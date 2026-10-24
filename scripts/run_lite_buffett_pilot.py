#!/usr/bin/env python3
"""Pilot-only Lite + Buffett-v3 remoat for ~5 HK + ~5 US tickers.

Does NOT remoat the full universe. Writes artifacts under cache/lite_buffett_pilot/
and a review JSON summary. Requires Vertex / Gemini credentials (GCP_SA_KEY or
GEMINI_API_KEY). Prefer --tickers / --limit over --force for production refresh.

Exit policy (partial success):
- Always write pilot_summary.json when possible.
- overall_pass in JSON is true only when every ticker passes ZH 100–300.
- Job exit 0 (green) when all attempted US pass and HK failures ≤ --allow-hk-failures
  (default 1), so a single near-miss like 0941 M7=98 does not red-X the Actions run.
- Otherwise exit 2. Partial success prints ::warning with a clear summary.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.buffett_moat_v3 import (  # noqa: E402
    BUFFETT_MOAT_ASSESSMENT_POLICY,
    BUFFETT_MOAT_MODEL,
    DIMENSION_KEYS,
    dimension_zh_counts,
    report_zh_pass,
)

DEFAULT_HK = ["0700.HK", "0005.HK", "0388.HK", "0941.HK", "1299.HK"]
DEFAULT_US = ["AAPL", "MSFT", "JPM", "AMZN", "BRK.B"]
# Workflow sentinels: empty/whitespace → skip market; these exact tokens expand to the lists above.
SENTINEL_DEFAULT_HK = "DEFAULT_HK"
SENTINEL_DEFAULT_US = "DEFAULT_US"


def parse_ticker_list(raw, *, sentinel: str, default_list: list) -> list:
    """Parse a workflow/CLI ticker field.

    - Empty or whitespace-only → [] (skip that market; do NOT resurrect a default list).
    - Exact sentinel (e.g. DEFAULT_US / DEFAULT_HK, case-insensitive) → copy of default_list.
    - Otherwise comma-separated tickers (blanks around commas ignored).
    """
    text = (raw or "").strip()
    if not text:
        return []
    if text.casefold() == sentinel.casefold():
        return list(default_list)
    return [part.strip().upper() for part in text.split(",") if part.strip()]


def _load_js_object(path: Path, prefix: str):
    text = path.read_text(encoding="utf-8")
    if not text.startswith(prefix):
        raise ValueError(f"{path} missing prefix {prefix!r}")
    return json.loads(text[len(prefix):].lstrip().rstrip().rstrip(";"))


def summarize_report(ticker: str, market: str, envelope: dict) -> dict:
    report = envelope.get("report") if isinstance(envelope.get("report"), dict) else envelope
    dims = dimension_zh_counts(report)
    zh_vals = [row["zh_chars"] for row in dims.values() if row["zh_chars"] is not None]
    return {
        "ticker": ticker,
        "market": market,
        "assessmentPolicy": envelope.get("assessmentPolicy") or report.get("assessmentPolicy"),
        "model": envelope.get("model") or report.get("model"),
        "period": report.get("period"),
        "pass_zh_100_300": report_zh_pass(report),
        "zh_chars_by_dim": {key: dims[key]["zh_chars"] for key in DIMENSION_KEYS},
        "en_present_by_dim": {key: dims[key]["en_present"] for key in DIMENSION_KEYS},
        "scores_by_dim": {key: dims[key]["score"] for key in DIMENSION_KEYS},
        "zh_min": min(zh_vals) if zh_vals else None,
        "zh_max": max(zh_vals) if zh_vals else None,
        "retries_or_errors": envelope.get("lastError"),
        "updatedAt": envelope.get("updatedAt"),
    }


def baseline_from_cache(hk_tickers, us_tickers) -> list:
    """Measure current production caches against the locked ZH band (no Gemini)."""
    rows = []
    hk_path = ROOT / "cache" / "hkex_moat.json"
    if hk_path.exists():
        hk = json.loads(hk_path.read_text(encoding="utf-8"))
        for ticker in hk_tickers:
            envelope = hk.get(ticker) or {}
            report = envelope.get("report") or {}
            if not report:
                rows.append({"ticker": ticker, "market": "HK", "status": "missing", "pass_zh_100_300": False})
                continue
            summary = summarize_report(ticker, "HK", envelope)
            summary["status"] = "baseline_cache"
            rows.append(summary)
    moat_dir = ROOT / "cache" / "moat"
    for ticker in us_tickers:
        files = sorted(moat_dir.glob(f"{ticker}_*.json"))
        if not files:
            rows.append({"ticker": ticker, "market": "US", "status": "missing", "pass_zh_100_300": False})
            continue
        data = json.loads(files[-1].read_text(encoding="utf-8"))
        summary = summarize_report(ticker, "US", data)
        summary["status"] = "baseline_cache"
        summary["cache_file"] = files[-1].name
        rows.append(summary)
    return rows


def run_us_pilot(tickers: list, out_dir: Path, force: bool) -> list:
    import build_full_market as market

    os.environ.setdefault("US_MOAT_MODEL", BUFFETT_MOAT_MODEL)
    os.environ.setdefault("MOAT_MODEL", BUFFETT_MOAT_MODEL)
    market.US_MOAT_MODEL = os.environ.get("US_MOAT_MODEL", BUFFETT_MOAT_MODEL)
    market.PRIMARY_MODEL = market.US_MOAT_MODEL
    # Prefer a dedicated pilot cache dir so production moat files stay untouched until review.
    pilot_moat = out_dir / "us_moat"
    pilot_moat.mkdir(parents=True, exist_ok=True)
    market.CACHE_DIR = str(pilot_moat)

    full = _load_js_object(ROOT / "market_data.js", "window.FULL_MARKET_DATA = ")
    results = []
    for ticker in tickers:
        stock = full.get(ticker) or full.get(ticker.replace("-", ".")) or {}
        if not stock:
            results.append({"ticker": ticker, "market": "US", "status": "not_in_market_data", "pass_zh_100_300": False})
            continue
        fin_context = {
            "name": stock.get("name") or stock.get("company_name") or ticker,
            "sector": stock.get("sector") or "N/A",
            "industry": stock.get("industry") or "N/A",
            "mcap": stock.get("mcap") or 0,
            "roe": stock.get("roe") or 0,
            "roa": stock.get("roa") or 0,
            "f_score": stock.get("f_score") or stock.get("fScore") or 0,
            "fcf0": stock.get("fcf0") or 0,
            "debt": stock.get("debt") or 0,
            "cash": stock.get("cash") or 0,
        }
        period = (stock.get("moat") or {}).get("period") or stock.get("period") or "2026Q3"
        if not market.gemini_client:
            results.append({
                "ticker": ticker, "market": "US", "status": "no_credentials",
                "pass_zh_100_300": False, "assessmentPolicy": BUFFETT_MOAT_ASSESSMENT_POLICY,
                "model": BUFFETT_MOAT_MODEL,
            })
            continue
        data = market.analyze_stock_moat(ticker, period, fin_context, force_refresh=force)
        if not data:
            results.append({"ticker": ticker, "market": "US", "status": "moat_unavailable", "pass_zh_100_300": False})
            continue
        summary = summarize_report(ticker, "US", data)
        summary["status"] = "generated" if report_zh_pass(data) else "generated_fail_length"
        results.append(summary)
    return results


def run_hk_pilot(tickers: list, inputs_path: Path, out_path: Path, force: bool, limit: int | None) -> list:
    from scripts.refresh_hkex_moat import create_client, main as hk_main

    if not inputs_path.exists():
        return [{
            "ticker": ",".join(tickers),
            "market": "HK",
            "status": "missing_moat_inputs",
            "pass_zh_100_300": False,
            "hint": f"Build moat inputs first (MOAT_EVIDENCE_OUTPUT) then pass --hk-inputs {inputs_path}",
        }]

    if create_client() is None:
        return [{
            "ticker": t, "market": "HK", "status": "no_credentials",
            "pass_zh_100_300": False, "assessmentPolicy": BUFFETT_MOAT_ASSESSMENT_POLICY,
            "model": BUFFETT_MOAT_MODEL,
        } for t in tickers]

    argv = [
        "refresh_hkex_moat.py",
        str(inputs_path),
        str(out_path),
        "--tickers", ",".join(tickers),
    ]
    if force:
        argv.append("--force")
        os.environ.setdefault("FORCE_MOAT_CONFIRM", "YES")
    if limit is not None:
        argv.extend(["--limit", str(limit)])
    os.environ.setdefault("MOAT_MODEL", BUFFETT_MOAT_MODEL)
    old = sys.argv
    try:
        sys.argv = argv
        try:
            hk_main()
        except SystemExit as exit_code:
            if exit_code.code not in (0, None):
                print(f"HK remoat exited {exit_code.code}", flush=True)
    finally:
        sys.argv = old

    reports = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}
    results = []
    for ticker in tickers:
        envelope = reports.get(ticker) or {}
        last_error = envelope.get("lastError")
        if not envelope.get("report"):
            results.append({
                "ticker": ticker, "market": "HK", "status": "not_updated",
                "pass_zh_100_300": False, "retries_or_errors": last_error,
            })
            continue
        summary = summarize_report(ticker, "HK", envelope)
        if summary["pass_zh_100_300"] and not last_error:
            summary["status"] = "generated"
        elif last_error and not summary["pass_zh_100_300"]:
            # Retained prior short report after rejected near-miss / failed remoat.
            summary["status"] = "refresh_failed_retained"
        elif summary["pass_zh_100_300"]:
            summary["status"] = "generated"
        else:
            summary["status"] = "generated_fail_length"
        results.append(summary)
    return results


def _is_pass_row(row: dict) -> bool:
    return bool(row.get("pass_zh_100_300"))


def evaluate_pilot_job(rows: list, *, allow_hk_failures: int = 1, min_pass: int | None = None) -> dict:
    """Decide Actions job green vs red without requiring every ticker to pass.

    Preferred rule: all US pass and HK failures ≤ allow_hk_failures (default 1).
    Optional floor: pass_count ≥ min_pass (e.g. 9 for a 10-ticker pilot).
    """
    us_rows = [r for r in rows if r.get("market") == "US"]
    hk_rows = [r for r in rows if r.get("market") == "HK"]
    us_fail = [r for r in us_rows if not _is_pass_row(r)]
    hk_fail = [r for r in hk_rows if not _is_pass_row(r)]
    pass_rows = [r for r in rows if _is_pass_row(r)]
    pass_count = len(pass_rows)
    total = len(rows)
    overall_pass = total > 0 and pass_count == total

    us_ok = len(us_fail) == 0
    hk_ok = len(hk_fail) <= max(0, allow_hk_failures)
    job_ok = bool(rows) and us_ok and hk_ok
    if min_pass is not None:
        job_ok = job_ok and pass_count >= min_pass

    failed_tickers = [r.get("ticker") for r in rows if not _is_pass_row(r)]
    return {
        "overall_pass": overall_pass,
        "job_ok": job_ok,
        "pass_count": pass_count,
        "total": total,
        "us_pass": len(us_rows) - len(us_fail),
        "us_total": len(us_rows),
        "hk_pass": len(hk_rows) - len(hk_fail),
        "hk_total": len(hk_rows),
        "hk_failures": len(hk_fail),
        "allow_hk_failures": allow_hk_failures,
        "min_pass": min_pass,
        "failed_tickers": failed_tickers,
    }


def main():
    parser = argparse.ArgumentParser(description="Lite Buffett-v3 pilot (~5 HK + ~5 US only)")
    parser.add_argument(
        "--hk", default="",
        help="HK tickers CSV, or DEFAULT_HK for the five-name pilot set. Empty/whitespace = skip HK.",
    )
    parser.add_argument(
        "--us", default="",
        help="US tickers CSV, or DEFAULT_US for AAPL,MSFT,JPM,AMZN,BRK.B. Empty/whitespace = skip US.",
    )
    parser.add_argument("--hk-inputs", default="cache/lite_buffett_pilot/moat-inputs.json",
                        help="HK moat evidence JSON from build_hkex (MOAT_EVIDENCE_OUTPUT)")
    parser.add_argument("--out-dir", default="cache/lite_buffett_pilot")
    parser.add_argument("--baseline-only", action="store_true",
                        help="Measure existing caches vs ZH 100–300; no Gemini calls")
    parser.add_argument("--force", action="store_true", help="Force remoat for selected pilot tickers")
    parser.add_argument("--skip-us", action="store_true")
    parser.add_argument("--skip-hk", action="store_true")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument(
        "--allow-hk-failures", type=int, default=1,
        help="Exit 0 when all US pass and HK failures ≤ this count (default 1). "
             "overall_pass in JSON stays false unless every ticker passes.",
    )
    parser.add_argument(
        "--min-pass", type=int, default=None,
        help="Optional extra floor: also require pass_count ≥ N (e.g. 9 for 10-ticker pilot).",
    )
    args = parser.parse_args()

    hk_tickers = parse_ticker_list(args.hk, sentinel=SENTINEL_DEFAULT_HK, default_list=DEFAULT_HK)
    us_tickers = parse_ticker_list(args.us, sentinel=SENTINEL_DEFAULT_US, default_list=DEFAULT_US)
    if not args.skip_hk and not args.skip_us and not hk_tickers and not us_tickers and not args.baseline_only:
        parser.error(
            "Both --hk and --us are empty after resolve. "
            "Pass DEFAULT_HK / DEFAULT_US or a comma-separated list; empty means skip that market."
        )

    out_dir = ROOT / args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.baseline_only:
        rows = baseline_from_cache(hk_tickers, us_tickers)
        verdict = evaluate_pilot_job(rows, allow_hk_failures=args.allow_hk_failures, min_pass=args.min_pass)
        payload = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "mode": "baseline_only",
            "policy": BUFFETT_MOAT_ASSESSMENT_POLICY,
            "model_target": BUFFETT_MOAT_MODEL,
            "zh_band": [100, 300],
            "rows": rows,
            "overall_pass": verdict["overall_pass"],
            "job_ok": verdict["job_ok"],
            "pass_count": verdict["pass_count"],
            "total": verdict["total"],
            "failed_tickers": verdict["failed_tickers"],
        }
        path = out_dir / "pilot_baseline_summary.json"
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({
            "wrote": str(path),
            "overall_pass": payload["overall_pass"],
            "job_ok": payload["job_ok"],
            "n": len(rows),
            "pass_count": verdict["pass_count"],
        }, ensure_ascii=False))
        return

    rows = []
    if not args.skip_hk and hk_tickers:
        hk_out = out_dir / "hkex_moat_pilot.json"
        rows.extend(run_hk_pilot(hk_tickers, ROOT / args.hk_inputs, hk_out, args.force, args.limit))
    if not args.skip_us and us_tickers:
        rows.extend(run_us_pilot(us_tickers, out_dir, force=True))

    verdict = evaluate_pilot_job(rows, allow_hk_failures=args.allow_hk_failures, min_pass=args.min_pass)
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "mode": "pilot",
        "policy": BUFFETT_MOAT_ASSESSMENT_POLICY,
        "model_target": BUFFETT_MOAT_MODEL,
        "zh_band": [100, 300],
        "rows": rows,
        "overall_pass": verdict["overall_pass"],
        "all_generated_ok": verdict["overall_pass"],
        "job_ok": verdict["job_ok"],
        "pass_count": verdict["pass_count"],
        "total": verdict["total"],
        "us_pass": f"{verdict['us_pass']}/{verdict['us_total']}",
        "hk_pass": f"{verdict['hk_pass']}/{verdict['hk_total']}",
        "allow_hk_failures": verdict["allow_hk_failures"],
        "failed_tickers": verdict["failed_tickers"],
    }
    path = out_dir / "pilot_summary.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    summary_line = (
        f"pilot {verdict['pass_count']}/{verdict['total']} pass; "
        f"US {verdict['us_pass']}/{verdict['us_total']}; "
        f"HK {verdict['hk_pass']}/{verdict['hk_total']} "
        f"(allow_hk_failures={verdict['allow_hk_failures']}); "
        f"overall_pass={verdict['overall_pass']}; job_ok={verdict['job_ok']}; "
        f"failed={verdict['failed_tickers'] or []}"
    )
    print(json.dumps({
        "wrote": str(path),
        "overall_pass": payload["overall_pass"],
        "job_ok": payload["job_ok"],
        "pass_count": verdict["pass_count"],
        "total": verdict["total"],
        "statuses": {r["ticker"]: r.get("status") for r in rows},
        "failed_tickers": verdict["failed_tickers"],
    }, ensure_ascii=False))
    print(summary_line, flush=True)

    if verdict["overall_pass"]:
        return
    if verdict["job_ok"]:
        print(
            f"::warning::Lite Buffett pilot partial success — {summary_line}. "
            "Artifact uploaded; review failed tickers (e.g. re-run with hk_tickers=0941.HK only).",
            flush=True,
        )
        return
    print(f"::error::Lite Buffett pilot failed job gate — {summary_line}", flush=True)
    raise SystemExit(2)


if __name__ == "__main__":
    main()

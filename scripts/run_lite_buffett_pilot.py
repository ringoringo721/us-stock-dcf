#!/usr/bin/env python3
"""Pilot-only Lite + Buffett-v3 remoat for ~5 HK + ~5 US tickers.

Does NOT remoat the full universe. Writes artifacts under cache/lite_buffett_pilot/
and a review JSON summary. Requires Vertex / Gemini credentials (GCP_SA_KEY or
GEMINI_API_KEY). Prefer --tickers / --limit over --force for production refresh.
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
    zh_char_count,
)

DEFAULT_HK = ["0700.HK", "0005.HK", "0388.HK", "0941.HK", "1299.HK"]
DEFAULT_US = ["AAPL", "MSFT", "JPM", "AMZN", "BRK.B"]


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
        if not envelope.get("report"):
            results.append({
                "ticker": ticker, "market": "HK", "status": "not_updated",
                "pass_zh_100_300": False, "retries_or_errors": envelope.get("lastError"),
            })
            continue
        summary = summarize_report(ticker, "HK", envelope)
        summary["status"] = "generated" if summary["pass_zh_100_300"] else "generated_fail_length"
        results.append(summary)
    return results


def main():
    parser = argparse.ArgumentParser(description="Lite Buffett-v3 pilot (~5 HK + ~5 US only)")
    parser.add_argument("--hk", default=",".join(DEFAULT_HK), help="Comma-separated HK tickers")
    parser.add_argument("--us", default=",".join(DEFAULT_US), help="Comma-separated US tickers")
    parser.add_argument("--hk-inputs", default="cache/lite_buffett_pilot/moat-inputs.json",
                        help="HK moat evidence JSON from build_hkex (MOAT_EVIDENCE_OUTPUT)")
    parser.add_argument("--out-dir", default="cache/lite_buffett_pilot")
    parser.add_argument("--baseline-only", action="store_true",
                        help="Measure existing caches vs ZH 100–300; no Gemini calls")
    parser.add_argument("--force", action="store_true", help="Force remoat for selected pilot tickers")
    parser.add_argument("--skip-us", action="store_true")
    parser.add_argument("--skip-hk", action="store_true")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    hk_tickers = [t.strip().upper() for t in args.hk.split(",") if t.strip()]
    us_tickers = [t.strip().upper() for t in args.us.split(",") if t.strip()]

    out_dir = ROOT / args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.baseline_only:
        rows = baseline_from_cache(hk_tickers, us_tickers)
        payload = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "mode": "baseline_only",
            "policy": BUFFETT_MOAT_ASSESSMENT_POLICY,
            "model_target": BUFFETT_MOAT_MODEL,
            "zh_band": [100, 300],
            "rows": rows,
            "overall_pass": all(r.get("pass_zh_100_300") for r in rows),
        }
        path = out_dir / "pilot_baseline_summary.json"
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"wrote": str(path), "overall_pass": payload["overall_pass"], "n": len(rows)}, ensure_ascii=False))
        return

    rows = []
    if not args.skip_hk:
        hk_out = out_dir / "hkex_moat_pilot.json"
        rows.extend(run_hk_pilot(hk_tickers, ROOT / args.hk_inputs, hk_out, args.force, args.limit))
    if not args.skip_us:
        rows.extend(run_us_pilot(us_tickers, out_dir, force=True))

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "mode": "pilot",
        "policy": BUFFETT_MOAT_ASSESSMENT_POLICY,
        "model_target": BUFFETT_MOAT_MODEL,
        "zh_band": [100, 300],
        "rows": rows,
        "overall_pass": all(r.get("pass_zh_100_300") for r in rows if r.get("status", "").startswith("generated")),
        "all_generated_ok": all(r.get("pass_zh_100_300") for r in rows),
    }
    path = out_dir / "pilot_summary.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "wrote": str(path),
        "overall_pass": payload["all_generated_ok"],
        "statuses": {r["ticker"]: r.get("status") for r in rows},
    }, ensure_ascii=False))
    if not payload["all_generated_ok"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()

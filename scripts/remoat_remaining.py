#!/usr/bin/env python3
"""Count / list production remoat backlog (Lite + buffett-moat-v3 + ZH 100–300).

Zero Gemini. Used by operators and the full-remoat workflow to pick the next batch.

HK scopes:
- core (default): reviewed 114 in hk_market_dcf.json, known mcap ≥ HKD 5B
- expansion: hkex_expansion_data.js incomplete/partial moats; known mcap ≥ HKD 5B
  OR unknown/null mcap (null is eligible — not treated as below-cap)
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.buffett_moat_v3 import (  # noqa: E402
    BUFFETT_MOAT_ASSESSMENT_POLICY,
    BUFFETT_MOAT_MODEL,
    policy_compatible_for_reuse,
    report_scores_complete,
    report_zh_pass,
)
from scripts.refresh_hkex_moat import (  # noqa: E402
    below_moat_market_cap,
    comment_without_score_dimensions,
    incomplete_score_dimensions,
)


def _hk_moat_screen(ticker: str, mcap) -> dict:
    return {
        "ticker": ticker,
        "moatScreen": {
            "calculationCurrency": "HKD",
            "marketCapMillions": mcap,
        },
    }


def _hk_eligible() -> list[str]:
    market = json.loads((ROOT / "hk_market_dcf.json").read_text(encoding="utf-8"))
    rows = []
    for ticker, stock in market.items():
        if below_moat_market_cap(_hk_moat_screen(ticker, stock.get("mcap"))):
            continue
        rows.append(ticker)
    return sorted(rows)


def _hk_good(entry: dict) -> bool:
    if not isinstance(entry, dict):
        return False
    if entry.get("assessmentPolicy") != BUFFETT_MOAT_ASSESSMENT_POLICY:
        return False
    model = (entry.get("model") or "").strip()
    if model and model != BUFFETT_MOAT_MODEL and "flash-lite" not in model:
        return False
    report = entry.get("report") or {}
    # ZH band alone is not enough — comment-present + score-null counts as incomplete.
    return report_zh_pass(report) and report_scores_complete(report)


def hk_remaining() -> dict:
    cache = json.loads((ROOT / "cache" / "hkex_moat.json").read_text(encoding="utf-8"))
    eligible = _hk_eligible()
    good, need = [], []
    for ticker in eligible:
        if _hk_good(cache.get(ticker) or {}):
            good.append(ticker)
        else:
            need.append(ticker)
    return {
        "market": "HK",
        "scope": "core",
        "eligible_ge_hkd_5b": len(eligible),
        "already_good": len(good),
        "remaining": len(need),
        "good_tickers": good,
        "need_tickers": need,
    }


def _load_js_object(path: Path, prefix: str) -> dict:
    text = path.read_text(encoding="utf-8")
    if not text.startswith(prefix):
        raise ValueError(f"{path} missing prefix {prefix!r}")
    return json.loads(text[len(prefix) :].lstrip().rstrip().rstrip(";"))


def _hk_core_tickers() -> set[str]:
    return {row["ticker"] for row in json.loads((ROOT / "hkex_stocks.json").read_text(encoding="utf-8"))}


def _hk_expansion_stock(ticker: str, compact: dict) -> dict:
    """Prefer full company snapshot (comments intact); fall back to compact catalogue."""
    path = ROOT / "cache" / "hk_companies" / f"{ticker}.json"
    if path.exists():
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            stock = record.get("stock")
            if isinstance(stock, dict) and stock.get("ticker") == ticker:
                return stock
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            pass
    return compact if isinstance(compact, dict) else {}


def _hk_expansion_entry(stock: dict) -> dict:
    source = (stock.get("ratingSources") or {}).get("moat") or {}
    return {
        "assessmentPolicy": source.get("assessmentPolicy"),
        "model": source.get("model"),
        "report": stock.get("moat") or {},
    }


def _hk_expansion_incomplete(stock: dict) -> bool:
    """True when moat is missing or any M1–M10 score is null / comment-without-score."""
    report = stock.get("moat") or {}
    if not report:
        return True
    return bool(incomplete_score_dimensions(report) or comment_without_score_dimensions(report))


def _hk_expansion_mcap_bucket(ticker: str, stock: dict) -> str:
    """ge (≥5B), null (unknown), or below (known <5B — excluded from expansion remoat)."""
    if below_moat_market_cap(_hk_moat_screen(ticker, stock.get("mcap"))):
        return "below"
    mcap = stock.get("mcap")
    if isinstance(mcap, (int, float)) and math.isfinite(mcap) and mcap > 0:
        return "ge"
    return "null"


def hk_expansion_remaining() -> dict:
    """Incomplete/partial expansion moats with mcap ≥ HKD 5B or unknown/null mcap.

    Systemic rule (not a hardcoded ticker list): skip known caps below 5B; include
    null mcap so -OLD / unquoted names with partial scores stay eligible. Already
    buffett-moat-v3 + Lite + complete ZH scores are skipped. Complete old-policy
    reports with all integer scores are left alone (no blind full restamp).
    """
    expansion = _load_js_object(ROOT / "hkex_expansion_data.js", "window.HKEX_EXPANSION = ")
    stocks = expansion.get("stocks") or {}
    core = _hk_core_tickers()
    good, need_ge, need_null, excluded_below = [], [], [], []
    for ticker, compact in sorted(stocks.items()):
        if ticker in core:
            continue
        stock = _hk_expansion_stock(ticker, compact)
        bucket = _hk_expansion_mcap_bucket(ticker, stock)
        if bucket == "below":
            excluded_below.append(ticker)
            continue
        if _hk_good(_hk_expansion_entry(stock)):
            good.append(ticker)
            continue
        if not _hk_expansion_incomplete(stock):
            # Complete scores under an older policy — not this incomplete path.
            continue
        if bucket == "ge":
            need_ge.append(ticker)
        else:
            need_null.append(ticker)
    need = need_ge + need_null
    return {
        "market": "HK",
        "scope": "expansion",
        "published_expansion": len(stocks),
        "excluded_below_hkd_5b": len(excluded_below),
        "eligible_ge_or_null_mcap": len(good) + len(need),
        "already_good": len(good),
        "remaining": len(need),
        "remaining_ge_hkd_5b": len(need_ge),
        "remaining_null_mcap": len(need_null),
        "good_tickers": good,
        "need_tickers": need,
        "need_ge_hkd_5b": need_ge,
        "need_null_mcap": need_null,
    }


def _us_published() -> dict[str, dict]:
    baseline = json.loads((ROOT / "full_market_dcf.json").read_text(encoding="utf-8"))
    expansion = json.loads(
        (ROOT / "us_expansion_data.js").read_text(encoding="utf-8").split("=", 1)[1].rstrip().rstrip(";")
    )
    out = {ticker: {"scope": "baseline", "stock": stock} for ticker, stock in baseline.items()}
    for ticker, stock in (expansion.get("stocks") or {}).items():
        if ticker not in out:
            out[ticker] = {"scope": "expansion", "stock": stock}
    return out


def _us_cache_report(ticker: str) -> dict | None:
    moat_dir = ROOT / "cache" / "moat"
    cands = sorted(moat_dir.glob(f"{ticker}_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not cands:
        single = moat_dir / f"{ticker}.json"
        if single.exists():
            cands = [single]
    if not cands:
        return None
    return json.loads(cands[0].read_text(encoding="utf-8"))


def _us_good(ticker: str, stock: dict) -> bool:
    cached = _us_cache_report(ticker)
    if cached is not None and policy_compatible_for_reuse(cached.get("assessmentPolicy"), cached):
        return True
    moat = stock.get("moat") or {}
    policy = (
        ((stock.get("ratingSources") or {}).get("moat") or {}).get("assessmentPolicy")
        or moat.get("assessmentPolicy")
    )
    if policy_compatible_for_reuse(policy, moat):
        return True
    return False


def us_remaining(scope: str = "all") -> dict:
    published = _us_published()
    good, need_baseline, need_expansion = [], [], []
    for ticker, meta in sorted(published.items()):
        if scope in ("baseline", "expansion") and meta["scope"] != scope:
            continue
        if _us_good(ticker, meta["stock"]):
            good.append(ticker)
        elif meta["scope"] == "baseline":
            need_baseline.append(ticker)
        else:
            need_expansion.append(ticker)
    need = need_baseline + need_expansion
    return {
        "market": "US",
        "scope": scope,
        "published": len(published) if scope == "all" else len(good) + len(need),
        "already_good": len(good),
        "remaining": len(need),
        "remaining_baseline": len(need_baseline),
        "remaining_expansion": len(need_expansion),
        "good_tickers": good,
        "need_tickers": need,
        "need_baseline": need_baseline,
        "need_expansion": need_expansion,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--market", choices=("hk", "us", "all"), default="all")
    parser.add_argument(
        "--scope",
        choices=("all", "baseline", "expansion", "core"),
        default="all",
        help="US: baseline/expansion/all. HK: core (default when market=hk), expansion, or all",
    )
    parser.add_argument("--limit", type=int, default=None, help="Print only the next N need_tickers")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    args = parser.parse_args()
    payload = {}
    if args.market in ("hk", "all"):
        hk_scope = args.scope
        if args.market == "hk" and hk_scope == "all":
            hk_scope = "core"  # lone --market hk keeps historical core behaviour
        if args.market == "hk" and hk_scope == "baseline":
            hk_scope = "core"
        if hk_scope == "expansion":
            payload["hk_expansion"] = hk_expansion_remaining()
        elif hk_scope == "all" and args.market == "all":
            payload["hk"] = hk_remaining()
            payload["hk_expansion"] = hk_expansion_remaining()
        else:
            payload["hk"] = hk_remaining()
    if args.market in ("us", "all"):
        us_scope = "all" if args.scope == "core" else args.scope
        payload["us"] = us_remaining(us_scope)
    if args.limit is not None:
        for block in payload.values():
            block["next_batch"] = block["need_tickers"][: args.limit]
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    for key, block in payload.items():
        print(f"== {key.upper()} ==")
        for field in (
            "eligible_ge_hkd_5b", "eligible_ge_or_null_mcap", "published", "published_expansion",
            "excluded_below_hkd_5b", "already_good", "remaining",
            "remaining_ge_hkd_5b", "remaining_null_mcap",
            "remaining_baseline", "remaining_expansion",
        ):
            if field in block:
                print(f"  {field}: {block[field]}")
        nxt = block.get("next_batch") or (block["need_tickers"][:20] if args.limit is None else [])
        if args.limit is not None:
            print(f"  next_batch({args.limit}): {','.join(block.get('next_batch') or [])}")
        elif nxt:
            print(f"  need_sample: {','.join(nxt)}")


if __name__ == "__main__":
    main()

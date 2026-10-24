#!/usr/bin/env python3
"""Count / list production remoat backlog (Lite + buffett-moat-v3 + ZH 100–300).

Zero Gemini. Used by operators and the full-remoat workflow to pick the next batch.
"""

from __future__ import annotations

import argparse
import json
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
from scripts.refresh_hkex_moat import below_moat_market_cap  # noqa: E402


def _hk_eligible() -> list[str]:
    market = json.loads((ROOT / "hk_market_dcf.json").read_text(encoding="utf-8"))
    rows = []
    for ticker, stock in market.items():
        mcap = stock.get("mcap")
        record = {
            "ticker": ticker,
            "moatScreen": {
                "calculationCurrency": "HKD",
                "marketCapMillions": mcap,
            },
        }
        if below_moat_market_cap(record):
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
        "eligible_ge_hkd_5b": len(eligible),
        "already_good": len(good),
        "remaining": len(need),
        "good_tickers": good,
        "need_tickers": need,
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
    parser.add_argument("--scope", choices=("all", "baseline", "expansion"), default="all",
                        help="US only: filter baseline vs expansion backlog")
    parser.add_argument("--limit", type=int, default=None, help="Print only the next N need_tickers")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    args = parser.parse_args()
    payload = {}
    if args.market in ("hk", "all"):
        payload["hk"] = hk_remaining()
    if args.market in ("us", "all"):
        payload["us"] = us_remaining(args.scope)
    if args.limit is not None:
        for block in payload.values():
            block["next_batch"] = block["need_tickers"][: args.limit]
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    for key, block in payload.items():
        print(f"== {key.upper()} ==")
        for field in (
            "eligible_ge_hkd_5b", "published", "already_good", "remaining",
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

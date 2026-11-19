#!/usr/bin/env python3
"""Build curated supply-chain seeds for remaining US listings (mcap < $50B).

Skips tickers that already have cache/supply-chain/{TICKER}.json (mega/mid-mega).
Reuses mega helpers (entity metadata, 繁中 gates, short_brand_en, industry models).
Gemini drafts unavailable; curated industry templates + peer pools.
Optional --min-mcap / --max-mcap to split review PRs by band.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.build_supply_chain_mega_seeds import (  # noqa: E402
    CACHE_DIR,
    CHARTS_DIR,
    TMP_COMPS,
    TMP_ENT,
    TMP_OVERRIDES,
    TMP_PLAYERS,
    UNIVERSE_PATH,
    _assert_short_brand_en,
    build_quotes,
    build_seed,
    load_json,
    traditionalize,
    validate_seed,
    write_json,
)

SUMMARY_PATH = CACHE_DIR / "_remaining_build_summary.json"


def patch_seed_source(seed: dict, lo: float | None, hi: float | None) -> dict:
    """Rewrite mega/mid source blurbs for the remaining-universe batch."""
    src = dict(seed.get("source") or {})
    src["type"] = "curated"
    band = "US listings still without seed after mega ≥$100B and mid-mega $50–100B"
    if lo is not None or hi is not None:
        lo_s = f"${lo/1e9:.0f}B" if lo else "$0"
        hi_s = f"${hi/1e9:.0f}B" if hi else "∞"
        band = f"US mcap band {lo_s}–{hi_s} (remaining after ≥$50B batches)"
    src["basis"] = (
        f"Industry value-chain template + curated product/market rivals for {band}. "
        "Not a live supplier API dump. Gemini drafts were unavailable (billing); "
        "content is template-curated with automated schema/繁中 gates. Preview-before-merge."
    )
    src["notes_zh"] = traditionalize(
        "本頁為產業價值鏈模板＋人工策展競爭對手的種子資料（美股剩餘市值＜500億美元批次，"
        "接續≥1,000億與500–1,000億批次）。未呼叫即時供應商 API；FMP 同業名單不作價值鏈依據。"
        "角色與排序依公開產業結構整理，非完整供應商名單或採購份額。競爭對手採產品／市場真實對手原則"
        "（參考 AAPL 教訓：不以跨業巨頭充當直接產品對手）。Gemini 草稿因帳單不可用，改走策展模板＋審核閘。"
    )
    src["notes_en"] = (
        "Industry value-chain template plus curated rivals for remaining US listings "
        "under $50B mcap (after mega ≥$100B and mid-mega $50–100B). No live supplier API. "
        "FMP peers are not used as the value chain. Roles/ranks follow a public industry "
        "structure — not a full BOM or spend share. Competitors follow true product/market "
        "rivalry (AAPL lesson). Gemini drafts unavailable due to billing; curated templates "
        "+ review gates used instead."
    )
    refs = list(src.get("references") or [])
    refs = [
        r
        for r in refs
        if "USD 100B" not in r
        and "≥$100B" not in r
        and "mcap≥$100B" not in r
        and "50B ≤ mcap" not in r
    ]
    refs.extend(
        [
            "cache/us_universe.json screen: remaining US listings without supply-chain seed",
            "AAPL curated seed shape on main (schema reference)",
            "Mega/mid-mega batch patterns (entity gates, short_brand_en, industry models)",
        ]
    )
    seen = set()
    out_refs = []
    for r in refs:
        if r not in seen:
            seen.add(r)
            out_refs.append(r)
    src["references"] = out_refs
    seed["source"] = src
    return seed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--only", default="")
    parser.add_argument(
        "--min-mcap",
        type=float,
        default=0.0,
        help="Inclusive lower bound on marketCap (USD). Default 0.",
    )
    parser.add_argument(
        "--max-mcap",
        type=float,
        default=50e9,
        help="Exclusive upper bound on marketCap (USD). Default 50e9.",
    )
    parser.add_argument(
        "--overwrite-existing",
        action="store_true",
        help="Rewrite seeds even if cache/supply-chain/{TICKER}.json already exists",
    )
    parser.add_argument(
        "--summary-name",
        default="_remaining_build_summary.json",
        help="Summary filename under cache/supply-chain/",
    )
    args = parser.parse_args()

    _assert_short_brand_en()

    for path in (TMP_ENT, TMP_PLAYERS, TMP_OVERRIDES, TMP_COMPS):
        if not path.exists():
            raise SystemExit(f"Missing catalog {path}; run prep_remaining_catalogs.py first.")

    entities = load_json(TMP_ENT)
    players_by_model = load_json(TMP_PLAYERS)
    overrides = load_json(TMP_OVERRIDES)
    competitors = load_json(TMP_COMPS)
    universe = load_json(UNIVERSE_PATH)
    stocks = universe["stocks"]
    band = [
        r
        for r in stocks
        if args.min_mcap <= float(r.get("marketCap") or 0) < args.max_mcap
    ]
    band.sort(key=lambda r: -float(r["marketCap"]))
    universe_tickers = {r["ticker"] for r in stocks}
    universe_by_ticker = {r["ticker"]: r for r in stocks}
    mcap_millions = {
        r["ticker"]: round(float(r["marketCap"]) / 1e6, 1)
        for r in stocks
        if r.get("marketCap")
    }

    today = date.today().isoformat()
    only = {t.strip().upper() for t in args.only.split(",") if t.strip()}
    written = []
    skipped_existing = []
    failures = []

    targets = list(band)
    if only:
        targets = [r for r in targets if r["ticker"] in only]
    if args.limit:
        targets = targets[: args.limit]

    for row in targets:
        ticker = row["ticker"]
        seed_path = CACHE_DIR / f"{ticker}.json"
        if seed_path.exists() and not args.overwrite_existing:
            skipped_existing.append(ticker)
            continue
        if ticker not in competitors or len(competitors[ticker]) < 1:
            failures.append((ticker, ["competitors:missing-or-short"]))
            continue
        seed = build_seed(
            row,
            entities,
            players_by_model,
            overrides,
            competitors,
            universe_tickers,
            today,
            universe_by_ticker,
        )
        seed = patch_seed_source(seed, args.min_mcap, args.max_mcap)
        errs = validate_seed(seed)
        if errs:
            failures.append((ticker, errs))
            continue
        quotes = build_quotes(seed, mcap_millions, today)
        if not args.dry_run:
            write_json(seed_path, seed)
            write_json(CACHE_DIR / f"{ticker}.quotes.json", quotes)
        written.append(ticker)

    summary = {
        "bandMin": args.min_mcap,
        "bandMax": args.max_mcap,
        "bandTotal": len(band),
        "written": len(written),
        "skippedExisting": skipped_existing,
        "failures": failures,
        "tickers": written,
        "dryRun": args.dry_run,
        "date": today,
        "chartsDir": str(CHARTS_DIR),
    }
    summary_path = CACHE_DIR / args.summary_name
    if not args.dry_run:
        write_json(summary_path, summary)
    print(
        json.dumps(
            {
                k: summary[k]
                for k in (
                    "bandMin",
                    "bandMax",
                    "bandTotal",
                    "written",
                    "skippedExisting",
                    "failures",
                    "dryRun",
                )
            },
            ensure_ascii=False,
        )
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

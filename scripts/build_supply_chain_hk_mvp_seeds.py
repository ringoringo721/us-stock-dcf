#!/usr/bin/env python3
"""Build curated supply-chain seeds for HK MVP hubs (~12).

Reuses mega `build_seed` / validate / quotes. No live FMP for structure.
Universe tickers = HK listings ∪ US listings so .HK peers can be listedInApp.
Prefer .HK dual-list counters (see DUAL_LIST_ISSUER).
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

SUMMARY_PATH = CACHE_DIR / "_hk_mvp_build_summary.json"
HK_MARKET_PATH = ROOT / "hk_market_dcf.json"
HK_UNIVERSE_PATH = ROOT / "cache" / "hkex_universe.json"

# Plan MVP hubs (docs/hk-supply-chain-plan.md §5.3); 0386.HK = energy pick.
HUBS: list[str] = [
    "0700.HK",
    "9988.HK",
    "3690.HK",
    "1810.HK",
    "1211.HK",
    "0941.HK",
    "0005.HK",
    "2318.HK",
    "0388.HK",
    "0883.HK",
    "1299.HK",
    "0386.HK",
]


def patch_seed_source(seed: dict) -> dict:
    src = dict(seed.get("source") or {})
    src["type"] = "curated"
    src["basis"] = (
        "Industry value-chain template + curated product/market rivals for HK MVP hubs "
        "(trial batch). Not a live supplier API dump. Prefer .HK dual-list counters on HK pages. "
        "Preview-before-merge."
    )
    src["notes_zh"] = traditionalize(
        "本頁為港股 MVP 龍頭供應鏈／競爭策展種子（產業價值鏈模板＋人工策展對手）。"
        "未呼叫即時供應商 API；FMP 同業名單不作價值鏈依據。雙重上市優先港股 .HK 代號。"
        "競爭對手採產品／市場真實對手原則（參考美股 AAPL 教訓：不以階段玩家或跨業巨頭灌水）。"
    )
    src["notes_en"] = (
        "HK MVP hub curated seed (industry value-chain template + curated rivals). "
        "No live supplier API. FMP peers are not the value chain. Dual-listed names prefer "
        ".HK on HK pages. Competitors follow true product/market rivalry (AAPL lesson)."
    )
    src["competitorRationale_zh"] = traditionalize(
        "競爭弧只列與該公司主力產品／市場重疊的對手；供應鏈階段玩家與競爭對手分開；雙重上市優先 .HK。"
    )
    src["competitorRationale_en"] = (
        "Rival arc lists product/market overlaps only; stage players stay separate from rivals; "
        "dual listings prefer .HK."
    )
    refs = [
        "Industry model via TICKER_MODEL (HK MVP)",
        "HKEX listings + hk_market_dcf.json hub rows",
        "AAPL curated seed shape (schema reference)",
        "docs/hk-supply-chain-plan.md MVP hubs",
    ]
    src["references"] = refs
    seed["source"] = src
    return seed


def patch_quotes(pack: dict) -> dict:
    pack = dict(pack)
    pack["notes_en"] = (
        "changePct from last two EOD closes in price_charts when present; mcap from HK/US "
        "universe overlays (HKD millions for .HK, USD millions for US). Missing stays null. "
        "No live FMP per pageview."
    )
    pack["notes_zh"] = traditionalize(
        "漲跌%取自 price_charts 最近兩日收盤（若有）；市值取自港股／美股宇宙覆寫"
        "（.HK 為百萬港元，美股為百萬美元）。缺資料維持 null，不造假。頁面不打即時 FMP。"
    )
    return pack


def load_hub_rows() -> dict[str, dict]:
    core = load_json(HK_MARKET_PATH)
    rows: dict[str, dict] = {}
    for t in HUBS:
        s = core.get(t) or {}
        if not s:
            raise SystemExit(f"Missing hub fundamentals in hk_market_dcf.json: {t}")
        rows[t] = {
            "ticker": t,
            "sector": s.get("sector") or "",
            "industry": s.get("industry") or "",
            "name": s.get("company_name") or s.get("name_en") or s.get("name") or t,
            "name_zh": s.get("name_zh") or s.get("name") or t,
            "exchange": "HKEX",
            "marketCap": float(s["mcap"]) * 1e6 if s.get("mcap") is not None else 0.0,
        }
    return rows


def build_universe_tickers_and_mcap() -> tuple[set[str], dict[str, float | None]]:
    """HK ∪ US tickers for listedInApp; mcap in millions (native listing currency)."""
    tickers: set[str] = set()
    mcap: dict[str, float | None] = {}

    hk_uni = load_json(HK_UNIVERSE_PATH)
    for s in hk_uni.get("stocks") or []:
        t = (s.get("ticker") or "").strip().upper()
        if t:
            tickers.add(t)

    core = load_json(HK_MARKET_PATH)
    for t, s in core.items():
        if not str(t).endswith(".HK"):
            continue
        tickers.add(t)
        if s.get("mcap") is not None:
            mcap[t] = round(float(s["mcap"]), 1)

    # Expansion mcaps (HKD millions) without live FMP
    exp_path = ROOT / "hkex_expansion_data.js"
    if exp_path.exists():
        text = exp_path.read_text(encoding="utf-8")
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            exp = json.loads(text[start : end + 1])
            for t, s in (exp.get("stocks") or {}).items():
                tickers.add(t)
                if t not in mcap and isinstance(s, dict) and s.get("mcap") is not None:
                    mcap[t] = round(float(s["mcap"]), 1)

    us = load_json(UNIVERSE_PATH)
    for r in us.get("stocks") or []:
        t = r.get("ticker")
        if not t:
            continue
        tickers.add(t)
        if r.get("marketCap") is not None:
            mcap[t] = round(float(r["marketCap"]) / 1e6, 1)

    return tickers, mcap


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--only", default="")
    parser.add_argument(
        "--overwrite-existing",
        action="store_true",
        help="Rewrite seeds even if cache/supply-chain/{TICKER}.json already exists",
    )
    args = parser.parse_args()

    _assert_short_brand_en()

    for path in (TMP_ENT, TMP_PLAYERS, TMP_OVERRIDES, TMP_COMPS):
        if not path.exists():
            raise SystemExit(f"Missing catalog {path}; run prep_hk_mvp_catalogs.py first.")

    entities = load_json(TMP_ENT)
    players_by_model = load_json(TMP_PLAYERS)
    overrides = load_json(TMP_OVERRIDES)
    competitors = load_json(TMP_COMPS)
    hub_rows = load_hub_rows()
    universe_tickers, mcap_millions = build_universe_tickers_and_mcap()
    universe_by_ticker = {t: hub_rows[t] for t in hub_rows}
    # Also pass US rows for entity name fallbacks when needed
    for r in load_json(UNIVERSE_PATH).get("stocks") or []:
        universe_by_ticker.setdefault(r["ticker"], r)

    today = date.today().isoformat()
    only = {t.strip().upper() for t in args.only.split(",") if t.strip()}
    written: list[str] = []
    skipped_existing: list[str] = []
    failures: list[tuple[str, list[str]]] = []

    targets = list(HUBS)
    if only:
        targets = [t for t in targets if t in only]

    for ticker in targets:
        seed_path = CACHE_DIR / f"{ticker}.json"
        if seed_path.exists() and not args.overwrite_existing:
            skipped_existing.append(ticker)
            continue
        if ticker not in competitors or len(competitors[ticker]) < 1:
            failures.append((ticker, ["competitors:missing-or-short"]))
            continue
        row = hub_rows[ticker]
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
        seed = patch_seed_source(seed)
        errors = validate_seed(seed)
        if errors:
            failures.append((ticker, errors))
            continue
        quotes = patch_quotes(build_quotes(seed, mcap_millions, today))
        if not args.dry_run:
            write_json(seed_path, seed)
            write_json(CACHE_DIR / f"{ticker}.quotes.json", quotes)
        written.append(ticker)

    summary = {
        "batch": "hk-mvp",
        "hubs": HUBS,
        "written": written,
        "skippedExisting": skipped_existing,
        "failures": [{"ticker": t, "errors": e} for t, e in failures],
        "updatedAt": today,
    }
    if not args.dry_run:
        write_json(SUMMARY_PATH, summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

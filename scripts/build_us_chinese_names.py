#!/usr/bin/env python3
"""Build best-effort Traditional Chinese display names for US listings.

Sources (priority order — never invent translations):
  1. Curated STOCK_NAMES_ZH map embedded in index.html
  2. HKEX dual-listed Chinese short names (exact English legal-name match)
  3. Leading Chinese company name already present in description_zh
     (FULL_MARKET_DATA + cache/us_companies/*.json)

FMP profiles are English-only; remaining gaps need a curated/ADR backfill
(see docs note). Prefer Traditional Chinese; do not machine-translate stubs.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CJK = re.compile(r"[\u4e00-\u9fff]")
STOCK_NAMES_BLOCK = re.compile(r"const STOCK_NAMES_ZH = \{([\s\S]*?)\n  \};")
STOCK_NAMES_ENTRY = re.compile(r'"([A-Z0-9.]+)":\s*"([^"]*)"')
WINDOW_JSON = re.compile(r"window\.(\w+)\s*=\s*(\{[\s\S]*\})\s*;?\s*$")

# Markdown / title noise then Chinese short name before an English paren.
DESC_NAME_PATS = (
    re.compile(
        r"^([\u4e00-\u9fff·、]{2,30}"
        r"(?:公司|集團|控股|銀行|航空|能源|科技|國際|電子|通訊|製藥|保險|"
        r"資本|證券|工業|汽車|娛樂|媒體|食品|藥業|醫療|化學|石油|電力|"
        r"地產|物流|快遞|遊戲|音樂|酒店|飯店|信託)?)"
        r"\s*\**\s*[（(]"
    ),
    re.compile(r"^([\u4e00-\u9fff·、]{2,24})\s*\**\s*[（(]"),
)

# Legal-suffix tokens stripped for dual-list English matching.
LEGAL_SUFFIX = re.compile(
    r"\b(?:incorporated|inc|corporation|corp|company|co|limited|ltd|plc|"
    r"group|holdings?|sa|nv|ag|se|lp|llc|plc|adr|ads)\b",
    re.I,
)

# HKEX share-class markers on Chinese short names (－Ｗ / -SW / …).
HK_CLASS_SUFFIX = re.compile(r"[－\-][Ａ-ＺA-Za-zＷＳ]+$")

# Curated ticker aliases (listing symbol → STOCK_NAMES_ZH key).
TICKER_ALIASES = {
    "BRK-A": "BRK.B",
    "BRK-B": "BRK.B",
    "BRK.A": "BRK.B",
}


def load_window_json(path: Path, expected: str | None = None) -> dict:
    text = path.read_text(encoding="utf-8")
    match = WINDOW_JSON.search(text)
    if not match:
        raise ValueError(f"No window.* JSON assignment in {path}")
    if expected and match.group(1) != expected:
        raise ValueError(f"Expected window.{expected} in {path}, found {match.group(1)}")
    return json.loads(match.group(2))


def load_stock_names_zh(index_html: Path) -> dict[str, str]:
    block = STOCK_NAMES_BLOCK.search(index_html.read_text(encoding="utf-8"))
    if not block:
        raise ValueError("STOCK_NAMES_ZH not found in index.html")
    return dict(STOCK_NAMES_ENTRY.findall(block.group(1)))


def normalize_lead(description: str) -> str:
    text = (description or "").strip()
    text = re.sub(r"^\*+\s*", "", text)
    text = re.sub(r"^#+\s*", "", text)
    return text.strip()


def extract_name_from_description(description: str) -> str | None:
    lead = normalize_lead(description)
    if not lead or not CJK.search(lead[:8]):
        return None
    for pattern in DESC_NAME_PATS:
        match = pattern.match(lead)
        if not match:
            continue
        name = match.group(1).strip(" *")
        if len(CJK.findall(name)) >= 2:
            return name
    return None


def normalize_english_name(value: str | None) -> str:
    text = (value or "").lower()
    text = re.sub(r"[,\.]", " ", text)
    text = LEGAL_SUFFIX.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def clean_hk_name_zh(value: str) -> str:
    return HK_CLASS_SUFFIX.sub("", value).strip()


def hk_dual_list_names(hk_listings: dict, us_listings: dict) -> dict[str, str]:
    """Match US listings to HKEX Chinese short names by normalized English legal name."""
    by_norm: dict[str, str] = {}
    for stock in hk_listings.get("stocks") or []:
        zh = stock.get("name_zh")
        if not zh:
            continue
        key = normalize_english_name(stock.get("name_en") or stock.get("name"))
        # Keep short keys only when the raw English name is short (e.g. NetEase).
        raw = (stock.get("name_en") or stock.get("name") or "").strip()
        if not key:
            continue
        if len(key) < 4 and len(raw) > 12:
            continue
        by_norm[key] = clean_hk_name_zh(zh)

    matches: dict[str, str] = {}
    for stock in us_listings.get("stocks") or []:
        key = normalize_english_name(stock.get("name_en") or stock.get("name"))
        if key and key in by_norm:
            matches[stock["ticker"]] = by_norm[key]
    return matches


def names_from_full_market(market: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for ticker, stock in market.items():
        name = extract_name_from_description(stock.get("description_zh") or "")
        if name:
            out[ticker] = name
    return out


def names_from_us_companies(cache_dir: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not cache_dir.is_dir():
        return out
    for path in sorted(cache_dir.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        stock = payload.get("stock") or {}
        name = extract_name_from_description(stock.get("description_zh") or "")
        if name:
            out[path.stem.upper()] = name
    return out


def resolve_alias(ticker: str, curated: dict[str, str]) -> str | None:
    if ticker in curated:
        return curated[ticker]
    alias = TICKER_ALIASES.get(ticker)
    if alias and alias in curated:
        # Prefer class-specific label when curated entry is Class B.
        base = curated[alias]
        if ticker in ("BRK-A", "BRK.A") and "(B)" in base:
            return base.replace("(B)", "(A)")
        if ticker in ("BRK-B",) and "(B)" in base:
            return base
        return base
    # Dot/dash interchangeable class tickers already covered; also try swap.
    if "." in ticker:
        return curated.get(ticker.replace(".", "-"))
    if "-" in ticker:
        return curated.get(ticker.replace("-", "."))
    return None


def build_catalogue(
    curated: dict[str, str],
    hk_matches: dict[str, str],
    desc_market: dict[str, str],
    desc_companies: dict[str, str],
    us_tickers: list[str],
) -> dict:
    names: dict[str, dict] = {}
    source_counts: Counter[str] = Counter()

    def put(ticker: str, name_zh: str, source: str) -> None:
        if ticker in names:
            return
        names[ticker] = {"name_zh": name_zh, "source": source}
        source_counts[source] += 1

    for ticker in us_tickers:
        curated_name = resolve_alias(ticker, curated)
        if curated_name:
            put(ticker, curated_name, "STOCK_NAMES_ZH")

    for ticker, name_zh in hk_matches.items():
        put(ticker, name_zh, "HKEX_dual_list")

    for ticker, name_zh in desc_market.items():
        put(ticker, name_zh, "description_zh_full_market")

    for ticker, name_zh in desc_companies.items():
        put(ticker, name_zh, "description_zh_us_companies")

    covered = sum(1 for t in us_tickers if t in names)
    total = len(us_tickers)
    missing = [t for t in us_tickers if t not in names]
    return {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "policy": {
            "preferTraditionalChinese": True,
            "noInventedTranslations": True,
            "priority": [
                "STOCK_NAMES_ZH",
                "HKEX_dual_list",
                "description_zh_full_market",
                "description_zh_us_companies",
            ],
            "notes": (
                "FMP company profiles do not provide Chinese names. "
                "Gaps keep English company_name in the Chinese UI until a curated "
                "Traditional Chinese short name is supplied."
            ),
        },
        "coverage": {
            "universeTickers": total,
            "withNameZh": covered,
            "missingNameZh": total - covered,
            "pct": round(100.0 * covered / total, 1) if total else 0.0,
            "bySource": dict(source_counts),
            "curatedMapSize": len(curated),
        },
        "missingTickers": missing,
        "names": names,
    }


def write_js_module(path: Path, catalogue: dict) -> None:
    # Browser payload: flat ticker → name_zh plus coverage metadata.
    payload = {
        "version": catalogue["version"],
        "generatedAt": catalogue["generatedAt"],
        "policy": catalogue["policy"],
        "coverage": catalogue["coverage"],
        "names": {t: entry["name_zh"] for t, entry in catalogue["names"].items()},
        "sources": {t: entry["source"] for t, entry in catalogue["names"].items()},
    }
    text = "window.US_CHINESE_NAMES = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
    path.write_text(text, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument(
        "--json-out",
        type=Path,
        default=None,
        help="Full provenance JSON (default: cache/us_chinese_names.json)",
    )
    parser.add_argument(
        "--js-out",
        type=Path,
        default=None,
        help="Browser module (default: us_chinese_names_data.js)",
    )
    args = parser.parse_args()
    root = args.root
    json_out = args.json_out or (root / "cache" / "us_chinese_names.json")
    js_out = args.js_out or (root / "us_chinese_names_data.js")

    curated = load_stock_names_zh(root / "index.html")
    us_listings = load_window_json(root / "us_universe_data.js", "US_LISTINGS")
    hk_listings = load_window_json(root / "hkex_universe_data.js", "HKEX_LISTINGS")
    market = load_window_json(root / "market_data.js", "FULL_MARKET_DATA")

    us_tickers = [stock["ticker"] for stock in us_listings.get("stocks") or []]
    hk_matches = hk_dual_list_names(hk_listings, us_listings)
    desc_market = names_from_full_market(market)
    desc_companies = names_from_us_companies(root / "cache" / "us_companies")

    before = sum(1 for t in us_tickers if resolve_alias(t, curated))
    catalogue = build_catalogue(curated, hk_matches, desc_market, desc_companies, us_tickers)
    catalogue["coverage"]["beforeCuratedOnly"] = before
    catalogue["coverage"]["beforePct"] = round(100.0 * before / len(us_tickers), 1) if us_tickers else 0.0

    json_out.parent.mkdir(parents=True, exist_ok=True)
    json_out.write_text(json.dumps(catalogue, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_js_module(js_out, catalogue)

    cov = catalogue["coverage"]
    print(
        json.dumps(
            {
                "before": f"{cov['beforeCuratedOnly']}/{cov['universeTickers']} ({cov['beforePct']}%)",
                "after": f"{cov['withNameZh']}/{cov['universeTickers']} ({cov['pct']}%)",
                "bySource": cov["bySource"],
                "jsonOut": str(json_out),
                "jsOut": str(js_out),
                "samples": {
                    t: catalogue["names"].get(t)
                    for t in ("ETN", "IBKR", "WDC", "LMT", "BABA", "SCHW", "BRK-A")
                },
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

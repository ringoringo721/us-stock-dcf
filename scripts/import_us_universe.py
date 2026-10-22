"""Import NYSE / NASDAQ / AMEX equities with market cap above USD 2 billion from FMP.

Does not invent financials, moat scores or PF scores. Requires FMP_API_KEY.
Reviewed companies already in full_market_dcf.json remain the published baseline;
this catalogue only lists eligible expansion candidates (and optionally the reviewed set).
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import time

import requests

MIN_MARKET_CAP = 2_000_000_000
EXCHANGES = ("NYSE", "NASDAQ", "AMEX")
EXCHANGE_ALIASES = {
    "NYSE": {"NYSE"},
    "NASDAQ": {"NASDAQ", "NASDAQGS", "NASDAQGM", "NASDAQCM", "NMS", "NGM", "NCM"},
    "AMEX": {"AMEX", "NYSE AMERICAN", "NYSEAMERICAN", "NYSE MKT", "ASE"},
}
SCREENER_URLS = (
    "https://financialmodelingprep.com/stable/company-screener",
    "https://financialmodelingprep.com/api/v3/stock-screener",
)


def normalize_exchange(value: str | None) -> str | None:
    if not value:
        return None
    token = re.sub(r"\s+", " ", value.strip().upper())
    for canonical, aliases in EXCHANGE_ALIASES.items():
        if token in aliases or token.replace(" ", "") in {a.replace(" ", "") for a in aliases}:
            return canonical
    return None


def is_excluded_security(row: dict) -> str | None:
    symbol = str(row.get("symbol") or "").strip().upper()
    if not symbol or not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", symbol):
        return "invalidSymbol"
    if row.get("isEtf") is True or row.get("isFund") is True:
        return "etfOrFund"
    name = str(row.get("companyName") or row.get("name") or "")
    if re.search(r"\b(ETF|ETN|ETP|Fund|Trust|Warrant|Right|Unit|Preferred)\b", name, re.I):
        if re.search(r"\b(ETF|ETN|ETP)\b", name, re.I) or re.search(r"\bWarrant|\bRight\b|\bUnit\b", name, re.I):
            return "nonCommonName"
    security = str(row.get("type") or row.get("securityType") or "").lower()
    if security and security not in {"stock", "equity", "common stock", "commonstock", ""}:
        if any(token in security for token in ("etf", "fund", "warrant", "preferred", "unit", "right")):
            return "nonCommonType"
    return None


def fetch_exchange(session: requests.Session, key: str, exchange: str) -> list[dict]:
    params = {
        "marketCapMoreThan": MIN_MARKET_CAP,
        "exchange": exchange,
        "isActivelyTrading": "true",
        "limit": 10000,
        "apikey": key,
    }
    last_error = None
    for url in SCREENER_URLS:
        for attempt in range(3):
            try:
                response = session.get(url, params=params, timeout=60)
            except requests.RequestException as error:
                last_error = error
                time.sleep(1.5 * (attempt + 1))
                continue
            if response.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(3 * (attempt + 1))
                continue
            if response.status_code != 200:
                last_error = RuntimeError(f"{url} HTTP {response.status_code}: {response.text[:240]}")
                break
            try:
                payload = response.json()
            except ValueError as error:
                last_error = error
                break
            if isinstance(payload, dict) and payload.get("Error Message"):
                last_error = RuntimeError(str(payload["Error Message"]))
                break
            if not isinstance(payload, list):
                last_error = RuntimeError(f"Unexpected screener payload from {url}")
                break
            return payload
        time.sleep(0.25)
    raise RuntimeError(f"FMP screener failed for {exchange}: {last_error}")


def select_listings(rows: list[dict]) -> tuple[list[dict], dict]:
    selected, excluded, by_symbol = [], Counter(), {}
    for row in rows:
        reason = is_excluded_security(row)
        if reason:
            excluded[reason] += 1
            continue
        exchange = normalize_exchange(row.get("exchangeShortName") or row.get("exchange"))
        if exchange not in EXCHANGES:
            excluded["unsupportedExchange"] += 1
            continue
        market_cap = row.get("marketCap")
        if type(market_cap) not in (int, float) or not (market_cap > MIN_MARKET_CAP):
            # Strict greater-than USD 2B; exact 2B is out of scope for this screen.
            excluded["marketCapNotAbove2B"] += 1
            continue
        symbol = str(row["symbol"]).strip().upper()
        item = {
            "ticker": symbol,
            "name": row.get("companyName") or row.get("name") or symbol,
            "name_en": row.get("companyName") or row.get("name") or symbol,
            "exchange": exchange,
            "sector": row.get("sector") or "Unclassified",
            "industry": row.get("industry") or "Unclassified",
            "marketCap": int(market_cap) if float(market_cap).is_integer() else float(market_cap),
            "isActivelyTrading": bool(row.get("isActivelyTrading", True)),
            "country": row.get("country") or None,
            "universeMembership": "FMP US equity screener (NYSE/NASDAQ/AMEX, marketCap > USD 2B)",
        }
        previous = by_symbol.get(symbol)
        if previous and previous["marketCap"] >= item["marketCap"]:
            excluded["duplicateSymbol"] += 1
            continue
        if previous:
            excluded["duplicateSymbol"] += 1
        by_symbol[symbol] = item
    selected = sorted(by_symbol.values(), key=lambda item: (-item["marketCap"], item["ticker"]))
    return selected, dict(excluded)


def write_catalogue(path: Path, stocks: list[dict], excluded: dict, retrieved_at: str) -> dict:
    reviewed = set()
    market_path = path.resolve().parents[1] / "full_market_dcf.json"
    if market_path.exists():
        reviewed = set(json.loads(market_path.read_text(encoding="utf-8")))
    payload = {
        "version": 1,
        "screen": {
            "exchanges": list(EXCHANGES),
            "marketCapMoreThanUsd": MIN_MARKET_CAP,
            "isActivelyTrading": True,
            "excludeEtfsAndFunds": True,
        },
        "source": {
            "provider": "Financial Modeling Prep company/stock screener",
            "retrievedAt": retrieved_at,
            "endpoints": list(SCREENER_URLS),
        },
        "counts": {
            "eligible": len(stocks),
            "reviewedBaseline": len(reviewed),
            "alreadyInBaseline": sum(1 for item in stocks if item["ticker"] in reviewed),
            "expansionCandidates": sum(1 for item in stocks if item["ticker"] not in reviewed),
            "excluded": excluded,
        },
        "stocks": stocks,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    path.write_text(serialized, encoding="utf-8")
    js_path = path.resolve().parents[1] / "us_universe_data.js"
    js_path.write_text("window.US_LISTINGS = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
                       encoding="utf-8")
    return payload


def inventory_only(reviewed: set[str], stocks: list[dict] | None = None) -> dict:
    baseline = {
        "reviewedBaseline": len(reviewed),
        "reviewedExchanges": "see full_market_dcf.json",
        "externalEstimateAbove2B": 2001,
        "externalEstimateSource": (
            "totalmarketindex.com US exchange company count by size, "
            "close 2026-10-20 (914 ≥ $10B + 1,081 in $2–10B)"
        ),
        "estimatedGapVsBaseline": 2001 - len(reviewed),
    }
    if stocks is None:
        return {"status": "fmpUnavailable", **baseline}
    return {
        "status": "screened",
        **baseline,
        "eligibleFromFmp": len(stocks),
        "alreadyInBaseline": sum(1 for item in stocks if item["ticker"] in reviewed),
        "expansionCandidates": sum(1 for item in stocks if item["ticker"] not in reviewed),
        "byExchange": dict(Counter(item["exchange"] for item in stocks)),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("cache/us_universe.json"))
    parser.add_argument("--inventory-only", action="store_true",
                        help="Print coverage inventory; still screens FMP when a key is present")
    parser.add_argument("--dry-run", action="store_true", help="Screen FMP but do not write catalogue files")
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    reviewed = set(json.loads((root / "full_market_dcf.json").read_text(encoding="utf-8")))
    key = os.environ.get("FMP_API_KEY", "").strip()
    if not key:
        report = inventory_only(reviewed)
        report["blocker"] = "FMP_API_KEY missing; cannot screen live US universe"
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 2 if not args.inventory_only else 0
    retrieved_at = datetime.now(timezone.utc).isoformat()
    rows = []
    with requests.Session() as session:
        for exchange in EXCHANGES:
            batch = fetch_exchange(session, key, exchange)
            print(f"Screener {exchange}: {len(batch)} raw rows", flush=True)
            rows.extend(batch)
            time.sleep(0.35)
    stocks, excluded = select_listings(rows)
    report = inventory_only(reviewed, stocks)
    report["excluded"] = excluded
    if args.inventory_only or args.dry_run:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    payload = write_catalogue(args.output if args.output.is_absolute() else root / args.output,
                              stocks, excluded, retrieved_at)
    report["wrote"] = str(args.output)
    report["counts"] = payload["counts"]
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

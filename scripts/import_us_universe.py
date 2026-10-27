"""Import NYSE / NASDAQ / AMEX equities with market cap above USD 10 billion from FMP.

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

MIN_MARKET_CAP = 10_000_000_000
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
# Independent public estimate (totalmarketindex.com, close 2026-10-20): 914 companies ≥ $10B.
EXTERNAL_ESTIMATE_ABOVE_10B = 914


def normalize_exchange(value: str | None) -> str | None:
    if not value:
        return None
    token = re.sub(r"\s+", " ", value.strip().upper())
    for canonical, aliases in EXCHANGE_ALIASES.items():
        if token in aliases or token.replace(" ", "") in {a.replace(" ", "") for a in aliases}:
            return canonical
    return None


# NYSE/NASDAQ preferred & exchange-traded note share classes (e.g. MER-PK, CTA-PA).
# Dual-class commons use other letters (BRK-A, BF-B) and are kept.
PREFERRED_OR_NOTE_SYMBOL = re.compile(r"^[A-Z][A-Z0-9]*-P[A-Z]?$")
DEBT_NOTE_NAME = re.compile(
    r"\b(?:Notes?|Junior\s+Subordinated|Income\s+Capital\s+Obligations|"
    r"Subordinated\s+Debentures?|Debentures?)\b",
    re.I,
)
PREFERRED_NAME = re.compile(
    r"\b(?:Preferred(?:\s+Stock)?|Pref\.?|Pfd\.?|Cum\.?\s+Pfd|"
    r"Perp(?:etual)?\.?\s+Pfd)\b",
    re.I,
)
NON_COMMON_NAME = re.compile(r"\b(?:ETF|ETN|ETP|Warrants?|Rights?|Units?)\b", re.I)
COMMON_SECURITY_TYPES = {"", "stock", "equity", "common stock", "commonstock"}
NON_COMMON_TYPE_TOKENS = (
    "etf", "fund", "warrant", "preferred", "unit", "right",
    "note", "bond", "debenture", "preference",
)


def is_excluded_security(row: dict) -> str | None:
    """Return an exclusion reason for non-common US listings, else None.

    Drops debt NOTES, preferred notes/stock, and exchange preferred/note symbols
    so the website universe stays common-equity only (DCF-applicable names).
    """
    symbol = str(row.get("symbol") or row.get("ticker") or "").strip().upper()
    if not symbol or not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", symbol):
        return "invalidSymbol"
    if row.get("isEtf") is True or row.get("isFund") is True:
        return "etfOrFund"
    if PREFERRED_OR_NOTE_SYMBOL.fullmatch(symbol):
        return "preferredOrNoteSymbol"
    name = str(
        row.get("companyName")
        or row.get("name")
        or row.get("name_en")
        or row.get("company_name")
        or ""
    )
    if DEBT_NOTE_NAME.search(name):
        return "debtNoteName"
    if PREFERRED_NAME.search(name):
        return "preferredName"
    if NON_COMMON_NAME.search(name):
        return "nonCommonName"
    security = str(row.get("type") or row.get("securityType") or "").lower().strip()
    if security not in COMMON_SECURITY_TYPES:
        if any(token in security for token in NON_COMMON_TYPE_TOKENS):
            return "nonCommonType"
    return None


def listing_exclusion_reason(item: dict) -> str | None:
    """Map a catalogue / expansion row onto is_excluded_security."""
    return is_excluded_security({
        "symbol": item.get("ticker") or item.get("symbol"),
        "companyName": item.get("name") or item.get("name_en") or item.get("company_name"),
        "type": item.get("securityType") or item.get("type"),
        "isEtf": item.get("isEtf"),
        "isFund": item.get("isFund"),
    })


def fetch_exchange(session, key: str, exchange: str) -> list[dict]:
    import requests  # Imported here so filter helpers stay testable without requests installed.
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
            # Strict greater-than USD 10B; exact 10B is out of scope for this screen.
            excluded["marketCapNotAbove10B"] += 1
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
            "universeMembership": "FMP US equity screener (NYSE/NASDAQ/AMEX, marketCap > USD 10B)",
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


def inventory_only(reviewed: set[str], stocks: list[dict] | None = None,
                   reviewed_above_10b: int | None = None) -> dict:
    already = reviewed_above_10b if reviewed_above_10b is not None else None
    gap = None if already is None else max(EXTERNAL_ESTIMATE_ABOVE_10B - already, 0)
    baseline = {
        "reviewedBaseline": len(reviewed),
        "reviewedBaselineAbove10B": already,
        "reviewedExchanges": "see full_market_dcf.json",
        "externalEstimateAbove10B": EXTERNAL_ESTIMATE_ABOVE_10B,
        "externalEstimateSource": (
            "totalmarketindex.com US exchange company count by size, "
            "close 2026-10-20 (914 companies with market cap of $10 billion or more). "
            "Screen uses strict greater-than USD 10B; FMP live screen remains authoritative."
        ),
        "estimatedGapVsBaselineAbove10B": gap,
        "estimatedGapVsFullBaseline": EXTERNAL_ESTIMATE_ABOVE_10B - len(reviewed),
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


def count_reviewed_above_10b(root: Path, reviewed: set[str]) -> int:
    market_path = root / "full_market_dcf.json"
    if not market_path.exists():
        return 0
    market = json.loads(market_path.read_text(encoding="utf-8"))
    # Stored mcap is USD millions.
    return sum(
        1 for ticker in reviewed
        if isinstance(market.get(ticker), dict)
        and type(market[ticker].get("mcap")) in (int, float)
        and market[ticker]["mcap"] * 1_000_000 > MIN_MARKET_CAP
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("cache/us_universe.json"))
    parser.add_argument("--inventory-only", action="store_true",
                        help="Print coverage inventory; still screens FMP when a key is present")
    parser.add_argument("--dry-run", action="store_true", help="Screen FMP but do not write catalogue files")
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    reviewed = set(json.loads((root / "full_market_dcf.json").read_text(encoding="utf-8")))
    reviewed_above = count_reviewed_above_10b(root, reviewed)
    key = os.environ.get("FMP_API_KEY", "").strip()
    if not key:
        report = inventory_only(reviewed, reviewed_above_10b=reviewed_above)
        report["blocker"] = "FMP_API_KEY missing; cannot screen live US universe"
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 2 if not args.inventory_only else 0
    retrieved_at = datetime.now(timezone.utc).isoformat()
    import requests
    rows = []
    with requests.Session() as session:
        for exchange in EXCHANGES:
            batch = fetch_exchange(session, key, exchange)
            print(f"Screener {exchange}: {len(batch)} raw rows", flush=True)
            rows.extend(batch)
            time.sleep(0.35)
    stocks, excluded = select_listings(rows)
    report = inventory_only(reviewed, stocks, reviewed_above_10b=reviewed_above)
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

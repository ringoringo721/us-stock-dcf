#!/usr/bin/env python3
"""Patch US baseline price/mcap from FMP batch-quote without a full remoat rebuild.

Used when Actions workflow_dispatch is unavailable and frontpage prices are stale.
Does not invent financials — only overwrites price and mcap from live quotes.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
BATCH = "https://financialmodelingprep.com/stable/batch-quote"
CHUNK = 50


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def provider_symbol(ticker: str) -> str:
    return ticker if ticker.endswith(".HK") else ticker.replace(".", "-")


def load_market_js(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    payload = text.split("=", 1)[1].strip().rstrip(";")
    return json.loads(payload)


def write_market_js(path: Path, market: dict) -> None:
    path.write_text(
        "window.FULL_MARKET_DATA = "
        + json.dumps(market, ensure_ascii=False, indent=2)
        + ";\n",
        encoding="utf-8",
    )


def fetch_batch(session_key: str, symbols: list[str]) -> list[dict]:
    query = urlencode({"symbols": ",".join(symbols), "apikey": session_key})
    req = Request(f"{BATCH}?{query}", headers={"User-Agent": "us-stock-dcf-quote-refresh"})
    with urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        return payload["data"]
    if not isinstance(payload, list):
        raise RuntimeError(f"Unexpected batch-quote payload for {symbols[:3]}…")
    return payload


def quote_session_date(row: dict, fallback: str) -> str:
    ts = row.get("timestamp")
    if finite(ts) and ts > 0:
        return datetime.fromtimestamp(int(ts), timezone.utc).date().isoformat()
    return fallback


def main() -> int:
    key = (os.environ.get("FMP_API_KEY") or "").strip()
    if not key:
        print("FMP_API_KEY is required", file=sys.stderr)
        return 1

    market_path = ROOT / "market_data.js"
    json_path = ROOT / "full_market_dcf.json"
    market = load_market_js(market_path)
    full = json.loads(json_path.read_text(encoding="utf-8"))

    tickers = sorted(
        t for t, row in market.items()
        if isinstance(row, dict) and isinstance(t, str) and not t.endswith(".HK")
    )
    by_provider = {provider_symbol(t): t for t in tickers}
    today = datetime.now(timezone.utc).date().isoformat()
    updated = 0
    session_dates: dict[str, int] = {}

    symbols = list(by_provider)
    for i in range(0, len(symbols), CHUNK):
        chunk = symbols[i:i + CHUNK]
        rows = fetch_batch(key, chunk)
        for row in rows:
            symbol = str(row.get("symbol") or "")
            ticker = by_provider.get(symbol)
            if not ticker:
                continue
            price = row.get("price")
            mcap_raw = row.get("marketCap")
            if not finite(price) or price <= 0:
                continue
            stock = market.get(ticker)
            if not isinstance(stock, dict):
                continue
            stock["price"] = float(price)
            if finite(mcap_raw) and mcap_raw > 0:
                stock["mcap"] = round(float(mcap_raw) / 1e6, 1)
            session = quote_session_date(row, today)
            stock["quoteDate"] = session
            stock["quoteAvailability"] = {
                "reason": None,
                "ageDays": max(0, (datetime.fromisoformat(today) - datetime.fromisoformat(session)).days),
                "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            }
            if ticker in full and isinstance(full[ticker], dict):
                full[ticker]["price"] = stock["price"]
                if "mcap" in stock:
                    full[ticker]["mcap"] = stock["mcap"]
                full[ticker]["quoteDate"] = session
                full[ticker]["quoteAvailability"] = stock["quoteAvailability"]
            updated += 1
            session_dates[session] = session_dates.get(session, 0) + 1
        time.sleep(0.15)

    write_market_js(market_path, market)
    json_path.write_text(json.dumps(full, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "updated": updated,
        "universe": len(tickers),
        "sessionDates": dict(sorted(session_dates.items())),
        "sample": {
            t: {"price": market[t]["price"], "quoteDate": market[t].get("quoteDate")}
            for t in ("AAPL", "NVDA", "MSFT", "BRK.B")
            if t in market
        },
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

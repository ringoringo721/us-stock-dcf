"""Refresh real daily prices for Profile charts without modifying financial datasets."""

import calendar
from datetime import date, datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time

import requests

ENDPOINT = "https://financialmodelingprep.com/stable/historical-price-eod/full"


def years_before(day, years):
    year = day.year - years
    return day.replace(year=year, day=min(day.day, calendar.monthrange(year, day.month)[1]))


def parse_prices(payload, symbol, start, end):
    if not isinstance(payload, list):
        raise ValueError("Unrecognized EOD response; possible provider permission or API error")
    rows = {}
    for item in payload:
        if not isinstance(item, dict) or item.get("symbol") != symbol:
            raise ValueError("Unexpected EOD symbol or record")
        try:
            day = date.fromisoformat(item["date"])
            close = item["close"]
            volume = item.get("volume")
            if isinstance(close, bool) or not isinstance(close, (int, float)) or not math.isfinite(close) or close <= 0:
                raise ValueError("Invalid EOD close")
            if volume is not None and (isinstance(volume, bool) or not isinstance(volume, (int, float))
                                       or not math.isfinite(volume) or not 0 <= volume <= 9007199254740991
                                       or int(volume) != volume):
                raise ValueError("Invalid EOD volume")
        except (KeyError, TypeError, ValueError):
            raise ValueError("Invalid EOD date, close or volume") from None
        if not start <= day <= end:
            raise ValueError("EOD record outside requested dates")
        row = [day.isoformat(), close, volume]
        if row[0] in rows and rows[row[0]] != row:
            raise ValueError("Conflicting duplicate EOD date")
        rows[row[0]] = row
    if len(payload) >= 5000:
        raise ValueError("Provider EOD limit reached; refusing a potentially truncated history")
    return [rows[day] for day in sorted(rows)]


def provider_symbol(ticker):
    return ticker if ticker.endswith(".HK") else ticker.replace(".", "-")


def fetch_prices(session, ticker, api_key, today):
    symbol = provider_symbol(ticker)
    currency = "HKD" if ticker.endswith(".HK") else "USD"
    start = years_before(today, 20)
    middle = years_before(today, 10)
    rows = []
    for first, last in [(start, middle - timedelta(days=1)), (middle, today)]:
        for attempt in range(3):
            try:
                response = session.get(ENDPOINT, params={
                    "symbol": symbol, "from": first.isoformat(), "to": last.isoformat(), "apikey": api_key
                }, timeout=45)
            except requests.RequestException as error:
                raise RuntimeError(f"{ticker}: EOD network failure ({type(error).__name__})") from None
            if response.status_code not in (429, 500, 502, 503, 504) or attempt == 2:
                break
            time.sleep(5 * (attempt + 1))
        if response.status_code != 200:
            raise RuntimeError(f"{ticker}: EOD HTTP {response.status_code}; existing prices retained")
        try:
            rows.extend(parse_prices(response.json(), symbol, first, last))
        except ValueError as error:
            raise RuntimeError(f"{ticker}: {error}; existing prices retained") from None
        time.sleep(0.12)
    return {
        "version": 1, "ticker": ticker, "providerSymbol": symbol, "currency": currency,
        "source": "FMP historical-price-eod/full", "priceBasis": "splitAdjustedClose",
        "volumeBasis": "providerReported", "requestedFrom": start.isoformat(), "requestedTo": today.isoformat(),
        "fetchedAt": datetime.now(timezone.utc).isoformat(), "columns": ["date", "close", "volume"],
        "rows": rows
    }


def write_price_record(folder, ticker, record):
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{ticker}.json"
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=folder, delete=False) as destination:
        temporary = Path(destination.name)
        json.dump(record, destination, ensure_ascii=False, separators=(",", ":"))
        destination.write("\n")
    try:
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    root = Path(__file__).resolve().parent.parent
    key = os.environ.get("FMP_API_KEY")
    if not key:
        raise RuntimeError("FMP_API_KEY is required; price charts were not refreshed")
    market = json.loads((root / "full_market_dcf.json").read_text(encoding="utf-8"))
    prices = {}
    today = datetime.now(timezone.utc).date()
    with requests.Session() as session:
        for ticker in market:
            if not re.fullmatch(r"[A-Z0-9]+(?:[.-][A-Z0-9]+)*", ticker):
                raise ValueError("Invalid market ticker")
            prices[ticker] = fetch_prices(session, ticker, key, today)
            previous = root / "cache" / "price_charts" / f"{ticker}.json"
            if not prices[ticker]["rows"] and previous.exists():
                if json.loads(previous.read_text(encoding="utf-8")).get("rows"):
                    raise RuntimeError(f"{ticker}: empty provider response would erase existing history; all caches retained")
            print(f"{ticker}: {len(prices[ticker]['rows'])} real daily price records", flush=True)
        # Low-cost beta benchmarks: S&P 500 (SPY) + HSI proxy (TraHK 2800.HK).
        for ticker in ("SPY", "2800.HK"):
            prices[ticker] = fetch_prices(session, ticker, key, today)
            print(f"{ticker}: {len(prices[ticker]['rows'])} beta-benchmark daily price records", flush=True)
    # Fetch and validate every company before replacing any published cache.
    folder = root / "cache" / "price_charts"
    benchmarks = root / "cache" / "beta_benchmarks"
    for ticker, record in prices.items():
        write_price_record(folder, ticker, record)
        if ticker in {"SPY", "2800.HK"}:
            mirrored = dict(record)
            mirrored["benchmark"] = "S&P 500 via SPY ETF" if ticker == "SPY" else "Hang Seng Index via TraHK 2800.HK"
            write_price_record(benchmarks, ticker, mirrored)
    unavailable = [ticker for ticker, record in prices.items() if not record["rows"]]
    print(f"Refreshed {len(prices)} Profile price histories; financial and DCF datasets unchanged", flush=True)
    if unavailable:
        print(f"No provider history available for: {', '.join(unavailable)}", flush=True)


if __name__ == "__main__":
    main()

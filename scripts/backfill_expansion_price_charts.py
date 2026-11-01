"""One-shot backfill of missing US expansion price charts via the published /api/fmp proxy.

Uses real FMP EOD rows only (never fabricates). Intended for local recovery when
FMP_API_KEY is unavailable in the agent environment but production already has it.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import math
import time
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from refresh_price_charts import (  # noqa: E402
    expansion_tickers,
    guard_empty_erase,
    provider_symbol,
    read_previous,
    write_price_record,
    years_before,
)


def fetch_window(base, ticker, start, end, timeout=60):
    query = urllib.parse.urlencode({
        "action": "historical-price",
        "symbol": ticker,
        "from": start.isoformat(),
        "to": end.isoformat(),
    })
    url = f"{base.rstrip('/')}/api/fmp?{query}"
    request = urllib.request.Request(url, headers={"User-Agent": "us-stock-dcf-expansion-price-backfill"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.load(response)
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise RuntimeError("invalid proxy payload")
    if len(payload["data"]) >= 5000:
        raise RuntimeError("provider EOD limit reached; refusing truncated history")
    provider = provider_symbol(ticker)
    rows = {}
    for item in payload["data"]:
        if not isinstance(item, dict):
            raise RuntimeError("invalid EOD row")
        symbol = item.get("symbol")
        provider_sym = item.get("providerSymbol")
        if symbol not in (None, ticker) or provider_sym not in (None, provider, ticker):
            raise RuntimeError(f"unexpected symbol {symbol}/{provider_sym}")
        day = str(item.get("date") or "")[:10]
        close = item.get("close")
        volume = item.get("volume")
        if not day or isinstance(close, bool) or not isinstance(close, (int, float)) \
                or not math.isfinite(close) or close <= 0:
            raise RuntimeError("invalid EOD close")
        if volume is not None and (isinstance(volume, bool) or not isinstance(volume, (int, float))
                                   or not math.isfinite(volume) or not 0 <= volume <= 9007199254740991
                                   or int(volume) != volume):
            raise RuntimeError("invalid EOD volume")
        if not (start.isoformat() <= day <= end.isoformat()):
            raise RuntimeError("EOD record outside requested dates")
        row = [day, close, None if volume is None else int(volume)]
        if day in rows and rows[day] != row:
            raise RuntimeError("conflicting duplicate EOD date")
        rows[day] = row
    return [rows[day] for day in sorted(rows)]


def fetch_prices_via_proxy(base, ticker, today):
    currency = "HKD" if ticker.endswith(".HK") else "USD"
    start = years_before(today, 20)
    middle = years_before(today, 10)
    rows = []
    for first, last in [(start, middle - timedelta(days=1)), (middle, today)]:
        if first > last:
            continue
        for attempt in range(3):
            try:
                rows.extend(fetch_window(base, ticker, first, last))
                break
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, RuntimeError, ValueError) as error:
                if attempt == 2:
                    raise RuntimeError(f"{ticker}: {error}") from None
                time.sleep(2 * (attempt + 1))
        time.sleep(0.08)
    return {
        "version": 1, "ticker": ticker, "providerSymbol": provider_symbol(ticker), "currency": currency,
        "source": "FMP historical-price-eod/full", "priceBasis": "splitAdjustedClose",
        "volumeBasis": "providerReported", "requestedFrom": start.isoformat(), "requestedTo": today.isoformat(),
        "fetchedAt": datetime.now(timezone.utc).isoformat(), "columns": ["date", "close", "volume"],
        "rows": rows,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="https://us-stock-dcf.vercel.app")
    parser.add_argument("--limit", type=int, default=0, help="Optional cap on missing tickers (0 = all)")
    parser.add_argument("--only", default="", help="Comma-separated tickers to backfill")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    market = json.loads((root / "full_market_dcf.json").read_text(encoding="utf-8"))
    folder = root / "cache" / "price_charts"
    if args.only:
        targets = [ticker.strip().upper() for ticker in args.only.split(",") if ticker.strip()]
    else:
        targets = [ticker for ticker in expansion_tickers(root) if ticker not in market]
        targets = [ticker for ticker in targets if not (folder / f"{ticker}.json").exists()]
        if args.limit:
            targets = targets[: args.limit]
    today = datetime.now(timezone.utc).date()
    ok = failed = 0
    failures = []
    for index, ticker in enumerate(targets, 1):
        previous = read_previous(folder, ticker)
        try:
            record = fetch_prices_via_proxy(args.base, ticker, today)
            guard_empty_erase(ticker, record, previous)
            if not record["rows"]:
                raise RuntimeError(f"{ticker}: empty history from provider")
            write_price_record(folder, ticker, record)
            ok += 1
            print(f"[{index}/{len(targets)}] {ticker}: {len(record['rows'])} rows", flush=True)
        except (RuntimeError, ValueError, urllib.error.HTTPError, urllib.error.URLError) as error:
            failed += 1
            failures.append(ticker)
            print(f"[{index}/{len(targets)}] {ticker}: FAILED {error}", flush=True)
    print(f"Backfill done ok={ok} failed={failed} targets={len(targets)}", flush=True)
    if failures:
        print(f"Failed tickers: {', '.join(failures)}", flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()

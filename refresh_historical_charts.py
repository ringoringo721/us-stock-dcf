#!/usr/bin/env python3
"""Refresh only historical chart data; this command does not run the DCF or AI pipeline."""

import json
import os
import sys
from pathlib import Path

from historical_market_data import fetch_historical_prices, fetch_historical_splits
from validate_market_data import DATA_PATH, configured_symbols, validate_dataset


ROOT = Path(__file__).resolve().parent
MARKET_DATA_JS = ROOT / "market_data.js"
CACHE_DIR = ROOT / "cache/historical_prices"
REPORT_PATH = CACHE_DIR / "coverage_report.json"


def write_atomically(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)


def refresh_chart_history(api_key: str) -> dict:
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    symbols = configured_symbols()
    missing = sorted(set(symbols) - set(data))
    if missing:
        raise ValueError(f"Dataset is missing configured stocks: {', '.join(missing)}")
    for index, symbol in enumerate(symbols, 1):
        split_result = fetch_historical_splits(symbol, api_key, CACHE_DIR)
        split_is_fresh = split_result["metadata"].get("status") == "fresh"
        prices = fetch_historical_prices(
            symbol,
            api_key,
            CACHE_DIR,
            split_events=split_result.get("splits", []),
            adjustment_basis_verified=True,
            split_events_available=split_is_fresh,
        )
        data[symbol]["real_5y_prices"] = [
            {key: row[key] for key in ("date", "close", "volume") if key in row}
            for row in prices.get("prices", [])
        ]
        data[symbol]["price_history_metadata"] = prices.get("metadata", {})
        print(
            f"[{index:03d}/{len(symbols)}] {symbol}: "
            f"{prices.get('metadata', {}).get('status', 'missing')} "
            f"({len(data[symbol]['real_5y_prices'])} daily rows); "
            f"splits {split_result['metadata'].get('status', 'missing')}",
            flush=True,
        )
    report, errors = validate_dataset(data, symbols)
    if errors:
        raise ValueError(f"Chart history validation found {len(errors)} error(s); output files were not replaced.")
    report_content = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    data_content = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    script_content = f"window.FULL_MARKET_DATA = {json.dumps(data, ensure_ascii=False, indent=2)};"
    write_atomically(DATA_PATH, data_content)
    write_atomically(MARKET_DATA_JS, script_content)
    write_atomically(REPORT_PATH, report_content)
    return report


def main() -> int:
    api_key = os.environ.get("FMP_API_KEY", "").strip()
    if not api_key:
        print("FMP_API_KEY is required; chart data was not refreshed.", file=sys.stderr)
        return 2
    try:
        report = refresh_chart_history(api_key)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"Historical chart refresh stopped: {error}", file=sys.stderr)
        return 1
    print(
        f"Chart-only refresh validated {report['stocks_with_records']}/"
        f"{report['configured_stock_count']} stocks. "
        f"Price statuses: {report['historical_price_status_counts']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

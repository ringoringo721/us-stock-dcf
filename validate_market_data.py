#!/usr/bin/env python3
"""Validate chart-data contracts and write a per-stock availability report."""

import argparse
import ast
import json
import math
import re
import sys
from collections import Counter
from datetime import date, datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "full_market_dcf.json"
CONFIG_PATH = ROOT / "build_full_market.py"
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def configured_symbols() -> list[str]:
    tree = ast.parse(CONFIG_PATH.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "RAW_STOCK_LIST"
            for target in node.targets
        ):
            entries = ast.literal_eval(node.value)
            return sorted({entry["ticker"].strip().upper() for entry in entries if entry.get("ticker")})
    raise ValueError("RAW_STOCK_LIST was not found in build_full_market.py")


def valid_price(row: object) -> bool:
    if not isinstance(row, dict) or not DATE_RE.fullmatch(str(row.get("date", ""))):
        return False
    try:
        date.fromisoformat(row["date"])
        value = float(row["close"])
    except (ValueError, TypeError, KeyError, OverflowError):
        return False
    return math.isfinite(value) and value > 0


def validate_dataset(data: object, symbols: list[str]) -> tuple[dict, list[str]]:
    if not isinstance(data, dict):
        raise ValueError("Dataset root must be a JSON object")
    errors = []
    stocks = {}
    today_date = date.today()
    today = today_date.isoformat()
    try:
        five_year_cutoff = today_date.replace(year=today_date.year - 5).isoformat()
    except ValueError:
        five_year_cutoff = today_date.replace(year=today_date.year - 5, day=28).isoformat()
    price_status_counts = Counter()
    model_status_counts = Counter()
    for symbol in symbols:
        stock = data.get(symbol)
        if not isinstance(stock, dict):
            errors.append(f"{symbol}: missing stock object")
            continue
        metadata = stock.get("price_history_metadata") or {}
        rows = stock.get("real_5y_prices", [])
        if not isinstance(metadata, dict) or not isinstance(rows, list):
            errors.append(f"{symbol}: malformed historical-price metadata or series")
            continue
        price_status = metadata.get("status", "missing")
        if price_status not in {"fresh", "stale", "error", "missing", "missing_key"}:
            errors.append(f"{symbol}: unknown historical-price status {price_status!r}")
        if price_status == "fresh" and rows == []:
            errors.append(f"{symbol}: marked fresh without historical prices")
        seen = set()
        dates = []
        for row in rows:
            if not valid_price(row):
                errors.append(f"{symbol}: malformed/non-finite historical-price row")
                continue
            if row["date"] in seen:
                errors.append(f"{symbol}: duplicate historical-price date {row['date']}")
            seen.add(row["date"])
            dates.append(row["date"])
            if row["date"] < five_year_cutoff or row["date"] > today:
                errors.append(f"{symbol}: historical price outside five-year window {row['date']}")
        if dates != sorted(dates):
            errors.append(f"{symbol}: historical prices are not in chronological order")
        if rows and not metadata.get("source"):
            errors.append(f"{symbol}: historical prices have no source provenance")
        price_status_counts[price_status] += 1

        valuations = stock.get("historical_valuations", [])
        if not isinstance(valuations, list):
            errors.append(f"{symbol}: historical_valuations must be an array")
            valuations = []
        available_count = 0
        unavailable_count = 0
        missing_reasons = Counter()
        valuation_dates = []
        for point in valuations:
            if not isinstance(point, dict):
                errors.append(f"{symbol}: malformed historical valuation point")
                continue
            status = point.get("status")
            fiscal_end = point.get("fiscal_end_date")
            valuation_date = point.get("valuation_date")
            if fiscal_end is not None and (
                not isinstance(fiscal_end, str) or not DATE_RE.fullmatch(fiscal_end)
            ):
                errors.append(f"{symbol}: historical valuation has an invalid fiscal end date")
            if valuation_date is not None:
                if not isinstance(valuation_date, str) or not DATE_RE.fullmatch(valuation_date):
                    errors.append(f"{symbol}: historical valuation has an invalid valuation date")
                else:
                    valuation_dates.append(valuation_date)
                    if valuation_date > today:
                        errors.append(f"{symbol}: historical valuation date is in the future")
                    if isinstance(fiscal_end, str) and DATE_RE.fullmatch(fiscal_end) and valuation_date < fiscal_end:
                        errors.append(f"{symbol}: valuation date precedes the fiscal period end")
            if status == "available":
                value = point.get("value_per_share")
                availability_date = point.get("availability_date")
                if not isinstance(availability_date, str) or not DATE_RE.fullmatch(availability_date):
                    errors.append(f"{symbol}: available valuation has no full information-availability date")
                if availability_date != valuation_date:
                    errors.append(f"{symbol}: valuation date does not match its information-availability date")
                available_timestamp = point.get("availability_timestamp")
                try:
                    parsed_availability = datetime.fromisoformat(available_timestamp.replace("Z", "+00:00"))
                except (AttributeError, ValueError):
                    parsed_availability = None
                if parsed_availability is None or (
                    isinstance(availability_date, str)
                    and parsed_availability.date().isoformat() != availability_date
                ):
                    errors.append(f"{symbol}: available valuation has an invalid filing-availability timestamp")
                if not isinstance(valuation_date, str) or not DATE_RE.fullmatch(valuation_date):
                    errors.append(f"{symbol}: available valuation has no full valuation date")
                try:
                    number = float(value)
                except (TypeError, ValueError, OverflowError):
                    number = float("nan")
                if not math.isfinite(number) or number <= 0:
                    errors.append(f"{symbol}: available valuation is non-finite or non-positive")
                required_inputs = ("fcff_ttm", "cash", "debt", "shares")
                if any(not isinstance(point.get(key), (int, float)) or not math.isfinite(point[key]) for key in required_inputs):
                    errors.append(f"{symbol}: available valuation has missing/non-finite model inputs")
                if not isinstance(point.get("shares"), (int, float)) or point.get("shares", 0) <= 0:
                    errors.append(f"{symbol}: available valuation has non-positive shares")
                assumptions = point.get("assumptions") or {}
                try:
                    valid_discount = (
                        isinstance(assumptions, dict)
                        and math.isfinite(float(assumptions["discount_rate"]))
                        and math.isfinite(float(assumptions["terminal_growth"]))
                        and float(assumptions["discount_rate"]) > float(assumptions["terminal_growth"])
                    )
                except (KeyError, TypeError, ValueError, OverflowError):
                    valid_discount = False
                if not valid_discount:
                    errors.append(f"{symbol}: available valuation has invalid discount/terminal-growth assumptions")
                if (
                    point.get("currency") != "USD"
                    or point.get("share_basis_verified") is not True
                    or point.get("adjustment_basis_verified") is not True
                ):
                    errors.append(f"{symbol}: available valuation has unverified currency/share/split basis")
                if not point.get("assumptions") or not point.get("provenance") or not point.get("limitation"):
                    errors.append(f"{symbol}: available valuation lacks assumptions, provenance, or limitation")
                available_count += 1
            elif status == "unavailable":
                unavailable_count += 1
                reason = point.get("missing_reason")
                if not isinstance(reason, str) or not reason.strip():
                    errors.append(f"{symbol}: unavailable valuation has no reason")
                missing_reasons[reason or "reason not provided"] += 1
            else:
                errors.append(f"{symbol}: unknown historical-valuation status {status!r}")
        if valuation_dates != sorted(valuation_dates):
            errors.append(f"{symbol}: historical valuations are not in chronological order")
        model_status_counts["available"] += available_count
        model_status_counts["unavailable"] += unavailable_count
        stocks[symbol] = {
            "price_count": len(rows),
            "price_start": min(dates) if dates else None,
            "price_end": max(dates) if dates else None,
            "price_status": price_status,
            "price_basis_verified": metadata.get("adjustment_semantics_verified") is True,
            "price_last_good_at": metadata.get("last_good_at"),
            "price_last_error": metadata.get("last_error"),
            "statement_status": (stock.get("financial_statements_metadata") or {}).get("status", "missing"),
            "model_available_count": available_count,
            "model_unavailable_count": unavailable_count,
            "model_missing_reasons": dict(missing_reasons),
        }
    extras = sorted(set(data) - set(symbols))
    report = {
        "generated_at": date.today().isoformat(),
        "configured_stock_count": len(symbols),
        "dataset_stock_count": len(data),
        "stocks_with_records": len(stocks),
        "historical_price_status_counts": dict(price_status_counts),
        "historical_model_status_counts": dict(model_status_counts),
        "extra_dataset_symbols": extras,
        "stocks": stocks,
        "validation_errors": errors,
    }
    return report, errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=DATA_PATH)
    parser.add_argument("--report", type=Path, default=ROOT / "cache/historical_prices/coverage_report.json")
    args = parser.parse_args()
    try:
        symbols = configured_symbols()
        data = json.loads(args.data.read_text(encoding="utf-8"))
        report, errors = validate_dataset(data, symbols)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, json.JSONDecodeError, ValueError, KeyError) as error:
        print(f"Validation could not complete: {error}", file=sys.stderr)
        return 1
    print(
        f"Validated {report['stocks_with_records']}/{report['configured_stock_count']} configured stocks; "
        f"prices: {report['historical_price_status_counts']}; "
        f"historical estimates: {report['historical_model_status_counts']}; "
        f"errors: {len(errors)}"
    )
    for error in errors:
        print(error, file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())

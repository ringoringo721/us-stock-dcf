"""Read-only FMP evidence capture; never modifies published financial or price datasets."""

from collections import Counter
import calendar
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import time

import requests

ENDPOINTS = {
    "profile": ("profile", {}),
    "quote": ("quote", {}),
    "balance": ("balance-sheet-statement", {"period": "quarter", "limit": 8}),
    "income": ("income-statement", {"period": "quarter", "limit": 8}),
    "cashflow": ("cash-flow-statement", {"period": "quarter", "limit": 8}),
    "annual_income": ("income-statement", {"period": "annual", "limit": 5}),
    "annual_balance": ("balance-sheet-statement", {"period": "annual", "limit": 5}),
    "annual_cashflow": ("cash-flow-statement", {"period": "annual", "limit": 5}),
    "estimates": ("analyst-estimates", {"period": "annual", "limit": 12}),
    "enterprise_values": ("enterprise-values", {"period": "quarter", "limit": 1}),
    "shares_float": ("shares-float", {}),
}
LEASE_ENDPOINTS = {
    "balance_as_reported": ("balance-sheet-statement-as-reported", {"period": "quarter", "limit": 8}),
    "income_as_reported": ("income-statement-as-reported", {"period": "quarter", "limit": 8}),
    "cashflow_as_reported": ("cash-flow-statement-as-reported", {"period": "quarter", "limit": 8}),
}
HK_EXTRA_ENDPOINTS = {
    **LEASE_ENDPOINTS,
    "dividends": ("dividends", {"limit": 100}),
    "splits": ("splits", {"limit": 100}),
    "peers": ("stock-peers", {}),
    "news": ("news/stock", {"limit": 12}),
    "shares_float": ("shares-float", {}),
}

def configured_market(root, name):
    if name == "HKEX":
        reviewed = json.loads((root / "hkex_stocks.json").read_text(encoding="utf-8"))
        listed = json.loads((root / "cache" / "hkex_universe.json").read_text(encoding="utf-8"))["stocks"] \
            if os.environ.get("CAPTURE_ALL_HK") == "true" else []
        return {stock["ticker"]: stock for stock in [*listed, *reviewed]}
    if name == "US":
        reviewed = json.loads((root / "full_market_dcf.json").read_text(encoding="utf-8"))
        if os.environ.get("CAPTURE_ALL_US") == "true":
            listed = json.loads((root / "cache" / "us_universe.json").read_text(encoding="utf-8"))["stocks"]
            return {**{stock["ticker"]: stock for stock in listed}, **reviewed}
        return reviewed
    raise ValueError("CAPTURE_MARKET must be US or HKEX")


def selected_symbols(market, supplied):
    if not supplied:
        return list(market)
    symbols = list(dict.fromkeys(value.strip().upper() for value in supplied.split(",") if value.strip()))
    if not symbols or len(symbols) > 20 or any(
            not re.fullmatch(r"[A-Z0-9]+(?:[.-][A-Z0-9]+)*", symbol) for symbol in symbols):
        raise ValueError("Source capture requires 1-20 valid comma-separated symbols")
    return symbols


def provider_symbol(ticker):
    return ticker if ticker.endswith(".HK") else ticker.replace(".", "-")


def outstanding_share_record(rows, symbol, as_of):
    if not isinstance(rows, list):
        raise ValueError("Outstanding-share source must be a list of dated records")
    cutoff = datetime.strptime(as_of, "%Y-%m-%d").date()
    eligible = []
    for row in rows:
        if not isinstance(row, dict) or row.get("symbol") != symbol:
            continue
        count, source_date = row.get("outstandingShares"), row.get("date")
        if (type(count) not in (int, float) or not 0 < count <= 9007199254740991
                or count % 1 != 0 or not isinstance(source_date, str)
                or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", source_date[:10])):
            continue
        try:
            observed = datetime.strptime(source_date[:10], "%Y-%m-%d").date()
        except ValueError:
            continue
        if observed <= cutoff:
            eligible.append(row)
    return max(eligible, key=lambda row: row["date"][:10], default=None)


def years_before(day, years):
    year = day.year - years
    return day.replace(year=year, day=min(day.day, calendar.monthrange(year, day.month)[1]))


def capture(session, endpoint, params, key):
    for attempt in range(3):
        try:
            response = session.get(
                f"https://financialmodelingprep.com/stable/{endpoint}",
                params={**params, "apikey": key}, timeout=30)
        except requests.RequestException as error:
            return {"ok": False, "error": type(error).__name__}
        if response.status_code not in (429, 500, 502, 503, 504) or attempt == 2:
            break
        time.sleep(5 * (attempt + 1))
    time.sleep(max(0.16, float(os.environ.get("CAPTURE_REQUEST_DELAY", "0.16"))))
    if response.status_code != 200:
        return {"ok": False, "httpStatus": response.status_code}
    try:
        payload = response.json()
    except ValueError:
        return {"ok": False, "httpStatus": 200, "error": "InvalidJSON"}
    if not isinstance(payload, list):
        return {"ok": False, "httpStatus": 200, "error": "UnexpectedResponse"}
    # Source rows are public market/financial data; redact any unexpected key echo.
    payload = json.loads(json.dumps(payload).replace(key, "[REDACTED]"))
    return {"ok": True, "httpStatus": 200, "rows": payload}


def main():
    root = Path(__file__).resolve().parent.parent
    key = os.environ.get("FMP_API_KEY")
    if not key:
        raise RuntimeError("FMP_API_KEY is required for read-only source capture")
    market = configured_market(root, os.environ.get("CAPTURE_MARKET", "US"))
    symbols = selected_symbols(market, os.environ.get("CAPTURE_SYMBOLS", ""))
    output = (root / os.environ.get("CAPTURE_OUTPUT", "valuation-audit-output")).resolve()
    if root not in output.parents:
        raise ValueError("Capture output must be a dedicated repository subdirectory")
    output.mkdir(exist_ok=True)
    now = datetime.now(timezone.utc)
    leases_only = os.environ.get("CAPTURE_LEASE_SOURCES_ONLY") == "true"
    fcff_only = os.environ.get("CAPTURE_FCFF_SOURCES_ONLY") == "true"
    shares_only = os.environ.get("CAPTURE_SHARES_ONLY") == "true"
    endpoints = LEASE_ENDPOINTS if leases_only else ENDPOINTS
    if fcff_only:
        endpoints = {name: value for name, value in ENDPOINTS.items()
                     if name in ("profile", "quote", "balance", "income", "cashflow",
                                 "annual_income", "annual_balance", "annual_cashflow", "estimates")}
        endpoints["balance_as_reported"] = LEASE_ENDPOINTS["balance_as_reported"]
        endpoints["shares_float"] = ENDPOINTS["shares_float"]
    if shares_only:
        endpoints = {"shares_float": ENDPOINTS["shares_float"]}
    summary = {"gitCommit": os.environ.get("GITHUB_SHA"), "capturedAt": now.isoformat(),
               "sourceScope": "shares" if shares_only else "leases" if leases_only else "fcff" if fcff_only else "valuation",
               "stocks": len(symbols), "successfulResponses": 0, "emptyResponses": 0, "errors": []}
    outcomes = Counter()
    with requests.Session() as session:
        for ticker in symbols:
            symbol = provider_symbol(ticker)
            record = {"ticker": ticker, "providerSymbol": symbol,
                      "capturedAt": datetime.now(timezone.utc).isoformat(), "responses": {}}
            saved_path = output / f"{ticker}.json"
            if os.environ.get("CAPTURE_RESUME") == "true" and saved_path.exists():
                saved = json.loads(saved_path.read_text(encoding="utf-8"))
                captured = datetime.fromisoformat(saved["capturedAt"])
                if saved.get("ticker") != ticker or saved.get("providerSymbol") != symbol:
                    raise ValueError("Resume source identity mismatch")
                if timedelta(0) <= now - captured <= timedelta(days=7):
                    record["responses"] = {name: value for name, value in saved["responses"].items()
                                           if value.get("ok") is True}
            ticker_endpoints = dict(endpoints)
            if ticker.endswith(".HK") and not leases_only and not shares_only:
                ticker_endpoints.update(HK_EXTRA_ENDPOINTS)
                ticker_endpoints["news"] = ("news/stock", {"symbols": symbol, "limit": 12})
                ticker_endpoints = {
                    name: (endpoint, {**params, "limit": 32 if params.get("period") == "quarter" else 8})
                    if name in ("income", "balance", "cashflow", "annual_income", "annual_balance", "annual_cashflow")
                    else (endpoint, params)
                    for name, (endpoint, params) in ticker_endpoints.items()
                }
                ticker_endpoints["earnings_releases"] = ("earnings", {"limit": 20})
                ticker_endpoints["transcript_dates"] = ("earning-call-transcript-dates", {})
                for name, first, last in (
                        ("prices_older", years_before(now.date(), 20).isoformat(),
                         (years_before(now.date(), 10) - timedelta(days=1)).isoformat()),
                        ("prices_recent", years_before(now.date(), 10).isoformat(), now.date().isoformat())):
                    ticker_endpoints[name] = ("historical-price-eod/full", {"from": first, "to": last})
            for name, (endpoint, params) in ticker_endpoints.items():
                result = record["responses"].get(name) or capture(session, endpoint, {"symbol": symbol, **params}, key)
                record["responses"][name] = result
                if result["ok"]:
                    summary["successfulResponses"] += 1
                    summary["emptyResponses"] += not bool(result["rows"])
                    outcomes[f"{name}: {'nonempty' if result['rows'] else 'empty'}"] += 1
                else:
                    summary["errors"].append({"ticker": ticker, "endpoint": name, **result})
                    outcomes[f"{name}: error"] += 1
            if ticker.endswith(".HK") and not leases_only:
                dates = record["responses"].get("transcript_dates", {}).get("rows", [])
                available = [row for row in dates if isinstance(row, dict)
                             and str(row.get("date", ""))[:10] <= now.date().isoformat()
                             and str(row.get("fiscalYear", "")).isdigit()
                             and str(row.get("quarter", "")) in ("1", "2", "3", "4")]
                if available:
                    latest = max(available, key=lambda row: str(row["date"]))
                    result = capture(session, "earning-call-transcript", {
                        "symbol": symbol, "year": latest["fiscalYear"], "quarter": latest["quarter"]
                    }, key)
                    record["responses"]["transcript_latest"] = result
                    if result["ok"]:
                        summary["successfulResponses"] += 1
                        summary["emptyResponses"] += not bool(result["rows"])
                        outcomes[f"transcript_latest: {'nonempty' if result['rows'] else 'empty'}"] += 1
                    else:
                        summary["errors"].append({"ticker": ticker, "endpoint": "transcript_latest", **result})
                        outcomes["transcript_latest: error"] += 1
            if not leases_only and not fcff_only and not shares_only and ticker in ("NVDA", "JPM"):
                record["responses"]["backend_estimates_query"] = capture(
                    session, "analyst-estimates", {"symbol": symbol, "limit": 4}, key)
            if not leases_only and not fcff_only and not shares_only and ticker == "BRK.B":
                record["responses"]["backend_symbol_profile"] = capture(
                    session, "profile", {"symbol": "BRKB"}, key)
                record["responses"]["backend_symbol_quote"] = capture(
                    session, "quote", {"symbol": "BRKB"}, key)
            (output / f"{ticker}.json").write_text(json.dumps(record, separators=(",", ":")), encoding="utf-8")
            print(f"{ticker}: source evidence captured (no valuation updates)", flush=True)
        treasury = capture(session, "treasury-rates", {
            "from": (now - timedelta(days=14)).date().isoformat(), "to": now.date().isoformat()
        }, key)
        (output / "treasury.json").write_text(json.dumps(treasury), encoding="utf-8")
    summary["endpointOutcomes"] = dict(outcomes)
    (output / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2), flush=True)
    if summary["errors"] or not treasury["ok"]:
        print("::warning::Some FMP sources were unavailable; see audit artifacts. Capture success does not certify valuations.", flush=True)


if __name__ == "__main__":
    main()

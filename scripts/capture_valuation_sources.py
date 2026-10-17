"""Read-only FMP evidence capture; never modifies published financial or price datasets."""

from collections import Counter
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
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
}
LEASE_ENDPOINTS = {
    "balance_as_reported": ("balance-sheet-statement-as-reported", {"period": "quarter", "limit": 8}),
    "income_as_reported": ("income-statement-as-reported", {"period": "quarter", "limit": 8}),
    "cashflow_as_reported": ("cash-flow-statement-as-reported", {"period": "quarter", "limit": 8}),
}


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
    time.sleep(0.16)
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
    market = json.loads((root / "full_market_dcf.json").read_text(encoding="utf-8"))
    output = root / "valuation-audit-output"
    output.mkdir(exist_ok=True)
    now = datetime.now(timezone.utc)
    leases_only = os.environ.get("CAPTURE_LEASE_SOURCES_ONLY") == "true"
    fcff_only = os.environ.get("CAPTURE_FCFF_SOURCES_ONLY") == "true"
    endpoints = LEASE_ENDPOINTS if leases_only else ENDPOINTS
    if fcff_only:
        endpoints = {name: value for name, value in ENDPOINTS.items()
                     if name in ("profile", "quote", "balance", "income", "cashflow",
                                 "annual_income", "annual_balance", "annual_cashflow", "estimates")}
        endpoints["balance_as_reported"] = LEASE_ENDPOINTS["balance_as_reported"]
    summary = {"gitCommit": os.environ.get("GITHUB_SHA"), "capturedAt": now.isoformat(),
               "sourceScope": "leases" if leases_only else "fcff" if fcff_only else "valuation",
               "stocks": len(market), "successfulResponses": 0, "emptyResponses": 0, "errors": []}
    outcomes = Counter()
    with requests.Session() as session:
        for ticker in market:
            symbol = ticker.replace(".", "-")
            record = {"ticker": ticker, "providerSymbol": symbol,
                      "capturedAt": datetime.now(timezone.utc).isoformat(), "responses": {}}
            for name, (endpoint, params) in endpoints.items():
                result = capture(session, endpoint, {"symbol": symbol, **params}, key)
                record["responses"][name] = result
                if result["ok"]:
                    summary["successfulResponses"] += 1
                    summary["emptyResponses"] += not bool(result["rows"])
                    outcomes[f"{name}: {'nonempty' if result['rows'] else 'empty'}"] += 1
                else:
                    summary["errors"].append({"ticker": ticker, "endpoint": name, **result})
                    outcomes[f"{name}: error"] += 1
            if not leases_only and not fcff_only and ticker in ("NVDA", "JPM"):
                record["responses"]["backend_estimates_query"] = capture(
                    session, "analyst-estimates", {"symbol": symbol, "limit": 4}, key)
            if not leases_only and not fcff_only and ticker == "BRK.B":
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

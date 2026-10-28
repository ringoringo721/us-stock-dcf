"""Refresh isolated liquidation inputs; never substitutes DCF balances or quote defaults."""

from datetime import date, datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time

import requests

FIELDS = ("totalCurrentAssets", "totalLiabilities", "cashAndShortTermInvestments",
          "accountsReceivables", "netReceivables", "otherReceivables", "inventory", "preferredStock")


def number(value):
    return value if not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) else None


def build_record(ticker, responses, captured_at):
    symbol = ticker.replace(".", "-")
    rows = {}
    for name in ("balance", "quote", "profile"):
        result = responses[name]
        if not result.get("ok") or not isinstance(result.get("rows"), list) or not result["rows"]:
            raise ValueError(f"{ticker}: unavailable {name}; existing liquidation snapshot retained")
        rows[name] = result["rows"]
        if any(not isinstance(row, dict) or row.get("symbol") != symbol for row in rows[name]):
            raise ValueError(f"{ticker}: incorrect {name} symbol")
    today = date.fromisoformat(captured_at[:10])
    balances = {}
    for row in rows["balance"]:
        try:
            day = date.fromisoformat(row["date"])
        except (KeyError, TypeError, ValueError):
            raise ValueError(f"{ticker}: invalid balance date") from None
        if day > today or row.get("period") not in ("Q1", "Q2", "Q3", "Q4"):
            raise ValueError(f"{ticker}: not a published quarterly balance")
        for field in ("filingDate", "acceptedDate"):
            if row.get(field):
                try:
                    filing_day = date.fromisoformat(str(row[field])[:10])
                except ValueError:
                    raise ValueError(f"{ticker}: invalid filing date") from None
                if filing_day > today:
                    raise ValueError(f"{ticker}: future filing")
        if day in balances and balances[day] != row:
            raise ValueError(f"{ticker}: conflicting balance records")
        balances[day] = row
    balance = balances[max(balances)]
    if not isinstance(balance.get("reportedCurrency"), str) or not re.fullmatch(r"[A-Z]{3}", balance["reportedCurrency"]):
        raise ValueError(f"{ticker}: missing reported currency")
    if len(rows["quote"]) != 1 or len(rows["profile"]) != 1 or rows["profile"][0].get("currency") != "USD":
        raise ValueError(f"{ticker}: USD listing currency could not be verified")
    quote = rows["quote"][0]
    timestamp = number(quote.get("timestamp"))
    try:
        quote_date = datetime.fromtimestamp(timestamp, timezone.utc).date()
    except (TypeError, ValueError, OverflowError, OSError):
        raise ValueError(f"{ticker}: missing quote timestamp") from None
    if quote_date > today:
        raise ValueError(f"{ticker}: future quote")
    return {
        "ticker": ticker, "providerSymbol": symbol, "fetchedAt": captured_at,
        "balance": {"date": balance["date"], "period": balance["period"],
                    "reportedCurrency": balance["reportedCurrency"],
                    "filingDate": str(balance["filingDate"])[:10] if balance.get("filingDate") else None,
                    "acceptedDate": str(balance["acceptedDate"])[:10] if balance.get("acceptedDate") else None,
                    **{field: number(balance.get(field)) for field in FIELDS}},
        "quote": {"currency": "USD", "date": quote_date.isoformat(),
                  "price": number(quote.get("price")), "marketCap": number(quote.get("marketCap"))}
    }


def fetch_rows(session, endpoint, params, key):
    for attempt in range(3):
        try:
            response = session.get(f"https://financialmodelingprep.com/stable/{endpoint}",
                                   params={**params, "apikey": key}, timeout=30)
        except requests.RequestException as error:
            raise RuntimeError(f"FMP {endpoint}: network failure ({type(error).__name__})") from None
        if response.status_code not in (429, 500, 502, 503, 504) or attempt == 2:
            break
        time.sleep(5 * (attempt + 1))
    time.sleep(0.16)
    if response.status_code != 200:
        raise RuntimeError(f"FMP {endpoint}: HTTP {response.status_code}; existing liquidation snapshot retained")
    try:
        payload = response.json()
    except ValueError:
        raise ValueError(f"FMP {endpoint}: invalid JSON") from None
    if not isinstance(payload, list):
        raise ValueError(f"FMP {endpoint}: unexpected response")
    return {"ok": True, "rows": payload}


def expansion_tickers(root):
    path = root / "us_expansion_data.js"
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8")
    payload = text.split("=", 1)[1].strip().rstrip(";")
    data = json.loads(payload)
    return sorted(data.get("stocks", {}))


def fetch_record(session, ticker, key, captured_at):
    if not re.fullmatch(r"[A-Z0-9]+(?:[.-][A-Z0-9]+)*", ticker):
        raise ValueError("Invalid market ticker")
    symbol = ticker.replace(".", "-")
    responses = {
        "balance": fetch_rows(session, "balance-sheet-statement",
                              {"symbol": symbol, "period": "quarter", "limit": 4}, key),
        "quote": fetch_rows(session, "quote", {"symbol": symbol}, key),
        "profile": fetch_rows(session, "profile", {"symbol": symbol}, key)
    }
    return build_record(ticker, responses, captured_at)


def main():
    root = Path(__file__).resolve().parent.parent
    key = os.environ.get("FMP_API_KEY")
    if not key:
        raise RuntimeError("FMP_API_KEY is required; liquidation sources were not refreshed")
    market = json.loads((root / "full_market_dcf.json").read_text(encoding="utf-8"))
    previous = {}
    previous_path = root / "cache" / "liquidation_sources.json"
    if previous_path.exists():
        try:
            previous = json.loads(previous_path.read_text(encoding="utf-8")).get("stocks") or {}
        except (TypeError, ValueError, json.JSONDecodeError):
            previous = {}
    records = {}
    captured_at = datetime.now(timezone.utc).isoformat()
    expansion_ok = expansion_retained = expansion_failed = 0
    with requests.Session() as session:
        for ticker in market:
            records[ticker] = fetch_record(session, ticker, key, captured_at)
            print(f"{ticker}: liquidation balance {records[ticker]['balance']['date']}", flush=True)
        for ticker in expansion_tickers(root):
            if ticker in market:
                continue
            try:
                records[ticker] = fetch_record(session, ticker, key, captured_at)
                expansion_ok += 1
                print(f"{ticker}: liquidation balance {records[ticker]['balance']['date']}", flush=True)
            except (ValueError, RuntimeError) as error:
                if ticker in previous:
                    records[ticker] = previous[ticker]
                    expansion_retained += 1
                    print(f"{ticker}: retained previous liquidation source ({error})", flush=True)
                else:
                    expansion_failed += 1
                    print(f"{ticker}: expansion liquidation skipped ({error})", flush=True)
    output = {"version": 1, "source": "FMP stable balance-sheet-statement, quote, profile",
              "refreshedAt": captured_at, "stocks": records}
    folder = root / "cache"
    folder.mkdir(exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=folder, delete=False) as destination:
        temporary = Path(destination.name)
        json.dump(output, destination, ensure_ascii=False, separators=(",", ":"))
        destination.write("\n")
    try:
        os.replace(temporary, folder / "liquidation_sources.json")
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Refreshed {len(records)} liquidation sources "
          f"(expansion ok={expansion_ok}, retained={expansion_retained}, skipped={expansion_failed}); "
          f"DCF inputs unchanged", flush=True)


if __name__ == "__main__":
    main()

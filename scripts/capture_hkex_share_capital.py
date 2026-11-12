#!/usr/bin/env python3
"""Capture HKEX monthly returns into cache/hkex_share_capital.json.

Parses FF301 "Monthly Return of Equity Issuer on Movements in Securities"
PDFs for issuer-wide ordinary share classes (issued and treasury). Does not
substitute diluted weighted-average shares or market-cap/price estimates.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from datetime import date, datetime, timezone
from html import unescape
from io import BytesIO
from pathlib import Path

import requests
from pypdf import PdfReader

HOST = "https://www1.hkexnews.hk"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; financial-statement-review)"}
MONTHS = {
    "January": "01", "February": "02", "March": "03", "April": "04",
    "May": "05", "June": "06", "July": "07", "August": "08",
    "September": "09", "October": "10", "November": "11", "December": "12",
}


def display_code(ticker: str) -> str:
    return ticker.replace(".HK", "").zfill(5)


def parse_month_end(text: str) -> str | None:
    match = re.search(r"For the month ended:\s*(\d{1,2})\s+(\w+)\s+(\d{4})", text)
    if not match:
        return None
    day, month, year = match.group(1), match.group(2), match.group(3)
    if month not in MONTHS:
        return None
    return f"{year}-{MONTHS[month]}-{int(day):02d}"


def parse_submitted(text: str) -> str | None:
    match = re.search(r"Date Submitted:\s*(\d{1,2})\s+(\w+)\s+(\d{4})", text)
    if not match:
        return None
    day, month, year = match.group(1), match.group(2), match.group(3)
    if month not in MONTHS:
        return None
    return f"{year}-{MONTHS[month]}-{int(day):02d}"


HEADER_NAMES = {
    "numberofissued", "numberofauthorised", "numberofauthorized", "excludingtreasury",
    "parvalue", "authorised", "authorized", "registered", "shares", "share",
}


def normalize_class_name(raw: str) -> str:
    name = re.sub(r"\s+", " ", raw.strip())
    name = re.sub(r"\s+Shares?$", "", name, flags=re.I).strip()
    aliases = {
        "Hong Kong": "HongKong",
        "HK": "HongKong",
        "Domestic": "Domestic",
        "Domesticshares": "Domestic",  # Description line without space after OCR/join
        "Unlisted": "Unlisted",
        "Ordinary": "Ordinary",
        "A": "A",
        "B": "B",
        "D": "D",
        "H": "H",
        "RMB": "RMB",
    }
    if name in aliases:
        return aliases[name]
    compact = name.replace(" ", "")
    if compact in aliases:
        return aliases[compact]
    lowered = compact.lower()
    if not compact or lowered in {
        "notapplicable", "na", "n/a", "othertype(specifyindescription)", "other"
    } or any(token in lowered for token in HEADER_NAMES):
        return ""
    return compact


def class_name_from_part(part: str, raw_type: str) -> str:
    name = normalize_class_name(raw_type)
    if name:
        return name
    # Only read the remainder of the Description line; do not spill into the next
    # table header via newline-matching \\s*.
    desc_match = re.search(r"Description[ \t]*([^\n\r]*)", part)
    if desc_match:
        desc = normalize_class_name(desc_match.group(1))
        if desc:
            return desc
    # Single-class HK issuers often leave Type/Description blank ("Not applicable").
    return "Ordinary"


def parse_ff301(content: bytes) -> dict:
    reader = PdfReader(BytesIO(content))
    text = "\n".join((page.extract_text() or "") for page in reader.pages)
    month_end = parse_month_end(text)
    filing_date = parse_submitted(text)
    if not month_end or not filing_date:
        raise ValueError("monthly return missing month-end or filing date")
    issuer = None
    issuer_match = re.search(r"Name of Issuer:\s*(.+)", text)
    if issuer_match:
        issuer = issuer_match.group(1).strip()
    classes = []
    # Standard ordinary shares and WVR ordinary shares are both ordinary equity.
    parts = re.split(
        r"Class of shares\s+(?:WVR\s+)?Ordinary shares\s+Type of shares\s+",
        text,
        flags=re.I,
    )
    for part in parts[1:]:
        type_match = re.match(
            r"(.+?)(?:\s+Listed on the Exchange)",
            part.strip(),
            re.S,
        )
        if not type_match:
            continue
        raw_type = re.sub(r"\s+", " ", type_match.group(1)).strip()
        balances = re.findall(
            r"Balance at close of the month\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)",
            part,
        )
        if not balances:
            continue
        name = class_name_from_part(part, raw_type)
        if not name:
            raise ValueError("ordinary class name unresolved")
        issued_ex_treasury, treasury, total = [
            int(value.replace(",", "")) for value in balances[0]
        ]
        if total <= 0 or treasury < 0 or treasury > total:
            raise ValueError(f"invalid share counts for class {name}")
        if issued_ex_treasury != total - treasury:
            raise ValueError(f"issued/treasury/total mismatch for class {name}")
        if any(row["name"] == name for row in classes):
            continue
        classes.append({
            "name": name,
            "type": "ordinary",
            "issuedShares": total,
            "treasuryShares": treasury,
        })
    if len(classes) < 1:
        raise ValueError("no ordinary share classes parsed from monthly return")
    outstanding = sum(row["issuedShares"] - row["treasuryShares"] for row in classes)
    if outstanding <= 0:
        raise ValueError("non-positive issuer-wide ordinary shares")
    return {
        "date": month_end,
        "filingDate": filing_date,
        "issuerName": issuer,
        "classes": classes,
        "outstandingShares": outstanding,
        "pdfPages": list(range(1, min(4, len(reader.pages)) + 1)),
        "textSample": text[:240],
    }


def latest_monthly_filing(session: requests.Session, stock_id: int, from_date: str, to_date: str):
    payload = session.get(
        f"{HOST}/search/titleSearchServlet.do",
        params={
            "sortDir": "0",
            "sortByOptions": "DateTime",
            "category": "0",
            "market": "SEHK",
            "stockId": str(stock_id),
            "documentType": "-1",
            "fromDate": from_date,
            "toDate": to_date,
            "title": "Monthly Return",
            "searchType": "1",
            "t1code": "-2",
            "t2Gcode": "-2",
            "t2code": "-2",
            "lang": "E",
        },
        headers=HEADERS,
        timeout=45,
    ).json()
    raw = payload.get("result")
    if not raw:
        return None
    filings = json.loads(raw)
    for filing in filings:
        title = unescape(filing.get("TITLE", ""))
        if re.search(r"Monthly\s+Return\s+of\s+Equity\s+Issuer", title, re.I):
            return filing
    return filings[0] if filings else None


def provider_outstanding(stock: dict) -> tuple[int | None, str | None]:
    comparison = (stock.get("shareSource") or {}).get("providerComparison") or {}
    shares = comparison.get("shares")
    as_of = comparison.get("date")
    if isinstance(shares, (int, float)) and shares > 0:
        return int(round(shares * 1e6)), as_of
    return None, as_of


def build_record(ticker: str, filing: dict, content: bytes, parsed: dict, provider_shares: int | None, provider_date: str | None):
    url = HOST + filing["FILE_LINK"]
    outstanding = parsed["outstandingShares"]
    known = [outstanding, *[
        row["issuedShares"] - row["treasuryShares"] for row in parsed["classes"]
    ]]
    record = {
        "ticker": ticker,
        "date": parsed["date"],
        "filingDate": parsed["filingDate"],
        "verifiedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "coverage": "allOrdinaryShareClasses",
        "source": f"{parsed.get('issuerName') or ticker} Monthly Return for Equity Issuer on Movements in Securities",
        "url": url,
        "documentSha256": hashlib.sha256(content).hexdigest(),
        "pdfPages": parsed["pdfPages"],
        "classes": parsed["classes"],
    }
    if provider_shares and provider_date and provider_shares not in known:
        record["providerReview"] = {
            "providerDate": provider_date,
            "outstandingShares": provider_shares,
            "capitalDate": parsed["date"],
            "reviewedThrough": provider_date,
            "basis": "officialOrdinaryShareReturnOverridesReviewedProviderMismatch",
            "note": (
                "The captured provider outstanding-share count does not reconcile to the dated "
                "official monthly return total or any disclosed ordinary class. Use the explicitly "
                "dated monthly return (all ordinary classes, excluding treasury). Same mismatched "
                "provider *count* remains accepted when FMP republishes under a newer as-of date "
                "while this capital.date is current; a material change in the provider count still "
                "requires a fresh review. This is not a claim that no share movements occurred after month-end."
            ),
        }
    return record


def load_targets(root: Path, tickers: list[str] | None) -> list[str]:
    if tickers:
        return tickers
    capital = json.loads((root / "cache" / "hkex_share_capital.json").read_text(encoding="utf-8"))
    core = json.loads((root / "hk_market_dcf.json").read_text(encoding="utf-8"))
    expansion = json.loads(
        (root / "hkex_expansion_data.js").read_text(encoding="utf-8")
        .split("=", 1)[1].rstrip().rstrip(";")
    )["stocks"]
    universe = {
        row["ticker"]: row
        for row in json.loads((root / "cache" / "hkex_universe.json").read_text(encoding="utf-8"))["stocks"]
    }
    targets = []
    for ticker, stock in {**expansion, **core}.items():
        reason = (stock.get("shareSource") or {}).get("reason")
        listing = universe.get(ticker) or {}
        needs = reason in {
            "shareBasisUnverified",
            "issuerShareReturnNeedsReview",
            "issuerShareReturnNotYetAvailable",
        } or stock.get("shares") is None and (
            not listing.get("isin") or str(listing.get("isin")).startswith("CNE")
        )
        if needs or ticker in capital and reason == "issuerShareReturnNeedsReview":
            targets.append(ticker)
    # Always include known capital issuers that currently need review.
    for ticker, stock in core.items():
        if (stock.get("shareSource") or {}).get("reason") == "issuerShareReturnNeedsReview":
            targets.append(ticker)
    return sorted(set(targets))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--tickers", default="")
    parser.add_argument("--from-date", default="20250901")
    parser.add_argument("--sleep", type=float, default=0.35)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    capital_path = root / "cache" / "hkex_share_capital.json"
    capital = json.loads(capital_path.read_text(encoding="utf-8"))
    tickers = [value.strip().upper() for value in args.tickers.split(",") if value.strip()]
    targets = load_targets(root, tickers or None)
    if args.limit:
        targets = targets[: args.limit]

    session = requests.Session()
    lookup = {
        row["c"]: row
        for row in session.get(
            f"{HOST}/ncms/script/eds/activestock_sehk_e.json", headers=HEADERS, timeout=45
        ).json()
    }
    core = json.loads((root / "hk_market_dcf.json").read_text(encoding="utf-8"))
    expansion = json.loads(
        (root / "hkex_expansion_data.js").read_text(encoding="utf-8")
        .split("=", 1)[1].rstrip().rstrip(";")
    )["stocks"]
    today = date.today().strftime("%Y%m%d")
    summary = {"captured": [], "updatedReviews": [], "failed": [], "skipped": []}

    for index, ticker in enumerate(targets, 1):
        code = display_code(ticker)
        stock_meta = lookup.get(code)
        stock = core.get(ticker) or expansion.get(ticker) or {}
        provider_shares, provider_date = provider_outstanding(stock)
        if not stock_meta:
            summary["failed"].append({"ticker": ticker, "error": "notInHkexActiveStockLookup"})
            continue
        try:
            existing = capital.get(ticker)
            # Refresh providerReview only when capital already exists and review drifted.
            if existing and (stock.get("shareSource") or {}).get("reason") == "issuerShareReturnNeedsReview":
                if provider_shares and provider_date:
                    known = [
                        sum(row["issuedShares"] - row["treasuryShares"] for row in existing["classes"]),
                        *[row["issuedShares"] - row["treasuryShares"] for row in existing["classes"]],
                    ]
                    if provider_shares not in known:
                        existing = {
                            **existing,
                            "providerReview": {
                                "providerDate": provider_date,
                                "outstandingShares": provider_shares,
                                "capitalDate": existing["date"],
                                "reviewedThrough": provider_date,
                                "basis": "officialOrdinaryShareReturnOverridesReviewedProviderMismatch",
                                "note": (
                                    "The captured provider outstanding-share count does not reconcile to the dated "
                                    "official monthly return total or any disclosed ordinary class. Use the explicitly "
                                    "dated monthly return (all ordinary classes, excluding treasury). Same mismatched "
                                    "provider *count* remains accepted when FMP republishes under a newer as-of date "
                                    "while this capital.date is current; a material change in the provider count still "
                                    "requires a fresh review. This is not a claim that no share movements occurred after month-end."
                                ),
                            },
                        }
                        capital[ticker] = existing
                        summary["updatedReviews"].append(ticker)
                        print(f"[{index}/{len(targets)}] {ticker}: refreshed providerReview only", flush=True)
                        continue
            filing = latest_monthly_filing(session, stock_meta["i"], args.from_date, today)
            if not filing:
                summary["failed"].append({"ticker": ticker, "error": "monthlyReturnNotFound"})
                print(f"[{index}/{len(targets)}] {ticker}: monthly return not found", flush=True)
                continue
            url = HOST + filing["FILE_LINK"]
            response = session.get(url, headers=HEADERS, timeout=90)
            response.raise_for_status()
            content = response.content
            if not content.startswith(b"%PDF"):
                raise ValueError("response is not a PDF")
            parsed = parse_ff301(content)
            # Prefer fresher returns; keep existing if same/newer already present unless forced by missing.
            if existing and existing.get("date") and existing["date"] > parsed["date"]:
                summary["skipped"].append({"ticker": ticker, "reason": "existingCapitalNewer"})
                print(f"[{index}/{len(targets)}] {ticker}: keep newer existing capital {existing['date']}", flush=True)
                continue
            record = build_record(ticker, filing, content, parsed, provider_shares, provider_date)
            capital[ticker] = record
            summary["captured"].append({
                "ticker": ticker,
                "date": record["date"],
                "outstandingShares": parsed["outstandingShares"],
                "classes": [row["name"] for row in record["classes"]],
                "providerReview": "providerReview" in record,
            })
            print(
                f"[{index}/{len(targets)}] {ticker}: {parsed['outstandingShares']} "
                f"({'/'.join(row['name'] for row in record['classes'])}) {record['date']}",
                flush=True,
            )
        except Exception as error:  # noqa: BLE001 - batch capture must continue
            summary["failed"].append({"ticker": ticker, "error": f"{type(error).__name__}: {error}"})
            print(f"[{index}/{len(targets)}] {ticker}: FAIL {type(error).__name__}: {error}", flush=True)
        time.sleep(args.sleep)

    capital_path.write_text(json.dumps(capital, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary_path = root / "cache" / "hkex_share_capital_capture_summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "captured": len(summary["captured"]),
        "updatedReviews": len(summary["updatedReviews"]),
        "failed": len(summary["failed"]),
        "skipped": len(summary["skipped"]),
        "capitalTickers": len(capital),
        "summaryPath": str(summary_path),
    }, indent=2))


if __name__ == "__main__":
    main()

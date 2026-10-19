"""Import the public HKEX security list without inventing financial observations."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile

SOURCE_URL = "https://www.hkex.com.hk/eng/services/trading/securities/securitieslists/ListOfSecurities.xlsx"
ALLOCATION_URL = "https://www.hkex.com.hk/-/media/HKEX-Market/Products/Securities/Stock-Code-Allocation-Plan/scap.pdf"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
SUBCATEGORIES = {"Equity Securities (Main Board)", "Equity Securities (GEM)", "Investment Companies"}


def workbook_rows(path):
    with zipfile.ZipFile(path) as archive:
        if sum(item.file_size for item in archive.infolist()) > 100_000_000:
            raise ValueError("HKEX workbook exceeds the supported size")
        strings = ["".join(item.itertext()) for item in
                   ET.fromstring(archive.read("xl/sharedStrings.xml")).findall("m:si", NS)]
        rows = []
        for row in ET.fromstring(archive.read("xl/worksheets/sheet1.xml")).findall(".//m:row", NS):
            values = {}
            for cell in row.findall("m:c", NS):
                value = cell.find("m:v", NS)
                text = value.text if value is not None and value.text else ""
                if cell.get("t") == "s" and text:
                    text = strings[int(text)]
                elif cell.get("t") == "inlineStr":
                    text = "".join(cell.find("m:is", NS).itertext())
                values[re.sub(r"\d", "", cell.attrib["r"])] = text.strip()
            rows.append(values)
        return rows


def select_listings(rows):
    if len(rows) < 3 or rows[2].get("A") != "Stock Code" or rows[2].get("C") != "Category":
        raise ValueError("Unrecognized HKEX securities workbook schema")
    match = re.fullmatch(r"Updated as at (\d{2})/(\d{2})/(\d{4})", rows[1].get("A", ""))
    if not match:
        raise ValueError("HKEX list date is missing")
    as_of = datetime(int(match[3]), int(match[2]), int(match[1])).date().isoformat()
    selected, excluded = [], Counter()
    for row in rows[3:]:
        category, subtype = row.get("C"), row.get("D")
        if category != "Real Estate Investment Trusts" and not (category == "Equity" and subtype in SUBCATEGORIES):
            excluded[category or "unclassified"] += 1
            continue
        code = row.get("A", "")
        if not re.fullmatch(r"\d{5}", code) or not row.get("B") or row.get("Q") not in {"HKD", "USD", "RMB"}:
            raise ValueError("Invalid HKEX equity identity or trading currency")
        number = int(code)
        if 2900 <= number <= 2999:
            excluded["temporaryCounter"] += 1
            continue
        if re.search(r"(?:USDPREF|RMBPREF|PREFERENCE SHARES|[- ]PREF)$", row["B"]):
            excluded["preferenceShares"] += 1
            continue
        isin = row.get("F") or None
        if isin and not re.fullmatch(r"[A-Z]{2}[A-Z0-9]{9}\d", isin):
            raise ValueError("Invalid HKEX ISIN")
        selected.append({
            "ticker": f"{number:04d}.HK", "displayCode": code,
            "name": row["B"], "name_en": row["B"], "tradingCurrency": row["Q"],
            "board": "GEM" if subtype == "Equity Securities (GEM)" else "Main Board",
            "securityType": "REIT" if category == "Real Estate Investment Trusts" else "ordinaryEquity",
            "isin": isin, "universeMembership": "HKEX official securities list",
        })
    groups = {}
    for item in selected:
        groups.setdefault(item["isin"] or item["ticker"], []).append(item)
    result, counters = [], []
    for items in groups.values():
        items.sort(key=lambda item: (item["tradingCurrency"] != "HKD", int(item["displayCode"])))
        result.append(items[0])
        counters.extend({"ticker": item["ticker"], "primary": items[0]["ticker"], "isin": item["isin"]}
                        for item in items[1:])
    result.sort(key=lambda item: int(item["displayCode"]))
    return as_of, result, dict(excluded), counters


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--screener", type=Path)
    parser.add_argument("--output", type=Path, default=Path("cache/hkex_universe.json"))
    args = parser.parse_args()
    as_of, stocks, excluded, counters = select_listings(workbook_rows(args.workbook))
    profiles = {}
    if args.screener:
        for row in json.loads(args.screener.read_text(encoding="utf-8")):
            if re.fullmatch(r"\d{4,5}\.HK", row.get("symbol", "")):
                profiles[row["symbol"]] = row
    for stock in stocks:
        profile = profiles.get(stock["ticker"], {})
        stock["name_en"] = profile.get("companyName") or stock["name_en"]
        stock["sector"] = profile.get("sector") or "Unclassified"
        stock["industry"] = profile.get("industry") or "Unclassified"
        stock["classificationSource"] = "FMP company-screener; not HSICS" if profile else "unavailable"
    result = {
        "version": 1,
        "source": {"provider": "HKEX", "url": SOURCE_URL, "asOf": as_of,
                   "retrievedAt": datetime.now(timezone.utc).isoformat(),
                   "sha256": hashlib.sha256(args.workbook.read_bytes()).hexdigest(),
                   "allocationPlan": ALLOCATION_URL},
        "scope": "Main Board/GEM ordinary equities, listed investment companies and REITs; one counter per verified ISIN",
        "excluded": excluded, "additionalCounters": counters, "stocks": stocks,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    Path("hkex_universe_data.js").write_text(
        "window.HKEX_LISTINGS = " + json.dumps(result, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8")
    print(json.dumps({"listDate": as_of, "stocks": len(stocks), "additionalCounters": len(counters), "excluded": excluded}))


if __name__ == "__main__":
    main()

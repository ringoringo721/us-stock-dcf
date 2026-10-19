"""Capture primary HKEX report evidence without changing published company data."""

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime
import hashlib
from html import unescape
import json
from pathlib import Path
import re
import sys

import requests
from pypdf import PdfReader
from pypdf.errors import PdfReadError

HOST = "https://www1.hkexnews.hk"
SESSION_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; financial-statement-review)"}
INCOME = re.compile(
    r"^\s*(?:\d+(?:\.\d+)*\s+)?(?:interim\s+)?(?:condensed\s+)?consolid\s*a\s*t\s*e\s*d\s+(?:interim\s+)?"
    r"(?:inco\s*m\s*e\s+sta\s*t\s*e\s*ments?|sta\s*t\s*e\s*ments?\s+of\s+"
    r"(?:prof\s*i\s*t\s+or\s+loss|profit\s+and\s+loss|inco\s*m\s*e|operations|co\s*m\s*prehensive\s+inco\s*m\s*e))",
    re.I | re.M,
)

def statement_heading(text):
    compact = re.sub(r"[\s-]+", "", text[:1600]).lower()
    return INCOME.search(text[:1600]) and not any(
        title in compact for title in ["fiveyearsummary", "fiveyearfinancialsummary", "financialsummary"])


def response_json(url, parameters=None):
    response = requests.get(url, params=parameters, headers=SESSION_HEADERS, timeout=45)
    response.raise_for_status()
    return response.json()


def selected_reports(filings, evidence):
    annual_dates = [row["date"] for row in evidence["responses"]["annual_income"]["rows"]]
    interim_dates = [row["date"] for row in evidence["responses"]["income"]["rows"]]
    annual_min = min(int(value[:4]) for value in annual_dates)
    interim_min = min(int(value[:4]) for value in interim_dates)
    groups = {"annual": [], "interim": []}
    for filing in filings:
        category = unescape(filing["LONG_TEXT"])
        kind = "annual" if re.search(r"\[Annual Report(?:\s*/|\])", category, re.I) else (
            "interim" if re.search(r"\[Interim.*Report\]", category, re.I) else None)
        title = unescape(filing["TITLE"])
        years = re.findall(r"20\d{2}", title)
        for first, last in re.findall(r"(20\d{2})\s*[/\-]\s*(\d{2})(?!\d)", title):
            expanded = int(first[:2] + last)
            if expanded == int(first) + 1:
                years.append(str(expanded))
        if not kind or not years:
            continue
        year = max(map(int, years))
        minimum = annual_min if kind == "annual" else interim_min
        if year >= minimum:
            groups[kind].append({**filing, "kind": kind, "reportYear": year})
    selected = []
    for kind, reports in groups.items():
        if not reports:
            raise ValueError(f"No primary {kind} report coverage")
        latest = max(report["reportYear"] for report in reports)
        by_year = {}
        for report in reports:
            year = report["reportYear"]
            if year not in by_year or datetime.strptime(report["DATE_TIME"], "%d/%m/%Y %H:%M") > datetime.strptime(
                    by_year[year]["DATE_TIME"], "%d/%m/%Y %H:%M"):
                by_year[year] = report
        for year, report in sorted(by_year.items(), reverse=True):
            if (latest - year) % 2 == 0:
                selected.append(report)
    return selected


def income_pages(pdf):
    reader = PdfReader(pdf)
    candidates = set()
    for index in range(min(16, len(reader.pages))):
        text = reader.pages[index].extract_text() or ""
        for line in text.splitlines():
            if INCOME.search(line):
                for number in re.findall(r"\b\d{1,3}\b", line):
                    printed = int(number)
                    candidates.update(range(max(0, printed - 1), min(len(reader.pages), printed + 6)))
    checked = set()
    for index in [*sorted(candidates), *range(len(reader.pages))]:
        if index in checked:
            continue
        checked.add(index)
        text = reader.pages[index].extract_text() or ""
        if statement_heading(text) and re.search(r"\b(?:revenues?|turnover)\b", text, re.I):
            if len(re.findall(r"\d[\d,]{2,}", text)) > 12:
                return [{"pdfPage": index + 1, "text": text},
                        *([{"pdfPage": index + 2, "text": reader.pages[index + 1].extract_text() or ""}]
                          if index + 1 < len(reader.pages) else [])]
    raise ValueError("No consolidated income-statement page identified")


def capture_report(symbol, filing, output, previous=None):
    url = HOST + filing["FILE_LINK"]
    name = f"{symbol}-{filing['reportYear']}-{filing['kind']}"
    pdf = output / f"{name}.pdf"
    cached = previous and output / previous["pdfFile"]
    content = cached.read_bytes() if cached and cached.is_file() else None
    if content is not None and hashlib.sha256(content).hexdigest() != previous["sha256"]:
        raise ValueError("Cached primary report hash changed")
    if content is not None and len(previous.get("incomePages", [])) > 1:
        if statement_heading(previous["incomePages"][0]["text"]):
            return {**previous, "reportYear": filing["reportYear"], "title": filing["TITLE"]}
    if content is None:
        response = requests.get(url, headers=SESSION_HEADERS, timeout=90)
        response.raise_for_status()
        content = response.content
    if not content.startswith(b"%PDF"):
        raise ValueError("Primary report response is not a PDF")
    if cached:
        pdf = cached
    else:
        pdf.write_bytes(content)
    pages = income_pages(pdf)
    record = {
        "symbol": symbol, "title": filing["TITLE"], "kind": filing["kind"],
        "reportYear": filing["reportYear"], "publishedAt": filing["DATE_TIME"],
        "url": url, "sha256": hashlib.sha256(content).hexdigest(),
        "pdfFile": pdf.name, "incomePages": pages,
        "reviewStatus": "extractedNotYetReconciled",
    }
    (output / f"{name}.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    return record


def main():
    if len(sys.argv) not in [4, 5] or len(sys.argv) == 5 and sys.argv[4] != "--reuse-downloads":
        raise ValueError("Usage: capture_hkex_reports.py CAPTURE_DIRECTORY OUTPUT_DIRECTORY SYMBOLS [--reuse-downloads]")
    captures, output = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    symbols = sys.argv[3].split(",")
    if any(not re.fullmatch(r"\d{4}\.HK", symbol) for symbol in symbols):
        raise ValueError("Expected HK security symbols")
    output.mkdir(parents=True, exist_ok=True)
    previous = {}
    if "--reuse-downloads" in sys.argv:
        for record_file in output.glob("*.HK-*.json"):
            if not re.fullmatch(r"\d{4}\.HK-\d{4}-(annual|interim)\.json", record_file.name):
                continue
            record = json.loads(record_file.read_text(encoding="utf-8"))
            previous[record["url"]] = record
    stocks = response_json(f"{HOST}/ncms/script/eds/activestock_sehk_e.json")
    lookup = {stock["c"]: stock for stock in stocks}
    jobs, indexes, errors = [], {}, []
    today = date.today().strftime("%Y%m%d")
    for symbol in symbols:
        evidence = json.loads((captures / f"{symbol}.json").read_text(encoding="utf-8"))
        stock = lookup.get(symbol[:4].zfill(5))
        if not stock:
            raise ValueError(f"{symbol}: not in HKEX's listed-security lookup")
        payload = response_json(f"{HOST}/search/titleSearchServlet.do", {
            "sortDir": "0", "sortByOptions": "DateTime", "category": "0", "market": "SEHK",
            "stockId": str(stock["i"]), "documentType": "-1", "fromDate": "20100101",
            "toDate": today, "title": "", "searchType": "1", "t1code": "40000",
            "t2Gcode": "-2", "t2code": "-2", "lang": "E",
        })
        filings = json.loads(payload["result"])
        if filings and int(filings[0]["TOTAL_COUNT"]) > len(filings):
            raise ValueError(f"{symbol}: filing-search pagination requires review")
        indexes[symbol] = {"security": stock, "filings": filings}
        (output / "filing-indexes.json").write_text(
            json.dumps(indexes, ensure_ascii=False, indent=2), encoding="utf-8")
        reports = selected_reports(filings, evidence)
        jobs.extend((symbol, filing) for filing in reports)
        print(f"{symbol}: {len(reports)} primary reports selected", flush=True)
    (output / "filing-indexes.json").write_text(
        json.dumps(indexes, ensure_ascii=False, indent=2), encoding="utf-8")
    records = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = {pool.submit(capture_report, symbol, filing, output, previous.get(HOST + filing["FILE_LINK"])):
                   (symbol, filing) for symbol, filing in jobs}
        for future in as_completed(pending):
            symbol, filing = pending[future]
            try:
                record = future.result()
                records.append(record)
                print(f"{symbol}: {record['title']} extracted, awaiting reconciliation", flush=True)
            except (requests.RequestException, PdfReadError, ValueError, OSError) as error:
                failure = {"symbol": symbol, "title": filing["TITLE"], "error": type(error).__name__,
                           "url": HOST + filing["FILE_LINK"]}
                errors.append(failure)
                print(json.dumps(failure), flush=True)
    manifest = {"capturedAt": date.today().isoformat(), "records": records, "errors": errors,
                "basis": "Primary report extraction only; not certification or a published-data replacement"}
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    if errors:
        raise RuntimeError(f"{len(errors)} reports could not be extracted; see manifest")


if __name__ == "__main__":
    main()

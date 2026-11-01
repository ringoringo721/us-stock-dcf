#!/usr/bin/env python3
"""Rebuild US statements_raw CFF (and related) series from statements_v2 using aliases.

USD-native tickers skip scripts/usd_financials.cjs rewrite, so market_data.js kept
legacy UI keys at 0 while FMP stable only ships renamed fields. This pass rewrites
only the aliased cash-flow series in market_data.js / full_market_dcf.json.
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIN_DIR = ROOT / "cache" / "financials"


def _load_aliases():
    """Load alias helpers from build_full_market without importing its side effects."""
    source = ast.parse((ROOT / "build_full_market.py").read_text(encoding="utf-8"))
    names = {"STATEMENT_FIELD_ALIASES", "get_safe_field"}
    nodes = [
        node for node in source.body
        if (isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id in names for t in node.targets))
        or (isinstance(node, ast.FunctionDef) and node.name in names)
    ]
    scope = {}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "statement_aliases", "exec"), scope)
    return scope["STATEMENT_FIELD_ALIASES"], scope["get_safe_field"]


STATEMENT_FIELD_ALIASES, get_safe_field = _load_aliases()

CFF_FIELDS = [
    "debtRepayment",
    "commonStockIssued",
    "commonStockRepurchased",
    "dividendsPaid",
    "otherFinancingActivites",
    "netCashUsedProvidedByFinancingActivities",
    "netCashProvidedByOperatingActivities",
    "otherInvestingActivites",
    "netCashUsedForInvestingActivites",
]


def _load_js_object(path: Path, assign_re: str) -> tuple[str, dict, str]:
    text = path.read_text(encoding="utf-8")
    match = re.match(assign_re, text)
    if not match:
        raise SystemExit(f"Unexpected JS assignment in {path}")
    prefix = match.group(0)
    payload = text[match.end() :].rstrip()
    if payload.endswith(";"):
        payload = payload[:-1]
    return prefix, json.loads(payload), ";"


def _write_js_object(path: Path, prefix: str, data: dict, suffix: str) -> None:
    path.write_text(prefix + json.dumps(data, ensure_ascii=False, indent=2) + suffix + "\n", encoding="utf-8")


def _series_annual(annual_rows: list[dict], quarterly_rows: list[dict], field: str) -> list[float]:
    annual = list(reversed(annual_rows))[:5] if annual_rows else []
    series = [round(get_safe_field(row, field) / 1e6, 2) for row in annual]
    while len(series) < 5:
        series.insert(0, 0.0)
    # Match build_full_market TTM: sum newest-first quarterly window.
    latest4 = quarterly_rows[:4] if quarterly_rows else []
    ttm = round(sum(get_safe_field(row, field) for row in latest4) / 1e6, 2)
    series.append(ttm)
    return series


def _series_quarterly(rows: list[dict], field: str, count: int) -> list[float]:
    chronological = list(reversed(rows[:count])) if rows else []
    while len(chronological) < count:
        chronological.insert(0, {})
    return [round(get_safe_field(row, field) / 1e6, 2) for row in chronological[-count:]]


def _align(series: list[float], old: list) -> list[float]:
    target_len = len(old)
    out = list(series)
    if len(out) > target_len:
        out = out[-target_len:]
    while len(out) < target_len:
        out.insert(0, 0.0)
    return out


def rematerialize_stock(stock: dict, statements: dict) -> int:
    raw = stock.get("statements_raw")
    if not isinstance(raw, dict):
        return 0
    annual_cf = statements.get("annual", {}).get("cashflow") or []
    quarterly_cf = statements.get("quarterly", {}).get("cashflow") or []
    q_raw = raw.get("quarterly_raw") or {}
    q_cf = q_raw.get("cashflow") if isinstance(q_raw, dict) else None
    periods = (q_raw.get("periods") if isinstance(q_raw, dict) else None) or []
    q_count = len(periods) if periods else 20
    changed = 0
    for field in CFF_FIELDS:
        if isinstance(raw.get("cashflow"), dict) and field in raw["cashflow"]:
            old = raw["cashflow"][field]
            if isinstance(old, list):
                series = _align(_series_annual(annual_cf, quarterly_cf, field), old)
                if series != old:
                    raw["cashflow"][field] = series
                    changed += 1
        if isinstance(q_cf, dict) and field in q_cf and isinstance(q_cf[field], list):
            series = _align(
                _series_quarterly(quarterly_cf, field, q_count or len(q_cf[field])),
                q_cf[field],
            )
            if series != q_cf[field]:
                q_cf[field] = series
                changed += 1
    return changed


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    market_js = ROOT / "market_data.js"
    market_json = ROOT / "full_market_dcf.json"
    prefix, market, suffix = _load_js_object(market_js, r"^window\.FULL_MARKET_DATA\s*=\s*")
    json_market = json.loads(market_json.read_text(encoding="utf-8"))
    tickers_changed = 0
    field_updates = 0
    missing_cache = []
    for ticker, stock in market.items():
        cache_path = FIN_DIR / f"{ticker}_statements_v2.json"
        if not cache_path.exists():
            missing_cache.append(ticker)
            continue
        statements = json.loads(cache_path.read_text(encoding="utf-8"))
        n = rematerialize_stock(stock, statements)
        if n:
            tickers_changed += 1
            field_updates += n
            # Mirror into full_market_dcf.json when present.
            if ticker in json_market and isinstance(json_market[ticker], dict):
                rematerialize_stock(json_market[ticker], statements)
    summary = {
        "tickers": len(market),
        "tickersChanged": tickers_changed,
        "seriesUpdates": field_updates,
        "missingCache": missing_cache,
        "dryRun": dry_run,
    }
    print(json.dumps(summary, indent=2))
    if dry_run:
        return
    _write_js_object(market_js, prefix, market, suffix)
    market_json.write_text(json.dumps(json_market, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

"""Historical market data and reconstructed quarterly valuation helpers."""

from __future__ import annotations

import json
import math
import os
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import requests


FMP_BASE_URL = "https://financialmodelingprep.com/stable"
PRICE_ENDPOINT = "historical-price-eod/full"
PRICE_CACHE_VERSION = 1
PRICE_CACHE_TTL = timedelta(hours=12)
SPLIT_CACHE_TTL = timedelta(days=30)
PRICE_RETRIES = 4
PRICE_TIMEOUT = (5, 20)
PRICE_BASIS = "FMP unadjusted close normalized for reported splits to current share basis; dividends excluded"

FMP_SYMBOL_OVERRIDES = {}

RECONSTRUCTION_ASSUMPTIONS = {
    "cash_flow_definition": "FCFF approximation: CFO - absolute capital expenditure + interest expense after fixed 21% tax",
    "explicit_years": 5,
    "annual_growth": 0.05,
    "discount_rate": 0.10,
    "terminal_growth": 0.025,
    "tax_rate": 0.21,
    "discount_rate_basis": "fixed reconstruction assumption; not a historical WACC or Ke",
}
RECONSTRUCTION_LIMITATION = (
    "Reconstructed from currently available normalized statements, not original filing vintages; "
    "fixed assumptions are not contemporaneous forecasts, a point-in-time backtest, or an objective price."
)


class HistoricalDataError(ValueError):
    pass


def fmp_symbol(symbol: str) -> str:
    """Apply explicit provider mappings; never strip punctuation blindly."""
    normalized = symbol.strip().upper()
    return FMP_SYMBOL_OVERRIDES.get(normalized, normalized)


def _date(value: Any) -> date | None:
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        parsed = date.fromisoformat(value[:10])
        if len(value) > 10:
            if value[10] not in {"T", " "}:
                return None
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed
    except ValueError:
        return None


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def normalize_split_events(events: Any) -> list[dict[str, Any]]:
    normalized = {}
    if not isinstance(events, list):
        return []
    for event in events:
        if not isinstance(event, dict):
            continue
        event_date = _date(event.get("date"))
        numerator = _finite(event.get("numerator"))
        denominator = _finite(event.get("denominator"))
        if event_date and numerator and denominator and numerator > 0 and denominator > 0:
            normalized[event_date.isoformat()] = {
                "date": event_date.isoformat(),
                "numerator": numerator,
                "denominator": denominator,
            }
    return [normalized[key] for key in sorted(normalized)]


def normalize_price_rows(rows: Any, start: date, end: date) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        raise HistoricalDataError("Historical price response must be a list")
    normalized = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        row_date = _date(row.get("date"))
        close = _finite(row.get("close"))
        if row_date is None or close is None or close <= 0 or not start <= row_date <= end:
            continue
        normalized[row_date.isoformat()] = {
            "date": row_date.isoformat(),
            "close": close,
            "volume": _finite(row.get("volume")),
        }
    if rows and not normalized:
        raise HistoricalDataError("Historical price response had no valid dated close values")
    return [normalized[key] for key in sorted(normalized)]


def split_adjust_prices(
    rows: list[dict[str, Any]], split_events: Any, through_date: date
) -> list[dict[str, Any]]:
    """Express earlier closes in the share basis after all known subsequent splits."""
    splits = normalize_split_events(split_events)
    result = []
    for row in rows:
        row_date = _date(row.get("date"))
        close = _finite(row.get("raw_close"))
        if close is None:
            close = _finite(row.get("close"))
        if row_date is None or close is None:
            continue
        factor = 1.0
        for split in splits:
            split_date = _date(split["date"])
            if split_date and row_date < split_date <= through_date:
                factor *= split["numerator"] / split["denominator"]
        adjusted = close / factor
        if math.isfinite(adjusted) and adjusted > 0:
            result.append({**row, "close": adjusted, "raw_close": close})
    return result


def _load_price_cache(cache_path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if (
        not isinstance(value, dict)
        or value.get("schema_version") != PRICE_CACHE_VERSION
        or not isinstance(value.get("prices"), list)
        or not isinstance(value.get("metadata"), dict)
    ):
        return None
    return value


def fetch_historical_splits(
    symbol: str,
    api_key: str,
    cache_dir: str | Path = "cache/historical_prices",
    *,
    as_of: date | None = None,
    get: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    cache_path = Path(cache_dir) / f"{symbol.upper()}.splits.json"
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        cached = None
    if isinstance(cached, dict) and isinstance(cached.get("splits"), list):
        meta = cached.get("metadata") if isinstance(cached.get("metadata"), dict) else {}
        try:
            refreshed = datetime.fromisoformat(meta.get("refreshed_at", ""))
        except ValueError:
            refreshed = None
        if (
            meta.get("status") == "fresh"
            and refreshed
            and refreshed.tzinfo is not None
            and datetime.now(timezone.utc) - refreshed < SPLIT_CACHE_TTL
        ):
            return cached
    else:
        cached = None
    previous = cached.get("splits", []) if cached else []
    previous_meta = cached.get("metadata", {}) if cached else {}
    now = datetime.now(timezone.utc)
    if not api_key:
        return _split_last_good(symbol, previous, previous_meta, "stale" if previous else "missing_key", "FMP_API_KEY is not configured", cache_path, now)

    requester = get or requests.get
    last_error = "Stock split refresh failed"
    for attempt in range(PRICE_RETRIES):
        try:
            response = requester(
                f"{FMP_BASE_URL}/splits",
                params={"symbol": fmp_symbol(symbol), "apikey": api_key},
                timeout=PRICE_TIMEOUT,
            )
            if response.status_code == 200:
                try:
                    payload = response.json()
                    events = normalize_split_events(payload)
                    if not isinstance(payload, list) or (payload and not events):
                        raise HistoricalDataError("Malformed split response")
                except (ValueError, TypeError, HistoricalDataError):
                    last_error = "Stock split response was empty or malformed"
                    break
                result = {
                    "metadata": {
                        "status": "fresh",
                        "source": "FMP stable splits",
                        "symbol": fmp_symbol(symbol),
                        "refreshed_at": now.isoformat(),
                        "last_good_at": now.isoformat(),
                        "last_error": None,
                    },
                    "splits": events,
                }
                _write_price_cache(cache_path, result)
                return result
            if response.status_code == 429:
                retry_after = _finite(response.headers.get("Retry-After"))
                wait = max(0.0, min(retry_after if retry_after is not None else 2**attempt, 30.0))
                last_error = "FMP rate limit response"
            elif response.status_code >= 500:
                wait = min(2**attempt, 30)
                last_error = f"FMP server returned HTTP {response.status_code}"
            else:
                last_error = f"FMP returned HTTP {response.status_code}"
                break
        except requests.RequestException:
            wait = min(2**attempt, 30)
            last_error = "Stock split request failed"
        if attempt < PRICE_RETRIES - 1:
            time.sleep(wait)
    return _split_last_good(
        symbol, previous, previous_meta, "stale" if previous else "error", last_error, cache_path, now
    )


def _split_last_good(
    symbol: str,
    previous: list[dict[str, Any]],
    previous_meta: dict[str, Any],
    status: str,
    reason: str,
    path: Path,
    now: datetime,
) -> dict[str, Any]:
    result = {
        "metadata": {
            **previous_meta,
            "status": status,
            "source": previous_meta.get("source", "FMP stable splits"),
            "symbol": fmp_symbol(symbol),
            "last_attempt_at": now.isoformat(),
            "last_error": reason,
        },
        "splits": previous,
    }
    _write_price_cache(path, result)
    return result


def fetch_historical_prices(
    symbol: str,
    api_key: str,
    cache_dir: str | Path = "cache/historical_prices",
    *,
    as_of: date | None = None,
    split_events: Any = None,
    adjustment_basis_verified: bool = False,
    split_events_available: bool = False,
    get: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """Refresh five calendar years of prices while retaining last-good data on errors."""
    today = as_of or datetime.now(timezone.utc).date()
    start = today.replace(year=today.year - 5) if not (
        today.month == 2 and today.day == 29 and not _is_leap_year(today.year - 5)
    ) else date(today.year - 5, 2, 28)
    cache_path = Path(cache_dir) / f"{symbol.upper()}.json"
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cached = _load_price_cache(cache_path)
    cached_prices = cached.get("prices", []) if cached else []
    cached_meta = cached.get("metadata", {}) if cached else {}
    now = datetime.now(timezone.utc)
    updated_at = cached_meta.get("refreshed_at")
    latest_date = _date(cached_meta.get("latest_trading_date"))
    try:
        refreshed_at = datetime.fromisoformat(updated_at) if isinstance(updated_at, str) else None
    except ValueError:
        refreshed_at = None
    if (
        cached
        and refreshed_at
        and refreshed_at.tzinfo is not None
        and now - refreshed_at < PRICE_CACHE_TTL
        and latest_date
        and latest_date >= today - timedelta(days=7)
    ):
        cached["metadata"]["status"] = "fresh"
        cached["metadata"]["price_basis"] = PRICE_BASIS
        cached["metadata"]["adjustment_semantics_verified"] = adjustment_basis_verified and split_events_available
        cached["prices"] = split_adjust_prices(cached_prices, split_events, today)
        return cached

    if not api_key:
        status = "stale" if cached_prices else "missing_key"
        result = _last_good_or_empty(
            symbol, cached_prices, cached_meta, status, "FMP_API_KEY is not configured",
            split_events, today, start, adjustment_basis_verified, split_events_available,
        )
        result["metadata"]["last_attempt_at"] = now.isoformat()
        _write_price_cache(cache_path, result)
        return result

    prior_latest = max((_date(row.get("date")) for row in cached_prices if isinstance(row, dict)), default=None)
    request_from = max(start, prior_latest - timedelta(days=7)) if prior_latest else start
    params = {
        "symbol": fmp_symbol(symbol),
        "from": request_from.isoformat(),
        "to": today.isoformat(),
        "apikey": api_key,
    }
    requester = get or requests.get
    last_error = "Historical price refresh failed"
    for attempt in range(PRICE_RETRIES):
        try:
            response = requester(
                f"{FMP_BASE_URL}/{PRICE_ENDPOINT}",
                params=params,
                timeout=PRICE_TIMEOUT,
            )
            if response.status_code == 200:
                try:
                    payload = response.json()
                    fresh_rows = normalize_price_rows(payload, request_from, today)
                except (ValueError, TypeError, HistoricalDataError):
                    last_error = "Historical price response was empty or malformed"
                    break
                if not fresh_rows:
                    last_error = "Historical price endpoint returned no observations for the requested range"
                    break
                merged = {
                    row["date"]: row
                    for row in cached_prices
                    if isinstance(row, dict)
                    and (row_date := _date(row.get("date")))
                    and start <= row_date < request_from
                }
                merged.update({row["date"]: row for row in fresh_rows})
                raw_rows = [merged[key] for key in sorted(merged)]
                if not raw_rows:
                    last_error = "Historical price endpoint returned no usable observations"
                    break
                prices = split_adjust_prices(raw_rows, split_events, today)
                if not prices:
                    last_error = "No valid prices remained after split normalization"
                    break
                if _date(prices[-1]["date"]) < today - timedelta(days=7):
                    last_error = "Latest provider observation is older than seven calendar days"
                    break
                metadata = {
                    "status": "fresh",
                    "source": "FMP stable historical-price-eod/full",
                    "symbol": fmp_symbol(symbol),
                    "price_basis": PRICE_BASIS,
                    "adjustment_semantics_verified": adjustment_basis_verified and split_events_available,
                    "split_event_count": len(normalize_split_events(split_events)),
                    "requested_from": start.isoformat(),
                    "requested_to": today.isoformat(),
                    "latest_trading_date": prices[-1]["date"],
                    "refreshed_at": now.isoformat(),
                    "last_good_at": now.isoformat(),
                    "last_error": None,
                }
                value = {"schema_version": PRICE_CACHE_VERSION, "metadata": metadata, "prices": prices}
                _write_price_cache(cache_path, value)
                return value
            if response.status_code == 429:
                retry_after = _finite(response.headers.get("Retry-After"))
                wait = max(0.0, min(retry_after if retry_after is not None else 2**attempt, 30.0))
                last_error = "FMP rate limit response"
            elif response.status_code >= 500:
                wait = min(2**attempt, 30)
                last_error = f"FMP server returned HTTP {response.status_code}"
            else:
                last_error = f"FMP returned HTTP {response.status_code}"
                break
        except requests.RequestException:
            wait = min(2**attempt, 30)
            last_error = "Historical price request failed"
        if attempt < PRICE_RETRIES - 1:
            time.sleep(wait)
    status = "stale" if cached_prices else "error"
    result = _last_good_or_empty(
        symbol, cached_prices, cached_meta, status, last_error, split_events, today, start,
        adjustment_basis_verified, split_events_available,
    )
    result["metadata"]["last_attempt_at"] = now.isoformat()
    _write_price_cache(cache_path, result)
    return result


def _is_leap_year(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def _write_price_cache(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def _last_good_or_empty(
    symbol: str,
    old_prices: list[dict[str, Any]],
    old_meta: dict[str, Any],
    status: str,
    reason: str,
    split_events: Any,
    today: date,
    start: date,
    adjustment_basis_verified: bool,
    split_events_available: bool,
) -> dict[str, Any]:
    raw_prices = [
        row for row in old_prices
        if isinstance(row, dict) and (row_date := _date(row.get("date"))) and start <= row_date <= today
    ]
    prices = split_adjust_prices(raw_prices, split_events, today)
    latest = max((_date(row.get("date")) for row in prices), default=None)
    return {
        "schema_version": PRICE_CACHE_VERSION,
        "metadata": {
            **old_meta,
            "status": status,
            "source": old_meta.get("source", "FMP stable historical-price-eod/full"),
            "symbol": fmp_symbol(symbol),
            "price_basis": PRICE_BASIS,
            "adjustment_semantics_verified": adjustment_basis_verified and split_events_available,
            "requested_from": start.isoformat(),
            "requested_to": today.isoformat(),
            "latest_trading_date": latest.isoformat() if latest else old_meta.get("latest_trading_date"),
            "last_error": reason,
        },
        "prices": prices,
    }


def _accepted_date(row: dict[str, Any]) -> datetime | None:
    value = row.get("acceptedDate") or row.get("filingDate")
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def _date_rows(rows: Any) -> dict[str, dict[str, Any]]:
    result = {}
    if not isinstance(rows, list):
        return result
    for row in rows:
        if isinstance(row, dict) and (row_date := _date(row.get("date"))):
            result[row_date.isoformat()] = row
    return result


def build_quarterly_valuations(
    income_rows: Any,
    balance_rows: Any,
    cashflow_rows: Any,
    split_events: Any = None,
    *,
    sector: str = "",
    country: str = "US",
    is_adr: bool = False,
    adr_ratio: float | None = None,
    adjustment_basis_verified: bool = False,
    share_basis_verified: bool = False,
    statements_fresh: bool = True,
    as_of: date | None = None,
) -> list[dict[str, Any]]:
    """Build fixed-assumption historical FCFF estimates using exact fiscal dates."""
    income = _date_rows(income_rows)
    balances = _date_rows(balance_rows)
    cashflows = _date_rows(cashflow_rows)
    all_dates = sorted(set(income) | set(balances) | set(cashflows))
    splits = normalize_split_events(split_events)
    as_of_date = as_of or datetime.now(timezone.utc).date()
    output = []

    def missing(fiscal_end: str, valuation_date: str | None, reason: str) -> dict[str, Any]:
        return {
            "fiscal_end_date": fiscal_end,
            "availability_date": valuation_date,
            "valuation_date": valuation_date,
            "status": "unavailable",
            "missing_reason": reason,
        }

    for fiscal_end in all_dates:
        inc = income.get(fiscal_end)
        bs = balances.get(fiscal_end)
        cf = cashflows.get(fiscal_end)
        if not (inc and bs and cf):
            output.append(missing(fiscal_end, None, "Income, balance-sheet, and cash-flow statements do not share this exact period-end date."))
            continue
        accepted = [_accepted_date(row) for row in (inc, bs, cf)]
        if any(value is None for value in accepted):
            output.append(missing(fiscal_end, None, "A filing/acceptance timestamp is missing; a point-in-time valuation date cannot be established."))
            continue
        available_at = max(value for value in accepted if value)
        valuation_date = available_at.date().isoformat()
        if not statements_fresh:
            output.append(missing(fiscal_end, valuation_date, "Financial statement cache is stale or unavailable; no historical estimate is published."))
            continue
        currencies = {str(row.get("reportedCurrency") or "").upper() for row in (inc, bs, cf)}
        if currencies != {"USD"}:
            output.append(missing(fiscal_end, valuation_date, "Statement currency is missing or not USD; ADR ratio/FX conversion is not verified."))
            continue
        if sector == "金融":
            output.append(missing(fiscal_end, valuation_date, "No historical financial-sector valuation model is implemented; generic DCF is intentionally suppressed."))
            continue
        if country.upper() not in {"US", "USA", "UNITED STATES"} or (is_adr and (_finite(adr_ratio) is None or _finite(adr_ratio) <= 0)):
            output.append(missing(fiscal_end, valuation_date, "Non-US issuer or ADR ratio is unsupported for this historical per-share reconstruction."))
            continue
        if not adjustment_basis_verified:
            output.append(missing(fiscal_end, valuation_date, "Provider close/split and share-basis semantics have not been verified against current official documentation."))
            continue
        if not share_basis_verified:
            output.append(missing(fiscal_end, valuation_date, "FMP historical diluted-share split adjustment semantics are unverified; manual adjustment is suppressed to avoid double adjustment."))
            continue

        available_dates = [
            period for period in sorted(cashflows)
            if period <= fiscal_end
            and (_accepted_date(cashflows[period]) is not None)
            and _accepted_date(cashflows[period]) <= available_at
            and period in income
            and _accepted_date(income[period]) is not None
            and _accepted_date(income[period]) <= available_at
        ][-4:]
        if len(available_dates) < 4 or available_dates[-1] != fiscal_end:
            output.append(missing(fiscal_end, valuation_date, "Fewer than four aligned, already-published quarterly cash-flow periods are available."))
            continue

        fcff_ttm = 0.0
        valid_cash_flows = True
        for period in available_dates:
            period_cf = cashflows[period]
            period_inc = income[period]
            cfo = _finite(period_cf.get("operatingCashFlow"))
            capex = _finite(period_cf.get("capitalExpenditure"))
            interest = _finite(period_inc.get("interestExpense"))
            if cfo is None or capex is None or interest is None:
                valid_cash_flows = False
                break
            fcff_ttm += cfo - abs(capex) + max(interest, 0.0) * (1 - RECONSTRUCTION_ASSUMPTIONS["tax_rate"])
        if not valid_cash_flows or not math.isfinite(fcff_ttm):
            output.append(missing(fiscal_end, valuation_date, "A required CFO, capital expenditure, or interest input is missing/non-finite."))
            continue

        shares = _finite(inc.get("weightedAverageShsOutDil"))
        cash = _finite(bs.get("cashAndShortTermInvestments"))
        if cash is None:
            cash_only = _finite(bs.get("cashAndCashEquivalents"))
            short_term = _finite(bs.get("shortTermInvestments"))
            cash = cash_only + short_term if cash_only is not None and short_term is not None else None
        debt = _finite(bs.get("totalDebt"))
        if debt is None:
            short_debt = _finite(bs.get("shortTermDebt"))
            long_debt = _finite(bs.get("longTermDebt"))
            debt = short_debt + long_debt if short_debt is not None and long_debt is not None else None
        if shares is None or shares <= 0 or cash is None or debt is None:
            output.append(missing(fiscal_end, valuation_date, "Positive diluted weighted-average shares and historical cash/debt are required."))
            continue

        split_factor = 1.0
        for split in splits:
            split_date = _date(split["date"])
            if split_date and _date(fiscal_end) < split_date <= as_of_date:
                split_factor *= split["numerator"] / split["denominator"]
        if not math.isfinite(split_factor) or split_factor <= 0:
            output.append(missing(fiscal_end, valuation_date, "Share split normalization is invalid."))
            continue
        shares *= split_factor

        assumptions = RECONSTRUCTION_ASSUMPTIONS
        rate = assumptions["discount_rate"]
        growth = assumptions["annual_growth"]
        terminal_growth = assumptions["terminal_growth"]
        if not all(math.isfinite(value) for value in (fcff_ttm, shares, cash, debt, rate, growth, terminal_growth)) or shares <= 0 or rate <= terminal_growth:
            output.append(missing(fiscal_end, valuation_date, "Invalid/non-finite inputs, non-positive shares, or discount rate is not greater than terminal growth."))
            continue
        projected = fcff_ttm
        pv_explicit = 0.0
        for year in range(1, assumptions["explicit_years"] + 1):
            projected *= 1 + growth
            pv_explicit += projected / ((1 + rate) ** year)
        terminal = projected * (1 + terminal_growth) / (rate - terminal_growth)
        enterprise_value = pv_explicit + terminal / ((1 + rate) ** assumptions["explicit_years"])
        equity_value = enterprise_value + cash - debt
        value_per_share = equity_value / shares
        if not all(math.isfinite(value) for value in (fcff_ttm, enterprise_value, equity_value, value_per_share)):
            output.append(missing(fiscal_end, valuation_date, "Model result is non-finite."))
            continue
        output.append({
            "fiscal_end_date": fiscal_end,
            "availability_date": valuation_date,
            "availability_timestamp": available_at.isoformat(),
            "valuation_date": valuation_date,
            "status": "available" if value_per_share > 0 else "unavailable",
            "value_per_share": round(value_per_share, 4) if value_per_share > 0 else None,
            "fcff_ttm": fcff_ttm,
            "cash": cash,
            "debt": debt,
            "shares": shares,
            "shares_basis": "diluted weighted-average shares, normalized for subsequent reported splits",
            "share_basis_verified": share_basis_verified,
            "adjustment_basis_verified": adjustment_basis_verified,
            "currency": "USD",
            "fcf_definition": assumptions["cash_flow_definition"],
            "assumptions": assumptions.copy(),
            "assumptions_summary": "5y growth 5%; discount 10%; terminal growth 2.5%; tax 21%",
            "method": "Reconstructed FCFF DCF; fixed assumptions",
            "limitation": RECONSTRUCTION_LIMITATION,
            "missing_reason": None if value_per_share > 0 else "Reconstructed equity value per share is non-positive; negative cash flow was not replaced.",
            "split_factor": split_factor,
            "provenance": "FMP normalized quarterly income, balance-sheet, and cash-flow statements",
        })
    return output

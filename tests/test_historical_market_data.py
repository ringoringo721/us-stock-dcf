import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from historical_market_data import (
    HistoricalDataError,
    build_quarterly_valuations,
    fetch_historical_prices,
    fetch_historical_splits,
    fmp_symbol,
    normalize_price_rows,
    split_adjust_prices,
)


def quarter(date_value, *, accepted=None, **extra):
    return {
        "date": date_value,
        "acceptedDate": accepted or f"{date_value} 16:00:00",
        "reportedCurrency": "USD",
        **extra,
    }


def valuation_fixture():
    dates = ["2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31"]
    income = [
        quarter(day, interestExpense=10_000_000, weightedAverageShsOutDil=10_000_000)
        for day in dates
    ]
    balances = [
        quarter(day, cashAndShortTermInvestments=50_000_000, totalDebt=20_000_000)
        for day in dates
    ]
    cashflows = [
        quarter(day, operatingCashFlow=100_000_000, capitalExpenditure=-20_000_000)
        for day in dates
    ]
    return income, balances, cashflows


class HistoricalPriceTests(unittest.TestCase):
    def test_price_rows_sort_dedupe_and_reject_bad_values(self):
        rows = [
            {"date": "2025-01-03", "close": 10, "adjClose": 88},
            {"date": "2025-01-02", "close": 9},
            {"date": "2025-01-03", "close": 11},
            {"date": "2025-01-04", "close": float("nan")},
            {"date": "bad", "close": 12},
            {"date": "2025-01-01", "close": -1},
        ]
        normalized = normalize_price_rows(rows, date(2025, 1, 1), date(2025, 1, 5))
        self.assertEqual([row["date"] for row in normalized], ["2025-01-02", "2025-01-03"])
        self.assertEqual(normalized[-1]["close"], 11)

    def test_malformed_price_schema_is_rejected(self):
        with self.assertRaises(HistoricalDataError):
            normalize_price_rows({"error": "not a list"}, date(2025, 1, 1), date(2025, 1, 5))

    def test_split_adjustment_changes_price_to_current_share_basis(self):
        rows = [{"date": "2024-12-31", "close": 400}]
        split = [{"date": "2025-01-10", "numerator": 2, "denominator": 1}]
        adjusted = split_adjust_prices(rows, split, date(2025, 1, 15))
        self.assertEqual(adjusted[0]["close"], 200)
        self.assertEqual(adjusted[0]["raw_close"], 400)

    def test_failed_initial_refresh_records_error_without_fake_prices(self):
        class Response:
            status_code = 429
            headers = {"Retry-After": "0"}

            def json(self):
                return []

        with tempfile.TemporaryDirectory() as temp, patch("historical_market_data.time.sleep"):
            result = fetch_historical_prices(
                "AAPL",
                "fixture-key",
                temp,
                as_of=date(2025, 1, 15),
                get=lambda *args, **kwargs: Response(),
            )
            self.assertEqual(result["metadata"]["status"], "error")
            self.assertEqual(result["prices"], [])
            self.assertEqual(len(list(Path(temp).glob("*.json"))), 1)

    def test_refresh_uses_five_calendar_years_and_raw_close_field(self):
        captured = {}

        class Response:
            status_code = 200
            headers = {}

            def json(self):
                return [{"date": "2025-01-14", "close": 44, "adjClose": 2}]

        def get(url, **kwargs):
            captured["url"] = url
            captured.update(kwargs)
            return Response()

        with tempfile.TemporaryDirectory() as temp:
            result = fetch_historical_prices(
                "BRK.B",
                "fixture-key",
                temp,
                as_of=date(2025, 1, 15),
                split_events=[],
                adjustment_basis_verified=True,
                split_events_available=True,
                get=get,
            )
        self.assertTrue(captured["url"].endswith("/stable/historical-price-eod/full"))
        self.assertEqual(captured["params"]["symbol"], "BRK.B")
        self.assertEqual(captured["params"]["from"], "2020-01-15")
        self.assertEqual(captured["params"]["to"], "2025-01-15")
        self.assertEqual(result["prices"][0]["close"], 44)
        self.assertTrue(result["metadata"]["adjustment_semantics_verified"])

    def test_refresh_failure_keeps_last_good_and_marks_stale(self):
        class GoodResponse:
            status_code = 200
            headers = {}

            def json(self):
                return [{"date": "2025-01-14", "close": 42}]

        class FailedResponse:
            status_code = 503
            headers = {}

        with tempfile.TemporaryDirectory() as temp, patch("historical_market_data.time.sleep"):
            fetch_historical_prices(
                "AAPL",
                "fixture-key",
                temp,
                as_of=date(2025, 1, 15),
                get=lambda *args, **kwargs: GoodResponse(),
            )
            path = Path(temp) / "AAPL.json"
            cached = json.loads(path.read_text())
            cached["metadata"]["refreshed_at"] = "2020-01-01T00:00:00+00:00"
            path.write_text(json.dumps(cached))
            result = fetch_historical_prices(
                "AAPL",
                "fixture-key",
                temp,
                as_of=date(2025, 1, 15),
                get=lambda *args, **kwargs: FailedResponse(),
            )
            self.assertEqual(result["metadata"]["status"], "stale")
            self.assertEqual(result["metadata"]["last_good_at"], cached["metadata"]["last_good_at"])
            self.assertEqual(result["prices"][0]["close"], 42)
            self.assertEqual(json.loads(path.read_text())["metadata"]["status"], "stale")

    def test_split_cache_has_fresh_and_last_good_error_states(self):
        class GoodResponse:
            status_code = 200
            headers = {}

            def json(self):
                return [{"date": "2024-01-10", "numerator": 2, "denominator": 1}]

        class FailedResponse:
            status_code = 503
            headers = {}

        with tempfile.TemporaryDirectory() as temp, patch("historical_market_data.time.sleep"):
            first = fetch_historical_splits(
                "AAPL", "fixture-key", temp, get=lambda *args, **kwargs: GoodResponse()
            )
            self.assertEqual(first["metadata"]["status"], "fresh")
            self.assertEqual(first["splits"][0]["numerator"], 2)
            path = Path(temp) / "AAPL.splits.json"
            cached = json.loads(path.read_text())
            cached["metadata"]["refreshed_at"] = "2020-01-01T00:00:00+00:00"
            path.write_text(json.dumps(cached))
            stale = fetch_historical_splits(
                "AAPL", "fixture-key", temp, get=lambda *args, **kwargs: FailedResponse()
            )
            self.assertEqual(stale["metadata"]["status"], "stale")
            self.assertEqual(stale["metadata"]["last_good_at"], cached["metadata"]["last_good_at"])

    def test_explicit_symbol_mapping_does_not_strip_punctuation(self):
        self.assertEqual(fmp_symbol("BRK.B"), "BRK.B")
        self.assertEqual(fmp_symbol("ABC.X"), "ABC.X")


class HistoricalValuationTests(unittest.TestCase):
    def build(self, income, balances, cashflows, **kwargs):
        return build_quarterly_valuations(
            income,
            balances,
            cashflows,
            sector="資訊科技",
            country="US",
            adjustment_basis_verified=True,
            share_basis_verified=True,
            as_of=date(2025, 1, 15),
            **kwargs,
        )

    def test_reconstruction_reproducible_with_split_adjusted_shares(self):
        income, balances, cashflows = valuation_fixture()
        split = [{"date": "2025-01-10", "numerator": 2, "denominator": 1}]
        result = build_quarterly_valuations(
            income,
            balances,
            cashflows,
            split,
            sector="資訊科技",
            country="US",
            adjustment_basis_verified=True,
            share_basis_verified=True,
            as_of=date(2025, 1, 15),
        )
        point = result[-1]
        self.assertEqual(point["status"], "available")
        self.assertEqual(point["fiscal_end_date"], "2024-12-31")
        self.assertEqual(point["availability_date"], "2024-12-31")
        self.assertEqual(point["fcff_ttm"], 351_600_000)
        self.assertEqual(point["shares"], 20_000_000)
        self.assertEqual(point["split_factor"], 2)
        self.assertAlmostEqual(point["value_per_share"], 268.5147, places=4)
        self.assertIn("not original filing vintages", point["limitation"])

    def test_no_lookahead_when_quarterly_report_was_not_yet_available(self):
        income, balances, cashflows = valuation_fixture()
        cashflows[1]["acceptedDate"] = "2025-02-01 16:00:00"
        result = self.build(income, balances, cashflows)
        self.assertEqual(result[-1]["status"], "unavailable")
        self.assertIn("four aligned", result[-1]["missing_reason"])

    def test_missing_exact_period_join_is_unavailable(self):
        income, balances, cashflows = valuation_fixture()
        balances.pop(1)
        result = self.build(income, balances, cashflows)
        point = next(row for row in result if row["fiscal_end_date"] == "2024-06-30")
        self.assertEqual(point["status"], "unavailable")
        self.assertIn("exact period-end", point["missing_reason"])

    def test_negative_fcf_is_not_replaced_by_positive_value(self):
        income, balances, cashflows = valuation_fixture()
        for row in cashflows:
            row["operatingCashFlow"] = 1_000_000
            row["capitalExpenditure"] = -100_000_000
        result = self.build(income, balances, cashflows)
        self.assertEqual(result[-1]["status"], "unavailable")
        self.assertIsNone(result[-1]["value_per_share"])
        self.assertIn("negative cash flow was not replaced", result[-1]["missing_reason"])

    def test_unsupported_currency_adr_and_financial_sector_are_unavailable(self):
        income, balances, cashflows = valuation_fixture()
        income[0]["reportedCurrency"] = "TWD"
        self.assertIn("not USD", self.build(income, balances, cashflows)[0]["missing_reason"])
        income, balances, cashflows = valuation_fixture()
        adr = build_quarterly_valuations(
            income, balances, cashflows, sector="資訊科技", country="Taiwan",
            is_adr=True, adr_ratio=None, adjustment_basis_verified=True,
            share_basis_verified=True,
            as_of=date(2025, 1, 15),
        )
        self.assertIn("Non-US issuer", adr[0]["missing_reason"])
        financial = build_quarterly_valuations(
            income, balances, cashflows, sector="金融", country="US",
            adjustment_basis_verified=True, share_basis_verified=True,
            as_of=date(2025, 1, 15),
        )
        self.assertIn("financial-sector", financial[0]["missing_reason"])

    def test_unverified_source_and_nonfinite_inputs_are_suppressed(self):
        income, balances, cashflows = valuation_fixture()
        unverified = build_quarterly_valuations(
            income, balances, cashflows, sector="資訊科技", country="US",
            adjustment_basis_verified=False, as_of=date(2025, 1, 15),
        )
        self.assertIn("not been verified", unverified[0]["missing_reason"])
        share_basis_unknown = build_quarterly_valuations(
            income, balances, cashflows, sector="資訊科技", country="US",
            adjustment_basis_verified=True, share_basis_verified=False,
            as_of=date(2025, 1, 15),
        )
        self.assertIn("double adjustment", share_basis_unknown[0]["missing_reason"])
        income, balances, cashflows = valuation_fixture()
        income[-1]["weightedAverageShsOutDil"] = float("inf")
        result = self.build(income, balances, cashflows)
        self.assertEqual(result[-1]["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()

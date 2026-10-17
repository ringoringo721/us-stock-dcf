import unittest
from datetime import date

from scripts.capture_valuation_sources import outstanding_share_record, provider_symbol, selected_symbols, years_before


class SourceSelectionTests(unittest.TestCase):
    def test_default_universe_is_preserved(self):
        self.assertEqual(selected_symbols({"CSCO": {}, "BRK.B": {}}, ""), ["CSCO", "BRK.B"])

    def test_provider_identity_preserves_hk_suffix(self):
        self.assertEqual(provider_symbol("0700.HK"), "0700.HK")
        self.assertEqual(provider_symbol("0005.HK"), "0005.HK")
        self.assertEqual(provider_symbol("BRK.B"), "BRK-B")

    def test_selection_normalizes_and_deduplicates_without_losing_zeroes(self):
        self.assertEqual(selected_symbols({}, " 0700.hk,0005.HK,0700.HK "), ["0700.HK", "0005.HK"])

    def test_invalid_and_excessive_selections_are_rejected(self):
        for supplied in [",", "AAPL;echo unsafe", "AAPL/../../file", ",".join(f"X{i}" for i in range(21))]:
            with self.subTest(supplied=supplied), self.assertRaises(ValueError):
                selected_symbols({}, supplied)

    def test_historical_capture_handles_leap_dates(self):
        self.assertEqual(years_before(date(2024, 2, 29), 10), date(2014, 2, 28))
        self.assertEqual(years_before(date(2024, 2, 29), 20), date(2004, 2, 29))

    def test_outstanding_source_preserves_actual_counts_and_rejects_future_or_invalid_records(self):
        current = {"symbol": "TEST", "date": "2026-10-16", "outstandingShares": 120000001}
        rows = [dict(current, date="2026-10-01"), current, dict(current, date="2026-10-18"),
                dict(current, date="2025-02-30"), dict(current, symbol="OTHER")]
        self.assertEqual(outstanding_share_record(rows, "TEST", "2026-10-17"), current)
        for count in [None, True, 0, -1, 1.5, float("nan"), float("inf"), 9007199254740992]:
            with self.subTest(count=count):
                self.assertIsNone(outstanding_share_record([dict(current, outstandingShares=count)], "TEST", "2026-10-17"))
        self.assertIsNone(outstanding_share_record([{"symbol": "TEST", "date": "2026-10-16",
                                                    "floatShares": 90, "weightedAverageShsOutDil": 100}],
                                                   "TEST", "2026-10-17"))
        with self.assertRaises(ValueError):
            outstanding_share_record({"error": "unavailable"}, "TEST", "2026-10-17")


if __name__ == "__main__":
    unittest.main()

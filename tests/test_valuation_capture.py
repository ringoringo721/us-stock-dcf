import unittest
from datetime import date

from scripts.capture_valuation_sources import provider_symbol, selected_symbols, years_before


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


if __name__ == "__main__":
    unittest.main()

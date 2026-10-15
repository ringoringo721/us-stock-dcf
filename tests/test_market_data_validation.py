import unittest

from validate_market_data import configured_symbols, validate_dataset


class DatasetValidationTests(unittest.TestCase):
    def test_configured_symbols_are_read_from_market_builder(self):
        symbols = configured_symbols()
        self.assertGreaterEqual(len(symbols), 200)
        self.assertIn("NVDA", symbols)
        self.assertIn("BRK.B", symbols)

    def test_empty_authentic_history_is_reported_as_missing_not_success(self):
        report, errors = validate_dataset(
            {
                "NVDA": {
                    "real_5y_prices": [],
                    "price_history_metadata": {"status": "missing"},
                    "historical_valuations": [],
                }
            },
            ["NVDA"],
        )
        self.assertEqual(errors, [])
        self.assertEqual(report["stocks"]["NVDA"]["price_status"], "missing")
        self.assertEqual(report["stocks"]["NVDA"]["price_count"], 0)

    def test_fresh_empty_and_out_of_window_data_fail_validation(self):
        _, errors = validate_dataset(
            {
                "NVDA": {
                    "real_5y_prices": [],
                    "price_history_metadata": {"status": "fresh"},
                    "historical_valuations": [],
                }
            },
            ["NVDA"],
        )
        self.assertTrue(any("marked fresh without historical prices" in error for error in errors))


if __name__ == "__main__":
    unittest.main()

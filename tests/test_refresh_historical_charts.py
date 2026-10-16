import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import refresh_historical_charts as refresh


class ChartOnlyRefreshTests(unittest.TestCase):
    def test_refresh_updates_both_generated_files_without_touching_valuation_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data_path = root / "full_market_dcf.json"
            js_path = root / "market_data.js"
            cache_dir = root / "cache/historical_prices"
            report_path = cache_dir / "coverage_report.json"
            data_path.write_text(json.dumps({
                "NVDA": {"price": 200, "fair_val": 100, "real_5y_prices": []},
                "BRK.B": {"price": 500, "fair_val": 400, "real_5y_prices": []},
            }))
            split_result = {"metadata": {"status": "fresh"}, "splits": []}
            price_result = {
                "metadata": {
                    "status": "fresh",
                    "source": "fixture",
                    "adjustment_semantics_verified": True,
                },
                "prices": [{"date": "2025-01-02", "close": 42, "volume": 100}],
            }
            with (
                patch.object(refresh, "DATA_PATH", data_path),
                patch.object(refresh, "MARKET_DATA_JS", js_path),
                patch.object(refresh, "CACHE_DIR", cache_dir),
                patch.object(refresh, "REPORT_PATH", report_path),
                patch.object(refresh, "configured_symbols", return_value=["NVDA", "BRK.B"]),
                patch.object(refresh, "fetch_historical_splits", return_value=split_result),
                patch.object(refresh, "fetch_historical_prices", return_value=price_result),
            ):
                report = refresh.refresh_chart_history("test-key")

            data = json.loads(data_path.read_text())
            self.assertEqual(data["NVDA"]["price"], 200)
            self.assertEqual(data["NVDA"]["fair_val"], 100)
            self.assertEqual(data["NVDA"]["real_5y_prices"][0]["close"], 42)
            self.assertEqual(data["BRK.B"]["real_5y_prices"][0]["date"], "2025-01-02")
            js_data = js_path.read_text().split(" = ", 1)[1].removesuffix(";")
            self.assertEqual(json.loads(js_data), data)
            self.assertEqual(report["configured_stock_count"], 2)
            self.assertTrue(report_path.exists())


if __name__ == "__main__":
    unittest.main()

from datetime import date
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from scripts.refresh_price_charts import fetch_prices, main, parse_prices, years_before


class PriceChartTests(unittest.TestCase):
    def test_dates_sort_real_prices_and_preserve_missing_and_zero_volume(self):
        payload = [
            {"symbol": "AAPL", "date": "2026-10-16", "close": 12.3456, "volume": None},
            {"symbol": "AAPL", "date": "2026-10-15", "close": 10, "volume": 0},
        ]
        self.assertEqual(parse_prices(payload, "AAPL", date(2026, 1, 1), date(2026, 12, 31)),
                         [["2026-10-15", 10, 0], ["2026-10-16", 12.3456, None]])
        self.assertEqual(years_before(date(2024, 2, 29), 10), date(2014, 2, 28))

    def test_invalid_provider_data_is_not_an_empty_success(self):
        row = {"symbol": "AAPL", "date": "2026-10-16", "close": 10, "volume": 5}
        for payload in [{"Error Message": "restricted"}, None, [{"symbol": "OTHER"}],
                        [{**row, "date": "2026-02-30"}], [{**row, "close": 0}],
                        [{**row, "close": True}], [{**row, "volume": -1}],
                        [{**row, "volume": 1.5}], [{**row, "date": "2027-01-01"}],
                        [row, {**row, "close": 20}]]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                parse_prices(payload, "AAPL", date(2026, 1, 1), date(2026, 12, 31))

    @patch("scripts.refresh_price_charts.time.sleep")
    def test_twenty_year_history_uses_bounded_nonoverlapping_requests(self, sleep):
        session = Mock()
        old = {"symbol": "BRK-B", "date": "2010-01-04", "close": 50, "volume": 100}
        new = {"symbol": "BRK-B", "date": "2026-10-16", "close": 100, "volume": 200}
        session.get.side_effect = [Mock(status_code=200, json=Mock(return_value=[old])),
                                   Mock(status_code=200, json=Mock(return_value=[new]))]
        result = fetch_prices(session, "BRK.B", "secret", date(2026, 10, 17))
        self.assertEqual(result["rows"], [["2010-01-04", 50, 100], ["2026-10-16", 100, 200]])
        self.assertEqual(result["priceBasis"], "splitAdjustedClose")
        first, second = [call.kwargs["params"] for call in session.get.call_args_list]
        self.assertEqual(first["symbol"], "BRK-B")
        self.assertEqual(first["to"], "2016-10-16")
        self.assertEqual(second["from"], "2016-10-17")

    def test_permission_failure_does_not_leak_api_key(self):
        session = Mock()
        session.get.return_value = Mock(status_code=403)
        with self.assertRaisesRegex(RuntimeError, "HTTP 403") as error:
            fetch_prices(session, "AAPL", "secret", date(2026, 10, 17))
        self.assertNotIn("secret", str(error.exception))

    @patch("scripts.refresh_price_charts.time.sleep")
    @patch("scripts.refresh_price_charts.requests.Session")
    def test_empty_response_cannot_erase_existing_real_history(self, session_factory, sleep):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / "cache" / "price_charts"
            folder.mkdir(parents=True)
            (root / "full_market_dcf.json").write_text('{"AAPL": {}}', encoding="utf-8")
            previous = json.dumps({"rows": [["2024-01-02", 100, 1000]]})
            target = folder / "AAPL.json"
            target.write_text(previous, encoding="utf-8")
            session_factory.return_value.__enter__.return_value.get.return_value = Mock(
                status_code=200, json=Mock(return_value=[]))
            with patch("scripts.refresh_price_charts.__file__", str(root / "scripts" / "refresh_price_charts.py")), \
                    patch.dict("os.environ", {"FMP_API_KEY": "secret"}):
                with self.assertRaisesRegex(RuntimeError, "would erase existing history"):
                    main()
            self.assertEqual(target.read_text(encoding="utf-8"), previous)


if __name__ == "__main__":
    unittest.main()

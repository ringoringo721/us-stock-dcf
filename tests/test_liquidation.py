import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from scripts.refresh_liquidation import build_record, fetch_rows, main


def responses(symbol="BRK-B"):
    return {
        "balance": {"ok": True, "rows": [
            {"symbol": symbol, "date": "2026-06-30", "period": "Q2", "reportedCurrency": "USD",
             "totalCurrentAssets": 500, "totalLiabilities": 200, "cashAndShortTermInvestments": 100,
             "accountsReceivables": 0, "inventory": 0, "preferredStock": None},
            {"symbol": symbol, "date": "2026-03-31", "period": "Q1", "reportedCurrency": "USD"}]},
        "quote": {"ok": True, "rows": [{"symbol": symbol, "price": 10, "marketCap": 1000, "timestamp": 1792180800}]},
        "profile": {"ok": True, "rows": [{"symbol": symbol, "currency": "USD"}]}
    }


class LiquidationTests(unittest.TestCase):
    def test_latest_quarter_is_sorted_and_zero_and_missing_fields_stay_distinct(self):
        data = responses()
        data["balance"]["rows"].reverse()
        result = build_record("BRK.B", data, "2026-10-17T05:00:00Z")
        self.assertEqual(result["providerSymbol"], "BRK-B")
        self.assertEqual(result["balance"]["date"], "2026-06-30")
        self.assertEqual(result["balance"]["accountsReceivables"], 0)
        self.assertIsNone(result["balance"]["preferredStock"])
        self.assertIsNone(result["balance"]["netReceivables"])
        self.assertEqual(result["quote"]["date"], "2026-10-16")

    def test_future_dates_conflicting_duplicates_wrong_symbols_and_non_usd_quotes_are_rejected(self):
        for case in ("future", "invalid", "symbol", "duplicate", "currency", "timestamp", "filing"):
            data = responses()
            if case == "future":
                data["balance"]["rows"][0]["date"] = "2027-01-01"
            elif case == "invalid":
                data["balance"]["rows"][0]["date"] = "2026-02-30"
            elif case == "symbol":
                data["quote"]["rows"][0]["symbol"] = "BRKB"
            elif case == "duplicate":
                data["balance"]["rows"].append({**data["balance"]["rows"][0], "inventory": 3})
            elif case == "currency":
                data["profile"]["rows"][0]["currency"] = "EUR"
            elif case == "filing":
                data["balance"]["rows"][0]["acceptedDate"] = "2027-01-01 17:00:00"
            else:
                data["quote"]["rows"][0]["timestamp"] = None
            with self.subTest(case=case), self.assertRaises(ValueError):
                build_record("BRK.B", data, "2026-10-17T05:00:00Z")

    def test_empty_and_permission_error_are_not_success_or_fake_quote_defaults(self):
        for endpoint in ("balance", "profile", "quote"):
            data = responses()
            data[endpoint] = {"ok": True, "rows": []}
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                build_record("BRK.B", data, "2026-10-17T05:00:00Z")

    @patch("scripts.refresh_liquidation.time.sleep")
    def test_http_and_network_failures_do_not_expose_the_key(self, sleep):
        session = Mock()
        session.get.return_value = Mock(status_code=403)
        with self.assertRaisesRegex(RuntimeError, "HTTP 403") as error:
            fetch_rows(session, "quote", {"symbol": "TEST"}, "private-test-key")
        self.assertNotIn("private-test-key", str(error.exception))
        session.get.return_value = Mock(status_code=200, json=Mock(return_value={"Error": "private-test-key"}))
        with self.assertRaisesRegex(ValueError, "unexpected response") as error:
            fetch_rows(session, "quote", {"symbol": "TEST"}, "private-test-key")
        self.assertNotIn("private-test-key", str(error.exception))

    @patch("scripts.refresh_liquidation.time.sleep")
    @patch("scripts.refresh_liquidation.requests.Session")
    def test_failed_refresh_retains_all_previously_published_sources(self, session_factory, sleep):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "cache").mkdir()
            target = root / "cache" / "liquidation_sources.json"
            previous = '{"version":1,"stocks":{"BRK.B":{"fetchedAt":"2026-10-16"}}}'
            target.write_text(previous, encoding="utf-8")
            (root / "full_market_dcf.json").write_text(json.dumps({"BRK.B": {}, "MSFT": {}}), encoding="utf-8")
            data = responses()
            session_factory.return_value.__enter__.return_value.get.side_effect = [
                Mock(status_code=200, json=Mock(return_value=data[name]["rows"]))
                for name in ("balance", "quote", "profile")
            ] + [Mock(status_code=403)]
            with patch("scripts.refresh_liquidation.__file__", str(root / "scripts" / "refresh_liquidation.py")), \
                    patch.dict("os.environ", {"FMP_API_KEY": "private-test-key"}):
                with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
                    main()
            self.assertEqual(target.read_text(encoding="utf-8"), previous)


if __name__ == "__main__":
    unittest.main()

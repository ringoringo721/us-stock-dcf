import unittest

from scripts.import_us_universe import select_listings, normalize_exchange, is_excluded_security


class UsUniverseImportTest(unittest.TestCase):
    def test_exchange_aliases(self):
        self.assertEqual(normalize_exchange("NYSE American"), "AMEX")
        self.assertEqual(normalize_exchange("NASDAQGS"), "NASDAQ")
        self.assertIsNone(normalize_exchange("OTC"))

    def test_excludes_etfs_and_sub_10b(self):
        rows = [
            {"symbol": "BIG", "companyName": "Big Co", "exchangeShortName": "NYSE", "marketCap": 15_000_000_001, "isEtf": False},
            {"symbol": "TINY", "companyName": "Tiny Co", "exchangeShortName": "NYSE", "marketCap": 9_999_999_999, "isEtf": False},
            {"symbol": "FUND", "companyName": "Some ETF", "exchangeShortName": "NYSE", "marketCap": 50_000_000_000, "isEtf": True},
            {"symbol": "EXACT", "companyName": "Exact Ten", "exchangeShortName": "NASDAQ", "marketCap": 10_000_000_000, "isEtf": False},
            {"symbol": "AMEX1", "companyName": "Amex Co", "exchange": "AMEX", "marketCap": 12_500_000_000, "isEtf": False},
        ]
        stocks, excluded = select_listings(rows)
        self.assertEqual([item["ticker"] for item in stocks], ["BIG", "AMEX1"])
        self.assertGreaterEqual(excluded.get("marketCapNotAbove10B", 0), 2)
        self.assertGreaterEqual(excluded.get("etfOrFund", 0), 1)

    def test_invalid_symbol(self):
        self.assertEqual(is_excluded_security({"symbol": "1BAD"}), "invalidSymbol")


if __name__ == "__main__":
    unittest.main()

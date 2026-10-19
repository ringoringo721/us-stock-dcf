import unittest

from scripts.import_hkex_universe import select_listings


class HkexUniverseTests(unittest.TestCase):
    def rows(self, *rows):
        return [{}, {"A": "Updated as at 20/10/2026"}, {"A": "Stock Code", "C": "Category"}, *rows]

    def stock(self, code, isin="", currency="HKD", **extra):
        return {"A": code, "B": "ISSUER", "C": "Equity", "D": "Equity Securities (Main Board)",
                "F": isin, "Q": currency, **extra}

    def test_missing_isin_does_not_collapse_distinct_companies(self):
        date, stocks, _, counters = select_listings(self.rows(self.stock("00001"), self.stock("00002")))
        self.assertEqual(date, "2026-10-20")
        self.assertEqual(len(stocks), 2)
        self.assertEqual(counters, [])

    def test_verified_additional_counters_prefer_hkd_but_preserve_sole_rmb_reit(self):
        _, stocks, _, counters = select_listings(self.rows(
            self.stock("80001", "HK0000000001", "RMB"), self.stock("00001", "HK0000000001"),
            self.stock("87001", "HK0000000002", "RMB", C="Real Estate Investment Trusts")))
        self.assertEqual([stock["ticker"] for stock in stocks], ["0001.HK", "87001.HK"])
        self.assertEqual(counters[0]["primary"], "0001.HK")
        self.assertEqual(stocks[-1]["securityType"], "REIT")

    def test_nonordinary_securities_and_temporary_counters_are_excluded(self):
        _, stocks, excluded, _ = select_listings(self.rows(
            self.stock("02915"), self.stock("04621", B="CINDA 21USDPREF"),
            self.stock("02800", C="Exchange Traded Products"),
            self.stock("08111", D="Equity Securities (GEM)")))
        self.assertEqual([stock["ticker"] for stock in stocks], ["8111.HK"])
        self.assertEqual(stocks[0]["board"], "GEM")
        self.assertEqual(excluded["temporaryCounter"], 1)
        self.assertEqual(excluded["preferenceShares"], 1)

    def test_unrecognized_dates_and_invalid_equity_identity_fail_explicitly(self):
        with self.assertRaises(ValueError):
            select_listings(self.rows(self.stock("0001")))
        with self.assertRaises(ValueError):
            select_listings(self.rows(self.stock("00001", currency="JPY")))


if __name__ == "__main__":
    unittest.main()

import unittest

from scripts.import_hkex_universe import select_listings, supplement_chinese_names


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

    def chinese_rows(self, *rows):
        return [{}, {"A": "截 至 20/10/2026"}, {"A": "股份代號", "B": "股份名稱"}, *rows]

    def catalogue(self, *rows):
        _, stocks, _, _ = select_listings(self.rows(*rows))
        return {"source": {"asOf": "2026-10-20", "sha256": "original"}, "stocks": stocks}

    def test_official_chinese_names_preserve_primary_source_and_listing_identity(self):
        catalogue = self.catalogue(self.stock("02145", "CNE100005MX1"), self.stock("00002"))
        count = supplement_chinese_names(catalogue, self.chinese_rows(
            self.stock("02145", "CNE100005MX1", B="上美股份"), self.stock("00002", B="中電控股")
        ), {"sha256": "chinese", "url": "official"})
        self.assertEqual(count, 2)
        self.assertEqual(catalogue["source"]["sha256"], "original")
        self.assertEqual(catalogue["stocks"][-1]["name_zh"], "上美股份")
        self.assertEqual(catalogue["stocks"][-1]["name_en"], "ISSUER")
        self.assertEqual(catalogue["chineseNameSource"]["unmatchedTickers"], [])

    def test_chinese_identity_mismatches_and_duplicates_fail_explicitly(self):
        for row in [self.stock("02145", "CNE100005MX2"), self.stock("02145", "CNE100005MX1", "RMB")]:
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                supplement_chinese_names(self.catalogue(self.stock("02145", "CNE100005MX1")),
                                         self.chinese_rows(row), {})
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            supplement_chinese_names(self.catalogue(self.stock("00002")),
                                     self.chinese_rows(self.stock("00002"), self.stock("00002")), {})

    def test_unmatched_names_and_cross_date_unverified_isins_are_not_invented(self):
        catalogue = self.catalogue(self.stock("00002"), self.stock("02145", "CNE100005MX1"))
        rows = self.chinese_rows(self.stock("00002", B="中電控股"))
        rows[1]["A"] = "截 至 21/10/2026"
        self.assertEqual(supplement_chinese_names(catalogue, rows, {}), 0)
        self.assertEqual(catalogue["chineseNameSource"]["unmatchedTickers"], ["0002.HK", "2145.HK"])
        self.assertTrue(all("name_zh" not in stock for stock in catalogue["stocks"]))
        with self.assertRaisesRegex(ValueError, "schema"):
            supplement_chinese_names(catalogue, self.rows(), {})
        rows[1]["A"] = "unknown"
        with self.assertRaisesRegex(ValueError, "date"):
            supplement_chinese_names(catalogue, rows, {})


if __name__ == "__main__":
    unittest.main()

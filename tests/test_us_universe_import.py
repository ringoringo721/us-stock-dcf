import unittest

from scripts.import_us_universe import (
    select_listings,
    normalize_exchange,
    is_excluded_security,
    listing_exclusion_reason,
)


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

    def test_excludes_debt_notes_and_preferred(self):
        cases = [
            ({"symbol": "MER-PK", "companyName": "Bank of America Corp 6.45 % Notes 2018-15.12.66 Income Capital Obligations"},
             "preferredOrNoteSymbol"),
            ({"symbol": "PFH", "companyName": "Prudential Financial, Inc. 4.125% Junior Subordinated Notes due 2060"},
             "debtNoteName"),
            ({"symbol": "TMUSL", "companyName": "T-Mobile US, Inc. 6.25 % Notes -01.09.69"},
             "debtNoteName"),
            ({"symbol": "TMUSI", "companyName": "T-Mobile USA Inc 5.5 % Notes 2025-01.06.70"},
             "debtNoteName"),
            ({"symbol": "XELLL", "companyName": "Xcel Energy Inc. 6.25% Junior Subordinated Notes, Series due 2085"},
             "debtNoteName"),
            ({"symbol": "STRF", "companyName": "MicroStrategy Incorporated 10.00% Series A Perpetual Strife Preferred Stock"},
             "preferredName"),
            ({"symbol": "SATA", "companyName": "Strive Inc. Perp. Pfd. Series A"},
             "preferredName"),
            ({"symbol": "CTA-PA", "companyName": "EIDP, Inc."},
             "preferredOrNoteSymbol"),
            ({"symbol": "EP-PC", "companyName": "El Paso Energy Capital Trust I PFD CV TR SECS"},
             "preferredOrNoteSymbol"),
            ({"symbol": "NOTE1", "companyName": "Issuer Co", "securityType": "preferred stock"},
             "nonCommonType"),
        ]
        for row, reason in cases:
            self.assertEqual(is_excluded_security(row), reason, row)

    def test_keeps_dual_class_common_equity(self):
        for symbol, name in (
            ("BRK-A", "Berkshire Hathaway Inc."),
            ("BF-B", "Brown-Forman Corporation"),
            ("PBR-A", "Petróleo Brasileiro S.A. - Petrobras"),
            ("MOG-A", "Moog Inc."),
            ("CIG-C", "Companhia Energética de Minas Gerais"),
            ("DLR", "Digital Realty Trust, Inc."),
            ("AAPL", "Apple Inc."),
        ):
            self.assertIsNone(is_excluded_security({"symbol": symbol, "companyName": name}), symbol)

    def test_select_listings_drops_notes(self):
        rows = [
            {"symbol": "AAPL", "companyName": "Apple Inc.", "exchangeShortName": "NASDAQ",
             "marketCap": 3_000_000_000_000, "isEtf": False},
            {"symbol": "TMUSL", "companyName": "T-Mobile US, Inc. 6.25 % Notes -01.09.69",
             "exchangeShortName": "NASDAQ", "marketCap": 20_000_000_000, "isEtf": False},
            {"symbol": "MER-PK", "companyName": "Bank of America Corp Notes",
             "exchangeShortName": "NYSE", "marketCap": 50_000_000_000, "isEtf": False},
            {"symbol": "BRK-A", "companyName": "Berkshire Hathaway Inc.",
             "exchangeShortName": "NYSE", "marketCap": 1_000_000_000_000, "isEtf": False},
        ]
        stocks, excluded = select_listings(rows)
        self.assertEqual([item["ticker"] for item in stocks], ["AAPL", "BRK-A"])
        self.assertGreaterEqual(excluded.get("debtNoteName", 0) + excluded.get("preferredOrNoteSymbol", 0), 2)

    def test_listing_exclusion_reason_reads_catalogue_shape(self):
        self.assertEqual(
            listing_exclusion_reason({
                "ticker": "PFH",
                "name": "Prudential Financial, Inc. 4.125% Junior Subordinated Notes due 2060",
            }),
            "debtNoteName",
        )


if __name__ == "__main__":
    unittest.main()

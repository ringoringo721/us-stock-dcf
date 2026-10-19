import importlib.util
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location(
    "capture_hkex_reports", Path(__file__).resolve().parents[1] / "scripts" / "capture_hkex_reports.py")
capture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capture)


class ReportSelectionTests(unittest.TestCase):
    def evidence(self):
        return {"responses": {
            "annual_income": {"rows": [{"date": "2024-12-31"}, {"date": "2025-12-31"}]},
            "income": {"rows": [{"date": "2025-06-30"}, {"date": "2026-06-30"}]},
        }}

    def report(self, year, kind, published=None, combined=False):
        category = "Annual Report" if kind == "annual" else "Interim&#x2f;Half-Year Report"
        if combined:
            category += " &#x2f; Environmental, Social and Governance Information&#x2f;Report"
        return {"TITLE": f"{year} {kind.title()} Report", "LONG_TEXT": f"[{category}]",
                "DATE_TIME": published or f"01/09/{year} 16:30"}

    def test_combined_annual_esg_reports_are_annual_evidence(self):
        filings = [self.report(2025, "annual", combined=True), self.report(2026, "interim")]
        selected = capture.selected_reports(filings, self.evidence())
        self.assertEqual([(row["kind"], row["reportYear"]) for row in selected],
                         [("annual", 2025), ("interim", 2026)])

    def test_date_selection_uses_calendar_order_not_day_string_order(self):
        old = self.report(2025, "annual", "28/04/2026 16:30")
        revised = self.report(2025, "annual", "01/05/2026 16:30")
        selected = capture.selected_reports([old, revised, self.report(2026, "interim")], self.evidence())
        self.assertEqual(selected[0]["DATE_TIME"], "01/05/2026 16:30")

    def test_standalone_esg_is_not_financial_evidence(self):
        esg = {"TITLE": "2025 ESG Report", "LONG_TEXT": "[Environmental, Social and Governance Report]",
               "DATE_TIME": "01/05/2026 16:30"}
        with self.assertRaisesRegex(ValueError, "No primary annual"):
            capture.selected_reports([esg, self.report(2026, "interim")], self.evidence())

    def test_short_fiscal_year_titles_are_not_mistaken_for_prior_year(self):
        annual = self.report(2025, "annual")
        annual["TITLE"] = "Annual Report 2025&#x2f;26"
        interim = self.report(2025, "interim")
        interim["TITLE"] = "Interim Report 2025-26"
        selected = capture.selected_reports([annual, interim], self.evidence())
        self.assertTrue(all(row["reportYear"] == 2026 for row in selected))

    def test_comparative_capture_is_not_marked_as_reviewed(self):
        annual = [self.report(year, "annual") for year in [2024, 2025]]
        interim = [self.report(year, "interim") for year in [2025, 2026]]
        selected = capture.selected_reports(annual + interim, self.evidence())
        self.assertEqual(len(selected), 2)
        self.assertTrue(all("reviewStatus" not in row for row in selected))

    def test_income_heading_does_not_accept_a_management_summary_reference(self):
        self.assertIsNone(capture.INCOME.search(
            "The following table presents selected consolidated statement of profit or loss line items."))
        self.assertIsNotNone(capture.INCOME.search(
            "Annual Report 2025\nCONSOLIDATED STATEMENT\nOF PROFIT OR LOSS\n2025 2024"))
        self.assertIsNotNone(capture.INCOME.search("CONSOLIDATED STATEMENTS OF INCOME"))
        self.assertIsNotNone(capture.INCOME.search(
            "CONSOLIDA TED STA TEMENT OF PROFIT OR\nLOSS AND OTHER COMPREHENSIVE INCOME"))
        self.assertIsNotNone(capture.INCOME.search("4.2 CONSOLIDATED\nINCOME STATEMENT"))
        self.assertIsNotNone(capture.INCOME.search(
            "Interim Condensed Consolidated\nStatement of Profit or Loss"))
        self.assertTrue(capture.statement_heading(
            "UNAUDITED RESULTS\nCONDENSED CONSOLIDATED STATE mENT OF CO mPrEHENSIVE\nINCO mE"))
        self.assertFalse(capture.statement_heading(
            "FIVE-YEAR SUMMARY\n2015 2016 2017 2018 2019\nCONSOLIDATED INCOME STATEMENT\nRevenue"))


if __name__ == "__main__":
    unittest.main()

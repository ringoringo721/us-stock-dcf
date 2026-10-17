import unittest

from scripts.refresh_hkex_moat import DIMENSIONS, needs_refresh, validate_report


class MoatEvidenceTests(unittest.TestCase):
    def report(self):
        return {"ticker": "0700.HK", "overall_moat_verdict_zh": "Evidence", "overall_moat_verdict_en": "Evidence",
                **{name: {"score": 7, "sources": ["profile"], "comment_zh": "Evidence", "comment_en": "Evidence"}
                   for name in DIMENSIONS}}

    def test_only_actual_evidence_changes_trigger_refresh(self):
        self.assertTrue(needs_refresh({"evidenceHash": "new", "existing": None}))
        self.assertFalse(needs_refresh({"evidenceHash": "old", "existing": {"evidenceHash": "old", "report": {"score": 7}}}))
        self.assertTrue(needs_refresh({"evidenceHash": "new", "existing": {"evidenceHash": "old", "report": {"score": 7}}}))

    def test_unavailable_dimensions_are_not_neutral_scores(self):
        report = self.report()
        report["m7_operational_efficiency"].update(score=None, sources=[])
        self.assertIsNone(validate_report(report, "0700.HK", ["profile"])["m7_operational_efficiency"]["score"])

    def test_fabricated_citations_and_uncited_scores_are_rejected(self):
        for sources in [[], ["imaginary-earnings-call"]]:
            report = self.report()
            report["m1_brand_pricing"]["sources"] = sources
            with self.assertRaises(ValueError):
                validate_report(report, "0700.HK", ["profile"])

    def test_invalid_scores_or_security_ids_are_rejected(self):
        for score in [True, -1, 11, 5.5]:
            report = self.report()
            report["m1_brand_pricing"]["score"] = score
            with self.assertRaises(ValueError):
                validate_report(report, "0700.HK", ["profile"])
        with self.assertRaises(ValueError):
            validate_report(self.report(), "9988.HK", ["profile"])


if __name__ == "__main__":
    unittest.main()

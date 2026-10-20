import unittest
import os
import sys
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import Mock, patch

from scripts.refresh_hkex_moat import (
    ASSESSMENT_POLICY, DIMENSIONS, MoatReportValidationError, create_client,
    needs_refresh, validate_report, validation_feedback, evidence_context, write_json_checkpoint, main,
    below_moat_market_cap,
)


class MoatEvidenceTests(unittest.TestCase):
    def test_market_cap_screen_uses_hkd_millions_and_preserves_unknowns(self):
        record = {"ticker": "0004.HK", "evidenceHash": "unchanged",
                  "moatScreen": {"calculationCurrency": "HKD", "marketCapMillions": 999.999}}
        self.assertTrue(below_moat_market_cap(record))
        self.assertFalse(needs_refresh(record, retry_incomplete=True, force=True))
        for amount in [1000, 1000.001, None, 0, -1, True, "999", float("nan"), float("inf")]:
            record["moatScreen"]["marketCapMillions"] = amount
            self.assertFalse(below_moat_market_cap(record), repr(amount))
        record["moatScreen"]["marketCapMillions"] = 750
        self.assertTrue(below_moat_market_cap(record))
        record["moatScreen"] = {"calculationCurrency": "USD", "marketCapMillions": 100}
        self.assertFalse(below_moat_market_cap(record))
        self.assertFalse(below_moat_market_cap({"ticker": "0004.HK"}))

    def test_excluded_companies_make_no_client_call_and_preserve_stored_reports(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "inputs.json", Path(directory) / "reports.json"
            stored = {"evidenceHash": "old", "report": {"archived": True}}
            record = {"ticker": "0004.HK", "evidenceHash": "new", "existing": stored,
                      "moatScreen": {"calculationCurrency": "HKD", "marketCapMillions": 100}}
            source.write_text(json.dumps([record]), encoding="utf-8")
            with patch.object(sys, "argv", ["refresh_hkex_moat.py", str(source), str(output), "--force"]), \
                    patch("scripts.refresh_hkex_moat.create_client") as client:
                main()
            client.assert_not_called()
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["0004.HK"], stored)

    def test_legacy_annual_only_inputs_without_currency_metadata_remain_assessable(self):
        record = {"ticker": "0004.HK", "profile": {"companyName": "Issuer"}, "fScore": {},
                  "statements": {"annual": {"income": [], "balance": [], "cashflow": []},
                                 "quarterly": {"income": [], "balance": [], "cashflow": []}}}
        context = evidence_context(record)
        self.assertIsNone(context["reportingCurrency"])
        self.assertEqual(context["ticker"], "0004.HK")
        self.assertIn("financial-quality", context["allowedSourceIds"])

    def test_completed_company_checkpoints_replace_atomically_and_preserve_prior_results(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "reports.json"
            write_json_checkpoint(output, {"0004.HK": {"report": {"score": 7}}})
            write_json_checkpoint(output, {"0004.HK": {"report": {"score": 7}},
                                           "0008.HK": {"lastError": {"type": "ValueError"}}})
            saved = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(saved["0004.HK"]["report"]["score"], 7)
            self.assertEqual(saved["0008.HK"]["lastError"]["type"], "ValueError")
            self.assertFalse(output.with_name("reports.json.tmp").exists())

    def test_filtered_research_inputs_do_not_erase_existing_report_checkpoints(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "inputs.json", Path(directory) / "reports.json"
            source.write_text("[]", encoding="utf-8")
            saved = {"0004.HK": {"evidenceHash": "prior-evidence", "report": {"score": 7}}}
            write_json_checkpoint(output, saved)
            with patch.object(sys, "argv", ["refresh_hkex_moat.py", str(source), str(output)]):
                main()
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), saved)

    def test_authorized_timeout_is_explicit_and_does_not_change_default_clients(self):
        client = Mock()
        google = SimpleNamespace(genai=SimpleNamespace(Client=client))
        with patch.dict(sys.modules, {"google": google}), patch.dict(os.environ, {
                "GEMINI_API_KEY": "test-placeholder", "MOAT_REQUEST_TIMEOUT_MS": "120000"}, clear=True):
            create_client()
        client.assert_called_once_with(vertexai=True, api_key="test-placeholder", http_options={"timeout": 120000})

    def test_service_account_location_can_use_global_without_changing_default_or_exposing_credentials(self):
        credentials = object()
        client = Mock()
        account = SimpleNamespace(Credentials=SimpleNamespace(from_service_account_info=Mock(return_value=credentials)))
        google = SimpleNamespace(genai=SimpleNamespace(Client=client))
        with patch.dict(sys.modules, {"google": google, "google.oauth2": SimpleNamespace(service_account=account)}), \
             patch.dict(os.environ, {"GCP_SA_KEY": '{"project_id":"credential-project"}',
                                     "GOOGLE_CLOUD_LOCATION": "global"}, clear=True):
            create_client()
        client.assert_called_once_with(vertexai=True, project="credential-project", location="global", credentials=credentials)

    def test_adc_uses_standard_vertex_project_credentials_before_express_key(self):
        credentials = object()
        client = Mock()
        auth = SimpleNamespace(default=Mock(return_value=(credentials, "credential-project")))
        google = SimpleNamespace(genai=SimpleNamespace(Client=client), auth=auth)
        with patch.dict(sys.modules, {"google": google, "google.auth": auth}), patch.dict(os.environ, {
            "GOOGLE_APPLICATION_CREDENTIALS": "test-file.json",
            "GOOGLE_CLOUD_PROJECT": "selected-project",
            "GOOGLE_CLOUD_LOCATION": "europe-west4",
            "GEMINI_API_KEY": "test-express-placeholder"
        }, clear=True):
            create_client()
        client.assert_called_once_with(vertexai=True, project="selected-project",
                                       location="europe-west4", credentials=credentials)
        auth.default.assert_called_once_with(scopes=["https://www.googleapis.com/auth/cloud-platform"])

    def test_adc_without_a_project_fails_instead_of_falling_back_to_an_api_key(self):
        auth = SimpleNamespace(default=Mock(return_value=(object(), None)))
        google = SimpleNamespace(genai=SimpleNamespace(Client=Mock()), auth=auth)
        with patch.dict(sys.modules, {"google": google, "google.auth": auth}), patch.dict(os.environ, {
            "GOOGLE_APPLICATION_CREDENTIALS": "test-file.json",
            "GEMINI_API_KEY": "test-express-placeholder"
        }, clear=True):
            with self.assertRaisesRegex(ValueError, "GOOGLE_CLOUD_PROJECT"):
                create_client()
        google.genai.Client.assert_not_called()

    def report(self):
        return {"ticker": "0700.HK", "overall_moat_verdict_zh": "Evidence", "overall_moat_verdict_en": "Evidence",
                **{name: {"score": 7, "sources": ["profile"], "comment_zh": "Evidence", "comment_en": "Evidence"}
                   for name in DIMENSIONS}}

    def test_only_actual_evidence_changes_trigger_refresh(self):
        self.assertTrue(needs_refresh({"evidenceHash": "new", "existing": None}))
        self.assertFalse(needs_refresh({"evidenceHash": "old", "existing": {
            "evidenceHash": "old", "assessmentPolicy": ASSESSMENT_POLICY, "report": {"score": 7}}}))
        self.assertTrue(needs_refresh({"evidenceHash": "new", "existing": {"evidenceHash": "old", "report": {"score": 7}}}))

    def test_policy_changes_and_explicit_partial_retry_trigger_reassessment(self):
        record = {"evidenceHash": "same", "existing": {"evidenceHash": "same", "report": self.report()}}
        self.assertTrue(needs_refresh(record))
        record["existing"]["assessmentPolicy"] = ASSESSMENT_POLICY
        self.assertFalse(needs_refresh(record))
        self.assertTrue(needs_refresh(record, force=True))
        record["existing"]["report"]["m2_patents_regulatory"]["score"] = None
        self.assertFalse(needs_refresh(record))
        self.assertTrue(needs_refresh(record, retry_incomplete=True))

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

    def test_generated_prose_cannot_relabel_foreign_money_or_invent_numerical_claims(self):
        for text in ["Deposits are HKD 1.8 trillion (USD 1.8 trillion)",
                     "Cash flow grew 20%", "FY2025 projections",
                     "\u5b58\u6b3e\u9054\u842c\u5104\u6e2f\u5143"]:
            report = self.report()
            report["m1_brand_pricing"]["comment_en"] = text
            with self.assertRaises(ValueError):
                validate_report(report, "0700.HK", ["profile"])
            report = self.report()
            report["overall_moat_verdict_en"] = text
            with self.assertRaises(ValueError):
                validate_report(report, "0700.HK", ["profile"])

    def test_invalid_report_retries_receive_safe_actionable_feedback_without_weakening_validation(self):
        report = self.report()
        report["m1_brand_pricing"]["comment_en"] = "A leading 5G network"
        with self.assertRaises(MoatReportValidationError) as rejected:
            validate_report(report, "0700.HK", ["profile"])
        feedback = validation_feedback(rejected.exception)
        self.assertIn("numerical or currency claims", feedback)
        self.assertIn("technology/product terms", feedback)
        self.assertIn("numbered industry tiers", feedback)
        self.assertIn("m1_brand_pricing.comment_en", feedback)
        self.assertIn("prohibited token: 5", feedback)
        report["m1_brand_pricing"]["comment_en"] = "A leading next-generation network"
        self.assertEqual(validate_report(report, "0700.HK", ["profile"]), report)

    def test_external_error_strings_never_enter_retry_prompts(self):
        self.assertEqual(validation_feedback(ValueError("https://example.invalid/?key=private-token")), "")
        self.assertEqual(validation_feedback(TypeError("private-token")), "")


if __name__ == "__main__":
    unittest.main()

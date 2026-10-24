import unittest
import os
import sys
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import Mock, patch

from scripts.refresh_hkex_moat import (
    ASSESSMENT_POLICY, RESEARCH_ASSESSMENT_POLICY, DIMENSIONS, MoatReportValidationError, create_client,
    needs_refresh, validate_report, validate_comment_lengths, validation_feedback, evidence_context,
    write_json_checkpoint, main, below_moat_market_cap, MIN_COMMENT_EN_WORDS,
    repair_narratives, report_schema,
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
                    patch.dict(os.environ, {"FORCE_MOAT_CONFIRM": "YES"}), \
                    patch("scripts.refresh_hkex_moat.create_client") as client:
                main()
            client.assert_not_called()
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["0004.HK"], stored)

    def test_force_requires_explicit_confirm_env(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "inputs.json", Path(directory) / "reports.json"
            source.write_text(json.dumps([{"ticker": "0005.HK", "evidenceHash": "h"}]), encoding="utf-8")
            with patch.object(sys, "argv", ["refresh_hkex_moat.py", str(source), str(output), "--force"]), \
                    patch.dict(os.environ, {"FORCE_MOAT_CONFIRM": ""}, clear=False), \
                    patch("scripts.refresh_hkex_moat.create_client") as client:
                with self.assertRaises(SystemExit) as raised:
                    main()
            self.assertIn("FORCE_MOAT_CONFIRM", str(raised.exception))
            client.assert_not_called()

    def test_legacy_annual_only_inputs_without_currency_metadata_remain_assessable(self):
        record = {"ticker": "0004.HK", "profile": {"companyName": "Issuer"}, "fScore": {},
                  "statements": {"annual": {"income": [], "balance": [], "cashflow": []},
                                 "quarterly": {"income": [], "balance": [], "cashflow": []}}}
        context = evidence_context(record)
        self.assertIsNone(context["reportingCurrency"])
        self.assertEqual(context["ticker"], "0004.HK")
        self.assertIn("financial-quality", context["allowedSourceIds"])

    def test_existing_cost_and_allocation_fields_and_available_history_reach_the_assessment(self):
        record = {"ticker": "1911.HK", "profile": {}, "fScore": {},
                  "statements": {"annual": {
                      "income": [{"date": f"{year}-12-31", "operatingExpenses": 40, "costOfRevenue": 30,
                                  "generalAndAdministrativeExpenses": 0} for year in range(2018, 2026)],
                      "balance": [{"date": "2025-12-31", "goodwill": None, "longTermInvestments": 12}],
                      "cashflow": [{"date": "2025-12-31", "acquisitionsNet": -10,
                                    "netDebtIssuance": 15, "purchasesOfInvestments": -20}]},
                                 "quarterly": {"income": [], "balance": [], "cashflow": []}}}
        original = json.loads(json.dumps(record))
        context = evidence_context(record)
        self.assertEqual(len(context["financials"]["annual"]["income"]), 8)
        self.assertEqual(context["financials"]["annual"]["income"][-1]["operatingExpenses"], 40)
        self.assertEqual(context["financials"]["annual"]["income"][-1]["generalAndAdministrativeExpenses"], 0)
        self.assertIsNone(context["financials"]["annual"]["balance"][0]["goodwill"])
        self.assertEqual(context["financials"]["annual"]["cashflow"][0]["acquisitionsNet"], -10)
        self.assertIn("annual:income:2018-12-31", context["allowedSourceIds"])
        self.assertEqual(record, original)

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

    def test_assessment_policy_is_v5_enforced_length_not_prior_short_ids(self):
        self.assertEqual(ASSESSMENT_POLICY, "grounded-business-judgment-v5")
        self.assertEqual(RESEARCH_ASSESSMENT_POLICY, "researched-business-judgment-v6")
        self.assertNotIn("v3", ASSESSMENT_POLICY)
        self.assertNotIn("v4", ASSESSMENT_POLICY)
        schema = report_schema("0700.HK", ["profile"])
        dimension = schema.model_json_schema()["$defs"]["Dimension"]
        self.assertIn("150", dimension["properties"]["comment_zh"]["description"])
        self.assertIn("150", dimension["properties"]["comment_en"]["description"])
        self.assertIn("REQUIRED length", dimension["properties"]["comment_en"]["description"])
        self.assertIn("approximately 150", dimension["properties"]["comment_en"]["description"])
        props = schema.model_json_schema()["properties"]
        self.assertIn("150", props["overall_moat_verdict_en"]["description"])
        # Prior v3/v4/researched-v4/v5 caches remoat on policy mismatch (no --force),
        # including short batch-1 grounded-v4 / researched-v5.
        prior = {"evidenceHash": "same", "existing": {
            "evidenceHash": "same", "assessmentPolicy": "grounded-business-judgment-v3",
            "report": self.report()}}
        self.assertTrue(needs_refresh(prior))
        for stale in ("researched-business-judgment-v4", "grounded-business-judgment-v4",
                      "researched-business-judgment-v5"):
            prior["existing"]["assessmentPolicy"] = stale
            self.assertTrue(needs_refresh(prior), stale)

    def test_comment_length_floor_rejects_short_batch1_style_prose(self):
        report = self.report()
        short = " ".join(["word"] * 90)
        report["m1_brand_pricing"]["comment_en"] = short
        with self.assertRaises(MoatReportValidationError) as raised:
            validate_comment_lengths(report)
        self.assertIn("too short", str(raised.exception))
        report["m1_brand_pricing"]["comment_en"] = " ".join(["word"] * MIN_COMMENT_EN_WORDS)
        report["m1_brand_pricing"]["comment_zh"] = "字" * 120
        for name in DIMENSIONS:
            if name == "m1_brand_pricing":
                continue
            report[name]["comment_en"] = " ".join(["word"] * MIN_COMMENT_EN_WORDS)
            report[name]["comment_zh"] = "字" * 120
        validate_comment_lengths(report)

    def test_limit_caps_remoats_without_force(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "inputs.json", Path(directory) / "reports.json"
            records = []
            for ticker in ("0005.HK", "0700.HK", "0941.HK"):
                records.append({
                    "ticker": ticker, "evidenceHash": "new",
                    "moatScreen": {"calculationCurrency": "HKD", "marketCapMillions": 5000},
                    "existing": {"evidenceHash": "old", "assessmentPolicy": "grounded-business-judgment-v3",
                                 "report": {"score": 7}},
                    "profile": {}, "fScore": {},
                    "statements": {"annual": {"income": [], "balance": [], "cashflow": []},
                                   "quarterly": {"income": [], "balance": [], "cashflow": []}},
                })
            source.write_text(json.dumps(records), encoding="utf-8")
            with patch.object(sys, "argv", ["refresh_hkex_moat.py", str(source), str(output), "--limit", "1"]), \
                    patch("scripts.refresh_hkex_moat.create_client", return_value=None):
                with self.assertRaises(SystemExit) as raised:
                    main()
            self.assertEqual(raised.exception.code, 1)  # pending + no credentials
            saved = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(set(saved), {"0005.HK", "0700.HK", "0941.HK"})

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

    def test_narrative_correction_changes_only_rejected_prose_and_preserves_scores_and_citations(self):
        report = self.report()
        report["m1_brand_pricing"]["comment_en"] = "Its 5G products face competition."
        report["m3_high_switching_costs"]["score"] = None
        report["overall_moat_verdict_en"] = "The B2B platform has limited protection."
        before = json.loads(json.dumps(report))
        rewrite = Mock(return_value={
            "m1_brand_pricing.comment_en": "Its next-generation products face competition.",
            "overall_moat_verdict_en": "The business-facing platform has limited protection.",
        })
        corrected = repair_narratives(report, rewrite)
        rewrite.assert_called_once_with({
            "m1_brand_pricing.comment_en": before["m1_brand_pricing"]["comment_en"],
            "overall_moat_verdict_en": before["overall_moat_verdict_en"],
        })
        self.assertEqual(report, before)
        for name in DIMENSIONS:
            self.assertEqual(corrected[name]["score"], before[name]["score"])
            self.assertEqual(corrected[name]["sources"], before[name]["sources"])
            self.assertEqual(corrected[name]["comment_zh"], before[name]["comment_zh"])
        self.assertEqual(validate_report(corrected, "0700.HK", ["profile"]), corrected)

    def test_narrative_correction_does_not_call_model_for_valid_reports(self):
        rewrite = Mock()
        report = self.report()
        self.assertIs(repair_narratives(report, rewrite), report)
        rewrite.assert_not_called()

    def test_narrative_correction_rejects_missing_extra_or_invalid_fields(self):
        report = self.report()
        report["m1_brand_pricing"]["comment_en"] = "A 5G network."
        field = "m1_brand_pricing.comment_en"
        for replacement in [None, {}, {field: "Qualitative.", "score": 10},
                            {field: ""}, {field: True}, {field: "A 6G network."},
                            {field: "Cash flow of HKD billion."}]:
            with self.subTest(replacement=replacement), self.assertRaises(MoatReportValidationError):
                repair_narratives(report, Mock(return_value=replacement))
        self.assertEqual(report[field.split(".")[0]]["comment_en"], "A 5G network.")

    def test_narrative_correction_does_not_bypass_score_or_citation_validation(self):
        for key, value in [("score", 11), ("sources", ["invented-evidence"])]:
            report = self.report()
            report["m1_brand_pricing"][key] = value
            report["m1_brand_pricing"]["comment_en"] = "A 5G network."
            corrected = repair_narratives(report, Mock(return_value={
                "m1_brand_pricing.comment_en": "A next-generation network.",
            }))
            with self.assertRaises(MoatReportValidationError):
                validate_report(corrected, "0700.HK", ["profile"])


if __name__ == "__main__":
    unittest.main()

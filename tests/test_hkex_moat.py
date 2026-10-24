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
    needs_refresh, validate_report, validation_feedback, evidence_context, write_json_checkpoint, main,
    below_moat_market_cap,
    repair_narratives, report_schema, validate_comment_lengths,
    validate_narrative, magnitude_retry_guidance, digit_retry_guidance,
)
from scripts.buffett_moat_v3 import BUFFETT_MOAT_ASSESSMENT_POLICY, MIN_COMMENT_ZH_CHARS, MAX_COMMENT_ZH_CHARS

# Locked band sample (~120 字) used wherever validate_report runs.
_ZH120 = (
    "該公司憑藉品牌心智與產品生態形成可辨識的定價權，客戶轉換成本來自工作流程與資料黏著，"
    "規模攤銷固定研發與通路後具備成本優勢，管理層資本配置偏重股東回報與核心再投資，"
    "整體護城河屬穩固而非短暫行情，惟仍須留意技術更迭與監管變化對壁壘耐久度的侵蝕風險。"
)
_EN_TR = (
    "The company has recognizable pricing power from brand and product ecosystem; switching costs "
    "come from workflow and data stickiness; scale amortizes fixed R&D and distribution into a cost "
    "edge; capital allocation favors shareholder returns and core reinvestment; the moat is durable "
    "rather than cyclical, though technology and regulation can still erode it."
)
assert MIN_COMMENT_ZH_CHARS <= len(_ZH120) <= MAX_COMMENT_ZH_CHARS, len(_ZH120)


class MoatEvidenceTests(unittest.TestCase):
    def test_market_cap_screen_uses_hkd_millions_and_preserves_unknowns(self):
        record = {"ticker": "0004.HK", "evidenceHash": "unchanged",
                  "moatScreen": {"calculationCurrency": "HKD", "marketCapMillions": 4999.999}}
        self.assertTrue(below_moat_market_cap(record))
        self.assertFalse(needs_refresh(record, retry_incomplete=True, force=True))
        for amount in [5000, 5000.001, None, 0, -1, True, "999", float("nan"), float("inf")]:
            record["moatScreen"]["marketCapMillions"] = amount
            self.assertFalse(below_moat_market_cap(record), repr(amount))
        # Former HKD 1B floor no longer applies — 1B–5B names are excluded.
        for amount in [750, 999.999, 1000, 1000.001, 4999]:
            record["moatScreen"]["marketCapMillions"] = amount
            self.assertTrue(below_moat_market_cap(record), repr(amount))
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
        return {"ticker": "0700.HK", "overall_moat_verdict_zh": _ZH120, "overall_moat_verdict_en": _EN_TR,
                **{name: {"score": 7, "sources": ["profile"], "comment_zh": _ZH120, "comment_en": _EN_TR}
                   for name in DIMENSIONS}}

    def test_only_actual_evidence_changes_trigger_refresh(self):
        complete = self.report()
        self.assertTrue(needs_refresh({"evidenceHash": "new", "existing": None}))
        self.assertFalse(needs_refresh({"evidenceHash": "old", "existing": {
            "evidenceHash": "old", "assessmentPolicy": ASSESSMENT_POLICY, "report": complete}}))
        self.assertTrue(needs_refresh({"evidenceHash": "new", "existing": {
            "evidenceHash": "old", "assessmentPolicy": ASSESSMENT_POLICY, "report": complete}}))
        # Stub / missing M1–M10 scores count as incomplete even when evidence hash matches.
        self.assertTrue(needs_refresh({"evidenceHash": "old", "existing": {
            "evidenceHash": "old", "assessmentPolicy": ASSESSMENT_POLICY, "report": {"score": 7}}}))

    def test_policy_changes_and_explicit_partial_retry_trigger_reassessment(self):
        record = {"evidenceHash": "same", "existing": {"evidenceHash": "same", "report": self.report()}}
        self.assertTrue(needs_refresh(record))
        record["existing"]["assessmentPolicy"] = ASSESSMENT_POLICY
        self.assertFalse(needs_refresh(record))
        self.assertTrue(needs_refresh(record, force=True))
        # Comment-present + score-null is incomplete and remoats without requiring --retry-incomplete.
        record["existing"]["report"]["m2_patents_regulatory"]["score"] = None
        self.assertTrue(needs_refresh(record))
        self.assertTrue(needs_refresh(record, retry_incomplete=True))

    def test_assessment_policy_is_unified_buffett_v3_zh_primary(self):
        self.assertEqual(ASSESSMENT_POLICY, BUFFETT_MOAT_ASSESSMENT_POLICY)
        self.assertEqual(RESEARCH_ASSESSMENT_POLICY, BUFFETT_MOAT_ASSESSMENT_POLICY)
        self.assertEqual(ASSESSMENT_POLICY, "buffett-moat-v3")
        schema = report_schema("0700.HK", ["profile"])
        dimension = schema.model_json_schema()["$defs"]["Dimension"]
        self.assertIn("100", dimension["properties"]["comment_zh"]["description"])
        self.assertIn("300", dimension["properties"]["comment_zh"]["description"])
        self.assertIn("translation", dimension["properties"]["comment_en"]["description"].lower())
        # Prior grounded/researched caches must remoat on policy mismatch (no --force).
        prior = {"evidenceHash": "same", "existing": {
            "evidenceHash": "same", "assessmentPolicy": "grounded-business-judgment-v5",
            "report": self.report()}}
        self.assertTrue(needs_refresh(prior))
        prior["existing"]["assessmentPolicy"] = "researched-business-judgment-v6"
        self.assertTrue(needs_refresh(prior))
        prior["existing"]["assessmentPolicy"] = "us-buffett-moat-v3"
        self.assertTrue(needs_refresh(prior))

    def test_zh_comment_length_band_is_enforced(self):
        report = self.report()
        validate_comment_lengths(report)
        report["m1_brand_pricing"]["comment_zh"] = "短評不足一百字。" * 2
        with self.assertRaises(MoatReportValidationError):
            validate_comment_lengths(report)
        report["m1_brand_pricing"]["comment_zh"] = _ZH120 + ("再加一段灌水文字用於超過三百字上限的拒絕測試。" * 12)
        self.assertGreater(len(report["m1_brand_pricing"]["comment_zh"]), MAX_COMMENT_ZH_CHARS)
        with self.assertRaises(MoatReportValidationError):
            validate_comment_lengths(report)

    def test_near_floor_zh_length_retry_asks_to_expand_by_a_few_characters(self):
        report = self.report()
        report["m7_operational_efficiency"]["comment_zh"] = "甲" * 98
        with self.assertRaises(MoatReportValidationError) as rejected:
            validate_comment_lengths(report)
        self.assertIn("NEAR-FLOOR", str(rejected.exception))
        self.assertIn("EXPAND BY A FEW CHARACTERS", str(rejected.exception))
        feedback = validation_feedback(rejected.exception)
        self.assertIn("EXPAND BY A FEW CHARACTERS", feedback)
        self.assertIn("LENGTH RETRY", feedback)
        # Length-focused retry should not bury the model in the long digit/currency paragraph.
        self.assertNotIn("numbered industry tiers", feedback)

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
                     "\u5b58\u6b3e\u9054100\u842c\u5104\u6e2f\u5143",  # 存款達100萬億港元
                     "\u4eba\u6c11\u5e63100",  # 人民幣100
                     "$1"]:
            report = self.report()
            report["m1_brand_pricing"]["comment_en"] = text
            with self.assertRaises(ValueError):
                validate_report(report, "0700.HK", ["profile"])
            report = self.report()
            report["overall_moat_verdict_en"] = text
            with self.assertRaises(ValueError):
                validate_report(report, "0700.HK", ["profile"])

    def test_bare_currency_names_allowed_without_digits(self):
        # Bank-style qualitative currency mentions (batch-1 1398/3988 failure mode).
        for text in (
            "以人民幣計價的存款與貸款業務強化客戶黏著。",
            "The franchise clears mainly in HKD and USD without quoting amounts.",
            "結算以港元為主，偶爾涉及美元與人民幣資金池。",
            "Reporting currency is CNY; calculation currency is HKD.",
            "存款達萬億港元規模，護城河來自網路與牌照壁壘。",  # bare 港元 + Chinese magnitude words, no digits
        ):
            validate_narrative(text)
        # Digit-bearing monetary claims stay rejected.
        for text in ("人民幣100", "港元1.8", "HKD 1.8", "USD 100", "CNY50", "$1", "RMB 20"):
            with self.assertRaises(MoatReportValidationError) as rejected:
                validate_narrative(text)
            self.assertIn("prohibited token:", str(rejected.exception))
            token = str(rejected.exception).split("prohibited token:", 1)[1].strip()
            self.assertTrue(token[0].isdigit() or token.startswith("$"), token)

    def test_bare_english_magnitude_words_remain_hard_banned(self):
        for word in ("million", "billion", "trillion", "Billion"):
            text = f"The issuer has {word} of subscribers at vast scale."
            with self.assertRaises(MoatReportValidationError) as rejected:
                validate_narrative(text)
            self.assertIn("prohibited token:", str(rejected.exception))
            self.assertTrue(
                any(mag in str(rejected.exception).lower() for mag in ("million", "billion", "trillion"))
            )
        # Qualitative scale language without banned tokens must pass.
        validate_narrative("The issuer has a vast subscriber base and large-scale network reach.")
        validate_narrative("電訊商具備龐大規模與大型客戶基礎，護城河來自網路效應而非短期行情。")

    def test_magnitude_retry_feedback_quotes_token_and_asks_for_qualitative_scale(self):
        err = MoatReportValidationError(
            "m5_cost_advantage_scale.comment_en: Moat narrative must not invent numerical or "
            "currency claims (prohibited token: billion)"
        )
        feedback = validation_feedback(err)
        self.assertIn("prohibited token: billion", feedback)
        self.assertIn("MAGNITUDE RETRY", feedback)
        self.assertIn("qualitative scale language", feedback)
        self.assertIn("億/萬/千", feedback)
        self.assertIn(magnitude_retry_guidance(str(err)), feedback)
        # Digits take the digit-retry path (not magnitude-first).
        report = self.report()
        report["m1_brand_pricing"]["comment_en"] = "A leading 5G network"
        with self.assertRaises(MoatReportValidationError) as rejected:
            validate_report(report, "0700.HK", ["profile"])
        digit_feedback = validation_feedback(rejected.exception)
        self.assertNotIn("MAGNITUDE RETRY", digit_feedback)
        self.assertIn("DIGIT RETRY", digit_feedback)
        self.assertIn(digit_retry_guidance(str(rejected.exception)), digit_feedback)

    def test_invalid_report_retries_receive_safe_actionable_feedback_without_weakening_validation(self):
        report = self.report()
        report["m1_brand_pricing"]["comment_en"] = "A leading 5G network"
        with self.assertRaises(MoatReportValidationError) as rejected:
            validate_report(report, "0700.HK", ["profile"])
        feedback = validation_feedback(rejected.exception)
        self.assertIn("numerical or currency claims", feedback)
        self.assertIn("DIGIT RETRY", feedback)
        self.assertIn("Paraphrase WITHOUT any numerals", feedback)
        self.assertIn("core capital", feedback)
        self.assertIn("m1_brand_pricing.comment_en", feedback)
        self.assertIn("prohibited token: 5", feedback)
        self.assertIn("人民幣", feedback)  # bare currency still allowed guidance
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

    def test_partial_success_does_not_block_persist_exit(self):
        """When some remoats succeed and others fail, exit 0 so Persist can commit winners."""
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "inputs.json", Path(directory) / "reports.json"

            def make_record(ticker):
                report = self.report()
                report["ticker"] = ticker
                return {
                    "ticker": ticker, "evidenceHash": "new",
                    "moatScreen": {"calculationCurrency": "HKD", "marketCapMillions": 5000},
                    "existing": {"evidenceHash": "old", "assessmentPolicy": "grounded-business-judgment-v3",
                                 "report": report},
                    "profile": {"companyName": ticker}, "fScore": {},
                    "statements": {
                        "annual": {"income": [{"date": "2025-12-31", "fiscalYear": "2025", "period": "FY"}],
                                   "balance": [], "cashflow": []},
                        "quarterly": {"income": [], "balance": [], "cashflow": []},
                    },
                }

            source.write_text(json.dumps([make_record("0005.HK"), make_record("0700.HK")]), encoding="utf-8")

            class _Resp:
                def __init__(self, text):
                    self.text = text

            ok_0005 = self.report()
            ok_0005["ticker"] = "0005.HK"
            client = Mock()
            # 0005 succeeds on first try; 0700 fails all 3 attempts (invalid JSON)
            client.models.generate_content.side_effect = [
                _Resp(json.dumps(ok_0005)),
                _Resp("{"), _Resp("{"), _Resp("{"),
            ]
            with patch.object(sys, "argv", ["refresh_hkex_moat.py", str(source), str(output)]), \
                    patch("scripts.refresh_hkex_moat.create_client", return_value=client), \
                    patch.dict(os.environ, {"MOAT_MODEL": "gemini-2.5-flash-lite"}):
                # Should not raise — partial success returns normally for Persist.
                main()
            saved = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(saved["0005.HK"]["assessmentPolicy"], BUFFETT_MOAT_ASSESSMENT_POLICY)
            self.assertIn("lastError", saved["0700.HK"])


if __name__ == "__main__":
    unittest.main()

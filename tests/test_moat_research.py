import copy
import hashlib
import json
import sys
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from scripts.refresh_hkex_moat import (
    RESEARCH_ASSESSMENT_POLICY, business_research, needs_refresh, validate_business_research,
    report_schema,
)
from scripts.research_hkex_moat import research_result, main, needs_research, research_prompt


def response():
    sources = [
        SimpleNamespace(web=SimpleNamespace(uri="https://issuer.example/annual", title="Annual report")),
        SimpleNamespace(web=SimpleNamespace(uri="https://regulator.example/filing", title="Filing")),
    ]
    support = SimpleNamespace(model_dump=lambda **kwargs: {
        "segment": {"text": "0700.HK issuer business"}, "grounding_chunk_indices": [0, 1],
    })
    return SimpleNamespace(text="0700.HK issuer business", candidates=[SimpleNamespace(
        grounding_metadata=SimpleNamespace(grounding_chunks=sources, grounding_supports=[support],
            search_entry_point=SimpleNamespace(rendered_content="<div>Google Search Suggestions</div>"),
            web_search_queries=["Issuer annual report"]))])


class BusinessResearchTests(unittest.TestCase):
    def partial_record(self):
        return {"ticker": "0700.HK", "profile": {"companyName": "Issuer"}, "fScore": {},
                "statements": {"annual": {"income": [{"date": "2025-12-31", "netIncome": -100}],
                                         "balance": [], "cashflow": []},
                               "quarterly": {"income": [], "balance": [], "cashflow": []}},
                "existing": {"report": {"m7_operational_efficiency": {
                    "score": None, "comment_en": "Volatile earnings; cannot assess.",
                    "comment_zh": "Financial history allegedly unavailable."}},
                    "businessResearch": research_result({"ticker": "0700.HK"}, response(), "test-model")}}

    def test_partial_retry_seeks_new_evidence_but_default_still_reuses_cached_research(self):
        record = self.partial_record()
        self.assertFalse(needs_research(record))
        self.assertTrue(needs_research(record, retry_incomplete=True))
        record["existing"]["report"]["m7_operational_efficiency"]["score"] = 0
        self.assertFalse(needs_research(record, retry_incomplete=True))
        record["existing"]["report"]["m7_operational_efficiency"]["score"] = None
        record["moatScreen"] = {"calculationCurrency": "HKD", "marketCapMillions": 999}
        self.assertFalse(needs_research(record, retry_incomplete=True))

    def test_gap_research_uses_actual_financial_evidence_and_explains_the_missing_criterion(self):
        prompt = research_prompt(self.partial_record())
        self.assertIn("m7_operational_efficiency", prompt)
        self.assertIn('"netIncome": -100', prompt)
        self.assertIn("unassessedDimensions", prompt)
        self.assertIn("NOT proof", prompt)
        self.assertIn("Losses or volatile cash returns", prompt)
        self.assertIn("not forecasts", prompt)
        self.assertIn("untrusted source data", prompt)
        self.assertIn("acquittals", prompt)
        self.assertIn("subsidiaries", prompt)

    def test_partial_retry_replaces_cached_research_without_duplicate_records(self):
        record = self.partial_record()
        fresh = response()
        fresh.text += " New attributable capital-allocation evidence."
        client = Mock()
        client.models.generate_content.return_value = fresh
        types = SimpleNamespace(GenerateContentConfig=Mock(), Tool=Mock(), GoogleSearch=Mock())
        modules = {"google.genai": SimpleNamespace(types=types, errors=SimpleNamespace(APIError=RuntimeError)),
                   "google.auth.exceptions": SimpleNamespace(GoogleAuthError=RuntimeError),
                   "httpx": SimpleNamespace(HTTPError=RuntimeError)}
        with tempfile.TemporaryDirectory() as directory:
            source, output, cache = [Path(directory) / name for name in ("input.json", "ready.json", "research.json")]
            source.write_text(json.dumps([record]), encoding="utf-8")
            with patch.dict(sys.modules, modules), patch.object(sys, "argv", [
                    "research_hkex_moat.py", str(source), str(output), str(cache), "--retry-incomplete"]), \
                    patch("scripts.research_hkex_moat.create_client", return_value=client):
                main()
            ready = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(len(ready), 1)
            self.assertEqual(ready[0]["businessResearch"]["summary"], fresh.text)
            self.assertEqual(ready[0]["existing"], record["existing"])
            self.assertNotEqual(ready[0]["businessResearch"]["evidenceHash"],
                                record["existing"]["businessResearch"]["evidenceHash"])
            self.assertEqual(json.loads(cache.read_text(encoding="utf-8"))["failures"], {})
        client.models.generate_content.assert_called_once()

    def test_failed_partial_research_retains_last_good_evidence_and_reports_failure(self):
        record = self.partial_record()
        client = Mock()
        client.models.generate_content.side_effect = RuntimeError("external request failed")
        types = SimpleNamespace(GenerateContentConfig=Mock(), Tool=Mock(), GoogleSearch=Mock())
        modules = {"google.genai": SimpleNamespace(types=types, errors=SimpleNamespace(APIError=RuntimeError)),
                   "google.auth.exceptions": SimpleNamespace(GoogleAuthError=RuntimeError),
                   "httpx": SimpleNamespace(HTTPError=RuntimeError)}
        with tempfile.TemporaryDirectory() as directory:
            source, output, cache = [Path(directory) / name for name in ("input.json", "ready.json", "research.json")]
            source.write_text(json.dumps([record]), encoding="utf-8")
            with patch.dict(sys.modules, modules), patch.object(sys, "argv", [
                    "research_hkex_moat.py", str(source), str(output), str(cache), "--retry-incomplete"]), \
                    patch("scripts.research_hkex_moat.create_client", return_value=client), \
                    patch("scripts.research_hkex_moat.time.sleep"), self.assertRaises(SystemExit):
                main()
            ready = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(len(ready), 1)
            self.assertEqual(ready[0]["businessResearch"], record["existing"]["businessResearch"])
            self.assertIn("0700.HK", json.loads(cache.read_text(encoding="utf-8"))["failures"])
        self.assertEqual(client.models.generate_content.call_count, 3)

    def test_below_one_billion_skips_paid_research_and_preserves_existing_evidence(self):
        record = {"ticker": "0004.HK", "existing": {"report": {"archived": True}},
                  "moatScreen": {"calculationCurrency": "HKD", "marketCapMillions": 750}}
        modules = {"google.genai": SimpleNamespace(types=SimpleNamespace(), errors=SimpleNamespace()),
                   "google.auth.exceptions": SimpleNamespace(GoogleAuthError=RuntimeError),
                   "httpx": SimpleNamespace(HTTPError=RuntimeError)}
        with tempfile.TemporaryDirectory() as directory:
            source, output, cache = [Path(directory) / name for name in ("input.json", "ready.json", "research.json")]
            source.write_text(json.dumps([record]), encoding="utf-8")
            with patch.dict(sys.modules, modules), patch.object(sys, "argv", [
                    "research_hkex_moat.py", str(source), str(output), str(cache)]), \
                    patch("scripts.research_hkex_moat.create_client") as client:
                main()
            client.assert_not_called()
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), [record])
            self.assertEqual(json.loads(cache.read_text(encoding="utf-8")), {"research": {}, "failures": {}})

    def test_interrupted_new_research_preserves_all_cached_companies_even_later_in_the_input(self):
        research = research_result({"ticker": "0700.HK"}, response(), "test-model")
        client = Mock()
        client.models.generate_content.side_effect = KeyboardInterrupt
        types = SimpleNamespace(GenerateContentConfig=Mock(), Tool=Mock(), GoogleSearch=Mock(), ThinkingConfig=Mock())
        modules = {"google.genai": SimpleNamespace(types=types, errors=SimpleNamespace(APIError=RuntimeError)),
                   "google.auth.exceptions": SimpleNamespace(GoogleAuthError=RuntimeError),
                   "httpx": SimpleNamespace(HTTPError=RuntimeError)}
        with tempfile.TemporaryDirectory() as directory:
            source, output, cache = [Path(directory) / name for name in ("input.json", "ready.json", "research.json")]
            source.write_text(json.dumps([
                {"ticker": "0004.HK", "profile": {"companyName": "Issuer"}},
                {"ticker": "0700.HK", "businessResearch": research}
            ]), encoding="utf-8")
            with patch.dict(sys.modules, modules), patch.object(sys, "argv", [
                    "research_hkex_moat.py", str(source), str(output), str(cache)]), \
                 patch("scripts.research_hkex_moat.create_client", return_value=client):
                with self.assertRaises(KeyboardInterrupt):
                    main()
            self.assertEqual(json.loads(cache.read_text(encoding="utf-8"))["research"]["0700.HK"], research)
            self.assertEqual([record["ticker"] for record in json.loads(output.read_text(encoding="utf-8"))], ["0700.HK"])

    def test_response_schema_constrains_each_citation_to_actual_supplied_ids(self):
        schema = report_schema("0700.HK", ["profile", "web:1"])
        dimension = schema.model_json_schema()["$defs"]["Dimension"]
        self.assertEqual(dimension["properties"]["sources"]["items"]["enum"], ["profile", "web:1"])
        self.assertEqual(schema.model_json_schema()["properties"]["ticker"]["const"], "0700.HK")

    def test_grounded_response_preserves_sources_support_and_unmodified_suggestions(self):
        result = research_result({"ticker": "0700.HK"}, response(), "test-model")
        self.assertEqual([item["id"] for item in result["sources"]], ["web:1", "web:2"])
        self.assertEqual(result["searchEntryPointHtml"], "<div>Google Search Suggestions</div>")
        self.assertEqual(result["groundingSupports"][0]["grounding_chunk_indices"], [0, 1])
        self.assertIs(validate_business_research(result, "0700.HK"), result)

    def test_other_issuers_missing_grounding_and_bad_source_urls_are_rejected(self):
        for change in [
            lambda r: setattr(r, "text", "Other issuer"),
            lambda r: setattr(r.candidates[0], "grounding_metadata", None),
            lambda r: setattr(r.candidates[0].grounding_metadata.grounding_chunks[0].web, "uri", "javascript:alert(1)"),
            lambda r: setattr(r.candidates[0].grounding_metadata, "grounding_supports", []),
            lambda r: setattr(r.candidates[0].grounding_metadata, "web_search_queries", []),
        ]:
            r = response()
            change(r)
            with self.assertRaises(ValueError):
                research_result({"ticker": "0700.HK"}, r, "test-model")

    def test_tampered_research_and_nonexistent_citations_are_rejected(self):
        baseline = research_result({"ticker": "0700.HK"}, response(), "test-model")
        for mutate in [
            lambda r: r.update(ticker="9988.HK"),
            lambda r: r.update(summary="0700.HK changed summary"),
            lambda r: r["sources"][0].update(id="profile"),
            lambda r: r["groundingSupports"][0].update(grounding_chunk_indices=[2]),
            lambda r: r["groundingSupports"][0].update(grounding_chunk_indices=[True]),
            lambda r: r.update(searchEntryPointHtml=""),
            lambda r: r.update(researchedAt="invalid"),
        ]:
            research = copy.deepcopy(baseline)
            mutate(research)
            with self.assertRaises(ValueError):
                validate_business_research(research, "0700.HK")

    def test_researched_assessments_reuse_saved_evidence_without_another_model_call(self):
        research = research_result({"ticker": "0700.HK"}, response(), "test-model")
        record = {"ticker": "0700.HK", "evidenceHash": "financials",
                  "existing": {"businessResearch": research, "evidenceHash": "financials",
                               "assessmentPolicy": RESEARCH_ASSESSMENT_POLICY, "report": {"score": 7}}}
        self.assertEqual(business_research(record), research)
        self.assertFalse(needs_refresh(record))
        changed = copy.deepcopy(research)
        changed["summary"] += " New attributable evidence."
        changed["evidenceHash"] = hashlib.sha256(json.dumps({
            "summary": changed["summary"], "sources": changed["sources"]}, sort_keys=True).encode()).hexdigest()
        record["businessResearch"] = changed
        self.assertTrue(needs_refresh(record), "Changed business evidence must invalidate the cached assessment")
        del record["businessResearch"]
        record["evidenceHash"] = "changed"
        self.assertTrue(needs_refresh(record))


if __name__ == "__main__":
    unittest.main()

"""Unit tests for US Gemini remoat budget (#2) and evidence-hash reuse (#1)."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_full_market as market


class UsMoatBudgetTests(unittest.TestCase):
    def test_daily_defaults_and_unlimited_tokens(self):
        with patch.object(market, "US_EXPANSION_MODE", False), \
                patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MAX_US_MOAT_GEMINI", None)
            os.environ.pop("MAX_US_DESC_GEMINI", None)
            self.assertEqual(market.us_moat_gemini_budget(), 30)
            self.assertEqual(market.us_desc_gemini_budget(), 15)
            os.environ["MAX_US_MOAT_GEMINI"] = "unlimited"
            self.assertIsNone(market.us_moat_gemini_budget())
            os.environ["MAX_US_MOAT_GEMINI"] = "12"
            self.assertEqual(market.us_moat_gemini_budget(), 12)

    def test_expansion_defaults_uncapped(self):
        with patch.object(market, "US_EXPANSION_MODE", True), \
                patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MAX_US_MOAT_GEMINI", None)
            os.environ.pop("MAX_US_DESC_GEMINI", None)
            self.assertIsNone(market.us_moat_gemini_budget())
            self.assertIsNone(market.us_desc_gemini_budget())

    def test_prior_period_moat_prefers_newest_valid(self):
        prior = market.load_prior_period_moat("AAPL", "2099Q4")
        self.assertIsNotNone(prior)
        self.assertEqual(prior.get("ticker"), "AAPL")
        self.assertTrue(market._moat_cache_is_valid(prior))


class UsMoatEvidenceHashTests(unittest.TestCase):
    def test_hash_stable_and_ignores_mcap(self):
        base = {
            "name": "Apple", "sector": "Tech", "industry": "Hardware",
            "roe": 100.12, "roa": 30.45, "f_score": 8,
            "fcf0": 1000.4, "debt": 50.2, "cash": 60.6, "mcap": 1.0,
        }
        other_mcap = dict(base, mcap=999999.0)
        self.assertEqual(market.us_moat_evidence_hash(base), market.us_moat_evidence_hash(other_mcap))
        changed = dict(base, f_score=7)
        self.assertNotEqual(market.us_moat_evidence_hash(base), market.us_moat_evidence_hash(changed))

    def test_evidence_hash_hit_reuses_across_periods_without_gemini(self):
        fin = {
            "name": "TestCo", "sector": "X", "industry": "Y",
            "roe": 10.0, "roa": 5.0, "f_score": 6,
            "fcf0": 100.0, "debt": 10.0, "cash": 20.0, "mcap": 1.0,
        }
        evidence_hash = market.us_moat_evidence_hash(fin)
        dim = {"score": 7, "comment_zh": "測試評語足夠長度的護城河說明文字", "comment_en": "Test moat comment"}
        prior = {
            "ticker": "ZZZZ",
            "period": "2025Q1",
            "evidenceHash": evidence_hash,
            "assessmentPolicy": market.US_MOAT_ASSESSMENT_POLICY,
            "m1_brand_pricing": dim,
            "overall_moat_verdict_zh": "總結定性足夠長度的護城河說明",
            "overall_moat_verdict_en": "Verdict",
        }
        for key in (
            "m2_patents_regulatory", "m3_high_switching_costs", "m4_network_effects",
            "m5_cost_advantage_scale", "m6_unique_geography_assets", "m7_operational_efficiency",
            "m8_capital_allocation", "m9_customer_retention", "m10_durability",
        ):
            prior[key] = dim

        with tempfile.TemporaryDirectory() as directory:
            with patch.object(market, "CACHE_DIR", directory), \
                    patch.object(market, "gemini_client", object()):
                Path(directory, "ZZZZ_2025Q1.json").write_text(
                    json.dumps(prior), encoding="utf-8"
                )
                result = market.analyze_stock_moat("ZZZZ", "2026Q3", fin, force_refresh=False)
                self.assertEqual(result["period"], "2026Q3")
                self.assertEqual(result["evidenceHash"], evidence_hash)
                self.assertEqual(result["m1_brand_pricing"]["score"], 7)
                self.assertTrue(Path(directory, "ZZZZ_2026Q3.json").exists())
                self.assertEqual(market._moat_gemini_used, 0)


if __name__ == "__main__":
    unittest.main()

"""Unit tests for remoat backlog counting (HK core + expansion)."""

from __future__ import annotations

import unittest

from scripts.remoat_remaining import (
    _hk_expansion_incomplete,
    _hk_expansion_mcap_bucket,
    _hk_good,
    hk_expansion_remaining,
)


class HkExpansionEligibilityTests(unittest.TestCase):
    def test_null_mcap_is_not_below_cap(self):
        stock = {"ticker": "1392.HK", "calculationCurrency": "HKD", "mcap": None}
        self.assertEqual(_hk_expansion_mcap_bucket("1392.HK", stock), "null")

    def test_known_sub_5b_is_below(self):
        stock = {"ticker": "1911.HK", "calculationCurrency": "HKD", "mcap": 1500}
        self.assertEqual(_hk_expansion_mcap_bucket("1911.HK", stock), "below")

    def test_ge_5b_bucket(self):
        stock = {"ticker": "0901.HK", "calculationCurrency": "HKD", "mcap": 130502}
        self.assertEqual(_hk_expansion_mcap_bucket("0901.HK", stock), "ge")

    def test_incomplete_detects_null_score_and_missing_moat(self):
        self.assertTrue(_hk_expansion_incomplete({}))
        partial = {
            "moat": {
                "m1_brand_pricing": {"score": 5, "comment_zh": "x", "comment_en": "y"},
                "m2_patents_regulatory": {"score": None, "comment_zh": "有說明", "comment_en": "note"},
            }
        }
        self.assertTrue(_hk_expansion_incomplete(partial))

    def test_listed_partial_tickers_are_in_expansion_remaining(self):
        """Systemic rule must cover the product-listed 12 even when mcap is null."""
        target = {
            "0901.HK", "1333.HK", "1392.HK", "1956.HK", "2585.HK", "3228.HK",
            "3752.HK", "6915.HK", "8567.HK", "8582.HK", "8583.HK", "8585.HK",
        }
        result = hk_expansion_remaining()
        need = set(result["need_tickers"])
        missing = sorted(target - need)
        self.assertEqual(missing, [], f"expected target tickers in expansion remaining, missing={missing}")
        self.assertGreaterEqual(result["remaining"], 12)
        # Null-mcap names from the list must not be dropped by the ≥5B gate.
        for ticker in ("1392.HK", "6915.HK", "8567.HK", "8582.HK", "8583.HK", "8585.HK"):
            self.assertIn(ticker, result["need_null_mcap"])

    def test_already_good_buffett_v3_is_skipped(self):
        zh = "甲" * 120
        report = {
            f"m{i}_{name}": {"score": 6, "comment_zh": zh, "comment_en": "translation"}
            for i, name in enumerate(
                (
                    "brand_pricing", "patents_regulatory", "high_switching_costs",
                    "network_effects", "cost_advantage_scale", "unique_geography_assets",
                    "operational_efficiency", "capital_allocation", "customer_retention",
                    "durability",
                ),
                start=1,
            )
        }
        entry = {
            "assessmentPolicy": "buffett-moat-v3",
            "model": "gemini-2.5-flash-lite",
            "report": report,
        }
        self.assertTrue(_hk_good(entry))


if __name__ == "__main__":
    unittest.main()

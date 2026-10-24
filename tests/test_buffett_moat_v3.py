"""Unit tests for unified Buffett-v3 ZH length gate."""

import unittest

from scripts.buffett_moat_v3 import (
    BUFFETT_MOAT_ASSESSMENT_POLICY,
    BUFFETT_MOAT_MODEL,
    LEGACY_US_BUFFETT_MOAT_POLICY,
    MAX_COMMENT_ZH_CHARS,
    MIN_COMMENT_ZH_CHARS,
    NEAR_FLOOR_ZH_CHARS,
    dimension_zh_counts,
    policy_compatible_for_reuse,
    report_scores_complete,
    report_zh_pass,
    validate_dimension_zh_lengths,
    zh_char_count,
    zh_length_ok,
    zh_length_retry_guidance,
    zh_length_violation_message,
)


_ZH = (
    "該公司憑藉品牌心智與產品生態形成可辨識的定價權，客戶轉換成本來自工作流程與資料黏著，"
    "規模攤銷固定研發與通路後具備成本優勢，管理層資本配置偏重股東回報與核心再投資，"
    "整體護城河屬穩固而非短暫行情，惟仍須留意技術更迭與監管變化對壁壘耐久度的侵蝕風險。"
)


class BuffettMoatV3Tests(unittest.TestCase):
    def test_policy_and_model_defaults(self):
        self.assertEqual(BUFFETT_MOAT_ASSESSMENT_POLICY, "buffett-moat-v3")
        self.assertEqual(BUFFETT_MOAT_MODEL, "gemini-2.5-flash-lite")
        self.assertEqual(MIN_COMMENT_ZH_CHARS, 100)
        self.assertEqual(MAX_COMMENT_ZH_CHARS, 300)

    def test_zh_band(self):
        self.assertTrue(MIN_COMMENT_ZH_CHARS <= zh_char_count(_ZH) <= MAX_COMMENT_ZH_CHARS)
        self.assertTrue(zh_length_ok(_ZH))
        self.assertFalse(zh_length_ok("短"))
        self.assertFalse(zh_length_ok(_ZH + ("超長灌水。" * 40)))

    def test_validate_report_dims(self):
        report = {
            f"m{i}_{suffix}": {"score": 7, "comment_zh": _ZH, "comment_en": "Translation."}
            for i, suffix in enumerate(
                [
                    "1_brand_pricing", "2_patents_regulatory", "3_high_switching_costs",
                    "4_network_effects", "5_cost_advantage_scale", "6_unique_geography_assets",
                    "7_operational_efficiency", "8_capital_allocation", "9_customer_retention",
                    "10_durability",
                ],
                start=1,
            )
        }
        # Fix keys to exact DIMENSION_KEYS
        from scripts.buffett_moat_v3 import DIMENSION_KEYS
        report = {key: {"score": 7, "comment_zh": _ZH, "comment_en": "Translation of the Chinese moat comment."}
                  for key in DIMENSION_KEYS}
        validate_dimension_zh_lengths(report)
        self.assertTrue(report_zh_pass(report))
        self.assertTrue(report_scores_complete(report))
        counts = dimension_zh_counts(report)
        self.assertEqual(len(counts), 10)
        report["m1_brand_pricing"]["score"] = None
        self.assertTrue(report_zh_pass(report), "ZH can pass while a score is still null")
        self.assertFalse(report_scores_complete(report))
        report["m1_brand_pricing"]["score"] = 7
        report["m1_brand_pricing"]["comment_zh"] = "太短"
        with self.assertRaises(ValueError):
            validate_dimension_zh_lengths(report)

    def test_near_floor_length_message_asks_to_expand_by_a_few(self):
        self.assertEqual(NEAR_FLOOR_ZH_CHARS, 90)
        msg = zh_length_violation_message("m7_operational_efficiency", 98)
        self.assertIn("NEAR-FLOOR", msg)
        self.assertIn("EXPAND BY A FEW CHARACTERS", msg)
        self.assertIn("98", msg)
        guidance = zh_length_retry_guidance(msg)
        self.assertIn("near floor", guidance.lower())
        with self.assertRaises(ValueError) as raised:
            from scripts.buffett_moat_v3 import DIMENSION_KEYS
            report = {
                key: {"score": 7, "comment_zh": _ZH, "comment_en": "Translation of the Chinese moat comment."}
                for key in DIMENSION_KEYS
            }
            report["m7_operational_efficiency"]["comment_zh"] = "甲" * 98
            validate_dimension_zh_lengths(report)
        self.assertIn("NEAR-FLOOR", str(raised.exception))
        self.assertIn("EXPAND BY A FEW CHARACTERS", str(raised.exception))

    def test_legacy_us_policy_reuse_requires_zh_band(self):
        from scripts.buffett_moat_v3 import DIMENSION_KEYS
        report = {
            key: {"score": 7, "comment_zh": _ZH, "comment_en": "Translation of the Chinese moat comment."}
            for key in DIMENSION_KEYS
        }
        self.assertTrue(policy_compatible_for_reuse(LEGACY_US_BUFFETT_MOAT_POLICY, report))
        self.assertTrue(policy_compatible_for_reuse(BUFFETT_MOAT_ASSESSMENT_POLICY, report))
        self.assertFalse(policy_compatible_for_reuse("grounded-business-judgment-v5", report))
        short = dict(report)
        short["m1_brand_pricing"] = {"score": 7, "comment_zh": "太短", "comment_en": "short"}
        self.assertFalse(policy_compatible_for_reuse(LEGACY_US_BUFFETT_MOAT_POLICY, short))


if __name__ == "__main__":
    unittest.main()


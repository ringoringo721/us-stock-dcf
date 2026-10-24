"""Unit tests for unified Buffett-v3 ZH length gate."""

import unittest

from scripts.buffett_moat_v3 import (
    BUFFETT_MOAT_ASSESSMENT_POLICY,
    BUFFETT_MOAT_MODEL,
    MAX_COMMENT_ZH_CHARS,
    MIN_COMMENT_ZH_CHARS,
    dimension_zh_counts,
    report_zh_pass,
    validate_dimension_zh_lengths,
    zh_char_count,
    zh_length_ok,
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
        self.assertEqual(MAX_COMMENT_ZH_CHARS, 150)

    def test_zh_band(self):
        self.assertTrue(MIN_COMMENT_ZH_CHARS <= zh_char_count(_ZH) <= MAX_COMMENT_ZH_CHARS)
        self.assertTrue(zh_length_ok(_ZH))
        self.assertFalse(zh_length_ok("短"))
        self.assertFalse(zh_length_ok(_ZH + ("超長灌水。" * 20)))

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
        counts = dimension_zh_counts(report)
        self.assertEqual(len(counts), 10)
        report["m1_brand_pricing"]["comment_zh"] = "太短"
        with self.assertRaises(ValueError):
            validate_dimension_zh_lengths(report)


if __name__ == "__main__":
    unittest.main()

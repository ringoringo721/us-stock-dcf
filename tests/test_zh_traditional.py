"""Unit tests for Traditional Chinese (繁體) detection and OpenCC S→T convert-on-retry."""

import unittest

from scripts.zh_traditional import (
    convert_report_zh_to_traditional,
    has_simplified,
    simplified_chars,
    to_traditional,
)


_SIMP = "公司业务缺乏证据，无法评估网络效应与运营资产的护城河。"
_TRAD = "公司業務缺乏證據，無法評估網路效應與營運資產的護城河。"


class ZhTraditionalTests(unittest.TestCase):
    def test_detects_simplified_and_accepts_traditional(self):
        self.assertTrue(has_simplified(_SIMP))
        self.assertIn("业", simplified_chars(_SIMP))
        self.assertFalse(has_simplified(_TRAD))
        self.assertEqual(simplified_chars(_TRAD), [])

    def test_to_traditional_converts_common_finance_vocab(self):
        converted = to_traditional(_SIMP)
        self.assertFalse(has_simplified(converted))
        self.assertIn("業務", converted)
        self.assertIn("證據", converted)
        # OpenCC S2T uses 網絡 (still Traditional); HK 網路 is also Traditional — either OK.
        self.assertTrue("網絡" in converted or "網路" in converted)
        self.assertIn("運營", converted)  # 运营→運營 under OpenCC ST
        self.assertIn("資產", converted)
        self.assertIn("護城河", converted)

    def test_convert_report_zh_fields_only(self):
        report = {
            "description_zh": "业务描述不详。",
            "overall_moat_verdict_zh": "整体护城河极弱。",
            "overall_moat_verdict_en": "The overall moat is very weak.",
            "m1_brand_pricing": {
                "score": 0,
                "comment_zh": "缺乏品牌定价证据。",
                "comment_en": "No brand pricing evidence.",
            },
        }
        converted, fields = convert_report_zh_to_traditional(report)
        self.assertIn("description_zh", fields)
        self.assertIn("overall_moat_verdict_zh", fields)
        self.assertIn("m1_brand_pricing.comment_zh", fields)
        self.assertFalse(has_simplified(converted["description_zh"]))
        self.assertFalse(has_simplified(converted["overall_moat_verdict_zh"]))
        self.assertFalse(has_simplified(converted["m1_brand_pricing"]["comment_zh"]))
        # EN untouched; original report not mutated.
        self.assertEqual(converted["m1_brand_pricing"]["comment_en"], "No brand pricing evidence.")
        self.assertTrue(has_simplified(report["m1_brand_pricing"]["comment_zh"]))


if __name__ == "__main__":
    unittest.main()

"""Tests for best-effort US Traditional Chinese company-name catalogue."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.build_us_chinese_names import (
    build_catalogue,
    extract_name_from_description,
    hk_dual_list_names,
    resolve_alias,
)


class ExtractDescriptionNameTests(unittest.TestCase):
    def test_markdown_bold_leading_chinese(self):
        self.assertEqual(
            extract_name_from_description(
                "**伊頓公司 (Eaton Corporation plc, ETN) 業務營運精煉報告**\n\n伊頓公司為全球"
            ),
            "伊頓公司",
        )

    def test_skips_english_only_stub(self):
        self.assertIsNone(
            extract_name_from_description(
                "Interactive Brokers Group, Inc.（美股代碼：IBKR）為 Financial Services 領域之重要企業"
            )
        )

    def test_skips_english_markdown_title(self):
        self.assertIsNone(
            extract_name_from_description(
                "**Western Digital Corporation (WDC) 業務營運概述**\n\nWestern Digital"
            )
        )


class AliasAndDualListTests(unittest.TestCase):
    def test_berkshire_class_a_alias(self):
        curated = {"BRK.B": "波克夏海瑟威 (B)"}
        self.assertEqual(resolve_alias("BRK-A", curated), "波克夏海瑟威 (A)")
        self.assertEqual(resolve_alias("BRK.B", curated), "波克夏海瑟威 (B)")

    def test_hk_dual_list_exact_english_match(self):
        hk = {
            "stocks": [
                {"ticker": "9988.HK", "name_en": "Alibaba Group Holding Limited", "name_zh": "阿里巴巴－Ｗ"},
                {"ticker": "0700.HK", "name_en": "Tencent Holdings Limited", "name_zh": "騰訊控股"},
            ]
        }
        us = {
            "stocks": [
                {"ticker": "BABA", "name_en": "Alibaba Group Holding Limited"},
                {"ticker": "OTHER", "name_en": "Totally Unrelated Corp"},
            ]
        }
        self.assertEqual(hk_dual_list_names(hk, us), {"BABA": "阿里巴巴"})


class CataloguePriorityTests(unittest.TestCase):
    def test_curated_wins_over_description(self):
        curated = {"LMT": "洛克希德·馬丁"}
        catalogue = build_catalogue(
            curated,
            {},
            {"LMT": "洛克希德馬丁公司"},
            {"ETN": "伊頓公司"},
            ["LMT", "ETN", "IBKR"],
        )
        self.assertEqual(catalogue["names"]["LMT"]["source"], "STOCK_NAMES_ZH")
        self.assertEqual(catalogue["names"]["LMT"]["name_zh"], "洛克希德·馬丁")
        self.assertEqual(catalogue["names"]["ETN"]["name_zh"], "伊頓公司")
        self.assertNotIn("IBKR", catalogue["names"])
        self.assertEqual(catalogue["coverage"]["withNameZh"], 2)
        self.assertEqual(catalogue["coverage"]["universeTickers"], 3)


class ShippedCatalogueSmokeTests(unittest.TestCase):
    def test_generated_files_cover_etn_and_lmt(self):
        root = Path(__file__).resolve().parents[1]
        js_path = root / "us_chinese_names_data.js"
        json_path = root / "cache" / "us_chinese_names.json"
        self.assertTrue(js_path.exists(), "run scripts/build_us_chinese_names.py first")
        self.assertTrue(json_path.exists())
        catalogue = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertGreaterEqual(catalogue["coverage"]["pct"], 30.0)
        self.assertEqual(catalogue["names"]["LMT"]["name_zh"], "洛克希德·馬丁")
        self.assertEqual(catalogue["names"]["ETN"]["name_zh"], "伊頓公司")
        self.assertNotIn("IBKR", catalogue["names"])
        self.assertNotIn("WDC", catalogue["names"])
        text = js_path.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("window.US_CHINESE_NAMES = "))


if __name__ == "__main__":
    unittest.main()

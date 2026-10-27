"""Tests for best-effort US Traditional Chinese company-name catalogue."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from scripts.build_us_chinese_names import (
    build_catalogue,
    hk_dual_list_names,
    resolve_alias,
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
    def test_curated_and_hk_only_no_description_source(self):
        curated = {"LMT": "洛克希德·馬丁"}
        catalogue = build_catalogue(
            curated,
            {"BABA": "阿里巴巴"},
            ["LMT", "BABA", "ETN", "A", "VALE"],
        )
        self.assertEqual(catalogue["names"]["LMT"]["source"], "STOCK_NAMES_ZH")
        self.assertEqual(catalogue["names"]["BABA"]["name_zh"], "阿里巴巴")
        self.assertNotIn("ETN", catalogue["names"])
        self.assertNotIn("A", catalogue["names"])
        self.assertNotIn("VALE", catalogue["names"])
        self.assertEqual(catalogue["coverage"]["withNameZh"], 2)
        self.assertEqual(
            catalogue["policy"]["excludedSources"],
            ["description_zh_full_market", "description_zh_us_companies"],
        )


class ShippedCatalogueSmokeTests(unittest.TestCase):
    def test_generated_files_drop_unsafe_description_names(self):
        root = Path(__file__).resolve().parents[1]
        js_path = root / "us_chinese_names_data.js"
        json_path = root / "cache" / "us_chinese_names.json"
        self.assertTrue(js_path.exists(), "run scripts/build_us_chinese_names.py first")
        self.assertTrue(json_path.exists())
        catalogue = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertEqual(catalogue["names"]["LMT"]["name_zh"], "洛克希德·馬丁")
        self.assertEqual(catalogue["names"]["BABA"]["name_zh"], "阿里巴巴")
        # Bugbot false positives must not ship.
        for ticker in ("A", "VALE", "VOD", "PS", "PFG", "ETN", "SCHW"):
            self.assertNotIn(ticker, catalogue["names"])
        sources = {entry["source"] for entry in catalogue["names"].values()}
        self.assertTrue(sources <= {"STOCK_NAMES_ZH", "HKEX_dual_list"})
        text = js_path.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("window.US_CHINESE_NAMES = "))
        self.assertNotIn("惠普公司", text)
        self.assertNotIn("力拓公司", text)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""FF301 monthly-return parser must keep Domestic + H classes for PRC issuers."""

from __future__ import annotations

import unittest
from pathlib import Path

from pypdf import PdfReader

# Import parser without requiring network requests at import time.
import importlib.util
import sys
import types

sys.modules.setdefault("requests", types.ModuleType("requests"))
spec = importlib.util.spec_from_file_location(
    "capture_hkex_share_capital",
    Path(__file__).resolve().parents[1] / "scripts" / "capture_hkex_share_capital.py",
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class Ff301DomesticClassTest(unittest.TestCase):
    def test_3983_october_2026_h_and_domestic(self):
        pdf = Path("/tmp/3983-monthly.pdf")
        if not pdf.exists():
            self.skipTest("3983 monthly return PDF not cached at /tmp/3983-monthly.pdf")
        parsed = mod.parse_ff301(pdf.read_bytes())
        by_name = {row["name"]: row for row in parsed["classes"]}
        self.assertIn("H", by_name)
        self.assertIn("Domestic", by_name)
        self.assertEqual(by_name["H"]["issuedShares"], 1_796_000_122)
        self.assertEqual(by_name["Domestic"]["issuedShares"], 2_813_999_878)
        self.assertEqual(parsed["outstandingShares"], 4_610_000_000)

    def test_normalize_domestic_description_variants(self):
        self.assertEqual(mod.normalize_class_name("Domestic"), "Domestic")
        self.assertEqual(mod.normalize_class_name("Domestic shares"), "Domestic")
        self.assertEqual(mod.normalize_class_name("Domesticshares"), "Domestic")


if __name__ == "__main__":
    unittest.main()

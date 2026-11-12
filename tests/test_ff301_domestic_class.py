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

    def test_other_class_domestic_block_is_parsed(self):
        # Minimal FF301-like text with GEM-style "Other class" Domestic issued shares.
        text = """
For the month ended: 31 October 2026 Status: New Submission
Date Submitted: 02 November 2026
Name of Issuer: Test Issuer
Class of shares Ordinary shares Type of shares H Listed on the Exchange (Note 1) Yes
Stock code (if listed) 08329 Description
Number of issued shares
(excluding treasury shares) Number of treasury shares Total number of issued shares
Balance at close of the month 426,000,000 0 426,000,000
Class of shares Other class (specify in description) Type of shares Other type(specify in description) Listed on the Exchange (Note 1) No
Stock code (if listed) -- Description Domestic Shares
Number of issued shares
(excluding treasury shares) Number of treasury shares Total number of issued shares
Balance at close of the month 1,252,000,000 0 1,252,000,000
"""
        from pypdf import PdfWriter
        from io import BytesIO
        # parse_ff301 expects PDF bytes; feed a one-page PDF with the text via reportlab-less stub:
        # PdfReader needs real PDF — instead unit-test the split path through a helper by
        # writing a tiny PDF using pypdf blank page + this is awkward. Call parse on a
        # synthesized PDF if available; otherwise skip.
        try:
            writer = PdfWriter()
            writer.add_blank_page(width=612, height=792)
            buf = BytesIO()
            writer.write(buf)
        except Exception:
            self.skipTest("cannot synthesize PDF")
            return
        # Directly exercise class extraction by monkeypatching PdfReader pages text.
        class FakePage:
            def extract_text(self):
                return text

        class FakeReader:
            pages = [FakePage()]

        original = mod.PdfReader
        mod.PdfReader = lambda *_a, **_k: FakeReader()
        try:
            parsed = mod.parse_ff301(b"%PDF-fake")
        finally:
            mod.PdfReader = original
        by_name = {row["name"]: row for row in parsed["classes"]}
        self.assertEqual(by_name["H"]["issuedShares"], 426_000_000)
        self.assertEqual(by_name["Domestic"]["issuedShares"], 1_252_000_000)
        self.assertEqual(parsed["outstandingShares"], 1_678_000_000)


if __name__ == "__main__":
    unittest.main()

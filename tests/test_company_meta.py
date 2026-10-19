import ast
import json
import os
from pathlib import Path
import re
import tempfile
import typing
import unittest
from unittest.mock import Mock


class CompanyMetadataTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        source = ast.parse((Path(__file__).resolve().parents[1] / "build_full_market.py").read_text(encoding="utf-8"))
        function = next(node for node in source.body if isinstance(node, ast.FunctionDef)
                        and node.name == "fetch_cached_company_meta")
        self.fetch = Mock(return_value=[])
        scope = {"Dict": typing.Dict, "Any": typing.Any, "os": os, "json": json, "re": re,
                 "META_CACHE_DIR": self.directory.name, "time": Mock(), "fetch_fmp_api": self.fetch}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "company_meta", "exec"), scope)
        self.generate = scope["fetch_cached_company_meta"]

    def test_missing_provider_data_does_not_recreate_synthetic_holders_or_percentages(self):
        Path(self.directory.name, "AAPL_meta.json").write_text(json.dumps({
            "top_holders": [{"name": "obsolete synthetic holder"}], "inst_ownership_pct": 72,
            "insider_ownership_pct": 5
        }), encoding="utf-8")
        result = self.generate("AAPL", "AAPL", 100, 200)
        self.assertEqual(result["top_holders"], [])
        self.assertEqual(result["insider_trades"], [])
        self.assertEqual(result["stock_splits"], [])
        self.assertIsNone(result["inst_ownership_pct"])
        self.assertIsNone(result["insider_ownership_pct"])

    def test_insider_awards_missing_prices_and_true_zero_prices_are_not_reinterpreted(self):
        self.fetch.side_effect = [[], [
            {"symbol": "AAPL", "transactionType": "A-Award", "securitiesTransacted": 10, "price": 0},
            {"symbol": "AAPL", "transactionType": "P-Purchase", "securitiesTransacted": 5},
            {"symbol": "MSFT", "transactionType": "S-Sale", "securitiesTransacted": 20}
        ], []]
        result = self.generate("AAPL", "AAPL", 100, 200)
        self.assertEqual(len(result["insider_trades"]), 2)
        award, purchase = result["insider_trades"]
        self.assertIsNone(award["is_buy"])
        self.assertEqual(award["price"], 0)
        self.assertEqual(award["total_val"], 0)
        self.assertTrue(purchase["is_buy"])
        self.assertIsNone(purchase["price"])
        self.assertIsNone(purchase["total_val"])


if __name__ == "__main__":
    unittest.main()

"""Regression: incomplete FMP statement payloads must not wipe *_statements_v2.json."""

import ast
import json
import os
import tempfile
import typing
import unittest
from pathlib import Path
from unittest.mock import Mock


def _extract_statement_helpers(directory: str, fetch_json):
    source = ast.parse((Path(__file__).resolve().parents[1] / "build_full_market.py").read_text(encoding="utf-8"))
    names = {"_load_statements_cache", "_valid_statement_rows", "fetch_cached_financial_statements"}
    functions = [
        node for node in source.body
        if isinstance(node, ast.FunctionDef) and node.name in names
    ]
    assert {fn.name for fn in functions} == names
    scope = {
        "Any": typing.Any,
        "Dict": typing.Dict,
        "Optional": typing.Optional,
        "os": os,
        "json": json,
        "time": Mock(),
        "FIN_CACHE_DIR": directory,
        "fetch_json": fetch_json,
    }
    exec(compile(ast.Module(body=functions, type_ignores=[]), "statements_refresh", "exec"), scope)
    return scope


class FinancialStatementsRefreshTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.fetch = Mock()
        scope = _extract_statement_helpers(self.directory.name, self.fetch)
        self.valid = scope["_valid_statement_rows"]
        self.refresh = scope["fetch_cached_financial_statements"]
        self.cache_path = Path(self.directory.name) / "KO_statements_v2.json"
        self.prior = {
            "annual": {"income": [{"date": "2025-12-31", "revenue": 1}], "balance": [{"date": "2025-12-31"}],
                       "cashflow": [{"date": "2025-12-31"}]},
            "quarterly": {"income": [{"date": "2026-07-03", "period": "Q2", "revenue": 2}],
                          "balance": [{"date": "2026-07-03", "period": "Q2"}],
                          "cashflow": [{"date": "2026-07-03", "period": "Q2"}]},
        }
        self.cache_path.write_text(json.dumps(self.prior), encoding="utf-8")
        self.prior_text = self.cache_path.read_text(encoding="utf-8")

    def _rows(self, date="2026-09-30", period="Q3"):
        return [{"date": date, "period": period, "revenue": 3, "symbol": "KO"}]

    def test_error_object_and_empty_list_are_invalid(self):
        self.assertFalse(self.valid(None))
        self.assertFalse(self.valid({"Error Message": "Limit Reach"}))
        self.assertFalse(self.valid([]))
        self.assertFalse(self.valid(["not-a-row"]))
        self.assertTrue(self.valid(self._rows()))

    def test_error_message_object_retains_existing_cache_file(self):
        self.fetch.side_effect = [
            {"Error Message": "Limit Reach"},
            self._rows(), self._rows(), self._rows(), self._rows(), self._rows(),
        ]
        result = self.refresh("KO", "KO")
        self.assertEqual(result["quarterly"]["income"][0]["date"], "2026-07-03")
        self.assertEqual(self.cache_path.read_text(encoding="utf-8"), self.prior_text)

    def test_empty_arrays_do_not_overwrite_statements_cache(self):
        self.fetch.side_effect = [[] for _ in range(6)]
        result = self.refresh("KO", "KO")
        self.assertEqual(result, self.prior)
        self.assertEqual(self.cache_path.read_text(encoding="utf-8"), self.prior_text)

    def test_none_response_retains_cache(self):
        self.fetch.side_effect = [None, self._rows(), self._rows(), self._rows(), self._rows(), self._rows()]
        result = self.refresh("KO", "KO")
        self.assertEqual(result["quarterly"]["income"][0]["period"], "Q2")
        self.assertEqual(self.cache_path.read_text(encoding="utf-8"), self.prior_text)

    def test_successful_refresh_rewrites_cache(self):
        fresh = self._rows()
        self.fetch.side_effect = [fresh for _ in range(6)]
        result = self.refresh("KO", "KO")
        self.assertEqual(result["quarterly"]["income"][0]["period"], "Q3")
        saved = json.loads(self.cache_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["quarterly"]["income"][0]["date"], "2026-09-30")

    def test_failed_refresh_without_cache_does_not_create_empty_file(self):
        missing = Path(self.directory.name) / "META_statements_v2.json"
        self.fetch.side_effect = [{"Error Message": "restricted"} for _ in range(6)]
        result = self.refresh("META", "META")
        self.assertEqual(result["quarterly"]["income"], [])
        self.assertFalse(missing.exists())


if __name__ == "__main__":
    unittest.main()

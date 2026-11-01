"""Regression: FMP stable CFF renames must resolve through STATEMENT_FIELD_ALIASES."""

import ast
import unittest
from pathlib import Path


def _load_aliases():
    source = ast.parse((Path(__file__).resolve().parents[1] / "build_full_market.py").read_text(encoding="utf-8"))
    names = {"STATEMENT_FIELD_ALIASES", "get_safe_field"}
    nodes = [
        node for node in source.body
        if (isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id in names for t in node.targets))
        or (isinstance(node, ast.FunctionDef) and node.name in names)
    ]
    scope = {}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "statement_aliases", "exec"), scope)
    return scope["STATEMENT_FIELD_ALIASES"], scope["get_safe_field"]


class StatementFieldAliasTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.aliases, get_safe = _load_aliases()
        # Store as staticmethod so instance access does not bind `self`.
        cls.get_safe_field = staticmethod(get_safe)

    def test_googl_style_stable_cff_keys(self):
        row = {
            "commonStockIssuance": 12_371_000_000,
            "commonStockRepurchased": 0,
            "commonDividendsPaid": -2_936_000_000,
            "netDebtIssuance": 25_370_000_000,
            "otherFinancingActivities": -5_368_000_000,
            "netCashProvidedByFinancingActivities": 29_437_000_000,
        }
        get = self.get_safe_field
        self.assertEqual(get(row, "commonStockIssued"), 12_371_000_000.0)
        self.assertEqual(get(row, "dividendsPaid"), -2_936_000_000.0)
        self.assertEqual(get(row, "debtRepayment"), 25_370_000_000.0)
        self.assertEqual(get(row, "otherFinancingActivites"), -5_368_000_000.0)
        self.assertEqual(get(row, "netCashUsedProvidedByFinancingActivities"), 29_437_000_000.0)

    def test_legacy_keys_still_preferred(self):
        row = {
            "commonStockIssued": 1.0,
            "commonStockIssuance": 99.0,
            "dividendsPaid": -2.0,
            "commonDividendsPaid": -99.0,
            "debtRepayment": -3.0,
            "netDebtIssuance": 99.0,
            "netCashUsedProvidedByFinancingActivities": -4.0,
            "netCashProvidedByFinancingActivities": 99.0,
        }
        get = self.get_safe_field
        self.assertEqual(get(row, "commonStockIssued"), 1.0)
        self.assertEqual(get(row, "dividendsPaid"), -2.0)
        self.assertEqual(get(row, "debtRepayment"), -3.0)
        self.assertEqual(get(row, "netCashUsedProvidedByFinancingActivities"), -4.0)

    def test_missing_field_is_zero(self):
        get = self.get_safe_field
        self.assertEqual(get({}, "commonStockIssued"), 0.0)
        self.assertEqual(get(None, "dividendsPaid"), 0.0)

    def test_alias_map_covers_cff_renames(self):
        for field in (
            "commonStockIssued",
            "dividendsPaid",
            "debtRepayment",
            "netCashUsedProvidedByFinancingActivities",
            "otherFinancingActivites",
        ):
            self.assertIn(field, self.aliases)


if __name__ == "__main__":
    unittest.main()

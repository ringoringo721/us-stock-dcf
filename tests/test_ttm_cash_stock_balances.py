import ast
import unittest
from pathlib import Path


class TtmCashStockBalanceTests(unittest.TestCase):
    def test_builder_does_not_sum_cash_stock_balances_for_ttm(self):
        source = (Path(__file__).resolve().parents[1] / "build_full_market.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        found = False
        for node in ast.walk(tree):
            if not isinstance(node, ast.If):
                continue
            test = node.test
            if isinstance(test, ast.Compare) and isinstance(test.left, ast.Name) and test.left.id == "f":
                comparators = [c.value for c in test.comparators if isinstance(c, ast.Constant)]
                if "cashAtEndOfPeriod" in comparators or "cashAtBeginningOfPeriod" in comparators:
                    found = True
                    break
        self.assertTrue(found, "TTM cash stock balances must be special-cased in build_full_market")
        self.assertIn('if f == "cashAtEndOfPeriod":', source)
        self.assertIn('elif f == "cashAtBeginningOfPeriod":', source)
        self.assertIn('get_ttm_val(cf_latest_4q, f, is_sum=False', source)
        # Flow fields may still sum; cash stock balances must take the oldest quarter begin.
        self.assertIn("oldest = cf_latest_4q[min(3, len(cf_latest_4q) - 1)]", source)


if __name__ == "__main__":
    unittest.main()

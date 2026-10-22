"""US expansion must skip missing verified outstanding shares instead of aborting the batch."""
import unittest

from build_full_market import resolve_outstanding_shares


class UsExpansionSkipSharesTest(unittest.TestCase):
    def test_returns_row_when_present(self):
        row = {"outstandingShares": 1_000_000, "date": "2026-10-22"}
        self.assertIs(resolve_outstanding_shares("AAPL", row, expansion_mode=True), row)
        self.assertIs(resolve_outstanding_shares("AAPL", row, expansion_mode=False), row)

    def test_expansion_mode_skips_missing_shares(self):
        self.assertIsNone(resolve_outstanding_shares("AEFC", None, expansion_mode=True))

    def test_baseline_mode_still_raises(self):
        with self.assertRaisesRegex(ValueError, "AEFC: verified outstanding-share"):
            resolve_outstanding_shares("AEFC", None, expansion_mode=False)


if __name__ == "__main__":
    unittest.main()

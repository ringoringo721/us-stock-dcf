"""Unit tests for Lite Buffett pilot partial-success exit gate."""

import unittest

from scripts.run_lite_buffett_pilot import evaluate_pilot_job


def _row(ticker, market, ok):
    return {"ticker": ticker, "market": market, "pass_zh_100_300": ok, "status": "generated" if ok else "fail"}


class LiteBuffettPilotExitTests(unittest.TestCase):
    def test_nine_of_ten_with_one_hk_near_miss_is_job_ok_not_overall_pass(self):
        rows = [
            _row("0700.HK", "HK", True),
            _row("0005.HK", "HK", True),
            _row("0388.HK", "HK", True),
            _row("0941.HK", "HK", False),
            _row("1299.HK", "HK", True),
            _row("AAPL", "US", True),
            _row("MSFT", "US", True),
            _row("JPM", "US", True),
            _row("AMZN", "US", True),
            _row("BRK.B", "US", True),
        ]
        verdict = evaluate_pilot_job(rows, allow_hk_failures=1)
        self.assertFalse(verdict["overall_pass"])
        self.assertTrue(verdict["job_ok"])
        self.assertEqual(verdict["pass_count"], 9)
        self.assertEqual(verdict["failed_tickers"], ["0941.HK"])

    def test_us_failure_fails_job_even_if_hk_all_pass(self):
        rows = [_row("0700.HK", "HK", True), _row("AAPL", "US", False)]
        verdict = evaluate_pilot_job(rows, allow_hk_failures=1)
        self.assertFalse(verdict["job_ok"])
        self.assertFalse(verdict["overall_pass"])

    def test_two_hk_failures_exceed_default_allowance(self):
        rows = [
            _row("0941.HK", "HK", False),
            _row("1299.HK", "HK", False),
            _row("AAPL", "US", True),
        ]
        verdict = evaluate_pilot_job(rows, allow_hk_failures=1)
        self.assertFalse(verdict["job_ok"])
        verdict2 = evaluate_pilot_job(rows, allow_hk_failures=2)
        self.assertTrue(verdict2["job_ok"])

    def test_optional_min_pass_floor(self):
        rows = [_row(f"T{i}", "HK", i < 8) for i in range(10)]
        # 8/10 pass, 2 HK fails — allow_hk_failures=2 would pass without min_pass
        verdict = evaluate_pilot_job(rows, allow_hk_failures=2, min_pass=9)
        self.assertFalse(verdict["job_ok"])
        verdict_ok = evaluate_pilot_job(rows, allow_hk_failures=2, min_pass=8)
        self.assertTrue(verdict_ok["job_ok"])


if __name__ == "__main__":
    unittest.main()

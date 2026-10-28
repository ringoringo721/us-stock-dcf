"""Piotroski must tolerate None ratio inputs (US expansion remoat #31 / NGG)."""
import unittest

from build_full_market import calculate_piotroski_score


class PiotroskiNoneSafeTest(unittest.TestCase):
    def test_none_roa_does_not_typeerror(self):
        # p1/p3/p8/p9 fail (None roa); p2+p4+p5+p6+p7 pass
        score, items = calculate_piotroski_score(None, 100.0, 1.5, 40.0, 50_000_000.0)
        self.assertEqual(score, 5)
        self.assertEqual(items[0]["passed"], 0)
        self.assertIn("N/A", items[0]["detail"])

    def test_all_none_inputs_fail_softly(self):
        score, items = calculate_piotroski_score(None, None, None, None, None)
        self.assertEqual(score, 1)  # only p7 always passes
        self.assertEqual(len(items), 9)
        self.assertIn("N/A", items[0]["detail"])
        self.assertIn("N/A", items[1]["detail"])

    def test_numeric_path_unchanged(self):
        score, items = calculate_piotroski_score(10.0, 200.0, 2.0, 30.0, 1_000_000.0)
        self.assertEqual(score, 9)
        self.assertIn("10.0%", items[0]["detail"])


if __name__ == "__main__":
    unittest.main()

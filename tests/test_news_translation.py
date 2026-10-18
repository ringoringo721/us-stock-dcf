import unittest

from scripts.translate_news import pending_titles, validate


class NewsTranslationTests(unittest.TestCase):
    def test_exact_titles_are_cached_without_retranslation(self):
        cache = {"version": 1, "language": "zh-Hant", "titles": {"Old title": {"text": "舊標題"}}}
        self.assertEqual(pending_titles({"version": 1, "titles": ["Old title", "New title", "New title"]}, cache), ["New title"])
        self.assertEqual(pending_titles({"version": 1, "titles": ["Old title"]}, cache), [])

    def test_invalid_cache_does_not_claim_success(self):
        for cache in [{}, {"version": 1, "language": "en", "titles": {}},
                      {"version": 1, "language": "zh-Hant", "titles": {"Title": None}}]:
            with self.assertRaises(ValueError):
                pending_titles({"version": 1, "titles": ["Title"]}, cache)

    def test_order_does_not_reassign_a_translation_to_another_headline(self):
        items = [{"id": 0, "title": "First"}, {"id": 1, "title": "Second"}]
        self.assertEqual(validate(items, [{"id": 1, "text": "第二則"}, {"id": 0, "text": "第一則"}]),
                         {0: "第一則", 1: "第二則"})

    def test_incomplete_duplicate_unknown_english_and_blank_outputs_fail_explicitly(self):
        items = [{"id": 0, "title": "First"}, {"id": 1, "title": "Second"}]
        for output in [[], None, [{"id": 0, "text": "第一則"}],
                       [{"id": 0, "text": "第一則"}, {"id": 0, "text": "第二則"}],
                       [{"id": 0, "text": "第一則"}, {"id": 5, "text": "第二則"}],
                       [{"id": 0, "text": "First"}, {"id": 1, "text": "Second"}],
                       [{"id": 0, "text": ""}, {"id": 1, "text": "第二則"}]]:
            with self.assertRaises(ValueError):
                validate(items, output)


if __name__ == "__main__":
    unittest.main()

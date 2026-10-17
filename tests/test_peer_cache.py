import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import requests
from scripts.peer_cache import get_stock_peers_cached, parse_peers


class PeerCacheTests(unittest.TestCase):
    def test_stable_and_legacy_formats_preserve_all_symbols(self):
        expected = ["DE", "CMI", "PCAR", "AGCO", "TEX", "OSK", "BRK.B"]
        stable = [{"symbol": symbol, "companyName": symbol} for symbol in ["CAT", *expected, "de", "BRKB"]]
        self.assertEqual(parse_peers(stable, "CAT"), expected)
        self.assertEqual(parse_peers([{"symbol": "CAT", "peersList": expected}], "CAT"), expected)
        self.assertEqual(parse_peers({"peersList": expected}, "CAT"), expected)
        self.assertEqual(parse_peers(expected, "CAT"), expected)
        self.assertEqual(parse_peers([], "CAT"), [])

    def test_error_payloads_are_not_treated_as_empty_success(self):
        for payload in [{"Error Message": "Plan not supported"}, [{"companyName": "Invalid"}], ["bad symbol"], None]:
            with self.assertRaises(ValueError):
                parse_peers(payload, "CAT")

    @patch("scripts.peer_cache.requests.get")
    def test_old_empty_caches_are_refreshed_with_stable_records(self, get):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "CAT.json"
            cache.write_text("[]", encoding="utf-8")
            get.return_value = Mock(status_code=200)
            get.return_value.json.return_value = [{"symbol": "DE"}, {"symbol": "CMI"}]
            self.assertEqual(get_stock_peers_cached("CAT", "key", directory), ["DE", "CMI"])
            self.assertEqual(json.loads(cache.read_text(encoding="utf-8")), ["DE", "CMI"])
            self.assertEqual(get.call_args.kwargs["params"]["symbol"], "CAT")

    @patch("scripts.peer_cache.requests.get")
    def test_valid_cached_lists_are_not_truncated(self, get):
        with tempfile.TemporaryDirectory() as directory:
            peers = ["DE", "CMI", "PCAR", "AGCO", "TEX", "OSK"]
            (Path(directory) / "CAT.json").write_text(json.dumps(peers), encoding="utf-8")
            self.assertEqual(get_stock_peers_cached("CAT", "key", directory), peers)
            get.assert_not_called()

    @patch("scripts.peer_cache.requests.get")
    def test_permission_errors_preserve_existing_cache_and_are_explicit(self, get):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "CAT.json"
            cache.write_text('["DE"]', encoding="utf-8")
            get.return_value = Mock(status_code=403)
            log = io.StringIO()
            with contextlib.redirect_stdout(log):
                self.assertEqual(get_stock_peers_cached("CAT", "secret", directory, refresh=True), ["DE"])
                with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
                    get_stock_peers_cached("CAT", "secret", directory, refresh=True, strict=True)
            self.assertIn("HTTP 403", log.getvalue())
            self.assertNotIn("secret", log.getvalue())
            self.assertEqual(json.loads(cache.read_text(encoding="utf-8")), ["DE"])

    @patch("scripts.peer_cache.requests.get")
    def test_network_exceptions_do_not_log_api_keys(self, get):
        get.side_effect = requests.ConnectionError("https://example.invalid?apikey=secret")
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()) as log:
            with self.assertRaisesRegex(RuntimeError, "ConnectionError"):
                get_stock_peers_cached("CAT", "secret", directory, strict=True)
            self.assertNotIn("secret", log.getvalue())


if __name__ == "__main__":
    unittest.main()

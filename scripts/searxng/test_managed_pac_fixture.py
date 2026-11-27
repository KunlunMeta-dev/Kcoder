"""Offline shape check through the immutable bundled Bing/OnlineProcessor code."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

ROOT = FIXTURE = None


class ManagedPacBingFixtureTest(unittest.TestCase):
    def test_original_bing_and_online_processor_parse_the_owned_tls_fixture(self):
        pin = json.loads((Path(__file__).parent / "upstream.json").read_text())
        manifest = json.loads((ROOT / "runtime-manifest.json").read_text())
        self.assertEqual(manifest["upstream"], pin)
        inventory = json.loads((ROOT / "files.sha256.json").read_text())["files"]
        for name in ("source/searx/engines/bing.py", "source/searx/search/processors/online.py"):
            data = (ROOT / name).read_bytes()
            self.assertEqual(len(data), inventory[name]["bytes"])
            self.assertEqual(hashlib.sha256(data).hexdigest(), inventory[name]["sha256"])
        fixture = json.loads(FIXTURE.read_text())
        self.assertEqual(len(fixture["expectedSources"]), 3)
        self.assertLess(len(fixture["html"].encode()), 65536)
        from searx.engines import load_engines, engines
        from searx.extended_types import SXNG_Response
        from searx.search.processors.online import OnlineProcessor, default_request_params
        from searx.query import RawTextQuery
        import searx.network
        load_engines([{"name": "bing", "engine": "bing"}])
        parsed = RawTextQuery(fixture["nativeQuery"], [])
        self.assertEqual({reference.name for reference in parsed.enginerefs}, {"bing"})
        self.assertEqual(parsed.getQuery(), fixture["marker"])
        self.assertIsNone(parsed.external_bang)
        processor = OnlineProcessor(engines["bing"])
        response = SXNG_Response()
        response.content = fixture["html"].encode()
        response.encoding = "utf-8"
        response.status_code = 200
        response.url = "https://www.bing.com/search"
        params = {**default_request_params(), "pageno": 1, "searxng_locale": "en", "safesearch": 0}
        # Only the transport is replaced: the actual existing Bing request and
        # response functions plus OnlineProcessor orchestration remain intact.
        with patch.object(searx.network, "get", return_value=response) as transport:
            results = processor._search_basic(parsed.getQuery(), params)
        transport.assert_called_once()
        url = urlsplit(transport.call_args.args[0])
        self.assertEqual((url.scheme, url.hostname, url.path), ("https", "www.bing.com", "/search"))
        self.assertEqual(parse_qs(url.query)["q"], [fixture["marker"]])
        self.assertEqual(results, fixture["expectedSources"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    args, rest = parser.parse_known_args()
    ROOT, FIXTURE = args.runtime.resolve(strict=True), args.fixture.resolve(strict=True)
    sys.path[:0] = [str(ROOT / "packages"), str(ROOT / "source")]
    unittest.main(argv=[__file__, *rest])

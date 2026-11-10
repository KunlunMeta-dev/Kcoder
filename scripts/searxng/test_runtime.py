"""Offline acceptance against the actual bundled SearXNG application."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_route_broker import RouteFixture

ROOT = None


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.fixture_hits += 1
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("q", [""])[0]
        body = json.dumps({"results": [{"title": "Fixture " + query, "url": "https://example.test/source", "content": "Verified local search"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return


class RuntimeTest(unittest.TestCase):
    def test_actual_search_engine_and_async_loop_keep_each_query_lease(self):
        def exercise(base, token, fixture, broker):
            results, failures = {}, []
            barrier = threading.Barrier(3)
            def query(lease):
                try:
                    barrier.wait(3)
                    results[lease] = self.parent_search(base, token, lease, lease)
                except Exception as error:
                    failures.append(type(error).__name__)
            threads = [threading.Thread(target=query, args=(lease,)) for lease in ("query-a", "query-b")]
            try:
                for thread in threads:
                    thread.start()
                barrier.wait(3)
            finally:
                for thread in threads:
                    thread.join(15)
            self.assertTrue(all(not thread.is_alive() for thread in threads))
            self.assertEqual(failures, [])
            for lease in ("query-a", "query-b"):
                self.assertEqual(results[lease]["results"][0]["title"], "Fixture " + lease)
            self.assertEqual(fixture.fixture_hits, 2)
            resolves = [event for event in broker.events if event["op"] == "resolve"]
            self.assertEqual(len(resolves), 2)
            for event in resolves:
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(event["url"]).query)["q"][0]
                self.assertEqual(event["queryLease"], query)
            self.assertEqual({event["queryLease"] for event in resolves}, {"query-a", "query-b"})
        self.assert_parent_service(exercise)

    def test_actual_late_revoked_engine_cannot_borrow_the_peer_lease(self):
        def exercise(base, token, fixture, broker):
            broker.hold_lease = "query-a"
            old, failures = [], []
            def query():
                try:
                    old.append(self.parent_search(base, token, "late-owned-a", "query-a"))
                except Exception as error:
                    failures.append(type(error).__name__)
            thread = threading.Thread(target=query)
            thread.start()
            try:
                self.assertTrue(broker.waiting.wait(5), "Original engine must reach the parent resolver")
                peer = self.parent_search(base, token, "peer-owned-b", "query-b")
                self.assertEqual(peer["results"][0]["title"], "Fixture peer-owned-b")
                broker.allowed_leases.remove("query-a")
            finally:
                broker.unblock.set()
                thread.join(15)
            self.assertFalse(thread.is_alive())
            self.assertEqual(failures, [])
            self.assertEqual(old[0]["results"], [])
            self.assertEqual(fixture.fixture_hits, 1, "Revoked original request must not dispatch directly or borrow peer authority")
            resolves = [event for event in broker.events if event["op"] == "resolve"]
            self.assertEqual(len(resolves), 2)
            self.assertEqual({event["queryLease"] for event in resolves}, {"query-a", "query-b"})
            for event in resolves:
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(event["url"]).query)["q"][0]
                self.assertEqual(event["queryLease"], "query-a" if query == "late-owned-a" else "query-b")
        self.assert_parent_service(exercise)

    def test_actual_ready_request_without_lease_cannot_use_startup_authority(self):
        def exercise(base, token, fixture, broker):
            result = self.parent_search(base, token, "missing-owned-lease", None)
            self.assertEqual(result["results"], [])
            self.assertEqual(fixture.fixture_hits, 0)
            self.assertEqual(broker.events, [], "A post-ready request cannot use initialQueryLease")
        self.assert_parent_service(exercise)

    def parent_search(self, base, token, query, lease):
        url = base + "/search?" + urllib.parse.urlencode({"q": query, "format": "json", "engines": "fixture"})
        headers = {"Authorization": "Bearer " + token}
        if lease is not None:
            headers["X-KCoder-Query-Lease"] = lease
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(urllib.request.Request(url, headers=headers), timeout=15) as response:
            return json.load(response)

    def assert_parent_service(self, exercise):
        # Read the immutable sealed code; never overwrite its launcher or recipe.
        for name in ("launch.py", "egress.py"):
            self.assertEqual((ROOT / name).read_bytes(), (Path(__file__).resolve().parent / name).read_bytes())
        broker = RouteFixture()
        try:
            self.assert_service_upstream(True, broker, exercise)
        finally:
            broker.close()

    def test_real_curl_cannot_bypass_private_destination_guard(self):
        manifest = json.loads((ROOT / "runtime-manifest.json").read_text())
        script = r"""
import sys
from pathlib import Path
root = Path(sys.argv[1])
sys.path[:0] = [str(root), str(root / "packages")]
import egress
from curl_cffi import requests
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import os
os.environ["NO_PROXY"] = ""
os.environ["no_proxy"] = ""
class Fixture(BaseHTTPRequestHandler):
    hits = 0
    def do_GET(self):
        Fixture.hits += 1
        self.send_response(200)
        self.send_header("Content-Length", "7")
        self.end_headers()
        self.wfile.write(b"allowed")
    def log_message(self, *_): pass
fixture = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=fixture.serve_forever, daemon=True).start()
origin = f"http://127.0.0.1:{fixture.server_port}"
for allowed in (False, True):
    guard = egress.Egress("a" * 64, {"proxyMode": "direct", "allowedOrigins": [origin] if allowed else []})
    proxy = guard.start()
    try:
        try:
            response = requests.get(origin, proxy=proxy, timeout=3)
        except requests.exceptions.RequestException:
            assert not allowed
        else:
            assert allowed and response.text == "allowed"
    finally:
        guard.close()
assert Fixture.hits == 1
fixture.shutdown()
fixture.server_close()
print("curl_private_denied_and_exact_origin_grant_verified")
"""
        result = subprocess.run([ROOT / manifest["python"], "-I", "-B", "-c", script, str(ROOT)], text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("curl_private_denied_and_exact_origin_grant_verified", result.stdout)

    def test_real_service_search_authentication_and_owner_eof(self):
        self.assert_service_upstream(True)

    def test_real_service_cannot_reach_an_ungranted_private_upstream(self):
        self.assert_service_upstream(False)

    def assert_service_upstream(self, allowed, broker=None, exercise=None, settings_override=None, network_override=None):
        fixture = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        fixture.fixture_hits = 0
        threading.Thread(target=fixture.serve_forever, daemon=True).start()
        self.addCleanup(fixture.server_close)
        self.addCleanup(fixture.shutdown)
        manifest = json.loads((ROOT / "runtime-manifest.json").read_text())
        with tempfile.TemporaryDirectory(prefix="kcoder-searxng-test-") as directory:
            workspace = Path(directory)
            token = "a" * 64
            settings = f"""use_default_settings:
  engines:
    keep_only: [fixture]
engines:
  - name: fixture
    engine: json_engine
    search_url: http://127.0.0.1:{fixture.server_port}/?q={{query}}
    results_query: results
    title_query: title
    url_query: url
    content_query: content
    shortcut: fx
    enable_http: true
outgoing:
  enable_http: true
plugins: {{}}
server:
  secret_key: '{token}'
  limiter: false
  public_instance: false
general:
  enable_metrics: false
search:
  formats: [json]
"""
            (workspace / "settings.yml").write_text(settings if settings_override is None else settings_override)
            with (workspace / "stderr.log").open("w+") as stderr:
                child = subprocess.Popen([ROOT / manifest["python"], "-I", "-B", ROOT / "launch.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True)
                try:
                    startup = {"token": token, "workspace": directory, "network": {"proxyMode": "direct", "allowedOrigins": [f"http://127.0.0.1:{fixture.server_port}"] if allowed else []}}
                    if network_override is not None:
                        startup["network"] = network_override
                    if broker is not None:
                        startup["parentEgress"] = {"schemaVersion": 1, "endpoint": broker.broker.url + "/route", "token": "owned-token", "initialQueryLease": "startup-only"}
                    child.stdin.write(json.dumps(startup) + "\n")
                    child.stdin.flush()
                    ready = {}
                    def read_ready():
                        ready.update(json.loads(child.stdout.readline()))
                    reader = threading.Thread(target=read_ready, daemon=True)
                    reader.start()
                    reader.join(25)
                    if not ready.get("port"):
                        stderr.seek(0)
                        self.fail("No ready receipt: " + repr(ready) + " " + stderr.read())
                    base = f"http://127.0.0.1:{ready['port']}"
                    with self.assertRaises(urllib.error.HTTPError) as denied:
                        urllib.request.urlopen(base + "/search?q=forbidden&format=json", timeout=5)
                    self.assertEqual(denied.exception.code, 403)
                    denied.exception.close()
                    url = base + "/search?" + urllib.parse.urlencode({"q": "本地验证", "format": "json", "engines": "fixture"})
                    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
                    if exercise is not None:
                        exercise(base, token, fixture, broker)
                    else:
                        with urllib.request.urlopen(request, timeout=15) as response:
                            result = json.load(response)
                    if exercise is not None:
                        pass
                    elif allowed:
                        if not result["results"]:
                            stderr.seek(0)
                            self.fail(repr(result) + " " + stderr.read())
                        self.assertEqual(result["results"][0]["title"], "Fixture 本地验证")
                        self.assertEqual(result["results"][0]["url"], "https://example.test/source")
                        self.assertEqual(fixture.fixture_hits, 1)
                    else:
                        self.assertEqual(result["results"], [])
                        self.assertEqual(fixture.fixture_hits, 0, "curl must use the guard even when NO_PROXY inherited localhost")
                    child.stdin.close()
                    self.assertEqual(child.wait(timeout=5), 0)
                    self.assertTrue((workspace / "settings.yml").exists())
                    stderr.seek(0)
                    self.assertNotIn(token, stderr.read())
                    with self.assertRaises((urllib.error.URLError, ConnectionResetError, ConnectionAbortedError)):
                        urllib.request.urlopen(request, timeout=2)
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait(timeout=5)
                    if not child.stdin.closed:
                        child.stdin.close()
                    child.stdout.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, required=True)
    args, remaining = parser.parse_known_args()
    ROOT = args.runtime.resolve(strict=True)
    unittest.main(argv=[__file__, *remaining])

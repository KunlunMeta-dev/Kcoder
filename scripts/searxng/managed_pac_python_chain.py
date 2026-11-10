"""Whole sealed Bing/Curl chain to an owned Node TLS proxy, never the public web."""
import argparse
import json
from pathlib import Path
import sys
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_runtime
from test_route_broker import RouteFixture


def observe(runtime, descriptor):
    fixture = json.loads(descriptor.read_text())
    proxy = urlsplit(fixture["proxyUrl"])
    assert proxy.scheme == "http" and proxy.hostname == "127.0.0.1" and proxy.port
    assert fixture["tlsHost"] == "www.bing.com" and len(fixture["expectedSources"]) == 3
    test_runtime.ROOT = runtime
    case = test_runtime.RuntimeTest()
    broker = RouteFixture()
    broker.proxy_override = fixture["proxyUrl"]
    receipt = {"mode": "whole-python-managed-bing", "wrapperSucceeded": False,
               "winHttpExercised": False, "modelCalls": 0, "phase": "startup"}
    settings = """use_default_settings:
  engines:
    keep_only: [bing]
engines:
  - name: bing
    disabled: false
plugins: {}
general:
  enable_metrics: false
server:
  secret_key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  limiter: false
  public_instance: false
search:
  formats: [json]
"""
    def exercise(base, token, _origin, _broker):
        receipt["phase"] = "query"
        query = base + "/search?" + urlencode({"q": fixture["nativeQuery"], "format": "json"})
        request = Request(query, headers={"Authorization": "Bearer " + token, "X-KCoder-Query-Lease": "query-a"})
        with build_opener(ProxyHandler({})).open(request, timeout=20) as response:
            page = json.load(response)
        receipt["page"] = page
        results = page["results"]
        case.assertEqual([row["url"] for row in results], [row["url"] for row in fixture["expectedSources"]])
        case.assertEqual([row["title"] for row in results], [row["title"] for row in fixture["expectedSources"]])
        case.assertTrue(all(fixture["marker"] in row["content"] for row in results))
        case.assertTrue(all(row["engine"] == "bing" for row in results))
    try:
        # Shared RuntimeTest owns the original launcher stdin/EOF and private
        # workspace; only an existing bundled engine is selected in settings.
        case.assert_service_upstream(True, broker, exercise, settings, {"proxyMode": "inherit"})
        receipt.update(wrapperSucceeded=True, phase="owner_eof", sourceCount=3, ownerEofObserved=True)
    except Exception as error:
        receipt.update(errorType=type(error).__name__)
    finally:
        events = []
        for item in broker.events:
            event = {"op": item.get("op"), "queryLease": item.get("queryLease")}
            if "url" in item:
                target = urlsplit(item["url"])
                event.update(host=target.hostname, path=target.path,
                             markerMatched=parse_qs(target.query).get("q") == [fixture["marker"]])
            events.append(event)
        receipt["brokerEvents"] = events
        receipt["brokerTicketsRemaining"] = len(broker.tickets)
        broker.close()
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--input", type=Path, required=True)
    args = parser.parse_args()
    result = observe(args.runtime.resolve(strict=True), args.input.resolve(strict=True))
    print(json.dumps(result))
    raise SystemExit(0 if result["wrapperSucceeded"] else 1)

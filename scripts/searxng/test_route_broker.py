"""Owned parent-route contracts. No personal proxy, Registry or public network."""
import argparse
import asyncio
import http.server
import json
import os
from pathlib import Path
import secrets
import select
import selectors
import socket
import socketserver
import sys
import threading
import unittest
import urllib.parse
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import egress
import launch


class OwnedServer:
    def __init__(self, handler):
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)


class RouteFixture:
    """A loopback broker and two real CONNECT proxies, all owned by one test."""
    def __init__(self):
        self.events, self.requests, self.connects = [], [], []
        self.tickets = {}
        self.decision = "normal"
        self.allowed_leases = {"startup-only", "query-a", "query-b"}
        self.hold_lease = None
        self.proxy_override = None
        self.waiting = threading.Event()
        self.control_closed = threading.Event()
        self.stream_waiting = threading.Event()
        self.unblock = threading.Event()
        fixture = self
        class Origin(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *_args):
                pass
            def do_HEAD(self):
                self.respond()
            def do_GET(self):
                self.respond()
            def do_POST(self):
                self.respond()
            def respond(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                fixture.requests.append((self.path, self.command, body, dict(self.headers)))
                path = urllib.parse.urlsplit(self.path).path
                if path.startswith("/redirect/"):
                    code = int(path.rsplit("/", 1)[1])
                    target = fixture.other.url + "/final" if "cross=1" in self.path else "/final"
                    self.send_response(code)
                    self.send_header("Location", target)
                    self.send_header("Set-Cookie", "owned=yes; Path=/")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if path == "/loop":
                    self.send_response(302)
                    self.send_header("Location", "/loop")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if path == "/stream":
                    self.send_response(200)
                    self.send_header("Content-Length", "4096")
                    self.end_headers()
                    self.wfile.write(b"owned")
                    self.wfile.flush()
                    fixture.stream_waiting.set()
                    fixture.unblock.wait(3)
                    return
                value = json.dumps({"path": self.path, "method": self.command, "body": body.decode(), "headers": dict(self.headers)}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("X-Owned-Response", "curl-preserved")
                self.send_header("Content-Length", str(len(value)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(value)
        self.origin = OwnedServer(Origin)
        self.other = OwnedServer(Origin)
        def proxy_handler(name):
            class Proxy(socketserver.BaseRequestHandler):
                def handle(self):
                    try:
                        header = bytearray()
                        while not header.endswith(b"\r\n\r\n") and len(header) < 8192:
                            header.extend(egress.read_exact(self.request, 1))
                        destination = header.split(b" ")[1].decode()
                        host, port = destination.rsplit(":", 1)
                        fixture.connects.append((name, host, int(port)))
                        with socket.create_connection((host, int(port)), timeout=3) as remote:
                            self.request.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
                            with selectors.DefaultSelector() as selector:
                                selector.register(self.request, selectors.EVENT_READ, remote)
                                selector.register(remote, selectors.EVENT_READ, self.request)
                                while True:
                                    for key, _ in selector.select(3):
                                        data = key.fileobj.recv(65536)
                                        if not data:
                                            return
                                        key.data.sendall(data)
                    except OSError:
                        return
            return Proxy
        self.proxies = []
        for name in ("a", "b"):
            server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), proxy_handler(name))
            server.daemon_threads = True
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.proxies.append((server, thread))
        class Broker(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                status, result = 200, {}
                op = payload.get("op")
                fixture.events.append(payload)
                if self.headers.get("Authorization") != "Bearer owned-token" or payload.get("queryLease") not in fixture.allowed_leases:
                    status = 403
                elif fixture.decision == "deny":
                    status = 403
                elif op == "resolve":
                    if fixture.hold_lease == payload["queryLease"]:
                        fixture.waiting.set()
                        fixture.unblock.wait(5)
                    if fixture.decision == "slow":
                        fixture.waiting.set()
                        for _ in range(300):
                            if fixture.unblock.wait(0.01):
                                break
                            if select.select([self.connection], [], [], 0)[0] and not self.connection.recv(1, socket.MSG_PEEK):
                                fixture.control_closed.set()
                                return
                    if payload["queryLease"] not in fixture.allowed_leases:
                        status = 403
                    else:
                        ticket = secrets.token_hex(32)
                        fixture.tickets[ticket] = payload
                        result = {"routeTicket": ticket}
                elif op == "redeem":
                    record = fixture.tickets.pop(payload["routeTicket"], None)
                    target = urllib.parse.urlsplit(record["url"]) if record else None
                    target_port = target.port if target and target.port is not None else 443 if target and target.scheme == "https" else 80 if target and target.scheme == "http" else None
                    if not target or record["queryLease"] != payload["queryLease"] or target.hostname != payload["host"] or target_port != payload["port"]:
                        status = 403
                    elif fixture.decision == "missing":
                        result = {}
                    elif fixture.decision == "empty":
                        result = {"proxy": ""}
                    else:
                        index = 1 if target.path.startswith("/b") else 0
                        proxy = f"http://127.0.0.1:{fixture.proxies[index][0].server_address[1]}"
                        result = {"proxy": fixture.proxy_override if fixture.proxy_override is not None else None if target.path == "/direct" else proxy}
                elif op == "release":
                    fixture.tickets.pop(payload["routeTicket"], None)
                else:
                    status = 403
                if status != 200:
                    result = {"errorKind": "route_denied"}
                body = json.dumps(result).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(body)
                except (OSError, BrokenPipeError):
                    pass
        self.broker = OwnedServer(Broker)
        self.guard = egress.Egress("a" * 64, {"allowedOrigins": [self.origin.url, self.other.url]}, {"schemaVersion": 1, "endpoint": self.broker.url + "/route", "token": "owned-token", "initialQueryLease": "startup-only"})
        self.guard.start()

    def close(self):
        self.unblock.set()
        self.guard.close()
        self.broker.close()
        for server, thread in self.proxies:
            server.shutdown()
            server.server_close()
            thread.join(2)
        self.origin.close()
        self.other.close()


class CurlRouteTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from curl_cffi.requests import AsyncSession
        from searx.extended_types import SXNG_Response
        from searx.network.client import AsyncClient
        class Client(AsyncClient):
            pass
        launch.install_route_connection_guard(Client)
        self.original = AsyncSession.request
        self.fixture = RouteFixture()
        self.client = Client(trust_env=False, discard_cookies=True, impersonate="chrome", response_class=SXNG_Response, timeout=3)
        self.environment = patch.dict(os.environ, {"NO_PROXY": "", "no_proxy": ""})
        self.environment.start()

    async def asyncTearDown(self):
        await self.client.close()
        await asyncio.to_thread(self.fixture.close)
        self.environment.stop()

    async def request(self, path, method="GET", **kwargs):
        return await launch.parent_routed_request(self.fixture.guard, self.original, self.client, method, self.fixture.origin.url + path, **kwargs)

    async def test_real_curl_per_path_proxy_direct_and_response_are_preserved(self):
        from searx.extended_types import SXNG_Response
        for path in ("/a", "/b", "/direct", "/a?encoded=x%20y"):
            response = await self.request(path)
            self.assertIsInstance(response, SXNG_Response)
            self.assertEqual(response.json()["path"], path)
            self.assertEqual(response.headers["X-Owned-Response"], "curl-preserved")
        self.assertEqual([item[0] for item in self.fixture.connects], ["a", "b", "a"])
        resolves = [event for event in self.fixture.events if event["op"] == "resolve"]
        redeems = [event for event in self.fixture.events if event["op"] == "redeem"]
        self.assertEqual(len(resolves), 4)
        self.assertEqual(len(redeems), 4)
        self.assertEqual(len({event["routeTicket"] for event in redeems}), 4)
        self.assertEqual(self.fixture.guard.routes, {})
        self.assertEqual(self.fixture.guard.route_sockets, {})

    async def test_redirect_status_methods_history_and_same_origin_cookies(self):
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                response = await self.request(f"/redirect/{status}", "POST", data="owned-body")
                self.assertEqual(response.json()["method"], "POST" if status in (307, 308) else "GET")
                self.assertEqual(response.json()["body"], "owned-body" if status in (307, 308) else "")
                self.assertIn("owned=yes", response.json()["headers"].get("Cookie", ""))
                self.assertEqual([item.status_code for item in response.history], [status])
                self.assertEqual(response.redirect_count, 1)

    async def test_cross_origin_strips_request_credentials_and_rejects_ambient_auth(self):
        response = await self.request("/redirect/302?cross=1", headers={"Authorization": "owned-secret", "Cookie": "private=yes", "Proxy-Authorization": "private"}, auth=("owned", "secret"))
        headers = {key.lower(): value for key, value in response.json()["headers"].items()}
        self.assertNotIn("authorization", headers)
        self.assertNotIn("cookie", headers)
        self.assertNotIn("proxy-authorization", headers)
        self.client.auth = ("ambient", "secret")
        before = len(self.fixture.requests)
        with self.assertRaises(PermissionError):
            await self.request("/redirect/302?cross=1")
        self.assertEqual(len(self.fixture.requests), before + 1)

    async def test_query_encoding_redirect_limit_and_stream_close_release(self):
        response = await self.request("/a?first=1#ignored", params={"space": "x y", "unicode": "中文"})
        full = next(event["url"] for event in self.fixture.events if event["op"] == "resolve")
        self.assertEqual(urllib.parse.urlsplit(full).path + "?" + urllib.parse.urlsplit(full).query, response.json()["path"])
        with self.assertRaises(PermissionError):
            await self.request("/loop", max_redirects=2)
        response = await self.request("/a", stream=True)
        self.assertEqual(json.loads(await response.acontent())["path"], "/a")
        await response.aclose()
        self.assertEqual(self.fixture.guard.route_sockets, {})

    async def test_parent_denied_missing_or_empty_decision_never_connects_direct(self):
        for decision in ("deny", "missing", "empty"):
            with self.subTest(decision=decision):
                self.fixture.decision = decision
                with self.assertRaises(Exception):
                    await self.request("/a")
        self.assertEqual(self.fixture.requests, [])
        self.assertEqual(self.fixture.connects, [])

    async def test_live_stream_owner_close_settles_without_closing_peer(self):
        for synchronous in (False, True):
            response = await self.request("/stream", stream=True)
            self.assertTrue(self.fixture.stream_waiting.is_set())
            if synchronous:
                await asyncio.to_thread(response.close)
            await asyncio.wait_for(response.aclose(), 1)
            self.assertEqual(self.fixture.guard.route_sockets, {})
            peer = await self.request("/b")
            self.assertEqual(peer.status_code, 200)

    async def test_ready_missing_context_and_expired_ticket_cannot_dispatch(self):
        guard = self.fixture.guard
        guard.parent.ready = True
        with self.assertRaises(PermissionError):
            await self.request("/a")
        self.assertEqual(self.fixture.events, [])
        ticket, _ = await guard.route("query-a", self.fixture.origin.url + "/a")
        with guard.route_lock:
            lease, target, _ = guard.routes[ticket]
            guard.routes[ticket] = (lease, target, 0)
        with self.assertRaises(PermissionError):
            guard.consume_route(ticket, "query-a", "127.0.0.1", self.fixture.origin.server.server_port)
        self.assertEqual([event["op"] for event in self.fixture.events], ["resolve"])
        await guard.release_route("query-a", ticket)

    async def test_tickets_reject_wrong_peer_destination_and_replay(self):
        guard = self.fixture.guard
        with patch.object(socket, "getaddrinfo") as lookup:
            with self.assertRaises(PermissionError):
                guard.connect("must-not-resolve.invalid", 443, "unknown", "query-a")
            lookup.assert_not_called()
        for lease, host, port in (("query-b", "127.0.0.1", self.fixture.origin.server.server_port), ("query-a", "localhost", self.fixture.origin.server.server_port), ("query-a", "127.0.0.1", 1)):
            ticket, _ = await guard.route("query-a", self.fixture.origin.url + "/a")
            with self.assertRaises(PermissionError):
                guard.consume_route(ticket, lease, host, port)
            with self.assertRaises(PermissionError):
                guard.consume_route(ticket, "query-a", "127.0.0.1", self.fixture.origin.server.server_port)
            await guard.release_route("query-a", ticket)

    async def test_cancelled_control_socket_does_not_block_peer_loop(self):
        self.fixture.decision = "slow"
        pending = asyncio.create_task(self.request("/a"))
        self.assertTrue(await asyncio.to_thread(self.fixture.waiting.wait, 2))
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(pending, 1)
        self.assertTrue(await asyncio.to_thread(self.fixture.control_closed.wait, 1))
        self.fixture.decision = "normal"
        response = await self.request("/b")
        self.assertEqual(response.status_code, 200)
        self.fixture.unblock.set()


class RequestContextTest(unittest.TestCase):
    def test_engine_thread_and_async_task_keep_their_own_query_lease(self):
        from flask import Flask, copy_current_request_context
        app = Flask(__name__)
        routes = egress.ParentRoutes({"schemaVersion": 1, "endpoint": "http://127.0.0.1:1/route", "token": "owned-token", "initialQueryLease": "startup-only"})
        self.assertEqual(routes.lease(), "startup-only")
        routes.ready = True
        with self.assertRaises(PermissionError):
            routes.lease()
        loop = asyncio.new_event_loop()
        ready = threading.Event()
        def worker():
            asyncio.set_event_loop(loop)
            ready.set()
            loop.run_forever()
        owner = threading.Thread(target=worker)
        owner.start(); ready.wait(2)
        observed, failures, threads = [], [], []
        async def request():
            first = routes.lease()
            await asyncio.sleep(0.01)
            observed.append((first, routes.lease()))
        def engine():
            try:
                asyncio.run_coroutine_threadsafe(request(), loop).result(2)
            except Exception as error:
                failures.append(type(error).__name__)
        try:
            for value in ("query-a", "query-b"):
                with app.test_request_context("/search", headers={"X-KCoder-Query-Lease": value}):
                    thread = threading.Thread(target=copy_current_request_context(engine))
                    threads.append(thread); thread.start()
            for thread in threads:
                thread.join(3)
            self.assertEqual(failures, [])
            self.assertEqual(sorted(observed), [("query-a", "query-a"), ("query-b", "query-b")])
        finally:
            loop.call_soon_threadsafe(loop.stop); owner.join(3); loop.close()
        self.assertFalse(owner.is_alive())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path)
    args, rest = parser.parse_known_args()
    if args.runtime:
        sys.path[:0] = [str(args.runtime / "packages"), str(args.runtime / "source")]
    unittest.main(argv=[sys.argv[0], *rest])

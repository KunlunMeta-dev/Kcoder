"""Offline destination binding, proxy inheritance and private-origin regressions."""
from contextlib import closing
import os
import socket
import struct
import threading
import unittest
from unittest.mock import patch

import egress


class EgressTest(unittest.TestCase):
    def test_addresses_and_mixed_dns_fail_closed(self):
        for value in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "192.0.0.9", "::1", "::ffff:127.0.0.1", "2001:db8::1", "2002:7f00:1::", "fc00::1"):
            self.assertFalse(egress.public_address(value), value)
        guard = egress.Egress("a" * 64, {"proxyMode": "direct"})
        rows = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ("1.1.1.1", "127.0.0.1")]
        with patch.object(socket, "getaddrinfo", return_value=rows), patch.object(socket, "create_connection") as connect:
            with self.assertRaises(PermissionError):
                guard.connect("mixed.example", 443)
            connect.assert_not_called()

    def test_direct_connection_receives_checked_numeric_address(self):
        guard = egress.Egress("a" * 64, {"proxyMode": "direct"})
        rows = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))]
        with patch.object(socket, "getaddrinfo", return_value=rows), patch.object(socket, "create_connection") as connect:
            guard.connect("pinned.example", 443)
            connect.assert_called_once_with(("1.1.1.1", 443), timeout=15)

    def test_proxy_policy_uses_explicit_reference_and_exact_bypass(self):
        with patch.dict(os.environ, {"HTTPS_PROXY": "http://owned-proxy:99", "NO_PROXY": ".example.com:443"}, clear=True):
            guard = egress.Egress("a" * 64)
            self.assertIsNone(guard.proxy("www.example.com", 443))
            self.assertEqual(guard.proxy("other.example", 443), "http://owned-proxy:99")
            self.assertEqual(guard.proxy("badexample.com", 443), "http://owned-proxy:99")
            self.assertIsNone(egress.Egress("a" * 64, {"proxyMode": "direct"}).proxy("other.example", 443))
        with patch.dict(os.environ, {"OWNED_SEARCH_PROXY": "http://owned-proxy:88"}, clear=True):
            self.assertEqual(egress.Egress("a" * 64, {"proxyMode": "configured", "proxyEnv": "OWNED_SEARCH_PROXY"}).proxy("host", 443), "http://owned-proxy:88")

    def test_native_system_bypass_syntax_does_not_widen_domain_labels(self):
        self.assertTrue(egress.bypasses("docs.example.com", 443, "*.example.com"))
        self.assertFalse(egress.bypasses("badexample.com", 443, "*.example.com"))
        self.assertTrue(egress.bypasses("owned-dev", 80, "<local>"))
        self.assertFalse(egress.bypasses("docs.example.com", 443, "<local>"))
        self.assertTrue(egress.bypasses("www.microsoft.example", 443, "www.microsoft.*"))
        self.assertFalse(egress.bypasses("other.microsoft.example", 443, "www.microsoft.*"))

    def test_http_proxy_receives_numeric_connect_without_remote_dns(self):
        with closing(socket.socket()) as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            requests = []
            def serve():
                with listener.accept()[0] as stream:
                    header = bytearray()
                    while not header.endswith(b"\r\n\r\n"):
                        header.extend(stream.recv(1))
                    requests.append(bytes(header))
                    stream.sendall(b"HTTP/1.1 200 Connected\r\n\r\n")
            worker = threading.Thread(target=serve)
            worker.start()
            with egress.connect_proxy(f"http://127.0.0.1:{listener.getsockname()[1]}", "1.1.1.1", 443):
                pass
            worker.join(3)
            self.assertFalse(worker.is_alive())
            self.assertTrue(requests[0].startswith(b"CONNECT 1.1.1.1:443 HTTP/1.1\r\n"))

    def test_socks4_proxy_receives_only_the_pinned_ipv4_address(self):
        with closing(socket.socket()) as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            received = []
            def serve():
                with listener.accept()[0] as stream:
                    received.append(egress.read_exact(stream, 9))
                    stream.sendall(b"\x00\x5a\x00\x00\x00\x00\x00\x00")
            worker = threading.Thread(target=serve)
            worker.start()
            with egress.connect_proxy(f"socks4://127.0.0.1:{listener.getsockname()[1]}", "1.1.1.1", 443):
                pass
            worker.join(3)
            self.assertFalse(worker.is_alive())
            self.assertEqual(received, [b"\x04\x01\x01\xbb\x01\x01\x01\x01\x00"])

    def test_owned_socks_guard_denies_private_and_other_owners(self):
        guard = egress.Egress("a" * 64, {"proxyMode": "direct"})
        url = guard.start()
        self.addCleanup(guard.close)
        proxy_port = int(url.rsplit(":", 1)[1])
        for user in (b"a" * 64, b"b" * 64):
            with socket.create_connection(("127.0.0.1", proxy_port), timeout=3) as stream:
                stream.sendall(b"\x05\x01\x02")
                self.assertEqual(egress.read_exact(stream, 2), b"\x05\x02")
                stream.sendall(b"\x01" + bytes((len(user),)) + user + b"\x01x")
                if user != b"a" * 64:
                    self.assertEqual(stream.recv(1), b"")
                    continue
                self.assertEqual(egress.read_exact(stream, 2), b"\x01\x00")
                stream.sendall(b"\x05\x01\x00\x01\x7f\x00\x00\x01" + struct.pack("!H", 80))
                self.assertEqual(stream.recv(1), b"")


if __name__ == "__main__":
    unittest.main()

"""Owned SOCKS egress: resolve, validate every address, then connect a numeric IP.

The launcher installs this as curl's sole proxy before loading SearXNG. Redirects
open another checked tunnel; TLS is still checked by curl against the origin.
"""
import asyncio
import base64
import hmac
import http.client
import ipaddress
import json
import os
import selectors
import socket
import socketserver
import struct
import threading
import time
import urllib.parse


PROXY_NAMES = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy")


class ParentRoutes:
    """Private control channel; proxy decisions never enter model-facing output."""
    def __init__(self, config):
        endpoint = urllib.parse.urlsplit(config.get("endpoint", ""))
        if config.get("schemaVersion") != 1 or endpoint.scheme != "http" or endpoint.hostname not in ("127.0.0.1", "::1") or not endpoint.port or endpoint.path != "/route" or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
            raise ValueError("Invalid parent route authority")
        self.endpoint = endpoint
        self.token = config.get("token")
        self.initial = config.get("initialQueryLease")
        if not isinstance(self.token, str) or not self.token or len(self.token) > 512 or any(c in self.token for c in "\r\n"):
            raise ValueError("Invalid parent route authority")
        self.ready = False

    def lease(self):
        from flask import has_request_context, request
        value = request.headers.get("X-KCoder-Query-Lease") if has_request_context() else self.initial if not self.ready else None
        if not isinstance(value, str) or not value or not value.isascii() or len(value) > 255 or any(c in value for c in "\r\n\0"):
            raise PermissionError("A current query route lease is required")
        return value

    def rpc(self, payload):
        body = json.dumps(payload, separators=(",", ":")).encode()
        if len(body) > 64 * 1024:
            raise ValueError("Parent route request is too large")
        connection = http.client.HTTPConnection(self.endpoint.hostname, self.endpoint.port, timeout=36)
        try:
            connection.request("POST", self.endpoint.path, body, {"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
            response = connection.getresponse()
            raw = response.read(64 * 1024 + 1)
            if response.status != 200 or len(raw) > 64 * 1024:
                raise PermissionError("Parent web route was denied")
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError("Invalid parent route response")
            return value
        except (OSError, ValueError, http.client.HTTPException):
            raise PermissionError("Parent web route was denied") from None
        finally:
            connection.close()

    async def arpc(self, payload):
        """Cancellation closes only this request's loopback control connection."""
        body = json.dumps(payload, separators=(",", ":")).encode()
        if len(body) > 64 * 1024:
            raise PermissionError("Parent web route was denied")
        writer = None
        try:
            async with asyncio.timeout(36):
                reader, writer = await asyncio.open_connection(self.endpoint.hostname, self.endpoint.port, limit=8192)
                header = (f"POST /route HTTP/1.1\r\nHost: {self.endpoint.netloc}\r\nAuthorization: Bearer {self.token}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode("ascii")
                writer.write(header + body)
                await writer.drain()
                head = await reader.readuntil(b"\r\n\r\n")
                lines = head.decode("ascii").split("\r\n")
                if lines[0].split(" ")[1:2] != ["200"]:
                    raise ValueError("Denied")
                fields = {}
                for line in lines[1:-2]:
                    key, value = line.split(":", 1)
                    key = key.lower()
                    if key in fields:
                        raise ValueError("Duplicate header")
                    fields[key] = value.strip()
                length = int(fields["content-length"])
                if "transfer-encoding" in fields or not 0 <= length <= 64 * 1024:
                    raise ValueError("Invalid framing")
                result = json.loads(await reader.readexactly(length))
                if not isinstance(result, dict):
                    raise ValueError("Invalid response")
                return result
        except (OSError, ValueError, KeyError, UnicodeError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError):
            raise PermissionError("Parent web route was denied") from None
        finally:
            if writer is not None:
                writer.close()


def host_key(host):
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        return host.rstrip(".").encode("idna").decode().lower()


def public_address(value):
    ip = ipaddress.ip_address(value)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        return public_address(str(ip.ipv4_mapped))
    if not ip.is_global:
        return False
    if ip.version == 4:
        return not any(ip in ipaddress.ip_network(net) for net in ("192.0.0.0/24", "192.88.99.0/24"))
    return ip in ipaddress.ip_network("2000::/3") and not any(ip in ipaddress.ip_network(net) for net in ("2001::/23", "2002::/16", "3fff::/20"))


def wildcard_host(pattern, host):
    p = h = retry = 0
    star = None
    while h < len(host):
        if p < len(pattern) and pattern[p] == host[h]:
            p += 1
            h += 1
        elif p < len(pattern) and pattern[p] == "*":
            star = p
            p += 1
            retry = h
        elif star is not None:
            retry += 1
            h = retry
            p = star + 1
        else:
            return False
    return not pattern[p:].strip("*")


def bypasses(host, port, rules):
    host = host.lower().strip("[]").rstrip(".")
    for rule in rules.split(","):
        rule = rule.strip()
        if rule == "*" or (rule == "<local>" and "." not in host and ":" not in host):
            return True
        if not rule:
            continue
        if "/" in rule:
            try:
                if ipaddress.ip_address(host) in ipaddress.ip_network(rule, strict=False):
                    return True
            except ValueError:
                pass
            continue
        name = rule
        if rule.startswith("["):
            end = rule.find("]")
            if end < 0:
                continue
            name = rule[1:end]
            if rule[end + 1:] and rule[end + 1:] != ":" + str(port):
                continue
        elif rule.count(":") == 1:
            name, rule_port = rule.rsplit(":", 1)
            if rule_port != str(port):
                continue
        name = name.lower().removeprefix("*.").lstrip(".").rstrip(".")
        if "*" in name and wildcard_host(name, host):
            return True
        if host == name or host.endswith("." + name):
            return True
    return False


def read_exact(stream, count):
    output = bytearray()
    while len(output) < count:
        part = stream.recv(count - len(output))
        if not part:
            raise ConnectionError("Incomplete egress protocol")
        output.extend(part)
    return bytes(output)


def connect_proxy(proxy, address, port):
    parsed = urllib.parse.urlsplit(proxy)
    if parsed.scheme not in ("http", "socks4", "socks5") or not parsed.hostname:
        raise ValueError("Proxy cannot pin destination addresses")
    stream = socket.create_connection((parsed.hostname, parsed.port or (80 if parsed.scheme == "http" else 1080)), timeout=15)
    try:
        if parsed.scheme == "http":
            destination = f"[{address}]:{port}" if ":" in address else f"{address}:{port}"
            request = f"CONNECT {destination} HTTP/1.1\r\nHost: {destination}\r\n"
            if parsed.username is not None:
                auth = urllib.parse.unquote(parsed.username) + ":" + urllib.parse.unquote(parsed.password or "")
                request += "Proxy-Authorization: Basic " + base64.b64encode(auth.encode()).decode() + "\r\n"
            stream.sendall((request + "\r\n").encode())
            header = bytearray()
            while not header.endswith(b"\r\n\r\n") and len(header) < 8192:
                header.extend(read_exact(stream, 1))
            if not header.endswith(b"\r\n\r\n") or header.split(b"\r\n", 1)[0].split(b" ")[1:2] != [b"200"]:
                raise ConnectionError("Proxy refused the pinned tunnel")
        elif parsed.scheme == "socks4":
            ip = ipaddress.ip_address(address)
            user = urllib.parse.unquote(parsed.username or "").encode()
            if ip.version != 4 or len(user) > 255 or b"\0" in user or parsed.password:
                raise ValueError("SOCKS4 requires a pinned IPv4 address and a bounded user id")
            stream.sendall(b"\x04\x01" + struct.pack("!H", port) + ip.packed + user + b"\0")
            if read_exact(stream, 8)[:2] != b"\x00\x5a":
                raise ConnectionError("SOCKS4 proxy refused the pinned tunnel")
        else:
            authenticated = parsed.username is not None
            stream.sendall(bytes((5, 1, 2 if authenticated else 0)))
            method = read_exact(stream, 2)
            if method != bytes((5, 2 if authenticated else 0)):
                raise ConnectionError("SOCKS proxy authentication failed")
            if authenticated:
                user = urllib.parse.unquote(parsed.username).encode()
                password = urllib.parse.unquote(parsed.password or "").encode()
                if len(user) > 255 or len(password) > 255:
                    raise ValueError("SOCKS proxy credential limit")
                stream.sendall(bytes((1, len(user))) + user + bytes((len(password),)) + password)
                if read_exact(stream, 2) != b"\x01\x00":
                    raise ConnectionError("SOCKS proxy authentication failed")
            ip = ipaddress.ip_address(address)
            stream.sendall(bytes((5, 1, 0, 1 if ip.version == 4 else 4)) + ip.packed + struct.pack("!H", port))
            reply = read_exact(stream, 4)
            if reply[:2] != b"\x05\x00":
                raise ConnectionError("SOCKS proxy refused the pinned tunnel")
            size = {1: 4, 4: 16}.get(reply[3])
            if reply[3] == 3:
                size = read_exact(stream, 1)[0]
            if size is None:
                raise ConnectionError("Invalid SOCKS reply")
            read_exact(stream, size + 2)
        return stream
    except BaseException:
        stream.close()
        raise


class Egress:
    def __init__(self, token, network=None, parent=None):
        self.token = token.encode()
        self.network = network or {}
        self.parent = ParentRoutes(parent) if parent is not None else None
        self.route_lock = threading.Lock()
        self.routes = {}
        self.revoked_routes = {}
        self.route_sockets = {}
        self.closed = False
        self.environment = {name: os.environ[name] for name in PROXY_NAMES if name in os.environ}
        self.mode = self.network.get("proxyMode", "inherit")
        if self.mode == "inherit" and os.environ.get("KCODER_WEB_NO_PROXY", "").lower() in ("1", "true", "yes", "on"):
            self.mode = "direct"
        if self.mode not in ("inherit", "direct", "configured"):
            raise ValueError("Invalid egress proxy mode")
        self.configured = None
        if self.mode == "configured":
            name = self.network.get("proxyEnv")
            if not isinstance(name, str) or not name or name not in os.environ:
                raise ValueError("Configured egress proxy is unavailable")
            self.configured = os.environ[name]
        self.slots = threading.BoundedSemaphore(8)
        # Only the owning host/test harness can add these; never a query field.
        self.allowed = set()
        for origin in self.network.get("allowedOrigins", []):
            parsed = urllib.parse.urlsplit(origin)
            if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
                raise ValueError("Invalid exact egress origin")
            self.allowed.add((parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)))

    async def route(self, lease, url):
        if self.parent is None:
            raise PermissionError("Parent web routing is unavailable")
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise PermissionError("Invalid web route URL")
        result = await self.parent.arpc({"op": "resolve", "queryLease": lease, "url": url})
        ticket = result.get("routeTicket")
        if not isinstance(ticket, str) or len(ticket) != 64 or any(c not in "0123456789abcdef" for c in ticket):
            raise PermissionError("Invalid parent route ticket")
        with self.route_lock:
            now = time.monotonic()
            self.routes = {key: value for key, value in self.routes.items() if value[2] > now}
            self.revoked_routes = {key: expiry for key, expiry in self.revoked_routes.items() if expiry > now}
            if self.closed or len(self.routes) >= 128 or ticket in self.routes:
                raise PermissionError("Parent route capacity unavailable")
            self.routes[ticket] = (lease, parsed, now + 30)
        return ticket, f"socks5h://{ticket}:{urllib.parse.quote(lease, safe='')}@127.0.0.1:{self.server.server_address[1]}"

    def revoke_route(self, ticket):
        with self.route_lock:
            self.routes.pop(ticket, None)
            self.revoked_routes[ticket] = time.monotonic() + 30
            sockets = self.route_sockets.pop(ticket, ())
        for stream in sockets:
            try:
                stream.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            stream.close()

    async def release_route(self, lease, ticket):
        self.revoke_route(ticket)
        try:
            async with asyncio.timeout(2):
                await self.parent.arpc({"op": "release", "queryLease": lease, "routeTicket": ticket})
        except (OSError, ValueError, TimeoutError):
            pass

    def check_route(self, ticket, lease, host, port, consume=False):
        with self.route_lock:
            value = self.routes.pop(ticket, None) if consume else self.routes.get(ticket)
        if value is None or value[2] <= time.monotonic() or not hmac.compare_digest(value[0], lease):
            raise PermissionError("Parent route ticket unavailable")
        parsed = value[1]
        if host_key(parsed.hostname) != host_key(host) or (parsed.port or (443 if parsed.scheme == "https" else 80)) != port:
            raise PermissionError("Parent route destination changed")

    def consume_route(self, ticket, lease, host, port):
        self.check_route(ticket, lease, host, port, consume=True)
        result = self.parent.rpc({"op": "redeem", "queryLease": lease, "routeTicket": ticket, "host": host, "port": port})
        if "proxy" not in result or result["proxy"] is not None and (not isinstance(result["proxy"], str) or not result["proxy"].strip()):
            raise PermissionError("Parent route decision unavailable")
        return result["proxy"]

    def proxy(self, host, port):
        if self.mode == "direct":
            return None
        if self.mode == "configured":
            return self.configured
        if bypasses(host, port, self.environment.get("no_proxy", self.environment.get("NO_PROXY", ""))):
            return None
        scheme = "https" if port == 443 else "http"
        return self.environment.get(scheme + "_proxy", self.environment.get(scheme.upper() + "_PROXY", self.environment.get("all_proxy", self.environment.get("ALL_PROXY")))) or None

    def connect(self, host, port, ticket=None, lease=None):
        if not 1 <= port <= 65535:
            raise ValueError("Invalid destination port")
        if self.parent is not None:
            # An unauthenticated SOCKS peer cannot trigger even a DNS lookup.
            self.check_route(ticket, lease, host, port)
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        if not addresses or len(addresses) > 64:
            raise ValueError("Invalid destination resolution")
        if (host, port) not in self.allowed and any(not public_address(row[4][0]) for row in addresses):
            raise PermissionError("Private egress destination denied")
        # Numeric socket connect cannot perform a second name lookup.
        addresses.sort(key=lambda row: row[0] == socket.AF_INET6)
        address = addresses[0][4][0]
        proxy = self.consume_route(ticket, lease, host, port) if self.parent is not None else self.proxy(host, port)
        if proxy:
            return connect_proxy(proxy, address, port)
        return socket.create_connection((address, port), timeout=15)

    def start(self):
        guard = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                if not guard.slots.acquire(blocking=False):
                    return
                try:
                    self.request.settimeout(15)
                    if read_exact(self.request, 1) != b"\x05":
                        return
                    methods = read_exact(self.request, read_exact(self.request, 1)[0])
                    if 2 not in methods:
                        return
                    self.request.sendall(b"\x05\x02")
                    if read_exact(self.request, 1) != b"\x01":
                        return
                    user = read_exact(self.request, read_exact(self.request, 1)[0])
                    password = read_exact(self.request, read_exact(self.request, 1)[0])
                    if guard.parent is None and not hmac.compare_digest(user, guard.token):
                        return
                    self.request.sendall(b"\x01\x00")
                    header = read_exact(self.request, 4)
                    if header[:3] != b"\x05\x01\x00":
                        return
                    if header[3] == 3:
                        host = read_exact(self.request, read_exact(self.request, 1)[0]).decode("idna")
                    elif header[3] in (1, 4):
                        host = str(ipaddress.ip_address(read_exact(self.request, 4 if header[3] == 1 else 16)))
                    else:
                        return
                    port = struct.unpack("!H", read_exact(self.request, 2))[0]
                    ticket = user.decode("ascii") if guard.parent is not None else None
                    lease = password.decode("utf8") if guard.parent is not None else None
                    with guard.connect(host, port, ticket, lease) as remote:
                        if ticket is not None:
                            with guard.route_lock:
                                if guard.closed or ticket in guard.revoked_routes:
                                    return
                                guard.route_sockets.setdefault(ticket, set()).update((self.request, remote))
                        self.request.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
                        with selectors.DefaultSelector() as selector:
                            selector.register(self.request, selectors.EVENT_READ, remote)
                            selector.register(remote, selectors.EVENT_READ, self.request)
                            while True:
                                ready = selector.select(30)
                                if not ready:
                                    return
                                for key, _ in ready:
                                    data = key.fileobj.recv(65536)
                                    if not data:
                                        return
                                    key.data.sendall(data)
                except (OSError, ValueError):
                    return
                finally:
                    guard.slots.release()

        class Server(socketserver.ThreadingTCPServer):
            daemon_threads = True
            allow_reuse_address = False

        self.server = Server(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, name="search-egress", daemon=True).start()
        port = self.server.server_address[1]
        return f"socks5h://{self.token.decode()}:x@127.0.0.1:{port}"

    def close(self):
        self.closed = True
        with self.route_lock:
            sockets = [stream for owned in self.route_sockets.values() for stream in owned]
            self.routes.clear()
            self.revoked_routes.clear()
            self.route_sockets.clear()
        for stream in sockets:
            try:
                stream.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            stream.close()
        self.server.shutdown()
        self.server.server_close()

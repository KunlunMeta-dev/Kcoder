"""Owned loopback SearXNG service; startup authority arrives only over stdin."""
import contextlib
import asyncio
import hmac
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
import urllib.parse
import threading


ROOT = Path(__file__).resolve().parent
sys.path[:0] = [str(ROOT), str(ROOT / "packages"), str(ROOT / "source")]


def configure_system_proxy():
    """Honor explicit proxy variables; otherwise use Windows' configured proxy."""
    proxy_names = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
    if sys.platform != "win32" or any(name in os.environ for name in proxy_names):
        return
    import urllib.request

    # NO_PROXY alone must not hide the native settings from getproxies().
    proxies = urllib.request.getproxies_registry()
    configured = False
    for scheme in ("http", "https"):
        value = proxies.get(scheme)
        if isinstance(value, str) and value:
            os.environ[scheme.upper() + "_PROXY"] = value
            configured = True
    if configured and not any(name in os.environ for name in ("NO_PROXY", "no_proxy")):
        os.environ["NO_PROXY"] = "localhost,127.0.0.1,::1"


def routed_url(session, url, kwargs):
    from curl_cffi.requests.utils import quote_path_and_params, requote_uri, update_url_params
    value = str(url)
    if getattr(session, "params", None):
        value = update_url_params(value, session.params)
    if kwargs.get("params"):
        value = update_url_params(value, kwargs["params"])
    if getattr(session, "base_url", None):
        value = urllib.parse.urljoin(session.base_url, value)
    quote = kwargs.get("quote")
    if quote:
        value = quote_path_and_params(value, quote_str=quote)
    if quote is not False:
        value = requote_uri(value)
    return urllib.parse.urldefrag(value)[0]


def origin(url):
    parsed = urllib.parse.urlsplit(url)
    return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def install_route_connection_guard(client_class):
    """A PAC decision belongs to one hop, never to a reusable Curl tunnel."""
    from curl_cffi import CurlOpt
    original_init = client_class.__init__
    def owned_init(self, **kwargs):
        options = dict(kwargs.get("curl_options") or {})
        options[CurlOpt.FRESH_CONNECT] = 1
        options[CurlOpt.FORBID_REUSE] = 1
        kwargs["curl_options"] = options
        original_init(self, **kwargs)
    client_class.__init__ = owned_init


async def parent_routed_request(guard, original, session, method, url, **kwargs):
    """Preserve Curl responses/TLS while authorizing each exact redirect hop."""
    from curl_cffi.requests.headers import Headers
    from curl_cffi.requests.cookies import Cookies
    lease = guard.parent.lease()
    follow = kwargs.get("allow_redirects")
    follow = getattr(session, "allow_redirects", True) if follow is None else bool(follow)
    limit = kwargs.get("max_redirects")
    limit = getattr(session, "max_redirects", 10) if limit is None else limit
    if not isinstance(limit, int) or limit < 0:
        raise PermissionError("Invalid parent web redirect policy")
    limit = min(limit, 10)
    if getattr(session, "proxy_auth", None):
        raise PermissionError("Session proxy authentication cannot replace a route lease")
    options = dict(kwargs)
    options.pop("proxies", None)
    options.pop("proxy_auth", None)
    options["verify"] = True
    options["allow_redirects"] = False
    options["max_redirects"] = 0
    history = []
    current = url
    method = method.upper()
    while True:
        target = routed_url(session, current, options)
        ticket, proxy = await guard.route(lease, target)
        response = None
        retained = False
        try:
            options["proxy"] = proxy
            response = await original(session, method, current, **options)
            location = response.headers.get("location")
            redirect = follow and response.status_code in (301, 302, 303, 307, 308) and location
            if not redirect:
                response.history = history
                response.redirect_count = len(history)
                if options.get("stream"):
                    previous_aclose = response.aclose
                    loop = asyncio.get_running_loop()
                    lock = threading.Lock()
                    released = False
                    async def release_once():
                        nonlocal released
                        with lock:
                            if released:
                                return
                            released = True
                        await guard.release_route(lease, ticket)
                    def close():
                        # Async Curl must settle on its own loop, even when a
                        # consumer closes the response from an engine thread.
                        guard.revoke_route(ticket)
                        if not loop.is_closed():
                            asyncio.run_coroutine_threadsafe(aclose(), loop)
                    async def aclose():
                        await release_once()
                        return await previous_aclose()
                    response.close, response.aclose = close, aclose
                    retained = True
                return response
            if len(history) >= limit:
                raise PermissionError("Parent web redirect limit reached")
            next_url = urllib.parse.urljoin(target, location)
            cross_origin = origin(target) != origin(next_url)
            if getattr(session, "params", None):
                raise PermissionError("Session query parameters cannot be safely rebound during redirects")
            headers = Headers(options.get("headers"))
            if cross_origin:
                ambient = Headers(getattr(session, "headers", None))
                if getattr(session, "auth", None) or len(getattr(session, "cookies", ())) or any(key in ambient for key in ("authorization", "cookie", "proxy-authorization", "host")):
                    raise PermissionError("Session authentication cannot cross a web redirect")
                for key in ("authorization", "cookie", "proxy-authorization", "host"):
                    headers.pop(key, None)
                options.pop("auth", None)
                options.pop("cookies", None)
            else:
                cookies = Cookies(options.get("cookies"))
                cookies.update(response.cookies)
                options["cookies"] = cookies
            if response.status_code == 303 and method != "HEAD" or response.status_code in (301, 302) and method == "POST":
                method = "GET"
                for key in ("data", "json", "content", "files", "multipart"):
                    options.pop(key, None)
                for key in ("content-type", "content-length", "transfer-encoding"):
                    headers[key] = None
            elif any(options.get(key) is not None for key in ("content", "files", "multipart")) or options.get("data") is not None and not isinstance(options["data"], (str, bytes, dict, list, tuple)):
                raise PermissionError("A streaming upload cannot be replayed across a web redirect")
            options["headers"] = headers
            options.pop("params", None)
            history.append(response)
            current = next_url
        finally:
            if not retained:
                await guard.release_route(lease, ticket)
                if response is not None and options.get("stream"):
                    await response.aclose()


def import_check():
    import flask
    import lxml.etree
    import msgspec
    import curl_cffi
    import yaml
    import valkey
    assert flask and lxml.etree and msgspec and curl_cffi and yaml and valkey
    print(json.dumps({"status": "imports_ready", "python": sys.version.split()[0]}))


def main():
    if sys.argv[1:] == ["--check"]:
        import_check()
        return
    assert not sys.argv[1:], "Unexpected launch arguments"
    line = sys.stdin.buffer.readline(65537)
    assert len(line) <= 65536 and line.endswith(b"\n"), "Invalid startup frame"
    config = json.loads(line)
    token = config["token"]
    assert isinstance(token, str) and len(token) == 64
    workspace = Path(config["workspace"]).resolve(strict=True)
    assert workspace.is_dir()
    settings_file = workspace / "settings.yml"
    assert settings_file.is_file()

    # EOF also stops startup before imports finish, and never waits for a query.
    def watch_owner():
        sys.stdin.buffer.read(1)
        os._exit(0)

    threading.Thread(target=watch_owner, name="searxng-owner", daemon=True).start()
    os.environ["SEARXNG_SETTINGS_PATH"] = str(settings_file)
    os.environ["SEARXNG_DEBUG"] = "false"
    os.environ["SEARXNG_PUBLIC_INSTANCE"] = "false"
    os.environ["SEARXNG_LIMITER"] = "false"
    os.environ.pop("SEARXNG_REDIS_URL", None)
    os.environ.pop("SEARXNG_VALKEY_URL", None)
    os.environ["TMPDIR"] = str(workspace)
    os.environ["TEMP"] = str(workspace)
    os.environ["TMP"] = str(workspace)
    tempfile.tempdir = str(workspace)
    logging.disable(logging.CRITICAL)
    if config.get("parentEgress") is None:
        configure_system_proxy()
    from egress import Egress
    egress = Egress(token, config.get("network"), config.get("parentEgress"))
    proxy = egress.start()
    # Replace inherited bypass rules as well: curl must always reach the guard.
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        os.environ[name] = proxy
    os.environ["NO_PROXY"] = ""
    os.environ["no_proxy"] = ""

    with contextlib.redirect_stdout(sys.stderr):
        # The upstream session always uses the owned egress, including engines
        # that pass per-request proxy options. TLS verification stays enabled.
        from searx.network import client as network_client
        if egress.parent is not None:
            install_route_connection_guard(network_client.AsyncClient)
        original_request = network_client.AsyncClient.request

        async def guarded_request(self, method, url, **kwargs):
            if egress.parent is not None:
                return await parent_routed_request(egress, original_request, self, method, url, **kwargs)
            kwargs.pop("proxies", None)
            kwargs["proxy"] = proxy
            kwargs["verify"] = True
            return await original_request(self, method, url, **kwargs)

        network_client.AsyncClient.request = guarded_request
        from searx.webapp import app
        from flask import request, abort
        from werkzeug.serving import make_server, WSGIRequestHandler

        @app.before_request
        def require_owner_authority():
            provided = request.headers.get("Authorization", "")
            if not hmac.compare_digest(provided, "Bearer " + token):
                abort(403)

        class PrivateRequestHandler(WSGIRequestHandler):
            def log(self, _type, _message, *args):
                # URLs contain search queries; access logs must not retain them.
                return

        server = make_server("127.0.0.1", 0, app, threaded=True, request_handler=PrivateRequestHandler)

    if egress.parent is not None:
        egress.parent.ready = True
    print(json.dumps({"protocolVersion": 1, "port": server.server_port}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Settings/parser exceptions can contain internal paths or secret values.
        print(json.dumps({"error": "searxng_start_failed", "kind": type(error).__name__}), flush=True)
        raise SystemExit(1) from None

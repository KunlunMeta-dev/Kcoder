"""Pinned Authlib transport and root-owned OpenID Provider configuration."""

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
from urllib.parse import urlsplit

from studio_account_files import AccountError, locked, read_private_json, write_private_json

MAX_RESPONSE_BYTES = 1024 * 1024
ALGORITHMS = {"RS256", "ES256"}


def root_file(path, limit=1024 * 1024):
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise AccountError("OIDC trusted file requires an absolute path")
    for parent in path.parents:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
            raise AccountError("Untrusted OIDC dependency or CA ancestor")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_nlink != 1 or info.st_size > limit:
            raise AccountError("Untrusted OIDC dependency or CA file")
        result = source.read(limit + 1)
    if len(result) > limit:
        raise AccountError("OIDC trusted file exceeds its bound")
    return result


def libraries():
    prefix = Path(__file__).resolve().parent.parent
    dependencies = prefix / "oidc-deps"
    if dependencies.exists():
        info = dependencies.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise AccountError("Untrusted OIDC dependency directory")
        if str(dependencies) not in sys.path:
            sys.path.insert(0, str(dependencies))
    try:
        requirements = root_file(prefix / "oidc" / "requirements.lock").decode()
        pins = re.findall(r"^([A-Za-z0-9_.-]+)==([^\s\\]+)", requirements, re.MULTILINE)
        if not pins:
            raise ValueError()
        for name, version in pins:
            if importlib.metadata.version(name) != version:
                raise ValueError()
        from authlib.integrations.requests_client import OAuth2Session
        from authlib.jose import JsonWebToken
        from authlib.oidc.core import CodeIDToken
        import requests
        return OAuth2Session, JsonWebToken, CodeIDToken, requests
    except Exception:
        raise AccountError("Pinned OIDC dependencies are unavailable") from None


def https_url(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 2048 or any(ord(char) < 33 for char in value):
        raise AccountError("Invalid fixed OIDC endpoint")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or parsed.query:
        raise AccountError("OIDC endpoints require fixed HTTPS origins and paths")
    try:
        parsed.port
    except ValueError:
        raise AccountError("Invalid OIDC endpoint port") from None
    return value


def client_id(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 256 or any(ord(char) < 33 for char in value):
        raise AccountError("Invalid fixed OIDC client ID")
    return value


def redirect_uri(value):
    try:
        return https_url(value)
    except AccountError:
        if not isinstance(value, str) or len(value) > 2048 or any(ord(char) < 33 for char in value):
            raise AccountError("Invalid fixed OIDC redirect URI") from None
        parsed = urlsplit(value)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1") or parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.port:
            raise AccountError("OIDC redirects require HTTPS or an explicit fixed loopback port") from None
        return value


def ca_file(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise AccountError("Invalid OIDC CA file")
    root_file(value)
    return value


def bounded_response(response):
    try:
        if response.status_code != 200:
            raise AccountError("OIDC provider request failed")
        encoding = response.headers.get("Content-Encoding", "identity").lower()
        mime = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if encoding != "identity" or not (mime == "application/json" or mime.endswith("+json")):
            raise AccountError("OIDC provider response is not bounded JSON")
        length = response.headers.get("Content-Length")
        if length is not None and (not length.isdecimal() or int(length) > MAX_RESPONSE_BYTES):
            raise AccountError("OIDC provider response exceeds its bound")
        data = bytearray()
        deadline = time.monotonic() + 10
        # One-byte reads keep the wall-clock bound effective even for a peer
        # that continually sends less than a normal HTTP read buffer.
        for chunk in response.iter_content(chunk_size=1):
            if time.monotonic() > deadline or len(data) + len(chunk) > MAX_RESPONSE_BYTES:
                raise AccountError("OIDC provider response exceeds its bound")
            data.extend(chunk)
        response._content = bytes(data)
        response._content_consumed = True
        return response
    finally:
        response.close()


def transport(config, state=None):
    OAuth2Session, _, _, _ = libraries()

    class FixedOAuthSession(OAuth2Session):
        def request(self, method, url, **kwargs):
            allowed = {config.get("discoveryEndpoint"), config.get("tokenEndpoint"), config.get("jwksUri")}
            if url not in allowed:
                raise AccountError("OIDC request left its fixed provider endpoints")
            kwargs.update(timeout=(3, 3), allow_redirects=False, stream=True, verify=config.get("caFile") or True)
            headers = dict(kwargs.get("headers") or {})
            headers["Accept-Encoding"] = "identity"
            kwargs["headers"] = headers
            try:
                return bounded_response(super().request(method, url, **kwargs))
            except Exception:
                raise AccountError("OIDC provider request failed") from None

    session = FixedOAuthSession(config["clientId"], redirect_uri=config["redirectUri"],
                                scope="openid", state=state, code_challenge_method="S256",
                                token_endpoint_auth_method="none")
    session.trust_env = False
    return session


def jwks(config):
    session = transport(config)
    try:
        keys = session.get(config["jwksUri"], withhold_token=True).json()
    finally:
        session.close()
    if not isinstance(keys, dict) or set(keys) != {"keys"} or not isinstance(keys["keys"], list) or not 1 <= len(keys["keys"]) <= 64:
        raise AccountError("OIDC provider keys are unavailable")
    for key in keys["keys"]:
        if not isinstance(key, dict) or key.get("kty") not in ("RSA", "EC") or any(name in key for name in ("d", "p", "q", "dp", "dq", "qi", "k")):
            raise AccountError("OIDC provider supplied an invalid public key")
    return keys


class OidcProviderStore:
    def __init__(self, accounts):
        self.accounts = accounts
        self.path = accounts.root / "oidc-provider.json"

    def load(self):
        value = read_private_json(self.path)
        fields = {"version", "revision", "issuer", "clientId", "redirectUri", "authorizationEndpoint", "tokenEndpoint",
                  "jwksUri", "algorithms", "caFile", "maxSessionSeconds", "loopbackPortNegotiation"}
        if not isinstance(value, dict) or set(value) != fields or value["version"] != 1 or type(value["revision"]) is not int or value["revision"] < 1:
            raise AccountError("Invalid fixed OIDC provider")
        for field in ("issuer", "authorizationEndpoint", "tokenEndpoint", "jwksUri"):
            https_url(value[field])
        redirect_uri(value["redirectUri"])
        if type(value["loopbackPortNegotiation"]) is not bool or (value["loopbackPortNegotiation"] and urlsplit(value["redirectUri"]).scheme != "http"):
            raise AccountError("Invalid OIDC native loopback policy")
        client_id(value["clientId"])
        ca_file(value["caFile"])
        if not isinstance(value["algorithms"], list) or not value["algorithms"] or any(item not in ALGORITHMS for item in value["algorithms"]) or type(value["maxSessionSeconds"]) is not int or not 60 <= value["maxSessionSeconds"] <= 86400:
            raise AccountError("Invalid OIDC algorithm or session policy")
        canonical = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        if value["caFile"]:
            canonical += root_file(value["caFile"])
        return {**value, "fingerprint": hashlib.sha256(canonical).hexdigest()}

    def configure(self, request):
        if os.geteuid() != 0:
            raise AccountError("OIDC provider configuration requires local root")
        if not isinstance(request, dict) or set(request) - {"issuer", "clientId", "redirectUri", "caFile", "maxSessionSeconds", "algorithms", "loopbackPortNegotiation"}:
            raise AccountError("Invalid OIDC provider configuration")
        issuer = https_url(request.get("issuer"))
        prepared = {"issuer": issuer, "clientId": client_id(request.get("clientId")),
                    "redirectUri": redirect_uri(request.get("redirectUri")), "caFile": ca_file(request.get("caFile")),
                    "maxSessionSeconds": request.get("maxSessionSeconds", 3600), "algorithms": request.get("algorithms", ["RS256"]),
                    "loopbackPortNegotiation": request.get("loopbackPortNegotiation", False),
                    "discoveryEndpoint": issuer.rstrip("/") + "/.well-known/openid-configuration"}
        if type(prepared["maxSessionSeconds"]) is not int or not 60 <= prepared["maxSessionSeconds"] <= 86400 or not isinstance(prepared["algorithms"], list) or not prepared["algorithms"] or any(item not in ALGORITHMS for item in prepared["algorithms"]):
            raise AccountError("Invalid OIDC algorithm or session policy")
        if type(prepared["loopbackPortNegotiation"]) is not bool or (prepared["loopbackPortNegotiation"] and urlsplit(prepared["redirectUri"]).scheme != "http"):
            raise AccountError("Invalid OIDC native loopback policy")
        session = transport(prepared)
        try:
            metadata = session.get(prepared["discoveryEndpoint"], withhold_token=True).json()
        finally:
            session.close()
        if not isinstance(metadata, dict) or metadata.get("issuer") != issuer or "code" not in metadata.get("response_types_supported", []) or "S256" not in metadata.get("code_challenge_methods_supported", []) or any(algorithm not in metadata.get("id_token_signing_alg_values_supported", []) for algorithm in prepared["algorithms"]):
            raise AccountError("OIDC discovery did not verify the fixed issuer and code/PKCE policy")
        with locked(self.accounts.lock):
            accounts = self.accounts._load()
            if not accounts.get("organizationId"):
                raise AccountError("OIDC requires an existing organization")
            try:
                previous = self.load()
            except FileNotFoundError:
                previous = None
            value = {"version": 1, "revision": previous["revision"] + 1 if previous else 1,
                     **{key: prepared[key] for key in ("issuer", "clientId", "redirectUri", "caFile", "maxSessionSeconds", "algorithms", "loopbackPortNegotiation")},
                     "authorizationEndpoint": https_url(metadata.get("authorization_endpoint")),
                     "tokenEndpoint": https_url(metadata.get("token_endpoint")), "jwksUri": https_url(metadata.get("jwks_uri"))}
            write_private_json(self.path, value)
            return {"issuer": issuer, "revision": value["revision"], "clientId": value["clientId"]}


def oidc_subject(store, value):
    if not isinstance(value, dict) or set(value) != {"issuer", "sub"}:
        raise AccountError("Invalid OIDC member binding")
    configured = OidcProviderStore(store).load()
    if value["issuer"] != configured["issuer"] or not isinstance(value["sub"], str) or not 1 <= len(value["sub"]) <= 255 or any(ord(char) < 32 for char in value["sub"]):
        raise AccountError("OIDC member binding does not match its fixed issuer")
    return {"issuer": value["issuer"], "sub": value["sub"]}

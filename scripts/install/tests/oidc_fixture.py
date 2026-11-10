"""Owned HTTPS OpenID Provider fixture with real Authlib signatures and PKCE."""

import datetime
import ipaddress
import json
from pathlib import Path
import secrets
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit


class OidcFixture:
    def __init__(self, directory):
        from authlib.jose import JsonWebKey, JsonWebToken
        from authlib.oidc.core.util import create_half_hash
        from authlib.oauth2.rfc7636 import create_s256_code_challenge
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        self.JsonWebToken, self.create_half_hash = JsonWebToken, create_half_hash
        self.challenge = create_s256_code_challenge
        self.signing_key = JsonWebKey.generate_key("RSA", 2048, is_private=True, options={"kid": "fixture-signing"})
        self.algorithm = "RS256"
        self.other_key = JsonWebKey.generate_key("RSA", 2048, is_private=True, options={"kid": "fixture-signing"})
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "owned-oidc-fixture")])
        now = datetime.datetime.now(datetime.timezone.utc)
        cert = x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=1)).add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True).add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False).sign(key, hashes.SHA256())
        self.ca_file = Path(directory) / "issuer-ca.pem"
        self.key_file = Path(directory) / "issuer-tls-key.pem"
        self.ca_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        self.key_file.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        self.ca_file.chmod(0o600)
        self.key_file.chmod(0o600)
        self.codes, self.token_requests, self.authorization_requests = {}, [], []
        self.subject, self.sid = "subject-alice", "session-alice"
        self.claim_overrides, self.header_overrides = {}, {}
        self.invalid_signature, self.redirect_jwks, self.discovery_issuer_override = False, False, None
        self.require_user_action, self.authorizations = False, {}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def emit(self, status, value):
                raw = json.dumps(value, separators=(",", ":")).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                parsed = urlsplit(self.path)
                if parsed.path == "/issuer/.well-known/openid-configuration":
                    return self.emit(200, {"issuer": owner.discovery_issuer_override or owner.issuer,
                        "authorization_endpoint": owner.base + "/authorize", "token_endpoint": owner.base + "/token",
                        "jwks_uri": owner.base + "/jwks", "response_types_supported": ["code"],
                        "code_challenge_methods_supported": ["S256"], "id_token_signing_alg_values_supported": [owner.algorithm]})
                if parsed.path == "/jwks":
                    if owner.redirect_jwks:
                        self.send_response(302); self.send_header("Location", owner.base + "/untrusted-keys"); self.end_headers(); return
                    return self.emit(200, {"keys": [owner.signing_key.as_dict(is_private=False)]})
                if parsed.path == "/authorize":
                    query = parse_qs(parsed.query)
                    owner.authorization_requests.append(query)
                    if query.get("client_id") != [owner.client_id] or query.get("response_type") != ["code"] or query.get("scope") != ["openid"] or query.get("code_challenge_method") != ["S256"] or not query.get("code_challenge") or not query.get("nonce") or query.get("redirect_uri") != [owner.redirect_uri]:
                        return self.emit(400, {"error": "invalid_request"})
                    if owner.require_user_action:
                        transaction = secrets.token_urlsafe(32)
                        owner.authorizations[transaction] = query
                        raw = ('<!doctype html><html><head><title>Owned OIDC Fixture</title></head><body>'
                               '<form method="POST" action="/authorize"><input type="hidden" name="transaction" value="' + transaction + '">'
                               '<button type="submit">Continue as fixture member</button></form></body></html>').encode()
                        self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw); return
                    return self.redirect_code(query)
                self.emit(404, {"error": "unknown_endpoint"})

            def redirect_code(self, query):
                    code = secrets.token_urlsafe(32)
                    owner.codes[code] = query
                    callback = owner.redirect_uri + "?" + urlencode({"code": code, "state": query["state"][0], "iss": owner.issuer})
                    self.send_response(302); self.send_header("Location", callback); self.end_headers(); return

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                if self.path == "/authorize" and length <= 1024:
                    form = parse_qs(self.rfile.read(length).decode())
                    original = owner.authorizations.pop(form.get("transaction", [""])[0], None)
                    if not original: return self.emit(400, {"error": "invalid_authorization"})
                    return self.redirect_code(original)
                if self.path != "/token" or length > 16384:
                    return self.emit(400, {"error": "invalid_request"})
                body = parse_qs(self.rfile.read(length).decode())
                owner.token_requests.append(body)
                original = owner.codes.pop(body.get("code", [""])[0], None)
                verifier = body.get("code_verifier", [""])[0]
                if not original or body.get("client_id") != [owner.client_id] or body.get("grant_type") != ["authorization_code"] or body.get("redirect_uri") != [owner.redirect_uri] or owner.challenge(verifier) != original["code_challenge"][0] or self.headers.get("Authorization"):
                    return self.emit(400, {"error": "invalid_grant"})
                access_token = secrets.token_urlsafe(32)
                now = int(time.time())
                claims = {"iss": owner.issuer, "sub": owner.subject, "aud": owner.client_id,
                          "iat": now, "exp": now + 300, "auth_time": now, "nonce": original["nonce"][0],
                          "at_hash": owner.create_half_hash(access_token, owner.algorithm).decode(), "sid": owner.sid,
                          "roles": ["admin"], **owner.claim_overrides}
                header = {"alg": owner.algorithm, "kid": "fixture-signing", "typ": "JWT", **owner.header_overrides}
                signing = owner.other_key if owner.invalid_signature else owner.signing_key
                token = owner.JsonWebToken([owner.algorithm]).encode(header, claims, signing).decode()
                self.emit(200, {"access_token": access_token, "token_type": "Bearer", "id_token": token,
                                "refresh_token": "synthetic-refresh-token-never-persisted"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(self.ca_file), str(self.key_file))
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.base = "https://127.0.0.1:" + str(self.server.server_address[1])
        self.issuer, self.client_id, self.redirect_uri = self.base + "/issuer", "kcoder-test-client", self.base + "/callback"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def configuration(self):
        return {"issuer": self.issuer, "clientId": self.client_id, "redirectUri": self.redirect_uri, "caFile": str(self.ca_file)}

    def authorize(self, challenge):
        import requests
        with requests.Session() as session:
            session.trust_env = False
            response = session.get(challenge["authorizationUrl"], verify=str(self.ca_file), allow_redirects=False, timeout=3)
            if response.status_code != 302:
                raise AssertionError("Owned OIDC fixture did not accept the original authorization request")
            return {"protocol": "kcoder-account-oidc-code-v1", "requestId": challenge["requestId"],
                    "authorizationResponse": response.headers["Location"]}

    def logout_token(self, subject="subject-alice", sid=None, **overrides):
        from studio_organization_oidc_logout import EVENT
        claims = {"iss": self.issuer, "aud": self.client_id, "iat": int(time.time()),
                  "jti": secrets.token_urlsafe(24), "events": {EVENT: {}}, **overrides}
        if subject is not None: claims["sub"] = subject
        if sid is not None: claims["sid"] = sid
        return self.JsonWebToken([self.algorithm]).encode({"alg": self.algorithm, "kid": "fixture-signing", "typ": "logout+jwt"}, claims, self.signing_key).decode()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

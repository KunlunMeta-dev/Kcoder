"""Authorization-code OIDC inside the existing privileged account entry.

Authlib owns OAuth/JWS/OIDC validation. Only the original root process retains
the verifier and authenticated session capability; workers receive public IDs.
"""

import hashlib
import hmac
import math
import secrets
import time
from urllib.parse import parse_qs, urlsplit, urlunsplit

from studio_account_files import AccountError, locked
from studio_accounts import public_identity
from studio_organization_oidc_provider import OidcProviderStore, jwks, libraries, transport

_PROOF = object()
LOGIN_TTL = 180
AUTH_MAX_AGE = 300


def sid_reference(issuer, sid):
    return hashlib.sha256((issuer + "\0" + sid).encode()).hexdigest()


def subject_reference(subject):
    return hashlib.sha256(subject.encode()).hexdigest()


def decode_token(config, token, keys, *, claims_class=None, options=None, parameters=None):
    _, JsonWebToken, _, _ = libraries()
    from authlib.jose import JsonWebKey
    if not isinstance(token, str) or not 1 <= len(token) <= 16384 or token.count(".") != 2:
        raise AccountError("OIDC token is invalid")

    def trusted_key(header, _payload):
        if header.get("alg") not in config["algorithms"] or any(name in header for name in ("jku", "jwk", "x5u", "x5c", "crit")):
            raise AccountError("OIDC token used an unapproved key source or algorithm")
        kid = header.get("kid")
        if not isinstance(kid, str) or not 1 <= len(kid) <= 128:
            raise AccountError("OIDC token key identity is missing")
        matching = [key for key in keys["keys"] if key.get("kid") == kid]
        if len(matching) != 1:
            raise AccountError("OIDC token key identity is unknown or ambiguous")
        selected = matching[0]
        if selected.get("use", "sig") != "sig" or selected.get("alg", header["alg"]) != header["alg"] or ("key_ops" in selected and "verify" not in selected["key_ops"]):
            raise AccountError("OIDC public key does not allow signature verification")
        key = JsonWebKey.import_key(selected)
        public = key.get_public_key()
        if header["alg"] == "RS256" and (selected.get("kty") != "RSA" or public.key_size < 2048):
            raise AccountError("OIDC RSA key is too weak or has the wrong type")
        if header["alg"] == "ES256" and (selected.get("kty") != "EC" or public.curve.name != "secp256r1"):
            raise AccountError("OIDC elliptic curve key has the wrong type")
        return key

    try:
        claims = JsonWebToken(config["algorithms"]).decode(token, trusted_key, claims_cls=claims_class,
                                                         claims_options=options, claims_params=parameters)
        claims.validate(now=time.time(), leeway=30)
        return claims
    except Exception:
        raise AccountError("OIDC token signature or claims validation failed") from None


class OidcIdentity(dict):
    """A root-memory capability, deliberately absent from JSON serialization."""
    def __init__(self, identity, session, proof):
        if proof is not _PROOF:
            raise AccountError("OIDC identity requires verified original authentication")
        super().__init__(identity)
        self._oidc_session = session


class _OidcSession:
    def __init__(self, config, record, claims, proof):
        if proof is not _PROOF:
            raise AccountError("OIDC session requires verified original authentication")
        now = time.time()
        self._proof = proof
        self.provider = config["fingerprint"]
        self.binding = {"issuer": config["issuer"], "sub": claims["sub"]}
        self.principal_id, self.revision = record["id"], record["revision"]
        self.expires_at = min(claims["exp"], now + config["maxSessionSeconds"])
        self.monotonic_expiry = time.monotonic() + max(0, self.expires_at - now)
        self.sid = claims.get("sid")

    def verify(self, store, current, member):
        config = OidcProviderStore(store).load()
        if self._proof is not _PROOF or config["fingerprint"] != self.provider or member.get("oidc") != self.binding or current["id"] != self.principal_id or current["revision"] != self.revision or time.time() >= self.expires_at or time.monotonic() >= self.monotonic_expiry:
            raise AccountError("OIDC session is expired or revoked")
        if self.sid:
            state = store._load().get("oidcState", {})
            revocation = state.get("revokedSids", {}).get(sid_reference(self.binding["issuer"], self.sid))
            if revocation and revocation["expiresAt"] > time.time() and revocation["subjectHash"] in (None, subject_reference(self.binding["sub"])):
                raise AccountError("OIDC session is revoked")


def require_oidc_identity(store, current, member, actor):
    if type(actor) is not OidcIdentity or type(actor._oidc_session) is not _OidcSession:
        raise AccountError("OIDC browser authentication is required")
    actor._oidc_session.verify(store, current, member)


class OidcLogin:
    def __init__(self, store, username, callback_port=None):
        from studio_organization import OrganizationStore
        self.store = store
        self.config = OidcProviderStore(store).load()
        if self.config["loopbackPortNegotiation"]:
            if type(callback_port) is not int or not 1 <= callback_port <= 65535:
                raise AccountError("OIDC native callback requires the Gateway listening port")
            registered = urlsplit(self.config["redirectUri"])
            host = "[::1]" if registered.hostname == "::1" else "127.0.0.1"
            self.config["redirectUri"] = urlunsplit(registered._replace(netloc=f"{host}:{callback_port}"))
        with locked(store.lock):
            accounts = store._load()
            policy = OrganizationStore(store)._load()
            current = next((item for item in accounts["accounts"] if item["username"] == username), None)
            member = policy["members"].get(current["id"]) if current else None
            if not current or current["disabled"] or not member or member["disabled"] or not member.get("oidc") or member["oidc"]["issuer"] != self.config["issuer"] or current["id"] not in accounts["bindings"]:
                raise AccountError("OIDC member requires a current enrollment and existing worker binding")
            self.principal_id, self.revision = current["id"], current["revision"]
            self.subject = dict(member["oidc"])
            self.binding = dict(accounts["bindings"][current["id"]])
        self.keys = jwks(self.config)
        self.started_at, self.deadline = time.time(), time.monotonic() + LOGIN_TTL
        self.request_id = secrets.token_urlsafe(24)
        self.state, self.nonce, self.verifier = (secrets.token_urlsafe(48) for _ in range(3))
        self.client = transport(self.config, state=self.state)
        self.authorization_url, returned_state = self.client.create_authorization_url(
            self.config["authorizationEndpoint"], state=self.state, code_verifier=self.verifier,
            nonce=self.nonce, max_age=AUTH_MAX_AGE, response_mode="query")
        if not hmac.compare_digest(returned_state, self.state):
            raise AccountError("OIDC request state was not bound")
        self.used = False

    def challenge(self):
        return {"protocol": "kcoder-account-v1", "authenticated": False, "authenticationPending": True,
                "authentication": "oidc", "requestId": self.request_id,
                "authorizationUrl": self.authorization_url, "redirectUri": self.config["redirectUri"],
                "expiresIn": LOGIN_TTL}

    def close(self):
        self.client.token = None
        self.client.close()
        self.verifier = self.nonce = self.state = ""

    def _current_account(self, accounts, policy):
        from studio_account_runtime import validate_binding
        current = next((item for item in accounts["accounts"] if item["id"] == self.principal_id), None)
        member = policy["members"].get(self.principal_id)
        if not current or current["disabled"] or current["revision"] != self.revision or not member or member["disabled"] or member.get("oidc") != self.subject or accounts["bindings"].get(self.principal_id) != self.binding or OidcProviderStore(self.store).load()["fingerprint"] != self.config["fingerprint"]:
            raise AccountError("OIDC member authority changed during authentication")
        validate_binding(self.binding, self.principal_id)
        return current, member

    def complete(self, response):
        if self.used or time.monotonic() >= self.deadline:
            raise AccountError("OIDC original request is expired or consumed")
        self.used = True
        if not isinstance(response, dict) or set(response) != {"protocol", "requestId", "authorizationResponse"} or response["protocol"] != "kcoder-account-oidc-code-v1" or not isinstance(response["requestId"], str) or not hmac.compare_digest(response["requestId"], self.request_id):
            self.client.close()
            raise AccountError("OIDC response did not match its original request")
        returned = response["authorizationResponse"]
        if not isinstance(returned, str) or len(returned) > 8192:
            self.client.close()
            raise AccountError("OIDC authorization response exceeds its bound")
        parsed, expected = urlsplit(returned), urlsplit(self.config["redirectUri"])
        if (parsed.scheme, parsed.netloc, parsed.path) != (expected.scheme, expected.netloc, expected.path) or parsed.fragment or parsed.username or parsed.password:
            self.client.close()
            raise AccountError("OIDC redirect left its original callback")
        query = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=16)
        if any(len(values) != 1 for values in query.values()) or "code" not in query or "state" not in query or not hmac.compare_digest(query["state"][0], self.state) or len(query["code"][0]) > 4096 or not query["code"][0] or ("iss" in query and query["iss"][0] != self.config["issuer"]):
            self.client.close()
            raise AccountError("OIDC response state or issuer did not match")
        try:
            from studio_organization import OrganizationStore
            with locked(self.store.lock):
                self._current_account(self.store._load(), OrganizationStore(self.store)._load())
            token = self.client.fetch_token(self.config["tokenEndpoint"], authorization_response=returned,
                                           code_verifier=self.verifier, grant_type="authorization_code")
            if not isinstance(token, dict) or not isinstance(token.get("access_token"), str) or not 1 <= len(token["access_token"]) <= 8192 or str(token.get("token_type", "")).lower() != "bearer":
                raise AccountError("OIDC code exchange did not return its required token set")
            _, _, CodeIDToken, _ = libraries()
            self.keys = jwks(self.config)
            claims = decode_token(self.config, token.get("id_token"), self.keys, claims_class=CodeIDToken,
                options={"iss": {"essential": True, "value": self.config["issuer"]},
                         "aud": {"essential": True, "value": self.config["clientId"]},
                         "sub": {"essential": True, "value": self.subject["sub"]}},
                parameters={"client_id": self.config["clientId"], "nonce": self.nonce,
                            "access_token": token["access_token"], "max_age": AUTH_MAX_AGE})
            now = time.time()
            if any(type(claims.get(field)) not in (int, float) or not math.isfinite(claims[field]) for field in ("iat", "exp", "auth_time")) or claims["iat"] < self.started_at - 30 or claims["iat"] > now + 30 or claims["exp"] <= now or claims["auth_time"] < now - AUTH_MAX_AGE - 30 or claims["auth_time"] > now + 30:
                raise AccountError("OIDC authentication is expired or not bound to the original login")
            if "sid" in claims and (not isinstance(claims["sid"], str) or not 1 <= len(claims["sid"]) <= 255):
                raise AccountError("OIDC session identity is invalid")
            with locked(self.store.lock):
                accounts = self.store._load()
                policy = OrganizationStore(self.store)._load()
                current, member = self._current_account(accounts, policy)
                session = _OidcSession(self.config, current, claims, _PROOF)
                session.verify(self.store, current, member)
                return OidcIdentity(public_identity(current), session, _PROOF)
        except AccountError:
            raise
        except Exception:
            raise AccountError("OIDC code exchange or authentication failed") from None
        finally:
            self.close()

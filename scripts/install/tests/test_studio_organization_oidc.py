"""Real HTTPS/OAuth/PKCE/JWS protocol tests; OS binding is a declared fixture."""

import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_account_files import AccountError, read_private_json, write_private_json
from studio_accounts import AccountStore
from studio_organization import OrganizationStore
from studio_organization_oidc import OidcIdentity, OidcLogin
from studio_organization_oidc_logout import logout
from studio_organization_oidc_provider import OidcProviderStore, libraries


def dependencies_available():
    try:
        libraries()
        return True
    except AccountError:
        return False


@unittest.skipUnless(os.geteuid() == 0 and dependencies_available(), "Root and the exact hashed OIDC dependencies are required")
class OidcProtocolTests(unittest.TestCase):
    def setUp(self):
        from oidc_fixture import OidcFixture
        self.temporary = tempfile.TemporaryDirectory(prefix="kcoder-oidc-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.issuer = OidcFixture(self.root)
        self.addCleanup(self.issuer.close)
        self.store = AccountStore(self.root / "accounts")
        self.alice = self.store.create("alice", "synthetic-local-password")
        self.organization = OrganizationStore(self.store)
        self.organization.configure("fixture-oidc")
        OidcProviderStore(self.store).configure(self.issuer.configuration())
        self.organization.administer(None, {"operation": "organization.member", "principalId": self.alice["id"], "roles": ["member"],
                                             "oidc": {"issuer": self.issuer.issuer, "sub": "subject-alice"}})
        data = self.store._load()
        data["bindings"][self.alice["id"]] = {"uid": 22001, "gid": 22001, "home": "/synthetic-worker", "instance": data["instance"]}
        write_private_json(self.store.path, data)
        # The real host suite separately checks OS adoption/drop. This protocol
        # suite tests real TLS, library signatures, current storage and receipts.
        self.binding = patch("studio_account_runtime.validate_binding")
        self.binding.start()
        self.addCleanup(self.binding.stop)

    def begin(self):
        flow = OidcLogin(self.store, "alice")
        self.addCleanup(flow.close)
        return flow

    def authenticate(self):
        flow = self.begin()
        return flow.complete(self.issuer.authorize(flow.challenge()))

    def test_original_code_flow_has_state_nonce_pkce_and_stable_uuid_not_token_role(self):
        flow = self.begin()
        challenge = flow.challenge()
        identity = flow.complete(self.issuer.authorize(challenge))
        self.assertIs(type(identity), OidcIdentity)
        self.assertEqual(identity["id"], self.alice["id"])
        self.assertEqual(identity["username"], "alice")
        self.assertEqual(identity["role"], "user")
        self.assertTrue(self.store.session_current(identity))
        query, token_request = self.issuer.authorization_requests[0], self.issuer.token_requests[0]
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertNotIn("code_verifier", query)
        self.assertEqual(query["code_challenge"][0], self.issuer.challenge(token_request["code_verifier"][0]))
        raw = self.store.path.read_text() + self.organization.path.read_text() + json.dumps(identity)
        for forbidden in ("synthetic-refresh-token", "access_token", "id_token", "code_verifier"):
            self.assertNotIn(forbidden, raw)
        self.assertNotIn(flow.request_id, raw)

    def test_plain_caller_identity_and_password_cannot_reconstruct_oidc_capability(self):
        identity = self.authenticate()
        self.assertFalse(self.store.session_current(dict(identity)))
        with self.assertRaisesRegex(AccountError, "OIDC browser"):
            self.store.authenticate("alice", "synthetic-local-password")
        with self.assertRaises(AccountError):
            self.organization.administer({**dict(identity), "role": "admin", "approved": True}, {"operation": "organization.self"})

    def test_state_request_and_redirect_are_bound_before_any_token_exchange(self):
        for variant in ("state", "request", "redirect", "issuer"):
            with self.subTest(variant=variant):
                flow = self.begin()
                callback = self.issuer.authorize(flow.challenge())
                parts = urlsplit(callback["authorizationResponse"])
                query = parse_qs(parts.query)
                if variant == "state": query["state"] = ["not-original-state"]
                elif variant == "request": callback["requestId"] = "not-original-request"
                elif variant == "redirect": parts = parts._replace(path="/wrong-callback")
                else: query["iss"] = ["https://untrusted.example"]
                callback["authorizationResponse"] = urlunsplit(parts._replace(query=urlencode({key: value[0] for key, value in query.items()})))
                before = len(self.issuer.token_requests)
                with self.assertRaises(AccountError): flow.complete(callback)
                self.assertEqual(len(self.issuer.token_requests), before)

    def test_nonce_issuer_audience_subject_expiry_and_signature_are_verified(self):
        cases = [{"nonce": "unbound-nonce"}, {"iss": "https://untrusted.example"}, {"aud": "another-client"},
                 {"sub": "subject-bob"}, {"exp": int(time.time()) - 120}, {"iat": int(time.time()) - 3600},
                 {"auth_time": int(time.time()) - 3600}, {"at_hash": "not-access-token-hash"}]
        for overrides in cases:
            with self.subTest(overrides=list(overrides)):
                self.issuer.claim_overrides = overrides
                flow = self.begin()
                with self.assertRaises(AccountError): flow.complete(self.issuer.authorize(flow.challenge()))
        self.issuer.claim_overrides = {}
        self.issuer.invalid_signature = True
        flow = self.begin()
        with self.assertRaises(AccountError): flow.complete(self.issuer.authorize(flow.challenge()))

    def test_untrusted_jwk_header_and_discovery_redirect_do_not_supply_trusted_keys(self):
        self.issuer.header_overrides = {"jwk": self.issuer.other_key.as_dict(is_private=False)}
        flow = self.begin()
        with self.assertRaises(AccountError): flow.complete(self.issuer.authorize(flow.challenge()))
        self.issuer.redirect_jwks = True
        with self.assertRaises(AccountError): self.begin()

    def test_request_is_single_use_and_pending_revision_change_blocks_runtime_authority(self):
        flow = self.begin()
        callback = self.issuer.authorize(flow.challenge())
        self.store.revoke_sessions("alice")
        with self.assertRaisesRegex(AccountError, "authority changed"):
            flow.complete(callback)
        self.assertEqual(self.issuer.token_requests, [])
        with self.assertRaisesRegex(AccountError, "consumed"):
            flow.complete(callback)

    def test_provider_configuration_change_and_expiry_reach_existing_identity(self):
        identity = self.authenticate()
        config = read_private_json(OidcProviderStore(self.store).path)
        config["revision"] += 1
        write_private_json(OidcProviderStore(self.store).path, config)
        self.assertFalse(self.store.session_current(identity))
        identity = self.authenticate()
        identity._oidc_session.monotonic_expiry = time.monotonic() - 1
        self.assertFalse(self.store.session_current(identity))

    def test_logout_sid_is_precise_and_exact_replay_cannot_revoke_new_session(self):
        first = self.authenticate()
        self.issuer.sid = "session-alice-second"
        second = self.authenticate()
        token = self.issuer.logout_token(sid="session-alice")
        self.assertEqual(logout(self.store, token), {"processed": True, "replayed": False})
        self.assertFalse(self.store.session_current(first))
        self.assertTrue(self.store.session_current(second))
        self.assertEqual(logout(self.store, token), {"processed": True, "replayed": True})
        self.assertTrue(self.store.session_current(second))

    def test_sub_logout_advances_native_epoch_with_atomic_replay_receipt(self):
        identity = self.authenticate()
        before = self.store._load()["accounts"][0]["revision"]
        token = self.issuer.logout_token()
        logout(self.store, token)
        self.assertEqual(self.store._load()["accounts"][0]["revision"], before + 1)
        self.assertFalse(self.store.session_current(identity))
        current = self.authenticate()
        logout(self.store, token)
        self.assertTrue(self.store.session_current(current))
        raw = self.store.path.read_text()
        self.assertNotIn(token, raw)
        self.assertNotIn("subject-alice", json.dumps(self.store._load()["oidcState"]))

    def test_logout_rejects_id_token_confusion_nonce_old_event_and_jti_conflict(self):
        for overrides in ({"nonce": "id-token-nonce"}, {"events": {}}, {"iat": int(time.time()) - 3600}, {"aud": "other-client"}):
            with self.subTest(overrides=list(overrides)):
                before = self.store.path.read_bytes()
                with self.assertRaises(AccountError): logout(self.store, self.issuer.logout_token(**overrides))
                self.assertEqual(self.store.path.read_bytes(), before)
        first = self.issuer.logout_token(jti="original-logout-event")
        logout(self.store, first)
        with self.assertRaisesRegex(AccountError, "conflicts"):
            logout(self.store, self.issuer.logout_token(subject="subject-bob", jti="original-logout-event"))

    def test_fixed_issuer_configuration_is_not_discovery_or_caller_override(self):
        self.issuer.discovery_issuer_override = "https://different.example"
        before = OidcProviderStore(self.store).path.read_bytes()
        with self.assertRaises(AccountError): OidcProviderStore(self.store).configure(self.issuer.configuration())
        self.assertEqual(before, OidcProviderStore(self.store).path.read_bytes())
        with self.assertRaises(AccountError): OidcProviderStore(self.store).configure({**self.issuer.configuration(), "publicKey": self.issuer.other_key.as_dict(is_private=False)})

    def test_es256_public_key_and_access_hash_use_the_same_fixed_provider_policy(self):
        from authlib.jose import JsonWebKey
        self.issuer.algorithm = "ES256"
        self.issuer.signing_key = JsonWebKey.generate_key("EC", "P-256", is_private=True, options={"kid": "fixture-signing"})
        OidcProviderStore(self.store).configure({**self.issuer.configuration(), "algorithms": ["ES256"]})
        identity = self.authenticate()
        self.assertTrue(self.store.session_current(identity))
        logout(self.store, self.issuer.logout_token())
        self.assertFalse(self.store.session_current(identity))


if __name__ == "__main__":
    unittest.main()

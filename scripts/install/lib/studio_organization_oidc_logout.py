"""Verified OIDC back-channel logout in the existing atomic account store."""

import hashlib
import math
import time

from studio_account_files import AccountError, locked, write_private_json
from studio_organization_oidc import decode_token, sid_reference, subject_reference
from studio_organization_oidc_provider import OidcProviderStore, jwks

EVENT = "http://schemas.openid.net/event/backchannel-logout"


def logout(store, token):
    if not isinstance(token, str) or not 1 <= len(token) <= 16384:
        raise AccountError("Invalid OIDC logout token")
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    # Exact known content can reconcile a lost logout response without replaying
    # revocation against a newly authenticated session or requiring an old key.
    with locked(store.lock):
        accounts = store._load()
        previous = accounts.get("oidcState", {}).get("receipts", {})
        if any(item["tokenHash"] == token_hash for item in previous.values()):
            return {"processed": True, "replayed": True}
    config = OidcProviderStore(store).load()
    claims = decode_token(config, token, jwks(config),
        options={"iss": {"essential": True, "value": config["issuer"]},
                 "aud": {"essential": True, "value": config["clientId"]},
                 "iat": {"essential": True}, "jti": {"essential": True}, "events": {"essential": True}})
    now = time.time()
    if "nonce" in claims or claims.get("events") != {EVENT: {}} or type(claims.get("iat")) not in (int, float) or not math.isfinite(claims["iat"]) or not now - 330 <= claims["iat"] <= now + 30 or not isinstance(claims.get("jti"), str) or not 1 <= len(claims["jti"]) <= 255:
        raise AccountError("OIDC logout token has invalid event, time or replay identity")
    subject, sid = claims.get("sub"), claims.get("sid")
    if subject is None and sid is None:
        raise AccountError("OIDC logout must identify its original subject or session")
    if any(value is not None and (not isinstance(value, str) or not 1 <= len(value) <= 255) for value in (subject, sid)):
        raise AccountError("OIDC logout subject or session is invalid")
    receipt_id = hashlib.sha256((config["issuer"] + "\0" + claims["jti"]).encode()).hexdigest()
    from studio_organization import OrganizationStore
    with locked(store.lock):
        accounts = store._load()
        policy = OrganizationStore(store)._load()
        if OidcProviderStore(store).load()["fingerprint"] != config["fingerprint"]:
            raise AccountError("OIDC provider authority changed during logout")
        state = accounts.setdefault("oidcState", {"receipts": {}, "revokedSids": {}})
        existing = state["receipts"].get(receipt_id)
        if existing:
            if existing["tokenHash"] != token_hash:
                raise AccountError("OIDC logout replay identity conflicts with different content")
            return {"processed": True, "replayed": True}
        state["receipts"] = {key: value for key, value in state["receipts"].items() if value["processedAt"] >= now - 660}
        state["revokedSids"] = {key: value for key, value in state["revokedSids"].items() if value["expiresAt"] > now}
        if len(state["receipts"]) >= 4096 or (sid and len(state["revokedSids"]) >= 4096):
            raise AccountError("OIDC logout receipt capacity reached")
        if sid:
            state["revokedSids"][sid_reference(config["issuer"], sid)] = {
                "subjectHash": subject_reference(subject) if subject else None,
                "expiresAt": now + config["maxSessionSeconds"] + 30}
        else:
            affected = {principal for principal, member in policy["members"].items()
                        if member.get("oidc") == {"issuer": config["issuer"], "sub": subject}}
            for account in accounts["accounts"]:
                if account["id"] in affected:
                    account["revision"] += 1
        state["receipts"][receipt_id] = {"tokenHash": token_hash, "processedAt": now}
        # The identity epoch or SID revocation and its receipt share one atomic
        # replacement. No bearer token, JWT, password or caller metadata is saved.
        write_private_json(store.path, accounts)
        return {"processed": True, "replayed": False}

"""Portable KCoder identities; local Linux bindings never enter identity exports."""

import base64
import hashlib
import hmac
import math
import os
from pathlib import Path
import re
import time
import uuid

from studio_account_files import AccountError, locked, read_private_json, trusted_directory, write_private_json

MAX_ACCOUNTS = 1000
SCHEME = "scrypt-v1"


def username(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_.-]{1,31}", value):
        raise AccountError("Account names require 2–32 lowercase letters, digits, dots, hyphens or underscores")
    return value


def secret_bytes(password):
    if not isinstance(password, str) or not 12 <= len(password.encode()) <= 1024 or "\0" in password:
        raise AccountError("Passwords require 12–1024 UTF-8 bytes without NUL")
    return password.encode()


def password_hash(password):
    salt = os.urandom(16)
    result = hashlib.scrypt(secret_bytes(password), salt=salt, n=32768, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32)
    return {"scheme": SCHEME, "salt": base64.b64encode(salt).decode(), "hash": base64.b64encode(result).decode()}


def validate_hash(record):
    if not isinstance(record, dict) or set(record) != {"scheme", "salt", "hash"} or record["scheme"] != SCHEME:
        raise AccountError("Unsupported password hash")
    try:
        salt = base64.b64decode(record["salt"], validate=True)
        digest = base64.b64decode(record["hash"], validate=True)
    except (TypeError, ValueError) as error:
        raise AccountError("Invalid password hash") from error
    if len(salt) != 16 or len(digest) != 32:
        raise AccountError("Invalid password hash length")
    return salt, digest


def verify_password(password, record):
    salt, expected = validate_hash(record)
    try:
        raw = secret_bytes(password)
    except AccountError:
        return False
    actual = hashlib.scrypt(raw, salt=salt, n=32768, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32)
    return hmac.compare_digest(actual, expected)


def validate_identity(record):
    if not isinstance(record, dict) or set(record) != {"id", "username", "role", "disabled", "password", "revision"}:
        raise AccountError("Invalid identity record")
    try:
        canonical = str(uuid.UUID(record["id"]))
    except (ValueError, TypeError, AttributeError) as error:
        raise AccountError("Invalid identity ID") from error
    if canonical != record["id"]:
        raise AccountError("Identity ID must be canonical")
    username(record["username"])
    if record["role"] not in ("admin", "user") or type(record["disabled"]) is not bool:
        raise AccountError("Invalid identity role or status")
    if type(record["revision"]) is not int or not 1 <= record["revision"] <= 2**53:
        raise AccountError("Invalid identity revision")
    validate_hash(record["password"])
    return record


def public_identity(record):
    return {name: record[name] for name in ("id", "username", "role", "disabled", "revision")}


class AccountStore:
    def __init__(self, root=Path("/var/lib/kcoder/accounts")):
        self.root = trusted_directory(root)
        self.path = self.root / "accounts.json"
        self.lock = self.root / ".accounts.lock"

    def _load(self):
        try:
            data = read_private_json(self.path)
        except FileNotFoundError:
            return {"version": 1, "instance": str(uuid.uuid4()), "accounts": [], "bindings": {}, "attempts": {}}
        fields = {"version", "instance", "accounts", "bindings", "attempts"}
        if not isinstance(data, dict) or data.get("version") != 1 or set(data) - {"organizationId", "oidcState"} != fields:
            raise AccountError("Unsupported account store")
        if "organizationId" in data and (not isinstance(data["organizationId"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}", data["organizationId"]) or ".." in data["organizationId"]):
            raise AccountError("Invalid organization account binding")
        if "oidcState" in data:
            state = data["oidcState"]
            if not data.get("organizationId") or not isinstance(state, dict) or set(state) != {"receipts", "revokedSids"} or any(not isinstance(state[key], dict) or len(state[key]) > 4096 for key in state):
                raise AccountError("Invalid OIDC account revocation state")
            for key, item in state["receipts"].items():
                if not re.fullmatch(r"[0-9a-f]{64}", key) or not isinstance(item, dict) or set(item) != {"tokenHash", "processedAt"} or not isinstance(item["tokenHash"], str) or not re.fullmatch(r"[0-9a-f]{64}", item["tokenHash"]) or type(item["processedAt"]) not in (int, float) or not math.isfinite(item["processedAt"]):
                    raise AccountError("Invalid OIDC account receipt")
            for key, item in state["revokedSids"].items():
                if not re.fullmatch(r"[0-9a-f]{64}", key) or not isinstance(item, dict) or set(item) != {"subjectHash", "expiresAt"} or (item["subjectHash"] is not None and (not isinstance(item["subjectHash"], str) or not re.fullmatch(r"[0-9a-f]{64}", item["subjectHash"]))) or type(item["expiresAt"]) not in (int, float) or not math.isfinite(item["expiresAt"]):
                    raise AccountError("Invalid OIDC session revocation")
        try:
            if str(uuid.UUID(data["instance"])) != data["instance"]:
                raise ValueError()
        except (ValueError, TypeError, AttributeError) as error:
            raise AccountError("Invalid account-store instance") from error
        self._validate_accounts(data["accounts"])
        if not isinstance(data["bindings"], dict) or not isinstance(data["attempts"], dict):
            raise AccountError("Invalid local account state")
        return data

    @staticmethod
    def _validate_accounts(accounts):
        if not isinstance(accounts, list) or len(accounts) > MAX_ACCOUNTS:
            raise AccountError("Invalid account count")
        ids, names = set(), set()
        for record in accounts:
            validate_identity(record)
            if record["id"] in ids or record["username"] in names:
                raise AccountError("Duplicate account identity")
            ids.add(record["id"])
            names.add(record["username"])

    def _require_current_administrator(self, data, actor):
        # None is reserved for the local root operator. Remote dispatch always
        # supplies its authenticated entry context, never an actor from JSON.
        if actor is None:
            return
        if not isinstance(actor, dict):
            raise AccountError("Account authorization has changed")
        current = next((item for item in data["accounts"] if item["id"] == actor.get("id")), None)
        if not current or current["disabled"] or current["revision"] != actor.get("revision"):
            raise AccountError("Account authorization has changed")
        if current["role"] != "admin":
            raise AccountError("Account administrator role required")
        from studio_organization import OrganizationStore
        OrganizationStore(self).require_current_account(current, actor)

    def create(self, name, password, role="user", *, actor=None):
        name = username(name)
        record = {"id": str(uuid.uuid4()), "username": name, "role": role, "disabled": False,
                  "password": password_hash(password), "revision": 1}
        validate_identity(record)
        with locked(self.lock):
            data = self._load()
            self._require_current_administrator(data, actor)
            data["accounts"].append(record)
            self._validate_accounts(data["accounts"])
            write_private_json(self.path, data)
        return public_identity(record)

    def list(self, *, actor=None):
        with locked(self.lock):
            data = self._load()
            self._require_current_administrator(data, actor)
            return [public_identity(record) for record in data["accounts"]]

    def set_disabled(self, name, disabled, *, actor=None):
        with locked(self.lock):
            data = self._load()
            self._require_current_administrator(data, actor)
            record = next((item for item in data["accounts"] if item["username"] == username(name)), None)
            if record is None:
                raise AccountError("Unknown account")
            if record["disabled"] != disabled:
                record["disabled"] = disabled
                record["revision"] += 1
            write_private_json(self.path, data)
            return public_identity(record)

    def session_current(self, identity):
        with locked(self.lock):
            current = next((item for item in self._load()["accounts"] if item["id"] == identity["id"]), None)
            if not current or current["disabled"] or current["revision"] != identity["revision"]:
                return False
            try:
                from studio_organization import OrganizationStore
                OrganizationStore(self).require_current_account(current, identity)
            except Exception:
                return False
            return True

    def revoke_sessions(self, name, *, actor=None):
        with locked(self.lock):
            data = self._load()
            self._require_current_administrator(data, actor)
            record = next((item for item in data["accounts"] if item["username"] == username(name)), None)
            if record is None:
                raise AccountError("Unknown account")
            record["revision"] += 1
            write_private_json(self.path, data)
            return public_identity(record)

    def authenticate(self, name, password, now=None):
        from studio_organization import OrganizationStore
        mapping = OrganizationStore(self).mapped_directory_login(name)
        if mapping is not None:
            # The existing login form names the stable KCoder account. Its
            # authoritative private enrollment selects the PAM subject. Caller
            # JSON cannot select an issuer, and local passwords cannot bypass it.
            from studio_organization_directory import authenticate_directory
            identity = authenticate_directory(self, mapping["subject"]["username"], password)
            if identity["id"] != mapping["principalId"] or identity["username"] != name or identity["revision"] != mapping["revision"]:
                raise AccountError("Account authorization has changed")
            return identity
        now = time.time() if now is None else now
        with locked(self.lock):
            data = self._load()
            record = next((item for item in data["accounts"] if item["username"] == name), None)
            key = record["id"] if record else "unknown"
            attempt = data["attempts"].get(key, {"count": 0, "until": 0})
            if attempt["until"] > now:
                raise AccountError("Account authentication failed")
            if attempt["until"]:
                attempt = {"count": 0, "until": 0}
            dummy = {"scheme": SCHEME, "salt": base64.b64encode(bytes(16)).decode(), "hash": base64.b64encode(bytes(32)).decode()}
            valid = verify_password(password, record["password"] if record else dummy)
            if not record or record["disabled"] or not valid:
                attempt["count"] += 1
                if attempt["count"] >= 5:
                    attempt["until"] = now + 60
                data["attempts"][key] = attempt
                write_private_json(self.path, data)
                raise AccountError("Account authentication failed")
            data["attempts"].pop(key, None)
            from studio_organization import OrganizationStore
            OrganizationStore(self).require_current_account(record)
            write_private_json(self.path, data)
            return public_identity(record)

    def export_identities(self, destination):
        bundle = self.export_bundle()
        write_private_json(destination, bundle, replace=False)
        return {"accounts": len(bundle["accounts"]), "path": str(destination)}

    def export_bundle(self, *, actor=None):
        with locked(self.lock):
            data = self._load()
            self._require_current_administrator(data, actor)
            return {"format": "kcoder-identities", "version": 1, "accounts": data["accounts"]}

    def import_identities(self, source):
        return self.import_bundle(read_private_json(source))

    def import_bundle(self, bundle, *, actor=None):
        if not isinstance(bundle, dict) or set(bundle) != {"format", "version", "accounts"} or bundle["format"] != "kcoder-identities" or bundle["version"] != 1:
            raise AccountError("Unsupported identity export")
        self._validate_accounts(bundle["accounts"])
        with locked(self.lock):
            data = self._load()
            self._require_current_administrator(data, actor)
            added = 0
            for incoming in bundle["accounts"]:
                existing = next((item for item in data["accounts"] if item["id"] == incoming["id"] or item["username"] == incoming["username"]), None)
                if existing and existing != incoming:
                    raise AccountError("Identity import conflicts with an existing account")
                if not existing:
                    data["accounts"].append(incoming)
                    added += 1
            self._validate_accounts(data["accounts"])
            write_private_json(self.path, data)
            return {"added": added, "total": len(data["accounts"])}

    def change_password(self, name, password, *, actor=None):
        encoded = password_hash(password)
        with locked(self.lock):
            data = self._load()
            self._require_current_administrator(data, actor)
            record = next((item for item in data["accounts"] if item["username"] == username(name)), None)
            if not record:
                raise AccountError("Unknown account")
            record["password"] = encoded
            record["revision"] += 1
            data["attempts"].pop(record["id"], None)
            write_private_json(self.path, data)
            return public_identity(record)

    def administer(self, actor, request):
        if not isinstance(actor, dict) or not isinstance(request, dict) or not isinstance(request.get("operation"), str):
            raise AccountError("Invalid account operation")
        operation = request["operation"]
        if operation.startswith("organization."):
            from studio_organization import OrganizationStore
            return OrganizationStore(self).administer(actor, request)
        allowed = {"list": {"operation"}, "create": {"operation", "username", "password", "role"},
                   "revoke": {"operation", "username"},
                   "disable": {"operation", "username"}, "enable": {"operation", "username"},
                   "password": {"operation", "username", "password"}, "export": {"operation"},
                   "import": {"operation", "bundle"}}
        if operation not in allowed or set(request) - allowed[operation]:
            raise AccountError("Unsupported account operation")
        if operation == "list":
            return self.list(actor=actor)
        if operation == "create":
            return self.create(request.get("username"), request.get("password"), request.get("role", "user"), actor=actor)
        if operation in ("disable", "enable"):
            return self.set_disabled(request.get("username"), operation == "disable", actor=actor)
        if operation == "revoke":
            return self.revoke_sessions(request.get("username"), actor=actor)
        if operation == "password":
            return self.change_password(request.get("username"), request.get("password"), actor=actor)
        if operation == "export":
            return self.export_bundle(actor=actor)
        return self.import_bundle(request.get("bundle"), actor=actor)

"""Memory-only resume authority owned by the original account supervisor."""

import hmac
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import struct
import time

from studio_account_files import AccountError, locked
from studio_accounts import public_identity
from studio_organization_oidc import OidcIdentity, _OidcSession, _PROOF
from studio_organization_oidc_provider import OidcProviderStore

HEX = re.compile(r"[0-9a-f]{64}")
BINDING = re.compile(r"[A-Za-z0-9_-]{32,128}")


def reference(value):
    if not isinstance(value, dict) or set(value) != {"handle", "secret", "clientBinding"} or not isinstance(value["handle"], str) or not HEX.fullmatch(value["handle"]) or not isinstance(value["secret"], str) or not HEX.fullmatch(value["secret"]) or not isinstance(value["clientBinding"], str) or not BINDING.fullmatch(value["clientBinding"]):
        raise AccountError("Invalid native OIDC resume authority")
    return value


class OidcResumeAuthority:
    def __init__(self, store, identity, client_binding):
        if type(identity) is not OidcIdentity or not isinstance(client_binding, str) or not BINDING.fullmatch(client_binding):
            raise AccountError("OIDC resume requires the original verified owner")
        self.store, self.identity = store, identity
        self.owner_pid = os.getpid()
        self.reference = {"handle": secrets.token_hex(32), "secret": secrets.token_hex(32), "clientBinding": client_binding}
        self.path = store.root / (".oidc-" + self.reference["handle"] + ".sock")
        self.directory_fd = os.open(store.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        # A handle-relative procfs alias avoids Unix sun_path limits without
        # accepting any caller-supplied path or abstract socket namespace.
        self.listener.bind(f"/proc/self/fd/{self.directory_fd}/{self.path.name}")
        os.chmod(self.path, 0o600)
        info = self.path.lstat()
        self.path_identity = (info.st_dev, info.st_ino)
        self.listener.listen(4)
        self.listener.setblocking(False)

    def child_started(self):
        self.listener.close()
        if self.directory_fd is not None:
            os.close(self.directory_fd)
            self.directory_fd = None

    def process(self):
        connection, _ = self.listener.accept()
        with connection:
            connection.settimeout(3)
            peer_pid, peer_uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            try:
                raw, _, flags, _ = connection.recvmsg(8192)
                request = json.loads(raw)
                if peer_uid != 0 or peer_pid <= 0 or flags & socket.MSG_TRUNC or not isinstance(request, dict) or set(request) != {"protocol", "username", "authority"} or request["protocol"] != "kcoder-oidc-resume-v1" or request["username"] != self.identity["username"]:
                    raise AccountError("OIDC resume owner did not match")
                supplied = reference(request["authority"])
                if any(not hmac.compare_digest(supplied[field], self.reference[field]) for field in self.reference):
                    raise AccountError("OIDC resume owner did not match")
                if not self.store.session_current(self.identity):
                    raise AccountError("OIDC resume authority is expired or revoked")
                session = self.identity._oidc_session
                response = {"ok": True, "issuerPid": os.getpid(), "identity": dict(self.identity),
                            "session": {"provider": session.provider, "binding": session.binding,
                                        "expiresAt": session.expires_at, "monotonicExpiry": session.monotonic_expiry,
                                        "sid": session.sid}}
            except Exception:
                response = {"ok": False}
            connection.send(json.dumps(response, separators=(",", ":")).encode())

    def close(self):
        self.listener.close()
        if self.directory_fd is not None:
            os.close(self.directory_fd)
            self.directory_fd = None
        if os.getpid() != self.owner_pid:
            return
        try:
            current = self.path.lstat()
            if (current.st_dev, current.st_ino) == self.path_identity and stat.S_ISSOCK(current.st_mode) and current.st_uid == 0:
                self.path.unlink()
        except FileNotFoundError:
            pass


def resume_identity(store, username, authority):
    supplied = reference(authority)
    path = store.root / (".oidc-" + supplied["handle"] + ".sock")
    info = path.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
        raise AccountError("Native OIDC resume socket is unavailable")
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    directory_fd = os.open(store.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        connection.settimeout(4)
        connection.connect(f"/proc/self/fd/{directory_fd}/{path.name}")
        peer_pid, peer_uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if peer_uid != 0 or peer_pid <= 0:
            raise AccountError("Native OIDC resume issuer is untrusted")
        connection.send(json.dumps({"protocol": "kcoder-oidc-resume-v1", "username": username, "authority": supplied}).encode())
        raw, _, flags, _ = connection.recvmsg(8192)
        receipt = json.loads(raw)
        if flags & socket.MSG_TRUNC or not receipt.get("ok") or receipt.get("issuerPid") != peer_pid:
            raise AccountError("Native OIDC resume authority is expired or revoked")
    except AccountError:
        raise
    except Exception:
        raise AccountError("Native OIDC resume authority is unavailable") from None
    finally:
        connection.close()
        os.close(directory_fd)
    from studio_organization import OrganizationStore
    from studio_account_runtime import validate_binding
    with locked(store.lock):
        accounts = store._load()
        policy = OrganizationStore(store)._load()
        signed = receipt.get("identity")
        details = receipt.get("session")
        if not isinstance(signed, dict) or set(signed) != {"id", "username", "role", "disabled", "revision"} or not isinstance(details, dict) or set(details) != {"provider", "binding", "expiresAt", "monotonicExpiry", "sid"}:
            raise AccountError("Native OIDC resume receipt is invalid")
        current = next((item for item in accounts["accounts"] if item["id"] == signed["id"]), None)
        member = policy["members"].get(signed["id"])
        config = OidcProviderStore(store).load()
        if not current or current["disabled"] or current["username"] != username or public_identity(current) != signed or not member or member["disabled"] or member.get("oidc") != details["binding"] or config["fingerprint"] != details["provider"]:
            raise AccountError("Native OIDC resume identity has changed")
        binding = accounts["bindings"].get(current["id"])
        if not binding:
            raise AccountError("Native OIDC resume requires its original worker")
        validate_binding(binding, current["id"])
        session = object.__new__(_OidcSession)
        session._proof, session.provider, session.binding = _PROOF, details["provider"], details["binding"]
        session.principal_id, session.revision = current["id"], current["revision"]
        session.expires_at = min(details["expiresAt"], time.time() + config["maxSessionSeconds"])
        session.monotonic_expiry = min(details["monotonicExpiry"], time.monotonic() + config["maxSessionSeconds"])
        session.sid = details["sid"]
        session.verify(store, current, member)
        return OidcIdentity(public_identity(current), session, _PROOF)

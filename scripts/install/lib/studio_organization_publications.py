"""Narrow publication reads through the original root-owned account supervisor.

Only the publisher's restricted UID reads its existing finalized publication.
The privileged parent checks current policy and forwards a sealed anonymous FD;
it never reads publication bytes or writes another copy of the member's data.
"""
import array
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import resource
import socket
import signal
import stat
import time

from studio_account_files import AccountError, locked
from studio_account_runtime import drop_to_worker, validate_binding
from studio_account_sessions import supervise
from studio_accounts import public_identity

CONTROL_ENV = "KCODER_PRIVATE_SHARED_PUBLICATION_FD_V1"
MAX_BODY = 512 * 1024
SOURCE_ERRORS = {"KNOWLEDGE_PUBLICATION_REVOKED", "KNOWLEDGE_PUBLICATION_EXPIRED",
                 "KNOWLEDGE_INVALID_CURSOR",
                 "KNOWLEDGE_PUBLICATION_NOT_EFFECTIVE", "KNOWLEDGE_PUBLICATION_NOT_FOUND",
                 "KNOWLEDGE_INDEX_STALE", "KNOWLEDGE_PUBLICATION_CORRUPT",
                 "KNOWLEDGE_RESOURCE_DENIED", "KNOWLEDGE_SHARED_READER_UNAVAILABLE"}


class SharedPublicationError(AccountError):
    def __init__(self, code):
        if code not in SOURCE_ERRORS:raise AccountError("Invalid shared publication failure")
        self.code = code
        super().__init__(code)


def _resource(owner, publication_id):
    raw = json.dumps(["native-knowledge-resource-v1", "publication", owner["accountId"],
                      owner["targetId"], owner["workspaceId"], owner["organizationId"], publication_id],
                     ensure_ascii=False, separators=(",", ":")).encode()
    return "knowledge:" + hashlib.sha256(raw).hexdigest()


def _own_other_workspace(owner, reader):
    return (owner.get("accountId") == reader.get("accountId")
            and owner.get("targetId") == reader.get("targetId")
            and isinstance(owner.get("workspaceId"), str) and isinstance(reader.get("workspaceId"), str)
            and bool(reader["workspaceId"]) and owner["workspaceId"] != reader["workspaceId"]
            and isinstance(reader.get("organizationId"), str)
            and owner.get("organizationId") == reader["organizationId"])


class PublicationRead:
    def __init__(self, channel, request):
        fields = {"operation", "requestId", "readerScope", "owner", "publicationId", "version", "usage", "expectedSha256", "retrieval"}
        if set(request) != fields or request["operation"] not in ("sharedPublication.open", "sharedPublication.verify"):
            raise AccountError("Invalid shared publication operation")
        owner = request["owner"]
        if (not isinstance(owner, dict) or set(owner) != {"accountId", "targetId", "workspaceId", "organizationId"}
                or not all(isinstance(owner[key], str) and 1 <= len(owner[key]) <= 256 for key in owner)
                or not isinstance(request["publicationId"], str) or not 1 <= len(request["publicationId"]) <= 256
                or "\0" in request["publicationId"] or type(request["version"]) is not int or request["version"] <= 0
                or request["usage"] not in ("read", "use") or not isinstance(request["readerScope"], dict)
                or request["readerScope"].get("organizationId") != owner["organizationId"]
                or (request["readerScope"].get("accountId") == owner["accountId"]
                    and not _own_other_workspace(owner, request["readerScope"]))):
            raise AccountError("Invalid shared publication reference")
        expected = request["expectedSha256"]
        if (request["operation"] == "sharedPublication.open" and expected is not None
                or request["operation"] == "sharedPublication.verify" and
                (not isinstance(expected, str) or len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected))):
            raise AccountError("Invalid shared publication verification")
        if channel.runtime_fd is None:
            raise AccountError("Shared publication runtime unavailable")
        retrieval = request["retrieval"]
        if retrieval is not None and (not isinstance(retrieval, dict) or set(retrieval) != {"query", "limit", "observedAtMs"}
                or request["usage"] != "use" or not isinstance(retrieval["query"], str)
                or not retrieval["query"].strip() or len(retrieval["query"].encode()) > 4096
                or type(retrieval["limit"]) is not int or not 1 <= retrieval["limit"] <= 20
                or type(retrieval["observedAtMs"]) is not int or not time.time() * 1000 - 120000 <= retrieval["observedAtMs"] <= time.time() * 1000 + 1000):
            raise AccountError("Invalid shared publication retrieval")
        self.channel, self.request = channel, copy.deepcopy(request)
        self.resource_id = _resource(owner, request["publicationId"])
        self.result = None
        self.body_fd = None
        self.failure = False
        self.source_error = None
        self.closed = False
        self.deadline = time.monotonic() + 3
        self.snapshot, self.publisher, self.binding = self._state(initial=True)
        self.parent, self.child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.parent.setblocking(False)

    def _state(self, initial=False, audit=True):
        channel = self.channel
        snapshot = channel.policy.inspect_session(channel.identity)
        if snapshot is None or snapshot["organizationId"] != self.request["owner"]["organizationId"]:
            raise AccountError("Shared publication organization changed")
        actions = ["read", "use"] if self.request["usage"] == "use" else ["read"]
        if audit:
            for action in actions:
                decision = channel.policy.evaluate(channel.identity, action, self.resource_id, self.request["requestId"])
                if not decision["allowed"] or decision["policyRevision"] != snapshot["policyRevision"]:
                    raise AccountError("Shared publication permission denied")
        with locked(channel.store.lock):
            accounts = channel.store._load()
            policy = channel.policy._load()
            resource = policy["resources"].get(self.resource_id)
            if not resource or resource["kind"] != "knowledge" or resource["visibility"] != "organization":
                raise AccountError("Shared publication resource denied")
            if any(not channel.policy._allowed(policy, channel.identity, action, self.resource_id, None) for action in actions):
                raise AccountError("Shared publication permission denied")
            locator = resource.get("nativeKnowledgeSource")
            principal = resource["owner"]
            if locator is not None:
                channel.policy._validate_resource(resource, accounts, policy, require_source_binding=True)
                if (locator.get("version") != 1 or locator.get("publicationOwner") != self.request["owner"]
                        or locator.get("publicationId") != self.request["publicationId"]):
                    raise AccountError("Shared publication source locator changed")
                principal = locator["publisherPrincipalId"]
            own_workspace = (locator is not None and principal == channel.identity["id"]
                             and _own_other_workspace(self.request["owner"], self.request["readerScope"]))
            publisher = next((record for record in accounts["accounts"] if record["id"] == principal), None)
            member = policy["members"].get(principal)
            binding = accounts["bindings"].get(principal)
            if (publisher is None or publisher["disabled"] or not member or member["disabled"] or not binding
                    or (principal == channel.identity["id"] and not own_workspace)
                    or policy["revision"] != snapshot["policyRevision"]):
                raise AccountError("Shared publication publisher unavailable")
            if audit and member.get("directory"):
                from studio_organization_directory import directory_current
                directory_current(member["directory"])
            if audit and member.get("oidc"):
                from studio_organization_oidc_provider import oidc_subject
                if oidc_subject(channel.store, member["oidc"]) != member["oidc"]:
                    raise AccountError("Shared publication publisher enrollment changed")
            validate_binding(binding, publisher["id"])
            if binding["uid"] == snapshot["workerUid"] and not own_workspace:
                raise AccountError("Shared publication requires distinct worker identities")
            publisher, binding = public_identity(publisher), copy.deepcopy(binding)
        if not initial and (snapshot != self.snapshot or publisher != self.publisher or binding != self.binding):
            raise AccountError("Shared publication authority changed")
        return snapshot, publisher, binding

    def parent_started(self, runtime_pid=None):
        self.child.close()
        payload = {key: self.request[key] for key in ("requestId", "readerScope", "owner", "publicationId", "version", "usage", "expectedSha256", "retrieval")}
        payload.update(organizationId=self.snapshot["organizationId"], publisherPrincipalId=self.publisher["id"])
        raw = json.dumps(payload, separators=(",", ":")).encode()
        if len(raw) > 8192 or self.parent.send(raw) != len(raw):
            raise AccountError("Shared publication request incomplete")

    def start(self):
        self.parent.close()
        environment = drop_to_worker(self.binding, self.publisher)
        control = fcntl.fcntl(self.child.fileno(), fcntl.F_DUPFD_CLOEXEC, 5)
        image = fcntl.fcntl(self.channel.runtime_fd, fcntl.F_DUPFD_CLOEXEC, 5)
        os.dup2(control, 3, inheritable=True)
        os.dup2(image, 4, inheritable=False)
        null = os.open("/dev/null", os.O_RDWR | os.O_CLOEXEC)
        for descriptor in (0, 1, 2):os.dup2(null, descriptor)
        os.closerange(5, resource.getrlimit(resource.RLIMIT_NOFILE)[0])
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
        environment[CONTROL_ENV] = "3"
        # Only this pinned installed image and this exact private entry execute.
        os.execve(4, [self.channel.runtime_path, "--internal-shared-publication-read-v1"], environment)

    def current(self):
        if time.monotonic() >= self.deadline:
            return False
        try:
            self._state(audit=False)
            # Closing the reader's original authority socket revokes this owner.
            try:
                return self.channel.parent.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) != b""
            except BlockingIOError:
                return True
        except Exception:
            return False

    def poll(self, timeout):
        if not select.select([self.parent], [], [], timeout)[0]:
            return False
        self._receive()
        return True

    def _receive(self):
        if self.result is not None or self.source_error is not None:
            return
        raw, ancillary, flags, _ = self.parent.recvmsg(8192, socket.CMSG_SPACE(8 * array.array("i").itemsize), socket.MSG_CMSG_CLOEXEC)
        descriptors = []
        try:
            for level, kind, value in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    numbers = array.array("i"); numbers.frombytes(value[:len(value) - len(value) % numbers.itemsize]); descriptors.extend(numbers)
            if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or not raw:
                raise AccountError("Shared publication response incomplete")
            response = json.loads(raw)
            if response.get("ok") is False and not descriptors and response.get("error") in SOURCE_ERRORS:
                self.source_error = response["error"]
                return
            metadata = response.get("result")
            if (response.get("ok") is not True or not isinstance(metadata, dict)
                    or len(descriptors) != (1 if self.request["expectedSha256"] is None else 0)
                    or metadata.get("format") != "kcoder-shared-publication/1"
                    or any(metadata.get(key) != self.request[key] for key in ("requestId", "owner", "publicationId", "version"))
                    or metadata.get("publisherUid") != self.binding["uid"]
                    or metadata.get("retrieval") != self.request["retrieval"]
                    or metadata.get("payloadKind") != ("retrieval" if self.request["retrieval"] is not None else "publication")
                    or type(metadata.get("bodyBytes")) is not int or not 1 <= metadata["bodyBytes"] <= MAX_BODY
                    or not isinstance(metadata.get("bodySha256"), str) or len(metadata["bodySha256"]) != 64):
                raise AccountError("Shared publication response invalid")
            self.result = metadata
            if descriptors:
                self.body_fd = descriptors.pop()
        finally:
            for descriptor in descriptors:
                os.close(descriptor)

    def close(self):
        if self.closed:return
        self.closed = True
        try:
            if self.result is None and self.source_error is None and select.select([self.parent], [], [], 0)[0]:
                self._receive()
        except Exception:
            self.failure = True
        self.parent.close(); self.child.close()

    def execute(self):
        stopped = []
        try:
            status = supervise(self.channel.store, self.channel.identity, self.start, interval=0.01, policy_channel=self, stop_requested=stopped)
            if stopped:
                # The outer session owner receives the same cancellation after its
                # nested fixed reader has terminated and its handler is restored.
                handler = signal.getsignal(signal.SIGTERM)
                if callable(handler):handler(signal.SIGTERM, None)
            if status != 0 or self.failure or self.result is None:
                if self.source_error is not None:raise SharedPublicationError(self.source_error)
                raise AccountError("Shared publication reader unavailable")
            self._state()
            self.result.update(policyRevision=self.snapshot["policyRevision"], readerIdentityRevision=self.snapshot["identityRevision"], publisherAccountRevision=self.publisher["revision"])
            result, descriptor = self.result, self.body_fd
            self.body_fd = None
            return result, descriptor
        finally:
            self.close()
            if self.body_fd is not None:
                os.close(self.body_fd); self.body_fd = None


def read_publication(channel, request):
    owned = PublicationRead(channel, request)
    return owned.execute()

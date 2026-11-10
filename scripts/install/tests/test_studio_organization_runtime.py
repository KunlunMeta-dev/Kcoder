"""Explicit owned Linux UID/PAM and privileged-supervisor acceptance."""

import json
from contextlib import ExitStack
import os
from pathlib import Path
import select
import socket
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_accounts import AccountStore, AccountError
from studio_account_runtime import ensure_binding, drop_to_worker, trusted_runtime
from studio_account_sessions import supervise
from studio_organization import OrganizationStore, publish_worker_marker
from studio_organization_channel import CHANNEL_ENV, OrganizationChannel
from studio_organization_directory import _pam
from account_fixture_cleanup import cleanup_worker_accounts


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1",
                     "Explicit KCODER_TEST_SYSTEM_USERS=1 required for owned system identities")
class OrganizationRuntimeTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("KCODER_ORGANIZATION_PROBE"), "Compiled production authority probe required")
    def test_real_rust_authority_checks_os_peer_governed_marker_current_acl_and_missing_fd(self):
        installed = tempfile.TemporaryDirectory(prefix="kcoder-organization-probe-", dir="/usr/local/lib")
        self.addCleanup(installed.cleanup)
        installed_root = Path(installed.name)
        installed_root.chmod(0o755)
        candidate = installed_root / "authority-probe"
        shutil.copyfile(os.environ["KCODER_ORGANIZATION_PROBE"], candidate)
        candidate.chmod(0o755)
        probe = trusted_runtime(candidate)
        with tempfile.TemporaryDirectory(prefix="kcoder-organization-native-") as directory, ExitStack() as resources:
            root = Path(directory)
            root.chmod(0o711)
            store = AccountStore(root / "accounts")
            resources.callback(cleanup_worker_accounts, store)
            alice = store.create("alice", "synthetic-native-password")
            bob = store.create("bob", "synthetic-native-password")
            policy = OrganizationStore(store)
            policy.configure("fixture-native")
            binding = ensure_binding(store, alice, root / "homes")
            policy.administer(None, {"operation": "organization.member", "principalId": alice["id"], "roles": ["member"]})
            alice = store.authenticate("alice", "synthetic-native-password")
            resource = {"id": "knowledge:owned", "kind": "knowledge", "owner": bob["id"], "visibility": "organization",
                        "grants": [{"subject": alice["id"], "actions": ["read"]}]}
            policy.administer(None, {"operation": "organization.resource", "resource": resource, "expectedRevision": policy._load()["revision"]})
            def run(mode):
                channel = OrganizationChannel(store, alice)
                output_read, output_write = os.pipe()
                def start():
                    os.close(output_read)
                    os.dup2(output_write, 1)
                    os.dup2(output_write, 2)
                    environment = drop_to_worker(binding, alice)
                    descriptor = channel.child_fd()
                    if mode == "forged-peer":
                        forged, other = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
                        forged.set_inheritable(True)
                        descriptor = forged.fileno()
                    if mode != "missing-fd": environment[CHANNEL_ENV] = str(descriptor)
                    if mode == "revoked-between-actions": environment["KCODER_ORGANIZATION_PROBE_REPEAT"] = "1"
                    os.execve(probe, [probe], environment)
                try:
                    code = supervise(store, alice, start, interval=0.01, policy_channel=channel)
                finally:
                    os.close(output_write)
                    channel.close()
                with os.fdopen(output_read, "rb") as observed:
                    output = observed.read().decode()
                return code, output
            try:
                code, output = run("valid")
                self.assertEqual(code, 0, output)
                self.assertIn("organization-authority-verified", output)
                code, output = run("missing-fd")
                self.assertNotEqual(code, 0)
                self.assertIn("ORGANIZATION_GOVERNED_CHANNEL_REQUIRED", output)
                code, output = run("forged-peer")
                self.assertNotEqual(code, 0)
                self.assertIn("ORGANIZATION_NATIVE_PEER_UNTRUSTED", output)
                evaluate = OrganizationStore.evaluate
                evaluations = []
                def revoke_after_first(instance, *args, **kwargs):
                    result = evaluate(instance, *args, **kwargs)
                    evaluations.append(result["allowed"])
                    if len(evaluations) == 1:
                        policy.administer(None, {"operation": "organization.resource", "resource": {**resource, "grants": []},
                                                "expectedRevision": policy._load()["revision"]})
                    return result
                with patch.object(OrganizationStore, "evaluate", revoke_after_first):
                    code, output = run("revoked-between-actions")
                self.assertNotEqual(code, 0)
                self.assertIn("ORGANIZATION_RESOURCE_DENIED", output)
                self.assertEqual(evaluations, [True, False])
            finally:
                cleanup_worker_accounts(store)

    def test_real_pam_password_account_expiry_and_fixed_service(self):
        name = "kct_" + uuid.uuid4().hex[:16]
        created = False
        try:
            subprocess.run(["/usr/sbin/useradd", "--no-create-home", "--no-log-init", "--shell", "/usr/sbin/nologin", name], check=True)
            created = True
            subprocess.run(["/usr/sbin/chpasswd"], input=(name + ":synthetic-directory-password\n").encode(), check=True)
            with tempfile.TemporaryDirectory(prefix="kcoder-pam-") as directory, ExitStack() as resources:
                config = Path(directory) / "pam"
                config.mkdir(mode=0o700)
                policy = config / "kcoder"
                policy.write_text("auth required pam_unix.so\naccount required pam_unix.so\n")
                policy.chmod(0o600)
                _pam(name, "synthetic-directory-password", config)
                with self.assertRaises(AccountError): _pam(name, "incorrect-directory-password", config)
                _pam(name, None, config)
                store = AccountStore(Path(directory) / "accounts")
                resources.callback(cleanup_worker_accounts, store)
                identity = store.create("mapped-user", "synthetic-local-password")
                ensure_binding(store, identity, Path(directory) / "homes")
                organization = OrganizationStore(store)
                organization.configure("fixture-pam-login")
                organization.administer(None, {"operation": "organization.member", "principalId": identity["id"], "roles": ["member"],
                                              "directory": {"issuer": "linux-pam-nss:kcoder", "username": name}})
                try:
                    with patch("studio_organization_directory._bounded_pam", side_effect=lambda username, password=None: _pam(username, password, config)):
                        authenticated = store.authenticate("mapped-user", "synthetic-directory-password")
                        self.assertEqual(authenticated["id"], identity["id"])
                        self.assertEqual(authenticated["username"], "mapped-user")
                        with self.assertRaises(AccountError): store.authenticate("mapped-user", "synthetic-local-password")
                        subprocess.run(["/usr/bin/chage", "--expiredate", "1", name], check=True)
                        with self.assertRaises(AccountError): store.authenticate("mapped-user", "synthetic-directory-password")
                finally:
                    cleanup_worker_accounts(store)
                with self.assertRaises(AccountError): _pam(name, None, config)
        finally:
            if created:
                subprocess.run(["/usr/sbin/userdel", name], check=True)

    def test_root_supervisor_nonprivileged_uid_current_acl_and_revocation(self):
        with tempfile.TemporaryDirectory(prefix="kcoder-organization-runtime-") as directory, ExitStack() as resources:
            root = Path(directory)
            root.chmod(0o711)
            store = AccountStore(root / "accounts")
            resources.callback(cleanup_worker_accounts, store)
            original = store.create("alice", "synthetic-runtime-password")
            policy = OrganizationStore(store)
            policy.configure("fixture-runtime")
            binding = ensure_binding(store, original, root / "homes")
            policy.administer(None, {"operation": "organization.member", "principalId": original["id"], "roles": ["member"]})
            identity = store.authenticate("alice", "synthetic-runtime-password")
            policy.administer(None, {"operation": "organization.resource", "expectedRevision": policy._load()["revision"],
                "resource": {"id": "knowledge:owned", "kind": "knowledge", "owner": identity["id"], "visibility": "private", "grants": []}})
            channel = OrganizationChannel(store, identity)
            self.addCleanup(channel.close)
            observed_read, observed_write = os.pipe()
            supervisor = os.fork()
            if supervisor == 0:
                os.close(observed_read)
                def start():
                    environment = drop_to_worker(binding, identity)
                    descriptor = channel.child_fd()
                    peer = socket.socket(fileno=descriptor)
                    def emit(frame):
                        raw = json.dumps(frame).encode() + b"\n"
                        os.write(observed_write, raw)
                    peer.send(b'{"operation":"inspect"}')
                    snapshot = json.loads(peer.recv(8192))
                    emit({"uid": os.geteuid(), "gid": os.getegid(), "groups": os.getgroups(), "snapshot": snapshot,
                          "inheritedEnvironment": sorted(environment)})
                    peer.send(b'{"operation":"evaluate","action":"read","resourceId":"knowledge:owned","requestId":"first-read"}')
                    emit(json.loads(peer.recv(8192)))
                    while True: time.sleep(0.1)
                code = supervise(store, identity, start, interval=0.05, policy_channel=channel)
                os._exit(code)
            os.close(observed_write)
            # The root test process did not create this runtime and must not
            # compete with the supervisor for its socket endpoint.
            channel.close()
            try:
                with os.fdopen(observed_read, "rb", buffering=0) as observed:
                    self.assertTrue(select.select([observed], [], [], 10)[0], "worker did not inspect current policy")
                    first = json.loads(observed.readline())
                    self.assertEqual(first["uid"], binding["uid"])
                    self.assertGreaterEqual(first["uid"], 1000)
                    self.assertEqual(first["groups"], [])
                    self.assertEqual(first["snapshot"]["result"]["workerUid"], binding["uid"])
                    self.assertNotIn("KCODER_PRIVATE_ORGANIZATION_FD_V1", first["inheritedEnvironment"])
                    self.assertTrue(select.select([observed], [], [], 10)[0])
                    self.assertTrue(json.loads(observed.readline())["result"]["allowed"])
                    store.revoke_sessions("alice")
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        observed_pid, status = os.waitpid(supervisor, os.WNOHANG)
                        if observed_pid:
                            self.assertTrue(os.WIFEXITED(status))
                            supervisor = None
                            break
                        time.sleep(0.05)
                    self.assertIsNone(supervisor, "revoked runtime was not terminated")
            finally:
                if supervisor is not None:
                    os.kill(supervisor, 15)
                    os.waitpid(supervisor, 0)
                cleanup_worker_accounts(store)


if __name__ == "__main__":
    unittest.main()

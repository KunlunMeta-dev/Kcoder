"""Real privileged entry, HTTPS OIDC and exact-owner Linux UID acceptance."""

from contextlib import ExitStack
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import sysconfig
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_accounts import AccountStore
from studio_account_deploy import prepare
from studio_account_runtime import ensure_binding
from studio_organization import OrganizationStore
from studio_organization_oidc_provider import OidcProviderStore
from test_studio_organization_oidc import dependencies_available
from account_fixture_cleanup import cleanup_worker_accounts


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1" and dependencies_available(),
                     "Explicit system UID gate and exact OIDC dependency environment required")
class OidcHostTests(unittest.TestCase):
    def test_actual_entry_oidc_sid_logout_stops_only_its_authenticated_worker(self):
        from oidc_fixture import OidcFixture
        with tempfile.TemporaryDirectory(prefix="kcoder-oidc-host-") as directory, \
                tempfile.TemporaryDirectory(prefix="kcoder-oidc-installed-", dir="/usr/local/lib") as installation, \
                ExitStack() as resources:
            root, prefix = Path(directory), Path(installation)
            root.chmod(0o711)
            prepare(prefix, Path(__file__).resolve().parents[1])
            prefix.chmod(0o711)
            shutil.copytree(sysconfig.get_path("purelib"), prefix / "oidc-deps", ignore=shutil.ignore_patterns("__pycache__"))
            runtime_directory = prefix / "runtime"
            runtime_directory.mkdir(mode=0o755)
            runtime = runtime_directory / "owned-oidc-worker"
            shutil.copyfile(Path(__file__).parent / "fixtures/organization_oidc_worker.py", runtime)
            runtime.chmod(0o755)
            issuer = OidcFixture(root)
            resources.callback(issuer.close)
            store = AccountStore(root / "accounts")
            resources.callback(cleanup_worker_accounts, store)
            processes = []
            identity = store.create("alice", "synthetic-unused-local-password")
            binding = ensure_binding(store, identity, root / "homes")
            provisioned = subprocess.run(["/usr/bin/python3", "-I", str(prefix / "bin/studio-account.py"), "--state-directory", str(store.root),
                "provision-worker", "--username", "alice", "--homes-directory", str(root / "homes")], capture_output=True, timeout=10, check=True)
            self.assertEqual(json.loads(provisioned.stdout)["uid"], binding["uid"])

            def cleanup_owned():
                store.revoke_sessions("alice")
                for process in processes:
                    if process.stdin and not process.stdin.closed: process.stdin.close()
                    try: process.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        process.terminate()
                        process.wait(timeout=5)
                    process.stdout.close(); process.stderr.close()
                owned = Path(binding["home"]) / "tmp/oidc-owned-wiki-parents.jsonl"
                if owned.exists():
                    parent_pids = {json.loads(line)["parentPid"] for line in owned.read_text().splitlines()}
                    deadline = time.monotonic() + 10
                    for pid in parent_pids:
                        while time.monotonic() < deadline:
                            try:
                                state = Path(f"/proc/{pid}/status").read_text()
                            except FileNotFoundError:
                                break
                            if "State:\tZ" in state: break
                            time.sleep(0.05)
                        else:
                            raise AssertionError("Owned OIDC Wiki supervisor did not settle before cleanup")
                cleanup_worker_accounts(store)

            resources.callback(cleanup_owned)
            organization = OrganizationStore(store)
            organization.configure("fixture-oidc-host")
            OidcProviderStore(store).configure(issuer.configuration())
            organization.administer(None, {"operation": "organization.member", "principalId": identity["id"], "roles": ["member"],
                                             "oidc": {"issuer": issuer.issuer, "sub": "subject-alice"}})
            organization.administer(None, {"operation": "organization.resource", "expectedRevision": organization._load()["revision"],
                "resource": {"id": "knowledge:oidc-host", "kind": "knowledge", "owner": identity["id"], "visibility": "private", "grants": []}})

            def line(process):
                self.assertTrue(select.select([process.stdout], [], [], 20)[0], "Owned OIDC entry did not produce its bounded frame")
                return json.loads(process.stdout.readline())

            def start(sid):
                issuer.sid = sid
                process = subprocess.Popen(["/usr/bin/python3", "-I", str(prefix / "bin/studio-account-entry.py"),
                    "--state-directory", str(store.root), "--homes-directory", str(root / "homes"), "--runtime", str(runtime)],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                    env={"PATH": "/usr/bin:/bin", "SSH_ORIGINAL_COMMAND": "kcoder-account", "OIDC_ACCESS_TOKEN": "synthetic-ambient-token"})
                processes.append(process)
                process.stdin.write((json.dumps({"protocol": "kcoder-account-v1", "authentication": "oidc", "username": "alice"}) + "\n").encode())
                process.stdin.flush()
                challenge = line(process)
                self.assertTrue(challenge.get("authenticationPending"), "OIDC challenge was not returned")
                process.stdin.write((json.dumps(issuer.authorize(challenge)) + "\n").encode()); process.stdin.flush()
                authenticated = line(process)
                self.assertTrue(authenticated.get("authenticated"), "OIDC native authentication failed")
                self.assertEqual(authenticated["principalId"], identity["id"])
                self.assertEqual(authenticated["role"], "user")
                self.assertEqual(authenticated["uid"], binding["uid"])
                process.private_resume = authenticated["privateOidcResume"]
                observed = line(process)
                self.assertTrue(observed["hostProbe"])
                self.assertEqual(observed["peerUid"], 0)
                self.assertEqual(observed["uid"], binding["uid"])
                self.assertTrue(observed["allowed"])
                self.assertFalse(observed["ambientTokenLeaked"])
                return process

            def resumed(authority, success, username="alice", state_directory=None):
                process = subprocess.Popen(["/usr/bin/python3", "-I", str(prefix / "bin/studio-account-entry.py"),
                    "--state-directory", str(state_directory or store.root), "--homes-directory", str(root / "homes"), "--runtime", str(runtime)],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                    env={"PATH": "/usr/bin:/bin", "SSH_ORIGINAL_COMMAND": "kcoder-account"})
                processes.append(process)
                process.stdin.write((json.dumps({"protocol": "kcoder-account-v1", "authentication": "oidcResume", "username": username,
                                                 "resumeAuthority": authority}) + "\n").encode()); process.stdin.flush()
                response = line(process)
                self.assertEqual(bool(response.get("authenticated")), success, "Native resume authorization result did not match")
                if success:
                    self.assertEqual(response["principalId"], identity["id"])
                    self.assertEqual(response["uid"], binding["uid"])
                    self.assertTrue(line(process)["allowed"])
                else:
                    process.wait(timeout=8)
                return process

            def deliver_logout(token):
                result = subprocess.run(["/usr/bin/python3", "-I", str(prefix / "bin/studio-account-entry.py"),
                    "--state-directory", str(store.root), "--runtime", str(runtime)],
                    input=(json.dumps({"protocol": "kcoder-account-v1", "authentication": "oidcLogout", "logoutToken": token}) + "\n").encode(),
                    capture_output=True, timeout=20, env={"PATH": "/usr/bin:/bin", "SSH_ORIGINAL_COMMAND": "kcoder-account"})
                self.assertEqual(result.returncode, 0, "Owned signed OIDC logout was rejected")
                response = json.loads(result.stdout)
                self.assertTrue(response["logoutAccepted"])
                return response["result"]

            first, second = start("host-session-one"), start("host-session-two")
            exchanges = len(issuer.token_requests)
            peer = resumed(first.private_resume, True)
            self.assertEqual(len(issuer.token_requests), exchanges, "Native resume must not replay an authorization code")
            resumed({**first.private_resume, "clientBinding": "wrong-owner-binding" * 3}, False)
            resumed({**first.private_resume, "secret": "0" * 64}, False)
            resumed(first.private_resume, False, username="other-user")
            other_target = AccountStore(root / "different-target-accounts")
            resumed(first.private_resume, False, state_directory=other_target.root)
            token = issuer.logout_token(sid="host-session-one")
            self.assertFalse(deliver_logout(token)["replayed"])
            first.wait(timeout=8)
            peer.wait(timeout=8)
            resumed(first.private_resume, False)
            self.assertIsNone(second.poll(), "SID logout must not stop the peer session")
            self.assertTrue(deliver_logout(token)["replayed"])
            self.assertIsNone(second.poll(), "A replay must not revoke a newer peer session")
            socket_path = store.root / (".oidc-" + second.private_resume["handle"] + ".sock")
            socket_path.unlink()
            socket_path.write_text("owned damaged-socket fixture")
            resumed(second.private_resume, False)
            deliver_logout(issuer.logout_token())
            second.wait(timeout=8)
            issuer.claim_overrides = {"exp": int(time.time()) + 3}
            expired = start("host-expiring-session")
            expired.wait(timeout=8)
            resumed(expired.private_resume, False)
            raw = store.path.read_text()
            self.assertNotIn(token, raw)
            self.assertNotIn("synthetic-ambient-token", raw)


if __name__ == "__main__":
    unittest.main()

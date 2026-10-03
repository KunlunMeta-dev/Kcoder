"""Explicit root integration test: temporary worker UIDs and the actual installed app-server."""

import json
import os
from pathlib import Path
import pwd
import select
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_accounts import AccountStore
from studio_account_runtime import worker_name


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1",
                     "Explicit KCODER_TEST_SYSTEM_USERS=1 required for temporary system users")
class RuntimeIsolation(unittest.TestCase):
    def test_authenticated_workers_use_distinct_uids_and_private_files(self):
        entry = Path(__file__).resolve().parents[1] / "installers/studio-account-entry.py"
        with tempfile.TemporaryDirectory(prefix="kcoder-account-runtime-") as directory:
            root = Path(directory)
            root.chmod(0o711)
            store = AccountStore(root / "store")
            identities = [store.create(name, "synthetic-isolation-password") for name in ["alice", "bob"]]
            processes = []
            try:
                for identity in identities:
                    process = subprocess.Popen([sys.executable, "-I", str(entry), "--state-directory", str(root / "store"),
                                                "--homes-directory", str(root / "homes")],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        env={"PATH": "/usr/bin:/bin", "SSH_ORIGINAL_COMMAND": "kcoder-account",
                             "HOME": "/root", "KCODER_CONFIG_DIR": "/root/private-admin-config"})
                    processes.append(process)
                    login = {"protocol": "kcoder-account-v1", "username": identity["username"], "password": "synthetic-isolation-password"}
                    initialize = {"jsonrpc": "2.0", "id": 41, "method": "initialize",
                                  "params": {"protocolVersion": "2026-07-27", "clientInfo": {"name": "isolation-test", "version": "1"}}}
                    process.stdin.write((json.dumps(login) + "\n" + json.dumps(initialize) + "\n").encode())
                    process.stdin.flush()
                    self.assertTrue(select.select([process.stdout], [], [], 20)[0], "authentication timed out")
                    authenticated = json.loads(process.stdout.readline())
                    self.assertTrue(authenticated["authenticated"])
                    self.assertEqual(authenticated["principalId"], identity["id"])
                    self.assertGreaterEqual(authenticated["uid"], 1000)
                    self.assertTrue(select.select([process.stdout], [], [], 20)[0], "pipelined initialize was lost")
                    initialized = json.loads(process.stdout.readline())
                    self.assertEqual(initialized["id"], 41)
                    self.assertIn("result", initialized)
                    status = Path(f"/proc/{authenticated['runtimePid']}/status").read_text()
                    self.assertIn("NoNewPrivs:\t1", status)
                    self.assertIn(f"Uid:\t{authenticated['uid']}\t{authenticated['uid']}", status)
                bindings = store._load()["bindings"]
                alice, bob = [bindings[identity["id"]] for identity in identities]
                self.assertNotEqual(alice["uid"], bob["uid"])
                secret = Path(alice["home"]) / ".config/kcoder/private-history-marker"
                secret.write_text("synthetic-private-history")
                secret.chmod(0o600)
                os.chown(secret, alice["uid"], alice["gid"])
                denied = subprocess.run(["/usr/bin/setpriv", "--reuid", str(bob["uid"]), "--regid", str(bob["gid"]),
                                         "--clear-groups", "--no-new-privs", "/bin/cat", str(secret)], capture_output=True)
                self.assertNotEqual(denied.returncode, 0)
                self.assertNotIn(b"synthetic-private-history", denied.stdout)
                store.revoke_sessions("alice")
                processes[0].wait(timeout=5)
                self.assertIsNone(processes[1].poll(), "revoking Alice must not terminate Bob")
            finally:
                for process in processes:
                    process.stdin.close()
                    if process.poll() is None:
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
                    process.stdout.close()
                    process.stderr.close()
                for identity in identities:
                    name = worker_name(identity["id"], store._load()["instance"])
                    try:
                        account = pwd.getpwnam(name)
                    except KeyError:
                        continue
                    binding = store._load()["bindings"].get(identity["id"])
                    self.assertTrue(binding and binding["uid"] == account.pw_uid, "refuse cleanup of an unowned account")
                    subprocess.run(["/usr/sbin/userdel", name], check=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()

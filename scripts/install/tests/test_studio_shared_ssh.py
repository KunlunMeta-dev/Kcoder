"""Explicit root integration: one SSH key, independent KCoder accounts and Gateway clients."""

import base64
import http.cookiejar
import json
import os
from pathlib import Path
import pwd
import select
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_accounts import AccountStore
from studio_account_runtime import worker_name
from studio_account_deploy import prepare, activate
from studio_account_files import write_private_json

REPO = Path(__file__).resolve().parents[3]
PASSWORDS = {"alice": "synthetic-alice-password", "bob": "synthetic-bob-password", "operator": "synthetic-admin-password"}


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1",
                     "Explicit system-user test opt-in required")
class SharedSshIsolation(unittest.TestCase):
    def test_shared_key_has_no_root_shell_and_accounts_have_separate_history(self):
        # sshd StrictModes needs trusted ancestors, and the SSH wrapper needs an executable mount.
        with tempfile.TemporaryDirectory(prefix="kcoder-shared-ssh-", dir="/var/lib") as directory:
            root = Path(directory)
            root.chmod(0o711)
            control = root / "control"
            control.mkdir(mode=0o700)
            workspace = root / "shared-project"
            workspace.mkdir(mode=0o755)
            (workspace / "README.md").write_text("Read-only shared fixture project\n")
            processes, stores = [], []
            prefix = control / "installed"
            prepare(prefix, Path(__file__).resolve().parents[1])
            for name in ["host", "shared", "administrator"]:
                subprocess.run(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(control / name)], check=True)
            known_hosts = control / "known_hosts"
            known_hosts.touch(mode=0o600)
            wrapper_dir = control / "bin"
            wrapper_dir.mkdir(mode=0o700)
            wrapper = wrapper_dir / "ssh"
            wrapper.write_text("#!/bin/sh\nexec /usr/bin/ssh -F /dev/null -i " + shlex.quote(str(control / "shared")) +
                               " -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=" + shlex.quote(str(known_hosts)) + ' "$@"\n')
            wrapper.chmod(0o700)

            def start(command, **kwargs):
                process = subprocess.Popen(command, start_new_session=True, **kwargs)
                processes.append(process)
                return process

            def start_sshd(store, label):
                area = control / label
                area.mkdir(mode=0o700)
                keys = area / "authorized_keys"
                keys.write_bytes((control / "shared.pub").read_bytes())
                keys.chmod(0o600)
                reservation = socket.socket()
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
                config = area / "sshd_config"
                dropin = area / "accounts.conf"
                config.write_text("\n".join([
                    f"Port {port}", "ListenAddress 127.0.0.1", f"HostKey {control / 'host'}",
                    f"AuthorizedKeysFile {keys}", "PubkeyAuthentication yes", "PasswordAuthentication no",
                    "KbdInteractiveAuthentication no", "UsePAM no", "StrictModes yes",
                    "PermitRootLogin prohibit-password", "AllowUsers root kcu_*",
                    f"Include {dropin}", f"PidFile {area / 'sshd.pid'}", "LogLevel ERROR", "",
                ]))
                activate(prefix=prefix, state=store.root, homes=root / "homes", runtime=Path("/usr/local/bin/kcoder"),
                         authorized_keys=keys, shared_key=control / "shared.pub", administrator_key=control / "administrator.pub",
                         sshd_config=config, dropin=dropin, service="ssh", reload_daemon=False)
                reservation.close()
                start(["/usr/sbin/sshd", "-D", "-e", "-f", str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                            return port
                    except OSError:
                        time.sleep(0.05)
                self.fail("owned sshd did not start")

            def ssh(port, key="shared"):
                return ["/usr/bin/ssh", "-F", "/dev/null", "-i", str(control / key), "-o", "BatchMode=yes",
                        "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new",
                        "-o", f"UserKnownHostsFile={known_hosts}", "-p", str(port), "root@127.0.0.1"]

            def request(url, path, body, opener):
                data = json.dumps(body).encode()
                query = urllib.request.Request(url + path, data=data, method="POST",
                    headers={"Content-Type": "application/json", "Origin": url})
                with opener.open(query, timeout=30) as response:
                    return json.loads(response.read())

            def gateway(port, name, label):
                area = control / label
                area.mkdir(mode=0o700)
                servers = area / "servers.json"
                servers.write_text(json.dumps([{"id": "shared", "label": name, "transport": "ssh", "host": "127.0.0.1",
                    "port": port, "user": "root", "workspacePath": str(workspace),
                    "security": {"identity": {"mode": "kcoder-account", "username": name}}}]))
                token = "synthetic-private-gateway-" + label
                env = {**os.environ, "PATH": str(wrapper_dir) + os.pathsep + os.environ["PATH"],
                       "HOME": str(area), "KCODER_STUDIO_SERVERS_STORE": str(servers),
                       "KCODER_STUDIO_HOST": "127.0.0.1", "KCODER_STUDIO_PORT": "0",
                       "KCODER_STUDIO_WORKSPACE": str(workspace), "KCODER_STUDIO_KCODER_BIN": "/usr/local/bin/kcoder",
                       "KCODER_STUDIO_AUTH_TOKEN": token}
                process = start(["node", str(REPO / "apps/kcoder-studio/dev-server.mjs")], cwd=REPO / "apps/kcoder-studio",
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
                deadline = time.monotonic() + 15
                url = None
                while time.monotonic() < deadline:
                    if select.select([process.stdout], [], [], 0.2)[0]:
                        line = process.stdout.readline().decode()
                        if line.startswith("KCoder Studio: "):
                            url = line.strip().split(" ")[-1]
                            break
                    if process.poll() is not None:
                        self.fail("owned Gateway exited before readiness")
                self.assertIsNotNone(url)
                jar = http.cookiejar.CookieJar()
                opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
                request(url, "/api/mobile/session", {"token": token}, opener)
                try:
                    login = request(url, "/api/servers/shared/account", {"password": PASSWORDS[name]}, opener)
                except urllib.error.HTTPError as error:
                    if select.select([process.stderr], [], [], 0)[0]:
                        diagnostic = os.read(process.stderr.fileno(), 16384).decode()
                        for password in PASSWORDS.values():
                            diagnostic = diagnostic.replace(password, "[redacted]")
                        sys.stderr.write(diagnostic)
                    self.fail("Account login failed: " + error.read(4096).decode())
                self.assertTrue(login["authenticated"])
                cookie = "; ".join(item.name + "=" + item.value for item in jar)
                return {"url": url, "cookie": cookie, "identity": login["identity"]}, opener

            try:
                source = AccountStore(control / "source")
                stores.append(source)
                for name, password in PASSWORDS.items():
                    source.create(name, password, "admin" if name == "operator" else "user")
                port = start_sshd(source, "ssh-source")
                denied = subprocess.run(ssh(port) + ["id -u"], capture_output=True, timeout=10)
                self.assertNotEqual(denied.returncode, 0)
                self.assertNotEqual(denied.stdout.strip(), b"0")
                administrator = subprocess.run(ssh(port, "administrator") + ["id -u"], capture_output=True, timeout=10)
                self.assertEqual(administrator.returncode, 0)
                self.assertEqual(administrator.stdout.strip(), b"0")
                forward = subprocess.run(ssh(port)[:-1] + ["-o", "ExitOnForwardFailure=yes", "-N", "-R", "0:127.0.0.1:1", ssh(port)[-1]],
                                         capture_output=True, timeout=10)
                self.assertNotEqual(forward.returncode, 0)
                direct_login = {"protocol": "kcoder-account-v1", "username": "alice",
                                "password": PASSWORDS["alice"], "workspace": str(workspace)}
                direct = subprocess.run(ssh(port) + ["kcoder-account"],
                    input=(json.dumps(direct_login) + "\n").encode(), capture_output=True, timeout=25)
                first_frame = direct.stdout.splitlines()
                self.assertTrue(first_frame, "Shared SSH entry produced no authentication response")
                self.assertTrue(json.loads(first_frame[0]).get("authenticated"),
                                "Shared SSH entry rejected the valid account before Gateway integration")
                endpoints = []
                for name, label in [("alice", "client-a"), ("bob", "client-b"), ("alice", "client-a-second")]:
                    endpoint, opener = gateway(port, name, label)
                    binding = source._load()["bindings"][endpoint["identity"]["principalId"]]
                    endpoint["home"] = binding["home"]
                    endpoints.append(endpoint)
                    with self.assertRaises(urllib.error.HTTPError) as rejected:
                        request(endpoint["url"], "/api/servers/shared/accounts", {"operation": "export"}, opener)
                    self.assertEqual(rejected.exception.code, 403)
                probe = subprocess.run(["node", str(Path(__file__).with_name("studio_accounts_gateway_probe.mjs"))],
                    input=json.dumps({"endpoints": endpoints}).encode(), capture_output=True, timeout=120)
                self.assertEqual(probe.returncode, 0, probe.stderr.decode()[-2000:])
                self.assertTrue(json.loads(probe.stdout)["crossAccountHistoryDenied"])
                admin_login = {"protocol": "kcoder-account-v1", "username": "operator", "password": PASSWORDS["operator"], "mode": "admin"}
                exported = subprocess.run(ssh(port) + ["kcoder-account"],
                    input=(json.dumps(admin_login) + '\n{"operation":"export"}\n').encode(), capture_output=True, timeout=20)
                self.assertEqual(exported.returncode, 0)
                bundle = json.loads(exported.stdout)["result"]
                self.assertEqual(set(bundle), {"format", "version", "accounts"})
                target = AccountStore(control / "target")
                stores.append(target)
                target.import_bundle(bundle)
                target_port = start_sshd(target, "ssh-target")
                migrated, _ = gateway(target_port, "alice", "client-migrated")
                self.assertEqual(migrated["identity"]["principalId"], endpoints[0]["identity"]["principalId"])
                old = source._load()["bindings"][migrated["identity"]["principalId"]]
                new = target._load()["bindings"][migrated["identity"]["principalId"]]
                self.assertNotEqual(old["uid"], new["uid"])
                self.assertNotEqual(old["home"], new["home"])
            finally:
                for process in reversed(processes):
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGTERM)
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            os.killpg(process.pid, signal.SIGKILL)
                            process.wait(timeout=5)
                    for stream in (process.stdout, process.stderr):
                        if stream:
                            stream.close()
                for store in stores:
                    state = store._load()
                    for principal, binding in state["bindings"].items():
                        name = worker_name(principal, state["instance"])
                        account = pwd.getpwnam(name)
                        self.assertEqual(account.pw_uid, binding["uid"])
                        subprocess.run(["/usr/sbin/userdel", name], check=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()

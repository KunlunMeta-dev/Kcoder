"""Deployment contracts: restricted keys and transactional configuration rollback."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_account_deploy import activate, install_command, prepare, read_public_key, restricted_keys
from studio_accounts import AccountError, AccountStore


@unittest.skipUnless(os.geteuid() == 0, "Deployment requires root-owned files")
class DeploymentTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name in ("shared", "admin"):
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(self.root / name)], check=True)

    def test_public_key_comments_and_empty_input(self):
        public = self.root / "shared.pub"
        key = read_public_key(public)
        public.write_text(key[0] + " 管理入口\n")
        self.assertEqual(read_public_key(public), key)
        public.write_text("\n")
        with self.assertRaises(AccountError):
            read_public_key(public)

    def test_account_command_does_not_change_ssh_and_refuses_unrelated_executable(self):
        prefix = self.root / "installed"
        prepare(prefix, Path(__file__).resolve().parents[1])
        command = self.root / "kcoder-account"
        arguments = dict(prefix=prefix, command_path=command, state=self.root / "state",
                         homes=self.root / "homes", runtime=Path("/usr/bin/true"))
        result = install_command(**arguments)
        self.assertFalse(result["sshAuthorizationChanged"])
        self.assertIn("SSH_ORIGINAL_COMMAND=kcoder-account", command.read_text())
        self.assertEqual(command.stat().st_mode & 0o777, 0o755)
        command.write_text("#!/bin/sh\nexit 0\n")
        with self.assertRaisesRegex(AccountError, "unrelated"):
            install_command(**arguments)

    def test_shared_key_is_replaced_once_and_admin_must_be_distinct(self):
        shared = read_public_key(self.root / "shared.pub")
        admin = read_public_key(self.root / "admin.pub")
        existing = (shared[0] + "\n" + shared[0] + " duplicate\n").encode()
        restricted = restricted_keys(existing, shared, admin, "/trusted/entry").decode()
        self.assertEqual(restricted.count(shared[0]), 1)
        self.assertIn('restrict,command="/trusted/entry" ' + shared[0], restricted)
        self.assertIn(admin[0] + " kcoder-administrator", restricted)
        with self.assertRaises(AccountError):
            restricted_keys(existing, shared, shared, "/trusted/entry")

    def test_failed_sshd_validation_restores_exact_prior_configuration(self):
        prefix = self.root / "installed"
        prepare(prefix, Path(__file__).resolve().parents[1])
        state = self.root / "accounts"
        AccountStore(state).create("operator", "synthetic-admin-password", "admin")
        keys = self.root / "authorized_keys"
        before = (self.root / "shared.pub").read_bytes()
        keys.write_bytes(before)
        keys.chmod(0o600)
        dropin = self.root / "accounts.conf"
        # Public-key parsing uses the real ssh-keygen; only sshd is fault-injected.
        real_run = subprocess.run
        def run(command, **kwargs):
            if command[0] == "/usr/sbin/sshd":
                return subprocess.CompletedProcess(command, 1, b"", b"invalid fixture configuration")
            return real_run(command, **kwargs)
        with patch("studio_account_deploy.subprocess.run", side_effect=run):
            with self.assertRaisesRegex(AccountError, "OpenSSH"):
                activate(prefix=prefix, state=state, homes=self.root / "homes", runtime=Path("/usr/bin/true"),
                    authorized_keys=keys, shared_key=self.root / "shared.pub", administrator_key=self.root / "admin.pub",
                    sshd_config=self.root / "sshd_config", dropin=dropin, service="ssh", reload_daemon=False)
        self.assertEqual(keys.read_bytes(), before)
        self.assertFalse(dropin.exists())
        backups = list(self.root.glob("authorized_keys.kcoder-backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), before)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()

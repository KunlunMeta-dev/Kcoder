"""Portable account contracts without real system-account mutations."""

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_accounts import AccountError, AccountStore, password_hash, verify_password
from studio_account_files import read_private_json, write_private_json


PASSWORD = "synthetic-account-password"


class PasswordTests(unittest.TestCase):
    def test_salted_password_hashes_and_wrong_password(self):
        first = password_hash(PASSWORD)
        second = password_hash(PASSWORD)
        self.assertNotEqual(first, second)
        self.assertTrue(verify_password(PASSWORD, first))
        self.assertFalse(verify_password("different-synthetic-password", first))
        self.assertNotIn(PASSWORD, json.dumps(first))


@unittest.skipUnless(os.geteuid() == 0, "Account storage is root-owned")
class AccountTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.store = AccountStore(self.root / "source")

    def test_create_authenticate_disable_and_public_listing(self):
        identity = self.store.create("alice", PASSWORD)
        self.assertNotIn("password", identity)
        self.assertEqual(self.store.authenticate("alice", PASSWORD), identity)
        self.assertEqual(self.store.list(), [identity])
        self.store.set_disabled("alice", True)
        with self.assertRaisesRegex(AccountError, "authentication failed"):
            self.store.authenticate("alice", PASSWORD)

    def test_revocation_invalidates_existing_revision_without_changing_password(self):
        identity = self.store.create("alice", PASSWORD)
        self.assertTrue(self.store.session_current(identity))
        self.store.revoke_sessions("alice")
        self.assertFalse(self.store.session_current(identity))
        current = self.store.authenticate("alice", PASSWORD)
        self.assertTrue(self.store.session_current(current))
        self.store.change_password("alice", "another-fixture-password")
        self.assertFalse(self.store.session_current(current))

    def test_rate_limit_survives_process_store_reopen(self):
        self.store.create("alice", PASSWORD)
        for _ in range(5):
            with self.assertRaises(AccountError):
                self.store.authenticate("alice", "wrong-password-here", now=100)
        reopened = AccountStore(self.root / "source")
        with self.assertRaises(AccountError):
            reopened.authenticate("alice", PASSWORD, now=130)
        self.assertEqual(reopened.authenticate("alice", PASSWORD, now=161)["username"], "alice")

    def test_portable_export_excludes_machine_bindings_and_preserves_identity(self):
        identity = self.store.create("alice", PASSWORD)
        state = read_private_json(self.store.path)
        state["bindings"][identity["id"]] = {"uid": 19001, "home": "/private-source-host/home"}
        write_private_json(self.store.path, state)
        destination = self.root / "identities.json"
        self.store.export_identities(destination)
        raw = destination.read_text()
        self.assertNotIn("19001", raw)
        self.assertNotIn("private-source-host", raw)
        self.assertNotIn(PASSWORD, raw)
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        imported = AccountStore(self.root / "target")
        self.assertEqual(imported.import_identities(destination)["added"], 1)
        self.assertEqual(imported.import_identities(destination)["added"], 0)
        self.assertEqual(imported.authenticate("alice", PASSWORD), identity)
        self.assertEqual(read_private_json(imported.path)["bindings"], {})

    def test_import_conflicts_are_atomic_and_cannot_take_over_a_name(self):
        self.store.create("alice", PASSWORD)
        other = AccountStore(self.root / "other")
        other.create("bob", PASSWORD)
        other.create("alice", "another-private-password")
        exported = self.root / "export.json"
        other.export_identities(exported)
        before = self.store.path.read_bytes()
        with self.assertRaisesRegex(AccountError, "conflicts"):
            self.store.import_identities(exported)
        self.assertEqual(before, self.store.path.read_bytes())

    def test_export_never_overwrites_and_import_rejects_public_files(self):
        self.store.create("alice", PASSWORD)
        exported = self.root / "export.json"
        self.store.export_identities(exported)
        with self.assertRaises(FileExistsError):
            self.store.export_identities(exported)
        exported.chmod(0o644)
        with self.assertRaisesRegex(AccountError, "root-private"):
            self.store.import_identities(exported)

    def test_registry_symlink_and_extra_identity_fields_are_rejected(self):
        self.store.create("alice", PASSWORD)
        exported = self.root / "export.json"
        self.store.export_identities(exported)
        data = read_private_json(exported)
        data["accounts"][0]["uid"] = 0
        write_private_json(exported, data)
        with self.assertRaisesRegex(AccountError, "identity record"):
            self.store.import_identities(exported)
        saved = self.store.path.with_suffix(".saved")
        self.store.path.rename(saved)
        self.store.path.symlink_to(saved)
        with self.assertRaises(OSError):
            self.store.list()

    def test_ordinary_accounts_cannot_administer_and_revoked_admin_is_rejected(self):
        ordinary = self.store.create("alice", PASSWORD)
        admin = self.store.create("operator", PASSWORD, "admin")
        for operation in [{"operation": "export"}, {"operation": "list"}, {"operation": "disable", "username": "operator"}]:
            with self.assertRaisesRegex(AccountError, "administrator"):
                self.store.administer(ordinary, operation)
        created = self.store.administer(admin, {"operation": "create", "username": "bob", "password": PASSWORD})
        self.assertEqual(created["role"], "user")
        self.store.set_disabled("operator", True)
        with self.assertRaisesRegex(AccountError, "changed"):
            self.store.administer(admin, {"operation": "export"})


if __name__ == "__main__":
    unittest.main()

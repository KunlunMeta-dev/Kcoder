"""The verified-account parent fact is created after the worker boundary."""

import base64
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


ENTRY_PATH = Path(__file__).resolve().parents[1] / "installers" / "studio-account-entry.py"
spec = importlib.util.spec_from_file_location("studio_account_entry_retention_review", ENTRY_PATH)
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)

PRIVATE_PARENT_ENV = "KCODER_PRIVATE_RETENTION_PARENT_V1"
PRINCIPAL_ID = "01234567-89ab-4cde-8fab-0123456789ab"
WORKER_UID = 23456


class FakeAccountStore:
    def __init__(self, _state_directory):
        pass

    def authenticate(self, username, password):
        if username != "alice" or password != "test-only-password":
            raise AssertionError("unexpected account fixture credentials")
        return {
            "id": PRINCIPAL_ID,
            "username": "alice",
            "role": "user",
            "revision": 1,
        }


class AccountRetentionParentTests(unittest.TestCase):
    def run_entry(self, include_parent):
        home = "/owned/test-worker-home"
        binding = {"home": home}
        observed = {}
        uid_state = {"worker": False, "queries": []}

        def effective_uid():
            uid = WORKER_UID if uid_state["worker"] else 0
            uid_state["queries"].append(uid)
            return uid

        def drop_to_worker(actual_binding, identity):
            self.assertIs(actual_binding, binding)
            self.assertEqual(identity["id"], PRINCIPAL_ID)
            self.assertFalse(uid_state["worker"], "the launcher reaches the worker boundary as root")
            self.assertEqual(uid_state["queries"], [0])
            observed["uid_before_drop"] = uid_state["queries"][-1]
            uid_state["worker"] = True
            observed["uid_after_drop"] = effective_uid()
            observed["ambient_scrubbed_before_drop"] = PRIVATE_PARENT_ENV not in entry.os.environ
            return {
                "PATH": "/usr/bin:/bin",
                "HOME": home,
                "KCODER_CONFIG_DIR": home + "/.config/kcoder",
                "TMPDIR": home + "/tmp",
            }

        def supervise(_store, identity, start):
            self.assertEqual(identity["id"], PRINCIPAL_ID)
            start()
            return 0

        def execve(path, argv, environment):
            observed["exec"] = (path, list(argv), dict(environment))

        entry.identity_verified = False
        login = {
            "username": "alice",
            "password": "test-only-password",
            "workspace": home + "/workspace",
            "mode": "runtime",
        }
        if include_parent:
            login["retentionParentV1"] = True
        ambient_value = "ambient-untrusted-value"
        with (
            patch.object(entry.sys, "argv", [str(ENTRY_PATH), "--runtime", "/fake/kcoder"]),
            patch.dict(
                entry.os.environ,
                {
                    "SSH_ORIGINAL_COMMAND": "kcoder-account",
                    PRIVATE_PARENT_ENV: ambient_value,
                },
                clear=False,
            ),
            patch.object(entry.os, "geteuid", side_effect=effective_uid),
            patch.object(entry.os, "chdir"),
            patch.object(entry.os, "closerange"),
            patch.object(entry.os, "execve", side_effect=execve),
            patch.object(entry.signal, "signal"),
            patch.object(entry.signal, "alarm"),
            patch.object(entry, "read_login", return_value=login),
            patch.object(entry, "trusted_runtime", return_value="/fake/kcoder"),
            patch.object(entry, "AccountStore", FakeAccountStore),
            patch.object(entry, "ensure_binding", return_value=binding),
            patch.object(entry, "start_knowledge_worker"),
            patch.object(entry, "drop_to_worker", side_effect=drop_to_worker),
            patch.object(entry, "supervise", side_effect=supervise),
            patch.object(entry, "reply"),
        ):
            with self.assertRaises(SystemExit) as exit_info:
                entry.main()
            self.assertEqual(exit_info.exception.code, 0)
            self.assertNotIn(PRIVATE_PARENT_ENV, entry.os.environ)
        observed["geteuid_queries"] = list(uid_state["queries"])
        self.assertEqual(observed["uid_before_drop"], 0)
        self.assertEqual(observed["uid_after_drop"], WORKER_UID)
        self.assertTrue(all(uid == WORKER_UID for uid in observed["geteuid_queries"][1:]))
        return observed

    def test_account_parent_fact_uses_post_drop_effective_uid_and_is_not_ambient(self):
        observed = self.run_entry(include_parent=True)
        self.assertTrue(observed["ambient_scrubbed_before_drop"])
        path, argv, environment = observed["exec"]
        self.assertEqual(path, "/fake/kcoder")
        self.assertEqual(
            argv[-6:],
            [
                "--retention-parent-v1",
                "account",
                "--retention-account-principal-id",
                PRINCIPAL_ID,
                "--retention-account-uid",
                str(WORKER_UID),
            ],
        )
        declaration = environment[PRIVATE_PARENT_ENV]
        self.assertTrue(declaration.startswith("v1."))
        encoded = declaration.removeprefix("v1.")
        parent = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        self.assertEqual(
            parent,
            {
                "version": 1,
                "mode": "verifiedAccount",
                "principalId": PRINCIPAL_ID,
                "uid": WORKER_UID,
            },
        )
        self.assertNotEqual(environment[PRIVATE_PARENT_ENV], "ambient-untrusted-value")

    def test_old_shape_login_gets_post_drop_parent_fact_but_no_explicit_flags(self):
        observed = self.run_entry(include_parent=False)
        self.assertTrue(observed["ambient_scrubbed_before_drop"])
        _path, argv, environment = observed["exec"]
        self.assertNotIn("--retention-parent-v1", argv)
        self.assertIn(PRIVATE_PARENT_ENV, environment)
        declaration = environment[PRIVATE_PARENT_ENV]
        self.assertTrue(declaration.startswith("v1."))
        encoded = declaration.removeprefix("v1.")
        parent = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        self.assertEqual(
            parent,
            {
                "version": 1,
                "mode": "verifiedAccount",
                "principalId": PRINCIPAL_ID,
                "uid": WORKER_UID,
            },
        )


if __name__ == "__main__":
    unittest.main()

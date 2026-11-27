"""Explicit real Rust journal bridge; fixed numeric calls are not model or UID acceptance."""
import copy
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_accounts import AccountStore
from studio_account_files import AccountError
from studio_organization import OrganizationStore
from studio_organization_budget import initialize, inspect as inspect_budget, request


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_ORGANIZATION_BUDGET_NATIVE"), "Explicit current normal Native and root-owned fixtures required")
class NativeBudgetBridgeTests(unittest.TestCase):
    def setUp(self):
        self.programs = tempfile.TemporaryDirectory(prefix="kcoder-budget-native-", dir="/usr/local/lib")
        self.addCleanup(self.programs.cleanup)
        self.program = Path(self.programs.name) / "kcoder"
        shutil.copyfile(os.environ["KCODER_ORGANIZATION_BUDGET_NATIVE"], self.program)
        self.program.chmod(0o700)
        self.temp = tempfile.TemporaryDirectory(prefix="kcoder-budget-state-")
        self.addCleanup(self.temp.cleanup)
        self.accounts = AccountStore(Path(self.temp.name) / "accounts")
        self.alice = self.accounts.create("alice", "synthetic-budget-password")
        self.bob = self.accounts.create("bob", "synthetic-budget-password")
        self.policy = OrganizationStore(self.accounts)
        self.policy.configure("native-org")
        for who in [self.alice, self.bob]:
            self.policy.administer(None, {"operation": "organization.member", "principalId": who["id"], "roles": ["member"]})
        current = {item["id"]: item for item in self.accounts.list()}
        self.alice, self.bob = current[self.alice["id"]], current[self.bob["id"]]
        for who in [self.alice, self.bob]:
            self.policy.administer(None, {"operation": "organization.resource", "expectedRevision": self.policy._load()["revision"],
                "resource": {"id": "workspace:" + who["id"], "kind": "workspace", "owner": who["id"], "visibility": "private", "grants": []}})
        start = int(time.time() // 3600) * 3_600_000
        self.execution = {"version": 1, "modelRules": [], "budgetPolicies": [{"id": "original-cap",
            "scope": {"kind": "organization", "id": "native-org"}, "window": {"id": "owned-hour", "startsAtMs": start, "endsAtMs": start + 3_600_000},
            "limits": {"tokens": 100}, "currency": None}]}
        self.policy.administer(None, {"operation": "organization.executionPolicy", "expectedRevision": self.policy._load()["revision"], "executionPolicy": self.execution})
        self.assertEqual(initialize(self.accounts, str(self.program)), {"initialized": True})

    def call(self, who, action):
        return request(self.accounts, who, str(self.program), "workspace:" + who["id"],
                       {"operation": "budget.request", "rootOperationId": "root-" + who["id"], "action": action})

    def reserve(self, who):
        return {"kind": "reserve", "reservation_id": "original-call", "operation_id": "operation-" + who["id"], "unit": "model_call",
                "task": {"rootOperationId": "root-" + who["id"], "rootTask": {"kind": "turn", "id": "turn-" + who["id"], "revision": None},
                         "actor": "main", "actorAttemptId": "attempt-original", "parentReservationId": None},
                "estimate": {"tokens": 70, "modelCalls": 1, "runMillis": 0, "costMicros": None}}

    def test_two_members_use_original_shared_ledger_and_current_restriction(self):
        first = self.call(self.alice, self.reserve(self.alice))
        self.assertEqual(first["reservation"]["charged"]["tokens"], 70)
        self.assertEqual(self.call(self.alice, self.reserve(self.alice))["reservation"], first["reservation"])
        with self.assertRaisesRegex(AccountError, "BUDGET_EXHAUSTED"):
            self.call(self.bob, self.reserve(self.bob))
        observed = self.call(self.alice, {"kind": "read", "reservation_id": "original-call"})
        self.assertEqual(observed["reservation"]["charged"]["tokens"], 70)
        self.assertIsNone(self.call(self.bob, {"kind": "read", "reservation_id": "original-call"})["reservation"])
        tightened = copy.deepcopy(self.execution)
        tightened["budgetPolicies"][0]["limits"]["tokens"] = 70
        self.policy.administer(None, {"operation": "organization.executionPolicy", "expectedRevision": self.policy._load()["revision"], "executionPolicy": tightened})
        self.assertEqual(self.call(self.alice, {"kind": "read", "reservation_id": "original-call"})["reservation"]["charged"]["tokens"], 70)
        self.assertEqual(self.policy._load()["executionPolicy"], tightened)

    def test_missing_initialized_journal_is_never_recreated(self):
        original = self.accounts.root / "organization-budget"
        original.rename(self.accounts.root / "retained-original-budget")
        with self.assertRaises(OSError):
            initialize(self.accounts, str(self.program))
        self.assertFalse(original.exists())

    def test_inspection_reads_original_usage_and_does_not_install_changed_policy(self):
        reservation = self.call(self.alice, self.reserve(self.alice))["reservation"]
        self.assertFalse(reservation["executionConfirmedTerminal"])
        ledger = self.accounts.root / "organization-budget/ledger.json"
        before = (ledger.stat().st_ino, hashlib.sha256(ledger.read_bytes()).hexdigest())
        report = inspect_budget(self.accounts, str(self.program), expected_revision=self.policy._load()["revision"])
        self.assertEqual(report["status"], "ready")
        self.assertIsNone(report["nextAfter"])
        self.assertEqual(len(report["items"]), 1)
        row = report["items"][0]
        self.assertTrue(row["current"])
        self.assertEqual(row["observation"]["charged"]["tokens"], 70)
        self.assertEqual((ledger.stat().st_ino, hashlib.sha256(ledger.read_bytes()).hexdigest()), before)
        increased = copy.deepcopy(self.execution)
        increased["budgetPolicies"][0]["limits"]["tokens"] = 140
        self.policy.administer(None, {"operation": "organization.executionPolicy", "expectedRevision": self.policy._load()["revision"], "executionPolicy": increased})
        report = inspect_budget(self.accounts, str(self.program), expected_revision=self.policy._load()["revision"])
        row = report["items"][0]
        self.assertFalse(row["current"])
        self.assertEqual(row["configured"]["limits"]["tokens"], 140)
        self.assertEqual(row["observation"]["limits"]["tokens"], 100)
        self.assertEqual(row["observation"]["charged"]["tokens"], 70)
        self.assertEqual((ledger.stat().st_ino, hashlib.sha256(ledger.read_bytes()).hexdigest()), before)
        self.assertFalse(self.call(self.alice, {"kind": "read", "reservation_id": "original-call"})["reservation"]["executionConfirmedTerminal"])

    def test_inspection_never_recreates_a_missing_original_journal(self):
        original = self.accounts.root / "organization-budget"
        original.rename(self.accounts.root / "retained-original-budget")
        with self.assertRaises(OSError):
            inspect_budget(self.accounts, str(self.program), expected_revision=self.policy._load()["revision"])
        self.assertFalse(original.exists())

    def test_explicit_limit_increase_retains_original_charge_and_unknown_hold_in_same_journal(self):
        first = self.call(self.alice, self.reserve(self.alice))["reservation"]
        original_directory = self.accounts.root / "organization-budget"
        file_id = (original_directory.stat().st_dev, original_directory.stat().st_ino)
        with self.assertRaisesRegex(AccountError, "BUDGET_EXHAUSTED"):
            self.call(self.bob, self.reserve(self.bob))
        increased = copy.deepcopy(self.execution)
        increased["budgetPolicies"][0]["limits"]["tokens"] = 140
        self.policy.administer(None, {"operation": "organization.executionPolicy", "expectedRevision": self.policy._load()["revision"], "executionPolicy": increased})
        self.assertEqual((original_directory.stat().st_dev, original_directory.stat().st_ino), file_id)
        observed = self.call(self.alice, {"kind": "read", "reservation_id": "original-call"})["reservation"]
        self.assertEqual(observed["reservationId"], first["reservationId"])
        self.assertEqual(observed["charged"]["tokens"], 70)
        self.assertFalse(observed["executionConfirmedTerminal"])
        self.assertEqual(self.call(self.bob, self.reserve(self.bob))["reservation"]["charged"]["tokens"], 70)
        third = self.reserve(self.bob)
        third["reservation_id"] = "another-call"
        third["operation_id"] = "another-operation"
        third["task"]["actorAttemptId"] = "another-attempt"
        with self.assertRaisesRegex(AccountError, "BUDGET_EXHAUSTED"):
            self.call(self.bob, third)

    def test_actual_private_usage_settles_only_original_call_and_rechecks_tightened_limit(self):
        first = self.call(self.alice, self.reserve(self.alice))["reservation"]
        dispatched = self.call(self.alice, {"kind": "dispatch", "reservation_id": "original-call", "expected_revision": first["revision"]})["reservation"]
        complete = self.call(self.alice, {"kind": "observe", "reservation_id": "original-call", "expected_revision": dispatched["revision"],
            "update_id": "actual-native-stop", "coverage": "complete", "usage": {"tokens": 5, "modelCalls": 1, "runMillis": 0, "costMicros": None},
            "terminal": {"receiptId": "original-native-stop", "receiptSha256": "a" * 64, "kind": "completed"}})["reservation"]
        self.assertEqual(complete["charged"]["tokens"], 5)
        self.assertTrue(complete["executionConfirmedTerminal"])
        self.assertEqual(self.call(self.bob, self.reserve(self.bob))["reservation"]["charged"]["tokens"], 70)
        tightened = copy.deepcopy(self.execution)
        tightened["budgetPolicies"][0]["limits"]["tokens"] = 74
        self.policy.administer(None, {"operation": "organization.executionPolicy", "expectedRevision": self.policy._load()["revision"], "executionPolicy": tightened})
        with self.assertRaisesRegex(AccountError, "BUDGET_EXHAUSTED"):
            self.call(self.bob, {"kind": "check", "reservation_id": "original-call"})


if __name__ == "__main__":
    unittest.main()

"""Current organization model/data boundary and portable policy transactions."""
import copy
import os
import sys
from pathlib import Path
import tempfile
import unittest
import json
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_accounts import AccountStore
from studio_account_files import AccountError, read_private_json, write_private_json
from studio_organization import OrganizationStore
from studio_organization_execution import endpoint_origin, model_resource_id, validate
from studio_organization_channel import OrganizationChannel
from studio_organization_budget import initialize as initialize_budget
from studio_organization_budget import inspect as inspect_budget
from studio_organization_workspace import WorkspaceBudgetBinding


@unittest.skipUnless(os.geteuid() == 0, "Requires owned root policy fixtures")
class ExecutionPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kcoder-organization-execution-")
        self.addCleanup(self.temp.cleanup)
        self.accounts = AccountStore(Path(self.temp.name) / "accounts")
        self.admin = self.accounts.create("operator", "synthetic-execution-password", "admin")
        self.member = self.accounts.create("member", "synthetic-execution-password")
        self.other = self.accounts.create("other", "synthetic-execution-password")
        self.policy = OrganizationStore(self.accounts)
        self.policy.configure("owned-organization")
        for who in [self.admin, self.member, self.other]:
            self.policy.administer(None, {"operation": "organization.member", "principalId": who["id"], "roles": ["member"]})
        current = {item["id"]: item for item in self.accounts.list()}
        self.admin, self.member, self.other = [current[item["id"]] for item in [self.admin, self.member, self.other]]
        self.origin = "https://internal-model.example"
        self.revision = "a" * 64
        self.model_id = model_resource_id("CaseProvider", "ExactModel", self.origin, self.revision)
        self.resource("workspace:owned", "workspace")
        self.resource(self.model_id, "model")
        self.execution = {"version": 1, "modelRules": [{
            "id": "owned-model", "members": [self.member["id"]], "workspaceResourceIds": ["workspace:owned"],
            "provider": "CaseProvider", "model": "ExactModel", "endpointOrigin": self.origin,
            "configurationRevision": self.revision, "enabled": True,
        }], "budgetPolicies": [{
            "id": "shared-cap", "scope": {"kind": "organization", "id": "owned-organization"},
            "window": {"id": "fixed-window", "startsAtMs": 100, "endsAtMs": 1000},
            "limits": {"tokens": 100, "concurrentCalls": 1}, "currency": None,
        }]}

    def resource(self, resource_id, kind, grants=None):
        self.policy.administer(None, {"operation": "organization.resource", "expectedRevision": self.policy._load()["revision"],
            "resource": {"id": resource_id, "kind": kind, "owner": self.member["id"], "visibility": "organization", "grants": grants or []}})

    def save(self, execution=None, actor=None, revision=None):
        return self.policy.administer(actor, {"operation": "organization.executionPolicy", "executionPolicy": execution or self.execution,
            "expectedRevision": self.policy._load()["revision"] if revision is None else revision})

    def request(self, **extra):
        return {"operation": "model.evaluate", "provider": "CaseProvider", "model": "ExactModel", "endpointOrigin": self.origin,
                "configurationRevision": self.revision, "workspaceResourceId": "workspace:owned", "modelResourceId": self.model_id,
                "requestId": "owned-model-call", **extra}

    def test_budget_inspection_is_administrator_only_and_never_initializes(self):
        revision = self.policy._load()["revision"]
        with patch("studio_organization_budget._run", side_effect=AssertionError("Inspection must not create a journal")):
            with self.assertRaises(AccountError):
                inspect_budget(self.accounts, "/not-used", self.member, expected_revision=revision)
            report = inspect_budget(self.accounts, "/not-used", self.admin, expected_revision=revision)
            self.assertEqual(report["status"], "not_configured")
            self.assertEqual(report["items"], [])
            self.assertFalse((self.accounts.root / "organization-budget").exists())
            self.assertFalse((self.accounts.root / "organization-budget-binding.json").exists())
            for value in [True, -1, 129, "0"]:
                with self.assertRaises(AccountError):
                    inspect_budget(self.accounts, "/not-used", self.admin, expected_revision=revision, after=value)
            with self.assertRaises(AccountError):
                inspect_budget(self.accounts, "/not-used", self.admin, expected_revision=revision + 1)

    def test_budget_inspection_pages_ten_current_policies_without_creating_storage(self):
        execution = copy.deepcopy(self.execution)
        for index in range(10):
            workspace = "workspace:inspection-" + str(index)
            self.resource(workspace, "workspace")
            policy = copy.deepcopy(execution["budgetPolicies"][0])
            policy.update(id="inspection-" + str(index), scope={"kind": "workspace", "id": workspace})
            execution["budgetPolicies"].append(policy)
        self.save(execution)
        revision = self.policy._load()["revision"]
        with patch("studio_organization_budget._run", side_effect=AssertionError("No initialization on read")):
            first = inspect_budget(self.accounts, "/not-used", self.admin, expected_revision=revision)
            self.assertEqual(first["status"], "uninitialized")
            self.assertEqual(len(first["items"]), 10)
            self.assertEqual(first["nextAfter"], 10)
            second = inspect_budget(self.accounts, "/not-used", self.admin, expected_revision=revision, after=10)
            self.assertEqual(len(second["items"]), 1)
            self.assertIsNone(second["nextAfter"])
            self.assertFalse((self.accounts.root / "organization-budget").exists())
            marker = self.accounts.root / "organization-budget-binding.json"
            binding = {"version": 1, "instance": self.accounts._load()["instance"],
                       "organizationId": self.policy._load()["id"], "phase": "preparing", "directoryIdentity": None}
            write_private_json(marker, binding)
            self.assertEqual(inspect_budget(self.accounts, "/not-used", self.admin, expected_revision=revision)["status"], "preparing")
            self.assertFalse((self.accounts.root / "organization-budget").exists())
            binding["version"] = True
            write_private_json(marker, binding)
            with self.assertRaises(AccountError):
                inspect_budget(self.accounts, "/not-used", self.admin, expected_revision=revision)

    def test_old_policy_is_denied_and_read_never_initializes_execution_policy(self):
        before = self.policy.path.read_bytes()
        self.assertFalse(self.policy.evaluate_model(self.member, self.request())["allowed"])
        self.assertEqual(self.policy.path.read_bytes(), before)
        self.assertNotIn("executionPolicy", read_private_json(self.policy.path))

    def test_exact_member_model_endpoint_revision_and_workspace_are_all_required(self):
        self.save()
        self.assertTrue(self.policy.evaluate_model(self.member, self.request())["allowed"])
        for extra in [{"provider": "caseprovider"}, {"model": "Other"}, {"endpointOrigin": "https://external.example"},
                      {"configurationRevision": "b" * 64}, {"workspaceResourceId": "workspace:other"}, {"modelResourceId": "model:borrowed"}]:
            self.assertFalse(self.policy.evaluate_model(self.member, self.request(**extra))["allowed"], extra)
        self.assertFalse(self.policy.evaluate_model(self.other, self.request())["allowed"])
        self.assertFalse(self.policy.evaluate_model(self.admin, self.request())["allowed"])

    def test_resource_grant_and_rule_must_both_allow_and_revoke_is_current(self):
        self.save()
        allowed = copy.deepcopy(self.execution)
        allowed["modelRules"][0]["members"].append(self.other["id"])
        self.save(allowed)
        self.assertFalse(self.policy.evaluate_model(self.other, self.request())["allowed"])
        grant = [{"subject": self.other["id"], "actions": ["use"]}]
        self.resource(self.model_id, "model", grant)
        self.resource("workspace:owned", "workspace", grant)
        self.assertTrue(self.policy.evaluate_model(self.other, self.request())["allowed"])
        self.resource(self.model_id, "model")
        self.assertFalse(self.policy.evaluate_model(self.other, self.request())["allowed"])

    def test_admin_write_requires_current_revision_and_member_cannot_relax_policy(self):
        revision = self.policy._load()["revision"]
        self.save(revision=revision)
        with self.assertRaisesRegex(AccountError, "revision conflict"):
            self.save(revision=revision)
        with self.assertRaisesRegex(AccountError, "administrator"):
            self.save(actor=self.member)

    def test_new_backup_roundtrip_and_old_backup_cannot_remove_current_restrictions(self):
        self.save()
        bundle = self.policy.backup()
        self.assertEqual(bundle["executionPolicy"], self.execution)
        self.policy.restore(bundle, self.policy._load()["revision"])
        old = copy.deepcopy(bundle)
        old.pop("executionPolicy")
        self.policy.restore(old, self.policy._load()["revision"])
        self.assertEqual(self.policy._load()["executionPolicy"], self.execution)

    def test_invalid_backup_fails_before_any_account_revision_change(self):
        self.save()
        bundle = self.policy.backup()
        bundle["executionPolicy"]["modelRules"][0]["workspaceResourceIds"] = ["missing-workspace"]
        before = self.accounts.path.read_bytes()
        with self.assertRaises(AccountError):
            self.policy.restore(bundle, self.policy._load()["revision"])
        self.assertEqual(self.accounts.path.read_bytes(), before)

    def test_backup_restore_cannot_silently_raise_the_current_budget_window(self):
        self.save()
        bundle = self.policy.backup()
        bundle["executionPolicy"]["budgetPolicies"][0]["limits"]["tokens"] = 200
        before = self.policy.path.read_bytes()
        with self.assertRaisesRegex(AccountError, "Restored budget window cannot be relaxed"):
            self.policy.restore(bundle, self.policy._load()["revision"])
        self.assertEqual(self.policy.path.read_bytes(), before)

    def test_finite_schema_rejects_credential_origins_bool_limits_and_unknowns(self):
        for key, value in [("endpointOrigin", "https://user:secret@example.com"), ("endpointOrigin", "https://example.com/private"),
                           ("configurationRevision", "not-a-digest"), ("members", [{"id": "forged"}])]:
            candidate = copy.deepcopy(self.execution)
            candidate["modelRules"][0][key] = value
            with self.assertRaises(AccountError):
                validate(candidate, self.accounts._load())
        for limits in [{"tokens": True}, {"tokens": -1}, {"tokens": 2**64}, {"apiKey": 1}, {"concurrentCalls": 2**32}]:
            candidate = copy.deepcopy(self.execution)
            candidate["budgetPolicies"][0]["limits"] = limits
            with self.assertRaises(AccountError):
                validate(candidate, self.accounts._load())
        self.assertEqual(endpoint_origin("https://EXAMPLE.com:443/"), "https://example.com")

    def test_current_budget_family_cannot_be_reset_by_removal_or_rebinding_the_window(self):
        self.save()
        for mutate in [lambda item: item.update(budgetPolicies=[]),
                       lambda item: item["budgetPolicies"][0].update(id="replacement-family"),
                       lambda item: item["budgetPolicies"][0]["window"].update(id="overlapping-new-window")]:
            candidate = copy.deepcopy(self.execution)
            mutate(candidate)
            with self.assertRaises(AccountError):
                self.save(candidate)
        next_window = copy.deepcopy(self.execution)
        next_window["budgetPolicies"][0]["window"] = {"id": "next-window", "startsAtMs": 1000, "endsAtMs": 2000}
        next_window["budgetPolicies"][0]["limits"]["tokens"] = 200
        self.save(next_window)
        self.assertEqual(self.policy._load()["executionPolicy"], next_window)

    def test_administrator_can_explicitly_adjust_existing_limit_with_original_revision_and_dimensions(self):
        self.save()
        increased = copy.deepcopy(self.execution)
        increased["budgetPolicies"][0]["limits"]["tokens"] = 200
        revision = self.policy._load()["revision"]
        with self.assertRaises(AccountError):
            self.save(increased, actor=self.member)
        self.save(increased, revision=revision)
        self.assertEqual(self.policy._load()["executionPolicy"], increased)
        with self.assertRaisesRegex(AccountError, "revision conflict"):
            self.save(increased, revision=revision)
        removed_dimension = copy.deepcopy(increased)
        del removed_dimension["budgetPolicies"][0]["limits"]["tokens"]
        with self.assertRaisesRegex(AccountError, "dimension cannot be removed"):
            self.save(removed_dimension)

    def test_budget_window_cannot_be_rotated_before_original_time_has_elapsed(self):
        self.save()
        candidate = copy.deepcopy(self.execution)
        candidate["budgetPolicies"][0]["window"] = {"id": "next-window", "startsAtMs": 1000, "endsAtMs": 2000}
        with patch("studio_organization_execution.time.time", return_value=0.5):
            with self.assertRaisesRegex(AccountError, "end early"):
                self.save(candidate)

    def test_actual_owned_policy_socket_rechecks_the_same_members_current_rule(self):
        self.save()
        channel = OrganizationChannel(self.accounts, self.member)
        self.addCleanup(channel.close)
        channel.child.settimeout(1)

        def query():
            channel.child.send(json.dumps(self.request()).encode())
            self.assertTrue(channel.poll(1))
            return json.loads(channel.child.recv(8192))

        first = query()
        self.assertTrue(first["ok"])
        self.assertTrue(first["result"]["allowed"])
        changed = copy.deepcopy(self.execution)
        changed["modelRules"][0]["enabled"] = False
        self.save(changed)
        second = query()
        self.assertTrue(second["ok"])
        self.assertFalse(second["result"]["allowed"])
        self.assertGreater(second["result"]["policyRevision"], first["result"]["policyRevision"])

    def test_lost_initialization_does_not_retry_create_or_recreate_missing_journal(self):
        self.save()
        calls = []

        def created_but_lost(_runtime, envelope):
            calls.append(envelope["action"]["kind"])
            (self.accounts.root / "organization-budget").mkdir(mode=0o700)
            raise AccountError("original receipt lost")

        with patch("studio_organization_budget._run", side_effect=created_but_lost):
            with self.assertRaisesRegex(AccountError, "receipt lost"):
                initialize_budget(self.accounts, "/fixture/native")
        self.assertEqual(calls, ["create"])
        with patch("studio_organization_budget._run", return_value={"initialized": True}) as run:
            initialize_budget(self.accounts, "/fixture/native")
            self.assertEqual(run.call_args.args[1]["action"], {"kind": "initialize"})
        original = self.accounts.root / "organization-budget"
        original.rename(self.accounts.root / "retained-original-budget")
        with patch("studio_organization_budget._run") as run:
            with self.assertRaises(OSError):
                initialize_budget(self.accounts, "/fixture/native")
            run.assert_not_called()
        self.assertFalse(original.exists())

    def test_budget_channel_does_not_trust_a_copied_frame_without_the_original_runtime_pid(self):
        self.save()
        channel = OrganizationChannel(self.accounts, self.member)
        self.addCleanup(channel.close)
        channel.child.settimeout(1)
        home = Path(self.temp.name) / "peer-workspace"
        (home / ".config/kcoder").mkdir(mode=0o700, parents=True)
        (home / ".config").chmod(0o700)
        (home / "workspace").mkdir(mode=0o700)
        with patch("studio_organization_workspace.validate_binding"):
            channel.workspace_resource = WorkspaceBudgetBinding({"uid": 0, "home": str(home)}, self.member, home / "workspace")
        channel.child.send(json.dumps({"operation": "budget.request", "rootOperationId": "forged", "action": {"kind": "read", "reservation_id": "guessed"}}).encode())
        with patch("studio_organization_budget.request") as execute:
            channel.poll(1)
            response = json.loads(channel.child.recv(8192))
            self.assertFalse(response["ok"])
            execute.assert_not_called()
        self.assertFalse((self.accounts.root / "organization-budget").exists())


if __name__ == "__main__":
    unittest.main()

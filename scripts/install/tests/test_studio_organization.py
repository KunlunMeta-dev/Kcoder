"""Current organization authority with real private persistence and OS sockets."""

import copy
import json
import multiprocessing
import os
from pathlib import Path
import pwd
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_accounts import AccountError, AccountStore
from studio_account_files import read_private_json, write_private_json
from studio_organization import OrganizationStore
from studio_organization_channel import OrganizationChannel
from studio_organization_directory import ISSUER, authenticate_directory, directory_subject

PASSWORD = "synthetic-organization-password"


@unittest.skipUnless(os.geteuid() == 0, "Account service requires root-owned fixtures")
class OrganizationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kcoder-organization-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = AccountStore(self.root / "accounts")
        self.admin = self.store.create("operator", PASSWORD, "admin")
        self.alice = self.store.create("alice", PASSWORD)
        self.bob = self.store.create("bob", PASSWORD)
        self.policy = OrganizationStore(self.store)
        self.policy.configure("fixture-organization")
        for principal in (self.admin, self.alice, self.bob):
            self.member(principal, ["member"])
        self.refresh()

    def refresh(self):
        current = {item["username"]: item for item in self.store.list()}
        self.admin, self.alice, self.bob = [current[name] for name in ("operator", "alice", "bob")]

    def fixture_binding(self, identity):
        data = self.store._load()
        data["bindings"][identity["id"]] = {"uid": 22001, "gid": 22001, "home": "/synthetic-worker", "instance": data["instance"]}
        write_private_json(self.store.path, data)

    def member(self, principal, roles, **extra):
        return self.policy.administer(None, {"operation": "organization.member", "principalId": principal["id"], "roles": roles, **extra})

    def resource(self, name="knowledge:alice", owner=None, visibility="private", grants=None, kind="knowledge", actor=None, audit_scope="organization"):
        revision = self.policy._load()["revision"]
        return self.policy.administer(actor, {"operation": "organization.resource", "expectedRevision": revision,
            "resource": {"id": name, "kind": kind, "owner": (owner or self.alice)["id"],
                         "visibility": visibility, "grants": grants or [], **({"auditScope": audit_scope} if kind == "audit" else {})}})

    def test_admin_does_not_gain_member_private_body_or_export(self):
        self.resource()
        for action in ("read", "export", "use"):
            self.assertFalse(self.policy.evaluate(self.admin, action, "knowledge:alice", "admin-attempt")["allowed"])
        self.assertTrue(self.policy.evaluate(self.alice, "read", "knowledge:alice", "owner-read")["allowed"])
        self.assertFalse(self.policy.evaluate(self.bob, "read", "knowledge:alice", "other-read")["allowed"])

    def test_knowledge_locator_is_metadata_and_preserves_distinct_management_and_publisher_identities(self):
        from studio_organization_publications import _resource
        self.fixture_binding(self.alice)
        data_owner = {"accountId": "native-data-account", "targetId": "native-data-target", "workspaceId": "native-nondefault-workspace", "organizationId": "fixture-organization"}
        resource = {"id": _resource(data_owner, "fixed-publication"), "kind": "knowledge", "owner": self.admin["id"], "visibility": "organization", "grants": [],
                    "nativeKnowledgeSource": {"version": 1, "publisherPrincipalId": self.alice["id"], "publicationOwner": data_owner, "publicationId": "fixed-publication"}}
        def save(value):
            return self.policy.administer(None, {"operation": "organization.resource", "expectedRevision": self.policy._load()["revision"], "resource": value})
        with patch("studio_account_runtime.validate_binding", return_value=None) as validate:
            save(resource)
            validate.assert_called_once()
        stored = self.policy._load()["resources"][resource["id"]]
        self.assertEqual(stored["owner"], self.admin["id"])
        self.assertEqual(stored["nativeKnowledgeSource"]["publisherPrincipalId"], self.alice["id"])
        self.assertFalse(self.policy.evaluate(self.bob, "read", resource["id"], "metadata-not-a-grant")["allowed"])
        self.assertFalse(self.policy.evaluate(self.admin, "read", resource["id"], "manager-not-source-owner")["allowed"])
        rebinding = copy.deepcopy(resource)
        rebinding["nativeKnowledgeSource"]["publisherPrincipalId"] = self.bob["id"]
        self.fixture_binding(self.bob)
        with patch("studio_account_runtime.validate_binding", return_value=None):
            with self.assertRaisesRegex(AccountError, "locator is immutable"):
                save(rebinding)
        bundle = self.policy.backup()
        with patch("studio_organization.publish_worker_marker"):
            self.policy.restore(bundle, self.policy._load()["revision"])
        self.assertEqual(self.policy._load()["resources"][resource["id"]], resource)

    def test_knowledge_locator_wrong_scope_hash_or_unregistered_publisher_is_rejected_before_write(self):
        from studio_organization_publications import _resource
        owner = {"accountId": "native-account", "targetId": "native-target", "workspaceId": None, "organizationId": None}
        original = {"id": _resource(owner, "old-personal"), "kind": "knowledge", "owner": self.admin["id"], "visibility": "organization", "grants": [],
                    "nativeKnowledgeSource": {"version": 1, "publisherPrincipalId": self.alice["id"], "publicationOwner": owner, "publicationId": "old-personal"}}
        before = self.policy.path.read_bytes()
        mutations = [lambda row: row.update(id="knowledge:forged"),
                     lambda row: row["nativeKnowledgeSource"].update(trusted=True),
                     lambda row: row["nativeKnowledgeSource"]["publicationOwner"].update(organizationId="foreign-org"),
                     lambda row: row["nativeKnowledgeSource"].update(publisherPrincipalId="fake-principal"),
                     lambda row: row.update(kind="model")]
        for mutate in mutations:
            value = copy.deepcopy(original)
            mutate(value)
            with self.assertRaises(AccountError):
                self.policy.administer(None, {"operation": "organization.resource", "expectedRevision": self.policy._load()["revision"], "resource": value})
            self.assertEqual(self.policy.path.read_bytes(), before)
        with self.assertRaisesRegex(AccountError, "binding required"):
            self.policy.administer(None, {"operation": "organization.resource", "expectedRevision": self.policy._load()["revision"], "resource": original})

    def test_current_policy_after_reopen_and_user_restrictions_only_shrink(self):
        self.resource(visibility="organization", grants=[{"subject": self.bob["id"], "actions": ["read"]}])
        reopened = OrganizationStore(AccountStore(self.root / "accounts"))
        self.assertTrue(reopened.evaluate(self.bob, "read", "knowledge:alice", "one")["allowed"])
        self.assertFalse(reopened.evaluate(self.bob, "export", "knowledge:alice", "two", ["read", "export"])["allowed"])
        self.assertFalse(reopened.evaluate(self.bob, "read", "knowledge:alice", "three", ["export"])["allowed"])
        self.resource(visibility="organization", grants=[])
        self.assertFalse(reopened.evaluate(self.bob, "read", "knowledge:alice", "after-revoke")["allowed"])

    def test_role_is_current_membership_and_caller_actor_labels_do_not_grant(self):
        self.resource(visibility="organization", grants=[{"subject": "role:knowledgePublisher", "actions": ["publish"]}])
        forged = {**self.bob, "role": "admin", "roles": ["knowledgePublisher"]}
        self.assertFalse(self.policy.evaluate(forged, "publish", "knowledge:alice", "forged-role")["allowed"])
        self.member(self.bob, ["knowledgePublisher"])
        with self.assertRaisesRegex(AccountError, "changed"):
            self.policy.evaluate(self.bob, "publish", "knowledge:alice", "old-identity")
        self.refresh()
        self.assertTrue(self.policy.evaluate(self.bob, "publish", "knowledge:alice", "new-identity")["allowed"])

    def test_member_disable_invalidates_session_and_next_action(self):
        self.resource()
        identity = copy.deepcopy(self.alice)
        self.assertIsNotNone(self.policy.inspect_session(identity))
        self.member(identity, ["member"], disabled=True)
        self.assertFalse(self.store.session_current(identity))
        with self.assertRaises(AccountError):
            self.policy.evaluate(identity, "read", "knowledge:alice", "revoked")

    def test_admin_revoked_between_dispatch_and_actual_org_write(self):
        operation = {"operation": "organization.resource", "expectedRevision": self.policy._load()["revision"],
            "resource": {"id": "knowledge:admin", "kind": "knowledge", "owner": self.admin["id"], "visibility": "private", "grants": []}}
        administer = OrganizationStore.administer
        def revoke_then_write(instance, actor, request):
            self.store.revoke_sessions("operator")
            return administer(instance, actor, request)
        before = self.policy.path.read_bytes()
        with patch.object(OrganizationStore, "administer", revoke_then_write):
            with self.assertRaisesRegex(AccountError, "changed"):
                self.store.administer(self.admin, operation)
        self.assertEqual(before, self.policy.path.read_bytes())

    def test_concurrent_policy_updates_have_one_cas_winner(self):
        revision = self.policy._load()["revision"]
        context = multiprocessing.get_context("fork")
        result = context.Queue()
        def update(name):
            try:
                policy = OrganizationStore(AccountStore(self.root / "accounts"))
                policy.administer(None, {"operation": "organization.resource", "expectedRevision": revision,
                    "resource": {"id": name, "kind": "model", "owner": self.alice["id"], "visibility": "private", "grants": []}})
                result.put("committed")
            except AccountError:
                result.put("conflict")
        children = [context.Process(target=update, args=("model:" + name,)) for name in ("first", "second")]
        for child in children: child.start()
        for child in children: child.join(10); self.assertEqual(child.exitcode, 0)
        self.assertCountEqual([result.get(timeout=1), result.get(timeout=1)], ["committed", "conflict"])
        result.close()
        self.assertEqual(self.policy._load()["revision"], revision + 1)

    def test_admin_cannot_relabel_private_resource_owner_or_visibility(self):
        self.resource()
        with self.assertRaisesRegex(AccountError, "ownership"):
            self.resource(owner=self.admin, actor=self.admin)
        with self.assertRaisesRegex(AccountError, "owner"):
            self.resource(visibility="organization", actor=self.admin)

    def test_audit_export_requires_independent_grant_and_has_no_private_data(self):
        self.resource("audit:organization", owner=self.alice, kind="audit", visibility="organization",
                      grants=[{"subject": "role:auditor", "actions": ["export"]}])
        request = {"operation": "organization.export", "resourceId": "audit:organization"}
        with self.assertRaisesRegex(AccountError, "export permission"):
            self.store.administer(self.admin, request)
        self.member(self.bob, ["auditor"])
        self.refresh()
        bundle = self.policy.administer(self.bob, request)
        raw = json.dumps(bundle)
        for private in (PASSWORD, "scrypt", "password", "uid", "home", "environment", "body"):
            self.assertNotIn(private, raw)
        self.assertTrue(bundle["events"])
        self.assertEqual(self.policy.audit.stat().st_mode & 0o777, 0o600)
        self.assertNotIn("bindings", raw)

    def test_policy_channel_uses_bound_actor_rejects_scope_and_observes_revocation(self):
        self.resource()
        channel = OrganizationChannel(self.store, self.alice)
        self.addCleanup(channel.close)
        def exchange(frame):
            channel.child.send(json.dumps(frame).encode())
            self.assertTrue(channel.poll(1))
            return json.loads(channel.child.recv(8192))
        self.assertEqual(exchange({"operation": "inspect"})["result"]["principalId"], self.alice["id"])
        self.assertFalse(exchange({"operation": "evaluate", "action": "read", "resourceId": "knowledge:alice", "requestId": "malicious", "actor": self.admin})["ok"])
        self.assertTrue(exchange({"operation": "evaluate", "action": "read", "resourceId": "knowledge:alice", "requestId": "valid"})["result"]["allowed"])
        self.store.revoke_sessions("alice")
        self.assertFalse(exchange({"operation": "inspect"})["ok"])

    def test_personal_account_channel_does_not_require_org_configuration(self):
        personal = AccountStore(self.root / "personal")
        identity = personal.create("personal", PASSWORD)
        channel = OrganizationChannel(personal, identity)
        self.addCleanup(channel.close)
        self.assertIsNone(channel.child_fd())
        self.assertTrue(channel.current())

    def test_directory_auth_maps_only_fixed_issuer_existing_member_and_binding(self):
        account = pwd.struct_passwd(("directory-fixture", "x", 21001, 21001, "", "/directory-home", "/bin/false"))
        with patch("studio_organization_directory.pwd.getpwnam", return_value=account), patch("studio_organization_directory._bounded_pam") as authenticate:
            self.member(self.alice, ["member"], directory={"issuer": ISSUER, "username": "directory-fixture"})
            with self.assertRaisesRegex(AccountError, "existing worker"):
                authenticate_directory(self.store, "directory-fixture", PASSWORD)
            data = self.store._load()
            data["bindings"][self.alice["id"]] = {"uid": 22001, "gid": 22001, "home": "/synthetic-worker", "instance": data["instance"]}
            write_private_json(self.store.path, data)
            identity = authenticate_directory(self.store, "directory-fixture", PASSWORD)
            self.assertEqual(identity["id"], self.alice["id"])
            self.assertNotIn(PASSWORD, self.policy.path.read_text())
            self.assertNotIn("directory-home", self.policy.path.read_text())
            authenticate.assert_called_with("directory-fixture", PASSWORD)
            with self.assertRaises(AccountError):
                directory_subject({"issuer": "caller-chosen-issuer", "username": "directory-fixture"})

    def test_directory_removal_or_uid_reuse_revokes_existing_session(self):
        account = pwd.struct_passwd(("directory-fixture", "x", 21001, 21001, "", "/directory-home", "/bin/false"))
        with patch("studio_organization_directory.pwd.getpwnam", return_value=account), patch("studio_organization_directory._bounded_pam"):
            self.member(self.alice, ["member"], directory={"issuer": ISSUER, "username": "directory-fixture"})
            self.refresh()
            self.assertIsNotNone(self.policy.inspect_session(self.alice))
            with patch("studio_organization_directory.pwd.getpwnam", side_effect=KeyError()):
                with self.assertRaises(KeyError): self.policy.inspect_session(self.alice)
            reused = pwd.struct_passwd(("directory-fixture", "x", 21002, 21001, "", "/directory-home", "/bin/false"))
            with patch("studio_organization_directory.pwd.getpwnam", return_value=reused):
                with self.assertRaisesRegex(AccountError, "changed"): self.policy.inspect_session(self.alice)

    def test_unsafe_audit_and_policy_paths_fail_closed(self):
        self.resource()
        self.policy.audit.chmod(0o644)
        with self.assertRaisesRegex(AccountError, "Unsafe"):
            self.policy.evaluate(self.alice, "read", "knowledge:alice", "unsafe-audit")

    def test_policy_backup_restore_preserves_ids_revokes_sessions_and_excludes_machine_facts(self):
        self.resource()
        bundle = self.policy.backup()
        self.assertNotIn("password", json.dumps(bundle))
        self.assertNotIn("directory", json.dumps(bundle))
        revision = self.policy._load()["revision"]
        self.resource(visibility="organization", grants=[{"subject": self.bob["id"], "actions": ["read"]}])
        with self.assertRaisesRegex(AccountError, "revision conflict"):
            self.policy.restore(bundle, revision)
        restored = self.policy.restore(bundle, revision + 1)
        self.assertEqual(restored["revision"], revision + 2)
        self.assertFalse(self.store.session_current(self.alice))
        self.refresh()
        self.assertFalse(self.policy.evaluate(self.bob, "read", "knowledge:alice", "restored-private")["allowed"])
        self.assertEqual(self.policy._load()["resources"]["knowledge:alice"]["owner"], self.alice["id"])

    def test_policy_restore_rejects_unknown_member_before_any_write(self):
        bundle = self.policy.backup()
        bundle["members"]["not-an-existing-account"] = {"roles": ["auditor"], "disabled": False}
        before = self.store.path.read_bytes(), self.policy.path.read_bytes()
        with self.assertRaisesRegex(AccountError, "existing portable"):
            self.policy.restore(bundle, self.policy._load()["revision"])
        self.assertEqual(before, (self.store.path.read_bytes(), self.policy.path.read_bytes()))

    def test_member_projection_never_lists_other_members_or_resource_counts(self):
        self.resource()
        result = self.store.administer(self.bob, {"operation": "organization.self"})
        self.assertEqual([item["principalId"] for item in result["members"]], [self.bob["id"]])
        self.assertEqual(result["resources"], [])
        self.assertEqual(result["auditExportResources"], [])
        with self.assertRaisesRegex(AccountError, "administrator"):
            self.store.administer(self.bob, {"operation": "organization.inspect"})

    def test_member_update_requires_current_remote_policy_revision(self):
        before = self.policy.path.read_bytes(), self.store.path.read_bytes()
        with self.assertRaisesRegex(AccountError, "revision conflict"):
            self.store.administer(self.admin, {"operation": "organization.member", "principalId": self.bob["id"], "roles": ["auditor"], "expectedRevision": 1})
        self.assertEqual(before, (self.policy.path.read_bytes(), self.store.path.read_bytes()))

    def test_directory_revocation_also_blocks_password_login_and_identity_admin_export(self):
        account = pwd.struct_passwd(("directory-fixture", "x", 21001, 21001, "", "/directory-home", "/bin/false"))
        with patch("studio_organization_directory.pwd.getpwnam", return_value=account), patch("studio_organization_directory._bounded_pam"):
            self.member(self.admin, ["member"], directory={"issuer": ISSUER, "username": "directory-fixture"})
            self.fixture_binding(self.admin)
            actor = self.store.authenticate("operator", PASSWORD)
            with patch("studio_organization_directory._bounded_pam", side_effect=AccountError("Directory authentication unavailable")):
                with self.assertRaises(AccountError): self.store.administer(actor, {"operation": "export"})
                with self.assertRaises(AccountError): self.store.authenticate("operator", PASSWORD)
                self.assertFalse(self.store.session_current(actor))

    def test_existing_login_uses_root_mapped_directory_subject_without_local_password_fallback(self):
        account = pwd.struct_passwd(("directory-fixture", "x", 21001, 21001, "", "/directory-home", "/bin/false"))
        with patch("studio_organization_directory.pwd.getpwnam", return_value=account), patch("studio_organization_directory._bounded_pam") as authenticate:
            self.member(self.alice, ["member"], directory={"issuer": ISSUER, "username": "directory-fixture"})
            self.fixture_binding(self.alice)
            identity = self.store.authenticate("alice", "external-directory-password")
            self.assertEqual(identity["id"], self.alice["id"])
            self.assertEqual(identity["username"], "alice")
            authenticate.assert_called_with("directory-fixture", "external-directory-password")
            with patch("studio_organization_directory._bounded_pam", side_effect=AccountError("Directory authentication failed")):
                with self.assertRaises(AccountError): self.store.authenticate("alice", PASSWORD)

    def test_mapping_revision_changed_during_directory_authentication_cannot_publish_old_login(self):
        account = pwd.struct_passwd(("directory-fixture", "x", 21001, 21001, "", "/directory-home", "/bin/false"))
        with patch("studio_organization_directory.pwd.getpwnam", return_value=account):
            self.member(self.alice, ["member"], directory={"issuer": ISSUER, "username": "directory-fixture"})
            self.fixture_binding(self.alice)
            with patch("studio_organization_directory._bounded_pam", side_effect=lambda *_: self.store.revoke_sessions("alice")):
                with self.assertRaisesRegex(AccountError, "authorization has changed"):
                    self.store.authenticate("alice", "external-directory-password")

    def test_audit_resource_scope_filters_events_and_counts_before_export(self):
        self.resource()
        self.resource("knowledge:bob", owner=self.bob)
        self.policy.evaluate(self.alice, "read", "knowledge:alice", "alice-read")
        self.policy.evaluate(self.alice, "read", "knowledge:bob", "bob-denied")
        self.resource("audit:alice", kind="audit", visibility="organization",
                      grants=[{"subject": "role:auditor", "actions": ["export"]}],
                      audit_scope={"resourceIds": ["knowledge:alice"]})
        self.member(self.bob, ["auditor"])
        self.refresh()
        bundle = self.policy.administer(self.bob, {"operation": "organization.export", "resourceId": "audit:alice"})
        self.assertEqual(bundle["scope"], {"resourceIds": ["knowledge:alice"]})
        self.assertTrue(bundle["events"])
        self.assertEqual({event["resource"] for event in bundle["events"]}, {"knowledge:alice"})
        self.assertNotIn("knowledge:bob", json.dumps(bundle))

    def test_lost_policy_file_cannot_restore_personal_login_or_admin_export(self):
        self.policy.path.rename(self.policy.path.with_suffix(".saved"))
        with self.assertRaisesRegex(AccountError, "policy is unavailable"):
            self.store.authenticate("alice", PASSWORD)
        with self.assertRaisesRegex(AccountError, "policy is unavailable"):
            self.store.administer(self.admin, {"operation": "export"})
        self.assertFalse(self.store.session_current(self.alice))
        with self.assertRaisesRegex(AccountError, "policy is unavailable"):
            OrganizationChannel(self.store, self.alice)

    def test_policy_identity_cannot_replace_existing_account_governance(self):
        policy = self.policy._load()
        policy["id"] = "caller-selected-organization"
        write_private_json(self.policy.path, policy)
        with self.assertRaisesRegex(AccountError, "authority has changed"):
            self.store.authenticate("alice", PASSWORD)


if __name__ == "__main__":
    unittest.main()

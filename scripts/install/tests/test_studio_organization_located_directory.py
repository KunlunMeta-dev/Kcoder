"""PDP source locators select actual publisher UIDs and registered Native workspaces."""
import copy
import hashlib
import json
import os
from pathlib import Path
import unittest
import uuid

from organization_publication_fixture import Fixture, resource_key
from test_studio_organization_nondefault_workspace import account_workspace_session


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1"
    and os.environ.get("KCODER_ORGANIZATION_APP_SERVER") and os.environ.get("KCODER_ORGANIZATION_LEGACY_FIXTURE"),
    "Explicit owned actual UID and Native/seed binaries required")
class LocatedPublicationDirectoryTests(unittest.TestCase):
    def test_management_owner_is_not_physical_publisher_and_registered_workspace_pages_remain_source_bound(self):
        with Fixture(self) as fixture:
            # This corpus tests publication reads; no Wiki organization work
            # belongs to the owned fixture or its durable account worker.
            settings = Path(fixture.bindings["publisher"]["home"]) / ".config/kcoder/settings.json"
            document = json.loads(settings.read_text())
            document["knowledge"] = {"enabled": True, "retrieval_enabled": True, "organization_enabled": False}
            settings.write_text(json.dumps(document))
            seed = fixture.seed("publisher")
            default, reader, manager = (fixture.session(name) for name in ("publisher", "reader", "administrator"))
            for name, session in (("publisher", default), ("reader", reader), ("administrator", manager)):
                fixture.resource(name, session.owner, "knowledge", "current-target")
            binding = fixture.bindings["publisher"]
            workspace = Path(binding["home"]) / "owned-directory-workspace"
            workspace.mkdir(mode=0o700); os.chown(workspace, binding["uid"], binding["gid"])
            alternate = account_workspace_session(fixture, "publisher", workspace)
            fixture.resource("publisher", alternate.owner, "knowledge", "current-target")
            default.rpc("runtime.workspaces.open", {"workspacePath": str(workspace),
                "projectKey": "owned-located-source", "label": "Owned actual source", "clientRequestId": str(uuid.uuid4())})
            for session in (default, alternate):
                fixture.resource("publisher", session.owner, "knowledge-audience",
                    json.dumps(["organization", fixture.organization], separators=(",", ":")))

            resources = []
            def publish(session, identity, management="administrator"):
                fixture.policy.administer(None, {"operation": "organization.resource",
                    "expectedRevision": fixture.policy._load()["revision"], "resource": {
                        "id": resource_key("publication", session.owner, identity), "kind": "knowledge",
                        "owner": fixture.identities[management]["id"], "visibility": "organization",
                        "grants": [{"subject": fixture.identities["publisher"]["id"], "actions": ["read", "use", "publish"]},
                                   {"subject": fixture.identities["reader"]["id"], "actions": ["read", "use"]}]}})
                draft = {"publicationId": identity, "title": "Owned source title", "purpose": "Real source locator directory",
                    "reviewConclusion": None, "visibility": "organization", "audienceId": fixture.organization,
                    "sources": [seed["source"]], "validFromMs": None, "validUntilMs": None, "unresolved": []}
                result = session.call("publishKnowledge", {"draft": draft}, True, 0)
                self.assertEqual(result["status"], "completed", result)
                return {"owner": session.owner, "publicationId": identity, "version": 1}

            selected = publish(alternate, "located-0")
            # Keep the original legacy ambiguity as a failure. Merely giving the
            # management owner a Native identity does not invent a publisher.
            legacy = reader.call("listPublications", {"after": None})
            self.assertEqual(legacy["status"], "unavailable", legacy)
            self.assertIsNone(legacy.get("result"))

            def locate(reference, management):
                resource = {"id": resource_key("publication", reference["owner"], reference["publicationId"]),
                    "kind": "knowledge", "owner": fixture.identities[management]["id"], "visibility": "organization",
                    "grants": [{"subject": fixture.identities["publisher"]["id"], "actions": ["read", "use", "publish"]},
                               {"subject": fixture.identities["reader"]["id"], "actions": ["read", "use"]}],
                    "nativeKnowledgeSource": {"version": 1, "publisherPrincipalId": fixture.identities["publisher"]["id"],
                        "publicationOwner": reference["owner"], "publicationId": reference["publicationId"]}}
                fixture.policy.administer(None, {"operation": "organization.resource",
                    "expectedRevision": fixture.policy._load()["revision"], "resource": resource})
                resources.append(resource)
            locate(selected, "administrator")
            for index in range(1, 10): locate(publish(alternate, "located-" + str(index)), "administrator")
            locate(publish(default, "located-0", "reader"), "reader")
            profile = Path(binding["home"]) / ".config/kcoder"
            source_files = [path for path in profile.glob("integration-*/catalog-binding.json")]
            source_files += [path.with_name("catalog.sqlite") for path in source_files]
            source_before = {str(path): (path.stat().st_ino, path.stat().st_uid,
                hashlib.sha256(path.read_bytes()).hexdigest()) for path in source_files}
            def page(after=None):
                reply = reader.call("listPublications", {"after": after})
                self.assertEqual(reply["status"], "completed", reply)
                return reply["result"]["page"]
            first = page(); self.assertEqual(len(first["items"]), 10); self.assertIsNotNone(first["nextCursor"])
            second = page(first["nextCursor"]); self.assertEqual(len(second["items"]), 1)
            union = first["items"] + second["items"]
            owners = {(item["owner"]["workspaceId"], item["draft"]["publicationId"]) for item in union}
            self.assertEqual(len(owners), 11)
            self.assertIn((default.owner["workspaceId"], "located-0"), owners)
            self.assertIn((alternate.owner["workspaceId"], "located-0"), owners)
            self.assertEqual({item["owner"]["accountId"] for item in union}, {default.owner["accountId"]})
            resolved = reader.call("resolvePublication", selected)
            self.assertEqual(resolved["status"], "completed", resolved)
            self.assertEqual(resolved["result"]["publication"]["owner"], alternate.owner)
            self.assertEqual(reader.call("adoptPublication", selected, True, 0)["status"], "completed")
            self.assertEqual(reader.call("retrieveKnowledge", {**selected, "query": "reviewed", "limit": 3})["status"], "completed")
            denied = manager.call("resolvePublication", selected)
            self.assertNotEqual(denied["status"], "completed"); self.assertIsNone(denied.get("result"))
            manager_list = manager.call("listPublications", {"after": None})
            self.assertEqual(manager_list["status"], "completed", manager_list)
            self.assertEqual(manager_list["result"]["page"]["items"], [])
            def save_resource(resource):
                fixture.policy.administer(None, {"operation": "organization.resource",
                    "expectedRevision": fixture.policy._load()["revision"], "resource": resource})
            before_policy = page()
            read_only = copy.deepcopy(resources[0])
            read_only["grants"][1]["actions"] = ["read"]
            save_resource(read_only)
            stale_policy = reader.call("listPublications", {"after": before_policy["nextCursor"]})
            self.assertNotEqual(stale_policy["status"], "completed"); self.assertIsNone(stale_policy.get("result"))
            self.assertNotEqual(reader.call("retrieveKnowledge", {**selected, "query": "reviewed", "limit": 3})["status"], "completed")
            revoked = copy.deepcopy(resources[0]); revoked["grants"] = revoked["grants"][:1]
            save_resource(revoked)
            visible = page(); remaining = visible["items"]
            if visible["nextCursor"] is not None: remaining += page(visible["nextCursor"])["items"]
            self.assertEqual(len(remaining), 10)
            self.assertFalse(any(item["owner"] == selected["owner"] and item["draft"]["publicationId"] == selected["publicationId"] for item in remaining))
            self.assertNotEqual(reader.call("resolvePublication", selected)["status"], "completed")
            save_resource(resources[0])
            alternate.stop()
            source_binding = next(path for path in source_files if path.name == "catalog-binding.json"
                and json.loads(path.read_text())["owner"] == alternate.owner)
            original_binding = source_binding.read_bytes()
            source_binding.write_bytes(b'{}')
            try:
                corrupt = reader.call("listPublications", {"after": None})
                self.assertEqual(corrupt["status"], "unavailable", corrupt)
                self.assertIsNone(corrupt.get("result"))
            finally:
                source_binding.write_bytes(original_binding)
            fresh = page()
            removed = default.rpc("runtime.workspaces.delete", {"workspacePath": str(workspace)})
            self.assertTrue(removed["deleted"])
            old_cursor = reader.call("listPublications", {"after": fresh["nextCursor"]})
            self.assertNotEqual(old_cursor["status"], "completed"); self.assertIsNone(old_cursor.get("result"))
            missing = reader.call("listPublications", {"after": None})
            self.assertEqual(missing["status"], "unavailable", missing)
            self.assertIsNone(missing.get("result"))
            self.assertEqual({str(path): (path.stat().st_ino, path.stat().st_uid,
                hashlib.sha256(path.read_bytes()).hexdigest()) for path in source_files}, source_before)
            storage = fixture.reader_storage("reader", source_binding.with_name("catalog.sqlite"))
            self.assertTrue(storage["foreignOsReadDenied"]); self.assertEqual(storage["publicationRows"], 0)
            self.assertEqual(storage["adoptionRows"], 1)
            print(json.dumps({"locatedDirectoryEvidence": {"publisherUid": binding["uid"],
                "readerUid": fixture.bindings["reader"]["uid"], "managementUid": fixture.bindings["administrator"]["uid"],
                "actualAuthenticatedRegisteredWorkspace": True, "sourceLocatorNotAuthorization": True,
                "legacyIdentityWithoutSourceStillUnavailable": True, "physicalPublisherDiffersFromManagementOwner": True,
                "managementOwnerDoesNotReadBodyOrCounts": True, "initialPages": [10, 1],
                "sameIdSamePublisherDifferentWorkspacesRetained": True, "fixedResolveAdoptRetrieve": True,
                "readWithoutUseCannotRetrieve": True, "pdpChangeInvalidatesCursorAndFiltersDeniedReference": True,
                "corruptSourceUnavailableNotPartialEmpty": True, "originalSourceFileIdsUidsAndBytesPreserved": True,
                "readerHasOneReferenceAndZeroCopiedPublicationBodies": True,
                "registryRemovalInvalidatesCursorAndFreshDirectoryFails": True, "paidCalls": 0}}))

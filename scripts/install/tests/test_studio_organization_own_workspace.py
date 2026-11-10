"""One actual account may use an explicitly located shared source from another registered workspace."""
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
class OwnWorkspaceTests(unittest.TestCase):
    def test_own_located_other_workspace_has_distinct_owner_current_pdp_and_reference_only_adoption(self):
        with Fixture(self) as fixture:
            binding = fixture.bindings["publisher"]
            profile = Path(binding["home"]) / ".config/kcoder"
            settings = profile / "settings.json"
            document = json.loads(settings.read_text())
            document["knowledge"] = {"enabled": True, "retrieval_enabled": True, "organization_enabled": False}
            settings.write_text(json.dumps(document))
            seed = fixture.seed("publisher")
            viewer = fixture.session("publisher")
            fixture.resource("publisher", viewer.owner, "knowledge", "current-target")
            workspace = Path(binding["home"]) / "owned-second-workspace"
            workspace.mkdir(mode=0o700); os.chown(workspace, binding["uid"], binding["gid"])
            source = account_workspace_session(fixture, "publisher", workspace)
            self.assertNotEqual(viewer.owner["workspaceId"], source.owner["workspaceId"])
            for key in ("accountId", "targetId", "organizationId"):
                self.assertEqual(viewer.owner[key], source.owner[key])
            fixture.resource("publisher", source.owner, "knowledge", "current-target")
            fixture.resource("publisher", source.owner, "knowledge-audience",
                json.dumps(["organization", fixture.organization], separators=(",", ":")))
            viewer.rpc("runtime.workspaces.open", {"workspacePath": str(workspace), "projectKey": "owned-second",
                "label": "Owned second workspace", "clientRequestId": str(uuid.uuid4())})
            identity = "own-other-workspace-shared"
            resource = {"id": resource_key("publication", source.owner, identity), "kind": "knowledge",
                "owner": fixture.identities["administrator"]["id"], "visibility": "organization",
                "grants": [{"subject": fixture.identities["publisher"]["id"], "actions": ["read", "use", "publish"]}]}
            def save(value):
                fixture.policy.administer(None, {"operation": "organization.resource",
                    "expectedRevision": fixture.policy._load()["revision"], "resource": value})
            save(resource)
            draft = {"publicationId": identity, "title": "Own explicit other-workspace source", "purpose": "Reference ownership",
                "reviewConclusion": None, "visibility": "organization", "audienceId": fixture.organization,
                "sources": [seed["source"]], "validFromMs": None, "validUntilMs": None, "unresolved": []}
            publication = source.call("publishKnowledge", {"draft": draft}, True, 0)
            self.assertEqual(publication["status"], "completed", publication)
            reference = {"owner": source.owner, "publicationId": identity, "version": 1}
            unlocated = viewer.call("resolvePublication", reference)
            self.assertNotEqual(unlocated["status"], "completed")
            resource["nativeKnowledgeSource"] = {"version": 1, "publisherPrincipalId": fixture.identities["publisher"]["id"],
                "publicationOwner": source.owner, "publicationId": identity}
            save(resource)
            private_id = "own-other-workspace-private"
            private_resource = copy.deepcopy(resource)
            private_resource["id"] = resource_key("publication", source.owner, private_id)
            private_resource["nativeKnowledgeSource"]["publicationId"] = private_id
            save(private_resource)
            private_draft = {**draft, "publicationId": private_id, "visibility": "personal", "audienceId": None}
            private = source.call("publishKnowledge", {"draft": private_draft}, True, 0)
            self.assertEqual(private["status"], "completed", private)
            private_reference = {"owner": source.owner, "publicationId": private_id, "version": 1}
            self.assertNotEqual(viewer.call("resolvePublication", private_reference)["status"], "completed")
            original_files = [path for path in profile.glob("integration-*/catalog-binding.json")
                if json.loads(path.read_text())["owner"] == source.owner]
            original_files += [path.with_name("catalog.sqlite") for path in original_files]
            before = {str(path): (path.stat().st_ino, path.stat().st_uid, hashlib.sha256(path.read_bytes()).hexdigest()) for path in original_files}
            resolved = viewer.call("resolvePublication", reference)
            self.assertEqual(resolved["status"], "completed", resolved)
            self.assertEqual(resolved["result"]["publication"]["owner"], source.owner)
            listed = viewer.call("listPublications", {"after": None})
            self.assertEqual(listed["status"], "completed", listed)
            self.assertEqual([(item["owner"], item["draft"]["publicationId"]) for item in listed["result"]["page"]["items"]], [(source.owner, identity)])
            adopted = viewer.call("adoptPublication", reference, True, 0)
            self.assertEqual(adopted["status"], "completed", adopted)
            current = adopted["result"]["adoption"]
            self.assertEqual(current["owner"], viewer.owner); self.assertEqual(current["publicationOwner"], source.owner)
            query = {**reference, "query": "reviewed", "limit": 3}
            retrieved = viewer.call("retrieveKnowledge", query)
            self.assertEqual(retrieved["status"], "completed", retrieved)
            self.assertIn("37 reviewed units", retrieved["result"]["retrieval"]["hits"][0]["excerpt"])
            disabled = viewer.call("setAdoptionEnabled", {"adoptionId": current["id"], "enabled": False}, True, 1)
            self.assertEqual(disabled["status"], "completed", disabled)
            self.assertNotEqual(viewer.call("retrieveKnowledge", query)["status"], "completed")
            self.assertEqual(viewer.call("setAdoptionEnabled", {"adoptionId": current["id"], "enabled": True}, True, 2)["status"], "completed")
            read_only = copy.deepcopy(resource); read_only["grants"][0]["actions"] = ["read", "publish"]
            save(read_only)
            self.assertEqual(viewer.call("resolvePublication", reference)["status"], "completed")
            self.assertNotEqual(viewer.call("retrieveKnowledge", query)["status"], "completed")
            save(resource)
            viewer.rpc("runtime.workspaces.delete", {"workspacePath": str(workspace)})
            self.assertNotEqual(viewer.call("resolvePublication", reference)["status"], "completed")
            self.assertNotEqual(viewer.call("retrieveKnowledge", query)["status"], "completed")
            self.assertEqual({str(path): (path.stat().st_ino, path.stat().st_uid, hashlib.sha256(path.read_bytes()).hexdigest()) for path in original_files}, before)
            storage = fixture.reader_storage("publisher", Path(fixture.bindings["reader"]["home"]) / ".config/kcoder/settings.json")
            self.assertEqual(storage["publicationRows"], 2); self.assertEqual(storage["adoptionRows"], 1)
            print(json.dumps({"ownWorkspaceEvidence": {"actualUid": binding["uid"], "sameActualAccountDifferentWorkspace": True,
                "explicitLocatedAndRegisteredSourceOnly": True, "fixedResolveListAdoptAndFts": True,
                "disabledUseRevocationAndRegistryRemovalDeny": True, "sourceFileIdsUidsAndBytesUnchanged": True,
                "privatePublicationCannotEnterSharedWorkspaceRoute": True,
                "twoOriginalSourceBodiesAndOneConsumerReference": True, "paidCalls": 0}}))

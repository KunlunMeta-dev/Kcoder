"""Ordinary Wiki readers retain original same-profile data ownership and current organization policy."""
import hashlib
import json
import os
from pathlib import Path
import unittest
import uuid

from organization_publication_fixture import Fixture
from studio_organization_publication_directory import native
from test_studio_organization_nondefault_workspace import account_workspace_session


def namespace_snapshot(profile):
    result = {}
    for root in profile.iterdir():
        if "integration-" not in root.name:
            continue
        for path in [root, *(root.rglob("*") if root.is_dir() else ())]:
            info = path.stat()
            result[str(path.relative_to(profile))] = (info.st_ino, info.st_uid,
                hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None)
    return result


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1"
    and os.environ.get("KCODER_ORGANIZATION_APP_SERVER") and os.environ.get("KCODER_ORGANIZATION_LEGACY_FIXTURE"),
    "Explicit actual owned UID and Native/seed binaries required")
class OriginalProfileWikiReadTests(unittest.TestCase):
    def test_normal_library_page_source_and_search_reads_preserve_old_principal_and_recheck_current_pdp(self):
        with Fixture(self) as fixture:
            binding = fixture.bindings["reader"]
            profile = Path(binding["home"]) / ".config/kcoder"
            settings = profile / "settings.json"
            document = json.loads(settings.read_text())
            document["knowledge"] = {"enabled": True, "retrieval_enabled": True, "organization_enabled": False}
            settings.write_text(json.dumps(document))
            seed = fixture.seed("reader", original_profile=True)
            workspace = Path(binding["home"]) / "workspace"
            session = account_workspace_session(fixture,"reader",workspace,initialize_capabilities={},read_scope=False)
            profile_id = "unix:%s:%s" % (profile.stat().st_dev,profile.stat().st_ino)
            workspace_id = "unix:%s:%s" % (workspace.stat().st_dev,workspace.stat().st_ino)
            owner = {"accountId":native("account-profile",profile_id),"targetId":native("native-target",profile_id),
                "workspaceId":native("native-workspace",profile_id+"\0"+workspace_id),"organizationId":fixture.organization}
            fixture.resource("administrator", owner, "knowledge", "current-target", readers=("reader",), actions=("read","write"))
            namespace_before = namespace_snapshot(profile)
            database = profile / "knowledge/state.sqlite"
            before = (database.stat().st_ino, database.stat().st_uid, hashlib.sha256(database.read_bytes()).hexdigest())
            library = seed["source"]["libraryId"]
            listed = session.rpc("knowledge/list", {"limit": 10})
            self.assertEqual([item["id"] for item in listed["items"]], [library])
            read = session.rpc("knowledge/read", {"libraryId": library})
            self.assertEqual(read["id"], library)
            pages = session.rpc("knowledge/page/list", {"libraryId": library, "limit": 10})
            self.assertEqual(pages["items"][0]["pageId"], seed["source"]["pageId"])
            fixed = session.rpc("knowledge/page/read", {"libraryId": library,
                "pageId": seed["source"]["pageId"], "revisionId": seed["source"]["pageRevision"]})
            self.assertEqual(hashlib.sha256(fixed["draft"]["markdown"].encode()).hexdigest(), seed["markdownSha256"])
            found = session.rpc("knowledge/search", {"libraryId": library, "query": "reviewed", "limit": 5})
            self.assertTrue(found["items"])
            sources = session.rpc("knowledge/source/list", {"libraryId": library, "limit": 10})
            self.assertEqual(len(sources["items"]), 1)
            citation = fixed["draft"]["citations"][0]
            chunks = session.rpc("knowledge/source/read", {"libraryId": library,"sourceId": citation["sourceId"],
                "revisionId": citation["revisionId"],"limit": 1})
            self.assertTrue(chunks["items"])
            resolved = session.rpc("knowledge/citation/resolve", {"libraryId": library,"sourceId": citation["sourceId"],
                "revisionId": citation["revisionId"],"chunkId": citation["chunkId"]})
            self.assertIn("chunk", resolved)
            history = session.rpc("knowledge/page/history", {"libraryId": library,"pageId": seed["source"]["pageId"],"limit": 10})
            self.assertTrue(history["items"])
            self.assertEqual(session.rpc("knowledge/job/list", {"libraryId": library,"limit": 10})["items"], [])
            self.assertEqual((database.stat().st_ino, database.stat().st_uid, hashlib.sha256(database.read_bytes()).hexdigest()), before)
            self.assertEqual(namespace_snapshot(profile), namespace_before)
            session.rpc("knowledge/configure", {"organizationEnabled": True})
            old_edit = session.rpc("knowledge/page/edit", {"libraryId": library,"pageId": seed["source"]["pageId"],
                "expectedRevision": seed["source"]["pageRevision"],"idempotencyKey": str(uuid.uuid4()),
                "title": "Must not rewrite original owner", "markdown": "Must not write old profile data."}, raw_response=True)
            self.assertIn("error", old_edit)
            self.assertIn("library not found", old_edit["error"]["message"])
            self.assertEqual(hashlib.sha256(database.read_bytes()).hexdigest(), before[2])
            created = session.rpc("knowledge/create", {"idempotencyKey": str(uuid.uuid4()),
                "name": "Current UUID-owned Wiki", "purpose": "Explicit ordinary writer"})
            session.rpc("knowledge/configure", {"organizationEnabled": False})
            self.assertNotEqual(created["id"], library)
            self.assertEqual(session.rpc("knowledge/read", {"libraryId": created["id"]})["id"], created["id"])
            first = session.rpc("knowledge/list", {"limit": 1})
            second = session.rpc("knowledge/list", {"limit": 1,"afterId": first["nextAfterId"]})
            self.assertEqual({first["items"][0]["id"],second["items"][0]["id"]}, {library,created["id"]})
            old_again = session.rpc("knowledge/page/read", {"libraryId": library,"pageId": seed["source"]["pageId"],
                "revisionId": seed["source"]["pageRevision"]})
            self.assertEqual(hashlib.sha256(old_again["draft"]["markdown"].encode()).hexdigest(),seed["markdownSha256"])
            after_explicit_write = hashlib.sha256(database.read_bytes()).hexdigest()
            fixture.resource("administrator", owner, "knowledge", "current-target")
            denied = session.rpc("knowledge/list", {"limit": 10}, raw_response=True)
            self.assertIn("error", denied)
            self.assertNotIn("result", denied)
            self.assertEqual((database.stat().st_ino, database.stat().st_uid), before[:2])
            self.assertEqual(hashlib.sha256(database.read_bytes()).hexdigest(), after_explicit_write)
            print(json.dumps({"ordinaryOriginalProfileWikiEvidence": {"actualUid": fixture.bindings["reader"]["uid"],
                "normalLibraryPageSourceAndSearch": True, "originalProfilePrincipalReadOnly": True,
                "currentOrganizationCallerAndPdpPreserved": True, "revocationHidesCountsAndBody": True,
                "noIntegrationOptInForWikiReads": True,
                "ordinaryReadsPreserveEstablishedNativeIdentityNamespaces": True,
                "explicitWriterCurrentUuidOnlyAndOriginalLibraryUnchanged": True,
                "nativeRawIdPaginationMergesBothOwnedDataScopes": True,
                "originalSourceChunksCitationHistoryAndJobMetadata": True,
                "originalDatabaseFileIdUidAndShaPreserved": True, "paidCalls": 0}}))

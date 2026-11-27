"""Fixed shared references use the publisher's actual registered Native workspace."""
import hashlib
import json
import os
from pathlib import Path
import unittest
import uuid

from organization_publication_fixture import Fixture, Session
from studio_account_deploy import prepare


def account_workspace_session(fixture, name, workspace, initialize_capabilities=None, read_scope=True):
    """Reuse the original Session owner with the actual authenticated entry protocol."""
    entry = fixture.installed / "entry/bin/studio-account-entry.py"
    if not entry.exists():
        prepare(entry.parents[1], Path(__file__).resolve().parents[1])
    input_read, input_write = os.pipe()
    output_read, output_write = os.pipe()
    error = fixture.root / ("workspace-account-" + uuid.uuid4().hex + ".log")
    error_fd = os.open(error, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    child = os.fork()
    if child == 0:
        os.close(input_write); os.close(output_read)
        os.dup2(input_read, 0); os.dup2(output_write, 1); os.dup2(error_fd, 2)
        os.execve("/usr/bin/python3", ["/usr/bin/python3", "-I", str(entry),
            "--state-directory", str(fixture.accounts.root), "--homes-directory", str(fixture.root / "homes"),
            "--runtime", fixture.programs[0]], {"PATH": "/usr/bin:/bin", "SSH_ORIGINAL_COMMAND": "kcoder-account"})
    os.close(input_read); os.close(output_write); os.close(error_fd)
    session = Session(fixture.case, input_write, output_read, child, error)
    fixture.resources.callback(session.stop)
    os.write(input_write, (json.dumps({"protocol": "kcoder-account-v1", "username": name,
        "password": "synthetic-" + name + "-password", "workspace": str(workspace)}) + "\n").encode())
    session.rpc("initialize", {"protocolVersion": "2026-07-27", "clientInfo": {"name": "owned-nondefault-workspace", "version": "1"},
        "capabilities": {"experimental": ({"integrationScopeV1": True, "knowledgePublicationsV1": True}
            if initialize_capabilities is None else initialize_capabilities)}})
    auth = next(message for message in session.messages if message.get("authenticated"))
    fixture.case.assertEqual(auth["uid"], fixture.bindings[name]["uid"])
    status = Path("/proc") / str(auth["runtimePid"]) / "status"
    fixture.case.assertIn("Uid:\t" + str(auth["uid"]) + "\t" + str(auth["uid"]), status.read_text())
    fixture.case.assertIn("NoNewPrivs:\t1", status.read_text())
    if read_scope:
        session.scope = session.rpc("integrations/scope/read", {})
        session.owner = {key: session.scope.get(key) for key in ("accountId", "targetId", "workspaceId", "organizationId")}
    return session


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1"
    and os.environ.get("KCODER_ORGANIZATION_APP_SERVER") and os.environ.get("KCODER_ORGANIZATION_LEGACY_FIXTURE"),
    "Explicit owned actual UID and Native/seed binaries required")
class NondefaultWorkspaceTests(unittest.TestCase):
    def test_fixed_shared_reference_follows_original_native_registration_and_rechecks_current_membership(self):
        with Fixture(self) as fixture:
            default, reader = fixture.session("publisher"), fixture.session("reader")
            for name, session in (("publisher", default), ("reader", reader)):
                fixture.resource(name, session.owner, "knowledge", "current-target")
            binding = fixture.bindings["publisher"]
            workspace = Path(binding["home"]) / "owned-extra-workspace"
            workspace.mkdir(mode=0o700); os.chown(workspace, binding["uid"], binding["gid"])
            alternate = account_workspace_session(fixture, "publisher", workspace)
            self.assertNotEqual(alternate.owner["workspaceId"], default.owner["workspaceId"])
            for key in ("accountId", "targetId", "organizationId"):
                self.assertEqual(alternate.owner[key], default.owner[key])
            fixture.resource("publisher", alternate.owner, "knowledge", "current-target")
            seed = fixture.seed("publisher")
            identity = "owned-nondefault-publication"
            fixture.resource("publisher", alternate.owner, "publication", identity, readers=("reader",))
            fixture.resource("publisher", alternate.owner, "knowledge-audience",
                json.dumps(["organization", fixture.organization], separators=(",", ":")))
            draft = {"publicationId": identity, "title": "Original nondefault workspace publication", "purpose": "Exact original workspace source",
                "reviewConclusion": None, "visibility": "organization", "audienceId": fixture.organization,
                "sources": [seed["source"]], "validFromMs": None, "validUntilMs": None, "unresolved": []}
            published = alternate.call("publishKnowledge", {"draft": draft}, True, 0)
            self.assertEqual(published["status"], "completed", published)
            reference = {"owner": alternate.owner, "publicationId": identity, "version": 1}
            unavailable = reader.call("resolvePublication", reference)
            self.assertNotEqual(unavailable["status"], "completed")
            self.assertIsNone(unavailable.get("result"))
            opened = default.rpc("runtime.workspaces.open", {"workspacePath": str(workspace),
                "label": "Owned original workspace", "projectKey": "owned-extra-workspace", "preserveExisting": True,
                "clientRequestId": str(uuid.uuid4())})
            self.assertTrue(opened["accepted"])
            self.assertEqual(opened["workspacePath"], str(workspace))
            profile = Path(binding["home"]) / ".config/kcoder"
            registry = next(profile.glob("projects/*/client-workspaces.json"))
            registry_bytes = registry.read_bytes()
            namespace = next(directory for directory in profile.iterdir() if directory.is_dir()
                and (directory / "catalog-binding.json").exists()
                and json.loads((directory / "catalog-binding.json").read_text())["owner"] == alternate.owner)
            source_before = {name: (path.stat().st_ino, path.stat().st_uid, hashlib.sha256(path.read_bytes()).hexdigest())
                for name in ("catalog-binding.json", "catalog.sqlite") for path in (namespace / name,)}
            resolved = reader.call("resolvePublication", reference)
            self.assertEqual(resolved["status"], "completed", resolved)
            self.assertEqual(resolved["result"]["publication"]["owner"], alternate.owner)
            self.assertEqual(hashlib.sha256(resolved["result"]["publication"]["pages"][0]["markdown"].encode()).hexdigest(), seed["markdownSha256"])
            adopted = reader.call("adoptPublication", reference, True, 0)
            self.assertEqual(adopted["status"], "completed", adopted)
            query = {**reference, "query": "reviewed", "limit": 3}
            self.assertEqual(reader.call("retrieveKnowledge", query)["status"], "completed")
            self.assertEqual(registry.read_bytes(), registry_bytes)
            alternate.stop()
            moved = workspace.with_name("owned-held-original-workspace")
            workspace.rename(moved); workspace.mkdir(mode=0o700)
            os.chown(workspace, binding["uid"], binding["gid"])
            try:
                replaced = reader.call("resolvePublication", reference)
                self.assertNotEqual(replaced["status"], "completed"); self.assertIsNone(replaced.get("result"))
            finally:
                workspace.rmdir(); moved.rename(workspace)
            self.assertEqual(reader.call("resolvePublication", reference)["status"], "completed")
            registry.write_bytes(b'{}')
            try:
                malformed = reader.call("resolvePublication", reference)
                self.assertNotEqual(malformed["status"], "completed"); self.assertIsNone(malformed.get("result"))
                self.assertEqual(registry.read_bytes(), b'{}')
            finally:
                registry.write_bytes(registry_bytes)
            self.assertEqual(reader.call("resolvePublication", reference)["status"], "completed")
            removed = default.rpc("runtime.workspaces.delete", {"workspacePath": str(workspace)})
            self.assertTrue(removed["deleted"])
            denied = reader.call("resolvePublication", reference)
            self.assertNotEqual(denied["status"], "completed"); self.assertIsNone(denied.get("result"))
            self.assertNotEqual(reader.call("retrieveKnowledge", query)["status"], "completed")
            self.assertEqual({name: (path.stat().st_ino, path.stat().st_uid, hashlib.sha256(path.read_bytes()).hexdigest())
                for name in ("catalog-binding.json", "catalog.sqlite") for path in (namespace / name,)}, source_before)
            print(json.dumps({"nondefaultWorkspaceEvidence": {"publisherUid": binding["uid"],
                "readerUid": fixture.bindings["reader"]["uid"], "actualAuthenticatedWorkspace": True,
                "unregisteredDenied": True, "exactOriginalOwnerAndRevision": True,
                "nativeRegistrationControlsFixedReadAndRetrieval": True, "membershipRemovalRechecked": True,
                "workspaceReplacementAndMalformedRegistryDenied": True,
                "originalNamespaceBindingDatabaseOwnerAndBytesPreserved": True,
                "paidCalls": 0}}))

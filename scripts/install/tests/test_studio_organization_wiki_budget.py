"""Root ticket routing contracts; synthetic credentials are not an OS proof."""
import os
from pathlib import Path
import socket
import struct
import tempfile
import types
import unittest
from unittest.mock import patch

from studio_account_files import AccountError
import studio_organization_wiki as wiki
from studio_organization_wiki_budget import workspace_for_budget
from test_studio_organization_wiki_tickets import Policy, Workspace


@unittest.skipUnless(os.geteuid() == 0, "Root-private ticket protocol fixture")
class WikiBudgetRouting(unittest.TestCase):
    def test_budget_uses_original_claim_workspace_and_never_channel_default(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(wiki, "WorkspaceBudgetBinding", Workspace):
            channel = types.SimpleNamespace(store=types.SimpleNamespace(root=Path(directory)),
                identity={"id": "member-1", "revision": 2},
                snapshot={"workerUid": 1001, "workerGid": 1001, "organizationId": "org-1"},
                runtime_pid=321, purpose="interactive", workspace_resource=Workspace(), worker_binding={}, policy=Policy())
            scope = {"accountId": wiki.native_id("account-profile", "unix:11:22"),
                "targetId": wiki.native_id("native-target", "unix:11:22"),
                "workspaceId": channel.workspace_resource.resource_id, "organizationId": "org-1",
                "identityGeneration": "generation-1", "targetRevision": "revision-1"}
            job = {"libraryId": "library-1", "jobId": "job-1", "sourceId": "source-1",
                "sourceRevision": "revision-1", "recipeKey": "wiki-v4:recipe"}
            credentials = [(socket.SOL_SOCKET, socket.SCM_CREDENTIALS, struct.pack("3i", 321, 1001, 1001))]
            wiki.dispatch(channel, {"operation": "wiki.job.bind", "scope": scope, "job": job}, credentials)
            channel.purpose = "wiki_worker"
            claim = {"operation": "wiki.job.open", "job": job, "claimFingerprint": "a" * 64}
            wiki.dispatch(channel, claim, credentials)
            channel.workspace_resource = object()
            request = {"operation": "budget.request", "rootOperationId": "org-wiki-" + "a" * 64,
                "action": {"kind": "reserve", "task": {"rootOperationId": "org-wiki-" + "a" * 64,
                    "rootTask": {"kind": "task", "id": "job-1", "revision": None}}}}
            original = workspace_for_budget(channel, request, credentials)
            self.assertEqual(original.resource_id, scope["workspaceId"])
            self.assertEqual(original.paths[1], Path("/fixed-workspace"))
            original.close()
            with self.assertRaises(AccountError):
                workspace_for_budget(channel, {**request, "action": {"kind": "reserve", "task": {
                    **request["action"]["task"], "rootTask": {"kind": "task", "id": "another-job", "revision": None}}}}, credentials)
            with self.assertRaises(AccountError):
                workspace_for_budget(channel, request, [(socket.SOL_SOCKET, socket.SCM_CREDENTIALS, struct.pack("3i", 322, 1001, 1001))])
            with self.assertRaises(AccountError):
                workspace_for_budget(channel, {**request, "rootOperationId": "org-wiki-" + "c" * 64}, credentials)
            channel.policy.allowed = False
            for kind in ("reserve", "dispatch", "check"):
                with self.assertRaises(AccountError):
                    workspace_for_budget(channel, {**request, "action": {**request["action"], "kind": kind}}, credentials)
            for kind in ("observe", "read", "calls_closed"):
                workspace_for_budget(channel, {**request, "action": {"kind": kind}}, credentials).close()
            channel.policy.allowed = True
            wiki.dispatch(channel, {**claim, "claimFingerprint": "b" * 64}, credentials)
            with self.assertRaises(AccountError):
                workspace_for_budget(channel, request, credentials)
            workspace_for_budget(channel, {**request, "action": {"kind": "observe"}}, credentials).close()

    def test_missing_ticket_read_does_not_create_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            channel = types.SimpleNamespace(store=types.SimpleNamespace(root=Path(directory)),
                identity={"id": "member-1", "revision": 2}, snapshot={"workerUid": 1001, "workerGid": 1001},
                runtime_pid=321, purpose="wiki_worker")
            credentials = [(socket.SOL_SOCKET, socket.SCM_CREDENTIALS, struct.pack("3i", 321, 1001, 1001))]
            with self.assertRaises(AccountError):
                workspace_for_budget(channel, {"operation": "budget.request", "rootOperationId": "org-wiki-" + "a" * 64,
                    "action": {"kind": "read"}}, credentials)
            self.assertFalse((Path(directory) / "organization-wiki-jobs").exists())


if __name__ == "__main__":
    unittest.main()

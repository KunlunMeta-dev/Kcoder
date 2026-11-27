"""Ticket protocol tests only; fake peer data below is not an OS UID proof."""
import json
from pathlib import Path
import os
import socket
import struct
import tempfile
import types
import unittest
from unittest.mock import patch

from studio_account_files import AccountError,write_private_json
import studio_organization_wiki as wiki


class Workspace:
    def __init__(self,*_):
        self.identities=[(11,22),(11,33)]
        self.resource_id=wiki.native_id("native-workspace","unix:11:22\0unix:11:33")
        self.paths=[Path("/fixed-profile"),Path("/fixed-workspace")]
    def verify(self,_):return self.resource_id
    def close(self):pass


class Policy:
    def __init__(self):self.allowed=True
    def inspect_session(self,_):return {}
    def evaluate(self,*_):return {"allowed":self.allowed}


@unittest.skipUnless(os.geteuid()==0,"Root-private ticket protocol fixture")
class WikiTickets(unittest.TestCase):
    def test_original_enqueue_is_immutable_and_revoked_work_cannot_reuse_retained_observation_as_permission(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(wiki,"WorkspaceBudgetBinding",Workspace):
            channel=types.SimpleNamespace(store=types.SimpleNamespace(root=Path(directory)),
                identity={"id":"member-1","revision":2},snapshot={"workerUid":1001,"workerGid":1001,"organizationId":"org-1"},
                runtime_pid=321,purpose="interactive",workspace_resource=Workspace(),worker_binding={},
                policy=Policy())
            scope={"accountId":wiki.native_id("account-profile","unix:11:22"),
                "targetId":wiki.native_id("native-target","unix:11:22"),
                "workspaceId":channel.workspace_resource.resource_id,"organizationId":"org-1",
                "identityGeneration":"generation-1","targetRevision":"revision-1"}
            job={"libraryId":"library-1","jobId":"job-1","sourceId":"source-1","sourceRevision":"revision-1","recipeKey":"wiki-v4:recipe"}
            credentials=[(socket.SOL_SOCKET,socket.SCM_CREDENTIALS,struct.pack("3i",321,1001,1001))]
            bind={"operation":"wiki.job.bind","scope":scope,"job":job}
            first=wiki.dispatch(channel,bind,credentials)
            self.assertEqual(wiki.dispatch(channel,bind,credentials),first)
            wrong=[(socket.SOL_SOCKET,socket.SCM_CREDENTIALS,struct.pack("3i",322,1001,1001))]
            with self.assertRaises(AccountError):wiki.dispatch(channel,bind,wrong)
            channel.purpose="wiki_worker"
            with self.assertRaises(AccountError):wiki.dispatch(channel,bind,credentials)
            claim={"operation":"wiki.job.open","job":job,"claimFingerprint":"a"*64}
            opened=wiki.dispatch(channel,claim,credentials)
            self.assertEqual(opened["receiptId"],first["receiptId"])
            channel.policy.allowed=False
            with self.assertRaises(AccountError):wiki.dispatch(channel,{**claim,"operation":"wiki.job.current"},credentials)
            observed=wiki.dispatch(channel,{**claim,"operation":"wiki.job.observe"},credentials)
            self.assertEqual(observed["receiptId"],first["receiptId"])
            with self.assertRaises(AccountError):wiki.dispatch(channel,{**claim,"claimFingerprint":"b"*64,"operation":"wiki.job.observe"},credentials)
            stored=wiki.load(channel,job["jobId"])
            stored["workspacePath"]="/another-workspace"
            write_private_json(wiki.path_for(channel,job["jobId"]),stored)
            with self.assertRaises(AccountError):wiki.load(channel,job["jobId"])


if __name__=="__main__":unittest.main()

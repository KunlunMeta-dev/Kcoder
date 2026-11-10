"""Real Native Wiki tool dispatch keeps current organization PDP and old data ownership."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import threading
import time
import unittest

from organization_publication_fixture import Fixture, resource_key
from studio_organization_budget import initialize
from studio_organization_channel import OrganizationChannel
from studio_organization_execution import model_resource_id
from studio_organization_workspace import WorkspaceBudgetBinding


def tool_result(body, identity):
    for message in reversed(body.get("messages", [])):
        if message.get("role") == "tool" and message.get("tool_call_id") == identity:
            content = message["content"]
            if not isinstance(content, str):
                return content
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                return {"text": content}
    return None


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1"
    and os.environ.get("KCODER_ORGANIZATION_APP_SERVER") and os.environ.get("KCODER_ORGANIZATION_LEGACY_FIXTURE"),
    "Explicit owned actual UID and Native/seed binaries required")
class OrganizationWikiToolTests(unittest.TestCase):
    def test_current_uuid_wiki_tool_reads_require_current_pdp(self):
        self.run_actual(False)

    def test_old_profile_wiki_tool_reads_require_current_pdp_without_migrating_owner(self):
        self.run_actual(True)

    def test_organization_review_reader_requires_pdp_with_retrieval_disabled(self):
        self.run_actual(False, tool_name="WikiManage", action_name="read_page", organization=True)

    def test_original_profile_organization_review_reader_keeps_original_data_owner(self):
        self.run_actual(True, tool_name="WikiManage", action_name="read_page", organization=True)

    def test_current_uuid_wiki_manage_write_requires_separate_current_write_grant(self):
        self.run_actual(False, tool_name="WikiManage", action_name="rename", organization=True, mutation=True)

    def test_legacy_library_stays_read_only_while_authorized_create_uses_current_uuid(self):
        self.run_actual(True, tool_name="WikiManage", action_name="rename", organization=True, mutation=True)

    def test_write_after_allow_revocation_reports_reconciliation_and_preserves_actual_revision(self):
        self.run_actual(False, tool_name="WikiManage", action_name="rename", organization=True, mutation=True, reconcile=True)

    def test_write_only_does_not_read_existing_library_metadata(self):
        self.run_actual(False, tool_name="WikiManage", action_name="rename", organization=True, mutation=True, write_only=True)

    def test_wiki_manage_job_metadata_requires_current_read_even_when_empty(self):
        self.run_actual(False, tool_name="WikiManage", action_name="jobs", organization=True, metadata=True)

    def test_paused_owned_job_metadata_preserves_original_record_and_current_read(self):
        self.run_actual(False, tool_name="WikiManage", action_name="jobs", organization=True, metadata=True, with_job=True)

    def run_actual(self, original_profile, tool_name="Wiki", action_name="read", organization=False, mutation=False, metadata=False, with_job=False, reconcile=False, write_only=False):
        requests, results, protocol_errors = [], [], []
        selected = {}
        call_ids = {}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                size = int(self.headers["Content-Length"])
                if size > 512 * 1024:
                    raise AssertionError("Owned Wiki tool request too large")
                body = json.loads(self.rfile.read(size)); requests.append(body)
                try:
                    if len(requests) > 9:
                        raise AssertionError("Owned Wiki Provider request ceiling exceeded")
                    value = tool_result(body, call_ids["read"])
                    if value is not None:
                        results.append(value)
                        delta, finish = {"content": "OWNED_WIKI_TOOL_TERMINAL"}, "stop"
                    elif tool_result(body, call_ids["discover"]) is not None:
                        receipt = tool_result(body, call_ids["discover"])
                        fenced = re.search(r"```json\s*([\s\S]*?)```", receipt.get("text", ""))
                        if not fenced or not any(item.get("name") == tool_name for item in json.loads(fenced.group(1))["tools"]):
                            raise AssertionError("Actual Wiki discovery metadata missing: " + json.dumps(receipt, ensure_ascii=False)[:4000])
                        arguments = {"tool_name": tool_name, "arguments": {"action": action_name, **selected}}
                        delta = {"tool_calls": [{"index": 0, "id": call_ids["read"], "type": "function",
                            "function": {"name": "tool_execute", "arguments": json.dumps(arguments)}}]}
                        finish = "tool_calls"
                    else:
                        attached = {item.get("function", {}).get("name") for item in body.get("tools", [])}
                        if tool_name in attached:
                            name, identity, arguments = tool_name, call_ids["read"], {"action": action_name, **selected}
                        elif "tool_search" in attached:
                            name, identity, arguments = "tool_search", call_ids["discover"], {"query": tool_name, "limit": 1}
                        else:
                            raise AssertionError("Actual Provider has no Wiki or discovery definition: " + repr(sorted(attached)))
                        delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": identity, "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)}}]}
                        finish = "tool_calls"
                except Exception as error:
                    protocol_errors.append(type(error).__name__ + ": " + str(error))
                    delta, finish = {"content": "OWNED_WIKI_PROTOCOL_FAILURE"}, "stop"
                events = [{"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                    {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                     "usage": {"prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10}}]
                wire = ("".join("data: " + json.dumps(event) + "\n\n" for event in events) + "data: [DONE]\n\n").encode()
                self.send_response(200); self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(wire))); self.end_headers(); self.wfile.write(wire)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        started = False
        try:
            with Fixture(self) as fixture:
                binding = fixture.bindings["reader"]
                member = fixture.identities["reader"]
                profile = Path(binding["home"]) / ".config/kcoder"
                origin = "http://127.0.0.1:" + str(server.server_port)
                settings = {"active_provider": "fixture", "model": "owned-wiki-model", "max_tokens": 512, "max_retries": 0,
                    "providers": {"fixture": {"api_format": "openai_chat_completions", "authentication": {"mode": "none"},
                        "endpoint": origin + "/v1", "default_model": "owned-wiki-model", "context_window_tokens": 128000,
                        "max_output_tokens": 512, "output_headroom_tokens": 512, "discover_models": False, "no_proxy": True}},
                    "knowledge": {"enabled": True, "retrieval_enabled": not organization, "organization_enabled": organization},
                    "memory": {"observer_mode": "disabled", "structured_enabled": False, "legacy_prompt_enabled": False},
                    "session_memory": {"enabled": False}}
                (profile / "settings.json").write_text(json.dumps(settings))
                source = fixture.seed("reader", original_profile=original_profile, with_job=with_job)
                selected.update({"library": source["source"]["libraryId"], "page": source["source"]["pageId"],
                                 "revision": source["source"]["pageRevision"]})
                revoke_marker = fixture.root / "owned-write-revocation"

                def channel_factory(accounts, identity, runtime, actual_binding):
                    workspace = WorkspaceBudgetBinding(actual_binding, identity, Path(actual_binding["home"]) / "workspace")
                    channel = OrganizationChannel(accounts, identity, runtime=runtime, workspace_resource=workspace)
                    if reconcile:
                        original_evaluate = channel.policy.evaluate

                        def evaluate_then_revoke(actor, action, resource_id, request_id, restrictions=None):
                            result = original_evaluate(actor, action, resource_id, request_id, restrictions)
                            committed = False
                            if action == "write" and result["allowed"] and revoke_marker.exists():
                                import sqlite3
                                with sqlite3.connect((profile / "knowledge/state.sqlite").as_uri() + "?mode=ro", uri=True) as database:
                                    rows = database.execute("SELECT name, metadata_revision FROM libraries WHERE id = ?", (source["source"]["libraryId"],)).fetchall()
                                committed = any(name == "Only explicitly authorized Wiki name" and revision > 1 for name, revision in rows)
                            if committed:
                                self.assertEqual(revoke_marker.read_text(), resource_id)
                                revoke_marker.unlink()
                                policy = channel.policy._load()
                                resource = policy["resources"][resource_id]
                                for grant in resource["grants"]:
                                    if grant["subject"] == identity["id"]:
                                        grant["actions"] = [item for item in grant["actions"] if item != "write"]
                                channel.policy.administer(None, {"operation": "organization.resource",
                                    "expectedRevision": policy["revision"], "resource": resource})
                                result = original_evaluate(actor, action, resource_id, request_id, restrictions)
                            return result

                        channel.policy.evaluate = evaluate_then_revoke
                    return channel

                session = fixture.session("reader", channel_factory=channel_factory)
                workspace, revision = session.scope["workspaceId"], session.scope["targetRevision"]
                model = model_resource_id("fixture", "owned-wiki-model", origin, revision)
                for identity, kind in ((workspace, "workspace"), (model, "model")):
                    fixture.policy.administer(None, {"operation": "organization.resource", "expectedRevision": fixture.policy._load()["revision"],
                        "resource": {"id": identity, "kind": kind, "owner": member["id"], "visibility": "private", "grants": []}})
                start = int(time.time() // 3600) * 3_600_000
                execution = {"version": 1, "modelRules": [{"id": "owned-wiki-route", "members": [member["id"]],
                    "workspaceResourceIds": [workspace], "provider": "fixture", "model": "owned-wiki-model", "endpointOrigin": origin,
                    "configurationRevision": revision, "enabled": True}], "budgetPolicies": [{"id": "original-org-wiki-cap",
                    "scope": {"kind": "organization", "id": fixture.organization},
                    "window": {"id": "owned-hour", "startsAtMs": start, "endsAtMs": start + 3_600_000},
                    "limits": {"tokens": 100000, "modelCalls": 9, "concurrentTasks": 1}, "currency": None}]}
                fixture.policy.administer(None, {"operation": "organization.executionPolicy", "expectedRevision": fixture.policy._load()["revision"],
                    "executionPolicy": execution})
                initialize(fixture.accounts, fixture.programs[0])
                worker.start(); started = True
                database = profile / "knowledge/state.sqlite"
                import hashlib
                sources = [database, *(path for path in (profile / "knowledge/state.objects").rglob("*") if path.is_file())]
                snapshot = lambda: {str(path): (path.stat().st_ino, path.stat().st_uid, hashlib.sha256(path.read_bytes()).hexdigest())
                                   for path in sources}
                before = snapshot()
                library_id = source["source"]["libraryId"]
                if metadata:
                    selected.clear()
                    selected.update({"library": library_id})
                if mutation:
                    fixture.resource("administrator", session.owner, "knowledge", "current-target", readers=("reader",), actions=("read",))
                    library_before = session.rpc("knowledge/read", {"libraryId": library_id})
                    selected.clear()
                    selected.update({"library": library_id, "expected_revision": library_before["revision"],
                                     "name": "Only explicitly authorized Wiki name"})
                    if write_only:
                        fixture.resource("administrator", session.owner, "knowledge", "current-target", readers=("reader",), actions=("write",))
                thread = session.rpc("thread/start", {})["thread"]["id"]
                approvals = set()

                def turn():
                    previous = len(results)
                    call_ids.update({"read": "owned-wiki-read-" + str(previous),
                                     "discover": "owned-wiki-discover-" + str(previous)})
                    reply = session.rpc("turn/start", {"threadId": thread,
                        "input": [{"type": "text", "text": ("Perform the explicitly requested " + action_name + " of the exact owned Wiki library through WikiManage. Do not use files or another tool."
                            if mutation else "List only the exact owned Wiki library's organization jobs through WikiManage. Do not modify jobs or files."
                            if metadata else "Perform explicit Wiki organization review. Read only the exact owned page through WikiManage; do not edit it."
                            if organization else "Read only the exact owned Wiki page through Wiki. Do not use Shell, files or another tool.")}]})

                    def terminal_or_approve(item):
                        params = item.get("params", {})
                        if params.get("threadId") != thread or params.get("turnId") != reply["turn"]["id"]:
                            return False
                        if item.get("method") == "approval/request" and item["id"] not in approvals:
                            self.assertEqual(params["action"], {"type": "tool", "name": tool_name,
                                "input": {"action": action_name, **selected}})
                            approvals.add(item["id"])
                            os.write(session.input_fd, (json.dumps({"jsonrpc": "2.0", "id": item["id"],
                                "result": {"decision": "accept"}}) + "\n").encode())
                        return item.get("method") == "turn/completed"

                    try:
                        terminal = session.wait(terminal_or_approve)
                    except AssertionError:
                        diagnostic = [{"method": item.get("method"), "id": item.get("id"),
                            "params": json.dumps(item.get("params", {}), ensure_ascii=False)[:600]}
                            for item in session.messages[-12:]]
                        self.fail("Owned Wiki turn did not terminate: " + json.dumps(diagnostic, ensure_ascii=False))
                    self.assertEqual(terminal["params"]["turn"]["status"], "completed", terminal)
                    self.assertEqual(protocol_errors, [])
                    self.assertEqual(len(results), previous + 1)
                    return json.dumps(results[-1], ensure_ascii=False)

                denied = turn()
                self.assertRegex(denied, r"DENIED|denied|unavailable|UNAVAILABLE")
                self.assertEqual(snapshot(), before)
                if mutation:
                    if not write_only:
                        self.assertEqual(session.rpc("knowledge/read", {"libraryId": library_id}), library_before)
                elif not metadata:
                    self.assertNotIn("37 reviewed units", denied, "A model route/budget grant must not grant Wiki body read")
                fixture.resource("administrator", session.owner, "knowledge", "current-target", readers=("reader",),
                    actions=("read", "write") if mutation else ("read",))
                if reconcile:
                    marker = os.open(revoke_marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                    os.write(marker, resource_key("knowledge", session.owner, "current-target").encode()); os.close(marker)
                allowed = turn()
                if mutation:
                    if original_profile:
                        self.assertIn("knowledge library not found", allowed)
                        self.assertEqual(snapshot(), before)
                        self.assertEqual(session.rpc("knowledge/read", {"libraryId": library_id}), library_before)
                        action_name = "create"
                        selected.clear()
                        selected.update({"request_key": "explicit-current-uuid-create", "name": "Explicit current UUID library"})
                        fixture.resource("administrator", session.owner, "knowledge", "current-target", readers=("reader",), actions=("write",))
                        created = turn()
                        created = json.loads(created)
                        self.assertEqual(created["name"], selected["name"])
                        self.assertEqual(created["status"], "created_or_existing")
                        self.assertNotIn("archived", created)
                        self.assertNotIn("revision", created)
                        self.assertNotEqual(created["id"], library_id)
                        fixture.resource("administrator", session.owner, "knowledge", "current-target", readers=("reader",), actions=("read", "write"))
                        self.assertEqual(session.rpc("knowledge/read", {"libraryId": library_id}), library_before)
                        library_id = created["id"]
                        library_after = session.rpc("knowledge/read", {"libraryId": library_id})
                        self.assertEqual(library_after["name"], created["name"])
                        action_name = "rename"
                    else:
                        library_after = session.rpc("knowledge/read", {"libraryId": library_id})
                        self.assertEqual(library_after["name"], selected["name"])
                        self.assertEqual(library_after["revision"], library_before["revision"] + 1)
                        if reconcile:
                            self.assertIn("WIKI_WRITE_RESULT_NEEDS_RECONCILIATION", allowed)
                            self.assertFalse(revoke_marker.exists())
                        else:
                            self.assertEqual(json.loads(allowed), library_after)
                    after_allowed = snapshot()
                    self.assertEqual(after_allowed[str(database)][:2], before[str(database)][:2])
                    self.assertNotEqual(after_allowed[str(database)][2], before[str(database)][2])
                    selected.clear()
                    selected.update({"library": library_id, "expected_revision": library_after["revision"], "name": "Revoked write must never commit"})
                elif metadata:
                    jobs = json.loads(allowed)["jobs"]
                    if with_job:
                        self.assertEqual(len(jobs), 1)
                        self.assertEqual(jobs[0]["id"], source["job"]["id"])
                        self.assertEqual(jobs[0]["status"], "paused")
                    else:
                        self.assertEqual(jobs, [])
                    self.assertIsNone(json.loads(allowed)["next_cursor"])
                else:
                    self.assertIn("37 reviewed units", allowed, allowed)
                    self.assertEqual(hashlib.sha256(json.loads(allowed)["text"].encode()).hexdigest(), source["markdownSha256"])
                fixture.resource("administrator", session.owner, "knowledge", "current-target",
                    readers=("reader",) if mutation else (), actions=("read",))
                revoked = turn()
                self.assertRegex(revoked, r"DENIED|denied|unavailable|UNAVAILABLE")
                if mutation:
                    self.assertEqual(snapshot(), after_allowed)
                    self.assertEqual(session.rpc("knowledge/read", {"libraryId": library_id}), library_after)
                    self.assertEqual({key: value for key, value in after_allowed.items() if key != str(database)},
                                     {key: value for key, value in before.items() if key != str(database)})
                else:
                    self.assertNotIn("37 reviewed units", revoked)
                    self.assertEqual(snapshot(), before)
                ledger = json.loads((fixture.accounts.root / "organization-budget/ledger.json").read_text())
                calls = [row["receipt"] for row in ledger["reservations"].values() if row["receipt"]["unit"] == "model_call"]
                self.assertEqual(len(calls), len(requests))
                self.assertTrue(all(receipt["executionConfirmedTerminal"] for receipt in calls))
                self.assertTrue(all(receipt["charged"]["tokens"] == 10 for receipt in calls))
                slots = [row["receipt"] for row in ledger["reservations"].values() if row["receipt"]["unit"] == "task_slot"]
                self.assertEqual(len(slots), 4 if mutation and original_profile else 3)
                self.assertTrue(all(receipt["executionConfirmedTerminal"] for receipt in slots))
                print(json.dumps({"organizationWikiToolEvidence": {"actualUid": binding["uid"], "originalProfileData": original_profile,
                    "tool": tool_name, "explicitOrganizationReviewWithRetrievalDisabled": organization,
                    "explicitCurrentUuidWriteControl": mutation,
                    "jobMetadataReadControl": metadata,
                    "realPausedJobRecordNoActiveWorker": with_job,
                    "actualTurnStartAndOriginalWikiDispatch": True, "noRequiredGrantAndSameSessionRevocationDenied": True,
                    "normalAskOnlyExactOwnedWikiApproval": True,
                    "explicitCurrentPdpRequiredActionAllowed": True,
                    "fullOriginalPageShaVerified": not mutation and not metadata,
                    "authorizedCurrentUuidMutationVerifiedByRpcAndRevision": mutation,
                    "legacyWriteRefusedAndOnlyCurrentUuidCreated": mutation and original_profile,
                    "currentUuidCreateWithWriteOnlyReceipt": mutation and original_profile,
                    "postAllowRevocationReconcilesActualCommittedRevision": reconcile,
                    "writeOnlyDoesNotReadExistingMetadata": write_only,
                    "originalDatabaseInodeUidPreserved": True,
                    "databaseBytesUnchangedExceptAuthorizedMutation": True,
                    "originalObjectsInodeUidShaPreserved": True,
                    "originalModelBudgetReceiptsSettled": True, "providerCalls": len(requests), "paidCalls": 0}}))
        finally:
            if started:
                server.shutdown()
            server.server_close()
            if started:
                worker.join(timeout=3)
                self.assertFalse(worker.is_alive())


if __name__ == "__main__":
    unittest.main()

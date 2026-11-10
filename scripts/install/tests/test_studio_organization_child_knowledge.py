"""Real managed child Wiki reads keep original Accepted lineage and current PDP."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import os
from pathlib import Path
import threading
import time
import unittest

from organization_publication_fixture import Fixture
from studio_organization_budget import initialize
from studio_organization_channel import OrganizationChannel
from studio_organization_execution import model_resource_id
from studio_organization_workspace import WorkspaceBudgetBinding
from test_studio_organization_wiki_tool import tool_result


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1"
    and os.environ.get("KCODER_ORGANIZATION_APP_SERVER") and os.environ.get("KCODER_ORGANIZATION_LEGACY_FIXTURE"),
    "Explicit actual Native, seed and owned restricted UID required")
class OrganizationChildKnowledgeTests(unittest.TestCase):
    def test_original_managed_child_accepted_reads_actual_fixed_wiki(self):
        self.run_actual(True)

    def test_original_managed_child_cannot_borrow_parent_model_grant_for_wiki(self):
        self.run_actual(False)

    def run_actual(self, allowed):
        requests, results, errors, registries = [], [], [], []
        selected = {}
        arguments = {"agent_type": "general", "message": "OWNED_CHILD_WIKI_ONLY. Read the exact declared Wiki page once; use no other tools.",
                     "run_in_background": False, "context_mode": "none", "max_turns": 4}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                size = int(self.headers["Content-Length"])
                if size > 1024 * 1024: raise AssertionError("Owned child request ceiling")
                body = json.loads(self.rfile.read(size)); requests.append(body)
                try:
                    if len(requests) > 8: raise AssertionError("Owned child model-call ceiling")
                    users = [item for item in body["messages"] if item["role"] == "user"]
                    child = "OWNED_CHILD_WIKI_ONLY" in json.dumps(users[-1]["content"])
                    names = {item.get("function", {}).get("name") for item in body.get("tools", [])}
                    registries.append({"child": child, "names": sorted(names)})
                    if not child and "Wiki" not in names:
                        raise AssertionError("Original main registry has no Wiki")
                    if child:
                        result = tool_result(body, "owned-child-wiki-read")
                        if result is not None:
                            results.append(result)
                            delta, finish = {"content": "OWNED_CHILD_WIKI_TERMINAL"}, "stop"
                        else:
                            if "Wiki" not in names: raise AssertionError("Original child registry has no Wiki: " + repr(sorted(names)))
                            delta = {"tool_calls": [{"index": 0, "id": "owned-child-wiki-read", "type": "function",
                                "function": {"name": "Wiki", "arguments": json.dumps(selected)}}]}; finish = "tool_calls"
                    elif tool_result(body, "owned-original-child-spawn") is not None:
                        delta, finish = {"content": "OWNED_PARENT_WIKI_TERMINAL"}, "stop"
                    else:
                        delta = {"tool_calls": [{"index": 0, "id": "owned-original-child-spawn", "type": "function",
                            "function": {"name": "spawn_agent", "arguments": json.dumps(arguments)}}]}; finish = "tool_calls"
                except Exception as error:
                    errors.append(str(error)); delta, finish = {"content": "OWNED_CHILD_PROTOCOL_FAILURE"}, "stop"
                events = [{"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                    {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                     "usage": {"prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10}}]
                raw = ("".join("data: " + json.dumps(event) + "\n\n" for event in events) + "data: [DONE]\n\n").encode()
                self.send_response(200); self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True); started = False
        try:
            with Fixture(self) as fixture:
                binding, member = fixture.bindings["reader"], fixture.identities["reader"]
                profile = Path(binding["home"]) / ".config/kcoder"
                origin = "http://127.0.0.1:" + str(server.server_port)
                settings = {"active_provider": "fixture", "model": "owned-child-wiki", "max_tokens": 512, "max_retries": 0,
                    "providers": {"fixture": {"api_format": "openai_chat_completions", "authentication": {"mode": "none"},
                        "endpoint": origin + "/v1", "default_model": "owned-child-wiki", "context_window_tokens": 128000,
                        "max_output_tokens": 512, "output_headroom_tokens": 512, "discover_models": False, "no_proxy": True}},
                    "knowledge": {"enabled": True, "retrieval_enabled": True, "organization_enabled": False},
                    "memory": {"observer_mode": "disabled", "structured_enabled": False, "legacy_prompt_enabled": False},
                    "session_memory": {"enabled": False}}
                (profile / "settings.json").write_text(json.dumps(settings))
                source = fixture.seed("reader")
                selected.update({"action": "read", "library": source["source"]["libraryId"],
                    "page": source["source"]["pageId"], "revision": source["source"]["pageRevision"]})

                def channel_factory(accounts, identity, runtime, actual_binding):
                    return OrganizationChannel(accounts, identity, runtime=runtime,
                        workspace_resource=WorkspaceBudgetBinding(actual_binding, identity, Path(actual_binding["home"]) / "workspace"))

                session = fixture.session("reader", channel_factory=channel_factory)
                model = model_resource_id("fixture", "owned-child-wiki", origin, session.scope["targetRevision"])
                for identity, kind in ((session.scope["workspaceId"], "workspace"), (model, "model")):
                    fixture.policy.administer(None, {"operation": "organization.resource", "expectedRevision": fixture.policy._load()["revision"],
                        "resource": {"id": identity, "kind": kind, "owner": member["id"], "visibility": "private", "grants": []}})
                if allowed:
                    fixture.resource("administrator", session.owner, "knowledge", "current-target", readers=("reader",), actions=("read",))
                start = int(time.time() // 3600) * 3_600_000
                fixture.policy.administer(None, {"operation": "organization.executionPolicy", "expectedRevision": fixture.policy._load()["revision"],
                    "executionPolicy": {"version": 1, "modelRules": [{"id": "actual-child-wiki-route", "members": [member["id"]],
                        "workspaceResourceIds": [session.scope["workspaceId"]], "provider": "fixture", "model": "owned-child-wiki",
                        "endpointOrigin": origin, "configurationRevision": session.scope["targetRevision"], "enabled": True}],
                        "budgetPolicies": [{"id": "original-child-wiki-task", "scope": {"kind": "organization", "id": fixture.organization},
                            "window": {"id": "owned-hour", "startsAtMs": start, "endsAtMs": start + 3_600_000},
                            "limits": {"tokens": 1000000, "modelCalls": 8, "concurrentTasks": 1}, "currency": None}]}})
                initialize(fixture.accounts, fixture.programs[0]); worker.start(); started = True
                database = profile / "knowledge/state.sqlite"
                before = (database.stat().st_ino, database.stat().st_uid, hashlib.sha256(database.read_bytes()).hexdigest())
                thread = session.rpc("thread/start", {})["thread"]["id"]
                turn = session.rpc("turn/start", {"threadId": thread,
                    "input": [{"type": "text", "text": "Delegate exactly one bounded foreground child to read its explicitly declared owned Wiki page, then finish."}]})["turn"]["id"]
                approvals = set()

                def completed_or_approve(item):
                    params = item.get("params", {})
                    if item.get("method") == "approval/request" and item["id"] not in approvals:
                        action = params["action"]
                        self.assertEqual(action["type"], "tool")
                        self.assertIn(action["name"], ("spawn_agent", "Wiki"))
                        self.assertEqual(action["input"], arguments if action["name"] == "spawn_agent" else selected)
                        approvals.add(item["id"])
                        os.write(session.input_fd, (json.dumps({"jsonrpc": "2.0", "id": item["id"], "result": {"decision": "accept"}}) + "\n").encode())
                    return item.get("method") == "turn/completed" and params.get("threadId") == thread and params.get("turnId") == turn

                completed = session.wait(completed_or_approve, seconds=30)
                self.assertEqual(completed["params"]["turn"]["status"], "completed", completed)
                print(json.dumps({"actualChildWikiRegistries": registries, "readGranted": allowed}), flush=True)
                self.assertEqual(errors, [])
                self.assertEqual(len(results), 1, session.error_path.read_text())
                if allowed:
                    self.assertEqual(hashlib.sha256(results[0]["text"].encode()).hexdigest(), source["markdownSha256"])
                else:
                    self.assertNotIn("37 reviewed units", json.dumps(results[0]))
                    self.assertRegex(json.dumps(results[0]), "DENIED|denied|UNAVAILABLE|unavailable")
                receipts = [row["receipt"] for row in json.loads((fixture.accounts.root / "organization-budget/ledger.json").read_text())["reservations"].values()]
                child = [row for row in receipts if row["unit"] == "model_call" and row["task"]["actor"] == "child_agent"]
                slots = [row for row in receipts if row["unit"] == "task_slot"]
                self.assertEqual(len(child), 2); self.assertEqual(len(slots), 1)
                self.assertTrue(all(row["executionConfirmedTerminal"] for row in receipts))
                self.assertTrue(all(row["task"]["parentReservationId"] == slots[0]["reservationId"] for row in child))
                self.assertEqual((database.stat().st_ino, database.stat().st_uid, hashlib.sha256(database.read_bytes()).hexdigest()), before)
                print(json.dumps({"managedChildWikiEvidence": {"actualUid": binding["uid"], "readGranted": allowed,
                    "actualOriginalManagedChildAndAcceptedTool": True, "normalAskExactOwnedTools": True,
                    "originalParentSlotAndChildCallsSettled": True, "providerCalls": len(requests), "paidCalls": 0}}))
        finally:
            if started: server.shutdown()
            server.server_close()
            if started: worker.join(timeout=3); self.assertFalse(worker.is_alive())


if __name__ == "__main__": unittest.main()

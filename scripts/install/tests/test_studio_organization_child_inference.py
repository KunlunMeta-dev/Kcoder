"""Actual governed Native child models use the original shared task reservation."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from organization_publication_fixture import Fixture
from studio_organization_channel import OrganizationChannel
from studio_organization_workspace import WorkspaceBudgetBinding
from studio_organization_execution import model_resource_id
from studio_organization_budget import initialize


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1"
                    and os.environ.get("KCODER_ORGANIZATION_APP_SERVER"), "Explicit actual Native and owned restricted UID required")
class OrganizationChildInferenceTests(unittest.TestCase):
    def test_actual_child_model_keeps_original_parent_slot_and_usage(self):
        self.run_actual(nested=False)

    def test_undeclared_nested_spawn_stays_denied_and_charged_to_original_root_slot(self):
        self.run_actual(nested=True)

    def run_actual(self, nested):
        requests = []
        child_seen = threading.Event()
        child_release = threading.Event()
        grandchild_seen = threading.Event()
        grandchild_release = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_HEAD(self): self.send_response(200); self.end_headers()
            def do_POST(self):
                length = int(self.headers["Content-Length"])
                if length > 1024 * 1024: raise AssertionError("Owned model request too large")
                request = json.loads(self.rfile.read(length))
                requests.append(request)
                if len(requests) > (5 if nested else 3): raise AssertionError("Bounded original model call count exceeded")
                users = [item for item in request["messages"] if item["role"] == "user"]
                is_grandchild = "OWNED_GRANDCHILD_MODEL_ONLY" in json.dumps(users[-1]["content"])
                is_child = "OWNED_CHILD_MODEL_ONLY" in json.dumps(users[-1]["content"])
                has_tool_result = any(item["role"] == "tool" for item in request["messages"])
                if is_grandchild:
                    grandchild_seen.set()
                    if not grandchild_release.wait(10): raise AssertionError("Original child follow-up missing")
                    events = self.text("OWNED_GRANDCHILD_COMPLETE")
                elif is_child:
                    child_seen.set()
                    if not child_release.wait(10): raise AssertionError("Original parent follow-up missing")
                    if nested and not has_tool_result:
                        events = self.spawn("owned-nested-spawn", "OWNED_GRANDCHILD_MODEL_ONLY. Reply once, use no tools.")
                    else:
                        grandchild_release.set()
                        events = self.text("OWNED_CHILD_COMPLETE")
                elif has_tool_result:
                    child_release.set()
                    events = self.text("OWNED_PARENT_COMPLETE")
                else:
                    events = self.spawn("owned-native-spawn", "OWNED_CHILD_MODEL_ONLY. Complete the assigned bounded task.")
                raw = ("".join("data: " + json.dumps(event) + "\n\n" for event in events) + "data: [DONE]\n\n").encode()
                self.send_response(200); self.send_header("Content-Type","text/event-stream"); self.send_header("Content-Length",str(len(raw))); self.end_headers(); self.wfile.write(raw)
            @staticmethod
            def spawn(call_id, message):
                arguments = {"agent_type":"general", "message":message, "run_in_background":True,
                             "context_mode":"none", "max_turns":60}
                return [{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":call_id,
                    "type":"function","function":{"name":"spawn_agent","arguments":json.dumps(arguments)}}]},"finish_reason":None}]},
                    {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}]
            @staticmethod
            def text(value):
                return [{"choices":[{"index":0,"delta":{"role":"assistant","content":value},"finish_reason":None}]},
                        {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}]

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        started = False
        try:
            with Fixture(self, with_seed=False) as fixture:
                member = fixture.identities["reader"]
                binding = fixture.bindings["reader"]
                home = Path(binding["home"])
                origin = "http://127.0.0.1:" + str(server.server_port)
                settings = {"active_provider":"fixture","model":"owned-model","permission_mode":"bypass","max_tokens":512,"max_retries":0,
                    "providers":{"fixture":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":origin+"/v1",
                        "default_model":"owned-model","context_window_tokens":128000,"max_output_tokens":512,"output_headroom_tokens":512,"discover_models":False,"no_proxy":True}},
                    "memory":{"observer_mode":"disabled","structured_enabled":False,"legacy_prompt_enabled":False},"session_memory":{"enabled":False}}
                (home/".config/kcoder/settings.json").write_text(json.dumps(settings))
                def channel_factory(accounts, identity, runtime, actual_binding):
                    return OrganizationChannel(accounts, identity, runtime=runtime,
                        workspace_resource=WorkspaceBudgetBinding(actual_binding,identity,Path(actual_binding["home"])/"workspace"))
                session = fixture.session("reader",channel_factory=channel_factory)
                worker.start(); started = True
                model = model_resource_id("fixture","owned-model",origin,session.scope["targetRevision"])
                for identity, kind in [(session.scope["workspaceId"],"workspace"),(model,"model")]:
                    fixture.policy.administer(None,{"operation":"organization.resource","expectedRevision":fixture.policy._load()["revision"],
                        "resource":{"id":identity,"kind":kind,"owner":member["id"],"visibility":"private","grants":[]}})
                start = int(time.time() // 3600) * 3_600_000
                fixture.policy.administer(None,{"operation":"organization.executionPolicy","expectedRevision":fixture.policy._load()["revision"],
                    "executionPolicy":{"version":1,"modelRules":[{"id":"approved-child-route","members":[member["id"]],"workspaceResourceIds":[session.scope["workspaceId"]],
                        "provider":"fixture","model":"owned-model","endpointOrigin":origin,"configurationRevision":session.scope["targetRevision"],"enabled":True}],
                        "budgetPolicies":[{"id":"one-original-task","scope":{"kind":"organization","id":fixture.organization},
                            "window":{"id":"original-hour","startsAtMs":start,"endsAtMs":start+3_600_000},"limits":{"tokens":1000000,"modelCalls":20,"concurrentTasks":1},"currency":None}]}})
                initialize(fixture.accounts,fixture.programs[0])
                thread = session.rpc("thread/start",{"model":"fixture::owned-model"})["thread"]["id"]
                turn = session.rpc("turn/start",{"threadId":thread,"input":[{"type":"text","text":"Delegate exactly one bounded child, then finish after its result."}]})["turn"]["id"]
                completed = session.wait(lambda item:item.get("method")=="turn/completed" and item.get("params",{}).get("turnId")==turn,seconds=30)
                self.assertEqual(completed["params"]["turn"]["status"],"completed",completed)
                self.assertTrue(child_seen.is_set(),"The actual child must reach the controlled Provider")
                ledger_path = fixture.accounts.root/"organization-budget/ledger.json"
                deadline = time.monotonic()+10
                while True:
                    receipts = [row["receipt"] for row in json.loads(ledger_path.read_text())["reservations"].values()]
                    children = [row for row in receipts if row["unit"]=="model_call" and row["task"]["actor"]=="child_agent"]
                    slots = [row for row in receipts if row["unit"]=="task_slot"]
                    if len(children) == (2 if nested else 1) and all(row["executionConfirmedTerminal"] for row in receipts): break
                    if time.monotonic() >= deadline:
                        summary = {"providerPosts":len(requests),"grandchildSeen":grandchild_seen.is_set(),
                            "requests":[{"kind":"grandchild" if "OWNED_GRANDCHILD_MODEL_ONLY" in json.dumps([item.get("content") for item in value["messages"] if item["role"]=="user"][-1])
                                else "child" if "OWNED_CHILD_MODEL_ONLY" in json.dumps([item.get("content") for item in value["messages"] if item["role"]=="user"][-1]) else "parent",
                                "spawnAvailable":any(tool.get("function",{}).get("name")=="spawn_agent" for tool in value.get("tools",[])),
                                "toolResults":[item.get("tool_call_id") for item in value["messages"] if item["role"]=="tool"]} for value in requests],
                            "receipts":[{"actor":row["task"]["actor"],"unit":row["unit"],"phase":row["phase"],
                                "terminal":row["executionConfirmedTerminal"],"tokens":row["charged"]["tokens"]} for row in receipts]}
                        self.fail("Original task/child reservations did not settle: "+json.dumps(summary))
                    time.sleep(0.02)
                self.assertEqual(len(children),2 if nested else 1)
                if nested:
                    self.assertFalse(grandchild_seen.is_set(), "An undeclared tool cannot create a nested model execution")
                    child_requests = [value for value in requests if "OWNED_CHILD_MODEL_ONLY" in json.dumps(
                        [item.get("content") for item in value["messages"] if item["role"] == "user"][-1])]
                    self.assertTrue(child_requests)
                    for value in child_requests:
                        self.assertFalse(any(tool.get("function",{}).get("name") == "spawn_agent" for tool in value.get("tools",[])),
                            "This case validates the actual child tool ceiling, not a new nested-agent capability")
                parent = next(row for row in slots if row["task"]["rootOperationId"]==children[0]["task"]["rootOperationId"])
                self.assertEqual(len(slots),1, "Nested children must not allocate independent root task slots")
                for child in children:
                    self.assertEqual(child["task"]["parentReservationId"],parent["reservationId"])
                    self.assertEqual(child["task"]["rootOperationId"],parent["task"]["rootOperationId"])
                    self.assertEqual(child["charged"]["tokens"],10)
                self.assertEqual(len(requests),4 if nested else 3)
                print(json.dumps({"actualOrganizationChild":{"providerPosts":len(requests),"childCalls":len(children),"undeclaredNestedAttempt":nested,"originalParentSlot":True,
                    "originalReservationsTerminal":True,"actualChildTokens":sum(row["charged"]["tokens"] for row in children),"paidCalls":0,"classicPermissionFixture":"owned bypass; not a permission approval test"}}))
        finally:
            child_release.set()
            grandchild_release.set()
            if started: server.shutdown()
            server.server_close()
            if started: worker.join(timeout=12); self.assertFalse(worker.is_alive())


if __name__ == "__main__": unittest.main()

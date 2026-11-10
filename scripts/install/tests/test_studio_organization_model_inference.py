"""Real restricted-UID Native Provider admission and original shared budget settlement."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_organization_channel import OrganizationChannel
from studio_organization_workspace import WorkspaceBudgetBinding
from studio_organization_execution import model_resource_id
from studio_organization_budget import initialize
from organization_publication_fixture import Fixture
import studio_organization_budget as budget_service


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1" and os.environ.get("KCODER_ORGANIZATION_APP_SERVER"), "Explicit actual Native and restricted UID fixture required")
class OrganizationInferenceTests(unittest.TestCase):
    def test_actual_native_model_observer_enforces_original_route_budget_and_same_session_revocation(self):
        self.run_actual(False)

    def test_original_journal_separates_actual_retry_and_retains_unknown_usage(self):
        self.run_actual(True)

    def run_actual(self, retry_first):
        requests = []
        budget_failures = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):pass
            def do_HEAD(self):
                self.send_response(200);self.end_headers()
            def do_POST(self):
                length = int(self.headers["Content-Length"])
                if length > 512 * 1024:raise AssertionError("Owned model request too large")
                requests.append(json.loads(self.rfile.read(length)))
                if retry_first and len(requests) == 1:
                    body = json.dumps({"error":{"type":"overloaded_error","message":"Owned transient fixture"}}).encode()
                    self.send_response(503);self.send_header("Content-Type", "application/json");self.send_header("Content-Length", str(len(body)));self.end_headers();self.wfile.write(body)
                    return
                events = [
                    {"choices":[{"index":0,"delta":{"role":"assistant","content":"OWNED_ORGANIZATION_RESULT"},"finish_reason":None}]},
                    {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}},
                ]
                body = "".join("data: " + json.dumps(event) + "\n\n" for event in events) + "data: [DONE]\n\n"
                self.send_response(200);self.send_header("Content-Type", "text/event-stream");self.send_header("Content-Length", str(len(body.encode())));self.end_headers();self.wfile.write(body.encode())

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        started = False
        try:
            with Fixture(self, with_seed=False) as fixture:
                original_budget_run = budget_service._run
                failure_path = fixture.root / "owned-budget-failures.jsonl"

                def observe_budget_run(runtime, envelope):
                    try:
                        return original_budget_run(runtime, envelope)
                    except Exception as error:
                        budget_failures.append({"action":envelope.get("action", {}).get("kind"),
                            "type":type(error).__name__, "code":getattr(error, "code", None)})
                        descriptor = os.open(failure_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
                        try:
                            os.write(descriptor, (json.dumps(budget_failures[-1]) + "\n").encode())
                        finally:
                            os.close(descriptor)
                        raise

                fixture.resources.enter_context(patch.object(budget_service, "_run", observe_budget_run))
                name = "reader"
                binding, member = fixture.bindings[name], fixture.identities[name]
                home = Path(binding["home"])
                origin = "http://127.0.0.1:" + str(server.server_port)
                settings = {"active_provider":"fixture", "model":"owned-model", "max_tokens":512, "max_retries":1 if retry_first else 0,
                    "providers":{"fixture":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":origin+"/v1",
                        "default_model":"owned-model","context_window_tokens":128000,"max_output_tokens":512,"output_headroom_tokens":512,"discover_models":False,"no_proxy":True}},
                    "memory":{"observer_mode":"disabled","structured_enabled":False,"legacy_prompt_enabled":False},"session_memory":{"enabled":False}}
                settings["providers"]["unapproved"] = {**settings["providers"]["fixture"], "endpoint":"http://127.0.0.1:1/v1"}
                settings["integrations"] = {"core":{"modelPolicies":[{"id":"owned-route-pool","candidates":[
                    {"provider":"unapproved","model":"owned-model"},{"provider":"fixture","model":"owned-model"}]}]}}
                (home / ".config/kcoder/settings.json").write_text(json.dumps(settings))

                def channel_factory(accounts, identity, runtime, actual_binding):
                    workspace = WorkspaceBudgetBinding(actual_binding, identity, Path(actual_binding["home"]) / "workspace")
                    return OrganizationChannel(accounts, identity, runtime=runtime, workspace_resource=workspace)

                session = fixture.session(name, channel_factory=channel_factory)
                worker.start()
                started = True
                workspace = session.scope["workspaceId"]
                revision = session.scope["targetRevision"]
                model = model_resource_id("fixture", "owned-model", origin, revision)
                for identity, kind in [(workspace,"workspace"),(model,"model")]:
                    fixture.policy.administer(None,{"operation":"organization.resource","expectedRevision":fixture.policy._load()["revision"],
                        "resource":{"id":identity,"kind":kind,"owner":member["id"],"visibility":"private","grants":[]}})
                start = int(time.time() // 3600) * 3_600_000
                execution = {"version":1,"modelRules":[{"id":"exact-actual-model","members":[member["id"]],"workspaceResourceIds":[workspace],
                    "provider":"fixture","model":"owned-model","endpointOrigin":origin,"configurationRevision":revision,"enabled":True}],
                    "budgetPolicies":[{"id":"original-org-cap","scope":{"kind":"organization","id":fixture.organization},
                        "window":{"id":"owned-hour","startsAtMs":start,"endsAtMs":start+3_600_000},"limits":{"tokens":1000000 if retry_first else 100000,"modelCalls":4 if retry_first else 3,"concurrentTasks":1},"currency":None}]}
                fixture.policy.administer(None,{"operation":"organization.executionPolicy","expectedRevision":fixture.policy._load()["revision"],"executionPolicy":execution})
                initialize(fixture.accounts, fixture.programs[0])
                envelope = lambda payload:{"contractVersion":"parallel-v1","requestId":"owned-model-preview","scope":session.scope,"timeoutMs":10000,"payload":payload}
                catalog = session.rpc("integrations/models/readPolicies", envelope({}))
                self.assertEqual(catalog["status"],"completed",catalog)
                reference = catalog["result"]["policies"][0]["reference"]
                preview = session.rpc("integrations/models/resolveSelection", envelope({"selection":{"kind":"auto_policy",**reference},"requirements":{"inputTokens":100,"outputTokens":128}}))
                self.assertEqual(preview["result"]["model"]["providerId"],"fixture",preview)
                self.assertEqual(len(requests),0,"Native policy preview must exclude the unapproved route without any Provider request")
                thread = session.rpc("thread/start", {})["thread"]["id"]

                def turn(prompt, thread_id=None):
                    selected = thread_id or thread
                    result = session.rpc("turn/start", {"threadId":selected,"input":[{"type":"text","text":prompt}]})
                    turn_id = result["turn"]["id"]
                    return session.wait(lambda item:item.get("method")=="turn/completed" and item.get("params",{}).get("threadId")==selected and item.get("params",{}).get("turnId")==turn_id)

                completed = turn("Reply once using the approved local protocol fixture.")
                diagnostic_ledger = json.loads((fixture.accounts.root / "organization-budget/ledger.json").read_text())
                diagnostic_receipts = [{key: row["receipt"].get(key) for key in ("unit", "phase", "task", "charged", "executionConfirmedTerminal")}
                                       for row in diagnostic_ledger["reservations"].values()]
                failures = failure_path.read_text() if failure_path.exists() else ""
                self.assertEqual(completed["params"]["turn"]["status"],"completed",{"terminal":completed,
                    "providerCalls":len(requests), "budgetFailures":failures, "receipts":diagnostic_receipts})
                self.assertEqual(len(requests),2 if retry_first else 1)
                self.assertEqual(requests[0]["model"],"owned-model")
                ledger = json.loads((fixture.accounts.root / "organization-budget/ledger.json").read_text())
                reservations = [row for row in ledger["reservations"].values() if row["receipt"]["unit"]=="model_call"]
                self.assertEqual(len(reservations),2 if retry_first else 1)
                actors = [row["receipt"]["task"]["actor"] for row in reservations]
                self.assertCountEqual(actors, ["main", "retry"] if retry_first else ["main"])
                if retry_first:
                    unknown = next(row["receipt"] for row in reservations if row["receipt"]["task"]["actor"] == "main")
                    self.assertGreater(unknown["charged"]["tokens"],10,"Missing usage must retain the conservative original reservation")
                    self.assertIsNone(unknown["charged"]["costMicros"],"An HTTP error without usage must not become zero cost")
                observed = next(row["receipt"] for row in reservations if row["receipt"]["task"]["actor"] == ("retry" if retry_first else "main"))
                self.assertEqual(observed["charged"]["tokens"],10)
                self.assertTrue(observed["executionConfirmedTerminal"])
                slots = [row["receipt"] for row in ledger["reservations"].values() if row["receipt"]["unit"]=="task_slot"]
                self.assertEqual(len(slots),1)
                if retry_first:
                    self.assertFalse(slots[0]["executionConfirmedTerminal"],"A successful retry cannot settle an earlier invocation with unknown execution")
                    second_thread = session.rpc("thread/start", {})["thread"]["id"]
                    blocked = turn("Unknown execution must retain its original concurrency reservation.", second_thread)
                    self.assertEqual(blocked["params"]["turn"]["status"],"failed",blocked)
                    self.assertEqual(len(requests),2,"An unknown first invocation must not silently release concurrency for another task")
                    after = json.loads((fixture.accounts.root / "organization-budget/ledger.json").read_text())
                    calls = [row["receipt"] for row in after["reservations"].values() if row["receipt"]["unit"]=="model_call"]
                    self.assertEqual(len(calls),2)
                    retained = next(row for row in calls if row["task"]["actor"] == "main")
                    self.assertEqual(retained["charged"], unknown["charged"])
                    self.assertFalse(retained["executionConfirmedTerminal"])
                    return
                self.assertTrue(slots[0]["executionConfirmedTerminal"],"Release must follow the original terminal without another request in that thread")
                second_thread = session.rpc("thread/start", {})["thread"]["id"]
                second = turn("An independent resident thread must obtain the released concurrent slot.", second_thread)
                self.assertEqual(second["params"]["turn"]["status"],"completed",second)
                self.assertEqual(len(requests),3 if retry_first else 2)
                execution["modelRules"][0]["enabled"] = False
                fixture.policy.administer(None,{"operation":"organization.executionPolicy","expectedRevision":fixture.policy._load()["revision"],"executionPolicy":execution})
                denied = turn("The original session must observe current model revocation.")
                self.assertEqual(denied["params"]["turn"]["status"],"failed",denied)
                self.assertEqual(len(requests),3 if retry_first else 2,"Revocation must stop the actual Provider before another HTTP request")
                execution["modelRules"][0]["enabled"] = True
                execution["modelRules"][0]["endpointOrigin"] = "http://127.0.0.1:1"
                fixture.policy.administer(None,{"operation":"organization.executionPolicy","expectedRevision":fixture.policy._load()["revision"],"executionPolicy":execution})
                wrong_route = turn("A different allowed endpoint must not authorize the original route.")
                self.assertEqual(wrong_route["params"]["turn"]["status"],"failed",wrong_route)
                self.assertEqual(len(requests),3 if retry_first else 2)
                execution["modelRules"][0]["endpointOrigin"] = origin
                execution["budgetPolicies"][0]["limits"]["modelCalls"] = 3 if retry_first else 2
                fixture.policy.administer(None,{"operation":"organization.executionPolicy","expectedRevision":fixture.policy._load()["revision"],"executionPolicy":execution})
                exhausted = turn("The next actual Provider request must obey the original exhausted balance.")
                self.assertEqual(exhausted["params"]["turn"]["status"],"failed",exhausted)
                self.assertEqual(len(requests),3 if retry_first else 2,"Budget failure must not generate another HTTP request")
                after = json.loads((fixture.accounts.root / "organization-budget/ledger.json").read_text())
                slots = [row["receipt"] for row in after["reservations"].values() if row["receipt"]["unit"]=="task_slot"]
                self.assertEqual(len(slots),3,"Each original Accepted task has a distinct slot, including admission failure")
                self.assertTrue(all(item["executionConfirmedTerminal"] for item in slots),"Completed and rejected turns must settle their own original slots")
        finally:
            if started:
                server.shutdown()
            server.server_close()
            if started:
                worker.join(timeout=3)
                self.assertFalse(worker.is_alive())


if __name__ == "__main__":unittest.main()

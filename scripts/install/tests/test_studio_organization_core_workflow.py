"""Actual Core Workflow children use the original governed root budget."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import select
import shutil
import signal
import threading
import time
import unittest

from organization_publication_fixture import Fixture
from studio_account_runtime import drop_to_worker, trusted_runtime
from studio_account_sessions import supervise
from studio_organization_channel import CHANNEL_ENV, OrganizationChannel
from studio_organization_workspace import WorkspaceBudgetBinding
from studio_organization_execution import model_resource_id
from studio_organization_budget import initialize

TEST = ("app_server::integrations::core::runtime_driver::tests::workflow_tests::"
        "organization_workflow_tests::actual_uid_direct_core_workflow_children_share_original_root_budget")
PURE_TEST = ("app_server::integrations::core::runtime_driver::tests::workflow_tests::"
             "organization_pure_workflow_tests::actual_uid_pure_wait_and_code_roots_contend_before_any_node_effect")


def run_owned_probe(fixture, on_scope, on_tick, expected, on_pure_active=None):
    executable = fixture.installed / "organization-core-workflow-test"
    shutil.copyfile(os.environ["KCODER_ORGANIZATION_NATIVE_TEST_BINARY"], executable)
    executable.chmod(0o755)
    executable = trusted_runtime(executable)
    identity, binding = fixture.identities["reader"], fixture.bindings["reader"]
    output_read, output_write = os.pipe()
    command_read, command_write = os.pipe()
    error_path = fixture.root / "organization-core-workflow.log"
    error_fd = os.open(error_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    supervisor = os.fork()
    if supervisor == 0:
        os.close(output_read)
        os.close(command_write)
        channel = OrganizationChannel(fixture.accounts, identity, runtime=fixture.programs[0],
            workspace_resource=WorkspaceBudgetBinding(binding, identity, Path(binding["home"])/"workspace"))

        def execute():
            os.dup2(command_read, 0)
            os.dup2(output_write, 1)
            os.dup2(error_fd, 2)
            environment = drop_to_worker(binding, identity)
            environment[CHANNEL_ENV] = str(channel.child_fd())
            environment["KCODER_TEST_ORGANIZATION_CORE_WORKFLOW"] = "1"
            environment["KCODER_TEST_ORGANIZATION_WORKFLOW_EXPECTED"] = expected
            environment["RUST_MIN_STACK"] = "16777216"
            environment["RUST_LOG"] = "warn"
            os.chdir(Path(binding["home"])/"workspace")
            test=PURE_TEST if on_pure_active else TEST
            os.execve(executable, [executable, test, "--exact", "--ignored", "--nocapture", "--test-threads=1"], environment)

        os._exit(supervise(fixture.accounts, identity, execute, interval=0.01, policy_channel=channel))
    os.close(output_write)
    os.close(command_read)
    os.close(error_fd)
    transcript, pending, waited, scopes = bytearray(), bytearray(), False, 0
    try:
        deadline = time.monotonic()+45
        while time.monotonic() < deadline:
            on_tick()
            if not select.select([output_read], [], [], min(.05, max(0, deadline-time.monotonic())))[0]:
                continue
            chunk = os.read(output_read, 65536)
            if not chunk:
                break
            transcript.extend(chunk)
            pending.extend(chunk)
            fixture.case.assertLessEqual(len(transcript), 512*1024)
            while b"\n" in pending:
                line, _, rest=pending.partition(b"\n");pending[:]=rest
                marker=b"ORG_CORE_WORKFLOW_SCOPE:"
                if marker in line:
                    scopes+=1
                    fixture.case.assertEqual(scopes,1)
                    on_scope(json.loads(line.split(marker,1)[1]))
                    os.write(command_write,b"continue\n")
                pure_marker=b"ORG_CORE_WORKFLOW_PURE_ACTIVE:"
                if pure_marker in line:
                    fixture.case.assertIsNotNone(on_pure_active)
                    on_pure_active(json.loads(line.split(pure_marker,1)[1]))
                    os.write(command_write,b"continue\n")
        terminal,status=os.waitpid(supervisor,os.WNOHANG)
        while not terminal and time.monotonic()<deadline:
            time.sleep(.01)
            terminal,status=os.waitpid(supervisor,os.WNOHANG)
        fixture.case.assertNotEqual(terminal,0,"Owned Core Workflow deadline")
        waited = True
        return os.waitstatus_to_exitcode(status), transcript.decode(), error_path.read_text()
    finally:
        os.close(output_read)
        os.close(command_write)
        if not waited:
            terminal, _ = os.waitpid(supervisor, os.WNOHANG)
            if not terminal:
                os.kill(supervisor, signal.SIGTERM)
                os.waitpid(supervisor, 0)


@unittest.skipUnless(os.geteuid()==0 and os.environ.get("KCODER_TEST_SYSTEM_USERS")=="1"
    and os.environ.get("KCODER_ORGANIZATION_APP_SERVER")
    and os.environ.get("KCODER_ORGANIZATION_NATIVE_TEST_BINARY"), "Explicit owned UID, Native and test executables required")
class OrganizationCoreWorkflow(unittest.TestCase):
    def test_actual_direct_core_workflow_has_one_original_root_for_two_children(self):
        self._run("complete")

    def test_actual_original_workflow_budget_exhaustion_preserves_first_child(self):
        self._run("exhausted")

    def test_actual_denied_model_stops_before_original_workflow_acceptance(self):
        self._run("model_denied")

    def test_actual_missing_workflow_usage_retains_conservative_original_charge(self):
        self._run("unreported")

    def test_actual_pure_wait_and_code_roots_share_the_task_concurrency_limit(self):
        self._run("pure_roots")

    def _run(self, mode):
        requests=[]
        second_seen=threading.Event()
        second_release=threading.Event()
        held=[]
        errors=[]

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                size=int(self.headers["Content-Length"])
                if size>1024*1024:
                    raise AssertionError("Owned Workflow request ceiling")
                requests.append(json.loads(self.rfile.read(size)))
                if mode=="pure_roots":
                    raise AssertionError("Model-free Workflow unexpectedly invoked a provider")
                if len(requests)>2:
                    raise AssertionError("Only the two actual Workflow children may invoke the provider")
                if len(requests)==2 and mode=="complete":
                    second_seen.set()
                    if not second_release.wait(5):
                        errors.append("Original second child response release deadline")
                events=[{"choices":[{"index":0,"delta":{"content":"{\"verified\":true}"},"finish_reason":None}]},
                    {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],
                     "usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}]
                if mode=="unreported":
                    events[-1].pop("usage")
                raw=("".join("data: "+json.dumps(e)+"\n\n" for e in events)+"data: [DONE]\n\n").encode()
                self.send_response(200)
                self.send_header("Content-Type","text/event-stream")
                self.send_header("Content-Length",str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        started=False
        try:
            with Fixture(self,with_seed=False) as fixture:
                fixture.resources.callback(second_release.set)
                binding,member=fixture.bindings["reader"],fixture.identities["reader"]
                profile=Path(binding["home"])/".config/kcoder"
                origin="http://127.0.0.1:"+str(server.server_port)
                settings={"active_provider":"fixture","model":"owned-workflow-model","permission_mode":"bypass",
                    "max_tokens":512,"max_retries":0,"providers":{"fixture":{"api_format":"openai_chat_completions",
                    "authentication":{"mode":"none"},"endpoint":origin+"/v1","default_model":"owned-workflow-model",
                    "context_window_tokens":128000,"max_output_tokens":512,"output_headroom_tokens":512,
                    "discover_models":False,"no_proxy":True}},"auto_memory_enabled":False,
                    "memory":{"observer_mode":"disabled","structured_enabled":False},"session_memory":{"enabled":False}}
                (profile/"settings.json").write_text(json.dumps(settings))
                def on_scope(scope):
                    nonlocal started
                    model=model_resource_id("fixture","owned-workflow-model",origin,scope["targetRevision"])
                    for resource,kind in [(scope["workspaceId"],"workspace"),(model,"model")]:
                        fixture.policy.administer(None,{"operation":"organization.resource","expectedRevision":fixture.policy._load()["revision"],
                            "resource":{"id":resource,"kind":kind,"owner":member["id"],"visibility":"private","grants":[]}})
                    start=int(time.time()//3600)*3600000
                    fixture.policy.administer(None,{"operation":"organization.executionPolicy","expectedRevision":fixture.policy._load()["revision"],
                    "executionPolicy":{"version":1,"modelRules":[{"id":"owned-workflow-route","members":[member["id"]],
                        "workspaceResourceIds":[scope["workspaceId"]],"provider":"fixture","model":"owned-workflow-model",
                        "endpointOrigin":origin,"configurationRevision":scope["targetRevision"],"enabled":mode!="model_denied"}],
                        "budgetPolicies":[{"id":"one-workflow-root","scope":{"kind":"organization","id":fixture.organization},
                        "window":{"id":"owned-hour","startsAtMs":start,"endsAtMs":start+3600000},
                        "limits":{"tokens":1000000,"modelCalls":1 if mode=="exhausted" else 2,"concurrentTasks":1},"currency":None}]}})
                    initialize(fixture.accounts,fixture.programs[0])
                    thread.start();started=True
                def on_tick():
                    if not second_seen.is_set() or held:
                        return
                    rows=[v["receipt"] for v in json.loads((fixture.accounts.root/"organization-budget/ledger.json").read_text())["reservations"].values()]
                    slots=[r for r in rows if r["unit"]=="task_slot"]
                    calls=[r for r in rows if r["unit"]=="model_call"]
                    self.assertEqual(len(slots),1)
                    self.assertEqual(len(calls),2)
                    self.assertFalse(slots[0]["executionConfirmedTerminal"])
                    self.assertEqual(sum(r["executionConfirmedTerminal"] for r in calls),1)
                    self.assertEqual({r["task"]["parentReservationId"] for r in calls},{slots[0]["reservationId"]})
                    held.append({"firstCallTerminal":True,"secondCallInFlight":True,"originalRootHeld":True,
                        "rootReservationId":slots[0]["reservationId"],"rootTask":slots[0]["task"]["rootTask"]})
                    second_release.set()
                expected="failed" if mode=="exhausted" else "model_denied" if mode=="model_denied" else "completed"
                def on_pure_active(snapshot):
                    original=[v["receipt"] for v in json.loads((fixture.accounts.root/"organization-budget/ledger.json").read_text())["reservations"].values()]
                    held.append({"actualFirstRoot":snapshot,"originalBudgetReceiptsWhileWaitActive":original})
                status,output,error=run_owned_probe(fixture,on_scope,on_tick,expected,on_pure_active if mode=="pure_roots" else None)
                rows=[v["receipt"] for v in json.loads((fixture.accounts.root/"organization-budget/ledger.json").read_text())["reservations"].values()]
                print(json.dumps({"actualCoreWorkflowDiagnostic":{"uid":binding["uid"],"providerCalls":len(requests),
                    "originalBudgetReceipts":rows,
                    "mode":mode,"heldAfterFirstChild":held,
                    "libtestMinStackBytes":16777216,
                    "status":status,"originalNativeProbe":output,"stderr":error,
                    "budgetRows":[{"unit":r["unit"],"actor":r["task"]["actor"],"rootOperationId":r["task"]["rootOperationId"],
                        "rootTask":r["task"]["rootTask"],"coverage":r["coverage"],"charged":r["charged"],
                        "terminal":r["executionConfirmedTerminal"]} for r in rows],"paidCalls":0}}))
                self.assertEqual(status,0)
                self.assertEqual(errors,[])
                self.assertEqual(len(requests),0 if mode in {"model_denied","pure_roots"} else 1 if mode=="exhausted" else 2)
                if mode=="pure_roots":
                    self.assertEqual(len(held),1)
                    during=held[0]["originalBudgetReceiptsWhileWaitActive"]
                    self.assertEqual(len(during),1)
                    self.assertEqual(during[0]["unit"],"task_slot")
                    self.assertFalse(during[0]["executionConfirmedTerminal"])
                    self.assertEqual(during[0]["task"]["rootTask"]["id"],held[0]["actualFirstRoot"]["originalCoreAcceptance"]["taskId"])
                    final=json.loads(next(line.split("ORG_CORE_WORKFLOW_PURE_EVIDENCE:",1)[1] for line in output.splitlines() if "ORG_CORE_WORKFLOW_PURE_EVIDENCE:" in line))
                    self.assertEqual(len(rows),3)
                    self.assertTrue(all(r["unit"]=="task_slot" and r["executionConfirmedTerminal"] for r in rows))
                    self.assertEqual({r["task"]["rootTask"]["id"] for r in rows},{final["firstAccepted"]["taskId"],final["additionalMeterDeniedAccepted"]["taskId"],final["afterReleaseAccepted"]["taskId"]})
                    self.assertTrue(all(node["startedAtMs"] is None for node in final["additionalMeterDeniedWorkflow"]["nodeStates"]))
                    self.assertTrue(final["noParentTurnAttempt"])
                    return
                if mode=="model_denied":
                    self.assertEqual(rows,[])
                    self.assertIn("ORG_CORE_WORKFLOW_ADMISSION_EVIDENCE:",output)
                    self.assertNotIn("ORG_CORE_WORKFLOW_EVIDENCE:",output)
                    return
                evidence=json.loads(next(line.split("ORG_CORE_WORKFLOW_EVIDENCE:",1)[1] for line in output.splitlines() if "ORG_CORE_WORKFLOW_EVIDENCE:" in line))
                self.assertTrue(evidence["parentAttemptIsNone"])
                self.assertEqual(evidence["nodeStates"][0]["status"],"completed")
                self.assertEqual(evidence["nodeStates"][1]["status"],"failed" if mode=="exhausted" else "completed")
                intents=evidence["nativeChildIntents"]
                self.assertGreaterEqual(len(intents),1)
                for child in intents:
                    self.assertEqual(child["phase"],"accepted")
                    self.assertEqual(child["intent"]["workflowTaskId"],evidence["originalCoreAcceptance"]["taskId"])
                    self.assertEqual(child["intent"]["childIdentity"]["attemptId"],"native-child-attempt-"+child["intent"]["backgroundRun"]["runId"])
                slots=[r for r in rows if r["unit"]=="task_slot"]
                calls=[r for r in rows if r["unit"]=="model_call"]
                self.assertEqual(len(slots),1)
                self.assertEqual(len(calls),1 if mode=="exhausted" else 2)
                self.assertEqual(slots[0]["task"]["rootTask"],{"kind":"task","id":evidence["originalCoreAcceptance"]["taskId"]})
                if mode=="complete":
                    self.assertEqual(len(held),1)
                    self.assertEqual(len(intents),2)
                for call in calls:
                    self.assertEqual(call["task"]["actor"],"child_agent")
                    self.assertEqual(call["task"]["parentReservationId"],slots[0]["reservationId"])
                    if mode=="unreported":
                        self.assertNotEqual(call["coverage"],"complete")
                        self.assertGreater(call["estimate"]["tokens"],0)
                        self.assertGreaterEqual(call["charged"]["tokens"],call["estimate"]["tokens"])
                        self.assertFalse(call["costKnown"])
                    else:
                        self.assertEqual(call["charged"]["tokens"],10)
                self.assertTrue(all(r["executionConfirmedTerminal"] for r in rows))
        finally:
            if started:
                server.shutdown()
            server.server_close()
            if started:
                thread.join(timeout=3)
                self.assertFalse(thread.is_alive())


if __name__=="__main__":
    unittest.main()

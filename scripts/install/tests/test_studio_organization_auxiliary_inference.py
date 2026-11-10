"""Actual automatic observer requests retain the original governed task ledger."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import threading
import time
import unittest

from organization_publication_fixture import Fixture
from studio_organization_channel import OrganizationChannel
from studio_organization_workspace import WorkspaceBudgetBinding
from studio_organization_execution import model_resource_id
from studio_organization_budget import initialize


@unittest.skipUnless(os.geteuid()==0 and os.environ.get("KCODER_TEST_SYSTEM_USERS")=="1"
    and os.environ.get("KCODER_ORGANIZATION_APP_SERVER"), "Explicit actual Native and owned UID required")
class OrganizationAuxiliaryInference(unittest.TestCase):
    def test_automatic_memory_observer_uses_original_root_slot_and_real_usage(self):
        self._run_automatic_auxiliary("observer")

    def test_automatic_session_summary_uses_original_root_slot_and_real_usage(self):
        self._run_automatic_auxiliary("summary")

    def test_actual_goal_verifier_uses_original_root_slot_and_real_usage(self):
        self._run_automatic_auxiliary("verifier")

    def test_exhausted_original_budget_stops_actual_verifier_before_provider(self):
        self._run_automatic_auxiliary("verifier",model_calls=1,expect_denied=True)

    def test_actual_moa_references_and_aggregator_share_original_task_budget(self):
        self._run_automatic_auxiliary("moa")

    def _run_automatic_auxiliary(self,kind,model_calls=5,expect_denied=False):
        requests=[];observer_seen=threading.Event();auxiliary_release=threading.Event();errors=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*_):pass
            def do_POST(self):
                size=int(self.headers["Content-Length"])
                if size>1024*1024:raise AssertionError("Owned auxiliary request ceiling")
                body=json.loads(self.rfile.read(size));requests.append(body)
                if len(requests)>5:raise AssertionError("Owned auxiliary call ceiling")
                system=json.dumps([m["content"] for m in body["messages"] if m["role"]=="system"])
                auxiliary=(True if kind=="moa" else any(t.get("function",{}).get("name")=="VerifierVote" for t in body.get("tools",[]))
                    if kind=="verifier" else "private memory observer" in system if kind=="observer" else
                    len(body["messages"])==1 and "internal session-memory maintenance task" in json.dumps(body["messages"][0]))
                if auxiliary:
                    observer_seen.set()
                    if kind=="summary" and not auxiliary_release.wait(5):
                        errors.append("Owned summary response release deadline")
                    text=("Owned independent bounded reference or aggregation response." if kind=="moa" else
                        "PASS\nThe controlled fixture report states 6 * 7 = 42." if kind=="verifier" else
                        json.dumps({"observation_candidates":[],"summary_candidates":[],"skip_reasons":[],
                        "audit":{"model":"owned-aux-model","generated_at_epoch":int(time.time()*1000),"privacy_notes":[]}})
                        if kind=="observer" else "<session_memory>"+"\n\n".join(
                            "# "+title+"\n\nOwned verification ran successfully."
                            for title in ["Session Title","Current State","Task specification","Files and Functions",
                                "Workflow","Errors & Corrections","Codebase and System Documentation","Learnings","Key results","Worklog"])+"</session_memory>")
                    delta={"content":text};finish="stop"
                elif any(m["role"]=="tool" for m in body["messages"]):
                    delta={"content":"OWNED_AUXILIARY_MAIN_COMPLETE"};finish="stop"
                else:
                    arguments={"status":"complete"} if kind=="verifier" else {"command":"npm test","timeout":10000}
                    delta={"tool_calls":[{"index":0,"id":"owned-verification","type":"function",
                        "function":{"name":"update_goal" if kind=="verifier" else "bash","arguments":json.dumps(arguments)}}]};finish="tool_calls"
                events=[{"choices":[{"index":0,"delta":delta,"finish_reason":None}]},
                    {"choices":[{"index":0,"delta":{},"finish_reason":finish}],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}]
                raw=("".join("data: "+json.dumps(e)+"\n\n" for e in events)+"data: [DONE]\n\n").encode()
                self.send_response(200);self.send_header("Content-Type","text/event-stream");self.send_header("Content-Length",str(len(raw)));self.end_headers();self.wfile.write(raw)
        server=ThreadingHTTPServer(("127.0.0.1",0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);started=False
        try:
            with Fixture(self,with_seed=False) as fixture:
                fixture.resources.callback(auxiliary_release.set)
                binding,member=fixture.bindings["reader"],fixture.identities["reader"]
                home=Path(binding["home"]);workspace=home/"workspace";profile=home/".config/kcoder"
                # The fixture's verification is an actual zero-dependency Node
                # test. It is not a forged successful tool output.
                (workspace/"package.json").write_text(json.dumps({"scripts":{"test":"node --test owned-verification.test.mjs"}}))
                (workspace/"owned-verification.test.mjs").write_text("import test from 'node:test'; import assert from 'node:assert/strict'; test('owned arithmetic',()=>assert.equal(6*7,42));\n")
                for file in [workspace/"package.json",workspace/"owned-verification.test.mjs"]:os.chown(file,binding["uid"],binding["gid"])
                origin="http://127.0.0.1:"+str(server.server_port)
                settings={"active_provider":"fixture","model":"owned-aux-model","permission_mode":"bypass","max_tokens":8192,"max_retries":0,
                    "providers":{"fixture":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":origin+"/v1",
                        "default_model":"owned-aux-model","context_window_tokens":128000,"max_output_tokens":8192,"output_headroom_tokens":8192,"discover_models":False,"no_proxy":True}},
                    "auto_memory_enabled":kind=="observer","auto_tool_memory_enabled":kind=="observer",
                    "memory":{"observer_mode":"model" if kind=="observer" else "disabled","structured_enabled":True,"legacy_prompt_enabled":False},
                    "summary_max_tokens":512,
                    "session_memory":{"enabled":kind=="summary","init_min_tokens":1,"update_min_token_delta":1,"update_max_tokens":512}}
                if kind=="moa":
                    slot={"profile":"fixture","provider":"fixture","model":"owned-aux-model"}
                    settings["moa"]={"enabled":True,"default_preset":"owned","max_reference_workers":2,"presets":{"owned":{
                        "enabled":True,"reference_models":[slot,slot],"aggregator":slot,"reference_max_tokens":64,"aggregator_max_tokens":64}}}
                (profile/"settings.json").write_text(json.dumps(settings))
                def channel_factory(accounts,identity,runtime,actual):
                    return OrganizationChannel(accounts,identity,runtime=runtime,
                        workspace_resource=WorkspaceBudgetBinding(actual,identity,Path(actual["home"])/"workspace"))
                session=fixture.session("reader",channel_factory=channel_factory)
                model=model_resource_id("fixture","owned-aux-model",origin,session.scope["targetRevision"])
                for resource,resource_kind in [(session.scope["workspaceId"],"workspace"),(model,"model")]:
                    fixture.policy.administer(None,{"operation":"organization.resource","expectedRevision":fixture.policy._load()["revision"],
                        "resource":{"id":resource,"kind":resource_kind,"owner":member["id"],"visibility":"private","grants":[]}})
                fixture.resource("administrator",session.owner,"memory","current-target",readers=("reader",),actions=("read","write","use"))
                start=int(time.time()//3600)*3600000
                fixture.policy.administer(None,{"operation":"organization.executionPolicy","expectedRevision":fixture.policy._load()["revision"],
                    "executionPolicy":{"version":1,"modelRules":[{"id":"owned-aux-route","members":[member["id"]],"workspaceResourceIds":[session.scope["workspaceId"]],
                        "provider":"fixture","model":"owned-aux-model","endpointOrigin":origin,"configurationRevision":session.scope["targetRevision"],"enabled":True}],
                        "budgetPolicies":[{"id":"one-aux-root","scope":{"kind":"organization","id":fixture.organization},
                            "window":{"id":"owned-hour","startsAtMs":start,"endsAtMs":start+3600000},"limits":{"tokens":1000000,"modelCalls":model_calls,"concurrentTasks":1},"currency":None}]}})
                initialize(fixture.accounts,fixture.programs[0]);thread.start();started=True
                current=session.rpc("thread/start",{})["thread"]["id"]
                if kind=="verifier":
                    goal=session.rpc("thread/goal/set",{"threadId":current,"objective":"State the product of 6 and 7.","mode":"strict","verificationKind":"answer"})["goal"]
                    goal_id=goal["goalId"]
                    self.assertRegex(goal_id,r"^[A-Za-z0-9_-]+$")
                    directory=workspace/".kcoder"/"goal-reports";directory.mkdir(parents=True,mode=0o700,exist_ok=True)
                    for p in [directory.parent,directory]:p.chmod(0o700);os.chown(p,binding["uid"],binding["gid"])
                    report=directory/(goal_id+".md");report.write_text("# Controlled answer\n\n6 * 7 = 42.\n")
                    report.chmod(0o600);os.chown(report,binding["uid"],binding["gid"])
                turn_params={"threadId":current,"input":[{"type":"text","text":"Run the owned bounded verification once, then finish."}]}
                if kind=="moa":turn_params["turnMode"]="moa"
                turn=session.rpc("turn/start",turn_params)["turn"]["id"]
                done=session.wait(lambda m:m.get("method")=="turn/completed" and m.get("params",{}).get("turnId")==turn,seconds=30)
                self.assertEqual(done["params"]["turn"]["status"],"failed" if expect_denied else "completed",done)
                if kind=="verifier":session.rpc("thread/goal/clear",{"threadId":current})
                if expect_denied:
                    self.assertFalse(observer_seen.is_set())
                    deadline=time.monotonic()+3
                    while True:
                        rows=[v["receipt"] for v in json.loads((fixture.accounts.root/"organization-budget/ledger.json").read_text())["reservations"].values()]
                        if all(r["executionConfirmedTerminal"] for r in rows):break
                        self.assertLess(time.monotonic(),deadline,"Original denied task slot remains unsettled")
                        time.sleep(.01)
                    calls=[r for r in rows if r["unit"]=="model_call"]
                    self.assertEqual(len(requests),1);self.assertEqual(len(calls),1)
                    self.assertEqual(calls[0]["task"]["actor"],"main")
                    self.assertEqual(calls[0]["charged"]["tokens"],10)
                    self.assertEqual(sum(r["unit"]=="task_slot" for r in rows),1)
                    self.assertEqual(report.read_text(),"# Controlled answer\n\n6 * 7 = 42.\n")
                    session.rpc("thread/list",{})
                    print(json.dumps({"actualAuxiliaryBudgetDenied":{"kind":kind,"uid":binding["uid"],"mainProviderCalls":1,
                        "verifierProviderCalls":0,"rootSlots":1,"retainedMainTokens":10,"originalReportPreserved":True,"nativeStillResponsive":True,"paidCalls":0}}))
                    return
                if not observer_seen.wait(3):errors.append("Automatic observer did not reach Provider after the original main admission released")
                if kind=="summary" and not errors:
                    held=[v["receipt"] for v in json.loads((fixture.accounts.root/"organization-budget/ledger.json").read_text())["reservations"].values()]
                    slots=[r for r in held if r["unit"]=="task_slot"]
                    auxiliary=[r for r in held if r["unit"]=="model_call" and r["task"]["actor"]=="observer"]
                    self.assertEqual(len(slots),1);self.assertEqual(len(auxiliary),1)
                    self.assertFalse(slots[0]["executionConfirmedTerminal"])
                    self.assertFalse(auxiliary[0]["executionConfirmedTerminal"])
                    self.assertTrue(all(r["executionConfirmedTerminal"] for r in held if r["unit"]=="model_call" and r["task"]["actor"]=="main"))
                    auxiliary_release.set()
                if not errors:
                    deadline=time.monotonic()+3
                    while True:
                        rows=[v["receipt"] for v in json.loads((fixture.accounts.root/"organization-budget/ledger.json").read_text())["reservations"].values()]
                        auxiliary=[r for r in rows if r["unit"]=="model_call" and r["task"]["actor"]==("verifier" if kind=="verifier" else "observer")]
                        slots=[r for r in rows if r["unit"]=="task_slot"]
                        if len(auxiliary)==(3 if kind=="moa" else 1) and all(r["executionConfirmedTerminal"] for r in auxiliary) and len(slots)==1 and slots[0]["executionConfirmedTerminal"]:break
                        if time.monotonic()>=deadline:
                            errors.append("Original auxiliary receipt and root slot did not both settle")
                            break
                        time.sleep(.01)
                if errors:
                    rows=[v["receipt"] for v in json.loads((fixture.accounts.root/"organization-budget/ledger.json").read_text())["reservations"].values()]
                    observer_files=[]
                    for file in profile.rglob('*observer*.json*'):
                        if file.is_file():
                            events=[]
                            for line in file.read_text().splitlines():
                                try:
                                    event=json.loads(line);details=event.get("details",{})
                                    events.append({"event":event.get("event_type"),"phase":details.get("phase"),
                                        "reasonCode":details.get("reason_code"),"kind":details.get("kind"),
                                        "failureCode":(details.get("failure") or {}).get("errorCode"),
                                        "failureCategory":(details.get("failure") or {}).get("category"),
                                        "nativeFailure":next((code for code in ["native_model_budget_denied","native_model_budget_unavailable","native_model_budget_deadline"]
                                            if code in str(details.get("reason",""))),None)})
                                except ValueError:pass
                            observer_files.append({"name":file.name,"bytes":file.stat().st_size,"events":events})
                    print(json.dumps({"auxiliaryDiagnostic":{"providerCalls":len(requests),
                        "toolResults":[{"error":m.get("is_error",False),"bytes":len(json.dumps(m.get("content",''))),
                            "nativeCodes":re.findall(r'\b(?:NATIVE|ORGANIZATION)_[A-Z0-9_]+\b',json.dumps(m.get("content",'')))[:8]}
                            for r in requests for m in r.get("messages",[]) if m.get("role")=="tool"],
                        "receipts":[{"unit":r["unit"],"actor":r["task"]["actor"],"terminal":r["executionConfirmedTerminal"]} for r in rows],
                        "observerFiles":observer_files,"stderrBytes":session.error_path.stat().st_size,
                        "admissionReasons":re.findall(r'reason_code(?:\x1b\[[0-9;]*m)*[=:\s]+(?:\x1b\[[0-9;]*m)*"?([a-z_]+)',
                            session.error_path.read_text())}}))
                self.assertEqual(errors,[])
                self.assertTrue(observer_seen.is_set())
                rows=[v["receipt"] for v in json.loads((fixture.accounts.root/"organization-budget/ledger.json").read_text())["reservations"].values()]
                auxiliary=[r for r in rows if r["unit"]=="model_call" and r["task"]["actor"]==("verifier" if kind=="verifier" else "observer")]
                slots=[r for r in rows if r["unit"]=="task_slot"]
                self.assertEqual(len(auxiliary),3 if kind=="moa" else 1);self.assertEqual(len(slots),1)
                for row in auxiliary:
                    self.assertEqual(row["task"]["parentReservationId"],slots[0]["reservationId"])
                    self.assertEqual(row["charged"]["tokens"],10)
                    self.assertTrue(row["executionConfirmedTerminal"])
                if kind=="summary":
                    summaries=[p for p in home.rglob("summary.md") if p.parent.name=="session-memory"]
                    self.assertEqual(len(summaries),1)
                    self.assertIn("Owned verification ran successfully.",summaries[0].read_text())
                print(json.dumps({"actualAuxiliaryBudget":{"kind":kind,"uid":binding["uid"],"auxiliaryCalls":len(auxiliary),"rootSlots":1,
                    "tokens":sum(row["charged"]["tokens"] for row in auxiliary),"providerCalls":len(requests),
                    "rootSlotHeldAfterForeground":kind=="summary","paidCalls":0}}))
        finally:
            if started:server.shutdown()
            server.server_close()
            if started:thread.join(timeout=3);self.assertFalse(thread.is_alive())


if __name__=="__main__":unittest.main()

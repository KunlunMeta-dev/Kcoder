"""Real governed durable Wiki jobs recheck resource grants independently of login."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import multiprocessing
import os
from pathlib import Path
import signal
import sqlite3
import threading
import time
import unittest
from unittest.mock import patch
import organization_publication_fixture as publication_fixture

from organization_publication_fixture import Fixture
from studio_account_knowledge import supervise_knowledge
from studio_organization_budget import initialize
from studio_organization_execution import model_resource_id
from studio_organization_workspace import WorkspaceBudgetBinding
from studio_organization_channel import OrganizationChannel
from organization_wiki_worker_diagnostics import private_worker_diagnostics


def wait_for(check, seconds, message):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        value=check()
        if value:return value
        time.sleep(.05)
    raise AssertionError(message)


@unittest.skipUnless(os.geteuid()==0 and os.environ.get("KCODER_TEST_SYSTEM_USERS")=="1"
    and os.environ.get("KCODER_ORGANIZATION_APP_SERVER") and os.environ.get("KCODER_ORGANIZATION_LEGACY_FIXTURE"),
    "Explicit actual restricted UID, Native worker and synthetic Wiki seed required")
class OrganizationWikiWorkerTests(unittest.TestCase):
    def test_actual_owned_job_stops_on_resource_write_revocation_while_login_and_peer_remain_current(self):
        self.run_actual("revoke")

    def test_actual_owned_job_budget_denial_prevents_provider_dispatch(self):
        self.run_actual("budget_denied")

    def run_actual(self, mode):
        seen,stop=threading.Event(),threading.Event()
        requests=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*_):pass
            def do_POST(self):
                size=int(self.headers["Content-Length"])
                if size>1024*1024:raise AssertionError("Owned Wiki request ceiling")
                body=json.loads(self.rfile.read(size));requests.append(body)
                self.send_response(200);self.send_header("Content-Type","text/event-stream");self.end_headers()
                seen.set()
                stop.wait(15)
                try:self.wfile.write(b"data: [DONE]\n\n")
                except (BrokenPipeError,ConnectionResetError):pass

        server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);started=False
        monitor=None
        try:
            with Fixture(self) as fixture:
                binding,identity=fixture.bindings["reader"],fixture.identities["reader"]
                profile=Path(binding["home"])/".config/kcoder"
                origin="http://127.0.0.1:"+str(server.server_port)
                settings={"active_provider":"fixture","model":"owned-wiki-worker","max_tokens":8192,"max_retries":0,
                    "providers":{"fixture":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},
                        "endpoint":origin+"/v1","default_model":"owned-wiki-worker","context_window_tokens":128000,
                        "max_output_tokens":8192,"output_headroom_tokens":8192,"discover_models":False,"no_proxy":True}},
                    "knowledge":{"enabled":True,"retrieval_enabled":True,"organization_enabled":True},
                    "memory":{"observer_mode":"disabled","structured_enabled":False,"legacy_prompt_enabled":False},
                    "session_memory":{"enabled":False}}
                (profile/"settings.json").write_text(json.dumps(settings))
                source=fixture.seed("reader")
                def channel_factory(accounts,principal,runtime,actual):
                    return OrganizationChannel(accounts,principal,runtime=runtime,
                        workspace_resource=WorkspaceBudgetBinding(actual,principal,Path(actual["home"])/"workspace"))
                monitor=multiprocessing.get_context("fork").Process(target=supervise_knowledge,
                    args=(fixture.accounts,identity,binding,fixture.programs[0],.05))
                with private_worker_diagnostics():
                    monitor.start()
                original_drop=publication_fixture.drop_to_worker
                def managed_launch(actual,principal):
                    environment=original_drop(actual,principal)
                    # This real root-owned supervisor was started above. This
                    # matches the shipped account entry's worker-management flag.
                    environment["KCODER_WIKI_WORKER_MANAGED"]="1"
                    return environment
                with patch.object(publication_fixture,"drop_to_worker",managed_launch),private_worker_diagnostics():
                    session=fixture.session("reader",channel_factory=channel_factory)
                peer=fixture.session("publisher")
                fixture.resource("administrator",session.owner,"knowledge","current-target",readers=("reader",),actions=("read","write","use"))
                model=model_resource_id("fixture","owned-wiki-worker",origin,session.scope["targetRevision"])
                for resource_id,kind in [(session.scope["workspaceId"],"workspace"),(model,"model")]:
                    fixture.policy.administer(None,{"operation":"organization.resource","expectedRevision":fixture.policy._load()["revision"],
                        "resource":{"id":resource_id,"kind":kind,"owner":identity["id"],"visibility":"private","grants":[]}})
                hour=int(time.time()//3600)*3600000
                fixture.policy.administer(None,{"operation":"organization.executionPolicy","expectedRevision":fixture.policy._load()["revision"],
                    "executionPolicy":{"version":1,"modelRules":[{"id":"owned-wiki-worker-model","members":[identity["id"]],
                        "workspaceResourceIds":[session.scope["workspaceId"]],"provider":"fixture","model":"owned-wiki-worker",
                        "endpointOrigin":origin,"configurationRevision":session.scope["targetRevision"],"enabled":True}],
                        "budgetPolicies":[{"id":"owned-wiki-worker-budget","scope":{"kind":"organization","id":fixture.organization},
                            "window":{"id":"owned-hour","startsAtMs":hour,"endsAtMs":hour+3600000},
                            "limits":{"tokens":1 if mode=="budget_denied" else 1000000,"modelCalls":4,"concurrentTasks":2},"currency":None}]}})
                initialize(fixture.accounts,fixture.programs[0])
                library=source["source"]["libraryId"]
                original=session.rpc("knowledge/source/list",{"libraryId":library,"limit":10})["items"][0]
                job=session.rpc("knowledge/job/start",{"libraryId":library,"idempotencyKey":"owned-active-worker",
                    "sourceId":original["sourceId"],"revisionId":original["revisionId"],"language":"en"})
                # Use the shipped supervisor and normal Native worker as their
                # actual UID. Start the HTTP thread only after every fork.
                thread.start();started=True

                def read_job():
                    response=session.rpc("knowledge/job/get",{"libraryId":library,"jobId":job["id"]},raw_response=True)
                    if response.get("error",{}).get("message") in {
                            "knowledge_catalog_source_busy","source_sqlite_recovery_required"}:
                        # An active owned SQLite writer can invalidate a source
                        # snapshot mid-observation. Retry only this readonly
                        # observation within the unchanged deadline; no repair,
                        # mutation or successful read is inferred from the error.
                        self.assertTrue(monitor.is_alive())
                        self.assertTrue(fixture.accounts.session_current(identity))
                        return None
                    self.assertNotIn("error",response,response)
                    return response["result"]

                # A frozen Wiki request has its own actual configuration
                # identity. The main conversation's exact grant cannot stand
                # in for it. First prove denial, then explicitly authorize the
                # host-reported immutable snapshot and resume the same job.
                denied=wait_for(lambda: (current if (current:=read_job()) is not None
                    and current["status"] in ("failed","paused") else None),12,
                    "The ungranted frozen Wiki model must stop the original job")
                self.assertEqual(requests,[])
                self.assertEqual(json.loads((fixture.accounts.root/"organization-budget/ledger.json").read_text())["reservations"],{})
                actual_model=(denied.get("progress") or {}).get("modelConfiguration")
                self.assertIsInstance(actual_model,dict)
                revision=actual_model["revision"]
                self.assertNotEqual(revision,session.scope["targetRevision"])
                resource=model_resource_id("fixture","owned-wiki-worker",origin,revision)
                fixture.policy.administer(None,{"operation":"organization.resource","expectedRevision":fixture.policy._load()["revision"],
                    "resource":{"id":resource,"kind":"model","owner":identity["id"],"visibility":"private","grants":[]}})
                execution=fixture.policy._load()["executionPolicy"]
                execution["modelRules"].append({"id":"owned-frozen-wiki-model","members":[identity["id"]],
                    "workspaceResourceIds":[session.scope["workspaceId"]],"provider":"fixture","model":"owned-wiki-worker",
                    "endpointOrigin":origin,"configurationRevision":revision,"enabled":True})
                fixture.policy.administer(None,{"operation":"organization.executionPolicy","expectedRevision":fixture.policy._load()["revision"],
                    "executionPolicy":execution})
                resumed=session.rpc("knowledge/job/resume",{"libraryId":library,"jobId":job["id"]})
                self.assertEqual(resumed["id"],job["id"])
                if mode=="budget_denied":
                    def denied_and_settled():
                        current=read_job()
                        if current is None or current["status"] not in ("paused","failed","cancelled"):
                            return None
                        rows=list(json.loads((fixture.accounts.root/"organization-budget/ledger.json").read_text())["reservations"].values())
                        # Job state and the root budget receipt are independent
                        # commits. Require both original terminals; observing
                        # the first one cannot imply the second one completed.
                        if len(rows)!=1 or not rows[0]["receipt"]["executionConfirmedTerminal"]:
                            return None
                        return current
                    try:
                        final=wait_for(denied_and_settled,
                            12,"Original Wiki budget denial must settle the same job before Provider dispatch")
                    except AssertionError:
                        current=read_job()
                        rows=list(json.loads((fixture.accounts.root/"organization-budget/ledger.json").read_text())["reservations"].values())
                        diagnostic=profile/"knowledge/worker-diagnostic.json"
                        print(json.dumps({"budgetTerminalFailure":{"jobStatus":current.get("status") if current else None,
                            "jobError":current.get("errorCode") if current else None,
                            "authority":json.loads(diagnostic.read_text()) if diagnostic.exists() else None,
                            "reservations":[{"unit":row["receipt"]["unit"],"phase":row["receipt"]["phase"],
                                "terminal":row["receipt"]["executionConfirmedTerminal"]} for row in rows]}}))
                        raise
                    self.assertFalse(seen.is_set());self.assertEqual(requests,[])
                    records=list(json.loads((fixture.accounts.root/"organization-budget/ledger.json").read_text())["reservations"].values())
                    print(json.dumps({"budgetDenialDiagnostic":{"status":final["status"],"errorCode":final.get("errorCode"),
                        "units":[row["receipt"]["unit"] for row in records],
                        "authority":json.loads((profile/"knowledge/worker-diagnostic.json").read_text())
                            if (profile/"knowledge/worker-diagnostic.json").exists() else None}}))
                    self.assertEqual(len(records),1)
                    slot=records[0]["receipt"]
                    self.assertEqual(slot["unit"],"task_slot")
                    self.assertEqual(slot["task"]["rootTask"]["kind"],"task")
                    self.assertEqual(slot["task"]["rootTask"]["id"],job["id"])
                    self.assertIsNone(slot["task"]["rootTask"].get("revision"))
                    self.assertTrue(slot["executionConfirmedTerminal"])
                    self.assertTrue(fixture.accounts.session_current(identity))
                    peer.rpc("integrations/scope/read",{})
                    print(json.dumps({"actualWikiBudgetDenial":{"actualUid":binding["uid"],"providerPosts":0,
                        "originalJobTerminal":final["status"],"originalSlotTerminal":True,"paidCalls":0}}))
                    fixture.accounts.revoke_sessions("reader")
                    monitor.join(timeout=8);self.assertFalse(monitor.is_alive());monitor=None
                    return
                try:
                    wait_for(seen.is_set,12,"Actual owned Native Wiki worker did not reach the controlled Provider")
                except AssertionError:
                    if os.environ.get("KCODER_ORGANIZATION_WIKI_DIAGNOSTIC_DIR"):
                        # Diagnostics only: this bypasses the product read RPC
                        # and cannot establish a successful authorized read.
                        with sqlite3.connect((profile/"knowledge/state.sqlite").as_uri()+"?mode=ro",uri=True,timeout=.25) as diagnostic:
                            rows=diagnostic.execute("SELECT status,error_code,error_detail FROM knowledge_jobs WHERE library_id=? AND job_id=?",(library,job["id"])).fetchall()
                        ledger=fixture.accounts.root/"organization-budget/ledger.json"
                        receipts=[value["receipt"] for value in json.loads(ledger.read_text())["reservations"].values()]
                        print(json.dumps({"fixtureDiagnosticOnly":{"jobState":rows,"expectedModelRevision":session.scope["targetRevision"],"budgetUnits":[{
                            "unit":value["unit"],"phase":value["phase"],"coverage":value["coverage"]} for value in receipts],
                            "rootJobTickets":len(list((fixture.accounts.root/"organization-wiki-jobs").glob("*.json")))}}))
                    raise
                children=Path(f"/proc/{monitor.pid}/task/{monitor.pid}/children").read_text().split()
                self.assertEqual(len(children),1)
                native_pid=int(children[0])
                status=Path(f"/proc/{native_pid}/status").read_text()
                self.assertIn(f"Uid:\t{binding['uid']}\t{binding['uid']}\t{binding['uid']}\t{binding['uid']}",status)
                fixture.resource("administrator",session.owner,"knowledge","current-target",readers=("reader",),actions=("read",))
                self.assertTrue(fixture.accounts.session_current(identity),"This is resource revocation, not account/logout revocation")
                observed=[]
                deadline=time.monotonic()+3
                while time.monotonic()<deadline:
                    current=read_job()
                    if current is None:
                        time.sleep(.1)
                        continue
                    observed.append(current["status"])
                    if current["status"] in ("paused","failed","cancelled"):break
                    time.sleep(.1)
                peer.rpc("integrations/scope/read",{})
                print(json.dumps({"actualWikiResourceRevoke":{"actualUid":binding["uid"],"providerPosts":len(requests),
                    "accountStillCurrent":True,"peerStillResponsive":True,"originalJobId":job["id"],
                    "observedStatuses":observed,"paidCalls":0}}))
                self.assertIn(observed[-1],("paused","failed","cancelled"),
                    "Resource write revocation must stop the original active job; login revision alone is insufficient")
                self.assertEqual(len(requests),1,"A revoked job must not create a second Provider request")
                records=list(json.loads((fixture.accounts.root/"organization-budget/ledger.json").read_text())["reservations"].values())
                calls=[row for row in records if row["receipt"]["unit"]=="model_call"]
                slots=[row for row in records if row["receipt"]["unit"]=="task_slot"]
                self.assertEqual(len(calls),1);self.assertEqual(len(slots),1)
                call,slot=calls[0]["receipt"],slots[0]["receipt"]
                self.assertEqual(call["task"]["rootTask"]["kind"],"task")
                self.assertEqual(call["task"]["rootTask"]["id"],job["id"])
                self.assertIsNone(call["task"]["rootTask"].get("revision"))
                self.assertEqual(call["task"]["parentReservationId"],slot["reservationId"])
                self.assertEqual(call["task"]["rootOperationId"],slot["task"]["rootOperationId"])
                self.assertEqual(call["task"]["actor"],"observer")
                self.assertFalse(call["executionConfirmedTerminal"])
                self.assertFalse(slot["executionConfirmedTerminal"])
                self.assertGreater(call["estimate"]["tokens"],0)
                self.assertGreaterEqual(call["charged"]["tokens"],call["estimate"]["tokens"])
                self.assertIsNone(call["charged"]["costMicros"])
                tickets=list((fixture.accounts.root/"organization-wiki-jobs").glob("*.json"))
                self.assertEqual(len(tickets),1)
                ticket=json.loads(tickets[0].read_text())
                self.assertEqual(ticket["scope"]["workspaceId"],session.scope["workspaceId"])
                self.assertEqual(ticket["job"]["jobId"],job["id"])
                print(json.dumps({"actualWikiBudgetEvidence":{"originalTaskSlots":1,"originalModelCalls":1,
                    "scopeFromOriginalTicket":True,"unknownRetainsReservation":True,"paidCalls":0}}))
                fixture.accounts.revoke_sessions("reader")
                monitor.join(timeout=8);self.assertFalse(monitor.is_alive())
                monitor=None
        finally:
            stop.set()
            if monitor is not None:
                if monitor.is_alive():os.kill(monitor.pid,signal.SIGTERM)
                monitor.join(timeout=8)
                if monitor.is_alive():monitor.kill();monitor.join(timeout=3)
            if started:server.shutdown()
            server.server_close()
            if started:thread.join(timeout=3);self.assertFalse(thread.is_alive())


if __name__=="__main__":unittest.main()

"""Actual restricted-UID image import spends through the original Root ledger; offline model protocol only."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import base64
import json
import multiprocessing
import os
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch

# Continuations may select the already-frozen common fixture library. This is
# test code only, not an alternate production settings/credential loader.
fixture_library = os.environ.get("KCODER_ORGANIZATION_FIXTURE_LIBRARY")
if fixture_library:
    sys.path.insert(0, str(Path(fixture_library).resolve()))
import organization_publication_fixture as publication_fixture
from organization_publication_fixture import Fixture
from studio_account_knowledge import supervise_knowledge
from studio_organization_budget import initialize
from studio_organization_execution import model_resource_id
from studio_organization_workspace import WorkspaceBudgetBinding
from studio_organization_channel import OrganizationChannel

PNG = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg=="

@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1"
    and os.environ.get("KCODER_ORGANIZATION_APP_SERVER"),
    "Explicit owned restricted-UID Native image/budget fixture required")
class OrganizationImageBudget(unittest.TestCase):
    def test_actual_image_budget_denial_prevents_original_provider_dispatch(self):
        self.run_actual("deny")

    def test_actual_image_records_reported_usage_and_original_import_terminal(self):
        self.run_actual("complete")

    def test_actual_image_missing_final_usage_keeps_original_call_unknown(self):
        self.run_actual("incomplete")

    def test_actual_image_dropped_provider_keeps_original_unknown_and_does_not_resend(self):
        self.run_actual("drop")

    def test_actual_image_cancel_preserves_original_unknown_charge_and_stops_provider(self):
        self.run_actual("cancel")

    def test_actual_image_resource_write_revocation_stops_original_call_with_login_current(self):
        self.run_actual("revoke")

    def run_actual(self, mode):
        requests = []
        entered, release = threading.Event(), threading.Event()
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                count = int(self.headers["Content-Length"])
                if count > 1024 * 1024:
                    raise AssertionError("Owned image request size exceeded")
                body = json.loads(self.rfile.read(count))
                requests.append(body)
                entered.set()
                if mode in ("cancel", "revoke"):
                    release.wait(15)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                chunks = [{"id":"owned-image", "object":"chat.completion.chunk", "model":"owned-image-model",
                    "choices":[{"index":0,"delta":{"role":"assistant","content":"A controlled image interpretation. Verify the source image."},"finish_reason":None}],
                    "usage":{"prompt_tokens":17,"completion_tokens":9,"total_tokens":26}}]
                if mode != "complete":
                    chunks[0].pop("usage")
                if mode == "complete":
                    chunks.append({"id":"owned-image", "object":"chat.completion.chunk", "model":"owned-image-model",
                        "choices":[{"index":0,"delta":{},"finish_reason":"stop"}],
                        "usage":{"prompt_tokens":17,"completion_tokens":9,"total_tokens":26}})
                elif mode != "drop":
                    chunks.append({"id":"owned-image", "object":"chat.completion.chunk", "model":"owned-image-model",
                        "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})
                try:
                    for chunk in chunks:
                        self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                    if mode != "drop": self.wfile.write(b"data: [DONE]\n\n")
                except (BrokenPipeError, ConnectionResetError):
                    pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        started = False
        monitor = None
        try:
            with Fixture(self, with_seed=False) as fixture:
                binding, identity = fixture.bindings["reader"], fixture.identities["reader"]
                profile = Path(binding["home"]) / ".config/kcoder"
                origin = "http://127.0.0.1:" + str(server.server_port)
                settings = {"active_provider":"fixture", "model":"owned-image-model", "max_tokens":8192,"max_retries":0,
                    "providers":{"fixture":{"api_format":"openai_chat_completions", "authentication":{"mode":"none"},
                        "endpoint":origin+"/v1", "default_model":"owned-image-model", "context_window_tokens":128000,
                        "max_output_tokens":8192, "output_headroom_tokens":8192, "discover_models":False, "no_proxy":True,
                        "capabilities":{"text":True,"tools":True,"vision":True,"reasoning":False,"structured_output":False}}},
                    "knowledge":{"enabled":True,"retrieval_enabled":True,"organization_enabled":True},
                    "memory":{"observer_mode":"disabled","structured_enabled":False,"legacy_prompt_enabled":False},
                    "session_memory":{"enabled":False}}
                (profile / "settings.json").write_text(json.dumps(settings))
                def channel_factory(accounts, principal, runtime, actual):
                    return OrganizationChannel(accounts, principal, runtime=runtime,
                        workspace_resource=WorkspaceBudgetBinding(actual, principal, Path(actual["home"])/"workspace"))
                # This is the shipped real supervisor with zero fabricated jobs.
                monitor = multiprocessing.get_context("fork").Process(target=supervise_knowledge,
                    args=(fixture.accounts, identity, binding, fixture.programs[0], .05))
                monitor.start()
                original_drop = publication_fixture.drop_to_worker
                def managed_launch(actual, principal):
                    environment = original_drop(actual, principal)
                    environment["KCODER_WIKI_WORKER_MANAGED"] = "1"
                    return environment
                with patch.object(publication_fixture, "drop_to_worker", managed_launch):
                    session = fixture.session("reader", channel_factory=channel_factory)
                peer = fixture.session("publisher")
                with patch.object(publication_fixture, "drop_to_worker", managed_launch):
                    control = fixture.session("reader", channel_factory=channel_factory) if mode in ("cancel", "revoke") else None
                fixture.resource("administrator", session.owner, "knowledge", "current-target", readers=("reader",), actions=("read","write","use"))
                model = model_resource_id("fixture","owned-image-model", origin, session.scope["targetRevision"])
                for resource, kind in [(session.scope["workspaceId"],"workspace"),(model,"model")]:
                    fixture.policy.administer(None,{"operation":"organization.resource","expectedRevision":fixture.policy._load()["revision"],
                        "resource":{"id":resource,"kind":kind,"owner":identity["id"],"visibility":"private","grants":[]}})
                hour = int(time.time() // 3600) * 3600000
                fixture.policy.administer(None,{"operation":"organization.executionPolicy","expectedRevision":fixture.policy._load()["revision"],
                    "executionPolicy":{"version":1,"modelRules":[{"id":"owned-image-model-rule","members":[identity["id"]],
                        "workspaceResourceIds":[session.scope["workspaceId"]],"provider":"fixture","model":"owned-image-model",
                        "endpointOrigin":origin,"configurationRevision":session.scope["targetRevision"],"enabled":True}],
                        "budgetPolicies":[{"id":"owned-image-shared-budget","scope":{"kind":"organization","id":fixture.organization},
                            "window":{"id":"owned-hour","startsAtMs":hour,"endsAtMs":hour+3600000},
                            "limits":{"tokens":1 if mode=="deny" else 1000000,"modelCalls":4,"concurrentTasks":2},"currency":None}]}})
                initialize(fixture.accounts, fixture.programs[0])
                library = session.rpc("knowledge/create",{"idempotencyKey":"original-image-library","name":"Images"})["id"]
                uploaded = session.rpc("attachment/save",{"filename":"image.png","content_base64":PNG})
                thread.start();started = True
                parameters={"libraryId":library,"idempotencyKey":"original-image-import","title":"image.png","attachmentPath":uploaded["path"]}
                if mode in ("cancel", "revoke"):
                    outcome=[]
                    def run_import():
                        try:outcome.append(session.rpc("knowledge/source/importAttachment",parameters,raw_response=True))
                        except BaseException as error:outcome.append(error)
                    pending=threading.Thread(target=run_import)
                    pending.start()
                    self.assertTrue(entered.wait(10),"Original image Provider was not dispatched")
                    original_id=control.rpc("knowledge/imageImport/list",{"libraryId":library})["items"][0]["id"]
                    if mode=="cancel":
                        control.rpc("knowledge/imageImport/cancel",{"libraryId":library,"importId":original_id,"additionalCallBudget":0})
                    else:
                        fixture.resource("administrator",session.owner,"knowledge","current-target",readers=("reader",),actions=("read","use"))
                    pending.join(timeout=12)
                    release.set()
                    self.assertFalse(pending.is_alive(),"Original image import did not stop after cancellation/revocation")
                    self.assertEqual(len(outcome),1)
                    if isinstance(outcome[0],BaseException):raise outcome[0]
                    result=outcome[0]
                else:
                    result=session.rpc("knowledge/source/importAttachment",parameters,raw_response=True)
                imports = session.rpc("knowledge/imageImport/list",{"libraryId":library})["items"]
                self.assertEqual(len(imports),1)
                original = imports[0]
                rows = [entry["receipt"] for entry in json.loads((fixture.accounts.root/"organization-budget/ledger.json").read_text())["reservations"].values()]
                slots = [row for row in rows if row["unit"]=="task_slot"]
                calls = [row for row in rows if row["unit"]=="model_call"]
                self.assertEqual(len(slots),1, {"result":result,"import":original,"rows":rows})
                self.assertEqual(slots[0]["task"]["rootTask"]["id"],original["id"])
                self.assertEqual(slots[0]["task"]["actor"],"observer")
                if mode == "deny":
                    self.assertIn("error",result)
                    self.assertEqual(requests,[])
                    self.assertEqual(calls,[])
                    self.assertIn(original["status"],["failed","cancelled"])
                    self.assertTrue(slots[0]["executionConfirmedTerminal"])
                elif mode in ("drop", "cancel", "revoke"):
                    self.assertIn("error",result)
                    self.assertIn(original["status"],["failed","cancelled"])
                    self.assertEqual(len(requests),1);self.assertEqual(len(calls),1)
                    self.assertFalse(calls[0]["executionConfirmedTerminal"])
                    self.assertFalse(slots[0]["executionConfirmedTerminal"])
                    self.assertGreater(calls[0]["charged"]["tokens"],0)
                    retried=session.rpc("knowledge/imageImport/resume",{"libraryId":library,"importId":original["id"],"additionalCallBudget":0},raw_response=True)
                    self.assertIn("error",retried)
                    self.assertEqual(len(requests),1,"An unknown original image call must not be replayed")
                else:
                    self.assertNotIn("error",result,result)
                    self.assertEqual(original["status"],"completed")
                    self.assertEqual(len(requests),1)
                    self.assertEqual(len(calls),1)
                    self.assertEqual(calls[0]["task"]["rootOperationId"],slots[0]["task"]["rootOperationId"])
                    self.assertEqual(calls[0]["knownUsage"]["modelCalls"],1)
                    if mode == "complete":
                        self.assertEqual(calls[0]["knownUsage"]["tokens"],26)
                        self.assertTrue(calls[0]["executionConfirmedTerminal"])
                        self.assertTrue(slots[0]["executionConfirmedTerminal"])
                    else:
                        self.assertNotEqual(calls[0]["coverage"],"complete")
                        self.assertGreater(calls[0]["charged"]["tokens"],0)
                        self.assertTrue(calls[0]["executionConfirmedTerminal"])
                        self.assertEqual(calls[0]["charged"]["tokens"],calls[0]["estimate"]["tokens"])
                self.assertEqual(session.rpc("knowledge/job/list",{"libraryId":library})["items"],[])
                self.assertTrue(fixture.accounts.session_current(identity))
                peer.rpc("integrations/scope/read",{})
                print(json.dumps({"actualImageBudget":{"mode":mode,"uid":binding["uid"],"providerPosts":len(requests),
                    "originalImageStatus":original["status"],"taskSlots":len(slots),"calls":len(calls),"paidCalls":0}}))
                fixture.accounts.revoke_sessions("reader")
                monitor.join(timeout=8)
                self.assertFalse(monitor.is_alive());monitor=None
        finally:
            release.set()
            if started:server.shutdown();thread.join(timeout=3)
            server.server_close()
            if monitor is not None:
                monitor.join(timeout=5)
                if monitor.is_alive():monitor.terminate();monitor.join(timeout=3)

if __name__ == "__main__":
    unittest.main()

"""Bounded local wire Provider and literal Source receipts, not a real Source ledger."""
import hashlib
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class LocalProviderScenario:
    def __init__(self, profile, checkpoint, max_calls=1, allowed_tools=()):
        self.profile = profile
        self.checkpoint = checkpoint
        self.accepted = None
        self.calls = {}
        self.seen = set()
        self.requests = 0
        self.control_invocations = 0
        self.failure = None
        self.provider_proofs = []
        self.text = "OWNED_LOCAL_PROVIDER_COMPLETED"
        self.received_text = ""
        self.header = None
        self.prompt_sha = None
        self.model = "native-config-only"
        self.max_calls = max_calls
        self.allowed_tools = set(allowed_tools)
        scenario = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _format, *args):
                pass

            def do_POST(self):
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= 2 * 1024 * 1024:
                        raise RuntimeError("LOCAL_PROVIDER_BODY_LIMIT")
                    body = json.loads(self.rfile.read(length))
                    scenario.before_provider(body)
                    chunks = scenario.response_chunks(body)
                    payload = ("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    self.wfile.flush()
                except Exception as error:
                    message = str(error)
                    scenario.failure = message if re.fullmatch(r"[A-Z][A-Z0-9_]{1,119}", message) else type(error).__name__
                    scenario.checkpoint("local_provider_fixture_rejected", closedDiagnostic=scenario.failure,
                                        requestNumber=scenario.requests)
                    self.send_error(503, "OWNED_LOCAL_PROVIDER_VALIDATION_FAILED")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def endpoint(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def bind(self, original):
        self.header = {key: original[key] for key in ("version", "operationId", "endpointRevision", "endpointInstanceId", "sourceAcceptedSha256")}
        self.prompt_sha = original["message"]["params"]["frozenInputSha256"]

    def response_chunks(self, _body):
        return [
            {"id": "owned-native-response", "object": "chat.completion.chunk", "choices": [
                {"index": 0, "delta": {"role": "assistant", "content": self.text}, "finish_reason": None}]},
            {"id": "owned-native-response", "object": "chat.completion.chunk", "choices": [
                {"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 7, "completion_tokens": 4, "total_tokens": 11}},
        ]

    def ledger(self):
        candidates = list(self.profile.rglob("ledger.json"))
        journals = []
        for path in candidates:
            data = path.read_bytes()
            if len(data) > 16 * 1024 * 1024:
                raise RuntimeError("NATIVE_LEDGER_LIMIT")
            value = json.loads(data)
            if "reservations" in value:
                journals.append((value, hashlib.sha256(data).hexdigest()))
        if len(journals) != 1:
            raise RuntimeError("ONE_REAL_RECEIVER_LEDGER_REQUIRED")
        return journals[0]

    def receipts(self, call_id):
        value, sha = self.ledger()
        calls = [record["receipt"] for record in value["reservations"].values()
                 if record["receipt"]["unit"] == "model_call" and record["receipt"]["operationId"] == call_id]
        slots = [record["receipt"] for record in value["reservations"].values() if record["receipt"]["unit"] == "task_slot"]
        if len(calls) != 1 or len(slots) != 1:
            raise RuntimeError("ORIGINAL_RECEIVER_SLOT_AND_CALL_REQUIRED")
        call, slot = calls[0], slots[0]
        if call["task"]["parentReservationId"] != slot["reservationId"]:
            raise RuntimeError("RECEIVER_NATIVE_PARENT_LINK_MISMATCH")
        if call["task"]["actor"] != "main" or call["task"]["actorAttemptId"] != call_id:
            raise RuntimeError("RECEIVER_NATIVE_CALL_IDENTITY_MISMATCH")
        if slot["task"]["actorAttemptId"] != self.accepted["identity"]["attemptId"]:
            raise RuntimeError("RECEIVER_NATIVE_ATTEMPT_MISMATCH")
        owner = value["owner"]
        scope = self.accepted["receiverScope"]
        if owner["accountId"] != scope["accountId"] or owner["targetId"] != scope["targetId"]:
            raise RuntimeError("RECEIVER_NATIVE_OWNER_MISMATCH")
        return call, slot, sha

    def control(self, frame):
        self.control_invocations += 1
        control = frame["params"]
        if not isinstance(frame.get("id"), str) or not frame["id"].startswith("native-control-"):
            raise RuntimeError("PRIVATE_CONTROL_TRANSPORT_ID_REQUIRED")
        if self.header != {key: control.get(key) for key in self.header}:
            raise RuntimeError("ORIGINAL_CONTROL_HEADER_CHANGED")
        request_id = control["requestId"]
        if request_id in self.seen or len(self.seen) >= 256:
            raise RuntimeError("ORIGINAL_CONTROL_REPLAY_OR_CAPACITY")
        self.seen.add(request_id)
        method = control["message"]["method"]
        params = control["message"].get("params")
        if method == "receiver_accepted":
            if self.accepted is not None or params["acceptedInputSha256"] != self.prompt_sha or not params.get("receiverScope"):
                raise RuntimeError("ACTUAL_RECEIVER_ACCEPTED_MISMATCH")
            self.accepted = params
            data = {"kind": "receiver", "accepted": params, "outcome": None, "cleanupConfirmed": False}
        elif method == "reserve_model":
            if params["receiverAccepted"] != self.accepted or params["nativeCallId"] in self.calls or len(self.calls) >= self.max_calls:
                raise RuntimeError("RESERVE_ORIGINAL_ACCEPTED_REQUIRED")
            if params["providerId"] != "fixture" or params["modelId"] != self.model or not params["modelConfigurationRevision"]:
                raise RuntimeError("ORIGINAL_RECEIVER_OWN_MODEL_REQUIRED")
            bound = params["conservativeBound"]
            if not 0 < bound["tokens"] <= 100000 or bound["modelCalls"] != 1:
                raise RuntimeError("BOUNDED_RECEIVER_RESERVATION_REQUIRED")
            call = {"receiverAccepted": self.accepted, "nativeCallId": params["nativeCallId"]}
            self.calls[params["nativeCallId"]] = {"call": call, "charged": bound, "dispatched": False, "finished": False}
            data = {"kind": "model_call", **self.calls[params["nativeCallId"]]}
        elif method in ("dispatch_model", "observe_model", "finish_model"):
            call = params["call"] if method == "finish_model" else params
            current = self.calls.get(call["nativeCallId"])
            if current is None or current["call"] != call:
                raise RuntimeError("ORIGINAL_SOURCE_FIXTURE_CALL_REQUIRED")
            if method == "dispatch_model":
                own, slot, sha = self.receipts(call["nativeCallId"])
                if own["phase"] != "dispatched" or slot["phase"] != "dispatched":
                    raise RuntimeError("NATIVE_RECEIVER_LEDGER_DISPATCH_REQUIRED")
                current["dispatched"] = True
                self.checkpoint("native_receiver_budget_dispatched", ledgerSha256=sha, callRevision=own["revision"], slotRevision=slot["revision"])
            elif method == "finish_model":
                if not current["dispatched"]:
                    raise RuntimeError("NATIVE_DISPATCH_BEFORE_SETTLEMENT_REQUIRED")
                if params["outcome"] == "completed" and params.get("actualUsage", {}).get("tokens") == 11:
                    current["finished"] = True
                    current["charged"] = params["actualUsage"]
                else:
                    self.checkpoint("native_finish_incomplete_bound_retained", outcome=params["outcome"],
                                    actualUsagePresent=params.get("actualUsage") is not None,
                                    sourceFixtureBoundRetained=True)
            elif not current["dispatched"] or current["finished"]:
                raise RuntimeError("SOURCE_FIXTURE_ACTIVE_CALL_REQUIRED")
            data = {"kind": "model_call", **current}
        else:
            raise RuntimeError("UNEXPECTED_PRIVATE_CONTROL_METHOD")
        self.checkpoint("literal_source_control", method=method, typedRequestId=request_id,
                        sourceReceiptFixtureOnly=True, realSourceLedger=False)
        reply = {key: control[key] for key in ("version", "operationId", "requestId", "endpointRevision", "endpointInstanceId")}
        reply.update({"state": "received", "data": data})
        return {"jsonrpc": "2.0", "id": frame["id"], "result": reply}

    def before_provider(self, body):
        self.requests += 1
        if self.requests > self.max_calls or len(self.calls) != self.requests:
            raise RuntimeError("ONE_ORIGINAL_PROVIDER_CALL_REQUIRED")
        active = [(key, value) for key, value in self.calls.items() if value["dispatched"] and not value["finished"]]
        if len(active) != 1:
            raise RuntimeError("ONE_ACTIVE_ORIGINAL_PROVIDER_CALL_REQUIRED")
        call_id, source = active[0]
        names = {tool["function"]["name"] for tool in body.get("tools", [])}
        if not source["dispatched"] or source["finished"] or not names.issubset(self.allowed_tools) or body.get("model") != self.model:
            raise RuntimeError("PROVIDER_BEFORE_ORIGINAL_DISPATCH_OR_TOOL_CEILING")
        own, slot, sha = self.receipts(call_id)
        if own["phase"] != "dispatched" or own["executionConfirmedTerminal"] or slot["phase"] != "dispatched":
            raise RuntimeError("PROVIDER_BEFORE_REAL_RECEIVER_BUDGET_DISPATCH")
        original_users = [item for item in body["messages"] if item.get("role") == "user"
                          and isinstance(item.get("content"), str)
                          and hashlib.sha256(item["content"].encode()).hexdigest() == self.prompt_sha]
        if len(original_users) != 1:
            raise RuntimeError("PROVIDER_ORIGINAL_INPUT_CHANGED")
        proof = {"ledgerSha256": sha, "receiverCallRevision": own["revision"], "receiverSlotRevision": slot["revision"],
                 "actualRequestSha256": hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest(),
                 "toolsCount": len(names), "exposedTools": sorted(names), "sourceFixtureDispatched": True, "realReceiverLedgerDispatched": True}
        self.provider_proofs.append(proof)
        self.checkpoint("actual_local_provider_request", **proof)

    def update(self, update):
        if update.get("sessionUpdate") == "agent_message_chunk":
            content = update.get("content", {})
            if content.get("type") != "text":
                raise RuntimeError("EXPECTED_TEXT_ONLY_RECEIVER_OUTPUT")
            self.received_text += content["text"]
            if len(self.received_text) > 65536:
                raise RuntimeError("BOUNDED_RECEIVER_OUTPUT_REQUIRED")

    def finish(self, observation):
        if self.failure or self.requests != self.max_calls or len(self.calls) != self.max_calls:
            raise RuntimeError(self.failure or "ONE_ACTUAL_LOCAL_PROVIDER_REQUEST_REQUIRED")
        if self.received_text != self.text:
            raise RuntimeError("ACTUAL_RECEIVER_OUTPUT_NOT_DELIVERED")
        if observation.get("state") != "received" or observation.get("data", {}).get("kind") != "receiver":
            raise RuntimeError("ACTUAL_ORIGINAL_OUTCOME_REQUIRED")
        data = observation["data"]
        if data["accepted"] != self.accepted or data.get("outcome") != "completed":
            raise RuntimeError("ACTUAL_ORIGINAL_COMPLETION_MISMATCH")
        for call_id, source in self.calls.items():
            if not source["finished"]:
                raise RuntimeError("ORIGINAL_MODEL_FINISH_RECEIPT_REQUIRED")
            own, slot, sha = self.receipts(call_id)
            if not own["executionConfirmedTerminal"] or not slot["executionConfirmedTerminal"]:
                raise RuntimeError("REAL_RECEIVER_TASK_AND_CALL_TERMINAL_REQUIRED")
            if own["coverage"] != "complete" or own["knownUsage"]["tokens"] != 11 or own["knownUsage"]["modelCalls"] != 1:
                raise RuntimeError("REAL_RECEIVER_COMPLETE_USAGE_REQUIRED")
        self.checkpoint("actual_receiver_terminal_and_observed", ledgerSha256=sha,
                        callRevision=own["revision"], slotRevision=slot["revision"], knownTokens=11*self.max_calls,
                        receiverRealBudget=True, sourceRealBudget=False, paidProvider=False,
                        deliveredTextSha256=hashlib.sha256(self.received_text.encode()).hexdigest())

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

"""Actual Office tools create DOCX; this fixture selects bounded protocol steps only."""
import base64
import hashlib
import json
import re
from native_local_provider import LocalProviderScenario

OFFICE_TOOLS = {"OfficeDocument", "tool_execute", "tool_search"}
TITLE = "Native Receiver DOCX proof"
PARAGRAPHS = ["Literal Receiver fixture: approved amount 1234.56; owner pending confirmation.",
              "Original generated DOCX must survive manifest, complete bytes, SHA and the native reader."]


def tool_result(body, call_id):
    message = next((item for item in reversed(body.get("messages", []))
                    if item.get("role") == "tool" and item.get("tool_call_id") == call_id), None)
    if message is None:
        return None
    text = message.get("content")
    if not isinstance(text, str):
        raise RuntimeError("ACTUAL_OFFICE_TOOL_TEXT_RECEIPT_REQUIRED")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"text": text}


class OfficeProviderScenario(LocalProviderScenario):
    def __init__(self, profile, checkpoint):
        super().__init__(profile, checkpoint, max_calls=3, allowed_tools=OFFICE_TOOLS)
        self.text = "OWNED_NATIVE_DOCX_COMPLETED"
        self.generated = None
        self.permissions = 0
        self.generation_approved = False
        self.session_id = None

    def response_chunks(self, body):
        names = {tool["function"]["name"] for tool in body.get("tools", [])}
        if not {"tool_search", "tool_execute"}.issubset(names):
            raise RuntimeError("NORMAL_KWORKER_CORE_DISCOVERY_TOOLS_REQUIRED")
        if self.requests == 1:
            call_id, name, arguments = "owned-office-discover", "tool_search", {"query": "OfficeDocument", "limit": 1}
        elif self.requests == 2:
            discovery = tool_result(body, "owned-office-discover")
            if not isinstance(discovery, dict) or not isinstance(discovery.get("text"), str):
                raise RuntimeError("ACTUAL_OFFICE_DISCOVERY_RECEIPT_REQUIRED")
            fenced = re.search(r"```json\s*([\s\S]*?)```", discovery["text"])
            value = json.loads(fenced.group(1)) if fenced else None
            if not value or not value.get("tools") or value["tools"][0].get("name") != "OfficeDocument":
                raise RuntimeError("OFFICE_DOCUMENT_NOT_REGISTERED_BY_NATIVE_STARTUP")
            self.checkpoint("actual_office_discovered", normalCore=True, ceiling=sorted(OFFICE_TOOLS))
            specification = {"schemaVersion": 1, "kind": "docx", "title": TITLE,
                             "paragraphs": [{"text": text} for text in PARAGRAPHS]}
            call_id, name, arguments = "owned-office-create", "tool_execute", {
                "tool_name": "OfficeDocument", "arguments": {"specification": specification, "sourceRefs": []}}
        elif self.requests == 3:
            self.generated = tool_result(body, "owned-office-create")
            if not isinstance(self.generated, dict) or self.generated.get("format") != "docx" or not self.generated.get("artifactRef", {}).get("id"):
                text = json.dumps(self.generated, ensure_ascii=False)
                codes = sorted(set(re.findall(r"\b(?:OFFICE|REMOTE|BUDGET)_[A-Z0-9_]{1,120}\b", text)))[:8]
                self.checkpoint("actual_office_generation_unavailable", toolReceiptKind=type(self.generated).__name__,
                                closedCodes=codes, toolReceiptSha256=hashlib.sha256(text.encode()).hexdigest())
                raise RuntimeError("ACTUAL_OFFICE_GENERATION_RECEIPT_REQUIRED")
            if not self.generation_approved:
                raise RuntimeError("NORMAL_ASK_APPROVAL_NOT_OBSERVED")
            self.checkpoint("actual_office_generated", artifactId=self.generated["artifactRef"]["id"],
                            sha256=self.generated.get("sha256"), normalAskPermissions=self.permissions)
            return super().response_chunks(body)
        else:
            raise RuntimeError("OFFICE_PROVIDER_CALL_LIMIT")
        return [
            {"id": "owned-office-response", "object": "chat.completion.chunk", "choices": [{"index": 0,
                "delta": {"role": "assistant", "tool_calls": [{"index": 0, "id": call_id, "type": "function",
                    "function": {"name": name, "arguments": json.dumps(arguments)}}]}, "finish_reason": None}]},
            {"id": "owned-office-response", "object": "chat.completion.chunk", "choices": [
                {"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                "usage": {"prompt_tokens": 7, "completion_tokens": 4, "total_tokens": 11}},
        ]

    def permission(self, frame):
        params = frame.get("params", {})
        call = params.get("toolCall", {})
        description = json.dumps(call, ensure_ascii=False)
        options = params.get("options", [])
        if params.get("sessionId") != self.session_id or not call.get("toolCallId") or "OfficeDocument" not in description:
            raise RuntimeError("ONLY_ACTUAL_OWNED_OFFICE_APPROVAL_MAY_BE_ANSWERED")
        if not any(item.get("optionId") == "allow_once" and item.get("kind") == "allow_once" for item in options):
            raise RuntimeError("NORMAL_ALLOW_ONCE_REQUIRED")
        self.permissions += 1
        self.generation_approved |= "owned-office-create" in call["toolCallId"]
        if self.permissions > 4:
            raise RuntimeError("OFFICE_APPROVAL_LIMIT")
        self.checkpoint("normal_office_permission_answered", approvalOrdinal=self.permissions,
                        sessionMatched=True, actualToolCallId=call["toolCallId"], onlyAllowOnce=True)
        return {"jsonrpc": "2.0", "id": frame["id"], "result": {"outcome": {"outcome": "selected", "optionId": "allow_once"}}}

    def manifest_digest(self, manifest):
        # Literal public struct field order; never read Receiver private artifact files.
        def ordered(value, keys):
            return {key: value[key] for key in keys if key in value}
        value = ordered(manifest, ["schemaVersion", "id", "revision", "owner", "task", "kind", "title", "format", "bytes", "sha256",
                                   "sourceRefs", "verification", "dataset", "createdAtMs", "presentation"])
        value["owner"] = ordered(value["owner"], ["accountId", "targetId", "workspaceId", "organizationId"])
        value["task"] = ordered(value["task"], ["threadId", "turnId", "runId"])
        value["verification"] = ordered(value["verification"], ["status", "completedChecks", "pendingChecks", "readerStatus", "formulaCalculation"])
        if value["sourceRefs"] or value.get("dataset") is not None:
            raise RuntimeError("ONLY_ORIGINAL_LITERAL_DOCX_FIXTURE_EXPECTED")
        if value.get("presentation") is not None:
            if value["presentation"].get("kind") != "document":
                raise RuntimeError("EXPECTED_DOCX_PRESENTATION")
            value["presentation"] = ordered(value["presentation"], ["kind", "paragraphs"])
        return hashlib.sha256(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()

    def receive_artifact(self, request, original):
        control = {**original, "requestId": "owned-docx-manifest", "message": {"method": "read_artifact_manifest", "params": self.accepted}}
        reply = request(9, "kcoder/nativeRemote/controlV1", control)
        manifest = reply.get("result", {}).get("data", {}).get("manifest")
        if reply.get("result", {}).get("state") != "received" or not isinstance(manifest, dict):
            raise RuntimeError("ACTUAL_DOCX_MANIFEST_NOT_RECEIVED")
        identity = self.accepted["identity"]
        if manifest.get("format") != "docx" or manifest.get("task", {}).get("threadId") != identity["threadId"] or manifest["task"].get("turnId") != identity["turnId"]:
            raise RuntimeError("ORIGINAL_DOCX_TASK_MISMATCH")
        reference = {"id": manifest["id"], "revision": manifest["revision"]}
        if reference != self.generated["artifactRef"] or manifest["sha256"] != self.generated["sha256"]:
            raise RuntimeError("ORIGINAL_DOCX_TOOL_AND_MANIFEST_MISMATCH")
        digest = self.manifest_digest(manifest)
        self.checkpoint("actual_docx_manifest_received", manifestSha256=digest, bytes=manifest["bytes"],
                        contentSha256=manifest["sha256"], acceptedIdentityMatched=True)
        content = bytearray()
        while len(content) < manifest["bytes"]:
            offset = len(content)
            control = {**original, "requestId": f"owned-docx-chunk-{offset}", "message": {"method": "read_artifact_chunk", "params": {
                "receiverAccepted": self.accepted, "artifact": reference, "manifestSha256": digest, "offset": offset, "maximumBytes": 4096}}}
            reply = request(10 + offset, "kcoder/nativeRemote/controlV1", control)
            data = reply.get("result", {}).get("data", {})
            if data.get("kind") != "artifact_chunk" or data.get("offset") != offset or data.get("manifestSha256") != digest or data.get("reference") != reference:
                raise RuntimeError("ORIGINAL_DOCX_CHUNK_MISMATCH")
            chunk = base64.b64decode(data["bytesBase64"], validate=True)
            if not chunk or data["totalBytes"] != manifest["bytes"] or len(chunk) > 4096:
                raise RuntimeError("ORIGINAL_DOCX_CHUNK_LENGTH_MISMATCH")
            content.extend(chunk)
            if len(content) > manifest["bytes"] or data["eof"] != (len(content) == manifest["bytes"]):
                raise RuntimeError("ORIGINAL_DOCX_COMPLETE_BYTES_REQUIRED")
        if hashlib.sha256(content).hexdigest() != manifest["sha256"]:
            raise RuntimeError("ORIGINAL_DOCX_CONTENT_HASH_MISMATCH")
        self.checkpoint("actual_docx_bytes_received", bytes=len(content), sha256=manifest["sha256"], fullHashMatched=True)
        return manifest, bytes(content)

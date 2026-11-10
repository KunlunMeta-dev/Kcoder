"""Literal material controls and read-only checks of the owned actual Receiver store."""
import base64
import hashlib
import json
import os
import stat
import subprocess


class MaterialScenario:
    def __init__(self, scenario, checkpoint, profile):
        self.scenario = scenario
        self.checkpoint = checkpoint
        self.profile = profile
        self.outer_id = 1000
        self.operations = []
        self.materials = []
        count = 2 if scenario in ("materials-transfer", "materials-prefinish-session", "materials-source-docx") else 1
        for index in range(count):
            label = f"owned-material-{index}"
            text = "".join(f"{label}-{row:04d}: literal untrusted row {hashlib.sha256(f'{index}:{row}'.encode()).hexdigest()[:16]}.\n"
                           for row in range(1600))
            content = text.encode()
            offer = {"content": {"source": {"id": label, "revision": 1}, "bytes": len(content),
                                  "sha256": hashlib.sha256(content).hexdigest()},
                     "filename": label + ".txt", "mediaType": "text/plain"}
            self.materials.append((offer, content))

    @property
    def offers(self):
        return [offer for offer, _ in self.materials]

    def frame(self, original, request_id, method, params):
        return {**original, "requestId": request_id, "message": {"method": method, "params": params}}

    def call(self, request, frame, expect_error=False):
        self.outer_id += 1
        reply = request(self.outer_id, "kcoder/nativeRemote/controlV1", frame)
        if expect_error:
            if reply.get("error", {}).get("code") != -32603:
                raise RuntimeError("MATERIAL_ORIGINAL_ERROR_RECEIPT_REQUIRED")
            self.checkpoint("original_material_error_receipt", typedRequestId=frame["requestId"],
                            publicErrorCode=reply["error"]["code"], mutationRetried=False)
            return reply
        value = reply.get("result", {})
        if value.get("state") != "received" or value.get("data", {}).get("kind") != "material":
            self.checkpoint("material_control_unconfirmed", typedRequestId=frame["requestId"],
                            errorCode=reply.get("error", {}).get("code"),
                            errorMessage=reply.get("error", {}).get("message", "")[:120])
            raise RuntimeError("ACTUAL_MATERIAL_RECEIPT_REQUIRED")
        for field in ("version", "operationId", "requestId", "endpointRevision", "endpointInstanceId"):
            if value.get(field) != frame[field]:
                raise RuntimeError("ORIGINAL_MATERIAL_REPLY_HEADER_MISMATCH")
        return value["data"]

    def observe(self, request, original, offer, ordinal):
        return self.call(request, self.frame(original, f"observe-{ordinal}", "observe_material", offer["content"]))

    def chunk(self, original, offer, content, offset, request_id):
        return self.frame(original, request_id, "material_chunk", {"content": offer["content"], "offset": offset,
            "chunkSha256": hashlib.sha256(content).hexdigest(), "bytesBase64": base64.b64encode(content).decode()})

    def transfer(self, request, original, offer, content):
        name = offer["content"]["source"]["id"]
        offered = self.call(request, self.frame(original, f"offer-{name}", "offer_material", offer))
        if offered["nextOffset"] != 0 or offered["complete"]:
            raise RuntimeError("ORIGINAL_EMPTY_OFFER_REQUIRED")
        chunks = 0
        for offset in range(0, len(content), 8192):
            data = content[offset:offset+8192]
            receipt = self.call(request, self.chunk(original, offer, data, offset, f"chunk-{name}-{offset}"))
            if receipt["nextOffset"] != offset + len(data) or receipt["complete"]:
                raise RuntimeError("ORIGINAL_SEQUENTIAL_CHUNK_REQUIRED")
            chunks += 1
        self.checkpoint("actual_material_chunks_transferred", sourceId=name, bytes=len(content),
                        sha256=offer["content"]["sha256"], chunks=chunks, complete=False)
        finished = self.call(request, self.frame(original, f"finish-{name}", "finish_material", offer["content"]))
        if not finished["complete"] or finished["nextOffset"] != len(content):
            raise RuntimeError("ORIGINAL_FULL_READER_FINISH_REQUIRED")
        self.checkpoint("actual_material_finished", sourceId=name, bytes=len(content),
                        sha256=offer["content"]["sha256"], nativeFinishReaderComplete=True)

    def run(self, request, original):
        first, content = self.materials[0]
        if self.scenario in ("materials-transfer", "materials-source-docx"):
            for offer, data in self.materials:
                self.transfer(request, original, offer, data)
            return True
        if self.scenario == "materials-prefinish-session":
            self.transfer(request, original, first, content)
            second = self.materials[1][0]
            self.call(request, self.frame(original, "offer-unfinished-second", "offer_material", second))
            one = self.observe(request, original, first, "finished-first")
            two = self.observe(request, original, second, "unfinished-second")
            if not one["complete"] or two["complete"] or two["nextOffset"] != 0:
                raise RuntimeError("DECLARED_FINISHED_AND_UNFINISHED_FACTS_REQUIRED")
            return False
        offered_frame = self.frame(original, "original-offer", "offer_material", first)
        original_receipt = self.call(request, offered_frame)
        if self.scenario == "materials-offset":
            wrong = self.chunk(original, first, content[:8192], 1, "original-wrong-offset")
            self.call(request, wrong, expect_error=True)
            current = self.observe(request, original, first, "after-wrong-offset")
            if current["nextOffset"] != 0 or current["complete"]:
                raise RuntimeError("WRONG_OFFSET_MODIFIED_ORIGINAL_TRANSFER")
            self.checkpoint("wrong_offset_only_observed", originalRequestId=wrong["requestId"], nextOffset=0,
                            unknownMutationReplayed=False, newMutationIdentity=False)
        elif self.scenario == "materials-conflict":
            conflicting = {**offered_frame, "message": {"method": "offer_material", "params": {**first, "filename": "conflict.txt"}}}
            self.call(request, conflicting, expect_error=True)
            # Only the original already-confirmed receipt is reread under its exact ID/body.
            cached = self.call(request, offered_frame)
            if cached != original_receipt:
                raise RuntimeError("CONFLICT_CHANGED_ORIGINAL_CONFIRMED_RECEIPT")
            current = self.observe(request, original, first, "after-conflict")
            if current["nextOffset"] != 0 or current["complete"]:
                raise RuntimeError("CONFLICT_EXPANDED_ORIGINAL_TRANSFER")
            self.checkpoint("conflict_original_receipt_reconciled", originalRequestId=offered_frame["requestId"],
                            cachedConfirmedReceiptMatched=True, newMutationIdentity=False)
        elif self.scenario == "materials-ack-unknown":
            original_chunk = self.chunk(original, first, content[:8192], 0, "original-ack-discarded-chunk")
            self.call(request, original_chunk)
            # The local consumer discards its ACK; no network-loss claim or mutation retry.
            current = self.observe(request, original, first, "after-local-ack-discard")
            if current["nextOffset"] != 8192 or current["complete"]:
                raise RuntimeError("ORIGINAL_ACK_RECONCILIATION_FACT_MISMATCH")
            self.checkpoint("local_ack_discard_only_observed", originalRequestId=original_chunk["requestId"],
                            nextOffset=8192, simulatedLocalConsumerLoss=True, networkLossClaim=False,
                            mutationReplayed=False, newMutationIdentity=False)
        else:
            raise RuntimeError("EXPLICIT_MATERIAL_SCENARIO_REQUIRED")
        return False

    def verify_store_and_reader(self, binary, private, observe_process):
        snapshots = list(self.profile.rglob("office-state.json"))
        if len(snapshots) != 1:
            raise RuntimeError("ONE_ORIGINAL_RECEIVER_OFFICE_STORE_REQUIRED")
        path = snapshots[0]
        raw = path.read_bytes()
        state = json.loads(raw)
        header = json.loads(path.with_name("office-header.json").read_bytes())
        if state["owner"] != header["owner"] or len(state["inputs"]) != len(self.materials):
            raise RuntimeError("ORIGINAL_RECEIVER_STORE_OWNER_MISMATCH")
        for offer, expected in self.materials:
            matching = [row for row in state["inputs"].values() if row["receipt"]["metadata"]["expectedSha256"] == offer["content"]["sha256"]]
            if len(matching) != 1:
                raise RuntimeError("ORIGINAL_STORED_MATERIAL_RECEIPT_REQUIRED")
            record = matching[0]
            receipt = record["receipt"]
            if receipt["status"] != "accepted" or receipt["owner"] != state["owner"] or receipt["bytes"] != len(expected) or receipt["sha256"] != offer["content"]["sha256"]:
                raise RuntimeError("ORIGINAL_STORED_MATERIAL_INCOMPLETE")
            blob = path.with_name("input-content-"+receipt["sha256"]+".blob")
            info = blob.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or blob.read_bytes() != expected:
                raise RuntimeError("ORIGINAL_STORED_MATERIAL_BYTES_CHANGED")
            self.checkpoint("original_receiver_store_material_verified", inputId=receipt["inputId"],
                            bytes=len(expected), sha256=receipt["sha256"], storeRevision=state["revision"],
                            originalStoreSha256=hashlib.sha256(raw).hexdigest(), originalOwnerMatched=True)
            workspace = private / ("reader-"+offer["content"]["source"]["id"])
            workspace.mkdir(mode=0o700)
            cursor = None
            chunks = []
            pages = 0
            while True:
                reader_header = {"schemaVersion": 1, "reference": {"id": receipt["inputId"], "revision": 1},
                    "filename": offer["filename"], "byteLength": len(expected), "sha256": receipt["sha256"],
                    "scopeSha256": hashlib.sha256(json.dumps(state["owner"], separators=(",", ":")).encode()).hexdigest(),
                    "cursor": cursor, "limit": 4}
                with subprocess.Popen([str(binary), "--internal-office-read-worker"], cwd=workspace,
                        env={"PATH": "/usr/bin:/bin", "KCODER_CONFIG_DIR": str(workspace/"config")},
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as reader:
                    observe_process(reader.pid, os.getpid())
                    output, _ = reader.communicate(json.dumps(reader_header).encode()+b"\n"+expected, timeout=30)
                    if reader.returncode != 0 or len(output) > 65536:
                        raise RuntimeError("ORIGINAL_MATERIAL_READER_FAILED")
                reply = json.loads(output)
                value = reply.get("result", {})
                if reply.get("ok") is not True or value.get("sha256") != receipt["sha256"] or value.get("untrustedSourceData") is not True:
                    raise RuntimeError("ORIGINAL_MATERIAL_READER_RECEIPT_CHANGED")
                chunks.extend(row["text"] for row in value["chunks"])
                pages += 1
                if value["complete"]:
                    if value["nextCursor"] is not None or value["omittedChunks"] != 0:
                        raise RuntimeError("ORIGINAL_MATERIAL_READER_INCOMPLETE")
                    break
                cursor = value["nextCursor"]
                if not isinstance(cursor, str) or pages >= 32:
                    raise RuntimeError("ORIGINAL_MATERIAL_READER_BOUND")
            text = "".join(chunks).encode()
            if text != expected or pages < 2:
                raise RuntimeError("ORIGINAL_MATERIAL_FULL_READER_CONTENT_REQUIRED")
            self.checkpoint("original_material_reader_all_pages_verified", inputId=receipt["inputId"],
                            pages=pages, chunks=len(chunks), bytes=len(text), textSha256=hashlib.sha256(text).hexdigest(),
                            complete=True, literalFullContentMatched=True)

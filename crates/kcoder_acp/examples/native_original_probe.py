"""Literal ACP client. No adapter types, model requests or fabricated identity files."""
import hashlib
import json
import os
import re
import select
import selectors
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.dont_write_bytecode = True
BINARY, PRIVATE, REPORT = map(Path, sys.argv[1:4])
SCENARIO = sys.argv[4] if len(sys.argv) > 4 else "bind-only"
if SCENARIO not in ("bind-only", "local-provider", "office-docx", "materials-transfer", "materials-prefinish-session", "materials-offset", "materials-conflict", "materials-ack-unknown", "materials-source-docx"):
    raise RuntimeError("EXPLICIT_SUPPORTED_SCENARIO_REQUIRED")
PRIVATE.chmod(0o700)
PROFILE = PRIVATE / "profile"
WORKSPACE = PRIVATE / "workspace"
for directory in (PROFILE, WORKSPACE):
    directory.mkdir(mode=0o700)
SETTINGS = {
    "active_provider": "fixture", "model": "fixture::native-config-only", "credential_store": "file", "max_retries": 0,
    "session_memory": {"enabled": False}, "tools": {"profile": "none"}, "hooks": {}, "mcp_servers": [],
    "plugins": {"runtime": {"enabled": False}},
    "skills": {"auto_curator_enabled": False, "auto_skill_review_enabled": False},
    "providers": {"fixture": {"api_format": "openai_chat_completions", "authentication": {"mode": "none"},
        "endpoint": "http://127.0.0.1:1/v1", "default_model": "native-config-only", "context_window_tokens": 128000,
        "output_headroom_tokens": 8192, "max_output_tokens": 4096, "no_proxy": True, "discover_models": False}},
    "integrations": {"remotes": {"receiver": {"enabled": True, "allowSameAccountAcp": True}}},
}
settings_file = PROFILE / "settings.json"
settings_file.write_text(json.dumps(SETTINGS))
settings_file.chmod(0o600)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        while data := source.read(1024 * 1024):
            value.update(data)
    return value.hexdigest()


result = {"passed": False, "driverSha256": digest(Path(__file__)), "binarySha256": digest(BINARY),
          "scenario": SCENARIO, "turnStartSent": False, "sourceRealBudget": False,
          "stages": [], "cleanup": {"allObservedExited": False}}
report_lock = threading.RLock()
observed = {}
monitor_failures = []
lock = threading.Lock()
stop = threading.Event()
child = None
watcher = None
local_provider = None
material_scenario = None


def checkpoint(stage, **facts):
    with report_lock:
        result["stages"].append({"stage": stage, **facts})
        temporary = REPORT.with_suffix(".pending")
        temporary.write_text(json.dumps(result, indent=2) + "\n")
        temporary.replace(REPORT)


def owned_attempt_facts():
    rows = []
    for path in PRIVATE.rglob("*.attempt.json"):
        data = path.read_bytes()
        if len(data) > 1024 * 1024 or len(rows) >= 16:
            raise RuntimeError("OWNED_ATTEMPT_DIAGNOSTIC_LIMIT")
        record = json.loads(data)
        completion = record.get("completion") or {}
        error = completion.get("error")
        closed_code = error if isinstance(error, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{3,159}", error) else None
        rows.append({"recordSha256": hashlib.sha256(data).hexdigest(), "identity": record.get("identity"),
                     "status": record.get("status"), "completionStatus": completion.get("status"),
                     "closedDiagnosticCode": closed_code,
                     "errorSha256": hashlib.sha256(error.encode()).hexdigest() if isinstance(error, str) else None,
                     "hasProviderFailure": completion.get("provider_failure") is not None})
    return rows


def identity(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        return int(fields[1]), int(fields[19])
    except (OSError, IndexError, ValueError):
        return None


def observe(pid, parent):
    before = identity(pid)
    if before is None or before[0] != parent:
        return
    with lock:
        if (pid, before[1]) in observed:
            return
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            return
        if identity(pid) != before:
            os.close(fd)
            return
        observed[(pid, before[1])] = fd


def descendants(parent):
    children = set()
    try:
        for task in Path(f"/proc/{parent}/task").iterdir():
            try:
                children.update(map(int, (task / "children").read_text().split()))
            except OSError:
                pass
    except OSError:
        return
    for pid in children:
        observe(pid, parent)
        descendants(pid)


def exited(fd):
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    return bool(poll.poll(0))


def backend_identity():
    descendants(child.pid)
    candidates = []
    with lock:
        for (pid, start), fd in observed.items():
            current = identity(pid)
            if current == (child.pid, start) and not exited(fd):
                candidates.append((pid, start))
    if len(candidates) != 1:
        raise RuntimeError("EXACTLY_ONE_ORIGINAL_BACKEND_REQUIRED")
    pid, start = candidates[0]
    backend_image = os.stat(f"/proc/{pid}/exe")
    parent_image = os.stat(f"/proc/{child.pid}/exe")
    supplied_image = BINARY.stat()
    same_image = (backend_image.st_dev, backend_image.st_ino) == (parent_image.st_dev, parent_image.st_ino) == (supplied_image.st_dev, supplied_image.st_ino)
    same_cwd = os.path.samefile(f"/proc/{pid}/cwd", WORKSPACE)
    marker = b"--internal-acp-backend" in Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    if not (same_image and same_cwd and marker):
        raise RuntimeError("ACTUAL_NATIVE_PARENT_IMAGE_CWD_REQUIRED")
    return pid, start


buffer = bytearray()


def request(request_id, method, params):
    child.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}).encode() + b"\n")
    child.stdin.flush()
    deadline = time.monotonic() + 35
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    try:
        while time.monotonic() < deadline:
            if b"\n" not in buffer:
                if not selector.select(max(0, deadline - time.monotonic())):
                    break
                data = os.read(child.stdout.fileno(), 65536)
                if not data:
                    raise RuntimeError("ACP_CLOSED_BEFORE_RECEIPT")
                buffer.extend(data)
                if len(buffer) > 2 * 1024 * 1024:
                    raise RuntimeError("ACP_FRAME_LIMIT")
                continue
            line, _, remaining = buffer.partition(b"\n")
            buffer[:] = remaining
            frame = json.loads(line)
            if frame.get("id") == request_id and "method" not in frame:
                return frame
            if local_provider is not None and frame.get("method") == "kcoder/nativeRemote/controlV1":
                response = local_provider.control(frame)
                child.stdin.write(json.dumps(response).encode() + b"\n")
                child.stdin.flush()
                continue
            if SCENARIO == "office-docx" and frame.get("method") == "session/request_permission":
                response = local_provider.permission(frame)
                child.stdin.write(json.dumps(response).encode() + b"\n")
                child.stdin.flush()
                continue
            if local_provider is not None and frame.get("method") == "session/update" and "id" not in frame:
                update = frame.get("params", {}).get("update", {})
                local_provider.update(update)
                checkpoint("acp_session_update", updateKind=update.get("sessionUpdate"))
                continue
            raise RuntimeError("UNEXPECTED_FRAME_WITHOUT_TURN")
        raise RuntimeError("ACP_RECEIPT_UNKNOWN_NO_REPLAY")
    finally:
        selector.close()


def interrupt(_signal, _frame):
    raise RuntimeError("OWNED_PROBE_INTERRUPTED")


signal.signal(signal.SIGTERM, interrupt)
signal.signal(signal.SIGINT, interrupt)
try:
    if SCENARIO.startswith("materials-"):
        from native_material_probe import MaterialScenario
        material_scenario = MaterialScenario(SCENARIO, checkpoint, PROFILE)
        result["materialDriverSha256"] = digest(Path(__file__).with_name("native_material_probe.py"))
        SETTINGS["integrations"]["remotes"]["receiver"].update({"acceptMaterials": True, "maximumMaterialBytes": 2*1024*1024})
        settings_file.write_text(json.dumps(SETTINGS))
    if SCENARIO in ("local-provider", "office-docx"):
        from native_local_provider import LocalProviderScenario
        if SCENARIO == "office-docx":
            from native_office_provider import OfficeProviderScenario
            local_provider = OfficeProviderScenario(PROFILE, checkpoint)
            result["officeProviderDriverSha256"] = digest(Path(__file__).with_name("native_office_provider.py"))
        else:
            local_provider = LocalProviderScenario(PROFILE, checkpoint)
        result["localProviderDriverSha256"] = digest(Path(__file__).with_name("native_local_provider.py"))
        SETTINGS["providers"]["fixture"]["endpoint"] = local_provider.endpoint
        SETTINGS["providers"]["fixture"]["max_output_tokens"] = 256
        SETTINGS["providers"]["fixture"]["output_headroom_tokens"] = 1024
        SETTINGS["max_tokens"] = 128
        SETTINGS["integrations"]["remotes"]["receiver"].update({"maximumTotalTokens": 100000, "maximumModelCalls": local_provider.max_calls})
        if SCENARIO == "office-docx":
            SETTINGS["providers"]["fixture"]["max_output_tokens"] = 1024
            SETTINGS["providers"]["fixture"]["output_headroom_tokens"] = 2048
            SETTINGS["max_tokens"] = 1024
            observation_path = os.environ["KCODER_ACP_OFFICE_OBSERVATION"]
            preflight_script = Path(__file__).with_name("native_office_preflight.mjs")
            with subprocess.Popen(["/usr/bin/node", str(preflight_script), observation_path, str(PRIVATE / "office-installation")],
                                  env={"PATH": "/usr/bin:/bin"}, cwd=PRIVATE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE) as preflight:
                observe(preflight.pid, os.getpid())
                preflight_output, _ = preflight.communicate(timeout=35)
                if preflight.returncode != 0 or len(preflight_output) > 16384:
                    raise RuntimeError("OWNED_OFFICE_PREFLIGHT_FAILED")
            launch = json.loads(preflight_output)
            SETTINGS["tools"] = {"profile": "core"}
            SETTINGS["permission_mode"] = "ask"
            SETTINGS["integrations"]["office"] = {"enabled": True, "allowedFormats": ["docx"], "maxOutputBytes": 1048576}
            SETTINGS["integrations"]["remotes"]["receiver"]["office"] = {
                "enabled": True, "allowedFormats": ["docx"], "allowedTools": ["OfficeDocument", "tool_execute", "tool_search"],
                "startupConfiguration": {key: launch[key] for key in ["schemaVersion", "componentRoot", "manifestSha256", "runtime"]}}
            checkpoint("owned_office_installation_preflight", manifestSha256=launch["manifestSha256"],
                       runtimeSha256=launch["runtime"]["sha256"], nodeVersion=launch["runtime"]["nodeVersion"],
                       actualSealedInventoryVerified=True, nativeParentStillRequired=True)
        settings_file.write_text(json.dumps(SETTINGS))
    environment = {"HOME": str(PRIVATE), "KCODER_CONFIG_DIR": str(PROFILE), "PATH": "/usr/bin:/bin", "TMPDIR": str(PRIVATE)}
    child = subprocess.Popen([str(BINARY), "acp"], cwd=WORKSPACE, env=environment,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    observe(child.pid, os.getpid())

    def monitor():
        while not stop.wait(0.01):
            try:
                descendants(child.pid)
            except Exception as error:
                monitor_failures.append(type(error).__name__)
                return

    watcher = threading.Thread(target=monitor, daemon=True)
    watcher.start()
    initialized = request(1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}})
    if initialized.get("result", {}).get("protocolVersion") != 1:
        raise RuntimeError("ACP_INITIALIZE_FAILED")
    checkpoint("acp_initialized")
    prompt = "C58_PRIVATE_ORIGINAL_PROBE"
    original = {"version": 1, "operationId": "owned-actual-original", "requestId": "owned-original-bind",
                "endpointRevision": "owned-target-revision", "endpointInstanceId": "owned-target-instance",
                "sourceAcceptedSha256": "a" * 64,
                "message": {"method": "bind_original", "params": {
                    "sourceScope": {"accountId": "owned-source", "targetId": "owned-source-target", "workspaceId": None,
                                    "identityGeneration": "1", "targetRevision": "1"},
                    "sourceAttempt": {"threadId": "owned-thread", "turnId": "owned-turn", "attemptId": "owned-attempt"},
                    "frozenInputSha256": hashlib.sha256(prompt.encode()).hexdigest(), "deadlineUtcMs": int(time.time() * 1000) + 120000,
                    "prompt": prompt, "allowedOutputFormats": []}}}
    if SCENARIO == "office-docx":
        original["message"]["params"]["allowedOutputFormats"] = ["docx"]
    if SCENARIO == "materials-source-docx":
        original["message"]["params"]["allowedOutputFormats"] = ["docx"]
        checkpoint("source_docx_advertised_own_office_disabled", ownOfficeEnabled=False,
                   ownToolsProfile=SETTINGS["tools"]["profile"], modelsRequested=False)
    if material_scenario is not None:
        original["message"]["params"]["materials"] = material_scenario.offers
    if local_provider is not None:
        local_provider.bind(original)
    first_backend = None
    for outer_id in (2, 3):
        receipt = request(outer_id, "kcoder/nativeRemote/controlV1", original)
        value = receipt.get("result", {})
        if value.get("state") != "received" or value.get("data", {}).get("kind") != "original_bound":
            checkpoint("original_bind_failed", outerId=outer_id, errorCode=receipt.get("error", {}).get("code"))
            raise RuntimeError("ACTUAL_ORIGINAL_BIND_NOT_RECEIVED")
        if value["data"]["receiverSettingsSha256"] != digest(settings_file):
            raise RuntimeError("ACTUAL_RECEIVER_SETTINGS_RECEIPT_MISMATCH")
        current = backend_identity()
        if first_backend is not None and current != first_backend:
            raise RuntimeError("ORIGINAL_BACKEND_WAS_RESTARTED")
        first_backend = current
        checkpoint("original_bound", outerId=outer_id, backendPid=current[0], backendStart=current[1],
                   sameImage=True, actualCwd=True, settingsReceiptMatched=True)
    all_materials_finished = False
    if material_scenario is not None:
        all_materials_finished = material_scenario.run(request, original)
        if all_materials_finished:
            material_scenario.verify_store_and_reader(BINARY, PRIVATE, observe)
        elif SCENARIO == "materials-prefinish-session":
            rejected = request(5, "session/new", {"cwd": str(WORKSPACE), "mcpServers": []})
            if "error" not in rejected:
                raise RuntimeError("UNFINISHED_DECLARED_MATERIAL_CREATED_SESSION")
            checkpoint("unfinished_declared_material_session_rejected", errorCode=rejected["error"]["code"],
                       priorFinishedMaterial=True, anotherDeclaredMaterialIncomplete=True, sessionRetried=False)
    if material_scenario is None or all_materials_finished:
        rejected = request(4, "session/new", {"cwd": "/", "mcpServers": []})
        if "error" not in rejected or backend_identity() != first_backend:
            raise RuntimeError("WRONG_CWD_NOT_REJECTED_ON_ORIGINAL_BACKEND")
        checkpoint("wrong_cwd_rejected")
        created = request(5, "session/new", {"cwd": str(WORKSPACE), "mcpServers": []})
        if not isinstance(created.get("result", {}).get("sessionId"), str) or backend_identity() != first_backend:
            checkpoint("session_new_failed", errorCode=created.get("error", {}).get("code"))
            raise RuntimeError("SAME_ORIGINAL_NATIVE_SESSION_REQUIRED")
        checkpoint("original_session_created", backendPid=first_backend[0])
        if SCENARIO == "office-docx":
            local_provider.session_id = created["result"]["sessionId"]
        second = request(6, "session/new", {"cwd": str(WORKSPACE), "mcpServers": []})
        if "error" not in second or backend_identity() != first_backend:
            raise RuntimeError("SECOND_NATIVE_SESSION_NOT_REJECTED")
        checkpoint("second_session_rejected")
    if local_provider is not None:
        result["turnStartSent"] = True
        checkpoint("original_prompt_started", sourceLiteralFixtureOnly=True, sourceRealBudget=False)
        completion = request(7, "session/prompt", {"sessionId": created["result"]["sessionId"], "prompt": [{"type": "text", "text": prompt}]})
        if completion.get("result", {}).get("stopReason") != "end_turn":
            checkpoint("original_prompt_failed", errorCode=completion.get("error", {}).get("code"),
                       errorMessage=completion.get("error", {}).get("message", "")[:160])
            raise RuntimeError("ACTUAL_RECEIVER_PROMPT_DID_NOT_COMPLETE")
        checkpoint("original_prompt_completed")
        observation_request = {**original, "requestId": "observe-owned-original", "message": {"method": "observe_original"}}
        observation = request(8, "kcoder/nativeRemote/controlV1", observation_request)
        local_provider.finish(observation.get("result", {}))
        if SCENARIO == "office-docx":
            from native_office_provider import PARAGRAPHS
            manifest, document = local_provider.receive_artifact(request, original)
            reader_workspace = PRIVATE / "original-reader"
            reader_workspace.mkdir(mode=0o700)
            header = {"schemaVersion": 1, "reference": {"id": manifest["id"], "revision": manifest["revision"]},
                      "filename": "native-receiver-proof.docx", "byteLength": len(document), "sha256": manifest["sha256"],
                      "scopeSha256": hashlib.sha256(json.dumps(local_provider.accepted["receiverScope"], separators=(",", ":")).encode()).hexdigest(),
                      "cursor": None, "limit": 4}
            with subprocess.Popen([str(BINARY), "--internal-office-read-worker"], cwd=reader_workspace,
                                  env={"PATH": "/usr/bin:/bin", "KCODER_CONFIG_DIR": str(reader_workspace / "config")},
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as reader:
                observe(reader.pid, os.getpid())
                output, _ = reader.communicate(json.dumps(header).encode() + b"\n" + document, timeout=30)
                if reader.returncode != 0 or len(output) > 65536:
                    raise RuntimeError("ORIGINAL_NATIVE_DOCX_READER_FAILED")
            read_result = json.loads(output)
            read_value = read_result.get("result", {})
            text = "\n".join(chunk.get("text", "") for chunk in read_value.get("chunks", []))
            if read_result.get("ok") is not True or read_value.get("sha256") != manifest["sha256"] or read_value.get("complete") is not True or not all(part in text for part in PARAGRAPHS):
                raise RuntimeError("ORIGINAL_NATIVE_DOCX_READER_CONTENT_MISMATCH")
            checkpoint("original_native_docx_reader_verified", sha256=manifest["sha256"],
                       textSha256=hashlib.sha256(text.encode()).hexdigest(), complete=True, literalParagraphsMatched=True)
    child.stdin.close()
    if child.wait(timeout=20) != 0:
        raise RuntimeError("ACP_EOF_EXIT_FAILED")
    with lock:
        if any(not exited(fd) for fd in observed.values()):
            raise RuntimeError("ACP_EOF_DID_NOT_RELEASE_ORIGINAL_BACKEND")
    if monitor_failures:
        raise RuntimeError("EXACT_PROCESS_MONITOR_FAILED")
    checkpoint("eof_owned_backend_exited_without_forced_cleanup")
    result["passed"] = True
except Exception as error:
    result["ownedAttemptFacts"] = owned_attempt_facts()
    checkpoint("failed", diagnostic=type(error).__name__ + ":" + str(error)[:128])
finally:
    if local_provider is not None:
        result["localProviderSummary"] = {"requests": local_provider.requests,
                                          "controlInvocations": local_provider.control_invocations,
                                          "typedControlReceipts": len(local_provider.seen),
                                          "acceptedReceived": local_provider.accepted is not None,
                                          "localFixtureFailure": local_provider.failure,
                                          "sourceRealBudget": False}
        local_provider.close()
    if child is not None:
        descendants(child.pid)
    stop.set()
    if watcher is not None:
        watcher.join(timeout=1)
    if child is not None:
        try:
            child.stdin.close()
        except (OSError, ValueError):
            pass
    with lock:
        handles = list(observed.values())
    for fd in reversed(handles):
        if not exited(fd):
            signal.pidfd_send_signal(fd, signal.SIGTERM)
    deadline = time.monotonic() + 3
    while any(not exited(fd) for fd in handles) and time.monotonic() < deadline:
        time.sleep(0.01)
    for fd in reversed(handles):
        if not exited(fd):
            signal.pidfd_send_signal(fd, signal.SIGKILL)
    if child is not None:
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
    deadline = time.monotonic() + 3
    while any(not exited(fd) for fd in handles) and time.monotonic() < deadline:
        time.sleep(0.01)
    result["cleanup"] = {"observedProcesses": len(handles), "allObservedExited": all(exited(fd) for fd in handles),
                         "monitorComplete": not monitor_failures, "monitorFailures": monitor_failures}
    checkpoint("cleanup_completed", allObservedExited=result["cleanup"]["allObservedExited"])
    for fd in handles:
        os.close(fd)
sys.exit(0 if result["passed"] and result["cleanup"]["allObservedExited"] and result["cleanup"]["monitorComplete"] else 1)

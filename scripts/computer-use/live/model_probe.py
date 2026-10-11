"""Live model -> app-server -> native desktop test. Approval is restricted to
the owned fixture. The visual challenge is not included in the model prompt.
"""
import ctypes
import base64
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

executable, output = map(Path, sys.argv[1:3])
protocol = sys.argv[3] if len(sys.argv) > 3 else "anthropic_messages"
uia_only = len(sys.argv) > 4 and sys.argv[4] == "--uia-only"
output.mkdir(parents=True, exist_ok=False)
source = Path.home() / ".config/kcoder"
settings = json.loads((source / "settings.json").read_text(encoding="utf-8-sig"))
credentials = json.loads((source / "credentials.json").read_text(encoding="utf-8-sig"))
secrets = [value.get("key", "") for value in credentials.values() if isinstance(value, dict) and value.get("key")]
def safe(value):
    text = str(value)
    for secret in secrets: text = text.replace(secret, "[redacted]")
    return text[:500]
report = {"status":"failed", "protocol":protocol, "approvedTools":[], "deniedTools":[], "desktopStates":[], "toolImageCount":0}
report["mode"] = "uia_only" if uia_only else "visual_challenge"
started = time.monotonic()
def diagnostic(value):
    if isinstance(value, dict):
        return {k:diagnostic(v) for k,v in value.items() if k not in ("outputImages", "images", "data", "source", "input")}
    if isinstance(value, list): return [diagnostic(v) for v in value[:12]]
    return safe(value) if isinstance(value, str) else value
def record(method, params):
    with (output / "events.jsonl").open("a", encoding="utf-8") as log:
        log.write(json.dumps({"seconds":round(time.monotonic()-started, 2), "method":method, "params":diagnostic(params)}) + "\n")
fixture = server = None
with tempfile.TemporaryDirectory(prefix="kcoder-model-desktop-") as temporary:
    root = Path(temporary)
    config = root / "config"; config.mkdir()
    workspace = root / "workspace"; workspace.mkdir()
    settings["plugins"] = {"runtime":{"enabled":True}}
    settings["permission_mode"] = "ask"
    settings["permission_rules"] = []
    settings.pop("session_permission_rules", None)
    settings.pop("hooks", None)
    settings["mcp_servers"] = []
    profile = settings["providers"][settings["active_provider"]]
    profile["api_format"] = protocol
    if uia_only:
        profile.setdefault("capabilities", {})["vision"] = False
        for model in profile.get("models", {}).values():
            model.setdefault("capabilities", {})["vision"] = False
    if protocol == "openai_chat_completions":
        profile["endpoint"] = profile["endpoint"].rstrip("/") + "/v1"
    (config / "settings.json").write_text(json.dumps(settings), encoding="utf-8")
    shutil.copyfile(source / "credentials.json", config / "credentials.json")
    env = os.environ.copy()
    env.update(KCODER_CONFIG_DIR=str(config), USERPROFILE=str(root), HOME=str(root))
    deadline = time.monotonic() + 125
    frames = queue.Queue()
    errors = []
    assistant_text = []
    try:
        fixture_log = (output / "fixture.log").open("wb")
        fixture = subprocess.Popen(["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
            "-File", str(Path(__file__).with_name("fixture.ps1")), "-OutputDirectory", str(output),
            *([] if uia_only else ["-VisualChallenge"])],
            stdout=fixture_log, stderr=subprocess.STDOUT)
        ready_path = output / "fixture-ready.json"
        while not ready_path.is_file():
            if fixture.poll() is not None or time.monotonic() > deadline: raise RuntimeError("fixture startup failed")
            time.sleep(.1)
        ready = json.loads(ready_path.read_text(encoding="utf-8-sig"))
        if not uia_only: assert re.fullmatch(r"[0-9]{4}", ready["challenge"])
        user32 = ctypes.WinDLL("user32"); user32.GetForegroundWindow.restype = ctypes.c_void_p
        server = subprocess.Popen([str(executable), "--settings-file", str(config / "settings.json"),
            "--cwd", str(workspace), "app-server"], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
        def receive():
            while True:
                line = server.stdout.readline(2 * 1024 * 1024 + 1)
                if not line: frames.put({"exited":True}); return
                if len(line) > 2 * 1024 * 1024: frames.put({"invalid":True}); return
                try: frames.put(json.loads(line))
                except ValueError: frames.put({"invalid":True}); return
        def drain():
            while True:
                line = server.stderr.readline(8192)
                if not line: return
                if len(errors) < 8: errors.append(safe(line.decode(errors="replace")))
        threading.Thread(target=receive, daemon=True).start()
        threading.Thread(target=drain, daemon=True).start()
        def send(value):
            server.stdin.write((json.dumps(value) + "\n").encode()); server.stdin.flush()
        def inside(point):
            if isinstance(point, str):
                try: point = json.loads(point)
                except ValueError: return False
            return isinstance(point, list) and len(point) == 2 and all(isinstance(v, (int,float)) for v in point) and ready["region"][0] <= point[0] < ready["region"][2] and ready["region"][1] <= point[1] < ready["region"][3]
        def approve(params):
            action = params.get("action", {})
            name = action.get("name", ""); args = action.get("input", {})
            allowed = False
            if action.get("type") == "tool" and name.startswith("mcp__kcoder_computer_use__") and isinstance(args, dict) and user32.GetForegroundWindow() == ready["hwnd"]:
                short = name.rsplit("__",1)[-1]
                if short in ("Screenshot", "Snapshot"):
                    region = args.get("region")
                    if isinstance(region, str):
                        try: region = json.loads(region)
                        except ValueError: region = None
                    scoped = region == ready["region"]
                    if uia_only and isinstance(region, list) and len(region) == 4 and all(isinstance(v, (int, float)) for v in region):
                        left, top, right, bottom = region
                        bounds = ready["region"]
                        scoped = bounds[0] <= left < right <= bounds[2] and bounds[1] <= top < bottom <= bounds[3]
                    allowed = scoped and args.get("use_dom", False) in (False, "false", "False")
                    if uia_only:
                        # Let the real native adapter enforce vision capability;
                        # this test gate only confines the operation to our form.
                        allowed = allowed and short == "Snapshot"
                elif short == "Click": allowed = inside(args.get("loc")) and args.get("button", "left") == "left"
                elif short == "Type": allowed = inside(args.get("loc")) and isinstance(args.get("text"), str) and bool(re.fullmatch(r"[0-9]{4}", args["text"])) and args.get("press_enter", False) in (False, "false", "False")
                elif short == "Move": allowed = inside(args.get("loc")) and args.get("drag", False) in (False, "false", "False")
            report["approvedTools" if allowed else "deniedTools"].append(name or action.get("type"))
            if allowed: record("approvedDesktopCall", {"name":name, "arguments":args})
            else: record("declinedDesktopCall", {"name":name, "arguments":args, "fixtureForeground":user32.GetForegroundWindow() == ready["hwnd"]})
            return {"decision":"accept" if allowed else "decline", **{key:params.get(key) for key in ("approvalId","threadId","turnId")}}
        def next_frame():
            while time.monotonic() < deadline:
                try: frame = frames.get(timeout=max(.01, deadline-time.monotonic()))
                except queue.Empty: raise TimeoutError("model desktop task timed out waiting for app-server event") from None
                if frame.get("exited") or frame.get("invalid"): raise RuntimeError("app-server stream ended: " + " ".join(errors))
                if frame.get("method") in ("item/started", "item/completed", "computerUse/stateChanged", "turn/completed", "approval/request"):
                    record(frame["method"], frame.get("params", {}))
                if frame.get("method") == "item/delta" and sum(map(len, assistant_text)) < 4000:
                    delta = frame.get("params", {}).get("delta", {}).get("text")
                    if isinstance(delta, str): assistant_text.append(delta[:4000])
                item = frame.get("params", {}).get("item", {})
                if item.get("name") == "mcp__kcoder_computer_use__Screenshot" and item.get("outputImages") and not (output / "fixture-model-screenshot.png").exists():
                    captured = item["outputImages"][0]
                    if captured.get("mimeType") == "image/png":
                        (output / "fixture-model-screenshot.png").write_bytes(base64.b64decode(captured["data"], validate=True))
                if frame.get("method") == "approval/request":
                    send({"jsonrpc":"2.0", "id":frame["id"], "result":approve(frame["params"])}); continue
                report["toolImageCount"] += len(frame.get("params",{}).get("item",{}).get("outputImages",[]))
                if frame.get("method") == "computerUse/stateChanged": report["desktopStates"].append(frame["params"].get("state"))
                return frame
            raise TimeoutError("model desktop task timed out")
        def rpc(identifier, method, params):
            send({"jsonrpc":"2.0","id":identifier,"method":method,"params":params})
            while True:
                frame=next_frame()
                if frame.get("id") != identifier: continue
                if "error" in frame: raise RuntimeError(safe(frame["error"]))
                return frame["result"]
        rpc(1,"initialize",{"protocolVersion":"2026-07-27","clientInfo":{"name":"owned-model-desktop-probe","version":"1"}})
        availability = rpc(2,"computerUse/status",{})
        assert availability.get("canControl") is True, "desktop component is unavailable: " + str(availability.get("reason"))
        thread = rpc(3,"thread/start",{})["thread"]["id"]
        prompt = ("You are authorized to operate only the already-open KCoder isolated input fixture. Use ONLY the computer-use desktop tools. "
            f"First take Screenshot with region={ready['region']}. Read the random four-digit code painted beside the button from the image. "
            f"Type ONLY those four digits into the textbox at loc={ready['inputLoc']}, clear=true; then click the verification button at loc={ready['buttonLoc']}. "
            "Use coordinates, not element labels. Every Screenshot or Snapshot must use the exact region above. Do not use shell, file tools, other windows or applications. "
            "When done reply KCODER_DESKTOP_DONE.")
        if uia_only:
            prompt = ("This turn has NO vision capability. Use ONLY the computer-use desktop tools on the already-open KCoder isolated input fixture. "
                f"First call Snapshot with region={ready['region']}, use_vision=false, use_annotation=false. Confirm the KCoderInput textbox and Verify test input button appear in the control tree. "
                "Use the coordinates from that control tree, not element labels: Type ONLY 3141 into KCoderInput, clear=true; then click Verify test input. "
                "Do not request screenshots, shell, file tools or any other window. When done reply KCODER_UIA_DONE.")
        rpc(4,"turn/start",{"threadId":thread,"input":[{"type":"text","text":prompt}],"computerUse":{"approved":True,"target":"local_windows_desktop"}})
        while True:
            frame=next_frame()
            if frame.get("method") == "turn/completed":
                params=frame["params"];report["turnStatus"]=params.get("turn",{}).get("status")
                if params.get("error"): report["turnError"]=safe(params["error"])
                break
        assert report["turnStatus"] == "completed", "model turn failed: " + str(report.get("turnError", "unknown"))
        assert (output / "input-result.json").is_file(), "model ended without clicking the fixture verification button"
        observed=json.loads((output / "input-result.json").read_text(encoding="utf-8-sig"))
        report["inputMatched"] = observed.get("clicked") is True and observed.get("text") == ("3141" if uia_only else ready["challenge"])
        if not uia_only: report["visualChallengeMatched"] = report["inputMatched"]
        assert report["inputMatched"], "model did not enter the expected fixture input"
        assert report["turnStatus"] == "completed" and "stopped" in report["desktopStates"], "turn/desktop did not complete cleanly"
        if uia_only:
            assert report["toolImageCount"] == 0, "non-visual model received an image"
            assert report["approvedTools"][0] == "mcp__kcoder_computer_use__Snapshot", "UIA was not observed first"
        else:
            assert report["toolImageCount"] > 0, "desktop image was not delivered through app-server"
        report["status"]="passed"
    except Exception as error: report["error"]=safe(error) or type(error).__name__
    finally:
        if server and server.poll() is None:
            server.stdin.close()
            try: server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                subprocess.run(["taskkill.exe","/PID",str(server.pid),"/T","/F"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
                server.wait(timeout=5)
        (output / "close.fixture").touch()
        if fixture:
            try: fixture.wait(timeout=5)
            except subprocess.TimeoutExpired: fixture.kill();fixture.wait(timeout=5)
        report["cleanup"]={"serverExited":server is None or server.poll() is not None,"fixtureExited":fixture is None or fixture.poll() is not None}
        report["stderr"] = errors
        report["assistantText"] = safe("".join(assistant_text))
(output / "model-result.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
print(json.dumps(report))
sys.exit(0 if report["status"]=="passed" else 1)

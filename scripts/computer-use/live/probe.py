"""Authorized interactive-desktop probe. Operates only the owned fixture.
Never writes raw desktop text; screenshots are cropped to the fixture client.
"""
import base64
import ctypes
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

root, output = map(Path, sys.argv[1:3])
output.mkdir(exist_ok=False, parents=True)
worker = fixture = None
report = {"status": "failed", "steps": [], "desktopTask": "temporary owned fixture"}
deadline = time.monotonic() + 120


def wait_file(path, seconds):
    until = min(deadline, time.monotonic() + seconds)
    while time.monotonic() < until:
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8-sig"))
        if fixture and fixture.poll() is not None:
            raise RuntimeError("fixture exited before observation")
        time.sleep(.1)
    raise TimeoutError("fixture observation timed out")


try:
    # The installer probe uses a new form and a separate result directory; it
    # does not launch or modify the user's Studio profile.
    fixture_log = (output / "fixture.log").open("wb")
    fixture = subprocess.Popen(["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
        "-File", str(Path(__file__).with_name("fixture.ps1")), "-OutputDirectory", str(output)],
        stdout=fixture_log, stderr=subprocess.STDOUT)
    ready = wait_file(output / "fixture-ready.json", 20)
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.GetForegroundWindow.restype = ctypes.c_void_p
    user32.IsWindow.argtypes = [ctypes.c_void_p]
    user32.IsWindow.restype = ctypes.c_bool

    def assert_fixture():
        if time.monotonic() >= deadline or fixture.poll() is not None:
            raise RuntimeError("fixture is no longer available")
        if not user32.IsWindow(ready["hwnd"]) or user32.GetForegroundWindow() != ready["hwnd"]:
            raise RuntimeError("fixture lost foreground; refusing input or screenshot")

    env = {key: value for key, value in os.environ.items() if key.upper() in {
        "SYSTEMROOT", "WINDIR", "COMSPEC", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
        "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES",
        "USERNAME", "USERDOMAIN", "SESSIONNAME", "PATH"}}
    env.update(TEMP=str(output), TMP=str(output), ANONYMIZED_TELEMETRY="false", WINDOWS_MCP_WATCHDOG="false")
    manifest = json.loads((root / "runtime-manifest.json").read_text(encoding="utf-8-sig"))
    worker = subprocess.Popen([str(root / manifest["python"]), "-I", "-B", "-X", "utf8", str(root / "launch.py")],
        cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    replies = queue.Queue()
    def read_replies():
        while True:
            line = worker.stdout.readline(16 * 1024 * 1024 + 1)
            if not line:
                replies.put(RuntimeError("worker exited")); return
            if len(line) > 16 * 1024 * 1024:
                replies.put(RuntimeError("oversized worker frame")); return
            try: replies.put(json.loads(line))
            except ValueError: replies.put(RuntimeError("invalid worker frame")); return
    threading.Thread(target=read_replies, daemon=True).start()
    # Avoid retaining arbitrary upstream window/clipboard diagnostics.
    def drain_errors():
        while worker.stderr.read(8192):
            pass
    threading.Thread(target=drain_errors, daemon=True).start()
    request_id = 0
    def request(method, params):
        global request_id
        request_id += 1
        worker.stdin.write((json.dumps({"jsonrpc":"2.0","id":request_id,"method":method,"params":params})+"\n").encode())
        worker.stdin.flush()
        until = min(deadline, time.monotonic() + 40)
        while True:
            if time.monotonic() >= until:
                raise TimeoutError("MCP request timed out: " + method)
            reply = replies.get(timeout=max(.01, until-time.monotonic()))
            if isinstance(reply, Exception): raise reply
            if reply.get("id") != request_id: continue
            if "error" in reply: raise RuntimeError("MCP request failed: " + method)
            return reply["result"]
    request("initialize", {"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"kcoder-owned-fixture-probe","version":"1"}})
    worker.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n'); worker.stdin.flush()
    tools = request("tools/list", {})["tools"]
    names = {tool["name"] for tool in tools}
    assert {"Snapshot","Screenshot","Click","Type"} <= names
    report["steps"].append({"name":"initialize_and_list","passed":True,"tools":sorted(names)})
    def call(name, args):
        assert_fixture()
        result = request("tools/call", {"name":name,"arguments":args})
        if result.get("isError"): raise RuntimeError("desktop tool reported failure: " + name)
        return result
    screenshot = call("Screenshot", {"region":ready["region"],"use_annotation":False})
    images = [item for item in screenshot.get("content",[]) if item.get("type")=="image"]
    assert images, "Screenshot returned no image"
    image = base64.b64decode(images[0]["data"], validate=True)
    assert 0 < len(image) <= 4 * 1024 * 1024
    extension = {"image/png":"png","image/jpeg":"jpg","image/webp":"webp"}[images[0]["mimeType"]]
    (output / ("fixture-screenshot." + extension)).write_bytes(image)
    report["steps"].append({"name":"cropped_screenshot","passed":True,"bytes":len(image),"mimeType":images[0]["mimeType"]})
    snapshot = call("Snapshot", {"region":ready["region"],"use_vision":False,"use_annotation":False})
    text = "\n".join(item.get("text","") for item in snapshot.get("content",[]))
    assert "KCoderInput" in text or "Verify test input" in text, "fixture controls missing from UIA snapshot"
    report["steps"].append({"name":"fixture_uia","passed":True})
    expected = "KCoder \u4e2d\u6587\u8f93\u5165 123"
    call("Click", {"loc":ready["inputLoc"]})
    call("Type", {"loc":ready["inputLoc"],"text":expected,"clear":True})
    call("Click", {"loc":ready["buttonLoc"]})
    observed = wait_file(output / "input-result.json", 5)
    assert observed == {"text":expected,"clicked":True}, "fixture did not receive exact test input"
    report["steps"].append({"name":"click_type_verify","passed":True,"chinese":True})
    report["status"] = "passed"
except Exception as error:
    report["error"] = str(error)[:300] or type(error).__name__
finally:
    if worker and worker.poll() is None:
        subprocess.run(["taskkill.exe","/PID",str(worker.pid),"/T","/F"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
        worker.wait(timeout=10)
    (output / "close.fixture").touch()
    if fixture:
        try: fixture.wait(timeout=5)
        except subprocess.TimeoutExpired:
            fixture.kill(); fixture.wait(timeout=5)
    report["cleanup"] = {"workerExited":worker is None or worker.poll() is not None,"fixtureExited":fixture is None or fixture.poll() is not None}
    (output / "result.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
    print(json.dumps(report))
sys.exit(0 if report["status"]=="passed" else 1)

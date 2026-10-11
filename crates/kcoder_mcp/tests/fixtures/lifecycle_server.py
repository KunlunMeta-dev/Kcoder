"""Owned stdio peer for cancellation, bidirectional requests, and idle exit."""
import json
import os
import pathlib
import sys
import threading
import time

mode, directory = sys.argv[1], pathlib.Path(sys.argv[2])
output_lock = threading.Lock()
with (directory / "launches.jsonl").open("a") as log:
    log.write(json.dumps({"pid": os.getpid()}) + "\n")
launch_count = len((directory / "launches.jsonl").read_text().splitlines())


def emit(value):
    with output_lock:
        print(json.dumps(value), flush=True)


def effect(request):
    time.sleep(0.2)
    (directory / "effect").write_text("completed")
    emit({"jsonrpc": "2.0", "id": request["id"], "result": {"content": []}})


for line in sys.stdin:
    request = json.loads(line)
    with (directory / "messages.jsonl").open("a") as log:
        logged = dict(request)
        if logged.get("method") == "tools/call":
            logged["params"] = {"name": request["params"]["name"]}
        log.write(json.dumps(logged) + "\n")
    method = request.get("method")
    if mode == "slowread" and method == "notifications/initialized":
        time.sleep(0.2)
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {},
                  "serverInfo": {"name": "lifecycle-fixture", "version": "0"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "effect", "inputSchema": {"type": "object"}}]}
    elif method == "tools/call":
        (directory / "called").write_text("sent")
        if mode in ["effect", "slowread"]:
            threading.Thread(target=effect, args=(request,), daemon=True).start()
            continue
        if mode == "ping":
            emit({"jsonrpc": "2.0", "id": request["id"], "method": "ping"})
            emit({"jsonrpc": "2.0", "id": "server-request", "method": "sampling/createMessage", "params": {}})
        result = {"content": []}
    else:
        continue
    emit({"jsonrpc": "2.0", "id": request["id"], "result": result})
    if (mode == "exit" or (mode == "recover" and launch_count == 1)) and method == "tools/list":
        (directory / "exited").write_text("done")
        os._exit(0)

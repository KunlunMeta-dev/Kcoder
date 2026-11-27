"""Session-owned MCP fixture. Private environment is echoed only into RPC replies."""
import json
import os
import pathlib
import signal
import sys
import time

root = pathlib.Path(sys.argv[1])
owner = sys.argv[2]
root.joinpath("pid").write_text(str(os.getpid()))
if owner == "stubborn":
    os.setsid()
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if os.fork() == 0:
        os.setsid()
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        root.joinpath("leaf.pid").write_text(str(os.getpid()))
        while True:
            time.sleep(1)
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        if owner == "hang":
            continue
        result = {"protocolVersion": "2024-11-05", "capabilities": {},
                  "serverInfo": {"name": "session-fixture", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "echo", "description": "Echo " + os.environ["TOKEN"],
                             "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}]}
    elif method == "tools/call":
        root.joinpath("called").write_text(owner)
        if owner == "stubborn":
            with root.joinpath("writes").open("a") as receipt:
                receipt.write("committed\n")
                receipt.flush()
                os.fsync(receipt.fileno())
            continue
        result = {"content": [{"type": "text", "text": "owner=" + owner + "; token=" + os.environ["TOKEN"]}]}
    else:
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
if owner == "stubborn":
    while True:
        time.sleep(1)

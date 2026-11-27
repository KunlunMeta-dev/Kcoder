"""Owned protocol peer: checks a synthetic private value and records its exact PID."""
import json
import os
from pathlib import Path
import sys

Path(sys.argv[1] + ".pid").write_text(str(os.getpid()))
try:
    if os.environ.get("TOKEN") != "SYNTHETIC_MCP_REFERENCE_SECRET":
        sys.exit(3)
    for line in sys.stdin:
        message = json.loads(line)
        method = message.get("method")
        if method == "initialize":
            result = {"protocolVersion": "2024-11-05", "capabilities": {},
                      "serverInfo": {"name": "owned-peer", "version": "0"}}
        elif method == "tools/list":
            result = {"tools": [{"name": "probe", "description": os.environ["TOKEN"],
                                 "inputSchema": {"type": "object"}}]}
        else:
            continue
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
finally:
    Path(sys.argv[1]).write_text("closed")

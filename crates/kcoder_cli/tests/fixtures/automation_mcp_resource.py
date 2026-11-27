#!/usr/bin/env python3
"""Owned offline MCP application/mail resources; no network or platform account."""
import json
import os
from pathlib import Path
import sys

root = Path(sys.argv[1])
(root / "pid").write_text(str(os.getpid()))
resources = {
    "application://owned/records": ("application.json", "application/json"),
    "mailbox://owned/inbox": ("mailbox.eml", "message/rfc822"),
}
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "serverInfo": {"name": "owned-resource-fixture", "version": "1.0.0"}, "capabilities": {"tools": {}, "resources": {}}}
    elif method == "tools/list":
        result = {"tools": [{"name": "resource_metadata", "description": "Owned connection registration only; never invoked", "inputSchema": {"type": "object", "properties": {}}}]}
    elif method == "resources/read" and request.get("params", {}).get("uri") in resources:
        uri = request["params"]["uri"]
        name, mime = resources[uri]
        counter = root / "reads"
        count = int(counter.read_text()) if counter.exists() else 0
        counter.write_text(str(count + 1))
        result = {"contents": [{"uri": uri, "mimeType": mime, "text": (root / name).read_text()}]}
    elif method == "resources/list":
        result = {"resources": [{"uri": uri, "name": name, "mimeType": mime} for uri, (name, mime) in resources.items()]}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Owned fixture method unavailable"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)

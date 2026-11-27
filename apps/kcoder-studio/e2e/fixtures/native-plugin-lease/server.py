"""Owned real stdio MCP peer that reads its immutable installed plugin version."""
import json
import os
import pathlib
import sys

root = pathlib.Path(__file__).parent
version = root.joinpath("version.txt").read_text().strip()
field = "version_" + version
directory = pathlib.Path(sys.argv[1])
directory.mkdir(mode=0o700, parents=True, exist_ok=True)
with directory.joinpath("launches.jsonl").open("a") as log:
    log.write(json.dumps({"pid": os.getpid(), "version": version}) + "\n")


def emit(identity, result=None, error=None):
    value = {"jsonrpc": "2.0", "id": identity}
    value["error" if error else "result"] = error if error else result
    print(json.dumps(value), flush=True)


for line in sys.stdin:
    request = json.loads(line)
    identity = request.get("id")
    method = request.get("method")
    if method == "initialize":
        emit(identity, {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "owned-version-lease", "version": version}})
    elif method == "tools/list":
        emit(identity, {"tools": [{"name": "lease_read", "description": "Read this owned immutable plugin version", "inputSchema": {"type": "object", "properties": {field: {"type": "string", "maxLength": 64}}, "required": [field], "additionalProperties": False}, "annotations": {"readOnlyHint": True}}]})
    elif method == "tools/call":
        args = request.get("params", {}).get("arguments", {})
        if set(args) != {field} or not isinstance(args[field], str):
            emit(identity, error={"code": -32602, "message": "OWNED_VERSION_SCHEMA_MISMATCH"})
            continue
        record = {"pid": os.getpid(), "version": version, "phase": args[field]}
        with directory.joinpath("calls.jsonl").open("a") as log:
            log.write(json.dumps(record) + "\n")
        emit(identity, {"content": [{"type": "text", "text": json.dumps(record)}], "isError": False})
    elif method == "ping":
        emit(identity, {})

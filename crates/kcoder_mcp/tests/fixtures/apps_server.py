"""Owned offline MCP Apps fixture; never launches external programs or accesses a network."""
import base64
import json
import pathlib
import sys
import time

mode, directory = sys.argv[1:]
root = pathlib.Path(directory)

def write(value):
    print(json.dumps(value), flush=True)

for line in sys.stdin:
    request = json.loads(line)
    with (root / "messages.jsonl").open("a", encoding="utf-8") as output:
        output.write(json.dumps(request) + "\n")
    if "id" not in request:
        continue
    method = request["method"]
    result = None
    error = None
    if method == "initialize":
        if request.get("params", {}).get("capabilities", {}).get("extensions", {}).get("io.modelcontextprotocol/ui") is not None and (root / "hold-app-initialize").exists():
            (root / "app-initialize-held").write_text("ready", encoding="utf-8")
            deadline = time.monotonic() + 8
            while not (root / "release-app-initialize").exists() and time.monotonic() < deadline:
                time.sleep(0.01)
        result = {"protocolVersion":"2024-11-05","capabilities":{"resources":{}},"serverInfo":{"name":"apps-fixture","version":"1"}}
    elif method == "tools/list":
        if mode == "cancel-list":
            (root / "list-started").write_text("ready", encoding="utf-8")
            time.sleep(5)
        result = {"tools":[
            {"name":"chart","description":"Chart data","inputSchema":{"type":"object"},"_meta":{"ui":{"resourceUri":"ui://fixture/chart","visibility":["model","app"]}}},
            {"name":"refresh","description":"App only","inputSchema":{"type":"object"},"_meta":{"ui":{"visibility":["app"]}}},
            {"name":"model_only","description":"Model only","inputSchema":{"type":"object"},"_meta":{"ui":{"visibility":["model"]}}}
        ]}
    elif method == "tools/call":
        if request.get("params", {}).get("arguments", {}).get("_fixture_delay"):
            (root / "action-started").write_text("ready", encoding="utf-8")
            time.sleep(5)
        result = {"content":[{"type":"text","text":"completed observation"}],"structuredContent":{"series":[1,2],"credential":"synthetic-ui-secret"},"_meta":{"uiOnly":"synthetic-ui-secret","revision":3}}
        if mode == "joint":
            value = request.get("params", {}).get("arguments", {}).get("value")
            result = {"content":[{"type":"text","text":"REAL_MCP_RESULT"}], "structuredContent":{"series":[1,2],"value":value}, "_meta":{"origin":"owned-real-mcp","revision":3}}
    elif method == "resources/list":
        if mode == "unsupported":
            error = {"code":-32601,"message":"method not found"}
        elif request.get("params",{}).get("cursor") == "page-2":
            result = {"resources":[]}
        else:
            result = {"resources":[{"uri":"ui://fixture/chart","name":"chart","mimeType":"text/html;profile=mcp-app"}],"nextCursor":"page-2"}
    elif method == "resources/read":
        html = "<!DOCTYPE html><html><body>synthetic-ui-secret<div id='chart'></div></body></html>"
        resource = {"uri":"ui://fixture/chart","mimeType":"text/html;profile=mcp-app","text":html,"_meta":{"ui":{"csp":{"connectDomains":["https://api.example.test"],"resourceDomains":[]},"permissions":{"clipboardWrite":{}},"prefersBorder":True}}}
        if mode == "wrong-uri":
            resource["uri"] = "ui://another-source/chart"
        elif mode == "wrong-mime":
            resource["mimeType"] = "text/plain"
        elif mode == "oversize":
            resource["text"] = "<html>" + "a" * (512 * 1024) + "</html>"
        elif mode == "blob":
            resource["blob"] = base64.b64encode(resource.pop("text").encode()).decode()
        elif mode == "cancel":
            (root / "read-started").write_text("ready",encoding="utf-8")
            time.sleep(5)
        elif mode == "revoke-after-resource":
            (root / "ui-resource-returned").write_text("ready", encoding="utf-8")
        if mode == "joint":
            if request.get("params", {}).get("uri") == "fixture://source/data":
                resource = {"uri":"fixture://source/data","mimeType":"text/plain","text":"REAL_MCP_RESOURCE:" + "x" * 70000}
            else:
                resource["text"] = (pathlib.Path(__file__).parent / "joint_app.html").read_text(encoding="utf-8")
                resource["_meta"] = {"ui":{"csp":{},"permissions":{},"prefersBorder":True}}
        result = {"contents":[resource]}
    else:
        error = {"code":-32601,"message":"method not found"}
    response = {"jsonrpc":"2.0","id":request["id"]}
    response["error" if error else "result"] = error if error else result
    write(response)

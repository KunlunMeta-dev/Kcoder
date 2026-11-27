use serde_json::{Value, json};
use std::fs::OpenOptions;
use std::io::{self, BufRead, Write};
use std::path::Path;

fn record(marker: &Path, value: &Value) -> io::Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(marker)?;
    writeln!(file, "{value}")
}

fn validate_request(request: &Value, step: usize) -> Result<&str, Box<dyn std::error::Error>> {
    let object = request
        .as_object()
        .ok_or("JSON-RPC envelope 必须是 object")?;
    if request["jsonrpc"] != "2.0" {
        return Err("jsonrpc 必须是 2.0".into());
    }
    let method = request["method"].as_str().ok_or("method 必须是 string")?;
    let expected = match step {
        0 => ("initialize", Some(1_u64)),
        1 => ("notifications/initialized", None),
        2 => ("tools/list", Some(2_u64)),
        3 => ("tools/call", Some(3_u64)),
        _ => return Err("收到超出 fixture 协议的额外请求".into()),
    };
    let common_envelope = object.contains_key("jsonrpc")
        && object.contains_key("method")
        && object.contains_key("params");
    let id_matches = expected.1.map_or_else(
        || object.len() == 3 && !object.contains_key("id"),
        |id| object.len() == 4 && request["id"] == id,
    );
    if !common_envelope || !id_matches {
        return Err("JSON-RPC request/notification envelope 字段错误".into());
    }
    if method != expected.0 || !id_matches {
        return Err(format!("请求顺序或 id 错误: step={step}, method={method}").into());
    }
    match method {
        "initialize" => {
            let params = request["params"]
                .as_object()
                .ok_or("initialize params 必须是 object")?;
            if params.len() != 3
                || params.get("protocolVersion") != Some(&json!("2024-11-05"))
                || params.get("capabilities") != Some(&json!({}))
            {
                return Err("initialize protocolVersion/capabilities 错误".into());
            }
            let client = params["clientInfo"]
                .as_object()
                .ok_or("clientInfo 必须是 object")?;
            if client.len() != 2
                || client.get("name") != Some(&json!("kcoder"))
                || client.get("version") != Some(&json!(env!("CARGO_PKG_VERSION")))
            {
                return Err("initialize clientInfo 错误".into());
            }
        }
        "notifications/initialized" | "tools/list" => {
            if request["params"] != json!({}) {
                return Err(format!("{method} params 必须是空 object").into());
            }
        }
        "tools/call" => {
            if request["params"] != json!({"name": "echo", "arguments": {"text": "跨进程回声"}})
            {
                return Err("tools/call params 错误".into());
            }
        }
        _ => unreachable!(),
    }
    Ok(method)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let flag = args.next().ok_or("缺少 --marker 参数")?;
    if flag != "--marker" {
        return Err("首个参数必须是 --marker".into());
    }
    let marker = args.next().ok_or("缺少 marker 路径")?;
    let marker = Path::new(&marker);
    let pid = std::process::id();
    record(marker, &json!({"pid": pid, "method": "started"}))?;

    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for (step, line) in stdin.lock().lines().enumerate() {
        let request: Value = serde_json::from_str(&line?)?;
        let method = validate_request(&request, step)?.to_string();
        record(
            marker,
            &json!({"pid": pid, "method": method, "request": request}),
        )?;

        let Some(id) = request.get("id").filter(|id| !id.is_null()) else {
            continue;
        };
        let result = match method.as_str() {
            "initialize" => json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fixture-mcp", "version": "1.0.0"}
            }),
            "tools/list" => json!({"tools": [{
                "name": "echo",
                "description": "返回输入文本",
                "inputSchema": {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"]
                }
            }]}),
            "tools/call" => {
                if request["params"]["name"] != "echo" {
                    return Err("仅支持 echo 工具".into());
                }
                let text = request["params"]["arguments"]["text"]
                    .as_str()
                    .ok_or("echo 缺少 text")?;
                json!({"content": [{"type": "text", "text": text}], "isError": false})
            }
            _ => return Err(format!("未知方法: {method}").into()),
        };
        writeln!(
            stdout,
            "{}",
            json!({"jsonrpc": "2.0", "id": id, "result": result})
        )?;
        stdout.flush()?;
    }
    Ok(())
}

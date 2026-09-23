use kcoder_mcp::{StreamableHttpTransport, client::McpClient, transport::SseTransport};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    process::{Command, Stdio},
};
struct Server(std::process::Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[tokio::test]
async fn real_stdio_sse_http_pages_call_and_fail_closed() {
    let script_path = std::path::PathBuf::from(
        std::env::var_os("KCODER_WORKSPACE_ROOT").expect("Cargo must provide the workspace root"),
    ).join("crates/kcoder_mcp/tests/fixtures/paged_server.py");
    let script = script_path.to_str().expect("fixture path must be UTF-8");
    for mode in ["stdio", "sse", "http"] {
        for scenario in ["ok", "cycle", "failure", "large"] {
            let mut owned = None;
            let mut client = if mode == "stdio" {
                McpClient::new(
                    "python3",
                    &[script.into(), mode.into(), scenario.into()],
                    &HashMap::new(),
                )
                .await
                .unwrap()
            } else {
                let mut child = Command::new("python3")
                    .args([script, mode, scenario])
                    .stdout(Stdio::piped())
                    .spawn()
                    .unwrap();
                let mut port = String::new();
                BufReader::new(child.stdout.take().unwrap())
                    .read_line(&mut port)
                    .unwrap();
                owned = Some(Server(child));
                let url = format!("http://127.0.0.1:{}/mcp", port.trim());
                if mode == "sse" {
                    McpClient::with_transport(Box::new(SseTransport::new(&url).await.unwrap()))
                } else {
                    McpClient::with_transport(Box::new(
                        StreamableHttpTransport::new(&url, &HashMap::new())
                            .await
                            .unwrap(),
                    ))
                }
            };
            client.initialize().await.unwrap();
            let result = client.list_tools().await;
            if scenario == "ok" {
                let tools = result.unwrap();
                assert_eq!(tools.len(), 2, "{mode}");
                for tool in tools {
                    let called = client
                        .call_tool(&tool.name, serde_json::json!({}))
                        .await
                        .unwrap();
                    assert_eq!(called.content[0].text.as_deref(), Some(tool.name.as_str()));
                }
            } else {
                if scenario == "large" {
                    assert!(
                        result.as_ref().unwrap_err().to_string().contains("16 MiB"),
                        "{mode}: {result:?}"
                    );
                }
                assert!(
                    result.is_err(),
                    "{mode}/{scenario} must not return partial catalog"
                );
            }
            drop(client);
            drop(owned);
        }
    }
}

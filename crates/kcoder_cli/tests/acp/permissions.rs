//! Exercise actual Engine decisions and writes through the ACP permission channel.
use super::acp_session_mcp::{receive, request_body, send};
use serde_json::{Value, json};
use std::{collections::BTreeMap, ffi::OsString, path::Path, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

fn launch(root: &Path, endpoint: &str) -> kcoder_acp::AgentInfo {
    let environment: BTreeMap<OsString, OsString> = [
        ("HOME".into(), root.as_os_str().to_owned()),
        (
            "KCODER_CONFIG_DIR".into(),
            root.join("config").into_os_string(),
        ),
        ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
    ]
    .into_iter()
    .collect();
    super::write_direct_transport_settings(&root.join("config"));
    let trust = std::process::Command::new(super::kcoder_binary())
        .env_clear()
        .envs(&environment)
        .args(["trust", "add", "--path"])
        .arg(root)
        .output()
        .unwrap();
    assert!(
        trust.status.success(),
        "cannot prepare isolated trust fixture"
    );
    kcoder_acp::AgentInfo {
        version: "test".into(),
        app_server: Some(kcoder_acp::AppServerConfig {
            executable: super::kcoder_binary().into(),
            environment: Some(environment),
            args: [
                "app-server",
                "--training-mode",
                "--provider",
                "local",
                "--model",
                "fixture",
                "--max-retries",
                "0",
                "--local-base-url",
                endpoint,
                "--permission-mode",
                "ask",
            ]
            .into_iter()
            .map(Into::into)
            .collect(),
        }),
    }
}

async fn model_reply(stream: &mut tokio::net::TcpStream, delta: Value, reason: &str) {
    let chunk = json!({"id":"permission-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
    let stop = json!({"id":"permission-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":reason}]});
    let response = format!("data: {chunk}\n\ndata: {stop}\n\ndata: [DONE]\n\n");
    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await.unwrap();
}

fn write_call(id: &str, path: &Path, content: &str) -> Value {
    json!({"role":"assistant","tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":"write","arguments":json!({"file_path":path,"content":content}).to_string()}}]})
}

#[tokio::test]
async fn acp_authentication_errors_are_typed_actionable_and_do_not_echo_provider_diagnostics() {
    for missing_key in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let provider = tokio::spawn(async move {
            let accepted = tokio::time::timeout(
                Duration::from_secs(if missing_key { 3 } else { 30 }),
                listener.accept(),
            )
            .await;
            let Ok(Ok((mut stream, _))) = accepted else {
                return false;
            };
            request_body(&mut stream).await;
            let body = r#"{"error":{"type":"authentication_error","message":"SENTINEL_PRIVATE_PROVIDER_DIAGNOSTIC"}}"#;
            stream.write_all(format!("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            true
        });
        let mut info = launch(root.path(), &endpoint);
        if missing_key {
            let args = &mut info.app_server.as_mut().unwrap().args;
            let provider = args.iter().position(|arg| arg == "--provider").unwrap() + 1;
            args[provider] = "openai".into();
            // Even a regression must stay on loopback instead of calling a real service.
            args.extend(["--openai-base-url".into(), endpoint.into()]);
        }
        let (client, server) = tokio::io::duplex(65536);
        let (input, output) = tokio::io::split(server);
        let adapter = tokio::spawn(kcoder_acp::serve(BufReader::new(input), output, info));
        let (read, mut write) = tokio::io::split(client);
        let mut frames = BufReader::new(read).lines();
        send(
            &mut write,
            json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1}}),
        )
        .await;
        receive(&mut frames).await;
        send(&mut write, json!({"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":root.path(),"mcpServers":[]}})).await;
        let created = receive(&mut frames).await;
        assert!(created.get("error").is_none(), "{created}");
        send(&mut write, json!({"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":created["result"]["sessionId"],"prompt":[{"type":"text","text":"Run the authentication fixture"}]}})).await;
        loop {
            let frame = receive(&mut frames).await;
            assert!(
                !frame.to_string().contains("SENTINEL_PRIVATE"),
                "private response leaked"
            );
            if frame["id"] == 2 {
                assert_eq!(frame["error"]["code"], -32000, "{frame}");
                assert_eq!(
                    frame["error"]["data"]["provider_failure"]["category"],
                    "authentication_error"
                );
                assert_eq!(
                    frame["error"]["data"]["provider_failure"]["retryable"],
                    false
                );
                assert!(
                    frame["error"]["data"]["guidance"]
                        .as_str()
                        .unwrap()
                        .contains("auth login")
                );
                break;
            }
        }
        write.shutdown().await.unwrap();
        tokio::time::timeout(Duration::from_secs(15), adapter)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            provider.await.unwrap(),
            !missing_key,
            "missing credentials must fail before an HTTP call"
        );
    }
}

#[tokio::test]
async fn acp_cancel_reaches_the_actual_provider_while_client_output_is_not_read() {
    let root = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let (closed_sender, mut closed) = tokio::sync::oneshot::channel();
    let provider = tokio::spawn(async move {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
            .await
            .unwrap()
            .unwrap();
        request_body(&mut stream).await;
        let delta = json!({"id":"backpressure-probe","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Controlled stream started"},"finish_reason":null}]});
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {delta}\n\n").as_bytes()).await.unwrap();
        stream.flush().await.unwrap();
        let mut byte = [0];
        let was_closed = tokio::time::timeout(Duration::from_secs(20), stream.read(&mut byte))
            .await
            .is_ok_and(|result| matches!(result, Ok(0) | Err(_)));
        let _ = closed_sender.send(was_closed);
    });
    let info = launch(root.path(), &endpoint);
    let (client, server) = tokio::io::duplex(1024);
    let (input, output) = tokio::io::split(server);
    let adapter = tokio::spawn(kcoder_acp::serve(BufReader::new(input), output, info));
    let (read, mut write) = tokio::io::split(client);
    let mut frames = BufReader::new(read).lines();
    send(
        &mut write,
        json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1}}),
    )
    .await;
    receive(&mut frames).await;
    send(&mut write, json!({"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":root.path(),"mcpServers":[]}})).await;
    let created = receive(&mut frames).await;
    assert!(created.get("error").is_none(), "{created}");
    let session = created["result"]["sessionId"].as_str().unwrap();
    send(&mut write, json!({"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":session,"prompt":[{"type":"text","text":"Wait in the controlled provider stream"}]}})).await;
    loop {
        let frame = receive(&mut frames).await;
        if frame["params"]["update"]["content"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("Controlled stream started"))
        {
            break;
        }
        assert!(frame.get("error").is_none(), "{frame}");
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut closed)
            .await
            .is_err()
    );
    // Stop reading: 400 bounded errors exceed the 256-frame output queue and
    // 1 KiB pipe, but the remaining input fits within the independent input queue.
    for id in 1000..1400 {
        send(
            &mut write,
            json!({"jsonrpc":"2.0","id":id,"method":"unhandled"}),
        )
        .await;
    }
    send(
        &mut write,
        json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}}),
    )
    .await;
    assert!(
        tokio::time::timeout(Duration::from_secs(5), &mut closed)
            .await
            .expect("cancel was trapped behind response backpressure")
            .unwrap()
    );
    let mut replies = std::collections::BTreeSet::new();
    let mut cancelled = false;
    tokio::time::timeout(Duration::from_secs(15), async {
        while replies.len() < 400 || !cancelled {
            let frame = receive(&mut frames).await;
            if frame["id"] == 2 {
                assert_eq!(frame["result"]["stopReason"], "cancelled", "{frame}");
                cancelled = true;
            } else if let Some(id) = frame["id"].as_u64()
                && (1000..1400).contains(&id)
            {
                assert_eq!(frame["error"]["code"], -32601);
                assert!(replies.insert(id), "duplicate response");
            }
        }
    })
    .await
    .expect("queued responses did not resume after reading restarted");
    write.shutdown().await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), adapter)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    provider.await.unwrap();
}

#[tokio::test]
async fn acp_approval_allow_once_does_not_grant_the_next_write_and_denial_preserves_the_file() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("审批 文件.txt");
    let target = file.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let provider = tokio::spawn(async move {
        for step in 0..3 {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let request = request_body(&mut stream).await;
            let tools = request["tools"].as_array().unwrap();
            assert!(tools.iter().any(|tool| tool["function"]["name"] == "write"));
            assert!(!tools.iter().any(|tool| matches!(
                tool["function"]["name"].as_str(),
                Some("AskUserQuestion" | "EnterPlanMode" | "ExitPlanMode")
            )));
            match step {
                0 => {
                    model_reply(
                        &mut stream,
                        write_call("write-first", &target, "first result"),
                        "tool_calls",
                    )
                    .await
                }
                1 => {
                    model_reply(
                        &mut stream,
                        write_call("write-second", &target, "must be rejected"),
                        "tool_calls",
                    )
                    .await
                }
                _ => {
                    model_reply(
                        &mut stream,
                        json!({"content":"Permission fixture finished"}),
                        "stop",
                    )
                    .await
                }
            }
        }
    });
    let info = launch(root.path(), &endpoint);
    let (client, server) = tokio::io::duplex(65536);
    let (input, output) = tokio::io::split(server);
    let adapter = tokio::spawn(kcoder_acp::serve(BufReader::new(input), output, info));
    let (read, mut write) = tokio::io::split(client);
    let mut frames = BufReader::new(read).lines();
    send(
        &mut write,
        json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1}}),
    )
    .await;
    receive(&mut frames).await;
    send(&mut write,json!({"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":root.path(),"mcpServers":[]}})).await;
    let created = receive(&mut frames).await;
    assert!(created.get("error").is_none(), "{created}");
    let session = created["result"]["sessionId"].as_str().unwrap();
    send(&mut write,json!({"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":session,"prompt":[{"type":"text","text":"Run two controlled writes"}]}})).await;
    let mut decisions = 0;
    let mut calls = Vec::new();
    let mut started = BTreeMap::new();
    let mut statuses = BTreeMap::new();
    loop {
        let frame = receive(&mut frames).await;
        if frame["method"] == "session/request_permission" {
            assert_eq!(frame["params"]["sessionId"], session);
            let expected = frame["params"]["toolCall"]["toolCallId"].as_str().unwrap();
            assert!(!calls.iter().any(|call| call == expected));
            calls.push(expected.to_owned());
            assert_eq!(frame["params"]["options"].as_array().unwrap().len(), 2);
            assert_eq!(started.get(expected), Some(&1));
            if decisions == 1 {
                assert_eq!(std::fs::read_to_string(&file).unwrap(), "first result");
            }
            send(&mut write,json!({"jsonrpc":"2.0","id":frame["id"],"result":{"outcome":{"outcome":"selected","optionId":if decisions==0 {"allow_once"} else {"reject_once"}}}})).await;
            decisions += 1;
        } else if frame["method"] == "session/update" {
            let update = &frame["params"]["update"];
            if let Some(id) = update["toolCallId"].as_str() {
                if update["sessionUpdate"] == "tool_call" {
                    *started.entry(id.to_owned()).or_insert(0) += 1;
                }
                if let Some(status) = update["status"].as_str() {
                    statuses.insert(id.to_owned(), status.to_owned());
                }
            }
        } else if frame["id"] == 2 {
            assert_eq!(frame["result"]["stopReason"], "end_turn", "{frame}");
            break;
        }
    }
    assert_eq!(decisions, 2);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "first result");
    assert_eq!(statuses[&calls[0]], "completed");
    assert_eq!(statuses[&calls[1]], "failed");
    write.shutdown().await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), adapter)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    provider.await.unwrap();
    let mut audited = std::collections::BTreeSet::new();
    for entry in walkdir::WalkDir::new(root.path())
        .into_iter()
        .filter_map(Result::ok)
    {
        if entry
            .path()
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == "approval-decisions")
            && entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "json")
        {
            let value: Value =
                serde_json::from_slice(&std::fs::read(entry.path()).unwrap()).unwrap();
            audited.insert(
                value["tool_call_id"]
                    .as_str()
                    .expect("approval receipt lost its exact call ID")
                    .to_owned(),
            );
        }
    }
    assert_eq!(
        audited,
        std::collections::BTreeSet::from(["write-first".to_owned(), "write-second".to_owned()])
    );
}

#[tokio::test]
async fn acp_approval_cancel_then_late_allow_never_writes_or_starts_another_model_request() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("cancelled.txt");
    let target = file.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let provider = tokio::spawn(async move {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
            .await
            .unwrap()
            .unwrap();
        request_body(&mut stream).await;
        model_reply(
            &mut stream,
            write_call("write-cancelled", &target, "must never exist"),
            "tool_calls",
        )
        .await;
        drop(stream);
        tokio::time::timeout(Duration::from_secs(2), listener.accept())
            .await
            .is_err()
    });
    let info = launch(root.path(), &endpoint);
    let (client, server) = tokio::io::duplex(65536);
    let (input, output) = tokio::io::split(server);
    let adapter = tokio::spawn(kcoder_acp::serve(BufReader::new(input), output, info));
    let (read, mut write) = tokio::io::split(client);
    let mut frames = BufReader::new(read).lines();
    send(
        &mut write,
        json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1}}),
    )
    .await;
    receive(&mut frames).await;
    send(&mut write,json!({"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":root.path(),"mcpServers":[]}})).await;
    let created = receive(&mut frames).await;
    assert!(created.get("error").is_none(), "{created}");
    let session = created["result"]["sessionId"].as_str().unwrap();
    send(&mut write,json!({"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":session,"prompt":[{"type":"text","text":"Run a controlled write"}]}})).await;
    let permission = loop {
        let frame = receive(&mut frames).await;
        if frame["method"] == "session/request_permission" {
            break frame;
        }
    };
    send(
        &mut write,
        json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}}),
    )
    .await;
    loop {
        let frame = receive(&mut frames).await;
        if frame["id"] == 2 {
            assert_eq!(frame["result"]["stopReason"], "cancelled", "{frame}");
            break;
        }
    }
    send(&mut write,json!({"jsonrpc":"2.0","id":permission["id"],"result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}})).await;
    write.shutdown().await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), adapter)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(!file.exists());
    assert!(
        provider.await.unwrap(),
        "a cancelled approval triggered another provider request"
    );
}

#[tokio::test]
async fn acp_approval_native_timeout_settles_without_waiting_for_a_client_response() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("timeout.txt");
    let target = file.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let provider = tokio::spawn(async move {
        for step in 0..2 {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
                .await
                .unwrap()
                .unwrap();
            request_body(&mut stream).await;
            if step == 0 {
                model_reply(
                    &mut stream,
                    write_call("write-timeout", &target, "must not exist"),
                    "tool_calls",
                )
                .await;
            } else {
                model_reply(
                    &mut stream,
                    json!({"content":"Timed out operation was not executed"}),
                    "stop",
                )
                .await;
            }
        }
    });
    let mut info = launch(root.path(), &endpoint);
    info.app_server
        .as_mut()
        .unwrap()
        .environment
        .as_mut()
        .unwrap()
        .insert("KCODER_E2E_APPROVAL_TIMEOUT_MS".into(), "1000".into());
    let (client, server) = tokio::io::duplex(65536);
    let (input, output) = tokio::io::split(server);
    let adapter = tokio::spawn(kcoder_acp::serve(BufReader::new(input), output, info));
    let (read, mut write) = tokio::io::split(client);
    let mut frames = BufReader::new(read).lines();
    send(
        &mut write,
        json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1}}),
    )
    .await;
    receive(&mut frames).await;
    send(&mut write,json!({"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":root.path(),"mcpServers":[]}})).await;
    let created = receive(&mut frames).await;
    assert!(created.get("error").is_none(), "{created}");
    let session = created["result"]["sessionId"].as_str().unwrap();
    send(&mut write,json!({"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":session,"prompt":[{"type":"text","text":"Run timeout fixture"}]}})).await;
    let permission = loop {
        let frame = receive(&mut frames).await;
        if frame["method"] == "session/request_permission" {
            break frame;
        }
    };
    let mut failed = false;
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let frame = receive(&mut frames).await;
            if frame["params"]["update"]["toolCallId"]
                == permission["params"]["toolCall"]["toolCallId"]
                && frame["params"]["update"]["status"] == "failed"
            {
                failed = true;
            }
            if frame["id"] == 2 {
                assert_eq!(frame["result"]["stopReason"], "end_turn", "{frame}");
                break;
            }
        }
    })
    .await
    .expect("native timeout was hidden by the permission wait");
    assert!(failed);
    send(&mut write,json!({"jsonrpc":"2.0","id":permission["id"],"result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}})).await;
    write.shutdown().await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), adapter)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    provider.await.unwrap();
    assert!(!file.exists());
}

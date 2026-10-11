//! Real Provider -> Engine -> app-server progress before the upstream terminal frame.

use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy)]
enum ProgressWire {
    Anthropic,
    GenAiChat,
}

struct ToolInputStreamFixture {
    endpoint: String,
    advance: Option<mpsc::Sender<()>>,
    stop: std::sync::Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Drop for ToolInputStreamFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        drop(self.advance.take());
        let result = self.worker.take().unwrap().join();
        if !std::thread::panicking() {
            result.unwrap();
        }
    }
}

fn progress_fixture_chunk(socket: &mut std::net::TcpStream, body: &str) {
    write!(socket, "{:x}\r\n{body}\r\n", body.len()).unwrap();
    socket.flush().unwrap();
}

fn progress_fixture_event(socket: &mut std::net::TcpStream, event: &str, data: Value) {
    progress_fixture_chunk(socket, &format!("event: {event}\ndata: {data}\n\n"));
}

fn progress_fixture_delta(socket: &mut std::net::TcpStream, wire: ProgressWire, part: &str) {
    match wire {
        ProgressWire::Anthropic => progress_fixture_event(
            socket,
            "content_block_delta",
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":part}}),
        ),
        ProgressWire::GenAiChat => progress_fixture_chunk(
            socket,
            &format!(
                "data: {}\n\n",
                json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":part}}]},"finish_reason":null}]})
            ),
        ),
    }
}

fn progress_fixture_start(socket: &mut std::net::TcpStream, wire: ProgressWire) {
    write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
    match wire {
        ProgressWire::Anthropic => {
            progress_fixture_event(
                socket,
                "message_start",
                json!({"type":"message_start","message":{"id":"progress-message","type":"message","role":"assistant","content":[],"model":"fixture-model","usage":{"input_tokens":1,"output_tokens":0}}}),
            );
            progress_fixture_event(
                socket,
                "content_block_start",
                json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"early-write","name":"write","input":{}}}),
            );
        }
        ProgressWire::GenAiChat => progress_fixture_chunk(
            socket,
            &format!(
                "data: {}\n\n",
                json!({"id":"progress-message","model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"early-write","type":"function","function":{"name":"write","arguments":""}}]},"finish_reason":null}]})
            ),
        ),
    }
}

fn progress_fixture_terminal(socket: &mut std::net::TcpStream, wire: ProgressWire) {
    match wire {
        ProgressWire::Anthropic => {
            progress_fixture_event(
                socket,
                "content_block_stop",
                json!({"type":"content_block_stop","index":0}),
            );
            progress_fixture_event(
                socket,
                "message_delta",
                json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}),
            );
            progress_fixture_event(socket, "message_stop", json!({"type":"message_stop"}));
        }
        ProgressWire::GenAiChat => progress_fixture_chunk(
            socket,
            &format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})
            ),
        ),
    }
    socket.write_all(b"0\r\n\r\n").unwrap();
    socket.flush().unwrap();
}

fn progress_fixture_final_answer(socket: &mut std::net::TcpStream, wire: ProgressWire) {
    write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
    match wire {
        ProgressWire::Anthropic => {
            progress_fixture_event(
                socket,
                "message_start",
                json!({"type":"message_start","message":{"id":"final-message","type":"message","role":"assistant","content":[],"model":"fixture-model","usage":{"input_tokens":2,"output_tokens":0}}}),
            );
            progress_fixture_event(
                socket,
                "content_block_start",
                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            );
            progress_fixture_event(
                socket,
                "content_block_delta",
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done"}}),
            );
            progress_fixture_event(
                socket,
                "content_block_stop",
                json!({"type":"content_block_stop","index":0}),
            );
            progress_fixture_event(
                socket,
                "message_delta",
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}),
            );
            progress_fixture_event(socket, "message_stop", json!({"type":"message_stop"}));
        }
        ProgressWire::GenAiChat => progress_fixture_chunk(
            socket,
            &format!(
                "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                json!({"choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":null}]}),
                json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})
            ),
        ),
    }
    socket.write_all(b"0\r\n\r\n").unwrap();
    socket.flush().unwrap();
}

fn tool_input_stream_fixture(wire: ProgressWire) -> ToolInputStreamFixture {
    use std::io::Read;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let (advance, gate) = mpsc::channel();
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let worker = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut model_calls = 0;
        while model_calls < 2 && !stopped.load(Ordering::SeqCst) {
            assert!(
                Instant::now() < deadline,
                "progress fixture request timed out"
            );
            let mut socket = match listener.accept() {
                Ok((socket, _)) => socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(error) => panic!("progress fixture accept: {error}"),
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
                assert!(
                    bytes.len() <= 65536,
                    "progress fixture header exceeds budget"
                );
            }
            let header = String::from_utf8(bytes).unwrap().to_ascii_lowercase();
            if !header.starts_with("post ") {
                write!(
                    socket,
                    "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
                continue;
            }
            assert!(
                header.contains("fixture-only-stream-progress"),
                "progress fixture must receive only its synthetic credential"
            );
            let body = read_fixture_request_body(&mut socket, &header);
            let request: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(request["model"], "fixture-model");
            model_calls += 1;
            if model_calls == 2 {
                progress_fixture_final_answer(&mut socket, wire);
                continue;
            }
            progress_fixture_start(&mut socket, wire);
            // Keep the whole input below 128 bytes, while forcing two visible lines.
            for part in [r#"{"file_path":"streamed.txt","content":"one"#, r#"\ntwo"#] {
                progress_fixture_delta(&mut socket, wire, part);
                loop {
                    match gate.recv_timeout(Duration::from_millis(50)) {
                        Ok(()) => break,
                        Err(mpsc::RecvTimeoutError::Timeout)
                            if !stopped.load(Ordering::SeqCst) && Instant::now() < deadline => {}
                        _ => return,
                    }
                }
            }
            progress_fixture_delta(&mut socket, wire, "\\n\"}");
            progress_fixture_terminal(&mut socket, wire);
        }
    });
    ToolInputStreamFixture {
        endpoint,
        advance: Some(advance),
        stop,
        worker: Some(worker),
    }
}

fn assert_tool_lines_reach_stdio_before_provider_terminal(wire: ProgressWire) {
    let temporary = tempfile::tempdir().unwrap();
    let workspace = temporary.path().join("workspace");
    let config = temporary.path().join("profile");
    std::fs::create_dir_all(&workspace).unwrap();
    let fixture = tool_input_stream_fixture(wire);
    let settings = temporary.path().join("settings.json");
    let format = match wire {
        ProgressWire::Anthropic => "anthropic_messages",
        ProgressWire::GenAiChat => "openai_chat_completions",
    };
    std::fs::write(&settings, serde_json::to_vec(&json!({
        "active_provider":"progress-fixture", "permission_mode":"bypass", "max_retries":0,
        "session_memory":{"enabled":false},
        "providers":{"progress-fixture":{
            "api_format":format, "endpoint":fixture.endpoint, "default_model":"fixture-model",
            "authentication":{"mode":"api_key"}, "credential_env":["KCODER_STREAM_PROGRESS_FIXTURE_KEY"],
            "chat_protocol":"standard", "context_window_tokens":128000,
            "output_headroom_tokens":8192, "max_output_tokens":8192,
            "request_timeout_secs":20, "no_proxy":true
        }}
    })).unwrap()).unwrap();
    let mut builder = TestAppServer::builder(&workspace, &settings)
        .config_dir(&config)
        .without_scenario();
    builder.training_mode = true;
    // Explicit fixture values prevent inherited developer credentials/endpoints
    // from reaching the test transport; no global environment is changed.
    for name in [
        "KCODER_STREAM_PROGRESS_FIXTURE_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
    ] {
        builder
            .extra_env
            .push((name.into(), "fixture-only-stream-progress".into()));
    }
    for name in ["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"] {
        builder
            .extra_env
            .push((name.into(), fixture.endpoint.clone().into()));
    }
    builder
        .extra_env
        .push(("KCODER_PROVIDER".into(), "progress-fixture".into()));
    builder
        .extra_env
        .push(("KCODER_PERMISSION_MODE".into(), "bypass".into()));
    for name in [
        "KCODER_USE_ANTHROPIC",
        "KCODER_USE_OPENAI",
        "KCODER_USE_LOCAL",
        "KCODER_USE_VLLM",
        "KCODER_USE_SGLANG",
        "KCODER_USE_GEMINI",
        "KCODER_USE_GROK",
        "KCODER_USE_KUNLUNMETA",
    ] {
        builder.extra_env.push((name.into(), "0".into()));
    }
    let mut server = builder.spawn();
    server.initialize(1);
    server.send(json!({"id":2,"method":"thread/start","params":{}}));
    let thread = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":3,"method":"turn/start","params":{"threadId":thread,"input":[{"type":"text","text":"Create streamed.txt with the complete supplied content"}]}}));
    let accepted = server.response(3);
    assert!(accepted.get("error").is_none(), "{accepted}");
    let turn = accepted["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let deadline = Instant::now() + Duration::from_secs(15);
    for expected in [1, 2] {
        loop {
            let value = server.next_value(deadline);
            eprintln!(
                "progress fixture gate={expected} method={} item={} event={} id={} chars={:?} generated={:?}",
                value["method"].as_str().unwrap_or("-"),
                value["params"]["item"]["type"].as_str().unwrap_or("-"),
                value["params"]["event"]["type"].as_str().unwrap_or("-"),
                value["params"]["event"]["id"].as_str().unwrap_or("-"),
                value["params"]["event"]["chars"].as_u64(),
                value["params"]["event"]["lines"]["generatedLines"].as_u64(),
            );
            assert!(
                !(value["method"] == "item/started"
                    && value["params"]["item"]["type"] == "toolCall"),
                "tool execution was projected before its upstream input completed"
            );
            assert_ne!(value["method"], "turn/completed", "{value}");
            let event = &value["params"]["event"];
            if value["method"] == "item/event"
                && event["type"] == "tool_input_progress"
                && event["lines"]["generatedLines"] == expected
            {
                assert_eq!(event["id"], "early-write");
                assert_eq!(value["params"]["threadId"], thread);
                assert_eq!(value["params"]["turnId"], turn);
                assert!(event["chars"].as_u64().unwrap() < 128);
                assert!(!workspace.join("streamed.txt").exists());
                fixture.advance.as_ref().unwrap().send(()).unwrap();
                break;
            }
        }
    }
    let mut tool_started = false;
    loop {
        let value = server.next_value(deadline);
        if value["method"] == "item/started" && value["params"]["item"]["id"] == "early-write" {
            tool_started = true;
        }
        if value["method"] == "turn/completed" {
            assert_eq!(value["params"]["turn"]["status"], "completed", "{value}");
            break;
        }
    }
    assert!(tool_started);
    assert_eq!(
        std::fs::read_to_string(workspace.join("streamed.txt")).unwrap(),
        "one\ntwo\n"
    );
    server.shutdown_successfully();
}

#[test]
fn anthropic_tool_lines_reach_stdio_before_provider_terminal() {
    assert_tool_lines_reach_stdio_before_provider_terminal(ProgressWire::Anthropic);
}

#[test]
fn genai_chat_tool_lines_reach_stdio_before_provider_terminal() {
    assert_tool_lines_reach_stdio_before_provider_terminal(ProgressWire::GenAiChat);
}

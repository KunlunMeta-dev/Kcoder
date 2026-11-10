//! Model-independent real HTTP Provider -> Engine -> JSONL widget persistence and recovery.
use super::tool_input_streaming::{
    ProgressWire, progress_fixture_delta, progress_fixture_final_text, progress_fixture_terminal,
    progress_fixture_tool_start,
};
use super::*;
use std::io::Read;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

struct WidgetFixture {
    endpoint: String,
    advance: Option<mpsc::Sender<()>>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Drop for WidgetFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        drop(self.advance.take());
        let result = self.worker.take().unwrap().join();
        if !std::thread::panicking() {
            result.unwrap();
        }
    }
}

pub(super) fn recorded_widget(value: &Value) -> Option<Value> {
    if value.get("status") == Some(&json!("committed")) && value.get("widget_id").is_some() {
        return Some(value.clone());
    }
    match value {
        Value::Object(object) => object.values().find_map(recorded_widget),
        Value::Array(array) => array.iter().find_map(recorded_widget),
        Value::String(text) => serde_json::Deserializer::from_str(text)
            .into_iter::<Value>()
            .filter_map(Result::ok)
            .find_map(|value| recorded_widget(&value)),
        _ => None,
    }
}

pub(super) fn render_observation_in_request(value: &Value) -> Option<Value> {
    if value.get("render_status").is_some() {
        return Some(value.clone());
    }
    match value {
        Value::Object(object) => object.values().find_map(render_observation_in_request),
        Value::Array(array) => array.iter().find_map(render_observation_in_request),
        Value::String(text) => serde_json::Deserializer::from_str(text)
            .into_iter::<Value>()
            .filter_map(Result::ok)
            .find_map(|value| render_observation_in_request(&value)),
        _ => None,
    }
}

fn widget_fixture() -> WidgetFixture {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let (advance, gate) = mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let worker = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(40);
        for call in 0..2 {
            let mut socket = loop {
                if stopped.load(Ordering::SeqCst) {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "widget fixture request timed out"
                );
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(error) => panic!("widget fixture accept: {error}"),
                }
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                header.push(byte[0]);
                assert!(header.len() <= 65536);
            }
            let header = String::from_utf8(header).unwrap().to_ascii_lowercase();
            assert!(header.starts_with("post ") && header.contains("fixture-only-widget-stream"));
            let request: Value =
                serde_json::from_slice(&read_fixture_request_body(&mut socket, &header)).unwrap();
            assert_eq!(request["model"], "fixture-model");
            if call == 1 {
                let receipt = recorded_widget(&request)
                    .expect("persisted widget receipt must reach provider");
                assert_eq!(
                    render_observation_in_request(&request)
                        .expect("active first-frame feedback must reach the next provider request")
                        ["render_status"],
                    "rendered"
                );
                let text = format!(
                    "Diagram ready.\n\n::kcoder-widget{{widget_id=\"{}\" revision={}}}",
                    receipt["widget_id"].as_str().unwrap(),
                    receipt["revision"]
                );
                progress_fixture_final_text(&mut socket, ProgressWire::Anthropic, &text);
                continue;
            }
            assert!(
                request["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|tool| tool["name"] == "show_widget")
            );
            progress_fixture_tool_start(
                &mut socket,
                ProgressWire::Anthropic,
                "show_widget",
                "live-widget",
            );
            let source = "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"20\" height=\"20\"/><text x=\"25\" y=\"20\">Second node</text></svg>";
            let input = json!({"title":"Live diagram", "summary":"Two elements", "format":"svg", "widget_code":source});
            let encoded = serde_json::to_string(&input).unwrap();
            let split = encoded.find("<text").unwrap();
            for (stage, part) in [&encoded[..split], &encoded[split..]]
                .into_iter()
                .enumerate()
            {
                // Independent network chunks cross the production preview throttle.
                if stage > 0 {
                    std::thread::sleep(Duration::from_millis(120));
                }
                progress_fixture_delta(&mut socket, ProgressWire::Anthropic, part);
                loop {
                    match gate.recv_timeout(Duration::from_millis(50)) {
                        Ok(()) => break,
                        Err(mpsc::RecvTimeoutError::Timeout)
                            if !stopped.load(Ordering::SeqCst) && Instant::now() < deadline => {}
                        _ => return,
                    }
                }
            }
            progress_fixture_terminal(&mut socket, ProgressWire::Anthropic);
        }
    });
    WidgetFixture {
        endpoint,
        advance: Some(advance),
        stop,
        worker: Some(worker),
    }
}

pub(super) fn widget_server(
    workspace: &std::path::Path,
    settings: &std::path::Path,
    config: &std::path::Path,
    endpoint: &str,
) -> TestAppServer {
    let mut builder = TestAppServer::builder(workspace, settings)
        .config_dir(config)
        .without_scenario();
    builder.training_mode = true;
    for name in [
        "KCODER_WIDGET_FIXTURE_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
    ] {
        builder
            .extra_env
            .push((name.into(), "fixture-only-widget-stream".into()));
    }
    for name in ["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"] {
        builder.extra_env.push((name.into(), endpoint.into()));
    }
    builder
        .extra_env
        .push(("KCODER_PROVIDER".into(), "widget-fixture".into()));
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
    builder.spawn()
}

pub(super) fn initialize_widgets(server: &mut TestAppServer, enabled: bool) {
    server.send(json!({"id":1,"method":"initialize","params":{
        "protocolVersion":"2026-07-27","clientInfo":{"name":"widget-protocol-fixture","version":"1"},
        "capabilities":{"experimental":{"studioWorkModesV1":enabled,"inlineWidgetsV1":enabled,"threadStreamContextV1":true}}
    }}));
    assert!(server.response(1).get("error").is_none());
}

pub(super) fn write_widget_settings(path: &std::path::Path, endpoint: &str, format: &str) {
    std::fs::write(path, serde_json::to_vec(&json!({
        "active_provider":"widget-fixture", "permission_mode":"bypass", "max_retries":0,
        "session_memory":{"enabled":false}, "providers":{"widget-fixture":{
            "api_format":format, "endpoint":endpoint, "default_model":"fixture-model",
            "authentication":{"mode":"api_key"}, "credential_env":["KCODER_WIDGET_FIXTURE_KEY"],
            "context_window_tokens":128000, "output_headroom_tokens":8192,"max_output_tokens":8192,
            "request_timeout_secs":25,"no_proxy":true
        }}
    })).unwrap()).unwrap();
}

#[test]
fn inline_widget_streams_before_execution_and_restores_authoritative_receipt() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let config = root.path().join("profile");
    let fixture = widget_fixture();
    let settings = root.path().join("settings.json");
    write_widget_settings(&settings, &fixture.endpoint, "anthropic_messages");
    let mut server = widget_server(&workspace, &settings, &config, &fixture.endpoint);
    initialize_widgets(&mut server, true);
    server.send(json!({"id":2,"method":"thread/start","params":{"studioWorkMode":"kworker"}}));
    let created = server.response(2);
    let thread = created["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(
        json!({"id":3,"method":"turn/start","params":{"threadId":thread,
        "clientPresentation":{"version":1,"studioWorkMode":"kworker","inlineWidgets":true},
        "input":[{"type":"text","text":"Show a two-element SVG diagram inline"}]}}),
    );
    let accepted = server.response(3);
    assert!(accepted.get("error").is_none(), "{accepted}");
    let turn = accepted["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let deadline = Instant::now() + Duration::from_secs(25);
    let mut last_bytes = 0;
    for stage in 0..2 {
        loop {
            let value = server.next_value(deadline);
            assert_ne!(value["method"], "turn/completed", "{value}");
            assert!(
                !(value["method"] == "item/started"
                    && value["params"]["item"]["type"] == "toolCall"),
                "tool ran before terminal frame"
            );
            let event = &value["params"]["event"];
            if value["method"] != "item/event" || event["type"] != "widget_input_preview" {
                continue;
            }
            let bytes = event["preview"]["bytes"].as_u64().unwrap();
            if bytes <= last_bytes {
                continue;
            }
            assert_eq!(event["id"], "live-widget");
            assert_eq!(value["params"]["threadId"], thread);
            assert_eq!(value["params"]["turnId"], turn);
            assert!(value["params"]["attemptId"].is_string());
            assert!(
                event["preview"]["source"]
                    .as_str()
                    .unwrap()
                    .starts_with("<svg")
            );
            if stage == 1 {
                assert!(
                    event["preview"]["source"]
                        .as_str()
                        .unwrap()
                        .contains("Second node")
                );
            }
            last_bytes = bytes;
            server.send(json!({"id":10+stage,"method":"widget/list","params":{"threadId":thread}}));
            assert_eq!(server.response(10 + stage)["result"]["widgets"], json!([]));
            fixture.advance.as_ref().unwrap().send(()).unwrap();
            break;
        }
    }
    let mut reference = None;
    loop {
        let value = server.next_value(deadline);
        if value["method"] == "item/completed" && value["params"]["item"]["id"] == "live-widget" {
            let widget = &value["params"]["item"]["widgetRef"];
            assert_eq!(widget["threadId"], thread);
            assert_eq!(widget["turnId"], turn);
            assert_eq!(value["params"]["attemptId"], widget["attemptId"]);
            assert!(value["params"]["attemptId"].is_string(), "{value}");
            assert_eq!(widget["toolCallId"], "live-widget");
            assert_eq!(widget["executionMode"], "managed");
            assert!(widget["sha256"].is_string(), "{value}");
            reference = Some(widget.clone());
            server.send(json!({"id":28,"method":"widget/render/receipt","params":{
                "widget":{"threadId":thread,"widgetId":widget["widgetId"],"revision":widget["revision"]},
                "turnId":turn,"attemptId":widget["attemptId"],"toolCallId":"live-widget","status":"rendered"
            }}));
            assert_eq!(server.response(28)["result"]["accepted"], true);
        }
        if value["method"] == "turn/completed" {
            assert_eq!(value["params"]["turn"]["status"], "completed", "{value}");
            break;
        }
    }
    let reference = reference.expect("trusted widget execution metadata");
    let read = json!({"threadId":thread,"widgetId":reference["widgetId"],"revision":reference["revision"]});
    server.send(json!({"id":20,"method":"widget/read","params":read}));
    let read_response = server.response(20);
    assert_eq!(
        read_response["result"]["widget"], reference,
        "{read_response}"
    );
    server.send(json!({"id":21,"method":"widget/content/read","params":read}));
    let content = server.response(21)["result"].clone();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content["dataBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), reference["sha256"]);
    assert!(String::from_utf8(bytes).unwrap().contains("Second node"));
    server.send(json!({"id":23,"method":"widget/render/receipt","params":{
        "widget":read,"turnId":turn,"attemptId":reference["attemptId"],"toolCallId":"live-widget",
        "status":"failed","errorCode":"render_failed"
    }}));
    assert_eq!(server.response(23)["result"]["accepted"], true);
    server.send(json!({"id":24,"method":"widget/read","params":read}));
    assert_eq!(
        server.response(24)["result"]["renderObservation"]["status"],
        "failed"
    );
    server.send(json!({"id":22,"method":"widget/read","params":{"threadId":"unowned-thread", "widgetId":reference["widgetId"],"revision":1}}));
    assert!(server.response(22).get("error").is_some());
    server.shutdown_successfully();
    let mut restored = widget_server(&workspace, &settings, &config, &fixture.endpoint);
    initialize_widgets(&mut restored, true);
    restored.send(json!({"id":2,"method":"thread/resume","params":{"threadId":thread}}));
    assert!(restored.response(2).get("error").is_none());
    restored.send(json!({"id":3,"method":"widget/read","params":read}));
    let recovered = restored.response(3);
    assert_eq!(recovered["result"]["widget"], reference);
    assert_eq!(
        recovered["result"]["renderObservation"]["errorCode"],
        "render_failed"
    );
    restored.shutdown_successfully();
    let mut legacy = widget_server(&workspace, &settings, &config, &fixture.endpoint);
    initialize_widgets(&mut legacy, false);
    legacy.send(json!({"id":2,"method":"thread/resume","params":{"threadId":thread}}));
    assert!(legacy.response(2).get("error").is_none());
    legacy.send(json!({"id":3,"method":"widget/read","params":read}));
    assert!(
        legacy.response(3)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("inlineWidgetsV1")
    );
    legacy.shutdown_successfully();
}

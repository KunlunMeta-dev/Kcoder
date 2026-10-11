//! Ordinary HTTP Provider barriers exercise the resident scheduler and event pump.
use super::*;
use std::sync::Condvar;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
struct ProviderBarrier {
    released: Mutex<bool>,
    changed: Condvar,
}

impl ProviderBarrier {
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.changed.notify_all();
    }

    fn wait(&self) {
        let (released, timeout) = self
            .changed
            .wait_timeout_while(
                self.released.lock().unwrap(),
                Duration::from_secs(15),
                |released| !*released,
            )
            .unwrap();
        assert!(
            *released && !timeout.timed_out(),
            "provider barrier timed out"
        );
    }
}

struct CompactBackgroundFixture {
    endpoint: String,
    calls: FixtureCalls,
    summary_entered: mpsc::Receiver<()>,
    agent_entered: mpsc::Receiver<()>,
    followup_entered: mpsc::Receiver<()>,
    summary: Arc<ProviderBarrier>,
    agent: Arc<ProviderBarrier>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Drop for CompactBackgroundFixture {
    fn drop(&mut self) {
        self.summary.release();
        self.agent.release();
        self.stop.store(true, Ordering::SeqCst);
        let result = self.worker.take().unwrap().join();
        if !std::thread::panicking() {
            result.unwrap();
        }
    }
}

fn compact_fixture_text(socket: &mut std::net::TcpStream, text: String) {
    let delta = json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]});
    let stop = json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
    compact_fixture_sse(socket, delta, stop);
}

fn compact_fixture_tool(socket: &mut std::net::TcpStream, name: &str, id: &str, input: Value) {
    let delta = json!({"choices":[{"index":0,"delta":{"tool_calls":[{
        "index":0,"id":id,"type":"function","function":{"name":name,"arguments":input.to_string()}
    }]},"finish_reason":null}]});
    let stop = json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]});
    compact_fixture_sse(socket, delta, stop);
}

fn compact_fixture_sse(socket: &mut std::net::TcpStream, delta: Value, stop: Value) {
    let start = json!({"id":"compact-fixture", "model":"fixture-model", "choices":[{
        "index":0,"delta":{"role":"assistant"},"finish_reason":null
    }]});
    let body = format!("data: {start}\n\ndata: {delta}\n\ndata: {stop}\n\ndata: [DONE]\n\n");
    write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
}

fn compact_background_fixture() -> CompactBackgroundFixture {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let calls = Arc::new(Mutex::new(Vec::new()));
    let summary = Arc::new(ProviderBarrier::default());
    let agent = Arc::new(ProviderBarrier::default());
    let stop = Arc::new(AtomicBool::new(false));
    let (summary_tx, summary_entered) = mpsc::channel();
    let (agent_tx, agent_entered) = mpsc::channel();
    let (followup_tx, followup_entered) = mpsc::channel();
    let recorded = calls.clone();
    let summary_gate = summary.clone();
    let agent_gate = agent.clone();
    let stopped = stop.clone();
    let worker = std::thread::spawn(move || {
        let mut handlers = Vec::new();
        while !stopped.load(Ordering::SeqCst) {
            let mut socket = match listener.accept() {
                Ok((socket, _)) => socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(error) => panic!("fixture accept failed: {error}"),
            };
            let recorded = recorded.clone();
            let summary_gate = summary_gate.clone();
            let agent_gate = agent_gate.clone();
            let summary_tx = summary_tx.clone();
            let agent_tx = agent_tx.clone();
            let followup_tx = followup_tx.clone();
            handlers.push(std::thread::spawn(move || {
                socket.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
                let mut bytes = Vec::new();
                while !bytes.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                    assert!(bytes.len() < 32 * 1024);
                }
                let header = String::from_utf8(bytes).unwrap().to_ascii_lowercase();
                if header.starts_with("head ") {
                    write!(socket,"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                    return;
                }
                let request: Value = serde_json::from_slice(&read_fixture_request_body(&mut socket, &header)).unwrap();
                recorded.lock().unwrap().push(request.clone());
                let last_user = request["messages"].as_array().unwrap().iter().rev()
                    .find(|message| message["role"] == "user")
                    .map(|message| message["content"].to_string()).unwrap_or_default();
                if request.to_string().contains("isolated conversation summarizer") {
                    summary_tx.send(()).unwrap();
                    summary_gate.wait();
                    let text = if request.get("response_format").is_some() {
                        json!({"summary":"Earlier fixture rounds are complete."}).to_string()
                    } else {
                        "<analysis>checked</analysis><summary>Earlier fixture rounds are complete.</summary>".into()
                    };
                    compact_fixture_text(&mut socket, text);
                } else if last_user.contains("AGENT_BARRIER_WORK") {
                    agent_tx.send(()).unwrap();
                    agent_gate.wait();
                    compact_fixture_text(&mut socket, "COMPLETED_AGENT_SENTINEL".into());
                } else if last_user.contains("COMPACT_START_AGENT") && tool_result_count(&request, "compaction-spawn") == 0 {
                    compact_fixture_tool(&mut socket, "spawn_agent", "compaction-spawn", json!({
                        "agent_type":"general", "message":"AGENT_BARRIER_WORK: return the completed report",
                        "max_turns": 2, "run_in_background": true
                    }));
                } else if last_user.contains("All tracked background sub-agents have finished") {
                    followup_tx.send(()).unwrap();
                    if tool_result_count(&request, "compaction-followup-read") == 0 {
                        compact_fixture_tool(&mut socket, "read", "compaction-followup-read", json!({"file_path":"fixture.txt"}));
                    } else {
                        compact_fixture_text(&mut socket, "BACKGROUND_FOLLOWUP_DONE".into());
                    }
                } else {
                    compact_fixture_text(&mut socket, "completed fixture detail ".repeat(250));
                }
            }));
        }
        for handler in handlers {
            handler.join().unwrap();
        }
    });
    CompactBackgroundFixture {
        endpoint,
        calls,
        summary_entered,
        agent_entered,
        followup_entered,
        summary,
        agent,
        stop,
        worker: Some(worker),
    }
}

fn compact_fixture_turn(server: &mut TestAppServer, thread: &str, id: i64, text: &str) {
    server.send(
        json!({"jsonrpc":"2.0","id":id,"method":"turn/start","params":{
            "threadId":thread,"input":[{"type":"text","text":text}]
        }}),
    );
    let response = server.response(id);
    assert!(response.get("error").is_none(), "{response}");
    let completed = server.wait_for_method("turn/completed");
    assert_eq!(
        completed["params"]["turn"]["status"], "completed",
        "{completed}"
    );
}

fn compact_notification_count(request: &Value, agent_id: &str) -> usize {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| {
            let content = message["content"].to_string();
            message["role"] == "user"
                && content.contains("<subagent_notification")
                && content.contains(&format!("id=\\\"{agent_id}\\\""))
        })
        .count()
}

#[test]
fn manual_compaction_preserves_agent_completion_and_automatic_tool_batch_on_resume() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = tmp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(
        workspace.join("fixture.txt"),
        "FOLLOWUP_READ_RESULT_SENTINEL",
    )
    .unwrap();
    let fixture = compact_background_fixture();
    let settings = tmp.path().join("settings.json");
    write_fixture_provider_settings(&settings, &fixture.endpoint);
    let mut value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    value["summary_profile"] = Value::Null;
    value["summary_provider"] = Value::Null;
    value["summary_model"] = Value::Null;
    value["session_memory"] = json!({"enabled":false});
    value["permission_mode"] = json!("bypass");
    // A synthetic key selects the ordinary GenAI ChatCompletions adapter, whose
    // stream includes the complete MessageStart lifecycle required by compact.
    value["providers"]["fixture"]["authentication"] = json!({"mode":"api_key"});
    value["providers"]["fixture"]["credential_env"] = json!(["KCODER_COMPACTION_FIXTURE_API_KEY"]);
    std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();
    let mut builder = TestAppServer::builder(&workspace, &settings).without_scenario();
    builder.extra_env.push((
        "KCODER_COMPACTION_FIXTURE_API_KEY".into(),
        "fixture-only-no-remote".into(),
    ));
    let mut server = builder.spawn();
    server.initialize(1);
    server.send(json!({"id":2,"method":"thread/start","params":{}}));
    let thread = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    compact_fixture_turn(&mut server, &thread, 3, &"old fixture request ".repeat(200));
    compact_fixture_turn(
        &mut server,
        &thread,
        4,
        &"middle fixture request ".repeat(200),
    );
    compact_fixture_turn(&mut server, &thread, 5, "COMPACT_START_AGENT");
    fixture
        .agent_entered
        .recv_timeout(Duration::from_secs(10))
        .expect("ordinary agent must reach its Provider");
    server.send(json!({"id":6,"method":"thread/compact","params":{"threadId":thread}}));
    fixture
        .summary_entered
        .recv_timeout(Duration::from_secs(10))
        .unwrap_or_else(|_| {
            panic!(
                "manual compact must reach summary Provider; {}",
                server.observed_tail()
            )
        });
    fixture.agent.release();
    // Pump delivery must occur during summary generation. The scheduler remains
    // queued on the compact activity gate until this stale summary is rejected.
    let deadline = Instant::now() + Duration::from_secs(10);
    let agent_id = loop {
        let event = server.next_value(deadline);
        assert_ne!(
            event["method"], "turn/started",
            "automatic turn entered the compact activity gate: {event}"
        );
        if event["method"] == "item/event"
            && event["params"]["event"]["type"] == "background_job_completed"
        {
            break event["params"]["event"]["id"].as_str().unwrap().to_owned();
        }
    };
    assert!(
        matches!(
            fixture
                .followup_entered
                .recv_timeout(Duration::from_millis(650)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ),
        "automatic scheduler entered while summary held the gate"
    );
    assert!(
        !fixture.calls.lock().unwrap().iter().any(|call| call
            .to_string()
            .contains("All tracked background sub-agents have finished")),
        "scheduler must wait for manual compact"
    );
    fixture.summary.release();
    let compact = server.response(6);
    assert_eq!(compact["error"]["code"], -32030, "{compact}");
    assert!(
        compact["error"]["message"]
            .as_str()
            .unwrap()
            .contains("conversation changed"),
        "{compact}"
    );
    let completed = server.wait_for_method("turn/completed");
    assert_eq!(
        completed["params"]["turn"]["status"], "completed",
        "{completed}"
    );
    let calls = fixture.calls.lock().unwrap().clone();
    assert!(
        calls
            .iter()
            .any(|call| compact_notification_count(call, &agent_id) == 1),
        "Agent completion notification must reach the followup"
    );
    assert!(
        calls.iter().any(
            |call| tool_call_count(call, "compaction-followup-read") == 1
                && tool_result_count(call, "compaction-followup-read") == 1
        ),
        "complete automatic tool batch must reach the model"
    );
    server.shutdown_successfully();
    let mut builder = TestAppServer::builder(&workspace, &settings).without_scenario();
    builder.extra_env.push((
        "KCODER_COMPACTION_FIXTURE_API_KEY".into(),
        "fixture-only-no-remote".into(),
    ));
    let mut server = builder.spawn();
    server.initialize(10);
    server.send(json!({"id":11,"method":"thread/resume","params":{"threadId":thread}}));
    let resumed = server.response(11);
    assert!(resumed.get("error").is_none(), "{resumed}");
    compact_fixture_turn(&mut server, &thread, 12, "RESTORE_MODEL_CONTEXT");
    let calls = fixture.calls.lock().unwrap();
    let restored = calls
        .iter()
        .rev()
        .find(|call| call.to_string().contains("RESTORE_MODEL_CONTEXT"))
        .unwrap();
    assert_eq!(
        compact_notification_count(restored, &agent_id),
        1,
        "resume lost or duplicated the Agent notification"
    );
    assert_eq!(
        tool_call_count(restored, "compaction-followup-read"),
        1,
        "{restored}"
    );
    assert_eq!(
        tool_result_count(restored, "compaction-followup-read"),
        1,
        "{restored}"
    );
    assert!(
        restored
            .to_string()
            .contains("FOLLOWUP_READ_RESULT_SENTINEL")
    );
    drop(calls);
    server.shutdown_successfully();
}

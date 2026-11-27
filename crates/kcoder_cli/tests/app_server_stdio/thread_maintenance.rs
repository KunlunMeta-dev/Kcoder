//! Manual compaction is owned per-thread work, not an inline dispatch-loop wait.
use super::*;
use std::io::Read as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

/// Loopback Provider whose summarizer requests wait for an explicit permit.
/// Writes ignore errors: a cancelled request's socket may already be closed.
struct SummaryGateFixture {
    endpoint: String,
    summary_entered: mpsc::Receiver<()>,
    permits: Arc<(Mutex<usize>, Condvar)>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl SummaryGateFixture {
    fn release_one(&self) {
        let (permits, changed) = &*self.permits;
        *permits.lock().unwrap() += 1;
        changed.notify_all();
    }
}

impl Drop for SummaryGateFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.permits.1.notify_all();
        let _ = self.worker.take().unwrap().join();
    }
}

fn respond_text(socket: &mut std::net::TcpStream, text: String) {
    let start = json!({"id":"maintenance-fixture","model":"fixture-model","choices":[{
        "index":0,"delta":{"role":"assistant"},"finish_reason":null}]});
    let delta = json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]});
    let stop = json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
    let body = format!("data: {start}\n\ndata: {delta}\n\ndata: {stop}\n\ndata: [DONE]\n\n");
    let _ = write!(
        socket,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

fn summary_gate_fixture() -> SummaryGateFixture {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let permits = Arc::new((Mutex::new(0usize), Condvar::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let (summary_tx, summary_entered) = mpsc::channel();
    let (gate, stopped) = (permits.clone(), stop.clone());
    let worker = std::thread::spawn(move || {
        let mut handlers = Vec::new();
        while !stopped.load(Ordering::SeqCst) {
            let mut socket = match listener.accept() {
                Ok((socket, _)) => socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(_) => break,
            };
            let (gate, stopped, summary_tx) = (gate.clone(), stopped.clone(), summary_tx.clone());
            handlers.push(std::thread::spawn(move || {
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
                let mut bytes = Vec::new();
                while !bytes.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    if socket.read_exact(&mut byte).is_err() {
                        return;
                    }
                    bytes.push(byte[0]);
                }
                let header = String::from_utf8(bytes).unwrap().to_ascii_lowercase();
                if header.starts_with("head ") {
                    let _ = write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    return;
                }
                let request = String::from_utf8_lossy(&read_fixture_request_body(&mut socket, &header)).into_owned();
                if request.contains("isolated conversation summarizer") {
                    let _ = summary_tx.send(());
                    let (permits, changed) = &*gate;
                    let mut available = permits.lock().unwrap();
                    while *available == 0 && !stopped.load(Ordering::SeqCst) {
                        available = changed.wait_timeout(available, Duration::from_millis(50)).unwrap().0;
                    }
                    if *available == 0 {
                        return;
                    }
                    *available -= 1;
                    drop(available);
                    let text = if request.contains("\"response_format\"") {
                        json!({"summary":"Earlier maintenance fixture rounds are complete."}).to_string()
                    } else {
                        "<analysis>checked</analysis><summary>Earlier maintenance fixture rounds are complete.</summary>".into()
                    };
                    respond_text(&mut socket, text);
                } else {
                    respond_text(&mut socket, "completed maintenance detail ".repeat(250));
                }
            }));
        }
        for handler in handlers {
            let _ = handler.join();
        }
    });
    SummaryGateFixture {
        endpoint,
        summary_entered,
        permits,
        stop,
        worker: Some(worker),
    }
}

fn maintenance_server(
    workspace: &std::path::Path,
    settings: &std::path::Path,
    cancel_capability: bool,
) -> TestAppServer {
    let mut builder = TestAppServer::builder(workspace, settings).without_scenario();
    builder.extra_env.push((
        "KCODER_MAINTENANCE_FIXTURE_API_KEY".into(),
        "fixture-only-no-remote".into(),
    ));
    let mut server = builder.discard_stderr().spawn();
    server.send(json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2026-07-27", "clientInfo": {"name": "maintenance-test", "version": "1"},
            "capabilities": {"experimental": {
                "threadMaintenanceV1": true,
                "threadMaintenanceCancelV1": cancel_capability,
                "agentTurnConfigurationV1": true,
            }}}
    }));
    let initialized = server.response(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["threadMaintenanceV1"], true,
        "{initialized}"
    );
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["threadMaintenanceCancelV1"],
        cancel_capability,
        "{initialized}"
    );
    server
}

fn long_thread(server: &mut TestAppServer, id: i64) -> String {
    server.send(json!({"jsonrpc":"2.0","id":id,"method":"thread/start","params":{}}));
    let thread = server.response(id)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for turn in 1..=3 {
        let request = id + turn;
        server.send(json!({"jsonrpc":"2.0","id":request,"method":"turn/start","params":{
            "threadId":thread,"input":[{"type":"text","text":format!("maintenance request {turn} ").repeat(200)}]}}));
        let accepted = server.response(request);
        assert!(accepted["error"].is_null(), "{accepted}");
        let completed = server.wait_for_method("turn/completed");
        assert_eq!(
            completed["params"]["turn"]["status"], "completed",
            "{completed}"
        );
    }
    thread
}

fn user_messages(server: &mut TestAppServer, id: i64, thread: &str) -> usize {
    server.send(json!({"jsonrpc":"2.0","id":id,"method":"thread/read","params":{"threadId":thread,"limit":100}}));
    let read = server.response(id);
    read["result"]["messages"]
        .as_array()
        .unwrap_or_else(|| panic!("{read}"))
        .iter()
        .filter(|message| message["role"] == "user")
        .count()
}

fn write_maintenance_settings(settings: &std::path::Path, endpoint: &str) {
    write_fixture_provider_settings(settings, endpoint);
    let mut value: Value = serde_json::from_slice(&std::fs::read(settings).unwrap()).unwrap();
    value["summary_profile"] = Value::Null;
    value["summary_provider"] = Value::Null;
    value["summary_model"] = Value::Null;
    value["session_memory"] = json!({"enabled":false});
    value["permission_mode"] = json!("bypass");
    value["providers"]["fixture"]["authentication"] = json!({"mode":"api_key"});
    value["providers"]["fixture"]["credential_env"] = json!(["KCODER_MAINTENANCE_FIXTURE_API_KEY"]);
    std::fs::write(settings, serde_json::to_vec(&value).unwrap()).unwrap();
}

#[test]
fn manual_compaction_does_not_block_other_requests_and_drains_on_shutdown() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = tmp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let fixture = summary_gate_fixture();
    let settings = tmp.path().join("settings.json");
    write_maintenance_settings(&settings, &fixture.endpoint);

    let mut server = maintenance_server(&workspace, &settings, false);
    let thread_a = long_thread(&mut server, 10);
    let thread_b = long_thread(&mut server, 20);

    server.send(
        json!({"jsonrpc":"2.0","id":30,"method":"thread/compact","params":{"threadId":thread_a}}),
    );
    let started = server.wait_for_method("thread/maintenance");
    assert_eq!(
        started["params"],
        json!({"threadId":thread_a,"operation":"compact","status":"started"})
    );
    fixture
        .summary_entered
        .recv_timeout(Duration::from_secs(15))
        .unwrap_or_else(|_| {
            panic!(
                "compaction must reach the summarizer; {}",
                server.observed_tail()
            )
        });
    // The dispatch loop keeps serving other threads, persisted expert reads
    // and conflicting requests while thread A's summary is still blocked.
    let served = Instant::now();
    assert_eq!(user_messages(&mut server, 31, &thread_b), 3);
    server.send(json!({"jsonrpc":"2.0","id":32,"method":"thread/expert","params":{"threadId":thread_a,"includeTurns":false}}));
    let expert = server.response(32);
    assert!(expert["error"].is_null(), "{expert}");
    for (id, method, params) in [
        (
            33,
            "turn/start",
            json!({"threadId":thread_a,"input":[{"type":"text","text":"during compaction"}],"clientMessageId":"during-compaction"}),
        ),
        (34, "thread/rollback", json!({"threadId":thread_a})),
        (35, "thread/compact", json!({"threadId":thread_a})),
        // An expert change writes the sidecar the compaction commits.
        (
            37,
            "thread/expert",
            json!({"threadId":thread_a,"change":{"expectedRevision":0,"expert":null}}),
        ),
    ] {
        server.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        let busy = server.response(id);
        assert_eq!(busy["error"]["code"], -32028, "{method}: {busy}");
        assert_eq!(
            busy["error"]["data"],
            json!({"threadId":thread_a,"operation":"compact"}),
            "{busy}"
        );
    }
    assert!(
        served.elapsed() < Duration::from_secs(5),
        "requests waited for compaction: {:?}",
        served.elapsed()
    );

    fixture.release_one();
    let compacted = server.response(30);
    assert!(compacted["error"].is_null(), "{compacted}");
    assert_eq!(compacted["result"]["compacted"], true, "{compacted}");
    let completed = server.wait_for_method("thread/maintenance");
    assert_eq!(completed["params"]["status"], "completed", "{completed}");
    // The released claim admits the same stable submission exactly once.
    server.send(json!({"jsonrpc":"2.0","id":36,"method":"turn/start","params":{
        "threadId":thread_a,"input":[{"type":"text","text":"during compaction"}],"clientMessageId":"during-compaction"}}));
    let accepted = server.response(36);
    assert_eq!(
        accepted["result"]["turn"]["status"], "running",
        "{accepted}"
    );
    server.wait_for_method("turn/completed");

    // Shutdown during a blocked summary cancels it before any commit and exits promptly.
    server.send(
        json!({"jsonrpc":"2.0","id":40,"method":"thread/compact","params":{"threadId":thread_b}}),
    );
    fixture
        .summary_entered
        .recv_timeout(Duration::from_secs(15))
        .unwrap_or_else(|_| {
            panic!(
                "second compaction must reach the summarizer; {}",
                server.observed_tail()
            )
        });
    server.shutdown();

    let mut restarted = maintenance_server(&workspace, &settings, false);
    restarted.send(
        json!({"jsonrpc":"2.0","id":50,"method":"thread/resume","params":{"threadId":thread_b}}),
    );
    let resumed = restarted.response(50);
    assert!(resumed["error"].is_null(), "{resumed}");
    assert_eq!(
        user_messages(&mut restarted, 51, &thread_b),
        3,
        "cancelled compaction wrote nothing"
    );
    restarted.shutdown();
}

#[test]
fn manual_compaction_stop_targets_exact_maintenance() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let settings = temp.path().join("settings.json");
    let fixture = summary_gate_fixture();
    write_maintenance_settings(&settings, &fixture.endpoint);
    let mut server = maintenance_server(&workspace, &settings, true);
    let thread = long_thread(&mut server, 10);

    server.send(
        json!({"jsonrpc":"2.0","id":20,"method":"thread/compact","params":{"threadId":thread}}),
    );
    let started = server.wait_for_method("thread/maintenance");
    let maintenance = started["params"]["maintenanceId"]
        .as_str()
        .expect("addressable compaction");
    fixture
        .summary_entered
        .recv_timeout(Duration::from_secs(15))
        .unwrap();
    server.send(json!({"jsonrpc":"2.0","method":"thread/maintenance/cancel",
        "params":{"threadId":thread,"maintenanceId":maintenance}}));
    for (request, thread_id, maintenance_id) in [
        (21, thread.as_str(), "00000000-0000-4000-8000-000000000001"),
        (22, "another-thread", maintenance),
    ] {
        server.send(
            json!({"jsonrpc":"2.0","id":request,"method":"thread/maintenance/cancel",
            "params":{"threadId":thread_id,"maintenanceId":maintenance_id}}),
        );
        assert_eq!(
            server.response(request)["result"],
            json!({"cancellationRequested":false})
        );
    }
    server.send(
        json!({"jsonrpc":"2.0","id":23,"method":"thread/maintenance/cancel",
        "params":{"threadId":thread,"maintenanceId":maintenance}}),
    );
    let mut reply = None;
    let mut stopped = None;
    let mut settled = None;
    let deadline = Instant::now() + Duration::from_secs(10);
    while reply.is_none() || settled.is_none() || stopped.is_none() {
        let value = server.next_value(deadline);
        if value["id"] == 23 {
            reply = Some(value);
        } else if value["id"] == 20 {
            stopped = Some(value);
        } else if value["method"] == "thread/maintenance" {
            settled = Some(value);
        }
    }
    assert_eq!(
        reply.unwrap()["result"],
        json!({"cancellationRequested":true})
    );
    assert_eq!(
        stopped.unwrap()["error"]["data"],
        json!({"kind":"thread_compaction_cancelled"})
    );
    assert_eq!(
        settled.unwrap()["params"],
        json!({
            "threadId":thread,"operation":"compact","status":"cancelled","maintenanceId":maintenance
        })
    );
    assert_eq!(user_messages(&mut server, 24, &thread), 3);

    server.send(
        json!({"jsonrpc":"2.0","id":25,"method":"thread/compact","params":{"threadId":thread}}),
    );
    let next = server.wait_for_method("thread/maintenance");
    assert_ne!(next["params"]["maintenanceId"], maintenance);
    fixture
        .summary_entered
        .recv_timeout(Duration::from_secs(15))
        .unwrap();
    server.send(
        json!({"jsonrpc":"2.0","id":26,"method":"thread/maintenance/cancel",
        "params":{"threadId":thread,"maintenanceId":maintenance}}),
    );
    assert_eq!(
        server.response(26)["result"],
        json!({"cancellationRequested":false})
    );
    // One blocked fixture request may still own the canceled HTTP socket.
    fixture.release_one();
    fixture.release_one();
    assert_eq!(server.response(25)["result"]["compacted"], true);
    server.shutdown_successfully();
}

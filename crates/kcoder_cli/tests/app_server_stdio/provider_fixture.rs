// Shared provider fixture for the continuation tests. The first model call fails
// at the provider, which is what makes a turn continuable; later calls answer
// normally. Every accepted call is recorded, so a test can prove that a refused
// continuation never reached the provider at all.

use std::io::Read;
use std::sync::{Arc, Mutex};

/// Records model calls until three seconds pass without another one. The call
/// log is shared so a test can assert that a refusal did not add a call at the
/// moment it happens, not only once the fixture stops.
type FixtureCalls = Arc<Mutex<Vec<Value>>>;

// Read exactly one HTTP body; waiting for EOF deadlocks persistent connections.
fn read_fixture_request_body(socket: &mut std::net::TcpStream, header: &str) -> Vec<u8> {
    const MAX_BODY: usize = 2 * 1024 * 1024;
    if let Some(length) = header.lines().find_map(|line| {
        line.strip_prefix("content-length:")
            .map(|value| value.trim().parse::<usize>().unwrap())
    }) {
        assert!(length <= MAX_BODY);
        let mut body = vec![0; length];
        socket.read_exact(&mut body).unwrap();
        return body;
    }
    assert!(
        header
            .lines()
            .any(|line| line.starts_with("transfer-encoding:") && line.contains("chunked"))
    );
    let mut body = Vec::new();
    loop {
        let mut line = Vec::new();
        while !line.ends_with(b"\r\n") {
            let mut byte = [0];
            socket.read_exact(&mut byte).unwrap();
            line.push(byte[0]);
            assert!(line.len() <= 1024);
        }
        let text = std::str::from_utf8(&line).unwrap();
        let size = usize::from_str_radix(text.trim().split(';').next().unwrap(), 16).unwrap();
        assert!(size <= MAX_BODY - body.len());
        if size == 0 {
            break;
        }
        let start = body.len();
        body.resize(start + size, 0);
        socket.read_exact(&mut body[start..]).unwrap();
        let mut crlf = [0; 2];
        socket.read_exact(&mut crlf).unwrap();
        assert_eq!(&crlf, b"\r\n");
    }
    body
}

fn serving_fixture() -> (String, FixtureCalls, std::thread::JoinHandle<()>) {
    serving_fixture_with(outage_first_call)
}

/// The first model call answers HTTP 500: the turn fails at the provider.
fn outage_first_call(socket: &mut std::net::TcpStream) {
    let body = "{\"error\":{\"message\":\"fixture outage\"}}";
    write!(
        socket,
        "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
}

/// The first model call streams one delta and then keeps the connection open, so
/// a test can kill the server while the answer is still streaming.
fn slow_partial_stream_first_call(socket: &mut std::net::TcpStream) {
    let body = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"uncommitted half\"},\"finish_reason\":null}]}\n\n";
    write!(
        socket,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{body}\r\n",
        body.len()
    )
    .unwrap();
    socket.flush().unwrap();
    std::thread::sleep(std::time::Duration::from_secs(15));
}

/// The first model call streams half a reasoning block and then drops the
/// connection without a terminal event.
fn partial_reasoning_stream_first_call(socket: &mut std::net::TcpStream) {
    let body = "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"half a thought\"},\"finish_reason\":null}]}\n\n";
    write!(
        socket,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
}

/// A model call that starts a background bash job.
fn background_bash_tool_call(socket: &mut std::net::TcpStream, command: &str) {
    let arguments = serde_json::json!({
        "command": command,
        "description": "background delivery fixture",
        "run_in_background": true
    })
    .to_string();
    let delta = serde_json::json!({
        "choices": [{
            "index": 0,
            "delta": {
                "tool_calls": [{
                    "index": 0,
                    "id": "fixture-background-call",
                    "type": "function",
                    "function": { "name": "bash", "arguments": arguments }
                }]
            },
            "finish_reason": null
        }]
    });
    let stop = serde_json::json!({
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }]
    });
    let body = format!("data: {delta}\n\ndata: {stop}\n\ndata: [DONE]\n\n");
    write!(
        socket,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
}

/// A model call that asks for the read-only `read` tool on a workspace file.
fn read_tool_call(socket: &mut std::net::TcpStream, file_path: &str) {
    let arguments = serde_json::json!({ "file_path": file_path }).to_string();
    let delta = serde_json::json!({
        "choices": [{
            "index": 0,
            "delta": {
                "tool_calls": [{
                    "index": 0,
                    "id": "fixture-read-call",
                    "type": "function",
                    "function": { "name": "read", "arguments": arguments }
                }]
            },
            "finish_reason": null
        }]
    });
    let stop = serde_json::json!({
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }]
    });
    let body = format!("data: {delta}\n\ndata: {stop}\n\ndata: [DONE]\n\n");
    write!(
        socket,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
}

/// The first model call streams half an answer and then drops the connection
/// without a terminal event.
fn partial_stream_first_call(socket: &mut std::net::TcpStream) {
    let body = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"half an answer\"},\"finish_reason\":null}]}\n\n";
    write!(
        socket,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
}

fn serving_fixture_with(
    first_call: fn(&mut std::net::TcpStream),
) -> (String, FixtureCalls, std::thread::JoinHandle<()>) {
    serving_fixture_scripted(vec![first_call])
}

/// A scripted provider: the n-th model call runs the n-th scripted behaviour and
/// every later call answers normally. Recording is shared, so a test can assert
/// how many calls happened and what each request body contained.
fn serving_fixture_scripted(
    script: Vec<fn(&mut std::net::TcpStream)>,
) -> (String, FixtureCalls, std::thread::JoinHandle<()>) {
    serving_fixture_decided(move |index, _request| match script.get(index) {
        Some(behaviour) => FixtureAnswer::Custom(*behaviour),
        None => FixtureAnswer::Ok,
    })
}

/// Answers decided per request, so a fixture can tell actors apart: a parent turn
/// and the sub-agent it spawned issue separate model calls that a fixed script
/// cannot address reliably.
#[derive(Clone, Copy)]
enum FixtureAnswer {
    Ok,
    Outage,
    Custom(fn(&mut std::net::TcpStream)),
}

fn serving_fixture_decided<F>(decide: F) -> (String, FixtureCalls, std::thread::JoinHandle<()>)
where
    F: Fn(usize, &Value) -> FixtureAnswer + Send + 'static,
{
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let calls: FixtureCalls = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&calls);
    let task = std::thread::spawn(move || {
        let mut requests = Vec::new();
        let mut last_call = Instant::now();
        let deadline = Instant::now() + Duration::from_secs(45);
        while Instant::now() < deadline
            && (requests.is_empty() || last_call.elapsed() < Duration::from_secs(3))
        {
            let mut socket = match listener.accept() {
                Ok((socket, _)) => socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(error) => panic!("fixture accept failed: {error}"),
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut bytes = Vec::new();
            let body_start = loop {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
                assert!(bytes.len() < 4 * 1024 * 1024);
                if bytes.ends_with(b"\r\n\r\n") {
                    break bytes.len();
                }
            };
            let header = String::from_utf8_lossy(&bytes[..body_start]).to_ascii_lowercase();
            // The app-server probes reachability with HEAD before a model call.
            if header.starts_with("head ") {
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
                drop(socket);
                continue;
            }
            let body = read_fixture_request_body(&mut socket, &header);
            requests.push(serde_json::from_slice::<Value>(&body).unwrap());
            recorded
                .lock()
                .unwrap()
                .push(requests.last().unwrap().clone());
            last_call = Instant::now();
            match decide(requests.len() - 1, requests.last().unwrap()) {
                FixtureAnswer::Custom(behaviour) => behaviour(&mut socket),
                FixtureAnswer::Outage => outage_first_call(&mut socket),
                FixtureAnswer::Ok => {
                    let body = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
                    write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
                }
            }
            drop(socket);
        }
        let _ = requests;
    });
    (endpoint, calls, task)
}

fn fixture_call_count(calls: &FixtureCalls) -> usize {
    calls.lock().unwrap().len()
}

fn write_fixture_provider_settings(path: &std::path::Path, endpoint: &str) {
    std::fs::write(
        path,
        serde_json::to_vec(&json!({
            "active_provider": "fixture",
            "max_retries": 0,
            "providers": {
                "fixture": {
                    "api_format": "openai_chat_completions",
                    "endpoint": endpoint,
                    "default_model": "fixture-model",
                    "context_window_tokens": 128000,
                    "output_headroom_tokens": 8192,
                    "max_output_tokens": 8192,
                    "request_timeout_secs": 30,
                    // Without an authentication mode the provider is treated as
                    // signed out and never dials the endpoint at all.
                    "authentication": {"mode": "none"},
                    "no_proxy": true,
                    "extra_body": {}
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
}

/// Drives a fresh app-server to one failed, continuable turn.
fn start_failed_turn(
    workspace: &std::path::Path,
    settings: &std::path::Path,
) -> (TestAppServer, String, String) {
    start_failed_turn_with_input(workspace, settings, "run once")
}

/// Same, with a caller-chosen user input so a test can build a context large
/// enough for a manual compaction to rewrite history.
fn start_failed_turn_with_input(
    workspace: &std::path::Path,
    settings: &std::path::Path,
    input: &str,
) -> (TestAppServer, String, String) {
    let mut server = TestAppServer::builder(workspace, settings)
        .without_scenario()
        .spawn();
    server.initialize(1);
    server.send(json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}));
    let thread_id = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "turn/start",
        "params": {"threadId": thread_id.clone(), "input": [{"type": "text", "text": input}]}
    }));
    let started = server.response(3);
    assert!(started.get("error").is_none(), "{started}");
    let failed_turn = started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed" {
            assert_eq!(event["params"]["turn"]["status"], "failed", "{event}");
            break;
        }
    }
    (server, thread_id, failed_turn)
}

/// A continuation never submits input; it resumes from the committed context.
fn continuation_request(thread_id: &str, failed_turn: &str, id: i64) -> Value {
    json!({
        "jsonrpc": "2.0", "id": id, "method": "turn/start",
        "params": {"threadId": thread_id, "input": [], "retryFromTurnId": failed_turn}
    })
}

fn user_message_count(server: &mut TestAppServer, thread_id: &str, id: i64) -> usize {
    server.send(json!({
        "jsonrpc": "2.0", "id": id, "method": "thread/read",
        "params": {"threadId": thread_id, "limit": 50}
    }));
    let read = server.response(id);
    read["result"]["messages"]
        .as_array()
        .expect("thread/read messages")
        .iter()
        .filter(|message| message["role"] == "user")
        .count()
}

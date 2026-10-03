//! Verify the actual transport, not config/get (which reports persisted configuration).
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    time::{Duration, Instant},
};

fn model_server() -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let worker = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "model endpoint was not called");
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("{error}"),
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let body = loop {
            let mut chunk = [0; 8192];
            let count = stream.read(&mut chunk).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&chunk[..count]);
            assert!(bytes.len() <= 2 * 1024 * 1024);
            if let Some(header_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = std::str::from_utf8(&bytes[..header_end]).unwrap();
                assert!(headers.starts_with("POST /v1/messages "));
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= header_end + 4 + length {
                    break bytes[header_end + 4..header_end + 4 + length].to_vec();
                }
            }
        };
        let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let model = request["model"].as_str().unwrap().to_string();
        let events = [
            serde_json::json!({"type":"message_start","message":{"id":"fixture","role":"assistant","content":[],"model":model,"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}),
            serde_json::json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            serde_json::json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}),
            serde_json::json!({"type":"content_block_stop","index":0}),
            serde_json::json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}),
            serde_json::json!({"type":"message_stop"}),
        ];
        let response = events
            .iter()
            .map(|event| {
                format!(
                    "event: {}\ndata: {event}\n\n",
                    event["type"].as_str().unwrap()
                )
            })
            .collect::<String>();
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
        model
    });
    (endpoint, worker)
}

#[test]
fn first_start_preserves_configured_provider_and_explicit_environment_override() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    std::fs::create_dir(&config).unwrap();
    let (endpoint, first) = model_server();
    std::fs::write(config.join("settings.json"),serde_json::json!({
        "permission_mode":"yolo","active_provider":"kunlunmeta","providers":{"kunlunmeta":{
            "endpoint":endpoint,"api_format":"anthropic_messages","authentication":{"mode":"api_key"},
            "default_model":"configured-fixture-model","context_window_tokens":128000,"max_output_tokens":1024,"output_headroom_tokens":1024,"no_proxy":true
        }}
    }).to_string()).unwrap();
    std::fs::write(
        config.join("credentials.json"),
        r#"{"kunlunmeta":{"type":"api","key":"fixture-private-not-real"}}"#,
    )
    .unwrap();
    let run = |override_endpoint: Option<&str>| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_kcoder"));
        command
            .env_clear()
            .env("KCODER_CONFIG_DIR", &config)
            .env("HOME", temp.path())
            .env("USERPROFILE", temp.path())
            .env("APPDATA", temp.path())
            .env("LOCALAPPDATA", temp.path())
            .arg("--cwd")
            .arg(temp.path())
            .args([
                "--tool-profile",
                "none",
                "--max-retries",
                "0",
                "--json",
                "hello",
            ]);
        for name in ["PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        if let Some(endpoint) = override_endpoint {
            command
                .env("KUNLUNMETA_BASE_URL", endpoint)
                .env("KCODER_MODEL", "explicit-fixture-model");
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run(None);
    assert_eq!(first.join().unwrap(), "configured-fixture-model");
    let (explicit_endpoint, second) = model_server();
    run(Some(&explicit_endpoint));
    assert_eq!(second.join().unwrap(), "explicit-fixture-model");
    assert!(config.join(".env").is_file());
}

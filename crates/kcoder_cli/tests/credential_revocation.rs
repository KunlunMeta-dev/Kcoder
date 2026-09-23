//! Isolated subprocess proof of persisted revocation; never uses real credentials.
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn bounded(mut command: Command) -> Output {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("isolated credential command exceeded deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    child.wait_with_output().unwrap()
}

#[test]
fn logout_persists_across_processes_and_blocks_environment_fallback_without_http() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let settings = serde_json::json!({
        "active_provider":"fixture", "credential_store":"file",
        "providers":{"fixture":{
            "api_format":"openai_chat_completions",
            "endpoint":format!("http://{}/v1", listener.local_addr().unwrap()),
            "default_model":"fixture-model", "credential_env":["P1_REVOCATION_FIXTURE_KEY"],
            "context_window_tokens":32000,"max_output_tokens":1024,"output_headroom_tokens":1024
        }}
    });
    std::fs::write(config.join("settings.json"), settings.to_string()).unwrap();
    let command = || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_kcoder"));
        command
            .current_dir(&workspace)
            .env("KCODER_CONFIG_DIR", &config)
            .env("P1_REVOCATION_FIXTURE_KEY", "synthetic-env-key")
            .env_remove("KCODER_SETTINGS_FILE");
        command
    };
    for _ in 0..2 {
        let mut logout = command();
        logout.args(["auth", "logout", "--provider", "fixture"]);
        let output = bounded(logout);
        assert!(output.status.success(), "logout failed");
        assert!(!String::from_utf8_lossy(&output.stdout).contains("synthetic-env-key"));
    }
    let stored: serde_json::Value =
        serde_json::from_slice(&std::fs::read(config.join("credentials.json")).unwrap()).unwrap();
    assert_eq!(stored["fixture"], serde_json::json!({"type":"revoked"}));
    let mut query = command();
    query.args(["--json", "isolated credential boundary test"]);
    let output = bounded(query);
    assert!(
        !output.status.success(),
        "revoked provider must not start a new headless turn"
    );
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains("key") || error.contains("credential"),
        "expected credential failure"
    );
    assert!(!error.contains("synthetic-env-key"));
    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
    );
}

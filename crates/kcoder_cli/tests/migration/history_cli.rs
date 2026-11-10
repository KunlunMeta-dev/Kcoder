//! Real terminal invocations exercise selection, immutable archives and idle publication.
#[path = "history_resource_cli.rs"]
mod initial_resources;
#[path = "history_local_attachment_cli.rs"]
mod local_attachment;
#[path = "history_reinterpretation_cli.rs"]
mod reinterpretation;
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    path::PathBuf,
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

struct Fixture {
    root: tempfile::TempDir,
    profile: PathBuf,
    source: PathBuf,
    workspace: PathBuf,
    binary: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let source = root.path().join("claude");
        let workspace = root.path().join("workspace");
        for path in [&profile, &source, &workspace] {
            fs::create_dir(path).unwrap();
        }
        let binary = workspace.join(if cfg!(windows) {
            "kcoder.exe"
        } else {
            "kcoder"
        });
        if fs::hard_link(env!("CARGO_BIN_EXE_kcoder"), &binary).is_err() {
            fs::copy(env!("CARGO_BIN_EXE_kcoder"), &binary).unwrap();
        }
        fs::write(profile.join("settings.json"),json!({"provider":"local","local_base_url":"http://127.0.0.1:9","api_format":"openai_chat_completions","model":"fixture-model","context_window_tokens":1000000,"context_output_headroom":10000,"max_tokens":2048}).to_string()).unwrap();
        Self {
            root,
            profile,
            source,
            workspace,
            binary,
        }
    }
    fn source(&self, id: &str) -> PathBuf {
        let path = self.source.join(format!("projects/project/{id}.jsonl"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let records = [
            json!({"type":"user","uuid":"a","sessionId":id,"version":"2.1.301","message":{"role":"user","content":"TERMINAL_ARCHIVE_SENTINEL"}}),
            json!({"type":"assistant","uuid":"b","parentUuid":"a","sessionId":id,"version":"2.1.301","message":{"role":"assistant","content":[{"type":"tool_use","id":"old","name":"Bash","input":{"command":format!("touch {}",self.workspace.join("NEVER_REPLAY").display())}}]}}),
            json!({"type":"user","uuid":"c","parentUuid":"b","sessionId":id,"version":"2.1.301","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"old","content":"historical result"}]}}),
        ];
        fs::write(
            &path,
            records
                .into_iter()
                .map(|row| row.to_string() + "\n")
                .collect::<String>(),
        )
        .unwrap();
        path
    }
    fn invoke(&self, args: &[&str]) -> Output {
        let mut command = Command::new(&self.binary);
        command
            .args([
                "migrate",
                "history",
                "--target-profile",
                self.profile.to_str().unwrap(),
            ])
            .args(args)
            .current_dir(&self.workspace)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", self.root.path())
            .env("USERPROFILE", self.root.path())
            .env("KCODER_CONFIG_DIR", &self.profile)
            .env(
                "KCODER_TUI_LAB_REQUEST_DIR",
                self.workspace.join("model-requests"),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        for name in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let mut child = command.spawn().unwrap();
        let reader = |stream: Box<dyn Read + Send>| {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                stream
                    .take(2 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .unwrap();
                assert!(bytes.len() <= 2 * 1024 * 1024);
                bytes
            })
        };
        let stdout = reader(Box::new(child.stdout.take().unwrap()));
        let stderr = reader(Box::new(child.stderr.take().unwrap()));
        let start = Instant::now();
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                return Output {
                    status,
                    stdout: stdout.join().unwrap(),
                    stderr: stderr.join().unwrap(),
                };
            }
            if start.elapsed() > Duration::from_secs(90) {
                let _ = child.kill();
                let _ = child.wait();
                panic!("owned history CLI exceeded deadline");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn call(&self, args: &[&str]) -> Value {
        let output = self.invoke(args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
    fn selected(&self, id: &str, key: &str) -> Value {
        self.call(&[
            "select",
            "--source",
            "claude-code",
            "--source-root",
            self.source.to_str().unwrap(),
            "--source-session-id",
            id,
            "--request-id",
            key,
        ])
    }
}

#[test]
fn history_cli_scans_selects_pages_and_builds_inert_context_without_running_source_tools() {
    let f = Fixture::new();
    let mut selected = None;
    for _ in 0..12 {
        let id = uuid::Uuid::new_v4().to_string();
        let path = f.source(&id);
        selected = Some((id, path));
    }
    let (id, path) = selected.unwrap();
    let original = fs::read(&path).unwrap();
    let scanned = f.call(&[
        "scan",
        "--source",
        "claude-code",
        "--source-root",
        f.source.to_str().unwrap(),
    ]);
    assert_eq!(scanned["items"].as_array().unwrap().len(), 10);
    assert_eq!(scanned["totalItems"], 12);
    assert!(!f.profile.join("migrations").exists());
    let rest = f.call(&[
        "scan",
        "--source",
        "claude-code",
        "--source-root",
        f.source.to_str().unwrap(),
        "--page",
        "1",
    ]);
    assert_eq!(rest["items"].as_array().unwrap().len(), 2);
    let key = uuid::Uuid::new_v4().to_string();
    let selected = f.selected(&id, &key);
    assert_eq!(selected["jobId"], key);
    let repeated = f.selected(&id, &key);
    assert_eq!(repeated["sequence"], selected["sequence"]);
    let job = f.call(&[
        "run",
        "--job-id",
        &key,
        "--expected-sequence",
        &selected["sequence"].to_string(),
    ]);
    assert_eq!(job["stage"], "normalized");
    let page = f.call(&["page", "--job-id", &key]);
    assert_eq!(page["items"].as_array().unwrap().len(), 3);
    let text = f.call(&["text", "--job-id", &key, "--record", "0", "--block", "0"]);
    assert_eq!(text["text"], "TERMINAL_ARCHIVE_SENTINEL");
    let branch = f.call(&["branch", "--job-id", &key]);
    assert_eq!(branch["progress"]["stage"], "ready");
    let view = branch["progress"]["viewId"].as_str().unwrap();
    let tools = f.call(&["tools", "--job-id", &key, "--view-id", view]);
    assert!(!tools["links"].as_array().unwrap().is_empty());
    let report = f.call(&["check", "--job-id", &key, "--view-id", view]);
    assert_eq!(report["report"]["contextCompiled"], true);
    assert_eq!(report["currentModelChecked"], false);
    assert!(!f.workspace.join("NEVER_REPLAY").exists());
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn history_cli_cancel_requires_explicit_resume_and_rejects_stale_sequences() {
    let f = Fixture::new();
    let id = uuid::Uuid::new_v4().to_string();
    f.source(&id);
    let key = uuid::Uuid::new_v4().to_string();
    let selected = f.selected(&id, &key);
    let cancelled = f.call(&["cancel", "--job-id", &key]);
    assert_eq!(cancelled["stage"], "cancelled");
    let stale = f.invoke(&[
        "run",
        "--job-id",
        &key,
        "--expected-sequence",
        &selected["sequence"].to_string(),
        "--resume-job",
    ]);
    assert!(!stale.status.success());
    let result = f.call(&[
        "run",
        "--job-id",
        &key,
        "--expected-sequence",
        &cancelled["sequence"].to_string(),
        "--resume-job",
    ]);
    assert_eq!(result["stage"], "normalized");
}

#[test]
fn history_cli_continuation_publishes_an_idle_kcoder_session_and_reopens_receipt() {
    let f = Fixture::new();
    let id = uuid::Uuid::new_v4().to_string();
    let path = f.source(&id);
    let bytes = fs::read(&path).unwrap();
    let key = uuid::Uuid::new_v4().to_string();
    let selected = f.selected(&id, &key);
    f.call(&[
        "run",
        "--job-id",
        &key,
        "--expected-sequence",
        &selected["sequence"].to_string(),
    ]);
    let branch = f.call(&["branch", "--job-id", &key]);
    let view = branch["progress"]["viewId"].as_str().unwrap();
    let operation = uuid::Uuid::new_v4().to_string();
    let imported = f.call(&[
        "continue",
        "--job-id",
        &key,
        "--view-id",
        view,
        "--request-id",
        &operation,
    ]);
    assert_eq!(imported["job"]["stage"], "imported");
    assert_eq!(imported["job"]["options"]["studioWorkMode"], "kcoder");
    let thread = imported["job"]["threadId"].as_str().unwrap();
    assert_eq!(thread.len(), 5);
    let receipt = f.call(&["continuation-read", "--job-id", &operation]);
    assert_eq!(receipt["job"]["threadId"], thread);
    let repeated = f.call(&[
        "continue",
        "--job-id",
        &key,
        "--view-id",
        view,
        "--request-id",
        &operation,
    ]);
    assert_eq!(repeated["job"]["threadId"], thread);
    let source = f.call(&["source", "--thread-id", thread]);
    assert_eq!(source["source"]["sourceJobId"], key);
    assert!(!f.workspace.join("NEVER_REPLAY").exists());
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn history_cli_codex_requires_an_explicit_physical_rollout_and_reads_after_source_removal() {
    let f = Fixture::new();
    let session = uuid::Uuid::new_v4().to_string();
    let records = [
        json!({"type":"session_meta","payload":{"id":session,"cli_version":"0.163.0"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"CODEX_TERMINAL_SOURCE"}]}}),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"old-call","name":"write","arguments":"{\"file_path\":\"NEVER_REPLAY\",\"content\":\"old content\"}"}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"old-call","output":"historical result"}}),
    ].into_iter().map(|row|row.to_string()+"\n").collect::<String>();
    let folder = f.source.join("sessions/2026/10/17");
    fs::create_dir_all(&folder).unwrap();
    for _ in 0..2 {
        fs::write(
            folder.join(format!(
                "rollout-2026-10-17T00-00-00-{session}_{}.jsonl",
                uuid::Uuid::new_v4()
            )),
            &records,
        )
        .unwrap();
    }
    let scanned = f.call(&[
        "scan",
        "--source",
        "codex",
        "--source-root",
        f.source.to_str().unwrap(),
    ]);
    assert_eq!(scanned["totalItems"], 2);
    let key = uuid::Uuid::new_v4().to_string();
    let args = [
        "select",
        "--source",
        "codex",
        "--source-root",
        f.source.to_str().unwrap(),
        "--source-session-id",
        &session,
        "--request-id",
        &key,
    ];
    let ambiguous = f.invoke(&args);
    assert!(!ambiguous.status.success());
    assert!(!f.profile.join("migrations").exists());
    let mut selected_args = args.to_vec();
    selected_args.extend([
        "--source-artifact-id",
        scanned["items"][0]["sourceArtifactId"].as_str().unwrap(),
    ]);
    let selected = f.call(&selected_args);
    let archived = f.call(&[
        "run",
        "--job-id",
        &key,
        "--expected-sequence",
        &selected["sequence"].to_string(),
    ]);
    assert_eq!(archived["stage"], "normalized");
    fs::remove_dir_all(&folder).unwrap();
    let text = f.call(&["text", "--job-id", &key, "--record", "1", "--block", "0"]);
    assert_eq!(text["text"], "CODEX_TERMINAL_SOURCE");
    let branch = f.call(&["branch", "--job-id", &key]);
    assert_eq!(branch["progress"]["stage"], "ready");
    let view = branch["progress"]["viewId"].as_str().unwrap();
    let report = f.call(&["check", "--job-id", &key, "--view-id", view]);
    assert_eq!(report["report"]["contextCompiled"], true);
    assert!(!f.workspace.join("NEVER_REPLAY").exists());
}

#[test]
fn history_cli_search_reads_full_typed_results_and_pages_with_connection_private_cursors() {
    let f = Fixture::new();
    let session = uuid::Uuid::new_v4().to_string();
    let path = f.source(&session);
    let large = format!("NEEDLE_START {} BODY_PAGE_TAIL", "x".repeat(200_000));
    let records = [
        json!({"type":"user","uuid":"a","sessionId":session,"version":"2.1.301","message":{"role":"user","content":"Search old recorded results"}}),
        json!({"type":"assistant","uuid":"b","parentUuid":"a","sessionId":session,"version":"2.1.301","message":{"role":"assistant","content":[{"type":"tool_use","id":"old","name":"Bash","input":{"command":"touch NEVER_REPLAY"}}]}}),
        json!({"type":"user","uuid":"c","parentUuid":"b","sessionId":session,"version":"2.1.301","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"old","content":[{"type":"text","text":large}]}]}}),
        json!({"type":"assistant","uuid":"d","parentUuid":"c","sessionId":session,"version":"2.1.301","message":{"role":"assistant","content":"needle_second final"}}),
    ].into_iter().map(|row|row.to_string()+"\n").collect::<String>();
    fs::write(&path, &records).unwrap();
    let key = uuid::Uuid::new_v4().to_string();
    let selected = f.selected(&session, &key);
    f.call(&[
        "run",
        "--job-id",
        &key,
        "--expected-sequence",
        &selected["sequence"].to_string(),
    ]);
    let first = f.call(&[
        "search",
        "--job-id",
        &key,
        "--query",
        "needle",
        "--limit",
        "1",
        "--read-hit",
        "1",
    ]);
    assert_eq!(first["items"][0]["block"]["kind"], "tool_result");
    assert_eq!(first["items"][0]["matched"], "NEEDLE");
    assert!(
        first["body"]["text"]
            .as_str()
            .unwrap()
            .contains("NEEDLE_START")
    );
    assert_eq!(first["body"]["hasNextPage"], true);
    assert!(first["items"][0].get("bodyCursor").is_none());
    assert!(first.get("nextCursor").is_none());
    assert_eq!(first["cursorScope"], "connection");
    let second = f.call(&[
        "search",
        "--job-id",
        &key,
        "--query",
        "needle",
        "--limit",
        "1",
        "--page",
        "1",
        "--read-hit",
        "1",
    ]);
    assert_eq!(second["page"], 1);
    assert_eq!(second["items"][0]["block"]["kind"], "text");
    assert_eq!(second["body"]["text"], "needle_second final");
    let body = f.call(&[
        "search",
        "--job-id",
        &key,
        "--query",
        "needle",
        "--limit",
        "1",
        "--read-hit",
        "1",
        "--body-page",
        "1",
    ]);
    assert_eq!(body["body"]["page"], 1);
    assert!(body["body"]["text"].as_str().unwrap().len() > 1000);
    assert!(
        !body["body"]["text"]
            .as_str()
            .unwrap()
            .contains("NEEDLE_START")
    );
    let sensitive = f.call(&[
        "search",
        "--job-id",
        &key,
        "--query",
        "NEEDLE",
        "--case-sensitive",
    ]);
    assert_eq!(sensitive["items"].as_array().unwrap().len(), 1);
    let branch = f.call(&["branch", "--job-id", &key]);
    let view = branch["progress"]["viewId"].as_str().unwrap();
    let current = f.call(&[
        "search",
        "--job-id",
        &key,
        "--view-id",
        view,
        "--query",
        "needle",
        "--read-hit",
        "1",
    ]);
    assert_eq!(current["items"].as_array().unwrap().len(), 2);
    assert!(
        current["body"]["text"]
            .as_str()
            .unwrap()
            .contains("NEEDLE_START")
    );
    assert!(
        !f.invoke(&[
            "search", "--job-id", &key, "--query", "needle", "--limit", "11"
        ])
        .status
        .success()
    );
    assert!(
        !f.invoke(&[
            "search", "--job-id", &key, "--query", "needle", "--cursor", "forged"
        ])
        .status
        .success()
    );
    assert!(!f.workspace.join("NEVER_REPLAY").exists());
    assert_eq!(fs::read_to_string(path).unwrap(), records);
}

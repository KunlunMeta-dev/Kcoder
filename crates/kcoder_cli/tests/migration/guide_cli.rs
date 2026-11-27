//! Live prompt identities drive actual command processes; fixtures never execute source tools.
#[path = "definitions_cli.rs"]
mod definitions;
#[path = "guide_history_cli.rs"]
mod history;
#[path = "guide_resource_cli.rs"]
mod initial_resources;
#[path = "guide_instruction_capture_cli.rs"]
mod instruction_capture;
#[path = "guide_instruction_cli.rs"]
mod instructions;
#[path = "memory_cli.rs"]
mod memory;
#[path = "plugin_cli.rs"]
mod plugins;
#[path = "guide_projects_cli.rs"]
mod projects;
#[path = "guide_scope_layers_cli.rs"]
mod scope_layers;
use super::*;
use std::{
    collections::BTreeSet,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin},
    sync::mpsc,
};

struct Dialog {
    child: Child,
    input: ChildStdin,
    events: mpsc::Receiver<Value>,
    errors: Option<std::thread::JoinHandle<Vec<u8>>>,
    transcript: String,
    item: Value,
    field: Value,
    state: Value,
}
impl Dialog {
    fn start(f: &Fixture, source: &str, job: Option<&str>) -> Self {
        Self::start_scoped(f, source, job, false)
    }
    fn start_scoped(f: &Fixture, source: &str, job: Option<&str>, history: bool) -> Self {
        Self::start_arguments(f, source, job, history, &[])
    }
    fn start_arguments(
        f: &Fixture,
        source: &str,
        job: Option<&str>,
        history: bool,
        extra: &[&str],
    ) -> Self {
        let mut command = Command::new(&f.binary);
        command.args([
            "migrate",
            "configure",
            "--target-profile",
            f.profile.to_str().unwrap(),
            "--jsonl",
        ]);
        if let Some(id) = job {
            command.args(["--job-id", id]);
        } else if !source.is_empty() {
            command.args([
                "--source",
                source,
                "--source-home",
                f.home.to_str().unwrap(),
            ]);
        }
        if history {
            command.arg("--include-history");
        }
        command.args(extra);
        command
            .current_dir(f.root.path().join("workspace"))
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", f.root.path().join("ambient-home"))
            .env("USERPROFILE", f.root.path().join("ambient-home"))
            .env("KCODER_CONFIG_DIR", f.root.path().join("unused-profile"))
            .env("MIGRATION_CLI_TEST_API_KEY", KEY)
            .env(
                "KCODER_TUI_LAB_REQUEST_DIR",
                f.root.path().join("model-requests"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        for name in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
            if let Some(v) = std::env::var_os(name) {
                command.env(name, v);
            }
        }
        let mut child = command.spawn().unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let errors = child.stderr.take().unwrap();
        let (send, events) = mpsc::sync_channel(32);
        std::thread::spawn(move || {
            let mut output = BufReader::new(output);
            loop {
                let mut line = Vec::new();
                if (&mut output)
                    .take(2 * 1024 * 1024 + 1)
                    .read_until(b'\n', &mut line)
                    .unwrap()
                    == 0
                {
                    break;
                }
                assert!(line.len() <= 2 * 1024 * 1024);
                if send
                    .send(serde_json::from_slice::<Value>(&line).unwrap())
                    .is_err()
                {
                    break;
                }
            }
        });
        let errors = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            errors.take(65537).read_to_end(&mut bytes).unwrap();
            assert!(bytes.len() <= 65536);
            bytes
        });
        Self {
            child,
            input,
            events,
            errors: Some(errors),
            transcript: String::new(),
            item: Value::Null,
            field: Value::Null,
            state: Value::Null,
        }
    }
    fn next(&mut self) -> Value {
        let event = self
            .events
            .recv_timeout(Duration::from_secs(30))
            .unwrap_or_else(|e| {
                let errors = self
                    .errors
                    .take()
                    .map(|handle| handle.join().unwrap())
                    .unwrap_or_default();
                let errors =
                    String::from_utf8_lossy(&errors).replace(KEY, "<redacted fixture key>");
                panic!(
                    "guide frame missing: {e}; stderr {errors}; transcript {}",
                    self.transcript
                )
            });
        self.transcript.push_str(&event.to_string());
        self.transcript.push('\n');
        for secret in [
            KEY,
            "SYNTHETIC_GUIDE_UNSELECTED_SECRET",
            "SYNTHETIC_STALE_ANSWER_SECRET",
        ] {
            assert!(!self.transcript.contains(secret));
        }
        match event["type"].as_str() {
            Some("state") => self.state = event["result"].clone(),
            Some("item") => self.item = event["result"].clone(),
            Some("private_field") => self.field = event["result"].clone(),
            _ => {}
        }
        event
    }
    fn prompt(&mut self, code: &str) -> Value {
        loop {
            let frame = self.next();
            if frame["type"] == "prompt" {
                if frame["code"] == "target_settings_scope" && code != "target_settings_scope" {
                    assert_eq!(frame["default"], "user");
                    self.answer(&frame, "user");
                    continue;
                }
                assert_eq!(
                    frame["code"], code,
                    "{frame}; public trace {}",
                    self.transcript
                );
                return frame;
            }
        }
    }
    fn answer(&mut self, prompt: &Value, value: &str) {
        self.raw_answer(prompt["id"].as_str().unwrap(), value);
    }
    fn raw_answer(&mut self, id: &str, value: &str) {
        writeln!(self.input, "{}", json!({"id":id,"value":value})).unwrap();
        self.input.flush().unwrap();
    }
    fn finish(mut self) -> String {
        let deadline = Instant::now() + Duration::from_secs(15);
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "owned guide did not exit");
            std::thread::sleep(Duration::from_millis(10));
        };
        let errors = self.errors.take().unwrap().join().unwrap();
        assert!(status.success(), "{}", String::from_utf8_lossy(&errors));
        assert!(!String::from_utf8_lossy(&errors).contains(KEY));
        self.transcript.clone()
    }
}
impl Drop for Dialog {
    fn drop(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn field_name(value: &Value) -> &str {
    value["name"].as_str().unwrap_or("")
}
fn credential_source(f: &Fixture, source: &str) {
    if source == "claude-code" {
        let mut value: Value = serde_json::from_slice(&std::fs::read(&f.config).unwrap()).unwrap();
        value["mcpServers"]["docs0"]["env"] =
            json!({"TOKEN":KEY,"UNSELECTED":"SYNTHETIC_GUIDE_UNSELECTED_SECRET"});
        std::fs::write(&f.config, value.to_string()).unwrap();
    } else {
        use std::io::Write;
        writeln!(
            std::fs::OpenOptions::new()
                .append(true)
                .open(&f.config)
                .unwrap(),
            "[mcp_servers.docs0.env]\nTOKEN='{KEY}'\nUNSELECTED='SYNTHETIC_GUIDE_UNSELECTED_SECRET'"
        )
        .unwrap();
    }
}

#[test]
fn real_guided_cli_selects_pages_confirms_private_slots_and_reopens_result_without_source() {
    for source in ["claude-code", "codex"] {
        let f = Fixture::new(source);
        credential_source(&f, source);
        let source_bytes = std::fs::read(&f.config).unwrap();
        let original = std::fs::read(f.profile.join("settings.json")).unwrap();
        let mut dialog = Dialog::start(&f, source, None);
        let first = dialog.prompt("menu");
        let job_id = dialog.state["job"]["jobId"].as_str().unwrap().to_owned();
        dialog.raw_answer(
            "00000000-0000-0000-0000-000000000000",
            "SYNTHETIC_STALE_ANSWER_SECRET",
        );
        assert_eq!(dialog.next()["code"], "migration_guide_stale_answer");
        dialog.answer(&first, "select");
        let mut chosen = BTreeSet::new();
        let mut rejected = false;
        let mut confirmed = false;
        let mut preview = false;
        let mut second_page = false;
        loop {
            let frame = dialog.next();
            if frame["type"] == "notice" {
                assert!(
                    matches!(
                        frame["code"].as_str(),
                        Some("migration_guide_not_confirmed")
                    ),
                    "{frame}"
                );
            }
            if frame["type"] != "prompt" {
                continue;
            }
            let code = frame["code"].as_str().unwrap();
            let answer = match code {
                "selection" => {
                    assert!(frame["choices"]["items"].as_array().unwrap().len() <= 10);
                    second_page |= frame["choices"]["page"].as_u64().unwrap() > 0;
                    let found = frame["choices"]["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find_map(|row| {
                            let item = &row["item"];
                            let category = item["category"].as_str().unwrap();
                            let wanted = match category {
                                "provider" => Some("provider"),
                                "mcp" if item["sourceName"] == "docs0" => Some("mcp"),
                                "skill" => Some("skill"),
                                "instructions" => Some("instructions"),
                                _ => None,
                            };
                            wanted
                                .filter(|key| !chosen.contains(*key))
                                .map(|key| (key, row["number"].as_u64().unwrap()))
                        });
                    if let Some((kind, number)) = found {
                        chosen.insert(kind.to_owned());
                        format!("toggle {number}")
                    } else if chosen.len() == 4 {
                        "preview".into()
                    } else {
                        "next".into()
                    }
                }
                "target_name" => match dialog.item["category"].as_str().unwrap() {
                    "provider" => "TerminalOffice",
                    "mcp" => "TerminalDocs",
                    "skill" => "terminal-skill",
                    _ => "terminal-instructions",
                }
                .into(),
                "endpoint" | "model" | "mcp_cwd" => String::new(),
                "context_window_tokens" => "128000".into(),
                "output_headroom_tokens" | "max_output_tokens" => "8192".into(),
                "credential_consent" => "yes".into(),
                "credential_source" => "configuration".into(),
                "mcp_private_consent" => if field_name(&dialog.field) == "TOKEN" {
                    "yes"
                } else {
                    "no"
                }
                .into(),
                "enable_mcp" | "reuse" => "no".into(),
                "enable_asset" => "yes".into(),
                "request_id" => String::new(),
                "confirm_operation" => {
                    if rejected {
                        confirmed = true;
                        "IMPORT".into()
                    } else {
                        rejected = true;
                        "no".into()
                    }
                }
                "menu" => {
                    let status = dialog.state["job"]["status"].as_str().unwrap();
                    if matches!(status, "completed" | "completed_with_issues") {
                        assert!(confirmed && second_page);
                        assert_eq!(dialog.state["batch"]["selectedItems"], 4);
                        assert_eq!(dialog.state["batch"]["publishedCredentials"], 2);
                        assert_eq!(
                            status, "completed_with_issues",
                            "saved MCP definitions are not verified activation"
                        );
                        dialog.answer(&frame, "quit");
                        break;
                    }
                    assert_eq!(status, "ready", "{}", dialog.state);
                    if !preview {
                        preview = true;
                        assert_eq!(
                            std::fs::read(f.profile.join("settings.json")).unwrap(),
                            original
                        );
                        assert!(!f.profile.join("credentials.json").exists());
                    } else if !confirmed {
                        assert_eq!(
                            std::fs::read(f.profile.join("settings.json")).unwrap(),
                            original
                        );
                    }
                    "apply".into()
                }
                other => panic!("unexpected prompt {other}: {frame}"),
            };
            dialog.answer(&frame, &answer);
        }
        let transcript = dialog.finish();
        assert!(!transcript.contains("MUST_NOT_READ_OR_MIGRATE_AUTH_CACHE"));
        assert_eq!(std::fs::read(&f.config).unwrap(), source_bytes);
        let public = kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap();
        assert!(!public.to_string().contains(KEY));
        assert_eq!(
            kcoder_config::CredentialStore::load_from(&f.profile.join("credentials.json"))
                .unwrap()
                .credentials["TerminalOffice"],
            KEY
        );
        let mcp: kcoder_types::McpServerConfig = serde_json::from_value(
            public["mcp_servers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["name"] == "TerminalDocs")
                .unwrap()
                .clone(),
        )
        .unwrap();
        let private =
            kcoder_config::imported_credentials::ImportedCredentialStore::open(&f.profile)
                .unwrap()
                .resolve_mcp_with_mode(
                    &mcp,
                    kcoder_config::CredentialStoreMode::File,
                    &kcoder_config::OsCredentialBackend::new(),
                )
                .unwrap();
        assert_eq!(private.env["TOKEN"], KEY);
        assert!(!private.env.contains_key("UNSELECTED"));
        std::fs::rename(f.config.parent().unwrap(), f.home.join("vendor-withheld")).unwrap();
        let mut reopened = Dialog::start(&f, "", None);
        let entry = reopened.prompt("entry");
        reopened.answer(&entry, "records");
        let records = reopened.prompt("records");
        assert_eq!(records["choices"]["items"][0]["jobId"], job_id);
        reopened.answer(&records, "1");
        let menu = reopened.prompt("menu");
        assert_eq!(reopened.state["job"]["status"], "completed_with_issues");
        reopened.answer(&menu, "results");
        let page = reopened.prompt("results_page");
        reopened.answer(&page, "next");
        let page = reopened.prompt("results_page");
        reopened.answer(&page, "back");
        let menu = reopened.prompt("menu");
        reopened.answer(&menu, "undo");
        let id = reopened.prompt("request_id");
        reopened.answer(&id, "");
        let confirm = reopened.prompt("confirm_operation");
        reopened.answer(&confirm, "UNDO");
        let menu = reopened.prompt("menu");
        assert_eq!(reopened.state["job"]["status"], "rolled_back");
        reopened.answer(&menu, "quit");
        reopened.finish();
        assert_eq!(
            kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap(),
            serde_json::from_slice::<Value>(&original).unwrap()
        );
        let requests = f.root.path().join("model-requests");
        assert!(!requests.exists() || std::fs::read_dir(requests).unwrap().next().is_none());
    }
}

#[test]
fn guided_template_explicitly_selects_its_connection_before_native_publication() {
    let f = Fixture::new("codex");
    std::fs::write(&f.config,"model='base-model'\nmodel_provider='Office'\n[model_providers.Office]\nbase_url='https://example.invalid/v1'\nwire_api='responses'\nenv_key='MIGRATION_CLI_TEST_API_KEY'\n[profiles.review]\nmodel='review-model'\nmodel_reasoning_effort='high'\n").unwrap();
    let mut dialog = Dialog::start(&f, "codex", None);
    let first = dialog.prompt("menu");
    dialog.answer(&first, "select");
    let mut selected = false;
    loop {
        let frame = dialog.next();
        if frame["type"] == "notice" {
            panic!("unexpected guide notice: {frame}");
        }
        if frame["type"] != "prompt" {
            continue;
        }
        let answer = match frame["code"].as_str().unwrap() {
            "selection" => {
                if selected {
                    "preview".into()
                } else if let Some(row) =
                    frame["choices"]["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|r| {
                            r["mappingKind"] == "template"
                                && r["item"]["sourceName"] == "profiles.review"
                        })
                {
                    selected = true;
                    format!("toggle {}", row["number"])
                } else {
                    "next".into()
                }
            }
            "target_name" => if dialog.item["sourceName"] == "profiles.review" {
                "terminal-review"
            } else {
                "TemplateOffice"
            }
            .into(),
            "template_dependency" => "yes".into(),
            "endpoint" | "model" | "request_id" => String::new(),
            "context_window_tokens" => "128000".into(),
            "output_headroom_tokens" | "max_output_tokens" => "8192".into(),
            "credential_consent" | "reuse" => "no".into(),
            "confirm_operation" => "IMPORT".into(),
            "menu" => {
                if dialog.state["job"]["status"] == "completed"
                    || dialog.state["job"]["status"] == "completed_with_issues"
                {
                    assert_eq!(dialog.state["batch"]["selectedItems"], 2);
                    dialog.answer(&frame, "quit");
                    break;
                }
                "apply".into()
            }
            other => panic!("unexpected template prompt {other}: {frame}"),
        };
        dialog.answer(&frame, &answer);
    }
    dialog.finish();
    let templates =
        kcoder_config::settings_templates::SettingsTemplateStore::open(&f.profile).unwrap();
    let document: Value =
        serde_json::from_str(&templates.read("terminal-review").unwrap().content).unwrap();
    assert_eq!(document["active_provider"], "TemplateOffice");
    assert_eq!(document["model_reasoning_effort"], "high");
    assert!(!f.profile.join("credentials.json").exists());
}

#[test]
fn guided_resume_requires_the_latest_cancel_watermark_and_reopens_without_auto_replay() {
    let f = Fixture::new("claude-code");
    let original = std::fs::read(f.profile.join("settings.json")).unwrap();
    let mut dialog = Dialog::start(&f, "claude-code", None);
    let first = dialog.prompt("menu");
    dialog.answer(&first, "select");
    let mut selected = false;
    let menu = loop {
        let frame = dialog.next();
        if frame["type"] != "prompt" {
            continue;
        }
        let answer = match frame["code"].as_str().unwrap() {
            "selection" => {
                if selected {
                    "preview".into()
                } else if let Some(row) = frame["choices"]["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|r| r["item"]["category"] == "skill")
                {
                    selected = true;
                    format!("toggle {}", row["number"])
                } else {
                    "next".into()
                }
            }
            "target_name" => "resumed-skill".into(),
            "enable_asset" => "yes".into(),
            "reuse" => "no".into(),
            "menu" => break frame,
            other => panic!("unexpected resume preparation {other}: {frame}"),
        };
        dialog.answer(&frame, &answer);
    };
    let id = dialog.state["job"]["jobId"].as_str().unwrap().to_owned();
    let cancel = |sequence: u64| {
        f.call(&[
            "migrate",
            "cancel",
            "--target-profile",
            f.profile.to_str().unwrap(),
            "--job-id",
            &id,
            "--expected-sequence",
            &sequence.to_string(),
        ])
    };
    let stopped = cancel(dialog.state["job"]["sequence"].as_u64().unwrap());
    dialog.answer(&menu, "apply");
    let notice = dialog.next();
    assert_eq!(notice["type"], "state");
    let mut menu = dialog.prompt("menu");
    assert_eq!(dialog.state["job"]["status"], "cancelled");
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        original
    );
    dialog.answer(&menu, "resume");
    let request = dialog.prompt("request_id");
    dialog.answer(&request, "");
    let confirm = dialog.prompt("confirm_operation");
    // A separate explicit resume stops at its owned pre-action boundary, advancing the
    // authoritative checkpoint while the older terminal confirmation is still pending.
    let store = kcoder_migration::store::MigrationStore::open_existing(&f.profile).unwrap();
    let provider = kcoder_migration::providers::ProviderTarget::open(&f.profile).unwrap();
    let mcp = kcoder_migration::mcp::McpTarget::open(&f.profile).unwrap();
    let assets = kcoder_migration::assets::AssetTarget::open(&f.profile).unwrap();
    let plan = stopped["batch"]["planId"].as_str().unwrap();
    let interrupted = match store.run_batch_controlled(
        kcoder_migration::batch::execution::BatchExecution {
            job_id: &id,
            plan_id: plan,
            request_id: "peer-owned-resume",
            expected_sequence: stopped["job"]["sequence"].as_u64().unwrap(),
            mode: kcoder_migration::batch::execution::BatchRunMode::Resume,
        },
        &kcoder_migration::store::BatchTargets {
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            credentials: None,
            history: None,
        },
        &mut |_| false,
    ) {
        Err(error) => error,
        Ok(_) => panic!("owned pre-action stop must remain an interrupted outcome"),
    };
    assert!(
        interrupted
            .to_string()
            .contains("migration_batch_worker_stopped")
    );
    let advanced = store.read(&id).unwrap();
    assert_eq!(
        advanced.status,
        kcoder_types::migration::MigrationJobStatus::Applying
    );
    // A user confirming UNDO must never publish an interrupted Apply/Resume request.
    let mut undo = Dialog::start(&f, "claude-code", Some(&id));
    let question = undo.prompt("menu");
    undo.answer(&question, "undo");
    let question = undo.prompt("request_id");
    undo.answer(&question, "peer-owned-resume");
    let question = undo.prompt("confirm_operation");
    undo.answer(&question, "UNDO");
    let question = undo.prompt("menu");
    assert!(
        store.read(&id).unwrap().receipts.is_empty(),
        "UNDO confirmation must not become publication"
    );
    undo.answer(&question, "quit");
    undo.finish();
    let again = cancel(advanced.sequence);
    assert_eq!(again["job"]["status"], "cancel_requested");
    let again_sequence = again["job"]["sequence"].as_u64().unwrap();
    assert!(again_sequence > stopped["job"]["sequence"].as_u64().unwrap());
    dialog.answer(&confirm, "RESUME");
    menu = dialog.prompt("menu");
    assert_eq!(dialog.state["job"]["sequence"], json!(again_sequence));
    assert_eq!(dialog.state["job"]["status"], "cancel_requested");
    dialog.answer(&menu, "resume");
    let request = dialog.prompt("request_id");
    dialog.answer(&request, "");
    let confirm = dialog.prompt("confirm_operation");
    dialog.answer(&confirm, "RESUME");
    let _menu = dialog.prompt("menu");
    assert_eq!(dialog.state["job"]["status"], "completed");
    let saved = std::fs::read(f.profile.join("settings.json")).unwrap();
    // Discard this idle client's completed receipt; reopening must read, not start another run.
    drop(dialog);
    let mut reopened = Dialog::start(&f, "claude-code", Some(&id));
    let menu = reopened.prompt("menu");
    assert_eq!(reopened.state["job"]["status"], "completed");
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        saved
    );
    reopened.answer(&menu, "quit");
    reopened.finish();
}

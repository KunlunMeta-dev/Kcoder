//! Actual CLI and local dialogue retain original package operations and never run their content.
use super::*;
use kcoder_migration::plugin_migration::{PluginMigrationStage, PluginMigrationStore};
use kcoder_plugins::{PluginCancellationToken, PluginStore};

fn seed(f: &Fixture, source: &str, count: usize) -> Vec<(PathBuf, Vec<u8>)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&f.profile, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let root = f.home.join(if source == "codex" {
        ".codex"
    } else {
        ".claude"
    });
    let mut installed = serde_json::Map::new();
    std::fs::create_dir_all(root.join("plugins")).unwrap();
    let mut originals = Vec::new();
    for n in 0..count {
        let name = format!("office{n:02}");
        let package = root.join(format!("plugins/cache/market/{name}/1.0.0"));
        let format = if source == "codex" {
            ".codex-plugin"
        } else {
            ".claude-plugin"
        };
        std::fs::create_dir_all(package.join(format)).unwrap();
        std::fs::create_dir_all(package.join("skills/check")).unwrap();
        let mut manifest = json!({"name":name,"version":"1.0.0"});
        if source == "claude-code" {
            manifest["mcpServers"] = json!({"docs":{"command":"MUST_NOT_EXECUTE_PLUGIN_MCP","env":{"REQUIRED_TOKEN":"${REQUIRED_TOKEN}"}}});
            manifest["hooks"] = json!({"SessionStart":[{"hooks":[{"type":"command","command":format!("touch {}",f.root.path().join("must-not-execute").display())}]}]});
        }
        let text = manifest.to_string().into_bytes();
        let path = package.join(format).join("plugin.json");
        std::fs::write(&path, &text).unwrap();
        originals.push((path, text));
        std::fs::write(
            package.join("skills/check/SKILL.md"),
            "---\nname: check\ndescription: Check supplied reports\n---\nCite original sources.\n",
        )
        .unwrap();
        installed.insert(
            format!("{name}@market"),
            json!([{"scope":"user","installPath":package,"version":"1.0.0"}]),
        );
    }
    if source == "claude-code" {
        std::fs::write(
            root.join("plugins/installed_plugins.json"),
            json!({"version":2,"plugins":installed}).to_string(),
        )
        .unwrap();
    } else {
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&f.config)
            .unwrap();
        for name in installed.keys() {
            writeln!(file, "\n[plugins.\"{name}\"]\nenabled=true").unwrap();
        }
    }
    originals
}
fn plugin(f: &Fixture, args: &[&str]) -> Value {
    let mut all = vec![
        "migrate",
        "plugin",
        "--target-profile",
        f.profile.to_str().unwrap(),
    ];
    all.extend(args);
    let result = f.invoke(&all);
    assert!(
        result.status.success(),
        "plugin action {} failed: {}; public result {}",
        args[0],
        String::from_utf8_lossy(&result.stderr),
        String::from_utf8_lossy(&result.stdout)
    );
    serde_json::from_slice(&result.stdout).unwrap()
}
fn rejected(f: &Fixture, args: &[&str]) -> String {
    let mut all = vec![
        "migrate",
        "plugin",
        "--target-profile",
        f.profile.to_str().unwrap(),
    ];
    all.extend(args);
    let output = f.invoke(&all);
    assert!(!output.status.success());
    let text = String::from_utf8(output.stderr).unwrap();
    assert!(!text.contains(KEY));
    text
}
fn prepared(f: &Fixture, source: &str, id: &str) -> Value {
    plugin(
        f,
        &[
            "prepare",
            "--source",
            source,
            "--source-home",
            f.home.to_str().unwrap(),
            "--name",
            "office00",
            "--scope",
            "user",
            "--installed-version",
            "1.0.0",
            "--request-id",
            id,
            "--confirm",
        ],
    )
}
fn choose_and_apply(_f: &Fixture, dialog: Dialog) -> (String, String) {
    let mut dialog = dialog;
    let menu = dialog.prompt("menu");
    let id = dialog.state["job"]["jobId"].as_str().unwrap().to_owned();
    dialog.answer(&menu, "select");
    let mut selected = false;
    for _ in 0..128 {
        let frame = dialog.next();
        if frame["type"] != "prompt" {
            continue;
        }
        let answer = match frame["code"].as_str().unwrap() {
            "selection" => {
                if !selected {
                    if let Some(row) = frame["choices"]["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|r| r["mappingKind"] == "plugin")
                    {
                        selected = true;
                        format!("toggle {}", row["number"])
                    } else {
                        "next".into()
                    }
                } else {
                    "preview".into()
                }
            }
            "target_name" | "plugin_target_name" => "terminal-office".into(),
            "reuse" => "no".into(),
            "menu" => {
                if dialog.state["job"]["status"] == "completed_with_issues"
                    || dialog.state["job"]["status"] == "completed"
                {
                    dialog.answer(&frame, "quit");
                    let trace = dialog.finish();
                    return (id, trace);
                }
                assert!(
                    dialog.state["batch"]["planId"].is_string(),
                    "Native preview was not accepted: {}",
                    dialog.state
                );
                "apply".into()
            }
            "request_id" => "".into(),
            "confirm_operation" => "IMPORT".into(),
            other => panic!("unexpected question {other}"),
        };
        dialog.answer(&frame, &answer);
    }
    panic!("owned dialogue exceeded its bounded prompt budget")
}
fn undo(f: &Fixture, id: &str) {
    let mut dialog = Dialog::start(f, "", Some(id));
    let p = dialog.prompt("menu");
    dialog.answer(&p, "undo");
    let p = dialog.prompt("request_id");
    dialog.answer(&p, "");
    let p = dialog.prompt("confirm_operation");
    dialog.answer(&p, "UNDO");
    let p = dialog.prompt("menu");
    assert_eq!(dialog.state["job"]["status"], "rolled_back");
    dialog.answer(&p, "quit");
    dialog.finish();
}

#[test]
fn both_plugin_formats_use_exact_selection_persistent_control_and_ready_batch_bindings() {
    for source in ["claude-code", "codex"] {
        let f = Fixture::new(source);
        let originals = seed(&f, source, 12);
        let page = plugin(
            &f,
            &[
                "discover",
                "--source",
                source,
                "--source-home",
                f.home.to_str().unwrap(),
            ],
        );
        assert_eq!(page["items"].as_array().unwrap().len(), 10);
        let next = plugin(
            &f,
            &[
                "discover",
                "--source",
                source,
                "--source-home",
                f.home.to_str().unwrap(),
                "--page",
                "1",
            ],
        );
        assert_eq!(next["items"].as_array().unwrap().len(), 2);
        let id = uuid::Uuid::new_v4().to_string();
        assert!(
            rejected(
                &f,
                &[
                    "prepare",
                    "--source",
                    source,
                    "--source-home",
                    f.home.to_str().unwrap(),
                    "--name",
                    "office00",
                    "--scope",
                    "user",
                    "--installed-version",
                    "2.0.0",
                    "--request-id",
                    &id,
                    "--confirm"
                ]
            )
            .contains("plugin_migration_selection_not_found")
        );
        let initial = prepared(&f, source, &id);
        assert_eq!(initial["stage"], "prepared");
        assert_eq!(initial["operationId"], id);
        assert_eq!(prepared(&f, source, &id)["sequence"], initial["sequence"]);
        let stopped = plugin(
            &f,
            &[
                "cancel",
                "--operation-id",
                &id,
                "--expected-sequence",
                &initial["sequence"].to_string(),
            ],
        );
        assert_eq!(stopped["cancelRequested"], true);
        let resumed = plugin(
            &f,
            &[
                "resume",
                "--operation-id",
                &id,
                "--expected-sequence",
                &stopped["sequence"].to_string(),
            ],
        );
        assert_eq!(resumed["cancelRequested"], false);
        let ready = plugin(
            &f,
            &[
                "capture",
                "--operation-id",
                &id,
                "--expected-sequence",
                &resumed["sequence"].to_string(),
                "--confirm",
            ],
        );
        assert_eq!(ready["stage"], "ready");
        if source == "claude-code" {
            assert!(!ready["readiness"].as_array().unwrap().is_empty());
        }
        let records = plugin(&f, &["records"]);
        assert_eq!(records["items"].as_array().unwrap().len(), 1);
        for (path, bytes) in &originals {
            assert_eq!(std::fs::read(path).unwrap(), *bytes);
        }
        let selector = format!("{id}:{}", ready["sequence"]);
        let (batch, trace) = choose_and_apply(
            &f,
            Dialog::start_arguments(&f, "", None, false, &["--plugin-operation", &selector]),
        );
        for forbidden in [
            "profile_root",
            "job_owner",
            "package_owner",
            "\"reference\"",
            "installPath",
            KEY,
        ] {
            assert!(
                !trace.contains(forbidden),
                "public projection contains forbidden private field"
            );
        }
        let read = plugin(&f, &["read", "--operation-id", &id]);
        if read["stage"] != "imported" {
            let parent = kcoder_migration::store::MigrationStore::open_existing(&f.profile)
                .unwrap()
                .read(&batch)
                .unwrap();
            let errors = parent
                .batch
                .as_ref()
                .unwrap()
                .actions
                .iter()
                .map(|action| action.error.as_deref())
                .collect::<Vec<_>>();
            let retained = f.root.keep();
            panic!(
                "retained owned plugin fixture {}; public child {}; parent errors {:?}",
                retained.display(),
                read,
                errors
            );
        }
        std::fs::rename(
            f.home.join(if source == "codex" {
                ".codex"
            } else {
                ".claude"
            }),
            f.home.join("source-withheld"),
        )
        .unwrap();
        assert_eq!(
            plugin(&f, &["read", "--operation-id", &id])["stage"],
            "imported"
        );
        assert_eq!(read["batchJobId"], batch);
        let store = PluginStore::open(&f.profile.join("plugin_store")).unwrap();
        let target = read["targetId"].as_str().unwrap().parse().unwrap();
        let record = store.read(&target).unwrap().unwrap();
        assert!(!record.enabled_by_default);
        assert_eq!(record.plugin_id.plugin_name(), "terminal-office");
        assert!(
            rejected(
                &f,
                &[
                    "cancel",
                    "--operation-id",
                    &id,
                    "--expected-sequence",
                    &read["sequence"].to_string()
                ]
            )
            .contains("plugin_migration_")
        );
        undo(&f, &batch);
        assert_eq!(
            plugin(&f, &["read", "--operation-id", &id])["stage"],
            "undone"
        );
        assert!(store.read(&target).unwrap().is_none());
        assert!(!f.root.path().join("must-not-execute").exists());
        assert!(!f.root.path().join("model-requests").exists());
    }
}

#[test]
fn missing_source_does_not_become_imported_and_restoring_it_resumes_the_same_operation() {
    let f = Fixture::new("claude-code");
    seed(&f, "claude-code", 1);
    let id = uuid::Uuid::new_v4().to_string();
    let initial = prepared(&f, "claude-code", &id);
    let ready = plugin(
        &f,
        &[
            "capture",
            "--operation-id",
            &id,
            "--expected-sequence",
            &initial["sequence"].to_string(),
            "--confirm",
        ],
    );
    std::fs::rename(f.home.join(".claude"), f.home.join("source-withheld")).unwrap();
    let selector = format!("{id}:{}", ready["sequence"]);
    let (batch, _) = choose_and_apply(
        &f,
        Dialog::start_arguments(&f, "", None, false, &["--plugin-operation", &selector]),
    );
    let failed = plugin(&f, &["read", "--operation-id", &id]);
    assert_eq!(failed["imported"], false);
    assert_eq!(failed["failureCode"], "plugin_migration_source_unavailable");
    let store = kcoder_migration::store::MigrationStore::open_existing(&f.profile).unwrap();
    let stopped = store.read(&batch).unwrap();
    assert!(stopped.receipts.is_empty());
    assert_eq!(
        stopped.batch.as_ref().unwrap().actions[0].error.as_deref(),
        Some("migration_source_unavailable")
    );
    std::fs::rename(f.home.join("source-withheld"), f.home.join(".claude")).unwrap();
    let done = f.call(&[
        "migrate",
        "resume-batch",
        "--target-profile",
        f.profile.to_str().unwrap(),
        "--job-id",
        &batch,
        "--plan-id",
        stopped.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
        "--request-id",
        "restore-original-source",
        "--expected-sequence",
        &stopped.sequence.to_string(),
    ]);
    assert_eq!(done["job"]["status"], "completed_with_issues");
    let imported = plugin(&f, &["read", "--operation-id", &id]);
    assert_eq!(imported["stage"], "imported");
    assert_eq!(imported["batchJobId"], batch);
    assert_eq!(store.read(&batch).unwrap().receipts.len(), 1);
    undo(&f, &batch);
}

#[test]
fn plugin_binding_errors_do_not_echo_raw_input_or_cross_profiles() {
    let f = Fixture::new("claude-code");
    seed(&f, "claude-code", 1);
    let secret = "SYNTHETIC_MALFORMED_PLUGIN_BINDING_SECRET";
    let output = f.invoke(&[
        "migrate",
        "configure",
        "--target-profile",
        f.profile.to_str().unwrap(),
        "--jsonl",
        "--plugin-operation",
        secret,
    ]);
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains(secret));
    assert!(!String::from_utf8_lossy(&output.stdout).contains(secret));
    assert!(String::from_utf8_lossy(&output.stderr).contains("plugin_migration_invalid_binding"));
    let id = uuid::Uuid::new_v4().to_string();
    let view = prepared(&f, "claude-code", &id);
    let other = Fixture::new("claude-code");
    seed(&other, "claude-code", 0);
    assert!(
        rejected(&other, &["read", "--operation-id", &id])
            .contains("plugin_migration_store_missing")
    );
    let repeated = plugin(&f, &["read", "--operation-id", &id]);
    assert_eq!(repeated["sequence"], view["sequence"]);
}

#[test]
fn persisted_plugin_records_page_by_ten_without_repeating_prepare_or_capture() {
    let f = Fixture::new("claude-code");
    seed(&f, "claude-code", 1);
    let mut expected = BTreeSet::new();
    for _ in 0..12 {
        let id = uuid::Uuid::new_v4().to_string();
        prepared(&f, "claude-code", &id);
        expected.insert(id);
    }
    let first = plugin(&f, &["records"]);
    assert_eq!(first["items"].as_array().unwrap().len(), 10);
    let next = plugin(
        &f,
        &["records", "--cursor", first["nextCursor"].as_str().unwrap()],
    );
    assert_eq!(next["items"].as_array().unwrap().len(), 2);
    assert!(next["nextCursor"].is_null());
    let actual = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .chain(next["items"].as_array().unwrap())
        .map(|job| {
            assert_eq!(job["stage"], "prepared");
            job["operationId"].as_str().unwrap().to_owned()
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(actual, expected);
    assert!(!f.profile.join("plugin_store").exists());
}

#[cfg(unix)]
#[test]
fn owned_running_capture_can_be_cancelled_and_resumed_through_the_same_cli_record() {
    struct Owner(Option<std::process::Child>);
    impl Drop for Owner {
        fn drop(&mut self) {
            if let Some(child) = &mut self.0 {
                // This unreaped exact child retains its PID; no peer process can occupy it.
                unsafe {
                    libc::kill(child.id() as libc::pid_t, libc::SIGCONT);
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    let f = Fixture::new("claude-code");
    seed(&f, "claude-code", 1);
    for n in 0..3 {
        std::fs::File::create(f.home.join(format!(
            ".claude/plugins/cache/market/office00/1.0.0/resource-{n}.bin"
        )))
        .unwrap()
        .set_len(24 * 1024 * 1024)
        .unwrap();
    }
    let id = uuid::Uuid::new_v4().to_string();
    let initial = prepared(&f, "claude-code", &id);
    let child = Command::new(&f.binary)
        .args([
            "migrate",
            "plugin",
            "--target-profile",
            f.profile.to_str().unwrap(),
            "capture",
            "--operation-id",
            &id,
            "--expected-sequence",
            &initial["sequence"].to_string(),
            "--confirm",
        ])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", f.root.path().join("ambient-home"))
        .env("KCODER_CONFIG_DIR", f.root.path().join("unused-profile"))
        .current_dir(f.root.path().join("workspace"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut owner = Owner(Some(child));
    let native = PluginMigrationStore::open_existing(&f.profile)
        .unwrap()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let active = loop {
        assert!(
            Instant::now() < deadline,
            "owned capture did not reach a running checkpoint"
        );
        assert!(
            owner.0.as_mut().unwrap().try_wait().unwrap().is_none(),
            "capture ended before its active cancellation checkpoint"
        );
        if native.running(&id).unwrap() {
            let view = native
                .read(&id, &PluginCancellationToken::default())
                .unwrap();
            if view.stage == PluginMigrationStage::Capturing {
                // Freeze only this owned worker so the separate cancellation caller observes one stable sequence.
                assert_eq!(
                    unsafe {
                        libc::kill(owner.0.as_ref().unwrap().id() as libc::pid_t, libc::SIGSTOP)
                    },
                    0
                );
                break view;
            }
        }
        std::thread::sleep(Duration::from_millis(1));
    };
    let stopped = plugin(
        &f,
        &[
            "cancel",
            "--operation-id",
            &id,
            "--expected-sequence",
            &active.sequence.to_string(),
        ],
    );
    assert_eq!(stopped["cancelRequested"], true);
    assert_eq!(
        unsafe { libc::kill(owner.0.as_ref().unwrap().id() as libc::pid_t, libc::SIGCONT) },
        0
    );
    let until = Instant::now() + Duration::from_secs(10);
    while owner.0.as_mut().unwrap().try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < until,
            "cancelled owned copy did not settle"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let output = owner.0.take().unwrap().wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains(KEY));
    let saved = plugin(&f, &["read", "--operation-id", &id]);
    assert_eq!(saved["stage"], "cancelled");
    assert!(!native.running(&id).unwrap());
    let resumed = plugin(
        &f,
        &[
            "resume",
            "--operation-id",
            &id,
            "--expected-sequence",
            &saved["sequence"].to_string(),
        ],
    );
    let ready = plugin(
        &f,
        &[
            "capture",
            "--operation-id",
            &id,
            "--expected-sequence",
            &resumed["sequence"].to_string(),
            "--confirm",
        ],
    );
    assert_eq!(ready["stage"], "ready");
    assert_eq!(ready["operationId"], id);
    assert!(!f.root.path().join("must-not-execute").exists());
}

#[test]
fn guide_reviews_one_plugin_and_reopens_the_original_copy_record_without_source() {
    let f = Fixture::new("claude-code");
    seed(&f, "claude-code", 1);
    let mut dialog =
        Dialog::start_arguments(&f, "claude-code", None, false, &["--include-plugins"]);
    let p = dialog.prompt("plugin_selection");
    dialog.answer(&p, "select 1");
    let p = dialog.prompt("plugin_request_id");
    let operation = p["default"].as_str().unwrap().to_owned();
    dialog.answer(&p, "");
    let p = dialog.prompt("plugin_capture_consent");
    dialog.answer(&p, "yes");
    let p = dialog.prompt("plugin_use_consent");
    dialog.answer(&p, "no");
    let p = dialog.prompt("plugin_selection");
    dialog.answer(&p, "skip");
    let p = dialog.prompt("menu");
    dialog.answer(&p, "quit");
    dialog.finish();
    std::fs::rename(f.home.join(".claude"), f.home.join("source-withheld")).unwrap();
    let mut dialog = Dialog::start(&f, "", None);
    let p = dialog.prompt("entry");
    dialog.answer(&p, "plugin-records");
    let p = dialog.prompt("plugin_records");
    assert_eq!(p["choices"]["items"][0]["job"]["operationId"], operation);
    dialog.answer(&p, "1");
    let p = dialog.prompt("plugin_record_menu");
    dialog.answer(&p, "read");
    let p = dialog.prompt("plugin_record_menu");
    std::fs::rename(f.home.join("source-withheld"), f.home.join(".claude")).unwrap();
    dialog.answer(&p, "use");
    let (batch, trace) = choose_and_apply(&f, dialog);
    assert!(!trace.contains("\"reference\""));
    let native = PluginMigrationStore::open_existing(&f.profile)
        .unwrap()
        .unwrap();
    assert_eq!(
        native
            .read(&operation, &PluginCancellationToken::default())
            .unwrap()
            .stage,
        PluginMigrationStage::Imported
    );
    std::fs::rename(f.home.join(".claude"), f.home.join("source-withheld")).unwrap();
    undo(&f, &batch);
}

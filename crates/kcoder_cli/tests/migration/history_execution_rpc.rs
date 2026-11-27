//! Real connections observe the Native execution lease, including a batch-owned child.
use super::{Fixture, TestAppServer, Value, json, rpc};
use sha2::{Digest, Sha256};
#[path = "../../../kcoder_migration/examples/history_reinterpretation_fixture/owned.rs"]
mod owned_legacy;
use super::persisted_legacy;
use std::{
    fs,
    time::{Duration, Instant},
};

#[test]
fn failed_version_one_old_parser_owner_check_keeps_the_failed_checkpoint_and_enables_explicit_reinterpretation()
 {
    let f = Fixture::new();
    fs::write(
        f.profile.join("settings.json"),
        r#"{"credential_store":"file"}"#,
    )
    .unwrap();
    let (source_job, _, source) = persisted_legacy::legacy(
        &f.profile,
        &f.claude,
        kcoder_types::migration::MigrationSourceKind::ClaudeCode,
        false,
    );
    let old = owned_legacy::from_job(&f.profile, &source_job.job_id).unwrap();
    let path = f
        .profile
        .join("migrations/history")
        .join(format!("{}.json", old.job_id));
    let before: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(before["version"], 1);
    let source_before = fs::read(&source).unwrap();
    let archives = persisted_legacy::snapshot(&f.profile.join("external-history"));
    let mut server = start(&f, true);
    let current = read(&mut server, &json!(old.job_id));
    assert_eq!(current["workerState"], "unknown");
    assert_eq!(current["workerError"], "history_job_execution_untracked");
    assert_eq!(current["job"]["stage"], "failed");
    let checked = rpc(
        &mut server,
        60,
        "migration/history/resume",
        json!({"jobId":old.job_id,"expectedSequence":old.sequence}),
    );
    assert_eq!(checked["workerState"], "stopped");
    assert_eq!(checked["job"], current["job"]);
    let mut after: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    after.as_object_mut().unwrap().remove("executionIdentity");
    after
        .as_object_mut()
        .unwrap()
        .remove("executionBirthSha256");
    assert_eq!(after, before);
    assert_eq!(
        persisted_legacy::snapshot(&f.profile.join("external-history")),
        archives
    );
    assert_eq!(fs::read(source).unwrap(), source_before);
    assert_eq!(
        rpc(
            &mut server,
            61,
            "migration/history/reinterpret/preview",
            json!({"sourceJobId":old.job_id})
        )["canCreate"],
        true
    );
    server.shutdown();
}

fn start(f: &Fixture, opted: bool) -> TestAppServer {
    let mut builder = TestAppServer::builder(&f.workspace, &f.overlay)
        .config_dir(&f.profile)
        .discard_stderr();
    for (key, value) in [
        ("HOME", f.root.path()),
        ("USERPROFILE", f.root.path()),
        ("CLAUDE_CONFIG_DIR", f.claude.as_path()),
        ("CODEX_HOME", f.codex.as_path()),
    ] {
        builder
            .extra_env
            .push((key.into(), value.as_os_str().into()));
    }
    let mut server = builder.spawn();
    let init = rpc(
        &mut server,
        1,
        "initialize",
        json!({"protocolVersion":"2026-07-27",
        "clientInfo":{"name":"owned-history-execution","version":"1"},
        "capabilities":{"experimental":{"migrationHistoryWorkerStateV1":opted}}}),
    );
    assert_eq!(
        init["capabilities"]["experimental"]["migrationHistoryWorkerStateV1"],
        opted
    );
    server
}
fn read(server: &mut TestAppServer, child: &Value) -> Value {
    rpc(
        server,
        900,
        "migration/history/read",
        json!({"jobId":child}),
    )
}
fn stopped(server: &mut TestAppServer, child: &Value) -> Value {
    // Normalization makes each record durable before acknowledging it, so a
    // debug build on a disk with ~3 ms fsync needs well over 30 s for a few
    // thousand records. The deadline bounds a hang, not the expected speed.
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        let value = read(server, child);
        if value["workerState"] == "stopped" {
            assert_eq!(value["workerRunning"], false);
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "owned worker did not stop: {value}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn call_error(server: &mut TestAppServer, method: &str, params: Value) -> Value {
    server.send(json!({"jsonrpc":"2.0","id":901,"method":method,"params":params}));
    let value = server.response(901);
    assert!(
        value.get("error").is_some(),
        "unexpected acceptance: {value}"
    );
    value
}

#[test]
fn a_batch_child_is_globally_running_across_actual_connections_until_its_owner_exits() {
    let f = Fixture::new();
    let source = f.source(3000);
    let old_tool_marker = f.root.path().join("old-tool-must-not-run");
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new().append(true).open(&source).unwrap();
        writeln!(file,"{}",json!({"type":"assistant","uuid":"inert-call-message","message":{"role":"assistant","content":[{"type":"tool_use","id":"inert-old-call","name":"Bash","input":{"command":format!("printf unsafe > {}",old_tool_marker.display())}}]}})).unwrap();
        writeln!(file,"{}",json!({"type":"user","uuid":"inert-result-message","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"inert-old-call","content":"Recorded output only"}]}})).unwrap();
    }
    let original = Sha256::digest(fs::read(&source).unwrap());
    fs::write(
        f.profile.join("settings.json"),
        r#"{"credential_store":"file"}"#,
    )
    .unwrap();
    let mut parent = start(&f, true);
    let mut peer = start(&f, true);
    let mut legacy = start(&f, false);
    let catalog = rpc(
        &mut parent,
        2,
        "migration/history/discover",
        json!({"source":"claude-code"}),
    );
    let scan = rpc(
        &mut parent,
        3,
        "migration/batch/scan",
        json!({"sourceIds":[],"historySources":[{"catalogId":catalog["catalogId"],"sourceHandle":catalog["items"][0]["sourceHandle"]}]}),
    );
    let job = scan["job"]["jobId"].clone();
    let plan = rpc(
        &mut parent,
        4,
        "migration/batch/plan",
        json!({"jobId":job,"expectedSequence":scan["job"]["sequence"],"choices":[],"includeDefaultItems":true}),
    );
    let page = rpc(&mut parent, 5, "migration/items", json!({"jobId":job}));
    let detail = rpc(
        &mut parent,
        6,
        "migration/batch/item/plan",
        json!({"jobId":job,"itemId":page["items"][0]["id"]}),
    );
    let child = detail["item"]["historyJobId"].clone();
    let accepted = rpc(
        &mut parent,
        7,
        "migration/batch/run",
        json!({"jobId":job,"expectedSequence":plan["job"]["sequence"],"planId":plan["batch"]["planId"],"requestId":"owned-execution-parent","mode":"apply"}),
    );
    assert_eq!(accepted["workerRunning"], true);
    let deadline = Instant::now() + Duration::from_secs(15);
    let active = loop {
        parent.send(json!({"jsonrpc":"2.0","id":8,"method":"migration/history/read","params":{"jobId":child}}));
        let value = parent.response(8);
        if value.get("error").is_none() {
            break value["result"].clone();
        }
        assert!(Instant::now() < deadline, "batch child was not accepted");
        std::thread::sleep(Duration::from_millis(2));
    };
    assert_eq!(
        active["workerState"], "running",
        "fixture must observe the active batch owner: {active}"
    );
    assert_eq!(active["workerRunning"], true);
    assert_eq!(read(&mut peer, &child)["workerState"], "running");
    let old = read(&mut legacy, &child);
    assert!(old.get("workerState").is_none());
    assert_eq!(old["workerRunning"], true);
    let duplicate = rpc(
        &mut peer,
        9,
        "migration/history/run",
        json!({"jobId":child,"expectedSequence":active["job"]["sequence"]}),
    );
    assert_eq!(duplicate["workerState"], "running");
    parent.shutdown();
    let interrupted = stopped(&mut peer, &child);
    assert_eq!(interrupted["job"]["stage"], "cancelled");
    let resumed = rpc(
        &mut peer,
        10,
        "migration/history/resume",
        json!({"jobId":child,"expectedSequence":interrupted["job"]["sequence"]}),
    );
    assert_eq!(resumed["workerState"], "stopped");
    rpc(
        &mut peer,
        11,
        "migration/history/run",
        json!({"jobId":child,"expectedSequence":resumed["job"]["sequence"]}),
    );
    let done = stopped(&mut peer, &child);
    assert_eq!(done["job"]["stage"], "normalized");
    assert_eq!(done["job"]["normalization"]["normalizedRecords"], 3002);
    assert!(read(&mut legacy, &child).get("workerState").is_none());
    assert_eq!(Sha256::digest(fs::read(source).unwrap()), original);
    assert!(!old_tool_marker.exists());
    peer.shutdown();
    legacy.shutdown();
}

#[test]
fn unknown_old_ownership_requires_explicit_cancel_resume_and_a_missing_born_lock_is_never_repaired()
{
    let f = Fixture::new();
    let source = f.source(1);
    let original = fs::read(&source).unwrap();
    fs::write(
        f.profile.join("settings.json"),
        r#"{"credential_store":"file"}"#,
    )
    .unwrap();
    let mut server = start(&f, false);
    let catalog = rpc(
        &mut server,
        2,
        "migration/history/discover",
        json!({"source":"claude-code"}),
    );
    let id = uuid::Uuid::new_v4().to_string();
    let created = rpc(
        &mut server,
        3,
        "migration/history/create",
        json!({"catalogId":catalog["catalogId"],"sourceHandle":catalog["items"][0]["sourceHandle"],"requestId":id}),
    );
    assert!(created.get("workerState").is_none());
    server.shutdown();
    let dir = f.profile.join("migrations/history");
    let header = dir.join(format!("{id}.json"));
    let mut value: Value = serde_json::from_slice(&fs::read(&header).unwrap()).unwrap();
    value.as_object_mut().unwrap().remove("executionIdentity");
    value
        .as_object_mut()
        .unwrap()
        .remove("executionBirthSha256");
    fs::write(&header, serde_json::to_vec(&value).unwrap()).unwrap();
    for suffix in ["execution.lock", "execution.birth"] {
        fs::remove_file(dir.join(format!("{id}.{suffix}"))).unwrap();
    }
    let mut server = start(&f, true);
    let child = json!(id);
    let unknown = read(&mut server, &child);
    assert_eq!(unknown["workerState"], "unknown");
    assert_eq!(unknown["workerError"], "history_job_execution_untracked");
    call_error(
        &mut server,
        "migration/history/run",
        json!({"jobId":id,"expectedSequence":0}),
    );
    let cancelled = rpc(
        &mut server,
        4,
        "migration/history/cancel",
        json!({"jobId":id}),
    );
    assert_eq!(cancelled["workerState"], "unknown");
    assert_eq!(cancelled["job"]["cancelRequested"], true);
    assert!(!dir.join(format!("{id}.execution.lock")).exists());
    let resumed = rpc(
        &mut server,
        5,
        "migration/history/resume",
        json!({"jobId":id,"expectedSequence":0}),
    );
    assert_eq!(resumed["workerState"], "stopped");
    rpc(
        &mut server,
        6,
        "migration/history/run",
        json!({"jobId":id,"expectedSequence":resumed["job"]["sequence"]}),
    );
    let done = stopped(&mut server, &child);
    assert_eq!(done["job"]["stage"], "normalized");
    let lock = dir.join(format!("{id}.execution.lock"));
    fs::remove_file(&lock).unwrap();
    let missing = read(&mut server, &child);
    assert_eq!(missing["workerState"], "unknown");
    assert_eq!(missing["workerError"], "history_job_execution_unknown");
    call_error(
        &mut server,
        "migration/history/run",
        json!({"jobId":id,"expectedSequence":missing["job"]["sequence"]}),
    );
    call_error(
        &mut server,
        "migration/history/resume",
        json!({"jobId":id,"expectedSequence":missing["job"]["sequence"]}),
    );
    assert!(!lock.exists());
    assert_eq!(fs::read(source).unwrap(), original);
    server.shutdown();
}

#[test]
fn normalized_old_parser_metadata_can_be_explicitly_reconciled_without_running_or_changing_history()
{
    let f = Fixture::new();
    fs::write(
        f.profile.join("settings.json"),
        r#"{"credential_store":"file"}"#,
    )
    .unwrap();
    let (done, _, source) = persisted_legacy::legacy(
        &f.profile,
        &f.claude,
        kcoder_types::migration::MigrationSourceKind::ClaudeCode,
        false,
    );
    let directory = f.profile.join("migrations/history");
    let header_path = directory.join(format!("{}.json", done.job_id));
    let mut header: Value = serde_json::from_slice(&fs::read(&header_path).unwrap()).unwrap();
    header.as_object_mut().unwrap().remove("executionIdentity");
    header
        .as_object_mut()
        .unwrap()
        .remove("executionBirthSha256");
    fs::write(&header_path, serde_json::to_vec(&header).unwrap()).unwrap();
    for suffix in ["execution.lock", "execution.birth"] {
        fs::remove_file(directory.join(format!("{}.{suffix}", done.job_id))).unwrap();
    }
    let original = fs::read(&source).unwrap();
    let archives = persisted_legacy::snapshot(&f.profile.join("external-history"));
    let mut server = start(&f, true);
    let old = read(&mut server, &json!(done.job_id));
    assert_eq!(old["workerState"], "unknown");
    assert_eq!(old["workerError"], "history_job_execution_untracked");
    assert_eq!(old["job"]["stage"], "normalized");
    let reconciled = rpc(
        &mut server,
        50,
        "migration/history/resume",
        json!({"jobId":done.job_id,"expectedSequence":done.sequence}),
    );
    assert_eq!(reconciled["workerState"], "stopped");
    assert_eq!(reconciled["workerRunning"], false);
    assert_eq!(reconciled["job"], old["job"]);
    let mut after: Value = serde_json::from_slice(&fs::read(&header_path).unwrap()).unwrap();
    after.as_object_mut().unwrap().remove("executionIdentity");
    after
        .as_object_mut()
        .unwrap()
        .remove("executionBirthSha256");
    assert_eq!(after, header);
    assert!(
        after["normalizationRevision"]
            .as_str()
            .unwrap()
            .starts_with("foreign-records/3")
    );
    assert_eq!(fs::read(source).unwrap(), original);
    assert_eq!(
        persisted_legacy::snapshot(&f.profile.join("external-history")),
        archives
    );
    let threads = rpc(&mut server, 51, "thread/list", json!({}));
    assert!(threads["threads"].as_array().unwrap().is_empty());
    server.shutdown();
}

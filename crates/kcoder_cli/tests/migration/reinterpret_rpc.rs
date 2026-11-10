//! Real app-server calls over artificial persisted legacy state, with no source replay.
use super::persisted_legacy as legacy;
use super::*;
use kcoder_migration::{
    history_jobs::HistoryJobStore,
    history_normalization::{
        HISTORY_NORMALIZATION_REVISION, LEGACY_HISTORY_NORMALIZATION_REVISION,
    },
};
use kcoder_types::migration::MigrationSourceKind;

fn start(fixture: &Fixture) -> TestAppServer {
    let mut builder = TestAppServer::builder(&fixture.workspace, &fixture.overlay)
        .config_dir(&fixture.profile)
        .discard_stderr();
    for (name, path) in [
        ("HOME", fixture.root.path()),
        ("USERPROFILE", fixture.root.path()),
        ("CLAUDE_CONFIG_DIR", fixture.claude.as_path()),
        ("CODEX_HOME", fixture.codex.as_path()),
    ] {
        builder
            .extra_env
            .push((name.into(), path.as_os_str().into()));
    }
    builder.extra_env.push((
        "KCODER_TUI_LAB_REQUEST_DIR".into(),
        fixture.workspace.join("model-requests").into_os_string(),
    ));
    let mut server = builder.spawn();
    let initialized = rpc(
        &mut server,
        1,
        "initialize",
        json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"reinterpretation-fixture","version":"test"}}),
    );
    assert_eq!(
        initialized["capabilities"]["experimental"]["migrationHistoryReinterpretationV1"],
        true
    );
    server
}
fn wait_branch(server: &mut TestAppServer, job: &str, view: &str) {
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let result = rpc(
            server,
            100,
            "migration/history/branch/read",
            json!({"jobId":job,"viewId":view}),
        );
        assert_ne!(result["progress"]["stage"], "failed", "{result}");
        if result["progress"]["stage"] == "ready" && result["workerRunning"] == false {
            return;
        }
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn branch(server: &mut TestAppServer, job: &str) -> String {
    let result = rpc(
        server,
        101,
        "migration/history/branch/prepare",
        json!({"jobId":job}),
    );
    let view = result["progress"]["viewId"].as_str().unwrap().to_owned();
    rpc(
        server,
        102,
        "migration/history/branch/run",
        json!({"jobId":job,"viewId":view}),
    );
    wait_branch(server, job, &view);
    rpc(
        server,
        103,
        "migration/history/branch/tools/run",
        json!({"jobId":job,"viewId":view}),
    );
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let result = rpc(
            server,
            104,
            "migration/history/branch/tools/read",
            json!({"jobId":job,"viewId":view}),
        );
        if result["state"]["run"]["stage"] == "ready" {
            return view;
        }
        assert_ne!(result["state"]["run"]["stage"], "failed", "{result}");
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn wait_attachment(server: &mut TestAppServer, selection: &Value, stage: &str) -> Value {
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let result = rpc(
            server,
            110,
            "migration/history/tool-attachments/read",
            json!({"selection":selection}),
        );
        assert_ne!(result["job"]["stage"], "failed", "{result}");
        if result["job"]["stage"] == stage && result["workerRunning"] == false {
            return result;
        }
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn continue_from(server: &mut TestAppServer, job: &str, view: &str) -> Value {
    let key = uuid::Uuid::new_v4().to_string();
    super::branches::continuation::create_continuation(server, job, &json!(view), &key);
    rpc(
        server,
        111,
        "migration/history/continuation/run",
        json!({"jobId":key,"expectedSequence":0}),
    );
    super::branches::continuation::wait_continuation(server, &key)
}
fn assert_inert(fixture: &Fixture) {
    assert!(
        !fixture
            .workspace
            .join("NEVER_REPLAY_REINTERPRETATION")
            .exists()
    );
    let requests = fixture.workspace.join("model-requests");
    assert!(
        !requests.exists() || fs::read_dir(requests).unwrap().next().is_none(),
        "reinterpretation requested a model"
    );
}

#[test]
fn reinterpret_rpc_preserves_legacy_cache_and_cursor_then_uses_fixed_rows_with_truthful_context_budget()
 {
    let fixture = Fixture::new();
    fs::write(&fixture.overlay, json!({"api_format":"anthropic_messages","context_window_tokens":1000000,"context_output_headroom":10000,"max_tokens":2048}).to_string()).unwrap();
    let (old, _, path) = legacy::legacy(
        &fixture.profile,
        &fixture.claude,
        MigrationSourceKind::ClaudeCode,
        true,
    );
    fs::remove_file(path).unwrap();
    let archived = fixture
        .profile
        .join("external-history")
        .join(old.archive_id.as_ref().unwrap());
    let before = legacy::snapshot(&archived);
    let old_journal = fixture
        .profile
        .join("migrations/history")
        .join(format!("{}.json", old.job_id));
    let old_bytes = fs::read(&old_journal).unwrap();
    let mut server = start(&fixture);
    let preview = rpc(
        &mut server,
        2,
        "migration/history/reinterpret/preview",
        json!({"sourceJobId":old.job_id}),
    );
    assert_eq!(
        preview["sourceRevision"],
        LEGACY_HISTORY_NORMALIZATION_REVISION
    );
    assert_eq!(preview["parserRevision"], HISTORY_NORMALIZATION_REVISION);
    assert_eq!(preview["canCreate"], true);
    assert_eq!(legacy::snapshot(&archived), before);
    let key = uuid::Uuid::new_v4().to_string();
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"migration/history/reinterpret/create","params":{"requestId":key,"sourceJobId":old.job_id,"expectedSourceSequence":old.sequence}}));
    let until = Instant::now() + Duration::from_secs(10);
    let created = fixture
        .profile
        .join("migrations/history")
        .join(format!("{key}.json"));
    while !created.exists() {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(2));
    }
    // The client never consumes its creation acknowledgement. Reopen and reconcile the same ID.
    drop(server);
    let mut server = start(&fixture);
    let accepted = rpc(
        &mut server,
        4,
        "migration/history/reinterpret/create",
        json!({"requestId":key,"sourceJobId":old.job_id,"expectedSourceSequence":old.sequence}),
    );
    assert_eq!(accepted["job"]["jobId"], key);
    assert_eq!(accepted["job"]["sequence"], 0);
    assert_eq!(accepted["workerRunning"], false);
    assert!(accepted["job"]["normalization"].is_null());
    assert_eq!(legacy::snapshot(&archived), before);
    let old_page = rpc(
        &mut server,
        5,
        "migration/history/transcript",
        json!({"jobId":old.job_id}),
    );
    assert_eq!(
        old_page["adapterRevision"],
        LEGACY_HISTORY_NORMALIZATION_REVISION
    );
    let old_body = rpc(
        &mut server,
        6,
        "migration/history/text",
        json!({"jobId":old.job_id,"record":0,"blockIndex":0}),
    );
    assert!(old_body["nextCursor"].is_string());
    rpc(
        &mut server,
        7,
        "migration/history/run",
        json!({"jobId":key,"expectedSequence":0}),
    );
    let done = wait(&mut server, &key, |value| {
        value["job"]["stage"] == "normalized" && value["workerRunning"] == false
    });
    assert_eq!(done["job"]["normalization"]["recordsWithDiagnostics"], 0);
    assert_eq!(
        rpc(
            &mut server,
            8,
            "migration/history/transcript",
            json!({"jobId":key})
        )["adapterRevision"],
        HISTORY_NORMALIZATION_REVISION
    );
    let remaining = rpc(
        &mut server,
        9,
        "migration/history/text",
        json!({"jobId":old.job_id,"record":0,"blockIndex":0,"cursor":old_body["nextCursor"]}),
    );
    assert!(!remaining["text"].as_str().unwrap().is_empty());
    assert_eq!(
        rpc(
            &mut server,
            10,
            "migration/history/transcript",
            json!({"jobId":old.job_id})
        ),
        old_page
    );
    let view = branch(&mut server, &key);
    let selection = json!({"jobId":key,"viewId":view,"position":2,"blockIndex":0});
    rpc(
        &mut server,
        112,
        "migration/history/tool-attachments/run",
        json!({"selection":selection}),
    );
    assert_eq!(
        wait_attachment(&mut server, &selection, "catalogued")["job"]["catalog"]["attachments"],
        1
    );
    let item = json!({"jobId":key,"viewId":view,"position":2,"blockIndex":0,"toolItemIndex":0});
    rpc(
        &mut server,
        113,
        "migration/history/tool-attachments/run",
        json!({"selection":item}),
    );
    assert!(wait_attachment(&mut server, &item, "ready")["job"]["info"]["receipt"].is_object());
    let continuation = uuid::Uuid::new_v4().to_string();
    super::branches::continuation::create_continuation(
        &mut server,
        &key,
        &json!(view),
        &continuation,
    );
    rpc(
        &mut server,
        114,
        "migration/history/continuation/run",
        json!({"jobId":continuation,"expectedSequence":0}),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    let blocked = loop {
        let value = rpc(
            &mut server,
            115,
            "migration/history/continuation/read",
            json!({"jobId":continuation}),
        );
        if value["workerRunning"] == false {
            break value;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(blocked["job"]["stage"], "blocked");
    assert!(
        blocked["job"]["compilation"]["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|issue| issue["code"] == "history_context_part_budget_exceeded")
    );
    // A durable target ID is reserved before compilation; it is not a published session.
    assert!(blocked["job"]["threadId"].is_string());
    assert!(blocked["job"]["projection"].is_null());
    assert_eq!(
        rpc(&mut server, 116, "thread/list", json!({}))["threads"],
        json!([])
    );
    assert_eq!(fs::read(old_journal).unwrap(), old_bytes);
    assert_inert(&fixture);
}

#[test]
fn current_jobs_avoid_legacy_cache_and_existing_published_continuation_keeps_its_old_interpretation()
 {
    let fixture = Fixture::new();
    fs::write(&fixture.overlay,json!({"api_format":"anthropic_messages","context_window_tokens":1000000,"context_output_headroom":10000,"max_tokens":2048}).to_string()).unwrap();
    let (old, binding, path) = legacy::legacy(
        &fixture.profile,
        &fixture.claude,
        MigrationSourceKind::ClaudeCode,
        false,
    );
    let mut server = start(&fixture);
    let old_view = branch(&mut server, &old.job_id);
    let old_continuation = continue_from(&mut server, &old.job_id, &old_view);
    let old_thread = old_continuation["job"]["threadId"].clone();
    let old_source = rpc(
        &mut server,
        120,
        "migration/history/continuation/source",
        json!({"threadId":old_thread}),
    );
    fs::remove_file(path).unwrap();
    let jobs = HistoryJobStore::open(&fixture.profile).unwrap();
    let key = uuid::Uuid::new_v4().to_string();
    let current = jobs.create(&key, &binding).unwrap();
    assert_eq!(
        jobs.normalization_revision(&key).unwrap(),
        HISTORY_NORMALIZATION_REVISION
    );
    assert_eq!(
        jobs.normalization_revision(&old.job_id).unwrap(),
        LEGACY_HISTORY_NORMALIZATION_REVISION
    );
    rpc(
        &mut server,
        121,
        "migration/history/run",
        json!({"jobId":key,"expectedSequence":current.sequence}),
    );
    wait(&mut server, &key, |value| {
        value["job"]["stage"] == "normalized" && value["workerRunning"] == false
    });
    let current_view = branch(&mut server, &key);
    assert_ne!(current_view, old_view);
    let new_continuation = continue_from(&mut server, &key, &current_view);
    assert_ne!(new_continuation["job"]["threadId"], old_thread);
    assert_eq!(
        rpc(
            &mut server,
            122,
            "migration/history/continuation/source",
            json!({"threadId":old_thread})
        ),
        old_source
    );
    assert_eq!(
        rpc(
            &mut server,
            123,
            "migration/history/branch/read",
            json!({"jobId":old.job_id,"viewId":old_view})
        )["progress"]["stage"],
        "ready"
    );
    assert_inert(&fixture);
}

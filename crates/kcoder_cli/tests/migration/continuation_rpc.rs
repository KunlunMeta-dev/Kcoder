use super::*;
pub(in super::super) fn setup() -> (Fixture, std::path::PathBuf) {
    let fixture = Fixture::new();
    fs::write(&fixture.overlay,json!({"api_format":"anthropic_messages","context_window_tokens":1000000,"context_output_headroom":10000,"max_tokens":2048}).to_string()).unwrap();
    let file = fixture.source(0);
    let session = file.file_stem().unwrap().to_str().unwrap();
    let marker = fixture.workspace.join("NEVER_REPLAY_CONTINUATION");
    let records = [
        json!({"type":"assistant","uuid":"old-call","sessionId":session,"version":"2.1.301","message":{"role":"assistant","content":[{"type":"tool_use","id":"old","name":"Bash","input":{"command":format!("touch {}",marker.display())}}]}}),
        json!({"type":"user","uuid":"old-result","parentUuid":"old-call","sessionId":session,"version":"2.1.301","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"old","content":"result received"}]}}),
    ];
    fs::write(
        &file,
        records
            .into_iter()
            .map(|record| record.to_string() + "\n")
            .collect::<String>(),
    )
    .unwrap();
    (fixture, file)
}
pub(in super::super) fn selected(server: &mut TestAppServer) -> (String, Value) {
    let job = archive(server);
    let prepared = rpc(
        server,
        40,
        "migration/history/branch/prepare",
        json!({"jobId":job}),
    );
    let view = prepared["progress"]["viewId"].clone();
    rpc(
        server,
        41,
        "migration/history/branch/run",
        json!({"jobId":job,"viewId":view}),
    );
    wait_branch(server, &job, &view);
    rpc(
        server,
        42,
        "migration/history/branch/tools/run",
        json!({"jobId":job,"viewId":view}),
    );
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let result = rpc(
            server,
            43,
            "migration/history/branch/tools/read",
            json!({"jobId":job,"viewId":view}),
        );
        if result["state"]["run"]["stage"] == "ready" {
            break;
        }
        assert!(Instant::now() < until, "{result}");
        std::thread::sleep(Duration::from_millis(10));
    }
    (job, view)
}
pub(in super::super) fn create_continuation(
    server: &mut TestAppServer,
    source: &str,
    view: &Value,
    key: &str,
) -> Value {
    rpc(
        server,
        50,
        "migration/history/continuation/create",
        json!({"requestId":key,"sourceJobId":source,"viewId":view,"policy":{"maxContextBytes":4194304,"maxEntries":2048,"maxAttachments":256,"maxAttachmentBytes":536870912},"options":{"model":null,"settingsTemplate":null,"studioWorkMode":"kworker"}}),
    )
}
pub(in super::super) fn wait_continuation(server: &mut TestAppServer, key: &str) -> Value {
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let result = rpc(
            server,
            51,
            "migration/history/continuation/read",
            json!({"jobId":key}),
        );
        if result["workerRunning"] == false && result["job"]["stage"] == "imported" {
            return result;
        }
        assert!(
            result["workerRunning"] == true
                || !["failed", "blocked", "publish_unknown"]
                    .contains(&result["job"]["stage"].as_str().unwrap_or("")),
            "{result}"
        );
        assert!(Instant::now() < until, "{result}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn continuation_rpc_publishes_one_idle_native_thread_and_recovers_without_source_execution() {
    let (fixture, file) = setup();
    let original = fs::read(&file).unwrap();
    let mut server = fixture.start();
    let (source, view) = selected(&mut server);
    let key = uuid::Uuid::new_v4().to_string();
    let created = create_continuation(&mut server, &source, &view, &key);
    assert_eq!(created["job"]["stage"], "planned");
    assert!(created["job"]["threadId"].is_null());
    rpc(
        &mut server,
        52,
        "migration/history/continuation/run",
        json!({"jobId":key,"expectedSequence":0}),
    );
    let ready = wait_continuation(&mut server, &key);
    let thread = ready["job"]["threadId"].clone();
    let origin = rpc(
        &mut server,
        90,
        "migration/history/continuation/source",
        json!({"threadId":thread}),
    );
    assert_eq!(origin["source"]["sourceJobId"], source);
    assert_eq!(origin["source"]["viewId"], view);
    assert_eq!(origin["source"]["operationId"], key);
    assert!(
        !origin
            .to_string()
            .contains(fixture.root.path().to_str().unwrap())
    );
    assert_eq!(thread.as_str().unwrap().len(), 5);
    assert!(
        !ready
            .to_string()
            .contains(fixture.root.path().to_str().unwrap())
    );
    assert!(!ready.to_string().contains("result received"));
    assert!(!fixture.workspace.join("NEVER_REPLAY_CONTINUATION").exists());
    assert_eq!(fs::read(&file).unwrap(), original);
    let read = rpc(&mut server, 53, "thread/read", json!({"threadId":thread}));
    assert_eq!(read["thread"]["id"], thread);
    assert!(
        !read["thread"]["title"]
            .as_str()
            .unwrap_or("")
            .contains("Historical evidence")
    );
    assert!(!read["thread"]["title"].as_str().unwrap_or("").is_empty());
    assert_eq!(
        create_continuation(&mut server, &source, &view, &key)["job"]["threadId"],
        thread
    );
    drop(server);
    fs::remove_file(file).unwrap();
    let mut reopened = fixture.start();
    assert_eq!(
        rpc(
            &mut reopened,
            91,
            "migration/history/continuation/source",
            json!({"threadId":thread})
        ),
        origin
    );
    let restored = rpc(
        &mut reopened,
        54,
        "migration/history/continuation/read",
        json!({"jobId":key}),
    );
    assert_eq!(restored["job"], ready["job"]);
    assert_eq!(
        rpc(
            &mut reopened,
            55,
            "migration/history/continuation/run",
            json!({"jobId":key,"expectedSequence":ready["job"]["sequence"]})
        )["job"]["threadId"],
        thread
    );
    assert!(!fixture.workspace.join("NEVER_REPLAY_CONTINUATION").exists());
}

#[test]
fn continuation_cancel_before_run_is_durable_and_requires_the_current_resume_sequence() {
    let (fixture, _) = setup();
    let mut server = fixture.start();
    let (source, view) = selected(&mut server);
    let key = uuid::Uuid::new_v4().to_string();
    create_continuation(&mut server, &source, &view, &key);
    let cancelled = rpc(
        &mut server,
        60,
        "migration/history/continuation/cancel",
        json!({"jobId":key}),
    );
    assert_eq!(cancelled["job"]["stage"], "cancelled");
    assert!(cancelled["job"]["threadId"].is_null());
    server.send(json!({"jsonrpc":"2.0","id":61,"method":"migration/history/continuation/resume","params":{"jobId":key,"expectedSequence":0}}));
    assert!(server.response(61).get("error").is_some());
    rpc(
        &mut server,
        62,
        "migration/history/continuation/resume",
        json!({"jobId":key,"expectedSequence":cancelled["job"]["sequence"]}),
    );
    wait_continuation(&mut server, &key);
    assert!(!fixture.workspace.join("NEVER_REPLAY_CONTINUATION").exists());
}

#[test]
fn a_lost_job_and_native_receipt_reconcile_the_same_thread_and_preserve_newer_work() {
    let (fixture, _) = setup();
    let mut server = fixture.start();
    let (source, view) = selected(&mut server);
    let key = uuid::Uuid::new_v4().to_string();
    create_continuation(&mut server, &source, &view, &key);
    rpc(
        &mut server,
        70,
        "migration/history/continuation/run",
        json!({"jobId":key,"expectedSequence":0}),
    );
    let ready = wait_continuation(&mut server, &key);
    let thread = ready["job"]["threadId"].as_str().unwrap().to_owned();
    drop(server);
    let journal = fixture
        .profile
        .join("migrations/history-continuations")
        .join(format!("{key}.json"));
    let mut job: Value = serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
    let history = std::path::PathBuf::from(job["target"]["history_directory"].as_str().unwrap())
        .join(format!("{thread}.jsonl"));
    let state = kcoder_state::AppState::new(&fixture.workspace);
    state.resume_from_history(&history).unwrap();
    state.add_message(kcoder_types::Message::user_text(
        "Newer user work must survive receipt recovery.",
    ));
    let current = state.set_goal("Current target goal", None);
    let before = fs::read(&history).unwrap();
    fs::remove_file(
        history
            .parent()
            .unwrap()
            .join(&thread)
            .join("historical-seed.receipt.json"),
    )
    .unwrap();
    job["receipt"] = Value::Null;
    job["view"]["stage"] = "publish_unknown".into();
    let sequence = job["view"]["sequence"].as_u64().unwrap() + 1;
    job["view"]["sequence"] = sequence.into();
    fs::write(&journal, serde_json::to_vec(&job).unwrap()).unwrap();
    let mut server = fixture.start();
    rpc(
        &mut server,
        71,
        "migration/history/continuation/resume",
        json!({"jobId":key,"expectedSequence":sequence}),
    );
    let recovered = wait_continuation(&mut server, &key);
    assert_eq!(recovered["job"]["threadId"], thread);
    assert_eq!(fs::read(&history).unwrap(), before);
    let read = kcoder_state::AppState::new(&fixture.workspace);
    read.resume_from_history(&history).unwrap();
    assert_eq!(read.goal().unwrap().goal_id, current.goal_id);
    assert_eq!(read.message_count(), 2);
    assert!(!fixture.workspace.join("NEVER_REPLAY_CONTINUATION").exists());
}

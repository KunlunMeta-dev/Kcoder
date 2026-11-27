fn transcript_observation_initialize(server: &mut TestAppServer, offered: bool) {
    server.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2026-07-27","clientInfo":{"name":"observation-stdio","version":"1"},
        "capabilities":{"experimental":{"threadTranscriptObservationV1":offered,"threadTranscriptSnapshotV1":true}}
    }}));
    let response = server.response(1);
    assert!(response.get("error").is_none(), "{response}");
    assert_eq!(
        response["result"]["capabilities"]["experimental"]["threadTranscriptObservationV1"],
        true
    );
}

fn transcript_observation_seed(
    root: &std::path::Path,
    settings: &std::path::Path,
) -> (String, String) {
    let mut owner = TestAppServer::builder(root, settings)
        .scenario("full-turn")
        .stream_delay_ms("0")
        .subagent_stream_delay_ms("0")
        .followup_stream_delay_ms("0")
        .spawn();
    transcript_observation_initialize(&mut owner, true);
    let first = resume_history_start_thread(&mut owner, 2);
    for index in 0..3 {
        resume_history_complete_turn(
            &mut owner,
            10 + index,
            &first,
            &format!("observe-original-{index}"),
        );
    }
    let second = resume_history_start_thread(&mut owner, 20);
    resume_history_complete_turn(&mut owner, 21, &second, "observe-peer");
    owner.shutdown_successfully();
    (first, second)
}

fn transcript_observation_read(
    server: &mut TestAppServer,
    id: i64,
    thread: &str,
    cursor: Option<&str>,
) -> Value {
    let mut params = json!({"threadId":thread,"limit":2});
    if let Some(cursor) = cursor {
        params["beforeCursor"] = json!(cursor);
    }
    server.send(json!({"jsonrpc":"2.0","id":id,"method":"thread/read/indexed","params":params}));
    server.response(id)
}

fn transcript_observation_assert_present(response: &Value, thread: &str) -> String {
    assert!(response.get("error").is_none(), "{response}");
    assert_eq!(response["result"]["thread"]["id"], thread, "{response}");
    assert_eq!(
        response["result"]["transcriptSnapshotV1"],
        json!({"status":"unavailable","code":"legacyReader"}),
        "{response}"
    );
    let observation: kcoder_app_protocol::ThreadTranscriptObservationV1 =
        serde_json::from_value(response["result"]["transcriptObservationV1"].clone()).unwrap();
    assert_eq!(observation.observation_id.len(), 64);
    assert_eq!(observation.view_key.len(), 64);
    assert_eq!(response["result"]["hasMoreBefore"], true, "{response}");
    let cursor = response["result"]["beforeCursor"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(cursor.starts_with("tp1:ob1-"), "{response}");
    cursor
}

fn transcript_observation_assert_stale(response: &Value) {
    assert_eq!(
        response["error"]["code"],
        kcoder_app_protocol::TRANSCRIPT_CURSOR_STALE_CODE,
        "{response}"
    );
    assert!(
        response.get("result").is_none(),
        "a stale observed cursor cannot fall back: {response}"
    );
}

#[test]
fn transcript_observation_stdio_default_writers_cold_pages_inline_resume_and_peer_scope() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    write_test_settings(&settings);
    // Only ordinary thread/start and real fixture turns create the writer fences.
    // No test code creates locks, tracking tokens, refresh receipts or page stores.
    let (first, second) = transcript_observation_seed(root.path(), &settings);
    let history = find_named_file(root.path(), &format!("{first}.jsonl")).unwrap();
    let original = std::fs::read(&history).unwrap();
    let mut server = TestAppServer::builder(root.path(), &settings)
        .without_scenario()
        .spawn();
    transcript_observation_initialize(&mut server, true);
    let first_page = transcript_observation_read(&mut server, 2, &first, None);
    let cursor = transcript_observation_assert_present(&first_page, &first);
    let older = transcript_observation_read(&mut server, 3, &first, Some(&cursor));
    assert!(older.get("error").is_none(), "{older}");
    assert_eq!(
        older["result"]["transcriptObservationV1"],
        first_page["result"]["transcriptObservationV1"]
    );
    assert_eq!(
        older["result"]["rangeEnd"],
        first_page["result"]["rangeStart"]
    );
    let wrong_scope = transcript_observation_read(&mut server, 4, &second, Some(&cursor));
    transcript_observation_assert_stale(&wrong_scope);
    let peer = transcript_observation_read(&mut server, 5, &second, None);
    assert!(peer.get("error").is_none(), "{peer}");
    assert!(
        peer["result"]["transcriptObservationV1"].is_object(),
        "{peer}"
    );
    let again = transcript_observation_read(&mut server, 6, &first, None);
    assert_eq!(
        again["result"]["transcriptObservationV1"], first_page["result"]["transcriptObservationV1"],
        "reading peer B must not invalidate A"
    );
    assert_eq!(
        std::fs::read(&history).unwrap(),
        original,
        "nonresident observations never rewrite raw history"
    );

    let inline = resume_history_request(&mut server, 7, &first, 2, true);
    let page = resume_history_ready_page(&inline, &first);
    assert!(page["transcriptObservationV1"].is_object(), "{inline}");
    assert_eq!(page["transcriptSnapshotV1"]["status"], "unavailable");
    let after = transcript_observation_read(&mut server, 8, &first, None);
    resume_history_assert_same_page(page, &after["result"]);
    assert_eq!(
        page["transcriptObservationV1"],
        after["result"]["transcriptObservationV1"]
    );
    server.shutdown_successfully();

    let mut legacy = TestAppServer::builder(root.path(), &settings)
        .without_scenario()
        .spawn();
    transcript_observation_initialize(&mut legacy, false);
    let response = transcript_observation_read(&mut legacy, 2, &first, None);
    assert!(response.get("error").is_none(), "{response}");
    assert!(
        response["result"].get("transcriptObservationV1").is_none(),
        "{response}"
    );
    assert_eq!(
        response["result"]["beforeCursor"],
        response["result"]["rangeStart"].to_string()
    );
    let refused = transcript_observation_read(&mut legacy, 3, &first, Some(&cursor));
    transcript_observation_assert_stale(&refused);
    legacy.shutdown_successfully();
}

#[test]
fn transcript_observation_stdio_metadata_correction_and_deletion_reject_old_cursors_readonly() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    write_test_settings(&settings);
    let (thread, _) = transcript_observation_seed(root.path(), &settings);
    let history = find_named_file(root.path(), &format!("{thread}.jsonl")).unwrap();
    let mut server = TestAppServer::builder(root.path(), &settings)
        .without_scenario()
        .spawn();
    transcript_observation_initialize(&mut server, true);
    let first = transcript_observation_read(&mut server, 2, &thread, None);
    let cursor = transcript_observation_assert_present(&first, &thread);
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"thread/metadata/update","params":{"threadId":thread,"title":"observed title revision"}}));
    let changed = server.response(3);
    assert!(changed.get("error").is_none(), "{changed}");
    transcript_observation_assert_stale(&transcript_observation_read(
        &mut server,
        4,
        &thread,
        Some(&cursor),
    ));
    let changed = transcript_observation_read(&mut server, 5, &thread, None);
    let changed_cursor = transcript_observation_assert_present(&changed, &thread);
    assert_ne!(
        changed["result"]["transcriptObservationV1"],
        first["result"]["transcriptObservationV1"]
    );

    // An owned external writer changes equal-length bytes and restores the old mtime.
    // The observed identity must bind the stream digest rather than mtime + length.
    let before = std::fs::read_to_string(&history).unwrap();
    let modified = std::fs::metadata(&history).unwrap().modified().unwrap();
    let corrected = before.replacen("observe-original-0", "observe-correctd-0", 1);
    assert_ne!(before, corrected);
    assert_eq!(before.len(), corrected.len());
    std::fs::write(&history, &corrected).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&history)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    transcript_observation_assert_stale(&transcript_observation_read(
        &mut server,
        6,
        &thread,
        Some(&changed_cursor),
    ));
    let corrected_page = transcript_observation_read(&mut server, 7, &thread, None);
    let corrected_cursor = transcript_observation_assert_present(&corrected_page, &thread);
    assert_ne!(
        changed["result"]["transcriptObservationV1"]["observationId"],
        corrected_page["result"]["transcriptObservationV1"]["observationId"]
    );
    assert_eq!(std::fs::read_to_string(&history).unwrap(), corrected);
    let shortened = corrected
        .lines()
        .take(corrected.lines().count() - 1)
        .map(|line| format!("{line}\n"))
        .collect::<String>();
    std::fs::write(&history, &shortened).unwrap();
    transcript_observation_assert_stale(&transcript_observation_read(
        &mut server,
        8,
        &thread,
        Some(&corrected_cursor),
    ));
    assert_eq!(
        std::fs::read_to_string(&history).unwrap(),
        shortened,
        "read rejection must not repair/delete raw history"
    );
    server.shutdown_successfully();
}

#[test]
fn transcript_observation_stdio_observed_to_explicit_tracking_is_typed_stale() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    write_test_settings(&settings);
    let (thread, _) = transcript_observation_seed(root.path(), &settings);
    let mut server = TestAppServer::builder(root.path(), &settings)
        .without_scenario()
        .spawn();
    transcript_observation_initialize(&mut server, true);
    let page = transcript_observation_read(&mut server, 2, &thread, None);
    let observed = transcript_observation_assert_present(&page, &thread);
    let refresh = resume_history_refresh_index(&mut server, 10);
    assert_eq!(refresh["result"]["status"], "ready", "{refresh}");
    transcript_observation_assert_stale(&transcript_observation_read(
        &mut server,
        100,
        &thread,
        Some(&observed),
    ));
    let tracked = transcript_observation_read(&mut server, 101, &thread, None);
    assert!(tracked.get("error").is_none(), "{tracked}");
    assert_eq!(
        tracked["result"]["transcriptSnapshotV1"]["status"], "available",
        "{tracked}"
    );
    assert!(
        tracked["result"].get("transcriptObservationV1").is_none(),
        "{tracked}"
    );
    assert!(
        !tracked["result"]["beforeCursor"]
            .as_str()
            .unwrap()
            .starts_with("tp1:ob1-")
    );
    server.shutdown_successfully();
}

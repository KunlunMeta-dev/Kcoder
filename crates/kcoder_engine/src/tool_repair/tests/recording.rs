#[test]
fn session_recorder_persists_only_failed_then_successful_repairs() {
    let tmp = tempfile::tempdir().unwrap();
    let mut recorder = ToolRepairSessionRecorder::default();
    let schema = schema_fingerprint(&json!({"type": "object"}));

    recorder.record_success("TodoWrite", &schema, &json!({"TodoList":[]}));
    recorder.record_failure(
        "TodoWrite",
        &schema,
        "$.TodoList expected array, got string",
        &json!({"TodoList":"Inspect renderer"}),
    );
    recorder.record_success(
        "TodoWrite",
        &schema,
        &json!({"TodoList":[{"content":"Inspect renderer","status":"pending"}]}),
    );

    let count = recorder
        .persist_session_examples(tmp.path(), "session-1")
        .unwrap();

    assert_eq!(count, 1);
    let audit_log = fs::read_to_string(session_audit_log_path(tmp.path())).unwrap();
    let audit_entry: Value = serde_json::from_str(audit_log.lines().last().unwrap()).unwrap();
    assert_eq!(audit_entry["session_id"], "session-1");
    assert_eq!(audit_entry["status"], "wrote_examples");
    assert_eq!(audit_entry["example_count"], 1);
    assert!(
        audit_entry["message"]
            .as_str()
            .unwrap()
            .contains("wrote failed-to-successful")
    );
    let index = ToolRepairIndex::load(tmp.path());
    let found = best_match(
        &index,
        "TodoWrite",
        &schema,
        &json!({"TodoList":"Run tests"}),
        "$.TodoList expected array, got string",
    )
    .expect("expected matching repair example");
    assert_eq!(found.failed_input["TodoList"], "Inspect renderer");
    assert!(found.successful_input["TodoList"].is_array());
}

fn recorder_with_one_repair() -> ToolRepairSessionRecorder {
    let mut recorder = ToolRepairSessionRecorder::default();
    let schema = schema_fingerprint(&json!({"type": "object"}));
    recorder.record_failure(
        "TodoWrite",
        &schema,
        "$.TodoList expected array, got string",
        &json!({"TodoList":"Inspect renderer"}),
    );
    recorder.record_success(
        "TodoWrite",
        &schema,
        &json!({"TodoList":[{"content":"Inspect renderer","status":"pending"}]}),
    );
    recorder
}

#[test]
fn session_recorder_audits_no_examples_on_session_end() {
    let tmp = tempfile::tempdir().unwrap();
    let recorder = ToolRepairSessionRecorder::default();

    let count = recorder
        .persist_session_examples(tmp.path(), "empty-session")
        .unwrap();

    assert_eq!(count, 0);
    assert!(session_audit_log_path(tmp.path()).is_file());
    let audit_log = fs::read_to_string(session_audit_log_path(tmp.path())).unwrap();
    let audit_entry: Value = serde_json::from_str(audit_log.lines().last().unwrap()).unwrap();
    assert_eq!(audit_entry["session_id"], "empty-session");
    assert_eq!(audit_entry["status"], "no_examples");
    assert_eq!(audit_entry["example_count"], 0);
    assert!(
        audit_entry["message"]
            .as_str()
            .unwrap()
            .contains("no failed-to-successful")
    );

    let jsonl_files = fs::read_dir(examples_dir(tmp.path()))
        .unwrap()
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .collect::<Vec<_>>();
    assert!(jsonl_files.is_empty());
}

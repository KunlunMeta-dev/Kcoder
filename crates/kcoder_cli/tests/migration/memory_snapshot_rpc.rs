//! Actual processes restore private Runtime context without replaying vendor tools or external models.
use super::super::{
    FixtureAnswer, serving_fixture_decided_bounded, write_fixture_provider_settings,
};
use super::{TestAppServer, Value, json, rpc};
use kcoder_config::imported_context::{
    ImportedContext, ImportedContextKind, ImportedContextScope, ImportedContextStore,
    ImportedMemoryControl, imported_context_revision,
};
use std::time::{Duration, Instant};

const MARKER: &str = "OWNED_IMPORTED_MEMORY_FROZEN_ACROSS_ACTUAL_PROCESS_RESTART";

fn turn(server: &mut TestAppServer, id: i64, thread: &Value, text: &str) -> String {
    let started = rpc(
        server,
        id,
        "turn/start",
        json!({"threadId":thread,"input":[{"type":"text","text":text}]}),
    );
    let turn = started["turn"]["id"].as_str().unwrap().to_owned();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let event = server.next_value(deadline);
        if event["method"] == "turn/completed"
            && event["params"]["threadId"] == *thread
            && event["params"]["turn"]["id"] == turn
        {
            assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
            break;
        }
    }
    let visible = rpc(
        server,
        id + 1,
        "thread/read",
        json!({"threadId":thread,"limit":100}),
    );
    assert!(
        !visible.to_string().contains(MARKER),
        "private Runtime snapshots must not become visible conversation text"
    );
    turn
}

#[test]
fn actual_process_restart_and_both_fork_paths_preserve_snapshot_after_original_note_is_removed() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(&profile).unwrap();
    let (endpoint, calls, fixture) =
        serving_fixture_decided_bounded(|_, _| FixtureAnswer::Ok, Some(6), Duration::from_secs(15));
    let settings = workspace.join("overlay.json");
    write_fixture_provider_settings(&settings, &endpoint);
    std::fs::write(profile.join("settings.json"), "{}").unwrap();
    let contexts = ImportedContextStore::open(&profile).unwrap();
    let record = ImportedContext {
        id: "ctx-process-memory".into(),
        operation_id: "owned-context-owner".into(),
        name: "Unverified process fixture note".into(),
        kind: ImportedContextKind::Memory,
        scope: ImportedContextScope::Global,
        content: MARKER.into(),
        enabled: false,
        memory_provenance: None,
        memory_workspace_identity: None,
        instruction_provenance: None,
    };
    contexts.create(record.clone()).unwrap();
    contexts
        .memory_control(&ImportedMemoryControl {
            request_id: "owned-context-enable".into(),
            id: record.id.clone(),
            owner_operation_id: record.operation_id.clone(),
            expected_revision: imported_context_revision(&record).unwrap(),
            enabled: true,
            confirm_unverified_notes: true,
        })
        .unwrap();
    let start = || {
        let mut builder = TestAppServer::builder(&workspace, &settings)
            .config_dir(&profile)
            .without_scenario()
            .discard_stderr();
        for (name, path) in [
            ("HOME", root.path()),
            ("USERPROFILE", root.path()),
            ("CLAUDE_CONFIG_DIR", root.path()),
            ("CODEX_HOME", root.path()),
        ] {
            builder
                .extra_env
                .push((name.into(), path.as_os_str().into()));
        }
        let mut server = builder.spawn();
        assert!(server.initialize(1).get("error").is_none());
        server
    };
    let mut first = start();
    let first_pid = first.child.id();
    let source = rpc(&mut first, 2, "thread/start", json!({}))["thread"]["id"].clone();
    turn(&mut first, 3, &source, "first owned turn");
    first.shutdown_successfully();
    let current = contexts.list().unwrap().remove(0);
    contexts
        .memory_control(&ImportedMemoryControl {
            request_id: "owned-context-disable".into(),
            id: record.id.clone(),
            owner_operation_id: record.operation_id.clone(),
            expected_revision: imported_context_revision(&current).unwrap(),
            enabled: false,
            confirm_unverified_notes: false,
        })
        .unwrap();
    contexts.remove_owned(&record).unwrap();
    assert!(contexts.list().unwrap().is_empty());
    let mut second = start();
    assert_ne!(second.child.id(), first_pid);
    rpc(&mut second, 2, "thread/resume", json!({"threadId":source}));
    let boundary = turn(
        &mut second,
        3,
        &source,
        "turn after process restart and source removal",
    );
    let durable = rpc(
        &mut second,
        5,
        "thread/fork",
        json!({"threadId":source,"lastTurnId":boundary}),
    )["thread"]["id"]
        .clone();
    // Durable fork creates an idle history; opening it is a separate explicit action.
    rpc(
        &mut second,
        50,
        "thread/resume",
        json!({"threadId":durable}),
    );
    turn(
        &mut second,
        6,
        &durable,
        "durable fork owns the same frozen data",
    );
    let ephemeral = rpc(
        &mut second,
        8,
        "thread/fork",
        json!({"threadId":source,"lastTurnId":boundary,"ephemeral":true}),
    )["thread"]["id"]
        .clone();
    turn(
        &mut second,
        9,
        &ephemeral,
        "ephemeral fork owns the same frozen data",
    );
    let fresh = rpc(&mut second, 11, "thread/start", json!({}))["thread"]["id"].clone();
    turn(
        &mut second,
        12,
        &fresh,
        "new conversation uses current disabled notes",
    );
    second.shutdown_successfully();
    let mut third = start();
    rpc(&mut third, 2, "thread/resume", json!({"threadId":durable}));
    turn(
        &mut third,
        3,
        &durable,
        "fork resumes in a third owned process",
    );
    third.shutdown_successfully();
    fixture.join().unwrap();
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 6);
    for (index, request) in calls.iter().enumerate() {
        assert_eq!(
            request.to_string().contains(MARKER),
            index != 4,
            "context must be original on resumed/forked threads, and absent on a fresh thread"
        );
        assert!(
            request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| matches!(row["role"].as_str(), Some("system" | "developer")))
                .all(|row| !row.to_string().contains(MARKER)),
            "the imported note must never enter the system prefix"
        );
    }
}

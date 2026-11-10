use super::recent_error::{before_finish, decorate};
use super::turn_attempts;
use crate::app_server::thread_runtime::test_support::test_runtime;
use kcoder_app_protocol::{ThreadRecentErrorCategory as Category, ThreadRecentErrorKind as Kind};
use kcoder_cli_storage::private_files::{hex_sha256, write_private_artifact_file};
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
use serde_json::json;

fn thread(id: &str) -> kcoder_app_protocol::Thread {
    serde_json::from_value(
        json!({ "id": id, "status": "idle", "createdAt": "1", "updatedAt": "1" }),
    )
    .unwrap()
}

#[tokio::test]
async fn projection_reads_committed_attempt_without_exposing_private_exception_text() {
    let root = tempfile::tempdir().unwrap();
    let runtime = test_runtime("recent-error", &root.path().join("history.jsonl"));
    let engine = runtime.engine();
    let id = engine.session_id();
    let identity = TurnAttemptIdentity {
        thread_id: id.clone(),
        turn_id: "turn-1".into(),
        attempt_id: "turn-1".into(),
    };
    let mut value = thread(&id);
    decorate(&engine, &mut value, true);
    assert_eq!(
        value.run_summary.as_ref().unwrap().recent_error,
        None,
        "legacy/missing pointer is unknown"
    );
    assert_eq!(value.run_summary.as_ref().unwrap().latest_turn_status, None);
    turn_attempts::begin(
        &engine,
        &identity,
        false,
        None,
        hex_sha256(b"fixture-fence"),
        hex_sha256(b"fixture-request"),
    )
    .unwrap();
    decorate(&engine, &mut value, true);
    assert_eq!(value.run_summary.as_ref().unwrap().recent_error, None);
    assert_eq!(
        value.run_summary.as_ref().unwrap().latest_turn_status,
        None,
        "an accepted task without completion is unknown, not never-run"
    );
    before_finish(&engine, &identity, TurnAttemptStatus::Failed).unwrap();
    decorate(&engine, &mut value, true);
    assert_eq!(
        value.run_summary.as_ref().unwrap().recent_error,
        None,
        "uncommitted source is unknown"
    );
    turn_attempts::finish(
        &engine,
        &identity,
        "failed",
        Some("private prompt Authorization: Bearer hidden-secret"),
        None,
        &turn_attempts::PartialOutput::default(),
    )
    .unwrap();
    decorate(&engine, &mut value, true);
    let error = value
        .run_summary
        .as_ref()
        .unwrap()
        .recent_error
        .as_ref()
        .unwrap()
        .as_ref()
        .unwrap();
    assert_eq!(
        value.run_summary.as_ref().unwrap().latest_turn_status,
        Some(kcoder_app_protocol::TurnStatus::Failed)
    );
    assert_eq!(error.kind, Kind::Failed);
    assert_eq!(error.category, Category::Execution);
    let encoded = serde_json::to_string(&value).unwrap();
    for secret in ["private prompt", "Authorization", "hidden-secret"] {
        assert!(!encoded.contains(secret));
    }
    // A later interrupted turn is visible, but its badge must disappear
    // after a subsequent successful completion (including after reload).
    for (number, status) in [(2, "interrupted"), (3, "completed")] {
        let next = TurnAttemptIdentity {
            thread_id: id.clone(),
            turn_id: format!("turn-{number}"),
            attempt_id: format!("turn-{number}"),
        };
        turn_attempts::begin(
            &engine,
            &next,
            false,
            None,
            hex_sha256(b"fixture-fence"),
            hex_sha256(b"fixture-request"),
        )
        .unwrap();
        if status == "completed" {
            before_finish(&engine, &next, TurnAttemptStatus::Completed).unwrap();
            decorate(&engine, &mut value, true);
            assert_eq!(
                value.run_summary.as_ref().unwrap().recent_error,
                None,
                "success not yet committed must remain unknown"
            );
            assert_eq!(value.run_summary.as_ref().unwrap().latest_turn_status, None);
        }
        turn_attempts::finish(
            &engine,
            &next,
            status,
            None,
            None,
            &turn_attempts::PartialOutput::default(),
        )
        .unwrap();
        value = thread(&id);
        decorate(&engine, &mut value, true);
        assert_eq!(
            value.run_summary.as_ref().unwrap().latest_turn_status,
            Some(if status == "interrupted" {
                kcoder_app_protocol::TurnStatus::Interrupted
            } else {
                kcoder_app_protocol::TurnStatus::Completed
            })
        );
        if status == "interrupted" {
            assert_eq!(
                value
                    .run_summary
                    .as_ref()
                    .unwrap()
                    .recent_error
                    .as_ref()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .kind,
                Kind::Interrupted
            );
        } else {
            assert_eq!(value.run_summary.as_ref().unwrap().recent_error, Some(None));
        }
    }
    let mut legacy = thread(&id);
    decorate(&engine, &mut legacy, false);
    assert!(legacy.run_summary.is_none());
    write_private_artifact_file(
        &engine
            .session_storage_dir_for(&id)
            .join("recent-turn-error.json"),
        b"{corrupt",
    )
    .unwrap();
    decorate(&engine, &mut value, true);
    assert_eq!(value.run_summary.unwrap().recent_error, None);
}
#[tokio::test]
async fn completion_survives_empty_missing_and_stale_derived_pointer() {
    let root = tempfile::tempdir().unwrap();
    let runtime = test_runtime("recent-error-recovery", &root.path().join("history.jsonl"));
    let engine = runtime.engine();
    let id = engine.session_id();
    let first = TurnAttemptIdentity {
        thread_id: id.clone(),
        turn_id: "turn-1".into(),
        attempt_id: "turn-1".into(),
    };
    turn_attempts::begin(
        &engine,
        &first,
        false,
        None,
        hex_sha256(b"context"),
        hex_sha256(b"request"),
    )
    .unwrap();
    turn_attempts::finish(
        &engine,
        &first,
        "completed",
        None,
        None,
        &turn_attempts::PartialOutput::default(),
    )
    .unwrap();
    let pointer = engine
        .session_storage_dir_for(&id)
        .join("recent-turn-error.json");
    let empty = serde_json::to_vec(&json!({"version": 1, "identity": null})).unwrap();
    write_private_artifact_file(&pointer, &empty).unwrap();
    let mut value = thread(&id);
    decorate(&engine, &mut value, true);
    assert_eq!(
        value.run_summary.as_ref().unwrap().latest_turn_status,
        Some(kcoder_app_protocol::TurnStatus::Completed)
    );
    assert_eq!(
        std::fs::read(&pointer).unwrap(),
        empty,
        "reading does not rewrite the pointer"
    );
    std::fs::remove_file(&pointer).unwrap();
    decorate(&engine, &mut value, true);
    assert_eq!(
        value.run_summary.as_ref().unwrap().latest_turn_status,
        Some(kcoder_app_protocol::TurnStatus::Completed)
    );
    let second = TurnAttemptIdentity {
        thread_id: id.clone(),
        turn_id: "turn-2".into(),
        attempt_id: "turn-2".into(),
    };
    turn_attempts::begin(
        &engine,
        &second,
        false,
        None,
        hex_sha256(b"context2"),
        hex_sha256(b"request2"),
    )
    .unwrap();
    write_private_artifact_file(&pointer, &empty).unwrap();
    write_private_artifact_file(
        &pointer,
        &serde_json::to_vec(&json!({"version": 1, "identity": first})).unwrap(),
    )
    .unwrap();
    decorate(&engine, &mut value, true);
    assert_eq!(
        value.run_summary.as_ref().unwrap().latest_turn_status,
        None,
        "a newer accepted attempt blocks the older success"
    );
    turn_attempts::finish(
        &engine,
        &second,
        "failed",
        Some("fixture failure"),
        None,
        &turn_attempts::PartialOutput::default(),
    )
    .unwrap();
    write_private_artifact_file(&pointer, &empty).unwrap();
    decorate(&engine, &mut value, true);
    assert_eq!(
        value.run_summary.as_ref().unwrap().latest_turn_status,
        Some(kcoder_app_protocol::TurnStatus::Failed)
    );
    write_private_artifact_file(
        &pointer,
        &serde_json::to_vec(&json!({"version": 1, "identity": first})).unwrap(),
    )
    .unwrap();
    decorate(&engine, &mut value, true);
    assert_eq!(
        value.run_summary.as_ref().unwrap().latest_turn_status,
        Some(kcoder_app_protocol::TurnStatus::Failed)
    );
    write_private_artifact_file(&pointer, b"{corrupt").unwrap();
    decorate(&engine, &mut value, true);
    assert_eq!(
        value.run_summary.as_ref().unwrap().latest_turn_status,
        None,
        "malformed protected metadata remains unknown"
    );
}

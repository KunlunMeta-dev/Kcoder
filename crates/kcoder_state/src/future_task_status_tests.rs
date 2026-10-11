use super::*;
use crate::session_persistence::{SESSION_STATE_SCHEMA_VERSION, parse_session_state};
use tempfile::TempDir;

#[test]
fn future_task_state_keeps_history_metadata_and_other_tasks_readable() {
    let temp = TempDir::new().unwrap();
    let history = temp.path().join("session.jsonl");
    let state = AppState::new(temp.path());
    state.with_history_path(&history);
    state.add_message(Message::user_text("owned history"));
    state.set_goal("retained goal", Some(100));
    let mut future = Task::new("future", "retained task");
    future.kind = TaskKind::Subagent;
    future.parent_session_id = Some(state.session_id());
    future.status = TaskStatus::Unknown("future_review".into());
    state.upsert_task(future);
    let mut known = Task::new("known", "ordinary task");
    known.kind = TaskKind::Subagent;
    known.parent_session_id = Some(state.session_id());
    state.upsert_task(known);
    state.save_history().unwrap();

    assert!(history_has_persisted_session_cwd(&history).unwrap());
    assert_eq!(
        history_persisted_base_cwd(&history).unwrap().as_deref(),
        Some(temp.path())
    );
    assert_eq!(
        history_persisted_goal(&history).unwrap().unwrap().objective,
        "retained goal"
    );
    let restored = AppState::new(temp.path());
    restored.resume_from_history(&history).unwrap();
    assert_eq!(
        restored.task("future").unwrap().status,
        TaskStatus::Unknown("future_review".into())
    );
    assert_eq!(restored.task("known").unwrap().status, TaskStatus::Pending);
    assert!(
        restored
            .update_task("future", |task| task.status = TaskStatus::Completed)
            .is_none()
    );
    assert!(
        restored
            .transact_task("future", |task| {
                task.status = TaskStatus::Completed;
                Ok(())
            })
            .is_err()
    );
    assert!(!restored.remove_task("future"));
    assert!(restored.begin_background_run("future").is_err());
    restored
        .update_task("known", |task| {
            task.description = "changed known task".into()
        })
        .unwrap();
    restored.save_history().unwrap();
    let bytes = fs::read_to_string(restored.session_state_path().unwrap()).unwrap();
    let wire: serde_json::Value = serde_json::from_str(&bytes).unwrap();
    assert_eq!(wire["tasks"]["future"]["status"], "future_review");
    assert_eq!(wire["tasks"]["known"]["description"], "changed known task");
}

#[test]
fn unknown_task_status_does_not_relax_future_schema_rejection() {
    let temp = TempDir::new().unwrap();
    let mut task = Task::new("future", "owned task");
    task.status = TaskStatus::Unknown("future_review".into());
    let value = serde_json::json!({
        "schema_version": SESSION_STATE_SCHEMA_VERSION + 1,
        "delivery_format": "lease_ack_v1", "tasks": {"future": task}
    });
    let error =
        parse_session_state(&temp.path().join("state.json"), &value.to_string()).unwrap_err();
    assert!(error.to_string().contains("unsupported future schema"));
}

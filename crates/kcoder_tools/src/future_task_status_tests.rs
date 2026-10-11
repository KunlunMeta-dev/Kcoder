use crate::{SendMessageTool, TaskStopTool, TaskUpdateTool, Tool, ToolContext, WaitAgentTool};
use kcoder_state::{AppState, Task, TaskKind, TaskStatus};
use serde_json::json;

#[tokio::test]
async fn unknown_generic_task_is_read_only_and_never_stopped_or_rewritten() {
    let root = tempfile::tempdir().unwrap();
    let state = AppState::new(root.path());
    let mut task = Task::new("future", "retained description");
    task.status = TaskStatus::Unknown("future_review".into());
    state.upsert_task(task);
    let ctx = ToolContext::new(state.clone());
    let result = TaskUpdateTool
        .call(json!({"taskId":"future", "subject":"replace"}), &ctx)
        .await;
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("task_status_unknown_read_only")
    );
    let stopped = TaskStopTool
        .call(json!({"task_id":"future"}), &ctx)
        .await
        .unwrap();
    assert!(!output_text(&stopped).contains("Successfully stopped"));
    assert_eq!(
        state.task("future").unwrap().description,
        "retained description"
    );
    assert_eq!(
        state.task("future").unwrap().status,
        TaskStatus::Unknown("future_review".into())
    );
}

#[tokio::test]
async fn unknown_subagent_never_waits_or_starts_a_continuation() {
    let root = tempfile::tempdir().unwrap();
    let state = AppState::new(root.path());
    let mut task = Task::new("future", "retained agent");
    task.kind = TaskKind::Subagent;
    task.parent_session_id = Some(state.session_id());
    task.arrangement_mode = Some(false);
    task.agent_kind = Some("general".into());
    task.status = TaskStatus::Unknown("future_review".into());
    state.upsert_task(task);
    let ctx = ToolContext::new(state.clone());
    let waited = WaitAgentTool
        .call(json!({"agent_id":"future", "timeout_ms":60000}), &ctx)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&output_text(&waited)).unwrap();
    assert_eq!(value["status"], "unknown");
    assert_eq!(value["effective_timeout_ms"], 0);
    let result = SendMessageTool
        .call(json!({"agent_id":"future", "message":"change"}), &ctx)
        .await;
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("task_status_unknown_read_only")
    );
    assert!(state.task("future").unwrap().message_queue.is_empty());
}

fn output_text(output: &crate::ToolOutput) -> String {
    output
        .content
        .iter()
        .filter_map(|block| match block {
            kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

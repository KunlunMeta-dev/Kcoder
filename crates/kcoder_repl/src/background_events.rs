//! Persisted sub-agent task reconciliation and event timestamps.

use super::*;

pub(super) fn background_watcher_error_event(
    error: tokio::sync::broadcast::error::RecvError,
) -> Option<AppEvent> {
    match error {
        tokio::sync::broadcast::error::RecvError::Lagged(skipped) => {
            warn!(skipped, "background job watcher lagged; continuing");
            Some(AppEvent::SystemNotice(format!(
                "[background] UI skipped {skipped} stale status event(s); continuing."
            )))
        }
        tokio::sync::broadcast::error::RecvError::Closed => None,
    }
}

pub(super) fn reconciled_subagent_task_events(engine: &QueryEngine) -> Vec<AppEvent> {
    let tasks = engine.state.tasks().into_values().collect::<Vec<_>>();
    reconciled_subagent_task_events_from_tasks(tasks)
}

pub(super) fn reconciled_subagent_task_events_from_tasks(
    mut tasks: Vec<kcoder_state::Task>,
) -> Vec<AppEvent> {
    tasks.retain(|task| task.managed && task.kind == TaskKind::Subagent);
    tasks.sort_by_key(|task| task.created_at_ms);
    let mut events = Vec::new();
    for task in tasks {
        let Some(tool_call_id) = task.parent_tool_call_id.clone() else {
            continue;
        };
        events.push(AppEvent::BackgroundJobAssociated {
            id: task.id.clone(),
            tool_call_id,
            run_in_background: task.delivery == TaskDelivery::Background,
        });
        match task.status {
            TaskStatus::Unknown(_) => {
                events.push(AppEvent::BackgroundJobReconciledUnknown { id: task.id })
            }
            TaskStatus::Pending | TaskStatus::Running
                if task.delivery == TaskDelivery::Background =>
            {
                events.push(AppEvent::BackgroundJobPromoted {
                    id: task.id.clone(),
                });
                events.push(AppEvent::BackgroundJobReconciledRunning {
                    detail: Some(orchestrate_agent_status_detail(&task)),
                    id: task.id,
                    current: Some(1),
                    total: task.max_turns,
                });
            }
            TaskStatus::Pending | TaskStatus::Running => {
                events.push(AppEvent::BackgroundJobReconciledRunning {
                    detail: Some(orchestrate_agent_status_detail(&task)),
                    id: task.id,
                    current: Some(1),
                    total: task.max_turns,
                });
            }
            TaskStatus::Paused => {
                events.push(AppEvent::BackgroundJobPaused {
                    id: task.id.clone(),
                    reason: orchestrate_agent_status_detail(&task),
                });
            }
            TaskStatus::Halted => {
                events.push(AppEvent::BackgroundJobHalted {
                    id: task.id.clone(),
                    reason: orchestrate_agent_status_detail(&task),
                });
            }
            TaskStatus::Completed => {
                events.push(AppEvent::BackgroundJobCompleted {
                    id: task.id,
                    summary: task.output.map(|text| truncate_display_text(&text, 2_000)),
                });
            }
            TaskStatus::Failed => events.push(AppEvent::BackgroundJobFailed {
                id: task.id,
                error: task
                    .output
                    .unwrap_or_else(|| "Sub-agent failed".to_string()),
            }),
            TaskStatus::Cancelled => {
                events.push(AppEvent::BackgroundJobCancelled { id: task.id });
            }
        }
    }
    events
}

pub(super) fn orchestrate_agent_status_detail(task: &kcoder_state::Task) -> String {
    let age_seconds = current_timestamp_ms()
        .saturating_sub(task.updated_at_ms)
        .saturating_div(1_000);
    let blocked = task
        .message_queue
        .first()
        .is_some_and(|message| message.status == kcoder_state::AgentMessageStatus::Blocked);
    let mut fields = vec![
        format!("queue {}", task.message_queue.len()),
        format!(
            "breaker {}",
            format!("{:?}", task.breaker.stage).to_ascii_lowercase()
        ),
        format!("last activity {age_seconds}s ago"),
    ];
    if blocked {
        fields.push("delivery blocked: use ControlAgent retry_message or discard_message".into());
    }
    if let Some(reason) = task.control.reason.as_ref() {
        fields.push(format!("reason: {}", reason.message));
    }
    fields.join(" · ")
}

pub(super) fn orchestrate_agent_terminal_control_detail(
    engine: &QueryEngine,
    agent_id: &str,
    reason: &str,
) -> String {
    let Some(task) = engine.state.task(agent_id) else {
        return reason.to_string();
    };
    let status = orchestrate_agent_status_detail(&task);
    if reason.trim().is_empty() || status.contains(reason.trim()) {
        status
    } else {
        format!("{status} · {reason}")
    }
}

pub(super) fn current_timestamp_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

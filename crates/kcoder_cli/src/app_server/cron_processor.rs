use anyhow::Result;
use kcoder_app_protocol::{
    CronCreateParams, CronDeleteParams, CronParams, CronPreviewParams, CronPreviewResult,
};
use kcoder_engine::QueryEngine;
use serde_json::{Value, json};

pub(super) fn process(engine: &QueryEngine, method: &str, params: Value) -> Result<Value> {
    anyhow::ensure!(
        !engine.settings.read().unwrap().training_mode,
        "scheduled tasks are disabled in training mode"
    );
    let scheduler = engine.cron_scheduler();
    let session_id = engine.session_id();
    let owner = kcoder_tools::cron::APP_PROJECT_CRON_OWNER;
    match method {
        kcoder_app_protocol::method::CRON_PREVIEW => {
            let params: CronPreviewParams = serde_json::from_value(params)?;
            let next = kcoder_tools::cron::preview_schedule(&params.schedule)
                .map_err(anyhow::Error::msg)?;
            Ok(serde_json::to_value(CronPreviewResult {
                next_run_at: next.to_rfc3339(),
            })?)
        }
        "cron/list" => {
            let params: CronParams = serde_json::from_value(params)?;
            anyhow::ensure!(
                params
                    .thread_id
                    .as_deref()
                    .is_none_or(|id| id == session_id),
                "scheduled task thread mismatch"
            );
            scheduler
                .migrate_app_jobs_to_project()
                .map_err(anyhow::Error::msg)?;
            let jobs = scheduler
                .list_for_session(owner)
                .map_err(anyhow::Error::msg)?;
            let delivery_diagnostics = scheduler
                .delivery_diagnostics(Some(owner))
                .map_err(anyhow::Error::msg)?;
            reconcile_execution(engine, &scheduler);
            let mut execution_diagnostics: kcoder_app_protocol::CronExecutionDiagnostics =
                serde_json::from_value(
                    scheduler
                        .execution_diagnostics(Some(owner))
                        .map_err(anyhow::Error::msg)?,
                )?;
            for run in &mut execution_diagnostics.runs {
                run.timezone = run.schedule.as_ref().map(|schedule| match schedule {
                    kcoder_types::CronSchedule::ZonedCron { timezone, .. } => timezone.clone(),
                    _ => "UTC".to_owned(),
                });
            }
            Ok(
                json!({"jobs": jobs, "executionDiagnostics": execution_diagnostics, "executionPolicy": "project-new-session", "timezone": "UTC", "deliveryDiagnostics": delivery_diagnostics}),
            )
        }
        "cron/create" => {
            let params: CronCreateParams = serde_json::from_value(params)?;
            anyhow::ensure!(
                params
                    .thread_id
                    .as_deref()
                    .is_none_or(|id| id == session_id),
                "scheduled task thread mismatch"
            );
            anyhow::ensure!(params.confirmed, "explicit user confirmation is required");
            anyhow::ensure!(
                params.prompt.len() <= 32 * 1024,
                "scheduled task prompt is too large"
            );
            let schedule = params.schedule;
            scheduler
                .migrate_app_jobs_to_project()
                .map_err(anyhow::Error::msg)?;
            let job = scheduler
                .create_for_session(
                    owner.to_string(),
                    params.prompt,
                    schedule,
                    params.jitter_seconds,
                )
                .map_err(anyhow::Error::msg)?;
            // The write already committed. A racing read must not turn it into an error
            // that encourages the caller to create the same schedule again.
            let job_count = scheduler
                .list_for_session(owner)
                .ok()
                .map(|jobs| jobs.len());
            Ok(json!({"job": job, "jobCount": job_count}))
        }
        "cron/delete" => {
            let params: CronDeleteParams = serde_json::from_value(params)?;
            anyhow::ensure!(
                params
                    .thread_id
                    .as_deref()
                    .is_none_or(|id| id == session_id),
                "scheduled task thread mismatch"
            );
            scheduler
                .migrate_app_jobs_to_project()
                .map_err(anyhow::Error::msg)?;
            anyhow::ensure!(
                !params.receipts_only || params.confirmed,
                "receipt cleanup requires explicit confirmation"
            );
            let deleted = if params.receipts_only {
                scheduler.clear_delivery_receipts(&params.job_id, Some(owner))
            } else {
                scheduler.delete_for_session(&params.job_id, owner)
            }
            .map_err(anyhow::Error::msg)?;
            let job_count = scheduler
                .list_for_session(owner)
                .ok()
                .map(|jobs| jobs.len());
            Ok(
                json!({"deleted": deleted, "jobCount": job_count, "receiptsOnly":params.receipts_only, "schedulePreserved":params.receipts_only}),
            )
        }
        _ => anyhow::bail!("unknown scheduled task method"),
    }
}

/// Repair projection only from persisted attempt and visible transcript evidence.
/// Missing, removed, unreadable or oversized history stays unknown; nothing executes.
pub(super) fn reconcile_execution(
    engine: &QueryEngine,
    scheduler: &kcoder_tools::cron::CronScheduler,
) {
    let Ok(runs) = scheduler
        .execution_reconciliation_candidates(Some(kcoder_tools::cron::APP_PROJECT_CRON_OWNER), 16)
    else {
        return;
    };
    for run in &runs {
        if run["status"] == "unknown"
            && run["threadId"].as_str().is_none()
            && let (Some(request), Some(trigger)) =
                (run["requestId"].as_str(), run["triggerId"].as_str())
            && request.starts_with("kcoder-automation-thread:")
        {
            let recover_link = (|| -> Result<()> {
                if let Some(record) = super::thread_creations::lookup(engine, request)?
                    && record.thread.is_some()
                {
                    super::thread_history_path(engine, &record.thread_id)?;
                    scheduler
                        .execution_reconcile_created_thread(trigger, &record.thread_id)
                        .map_err(anyhow::Error::msg)?;
                }
                Ok(())
            })();
            if let Err(error) = recover_link {
                tracing::debug!(%error, trigger_id=trigger, "automation creation remains unknown; no replay");
            }
        }
        let (Some(thread), Some(turn), Some(attempt)) = (
            run["threadId"].as_str(),
            run["turnId"].as_str(),
            run["attemptId"].as_str(),
        ) else {
            continue;
        };
        let reconcile = (|| -> Result<()> {
            super::validate_thread_id(thread)?;
            let history_path = super::thread_history_path(engine, thread)?;
            let records = super::turn_attempts::records(engine, thread)?;
            let Some(record) = records
                .into_iter()
                .find(|r| r.identity.turn_id == turn && r.identity.attempt_id == attempt)
            else {
                return Ok(());
            };
            let Some(completion) = record.completion else {
                return Ok(());
            };
            let status = match completion.status {
                kcoder_types::TurnAttemptStatus::Completed => "completed",
                kcoder_types::TurnAttemptStatus::Failed => "failed",
                kcoder_types::TurnAttemptStatus::Interrupted => "interrupted",
                kcoder_types::TurnAttemptStatus::Accepted
                | kcoder_types::TurnAttemptStatus::Unknown(_) => return Ok(()),
            };
            let reply = if status == "completed" {
                let Some(anchor) = completion.committed_history_uuid.as_deref() else {
                    return Ok(());
                };
                let entries = kcoder_state::load_transcript_history_bounded(
                    &history_path,
                    2 * 1024 * 1024,
                    512 * 1024,
                    4096,
                )?;
                let bindings = super::turn_admissions::bindings(engine, thread)?;
                let Some(reply) = committed_reply(&entries, &bindings, turn, anchor) else {
                    return Ok(());
                };
                reply
            } else {
                String::new()
            };
            let finished = i64::try_from(completion.finished_at_ms)
                .ok()
                .and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis)
                .ok_or_else(|| anyhow::anyhow!("invalid persisted automation completion time"))?;
            scheduler
                .execution_finished_at(
                    thread,
                    turn,
                    attempt,
                    status,
                    &reply,
                    completion.error.as_deref(),
                    finished,
                )
                .map_err(anyhow::Error::msg)?;
            Ok(())
        })();
        if let Err(error) = reconcile {
            tracing::debug!(%error, thread_id=thread, turn_id=turn, attempt_id=attempt, "automation outcome remains unknown; no replay");
        }
    }
}

fn committed_reply(
    entries: &[kcoder_state::HistoryEntry],
    bindings: &std::collections::HashMap<String, String>,
    turn: &str,
    anchor: &str,
) -> Option<String> {
    let mut users = bindings.iter().filter(|(_, id)| id.as_str() == turn);
    let (user_uuid, _) = users.next()?;
    if users.next().is_some() {
        return None;
    }
    let start = entries.iter().position(|e| {
        e.uuid.as_ref() == Some(user_uuid) && kcoder_engine::agent::is_real_user_message(&e.message)
    })?;
    let end = entries
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, e)| kcoder_engine::agent::is_real_user_message(&e.message))
        .map(|(i, _)| i)
        .unwrap_or(entries.len());
    let anchor_offset = entries[start..end]
        .iter()
        .position(|e| e.uuid.as_deref() == Some(anchor))?;
    let mut text = String::new();
    for entry in &entries[start..=start + anchor_offset] {
        if let kcoder_types::Message::Assistant { content, .. } = &entry.message {
            for block in content {
                if let kcoder_types::ContentBlock::Text { text: part } = block {
                    text.extend(
                        part.chars()
                            .take(2048usize.saturating_sub(text.chars().count())),
                    );
                }
            }
        }
    }
    Some(text)
}

#[cfg(test)]
mod execution_reconciliation_tests {
    use super::*;
    fn entry(uuid: &str, message: kcoder_types::Message) -> kcoder_state::HistoryEntry {
        kcoder_state::HistoryEntry {
            session_id: "fixture".into(),
            timestamp_ms: 1,
            uuid: Some(uuid.into()),
            parent_uuid: None,
            message,
        }
    }
    #[test]
    fn exact_admitted_turn_and_visible_completion_anchor_are_required() {
        let entries = vec![
            entry("user-1", kcoder_types::Message::user_text("scheduled")),
            entry(
                "reply-1",
                kcoder_types::Message::assistant_text("actual response"),
            ),
            entry("user-2", kcoder_types::Message::user_text("different turn")),
            entry(
                "reply-2",
                kcoder_types::Message::assistant_text("unrelated"),
            ),
        ];
        let bindings = std::collections::HashMap::from([("user-1".into(), "turn-1".into())]);
        assert_eq!(
            committed_reply(&entries, &bindings, "turn-1", "reply-1"),
            Some("actual response".into())
        );
        assert_eq!(
            committed_reply(&entries, &bindings, "turn-1", "reply-2"),
            None
        );
        assert_eq!(
            committed_reply(&entries, &bindings, "turn-1", "removed-anchor"),
            None
        );
        assert_eq!(
            committed_reply(&entries[1..], &bindings, "turn-1", "reply-1"),
            None
        );
    }
    #[test]
    fn tool_only_assistant_message_is_not_a_reply() {
        let tool_message: kcoder_types::Message = serde_json::from_value(json!({"role":"assistant","content":[{"type":"tool_use","id":"tool","name":"fixture","input":{}}]})).unwrap();
        let entries = vec![
            entry("user", kcoder_types::Message::user_text("scheduled")),
            entry("tools", tool_message),
        ];
        let bindings = std::collections::HashMap::from([("user".into(), "turn-1".into())]);
        assert_eq!(
            committed_reply(&entries, &bindings, "turn-1", "tools"),
            Some(String::new())
        );
    }
}

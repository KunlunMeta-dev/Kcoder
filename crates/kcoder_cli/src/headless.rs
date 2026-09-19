use crate::headless_outcome::HeadlessOutcome;
use anyhow::{Context, Result, bail};
use futures::StreamExt;
use kcoder_engine::{BackgroundJobEvent, EngineEvent, QueryEngine};
use kcoder_permissions::PermissionPrompt;
use kcoder_state::{TaskKind, TaskStatus};
use kcoder_types::{ContentBlock, Message};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{self, Write};
use std::time::{Duration, Instant};
use tracing::error;

fn headless_failure(event: &EngineEvent) -> Option<String> {
    match event {
        EngineEvent::Error(error) | EngineEvent::ProviderFailed { message: error, .. } => {
            Some(format!("error: {error}"))
        }
        EngineEvent::StreamAborted { reason } if reason.trim() == "cancelled by user" => {
            Some("cancelled by user".to_string())
        }
        EngineEvent::StreamAborted { reason } => Some(format!("stream_aborted: {reason}")),
        EngineEvent::MaxTurnsReached {
            max_turns,
            turn_count,
        } => Some(format!(
            "max_turns_reached: turn {turn_count} exceeded limit {max_turns}"
        )),
        _ => None,
    }
}

fn record_orchestrate_turn_outcome(engine: &QueryEngine, events: &[EngineEvent]) -> Result<()> {
    engine.record_orchestrate_continuation_outcome(
        events.iter().any(|event| headless_failure(event).is_some()),
    )
}

pub(crate) fn engine_event_json(event: EngineEvent) -> Value {
    match event {
        EngineEvent::UserMessageAdded => serde_json::json!({"type": "user_message_added"}),
        EngineEvent::TurnSteerApplied { id } => {
            serde_json::json!({"type": "turn_steer_applied", "id": id})
        }
        EngineEvent::SubagentSteerApplied {
            agent_id,
            message_id,
            queue_depth,
        } => {
            serde_json::json!({
                "type": "subagent_steer_applied",
                "agent_id": agent_id,
                "message_id": message_id,
                "queue_depth": queue_depth,
            })
        }
        EngineEvent::AssistantTextDelta(text) => {
            serde_json::json!({"type": "assistant_text_delta", "text": text})
        }
        EngineEvent::AssistantMessageStarted => {
            serde_json::json!({"type": "assistant_message_started"})
        }
        EngineEvent::AssistantMessageDone => serde_json::json!({"type": "assistant_message_done"}),
        EngineEvent::AssistantThinkingDelta(text) => {
            serde_json::json!({"type": "assistant_thinking_delta", "text": text})
        }
        EngineEvent::ToolUseStarted { id, name, input } => {
            serde_json::json!({"type": "tool_use_started", "id": id, "name": name, "input": input})
        }
        EngineEvent::ToolInputReset => serde_json::json!({"type": "tool_input_reset"}),
        EngineEvent::ToolInputProgress { id, name, chars } => {
            serde_json::json!({"type": "tool_input_progress", "id": id, "name": name, "chars": chars})
        }
        EngineEvent::ToolInputPreview { id, preview } => {
            serde_json::json!({"type": "tool_input_preview", "id": id, "preview": preview})
        }
        EngineEvent::ToolPathPreview {
            attempt_id,
            id,
            path,
        } => {
            serde_json::json!({"type": "tool_path_preview", "attempt_id": attempt_id, "id": id, "path": path})
        }
        EngineEvent::ToolDenied { id, name, reason } => {
            serde_json::json!({"type": "tool_denied", "id": id, "name": name, "reason": reason})
        }
        EngineEvent::ToolResult { id, name, output } => {
            let text = output
                .content
                .into_iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text),
                    _ => None,
                })
                .collect::<String>();
            serde_json::json!({"type": "tool_result", "id": id, "name": name, "text": text, "is_error": output.is_error})
        }
        EngineEvent::SystemNotice(text) => {
            serde_json::json!({"type": "system_notice", "text": text})
        }
        EngineEvent::ProviderRetry(details) => {
            let text = details.notice_text();
            let mut event = serde_json::to_value(details).unwrap_or_else(|_| serde_json::json!({}));
            if let Some(event) = event.as_object_mut() {
                event.insert(
                    "type".to_string(),
                    Value::String("system_notice".to_string()),
                );
                event.insert(
                    "kind".to_string(),
                    Value::String("provider_retry".to_string()),
                );
                event.insert("text".to_string(), Value::String(text));
            }
            crate::build_identity::add_to_json(&mut event);
            event
        }
        EngineEvent::MoaReference {
            label,
            text,
            index,
            count,
        } => {
            serde_json::json!({"type": "moa_reference", "label": label, "text": text, "index": index, "count": count})
        }
        EngineEvent::MoaAggregating { aggregator } => {
            serde_json::json!({"type": "moa_aggregating", "aggregator": aggregator})
        }
        EngineEvent::ProviderFailed { message, details } => serde_json::json!({
            "type": "error",
            "error": message,
            "retryable": details.retryable,
            "resume_safe": details.resume_safe,
            "retry_after_ms": details.retry_after_ms,
            "provider_failure": details,
        }),
        EngineEvent::Error(error) => {
            let retryable = crate::headless_outcome::is_retryable_failure(&error);
            let retry_after_ms = crate::headless_outcome::recommended_retry_after_ms(&error);
            serde_json::json!({
                "type": "error",
                "error": error,
                "retryable": retryable,
                "resume_safe": retryable,
                "retry_after_ms": retry_after_ms,
            })
        }
        EngineEvent::MaxTurnsReached { max_turns, .. } => {
            serde_json::json!({"type": "max_turns_reached", "max_turns": max_turns})
        }
        EngineEvent::StreamAborted { reason } => {
            serde_json::json!({"type": "stream_aborted", "reason": reason})
        }
        EngineEvent::CompactionFailed { error, details } => {
            let mut event = serde_json::json!({"type": "compaction_failed", "error": error});
            if let (Some(details), Some(event)) = (details, event.as_object_mut())
                && let Ok(serde_json::Value::Object(fields)) = serde_json::to_value(details)
            {
                event.extend(fields);
            }
            crate::build_identity::add_to_json(&mut event);
            event
        }
        EngineEvent::CompactionRecovered { details } => {
            let mut event = serde_json::json!({"type": "compaction_recovered"});
            if let (Ok(serde_json::Value::Object(fields)), Some(event)) =
                (serde_json::to_value(details), event.as_object_mut())
            {
                event.extend(fields);
            }
            crate::build_identity::add_to_json(&mut event);
            event
        }
        EngineEvent::HookMessage { text, is_error } => {
            serde_json::json!({"type": "hook_message", "text": text, "is_error": is_error})
        }
        EngineEvent::BackgroundJobStarted { id, description } => {
            serde_json::json!({"type": "background_job_started", "id": id, "description": description})
        }
        EngineEvent::BackgroundJobAssociated {
            id,
            tool_call_id,
            run_in_background,
        } => {
            serde_json::json!({"type": "background_job_associated", "id": id, "tool_call_id": tool_call_id, "run_in_background": run_in_background})
        }
        EngineEvent::BackgroundJobPromoted { id } => {
            serde_json::json!({"type": "background_job_promoted", "id": id})
        }
        EngineEvent::BackgroundJobProgress {
            id,
            message,
            detail,
            current,
            total,
        } => {
            serde_json::json!({"type": "background_job_progress", "id": id, "message": message, "detail": detail, "current": current, "total": total})
        }
        EngineEvent::BackgroundJobCompleted { id, output } => {
            let text = output
                .content
                .into_iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text),
                    _ => None,
                })
                .collect::<String>();
            serde_json::json!({"type": "background_job_completed", "id": id, "text": text, "is_error": output.is_error})
        }
        EngineEvent::BackgroundJobFailed { id, error } => {
            serde_json::json!({"type": "background_job_failed", "id": id, "error": error})
        }
        EngineEvent::BackgroundJobPaused { id, reason } => {
            serde_json::json!({"type": "background_job_paused", "id": id, "reason": reason})
        }
        EngineEvent::BackgroundJobHalted { id, reason } => {
            serde_json::json!({"type": "background_job_halted", "id": id, "reason": reason})
        }
        EngineEvent::BackgroundJobCancelled { id, reason } => {
            serde_json::json!({"type": "background_job_cancelled", "id": id, "reason": reason})
        }
    }
}

fn write_json_line(writer: &mut impl Write, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn write_json_event(writer: &mut impl Write, event: EngineEvent) -> Result<()> {
    write_json_line(writer, &engine_event_json(event))
}

/// Foreground shell commands are registered with the background task manager so
/// they can be promoted to background delivery when they outlive the foreground
/// budget. That registration broadcasts a `BackgroundJobStarted` event, but the
/// command's completion is consumed by the tool itself and is never broadcast,
/// so surfacing the start in JSON headless output would leave consumers with a
/// dangling job. The foreground outcome already arrives as a `tool_result`
/// event (or, after promotion, as an explicit background-started tool result),
/// and terminal events for explicit background tasks are drained before exit,
/// so suppress these internal start notifications.
fn is_internal_foreground_job_start(event: &EngineEvent) -> bool {
    matches!(
        event,
        EngineEvent::BackgroundJobStarted { description, .. }
            if description.starts_with(kcoder_tools::background::TOOL_BACKGROUND_TASK_PREFIX)
    )
}

/// Terminal event emitted as the last line of `--json` headless output so
/// consumers can distinguish a clean end from a truncated stream without
/// relying solely on the process exit code.
fn headless_result_event(
    outcome: &HeadlessOutcome,
    output_failed: bool,
    session_id: String,
) -> Value {
    let mut event = if output_failed {
        outcome.with_output_failure().to_json(session_id)
    } else {
        outcome.to_json(session_id)
    };
    crate::build_identity::add_to_json(&mut event);
    event
}

const MAX_HEADLESS_BACKGROUND_FOLLOWUPS: usize = 32;

enum HeadlessGoalContinuation {
    Continue,
    Stop {
        notice: String,
        reason: &'static str,
    },
    None,
}

fn headless_goal_automatic_turn_policy(
    engine: &QueryEngine,
    continuation_count: usize,
    session_started_at: Instant,
) -> HeadlessGoalContinuation {
    let (limit, max_duration) = {
        let settings = engine.settings.read().unwrap();
        (
            settings.goal_max_auto_continuations,
            settings.max_duration_secs.map(Duration::from_secs),
        )
    };
    if !engine
        .state
        .goal()
        .is_some_and(|goal| goal.status.is_active())
    {
        return HeadlessGoalContinuation::None;
    }
    if kcoder_engine::goal_continuation::auto_continuation_limit_reached(limit, continuation_count)
    {
        return HeadlessGoalContinuation::Stop {
            notice: format!("Goal auto-continuation limit reached ({limit}); goal remains active."),
            reason: "goal_auto_continuation_limit",
        };
    }
    if max_duration.is_some_and(|duration| session_started_at.elapsed() >= duration) {
        return HeadlessGoalContinuation::Stop {
            notice:
                "Headless goal session reached its absolute max-duration deadline; goal remains active."
                    .to_string(),
            reason: "max_duration",
        };
    }
    HeadlessGoalContinuation::Continue
}

fn record_headless_background_goal_turn(engine: &QueryEngine, continuation_count: &mut usize) {
    let Some(goal) = engine.state.goal().filter(|goal| goal.status.is_active()) else {
        return;
    };
    let _ = engine.state.record_goal_turn_start(&goal.goal_id);
    *continuation_count += 1;
}

fn prepare_headless_goal_continuation(
    engine: &QueryEngine,
    continuation_count: usize,
    session_started_at: Instant,
) -> HeadlessGoalContinuation {
    match headless_goal_automatic_turn_policy(engine, continuation_count, session_started_at) {
        HeadlessGoalContinuation::Continue => {}
        outcome => return outcome,
    }
    let enabled = engine.settings.read().unwrap().goal_enabled;
    let Some(goal) = engine.state.goal() else {
        return HeadlessGoalContinuation::None;
    };
    let final_text =
        kcoder_engine::goal_continuation::latest_assistant_text(&engine.state.messages());
    let Some(decision) = kcoder_engine::goal_continuation::plan_goal_continuation(
        enabled,
        &goal,
        final_text.as_deref(),
    ) else {
        return HeadlessGoalContinuation::None;
    };
    if engine.state.session_mode().is_orchestrate() {
        match engine.claim_orchestrate_idle_continuation(
            kcoder_engine::orchestrate::continuation::IdleRequest {
                cooldown_elapsed: true,
                ..Default::default()
            },
        ) {
            Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::Enqueued {
                ..
            })
            | Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::NotApplicable)
            | Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::StayIdle {
                reason: "no_incomplete_active_work",
                ..
            }) => {}
            Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::StayIdle {
                reason,
                ..
            }) => {
                return HeadlessGoalContinuation::Stop {
                    notice: format!(
                        "Orchestrate automatic continuation stopped ({reason}); goal/work remain active."
                    ),
                    reason: "orchestrate_continuation_stopped",
                };
            }
            Err(error) => {
                return HeadlessGoalContinuation::Stop {
                    notice: format!("Orchestrate continuation state failed: {error:#}"),
                    reason: "orchestrate_continuation_error",
                };
            }
        }
    }
    let goal = engine
        .state
        .record_goal_turn_start(&goal.goal_id)
        .unwrap_or(goal);
    engine.state.add_message(Message::user_text(
        kcoder_engine::goal_continuation::format_goal_continuation_prompt(&goal, &decision),
    ));
    HeadlessGoalContinuation::Continue
}

fn prepare_headless_orchestrate_continuation(
    engine: &QueryEngine,
    goal_continuation_count: usize,
) -> HeadlessGoalContinuation {
    let goal_limit_reached = engine.state.goal().is_some_and(|goal| {
        goal.status.is_active()
            && kcoder_engine::goal_continuation::auto_continuation_limit_reached(
                engine.settings.read().unwrap().goal_max_auto_continuations,
                goal_continuation_count,
            )
    });
    match engine.claim_orchestrate_idle_continuation(
        kcoder_engine::orchestrate::continuation::IdleRequest {
            cooldown_elapsed: true,
            goal_limit_reached,
            ..Default::default()
        },
    ) {
        Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::Enqueued { prompt }) => {
            engine.state.add_message(Message::user_text(prompt));
            HeadlessGoalContinuation::Continue
        }
        Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::StayIdle {
            reason: "manual_intervention_required",
            ..
        }) => HeadlessGoalContinuation::Stop {
            notice: "Orchestrate automatic continuation limit reached; work remains active and requires user review.".to_string(),
            reason: "orchestrate_manual_intervention",
        },
        Ok(_) => HeadlessGoalContinuation::None,
        Err(error) => HeadlessGoalContinuation::Stop {
            notice: format!("Orchestrate continuation infrastructure error: {error:#}"),
            reason: "orchestrate_continuation_error",
        },
    }
}

async fn wait_headless_orchestrate_cooldown(engine: &QueryEngine) {
    if engine.state.session_mode().is_orchestrate() {
        let seconds = engine
            .settings
            .read()
            .unwrap()
            .orchestrate
            .continuation
            .cooldown_seconds;
        if seconds > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(seconds)).await;
        }
    }
}

fn has_running_headless_subagents(engine: &QueryEngine) -> bool {
    engine.state.tasks().values().any(|task| {
        matches!(task.kind, TaskKind::Subagent)
            && task.notify_parent_on_completion
            && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
    })
}

fn running_headless_subagent_ids(engine: &QueryEngine) -> Vec<String> {
    engine
        .state
        .tasks()
        .into_values()
        .filter(|task| {
            matches!(task.kind, TaskKind::Subagent)
                && task.notify_parent_on_completion
                && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
        })
        .map(|task| task.id)
        .collect()
}

fn headless_background_event_id(event: &EngineEvent) -> Option<&str> {
    match event {
        EngineEvent::BackgroundJobCompleted { id, .. }
        | EngineEvent::BackgroundJobFailed { id, .. }
        | EngineEvent::BackgroundJobCancelled { id, .. } => Some(id),
        _ => None,
    }
}

fn headless_background_event_summary(event: &EngineEvent) -> Option<String> {
    match event {
        EngineEvent::BackgroundJobCompleted { id, .. } => {
            Some(format!("background sub-agent `{id}` completed"))
        }
        EngineEvent::BackgroundJobFailed { id, error } => {
            Some(format!("background sub-agent `{id}` failed: {error}"))
        }
        EngineEvent::BackgroundJobCancelled { id, reason } => Some(format!(
            "background sub-agent `{id}` was cancelled: {reason}"
        )),
        _ => None,
    }
}

fn track_headless_background_followup(
    engine: &QueryEngine,
    event: &EngineEvent,
    pending: &mut BTreeMap<String, String>,
) {
    let Some(id) = headless_background_event_id(event) else {
        return;
    };
    if !engine.background_job_triggers_followup(id) {
        return;
    }
    if let Some(summary) = headless_background_event_summary(event) {
        pending.insert(id.to_string(), summary);
    }
}

fn record_headless_wait_events(
    events: &mut Vec<EngineEvent>,
    incoming: impl IntoIterator<Item = EngineEvent>,
    observe: &mut impl FnMut(&EngineEvent),
) {
    for event in incoming {
        observe(&event);
        events.push(event);
    }
}

async fn wait_for_headless_subagents(
    engine: &QueryEngine,
    mut observe: impl FnMut(&EngineEvent),
) -> Vec<EngineEvent> {
    let mut wake_rx = engine.subscribe_background_jobs();
    let mut events = Vec::new();
    loop {
        record_headless_wait_events(
            &mut events,
            engine.flush_background_jobs_with_hooks().await,
            &mut observe,
        );
        if !has_running_headless_subagents(engine) {
            // Close the completion race between the active-task check and the
            // primary receiver drain.
            record_headless_wait_events(
                &mut events,
                engine.flush_background_jobs_with_hooks().await,
                &mut observe,
            );
            return events;
        }

        match wake_rx.recv().await {
            Ok(BackgroundJobEvent::Progress {
                id,
                message,
                detail,
                current,
                total,
            }) => {
                let event = EngineEvent::BackgroundJobProgress {
                    id,
                    message,
                    detail,
                    current,
                    total,
                };
                observe(&event);
                events.push(event);
            }
            Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                let event = EngineEvent::Error(
                    "background job channel closed while sub-agents were still running".to_string(),
                );
                observe(&event);
                events.push(event);
                return events;
            }
        }
    }
}

async fn cancel_headless_subagents(engine: &QueryEngine) -> Vec<EngineEvent> {
    let ids = running_headless_subagent_ids(engine);
    futures::future::join_all(
        ids.iter()
            .map(|id| engine.abort_background_job_and_wait(id)),
    )
    .await;
    engine.flush_background_jobs_with_hooks().await
}

/// Drop tracked agents that were closed and report whether any aggregate work
/// remains. Both follow-up loops consult this before injecting the aggregate
/// nudge so a closed agent never appears and an all-closed batch skips the
/// turn entirely.
fn retain_live_background_followups(
    engine: &QueryEngine,
    pending: &mut BTreeMap<String, String>,
) -> bool {
    pending.retain(|id, _| engine.background_job_triggers_followup(id));
    !pending.is_empty()
}

fn headless_background_followup_nudge(pending: &BTreeMap<String, String>) -> String {
    format!(
        "[system] All tracked background sub-agents have finished. Aggregate their results now \
         using the available `<subagent_notification .../>` entries and output files. Events: {}. \
         Continue the original task, do not repeat work already delegated to a sub-agent, and do \
         not give a final conclusion until the relevant results have been inspected.",
        pending.values().cloned().collect::<Vec<_>>().join(" ")
    )
}

pub(super) async fn run<P: PermissionPrompt>(
    engine: &QueryEngine,
    prompt: String,
    prompt_cb: &P,
    json: bool,
    mut events: Vec<EngineEvent>,
) -> Result<()> {
    let session_started_at = Instant::now();
    engine.acknowledge_orchestrate_user_input()?;
    if json {
        let stdout = io::stdout();
        let mut stdout = stdout.lock();
        let mut failure = None;
        let mut output_error = None;
        let mut outcome = HeadlessOutcome::default();
        let mut pending_background_followups = BTreeMap::new();
        for event in events.drain(..) {
            outcome.observe_event(&event);
            if failure.is_none() {
                failure = headless_failure(&event);
            }
            if is_internal_foreground_job_start(&event) {
                continue;
            }
            if output_error.is_none()
                && let Err(error) = write_json_event(&mut stdout, event)
            {
                engine.cancel();
                output_error = Some(error);
            }
        }
        let mut followup_count = 0usize;
        let mut goal_continuation_count = 0usize;
        let mut next_prompt = Some(prompt);
        loop {
            if failure.is_some() || output_error.is_some() {
                for event in cancel_headless_subagents(engine).await {
                    outcome.observe_event(&event);
                    if output_error.is_none()
                        && let Err(error) = write_json_event(&mut stdout, event)
                    {
                        engine.cancel();
                        output_error = Some(error);
                    }
                }
                break;
            }
            let mut stream = match next_prompt.take() {
                Some(prompt) => engine.submit_message_stream(prompt, prompt_cb),
                None => engine.run_turn_stream(prompt_cb),
            };
            let mut orchestrate_turn_failed = false;
            while let Some(event) = futures::StreamExt::next(&mut stream).await {
                orchestrate_turn_failed |= headless_failure(&event).is_some();
                outcome.observe_event(&event);
                if failure.is_none() {
                    failure = headless_failure(&event);
                }
                if is_internal_foreground_job_start(&event) {
                    continue;
                }
                if output_error.is_none()
                    && let Err(error) = write_json_event(&mut stdout, event)
                {
                    engine.cancel();
                    output_error = Some(error);
                }
            }
            drop(stream);
            if let Err(error) =
                engine.record_orchestrate_continuation_outcome(orchestrate_turn_failed)
                && failure.is_none()
            {
                failure = Some(format!("orchestrate_continuation_outcome: {error:#}"));
            }

            if failure.is_some() || output_error.is_some() {
                for event in cancel_headless_subagents(engine).await {
                    outcome.observe_event(&event);
                    if output_error.is_none()
                        && let Err(error) = write_json_event(&mut stdout, event)
                    {
                        engine.cancel();
                        output_error = Some(error);
                    }
                }
                break;
            }

            // A headless consumer has no TUI watcher to schedule the aggregate
            // turn. Wait for every parent-notifying sub-agent, emit each
            // terminal lifecycle event, then run the same hidden aggregate
            // nudge used by the TUI.
            let waited_events = wait_for_headless_subagents(engine, |event| {
                outcome.observe_event(event);
                if failure.is_none() {
                    failure = headless_failure(event);
                }
                track_headless_background_followup(
                    engine,
                    event,
                    &mut pending_background_followups,
                );
                if is_internal_foreground_job_start(event) {
                    return;
                }
                if output_error.is_none()
                    && let Err(error) = write_json_event(&mut stdout, event.clone())
                {
                    engine.cancel();
                    output_error = Some(error);
                }
            })
            .await;
            drop(waited_events);

            if failure.is_some() || output_error.is_some() {
                for event in cancel_headless_subagents(engine).await {
                    outcome.observe_event(&event);
                    if output_error.is_none()
                        && let Err(error) = write_json_event(&mut stdout, event)
                    {
                        engine.cancel();
                        output_error = Some(error);
                    }
                }
                break;
            }

            if pending_background_followups.is_empty() {
                match prepare_headless_goal_continuation(
                    engine,
                    goal_continuation_count,
                    session_started_at,
                ) {
                    HeadlessGoalContinuation::Continue => {
                        goal_continuation_count += 1;
                        wait_headless_orchestrate_cooldown(engine).await;
                        continue;
                    }
                    HeadlessGoalContinuation::Stop { notice, reason } => {
                        let notice = EngineEvent::SystemNotice(notice);
                        outcome.observe_event(&notice);
                        if output_error.is_none()
                            && let Err(error) = write_json_event(&mut stdout, notice)
                        {
                            output_error = Some(error);
                        }
                        let stopped = EngineEvent::StreamAborted {
                            reason: reason.to_string(),
                        };
                        outcome.observe_event(&stopped);
                        if output_error.is_none()
                            && let Err(error) = write_json_event(&mut stdout, stopped)
                        {
                            output_error = Some(error);
                        }
                        break;
                    }
                    HeadlessGoalContinuation::None => {
                        match prepare_headless_orchestrate_continuation(
                            engine,
                            goal_continuation_count,
                        ) {
                            HeadlessGoalContinuation::Continue => {
                                wait_headless_orchestrate_cooldown(engine).await;
                                continue;
                            }
                            HeadlessGoalContinuation::Stop { notice, reason } => {
                                let notice = EngineEvent::SystemNotice(notice);
                                outcome.observe_event(&notice);
                                if output_error.is_none()
                                    && let Err(error) = write_json_event(&mut stdout, notice)
                                {
                                    output_error = Some(error);
                                }
                                let stopped = EngineEvent::StreamAborted {
                                    reason: reason.to_string(),
                                };
                                outcome.observe_event(&stopped);
                                if output_error.is_none()
                                    && let Err(error) = write_json_event(&mut stdout, stopped)
                                {
                                    output_error = Some(error);
                                }
                                break;
                            }
                            HeadlessGoalContinuation::None => break,
                        }
                    }
                }
            }
            if followup_count >= MAX_HEADLESS_BACKGROUND_FOLLOWUPS {
                let event = EngineEvent::Error(format!(
                    "background_followup_limit: exceeded {} aggregate turns",
                    MAX_HEADLESS_BACKGROUND_FOLLOWUPS
                ));
                outcome.observe_event(&event);
                if output_error.is_none()
                    && let Err(error) = write_json_event(&mut stdout, event)
                {
                    output_error = Some(error);
                }
                break;
            }
            match headless_goal_automatic_turn_policy(
                engine,
                goal_continuation_count,
                session_started_at,
            ) {
                HeadlessGoalContinuation::Stop { notice, reason } => {
                    let notice = EngineEvent::SystemNotice(notice);
                    outcome.observe_event(&notice);
                    if output_error.is_none()
                        && let Err(error) = write_json_event(&mut stdout, notice)
                    {
                        output_error = Some(error);
                    }
                    let stopped = EngineEvent::StreamAborted {
                        reason: reason.to_string(),
                    };
                    outcome.observe_event(&stopped);
                    if output_error.is_none()
                        && let Err(error) = write_json_event(&mut stdout, stopped)
                    {
                        output_error = Some(error);
                    }
                    break;
                }
                HeadlessGoalContinuation::Continue => {
                    record_headless_background_goal_turn(engine, &mut goal_continuation_count);
                }
                HeadlessGoalContinuation::None => {}
            }
            // A closed agent must not appear in the aggregate nudge.
            if !retain_live_background_followups(engine, &mut pending_background_followups) {
                // Every tracked agent was closed while waiting; there is no
                // aggregate work left. Re-enter the loop: the empty-queue
                // branch above then runs the goal/orchestrate checks and exits
                // normally instead of injecting an empty nudge.
                continue;
            }
            followup_count += 1;
            let nudge = headless_background_followup_nudge(&pending_background_followups);
            pending_background_followups.clear();
            engine.state.add_message(Message::user_text(nudge));
        }
        outcome.finalize(engine);
        let exit_reason = outcome.hook_exit_reason();
        for event in engine.run_session_end_hooks(&exit_reason).await {
            outcome.observe_event(&event);
            if output_error.is_none()
                && let Err(error) = write_json_event(&mut stdout, event)
            {
                engine.cancel();
                output_error = Some(error);
            }
        }
        if output_error.is_none()
            && let Err(error) = write_json_line(
                &mut stdout,
                &headless_result_event(&outcome, output_error.is_some(), engine.session_id()),
            )
        {
            engine.cancel();
            output_error = Some(error);
        }
        drop(stdout);
        if let Some(error) = output_error {
            return Err(error).context("failed to write JSON headless output");
        }
        if !outcome.is_success() {
            bail!("headless task failed: {}", outcome.error_message());
        }
        return Ok(());
    }

    events.extend(engine.submit_message(prompt, prompt_cb).await);
    let mut pending_background_followups = BTreeMap::new();
    let mut followup_count = 0usize;
    let mut goal_continuation_count = 0usize;
    loop {
        if events.iter().any(|event| headless_failure(event).is_some()) {
            events.extend(cancel_headless_subagents(engine).await);
            break;
        }
        let waited_events = wait_for_headless_subagents(engine, |_| {}).await;
        for event in &waited_events {
            track_headless_background_followup(engine, event, &mut pending_background_followups);
        }
        events.extend(waited_events);
        if events.iter().any(|event| headless_failure(event).is_some()) {
            events.extend(cancel_headless_subagents(engine).await);
            break;
        }
        if pending_background_followups.is_empty() {
            match prepare_headless_goal_continuation(
                engine,
                goal_continuation_count,
                session_started_at,
            ) {
                HeadlessGoalContinuation::Continue => {
                    goal_continuation_count += 1;
                    wait_headless_orchestrate_cooldown(engine).await;
                    let followup_events =
                        engine.run_turn_stream(prompt_cb).collect::<Vec<_>>().await;
                    record_orchestrate_turn_outcome(engine, &followup_events)?;
                    events.extend(followup_events);
                    continue;
                }
                HeadlessGoalContinuation::Stop { notice, reason } => {
                    events.push(EngineEvent::SystemNotice(notice));
                    events.push(EngineEvent::StreamAborted {
                        reason: reason.to_string(),
                    });
                    break;
                }
                HeadlessGoalContinuation::None => {
                    match prepare_headless_orchestrate_continuation(engine, goal_continuation_count)
                    {
                        HeadlessGoalContinuation::Continue => {
                            wait_headless_orchestrate_cooldown(engine).await;
                            let followup_events =
                                engine.run_turn_stream(prompt_cb).collect::<Vec<_>>().await;
                            record_orchestrate_turn_outcome(engine, &followup_events)?;
                            events.extend(followup_events);
                            continue;
                        }
                        HeadlessGoalContinuation::Stop { notice, reason } => {
                            events.push(EngineEvent::SystemNotice(notice));
                            events.push(EngineEvent::StreamAborted {
                                reason: reason.to_string(),
                            });
                            break;
                        }
                        HeadlessGoalContinuation::None => break,
                    }
                }
            }
        }
        if followup_count >= MAX_HEADLESS_BACKGROUND_FOLLOWUPS {
            events.push(EngineEvent::Error(format!(
                "background_followup_limit: exceeded {} aggregate turns",
                MAX_HEADLESS_BACKGROUND_FOLLOWUPS
            )));
            break;
        }
        match headless_goal_automatic_turn_policy(
            engine,
            goal_continuation_count,
            session_started_at,
        ) {
            HeadlessGoalContinuation::Stop { notice, reason } => {
                events.push(EngineEvent::SystemNotice(notice));
                events.push(EngineEvent::StreamAborted {
                    reason: reason.to_string(),
                });
                break;
            }
            HeadlessGoalContinuation::Continue => {
                record_headless_background_goal_turn(engine, &mut goal_continuation_count);
            }
            HeadlessGoalContinuation::None => {}
        }
        // A closed agent must not appear in the aggregate nudge.
        if !retain_live_background_followups(engine, &mut pending_background_followups) {
            // No aggregate work left; the empty-queue branch above handles the
            // goal/orchestrate checks and exits normally.
            continue;
        }
        followup_count += 1;
        let nudge = headless_background_followup_nudge(&pending_background_followups);
        pending_background_followups.clear();
        engine.state.add_message(Message::user_text(nudge));
        let followup_events = engine.run_turn_stream(prompt_cb).collect::<Vec<_>>().await;
        record_orchestrate_turn_outcome(engine, &followup_events)?;
        events.extend(followup_events);
    }
    let mut outcome = HeadlessOutcome::default();
    for event in &events {
        outcome.observe_event(event);
    }
    outcome.finalize(engine);
    let exit_reason = outcome.hook_exit_reason();
    let session_end_events = engine.run_session_end_hooks(&exit_reason).await;
    for event in &session_end_events {
        outcome.observe_event(event);
    }
    events.extend(session_end_events);

    let mut assistant_started = false;
    for event in events {
        match event {
            EngineEvent::UserMessageAdded => {}
            EngineEvent::TurnSteerApplied { .. } => {}
            EngineEvent::SubagentSteerApplied {
                agent_id,
                message_id,
                queue_depth,
            } => {
                println!(
                    "\n[Sub-agent {agent_id} applied steering message {message_id}; {queue_depth} queued]"
                );
            }
            EngineEvent::AssistantMessageStarted => {}
            EngineEvent::AssistantTextDelta(text) => {
                print!("{}", text);
                assistant_started = true;
            }
            EngineEvent::AssistantMessageDone => {
                if assistant_started {
                    println!();
                    assistant_started = false;
                }
            }
            EngineEvent::AssistantThinkingDelta(_) => {
                // Suppress thinking blocks in plain headless output by default.
            }
            EngineEvent::ToolUseStarted { name, input, .. } => {
                println!("\n[Tool use: {} with {}]", name, input);
            }
            EngineEvent::ToolInputReset | EngineEvent::ToolInputProgress { .. } => {
                // Progress is rendered by the TUI; keep plain headless output concise.
            }
            EngineEvent::ToolInputPreview { .. } | EngineEvent::ToolPathPreview { .. } => {
                // The following ToolUseStarted event contains the completed input.
            }
            EngineEvent::ToolDenied { name, reason, .. } => {
                println!("\n[Tool denied: {} — {}]", name, reason);
            }
            EngineEvent::ToolResult { name, output, .. } => {
                let text = output
                    .content
                    .into_iter()
                    .filter_map(|b| match b {
                        kcoder_types::ContentBlock::Text { text } => Some(text),
                        _ => None,
                    })
                    .collect::<String>();
                let prefix = if output.is_error {
                    "[Tool error"
                } else {
                    "[Tool result"
                };
                println!("\n{}: {}]\n{}", prefix, name, text);
            }
            EngineEvent::SystemNotice(text) => {
                println!("\n[{}]", text);
            }
            EngineEvent::ProviderRetry(details) => {
                println!("\n[{}]", details.notice_text());
            }
            EngineEvent::MoaReference {
                label,
                text,
                index,
                count,
            } => {
                println!(
                    "\n[MoA reference {}/{} - {}]\n{}",
                    index, count, label, text
                );
            }
            EngineEvent::MoaAggregating { aggregator } => {
                println!("\n[MoA acting model: {}]", aggregator);
            }
            EngineEvent::Error(err) | EngineEvent::ProviderFailed { message: err, .. } => {
                error!("engine error: {}", err);
            }
            EngineEvent::MaxTurnsReached { max_turns, .. } => {
                println!("\n[Reached maximum turns: {}]", max_turns);
            }
            EngineEvent::StreamAborted { reason } => {
                println!("\n[Stream aborted: {}]", reason);
            }
            EngineEvent::CompactionFailed { error, .. } => {
                println!("\n[Compaction failed: {}]", error);
            }
            EngineEvent::CompactionRecovered { details } => {
                println!("\n[{}]", details.recovered_notice_text());
            }
            EngineEvent::HookMessage { text, is_error } => {
                let prefix = if is_error {
                    "[Hook error"
                } else {
                    "[Hook message"
                };
                println!("\n{}: {}]", prefix, text);
            }
            EngineEvent::BackgroundJobStarted { id, description } => {
                println!("\n[Background job {} started: {}]", id, description);
            }
            EngineEvent::BackgroundJobAssociated { .. } => {
                // Presentation metadata; the lifecycle start already identifies the job.
            }
            EngineEvent::BackgroundJobPromoted { id } => {
                println!("\n[Background job {} moved to background]", id);
            }
            EngineEvent::BackgroundJobProgress { .. } => {
                // Lifecycle heartbeats are presentation-only; avoid flooding
                // plain headless output. JSON mode retains the structured event.
            }
            EngineEvent::BackgroundJobCompleted { id, output, .. } => {
                let text = output
                    .content
                    .into_iter()
                    .filter_map(|b| match b {
                        kcoder_types::ContentBlock::Text { text } => Some(text),
                        _ => None,
                    })
                    .collect::<String>();
                let prefix = if output.is_error {
                    "[Background job error"
                } else {
                    "[Background job completed"
                };
                println!("\n{}: {}]\n{}", prefix, id, text);
            }
            EngineEvent::BackgroundJobFailed { id, error } => {
                println!("\n[Background job {} failed: {}]", id, error);
            }
            EngineEvent::BackgroundJobPaused { id, reason } => {
                println!("\n[Background job {} paused: {}]", id, reason);
            }
            EngineEvent::BackgroundJobHalted { id, reason } => {
                println!("\n[Background job {} halted: {}]", id, reason);
            }
            EngineEvent::BackgroundJobCancelled { id, reason } => {
                println!("\n[Background job {} cancelled: {}]", id, reason);
            }
        }
    }

    if !outcome.is_success() {
        bail!("headless task failed: {}", outcome.error_message());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn goal_policy_test_engine(cwd: &std::path::Path) -> QueryEngine {
        let settings = kcoder_config::Settings::default();
        QueryEngine::new_with_folder_trust(
            Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
                crate::tui_dev_mock::TuiDevScenario::FullTurn,
            )),
            kcoder_state::AppState::new(cwd),
            kcoder_tools::ToolRegistry::new(),
            kcoder_permissions::PermissionEngine::from_settings(&settings),
            settings,
            kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
            kcoder_skills::SkillRegistry::empty(),
            Arc::new(kcoder_tools::DenyAllUserQuestioner),
            cwd.to_path_buf(),
            Some(true),
        )
    }

    #[tokio::test]
    async fn closed_agents_are_dropped_before_the_aggregate_nudge() {
        let workspace = tempfile::tempdir().unwrap();
        let engine = goal_policy_test_engine(workspace.path());
        let mut live = kcoder_state::Task::new("job-live", "Implementer agent: patch");
        live.kind = kcoder_state::TaskKind::Subagent;
        live.notify_parent_on_completion = true;
        live.status = kcoder_state::TaskStatus::Completed;
        engine.state.upsert_task(live);
        let mut closed = kcoder_state::Task::new("job-closed", "Explore agent: survey");
        closed.kind = kcoder_state::TaskKind::Subagent;
        closed.notify_parent_on_completion = true;
        closed.status = kcoder_state::TaskStatus::Completed;
        engine.state.upsert_task(closed);
        engine.state.remove_task("job-closed");

        let mut pending = BTreeMap::from([
            (
                "job-live".to_string(),
                "background sub-agent `job-live` completed".to_string(),
            ),
            (
                "job-closed".to_string(),
                "background sub-agent `job-closed` completed".to_string(),
            ),
        ]);
        assert!(retain_live_background_followups(&engine, &mut pending));
        assert_eq!(pending.keys().collect::<Vec<_>>(), vec!["job-live"]);

        engine.state.remove_task("job-live");
        assert!(
            !retain_live_background_followups(&engine, &mut pending),
            "no aggregate work must remain once every tracked agent is gone"
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn headless_background_goal_turns_share_the_configured_continuation_limit() {
        let workspace = tempfile::tempdir().unwrap();
        let engine = goal_policy_test_engine(workspace.path());
        engine.settings.write().unwrap().goal_max_auto_continuations = 1;
        engine.state.set_goal("aggregate agent results", None);
        let started_at = Instant::now();
        let mut count = 0;

        assert!(matches!(
            headless_goal_automatic_turn_policy(&engine, count, started_at),
            HeadlessGoalContinuation::Continue
        ));
        record_headless_background_goal_turn(&engine, &mut count);
        assert_eq!(count, 1);
        assert_eq!(engine.state.goal().unwrap().continuation_count, 1);
        assert!(matches!(
            headless_goal_automatic_turn_policy(&engine, count, started_at),
            HeadlessGoalContinuation::Stop {
                reason: "goal_auto_continuation_limit",
                ..
            }
        ));
    }

    #[test]
    fn headless_failure_preserves_user_cancellation_reason() {
        assert_eq!(
            headless_failure(&EngineEvent::StreamAborted {
                reason: "cancelled by user".to_string(),
            })
            .as_deref(),
            Some("cancelled by user")
        );
        assert_eq!(
            headless_failure(&EngineEvent::StreamAborted {
                reason: "provider stream idle".to_string(),
            })
            .as_deref(),
            Some("stream_aborted: provider stream idle")
        );
    }
    #[test]
    fn json_event_includes_tool_input_progress_id() {
        assert_eq!(
            engine_event_json(EngineEvent::ToolInputReset),
            serde_json::json!({"type":"tool_input_reset"})
        );
        let event = engine_event_json(EngineEvent::ToolInputProgress {
            id: "tool-1".to_string(),
            name: "bash".to_string(),
            chars: 42,
        });
        assert_eq!(event["type"], "tool_input_progress");
        assert_eq!(event["id"], "tool-1");
        assert_eq!(event["name"], "bash");
        assert_eq!(event["chars"], 42);
    }

    #[test]
    fn json_tool_path_preview_preserves_attempt_identity_and_explicit_clear() {
        for path in [Some("src/main.rs".to_string()), None] {
            let event = engine_event_json(EngineEvent::ToolPathPreview {
                attempt_id: "attempt-1".into(),
                id: "tool-1".into(),
                path: path.clone(),
            });
            assert_eq!(event["type"], "tool_path_preview");
            assert_eq!(event["attempt_id"], "attempt-1");
            assert_eq!(event["id"], "tool-1");
            assert_eq!(event["path"], serde_json::json!(path));
            assert!(event.get("path").is_some());
        }
    }

    #[test]
    fn json_compaction_failure_exposes_safe_protocol_metadata() {
        let event = engine_event_json(EngineEvent::CompactionFailed {
            error: "invalid summary".to_string(),
            details: Some(kcoder_engine::context::CompactionFailureDetails {
                phase: "auto_full".to_string(),
                reason: "protocol_tag_count".to_string(),
                opening_summary_tags: 2,
                closing_summary_tags: 1,
                response_chars: 6842,
                response_fingerprint: "deadbeef".to_string(),
                stop_reason: Some("end_turn".to_string()),
                attempt: 3,
                will_retry: false,
                state_mutated: false,
            }),
        });

        assert_eq!(event["type"], "compaction_failed");
        assert_eq!(event["phase"], "auto_full");
        assert_eq!(event["reason"], "protocol_tag_count");
        assert_eq!(event["opening_summary_tags"], 2);
        assert_eq!(event["closing_summary_tags"], 1);
        assert_eq!(event["response_chars"], 6842);
        assert_eq!(event["attempt"], 3);
        assert_eq!(event["will_retry"], false);
        assert_eq!(event["state_mutated"], false);
        assert!(event["build_commit"].as_str().is_some());
        assert_eq!(event["executable_sha256"].as_str().map(str::len), Some(64));
        assert!(event.get("response").is_none());
    }

    #[test]
    fn json_compaction_recovery_is_not_reported_as_a_failure() {
        let event = engine_event_json(EngineEvent::CompactionRecovered {
            details: kcoder_engine::context::CompactionFailureDetails {
                phase: "auto_full".to_string(),
                reason: "protocol_tag_count".to_string(),
                opening_summary_tags: 2,
                closing_summary_tags: 1,
                response_chars: 6842,
                response_fingerprint: "deadbeef".to_string(),
                stop_reason: Some("end_turn".to_string()),
                attempt: 1,
                will_retry: true,
                state_mutated: false,
            },
        });

        assert_eq!(event["type"], "compaction_recovered");
        assert_eq!(event["phase"], "auto_full");
        assert_eq!(event["reason"], "protocol_tag_count");
        assert_eq!(event["attempt"], 1);
        assert_eq!(event["will_retry"], true);
        assert_eq!(event["state_mutated"], false);
        assert!(event.get("error").is_none());
        assert!(event.get("response").is_none());
    }

    #[test]
    fn json_provider_retry_exposes_timing_and_resume_metadata() {
        let event = engine_event_json(EngineEvent::ProviderRetry(
            kcoder_engine::ProviderRetryDetails {
                request_kind: "main".to_string(),
                provider: "test-provider".to_string(),
                model: "test-model".to_string(),
                attempt: 2,
                max_retries: 3,
                elapsed_ms: 180_000,
                turn_elapsed_ms: 200_000,
                transport_elapsed_ms: 190_000,
                retry_after_ms: 5_000,
                first_token_ms: Some(200),
                last_token_ms: Some(20_000),
                timeout_kind: Some("token_idle".to_string()),
                reason: "stream idle".to_string(),
            },
        ));

        assert_eq!(event["type"], "system_notice");
        assert_eq!(event["kind"], "provider_retry");
        assert_eq!(event["request_kind"], "main");
        assert_eq!(event["provider"], "test-provider");
        assert_eq!(event["model"], "test-model");
        assert_eq!(event["attempt"], 2);
        assert_eq!(event["retry_after_ms"], 5_000);
        assert_eq!(event["timeout_kind"], "token_idle");
        assert_eq!(event["first_token_ms"], 200);
        assert_eq!(event["last_token_ms"], 20_000);
        assert!(event["text"].as_str().unwrap().contains("retrying 2/3"));
        assert_eq!(event["executable_sha256"].as_str().map(str::len), Some(64));
    }

    #[test]
    fn retryable_error_event_recommends_backoff() {
        let event = engine_event_json(EngineEvent::Error("provider 529 overloaded".to_string()));
        assert_eq!(event["retryable"], true);
        assert_eq!(event["resume_safe"], true);
        assert_eq!(event["retry_after_ms"], 5_000);
    }

    #[test]
    fn internal_foreground_job_start_is_suppressed() {
        let internal = EngineEvent::BackgroundJobStarted {
            id: "job-1".to_string(),
            description: "tool-background:bash: run tests".to_string(),
        };
        assert!(is_internal_foreground_job_start(&internal));

        let subagent = EngineEvent::BackgroundJobStarted {
            id: "job-2".to_string(),
            description: "explore the repo".to_string(),
        };
        assert!(!is_internal_foreground_job_start(&subagent));

        // Terminal events for the same internal job must still flow through.
        let cancelled = EngineEvent::BackgroundJobCancelled {
            id: "job-1".to_string(),
            reason: "done".to_string(),
        };
        assert!(!is_internal_foreground_job_start(&cancelled));
    }

    #[test]
    fn headless_result_event_reports_success_and_error() {
        let success_outcome = HeadlessOutcome::default();
        let success = headless_result_event(&success_outcome, false, "session-1".to_string());
        assert_eq!(success["type"], "result");
        assert_eq!(success["subtype"], "success");
        assert_eq!(success["run_status"], "completed");
        assert_eq!(success["task_status"], "completed");
        assert_eq!(success["termination_reason"], "completed");
        assert_eq!(success["session_id"], "session-1");
        assert!(
            success["build_commit"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );
        assert!(success["build_dirty"].is_boolean());
        assert!(success["build_time_unix"].as_u64().is_some());
        assert_eq!(
            success["executable_sha256"].as_str().map(str::len),
            Some(64)
        );
        assert!(success.get("error").is_none());

        let mut failure_outcome = HeadlessOutcome::default();
        failure_outcome.observe_event(&EngineEvent::Error("boom".to_string()));
        let failure = headless_result_event(&failure_outcome, false, "session-2".to_string());
        assert_eq!(failure["subtype"], "error");
        assert_eq!(failure["run_status"], "failed");
        assert_eq!(failure["task_status"], "failed");
        assert_eq!(failure["termination_reason"], "engine_error");
        assert_eq!(failure["error"], "error: boom");

        let output_failure = headless_result_event(&success_outcome, true, "session-3".to_string());
        assert_eq!(output_failure["subtype"], "error");
        assert_eq!(output_failure["run_status"], "failed");
        assert_eq!(output_failure["task_status"], "failed");
        assert_eq!(
            output_failure["termination_reason"],
            "headless_output_error"
        );
        assert_eq!(output_failure["error"], "failed to write headless output");
    }

    #[test]
    fn headless_wait_observer_receives_each_event_before_collection() {
        let incoming = vec![
            EngineEvent::BackgroundJobProgress {
                id: "agent-1".to_string(),
                message: "working".to_string(),
                detail: Some("compiling kcoder_cli".to_string()),
                current: Some(1),
                total: Some(2),
            },
            EngineEvent::BackgroundJobCancelled {
                id: "agent-1".to_string(),
                reason: "parent failed".to_string(),
            },
        ];
        let mut collected = Vec::new();
        let mut observed = Vec::new();

        record_headless_wait_events(&mut collected, incoming, &mut |event| {
            observed.push(match event {
                EngineEvent::BackgroundJobProgress { id, .. }
                | EngineEvent::BackgroundJobCancelled { id, .. } => id.clone(),
                other => panic!("unexpected event: {other:?}"),
            });
        });

        assert_eq!(observed, ["agent-1", "agent-1"]);
        assert_eq!(collected.len(), 2);
        assert!(matches!(
            &collected[0],
            EngineEvent::BackgroundJobProgress { detail, .. }
                if detail.as_deref() == Some("compiling kcoder_cli")
        ));
    }
}

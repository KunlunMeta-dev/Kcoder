//! Turn execution, failure settlement, and background event formatting.

use super::*;

pub(super) fn format_moa_reference_message(
    label: &str,
    text: &str,
    index: usize,
    count: usize,
) -> String {
    let title = if count > 0 {
        format!("MoA reference {index}/{count} - {label}")
    } else {
        format!("MoA reference {index} - {label}")
    };
    let text = text.trim();
    if text.is_empty() {
        title
    } else {
        format!("{title}\n{text}")
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "Preserve the turn dispatch API and independent cancellation, completion and follow-up owners"
)]
pub(super) fn spawn_turn(
    engine: QueryEngine,
    text: Option<String>,
    tx: AppEventSender,
    prompt: TuiPermissionPrompt,
    turn_cancel: CancellationToken,
    steer_session: Option<TurnSteerSession>,
    path_preview_generation: u64,
    background_followup: Option<(Vec<kcoder_types::BackgroundRunKey>, String)>,
) -> JoinHandle<()> {
    // `text` is kept as an `Option<String>` for backward-compatibility with
    // existing call sites, but the REPL flow always passes `None`. User text
    // is appended to engine.state at the scheduling boundary, immediately
    // before this function is called, so queued input cannot split an
    // assistant tool_use from its tool_result.
    let _ = text;

    tokio::spawn(async move {
        let mut completion = TurnCompletionGuard::new(tx.clone());
        let goal_at_start = engine.state.goal().filter(|goal| goal.status.is_active());
        let goal_turn_started_at = Instant::now();
        let mut goal_turn_failure: Option<GoalTurnFailure> = None;
        let mut orchestrate_turn_failed = false;
        // Constructing the stream synchronously registers the current turn's steering mailbox.
        // Even if background notifications are refreshed before startup, later user input
        // cannot accidentally enter the next-turn queue.
        let mut stream = if let Some(steer_session) = steer_session {
            engine.run_turn_stream_with_cancel_and_steering(&prompt, turn_cancel, steer_session)
        } else {
            engine.run_turn_stream_with_cancel(&prompt, turn_cancel)
        };

        // Drain any subagent notifications that have piled up so far
        // before the follow-up turn starts streaming. This guarantees
        // the next API call sees the freshly-injected
        // `<subagent_notification .../>` user messages.
        for event in engine.flush_background_jobs_with_hooks().await {
            if let EngineEvent::HookMessage { text, is_error } = event {
                let _ = tx
                    .send_ordered(AppEvent::SystemNotice(if is_error {
                        format!("[hook error] {}", text)
                    } else {
                        text
                    }))
                    .await;
            }
        }

        let _ = tx.send_ordered(AppEvent::TurnStarted).await;
        while let Some(event) = stream.next().await {
            if matches!(
                event,
                EngineEvent::Error(_)
                    | EngineEvent::ProviderFailed { .. }
                    | EngineEvent::StreamAborted { .. }
                    | EngineEvent::MaxTurnsReached { .. }
            ) {
                orchestrate_turn_failed = true;
            }
            if let Some(failure) = goal_turn_failure_from_engine_event(&event) {
                goal_turn_failure = Some(failure);
            }
            append_repl_engine_event_diagnostic(&engine, &event);
            let Some(app_event) =
                engine_event_to_app_event_for_generation(event, path_preview_generation)
            else {
                continue;
            };

            if !tx.send_ordered(app_event).await {
                orchestrate_turn_failed = true;
                break;
            }
        }
        if !orchestrate_turn_failed
            && let Some((keys, turn_id)) = background_followup
            && !keys.is_empty()
        {
            let outcome = async {
                engine.state.flush_history().await?;
                engine.state.finish_background_followup(&keys, &turn_id)
            }
            .await;
            if let Err(error) = outcome {
                let _ = tx
                    .send_ordered(AppEvent::SystemNotice(format!(
                        "Background follow-up completion could not be persisted: {error:#}"
                    )))
                    .await;
            }
        }
        if let Err(error) = engine.record_orchestrate_continuation_outcome(orchestrate_turn_failed)
        {
            let _ = tx
                .send_ordered(AppEvent::SystemNotice(format!(
                    "Orchestrate continuation outcome could not be persisted: {error:#}"
                )))
                .await;
        }
        if let Some(start_goal) = goal_at_start.as_ref() {
            let elapsed_seconds = goal_turn_started_at.elapsed().as_secs();
            let still_active_same_goal = engine
                .state
                .goal()
                .map(|goal| goal.goal_id == start_goal.goal_id && goal.status.is_active())
                .unwrap_or(false);
            if still_active_same_goal
                && let Some(goal) = engine.state.account_active_goal_usage(0, elapsed_seconds)
                && goal.status.is_active()
                && goal.budget_exhausted()
                && let Some(goal) = engine.state.update_goal_status(GoalStatus::BudgetLimited)
            {
                let budget = goal.token_budget.unwrap_or(goal.tokens_used);
                let command = goal_command_for_goal(&goal);
                let name = goal_display_name(&goal);
                let _ = tx
                        .send_ordered(AppEvent::SystemNotice(format!(
                            "{name} token budget reached ({}/{} tokens). Use {command} clear before starting a new goal.",
                            goal.tokens_used, budget
                        )))
                        .await;
            }
        }
        if let (Some(start_goal), Some(failure)) = (goal_at_start.as_ref(), goal_turn_failure) {
            stop_active_goal_after_turn_failure(&engine, start_goal, failure, &tx).await;
        }
        // Ensure the loading indicator stops after the turn (including any
        // tool executions that followed the assistant message).
        completion.finish_ordered().await;
    })
}

#[derive(Debug, Clone)]
pub(super) struct GoalTurnFailure {
    pub(super) reason: String,
    pub(super) status: GoalStatus,
}

pub(super) fn goal_turn_failure_from_engine_event(event: &EngineEvent) -> Option<GoalTurnFailure> {
    match event {
        EngineEvent::ProviderFailed { message, details } => Some(GoalTurnFailure {
            reason: message.clone(),
            status: if details.category == kcoder_types::ProviderFailureCategory::QuotaExceeded {
                GoalStatus::UsageLimited
            } else {
                GoalStatus::Paused
            },
        }),
        EngineEvent::Error(reason) => Some(GoalTurnFailure {
            reason: reason.clone(),
            status: goal_failure_status(reason),
        }),
        EngineEvent::StreamAborted { reason } if reason != "cancelled by user" => {
            Some(GoalTurnFailure {
                reason: reason.clone(),
                status: goal_failure_status(reason),
            })
        }
        _ => None,
    }
}

pub(super) async fn stop_active_goal_after_turn_failure(
    engine: &QueryEngine,
    start_goal: &Goal,
    failure: GoalTurnFailure,
    tx: &AppEventSender,
) {
    let Some(current) = engine.state.goal() else {
        return;
    };
    if current.goal_id != start_goal.goal_id || current.status != GoalStatus::Active {
        return;
    }

    let status = failure.status;
    let Some(goal) = engine.state.update_goal_status(status) else {
        return;
    };
    let status_text = match status {
        GoalStatus::UsageLimited => "usage-limited",
        GoalStatus::Blocked => "blocked",
        _ => status.as_str(),
    };
    let _ = tx
        .send_ordered(AppEvent::SystemNotice(format!(
            "{} automatically marked {status_text} after a turn error to prevent automatic retry loops. Use {} resume after addressing the issue, or {} clear to discard it. Error: {}",
            goal_display_name(&goal),
            goal_command_for_goal(&goal),
            goal_command_for_goal(&goal),
            compact_failure_reason(&failure.reason, 240)
        )))
        .await;
    debug!(
        goal_id = %goal.goal_id,
        status = goal.status.as_str(),
        reason = %failure.reason,
        "stopped active goal after turn failure"
    );
}

pub(super) fn compact_failure_reason(reason: &str, max_width: usize) -> String {
    truncate_display_text(
        &reason.split_whitespace().collect::<Vec<_>>().join(" "),
        max_width,
    )
}

pub(super) fn goal_failure_status(reason: &str) -> GoalStatus {
    let lower = reason.to_lowercase();
    if lower.contains("usage limit")
        || lower.contains("usage_limit")
        || lower.contains("usage limits")
        || lower.contains("insufficient quota")
        || lower.contains("insufficient_quota")
        || lower.contains("quota exceeded")
        || lower.contains("credit balance")
        || lower.contains("insufficient credit")
        || lower.contains("insufficient_credit")
    {
        GoalStatus::UsageLimited
    } else {
        // The engine already performed in-turn provider retries. Pause the outer goal
        // here to prevent an infinite TUI continuation loop while allowing the user or
        // headless scheduler to resume after repairing the environment. Only update_goal's
        // three-turn audit may produce Blocked; never infer it from error text.
        GoalStatus::Paused
    }
}

/// Render a one-line summary of a background event for the synthetic
/// follow-up nudge the idle watcher injects into the main conversation.
pub(super) fn background_followup_key_is_live(engine: &QueryEngine, key: &str) -> bool {
    match serde_json::from_str::<kcoder_types::BackgroundRunKey>(key) {
        Ok(run) => {
            engine
                .state
                .task_for_background_run(&run)
                .is_some_and(|task| {
                    matches!(task.kind, kcoder_state::TaskKind::Subagent)
                        && task.notify_parent_on_completion
                })
                && engine
                    .state
                    .background_run_record(&run)
                    .is_some_and(|record| {
                        !record.suppressed && !record.followup_started && !record.followup_handled
                    })
        }
        Err(_) => engine.background_job_triggers_followup(key),
    }
}

pub(super) fn background_event_id(event: &EngineEvent) -> Option<&str> {
    match event.background_payload() {
        EngineEvent::BackgroundJobStarted { id, .. }
        | EngineEvent::BackgroundJobCompleted { id, .. }
        | EngineEvent::BackgroundJobFailed { id, .. }
        | EngineEvent::BackgroundJobPaused { id, .. }
        | EngineEvent::BackgroundJobHalted { id, .. }
        | EngineEvent::BackgroundJobCancelled { id, .. } => Some(id),
        _ => None,
    }
}

pub(super) fn format_background_event(event: &EngineEvent) -> String {
    match event.background_payload() {
        EngineEvent::BackgroundJobStarted { id, description } => {
            format!("[started: {id} — {description}]")
        }
        EngineEvent::BackgroundJobCompleted { id, .. } => {
            format!("[completed: {id}]")
        }
        EngineEvent::BackgroundJobFailed { id, error } => {
            format!("[failed: {id} — {error}]")
        }
        EngineEvent::BackgroundJobPaused { id, reason } => {
            format!("[paused: {id} — {reason}]")
        }
        EngineEvent::BackgroundJobHalted { id, reason } => {
            format!("[halted: {id} — {reason}]")
        }
        EngineEvent::BackgroundJobCancelled { id, reason } => {
            format!("[cancelled: {id} — {reason}]")
        }
        _ => "[other event]".to_string(),
    }
}

#[cfg(test)]
pub(super) fn format_goal_continuation_prompt(goal: &Goal) -> String {
    let decision = kcoder_engine::goal_continuation::plan_goal_continuation(true, goal, None)
        .unwrap_or(kcoder_engine::goal_continuation::GoalContinuationDecision {
            stall_nudge: false,
            premature_stop: None,
        });
    kcoder_engine::goal_continuation::format_goal_continuation_prompt(goal, &decision)
}

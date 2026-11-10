//! Drive the admitted foreground stream with its original borrowed state.
use anyhow::Result;
use futures::{Stream, future::BoxFuture};
use kcoder_app_events::background_delivery::clear_active_background_projection;
use kcoder_app_events::client_turn_counter::ClientTurnCounter;
use kcoder_app_events::notification_projection::{
    file_progress_notification, normalize_cancelled_terminal_event, with_event_context,
};
use kcoder_app_events::resident_turn::ResidentTurnState;
use kcoder_app_events::{BackgroundProjectionState, StreamProjection, foreground_events};
use kcoder_app_protocol::{Item, TurnExecutionMode};
use kcoder_engine::{EngineEvent, QueryEngine};
use kcoder_foreground_work::{ObservedFollowupWork, PendingFollowupWork, PendingInitialWork};
use kcoder_host_transport::protocol_io::{notification, send};
use kcoder_state::CommittedUserInput;
use kcoder_turn_evidence::live_file_progress::{self, LiveFileProgress};
use kcoder_turn_evidence::turn_file_capture::TurnFileCaptureTracker;
use kcoder_turn_evidence::turn_review_evidence::TurnReviewTracker;
use kcoder_turn_evidence::worktree_artifacts::TurnFileScope;
use kcoder_turn_lifecycle::{turn_admissions, turn_attempts::PartialOutput};
use kcoder_types::{ProviderFailureDetails, TurnAttemptIdentity};
use kcoder_workspace_resources::snapshots::GitTreeSnapshot;
use serde_json::{Value, json};
use std::{
    ops::ControlFlow,
    pin::Pin,
    sync::{Arc, atomic::AtomicU64},
    time::Duration,
};
use tokio::sync::{Mutex, Notify, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// References stay with the admitted task; the pump creates no owner or authority.
pub struct ForegroundStream<'a> {
    pub task_engine: &'a QueryEngine,
    pub task_tx: &'a mpsc::Sender<Value>,
    pub task_server_id: &'a str,
    pub task_thread_id: &'a str,
    pub task_turn_id: &'a str,
    pub task_sequence: &'a Arc<AtomicU64>,
    pub task_cancel: &'a CancellationToken,
    pub task_attempt_identity: &'a TurnAttemptIdentity,
    pub task_turn_state: &'a ResidentTurnState,
    pub task_background_projection: &'a Arc<Mutex<BackgroundProjectionState>>,
    pub task_projection: &'a Arc<Mutex<StreamProjection>>,
    pub followup_notify: &'a Notify,
    pub client_turn_count: &'a ClientTurnCounter,
    pub task_client_message_id: &'a Option<String>,
    pub turn_mode: TurnExecutionMode,
    pub continuing: bool,
    pub moa_plan_baseline: Option<usize>,
    pub stream: &'a mut Pin<Box<dyn Stream<Item = EngineEvent> + Send>>,
    pub pending_initial_work: &'a mut Option<PendingInitialWork>,
    pub pending_followup_work: &'a mut Option<PendingFollowupWork>,
    pub work_input_receiver: &'a mut Option<oneshot::Receiver<CommittedUserInput>>,
    pub pending_user_commit: &'a mut Option<Option<Item>>,
    pub counted_user_message: &'a mut bool,
    pub committed_work_input: &'a mut Option<CommittedUserInput>,
    pub observed_followup_work: &'a mut Option<ObservedFollowupWork>,
    pub snapshot_attempted: &'a mut bool,
    pub file_scope: &'a TurnFileScope<'a>,
    pub before_tree: &'a mut Option<GitTreeSnapshot>,
    pub file_capture: &'a mut Option<TurnFileCaptureTracker>,
    pub review: &'a mut TurnReviewTracker,
    pub status: &'a mut &'static str,
    pub terminal_error: &'a mut Option<String>,
    pub provider_failure: &'a mut Option<ProviderFailureDetails>,
    pub terminal_outcome_persisted: &'a mut bool,
    pub attempt_partial: &'a mut PartialOutput,
    pub live_files: &'a mut LiveFileProgress,
}

/// Erase the implementation future here so its polling code is compiled once.
pub fn pump(input: ForegroundStream<'_>) -> BoxFuture<'_, ControlFlow<()>> {
    Box::pin(async move {
        let ForegroundStream {
            task_engine,
            task_tx,
            task_server_id,
            task_thread_id,
            task_turn_id,
            task_sequence,
            task_cancel,
            task_attempt_identity,
            task_turn_state,
            task_background_projection,
            task_projection,
            followup_notify,
            client_turn_count,
            task_client_message_id,
            turn_mode,
            continuing,
            moa_plan_baseline,
            stream,
            pending_initial_work,
            pending_followup_work,
            work_input_receiver,
            pending_user_commit,
            counted_user_message,
            committed_work_input,
            observed_followup_work,
            snapshot_attempted,
            file_scope,
            before_tree,
            file_capture,
            review,
            status,
            terminal_error,
            provider_failure,
            terminal_outcome_persisted,
            attempt_partial,
            live_files,
        } = input;
        while let Some(update) = live_files.next(stream).await {
            let event = match update {
                live_file_progress::Update::Engine(event) => event,
                live_file_progress::Update::Files(counts) => {
                    let _async_answer_response_order =
                        Arc::clone(&task_turn_state.async_question_response_gate)
                            .lock_owned()
                            .await;
                    if send(
                        task_tx,
                        file_progress_notification(
                            task_server_id,
                            task_thread_id,
                            task_turn_id,
                            task_sequence,
                            None,
                            counts,
                        ),
                    )
                    .await
                    .is_err()
                    {
                        task_cancel.cancel();
                        break;
                    }
                    continue;
                }
                live_file_progress::Update::ToolFiles { id, counts } => {
                    let _async_answer_response_order =
                        Arc::clone(&task_turn_state.async_question_response_gate)
                            .lock_owned()
                            .await;
                    if send(
                        task_tx,
                        file_progress_notification(
                            task_server_id,
                            task_thread_id,
                            task_turn_id,
                            task_sequence,
                            Some(id.as_str()),
                            counts,
                        ),
                    )
                    .await
                    .is_err()
                    {
                        task_cancel.cancel();
                        break;
                    }
                    continue;
                }
            };
            let event = normalize_cancelled_terminal_event(event, task_cancel.is_cancelled());
            let _async_answer_response_order = foreground_events::publish_interaction_updates(
                task_engine,
                task_turn_state,
                task_tx,
                task_thread_id,
                task_turn_id,
                &event,
                task_cancel,
            )
            .await;
            review.observe(task_engine, &event);
            attempt_partial.observe(&event);
            if !*counted_user_message
                && explicit_turn_appended_user_message(task_engine, &event, moa_plan_baseline)
            {
                if let Err(error) = client_turn_count.increment() {
                    *status = "failed";
                    *terminal_error = Some(error.to_string());
                    break;
                }
                if !continuing
                    && let Err(error) =
                        turn_admissions::bind_user(task_engine, task_thread_id, task_turn_id)
                {
                    *status = "failed";
                    *terminal_error = Some(error.to_string());
                    break;
                }
                *counted_user_message = true;
                if !continuing {
                    // Snapshot the admitted item before later steering can append input.
                    let item = turn_admissions::user_item(
                        task_engine,
                        task_turn_id,
                        task_client_message_id.as_deref(),
                    );
                    if task_engine.state.flush_history().await.is_err() {
                        *pending_user_commit = Some(item);
                    } else if emit_committed_user(
                        task_tx,
                        task_server_id,
                        task_thread_id,
                        task_turn_id,
                        task_sequence,
                        item,
                    )
                    .await
                    .is_err()
                    {
                        task_cancel.cancel();
                        break;
                    }
                }
                *committed_work_input = work_input_receiver
                    .take()
                    .and_then(|mut receiver| receiver.try_recv().ok());
                if let Some(pending) = pending_followup_work.take() {
                    match committed_work_input.take() {
                        Some(input) if !pending.matches_original(&input) => {
                            tracing::warn!(
                                code = "CONTINUOUS_WORK_INPUT_UNTRACKED",
                                "A modified or non-durable input could not be associated with continuous work"
                            );
                        }
                        Some(input) => {
                            // An unconfirmed association must never fail the ordinary
                            // conversation. The input stays a pending work input when the
                            // store already accepted it, and this turn continues untracked.
                            let admitted = pending.observe_input(input, task_cancel).await;
                            match admitted {
                                Ok(Some(observed)) => *observed_followup_work = Some(observed),
                                Ok(None) => tracing::warn!(
                                    code = "CONTINUOUS_WORK_INPUT_UNTRACKED",
                                    "The original input could not be associated with continuous work"
                                ),
                                Err(code) => {
                                    tracing::warn!(code = %code, "The input could not be associated with continuous work in time; the turn continues untracked")
                                }
                            }
                        }
                        None => tracing::warn!(
                            code = "CONTINUOUS_WORK_INPUT_UNTRACKED",
                            "The committed input of this turn was not observed"
                        ),
                    }
                }
            }
            if matches!(&event, EngineEvent::AssistantMessageStarted)
                && let Some(work) = observed_followup_work.take()
            {
                if !work.matches_provider_request() {
                    tracing::warn!(
                        code = "CONTINUOUS_WORK_INPUT_NOT_IN_REQUEST",
                        "The actual provider request does not contain the accepted work input; it stays pending"
                    );
                } else {
                    // Recording the observation is a bookkeeping step. A failure or
                    // timeout leaves the input accepted and pending for a later turn,
                    // and must not terminate the reply the user is waiting for.
                    let recorded = work.observe_application(task_cancel).await;
                    if let Err(code) = recorded {
                        tracing::warn!(code = %code, "The applied work input could not be recorded; it stays pending for a later turn");
                    }
                }
            }
            if let (Some(pending), Some(_)) =
                (pending_initial_work.as_ref(), committed_work_input.as_ref())
                && let Some(goal) = pending.created_goal(&event)
            {
                let pending = pending_initial_work
                    .take()
                    .expect("pending work was observed");
                let input = committed_work_input
                    .take()
                    .expect("committed input was observed");
                let original_in_provider_request = kcoder_engine::continuous_work::input_handoff::current_provider_request_includes(&input);
                match pending.start(input, goal, original_in_provider_request) {
                    Some(receiver) => {
                        let _ = tokio::time::timeout(Duration::from_secs(1), receiver).await;
                    }
                    None => tracing::warn!(
                        code = "CONTINUOUS_WORK_ADMISSION_UNAVAILABLE",
                        "Continuous work admission could not start"
                    ),
                }
            }
            // ToolUseStarted yields the event stream before actual execution. Send the
            // state to the client, then establish a file baseline as needed before the next poll executes the tool.
            let should_snapshot = !*snapshot_attempted
                && matches!(
                    &event,
                    EngineEvent::ToolUseStarted { name, .. }
                        if live_file_progress::may_mutate_workspace(&task_engine.active_tool_registry(), name)
                );
            let executing_writer = match &event {
                EngineEvent::ToolExecutionStarted { id, name }
                    if live_file_progress::may_mutate_workspace(
                        &task_engine.active_tool_registry(),
                        name,
                    ) =>
                {
                    Some(id.clone())
                }
                _ => None,
            };
            // Deliver the last observation before item/completed clears the live tool.
            if let EngineEvent::ToolResult { id, .. } | EngineEvent::ToolDenied { id, .. } = &event
                && let Some(counts) = live_files.finish_tool(id).await
                && send(
                    task_tx,
                    file_progress_notification(
                        task_server_id,
                        task_thread_id,
                        task_turn_id,
                        task_sequence,
                        Some(id.as_str()),
                        counts,
                    ),
                )
                .await
                .is_err()
            {
                task_cancel.cancel();
                break;
            }
            if let Some(observed) =
                kcoder_turn_lifecycle::turn_artifacts::persist_foreground_terminal(
                    task_engine,
                    task_thread_id,
                    task_turn_id,
                    &event,
                    task_cancel.is_cancelled(),
                    turn_mode == kcoder_app_protocol::TurnExecutionMode::Standard,
                )
            {
                *status = observed.status;
                *terminal_error = Some(observed.error);
                *provider_failure = observed.provider_failure;
                *terminal_outcome_persisted |= observed.persisted;
            }
            if foreground_events::project(
                task_engine,
                task_background_projection,
                task_projection,
                task_tx,
                task_thread_id,
                task_turn_id,
                event,
                kcoder_foreground_work::automatic::record_terminal_background_result,
            )
            .await
            .is_err()
            {
                task_turn_state.clear_pending();
                task_turn_state.clear_matching_turn(task_thread_id, task_turn_id);
                task_turn_state.finish_turn_registration().await;
                followup_notify.notify_waiters();
                clear_active_background_projection(
                    task_background_projection,
                    task_thread_id,
                    task_turn_id,
                )
                .await;
                live_files.stop().await;
                return ControlFlow::Break(());
            }
            if let Some(id) = executing_writer {
                live_files.start_tool(&id).await;
            }
            if should_snapshot {
                *snapshot_attempted = true;
                let (snapshot, capture) = file_scope
                    .capture_baseline(task_engine, task_attempt_identity, live_files)
                    .await;
                *before_tree = snapshot;
                *file_capture = Some(capture);
            }
            if *status != "completed" {
                break;
            }
        }
        ControlFlow::Continue(())
    })
}

pub fn explicit_turn_appended_user_message(
    engine: &QueryEngine,
    event: &EngineEvent,
    moa_plan_baseline: Option<usize>,
) -> bool {
    if let Some(baseline) = moa_plan_baseline {
        // MoA planning appends directly and does not compact the parent conversation.
        // Its first progress/error/result event follows the append, if one occurred.
        return engine.client_turn_count() > baseline;
    }
    matches!(event, EngineEvent::UserMessageAdded)
        && engine
            .state
            .last_message()
            .as_ref()
            .is_some_and(kcoder_engine::agent::is_real_user_message)
}

#[allow(clippy::too_many_arguments)]
pub async fn emit_committed_user(
    tx: &mpsc::Sender<Value>,
    server: &str,
    thread: &str,
    turn: &str,
    sequence: &Arc<AtomicU64>,
    item: Option<Item>,
) -> Result<()> {
    if let Some(item) = item {
        send(
            tx,
            notification(
                "item/started",
                with_event_context(server, thread, Some(turn), sequence, json!({"item":item})),
            ),
        )
        .await?;
    }
    Ok(())
}

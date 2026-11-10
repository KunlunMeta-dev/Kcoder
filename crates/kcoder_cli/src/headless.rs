use crate::headless_outcome::HeadlessOutcome;
use anyhow::{Context, Result, bail};
use futures::StreamExt;
use kcoder_cli_support::{
    HeadlessPermissionPrompt, build_identity, engine_event_json, visible_system_notice,
};
use kcoder_engine::{BackgroundJobEvent, EngineEvent, QueryEngine};
use kcoder_state::continuous_work::{ContinuousWorkStore, HostWorkScope};
use kcoder_state::{GoalStatus, TaskKind, TaskStatus};
use kcoder_types::continuous_work::{WorkRecord, WorkScope};
use kcoder_types::{ContentBlock, Message};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::Path;
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
        event.background_payload(),
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
    build_identity::add_to_json(&mut event);
    event
}

/// Upper bound on how many session-bound records one turn boundary reads. A
/// session normally binds one work; the cap keeps an unexpected binding count
/// from multiplying whole-store reads.
const MAX_OBSERVED_WORKS: usize = 4;

/// Longest wait reference copied into a one-line observation.
const MAX_WAIT_REFERENCE_CHARS: usize = 96;

/// Longest session identity accepted as a work binding key.
const MAX_SESSION_ID_BYTES: usize = 256;

/// Plain owned projection of one stored work record for `--json` headless
/// output.
///
/// This mirrors the terminal UI projection in
/// `crates/kcoder_repl/src/work_observation.rs`; the CLI deliberately does not
/// depend on REPL rendering code, so keep both mappers in step when the stored
/// record changes. Every value here is a point-in-time observation: a stored
/// phase is not proof that business work finished, and `result_ready` is not
/// proof that its required deliveries happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HeadlessWorkObservation {
    pub(crate) work_id: String,
    /// Stored phase label (`running`, `waiting_user`, ...); never inferred.
    pub(crate) phase: String,
    pub(crate) revision: u64,
    pub(crate) requirements_revision: u64,
    /// Waiting condition rendered as `kind (reference)`, as the status line does.
    pub(crate) waiting: Option<String>,
    /// Accepted but not yet applied inputs at the observed revision.
    pub(crate) unconsumed_inputs: Option<u64>,
    /// Whether the stored result was produced at the observed revision. A stale
    /// result is not ready; a current one still proves no delivery.
    pub(crate) result_ready: Option<bool>,
}

impl HeadlessWorkObservation {
    fn from_record(record: &WorkRecord) -> Self {
        let revision = &record.revision;
        Self {
            work_id: record.identity.work_id.clone(),
            phase: record.phase.as_str().to_string(),
            revision: revision.revision,
            requirements_revision: revision.requirements_revision,
            waiting: record.waiting.as_ref().map(|wait| {
                format!(
                    "{} ({})",
                    wait.kind.as_str(),
                    capped(
                        &sanitized_control_chars(&wait.reference),
                        MAX_WAIT_REFERENCE_CHARS
                    )
                )
            }),
            unconsumed_inputs: Some(
                revision
                    .accepted_input_sequence
                    .saturating_sub(revision.applied_input_sequence),
            ),
            result_ready: Some(record.result.as_ref().is_some_and(|result| {
                let basis = &result.basis;
                basis.requirements_revision == revision.requirements_revision
                    && basis.control_epoch == revision.control_epoch
                    && basis.owner_epoch == revision.owner_epoch
                    && basis.applied_input_sequence == revision.applied_input_sequence
            })),
        }
    }
}

/// One bounded, read-only observation of the target store belonging to this
/// engine's profile, workspace and session.
///
/// `None` means no work is bound to this turn, either because no storage exists
/// or because the store could not be read. An unreadable store is reported on
/// the diagnostic channel instead of being projected as a guessed phase, so a
/// consumer never sees a fabricated `work_observation`.
fn observe_headless_work(engine: &QueryEngine) -> Option<HeadlessWorkObservation> {
    match read_headless_work(engine) {
        Ok(observed) => observed,
        Err(error) => {
            // JSON stdout stays protocol-only; diagnostics belong on stderr.
            tracing::warn!(
                error = %format!("{error:#}"),
                "continuous work observation unavailable; no work event emitted"
            );
            None
        }
    }
}

/// The store is only ever opened with `open_existing`, so a profile that never
/// ran durable work is never created, repaired or written while observing.
fn read_headless_work(engine: &QueryEngine) -> Result<Option<HeadlessWorkObservation>> {
    let workspace = engine.state.cwd();
    let settings = engine.settings_persistence_path();
    let Some(profile) = settings.as_deref().and_then(Path::parent) else {
        // Persistence is disabled for this engine, so there is no target store.
        return Ok(None);
    };
    if !profile.is_dir() {
        // Durable work lives inside an existing profile; never create one here.
        return Ok(None);
    }
    let Some(store) = ContinuousWorkStore::open_existing(profile)? else {
        return Ok(None);
    };
    // Records may only be attributed through host-resolved account, target and
    // workspace identities, never through a stored scope string.
    let host = HostWorkScope::capture(profile, &workspace, None)?;
    let observed = read_bound_work(&store, host.scope(), &engine.session_id())?;
    // Recheck the held objects and their names after filesystem I/O; a scope
    // that changed mid-read cannot be reported as the current one.
    host.verify()
        .context("continuous work scope changed during the headless read")?;
    if engine.state.cwd() != workspace
        || engine.settings_persistence_path().as_deref() != settings.as_deref()
    {
        bail!("continuous work scope changed during the headless read");
    }
    Ok(observed)
}

fn read_bound_work(
    store: &ContinuousWorkStore,
    scope: &WorkScope,
    session_id: &str,
) -> Result<Option<HeadlessWorkObservation>> {
    if session_id.is_empty()
        || session_id.len() > MAX_SESSION_ID_BYTES
        || session_id.trim() != session_id
        || session_id.chars().any(char::is_control)
    {
        // Without a usable session identity no record is bound to this turn.
        return Ok(None);
    }
    let identities = store.list_for_thread(scope, session_id)?;
    let mut best: Option<(u64, HeadlessWorkObservation)> = None;
    let mut failures = 0usize;
    for identity in identities.iter().take(MAX_OBSERVED_WORKS) {
        match store.read_work(scope, &identity.work_id) {
            Ok(Some(record)) => {
                // Only an explicit binding is considered; a missing timestamp is
                // unknown, not the Unix epoch.
                let updated_at = record
                    .presentation
                    .as_ref()
                    .and_then(|presentation| presentation.updated_at_ms)
                    .unwrap_or(0);
                if best
                    .as_ref()
                    .is_none_or(|(current, _)| updated_at > *current)
                {
                    best = Some((updated_at, HeadlessWorkObservation::from_record(&record)));
                }
            }
            Ok(None) => {}
            Err(_) => failures += 1,
        }
    }
    match best {
        Some((_, observation)) => Ok(Some(observation)),
        // An unreadable record must not be downgraded to "no work exists".
        None if failures > 0 => bail!("continuous work records are unreadable"),
        None => Ok(None),
    }
}

/// The session's current goal, if any. A terminal or paused goal is still the
/// goal this turn belongs to; its status is not re-derived here.
fn headless_goal_id(engine: &QueryEngine) -> Option<String> {
    engine.state.goal().map(|goal| goal.goal_id)
}

/// One JSONL line per headless turn that has a bound work.
fn headless_work_observation_event(
    observation: &HeadlessWorkObservation,
    goal_id: Option<&str>,
    attempt_id: Option<&str>,
) -> Value {
    let mut event = serde_json::json!({
        "type": "work_observation",
        "goal_id": goal_id,
        "work_id": &observation.work_id,
        "phase": &observation.phase,
        "revision": observation.revision,
        "requirements_revision": observation.requirements_revision,
        "waiting": &observation.waiting,
        "unconsumed_inputs": observation.unconsumed_inputs,
        "result_ready": observation.result_ready,
    });
    if let Some(attempt_id) = attempt_id {
        event["attempt_id"] = Value::String(attempt_id.to_string());
    }
    event
}

/// Read the bound work once at a turn boundary and project its event. `None`
/// keeps the existing output unchanged for consumers of work-free sessions.
fn observe_headless_work_event(engine: &QueryEngine) -> Option<(Value, HeadlessWorkObservation)> {
    let observation = observe_headless_work(engine)?;
    let goal_id = headless_goal_id(engine);
    // A headless turn has no accepted attempt identity unless the host bound one
    // for the current history append; the field is then simply absent.
    let attempt_id = engine
        .state
        .current_history_attempt_identity()
        .map(|identity| identity.attempt_id);
    let event =
        headless_work_observation_event(&observation, goal_id.as_deref(), attempt_id.as_deref());
    Some((event, observation))
}

/// Strip control characters from a stored wait reference. The TUI has a richer
/// sanitizer; this projection only needs a single printable line, which JSON
/// would otherwise carry as raw escape sequences in a machine field.
fn sanitized_control_chars(text: &str) -> String {
    text.chars()
        .map(|value| if value.is_control() { ' ' } else { value })
        .collect()
}

fn capped(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut capped = text
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    capped.push('…');
    capped
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
    if engine.cancel_token().is_cancelled() {
        return HeadlessGoalContinuation::Stop {
            notice: "Headless interruption stopped automatic continuation.".to_string(),
            reason: "cancelled by user",
        };
    }
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
    let _ = engine.state.record_goal_continuation_start(&goal.goal_id);
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
        .record_goal_continuation_start(&goal.goal_id)
        .unwrap_or(goal);
    engine.state.add_message(Message::runtime_text(
        kcoder_engine::goal_continuation::format_goal_continuation_prompt(&goal, &decision),
    ));
    HeadlessGoalContinuation::Continue
}

fn prepare_headless_orchestrate_continuation(
    engine: &QueryEngine,
    goal_continuation_count: usize,
) -> HeadlessGoalContinuation {
    if engine.cancel_token().is_cancelled() {
        return HeadlessGoalContinuation::Stop {
            notice: "Headless interruption stopped automatic continuation.".to_string(),
            reason: "cancelled by user",
        };
    }
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
            engine.state.add_message(Message::runtime_text(prompt));
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
            tokio::select! {
                _ = engine.cancel_token().cancelled_owned() => {}
                _ = tokio::time::sleep(std::time::Duration::from_secs(seconds)) => {}
            }
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
    match event.background_payload() {
        EngineEvent::BackgroundJobCompleted { id, .. }
        | EngineEvent::BackgroundJobFailed { id, .. }
        | EngineEvent::BackgroundJobCancelled { id, .. }
        | EngineEvent::BackgroundJobHalted { id, .. } => Some(id),
        _ => None,
    }
}

fn headless_background_event_summary(event: &EngineEvent) -> Option<String> {
    match event.background_payload() {
        EngineEvent::BackgroundJobCompleted { id, .. } => {
            Some(format!("background job `{id}` completed"))
        }
        EngineEvent::BackgroundJobFailed { id, error } => {
            Some(format!("background job `{id}` failed: {error}"))
        }
        EngineEvent::BackgroundJobHalted { id, reason } => {
            Some(format!("background job `{id}` halted: {reason}"))
        }
        EngineEvent::BackgroundJobCancelled { id, reason } => {
            Some(format!("background job `{id}` was cancelled: {reason}"))
        }
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
    if !engine.background_event_triggers_followup(event) {
        return;
    }
    if let Some(summary) = headless_background_event_summary(event) {
        let key = event
            .background_identity()
            .map(|identity| serde_json::to_string(&identity.run).expect("serializable run key"))
            .unwrap_or_else(|| id.to_string());
        pending.insert(key, summary);
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

        let wake = tokio::select! {
            biased;
            _ = engine.cancel_token().cancelled_owned() => {
                let event = EngineEvent::StreamAborted { reason: "cancelled by user".into() };
                observe(&event);
                events.push(event);
                return events;
            }
            wake = wake_rx.recv() => wake,
        };
        match wake {
            Ok(event) => {
                if matches!(event.payload(), BackgroundJobEvent::Progress { .. }) {
                    let event = EngineEvent::from(event);
                    observe(&event);
                    events.push(event);
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
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
fn background_followup_run_is_live(
    engine: &QueryEngine,
    run: &kcoder_types::BackgroundRunKey,
) -> bool {
    engine
        .state
        .task_for_background_run(run)
        .is_some_and(|task| {
            matches!(task.kind, TaskKind::Subagent) && task.notify_parent_on_completion
        })
        && engine
            .state
            .background_run_record(run)
            .is_some_and(|record| {
                !record.suppressed && !record.followup_started && !record.followup_handled
            })
}

fn retain_live_background_followups(
    engine: &QueryEngine,
    pending: &mut BTreeMap<String, String>,
) -> bool {
    pending.retain(
        |id, _| match serde_json::from_str::<kcoder_types::BackgroundRunKey>(id) {
            Ok(run) => background_followup_run_is_live(engine, &run),
            Err(_) => engine.background_job_triggers_followup(id),
        },
    );
    !pending.is_empty()
}

fn headless_background_followup_nudge(pending: &BTreeMap<String, String>) -> String {
    format!(
        "[system] All tracked background work has finished. Aggregate the results now using \
         the available `<subagent_notification .../>`, `<workflow_notification .../>` and \
         `<task_notification .../>` entries and output files. Events: {}. Continue the original \
         task, do not repeat work already delegated to background work, and do not give a final \
         conclusion until the relevant results have been inspected.",
        pending.values().cloned().collect::<Vec<_>>().join(" ")
    )
}

fn take_background_followup_batch(
    engine: &QueryEngine,
    pending: &mut BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let batch_for = |id: &str| {
        serde_json::from_str::<kcoder_types::BackgroundRunKey>(id)
            .ok()
            .and_then(|run| engine.state.background_run_record(&run))
            .and_then(|record| record.followup_turn_id)
    };
    let selected_batch = pending.keys().find_map(|id| batch_for(id));
    let selected: Vec<_> = pending
        .keys()
        .filter(|id| batch_for(id) == selected_batch)
        .cloned()
        .collect();
    selected
        .into_iter()
        .filter_map(|id| pending.remove(&id).map(|summary| (id, summary)))
        .collect()
}

async fn prepare_background_followup(
    engine: &QueryEngine,
    ids: impl IntoIterator<Item = String>,
    nudge: String,
) -> Result<Option<(Vec<kcoder_types::BackgroundRunKey>, String)>> {
    let keys: Vec<kcoder_types::BackgroundRunKey> = ids
        .into_iter()
        .filter_map(|id| serde_json::from_str(&id).ok())
        .collect();
    if keys.is_empty() {
        engine.state.add_message(Message::runtime_text(nudge));
        return Ok(Some((keys, String::new())));
    }
    let records: Vec<_> = keys
        .iter()
        .filter_map(|key| engine.state.background_run_record(key))
        .collect();
    if records
        .iter()
        .any(|record| record.followup_started || record.followup_handled)
    {
        tracing::warn!("background follow-up was already started; automatic replay suppressed");
        return Ok(None);
    }
    let turn_id = records
        .iter()
        .find_map(|record| record.followup_turn_id.clone())
        .unwrap_or_else(|| format!("{}:followup", keys[0].run_id));
    if !engine.state.reserve_background_followup(&keys, &turn_id)? {
        return Ok(None);
    }
    engine
        .state
        .commit_message_with_uuid(Message::runtime_text(nudge), &turn_id)
        .await?;
    if !engine
        .state
        .mark_background_followup_started(&keys, &turn_id)?
    {
        return Ok(None);
    }
    Ok(Some((keys, turn_id)))
}

fn cancel_headless_for_user(engine: &QueryEngine) {
    engine.cancel();
    // Match explicit TUI interruption. The atomic active-only update preserves
    // a verdict committed concurrently and keeps objective/progress for resume.
    engine.state.update_active_goal_status(GoalStatus::Paused);
}

pub async fn run(
    engine: &QueryEngine,
    prompt: String,
    prompt_cb: &HeadlessPermissionPrompt,
    json: bool,
    events: Vec<EngineEvent>,
) -> Result<()> {
    let completion = crate::headless_interrupt::run_until_interrupt(
        run_inner(engine, prompt, prompt_cb, json, events),
        tokio::signal::ctrl_c(),
        || {
            cancel_headless_for_user(engine);
            async {
                // These are this Engine's managed handles. Never discover or
                // terminate processes by PID/name outside its ownership registry.
                let ids: Vec<_> = engine
                    .state
                    .tasks()
                    .into_values()
                    .filter(|task| {
                        task.managed
                            && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
                    })
                    .map(|task| task.id)
                    .collect();
                futures::future::join_all(
                    ids.iter()
                        .map(|id| engine.abort_background_job_and_wait(id)),
                )
                .await;
            }
        },
        Duration::from_secs(10),
    )
    .await?;
    let mut outcome = match completion.result {
        Some(Ok(outcome)) => outcome,
        Some(Err(error)) => {
            let mut outcome = HeadlessOutcome::default();
            outcome.observe_event(&EngineEvent::Error(format!(
                "headless driver failed: {error:#}"
            )));
            outcome
        }
        None => HeadlessOutcome::default(),
    };
    if completion.interrupted {
        outcome.observe_event(&EngineEvent::StreamAborted {
            reason: "cancelled by user".into(),
        });
        if !completion.cleanup_complete {
            outcome.observe_event(&EngineEvent::Error(
                "headless interruption cleanup timed out".into(),
            ));
        }
    }
    // Flush the existing message boundary after the interrupted driver has
    // recorded tool results. This is one shutdown barrier, not per-token I/O.
    let flushed = tokio::time::timeout(Duration::from_secs(3), engine.state.flush_history()).await;
    let history_flushed = matches!(&flushed, Ok(Ok(())));
    if !history_flushed {
        let error = match flushed {
            Ok(Err(error)) => format!("failed to flush headless history: {error:#}"),
            Err(_) => "headless history flush timed out".into(),
            Ok(Ok(())) => unreachable!(),
        };
        outcome.observe_event(&EngineEvent::Error(error));
    }
    if completion.interrupted {
        // The driver can finish before the owned-job drain. Project remaining
        // work only after that cleanup, preserving the cancelled/failed verdict.
        outcome.finalize(engine);
        // An interrupted driver discards its own outcome, so re-observe the
        // bound work once here to keep work identity in the terminal result.
        if let Some(observation) = observe_headless_work(engine) {
            outcome.record_work_observation(observation);
        }
    }
    if json {
        let mut event = headless_result_event(&outcome, false, engine.session_id());
        if completion.interrupted {
            event["interrupt_cleanup"] = serde_json::json!({
                "status": if completion.cleanup_complete { "completed" } else { "timed_out" },
                "history_flushed": history_flushed,
            });
        }
        write_json_line(&mut io::stdout().lock(), &event)
            .context("failed to write JSON headless result")?;
    } else if completion.interrupted {
        eprintln!(
            "Headless interruption cleanup: {}; history flushed: {history_flushed}",
            if completion.cleanup_complete {
                "completed"
            } else {
                "timed out"
            }
        );
    }
    if !outcome.is_success() {
        bail!("headless task failed: {}", outcome.error_message());
    }
    Ok(())
}

async fn run_inner(
    engine: &QueryEngine,
    prompt: String,
    prompt_cb: &HeadlessPermissionPrompt,
    json: bool,
    mut events: Vec<EngineEvent>,
) -> Result<HeadlessOutcome> {
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
        let mut active_background_followup: Option<(Vec<kcoder_types::BackgroundRunKey>, String)> =
            None;
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
            // One read-only work observation per turn boundary, never per event.
            // The observation also feeds the terminal result, so the outcome and
            // the correlation line always describe the same work.
            if let Some((event, observation)) = observe_headless_work_event(engine) {
                outcome.record_work_observation(observation);
                if output_error.is_none()
                    && let Err(error) = write_json_line(&mut stdout, &event)
                {
                    engine.cancel();
                    output_error = Some(error);
                }
            }
            if !orchestrate_turn_failed
                && output_error.is_none()
                && let Some((keys, turn_id)) = active_background_followup.take()
                && !keys.is_empty()
            {
                engine.state.flush_history().await?;
                engine.state.finish_background_followup(&keys, &turn_id)?;
            }
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
            let selected =
                take_background_followup_batch(engine, &mut pending_background_followups);
            let nudge = headless_background_followup_nudge(&selected);
            active_background_followup =
                prepare_background_followup(engine, selected.keys().cloned(), nudge).await?;
            if active_background_followup.is_none() {
                break;
            }
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
        drop(stdout);
        if let Some(error) = output_error {
            return Err(error).context("failed to write JSON headless output");
        }
        return Ok(outcome);
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
        let selected = take_background_followup_batch(engine, &mut pending_background_followups);
        let nudge = headless_background_followup_nudge(&selected);
        let batch = prepare_background_followup(engine, selected.keys().cloned(), nudge).await?;
        let Some((keys, turn_id)) = batch else {
            break;
        };
        let followup_events = engine.run_turn_stream(prompt_cb).collect::<Vec<_>>().await;
        if !keys.is_empty()
            && !followup_events
                .iter()
                .any(|event| headless_failure(event).is_some())
        {
            engine.state.flush_history().await?;
            engine.state.finish_background_followup(&keys, &turn_id)?;
        }
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
        let event = event.background_payload().clone();
        match event {
            EngineEvent::BackgroundScoped { .. } => {
                unreachable!("background_payload unwraps scoped events")
            }
            EngineEvent::UserMessageAdded => {}
            EngineEvent::SubagentUserMessageAdded { .. } => {}
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
            EngineEvent::AssistantStopReason { .. } => {}
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
            EngineEvent::ToolInputReset
            | EngineEvent::ToolInputProgress { .. }
            | EngineEvent::ToolExecutionStarted { .. } => {
                // Progress is rendered by the TUI; keep plain headless output concise.
            }
            EngineEvent::WidgetInputPreview { .. }
            | EngineEvent::ToolInputPreview { .. }
            | EngineEvent::ToolPathPreview { .. } => {
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
                println!("\n[{}]", visible_system_notice(&text));
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

    Ok(outcome)
}

#[cfg(test)]
mod tests {
    #[test]
    fn imported_context_notice_carries_a_locale_key_and_readable_legacy_fallback() {
        let event = super::engine_event_json(kcoder_engine::EngineEvent::SystemNotice(
            "kcoder.notice.imported_context_legacy_unobserved".into(),
        ));
        assert_eq!(
            event["code"],
            "kcoder.notice.imported_context_legacy_unobserved"
        );
        assert!(
            event["text"]
                .as_str()
                .unwrap()
                .contains("Current profile notes were not applied")
        );
        assert_eq!(
            super::visible_system_notice("ordinary notice"),
            "ordinary notice"
        );
    }
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn headless_interrupt_pauses_only_active_goal_and_preserves_progress() {
        let workspace = tempfile::tempdir().unwrap();
        let engine = goal_policy_test_engine(workspace.path());
        let goal = engine
            .state
            .set_goal("Keep the actual goal objective", Some(1000));
        engine.state.record_goal_turn_start(&goal.goal_id);
        engine
            .state
            .record_goal_progress_fingerprint("completed-stage-1");
        engine.state.account_active_goal_usage(123, 2);
        let before = engine.state.goal().unwrap();
        cancel_headless_for_user(&engine);
        let paused = engine.state.goal().unwrap();
        assert_eq!(paused.status, GoalStatus::Paused);
        assert_eq!(paused.goal_id, before.goal_id);
        assert_eq!(paused.objective, before.objective);
        assert_eq!(paused.token_budget, before.token_budget);
        assert_eq!(paused.tokens_used, before.tokens_used);
        assert_eq!(paused.turn_count, before.turn_count);
        assert_eq!(
            paused.last_progress_fingerprint,
            before.last_progress_fingerprint
        );
        let resumed = engine
            .clone()
            .with_cancel_token(tokio_util::sync::CancellationToken::new());
        assert!(matches!(
            prepare_headless_goal_continuation(&resumed, 0, Instant::now()),
            HeadlessGoalContinuation::None
        ));

        for status in [
            GoalStatus::Complete,
            GoalStatus::Blocked,
            GoalStatus::Paused,
        ] {
            engine.state.update_goal_status(status);
            let before = engine.state.goal();
            cancel_headless_for_user(&engine);
            assert_eq!(
                engine.state.goal(),
                before,
                "terminal or paused goal must not be rewritten"
            );
        }
    }

    #[tokio::test]
    async fn normal_headless_completion_does_not_pause_goal() {
        let workspace = tempfile::tempdir().unwrap();
        let engine = goal_policy_test_engine(workspace.path());
        engine
            .state
            .set_goal("Keep active on normal completion", None);
        let before = engine.state.goal();
        crate::headless_interrupt::run_until_interrupt(
            async {},
            std::future::pending::<std::io::Result<()>>(),
            || {
                cancel_headless_for_user(&engine);
                std::future::ready(())
            },
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(engine.state.goal(), before);
        assert!(!engine.cancel_token().is_cancelled());
    }

    #[tokio::test]
    async fn user_interrupt_stops_background_wait_and_automatic_continuation() {
        let workspace = tempfile::tempdir().unwrap();
        let engine = goal_policy_test_engine(workspace.path());
        let mut task = kcoder_state::Task::new("waiting-agent", "owned pending subagent");
        task.kind = TaskKind::Subagent;
        task.notify_parent_on_completion = true;
        task.status = TaskStatus::Running;
        engine.state.upsert_task(task);
        engine.cancel();
        let events = tokio::time::timeout(
            Duration::from_secs(1),
            wait_for_headless_subagents(&engine, |_| {}),
        )
        .await
        .expect("cancelled wait must wake");
        assert!(
            events
                .iter()
                .any(|event| headless_failure(event).as_deref() == Some("cancelled by user"))
        );
        assert!(matches!(
            prepare_headless_goal_continuation(&engine, 0, Instant::now()),
            HeadlessGoalContinuation::Stop {
                reason: "cancelled by user",
                ..
            }
        ));
        assert!(matches!(
            prepare_headless_orchestrate_continuation(&engine, 0),
            HeadlessGoalContinuation::Stop {
                reason: "cancelled by user",
                ..
            }
        ));
    }

    fn goal_policy_test_engine(cwd: &std::path::Path) -> QueryEngine {
        let settings = kcoder_config::Settings::default();
        QueryEngine::new_with_folder_trust(
            Arc::new(kcoder_cli_support::tui_dev_mock::MockScenarioProvider::new(
                kcoder_cli_support::tui_dev_mock::TuiDevScenario::FullTurn,
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

    #[tokio::test]
    async fn headless_background_reservation_does_not_restart_started_run() {
        let workspace = tempfile::tempdir().unwrap();
        let engine = goal_policy_test_engine(workspace.path());
        let mut task = kcoder_state::Task::new("job", "subagent");
        task.kind = kcoder_state::TaskKind::Subagent;
        engine.state.upsert_task(task);
        let run = engine.state.begin_background_run("job").unwrap();
        engine
            .state
            .commit_background_terminal(
                &kcoder_types::BackgroundEventIdentity::terminal(run.clone()),
                TaskStatus::Completed,
                None,
            )
            .unwrap();
        engine
            .state
            .deliver_background_notification(
                &kcoder_types::BackgroundEventIdentity::terminal(run.clone()),
                Message::user_text("completed notification"),
            )
            .await
            .unwrap();
        let key = serde_json::to_string(&run).unwrap();
        let batch = prepare_background_followup(&engine, [key.clone()], "aggregate".into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(batch.0, vec![run.clone()]);
        assert!(
            engine
                .state
                .background_run_record(&run)
                .unwrap()
                .followup_started
        );
        assert!(
            prepare_background_followup(&engine, [key.clone()], "aggregate".into())
                .await
                .unwrap()
                .is_none()
        );
        let mut pending = BTreeMap::from([(key, "done".into())]);
        assert!(!retain_live_background_followups(&engine, &mut pending));
        assert_eq!(engine.state.messages().len(), 2);
    }

    #[tokio::test]
    async fn followup_batches_preserve_other_reservations_and_new_arrivals() {
        let workspace = tempfile::tempdir().unwrap();
        let engine = goal_policy_test_engine(workspace.path());
        let mut pending = BTreeMap::new();
        let mut runs = Vec::new();
        for id in ["a", "b", "fresh"] {
            let mut task = kcoder_state::Task::new(id, "subagent");
            task.kind = kcoder_state::TaskKind::Subagent;
            engine.state.upsert_task(task);
            let run = engine.state.begin_background_run(id).unwrap();
            let event = kcoder_types::BackgroundEventIdentity::terminal(run.clone());
            engine
                .state
                .commit_background_terminal(&event, TaskStatus::Completed, None)
                .unwrap();
            engine
                .state
                .deliver_background_notification(&event, Message::user_text(id))
                .await
                .unwrap();
            pending.insert(serde_json::to_string(&run).unwrap(), id.to_string());
            runs.push(run);
        }
        engine
            .state
            .reserve_background_followup(&runs[0..1], "batch-a")
            .unwrap();
        engine
            .state
            .reserve_background_followup(&runs[1..2], "batch-b")
            .unwrap();
        let first = take_background_followup_batch(&engine, &mut pending);
        assert_eq!(first.values().cloned().collect::<Vec<_>>(), vec!["a"]);
        assert_eq!(pending.len(), 2);
        let second = take_background_followup_batch(&engine, &mut pending);
        assert_eq!(second.values().cloned().collect::<Vec<_>>(), vec!["b"]);
        assert_eq!(pending.values().cloned().collect::<Vec<_>>(), vec!["fresh"]);
        let third = take_background_followup_batch(&engine, &mut pending);
        assert_eq!(third.len(), 1);
        assert!(pending.is_empty());
    }

    #[test]
    fn scoped_background_json_preserves_run_identity() {
        let run = kcoder_types::BackgroundRunKey {
            parent_session_id: "parent".into(),
            agent_id: "job".into(),
            run_id: "run".into(),
        };
        let event = EngineEvent::BackgroundScoped {
            identity: kcoder_types::BackgroundEventIdentity::terminal(run),
            event: Box::new(EngineEvent::BackgroundJobCancelled {
                id: "job".into(),
                reason: "cancelled".into(),
            }),
        };
        assert_eq!(headless_background_event_id(&event), Some("job"));
        let value = engine_event_json(event);
        assert_eq!(value["backgroundIdentity"]["run"]["runId"], "run");
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
    fn json_event_distinguishes_tool_execution_from_queued_input() {
        assert_eq!(
            engine_event_json(EngineEvent::ToolExecutionStarted {
                id: "writer-1".into(),
                name: "write".into(),
            }),
            serde_json::json!({"type":"tool_execution_started","id":"writer-1","name":"write"})
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
            lines: None,
        });
        assert_eq!(event["type"], "tool_input_progress");
        assert_eq!(event["id"], "tool-1");
        assert_eq!(event["name"], "bash");
        assert_eq!(event["chars"], 42);
    }

    #[test]
    fn json_event_exposes_only_line_counts_for_file_argument_generation() {
        let event = engine_event_json(EngineEvent::ToolInputProgress {
            id: "edit-1".into(),
            name: "edit".into(),
            chars: 1024,
            lines: Some(kcoder_types::tool_ui::ToolInputLineProgress {
                generated_lines: 30,
                replaced_lines: Some(20),
            }),
        });
        assert_eq!(
            event["lines"],
            serde_json::json!({"generatedLines":30,"replacedLines":20})
        );
        assert!(event.get("input").is_none());
        assert!(event.get("content").is_none());
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

    /// Private per-test profile and workspace so the captured work scope belongs
    /// to this test only. The user's real profile is never opened.
    struct WorkFixture {
        _root: tempfile::TempDir,
        profile: std::path::PathBuf,
        workspace: std::path::PathBuf,
        engine: QueryEngine,
    }

    fn owned_directory(root: &Path, name: &str) -> std::path::PathBuf {
        let path = root.join(name);
        std::fs::create_dir_all(&path).unwrap();
        kcoder_config::set_user_only_dir_permissions(&path).unwrap();
        path
    }

    fn work_input_source() -> kcoder_state::continuous_work::WorkInputSource {
        kcoder_state::continuous_work::WorkInputSource {
            kind: "foreground".into(),
            instance_id: "test-instance".into(),
            conversation_id: "test-conversation".into(),
        }
    }

    fn stored_work_record(scope: &WorkScope, work_id: &str, thread_id: &str) -> WorkRecord {
        let attempt = kcoder_types::TurnAttemptIdentity {
            thread_id: thread_id.into(),
            turn_id: format!("turn-{work_id}"),
            attempt_id: format!("attempt-{work_id}"),
        };
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "identity": {"scope": scope, "workId": work_id},
            "origin": {"kind": "foreground", "initialAttempt": attempt},
            "linkedThreadIds": [thread_id],
            "phase": "pending",
            "revision": {
                "revision": 1,
                "requirementsRevision": 1,
                "controlEpoch": 0,
                "ownerEpoch": 0,
                "acceptedInputSequence": 1,
                "requiredInputSequence": 1,
                "appliedInputSequence": 0,
            },
        }))
        .expect("valid work record")
    }

    /// A waiting record whose result was produced at its own revision, used to
    /// exercise the projection without touching storage.
    fn waiting_work_record(scope: &WorkScope, wait_reference: &str) -> WorkRecord {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "identity": {"scope": scope, "workId": "work-waiting"},
            "origin": {
                "kind": "foreground",
                "initialAttempt": {"threadId": "thread-1", "turnId": "turn-1", "attemptId": "attempt-1"},
            },
            "linkedThreadIds": ["thread-1"],
            "phase": "waiting_user",
            "revision": {
                "revision": 3,
                "requirementsRevision": 2,
                "controlEpoch": 1,
                "ownerEpoch": 1,
                "acceptedInputSequence": 2,
                "requiredInputSequence": 2,
                "appliedInputSequence": 2,
            },
            "waiting": {"kind": "user", "reference": wait_reference},
            "result": {
                "resultId": "result-1",
                "basis": {
                    "requirementsRevision": 2,
                    "controlEpoch": 1,
                    "ownerEpoch": 1,
                    "appliedInputSequence": 2,
                },
                "artifactRefs": ["artifact-1"],
                "evidenceRefs": [],
                "requiredDeliveryIds": [],
            },
        }))
        .expect("valid waiting record")
    }

    impl WorkFixture {
        fn new() -> Self {
            let root = tempfile::Builder::new()
                .prefix("kcoder-headless-work-")
                .tempdir()
                .unwrap();
            let base = root.path().canonicalize().unwrap();
            let profile = owned_directory(&base, "config");
            let workspace = owned_directory(&base, "work");
            let engine = goal_policy_test_engine(&workspace)
                .with_settings_persistence_path(profile.join("settings.json"));
            Self {
                _root: root,
                profile,
                workspace,
                engine,
            }
        }

        fn scope(&self) -> WorkScope {
            HostWorkScope::capture(&self.profile, &self.workspace, None)
                .expect("private test scope")
                .scope()
                .clone()
        }

        fn admit(&self, work_id: &str) {
            let scope = self.scope();
            let store = ContinuousWorkStore::open_or_create(&self.profile).expect("own test store");
            store
                .admit(
                    &scope,
                    stored_work_record(&scope, work_id, &self.engine.session_id()),
                    &work_input_source(),
                    &format!("request-{work_id}"),
                    serde_json::json!({"text": work_id}),
                    Vec::new(),
                )
                .expect("own test admission");
        }

        fn state_path(&self) -> std::path::PathBuf {
            self.profile.join("continuous-work.v1/state.json")
        }
    }

    #[test]
    fn work_observation_event_is_emitted_for_a_bound_work() {
        let fixture = WorkFixture::new();
        fixture.admit("work-1");

        let (event, observation) =
            observe_headless_work_event(&fixture.engine).expect("bound work is observed");
        assert_eq!(observation.work_id, "work-1");
        assert_eq!(event["type"], "work_observation");
        assert_eq!(event["work_id"], "work-1");
        assert_eq!(event["phase"], "pending");
        assert_eq!(event["revision"], 1);
        assert_eq!(event["requirements_revision"], 1);
        assert!(event["waiting"].is_null());
        // `admit` records one accepted input that was never applied.
        assert_eq!(event["unconsumed_inputs"], 1);
        assert_eq!(event["result_ready"], false);
        // No goal and no accepted attempt identity for this turn.
        assert!(event["goal_id"].is_null());
        assert!(event.get("attempt_id").is_none());
    }

    #[test]
    fn work_observation_projects_the_stored_wait_and_result_state() {
        let fixture = WorkFixture::new();
        let scope = fixture.scope();

        let observation =
            HeadlessWorkObservation::from_record(&waiting_work_record(&scope, "message-1"));
        assert_eq!(observation.work_id, "work-waiting");
        assert_eq!(observation.phase, "waiting_user");
        assert_eq!(observation.revision, 3);
        assert_eq!(observation.requirements_revision, 2);
        assert_eq!(observation.waiting.as_deref(), Some("user (message-1)"));
        assert_eq!(observation.unconsumed_inputs, Some(0));
        assert_eq!(observation.result_ready, Some(true));

        // A control character never reaches the machine-readable field.
        let control =
            HeadlessWorkObservation::from_record(&waiting_work_record(&scope, "message\none"));
        assert_eq!(control.waiting.as_deref(), Some("user (message one)"));

        // A result produced at an older revision is not ready for this one.
        let mut stale = waiting_work_record(&scope, "message-1");
        stale.revision.applied_input_sequence += 1;
        assert_eq!(
            HeadlessWorkObservation::from_record(&stale).result_ready,
            Some(false)
        );
        let mut without_result = waiting_work_record(&scope, "message-1");
        without_result.result = None;
        assert_eq!(
            HeadlessWorkObservation::from_record(&without_result).result_ready,
            Some(false)
        );
    }

    #[test]
    fn work_observation_is_absent_without_a_store() {
        let fixture = WorkFixture::new();

        assert!(observe_headless_work_event(&fixture.engine).is_none());
        assert!(
            matches!(
                ContinuousWorkStore::open_existing(&fixture.profile),
                Ok(None)
            ),
            "observation must not create work storage"
        );
    }

    #[test]
    fn work_observation_is_silent_for_an_unreadable_store() {
        let fixture = WorkFixture::new();
        fixture.admit("work-1");
        // A store another process left unparsable must stay untouched.
        std::fs::write(fixture.state_path(), b"{ not json").expect("corrupt own store");

        assert!(
            observe_headless_work_event(&fixture.engine).is_none(),
            "an unreadable store must not be projected as a guessed phase"
        );
        assert_eq!(
            std::fs::read(fixture.state_path()).expect("read own store"),
            b"{ not json"
        );
    }

    #[test]
    fn headless_result_carries_work_identity_and_keeps_previous_fields() {
        let fixture = WorkFixture::new();
        fixture.admit("work-1");
        let (_, observation) =
            observe_headless_work_event(&fixture.engine).expect("bound work is observed");

        let mut baseline = HeadlessOutcome::default();
        baseline.finalize(&fixture.engine);
        let baseline = baseline.to_json("session-work".into());

        let mut outcome = HeadlessOutcome::default();
        outcome.finalize(&fixture.engine);
        outcome.record_work_observation(observation);
        let event = outcome.to_json("session-work".into());

        assert_eq!(event["work_id"], "work-1");
        assert_eq!(event["work_phase"], "pending");
        assert!(event["waiting"].is_null());
        assert!(event["goal_id"].is_null());
        for field in [
            "type",
            "subtype",
            "run_status",
            "task_status",
            "termination_reason",
            "session_id",
            "timed_out",
            "retryable",
            "resume_safe",
            "nudge_sent",
            "deliverable_written",
            "provider_retry_count",
            "work_remaining",
        ] {
            assert_eq!(
                event[field], baseline[field],
                "{field} must keep its meaning"
            );
        }
    }

    /// Emit one record through the production writer and return the raw line
    /// with its parsed form. The contract under test is the emitted byte stream,
    /// not a `Value` the test assembled itself.
    fn emitted_json_line(value: &Value) -> (String, Value) {
        let mut bytes = Vec::new();
        write_json_line(&mut bytes, value).expect("write one JSONL record");
        let text = String::from_utf8(bytes).expect("JSONL output is UTF-8");
        assert!(text.ends_with('\n'), "a record ends with a newline");
        assert_eq!(
            text.matches('\n').count(),
            1,
            "a record is exactly one line"
        );
        let parsed: Value = serde_json::from_str(&text).expect("the emitted line parses");
        assert_eq!(
            text,
            format!(
                "{}\n",
                serde_json::to_string(&parsed).expect("re-serialize the parsed line")
            ),
            "the emitted bytes are the compact one-line serialization"
        );
        (text, parsed)
    }

    fn sorted_keys(value: &Value) -> Vec<String> {
        let mut keys = value
            .as_object()
            .expect("a headless event is a JSON object")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        keys
    }

    #[test]
    fn work_observation_line_bytes_match_the_documented_contract() {
        let fixture = WorkFixture::new();
        fixture.admit("work-1");
        let (event, observation) =
            observe_headless_work_event(&fixture.engine).expect("bound work is observed");

        let (text, parsed) = emitted_json_line(&event);
        assert_eq!(
            sorted_keys(&parsed),
            [
                "goal_id",
                "phase",
                "requirements_revision",
                "result_ready",
                "revision",
                "type",
                "unconsumed_inputs",
                "waiting",
                "work_id",
            ]
            .map(str::to_string),
            "the line carries exactly the documented keys"
        );
        assert_eq!(parsed["type"], "work_observation");
        assert_eq!(parsed["work_id"], observation.work_id);
        assert_eq!(parsed["work_id"], "work-1");
        assert_eq!(parsed["phase"], "pending");
        assert_eq!(parsed["revision"], 1);
        assert_eq!(parsed["requirements_revision"], 1);
        // `admit` recorded one accepted input that was never applied.
        assert_eq!(parsed["unconsumed_inputs"], 1);
        assert_eq!(parsed["result_ready"], false);
        assert!(parsed["waiting"].is_null());
        assert!(parsed["goal_id"].is_null());
        // `attempt_id` is optional in the contract: absent, not a null field.
        assert!(!text.contains("attempt_id"));
    }

    #[test]
    fn work_observation_line_adds_only_the_bound_attempt_key() {
        let fixture = WorkFixture::new();
        let scope = fixture.scope();
        let observation =
            HeadlessWorkObservation::from_record(&waiting_work_record(&scope, "message-1"));
        let event =
            headless_work_observation_event(&observation, Some("goal-1"), Some("attempt-1"));

        let (_, parsed) = emitted_json_line(&event);
        assert_eq!(
            sorted_keys(&parsed),
            [
                "attempt_id",
                "goal_id",
                "phase",
                "requirements_revision",
                "result_ready",
                "revision",
                "type",
                "unconsumed_inputs",
                "waiting",
                "work_id",
            ]
            .map(str::to_string),
            "a bound attempt adds its own key and nothing else"
        );
        assert_eq!(parsed["type"], "work_observation");
        assert_eq!(parsed["attempt_id"], "attempt-1");
        assert_eq!(parsed["goal_id"], "goal-1");
        assert_eq!(parsed["work_id"], "work-waiting");
        assert_eq!(parsed["phase"], "waiting_user");
        assert_eq!(parsed["revision"], 3);
        assert_eq!(parsed["requirements_revision"], 2);
        assert_eq!(parsed["waiting"], "user (message-1)");
        assert_eq!(parsed["unconsumed_inputs"], 0);
        assert_eq!(parsed["result_ready"], true);
    }

    #[test]
    fn terminal_result_line_keeps_previous_bytes_and_names_the_work() {
        let fixture = WorkFixture::new();
        fixture.admit("work-1");
        let (_, observation) =
            observe_headless_work_event(&fixture.engine).expect("bound work is observed");

        // The work-free result is the pre-existing contract; emit it through the
        // same writer so both sides are compared as records, not as literals.
        let mut baseline_outcome = HeadlessOutcome::default();
        baseline_outcome.finalize(&fixture.engine);
        let baseline_event =
            headless_result_event(&baseline_outcome, false, "session-bytes".to_string());
        let (_, baseline) = emitted_json_line(&baseline_event);

        let mut outcome = HeadlessOutcome::default();
        outcome.finalize(&fixture.engine);
        outcome.record_work_observation(observation);
        let event = headless_result_event(&outcome, false, "session-bytes".to_string());
        let (_, parsed) = emitted_json_line(&event);

        // The terminal record names the work the observation line named.
        assert_eq!(parsed["work_id"], "work-1");
        assert_eq!(parsed["work_phase"], "pending");
        assert!(parsed["waiting"].is_null());
        assert!(baseline["work_id"].is_null());
        assert!(baseline["work_phase"].is_null());

        // No key is added and none is dropped by carrying the identity.
        assert_eq!(sorted_keys(&parsed), sorted_keys(&baseline));
        for (key, value) in baseline.as_object().expect("baseline object") {
            if matches!(key.as_str(), "work_id" | "work_phase") {
                assert!(value.is_null(), "{key} is null without a bound work");
                assert!(!parsed[key].is_null(), "{key} is emitted, not null");
                continue;
            }
            // Includes `waiting`, which stays null in both records.
            assert_eq!(parsed.get(key), Some(value), "{key} must keep its meaning");
        }

        // The pre-existing field set, stated independently of the baseline so a
        // removal from both sides cannot pass.
        for field in [
            "type",
            "subtype",
            "run_status",
            "task_status",
            "termination_reason",
            "session_id",
            "timed_out",
            "retryable",
            "provider_failure",
            "resume_safe",
            "nudge_sent",
            "deliverable_written",
            "provider_retry_count",
            "retry_after_ms",
            "work_remaining",
            "goal_id",
            "work_id",
            "work_phase",
            "waiting",
            "version",
            "build_commit",
            "build_dirty",
            "build_time_unix",
        ] {
            assert!(parsed.get(field).is_some(), "{field} must still be emitted");
        }
        // Conditional fields stay absent on a clean run.
        assert!(parsed.get("error").is_none());
        assert!(parsed.get("last_compaction_failure").is_none());
    }

    #[test]
    fn headless_result_names_the_goal_the_turn_belongs_to() {
        let fixture = WorkFixture::new();
        let goal = fixture
            .engine
            .state
            .set_goal("Carry the work identity into the terminal result", None);

        let mut outcome = HeadlessOutcome::default();
        outcome.finalize(&fixture.engine);
        let event = outcome.to_json("session-goal".into());

        assert_eq!(event["goal_id"], goal.goal_id);
        assert!(
            event["work_id"].is_null(),
            "no bound work keeps the work fields null"
        );
        assert!(event["work_phase"].is_null());
        assert!(event["waiting"].is_null());
        // The verdict still follows the active goal.
        assert_eq!(event["task_status"], "partial");
        assert_eq!(event["termination_reason"], "goal_unfinished");
    }
}

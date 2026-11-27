//! `evolution/*` and `settings/evolution/*`: self-evolution management for
//! the connected runtime target.
//!
//! Every request captures the effective settings, configured model catalog,
//! skill registry and workspace once and runs the shared
//! `kcoder_tools::evolution_service` on a blocking task, so file locks never
//! hold the connection dispatcher. Mutations emit `evolution/changed`.
//! The connection advertises `selfEvolutionV1` only when the target has a
//! writable user settings file; without it every method is refused.

use super::engine_factory::AppServerEngineFactory;
use super::protocol_io::{error_response, notification, send, success_response};
use super::task_spawn::JoinSetExt as _;
use super::thread_runtime::ThreadManager;
use super::{ConnectionState, QueryEngine};
use anyhow::Result;
use kcoder_app_protocol::evolution::{
    self as protocol, CAPABILITY_SELF_EVOLUTION_V1, EvolutionChangedNotification,
    EvolutionChangedReason, method,
};
use kcoder_engine::evolution::{
    DistillRequestOutcome, EngineEvolutionHooks, EvolutionChangeEvent, EvolutionChangeSink,
};
use kcoder_tools::evolution_service::{
    ClearScope, ConfiguredModel, EvolutionChange, EvolutionEngineHooks, EvolutionService,
    EvolutionServiceError, EvolutionServiceInputs, ProposalDecision, RatingRequest,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::mpsc;

mod settings;

/// JSON-RPC error code of every evolution domain failure; `data.kind`
/// carries the stable `evolution_*` code.
const EVOLUTION_ERROR: i64 = -32050;
const MAX_CONCURRENT_REQUESTS: usize = 64;

/// The engine that serves `workspace`: a resident thread engine working
/// there, else the connection's workspace engine when it does.
fn session_engine(
    engine: &QueryEngine,
    thread_manager: &ThreadManager,
    workspace: &Path,
) -> Option<QueryEngine> {
    thread_manager
        .engine_for_workspace(workspace)
        .or_else(|| (engine.state.cwd() == workspace).then(|| engine.clone()))
}

/// Engine hooks for a request: the session engine's (its memory, review
/// store and workspace), or short-lived hooks for a workspace no engine of
/// this connection works in: that workspace's project memory and skill
/// store. Job cancellation is process-wide either way.
fn engine_hooks(
    capture: &Capture,
    settings: &kcoder_config::Settings,
) -> Result<Arc<dyn EvolutionEngineHooks>, EvolutionServiceError> {
    if let Some(engine) = &capture.session {
        return Ok(engine.evolution_hooks());
    }
    let storage = |error: anyhow::Error| {
        EvolutionServiceError::new(
            "evolution_storage_error",
            format!("project memory of the workspace is unavailable: {error}"),
        )
    };
    let memory = kcoder_memory::MemoryManager::new(
        capture.workspace_engine.memory_manager.global_store(),
        &capture.workspace,
        &settings.memory_dir().map_err(storage)?,
    )
    .map_err(storage)?;
    Ok(Arc::new(
        EngineEvolutionHooks::new(Some(Arc::new(memory)), None)
            .with_workspace(capture.workspace.clone()),
    ))
}

/// Longest time a connection drives a distillation queued on an engine
/// without an idle pump.
const DISTILL_DRIVE_LIMIT: std::time::Duration = std::time::Duration::from_secs(15 * 60);
const DISTILL_DRIVE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

/// Run the idle step of an engine that has no pump (the connection's
/// workspace engine when no thread is open) until the queued distillation
/// of `key` finished, bounded by [`DISTILL_DRIVE_LIMIT`]. Owned by the
/// connection's request tasks, so a disconnect stops it.
async fn drive_distillation(engine: QueryEngine, key: protocol::EvolutionTargetKey) {
    let deadline = tokio::time::Instant::now() + DISTILL_DRIVE_LIMIT;
    while engine.evolution_distill_pending(&key) && tokio::time::Instant::now() < deadline {
        let step = engine.clone();
        let _ = tokio::task::spawn_blocking(move || step.run_evolution_idle_step()).await;
        tokio::time::sleep(DISTILL_DRIVE_INTERVAL).await;
    }
}

pub(super) fn handles(name: &str) -> bool {
    matches!(
        name,
        method::STATUS
            | method::TARGETS_LIST
            | method::TARGET_READ
            | method::PROPOSAL_DECIDE
            | method::OVERLAY_UPDATE
            | method::PREFERENCE_LIST
            | method::PREFERENCE_UPDATE
            | method::RATE
            | method::RATINGS_LIST
            | method::DATA_CLEAR
            | method::SETTINGS_READ
            | method::SETTINGS_SAVE
            | method::TARGET_DISTILL
    )
}

/// Advertise `selfEvolutionV1` when this connection can serve every
/// method: a writable user settings file and an ordinary (non native
/// source) connection.
pub(super) fn negotiate(
    engine: &QueryEngine,
    native_source: bool,
    capabilities: &mut kcoder_app_protocol::ServerCapabilities,
) -> bool {
    let ready = !native_source && engine.settings_persistence_path().is_some();
    capabilities
        .experimental
        .insert(CAPABILITY_SELF_EVOLUTION_V1.into(), ready);
    ready
}

fn failure(id: Value, code: i64, kind: &str, message: &str) -> Value {
    let mut response = error_response(id, code, message);
    response["error"]["data"] = json!({ "kind": kind });
    response
}

fn service_failure(id: Value, error: &EvolutionServiceError) -> Value {
    failure(id, EVOLUTION_ERROR, error.code, &error.message)
}

fn invalid(id: Value, message: &str) -> Value {
    failure(id, -32602, "evolution_invalid_params", message)
}

fn decode<T: DeserializeOwned>(params: &Value) -> std::result::Result<T, String> {
    serde_json::from_value::<T>(params.clone()).map_err(|error| error.to_string())
}

fn changed(
    target_key: Option<protocol::EvolutionTargetKey>,
    reason: EvolutionChangedReason,
) -> Value {
    notification(
        method::CHANGED,
        serde_json::to_value(EvolutionChangedNotification { target_key, reason })
            .expect("evolution notification serializes"),
    )
}

fn change_reason(change: EvolutionChange) -> EvolutionChangedReason {
    match change {
        EvolutionChange::Proposal => EvolutionChangedReason::Proposal,
        EvolutionChange::Promoted => EvolutionChangedReason::Promoted,
        EvolutionChange::RolledBack => EvolutionChangedReason::RolledBack,
        EvolutionChange::Cleared => EvolutionChangedReason::Cleared,
    }
}

/// `evolution/changed` forwarder for changes the Engine's automation makes
/// (new proposals, canary promotion and rollback). Called from Engine jobs,
/// so it never blocks: a full outbound queue hands the notice to a task.
pub(super) fn change_sink(outbound: mpsc::Sender<Value>) -> EvolutionChangeSink {
    Arc::new(move |event: EvolutionChangeEvent| {
        let notice = changed(event.target_key, change_reason(event.change));
        if let Err(mpsc::error::TrySendError::Full(notice)) = outbound.try_send(notice)
            && tokio::runtime::Handle::try_current().is_ok()
        {
            let outbound = outbound.clone();
            super::task_spawn::spawn(async move {
                let _ = send(&outbound, notice).await;
            });
        }
    })
}

/// Install [`change_sink`] on the connection's engines after
/// `selfEvolutionV1` was negotiated; connections without it get no
/// unsolicited `evolution/changed`.
pub(super) fn install_change_sink(
    state: &ConnectionState,
    workspace_engine: &QueryEngine,
    thread_manager: &mut ThreadManager,
    outbound: &mpsc::Sender<Value>,
) {
    if !state.self_evolution_v1 {
        return;
    }
    let sink = change_sink(outbound.clone());
    workspace_engine.set_evolution_change_sink(Some(Arc::clone(&sink)));
    thread_manager.set_evolution_change_sink(sink);
}

/// Facts captured on the dispatcher before the blocking work starts.
struct Capture {
    factory: AppServerEngineFactory,
    /// Working directory selecting the project partition.
    workspace: PathBuf,
    user_settings: Option<PathBuf>,
    /// Engine serving the workspace (a resident thread, else the
    /// connection's workspace engine when the workspace is its own); its
    /// hooks apply proposals and its runtime pause reason refines the
    /// status.
    session: Option<QueryEngine>,
    /// Whether `session` is a resident thread, whose idle pump runs queued
    /// distillations.
    resident: bool,
    workspace_engine: QueryEngine,
}

fn build_service(capture: &Capture) -> Result<EvolutionService, EvolutionServiceError> {
    let settings = capture.factory.current_settings()?;
    let skills = capture.factory.current_skills().ok();
    // An unreadable catalog means no configured model is known available.
    let models = capture
        .factory
        .current_model_profiles()
        .unwrap_or_default()
        .into_iter()
        .map(|profile| ConfiguredModel {
            provider: profile.provider,
            model: profile.model,
            available: profile.available,
        })
        .collect();
    let data_root =
        kcoder_tools::evolution_service::data_root_for(capture.user_settings.as_deref())?;
    Ok(EvolutionService::new(EvolutionServiceInputs {
        settings: &settings,
        user_enabled: capture
            .user_settings
            .as_deref()
            .and_then(kcoder_tools::evolution_service::user_layer_enabled),
        models,
        skills: skills.as_ref(),
        workspace: Some(capture.workspace.clone()),
        data_root,
        hooks: engine_hooks(capture, &settings)?,
    })
    .with_overlay_edit_recorder(kcoder_engine::evolution::record_overlay_user_edit))
}

/// One parsed request ready to run on a blocking task.
enum Operation {
    Status,
    TargetsList(protocol::EvolutionTargetsListParams),
    TargetRead(protocol::EvolutionTargetReadParams),
    Decide(protocol::EvolutionProposalDecideParams),
    OverlayUpdate(protocol::EvolutionOverlayUpdateParams),
    PreferenceList,
    PreferenceUpdate(protocol::EvolutionPreferenceUpdateParams),
    Rate(RatingRequest),
    /// Ratable turns of the resolved thread.
    RatingsList(String),
    Clear(protocol::EvolutionDataClearParams),
    SettingsRead,
    SettingsSave(Box<protocol::EvolutionSettingsSaveParams>),
    Distill(protocol::EvolutionTargetDistillParams),
}

/// Result value plus the notification a mutation emits.
type Outcome = (Value, Option<Value>);

fn run(capture: Capture, operation: Operation) -> Result<Outcome, EvolutionServiceError> {
    match operation {
        Operation::SettingsRead => {
            let path = settings_path(&capture)?;
            Ok((json(settings::read(&path)?)?, None))
        }
        Operation::SettingsSave(params) => {
            let path = settings_path(&capture)?;
            let result = settings::save(&path, *params)?;
            // Turning the master switch off stops owned jobs right away; the
            // saved settings already keep new jobs from starting.
            if !result.settings.enabled
                && let Ok(service) = build_service(&capture)
            {
                service.cancel_jobs()?;
            }
            Ok((
                json(result)?,
                Some(changed(None, EvolutionChangedReason::Settings)),
            ))
        }
        Operation::Distill(params) => Ok((json(distill(&capture, &params)?)?, None)),
        Operation::Status => {
            let service = build_service(&capture)?;
            let mut status = service.status()?;
            // A running session may have paused model jobs (for example the
            // monthly usage limit) after the settings were read.
            if status.enabled && status.disabled_reason.is_none() {
                status.disabled_reason = capture
                    .session
                    .as_ref()
                    .and_then(QueryEngine::evolution_paused_reason);
            }
            Ok((json(status)?, None))
        }
        operation => {
            let service = build_service(&capture)?;
            run_service(&service, operation)
        }
    }
}

fn settings_path(capture: &Capture) -> Result<PathBuf, EvolutionServiceError> {
    capture.user_settings.clone().ok_or_else(|| {
        EvolutionServiceError::new(
            "evolution_storage_error",
            "this target has no writable user settings file",
        )
    })
}

fn json<T: serde::Serialize>(value: T) -> Result<Value, EvolutionServiceError> {
    Ok(serde_json::to_value(value).map_err(anyhow::Error::from)?)
}

fn run_service(
    service: &EvolutionService,
    operation: Operation,
) -> Result<Outcome, EvolutionServiceError> {
    match operation {
        Operation::Status => Ok((json(service.status()?)?, None)),
        Operation::TargetsList(params) => {
            let (items, next_cursor) = service.list_targets(
                params.target_type,
                params.cursor.as_deref(),
                params.limit.map(|limit| limit as usize),
            )?;
            Ok((
                json(protocol::EvolutionTargetsListResult { items, next_cursor })?,
                None,
            ))
        }
        Operation::TargetRead(params) => {
            let detail = service.read_target(&params.target_key)?;
            Ok((
                json(protocol::EvolutionTargetReadResult {
                    summary: detail.summary,
                    overlay: protocol::EvolutionOverlayView {
                        stable: detail.overlay.stable,
                        candidate: detail.overlay.candidate,
                        overlay_revision: detail.overlay.overlay_revision,
                    },
                    patterns: detail.patterns,
                    proposals: detail.proposals,
                })?,
                None,
            ))
        }
        Operation::Decide(params) => {
            let decision = match params.decision {
                protocol::EvolutionDecision::Accept => ProposalDecision::Accept,
                protocol::EvolutionDecision::Reject => ProposalDecision::Reject,
                protocol::EvolutionDecision::Rollback => ProposalDecision::Rollback,
                protocol::EvolutionDecision::PinStable => ProposalDecision::PinStable,
            };
            let (summary, change, notice) = service.decide_with_notice(
                &params.target_key,
                &params.proposal_id,
                decision,
                &params.expected_revision,
            )?;
            Ok((
                json(protocol::EvolutionProposalDecideResult { summary, notice })?,
                Some(changed(Some(params.target_key), change_reason(change))),
            ))
        }
        Operation::OverlayUpdate(params) => {
            let overlay_revision = service.update_overlay(
                &params.target_key,
                &params.content,
                &params.expected_revision,
            )?;
            Ok((
                json(protocol::EvolutionOverlayUpdateResult { overlay_revision })?,
                Some(changed(
                    Some(params.target_key),
                    EvolutionChangedReason::Proposal,
                )),
            ))
        }
        Operation::PreferenceList => {
            let (rows, revision) = service.preferences()?;
            let items = rows
                .into_iter()
                .map(|row| protocol::EvolutionPreferenceItem {
                    key: row.key,
                    value: row.value,
                    scope: row.scope,
                    evidence_count: row.evidence_count,
                    updated_at: row.updated_at,
                })
                .collect();
            Ok((
                json(protocol::EvolutionPreferenceListResult { items, revision })?,
                None,
            ))
        }
        Operation::PreferenceUpdate(params) => {
            let revision = service.update_preference(
                &params.key,
                params.value.as_deref(),
                &params.expected_revision,
            )?;
            Ok((
                json(protocol::EvolutionPreferenceUpdateResult { revision })?,
                Some(changed(None, EvolutionChangedReason::Proposal)),
            ))
        }
        Operation::Rate(request) => {
            let recorded = service.rate(&request)?;
            Ok((json(protocol::EvolutionRateResult { recorded })?, None))
        }
        Operation::RatingsList(thread_id) => {
            let (turns, truncated) =
                service.ratable_turns(&thread_id, protocol::EVOLUTION_RATINGS_LIST_MAX)?;
            let items = turns
                .into_iter()
                .map(|turn| protocol::EvolutionRatableTurn {
                    turn_id: turn.turn_id,
                    tool_call_ids: turn.tool_call_ids,
                    target_keys: turn.target_keys,
                    rating: turn.rating.map(|up| {
                        if up {
                            protocol::EvolutionRating::Up
                        } else {
                            protocol::EvolutionRating::Down
                        }
                    }),
                })
                .collect();
            Ok((
                json(protocol::EvolutionRatingsListResult { items, truncated })?,
                None,
            ))
        }
        Operation::Clear(params) => {
            let scope = match params.scope {
                protocol::EvolutionDataScope::User => ClearScope::User,
                protocol::EvolutionDataScope::Project => ClearScope::Project,
                protocol::EvolutionDataScope::All => ClearScope::All,
            };
            let cleared = service.clear(scope)?;
            Ok((
                json(protocol::EvolutionDataClearResult { cleared })?,
                Some(changed(None, EvolutionChangedReason::Cleared)),
            ))
        }
        Operation::SettingsRead | Operation::SettingsSave(_) | Operation::Distill(_) => {
            unreachable!("settings and distillation run without the service")
        }
    }
}

/// `evolution/target/distill`: queue a manual distillation on the session
/// engine of the workspace. Nothing runs here; the job starts from that
/// session's idle step.
fn distill(
    capture: &Capture,
    params: &protocol::EvolutionTargetDistillParams,
) -> Result<protocol::EvolutionTargetDistillResult, EvolutionServiceError> {
    use protocol::EvolutionDistillOutcome as Outcome;
    let result = |outcome, reason: Option<String>| protocol::EvolutionTargetDistillResult {
        outcome,
        reason,
    };
    if !capture.resident {
        // Section 15.1: without a session there is no session model to
        // follow, so a distillation needs a configured evolution model.
        let settings = capture.factory.current_settings()?;
        let evolution = &settings.evolution;
        if !evolution.target_enabled(&params.target_key) {
            return Ok(result(Outcome::Disabled, None));
        }
        if evolution.stage_models.distill.is_none() && evolution.model.is_none() {
            return Ok(result(
                Outcome::ModelUnavailable,
                Some(
                    "no session is open for this workspace, so there is no session model to \
                     follow; set evolution.model or evolution.stage_models.distill, or open a \
                     session"
                        .into(),
                ),
            ));
        }
    }
    // A workspace this connection has no engine for still reaches the
    // user-level skills through the workspace engine.
    let engine = capture
        .session
        .as_ref()
        .unwrap_or(&capture.workspace_engine);
    Ok(match engine.request_evolution_distill(&params.target_key) {
        DistillRequestOutcome::Queued => result(Outcome::Queued, None),
        DistillRequestOutcome::Disabled => result(Outcome::Disabled, None),
        DistillRequestOutcome::UnknownTarget => result(Outcome::UnknownTarget, None),
        DistillRequestOutcome::ModelUnavailable(reason) => {
            result(Outcome::ModelUnavailable, Some(reason))
        }
    })
}

/// Resolve the thread a rating (or the ratable-turn list) addresses. A
/// subagent rating names the parent thread the client owns; the child is
/// looked up in that parent's agent registry and must belong to it.
fn rating_thread(
    thread_manager: &ThreadManager,
    thread_id: &str,
    subagent_id: Option<&str>,
) -> std::result::Result<(String, Option<PathBuf>), EvolutionServiceError> {
    let engine = thread_manager.engine(thread_id);
    let cwd = engine
        .as_ref()
        .map(|engine| engine.state.cwd().to_path_buf());
    let Some(agent_id) = subagent_id else {
        return Ok((thread_id.to_string(), cwd));
    };
    let not_found = || {
        EvolutionServiceError::new(
            "evolution_target_not_found",
            "the subagent was not found in this thread",
        )
    };
    let engine = engine.ok_or_else(not_found)?;
    let task = super::agent_requests::owned_agent_scope(thread_manager, thread_id, agent_id)
        .map_err(|_| not_found())?
        .1;
    debug_assert_eq!(
        task.parent_session_id.as_deref(),
        Some(engine.session_id().as_str())
    );
    Ok((task.id, cwd))
}

fn parse(
    name: &str,
    params: &Value,
    thread_manager: &ThreadManager,
) -> std::result::Result<(Operation, Option<PathBuf>), Value> {
    let bad = |message: String| invalid(Value::Null, &message);
    let validated = |result: std::result::Result<(), protocol::EvolutionParamsError>| {
        result.map_err(|error| bad(error.to_string()))
    };
    let operation = match name {
        method::STATUS => {
            let params: protocol::EvolutionStatusParams = decode(params).map_err(bad)?;
            validated(params.validate())?;
            return Ok((Operation::Status, params.workspace.map(PathBuf::from)));
        }
        method::TARGETS_LIST => {
            let params: protocol::EvolutionTargetsListParams = decode(params).map_err(bad)?;
            validated(params.validate())?;
            let workspace = params.workspace.clone().map(PathBuf::from);
            return Ok((Operation::TargetsList(params), workspace));
        }
        method::TARGET_READ => {
            let params: protocol::EvolutionTargetReadParams = decode(params).map_err(bad)?;
            validated(params.validate())?;
            let workspace = params.workspace.clone().map(PathBuf::from);
            return Ok((Operation::TargetRead(params), workspace));
        }
        method::PROPOSAL_DECIDE => {
            let params: protocol::EvolutionProposalDecideParams = decode(params).map_err(bad)?;
            validated(params.validate())?;
            let workspace = params.workspace.clone().map(PathBuf::from);
            return Ok((Operation::Decide(params), workspace));
        }
        method::OVERLAY_UPDATE => {
            let params: protocol::EvolutionOverlayUpdateParams = decode(params).map_err(bad)?;
            validated(params.validate())?;
            let workspace = params.workspace.clone().map(PathBuf::from);
            return Ok((Operation::OverlayUpdate(params), workspace));
        }
        method::PREFERENCE_LIST => {
            let _: protocol::EvolutionPreferenceListParams = decode(params).map_err(bad)?;
            Operation::PreferenceList
        }
        method::PREFERENCE_UPDATE => {
            let params: protocol::EvolutionPreferenceUpdateParams = decode(params).map_err(bad)?;
            validated(params.validate())?;
            Operation::PreferenceUpdate(params)
        }
        method::RATE => {
            let params: protocol::EvolutionRateParams = decode(params).map_err(bad)?;
            validated(params.validate())?;
            let (thread_id, cwd) = rating_thread(
                thread_manager,
                &params.thread_id,
                params.subagent_id.as_deref(),
            )
            .map_err(|error| service_failure(Value::Null, &error))?;
            return Ok((
                Operation::Rate(RatingRequest {
                    thread_id,
                    turn_id: params.turn_id,
                    tool_call_ids: params.tool_call_ids,
                    target_key: params.target_key,
                    up: params.rating == protocol::EvolutionRating::Up,
                    reason: params.reason,
                }),
                cwd,
            ));
        }
        method::RATINGS_LIST => {
            let params: protocol::EvolutionRatingsListParams = decode(params).map_err(bad)?;
            validated(params.validate())?;
            let (thread_id, cwd) = rating_thread(
                thread_manager,
                &params.thread_id,
                params.subagent_id.as_deref(),
            )
            .map_err(|error| service_failure(Value::Null, &error))?;
            return Ok((Operation::RatingsList(thread_id), cwd));
        }
        method::DATA_CLEAR => {
            let params: protocol::EvolutionDataClearParams = decode(params).map_err(bad)?;
            validated(params.validate())?;
            let workspace = params.workspace.clone().map(PathBuf::from);
            return Ok((Operation::Clear(params), workspace));
        }
        method::SETTINGS_READ => {
            let _: protocol::EvolutionSettingsReadParams = decode(params).map_err(bad)?;
            Operation::SettingsRead
        }
        method::SETTINGS_SAVE => {
            let params: protocol::EvolutionSettingsSaveParams = decode(params).map_err(bad)?;
            validated(params.validate())?;
            Operation::SettingsSave(Box::new(params))
        }
        method::TARGET_DISTILL => {
            let params: protocol::EvolutionTargetDistillParams = decode(params).map_err(bad)?;
            validated(params.validate())?;
            let workspace = params.workspace.clone().map(PathBuf::from);
            return Ok((Operation::Distill(params), workspace));
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    };
    Ok((operation, None))
}

fn with_id(mut response: Value, id: Value) -> Value {
    response["id"] = id;
    response
}

#[expect(
    clippy::too_many_arguments,
    reason = "Keep separately borrowed connection owners explicit at the dispatch boundary"
)]
pub(super) async fn dispatch(
    name: &str,
    id: &Value,
    params: &Value,
    engine: &QueryEngine,
    factory: &AppServerEngineFactory,
    thread_manager: &ThreadManager,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    if !handles(name) {
        return Ok(false);
    }
    if !state.self_evolution_v1 {
        send(
            outbound,
            failure(
                id.clone(),
                -32601,
                "evolution_unsupported",
                "selfEvolutionV1 is not available on this connection",
            ),
        )
        .await?;
        return Ok(true);
    }
    if state.knowledge_rpc_tasks.len() >= MAX_CONCURRENT_REQUESTS {
        send(
            outbound,
            failure(
                id.clone(),
                -32000,
                "evolution_busy",
                "evolution requests are busy",
            ),
        )
        .await?;
        return Ok(true);
    }
    let (operation, workspace) = match parse(name, params, thread_manager) {
        Ok(parsed) => parsed,
        Err(response) => {
            send(outbound, with_id(response, id.clone())).await?;
            return Ok(true);
        }
    };
    let workspace = workspace.unwrap_or_else(|| engine.state.cwd().to_path_buf());
    let resident_session = thread_manager.engine_for_workspace(&workspace);
    let resident = resident_session.is_some();
    let session = resident_session.or_else(|| session_engine(engine, thread_manager, &workspace));
    // A distillation queued on an engine without an idle pump is driven by
    // this request's task after the response.
    let driver = match (&operation, resident) {
        (Operation::Distill(params), false) => Some((
            session.clone().unwrap_or_else(|| engine.clone()),
            params.target_key.clone(),
        )),
        _ => None,
    };
    let capture = Capture {
        factory: factory.clone(),
        workspace,
        user_settings: engine.settings_persistence_path(),
        session,
        resident,
        workspace_engine: engine.clone(),
    };
    let (id, outbound) = (id.clone(), outbound.clone());
    // Locks and durable writes must not hold the dispatcher. A committed
    // write may outlive its client; it is never replayed.
    state.knowledge_rpc_tasks.spawn_shared(async move {
        let result = tokio::task::spawn_blocking(move || run(capture, operation)).await;
        let (response, notice) = match result {
            Ok(Ok((value, notice))) => (success_response(id, value), notice),
            Ok(Err(error)) => (service_failure(id, &error), None),
            Err(_) => (
                failure(
                    id,
                    -32603,
                    "evolution_storage_error",
                    "evolution request failed",
                ),
                None,
            ),
        };
        let queued = response["result"]["outcome"] == "queued";
        let _ = send(&outbound, response).await;
        if let Some(notice) = notice {
            let _ = send(&outbound, notice).await;
        }
        if let Some((engine, key)) = driver.filter(|_| queued) {
            drive_distillation(engine, key).await;
        }
    });
    Ok(true)
}

#[cfg(test)]
mod tests;

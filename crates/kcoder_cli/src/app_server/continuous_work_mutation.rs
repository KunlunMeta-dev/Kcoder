//! Negotiated durable input acceptance and control submission against the
//! selected host's existing store. A recorded receipt is neither proof that a
//! later turn consumed the input nor that an owned resource actually settled.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::continuous_work::{
    ContinuousWorkControlParams, ContinuousWorkControlResult, ContinuousWorkInputReadParams,
    ContinuousWorkInputReceiptView, ContinuousWorkInputResult, ContinuousWorkInputSubmitParams,
    method,
};
use kcoder_engine::QueryEngine;
use kcoder_host_transport::protocol_io::{error_response, send, success_response};
use kcoder_state::continuous_work::{
    ContinuousWorkStore, HostWorkScope, InputAdmission, WorkInputSource,
};
use kcoder_turn_lifecycle::{thread_history::thread_history_path, turn_attempts};
use kcoder_types::continuous_work::{
    WorkControlAction, WorkControlState, WorkInputKind, WorkInputReceipt, WorkRecord,
};
use serde_json::{Value, json};
use std::sync::{Arc, LazyLock};
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinSet;

#[cfg(test)]
#[path = "continuous_work_mutation.test.rs"]
mod tests;

const CONNECTION_LIMIT: usize = 4;
static MUTATION_PERMITS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(8)));

enum MutationRequest {
    Submit(ContinuousWorkInputSubmitParams),
    ReadInput(ContinuousWorkInputReadParams),
    Control(ContinuousWorkControlParams),
}

impl MutationRequest {
    /// The original thread is the only identity a host resolves a scope for; a
    /// caller never selects its own account, target or workspace.
    fn thread_id(&self) -> &str {
        match self {
            Self::Submit(params) => &params.thread_id,
            Self::ReadInput(params) => &params.thread_id,
            Self::Control(params) => &params.thread_id,
        }
    }
}

fn parse(method: &str, params: &Value) -> Result<MutationRequest> {
    match method {
        method::INPUT_SUBMIT => {
            let params: ContinuousWorkInputSubmitParams = serde_json::from_value(params.clone())?;
            params.validate().map_err(anyhow::Error::msg)?;
            Ok(MutationRequest::Submit(params))
        }
        method::INPUT_READ => {
            let params: ContinuousWorkInputReadParams = serde_json::from_value(params.clone())?;
            params.validate().map_err(anyhow::Error::msg)?;
            Ok(MutationRequest::ReadInput(params))
        }
        method::CONTROL => {
            let params: ContinuousWorkControlParams = serde_json::from_value(params.clone())?;
            // Rejects an action/target mismatch and a zero expected revision.
            params.validate().map_err(anyhow::Error::msg)?;
            Ok(MutationRequest::Control(params))
        }
        _ => anyhow::bail!("unsupported continuous work mutation"),
    }
}

/// Both draft mutation capabilities rest on the same preconditions as the
/// read-only capability: a persistent profile and a negotiated read. A client
/// that never negotiated reads must keep its own page-local queue.
pub fn negotiate(read_enabled: bool, requested: Option<&bool>) -> bool {
    continuous_work_mutation_dispatch_ready() && read_enabled && requested == Some(&true)
}

/// The single switch that may advertise `continuousWorkInputV1` and
/// `continuousWorkControlV1`. It stays off because this host can persist and
/// return these mutations but nothing consumes them yet: no Engine safe-yield
/// consumer reads a queued input, and no executor applies pause/stop. An
/// advertised capability would let a client show "accepted by the target" for
/// input that no later turn will read. Advertising becomes honest once an
/// Engine safe-yield consumer takes queued input and a real control settlement
/// exists; flipping this one predicate is then the only change needed here.
fn continuous_work_mutation_dispatch_ready() -> bool {
    false
}

/// The negotiated gate for one method. Nothing is available before `initialize`
/// resolved the capability.
fn allowed(input: bool, control: bool, method: &str) -> bool {
    match method {
        method::INPUT_SUBMIT | method::INPUT_READ => input,
        method::CONTROL => control,
        _ => false,
    }
}

/// The original conversation binding, never a transient connection identity.
fn input_source(host: &HostWorkScope, thread_id: &str) -> WorkInputSource {
    WorkInputSource {
        kind: "foreground".into(),
        instance_id: host.scope().target_id.clone(),
        conversation_id: thread_id.to_owned(),
    }
}

/// A saved binding is an observation, so the original attempt must still be
/// verifiable on this host before any mutation is attributed to it. A record
/// outside this host's actual scope is simply not found.
fn observed_work(
    engine: &QueryEngine,
    host: &HostWorkScope,
    store: &ContinuousWorkStore,
    thread_id: &str,
    work_id: &str,
) -> Result<Option<WorkRecord>> {
    let Some(work) = store.read_work(host.scope(), work_id)? else {
        return Ok(None);
    };
    ensure!(
        work.origin.initial_attempt.thread_id == thread_id,
        "CONTINUOUS_WORK_THREAD_SCOPE_MISMATCH"
    );
    thread_history_path(engine, thread_id)?;
    ensure!(
        turn_attempts::records(engine, thread_id)?
            .iter()
            .any(|record| record.identity == work.origin.initial_attempt),
        "CONTINUOUS_WORK_ORIGINAL_ATTEMPT_UNAVAILABLE"
    );
    Ok(Some(work))
}

/// A busy target keeps the input durable but unconsumed. The store's own claim
/// is authoritative for the coordinated lane; a live turn is only observable
/// on the connection that owns it.
fn busy(
    store: &ContinuousWorkStore,
    host: &HostWorkScope,
    work_id: &str,
    live_turn: bool,
) -> Result<bool> {
    Ok(live_turn || store.active_claim(host.scope(), work_id)?.is_some())
}

fn input_view(
    host: &HostWorkScope,
    thread_id: String,
    receipt: WorkInputReceipt,
) -> Result<ContinuousWorkInputReceiptView> {
    receipt
        .validate_for_mutation(host.scope())
        .map_err(anyhow::Error::msg)?;
    Ok(ContinuousWorkInputReceiptView {
        thread_id,
        work_id: receipt.work.work_id,
        input_id: receipt.input_id,
        request_id: receipt.request_id,
        sequence: receipt.sequence,
        state: receipt.state,
        requirements_revision: receipt.requirements_revision,
        // Only an answer this host verified against its original question may
        // name an interaction; that adapter does not exist yet.
        interaction: None,
        // The store's own receipt never proves that a turn consumed the input.
        applied_turn_id: None,
    })
}

/// Persist one submitted requirement. The store owns idempotency: the same
/// `input_id` with the same payload reports its original receipt, and the same
/// `input_id` with different content is a stable conflict.
fn persist_submit(
    host: &HostWorkScope,
    store: &ContinuousWorkStore,
    live_turn: bool,
    params: ContinuousWorkInputSubmitParams,
) -> Result<ContinuousWorkInputResult> {
    let text = params
        .text
        .clone()
        .context("CONTINUOUS_WORK_INPUT_INVALID")?;
    let busy = busy(store, host, &params.work_id, live_turn)?;
    let source = input_source(host, &params.thread_id);
    let deliveries = store
        .accepted_deliveries(host.scope(), &params.work_id)?
        .context("CONTINUOUS_WORK_NOT_FOUND")?;
    let payload = json!({"text": text});
    let admitted = if busy {
        store.queue_input(
            host.scope(),
            &params.work_id,
            &source,
            params.expected_revision,
            &params.input_id,
            &params.request_id,
            WorkInputKind::Requirement,
            payload,
            Some(deliveries),
        )?
    } else {
        store.accept_input(
            host.scope(),
            &params.work_id,
            &source,
            params.expected_revision,
            &params.input_id,
            &params.request_id,
            WorkInputKind::Requirement,
            payload,
            Some(deliveries),
        )?
    };
    let receipt = match admitted {
        InputAdmission::Accepted(receipt) | InputAdmission::Existing(receipt) => receipt,
    };
    Ok(ContinuousWorkInputResult {
        receipt: Some(input_view(host, params.thread_id, receipt)?),
    })
}

fn submit_input(
    engine: &QueryEngine,
    host: &HostWorkScope,
    store: &ContinuousWorkStore,
    live_turn: bool,
    params: ContinuousWorkInputSubmitParams,
) -> Result<ContinuousWorkInputResult> {
    observed_work(engine, host, store, &params.thread_id, &params.work_id)?
        .context("CONTINUOUS_WORK_NOT_FOUND")?;
    // Retained attachments and answers to an original question need native
    // verification adapters this host does not have; fail closed instead of
    // persisting a reference whose original cannot be proven.
    ensure!(
        params.interaction.is_none() && params.retention.is_none(),
        "CONTINUOUS_WORK_INPUT_REFERENCE_UNSUPPORTED"
    );
    persist_submit(host, store, live_turn, params)
}

fn read_input(
    engine: &QueryEngine,
    host: &HostWorkScope,
    store: &ContinuousWorkStore,
    params: ContinuousWorkInputReadParams,
) -> Result<ContinuousWorkInputResult> {
    // Absence is an observation, not an error, and it never permits a replay
    // under a new input identity.
    if observed_work(engine, host, store, &params.thread_id, &params.work_id)?.is_none() {
        return Ok(ContinuousWorkInputResult { receipt: None });
    }
    let source = input_source(host, &params.thread_id);
    let Some((receipt, _payload)) =
        store.read_input(host.scope(), &params.work_id, &source, &params.input_id)?
    else {
        return Ok(ContinuousWorkInputResult { receipt: None });
    };
    Ok(ContinuousWorkInputResult {
        receipt: Some(input_view(host, params.thread_id, receipt)?),
    })
}

/// A recorded control intent is not a settled resource. This host settles only
/// the actions whose idle target is provable from the store's own facts, never
/// retries a native control, and reports anything it cannot prove as open.
fn persist_control(
    host: &HostWorkScope,
    store: &ContinuousWorkStore,
    live_turn: bool,
    params: ContinuousWorkControlParams,
) -> Result<ContinuousWorkControlResult> {
    let busy = busy(store, host, &params.work_id, live_turn)?;
    let mut receipt = store.control(
        host.scope(),
        &params.work_id,
        params.expected_revision,
        &params.request_id,
        params.action.into(),
        params.target.clone(),
    )?;
    // Pause/stop cannot settle while the work still has an owner. The store
    // rechecks that fence itself; a refusal leaves the intent accepted.
    if !busy
        && matches!(
            receipt.action,
            WorkControlAction::Pause | WorkControlAction::Stop
        )
    {
        match store.settle_control(
            host.scope(),
            &params.work_id,
            &receipt.request_id,
            receipt.control_epoch,
            WorkControlState::Settled,
        ) {
            Ok(settled) => receipt = settled,
            Err(error) => tracing::warn!(
                code = "CONTINUOUS_WORK_CONTROL_UNSETTLED",
                %error,
                "Continuous work control settlement is unconfirmed"
            ),
        }
    }
    // The store's original operation receipt is the only proof of the recorded
    // intent; when it disagrees the client must re-read before acting.
    let observed_state =
        match store.read_control(host.scope(), &params.work_id, &params.request_id)? {
            Some(observed)
                if observed.request_id == receipt.request_id
                    && observed.control_epoch == receipt.control_epoch
                    && observed.action == receipt.action
                    && observed.state == receipt.state =>
            {
                receipt.state
            }
            _ => WorkControlState::NeedsReconciliation,
        };
    let revision = store
        .read_work(host.scope(), &params.work_id)?
        .context("CONTINUOUS_WORK_NOT_FOUND")?
        .revision
        .revision;
    Ok(ContinuousWorkControlResult {
        work_id: params.work_id,
        request_id: receipt.request_id,
        action: receipt.action,
        target: receipt.target,
        revision,
        control_epoch: receipt.control_epoch,
        state: observed_state,
    })
}

fn submit_control(
    engine: &QueryEngine,
    host: &HostWorkScope,
    store: &ContinuousWorkStore,
    live_turn: bool,
    params: ContinuousWorkControlParams,
) -> Result<ContinuousWorkControlResult> {
    observed_work(engine, host, store, &params.thread_id, &params.work_id)?
        .context("CONTINUOUS_WORK_NOT_FOUND")?;
    persist_control(host, store, live_turn, params)
}

fn apply(
    engine: &QueryEngine,
    request: MutationRequest,
    principal: Option<String>,
    live_turn: bool,
) -> Result<Value> {
    let settings = engine
        .settings_persistence_path()
        .context("CONTINUOUS_WORK_PROFILE_UNAVAILABLE")?;
    let profile = settings
        .parent()
        .context("CONTINUOUS_WORK_PROFILE_UNAVAILABLE")?;
    let workspace = engine.state.cwd();
    let host = HostWorkScope::capture(profile, &workspace, principal.as_deref())?;
    let store = ContinuousWorkStore::open_existing(host.profile_path())?;
    let output = match request {
        MutationRequest::Submit(params) => {
            let store = store.context("CONTINUOUS_WORK_NOT_FOUND")?;
            serde_json::to_value(submit_input(engine, &host, &store, live_turn, params)?)?
        }
        MutationRequest::ReadInput(params) => {
            let result = match store.as_ref() {
                Some(store) => read_input(engine, &host, store, params)?,
                None => ContinuousWorkInputResult { receipt: None },
            };
            serde_json::to_value(result)?
        }
        MutationRequest::Control(params) => {
            let store = store.context("CONTINUOUS_WORK_NOT_FOUND")?;
            serde_json::to_value(submit_control(engine, &host, &store, live_turn, params)?)?
        }
    };
    host.verify()?;
    ensure!(
        engine.settings_persistence_path().as_ref() == Some(&settings)
            && engine.state.cwd() == workspace,
        "CONTINUOUS_WORK_SCOPE_CHANGED"
    );
    Ok(output)
}

/// Only a bounded `CONTINUOUS_WORK_*` code may reach the client; anything else
/// becomes a generic message so no private host detail leaks.
fn error_message(error: &anyhow::Error) -> String {
    error
        .chain()
        .map(ToString::to_string)
        .find(|code| {
            code.len() <= 96
                && code.starts_with("CONTINUOUS_WORK_")
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        })
        .unwrap_or_else(|| "continuous work mutation unavailable".into())
}

pub struct MutationAccess<'a> {
    pub input: bool,
    pub control: bool,
    pub tasks: &'a mut JoinSet<()>,
}

pub async fn dispatch(
    method: &str,
    id: &Value,
    params: &Value,
    engine: &QueryEngine,
    is_turn_running: &(dyn Fn(&str) -> bool + Sync),
    outbound: &mpsc::Sender<Value>,
    access: MutationAccess<'_>,
) -> Result<bool> {
    if !matches!(
        method,
        method::INPUT_SUBMIT | method::INPUT_READ | method::CONTROL
    ) {
        return Ok(false);
    }
    if !allowed(access.input, access.control, method) {
        send(
            outbound,
            error_response(
                id.clone(),
                -32601,
                "continuous work mutation was not negotiated",
            ),
        )
        .await?;
        return Ok(true);
    }
    let request = match parse(method, params) {
        Ok(request) => request,
        Err(_) => {
            send(
                outbound,
                error_response(id.clone(), -32602, "invalid continuous work mutation"),
            )
            .await?;
            return Ok(true);
        }
    };
    let principal = match std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(_) => {
            send(
                outbound,
                error_response(id.clone(), -32043, "continuous work mutation unavailable"),
            )
            .await?;
            return Ok(true);
        }
    };
    // A live turn is only observable on this connection; the store's claim is
    // rechecked inside the blocking task that opens the store.
    let live_turn = is_turn_running(request.thread_id());
    let permit = if access.tasks.len() < CONNECTION_LIMIT {
        MUTATION_PERMITS.clone().try_acquire_owned().ok()
    } else {
        None
    };
    let Some(permit) = permit else {
        send(
            outbound,
            error_response(id.clone(), -32043, "continuous work mutation busy"),
        )
        .await?;
        return Ok(true);
    };
    let engine = engine.clone();
    let id = id.clone();
    let outbound = outbound.clone();
    access.tasks.spawn_blocking(move || {
        let _permit = permit;
        let response = match apply(&engine, request, principal, live_turn) {
            Ok(value) => success_response(id, value),
            Err(error) => error_response(id, -32043, &error_message(&error)),
        };
        let _ = outbound.blocking_send(response);
    });
    Ok(true)
}

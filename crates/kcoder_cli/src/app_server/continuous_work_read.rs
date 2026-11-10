//! Negotiated, read-only observations from the selected host's existing store.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::continuous_work::{
    ContinuousWorkDeliveryRequirement, ContinuousWorkListParams, ContinuousWorkListResult,
    ContinuousWorkPendingInputView, ContinuousWorkPresence, ContinuousWorkReadParams,
    ContinuousWorkReadResult, ContinuousWorkResultView, ContinuousWorkView, ContinuousWorkWaitView,
    MAX_PENDING_INPUT_VIEWS, method,
};
use kcoder_engine::QueryEngine;
use kcoder_host_transport::protocol_io::{error_response, send, success_response};
use kcoder_state::continuous_work::{
    ContinuousWorkStore, HostWorkScope, PendingInputEntry, PendingInputPage,
};
use kcoder_turn_lifecycle::{thread_history::thread_history_path, turn_attempts};
use kcoder_types::continuous_work::{WorkObservationFreshness, WorkRecord};
use serde_json::Value;
use std::sync::{Arc, LazyLock};
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinSet;

const CONNECTION_LIMIT: usize = 4;
static READ_PERMITS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(8)));

enum ReadRequest {
    List(ContinuousWorkListParams),
    Read(ContinuousWorkReadParams),
}

fn parse(method: &str, params: &Value) -> Result<ReadRequest> {
    match method {
        method::LIST => {
            let params: ContinuousWorkListParams = serde_json::from_value(params.clone())?;
            params.validate().map_err(anyhow::Error::msg)?;
            if let Some(cursor) = &params.cursor {
                ContinuousWorkReadParams {
                    work_id: cursor.clone(),
                }
                .validate()
                .map_err(anyhow::Error::msg)?;
            }
            Ok(ReadRequest::List(params))
        }
        method::READ => {
            let params: ContinuousWorkReadParams = serde_json::from_value(params.clone())?;
            params.validate().map_err(anyhow::Error::msg)?;
            Ok(ReadRequest::Read(params))
        }
        _ => anyhow::bail!("unsupported continuous work read"),
    }
}

/// A saved binding is an observation. Resolve its original persistent thread
/// and accepted attempt independently before projecting any user-visible data.
///
/// Only a single-record read passes the store: a page must not fan a
/// whole-store read out across every row, and a record whose queue could not be
/// read keeps the field absent instead of failing the rest of the observation.
fn project(
    engine: &QueryEngine,
    store: Option<&ContinuousWorkStore>,
    work: WorkRecord,
) -> Result<ContinuousWorkView> {
    let initial = &work.origin.initial_attempt;
    thread_history_path(engine, &initial.thread_id)?;
    ensure!(
        turn_attempts::records(engine, &initial.thread_id)?
            .iter()
            .any(|record| record.identity == *initial),
        "CONTINUOUS_WORK_ORIGINAL_ATTEMPT_UNAVAILABLE"
    );
    let pending_inputs = store.and_then(|store| {
        observed_pending_inputs(store.list_pending_inputs(
            &work.identity.scope,
            &work.identity.work_id,
            None,
        ))
    });
    view_from(work, pending_inputs)
}

/// Project one observed pending requirement without its payload or authority.
fn pending_input(entry: &PendingInputEntry) -> ContinuousWorkPendingInputView {
    ContinuousWorkPendingInputView {
        input_id: entry.receipt.input_id.clone(),
        sequence: entry.receipt.sequence,
        state: entry.receipt.state.clone(),
    }
}

/// Bound the observed queue so one record cannot grow the frame on its own.
fn pending_input_views(page: &PendingInputPage) -> Vec<ContinuousWorkPendingInputView> {
    page.inputs
        .iter()
        .take(MAX_PENDING_INPUT_VIEWS)
        .map(pending_input)
        .collect()
}

/// A pending-input read never fails the record: an unobserved queue stays
/// absent instead of reading as an empty one.
fn observed_pending_inputs(
    pending: Result<PendingInputPage>,
) -> Option<Vec<ContinuousWorkPendingInputView>> {
    match pending {
        Ok(page) => Some(pending_input_views(&page)),
        Err(error) => {
            tracing::warn!(%error, "pending work inputs were not observed");
            None
        }
    }
}

/// Assemble the observation of one record whose original attempt was verified.
fn view_from(
    work: WorkRecord,
    pending_inputs: Option<Vec<ContinuousWorkPendingInputView>>,
) -> Result<ContinuousWorkView> {
    // Borrow the result before any field of the record is moved out.
    let result = result_view(&work);
    let view = ContinuousWorkView {
        work_id: work.identity.work_id,
        thread_id: work.origin.initial_attempt.thread_id.clone(),
        phase: work.phase,
        revision: work.revision.revision,
        requirements_revision: work.revision.requirements_revision,
        // This path has not verified current execution or completion evidence.
        freshness: WorkObservationFreshness::Partial,
        title: work
            .presentation
            .as_ref()
            .and_then(|value| value.title.clone()),
        updated_at_ms: work
            .presentation
            .as_ref()
            .and_then(|value| value.updated_at_ms),
        waiting: work.waiting.map(|value| ContinuousWorkWaitView {
            kind: value.kind,
            reference: value.reference,
        }),
        result,
        // Counters and watermarks are copied from the durable revision; they do
        // not prove consumption, completion or delivery on their own.
        usage: Some(work.revision.usage),
        unconsumed_inputs: Some(
            work.revision
                .accepted_input_sequence
                .saturating_sub(work.revision.applied_input_sequence),
        ),
        pending_inputs,
    };
    view.validate_observation().map_err(anyhow::Error::msg)?;
    Ok(view)
}

/// Project a recorded result without claiming completion.
///
/// The recorded artifacts are the client's only deliverable reference, so they
/// are forwarded instead of replaced by an empty list; `ready` stays false
/// because a recorded result is not the completion CAS.
fn result_view(
    work: &kcoder_types::continuous_work::WorkRecord,
) -> Option<ContinuousWorkResultView> {
    work.result.as_ref().map(|value| ContinuousWorkResultView {
        result_id: value.result_id.clone(),
        ready: false,
        delivery_requirement: Some(ContinuousWorkDeliveryRequirement::Unobserved),
        required_delivery_state: None,
        artifact_refs: value
            .artifact_refs
            .iter()
            .take(kcoder_types::continuous_work::MAX_RESULT_REFERENCES)
            .cloned()
            .collect(),
    })
}

fn observe(
    engine: &QueryEngine,
    request: ReadRequest,
    principal: Option<String>,
    allow_partial: bool,
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
    let output = match (request, store) {
        (ReadRequest::List(params), Some(store)) => {
            let allow_partial = allow_partial && params.allow_partial == Some(true);
            // Whole-index corruption must not hide every readable record when
            // the client explicitly accepted a partial page.
            let (records, next_cursor, mut partial) = match store.list_for_scope(
                host.scope(),
                params.cursor.as_deref(),
                params.updated_after_ms,
                params.phase.as_ref(),
                params.query.as_deref(),
            ) {
                Ok(page) => (page.items, page.next_after_work_id, false),
                Err(error) if allow_partial => {
                    let report = store.list_for_scope_isolated(host.scope())?;
                    tracing::warn!(
                        %error,
                        unreadable = report.unreadable.len(),
                        "work list fell back to per-record isolation"
                    );
                    // Cursor and filters were not applied on this path.
                    (report.readable, None, true)
                }
                Err(error) => return Err(error),
            };
            let mut items = Vec::with_capacity(records.len());
            for work in records {
                match project(engine, None, work) {
                    Ok(view) => items.push(view),
                    Err(_) if allow_partial => {
                        partial = true;
                    }
                    Err(error) => return Err(error),
                }
            }
            let result = ContinuousWorkListResult {
                items,
                next_cursor,
                partial: partial.then_some(true),
            };
            result.validate_observation().map_err(anyhow::Error::msg)?;
            serde_json::to_value(result)?
        }
        (ReadRequest::List(_), None) => serde_json::to_value(ContinuousWorkListResult {
            items: Vec::new(),
            next_cursor: None,
            partial: None,
        })?,
        (ReadRequest::Read(params), store) => {
            let work = match store.as_ref() {
                Some(store) => store.read_work(host.scope(), &params.work_id)?,
                None => None,
            };
            let (work, presence) = match work {
                Some(work) => match project(engine, store.as_ref(), work) {
                    Ok(view) => (Some(view), ContinuousWorkPresence::Present),
                    Err(_) => (None, ContinuousWorkPresence::Unreadable),
                },
                None => (None, ContinuousWorkPresence::ConfirmedAbsent),
            };
            let result = ContinuousWorkReadResult {
                work,
                presence: Some(presence),
            };
            result.validate_observation().map_err(anyhow::Error::msg)?;
            serde_json::to_value(result)?
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

pub struct ReadAccess<'a> {
    pub enabled: bool,
    pub partial_list: bool,
    pub tasks: &'a mut JoinSet<()>,
}

pub async fn dispatch(
    method: &str,
    id: &Value,
    params: &Value,
    engine: &QueryEngine,
    outbound: &mpsc::Sender<Value>,
    access: ReadAccess<'_>,
) -> Result<bool> {
    if !matches!(method, method::LIST | method::READ) {
        return Ok(false);
    }
    if !access.enabled {
        send(
            outbound,
            error_response(
                id.clone(),
                -32601,
                "continuous work read was not negotiated",
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
                error_response(id.clone(), -32602, "invalid continuous work read"),
            )
            .await?;
            return Ok(true);
        }
    };
    if matches!(&request, ReadRequest::List(params) if params.allow_partial == Some(true))
        && !access.partial_list
    {
        send(
            outbound,
            error_response(id.clone(), -32602, "partial work list was not negotiated"),
        )
        .await?;
        return Ok(true);
    }
    let principal = match std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(_) => {
            send(
                outbound,
                error_response(id.clone(), -32043, "continuous work read unavailable"),
            )
            .await?;
            return Ok(true);
        }
    };
    let permit = if access.tasks.len() < CONNECTION_LIMIT {
        READ_PERMITS.clone().try_acquire_owned().ok()
    } else {
        None
    };
    let Some(permit) = permit else {
        send(
            outbound,
            error_response(id.clone(), -32043, "continuous work read busy"),
        )
        .await?;
        return Ok(true);
    };
    let engine = engine.clone();
    let id = id.clone();
    let outbound = outbound.clone();
    let allow_partial = access.partial_list;
    access.tasks.spawn_blocking(move || {
        let _permit = permit;
        let response = match observe(&engine, request, principal, allow_partial) {
            Ok(value) => success_response(id, value),
            Err(_) => error_response(id, -32043, "continuous work read unavailable"),
        };
        let _ = outbound.blocking_send(response);
    });
    Ok(true)
}

#[cfg(test)]
#[path = "continuous_work_read.test.rs"]
mod tests;

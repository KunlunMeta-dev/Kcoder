//! Target-side routed ReadSession. The authenticated private router proves the source
//! identity; this owner decides from its own current `read_access`, visibility and
//! storage on every call, then projects, redacts and bounds the window before it
//! leaves. Nothing here loads, wakes, leases or writes the target conversation.
use super::read::{load_history, overlay_live};
use super::read_projection::{Artifacts, Options, project_turns};
use super::session_directory::{DirectorySourceView, ReadLookup, SessionDirectory};
use crate::app_server::session_messages::service::PeerMessageService;
use crate::app_server::{ResidentTurnState, ThreadManager};
use anyhow::{Context as _, Result, ensure};
use kcoder_app_protocol::cross_session_messages::SessionReadRpcParams;
use kcoder_app_protocol::cross_session_router::PrivatePeerRouteProofV1;
use kcoder_cli_storage::session_lease::DeferredSessionLeaseWitness;
use kcoder_config::SessionReadAccess;
use kcoder_engine::QueryEngine;
use kcoder_state::AppStateLifecycleIdentity;
use kcoder_tools::session_read::{
    SessionReadError, SessionReadOutcome, SessionReadResult, fit_wire_result, select_window,
};
use kcoder_types::session_address::SessionAddressV1;
use std::path::Path;

/// Serialized budget of one routed result. The source tool still renders at most
/// 64 KiB; this keeps the private router frame well under its 2 MiB line limit.
pub(crate) const MAX_ROUTED_READ_BYTES: usize = 96 * 1024;

pub(crate) struct ResidentTarget {
    engine: QueryEngine,
    owner: AppStateLifecycleIdentity,
    lease: DeferredSessionLeaseWitness,
    turn_state: Option<ResidentTurnState>,
}

/// Identities captured in the owner's select loop; disk work happens in `execute`.
pub(crate) enum Capture {
    Saved,
    /// Loaded but not an independent conversation of this workspace (ephemeral,
    /// sub-agent, other storage or no current lease): reported as absent.
    Hidden,
    Resident(Box<ResidentTarget>),
}

pub(in crate::app_server) fn capture(
    manager: &ThreadManager,
    thread_id: &str,
    workspace: &Path,
    storage: &Path,
) -> Capture {
    let Some(engine) = manager.engine(thread_id) else {
        return Capture::Saved;
    };
    let eligible = !manager.is_ephemeral(thread_id)
        && engine.is_independent_discovery_session()
        && engine.state.cwd() == workspace
        && engine.client_storage_root() == storage;
    let held = eligible
        .then(|| {
            Some((
                engine.state.try_inspection_lifecycle_identity()?,
                manager
                    .lease(thread_id)?
                    .deferred_witness(&engine.session_lease_target())?,
            ))
        })
        .flatten();
    match held {
        Some((owner, lease)) => Capture::Resident(Box::new(ResidentTarget {
            turn_state: manager.turn_state(thread_id),
            engine,
            owner,
            lease,
        })),
        None => Capture::Hidden,
    }
}

/// Facts the router RPC owner supplies; the proof was already authorized for this
/// destination and `verify` rechecks that authorization.
pub(crate) struct Context<'a> {
    pub service: &'a PeerMessageService,
    pub workspace: &'a Path,
    pub storage: &'a Path,
    pub history: Option<&'a Path>,
    pub proof: &'a PrivatePeerRouteProofV1,
    pub binding: &'a str,
    pub verify: &'a (dyn Fn() -> Result<()> + Send + Sync),
}

fn refused(error: SessionReadError) -> Result<SessionReadOutcome> {
    Ok(SessionReadOutcome::Refused { refused: error.0 })
}

/// The owner's current policy for this proven source. A peer on another runtime target
/// or workspace can never prove "same project" (no shared filesystem is assumed), so
/// only `same_account` admits it; the router already bound both ends to one account.
fn permitted(access: SessionReadAccess, same_workspace: bool) -> Option<SessionReadError> {
    match access {
        SessionReadAccess::None => Some(SessionReadError::NOT_PERMITTED),
        SessionReadAccess::SameProject if !same_workspace => Some(SessionReadError::OTHER_PROJECT),
        _ => None,
    }
}

struct Source {
    entries: Vec<kcoder_state::HistoryEntry>,
    title: Option<String>,
    archived: bool,
    live: Option<(kcoder_types::TurnAttemptIdentity, Option<ResidentTurnState>)>,
    resident: bool,
}

fn read_resident(target: &ResidentTarget) -> Result<Source, SessionReadError> {
    let engine = &target.engine;
    if target.owner.try_matches(&engine.state) != Some(true)
        || target
            .lease
            .verify_target(&engine.session_lease_target())
            .is_err()
    {
        return Err(SessionReadError::UNAVAILABLE);
    }
    let path = engine
        .state
        .history_path()
        .ok_or(SessionReadError::UNAVAILABLE)?;
    let entries = load_history(&path, true)?;
    let snapshot = crate::app_server::thread_metadata::thread_snapshot_with_metadata_policy(
        engine, false, true,
    )
    .ok()
    .and_then(|value| serde_json::from_value::<kcoder_app_protocol::Thread>(value).ok());
    let live = engine
        .owned_turn_observer()
        .current_identity()
        .ok()
        .flatten()
        .map(|identity| (identity, target.turn_state.clone()));
    Ok(Source {
        entries,
        title: snapshot.as_ref().and_then(|thread| thread.title.clone()),
        archived: snapshot.is_some_and(|thread| thread.archived_at.is_some()),
        live,
        resident: true,
    })
}

fn read_saved(context: &Context<'_>, id: &str) -> Result<Source, SessionReadError> {
    let view = DirectorySourceView::from_host(
        context.workspace,
        context.storage,
        context.history,
        context.binding,
        context.verify,
    )
    .map_err(|_| SessionReadError::UNAVAILABLE)?;
    let lookup = SessionDirectory::lookup_read_view(&view, id).map_err(|error| {
        match error.to_string().as_str() {
            "session_directory_invalid_target" => SessionReadError::NOT_FOUND,
            _ => SessionReadError::UNAVAILABLE,
        }
    })?;
    let target = match lookup {
        // A routed reader sees exactly this endpoint's workspace, as ListSessions does.
        ReadLookup::Found(target) if target.same_workspace => target,
        _ => return Err(SessionReadError::NOT_FOUND),
    };
    let entries = load_history(&target.session.history_path(), false)?;
    target
        .session
        .verify(&view)
        .map_err(|_| SessionReadError::UNAVAILABLE)?;
    let row = target.session.observation();
    Ok(Source {
        entries,
        title: row.title.clone(),
        archived: row.archived_at.is_some(),
        live: None,
        resident: false,
    })
}

/// `Ok(Refused)` is the owner's typed decision; `Err` is an unconfirmed failure.
pub(crate) fn execute(
    context: &Context<'_>,
    params: SessionReadRpcParams,
    target: Capture,
) -> Result<SessionReadOutcome> {
    params.validate().map_err(anyhow::Error::msg)?;
    let own = context.service.identity()?;
    let address = params
        .read
        .target_address
        .clone()
        .context("peer_router_read_address_required")?;
    ensure!(
        own.contains(&address) && context.proof.destination.contains(&address),
        "peer_router_read_destination_changed"
    );
    let source = SessionAddressV1 {
        target_id: context.proof.source.target_id.clone(),
        workspace_id: context.proof.source.workspace_id.clone(),
        thread_id: params.source_thread_id.clone(),
    };
    source.validate().map_err(anyhow::Error::msg)?;
    if source == address {
        return refused(SessionReadError::SELF_READ);
    }
    // The owner's current account policy, read now; never a saved verdict.
    let settings = match context.service.admission_settings() {
        Ok(settings) => settings,
        Err(error) if error.to_string() == "peer_message_policy_denied" => {
            return refused(SessionReadError::NOT_PERMITTED);
        }
        Err(error) => return Err(error),
    };
    let same_workspace =
        source.target_id == own.target_id && source.workspace_id == own.workspace_id;
    if let Some(error) = permitted(settings.read_access, same_workspace) {
        return refused(error);
    }
    let id = params.read.thread_id.as_str();
    let read = match &target {
        Capture::Hidden => Err(SessionReadError::NOT_FOUND),
        Capture::Resident(resident) => read_resident(resident),
        Capture::Saved => read_saved(context, id),
    };
    let source_view = match read {
        Ok(source) => source,
        Err(error) if error == SessionReadError::UNAVAILABLE => {
            anyhow::bail!("peer_router_read_unavailable")
        }
        Err(error) => return refused(error),
    };
    let session_dir = kcoder_state::session_dir_path(context.storage, id);
    let attempts =
        crate::app_server::turn_attempts::records_in(&session_dir, id).unwrap_or_default();
    let bindings =
        crate::app_server::turn_admissions::bindings_in(&session_dir, id).unwrap_or_default();
    let outcomes = crate::app_server::load_turn_outcomes_in(&session_dir, id);
    let options = Options {
        include_outputs: params.read.include_outputs,
        include_attachments: params.read.include_attachments,
    };
    let mut turns = project_turns(
        source_view.entries,
        &Artifacts {
            thread_id: id,
            attempts: &attempts,
            bindings: &bindings,
            outcomes: &outcomes,
        },
        options,
    );
    if let Some((identity, state)) = &source_view.live {
        overlay_live(&mut turns, identity, state.as_ref(), options);
    }
    let (turns, has_earlier_turns) = match select_window(turns, &params.read) {
        Ok(window) => window,
        Err(error) => return refused(error),
    };
    let mut result = SessionReadResult {
        thread_id: id.to_owned(),
        address: Some(address),
        title: source_view.title,
        archived: source_view.archived,
        resident: source_view.resident,
        other_workspace: false,
        other_target: false,
        turns,
        has_earlier_turns,
    };
    ensure!(
        fit_wire_result(&mut result, MAX_ROUTED_READ_BYTES),
        "peer_router_read_result_limit"
    );
    (context.verify)()?;
    Ok(SessionReadOutcome::Read {
        result: Box::new(result),
    })
}

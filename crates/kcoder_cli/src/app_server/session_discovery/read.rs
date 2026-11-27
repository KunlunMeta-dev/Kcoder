//! Target-side ReadSession. Every call rechecks the real source, the target's visibility
//! and the target owner's current read policy, then projects saved history (plus the
//! resident live turn) without loading, waking, leasing or writing the target.
use super::read_projection::{Artifacts, Options, project_turns};
use super::session_directory::{DirectorySourceView, ReadLookup, SessionDirectory};
use super::{Scope, ThreadManager};
use crate::app_server::ResidentTurnState;
use kcoder_config::SessionReadAccess;
use kcoder_engine::QueryEngine;
use kcoder_state::{AppStateLifecycleIdentity, HistoryEntry};
use kcoder_tools::session_discovery::SessionDiscoveryCall;
use kcoder_tools::session_read::{
    SessionReadError, SessionReadItem, SessionReadItemKind, SessionReadParams, SessionReadResult,
    SessionReadRoute, SessionReadTurn, SessionReadTurnStatus, bound_result, select_window,
};
use std::path::Path;
use tokio::sync::oneshot;

const MAX_HISTORY_BYTES: usize = 128 * 1024 * 1024;
const MAX_HISTORY_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_HISTORY_RECORDS: usize = 100_000;

pub(crate) struct ReadRequest {
    pub(super) call: SessionDiscoveryCall,
    pub(super) scope: Scope,
    pub(super) params: SessionReadParams,
    pub(super) route: SessionReadRoute,
    pub(super) reply: oneshot::Sender<Result<SessionReadResult, SessionReadError>>,
}

pub(crate) struct ReadCompleted {
    request: ReadRequest,
    result: Result<SessionReadResult, SessionReadError>,
}

struct Resident {
    engine: QueryEngine,
    owner: AppStateLifecycleIdentity,
    turn_state: Option<ResidentTurnState>,
}

enum Plan {
    Resident(Box<Resident>),
    Saved,
}

pub(super) struct Prepared {
    request: ReadRequest,
    origin: QueryEngine,
    access: SessionReadAccess,
    other_workspace: bool,
    plan: Plan,
}

fn same_path(left: &Path, right: &Path) -> bool {
    left == right
        || matches!(
            (dunce::canonicalize(left), dunce::canonicalize(right)),
            (Ok(left), Ok(right)) if left == right
        )
}

/// The source must still be the original independent session with this exact tool
/// contribution and no explicit deny; nothing here is cached between calls.
fn verify_source(
    request: &ReadRequest,
    manager: &ThreadManager,
) -> Result<QueryEngine, SessionReadError> {
    let call = &request.call;
    let id = call.state().session_id();
    let engine = manager.engine(&id).ok_or(SessionReadError::UNAVAILABLE)?;
    let input = serde_json::to_value(&request.params).map_err(|_| SessionReadError::UNAVAILABLE)?;
    let valid = call.tool_name() == "ReadSession"
        && call.matches(&engine.state)
        && request.scope.matches(&engine)
        && !manager.is_ephemeral(&id)
        && engine.is_independent_discovery_session()
        && manager.lease(&id).is_some_and(|lease| {
            lease.matches_target(&engine.session_lease_target()) && lease.native_witness().is_ok()
        })
        && engine
            .active_tool_registry()
            .get("ReadSession")
            .is_some_and(|tool| call.matches_registered_tool(tool.as_ref()))
        && engine.permissions.try_read().is_ok_and(|permissions| {
            !permissions.is_explicitly_denied("ReadSession", &input)
                && !permissions.is_explicitly_denied("ReadSession", &serde_json::json!({}))
        });
    valid.then_some(engine).ok_or(SessionReadError::UNAVAILABLE)
}

fn permitted(access: SessionReadAccess, same_workspace: bool) -> Result<(), SessionReadError> {
    match access {
        SessionReadAccess::None => Err(SessionReadError::NOT_PERMITTED),
        SessionReadAccess::SameProject if !same_workspace => Err(SessionReadError::OTHER_PROJECT),
        _ => Ok(()),
    }
}

pub(super) fn prepare(
    request: ReadRequest,
    manager: &ThreadManager,
) -> Result<Prepared, Box<(ReadRequest, SessionReadError)>> {
    let result = (|| {
        let origin = verify_source(&request, manager)?;
        let id = request.params.thread_id.as_str();
        if id == origin.session_id() {
            return Err(SessionReadError::SELF_READ);
        }
        let access = match request.route.read_access {
            Some(access) => access,
            None => {
                origin
                    .settings
                    .read()
                    .map_err(|_| SessionReadError::UNAVAILABLE)?
                    .cross_session_messages
                    .read_access
            }
        };
        if access == SessionReadAccess::None {
            return Err(SessionReadError::NOT_PERMITTED);
        }
        let Some(engine) = manager.engine(id) else {
            return Ok((origin, access, false, Plan::Saved));
        };
        // A loaded target is read only through its actual owner: same account storage,
        // independent kind and a current lease. Anything else is reported as absent.
        let owner = engine.state.try_inspection_lifecycle_identity();
        let visible = !manager.is_ephemeral(id)
            && engine.is_independent_discovery_session()
            && engine.client_storage_root() == request.scope.storage
            && manager.lease(id).is_some_and(|lease| {
                lease.matches_target(&engine.session_lease_target())
                    && lease.native_witness().is_ok()
            });
        let (true, Some(owner)) = (visible, owner) else {
            return Err(SessionReadError::NOT_FOUND);
        };
        let same_workspace = same_path(&engine.state.cwd(), &request.scope.cwd);
        permitted(access, same_workspace)?;
        Ok((
            origin,
            access,
            !same_workspace,
            Plan::Resident(Box::new(Resident {
                turn_state: manager.turn_state(id),
                engine,
                owner,
            })),
        ))
    })();
    match result {
        Ok((origin, access, other_workspace, plan)) => Ok(Prepared {
            request,
            origin,
            access,
            other_workspace,
            plan,
        }),
        Err(error) => Err(Box::new((request, error))),
    }
}

pub(super) fn load_history(
    path: &Path,
    resident: bool,
) -> Result<Vec<HistoryEntry>, SessionReadError> {
    let mut attempts = 0;
    loop {
        match kcoder_state::load_transcript_history_bounded(
            path,
            MAX_HISTORY_BYTES,
            MAX_HISTORY_LINE_BYTES,
            MAX_HISTORY_RECORDS,
        ) {
            Ok(entries) => return Ok(entries),
            // A newly loaded conversation may not have its first record yet.
            Err(error) if resident && kcoder_turn_evidence::error_is_not_found(&error) => {
                return Ok(Vec::new());
            }
            // The owner appends whole records; retry briefly over a tail being written.
            Err(_) if resident && attempts < 3 => {
                attempts += 1;
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(_) => return Err(SessionReadError::UNAVAILABLE),
        }
    }
}

struct Source {
    entries: Vec<HistoryEntry>,
    title: Option<String>,
    archived: bool,
    other_workspace: bool,
    live: Option<(kcoder_types::TurnAttemptIdentity, Option<ResidentTurnState>)>,
}

fn read_saved(prepared: &Prepared) -> Result<Source, SessionReadError> {
    let call = &prepared.request.call;
    let view = DirectorySourceView::from_state(
        &prepared.origin.state,
        call.lifecycle(),
        &prepared.origin.client_storage_root(),
    );
    let lookup = SessionDirectory::lookup_read_view(&view, &prepared.request.params.thread_id)
        .map_err(|error| match error.to_string().as_str() {
            "session_directory_invalid_target" => SessionReadError::NOT_FOUND,
            _ => SessionReadError::UNAVAILABLE,
        })?;
    let target = match lookup {
        ReadLookup::Found(target) => target,
        ReadLookup::Missing | ReadLookup::Hidden => return Err(SessionReadError::NOT_FOUND),
    };
    permitted(prepared.access, target.same_workspace)?;
    let entries = load_history(&target.session.history_path(), false)?;
    // The held history identity must be unchanged after the read.
    target
        .session
        .verify(&view)
        .map_err(|_| SessionReadError::UNAVAILABLE)?;
    let row = target.session.observation();
    Ok(Source {
        entries,
        title: row.title.clone(),
        archived: row.archived_at.is_some(),
        other_workspace: !target.same_workspace,
        live: None,
    })
}

fn read_resident(prepared: &Prepared, resident: &Resident) -> Result<Source, SessionReadError> {
    let engine = &resident.engine;
    if resident.owner.try_matches(&engine.state) != Some(true) {
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
        .map(|identity| (identity, resident.turn_state.clone()));
    Ok(Source {
        entries,
        title: snapshot.as_ref().and_then(|thread| thread.title.clone()),
        archived: snapshot.is_some_and(|thread| thread.archived_at.is_some()),
        other_workspace: prepared.other_workspace,
        live,
    })
}

/// Mark the active turn running and append its not-yet-committed content: the accepted
/// user input before it is appended, and the assistant text streamed so far.
pub(super) fn overlay_live(
    turns: &mut Vec<SessionReadTurn>,
    identity: &kcoder_types::TurnAttemptIdentity,
    state: Option<&ResidentTurnState>,
    options: Options,
) {
    let position = match turns
        .iter()
        .position(|turn| turn.turn_id == identity.turn_id)
    {
        Some(position) => position,
        None => {
            let mut turn = SessionReadTurn {
                turn_id: identity.turn_id.clone(),
                status: SessionReadTurnStatus::Running,
                partial: true,
                started_at_ms: None,
                ended_at_ms: None,
                items: Vec::new(),
                omitted_items: 0,
            };
            if let Some(input) = state
                .and_then(ResidentTurnState::accepted_input)
                .filter(|input| &input.attempt == identity)
            {
                turn.items = super::read_projection::items_for(
                    &input.message,
                    options,
                    &mut Default::default(),
                );
            }
            turns.push(turn);
            turns.len() - 1
        }
    };
    let turn = &mut turns[position];
    turn.status = SessionReadTurnStatus::Running;
    turn.partial = true;
    turn.ended_at_ms = None;
    let Some((text, truncated_front)) = state.and_then(|state| state.live_assistant_text(identity))
    else {
        return;
    };
    let duplicate = turn.items.last().is_some_and(|item| {
        item.kind == SessionReadItemKind::AssistantMessage
            && item.text.trim_end().ends_with(text.trim_end())
    });
    if !duplicate && !text.trim().is_empty() {
        turn.items.push(SessionReadItem {
            partial: true,
            truncated_front,
            ..SessionReadItem::text(SessionReadItemKind::AssistantMessage, text)
        });
    }
}

pub(super) fn run(prepared: Prepared) -> ReadCompleted {
    let result = (|| {
        if prepared.request.reply.is_closed() {
            return Err(SessionReadError::UNAVAILABLE);
        }
        let source = match &prepared.plan {
            Plan::Saved => read_saved(&prepared)?,
            Plan::Resident(resident) => read_resident(&prepared, resident)?,
        };
        let params = &prepared.request.params;
        let id = params.thread_id.as_str();
        let attempts =
            crate::app_server::turn_attempts::records(&prepared.origin, id).unwrap_or_default();
        let bindings =
            crate::app_server::turn_admissions::bindings(&prepared.origin, id).unwrap_or_default();
        let outcomes = crate::app_server::load_turn_outcomes(&prepared.origin, id);
        let options = Options {
            include_outputs: params.include_outputs,
            include_attachments: params.include_attachments,
        };
        let mut turns = project_turns(
            source.entries,
            &Artifacts {
                thread_id: id,
                attempts: &attempts,
                bindings: &bindings,
                outcomes: &outcomes,
            },
            options,
        );
        let resident = source.live.is_some() || matches!(prepared.plan, Plan::Resident(_));
        if let Some((identity, state)) = &source.live {
            overlay_live(&mut turns, identity, state.as_ref(), options);
        }
        let (turns, has_earlier_turns) = select_window(turns, params)?;
        let mut result = SessionReadResult {
            thread_id: id.to_owned(),
            address: prepared.request.route.address.clone(),
            title: source.title,
            archived: source.archived,
            resident,
            other_workspace: source.other_workspace,
            other_target: false,
            turns,
            has_earlier_turns,
        };
        bound_result(&mut result);
        Ok(result)
    })();
    ReadCompleted {
        request: prepared.request,
        result,
    }
}

pub(super) fn publish(completed: ReadCompleted, manager: &ThreadManager) {
    let result = verify_source(&completed.request, manager).and(completed.result);
    let _ = completed.request.reply.send(result);
}

pub(super) fn reject(request: ReadRequest, error: SessionReadError) {
    let _ = request.reply.send(Err(error));
}

//! Owned target-side discovery, merging resident facts with bounded persistent observations.
use super::{ThreadManager, thread_metadata};
use kcoder_app_protocol::cross_session_messages::*;
use kcoder_engine::QueryEngine;
use kcoder_state::AppStateLifecycleIdentity;
use kcoder_tools::{
    ToolError,
    session_discovery::{SessionDiscoveryCall, SessionDiscoveryHost},
};
#[cfg(test)]
use std::time::{Duration, Instant};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
};
use tokio::sync::{mpsc, oneshot};

#[path = "session_discovery/read.rs"]
mod read;
#[path = "session_discovery/read_projection.rs"]
mod read_projection;
#[path = "session_discovery/routed_read.rs"]
pub(crate) mod routed_read;
#[path = "session_directory/mod.rs"]
pub(crate) mod session_directory;

const MAX_REQUESTS: usize = 32;
const MAX_RESIDENTS: usize = 1024;

/// Older Gateways accept only an optional cursor. Never turn a requested filter into an unfiltered read.
pub(crate) fn gateway_search_input(
    mut input: serde_json::Value,
    supports_search: bool,
) -> Result<serde_json::Value, ToolError> {
    if supports_search {
        return Ok(input);
    }
    let unsupported = || {
        ToolError::Execution(
        "session_discovery_search_unsupported: upgrade the source Gateway, or use the default unfiltered list".into(),
    )
    };
    let fields = input.as_object_mut().ok_or_else(unsupported)?;
    if fields.get("limit").and_then(serde_json::Value::as_u64)
        == Some(kcoder_types::cross_session_messages::DEFAULT_DISCOVERY_PAGE_SIZE as u64)
    {
        fields.remove("limit");
    }
    if fields.keys().any(|key| key != "cursor") {
        return Err(unsupported());
    }
    Ok(input)
}

#[derive(Clone, PartialEq, Eq)]
struct Scope {
    cwd: PathBuf,
    storage: PathBuf,
}
impl Scope {
    fn capture(engine: &QueryEngine) -> Self {
        Self {
            cwd: engine.state.cwd(),
            storage: engine.client_storage_root(),
        }
    }
    fn matches(&self, engine: &QueryEngine) -> bool {
        self.cwd == engine.state.cwd() && self.storage == engine.client_storage_root()
    }
}
pub(super) struct ListRequest {
    call: SessionDiscoveryCall,
    scope: Scope,
    cursor: Option<String>,
    reply: oneshot::Sender<Result<serde_json::Value, ToolError>>,
}
/// Both operations share this connection's bounded worker pool and owner checks.
pub(super) enum Request {
    List(Box<ListRequest>),
    Read(Box<read::ReadRequest>),
}
#[cfg(test)]
impl Request {
    fn call(&self) -> &SessionDiscoveryCall {
        match self {
            Self::List(request) => &request.call,
            Self::Read(request) => &request.call,
        }
    }
}
/// Only known read-only routing diagnostics become model-facing recovery advice.
pub(crate) fn router_read_rejection(reason: &str) -> Option<&'static str> {
    match reason {
        "AGENT_MESSAGES_CURSOR_INVALID" => {
            Some("session_discovery_cursor_invalid: start a new search without cursor")
        }
        "AGENT_MESSAGES_CURSOR_FILTER_MISMATCH" => {
            Some("session_discovery_cursor_filter_mismatch: omit cursor when changing filters")
        }
        "AGENT_MESSAGES_DISCOVERY_SEARCH_UNSUPPORTED" => Some(
            "session_discovery_search_unsupported: upgrade the selected target, or use the default unfiltered list",
        ),
        _ => None,
    }
}

pub(crate) fn directory_read_error(error: &anyhow::Error, fallback: &'static str) -> ToolError {
    let message = match error.to_string().as_str() {
        "session_directory_invalid_cursor" => {
            "session_discovery_cursor_invalid: start a new search without cursor"
        }
        "ListSessions cursor belongs to different filters; start a new search" => {
            "session_discovery_cursor_filter_mismatch: omit cursor when changing filters"
        }
        _ => fallback,
    };
    ToolError::Execution(message.into())
}
struct Client {
    sender: mpsc::Sender<Request>,
    scope: Scope,
}
#[async_trait::async_trait]
impl SessionDiscoveryHost for Client {
    async fn list(
        &self,
        call: SessionDiscoveryCall,
        cursor: Option<String>,
    ) -> Result<serde_json::Value, ToolError> {
        let (reply, result) = oneshot::channel();
        self.sender
            .try_send(Request::List(Box::new(ListRequest {
                call,
                scope: self.scope.clone(),
                cursor,
                reply,
            })))
            .map_err(|_| unavailable("session_discovery_host_busy"))?;
        result
            .await
            .map_err(|_| unavailable("session_discovery_host_disconnected"))?
    }
    fn supports_read(&self) -> bool {
        true
    }
    /// Without a peer identity this host cannot prove that an address is its own.
    async fn read(
        &self,
        call: SessionDiscoveryCall,
        params: kcoder_tools::session_read::SessionReadParams,
    ) -> Result<
        kcoder_tools::session_read::SessionReadResult,
        kcoder_tools::session_read::SessionReadError,
    > {
        if params.target_address.is_some() {
            return Err(kcoder_tools::session_read::SessionReadError::UNSUPPORTED_TARGET);
        }
        self.read_routed(call, params, Default::default()).await
    }
    async fn read_routed(
        &self,
        call: SessionDiscoveryCall,
        params: kcoder_tools::session_read::SessionReadParams,
        route: kcoder_tools::session_read::SessionReadRoute,
    ) -> Result<
        kcoder_tools::session_read::SessionReadResult,
        kcoder_tools::session_read::SessionReadError,
    > {
        use kcoder_tools::session_read::SessionReadError;
        let (reply, result) = oneshot::channel();
        self.sender
            .try_send(Request::Read(Box::new(read::ReadRequest {
                call,
                scope: self.scope.clone(),
                params,
                route,
                reply,
            })))
            .map_err(|_| SessionReadError::UNAVAILABLE)?;
        result.await.map_err(|_| SessionReadError::UNAVAILABLE)?
    }
}
pub(super) fn channel(
    origin: &QueryEngine,
) -> (Arc<dyn SessionDiscoveryHost>, mpsc::Receiver<Request>) {
    let (sender, receiver) = mpsc::channel(MAX_REQUESTS);
    (
        Arc::new(Client {
            sender,
            scope: Scope::capture(origin),
        }),
        receiver,
    )
}
fn unavailable(code: &str) -> ToolError {
    ToolError::Execution(code.into())
}
#[derive(Default)]
pub(super) struct DiscoveryPages {
    directory: Arc<std::sync::Mutex<session_directory::SessionDirectory>>,
}
fn source(request: &ListRequest, manager: &ThreadManager) -> Result<QueryEngine, ToolError> {
    let id = request.call.state().session_id();
    let engine = manager
        .engine(&id)
        .ok_or_else(|| unavailable("session_discovery_source_unavailable"))?;
    if !request.call.matches(&engine.state)
        || !request.scope.matches(&engine)
        || manager.is_ephemeral(&id)
        || !engine.is_independent_discovery_session()
        || !manager.lease(&id).is_some_and(|lease| {
            let target = engine.session_lease_target();
            lease.matches_target(&target) && lease.native_witness().is_ok()
        })
        || !engine
            .active_tool_registry()
            .get("ListSessions")
            .is_some_and(|tool| request.call.matches_registered_tool(tool.as_ref()))
    {
        return Err(unavailable("session_discovery_source_unavailable"));
    }
    let input = request.call.input(request.cursor.as_deref());
    let allowed = engine.permissions.try_read().ok().map(|permissions| {
        !permissions.is_explicitly_denied("ListSessions", &input)
            && !permissions.is_explicitly_denied("ListSessions", &serde_json::json!({}))
            && (request.cursor.is_some()
                || !permissions
                    .is_explicitly_denied("ListSessions", &serde_json::json!({"cursor":null})))
    });
    if allowed != Some(true) {
        return Err(unavailable("session_discovery_source_unavailable"));
    }
    Ok(engine)
}
fn eligible(scope: &Scope, source: &str, engine: &QueryEngine, manager: &ThreadManager) -> bool {
    let id = engine.session_id();
    id != source
        && !manager.is_ephemeral(&id)
        && engine.is_independent_discovery_session()
        && scope.matches(engine)
        && manager.lease(&id).is_some_and(|lease| {
            let target = engine.session_lease_target();
            lease.matches_target(&target) && lease.native_witness().is_ok()
        })
}
struct Candidate {
    id: String,
    engine: QueryEngine,
    owner: AppStateLifecycleIdentity,
    facts: Option<kcoder_app_protocol::ThreadRunFacts>,
}
pub(super) enum Completed {
    List(Box<ListCompleted>),
    Read(Box<read::ReadCompleted>),
}
pub(super) struct ListCompleted {
    request: ListRequest,
    rows: Vec<(Option<AppStateLifecycleIdentity>, AgentMessageTarget)>,
    next_cursor: Option<String>,
    coverage: AgentMessageDiscoveryCoverage,
    completeness: AgentMessageDiscoveryCompleteness,
    issue_count: u32,
    proof: Option<Arc<session_directory::DirectoryScope>>,
    search: SessionDiscoveryQuery,
    error: Option<ToolError>,
}
struct Prepared {
    request: ListRequest,
    origin: QueryEngine,
    candidates: HashMap<String, Candidate>,
    excluded: HashSet<String>,
    directory: Arc<std::sync::Mutex<session_directory::SessionDirectory>>,
}
fn prepare(
    request: ListRequest,
    manager: &ThreadManager,
    pages: &mut DiscoveryPages,
) -> Result<Prepared, Box<(ListRequest, ToolError)>> {
    let origin = match source(&request, manager) {
        Ok(origin) => origin,
        Err(error) => return Err(Box::new((request, error))),
    };
    let engines = manager.resident_engines();
    if engines.len() > MAX_RESIDENTS {
        return Err(Box::new((
            request,
            unavailable("session_discovery_capacity_exceeded"),
        )));
    }
    let mut candidates = HashMap::new();
    let mut excluded = HashSet::new();
    for engine in engines {
        let id = engine.session_id();
        if eligible(&request.scope, &origin.session_id(), &engine, manager)
            && let Some(owner) = engine.state.try_inspection_lifecycle_identity()
        {
            let facts = manager.thread_run_facts(&id);
            candidates.insert(
                id.clone(),
                Candidate {
                    id,
                    engine,
                    owner,
                    facts,
                },
            );
        } else {
            // Never retry a forbidden or ephemeral resident through its persisted path.
            excluded.insert(id);
        }
    }
    Ok(Prepared {
        request,
        origin,
        candidates,
        excluded,
        directory: pages.directory.clone(),
    })
}
fn observe(prepared: Prepared) -> ListCompleted {
    let mut completed = ListCompleted {
        search: prepared.request.call.search().clone(),
        request: prepared.request,
        rows: Vec::new(),
        next_cursor: None,
        coverage: AgentMessageDiscoveryCoverage::WorkspaceHistory,
        completeness: AgentMessageDiscoveryCompleteness::Unknown,
        issue_count: 0,
        proof: None,
        error: None,
    };
    if completed.request.reply.is_closed() {
        return completed;
    }
    let residents = prepared.candidates.keys().cloned().collect::<Vec<_>>();
    let view = session_directory::DirectorySourceView::from_state(
        &prepared.origin.state,
        completed.request.call.lifecycle(),
        &prepared.origin.client_storage_root(),
    );
    let page = prepared
        .directory
        .try_lock()
        .map_err(|_| unavailable("session_discovery_host_busy"))
        .and_then(|mut directory| {
            directory
                .page_view_query(
                    &view,
                    completed.request.cursor.as_deref(),
                    &residents,
                    &prepared.excluded,
                    &completed.search,
                    |entry, _| {
                        anyhow::ensure!(
                            !completed.request.reply.is_closed(),
                            "session_discovery_cancelled"
                        );
                        match entry {
                            session_directory::DirectoryEntry::Historical(row) => {
                                Ok(Some(row.as_ref().clone()))
                            }
                            session_directory::DirectoryEntry::Resident(id) => {
                                Ok(prepared.candidates.get(id).and_then(|candidate| {
                                    observe_resident(candidate, &completed.request.scope)
                                }))
                            }
                        }
                    },
                )
                .map_err(|error| {
                    directory_read_error(&error, "session_discovery_directory_unavailable")
                })
        });
    let page = match page {
        Ok(page) => page,
        Err(error) => {
            completed.error = Some(error);
            return completed;
        }
    };
    completed.next_cursor = page.next_cursor;
    completed.coverage = page.coverage;
    completed.completeness = page.completeness;
    completed.issue_count = page.issue_count;
    completed.proof = Some(page.scope.clone());
    completed.search = page.query;
    for row in page.targets {
        let owner = if row.presence == AgentMessageTargetPresence::Resident {
            let Some(candidate) = prepared.candidates.get(&row.thread_id) else {
                continue;
            };
            Some(candidate.owner.clone())
        } else {
            None
        };
        completed.rows.push((owner, row));
    }
    if completed.issue_count > 0 {
        completed.completeness = AgentMessageDiscoveryCompleteness::Partial;
    }
    completed
}
fn observe_resident(candidate: &Candidate, scope: &Scope) -> Option<AgentMessageTarget> {
    if candidate.owner.try_matches(&candidate.engine.state) != Some(true)
        || !scope.matches(&candidate.engine)
    {
        return None;
    }
    let snapshot =
        thread_metadata::thread_snapshot_with_metadata_policy(&candidate.engine, false, true)
            .ok()
            .and_then(|value| serde_json::from_value::<kcoder_app_protocol::Thread>(value).ok());
    if snapshot
        .as_ref()
        .is_some_and(|thread| thread.id != candidate.id)
    {
        return None;
    }
    let facts = candidate.facts.as_ref();
    Some(AgentMessageTarget {
        address: None,
        thread_id: candidate.id.clone(),
        title: snapshot
            .as_ref()
            .and_then(|thread| thread.title.as_ref())
            .map(|title| {
                title
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(200)
                    .collect()
            }),
        status: facts.map_or(kcoder_app_protocol::ThreadStatus::Unknown, |value| {
            value.state()
        }),
        active_turn_id: None,
        presence: AgentMessageTargetPresence::Resident,
        run_summary: facts.map(|value| AgentMessageTargetRunSummary::from(&value.summary())),
        last_turn: None,
        archived_at: snapshot.and_then(|thread| thread.archived_at),
        last_history_update_at_ms: None,
        allowed_modes: Vec::new(),
    })
}
pub(super) fn publish(completed: Completed, manager: &ThreadManager) {
    match completed {
        Completed::List(completed) => publish_list(*completed, manager),
        Completed::Read(completed) => read::publish(*completed, manager),
    }
}
fn publish_list(completed: ListCompleted, manager: &ThreadManager) {
    let result = (|| {
        let origin = source(&completed.request, manager)?;
        if let Some(error) = completed.error {
            return Err(error);
        }
        if let Some(proof) = completed.proof.as_ref() {
            proof
                .verify(&origin, completed.request.call.lifecycle())
                .map_err(|_| unavailable("session_discovery_source_changed"))?;
        }
        let mut targets = Vec::new();
        let mut issues = completed.issue_count;
        for (owner, mut row) in completed.rows {
            if let Some(owner) = owner {
                let Some(engine) = manager.engine(&row.thread_id) else {
                    issues = issues.saturating_add(1);
                    continue;
                };
                if !eligible(
                    &completed.request.scope,
                    &origin.session_id(),
                    &engine,
                    manager,
                ) || owner.try_matches(&engine.state) != Some(true)
                {
                    issues = issues.saturating_add(1);
                    continue;
                }
                if let Some(facts) = manager.thread_run_facts(&row.thread_id) {
                    row.status = facts.state();
                    row.run_summary = Some(AgentMessageTargetRunSummary::from(&facts.summary()));
                }
                row.active_turn_id = engine
                    .owned_turn_observer()
                    .current_identity()
                    .ok()
                    .flatten()
                    .map(|identity| identity.turn_id);
            } else if manager.engine(&row.thread_id).is_some() {
                // A newly resident owner must be observed through its actual execution
                // scope rather than publishing a stale cold row under that same ID.
                issues = issues.saturating_add(1);
                continue;
            }
            if row.matches_query(&completed.search) {
                targets.push(row);
            }
        }
        let observed_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        serde_json::to_value(AgentMessageTargetsResult {
            coverage: completed.coverage,
            observed_at_ms,
            completeness: if issues > 0 {
                AgentMessageDiscoveryCompleteness::Partial
            } else {
                completed.completeness
            },
            issue_count: Some(issues),
            targets,
            next_cursor: completed.next_cursor,
        })
        .map_err(|_| unavailable("session_discovery_invalid_response"))
    })();
    let _ = completed.request.reply.send(result);
}
#[derive(Default)]
pub(super) struct DiscoveryJobs {
    tasks: tokio::task::JoinSet<Completed>,
}
impl DiscoveryJobs {
    pub fn start(&mut self, request: Request, manager: &ThreadManager, pages: &mut DiscoveryPages) {
        let closed = match &request {
            Request::List(request) => request.reply.is_closed(),
            Request::Read(request) => request.reply.is_closed(),
        };
        if closed {
            return;
        }
        if self.tasks.len() >= 2 {
            match request {
                Request::List(request) => {
                    let _ = request
                        .reply
                        .send(Err(unavailable("session_discovery_host_busy")));
                }
                Request::Read(request) => read::reject(
                    *request,
                    kcoder_tools::session_read::SessionReadError::UNAVAILABLE,
                ),
            }
            return;
        }
        match request {
            Request::List(request) => match prepare(*request, manager, pages) {
                Ok(prepared) => {
                    self.tasks
                        .spawn_blocking(move || Completed::List(Box::new(observe(prepared))));
                }
                Err(rejected) => {
                    let (request, error) = *rejected;
                    let _ = request.reply.send(Err(error));
                }
            },
            Request::Read(request) => match read::prepare(*request, manager) {
                Ok(prepared) => {
                    self.tasks
                        .spawn_blocking(move || Completed::Read(Box::new(read::run(prepared))));
                }
                Err(rejected) => {
                    let (request, error) = *rejected;
                    read::reject(request, error);
                }
            },
        }
    }
    pub fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }
    pub async fn next(&mut self) -> Option<Completed> {
        loop {
            match self.tasks.join_next().await? {
                Ok(completed) => return Some(completed),
                Err(_) => continue,
            }
        }
    }
    pub async fn finish(&mut self) {
        while self.tasks.join_next().await.is_some() {}
    }
}
#[cfg(test)]
async fn dispatch(request: Request, manager: &ThreadManager, pages: &mut DiscoveryPages) {
    let mut jobs = DiscoveryJobs::default();
    jobs.start(request, manager, pages);
    if let Some(completed) = jobs.next().await {
        publish(completed, manager);
    }
}

#[cfg(test)]
mod tests;

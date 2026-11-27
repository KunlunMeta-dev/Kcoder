//! Private Native route transactions, executed on the connection's owned blocking workers.
use super::{
    router_authority::{AuthorizedPeerRoute, PeerRouteEndpoint},
    router_store::{IncomingPeerOperation, verify_peer_attestation},
    service::PeerMessageService,
};
use crate::app_server::{
    session_discovery::routed_read,
    session_discovery::session_directory::{DirectoryEntry, DirectorySourceView, SessionDirectory},
    thread_metadata,
    thread_runtime::ThreadManager,
};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::{
    cross_session_messages::*,
    cross_session_router::{self as router, *},
};
use kcoder_cli_storage::session_lease::DeferredSessionLeaseWitness;
use kcoder_engine::QueryEngine;
use kcoder_state::AppStateLifecycleIdentity;
use kcoder_types::{cross_session_messages::*, session_address::SessionAddressV1};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
};

const MAX_RESIDENTS: usize = 1024;
mod wake_read;

/// A management-owned reader supplies actual Source roots, kernel lease and
/// current effective configuration. Neither signed facts nor this trait alone
/// create an allow verdict; implementations recheck every requested access.
pub(crate) trait ColdPeerSourceVerifier: Send + Sync {
    fn check_current(
        &self,
        operation: &PeerRouterOperationV1,
        message: &PeerRouterMessageV1,
        access: PeerRouterHistoryAccess,
    ) -> Result<()>;
}

/// Factory paths are observations from the actual workspace host. They do not
/// supply a source State or authorize a send while the profile is disabled.
#[derive(Clone)]
pub(crate) struct RouterRpc {
    service: Arc<PeerMessageService>,
    workspace: PathBuf,
    storage: PathBuf,
    history: Option<PathBuf>,
    directory: Arc<Mutex<SessionDirectory>>,
    cold_source: Option<Arc<dyn ColdPeerSourceVerifier>>,
}
struct Resident {
    engine: QueryEngine,
    owner: AppStateLifecycleIdentity,
    lease: DeferredSessionLeaseWitness,
    status: kcoder_app_protocol::ThreadStatus,
    run_summary: Option<AgentMessageTargetRunSummary>,
}
impl Resident {
    fn verify(&self, service: &PeerMessageService) -> Result<()> {
        ensure!(
            self.owner.try_matches(&self.engine.state) == Some(true)
                && self.engine.is_independent_discovery_session()
                && service.workspace_matches(&self.engine.state.cwd()),
            "peer_router_target_owner_changed"
        );
        self.lease
            .verify_target(&self.engine.session_lease_target())?;
        let address = service.address(&self.engine.session_id())?;
        let live = service
            .local_source(&address)?
            .context("peer_router_target_holder_unavailable")?;
        ensure!(
            live.address()? == address,
            "peer_router_target_holder_changed"
        );
        Ok(())
    }
}
pub(crate) struct RouterRpcJob {
    router: RouterRpc,
    request: PrivatePeerRouterRequest,
    residents: HashMap<String, Resident>,
    excluded: HashSet<String>,
    read_target: Option<routed_read::Capture>,
    wake_read: Option<wake_read::Capture>,
}
impl RouterRpc {
    pub(crate) fn capture(
        service: Arc<PeerMessageService>,
        workspace: PathBuf,
        storage: PathBuf,
        history_directory: Option<PathBuf>,
    ) -> Result<Self> {
        // Do not require an enabled mailbox here: policy UI must remain usable
        // before the user's first explicit opt-in initializes that namespace.
        ensure!(
            service.workspace_matches(&workspace),
            "peer_router_factory_scope_changed"
        );
        Ok(Self {
            service,
            workspace,
            storage,
            history: history_directory,
            directory: Arc::new(Mutex::new(SessionDirectory::default())),
            cold_source: None,
        })
    }
    pub(crate) fn with_cold_source_verifier(
        mut self,
        verifier: Arc<dyn ColdPeerSourceVerifier>,
    ) -> Self {
        if let Err(error) = self.service.install_cold_source_verifier(&verifier) {
            tracing::warn!(
                reason = super::errors::reason(&error),
                "Cold source owner requires reconciliation"
            );
        }
        self.cold_source = Some(verifier);
        self
    }
    /// Only capture resident identities in the select loop; disk and local IPC
    /// belong to execute(), which the owner runs outside its main dispatch loop.
    pub(in crate::app_server) fn prepare(
        &self,
        request: PrivatePeerRouterRequest,
        manager: &ThreadManager,
    ) -> Result<RouterRpcJob> {
        ensure!(
            self.service.has_private_parent(),
            "peer_router_private_parent_required"
        );
        let mut residents = HashMap::new();
        let mut excluded = HashSet::new();
        let wake_read = if request.method == router::method::SOURCE_CHECK_WAKE_READ {
            let params = request.params().map_err(anyhow::Error::msg)?;
            Some(wake_read::Capture::new(manager, params)?)
        } else {
            None
        };
        // A read captures only its one target's resident identity; no disk here.
        let read_target = if request.method == router::method::READ {
            let params: SessionReadRpcParams = request.params().map_err(anyhow::Error::msg)?;
            Some(routed_read::capture(
                manager,
                &params.read.thread_id,
                &self.workspace,
                &self.storage,
            ))
        } else {
            None
        };
        if matches!(
            request.method.as_str(),
            router::method::TARGETS | router::method::ACCEPT_FORWARDED
        ) {
            let engines = manager.resident_engines();
            ensure!(
                engines.len() <= MAX_RESIDENTS,
                "peer_router_resident_capacity"
            );
            for engine in engines {
                let id = engine.session_id();
                let eligible = !manager.is_ephemeral(&id)
                    && engine.is_independent_discovery_session()
                    && engine.state.cwd() == self.workspace;
                let held = eligible
                    .then(|| {
                        Some((
                            engine.state.try_inspection_lifecycle_identity()?,
                            manager
                                .lease(&id)?
                                .deferred_witness(&engine.session_lease_target())?,
                        ))
                    })
                    .flatten();
                if let Some((owner, lease)) = held {
                    let facts = manager.thread_run_facts(&id);
                    residents.insert(
                        id,
                        Resident {
                            engine,
                            owner,
                            lease,
                            status: facts
                                .as_ref()
                                .map_or(kcoder_app_protocol::ThreadStatus::Unknown, |facts| {
                                    facts.state()
                                }),
                            run_summary: facts
                                .as_ref()
                                .map(|facts| AgentMessageTargetRunSummary::from(&facts.summary())),
                        },
                    );
                } else {
                    excluded.insert(id);
                }
            }
        }
        Ok(RouterRpcJob {
            router: self.clone(),
            request,
            residents,
            excluded,
            read_target,
            wake_read,
        })
    }
}
fn source_identity(
    identity: &PeerRouterIdentityV1,
    address: SessionAddressV1,
) -> Result<CrossSessionMessageSource> {
    ensure!(
        identity.contains(&address),
        "peer_router_source_scope_changed"
    );
    Ok(CrossSessionMessageSource {
        thread_id: address.thread_id.clone(),
        principal_id: format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "kcoder.peer-message.source.v1",
                &identity.target_id,
                &identity.identity_epoch,
            ))?)
        ),
        address: Some(address),
    })
}
impl RouterRpcJob {
    fn read(mut self, route: &AuthorizedPeerRoute) -> Result<Value> {
        let started = std::time::Instant::now();
        let params: SessionReadRpcParams = self.request.params().map_err(anyhow::Error::msg)?;
        let target = self
            .read_target
            .take()
            .context("peer_router_read_target_uncaptured")?;
        let binding = serde_json::to_string(route.proof())?;
        let verify = || route.verify();
        let result = routed_read::execute(
            &routed_read::Context {
                service: &self.router.service,
                workspace: &self.router.workspace,
                storage: &self.router.storage,
                history: self.router.history.as_deref(),
                proof: route.proof(),
                binding: &binding,
                verify: &verify,
            },
            params,
            target,
        );
        match &result {
            Ok(SessionReadOutcome::Refused { refused }) => tracing::debug!(
                target: kcoder_tools::peer_diagnostics::TARGET,
                operation = "router.read",
                side = "app_server_router_rpc",
                code = refused.code(),
                elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                "routed read refused by target owner"
            ),
            Ok(_) => {}
            Err(error) => super::errors::report_failure(
                "router.read",
                "app_server_router_rpc",
                super::errors::reason(error),
                Some(error),
                started,
            ),
        }
        route.verify()?;
        Ok(serde_json::to_value(result?)?)
    }
    fn route(&self, endpoint: PeerRouteEndpoint) -> Result<AuthorizedPeerRoute> {
        ensure!(
            self.router.service.has_private_parent(),
            "peer_router_private_parent_required"
        );
        let proof = self
            .request
            .proof
            .clone()
            .context("peer_router_private_proof_required")?;
        self.router
            .service
            .authority()?
            .authorize_private_route(proof, endpoint)
    }
    fn verify_operation(
        &self,
        route: &AuthorizedPeerRoute,
        operation: &PeerRouterOperationV1,
        destination: bool,
    ) -> Result<()> {
        route.verify()?;
        let proof = route.proof();
        ensure!(
            proof.source.contains(&operation.source_address),
            "peer_router_original_source_changed"
        );
        verify_peer_attestation(&operation.attestation, &proof.source)?;
        if destination {
            ensure!(
                proof.destination.contains(&operation.destination),
                "peer_router_original_destination_changed"
            );
        }
        Ok(())
    }
    fn verify_original_holder(&self, operation: &PeerRouterOperationV1) -> Result<()> {
        let claims = &operation.attestation.claims;
        let verified = crate::peer_sessions::check_original_source(
            &self.router.service,
            &claims.source_address,
            &crate::peer_sessions::OriginalSourceCheck {
                client_message_id: claims.client_message_id.clone(),
                destination: claims.destination.clone(),
                mode: claims.mode,
                expected_turn_id: claims.expected_turn_id.clone(),
                body_sha256: claims.body_sha256.clone(),
                reply_to_message_id: claims.reply_to_message_id.clone(),
            },
        )?;
        ensure!(
            verified.attestation == operation.attestation,
            "peer_router_original_admission_changed"
        );
        Ok(())
    }
    fn target_modes(&self, address: &SessionAddressV1) -> Result<Vec<AgentMessageMode>> {
        ensure!(
            !self.excluded.contains(&address.thread_id),
            "peer_router_target_protected"
        );
        if let Some(resident) = self.residents.get(&address.thread_id) {
            resident.verify(&self.router.service)?;
            let row = crate::peer_sessions::read_peer_status(&self.router.service, address)?;
            ensure!(
                row.address.as_ref() == Some(address),
                "peer_router_target_holder_changed"
            );
            return Ok(row.allowed_modes);
        }
        if let Ok(row) = crate::peer_sessions::read_peer_status(&self.router.service, address) {
            ensure!(
                row.address.as_ref() == Some(address),
                "peer_router_target_holder_changed"
            );
            return Ok(row.allowed_modes);
        }
        let route = self.route(PeerRouteEndpoint::Destination)?;
        let verify = || route.verify();
        let binding = serde_json::to_string(route.proof())?;
        let view = DirectorySourceView::from_host(
            &self.router.workspace,
            &self.router.storage,
            self.router.history.as_deref(),
            &binding,
            &verify,
        )?;
        let target = self
            .router
            .directory
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_router_directory_busy"))?
            .lookup_view(&view, &address.thread_id, &self.excluded)?
            .context("peer_router_target_not_found")?;
        ensure!(target.archived_at.is_none(), "peer_router_target_archived");
        self.router.service.cold_target_modes()
    }
    fn targets(&self, route: &AuthorizedPeerRoute) -> Result<Value> {
        let params: AgentMessageTargetsRpcParams =
            self.request.params().map_err(anyhow::Error::msg)?;
        params.validate().map_err(anyhow::Error::msg)?;
        self.router.service.require_enabled(false)?;
        let source = SessionAddressV1 {
            target_id: route.proof().source.target_id.clone(),
            workspace_id: route.proof().source.workspace_id.clone(),
            thread_id: params.source_thread_id,
        };
        source.validate().map_err(anyhow::Error::msg)?;
        let mut excluded = self.excluded.clone();
        if route.proof().destination.contains(&source) {
            excluded.insert(source.thread_id.clone());
        }
        let mut resident_addresses = HashMap::new();
        for address in crate::peer_sessions::live_candidates(&self.router.service)? {
            if !excluded.contains(&address.thread_id) {
                resident_addresses.insert(address.thread_id.clone(), address);
            }
        }
        for (id, resident) in &self.residents {
            if resident.verify(&self.router.service).is_ok() && !excluded.contains(id) {
                resident_addresses.insert(id.clone(), self.router.service.address(id)?);
            }
        }
        let resident_ids = resident_addresses.keys().cloned().collect::<Vec<_>>();
        let binding = serde_json::to_string(route.proof())?;
        let verify = || {
            route.verify()?;
            self.router.service.require_enabled(false)
        };
        let view = DirectorySourceView::from_host(
            &self.router.workspace,
            &self.router.storage,
            self.router.history.as_deref(),
            &binding,
            &verify,
        )?;
        let page = self
            .router
            .directory
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_router_directory_busy"))?
            .page_view_query(
                &view,
                params.cursor.as_deref(),
                &resident_ids,
                &excluded,
                &params.search,
                |entry, _history| {
                    route.verify()?;
                    let row = match entry {
                        DirectoryEntry::Historical(row) => {
                            let mut row = row.as_ref().clone();
                            row.address = Some(self.router.service.address(&row.thread_id)?);
                            if row.archived_at.is_none() {
                                row.allowed_modes = self.router.service.cold_target_modes()?;
                            }
                            row
                        }
                        DirectoryEntry::Resident(id) => {
                            let Some(address) = resident_addresses.get(id) else {
                                return Ok(None);
                            };
                            let observed = crate::peer_sessions::read_peer_status(
                                &self.router.service,
                                address,
                            );
                            let Ok(mut row) = observed else {
                                return Ok(None);
                            };
                            if let Some(resident) = self.residents.get(id) {
                                if resident.verify(&self.router.service).is_err() {
                                    return Ok(None);
                                }
                                if let Ok(value) =
                                    thread_metadata::thread_snapshot_with_metadata_policy(
                                        &resident.engine,
                                        false,
                                        true,
                                    )
                                    && let Ok(thread) =
                                        serde_json::from_value::<kcoder_app_protocol::Thread>(value)
                                    && &thread.id == id
                                {
                                    row.title = thread.title;
                                    row.archived_at = thread.archived_at;
                                }
                                if row.status != kcoder_app_protocol::ThreadStatus::Unknown
                                    && !(row.active_turn_id.is_some()
                                        && resident.status
                                            == kcoder_app_protocol::ThreadStatus::Idle)
                                {
                                    row.status = resident.status.clone();
                                    row.run_summary = resident.run_summary.clone();
                                }
                            }
                            row
                        }
                    };
                    if row.address.as_ref() == Some(&source) {
                        return Ok(None);
                    }
                    if let Some(resident) = self.residents.get(&row.thread_id) {
                        resident.verify(&self.router.service)?;
                    }
                    Ok(Some(row))
                },
            )?;
        let issues = page.issue_count;
        let targets = page.targets;
        page.scope.verify_view(&view)?;
        verify()?;
        Ok(serde_json::to_value(AgentMessageTargetsResult {
            coverage: page.coverage,
            observed_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis()
                .min(u64::MAX as u128) as u64,
            completeness: if issues > 0 {
                AgentMessageDiscoveryCompleteness::Partial
            } else {
                page.completeness
            },
            issue_count: (issues > 0).then_some(issues),
            targets,
            next_cursor: page.next_cursor,
        })?)
    }
    pub(crate) fn execute(self) -> Result<Value> {
        ensure!(
            self.router.service.has_private_parent(),
            "peer_router_private_parent_required"
        );
        if self.request.method == router::method::IDENTITY {
            let _: EmptyParams = self.request.params().map_err(anyhow::Error::msg)?;
            return Ok(serde_json::to_value(self.router.service.identity()?)?);
        }
        if self.request.method == router::method::CAPABILITIES {
            let _: EmptyParams = self.request.params().map_err(anyhow::Error::msg)?;
            let mut capabilities = self.router.service.message_capabilities()?;
            // Only this app-server RPC owner serves routed reads; other Native hosts
            // sharing `message_capabilities` (e.g. a paired TUI) do not.
            capabilities
                .capabilities
                .push(CAPABILITY_SESSION_READ_V1.into());
            return Ok(serde_json::to_value(capabilities)?);
        }
        if self.request.method == router::ssh_parent::PEER_SSH_PARENT_BIND {
            let request = self.request.params().map_err(anyhow::Error::msg)?;
            return Ok(serde_json::to_value(
                self.router.service.bind_peer_ssh_parent(request)?,
            )?);
        }
        let endpoint = if matches!(
            self.request.method.as_str(),
            router::method::TARGETS
                | router::method::ACCEPT_FORWARDED
                | router::method::QUERY_ORIGINAL
                | router::method::QUERY_ORIGINAL_DETAILS
                | router::method::READ
        ) {
            PeerRouteEndpoint::Destination
        } else {
            PeerRouteEndpoint::Source
        };
        let route = self.route(endpoint)?;
        if self.request.method == router::method::TARGETS {
            return self.targets(&route);
        }
        if self.request.method == router::method::READ {
            return self.read(&route);
        }
        if self.request.method == router::method::SOURCE_CHECK_WAKE_READ {
            return self
                .wake_read
                .as_ref()
                .context("peer_read_wake_not_pending")?
                .verify(&self.router.service, &route);
        }
        if self.request.method == router::method::SOURCE_WAKE_READ_TARGET {
            return self.wake_read_target(&route);
        }
        let authority = self.router.service.authority()?;
        let store = authority.store()?;
        let result = match self.request.method.as_str() {
            router::method::SOURCE_CHECK_REPLY_ATTEMPT => {
                let params: PeerRouterSourceCheckReplyAttemptParams =
                    self.request.params().map_err(anyhow::Error::msg)?;
                params.attempt.validate().map_err(anyhow::Error::msg)?;
                params.message.validate().map_err(anyhow::Error::msg)?;
                let source = self.router.service.address(&params.attempt.thread_id)?;
                ensure!(
                    route.proof().source.contains(&source)
                        && params
                            .message
                            .target_address
                            .as_ref()
                            .is_some_and(|address| route.proof().destination.contains(address)),
                    "peer_reply_scope_changed"
                );
                let live = self
                    .router
                    .service
                    .local_source(&source)?
                    .context("peer_reply_source_unavailable")?;
                live.verify_reply_attempt(&params.attempt, &params.message)?;
                route.verify()?;
                serde_json::json!({"current": true})
            }
            router::method::SOURCE_PREPARE => {
                let params: PeerRouterSourcePrepareParams =
                    self.request.params().map_err(anyhow::Error::msg)?;
                let source = self.router.service.address(&params.source_thread_id)?;
                let intent = params.message.into_intent(params.destination);
                intent.validate().map_err(anyhow::Error::msg)?;
                ensure!(
                    route
                        .proof()
                        .destination
                        .contains(intent.target_address.as_ref().unwrap()),
                    "peer_router_destination_scope_changed"
                );
                ensure!(
                    params.operation_id
                        == PeerMessageService::operation_id(&source, &intent.client_message_id)?,
                    "peer_router_operation_identity_changed"
                );
                self.router.service.require_enabled(false)?;
                if let Some(live) = self.router.service.local_source(&source)? {
                    ensure!(
                        live.address()? == source,
                        "peer_router_source_holder_changed"
                    );
                    live.admit_original(&intent)?;
                    let history = live.source_admission_history()?;
                    let operation = self.router.service.prepare_source_operation(
                        &params.operation_id,
                        source,
                        &intent,
                    )?;
                    if let Some(history) = history {
                        store.record_source_history(&params.operation_id, &history)?;
                    }
                    self.verify_operation(&route, &operation, true)?;
                    serde_json::to_value(operation)?
                } else {
                    let operation = store
                        .read_operation(&params.operation_id)?
                        .context("peer_router_source_holder_unavailable")?;
                    self.verify_operation(&route, &operation, true)?;
                    let expected = &operation.attestation.claims;
                    ensure!(
                        expected.source_address == source
                            && expected.client_message_id == intent.client_message_id
                            && expected.destination == *intent.target_address.as_ref().unwrap()
                            && expected.mode == intent.mode
                            && expected.expected_turn_id == intent.expected_turn_id
                            && expected.reply_to_message_id == intent.reply_to_message_id
                            && expected.body_sha256
                                == format!("{:x}", Sha256::digest(intent.text.as_bytes())),
                        "peer_router_intent_conflict"
                    );
                    self.verify_original_holder(&operation)?;
                    serde_json::to_value(operation)?
                }
            }
            router::method::SOURCE_READ | router::method::SOURCE_MARK_DISPATCH => {
                let params: PeerRouterOperationParams =
                    self.request.params().map_err(anyhow::Error::msg)?;
                let operation = store.read_operation(&params.operation_id)?;
                if let Some(operation) = operation {
                    self.verify_operation(
                        &route,
                        &operation,
                        self.request.method == router::method::SOURCE_MARK_DISPATCH,
                    )?;
                    if self.request.method == router::method::SOURCE_MARK_DISPATCH {
                        self.router.service.require_enabled(false)?;
                        self.verify_original_holder(&operation)?;
                        route.verify()?;
                        serde_json::to_value(store.mark_dispatching(&params.operation_id)?)?
                    } else {
                        serde_json::to_value(operation)?
                    }
                } else {
                    ensure!(
                        self.request.method == router::method::SOURCE_READ,
                        "peer_router_operation_missing"
                    );
                    Value::Null
                }
            }
            router::method::SOURCE_FIND => {
                let params: PeerRouterSourceFindParams =
                    self.request.params().map_err(anyhow::Error::msg)?;
                let source = self.router.service.address(&params.source_thread_id)?;
                let operation = store.find_source_operation(&source, &params.query)?;
                if let Some(operation) = &operation {
                    self.verify_operation(&route, operation, false)?;
                }
                serde_json::to_value(operation)?
            }
            router::method::SOURCE_LIST => {
                let params: PeerRouterSourceListParamsV1 =
                    self.request.params().map_err(anyhow::Error::msg)?;
                let source = self.router.service.address(&params.source_thread_id)?;
                route.verify()?;
                let page = store.source_operations_page(&source, &params.query)?;
                for item in &page.items {
                    self.verify_operation(&route, &item.operation, false)?;
                }
                serde_json::to_value(page)?
            }
            router::method::SOURCE_RECORD_RECEIPT => {
                let params: PeerRouterRecordReceiptParams =
                    self.request.params().map_err(anyhow::Error::msg)?;
                let operation = store
                    .read_operation(&params.operation_id)?
                    .context("peer_router_operation_missing")?;
                self.verify_operation(&route, &operation, true)?;
                serde_json::to_value(store.record_receipt(&params.operation_id, params.receipt)?)?
            }
            router::method::SOURCE_CHECK_ORIGINAL => {
                let params: PeerRouterCheckOriginalParams =
                    self.request.params().map_err(anyhow::Error::msg)?;
                verify_peer_attestation(&params.attestation, &route.proof().source)?;
                let operation = store
                    .read_operation(&params.attestation.claims.operation_id)?
                    .context("peer_router_original_operation_missing")?;
                self.verify_operation(&route, &operation, true)?;
                ensure!(
                    operation.attestation == params.attestation
                        && operation.stage != PeerRouterStageV1::Prepared,
                    "peer_router_original_dispatch_unknown"
                );
                if let Some(message) = &params.message {
                    let claims = &operation.attestation.claims;
                    let intent = message.clone().into_intent(claims.destination.clone());
                    intent.validate().map_err(anyhow::Error::msg)?;
                    ensure!(
                        intent.client_message_id == claims.client_message_id
                            && intent.mode == claims.mode
                            && intent.expected_turn_id == claims.expected_turn_id
                            && intent.reply_to_message_id == claims.reply_to_message_id
                            && format!("{:x}", Sha256::digest(intent.text.as_bytes()))
                                == claims.body_sha256,
                        "peer_router_original_message_changed"
                    );
                }
                self.router.service.require_enabled(false)?;
                let source = &operation.source_address;
                if let Some(live) = self.router.service.local_source(source)? {
                    // A real current holder's denial is never replaced with
                    // a cold interpretation of historical configuration.
                    ensure!(
                        live.verify_original(&operation.attestation.claims)?
                            .attestation
                            == operation.attestation,
                        "peer_router_original_admission_changed"
                    );
                } else if let Err(error) = self.verify_original_holder(&operation) {
                    ensure!(
                        error
                            .downcast_ref::<crate::peer_sessions::OriginalSourceUnavailable>()
                            .is_some(),
                        "peer_router_original_source_unavailable"
                    );
                    let message = params
                        .message
                        .as_ref()
                        .context("peer_router_cold_source_message_required")?;
                    self.router
                        .cold_source
                        .as_ref()
                        .context("peer_router_cold_source_unavailable")?
                        .check_current(&operation, message, params.access)?;
                }
                route.verify()?;
                let current = store
                    .read_operation(&operation.operation_id)?
                    .context("peer_router_original_operation_missing")?;
                ensure!(
                    current.attestation == operation.attestation
                        && current.stage != PeerRouterStageV1::Prepared,
                    "peer_router_original_operation_changed"
                );
                serde_json::to_value(current)?
            }
            router::method::ACCEPT_FORWARDED => {
                let params: PeerRouterForwardParams =
                    self.request.params().map_err(anyhow::Error::msg)?;
                verify_peer_attestation(&params.attestation, &route.proof().source)?;
                let claims = &params.attestation.claims;
                ensure!(
                    route.proof().destination.contains(&claims.destination),
                    "peer_router_destination_scope_changed"
                );
                let intent = params.message.into_intent(claims.destination.clone());
                intent.validate().map_err(anyhow::Error::msg)?;
                ensure!(
                    claims.client_message_id == intent.client_message_id
                        && claims.mode == intent.mode
                        && claims.expected_turn_id == intent.expected_turn_id
                        && claims.reply_to_message_id == intent.reply_to_message_id
                        && claims.body_sha256
                            == format!("{:x}", Sha256::digest(intent.text.as_bytes())),
                    "peer_router_forwarded_intent_changed"
                );
                self.router
                    .service
                    .require_enabled(intent.mode == AgentMessageMode::WakeIfIdle)?;
                ensure!(
                    self.target_modes(&claims.destination)?
                        .contains(&intent.mode),
                    "peer_router_target_mode_denied"
                );
                let source = source_identity(&route.proof().source, claims.source_address.clone())?;
                store.remember_incoming(IncomingPeerOperation {
                    source_identity: route.proof().source.clone(),
                    destination_identity: route.proof().destination.clone(),
                    attestation: params.attestation.clone(),
                })?;
                let queue = self.router.service.mailbox()?;
                route.verify()?;
                self.router
                    .service
                    .require_enabled(intent.mode == AgentMessageMode::WakeIfIdle)?;
                let settings = self.router.service.admission_settings()?;
                let receipt = if intent.expected_turn_id.is_some() {
                    crate::peer_sessions::endpoint::admit_peer_target(
                        &self.router.service,
                        source,
                        intent,
                    )?
                } else {
                    queue.enqueue_with_ttl_seconds(
                        &source,
                        intent,
                        queue.revision()?,
                        settings.message_ttl_seconds,
                    )?
                };
                serde_json::to_value(receipt)?
            }
            router::method::QUERY_ORIGINAL | router::method::QUERY_ORIGINAL_DETAILS => {
                let params: PeerRouterQueryParams =
                    self.request.params().map_err(anyhow::Error::msg)?;
                let details = self.router.service.query_original_receipt_details(
                    &route.proof().source,
                    &params.attestation,
                    &params.query,
                    || route.verify(),
                )?;
                if self.request.method == router::method::QUERY_ORIGINAL_DETAILS {
                    serde_json::to_value(details)?
                } else {
                    json!({"receipt": details.receipt})
                }
            }
            _ => anyhow::bail!("peer_router_method_unsupported"),
        };
        route.verify()?;
        Ok(result)
    }
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyParams {}

#[cfg(test)]
#[path = "router_rpc/tests.rs"]
mod tests;

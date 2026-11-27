//! Real local tool hosts and destination authorization. No Engine is retained by a host.
use super::*;
use crate::app_server::session_discovery::session_directory::{
    DirectoryEntry, DirectorySourceView, SessionDirectory,
};
use crate::app_server::session_messages::delivery::{
    DestinationPeerMessageDriver, PeerDeliveryAuthorizationResolver, PeerDeliveryResolutionError,
};
use async_trait::async_trait;
use kcoder_cli_storage::session_lease::SessionLease;
use kcoder_engine::peer_message_runtime::PeerMessageCall;
use kcoder_state::{
    cross_session_messages::CrossSessionMessageRecord,
    peer_agent_history::{PeerHistoryAccess, PeerMessageAuthorization},
};
use kcoder_tools::{
    ToolError,
    session_discovery::SessionDiscoveryHost,
    session_messages::{SessionMessageSendError, SessionMessagesHost},
};
use serde_json::{Value, json};
use std::collections::HashSet;

struct LocalHost {
    source: Arc<BoundPeerSource>,
    directory: Arc<Mutex<SessionDirectory>>,
    readers: Arc<tokio::sync::Semaphore>,
}
struct LocalCallAuthorization<'a> {
    source: &'a BoundPeerSource,
    call: &'a SessionMessageCall,
    input: Value,
}
impl LocalPeerSourceAuthorization for LocalCallAuthorization<'_> {
    fn check_current(
        &self,
        state: &AppState,
        owner: &AppStateLifecycleIdentity,
        intent: &AgentMessageIntent,
    ) -> Result<()> {
        self.source.check_message_call(self.call, &self.input)?;
        self.source.check_current(state, owner, intent)
    }
    fn check_before_queue_commit(
        &self,
        state: &AppState,
        owner: &AppStateLifecycleIdentity,
        intent: &AgentMessageIntent,
    ) -> Result<()> {
        self.source.check_message_call(self.call, &self.input)?;
        self.source.check_before_queue_commit(state, owner, intent)
    }
}
fn unavailable() -> ToolError {
    ToolError::Execution("peer_message_current_owner_unavailable".into())
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn observe_directory(
    source: &BoundPeerSource,
    directory: &Mutex<SessionDirectory>,
    call: &SessionDiscoveryCall,
    input: &Value,
    cursor: Option<&str>,
) -> Result<Value> {
    source.check_discovery_call(call, input)?;
    let origin = source.address()?;
    let residents = registry::live_candidates(source.service())?
        .into_iter()
        .filter(|address| address != &origin)
        .map(|address| address.thread_id)
        .collect::<Vec<_>>();
    let excluded = HashSet::from([origin.thread_id.clone()]);
    let view = DirectorySourceView::from_state(source.state(), source.owner(), &source.storage);
    let mut directory = directory
        .try_lock()
        .map_err(|_| anyhow::anyhow!("peer_session_directory_busy"))?;
    let page = directory.page_view_query(
        &view,
        cursor,
        &residents,
        &excluded,
        call.search(),
        |entry, history| {
            source.check_discovery_call(call, input)?;
            let row = match entry {
                DirectoryEntry::Historical(row) => {
                    let mut row = row.as_ref().clone();
                    row.address = Some(source.service().address(&row.thread_id)?);
                    if row.archived_at.is_none() {
                        row.allowed_modes = source.service().cold_target_modes()?;
                    }
                    row
                }
                DirectoryEntry::Resident(id) => {
                    let address = source.service().address(id)?;
                    let Ok(mut row) = endpoint::read_peer_status(source.service(), &address) else {
                        return Ok(None);
                    };
                    if let Some(history) = history {
                        row.title.clone_from(&history.title);
                        row.archived_at.clone_from(&history.archived_at);
                        row.last_history_update_at_ms = history.last_history_update_at_ms;
                        if row.archived_at.is_some() {
                            row.allowed_modes.clear();
                        }
                    }
                    row
                }
            };
            Ok(Some(row))
        },
    )?;
    page.scope.verify_view(&view)?;
    source.check_discovery_call(call, input)?;
    Ok(serde_json::to_value(
        kcoder_app_protocol::cross_session_messages::AgentMessageTargetsResult {
            targets: page.targets,
            next_cursor: page.next_cursor,
            coverage: page.coverage,
            observed_at_ms: now_ms(),
            completeness: page.completeness,
            issue_count: (page.issue_count > 0).then_some(page.issue_count),
        },
    )?)
}
#[async_trait]
impl SessionDiscoveryHost for LocalHost {
    async fn list(
        &self,
        call: SessionDiscoveryCall,
        cursor: Option<String>,
    ) -> std::result::Result<Value, ToolError> {
        let started = std::time::Instant::now();
        let input = call.input(cursor.as_deref());
        self.source
            .check_discovery_call(&call, &input)
            .map_err(|_| unavailable())?;
        let source = self.source.clone();
        let directory = self.directory.clone();
        let worker_call = call.clone();
        let worker_input = input.clone();
        let permit = self
            .readers
            .clone()
            .try_acquire_owned()
            .map_err(|_| unavailable())?;
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            observe_directory(
                &source,
                &directory,
                &worker_call,
                &worker_input,
                cursor.as_deref(),
            )
        })
        .await
        .map_err(|_| unavailable())?
        .map_err(|error| {
            let returned = crate::app_server::session_discovery::directory_read_error(
                &error,
                "peer_message_current_owner_unavailable",
            );
            if let ToolError::Execution(message) = &returned
                && !message.starts_with("session_discovery_cursor")
            {
                crate::app_server::session_messages::errors::report_failure(
                    "local.targets",
                    "peer_local_host",
                    message,
                    Some(&error),
                    started,
                );
            }
            returned
        })?;
        self.source
            .check_discovery_call(&call, &input)
            .map_err(|_| unavailable())?;
        Ok(result)
    }
}
#[async_trait]
impl SessionMessagesHost for LocalHost {
    async fn send(
        &self,
        call: SessionMessageCall,
        mut intent: AgentMessageIntent,
    ) -> std::result::Result<Value, SessionMessageSendError> {
        let started = std::time::Instant::now();
        self.source
            .check_message_call(
                &call,
                &serde_json::to_value(&intent).map_err(|_| SessionMessageSendError::Rejected {
                    code: "peer_message_invalid_intent",
                })?,
            )
            .map_err(|_| SessionMessageSendError::Rejected {
                code: "peer_message_source_unavailable",
            })?;
        if intent.target_address.is_none() {
            intent.target_address = Some(
                self.source
                    .service()
                    .address(&intent.target_thread_id)
                    .map_err(|_| SessionMessageSendError::Rejected {
                        code: "peer_message_invalid_destination",
                    })?,
            );
        }
        let source = self.source.clone();
        let receipt = tokio::task::spawn_blocking(move || {
            let authorization = LocalCallAuthorization {
                source: &source,
                call: &call,
                input: serde_json::to_value(&intent)?,
            };
            source.service().prepare_local(
                source.state(),
                source.owner(),
                &authorization,
                source.storage_root(),
                intent,
            )
        })
        .await
        .map_err(|_| SessionMessageSendError::Unconfirmed {
            code: "peer_message_receipt_unconfirmed",
        })?
        .map_err(|error| {
            // Closed stage/reason codes only; the raw error may contain private paths or input.
            crate::app_server::session_messages::errors::report_failure(
                "local.send",
                "peer_local_host",
                crate::app_server::session_messages::errors::reason(&error),
                Some(&error),
                started,
            );
            crate::app_server::session_messages::service::local_send_error(error)
        })?;
        serde_json::to_value(receipt).map_err(|_| SessionMessageSendError::Unconfirmed {
            code: "peer_message_receipt_unconfirmed",
        })
    }
    async fn list_receipts(
        &self,
        call: SessionMessageCall,
        query: kcoder_types::cross_session_messages::CrossSessionMessageReceiptListParams,
    ) -> std::result::Result<
        kcoder_types::cross_session_messages::CrossSessionMessageReceiptListResult,
        ToolError,
    > {
        let started = std::time::Instant::now();
        let input = serde_json::to_value(&query).map_err(|_| unavailable())?;
        self.source
            .check_message_call(&call, &input)
            .map_err(|_| unavailable())?;
        let source = self.source.clone();
        let permit = self
            .readers
            .clone()
            .try_acquire_owned()
            .map_err(|_| unavailable())?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            crate::app_server::session_messages::receipt_list::local_page(
                source.service(),
                &source.address()?,
                &query,
                || source.check_message_call(&call, &input),
            )
        })
        .await
        .map_err(|_| unavailable())?
        .map_err(|error| {
            crate::app_server::session_messages::errors::report_failure(
                "local.listReceipts",
                "peer_local_host",
                "peer_message_receipt_list_unconfirmed",
                Some(&error),
                started,
            );
            ToolError::Execution("peer_message_receipt_list_unconfirmed".into())
        })
    }
    async fn receipt(
        &self,
        call: SessionMessageCall,
        query: Value,
    ) -> std::result::Result<Value, ToolError> {
        let started = std::time::Instant::now();
        let original_query = query.clone();
        crate::app_server::session_messages::receipt_read::verify_current(|| {
            self.source.check_message_call(&call, &query)
        })
        .await
        .map_err(|_| unavailable())?;
        let query: kcoder_app_protocol::cross_session_messages::AgentMessageGetParams =
            serde_json::from_value(query).map_err(|_| unavailable())?;
        query.validate().map_err(|_| unavailable())?;
        let source = self.source.clone();
        let read_call = call.clone();
        let read_input = original_query.clone();
        let result=tokio::task::spawn_blocking(move||->Result<Value>{
          crate::app_server::session_messages::receipt_read::read_current(|| {
            source.check_message_call(&read_call, &read_input)?;
            source.check_tool("GetSessionMessageReceipt",&serde_json::to_value(&query)?)?;
            let address=source.address()?;let native=source.service().message_source(&address.thread_id)?;
            let authority=source.service().authority()?;let operation=authority.store()?.find_source_operation(&address,&query)?;
            let queue=source.service().mailbox()?;
            let receipt=if let Some(id)=query.client_message_id.as_deref() {queue.get_by_client_id(&native,id)?}else{queue.get_by_message_id(&native,query.message_id.as_deref().context("peer_message_receipt_selector_required")?)?};
            if let Some(operation)=operation {
                if let Some(receipt)=receipt.as_ref() {authority.store()?.record_receipt(&operation.operation_id,receipt.clone())?;}
                else {ensure!(operation.receipt.is_none() && operation.stage==kcoder_app_protocol::cross_session_router::PeerRouterStageV1::Prepared,"peer_message_original_receipt_unconfirmed");}
            }else {ensure!(receipt.is_none(),"peer_message_original_operation_unconfirmed");}
            source.check_message_call(&read_call, &read_input)?;
            Ok(json!({"receipt":receipt}))
          })
        }).await.map_err(|_|unavailable())?.map_err(|error| {
            crate::app_server::session_messages::errors::report_failure(
                "local.get",
                "peer_local_host",
                crate::app_server::session_messages::errors::reason(&error),
                Some(&error),
                started,
            );
            unavailable()
        })?;
        crate::app_server::session_messages::receipt_read::verify_current(|| {
            self.source.check_message_call(&call, &original_query)
        })
        .await
        .map_err(|_| unavailable())?;
        Ok(result)
    }
}

struct LocalDeliveryAuthority {
    target: Arc<BoundPeerSource>,
    call: PeerMessageCall,
}
impl LocalDeliveryAuthority {
    fn check_current_sync(
        &self,
        access: PeerHistoryAccess,
        target: &AppState,
        owner: &AppStateLifecycleIdentity,
        record: &CrossSessionMessageRecord,
    ) -> Result<()> {
        self.call.verify_current_owner()?;
        self.target.check_owner()?;
        ensure!(
            target.shares_state_with(self.target.state())
                && self.target.owner().same_lifecycle(owner)
                && record.intent.target_address.as_ref() == Some(&self.target.address()?),
            "peer_message_destination_owner_changed"
        );
        let wake = matches!(access, PeerHistoryAccess::Wake);
        self.target.service().require_enabled(wake)?;
        if wake {
            if self.call.is_idle() {
                ensure!(
                    !(self.target.activity)(),
                    "peer_message_destination_not_idle"
                );
            } else {
                self.call.verify_claimed_start_record(record)?;
            }
        }
        let source = record
            .source
            .address
            .as_ref()
            .context("peer_message_original_source_required")?;
        let authority = self.target.service().authority()?;
        ensure!(
            authority
                .store()?
                .read_incoming(source, &record.intent.client_message_id)?
                .is_none(),
            "peer_message_imported_route_requires_current_gateway"
        );
        let original = self.target.service().verify_local_origin(record)?;
        let cold = self.target.service().cold_source_verifier()?;
        let fresh = super::cold_source::verify_local_source_for_delivery(
            self.target.service(),
            record,
            access,
            cold.as_deref(),
        )?;
        ensure!(
            fresh.attestation == original.attestation,
            "peer_message_original_source_changed"
        );
        self.target.check_owner()?;
        self.target.service().require_enabled(wake)
    }
}
#[async_trait]
impl PeerMessageAuthorization for LocalDeliveryAuthority {
    async fn check_current(
        &self,
        access: PeerHistoryAccess,
        target: &AppState,
        owner: &AppStateLifecycleIdentity,
        record: &CrossSessionMessageRecord,
    ) -> Result<()> {
        let bound = self.target.clone();
        let call = self.call.clone();
        let state = target.clone();
        let owner = owner.clone();
        let record = record.clone();
        tokio::task::spawn_blocking(move || {
            LocalDeliveryAuthority {
                target: bound,
                call,
            }
            .check_current_sync(access, &state, &owner, &record)
        })
        .await
        .context("peer_message_authorization_worker_unavailable")?
    }
}
struct LocalResolver {
    target: Arc<BoundPeerSource>,
}
pub(crate) fn local_delivery_resolver(
    target: Arc<BoundPeerSource>,
) -> Arc<dyn PeerDeliveryAuthorizationResolver> {
    Arc::new(LocalResolver { target })
}
pub(crate) fn destination_host(
    engine: &QueryEngine,
    service: Arc<PeerMessageService>,
    lease: kcoder_cli_storage::session_lease::NativeSessionLeaseWitness,
    target: Arc<BoundPeerSource>,
) -> Result<Arc<dyn kcoder_engine::peer_message_runtime::PeerMessageHost>> {
    ensure!(
        target.state().shares_state_with(&engine.state)
            && target.owner().try_matches(&engine.state) == Some(true)
            && target.service().identity()? == service.identity()?,
        "peer_message_destination_binding_changed"
    );
    Ok(Arc::new(DestinationPeerMessageDriver::new(
        engine.state.clone(),
        engine.state.inspection_lifecycle_identity(),
        lease,
        service.mailbox()?,
        Arc::new(LocalResolver { target }),
    )?))
}
#[async_trait]
impl PeerDeliveryAuthorizationResolver for LocalResolver {
    async fn resolve(
        &self,
        call: &PeerMessageCall,
        record: &CrossSessionMessageRecord,
    ) -> std::result::Result<Arc<dyn PeerMessageAuthorization>, PeerDeliveryResolutionError> {
        let authority = Arc::new(LocalDeliveryAuthority {
            target: self.target.clone(),
            call: call.clone(),
        });
        authority
            .check_current(
                PeerHistoryAccess::Observe,
                call.state(),
                call.owner(),
                record,
            )
            .await
            .map_err(|error| PeerDeliveryResolutionError::Unavailable {
                code: if crate::app_server::session_messages::delivery::claimed_validation::is_temporary_read_contention(&error) {
                    "peer_provider_start_original_read_busy"
                } else { "peer_message_current_authority_unavailable" },
            })?;
        Ok(authority)
    }
}

/// Guard fields deliberately close the endpoint before releasing the actual session lease.
pub(crate) struct LocalPeerRuntime {
    _maintenance: Option<super::maintenance::MailboxMaintenance>,
    _endpoint: Option<PeerSourceEndpoint>,
    _lease: Option<SessionLease>,
    _writer: Option<kcoder_state::HistoryWriterRetirement>,
    factory: Option<crate::app_server::AppServerEngineFactory>,
    cold_source:
        Option<Arc<dyn crate::app_server::session_messages::router_rpc::ColdPeerSourceVerifier>>,
    cold_targets:
        Option<crate::app_server::session_messages::cold_target_runtime::OwnedPeerColdTargets>,
}
impl Drop for LocalPeerRuntime {
    fn drop(&mut self) {
        self.disable_communication();
        if let (Some(writer), Some(lease)) = (self._writer.take(), self._lease.take()) {
            writer.request_retirement();
            writer.retain_until_writer_released(lease);
        }
    }
}
impl LocalPeerRuntime {
    pub(super) fn hold_native_owner_with_factory(
        engine: &QueryEngine,
        factory: Option<crate::app_server::AppServerEngineFactory>,
    ) -> Result<Self> {
        let mut owner = Self::hold_native_owner(engine)?;
        owner.factory = factory;
        Ok(owner)
    }
    pub(super) fn hold_native_owner(engine: &QueryEngine) -> Result<Self> {
        let mut lease = SessionLease::acquire(&engine.session_lease_target())?;
        super::turn_retirement::bind(&mut lease, engine, None);
        Ok(Self {
            _maintenance: None,
            _endpoint: None,
            _lease: Some(lease),
            _writer: Some(engine.state.capture_history_writer_retirement()?),
            factory: None,
            cold_source: None,
            cold_targets: None,
        })
    }
    pub(crate) fn disable_communication(&mut self) {
        if let Some(cold) = &self.cold_targets {
            cold.cancel();
        }
        // The original history lease remains owned until the interactive
        // runtime exits; disabling transport never permits a second writer.
        self._maintenance.take();
        self._endpoint.take();
        self.cold_source.take();
    }
    pub(super) fn native_witness(&self) -> Result<NativeSessionLeaseWitness> {
        self._lease
            .as_ref()
            .context("peer_source_owner_closed")?
            .native_witness()
    }
    pub(super) async fn retire_writer(&mut self) {
        if let Some(cold) = self.cold_targets.as_mut() {
            cold.close().await;
        }
        self.cold_targets.take();
        self.disable_communication();
        if let Some(writer) = &self._writer {
            writer.request_retirement();
            if !writer.wait_for_quiescence().await {
                tracing::warn!(
                    code = "peer_original_writer_unknown",
                    "Original history writer retired with an unknown result"
                );
            }
        }
        self._writer.take();
        self._lease.take();
    }
    pub(super) fn source(&self) -> Result<Arc<BoundPeerSource>> {
        self._endpoint
            .as_ref()
            .context("peer_source_communication_disabled")?
            .source()
    }
    pub(super) fn matches_owner(&self, engine: &QueryEngine) -> bool {
        self._lease.as_ref().is_some_and(|lease| {
            lease
                .native_witness()
                .is_ok_and(|lease| lease.verify_target(&engine.session_lease_target()).is_ok())
        })
    }
    pub(super) fn rebind(
        &mut self,
        engine: &mut QueryEngine,
        paths: kcoder_config::ConfigPaths,
    ) -> Result<()> {
        let service = PeerMessageService::capture(paths, engine.state.cwd(), None)?;
        let old = self
            ._endpoint
            .as_ref()
            .map(PeerSourceEndpoint::source)
            .transpose()?;
        if let Some(source) = &old {
            source.active.store(false, Ordering::Release);
        }
        let source = BoundPeerSource::capture(engine, service.clone(), self.native_witness()?)?;
        if let Some(lease) = self._lease.as_mut() {
            super::turn_retirement::bind(lease, engine, Some(&source));
        }
        self.cold_source = install_local_hosts(
            engine,
            &source,
            self.native_witness()?,
            self.factory.clone(),
        )?;
        if let Some(endpoint) = &self._endpoint {
            endpoint.replace_bound_source(source.clone())?;
        } else {
            self._endpoint = Some(PeerSourceEndpoint::bind(source.clone())?);
        }
        if self._maintenance.is_none() {
            self._maintenance = Some(super::maintenance::start(service));
        }
        self.cold_targets = start_cold_targets(
            engine,
            &source,
            self.factory.clone(),
            self.cold_source.clone(),
        )?;
        Ok(())
    }
}

fn install_local_hosts(
    engine: &mut QueryEngine,
    source: &Arc<BoundPeerSource>,
    lease: NativeSessionLeaseWitness,
    factory: Option<crate::app_server::AppServerEngineFactory>,
) -> Result<Option<Arc<dyn crate::app_server::session_messages::router_rpc::ColdPeerSourceVerifier>>>
{
    let host = Arc::new(LocalHost {
        source: source.clone(),
        directory: Arc::new(Mutex::new(SessionDirectory::default())),
        readers: Arc::new(tokio::sync::Semaphore::new(2)),
    });
    let driver = DestinationPeerMessageDriver::new(
        engine.state.clone(),
        engine.state.inspection_lifecycle_identity(),
        lease,
        source.service().mailbox()?,
        Arc::new(LocalResolver {
            target: source.clone(),
        }),
    )?;
    *engine = engine
        .clone()
        .with_session_discovery_host(host.clone())?
        .with_session_messages_host(host.clone())?
        .with_peer_message_host(Arc::new(driver));
    source.arm_tools(&engine.active_tool_registry())?;
    let cold: Option<Arc<dyn crate::app_server::session_messages::router_rpc::ColdPeerSourceVerifier>> =
        factory.map(|mut factory| {
            factory.set_session_messages_host(host);
            crate::app_server::session_messages::cold_source::LocalNativeColdPeerSourceVerifier::capture(
                engine, source, factory,
            ).map(|value| value as Arc<dyn crate::app_server::session_messages::router_rpc::ColdPeerSourceVerifier>)
        }).transpose()?;
    if let Some(cold) = &cold {
        source.service().install_cold_source_verifier(cold)?;
    }
    Ok(cold)
}

pub(crate) fn install_local_target_hosts(
    engine: &mut QueryEngine,
    source: &Arc<BoundPeerSource>,
    lease: NativeSessionLeaseWitness,
) -> Result<()> {
    install_local_hosts(engine, source, lease, None)?;
    Ok(())
}

fn start_cold_targets(
    _engine: &QueryEngine,
    source: &Arc<BoundPeerSource>,
    factory: Option<crate::app_server::AppServerEngineFactory>,
    verifier: Option<
        Arc<dyn crate::app_server::session_messages::router_rpc::ColdPeerSourceVerifier>,
    >,
) -> Result<Option<crate::app_server::session_messages::cold_target_runtime::OwnedPeerColdTargets>>
{
    let (Some(mut factory), Some(verifier)) = (factory, verifier) else {
        return Ok(None);
    };
    let host = Arc::new(LocalHost {
        source: source.clone(),
        directory: Arc::new(Mutex::new(SessionDirectory::default())),
        readers: Arc::new(tokio::sync::Semaphore::new(2)),
    });
    factory.set_session_discovery_host(host.clone());
    factory.set_session_messages_host(host);
    crate::app_server::session_messages::cold_target_runtime::OwnedPeerColdTargets::start(
        factory, source, verifier,
    )
    .map(Some)
}
#[cfg(test)]
pub(crate) fn attach(
    engine: &mut QueryEngine,
    paths: kcoder_config::ConfigPaths,
) -> Result<Option<LocalPeerRuntime>> {
    attach_with_factory(engine, paths, None)
}
pub(crate) fn attach_with_factory(
    engine: &mut QueryEngine,
    paths: kcoder_config::ConfigPaths,
    factory: Option<crate::app_server::AppServerEngineFactory>,
) -> Result<Option<LocalPeerRuntime>> {
    // A disabled optional feature does not inspect or initialize its old queue.
    if !crate::app_server::session_messages::policy::PeerMessagePolicy::capture(paths.clone())?
        .read()?
        .enabled
    {
        return Ok(None);
    }
    let service = PeerMessageService::capture(paths, engine.state.cwd(), None)?;
    if !service.policy()?.enabled || !engine.is_independent_discovery_session() {
        return Ok(None);
    }
    ensure!(
        engine.state.history_path().is_some(),
        "peer_session_original_history_required"
    );
    let mut lease = SessionLease::acquire(&engine.session_lease_target())?;
    let source = BoundPeerSource::capture(engine, service.clone(), lease.native_witness()?)?;
    super::turn_retirement::bind(&mut lease, engine, Some(&source));
    let cold_source =
        install_local_hosts(engine, &source, lease.native_witness()?, factory.clone())?;
    let endpoint = PeerSourceEndpoint::bind(source.clone())?;
    let cold_targets = start_cold_targets(engine, &source, factory.clone(), cold_source.clone())?;
    Ok(Some(LocalPeerRuntime {
        _maintenance: Some(super::maintenance::start(service)),
        _endpoint: Some(endpoint),
        _lease: Some(lease),
        _writer: Some(engine.state.capture_history_writer_retirement()?),
        factory,
        cold_source,
        cold_targets,
    }))
}

//! Only a pending read on the same Native connection may use the current wake's origin.
use super::*;
use crate::app_server::session_messages::backchannel::PeerRouterBackchannel;

pub(super) struct Capture {
    bridge: Arc<PeerRouterBackchannel>,
    engine: QueryEngine,
    lease: DeferredSessionLeaseWitness,
    check: PeerRouterWakeReadCheck,
}

impl RouterRpcJob {
    /// Discover only the original sender named by its signed and dispatched source operation.
    pub(super) fn wake_read_target(&self, route: &AuthorizedPeerRoute) -> Result<Value> {
        use crate::app_server::session_discovery::session_directory::ReadLookup;
        let params: PeerRouterWakeReadTarget = self.request.params().map_err(anyhow::Error::msg)?;
        params.query.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            params.query.cursor.is_none(),
            "session_discovery_cursor_invalid"
        );
        let service = &self.router.service;
        let operation = service
            .authority()?
            .store()?
            .read_operation(&params.attestation.claims.operation_id)?
            .context("peer_router_original_operation_missing")?;
        self.verify_operation(route, &operation, true)?;
        ensure!(
            operation.attestation == params.attestation
                && operation.stage != PeerRouterStageV1::Prepared
                && operation.attestation.claims.mode == AgentMessageMode::WakeIfIdle,
            "peer_read_wake_original_changed"
        );
        let binding = serde_json::to_string(route.proof())?;
        let verify = || {
            route.verify()?;
            service.require_enabled(false)
        };
        let view = DirectorySourceView::from_host(
            &self.router.workspace,
            &self.router.storage,
            self.router.history.as_deref(),
            &binding,
            &verify,
        )?;
        let address = &operation.source_address;
        let mut targets = Vec::new();
        if let ReadLookup::Found(target) =
            SessionDirectory::lookup_read_view(&view, &address.thread_id)?
            && target.same_workspace
        {
            let saved = target.session.observation();
            let mut row = match crate::peer_sessions::read_peer_status(service, address) {
                Ok(mut live) => {
                    live.title = saved.title.clone();
                    live
                }
                Err(_) => {
                    let mut row = saved.clone();
                    row.address = Some(address.clone());
                    row.presence = AgentMessageTargetPresence::Unknown;
                    row.allowed_modes.clear();
                    row
                }
            };
            if row.archived_at.is_some() {
                row.allowed_modes.clear();
            }
            ensure!(
                row.address.as_ref() == Some(address),
                "peer_read_wake_target_changed"
            );
            if row.matches_query(&params.query.search) {
                targets.push(row);
            }
            target.session.verify(&view)?;
        }
        verify()?;
        Ok(serde_json::to_value(AgentMessageTargetsResult {
            coverage: AgentMessageDiscoveryCoverage::WorkspaceHistory,
            completeness: AgentMessageDiscoveryCompleteness::Partial,
            observed_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis() as u64,
            issue_count: None,
            targets,
            next_cursor: None,
        })?)
    }
}

impl Capture {
    pub(super) fn new(manager: &ThreadManager, check: PeerRouterWakeReadCheck) -> Result<Self> {
        check.attempt.validate().map_err(anyhow::Error::msg)?;
        let id = &check.attempt.thread_id;
        let bridge = manager
            .peer_read_backchannel()
            .context("peer_read_wake_backchannel_unavailable")?;
        ensure!(
            bridge.confirms_pending_read(&check) && !manager.is_ephemeral(id),
            "peer_read_wake_not_pending"
        );
        let engine = manager
            .engine(id)
            .context("peer_read_wake_runtime_unavailable")?;
        let lease = manager
            .lease(id)
            .and_then(|lease| lease.deferred_witness(&engine.session_lease_target()))
            .context("peer_read_wake_owner_changed")?;
        Ok(Self {
            bridge,
            engine,
            lease,
            check,
        })
    }
    pub(super) fn verify(
        &self,
        service: &PeerMessageService,
        route: &AuthorizedPeerRoute,
    ) -> Result<Value> {
        let attempt = &self.check.attempt;
        let name = match self.check.kind {
            PeerRouterWakeReadKind::Targets => "ListSessions",
            PeerRouterWakeReadKind::Read => "ReadSession",
            PeerRouterWakeReadKind::Get => "GetSessionMessageReceipt",
            PeerRouterWakeReadKind::ListReceipts => "ListSessionMessageReceipts",
        };
        let verify = || -> Result<()> {
            route.verify()?;
            service.require_enabled(true)?;
            self.lease
                .verify_target(&self.engine.session_lease_target())?;
            ensure!(
                self.bridge.confirms_pending_read(&self.check)
                    && self.engine.is_independent_discovery_session()
                    && service.workspace_matches(&self.engine.state.cwd())
                    && self.engine.active_tool_registry().get(name).is_some()
                    && self
                        .engine
                        .permissions
                        .try_read()
                        .is_ok_and(|p| !p.is_explicitly_denied(name, &self.check.payload)
                            && !p.is_explicitly_denied(name, &json!({}))),
                "peer_read_wake_not_current"
            );
            Ok(())
        };
        verify()?;
        let (message, client_message_id) = self
            .engine
            .owned_turn_observer()
            .observe_wake_read_origin(attempt)?;
        let recipient = message
            .target_address
            .context("peer_read_wake_address_required")?;
        let sender = message
            .source_address
            .context("peer_read_wake_address_required")?;
        ensure!(
            recipient == service.address(&attempt.thread_id)?
                && route.proof().source.contains(&recipient)
                && route.proof().destination == route.proof().source,
            "peer_read_wake_source_changed"
        );
        verify()?;
        Ok(serde_json::to_value(PeerRouterWakeReadOrigin {
            sender,
            recipient,
            client_message_id,
            message_id: message.message_id,
            body_sha256: message.body_sha256,
        })?)
    }
}

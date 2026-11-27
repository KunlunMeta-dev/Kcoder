//! One original receipt read. Disk work runs on an owned blocking worker and the
//! source is rechecked on both sides of every read; the dispatcher only captures.
use super::super::service::OutgoingReceiptRead;
use super::*;
use anyhow::{Result as AnyResult, ensure};
use kcoder_app_protocol::cross_session_messages::AgentMessageGetParams;
use kcoder_cli_storage::session_lease::DeferredSessionLeaseWitness;

pub(crate) struct Source {
    call: SessionMessageCall,
    engine: kcoder_engine::QueryEngine,
    lease: DeferredSessionLeaseWitness,
    service: Arc<PeerMessageService>,
    query: AgentMessageGetParams,
    payload: Value,
    attempt: kcoder_types::TurnAttemptIdentity,
    routed: bool,
}

pub(super) fn capture(
    call: SessionMessageCall,
    payload: Value,
    manager: &ThreadManager,
    service: Option<&Arc<PeerMessageService>>,
    bridge: Option<&Arc<PeerRouterBackchannel>>,
) -> Result<Source, ToolError> {
    let service =
        service.ok_or_else(|| ToolError::Execution("peer_message_host_unavailable".into()))?;
    let (engine, lease) = capture_source(&call, manager, service, &payload)?;
    lease
        .verify_target(&engine.session_lease_target())
        .map_err(|_| ToolError::Execution("peer_message_source_changed".into()))?;
    let attempt = verify_captured_attempt(
        &engine,
        call.state(),
        call.owner(),
        call.captured_attempt(),
        "peer_message_source_attempt_unavailable",
        "peer_message_source_attempt_changed",
    )?;
    let query: AgentMessageGetParams = serde_json::from_value(payload.clone())
        .map_err(|_| ToolError::InvalidInput("peer_message_invalid_query".into()))?;
    query
        .validate()
        .map_err(|_| ToolError::InvalidInput("peer_message_invalid_query".into()))?;
    Ok(Source {
        call,
        engine,
        lease,
        service: service.clone(),
        query,
        payload,
        attempt,
        routed: service.has_private_parent() && bridge.is_some_and(|bridge| bridge.available()),
    })
}

fn unconfirmed() -> ToolError {
    ToolError::Execution("peer_message_receipt_unconfirmed".into())
}

impl Source {
    /// The same current-source fence as the outbox list: original tool
    /// contribution, permission, kernel lease and the exact captured attempt.
    fn check(&self) -> AnyResult<()> {
        self.service.require_enabled(false)?;
        self.lease
            .verify_target(&self.engine.session_lease_target())?;
        ensure!(
            self.call.is_current()
                && self
                    .engine
                    .active_tool_registry()
                    .get(self.call.tool_name())
                    .is_some_and(|tool| self.call.matches_registered_tool(tool.as_ref()))
                && self
                    .engine
                    .permissions
                    .try_read()
                    .is_ok_and(|p| !p.is_explicitly_denied(self.call.tool_name(), &self.payload))
                && self
                    .engine
                    .owned_turn_observer()
                    .current_identity()
                    .map_err(anyhow::Error::msg)?
                    .as_ref()
                    == Some(&self.attempt),
            "peer_message_source_changed"
        );
        Ok(())
    }

    /// Unrouted hosts keep the original direct mailbox read.
    fn read_direct(&self) -> Result<Value, ToolError> {
        let source = self
            .service
            .message_source(&self.attempt.thread_id)
            .map_err(|_| ToolError::Execution("peer_message_source_changed".into()))?;
        self.check()
            .map_err(|_| ToolError::Execution("peer_message_source_changed".into()))?;
        let queue = self.service.mailbox().map_err(|_| unconfirmed())?;
        let receipt = super::super::receipt_read::read_current(|| {
            if let Some(id) = self.query.message_id.as_deref() {
                queue.get_by_message_id(&source, id)
            } else {
                queue.get_by_client_id(
                    &source,
                    self.query.client_message_id.as_deref().unwrap_or_default(),
                )
            }
        })
        .map_err(|_| unconfirmed())?;
        self.check()
            .map_err(|_| ToolError::Execution("peer_message_source_changed".into()))?;
        Ok(json!({ "receipt": receipt }))
    }

    /// Routed hosts first observe a same-host destination locally; only an
    /// operation addressed to another runtime target (or one this host cannot
    /// find) is reconciled through the authenticated parent route.
    fn read_local(&self) -> AnyResult<OutgoingReceiptRead> {
        let address = self.service.address(&self.attempt.thread_id)?;
        let read = super::super::receipt_read::read_current(|| {
            self.check()?;
            self.service.local_outgoing_receipt(&address, &self.query)
        })?;
        self.check()?;
        Ok(read)
    }

    pub(super) async fn read(self, bridge: Arc<PeerRouterBackchannel>) -> Result<Value, ToolError> {
        enum Observed {
            Direct(Result<Value, ToolError>),
            Local(AnyResult<OutgoingReceiptRead>),
        }
        let (source, observed) = tokio::task::spawn_blocking(move || {
            let observed = if self.routed {
                Observed::Local(self.read_local())
            } else {
                Observed::Direct(self.read_direct())
            };
            (self, observed)
        })
        .await
        .map_err(|_| unconfirmed())?;
        match observed {
            Observed::Direct(result) => result,
            Observed::Local(Ok(OutgoingReceiptRead::Local(receipt))) => {
                Ok(json!({ "receipt": receipt }))
            }
            // A remote destination needs the route; an unreadable local fact never
            // proves absence, so the original routed reader may still confirm it.
            Observed::Local(Ok(OutgoingReceiptRead::RequiresRoute) | Err(_)) => {
                source
                    .check()
                    .map_err(|_| ToolError::Execution("peer_message_source_changed".into()))?;
                let result = bridge
                    .request("get", &source.attempt, source.payload.clone())
                    .await
                    .map_err(|_| {
                        ToolError::Execution("peer_message_original_receipt_unconfirmed".into())
                    })?;
                source.check().map_err(|_| unconfirmed())?;
                Ok(result)
            }
        }
    }
}

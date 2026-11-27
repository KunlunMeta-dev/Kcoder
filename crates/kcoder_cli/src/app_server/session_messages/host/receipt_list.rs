//! Keep disk reads outside the thread manager and verify the current source on both sides of a read.
use super::*;
use anyhow::{Result as AnyResult, ensure};
use kcoder_cli_storage::session_lease::DeferredSessionLeaseWitness;
use kcoder_types::cross_session_messages::{
    CrossSessionMessageReceiptListParams as Query, CrossSessionMessageReceiptListResult as Page,
};

pub(crate) struct Source {
    call: SessionMessageCall,
    engine: kcoder_engine::QueryEngine,
    lease: DeferredSessionLeaseWitness,
    service: Arc<PeerMessageService>,
    query: Query,
    input: Value,
    attempt: kcoder_types::TurnAttemptIdentity,
    routed: bool,
}

pub(super) fn capture(
    call: SessionMessageCall,
    query: Query,
    manager: &ThreadManager,
    service: Option<&Arc<PeerMessageService>>,
    bridge: Option<&Arc<PeerRouterBackchannel>>,
) -> Result<Source, ToolError> {
    let service = service.ok_or_else(unavailable)?;
    let input = serde_json::to_value(&query).map_err(|_| unavailable())?;
    let (engine, lease) = capture_source(&call, manager, service, &input)?;
    let attempt = verify_captured_attempt(
        &engine,
        call.state(),
        call.owner(),
        call.captured_attempt(),
        "peer_message_source_attempt_unavailable",
        "peer_message_source_attempt_changed",
    )?;
    let routed = service.has_private_parent()
        && bridge.is_some_and(|b| b.available() && b.supports_message_receipts());
    Ok(Source {
        call,
        engine,
        lease,
        service: service.clone(),
        query,
        input,
        attempt,
        routed,
    })
}

fn unavailable() -> ToolError {
    ToolError::Execution("peer_message_receipt_list_unconfirmed".into())
}
impl Source {
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
                    .is_ok_and(|p| !p.is_explicitly_denied(self.call.tool_name(), &self.input))
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
    pub(super) async fn read(
        self,
        bridge: Arc<PeerRouterBackchannel>,
        permit: tokio::sync::OwnedSemaphorePermit,
    ) -> Result<Page, ToolError> {
        let address = self
            .service
            .address(&self.attempt.thread_id)
            .map_err(|_| unavailable())?;
        let routed = self.routed;
        // Same-host operations are admitted locally, so observe this host's own
        // durable facts first, on an owned blocking worker. Only a page that
        // examined another runtime target's operation needs the parent route;
        // a local-only page never depends on the router attributing this turn.
        let (source, local) = tokio::task::spawn_blocking(move || {
            let local = super::super::receipt_list::local_page_observed(
                &self.service,
                &address,
                &self.query,
                || self.check(),
            );
            (self, local)
        })
        .await
        .map_err(|_| unavailable())?;
        if !routed {
            drop(permit);
            return local.map(|page| page.result).map_err(|_| unavailable());
        }
        let local = match local {
            Ok(page) if page.remote_candidates == 0 => return Ok(page.result),
            Ok(page) => Some(page.result),
            Err(_) => None,
        };
        let _permit = permit;
        source.check().map_err(|_| unavailable())?;
        let address = source
            .service
            .address(&source.attempt.thread_id)
            .map_err(|_| unavailable())?;
        let routed = async {
            let value = bridge
                .request("listReceipts", &source.attempt, source.input.clone())
                .await
                .ok()?;
            source.check().ok()?;
            let page: Page = serde_json::from_value(value).ok()?;
            page.validate(&source.query, &address.thread_id, Some(&address))
                .ok()?;
            Some(page)
        }
        .await;
        source.check().map_err(|_| unavailable())?;
        // A route failure (for example a Native peer-driven turn that the parent
        // cannot attribute to a client owner) degrades to the local page, whose
        // remote rows are already reported as unconfirmed and counted.
        routed.or(local).ok_or_else(unavailable)
    }
}

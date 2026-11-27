//! Original Native-to-Gateway requests. Replies cannot be replayed into another namespace.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::cross_session_router::{PeerRouterWakeReadCheck, PeerRouterWakeReadKind};
use kcoder_types::TurnAttemptIdentity;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

pub const METHOD: &str = "kcoder/peerRouter/requestV1";
const MAX_PENDING: usize = 32;
const MAX_FRAME_BYTES: usize = 128 * 1024;
pub(crate) struct PeerRouterBackchannel {
    namespace: String,
    next: AtomicU64,
    ready: AtomicBool,
    discovery_search: AtomicBool,
    message_replies: AtomicBool,
    message_receipts: AtomicBool,
    background_replies: AtomicBool,
    session_read: AtomicBool,
    pending: Arc<Mutex<HashMap<String, Pending>>>,
    /// Released on `close` so the connection's stdout writer can observe a
    /// closed outbound channel even while Arc clones of this lane remain.
    output: Mutex<Option<mpsc::Sender<Value>>>,
    closed: CancellationToken,
}
struct Registration {
    pending: Arc<Mutex<HashMap<String, Pending>>>,
    id: String,
}
struct Pending {
    result: oneshot::Sender<Value>,
    read: Option<(TurnAttemptIdentity, PeerRouterWakeReadKind, Value)>,
}
impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.id);
        }
    }
}
impl PeerRouterBackchannel {
    /// Only the actual passive restore owner can use this lane: the original
    /// kernel lease is held before any Engine/factory/MCP activation occurs.
    pub(crate) async fn verify_cold_target_original(
        &self,
        service: &super::service::PeerMessageService,
        destination: &kcoder_types::session_address::SessionAddressV1,
        history: &std::path::Path,
        lease: &kcoder_cli_storage::session_lease::NativeSessionLeaseWitness,
        params: kcoder_app_protocol::cross_session_router::PeerRouterCheckOriginalParams,
    ) -> Result<kcoder_app_protocol::cross_session_router::PeerRouterOperationV1> {
        let verify = || -> Result<()> {
            ensure!(
                self.available()
                    && service.has_private_parent()
                    && service.identity()?.contains(destination)
                    && params.attestation.claims.destination == *destination
                    && params.access
                        == kcoder_app_protocol::cross_session_router::PeerRouterHistoryAccess::Wake
                    && params.attestation.claims.mode
                        == kcoder_types::cross_session_messages::AgentMessageMode::WakeIfIdle
                    && params.attestation.claims.expected_turn_id.is_none(),
                "peer_cold_target_route_changed"
            );
            service.require_enabled(true)?;
            lease.verify_target(history)
        };
        verify()?;
        let value = self
            .exchange("verifyOriginal", None, serde_json::to_value(&params)?)
            .await?;
        verify()?;
        let operation: kcoder_app_protocol::cross_session_router::PeerRouterOperationV1 =
            serde_json::from_value(value)?;
        ensure!(
            operation.attestation == params.attestation
                && operation.stage
                    != kcoder_app_protocol::cross_session_router::PeerRouterStageV1::Prepared
                && operation.operation_id == params.attestation.claims.operation_id
                && operation.source_address == params.attestation.claims.source_address
                && operation.destination == *destination
                && operation.body_sha256 == params.attestation.claims.body_sha256,
            "peer_cold_target_original_changed"
        );
        Ok(operation)
    }

    pub fn new(output: mpsc::Sender<Value>) -> Arc<Self> {
        Arc::new(Self {
            namespace: format!("peer-router-{}-", uuid::Uuid::new_v4().simple()),
            next: AtomicU64::new(1),
            ready: AtomicBool::new(false),
            discovery_search: AtomicBool::new(false),
            message_replies: AtomicBool::new(false),
            message_receipts: AtomicBool::new(false),
            background_replies: AtomicBool::new(false),
            session_read: AtomicBool::new(false),
            pending: Arc::default(),
            output: Mutex::new(Some(output)),
            closed: CancellationToken::new(),
        })
    }
    /// This is capability negotiation only; every request still needs its actual host source gate.
    pub fn negotiate(&self, ready: bool) {
        self.ready.store(ready, Ordering::Release);
    }
    pub(crate) fn negotiate_discovery_search(&self, enabled: bool) {
        self.discovery_search.store(enabled, Ordering::Release);
    }
    pub(crate) fn supports_discovery_search(&self) -> bool {
        self.discovery_search.load(Ordering::Acquire)
    }
    pub(crate) fn negotiate_message_replies(&self, enabled: bool) {
        self.message_replies.store(enabled, Ordering::Release);
    }
    pub(crate) fn supports_message_replies(&self) -> bool {
        self.message_replies.load(Ordering::Acquire)
    }
    pub(crate) fn negotiate_message_receipts(&self, enabled: bool) {
        self.message_receipts.store(enabled, Ordering::Release);
    }
    pub(crate) fn supports_message_receipts(&self) -> bool {
        self.message_receipts.load(Ordering::Acquire)
    }
    pub(crate) fn negotiate_background_replies(&self, enabled: bool) {
        self.background_replies.store(enabled, Ordering::Release);
    }
    pub(crate) fn supports_background_replies(&self) -> bool {
        self.background_replies.load(Ordering::Acquire)
    }
    /// The Gateway router announced routed ReadSession; each read is still authorized
    /// by the target owner and the target endpoint must advertise it as well.
    pub(crate) fn negotiate_session_read(&self, enabled: bool) {
        self.session_read.store(enabled, Ordering::Release);
    }
    pub(crate) fn supports_session_read(&self) -> bool {
        self.session_read.load(Ordering::Acquire)
    }
    pub fn available(&self) -> bool {
        self.ready.load(Ordering::Acquire) && !self.closed.is_cancelled()
    }
    pub fn close(&self) {
        self.closed.cancel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
        // Drop the outbound sender: holders of this lane (thread manager, cold
        // drivers, session hosts) must not keep the stdout writer alive.
        if let Ok(mut output) = self.output.lock() {
            output.take();
        }
    }
    pub fn route_response(&self, response: &Value) -> bool {
        if response.get("method").is_some() {
            return false;
        }
        let Some(id) = response.get("id").and_then(Value::as_str) else {
            return false;
        };
        if !id.starts_with(&self.namespace) {
            return false;
        }
        if let Some(sender) = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(id))
        {
            let _ = sender.result.send(response.clone());
        }
        true
    }
    pub(super) fn confirms_pending_read(&self, check: &PeerRouterWakeReadCheck) -> bool {
        self.available()
            && self.pending.lock().is_ok_and(|pending| {
                pending
                    .get(&check.request_id)
                    .and_then(|p| p.read.as_ref())
                    .is_some_and(|(attempt, kind, input)| {
                        attempt == &check.attempt && *kind == check.kind && input == &check.payload
                    })
            })
    }
    pub async fn request(
        &self,
        kind: &str,
        attempt: &TurnAttemptIdentity,
        payload: Value,
    ) -> Result<Value> {
        ensure!(
            matches!(
                kind,
                "targets" | "send" | "get" | "listReceipts" | "sendReply" | "read"
            ),
            "peer_message_router_kind_unavailable"
        );
        attempt.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            [&attempt.thread_id, &attempt.turn_id, &attempt.attempt_id]
                .into_iter()
                .all(|id| !id.chars().any(char::is_control)),
            "peer_message_source_attempt_invalid"
        );
        self.exchange(kind, Some(attempt), payload).await
    }
    async fn exchange(
        &self,
        kind: &str,
        attempt: Option<&TurnAttemptIdentity>,
        payload: Value,
    ) -> Result<Value> {
        let started = std::time::Instant::now();
        let result = self.exchange_once(kind, attempt, payload).await;
        // Cursor/filter rejections are caller recovery advice, not channel failures.
        if let Err(error) = &result
            && super::super::session_discovery::router_read_rejection(&error.to_string()).is_none()
        {
            let operation = match kind {
                "targets" => "router.targets",
                "send" => "router.send",
                "get" => "router.get",
                "listReceipts" => "router.listReceipts",
                "sendReply" => "router.sendReply",
                "verifyOriginal" => "router.verifyOriginal",
                "read" => "router.read",
                _ => "router.other",
            };
            super::errors::report_failure(
                operation,
                "app_server_backchannel",
                &error.to_string(),
                Some(error),
                started,
            );
        }
        result
    }
    async fn exchange_once(
        &self,
        kind: &str,
        attempt: Option<&TurnAttemptIdentity>,
        payload: Value,
    ) -> Result<Value> {
        ensure!(self.available(), "peer_message_router_unavailable");
        let number = self.next.fetch_add(1, Ordering::Relaxed);
        ensure!(number <= 1_000_000, "peer_message_router_capacity");
        // Nothing has been sent yet, so a released lane is plainly unavailable.
        let output = self
            .output
            .lock()
            .ok()
            .and_then(|output| output.clone())
            .context("peer_message_router_unavailable")?;
        let id = format!("{}{number}", self.namespace);
        let frame = json!({"jsonrpc":"2.0","id":id,"method":METHOD,"params":{"kind":kind,"sourceAttempt":attempt,"payload":payload}});
        ensure!(
            serde_json::to_vec(&frame)?.len() <= MAX_FRAME_BYTES,
            "peer_message_router_frame_limit"
        );
        let (send, receive) = oneshot::channel();
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| anyhow::anyhow!("peer_message_router_busy"))?;
            ensure!(pending.len() < MAX_PENDING, "peer_message_router_busy");
            let read_kind = match kind {
                "targets" => Some(PeerRouterWakeReadKind::Targets),
                "get" => Some(PeerRouterWakeReadKind::Get),
                "listReceipts" => Some(PeerRouterWakeReadKind::ListReceipts),
                "read" => Some(PeerRouterWakeReadKind::Read),
                _ => None,
            };
            let read = attempt
                .zip(read_kind)
                .map(|(attempt, kind)| (attempt.clone(), kind, payload));
            pending.insert(id.clone(), Pending { result: send, read });
        }
        let _registration = Registration {
            pending: self.pending.clone(),
            id,
        };
        // Inner causes are closed diagnostic codes only; callers still see the
        // outermost `peer_message_router_outcome_unknown` message.
        let unknown = |inner: &'static str| {
            anyhow::anyhow!(inner).context("peer_message_router_outcome_unknown")
        };
        let exchange = async {
            output
                .send(frame)
                .await
                .map_err(|_| unknown("peer_message_router_channel_closed"))?;
            let response = receive
                .await
                .map_err(|_| unknown("peer_message_router_reply_dropped"))?;
            if !self.available() {
                return Err(unknown("peer_message_router_channel_closed"));
            }
            if let Some(error) = response.get("error") {
                let reason = error.get("message").and_then(Value::as_str);
                if kind == "targets"
                    && let Some(reason) = reason
                    && super::super::session_discovery::router_read_rejection(reason).is_some()
                {
                    anyhow::bail!("{}", reason);
                }
                // Keep only a closed router code from the Gateway error, never raw text.
                let inner = reason
                    .and_then(kcoder_tools::peer_diagnostics::normalized_code)
                    .unwrap_or_else(|| "peer_message_router_error_response".into());
                return Err(anyhow::anyhow!(inner).context("peer_message_router_outcome_unknown"));
            }
            response
                .get("result")
                .cloned()
                .ok_or_else(|| unknown("peer_message_router_response_invalid"))
        };
        tokio::select! {
            biased;
            _=self.closed.cancelled()=>Err(unknown("peer_message_router_channel_closed")),
            _=tokio::time::sleep(Duration::from_secs(60))=>Err(unknown("peer_message_router_timeout")),
            result=exchange=>result,
        }
    }
}

/// Actual destination ownership captured by the host, never decoded from a
/// queue record, a claimed address or a saved authorization verdict.
pub(crate) struct PeerTargetBackchannel {
    bridge: Arc<PeerRouterBackchannel>,
    service: Arc<super::service::PeerMessageService>,
    state: kcoder_state::AppState,
    owner: kcoder_state::AppStateLifecycleIdentity,
    history: std::path::PathBuf,
    lease: kcoder_cli_storage::session_lease::NativeSessionLeaseWitness,
    address: kcoder_types::session_address::SessionAddressV1,
    holder: std::sync::Weak<dyn super::service::LivePeerSource>,
    activity: Arc<dyn Fn() -> bool + Send + Sync>,
}
impl PeerTargetBackchannel {
    pub(crate) fn capture(
        bridge: Arc<PeerRouterBackchannel>,
        service: Arc<super::service::PeerMessageService>,
        engine: &kcoder_engine::QueryEngine,
        lease: kcoder_cli_storage::session_lease::NativeSessionLeaseWitness,
    ) -> Result<Self> {
        ensure!(
            service.has_private_parent() && engine.is_independent_discovery_session(),
            "peer_target_actual_private_owner_required"
        );
        let history = engine
            .state
            .history_path()
            .context("peer_target_history_required")?;
        lease.verify_target(&history)?;
        let address = service.address(&engine.session_id())?;
        let holder = service
            .local_source(&address)?
            .context("peer_target_actual_holder_required")?;
        ensure!(holder.address()? == address, "peer_target_holder_changed");
        Ok(Self {
            bridge,
            service,
            state: engine.state.clone(),
            owner: engine.state.inspection_lifecycle_identity(),
            history,
            lease,
            address,
            holder: Arc::downgrade(&holder),
            activity: engine.turn_driver_activity_observer(),
        })
    }
    pub(crate) fn address(&self) -> &kcoder_types::session_address::SessionAddressV1 {
        &self.address
    }
    pub(crate) fn verify_call(
        &self,
        call: &kcoder_engine::peer_message_runtime::PeerMessageCall,
        params: &kcoder_app_protocol::cross_session_router::PeerRouterCheckOriginalParams,
    ) -> Result<()> {
        use kcoder_app_protocol::cross_session_router::PeerRouterHistoryAccess;
        call.verify_current_owner()?;
        ensure!(
            self.bridge.available()
                && self.service.has_private_parent()
                && call.state().shares_state_with(&self.state)
                && self.owner.same_lifecycle(call.owner())
                && self.state.history_path().as_ref() == Some(&self.history)
                && self.service.address(&self.state.session_id())? == self.address
                && params.attestation.claims.destination == self.address,
            "peer_target_current_owner_changed"
        );
        self.lease.verify_target(&self.history)?;
        let holder = self.holder.upgrade().context("peer_target_holder_closed")?;
        let current = self
            .service
            .local_source(&self.address)?
            .context("peer_target_holder_closed")?;
        ensure!(
            Arc::ptr_eq(&holder, &current) && current.address()? == self.address,
            "peer_target_holder_changed"
        );
        let wake = params.access == PeerRouterHistoryAccess::Wake;
        self.service.require_enabled(wake)?;
        if wake {
            ensure!(
                params.attestation.claims.mode
                    == kcoder_types::cross_session_messages::AgentMessageMode::WakeIfIdle
                    && params.attestation.claims.expected_turn_id.is_none(),
                "peer_target_wake_not_currently_idle"
            );
            if call.is_idle() {
                ensure!(!(self.activity)(), "peer_target_wake_not_currently_idle");
            } else {
                call.verify_claimed_start_selector(
                    &params.attestation.claims.source_address,
                    &params.attestation.claims.destination,
                    &params.attestation.claims.client_message_id,
                    &params.attestation.claims.body_sha256,
                )?;
            }
        }
        if params.access == PeerRouterHistoryAccess::Append
            && let Some(expected) = params.attestation.claims.expected_turn_id.as_deref()
        {
            ensure!(
                !call.is_idle()
                    && call
                        .attempt()
                        .is_some_and(|attempt| attempt.turn_id == expected),
                "peer_target_original_turn_changed"
            );
        }
        Ok(())
    }
    pub(crate) async fn verify_original(
        &self,
        call: &kcoder_engine::peer_message_runtime::PeerMessageCall,
        params: kcoder_app_protocol::cross_session_router::PeerRouterCheckOriginalParams,
    ) -> Result<kcoder_app_protocol::cross_session_router::PeerRouterOperationV1> {
        self.verify_call(call, &params)?;
        let payload = serde_json::to_value(&params)?;
        let value = self
            .bridge
            .exchange("verifyOriginal", call.attempt(), payload)
            .await?;
        self.verify_call(call, &params)?;
        let operation: kcoder_app_protocol::cross_session_router::PeerRouterOperationV1 =
            serde_json::from_value(value)?;
        ensure!(
            operation.attestation == params.attestation
                && operation.stage
                    != kcoder_app_protocol::cross_session_router::PeerRouterStageV1::Prepared
                && operation.operation_id == params.attestation.claims.operation_id
                && operation.source_address == params.attestation.claims.source_address
                && operation.destination == self.address
                && operation.body_sha256 == params.attestation.claims.body_sha256,
            "peer_target_original_operation_changed"
        );
        Ok(operation)
    }
}

#[async_trait::async_trait]
impl super::remote_delivery::OriginalSourceVerifier for PeerTargetBackchannel {
    fn target_address(&self) -> &kcoder_types::session_address::SessionAddressV1 {
        self.address()
    }
    fn validate_destination_identity(
        &self,
        identity: &kcoder_app_protocol::cross_session_router::PeerRouterIdentityV1,
    ) -> Result<()> {
        ensure!(
            &self.service.identity()? == identity,
            "peer_target_original_identity_changed"
        );
        Ok(())
    }
    async fn verify_original(
        &self,
        call: &kcoder_engine::peer_message_runtime::PeerMessageCall,
        params: kcoder_app_protocol::cross_session_router::PeerRouterCheckOriginalParams,
    ) -> Result<kcoder_app_protocol::cross_session_router::PeerRouterOperationV1> {
        PeerTargetBackchannel::verify_original(self, call, params).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn attempt() -> TurnAttemptIdentity {
        TurnAttemptIdentity {
            thread_id: "source".into(),
            turn_id: "turn".into(),
            attempt_id: "attempt".into(),
        }
    }
    #[tokio::test]
    async fn only_the_original_pending_receipt_settles_and_a_closed_owner_never_resends() {
        let (output, mut input) = mpsc::channel(4);
        let bridge = PeerRouterBackchannel::new(output);
        assert!(
            bridge
                .request("get", &attempt(), json!({"clientMessageId":"original"}))
                .await
                .is_err()
        );
        assert!(input.try_recv().is_err());
        bridge.negotiate(true);
        assert!(
            bridge
                .request("verifyOriginal", &attempt(), json!({}))
                .await
                .is_err(),
            "a source action caller cannot fabricate the opaque target lane"
        );
        assert!(input.try_recv().is_err());
        let requester = bridge.clone();
        let task = tokio::spawn(async move {
            requester
                .request("get", &attempt(), json!({"clientMessageId":"original"}))
                .await
        });
        let frame = input.recv().await.unwrap();
        assert!(
            !bridge
                .route_response(&json!({"id":"peer-router-another-1","result":{"receipt":null}}))
        );
        assert!(!task.is_finished());
        assert!(bridge.route_response(&json!({"id":frame["id"],"result":{"receipt":null}})));
        assert_eq!(task.await.unwrap().unwrap(), json!({"receipt":null}));
        // A late duplicate belongs to the old request; it creates no new work.
        assert!(
            bridge.route_response(
                &json!({"id":frame["id"],"result":{"receipt":{"status":"applied"}}})
            )
        );
        assert!(input.try_recv().is_err());
        bridge.close();
        assert!(bridge.request("send", &attempt(), json!({})).await.is_err());
        assert!(input.try_recv().is_err());
    }
    #[tokio::test]
    async fn cancelling_a_waiter_releases_its_slot_and_owner_shutdown_settles_other_waiters() {
        let (output, mut input) = mpsc::channel(4);
        let bridge = PeerRouterBackchannel::new(output);
        bridge.negotiate(true);
        let requester = bridge.clone();
        let cancelled = tokio::spawn(async move {
            requester
                .request("send", &attempt(), json!({"clientMessageId":"first"}))
                .await
        });
        let original = input.recv().await.unwrap();
        cancelled.abort();
        let _ = cancelled.await;
        assert!(bridge.pending.lock().unwrap().is_empty());
        assert!(bridge.route_response(&json!({"id":original["id"],"result":{"status":"queued"}})));
        let requester = bridge.clone();
        let pending = tokio::spawn(async move {
            requester
                .request("get", &attempt(), json!({"clientMessageId":"first"}))
                .await
        });
        let read = input.recv().await.unwrap();
        assert_ne!(read["id"], original["id"]);
        bridge.close();
        assert!(pending.await.unwrap().is_err());
        assert!(bridge.pending.lock().unwrap().is_empty());
        assert!(input.try_recv().is_err());
    }

    #[tokio::test]
    async fn close_releases_the_outbound_sender_while_lane_clones_remain() {
        let (output, mut input) = mpsc::channel(4);
        let bridge = PeerRouterBackchannel::new(output);
        bridge.negotiate(true);
        // Thread managers, session hosts and cold drivers keep Arc clones
        // until process exit; the stdout writer must still see the channel close.
        let retained = bridge.clone();
        bridge.close();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), input.recv())
                .await
                .expect("closed lane must not keep the writer open")
                .is_none()
        );
        let error = retained
            .request("send", &attempt(), json!({"clientMessageId":"late"}))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "peer_message_router_unavailable");
    }
}

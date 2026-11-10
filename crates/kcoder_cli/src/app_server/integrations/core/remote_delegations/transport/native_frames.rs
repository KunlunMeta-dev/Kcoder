//! Keep the original Source budget Arc while standard ACP frames cross the host lane.
use super::host_client::{NativeHostMethod, NativeRemoteHostClient};
use crate::app_server::integrations::core::remote_delegations::source_budget::NativeRemoteSourceBudget;
use anyhow::{Context, Result, ensure};
use kcoder_acp::outbound::{NativeFrameFuture, OwnedNativeFrameTransport};
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_types::integrations::core::NativeRemoteTargetRefV1;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

pub struct NativeRemoteSourceFrames {
    client: Arc<NativeRemoteHostClient>,
    budget: Arc<NativeRemoteSourceBudget>,
    target: NativeRemoteTargetRefV1,
    operation: String,
    accepted_sha256: String,
    source_attempt: kcoder_types::integrations::core::NativeRemoteTurnIdentityV1,
    endpoint: String,
    deadline: tokio::time::Instant,
    deadline_utc_ms: u64,
    receiver_workspace: OnceLock<std::path::PathBuf>,
    cancelled: CancellationToken,
    opened: AtomicBool,
    poisoned: AtomicBool,
    receiver_cleanup: AtomicBool,
    close_intent: OnceLock<kcoder_types::integrations::core::NativeRemoteControlFrameV1>,
    close_sent: AtomicBool,
    cancel_intent: OnceLock<Value>,
    cancel_sent: AtomicBool,
    settlement_replies: Mutex<std::collections::BTreeMap<String, Value>>,
    next_write: AtomicU64,
    incoming: tokio::sync::Mutex<Incoming>,
    cleanup: Arc<Cleanup>,
}
#[derive(Default)]
struct Incoming {
    acknowledged: u64,
    frames: VecDeque<(u64, Value)>,
}
#[derive(Default)]
struct Cleanup {
    started: AtomicBool,
    result: Mutex<Option<bool>>,
    settled: tokio::sync::Notify,
}
#[derive(Clone, Copy)]
enum ExchangeAuthority {
    Execution,
    Observation,
    OwnerClose,
    SettlementReply,
    OwnerCancel,
}
impl NativeRemoteSourceFrames {
    /// A durable original Cancel dispatch and its captured Native session admit
    /// this one exact notification even when execution has already been revoked.
    pub fn admit_original_cancel(&self, session: &Value) -> Result<()> {
        self.verify_owner()?;
        ensure!(
            self.opened.load(Ordering::Acquire),
            "REMOTE_HOST_NATIVE_OPEN_REQUIRED"
        );
        self.cancel_intent
            .set(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}}))
            .map_err(|_| anyhow::anyhow!("REMOTE_ORIGINAL_CANCEL_RECONCILE"))
    }

    /// Called only after the retained authority settled an already dispatched
    /// original call. JSON cannot populate this exact one-use reply admission.
    pub fn admit_original_settlement_reply(&self, id: &Value, response: &Value) -> Result<()> {
        self.verify_owner()?;
        ensure!(
            id.is_string() || id.is_i64() || id.is_u64(),
            "REMOTE_ORIGINAL_SETTLEMENT_REPLY_REQUIRED"
        );
        let key = serde_json::to_string(id)?;
        ensure!(
            key.len() <= 1024,
            "REMOTE_ORIGINAL_SETTLEMENT_REPLY_REQUIRED"
        );
        let mut replies = self
            .settlement_replies
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_CONTROL_OWNER_BUSY"))?;
        ensure!(
            replies.len() < 64 && !replies.contains_key(&key),
            "REMOTE_ORIGINAL_SETTLEMENT_REPLY_RECONCILE"
        );
        replies.insert(key, json!({"jsonrpc":"2.0","id":id,"result":response}));
        Ok(())
    }

    pub fn original_close_admitted(&self) -> bool {
        self.close_intent.get().is_some()
    }
    /// This private retained-owner admission follows the durable OwnerClose
    /// dispatch. It authorizes one exact close frame and no read or execution.
    pub fn admit_original_close(
        &self,
        intent: &kcoder_types::integrations::core::NativeRemoteControlFrameV1,
    ) -> Result<()> {
        self.verify_received_control(intent)?;
        ensure!(
            matches!(
                intent.message,
                kcoder_types::integrations::core::NativeRemoteControlDataV1::CloseOriginal(_)
            ),
            "REMOTE_ORIGINAL_CLOSE_REQUIRED"
        );
        self.close_intent
            .set(intent.clone())
            .map_err(|_| anyhow::anyhow!("REMOTE_OWNER_CLOSE_RECONCILE_ORIGINAL"))
    }

    /// Recheck the existing Gateway target/account owner after awaited cleanup
    /// without opening a peer or accessing a remote file.
    pub fn observe_current_target_owner<'a>(
        &'a self,
    ) -> futures::future::BoxFuture<'a, Result<()>> {
        Box::pin(self.observe_current_target_owner_producer())
    }
    async fn observe_current_target_owner_producer(&self) -> Result<()> {
        self.verify_retained_source()?;
        let mut params = self.envelope();
        params["direction"] = json!("owner_observe");
        let reply = self
            .client
            .request(
                NativeHostMethod::Exchange,
                params,
                tokio::time::Instant::now() + std::time::Duration::from_secs(4),
                &CancellationToken::new(),
            )
            .await?;
        self.verify_retained_source()?;
        self.validate_reply(&reply)?;
        ensure!(
            reply["state"] == "owner_observed",
            "REMOTE_HOST_TARGET_OWNER_CHANGED"
        );
        Ok(())
    }
    /// A closed byte lane does not erase the retained original Source owner.
    /// This grants no send, receive, open or execution operation.
    pub fn verify_retained_source(&self) -> Result<()> {
        self.client.verify_owner()?;
        self.budget.verify_retained_observation_owner()
    }
    /// Only the actual Source authority calls this after validating the
    /// original Receiver's authenticated terminal/cleanup observation.
    pub fn observe_receiver_cleanup(&self, confirmed: bool) -> Result<()> {
        self.verify_owner()?;
        if confirmed {
            self.receiver_cleanup.store(true, Ordering::Release);
        }
        Ok(())
    }
    pub fn deadline_utc_ms(&self) -> u64 {
        self.deadline_utc_ms
    }
    /// Called only after the original accepted Tool creates and binds its actual
    /// Source budget/Goal owner. Target data selects; Gateway's held owner must
    /// authenticate/pin it before opening any SSH child.
    pub fn bind_original(
        client: Arc<NativeRemoteHostClient>,
        budget: Arc<NativeRemoteSourceBudget>,
        target: NativeRemoteTargetRefV1,
        operation: &str,
        deadline: tokio::time::Instant,
        cancelled: CancellationToken,
    ) -> Result<Arc<Self>> {
        client.verify_owner()?;
        budget.require_delegation_policy()?;
        let source = budget.frozen_native_facts()?;
        let expected = format!(
            "remote-{}",
            super::super::launch::digest(&(
                kcoder_types::integrations::core::IntegrationOwner::from(&source.scope),
                &source.attempt,
                &source.tool_call_id,
            ))?
        );
        ensure!(
            operation == expected,
            "REMOTE_HOST_ORIGINAL_OPERATION_CHANGED"
        );
        ensure!(
            !target.target_id.is_empty()
                && !target.target_revision.is_empty()
                && target.expected_native_sha256.len() == 64
                && target
                    .expected_native_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()),
            "REMOTE_HOST_NATIVE_TARGET_REQUIRED"
        );
        let deadline = budget
            .execution_deadline()?
            .map_or(deadline, |bound| bound.min(deadline));
        ensure!(
            tokio::time::Instant::now() < deadline,
            "REMOTE_HOST_ORIGINAL_DEADLINE_EXPIRED"
        );
        let remaining_ms: u64 = deadline
            .saturating_duration_since(tokio::time::Instant::now())
            .as_millis()
            .try_into()?;
        let wall_ms: u64 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis()
            .try_into()?;
        let deadline_utc_ms = wall_ms
            .checked_add(remaining_ms)
            .context("REMOTE_HOST_ORIGINAL_DEADLINE_INVALID")?;
        Ok(Arc::new(Self {
            client,
            budget,
            target,
            operation: operation.into(),
            accepted_sha256: source.accepted_receipt_sha256,
            source_attempt: (&source.attempt).into(),
            endpoint: format!("native-endpoint-{}", uuid::Uuid::new_v4().simple()),
            deadline,
            deadline_utc_ms,
            receiver_workspace: OnceLock::new(),
            cancelled,
            opened: AtomicBool::new(false),
            poisoned: AtomicBool::new(false),
            receiver_cleanup: AtomicBool::new(false),
            close_intent: OnceLock::new(),
            close_sent: AtomicBool::new(false),
            cancel_intent: OnceLock::new(),
            cancel_sent: AtomicBool::new(false),
            settlement_replies: Mutex::default(),
            next_write: AtomicU64::new(1),
            incoming: tokio::sync::Mutex::new(Incoming::default()),
            cleanup: Arc::default(),
        }))
    }
    pub fn source_control_binding(
        &self,
    ) -> Result<(Arc<NativeRemoteSourceBudget>, String, String, String)> {
        self.verify_owner()?;
        Ok((
            self.budget.clone(),
            self.operation.clone(),
            self.accepted_sha256.clone(),
            self.target.target_revision.clone(),
        ))
    }
    pub fn verify_received_control(
        &self,
        frame: &kcoder_types::integrations::core::NativeRemoteControlFrameV1,
    ) -> Result<()> {
        self.verify_owner()?;
        ensure!(
            self.opened.load(Ordering::Acquire)
                && frame.operation_id == self.operation
                && frame.source_accepted_sha256 == self.accepted_sha256
                && frame.endpoint_instance_id == self.endpoint
                && frame.endpoint_revision == self.target.target_revision,
            "REMOTE_CONTROL_ORIGINAL_OWNER_MISMATCH"
        );
        Ok(())
    }
    fn envelope(&self) -> Value {
        json!({"operationId":self.operation,"endpointInstanceId":self.endpoint,"sourceAcceptedSha256":self.accepted_sha256,"sourceAttempt":self.source_attempt,"deadlineUtcMs":self.deadline_utc_ms})
    }
    fn validate_reply(&self, reply: &Value) -> Result<()> {
        ensure!(
            reply["operationId"] == self.operation && reply["endpointInstanceId"] == self.endpoint,
            "REMOTE_HOST_ORIGINAL_RECEIPT_MISMATCH"
        );
        Ok(())
    }
    fn check_execution(&self) -> Result<()> {
        self.verify_owner()?;
        ensure!(
            !self.original_close_admitted(),
            "REMOTE_OWNER_CLOSE_RECONCILE_ORIGINAL"
        );
        ensure!(
            !self.cancelled.is_cancelled() && tokio::time::Instant::now() < self.deadline,
            "REMOTE_HOST_ORIGINAL_DEADLINE_EXPIRED"
        );
        self.budget.require_owned_transport_policy()
    }
    async fn exchange(&self, params: Value, authority: ExchangeAuthority) -> Result<Value> {
        self.verify_owner()?;
        if matches!(authority, ExchangeAuthority::Execution) {
            self.check_execution()?;
        }
        let observation_cancel = CancellationToken::new();
        let reply = self
            .client
            .request(
                NativeHostMethod::Exchange,
                params,
                match authority {
                    ExchangeAuthority::Observation => {
                        tokio::time::Instant::now() + std::time::Duration::from_secs(4)
                    }
                    ExchangeAuthority::OwnerCancel => {
                        tokio::time::Instant::now() + std::time::Duration::from_secs(4)
                    }
                    ExchangeAuthority::SettlementReply => {
                        tokio::time::Instant::now() + std::time::Duration::from_secs(4)
                    }
                    ExchangeAuthority::OwnerClose => {
                        tokio::time::Instant::now() + std::time::Duration::from_secs(20)
                    }
                    ExchangeAuthority::Execution => self.deadline,
                },
                if !matches!(authority, ExchangeAuthority::Execution) {
                    &observation_cancel
                } else {
                    &self.cancelled
                },
            )
            .await;
        if reply.is_err() {
            self.poisoned.store(true, Ordering::Release);
        }
        let reply = reply?;
        self.verify_owner()?;
        if matches!(authority, ExchangeAuthority::Execution) {
            self.check_execution()?;
        }
        self.validate_reply(&reply)?;
        Ok(reply)
    }
}
impl OwnedNativeFrameTransport for NativeRemoteSourceFrames {
    fn receiver_workspace(&self) -> Result<Option<std::path::PathBuf>> {
        self.verify_owner()?;
        Ok(self.receiver_workspace.get().cloned())
    }
    fn endpoint_instance_id(&self) -> &str {
        &self.endpoint
    }
    fn verify_owner(&self) -> Result<()> {
        self.verify_retained_source()?;
        ensure!(
            !self.poisoned.load(Ordering::Acquire),
            "REMOTE_HOST_RECONCILE_ORIGINAL"
        );
        Ok(())
    }
    fn open(&self) -> NativeFrameFuture<'_, ()> {
        Box::pin(async {
            self.check_execution()
                .context("REMOTE_OWNED_OPEN_FRAME_ADMISSION")?;
            ensure!(
                !self.opened.swap(true, Ordering::AcqRel),
                "REMOTE_HOST_RECONCILE_ORIGINAL"
            );
            let mut params = self.envelope();
            params["target"] = serde_json::to_value(&self.target)?;
            let result = self
                .client
                .request(
                    NativeHostMethod::Open,
                    params,
                    self.deadline,
                    &self.cancelled,
                )
                .await;
            if result.is_err() {
                self.poisoned.store(true, Ordering::Release);
            }
            let reply = result.context("REMOTE_OWNED_OPEN_HOST_REQUEST")?;
            self.verify_owner()?;
            self.validate_reply(&reply)?;
            ensure!(
                reply["state"] == "opened",
                "REMOTE_HOST_NATIVE_OPEN_RECEIPT_REQUIRED"
            );
            ensure!(
                reply["nativeSha256"] == self.target.expected_native_sha256
                    && reply["targetPlatform"]
                        == serde_json::to_value(self.target.target_platform)?,
                "REMOTE_HOST_NATIVE_IMAGE_CHANGED"
            );
            let workspace = reply["receiverWorkspace"]
                .as_str()
                .filter(|path| {
                    !path.is_empty() && path.len() <= 2048 && !path.chars().any(char::is_control)
                })
                .context("REMOTE_HOST_RECEIVER_WORKSPACE_REQUIRED")?;
            let bytes = workspace.as_bytes();
            ensure!(
                match self.target.target_platform {
                    kcoder_types::integrations::core::NativeRemoteTargetPlatformV1::Linux =>
                        workspace.starts_with('/'),
                    kcoder_types::integrations::core::NativeRemoteTargetPlatformV1::Windows =>
                        bytes.len() >= 3
                            && bytes[0].is_ascii_alphabetic()
                            && bytes[1] == b':'
                            && matches!(bytes[2], b'/' | b'\\'),
                },
                "REMOTE_HOST_RECEIVER_WORKSPACE_CHANGED"
            );
            self.receiver_workspace
                .set(std::path::PathBuf::from(workspace))
                .map_err(|_| anyhow::anyhow!("REMOTE_HOST_RECEIVER_WORKSPACE_CHANGED"))?;
            Ok(())
        })
    }
    fn send(&self, frame: Value) -> NativeFrameFuture<'_, ()> {
        Box::pin(async move {
            ensure!(
                self.opened.load(Ordering::Acquire),
                "REMOTE_HOST_NATIVE_OPEN_REQUIRED"
            );
            let settlement_reply = if frame.get("method").is_none() && frame.get("id").is_some() {
                let key = serde_json::to_string(&frame["id"])?;
                let mut replies = self
                    .settlement_replies
                    .lock()
                    .map_err(|_| anyhow::anyhow!("REMOTE_CONTROL_OWNER_BUSY"))?;
                if let Some(expected) = replies.get(&key) {
                    ensure!(
                        expected == &frame,
                        "REMOTE_ORIGINAL_SETTLEMENT_REPLY_CHANGED"
                    );
                    replies.remove(&key);
                    true
                } else {
                    false
                }
            } else {
                false
            };
            let authority = if frame["method"] == "session/cancel" {
                ensure!(
                    self.cancel_intent.get() == Some(&frame)
                        && !self.cancel_sent.swap(true, Ordering::AcqRel),
                    "REMOTE_ORIGINAL_CANCEL_RECONCILE"
                );
                ExchangeAuthority::OwnerCancel
            } else if settlement_reply {
                ExchangeAuthority::SettlementReply
            } else if frame["method"]
                == kcoder_types::integrations::core::NATIVE_REMOTE_CONTROL_METHOD
            {
                let request: kcoder_types::integrations::core::NativeRemoteControlFrameV1 =
                    rpc_codec::decode(frame["params"].clone())?;
                request.validate_shape().map_err(anyhow::Error::msg)?;
                self.verify_received_control(&request)?;
                match request.message {
                    kcoder_types::integrations::core::NativeRemoteControlDataV1::ObserveOriginal
                    | kcoder_types::integrations::core::NativeRemoteControlDataV1::ReadArtifactManifest(_)
                    | kcoder_types::integrations::core::NativeRemoteControlDataV1::ReadArtifactChunk(_) => ExchangeAuthority::Observation,
                    kcoder_types::integrations::core::NativeRemoteControlDataV1::CloseOriginal(_) => {
                        ensure!(self.close_intent.get() == Some(&request)
                            && !self.close_sent.swap(true, Ordering::AcqRel), "REMOTE_OWNER_CLOSE_RECONCILE_ORIGINAL");
                        ExchangeAuthority::OwnerClose
                    }
                    _ => ExchangeAuthority::Execution,
                }
            } else {
                ExchangeAuthority::Execution
            };
            if matches!(authority, ExchangeAuthority::Execution) {
                self.check_execution()?;
            }
            let sequence = self.next_write.fetch_add(1, Ordering::Relaxed);
            let mut params = self.envelope();
            params["direction"] = json!("frame_write");
            params["sequence"] = json!(sequence);
            params["frame"] = frame;
            let reply = self.exchange(params, authority).await?;
            ensure!(
                reply["sequence"] == sequence && reply["state"] == "transport_written",
                "REMOTE_HOST_RECONCILE_ORIGINAL"
            );
            Ok(())
        })
    }
    fn receive(&self) -> NativeFrameFuture<'_, Option<Value>> {
        Box::pin(async {
            let mut incoming = self.incoming.lock().await;
            loop {
                self.verify_owner()?;
                if let Some((sequence, frame)) = incoming.frames.pop_front() {
                    ensure!(
                        sequence == incoming.acknowledged + 1,
                        "REMOTE_HOST_READ_SEQUENCE_CHANGED"
                    );
                    incoming.acknowledged = sequence;
                    return Ok(Some(frame));
                }
                let mut params = self.envelope();
                params["direction"] = json!("frame_read");
                params["acknowledgeThrough"] = json!(incoming.acknowledged);
                params["maximumFrames"] = json!(16);
                params["waitMs"] = json!(500);
                let reply = self
                    .exchange(params, ExchangeAuthority::Observation)
                    .await?;
                let frames = reply["frames"]
                    .as_array()
                    .context("REMOTE_HOST_READ_RECEIPT_INVALID")?;
                ensure!(frames.len() <= 16, "REMOTE_HOST_READ_RECEIPT_INVALID");
                let mut expected = incoming.acknowledged + 1;
                for value in frames {
                    let sequence = value["sequence"]
                        .as_u64()
                        .context("REMOTE_HOST_READ_SEQUENCE_CHANGED")?;
                    ensure!(
                        sequence == expected
                            && value["frame"].is_object()
                            && value["frame"]["jsonrpc"] == "2.0",
                        "REMOTE_HOST_READ_SEQUENCE_CHANGED"
                    );
                    expected = expected
                        .checked_add(1)
                        .context("REMOTE_HOST_READ_SEQUENCE_CHANGED")?;
                    incoming
                        .frames
                        .push_back((sequence, value["frame"].clone()));
                }
            }
        })
    }
    fn begin_close(&self) {
        if self.cleanup.started.swap(true, Ordering::AcqRel) {
            return;
        }
        self.poisoned.store(true, Ordering::Release);
        let client = self.client.clone();
        let params = self.envelope();
        let cleanup = self.cleanup.clone();
        let operation = self.operation.clone();
        let endpoint = self.endpoint.clone();
        let receiver_confirmed = self.receiver_cleanup.load(Ordering::Acquire);
        crate::app_server::task_spawn::spawn(async move {
            // This grace closes only the original owner. It never renews an ACP
            // execution deadline, opens another target or resends a model call.
            let response = client
                .request(
                    NativeHostMethod::Close,
                    params,
                    tokio::time::Instant::now() + std::time::Duration::from_secs(4),
                    &CancellationToken::new(),
                )
                .await;
            // Only the private captured host provider may return this receipt,
            // after its actual Native/SSH owners confirm their original trees.
            let confirmed = response.is_ok_and(|value| {
                value["operationId"] == operation
                    && value["endpointInstanceId"] == endpoint
                    && value["transportCleanupConfirmed"] == true
                    && receiver_confirmed
            });
            *cleanup.result.lock().unwrap_or_else(|p| p.into_inner()) = Some(confirmed);
            cleanup.settled.notify_waiters();
        });
    }
    fn close(&self) -> NativeFrameFuture<'_, bool> {
        Box::pin(async {
            self.begin_close();
            loop {
                let notified = self.cleanup.settled.notified();
                let result = *self
                    .cleanup
                    .result
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                if let Some(result) = result {
                    return Ok(result);
                }
                notified.await;
            }
        })
    }
}

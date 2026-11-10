//! Original Native private binding between initialize and session creation.
use super::*;
use kcoder_types::integrations::core::{
    NATIVE_REMOTE_CONTROL_METHOD, NativeRemoteControlDataV1, NativeRemoteControlFrameV1,
};

struct BindingGuard {
    host: Arc<dyn OutboundHost>,
    finished: bool,
}
impl Drop for BindingGuard {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.host.unknown_owned_native_bind();
        }
    }
}
struct CloseGuard {
    host: Arc<dyn OutboundHost>,
    finished: bool,
}
impl Drop for CloseGuard {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.host.unknown_owned_native_close();
        }
    }
}
impl OutboundAcp {
    /// Reconcile only the original dispatched model call. This separate host
    /// capability may settle accounting facts; it grants no read or execution.
    pub(super) async fn settle_original_native_accounting(&self, frame: &Value) -> bool {
        if frame["method"] != NATIVE_REMOTE_CONTROL_METHOD || frame.get("id").is_none() {
            return false;
        }
        let Ok(request) =
            serde_json::from_value::<NativeRemoteControlFrameV1>(frame["params"].clone())
        else {
            return false;
        };
        if request.validate_shape().is_err()
            || !matches!(
                request.message,
                NativeRemoteControlDataV1::ObserveModel(_)
                    | NativeRemoteControlDataV1::FinishModel(_)
            )
        {
            return false;
        }
        let response = tokio::time::timeout(
            Duration::from_secs(1),
            self.host.handle_owned_native_settlement(frame),
        )
        .await;
        let response = match response {
            Ok(Ok(Some(response))) => response,
            _ => match serde_json::to_value(
                kcoder_types::integrations::core::NativeRemoteControlReplyV1 {
                    version: request.version,
                    operation_id: request.operation_id,
                    request_id: request.request_id,
                    endpoint_revision: request.endpoint_revision,
                    endpoint_instance_id: request.endpoint_instance_id,
                    state:
                        kcoder_types::integrations::core::NativeRemoteReceiptStateV1::OutcomeUnknown,
                    data: kcoder_types::integrations::core::NativeRemoteReceiptDataV1::Diagnostic {
                        code: "REMOTE_ORIGINAL_ACCOUNTING_OUTCOME_UNKNOWN".into(),
                    },
                },
            ) {
                Ok(value) => value,
                Err(_) => {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(1),
                        self.peer.reject_request(frame),
                    )
                    .await;
                    return true;
                }
            },
        };
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            self.peer.reply_result(frame["id"].clone(), response),
        )
        .await;
        true
    }

    /// Dispatch the retained original owner's one journaled close. No read
    /// permission, session result or transport EOF can authorize this effect.
    pub async fn close_owned_native_original(
        &mut self,
        original: &NativeRemoteControlFrameV1,
    ) -> Result<Value> {
        ensure!(
            self.initialized && (!self.poisoned || self.may_retain_original_close()),
            "Original Native initialize required"
        );
        original.validate_shape().map_err(anyhow::Error::msg)?;
        ensure!(
            matches!(
                original.message,
                NativeRemoteControlDataV1::CloseOriginal(_)
            ),
            "Original Native close intent required"
        );
        self.host
            .before_owned_native_close(&serde_json::to_value(original)?)?;
        let mut guard = CloseGuard {
            host: self.host.clone(),
            finished: false,
        };
        // Cleanup grace admits no execution and never moves the original deadline.
        let result = self
            .call_inner(
                NATIVE_REMOTE_CONTROL_METHOD,
                serde_json::to_value(original)?,
                None,
                &CancellationToken::new(),
                Duration::from_secs(20),
                CallAuthority::OwnerClose,
            )
            .await;
        let receipt = match result {
            Ok((receipt, _)) => receipt,
            Err(error) => {
                self.poisoned = true;
                self.peer.begin_shutdown();
                return Err(error);
            }
        };
        self.host.record_owned_native_close(&receipt)?;
        guard.finished = true;
        Ok(receipt)
    }

    /// Original-ID readback only. A concrete host must separately validate the
    /// endpoint and selected original task/artifact before any bytes are sent.
    pub async fn read_owned_native_original(
        &mut self,
        request: &NativeRemoteControlFrameV1,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        ensure!(
            self.initialized && !self.poisoned,
            "Original Native initialize required"
        );
        request.validate_shape().map_err(anyhow::Error::msg)?;
        ensure!(
            matches!(
                request.message,
                NativeRemoteControlDataV1::ObserveOriginal
                    | NativeRemoteControlDataV1::ReadArtifactManifest(_)
                    | NativeRemoteControlDataV1::ReadArtifactChunk(_)
            ),
            "Read-only original Native observation required"
        );
        let params = serde_json::to_value(request)?;
        self.host.check_owned_native_observation()?;
        self.host.verify_owned_native_read(&params)?;
        let (response, _) = self
            .observe_call(
                NATIVE_REMOTE_CONTROL_METHOD,
                params,
                cancel,
                Duration::from_secs(10),
            )
            .await?;
        self.host.check_owned_native_observation()?;
        Ok(response)
    }
    /// Only a concrete captured Native host may journal and approve this call.
    /// A transport or JSON reply never installs a Receiver execution authority.
    pub async fn bind_owned_native_original(
        &mut self,
        original: &NativeRemoteControlFrameV1,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        ensure!(
            self.initialized && !self.poisoned,
            "Original Native initialize required"
        );
        original.validate_shape().map_err(anyhow::Error::msg)?;
        ensure!(
            matches!(original.message, NativeRemoteControlDataV1::BindOriginal(_)),
            "Original Native bind intent required"
        );
        let params = serde_json::to_value(original)?;
        self.host.check_current()?;
        // First binding starts and verifies the Receiver's own native backend.
        // Use the original execution deadline, including installation hashing;
        // call_inner still enforces that same hard bound and cancellation.
        let remaining = self
            .host
            .deadline()
            .saturating_duration_since(tokio::time::Instant::now());
        ensure!(!remaining.is_zero(), "REMOTE_OWNED_BIND_DEADLINE_EXPIRED");
        self.host.before_owned_native_bind(&params)?;
        let mut guard = BindingGuard {
            host: self.host.clone(),
            finished: false,
        };
        let (receipt, _) = self
            .call(
                NATIVE_REMOTE_CONTROL_METHOD,
                params,
                None,
                cancel,
                remaining,
            )
            .await?;
        self.host.check_current()?;
        self.host.record_owned_native_bind(&receipt)?;
        guard.finished = true;
        Ok(receipt)
    }
}

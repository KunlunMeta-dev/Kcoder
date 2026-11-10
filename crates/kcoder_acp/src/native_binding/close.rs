//! The original owned backend and its actual stdio owner settle one close intent.
use super::*;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub(super) struct OwnerState {
    accepted: Mutex<Option<NativeRemoteAcceptedFactsV1>>,
    requested: Mutex<Option<NativeRemoteControlFrameV1>>,
    close: Mutex<Option<CloseState>>,
}
struct CloseState {
    original: NativeRemoteControlFrameV1,
    outcome: Option<NativeRemoteCallOutcomeV1>,
    observation: crate::upstream::OwnedExitObservation,
    verified: bool,
}
impl OwnerState {
    pub(super) fn request_close(&self, frame: &NativeRemoteControlFrameV1) -> Result<()> {
        ensure!(
            self.matches_close(frame),
            "REMOTE_ORIGINAL_ACCEPTED_REQUIRED"
        );
        let mut original = self.requested.lock().unwrap_or_else(|p| p.into_inner());
        ensure!(
            original.as_ref().is_none_or(|old| old == frame),
            "REMOTE_OWNER_CLOSE_RECONCILE_ORIGINAL"
        );
        *original = Some(frame.clone());
        Ok(())
    }
    pub(super) fn has_requested_close(&self) -> bool {
        self.has_actual_accepted()
            && self
                .requested
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .is_some()
    }

    pub(super) fn has_actual_accepted(&self) -> bool {
        self.accepted
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
    }

    pub(super) fn observe_accepted(&self, actual: &NativeRemoteAcceptedFactsV1) -> Result<()> {
        let mut accepted = self.accepted.lock().unwrap_or_else(|p| p.into_inner());
        ensure!(
            accepted.as_ref().is_none_or(|old| old == actual),
            "REMOTE_ORIGINAL_ACCEPTED_CHANGED"
        );
        *accepted = Some(actual.clone());
        Ok(())
    }
    pub(super) fn matches_close(&self, frame: &NativeRemoteControlFrameV1) -> bool {
        let NativeRemoteControlDataV1::CloseOriginal(actual) = &frame.message else {
            return false;
        };
        self.accepted
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            == Some(actual)
    }
    pub(super) fn receipt(&self, frame: &NativeRemoteControlFrameV1) -> Result<Option<Value>> {
        let state = self.close.lock().unwrap_or_else(|p| p.into_inner());
        let Some(state) = state.as_ref() else {
            return Ok(None);
        };
        ensure!(
            state.original == *frame,
            "REMOTE_OWNER_CLOSE_RECONCILE_ORIGINAL"
        );
        let NativeRemoteControlDataV1::CloseOriginal(accepted) = &frame.message else {
            unreachable!()
        };
        let backend_exited = state.observation.backend_exited();
        let tree = state.observation.tree_confirmed();
        let known = state.verified && backend_exited && tree;
        Ok(Some(serde_json::to_value(NativeRemoteControlReplyV1 {
            version: frame.version,
            operation_id: frame.operation_id.clone(),
            request_id: frame.request_id.clone(),
            endpoint_revision: frame.endpoint_revision.clone(),
            endpoint_instance_id: frame.endpoint_instance_id.clone(),
            state: if known {
                NativeRemoteReceiptStateV1::Received
            } else {
                NativeRemoteReceiptStateV1::OutcomeUnknown
            },
            data: NativeRemoteReceiptDataV1::OwnerClosed {
                accepted: accepted.clone(),
                outcome: state.outcome,
                backend_exited,
                owner_tree_cleanup_confirmed: state.verified && tree,
            },
        })?))
    }
}

pub(crate) async fn close_owned(
    binding: &NativeBinding,
    upstream: &mut Upstream,
    frame: &NativeRemoteControlFrameV1,
) -> Result<Value> {
    binding.cwd.verify()?;
    ensure!(
        binding.owner.matches_close(frame),
        "REMOTE_ORIGINAL_ACCEPTED_REQUIRED"
    );
    if let Some(receipt) = binding.owner.receipt(frame)? {
        return Ok(receipt);
    }
    {
        let mut close = binding
            .owner
            .close
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        ensure!(close.is_none(), "REMOTE_OWNER_CLOSE_RECONCILE_ORIGINAL");
        *close = Some(CloseState {
            original: frame.clone(),
            outcome: None,
            observation: upstream.exit_observation(),
            verified: false,
        });
    }
    // Ask the original native producer before stopping it. Neither caller data
    // nor a completed ACP prompt supplies this actual Accepted/outcome receipt.
    let observation = NativeRemoteControlFrameV1 {
        message: NativeRemoteControlDataV1::ObserveOriginal,
        ..frame.clone()
    };
    let verified = async {
        let value = upstream
            .call(
                NATIVE_REMOTE_CONTROL_METHOD,
                serde_json::to_value(&observation)?,
            )
            .await?;
        let actual: NativeRemoteControlReplyV1 = serde_json::from_value(value)?;
        validate_reply_header(&observation, &actual)?;
        let NativeRemoteReceiptDataV1::Receiver {
            accepted, outcome, ..
        } = actual.data
        else {
            anyhow::bail!("REMOTE_ORIGINAL_ACCEPTED_REQUIRED")
        };
        let NativeRemoteControlDataV1::CloseOriginal(expected) = &frame.message else {
            unreachable!()
        };
        ensure!(
            actual.state == NativeRemoteReceiptStateV1::Received && accepted == *expected,
            "REMOTE_ORIGINAL_ACCEPTED_CHANGED"
        );
        Ok::<_, anyhow::Error>(outcome)
    }
    .await;
    if let Ok(outcome) = verified {
        let mut close = binding
            .owner
            .close
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let state = close.as_mut().expect("original close");
        state.outcome = outcome;
        state.verified = true;
    }
    // A deadline reports unknown; the original native owner's retained waiter
    // continues cleanup. No task, owner or effect is restarted by reconciliation.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(14), upstream.shutdown()).await;
    binding
        .owner
        .receipt(frame)?
        .context("REMOTE_OWNER_CLOSE_RECEIPT_UNKNOWN")
}

pub(super) fn new_owner() -> Arc<OwnerState> {
    Arc::new(OwnerState::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    fn frame() -> NativeRemoteControlFrameV1 {
        serde_json::from_value(serde_json::json!({"version":1,"operationId":"original-op","requestId":"original-close",
            "endpointRevision":"1","endpointInstanceId":"original-endpoint","sourceAcceptedSha256":"a".repeat(64),
            "message":{"method":"close_original","params":{"identity":{"threadId":"t","turnId":"u","attemptId":"a"},
                "acceptedInputSha256":"b".repeat(64),"acceptedReceiptSha256":"c".repeat(64),"receiverSettingsSha256":"d".repeat(64)}}})).unwrap()
    }
    #[test]
    fn cleanup_handoff_requires_actual_accepted_and_the_frozen_original_close() {
        let state = new_owner();
        let handoff = NativeCloseHandoff(state.clone());
        let original = frame();
        assert!(!handoff.is_held());
        assert!(state.request_close(&original).is_err());
        let NativeRemoteControlDataV1::CloseOriginal(facts) = &original.message else {
            unreachable!()
        };
        state.observe_accepted(facts).unwrap();
        assert!(
            !handoff.is_held(),
            "An Accepted alone grants no cleanup transfer"
        );
        state.request_close(&original).unwrap();
        assert!(handoff.is_held());
        let mut other = original.clone();
        other.request_id = "another-close".into();
        assert!(state.request_close(&other).is_err());
    }
    #[test]
    fn root_exit_never_becomes_tree_credit_and_same_close_reads_late_original_observation() {
        let frame = frame();
        let state = new_owner();
        let NativeRemoteControlDataV1::CloseOriginal(accepted) = &frame.message else {
            unreachable!()
        };
        assert!(!state.matches_close(&frame));
        state.observe_accepted(accepted).unwrap();
        let exit = Arc::new(AtomicBool::new(false));
        let tree = Arc::new(AtomicBool::new(false));
        *state.close.lock().unwrap() = Some(CloseState {
            original: frame.clone(),
            outcome: Some(NativeRemoteCallOutcomeV1::Completed),
            observation: crate::upstream::OwnedExitObservation::test_observation(
                exit.clone(),
                tree.clone(),
            ),
            verified: true,
        });
        assert_eq!(
            state.receipt(&frame).unwrap().unwrap()["state"],
            "outcome_unknown"
        );
        exit.store(true, Ordering::SeqCst);
        let root_only = state.receipt(&frame).unwrap().unwrap();
        assert_eq!(root_only["data"]["backendExited"], true);
        assert_eq!(root_only["data"]["ownerTreeCleanupConfirmed"], false);
        assert_eq!(root_only["state"], "outcome_unknown");
        tree.store(true, Ordering::SeqCst);
        assert_eq!(state.receipt(&frame).unwrap().unwrap()["state"], "received");
        let mut other = frame.clone();
        other.request_id = "new-close".into();
        assert!(state.receipt(&other).is_err());
        let NativeRemoteControlDataV1::CloseOriginal(facts) = &mut other.message else {
            unreachable!()
        };
        facts.identity.attempt_id = "different".into();
        assert!(!state.matches_close(&other));
    }
    #[test]
    fn unknown_native_receipt_cannot_gain_credit_even_after_actual_exit_flags() {
        let frame = frame();
        let state = new_owner();
        *state.close.lock().unwrap() = Some(CloseState {
            original: frame.clone(),
            outcome: None,
            observation: crate::upstream::OwnedExitObservation::test_observation(
                Arc::new(AtomicBool::new(true)),
                Arc::new(AtomicBool::new(true)),
            ),
            verified: false,
        });
        let reply = state.receipt(&frame).unwrap().unwrap();
        assert_eq!(reply["state"], "outcome_unknown");
        assert_eq!(reply["data"]["outcome"], Value::Null);
        assert_eq!(reply["data"]["ownerTreeCleanupConfirmed"], false);
    }
}

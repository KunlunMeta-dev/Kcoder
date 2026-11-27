//! Fallible reads of the same original claim; contention never means a changed message.
use super::PeerMessageCall;

impl PeerMessageCall {
    pub fn verify_current_owner(&self) -> anyhow::Result<()> {
        anyhow::ensure!(!self.is_cancelled(), "PEER_WAKE_PROVIDER_CANCELLED");
        match self.state.try_check_lifecycle_identity(&self.owner)? {
            Some(true) => Ok(()),
            Some(false) => anyhow::bail!("PEER_WAKE_PERMIT_OWNER_CHANGED"),
            None => anyhow::bail!("PEER_WAKE_PERMIT_STATE_BUSY"),
        }
    }

    /// Identity only. The caller must still perform all current claim/Source checks.
    pub fn carries_original_claim(&self, permit: &kcoder_state::PeerAutoWakePermit) -> bool {
        self.claimed_start
            .as_ref()
            .is_some_and(|(original, stream)| {
                std::ptr::eq(original.as_ref(), permit) && permit.matches_provider_stream(*stream)
            })
    }

    pub fn verify_claimed_peer_start(&self) -> anyhow::Result<()> {
        let (permit, _) = self
            .claimed_start
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("PEER_WAKE_PROVIDER_ORIGINAL_CALL_REQUIRED"))?;
        self.verify_current_provider_invocation(permit)
    }

    pub fn verify_claimed_start_record(
        &self,
        record: &kcoder_state::cross_session_messages::CrossSessionMessageRecord,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(!self.is_cancelled(), "PEER_WAKE_PROVIDER_CANCELLED");
        let (permit, _) = self
            .claimed_start
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("PEER_WAKE_PROVIDER_ORIGINAL_CALL_REQUIRED"))?;
        permit.verify_original_record(record)?;
        self.verify_current_provider_invocation(permit)
    }

    pub fn verify_claimed_start_selector(
        &self,
        source: &kcoder_types::session_address::SessionAddressV1,
        destination: &kcoder_types::session_address::SessionAddressV1,
        client_id: &str,
        body_sha256: &str,
    ) -> anyhow::Result<()> {
        let (permit, _) = self
            .claimed_start
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("PEER_WAKE_PROVIDER_ORIGINAL_CALL_REQUIRED"))?;
        anyhow::ensure!(
            permit.matches_original_selector(source, destination, client_id, body_sha256),
            "PEER_WAKE_PROVIDER_ORIGINAL_MESSAGE_CHANGED"
        );
        self.verify_current_provider_invocation(permit)
    }

    /// Only errors produced by actual native lock observations enter backpressure.
    /// This classification is never an allow verdict or a continuation witness.
    pub fn is_temporary_claim_validation(error: &anyhow::Error) -> bool {
        error.is::<crate::peer_provider_start::OwnedTurnBusy>()
            || kcoder_state::PeerAutoWakePermit::is_temporary_start_contention(error)
    }

    pub fn claim_validation_reason(error: &anyhow::Error) -> &'static str {
        if error.is::<crate::peer_provider_start::OwnedTurnBusy>() {
            return "target_turn_owner_busy";
        }
        let native = kcoder_state::PeerAutoWakePermit::start_failure_reason(error);
        if native != "peer_wake_start_unconfirmed" {
            return native;
        }
        const CODES: &[&str] = &[
            "PEER_HISTORY_RECORD_MISMATCH",
            "PEER_WAKE_PROVIDER_ORIGINAL_MESSAGE_CHANGED",
            "PEER_WAKE_PROVIDER_CANCELLED",
            "PEER_WAKE_PROVIDER_RESPONSE_REQUIRED",
            "PEER_WAKE_PROVIDER_SCOPE_CLOSED",
            "PEER_WAKE_PROVIDER_SCOPE_CHANGED",
            "PEER_WAKE_PROVIDER_ORIGINAL_CALL_REQUIRED",
            "target_turn_changed",
            "target_turn_owner_changed",
            "target_turn_retired",
        ];
        for cause in error.chain() {
            if let Some(code) = CODES.iter().find(|code| **code == cause.to_string()) {
                return code;
            }
        }
        "peer_wake_start_unconfirmed"
    }
}

#[cfg(test)]
pub(super) mod tests;

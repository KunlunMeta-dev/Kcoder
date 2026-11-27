//! A retained original permit fences startup; it never grants Source access.
use super::*;
use crate::cross_session_messages::CrossSessionMessageRecord;
use crate::peer_agent_history::PeerHistoryCommitWitness;
use anyhow::Context;
use kcoder_types::session_address::SessionAddressV1;
use std::sync::atomic::Ordering;

impl PeerAutoWakePermit {
    pub(crate) fn provider_now_ms(&self) -> u64 {
        #[cfg(feature = "peer-wake-test-clock")]
        if let Some(clock) = self.test_clock.get() {
            return clock.load(Ordering::Acquire);
        }
        crate::now_millis()
    }
    #[cfg(feature = "peer-wake-test-clock")]
    pub fn install_provider_test_clock(
        &self,
        clock: Arc<std::sync::atomic::AtomicU64>,
    ) -> Result<u64> {
        ensure!(
            !self.started.load(Ordering::Acquire),
            "PEER_WAKE_TEST_CLOCK_ALREADY_STARTED"
        );
        self.test_clock
            .set(clock)
            .map_err(|_| anyhow::anyhow!("PEER_WAKE_TEST_CLOCK_ALREADY_BOUND"))?;
        Ok(self.expires_at_ms)
    }
    /// Resource observation only; the original object grants no Source access.
    pub fn observed_budget_usage(&self) -> Result<(u64, u32)> {
        self.store
            .upgrade()
            .context("PEER_WAKE_PERMIT_STORE_CLOSED")?
            .peer_wake_budget_usage(&self.thread_id)
    }

    pub fn bound_provider_stream(&self) -> Option<uuid::Uuid> {
        self.provider_stream.get().copied()
    }
    /// Return only the original captured owner after a fresh native check.
    pub fn checked_provider_owner(&self, state: &AppState) -> Result<AppStateLifecycleIdentity> {
        self.verify_provider_start(state, &self.owner)?;
        Ok(self.owner.clone())
    }
    /// Installing this original object is an identity binding only. All live
    /// history, quota and Source checks still run before actual dispatch.
    pub fn verify_provider_binding(&self, state: &AppState) -> Result<()> {
        ensure!(
            self.begin_succeeded.load(Ordering::Acquire)
                && self.state.shares_state_with(state)
                && self.presence.target_state().shares_state_with(state)
                && self.provider_dispatch_pending(),
            "PEER_WAKE_PROVIDER_ORIGINAL_BEGIN_REQUIRED"
        );
        Ok(())
    }

    pub fn bind_provider_stream(&self, stream_id: uuid::Uuid) -> Result<()> {
        ensure!(!stream_id.is_nil(), "PEER_WAKE_PROVIDER_STREAM_INVALID");
        let original = self.provider_stream.get_or_init(|| stream_id);
        ensure!(
            *original == stream_id,
            "PEER_WAKE_PROVIDER_STREAM_ALREADY_OWNED"
        );
        Ok(())
    }

    pub fn matches_provider_stream(&self, stream_id: uuid::Uuid) -> bool {
        self.provider_stream.get() == Some(&stream_id)
    }

    /// Borrow the original native presence without reissuing a fresh history
    /// witness, a quota claim or an automatic model-start permission.
    pub fn native_wake_presence(&self) -> &PeerHistoryCommitWitness {
        &self.presence
    }
    /// Immutable source-side locator of the claim, without its execution authority.
    pub fn original_client_message_id(&self) -> &str {
        &self.client_message_id
    }

    pub fn verify_provider_start(
        &self,
        state: &AppState,
        owner: &AppStateLifecycleIdentity,
    ) -> Result<()> {
        self.verify_provider_budget_owner(state, owner, true)
    }
    /// Budget/identity facts only. This does not authorize any Provider call;
    /// a host must require its real Engine-owned continuation witness.
    pub fn observed_provider_budget_owner(
        &self,
        state: &AppState,
    ) -> Result<AppStateLifecycleIdentity> {
        ensure!(
            !self.provider_dispatch_pending(),
            "PEER_WAKE_PROVIDER_ORIGINAL_BEGIN_REQUIRED"
        );
        self.verify_provider_budget_owner(state, &self.owner, false)?;
        Ok(self.owner.clone())
    }
    fn verify_provider_budget_owner(
        &self,
        state: &AppState,
        owner: &AppStateLifecycleIdentity,
        check_deadline: bool,
    ) -> Result<()> {
        ensure!(
            self.begin_succeeded.load(Ordering::Acquire)
                && self.state.shares_state_with(state)
                && self.owner.same_lifecycle(owner),
            "PEER_WAKE_PROVIDER_ORIGINAL_BEGIN_REQUIRED"
        );
        match state.try_check_lifecycle_identity(owner)? {
            Some(true) => {}
            Some(false) => anyhow::bail!("PEER_WAKE_PERMIT_OWNER_CHANGED"),
            None => anyhow::bail!("PEER_WAKE_PERMIT_STATE_BUSY"),
        }
        self.presence.verify_current()?;
        let admission = self
            .presence
            .idle_wake_admission()
            .context("PEER_WAKE_PROVIDER_ORIGINAL_ADMISSION_REQUIRED")?;
        admission.verify_presence(&self.presence)?;
        self.store
            .upgrade()
            .context("PEER_WAKE_PERMIT_STORE_CLOSED")?
            .verify_peer_wake_budget_binding(self, check_deadline.then(|| self.provider_now_ms()))
    }

    /// True means only this exact native permit has not crossed its first
    /// Provider dispatch. Current account/Source/target authority is separate.
    pub fn provider_dispatch_pending(&self) -> bool {
        !self.provider_dispatched.load(Ordering::Acquire)
    }

    pub fn verify_original_record(&self, record: &CrossSessionMessageRecord) -> Result<()> {
        ensure!(
            self.client_message_id == record.intent.client_message_id
                && self.message_id == record.receipt.message_id,
            "PEER_WAKE_PROVIDER_ORIGINAL_MESSAGE_CHANGED"
        );
        self.presence.matches_record(record)
    }

    /// Only native call objects may use this body-free selector to distinguish
    /// their registered peer turn from an unrelated active turn. JSON fields
    /// never create the original permit carried by that call object.
    pub fn matches_original_selector(
        &self,
        source: &SessionAddressV1,
        destination: &SessionAddressV1,
        client_message_id: &str,
        body_sha256: &str,
    ) -> bool {
        self.presence
            .message()
            .peer_agent_data()
            .is_some_and(|(metadata, _)| {
                self.client_message_id == client_message_id
                    && metadata.source_address.as_ref() == Some(source)
                    && metadata.target_address.as_ref() == Some(destination)
                    && metadata.body_sha256 == body_sha256
            })
    }

    /// The owner calls this only after a fresh Source/account/target/Wake and
    /// kernel-lease check, immediately before its first Provider invocation.
    /// A second stream or lost outcome cannot reuse this original permit.
    pub fn try_mark_provider_dispatched(
        &self,
        state: &AppState,
        owner: &AppStateLifecycleIdentity,
    ) -> Result<bool> {
        self.verify_provider_start(state, owner)?;
        Ok(self
            .provider_dispatched
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok())
    }
}

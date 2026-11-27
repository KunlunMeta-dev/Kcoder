//! Durable automatic wake accounting. Budget evidence never grants transport permission.
use crate::{AppState, AppStateLifecycleIdentity, history_store::HistorySource};
use anyhow::{Result, ensure};
use kcoder_config::PortableLeaseIdentity;
use serde::{Deserialize, Serialize};
#[cfg(feature = "peer-wake-test-clock")]
use std::sync::Arc;

pub const DEFAULT_PEER_AUTO_WAKE_LIMIT: u32 = 32;
mod provider_start;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PeerWakeUserResetReference {
    version: u32,
    pub(crate) thread_id: String,
    pub(crate) incarnation: uuid::Uuid,
    pub(crate) body_generation: uuid::Uuid,
    pub(crate) user_uuid: String,
    pub(crate) row_start: u64,
    pub(crate) row_end: u64,
    row_sha256: String,
    pub(crate) body_file: PortableLeaseIdentity,
}
impl PeerWakeUserResetReference {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_native_writer(
        thread_id: String,
        incarnation: uuid::Uuid,
        body_generation: uuid::Uuid,
        user_uuid: String,
        row_start: u64,
        row_end: u64,
        row_sha256: String,
        body_file: PortableLeaseIdentity,
    ) -> Self {
        Self {
            version: 1,
            thread_id,
            incarnation,
            body_generation,
            user_uuid,
            row_start,
            row_end,
            row_sha256,
            body_file,
        }
    }
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1
                && kcoder_types::cross_session_messages::valid_agent_message_id(&self.thread_id)
                && uuid::Uuid::parse_str(&self.user_uuid).is_ok()
                && self.row_start < self.row_end
                && self.row_sha256.len() == 64
                && self
                    .row_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()),
            "PEER_WAKE_USER_RESET_REFERENCE_INVALID"
        );
        Ok(())
    }
    fn accepts_newer(&self, incoming: &Self) -> Result<bool> {
        self.validate()?;
        incoming.validate()?;
        ensure!(
            self.thread_id == incoming.thread_id,
            "PEER_WAKE_RESET_TARGET_CHANGED"
        );
        if self == incoming {
            return Ok(false);
        }
        ensure!(
            self.user_uuid != incoming.user_uuid,
            "PEER_WAKE_USER_RESET_ALREADY_USED"
        );
        if self.incarnation == incoming.incarnation
            && self.body_generation == incoming.body_generation
        {
            ensure!(
                self.body_file == incoming.body_file && incoming.row_start >= self.row_end,
                "PEER_WAKE_USER_RESET_IS_OLDER"
            );
        }
        Ok(true)
    }
}

/// Independent native new-append facts; no exclusive row receipt is consumed.
#[derive(Clone)]
pub(crate) struct FreshPeerUserAppend {
    source: HistorySource,
    reference: PeerWakeUserResetReference,
    issued: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl FreshPeerUserAppend {
    pub(crate) fn from_native_writer(
        source: HistorySource,
        reference: PeerWakeUserResetReference,
    ) -> Self {
        Self {
            source,
            reference,
            issued: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
    pub(crate) fn witness(
        &self,
        state: &AppState,
        owner: &AppStateLifecycleIdentity,
        uuid: &str,
    ) -> Result<Option<PeerWakeUserResetWitness>> {
        ensure!(
            self.reference.user_uuid == uuid,
            "PEER_WAKE_USER_RESET_UUID_CHANGED"
        );
        let witness = PeerWakeUserResetWitness {
            state: state.clone(),
            owner: owner.clone(),
            source: self.source.clone(),
            reference: self.reference.clone(),
        };
        witness.verify_current()?;
        if self
            .issued
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_err()
        {
            return Ok(None);
        }
        Ok(Some(witness))
    }
}

/// Non-deserializable proof of a newly appended original User input.
/// Observing old history, Peer, Runtime or copied text cannot create one.
pub struct PeerWakeUserResetWitness {
    pub(crate) state: AppState,
    pub(crate) owner: AppStateLifecycleIdentity,
    source: HistorySource,
    pub(crate) reference: PeerWakeUserResetReference,
}
impl PeerWakeUserResetWitness {
    pub fn user_uuid(&self) -> &str {
        &self.reference.user_uuid
    }
    pub fn target_thread_id(&self) -> &str {
        &self.reference.thread_id
    }
    pub fn matches_target(&self, state: &AppState, owner: &AppStateLifecycleIdentity) -> bool {
        self.state.shares_state_with(state)
            && self.owner.same_lifecycle(owner)
            && owner.try_matches(state) == Some(true)
    }
    pub(crate) fn verify_current(&self) -> Result<()> {
        self.reference.validate()?;
        ensure!(
            self.owner.try_matches(&self.state) == Some(true),
            "PEER_WAKE_USER_RESET_OWNER_CHANGED"
        );
        let inner = self
            .state
            .inner
            .try_read()
            .map_err(|_| anyhow::anyhow!("PEER_WAKE_USER_RESET_STATE_BUSY"))?;
        ensure!(
            inner.session_id == self.reference.thread_id
                && inner
                    .history_source
                    .as_ref()
                    .is_some_and(|source| source.shares_binding(&self.source)),
            "PEER_WAKE_USER_RESET_SOURCE_CHANGED"
        );
        drop(inner);
        self.source.verify_peer_user_reset(&self.reference)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PeerWakeBudgetRecord {
    version: u32,
    last_real_user: Option<PeerWakeUserResetReference>,
    pub(crate) generation: u64,
    pub(crate) used: u32,
}
impl PeerWakeBudgetRecord {
    pub(crate) fn new_admitted_target() -> Self {
        Self {
            version: 1,
            last_real_user: None,
            generation: 1,
            used: 0,
        }
    }
    pub(crate) fn validate(&self, target: &str) -> Result<()> {
        ensure!(
            self.version == 1 && self.generation > 0 && self.used <= DEFAULT_PEER_AUTO_WAKE_LIMIT,
            "PEER_WAKE_BUDGET_INVALID"
        );
        if let Some(reference) = &self.last_real_user {
            reference.validate()?;
            ensure!(
                reference.thread_id == target,
                "PEER_WAKE_BUDGET_TARGET_CHANGED"
            );
        }
        Ok(())
    }
    pub(crate) fn reset(&mut self, witness: &PeerWakeUserResetWitness) -> Result<bool> {
        self.validate(witness.target_thread_id())?;
        witness.verify_current()?;
        if let Some(previous) = &self.last_real_user
            && !previous.accepts_newer(&witness.reference)?
        {
            return Ok(false);
        }
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("PEER_WAKE_BUDGET_GENERATION_OVERFLOW"))?;
        self.last_real_user = Some(witness.reference.clone());
        self.used = 0;
        Ok(true)
    }
    pub(crate) fn consume_attempt(&mut self) -> Result<PeerWakeClaimMarker> {
        ensure!(
            self.used < DEFAULT_PEER_AUTO_WAKE_LIMIT,
            "PEER_AUTO_WAKE_BUDGET_EXHAUSTED"
        );
        self.used += 1;
        Ok(PeerWakeClaimMarker {
            version: 1,
            claim_id: uuid::Uuid::new_v4(),
            budget_generation: self.generation,
        })
    }
}

/// Retained with the final message tombstone across resets and restarts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PeerWakeClaimMarker {
    version: u32,
    pub(crate) claim_id: uuid::Uuid,
    pub(crate) budget_generation: u64,
}
impl PeerWakeClaimMarker {
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1 && self.budget_generation > 0 && !self.claim_id.is_nil(),
            "PEER_WAKE_CLAIM_INVALID"
        );
        Ok(())
    }
}

/// Budget only: the host still checks its actual kernel lease and current
/// Source, account, target and wake permissions before provider startup.
pub enum PeerAutoWakeClaim {
    Permit(Box<PeerAutoWakePermit>),
    AlreadyClaimed,
    Exhausted { limit: u32, used: u32 },
    NotEligible,
}
pub struct PeerAutoWakePermit {
    pub(crate) presence: crate::peer_agent_history::PeerHistoryCommitWitness,
    pub(crate) store: std::sync::Weak<crate::cross_session_messages::CrossSessionMessageStore>,
    pub(crate) state: AppState,
    pub(crate) owner: AppStateLifecycleIdentity,
    pub(crate) namespace: String,
    pub(crate) thread_id: String,
    pub(crate) message_id: String,
    pub(crate) client_message_id: String,
    pub(crate) history_uuid: String,
    pub(crate) marker: PeerWakeClaimMarker,
    pub(crate) expires_at_ms: u64,
    pub(crate) started: std::sync::atomic::AtomicBool,
    pub(crate) begin_succeeded: std::sync::atomic::AtomicBool,
    pub(crate) provider_dispatched: std::sync::atomic::AtomicBool,
    pub(crate) provider_stream: std::sync::OnceLock<uuid::Uuid>,
    #[cfg(feature = "peer-wake-test-clock")]
    pub(crate) test_clock: std::sync::OnceLock<Arc<std::sync::atomic::AtomicU64>>,
}
impl PeerAutoWakePermit {
    /// A closed native classification, never a permission or an unknown commit.
    pub fn is_temporary_start_contention(error: &anyhow::Error) -> bool {
        crate::cross_session_messages::CrossSessionMessageStore::is_temporary_read_contention(error)
            || (error
                .chain()
                .any(|cause| cause.to_string() == "peer_source_history_writer_busy")
                && error.chain().any(|cause| {
                    cause
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::WouldBlock)
                }))
            || error.chain().any(|cause| {
                matches!(
                    cause.to_string().as_str(),
                    "PEER_HISTORY_STATE_BUSY"
                        | "PEER_HISTORY_SOURCE_BUSY"
                        | "PEER_IDLE_WAKE_STATE_BUSY"
                        | "PEER_WAKE_PERMIT_STATE_BUSY"
                )
            })
    }

    /// Only this retained original object can wait before its first begin.
    /// A begun, rejected or dispatched permit cannot enter that path again.
    pub fn can_retry_begin_after_contention(&self, error: &anyhow::Error) -> bool {
        Self::is_temporary_start_contention(error)
            && !self.started.load(std::sync::atomic::Ordering::Acquire)
            && !self
                .begin_succeeded
                .load(std::sync::atomic::Ordering::Acquire)
            && self.provider_dispatch_pending()
    }

    /// A closed diagnostic; arbitrary source errors never enter logs or context.
    pub fn start_failure_reason(error: &anyhow::Error) -> &'static str {
        if Self::is_temporary_start_contention(error) {
            return "peer_wake_start_busy";
        }
        const REASONS: &[&str] = &[
            "PEER_HISTORY_OWNER_CHANGED",
            "PEER_HISTORY_SOURCE_CHANGED",
            "PEER_HISTORY_GENERATION_CHANGED",
            "PEER_HISTORY_STATE_UNAVAILABLE",
            "PEER_HISTORY_SOURCE_UNAVAILABLE",
            "PEER_IDLE_WAKE_STATE_UNAVAILABLE",
            "PEER_IDLE_WAKE_SUPERSEDED_BY_USER",
            "PEER_IDLE_WAKE_CONTEXT_CHANGED",
            "PEER_IDLE_WAKE_ORIGINAL_HISTORY_CHANGED",
            "PEER_WAKE_PERMIT_REJECTED",
            "PEER_WAKE_PERMIT_OWNER_CHANGED",
            "PEER_WAKE_PERMIT_STORE_CLOSED",
            "PEER_WAKE_PERMIT_EXPIRED",
            "PEER_WAKE_PERMIT_NOT_CURRENT",
            "PEER_WAKE_PERMIT_BUDGET_MISSING",
            "PEER_WAKE_PERMIT_TRIGGER_MISSING",
            "PEER_WAKE_PROVIDER_ORIGINAL_BEGIN_REQUIRED",
            "PEER_WAKE_PROVIDER_ORIGINAL_ADMISSION_REQUIRED",
            "PEER_IDLE_WAKE_ADMISSION_INVALID",
            "peer_source_admission_history_changed",
            "peer_source_history_body_boundary_changed",
            "peer_source_history_control_missing",
            "peer_source_history_committed_boundary_unknown",
            "peer_source_history_observation_changed",
        ];
        for cause in error.chain() {
            let message = cause.to_string();
            if let Some(reason) = REASONS.iter().find(|reason| **reason == message) {
                return reason;
            }
        }
        "peer_wake_start_unconfirmed"
    }

    /// Consume this observation once. Lost permits are not reconstructed from
    /// ledger markers, and cancellation never refunds an automatic attempt.
    pub fn try_begin(&self) -> Result<bool> {
        self.try_begin_at(self.provider_now_ms())
    }
    pub(crate) fn try_begin_at(&self, now_ms: u64) -> Result<bool> {
        ensure!(
            !self.started.load(std::sync::atomic::Ordering::Acquire)
                || self
                    .begin_succeeded
                    .load(std::sync::atomic::Ordering::Acquire),
            "PEER_WAKE_PERMIT_REJECTED"
        );
        let checked = (|| {
            self.presence.verify_current()?;
            if let Some(admission) = self.presence.idle_wake_admission() {
                admission.verify_presence(&self.presence)?;
            }
            self.store
                .upgrade()
                .ok_or_else(|| anyhow::anyhow!("PEER_WAKE_PERMIT_STORE_CLOSED"))?
                .verify_peer_wake_permit_at(self, now_ms)
        })();
        if let Err(error) = checked {
            if !Self::is_temporary_start_contention(&error) {
                // A denied original object stays denied after clock rollback,
                // owner replacement or restoration of an old observation.
                self.started
                    .store(true, std::sync::atomic::Ordering::Release);
                self.begin_succeeded
                    .store(false, std::sync::atomic::Ordering::Release);
            }
            return Err(error);
        }
        let begun = self
            .started
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok();
        if begun {
            self.begin_succeeded
                .store(true, std::sync::atomic::Ordering::Release);
        }
        Ok(begun)
    }
}

#[cfg(test)]
#[path = "peer_wake_budget/tests.rs"]
mod tests;

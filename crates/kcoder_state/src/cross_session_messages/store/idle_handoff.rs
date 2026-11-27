//! Body-free scheduling facts and a held queue read lease, never wake authority.
use super::*;

#[derive(Clone)]
pub struct PendingColdWake {
    message_id: String,
    deadline_ms: Option<u64>,
}
impl PendingColdWake {
    pub fn message_id(&self) -> &str {
        &self.message_id
    }
    pub fn unexpired_at(&self, now_ms: u64) -> bool {
        self.deadline_ms.is_none_or(|deadline| now_ms < deadline)
    }
}

/// Only work facts are reused when the original namespace stamp is unchanged.
/// Every observation still obtains the real queue lease and verifies its owner.
#[derive(Clone)]
pub struct ColdWakeIdleHint {
    namespace: String,
    stamp: CrossSessionMessageObservationStamp,
    pending: Vec<PendingColdWake>,
}
pub struct ColdWakeIdleObservation {
    _lease: VerifiedPrivateLease,
    hint: ColdWakeIdleHint,
}
impl ColdWakeIdleObservation {
    pub fn namespace(&self) -> &str {
        &self.hint.namespace
    }
    pub fn hint(&self) -> ColdWakeIdleHint {
        self.hint.clone()
    }
    pub fn pending(&self) -> &[PendingColdWake] {
        &self.hint.pending
    }
}

/// Closed explanations for a queued Wake whose automatic cold restore did not
/// start. Every reason keeps the message `queued`; it is delivered once the
/// target is resident (restored later or opened by its owner) or expires by TTL.
/// New reasons are additive; readers must treat an unknown reason as deferred.
pub const COLD_WAKE_DEFERRED_REASONS: &[&str] = &[
    "cold_target_restore_unavailable",
    "cold_target_original_turn_unsettled",
    "cold_target_archived",
    "cold_target_source_unavailable",
    "cold_target_handoff_deferred",
    "cold_target_restore_preparation_failed",
    "cold_target_lease_busy",
    "cold_target_lifecycle_busy",
    "cold_target_history_busy",
    "cold_target_resident_capacity",
    "cold_target_scope_changed",
    "cold_target_not_independent",
    "cold_target_timeout",
];

impl CrossSessionMessageStore {
    /// Run on the caller's owned blocking worker. Keep the returned read lease
    /// until the host commits or abandons idle shutdown, so enqueue cannot pass
    /// between the final queue observation and closing that host's admissions.
    pub fn observe_idle_wake_handoff(
        &self,
        hint: Option<&ColdWakeIdleHint>,
    ) -> Result<ColdWakeIdleObservation> {
        let lease = self.lease(false)?;
        let before = self.observation_stamp()?;
        if let Some(hint) = hint.filter(|hint| hint.stamp == before) {
            self.verify()?;
            return Ok(ColdWakeIdleObservation {
                _lease: lease,
                hint: hint.clone(),
            });
        }
        let (pending, _) =
            self.access_with_archive_observed_lease_ref(false, false, &lease, |data, _| {
                let mut rows = BTreeMap::<String, Option<u64>>::new();
                for row in data.messages.values() {
                    if row.receipt.status == AgentMessageStatus::Queued
                        && row.intent.mode == AgentMessageMode::WakeIfIdle
                        && row.intent.expected_turn_id.is_none()
                        && row.created_at_ms != 0
                    {
                        rows.insert(row.receipt.message_id.clone(), row.expires_at_ms);
                    }
                }
                for (id, admission) in &data.peer_idle_wakes {
                    if data
                        .peer_wake_budgets
                        .get(&admission.thread_id)
                        .is_some_and(|budget| budget.used < crate::DEFAULT_PEER_AUTO_WAKE_LIMIT)
                    {
                        rows.insert(id.clone(), Some(admission.deadline_ms));
                    }
                }
                Ok((
                    rows.into_iter()
                        .map(|(message_id, deadline_ms)| PendingColdWake {
                            message_id,
                            deadline_ms,
                        })
                        .collect(),
                    false,
                ))
            })?;
        let stamp = self.observation_stamp()?;
        self.verify()?;
        Ok(ColdWakeIdleObservation {
            _lease: lease,
            hint: ColdWakeIdleHint {
                namespace: self.header.directory.clone(),
                stamp,
                pending,
            },
        })
    }

    /// An actual failed cold restore may explain its original queued Wake.
    /// This never settles a receipt, spends a permit or changes its payload.
    pub fn note_cold_wake_deferred(&self, message_id: &str, reason: &str) -> Result<()> {
        ensure!(
            valid_agent_message_id(message_id),
            "AGENT_MESSAGE_INVALID_ID"
        );
        ensure!(
            COLD_WAKE_DEFERRED_REASONS.contains(&reason),
            "AGENT_MESSAGE_INVALID_REASON"
        );
        self.access(true, |data| {
            let row = data
                .messages
                .values_mut()
                .find(|row| row.receipt.message_id == message_id);
            let Some(row) = row else {
                return Ok(((), false));
            };
            if row.receipt.status != AgentMessageStatus::Queued
                || row.intent.mode != AgentMessageMode::WakeIfIdle
                || row.receipt.reason_code.as_deref() == Some(reason)
            {
                return Ok(((), false));
            }
            row.receipt.reason_code = Some(reason.to_owned());
            let revision = data
                .revision
                .checked_add(1)
                .context("AGENT_MESSAGE_REVISION_OVERFLOW")?;
            row.receipt.revision = revision;
            data.revision = revision;
            Ok(((), true))
        })
    }
}

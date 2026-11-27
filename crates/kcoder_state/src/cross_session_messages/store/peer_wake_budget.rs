//! Queue-owned wake attempts. A persisted claim is never a permission cache.
use super::*;
use crate::peer_agent_history::PeerHistoryCommitWitness;
use crate::{
    DEFAULT_PEER_AUTO_WAKE_LIMIT, PeerAutoWakeClaim, PeerAutoWakePermit, PeerWakeUserResetWitness,
};
use std::sync::{Arc, atomic::AtomicBool};

const MAX_TARGET_WAKE_BUDGETS: usize = 4096;

fn seal_expired_wake(data: &mut Data, message_id: &str, deadline: u64, now: u64) -> Result<bool> {
    if data.archive_clock_ms >= deadline && !data.wake_grace_deadlines.contains_key(message_id) {
        return Ok(false);
    }
    data.archive_clock_ms = data.archive_clock_ms.max(now);
    data.wake_grace_deadlines.remove(message_id);
    data.peer_idle_wakes.remove(message_id);
    data.revision = next_revision(data)?;
    Ok(true)
}

impl CrossSessionMessageStore {
    pub(crate) fn peer_wake_budget_usage(&self, thread: &str) -> Result<(u64, u32)> {
        self.access_with_archive(false, |data, _| {
            let budget = data
                .peer_wake_budgets
                .get(thread)
                .context("PEER_WAKE_PERMIT_BUDGET_MISSING")?;
            budget.validate(thread)?;
            Ok(((budget.generation, budget.used), false))
        })
    }
    pub(super) fn validate_peer_wake_budgets(&self, data: &Data) -> Result<()> {
        ensure!(
            data.peer_wake_budgets.len() <= MAX_TARGET_WAKE_BUDGETS,
            "PEER_WAKE_BUDGET_CAPACITY"
        );
        ensure!(
            data.peer_wake_archived_claims.len() <= MAX_TARGET_WAKE_BUDGETS,
            "PEER_WAKE_BUDGET_CAPACITY"
        );
        for (target, summary) in &data.peer_wake_archived_claims {
            let budget = data
                .peer_wake_budgets
                .get(target)
                .context("PEER_WAKE_ARCHIVE_BUDGET_MISSING")?;
            ensure!(
                summary.generation > 0
                    && summary.generation <= budget.generation
                    && summary.count <= DEFAULT_PEER_AUTO_WAKE_LIMIT,
                "PEER_WAKE_ARCHIVE_COUNTER_INVALID"
            );
        }
        for (target, budget) in &data.peer_wake_budgets {
            ensure!(
                valid_agent_message_id(target),
                "PEER_WAKE_BUDGET_TARGET_INVALID"
            );
            budget.validate(target)?;
        }
        let mut current_claims = std::collections::BTreeMap::<String, u32>::new();
        let mut claim_ids = std::collections::BTreeSet::new();
        for value in data.messages.values() {
            if let Some(claim) = &value.peer_wake_claim {
                claim.validate()?;
                ensure!(
                    value.receipt.status == AgentMessageStatus::Applied
                        && value.intent.mode == AgentMessageMode::WakeIfIdle
                        && data
                            .peer_wake_budgets
                            .contains_key(&value.intent.target_thread_id),
                    "PEER_WAKE_CLAIM_DATA_INVALID"
                );
                ensure!(claim_ids.insert(claim.claim_id), "PEER_WAKE_CLAIM_REPEATED");
                let budget = &data.peer_wake_budgets[&value.intent.target_thread_id];
                if claim.budget_generation == budget.generation {
                    *current_claims
                        .entry(value.intent.target_thread_id.clone())
                        .or_default() += 1;
                }
            }
        }
        for (target, budget) in &data.peer_wake_budgets {
            ensure!(
                current_claims.get(target).copied().unwrap_or(0)
                    + data
                        .peer_wake_archived_claims
                        .get(target)
                        .filter(|summary| summary.generation == budget.generation)
                        .map_or(0, |summary| summary.count)
                    == budget.used,
                "PEER_WAKE_BUDGET_MARKERS_MISSING"
            );
        }
        Ok(())
    }

    /// Only a new native User append can reset this target. An old observed
    /// receipt or same UUID is idempotent and never refills consumed attempts.
    pub fn record_fresh_peer_user_reset(
        &self,
        witness: &PeerWakeUserResetWitness,
        expected_revision: u64,
    ) -> Result<bool> {
        witness.verify_current()?;
        self.access(true, |data| {
            revision_is(data, expected_revision)?;
            let target = witness.target_thread_id();
            if !data.peer_wake_budgets.contains_key(target) {
                ensure!(
                    data.peer_wake_budgets.len() < MAX_TARGET_WAKE_BUDGETS,
                    "PEER_WAKE_BUDGET_CAPACITY"
                );
                data.peer_wake_budgets
                    .insert(target.into(), PeerWakeBudgetRecord::new_admitted_target());
            }
            let changed = data
                .peer_wake_budgets
                .get_mut(target)
                .expect("target was inserted")
                .reset(witness)?;
            if changed {
                let retired = data
                    .peer_idle_wakes
                    .iter()
                    .filter(|(_, admission)| admission.thread_id == target)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                for id in retired {
                    data.wake_grace_deadlines.remove(&id);
                }
                data.peer_idle_wakes
                    .retain(|_, admission| admission.thread_id != target);
                data.revision = next_revision(data)?;
            }
            Ok((changed, changed))
        })
    }

    /// The real host has already rechecked Source/target/wake authority.
    /// This method only consumes durable resource quota and an exact trigger.
    pub fn claim_peer_auto_wake(
        self: &Arc<Self>,
        witness: &PeerHistoryCommitWitness,
        expected_revision: u64,
    ) -> Result<PeerAutoWakeClaim> {
        self.claim_peer_auto_wake_at(witness, expected_revision, crate::now_millis())
    }
    // The clock is native-owned; this narrow helper allows deterministic
    // expiry/rollback tests without accepting time in any public request.
    pub(super) fn claim_peer_auto_wake_at(
        self: &Arc<Self>,
        witness: &PeerHistoryCommitWitness,
        expected_revision: u64,
        now_ms: u64,
    ) -> Result<PeerAutoWakeClaim> {
        if (!witness.newly_inserted_into_context() && !witness.has_pending_idle_wake_admission())
            || !witness.is_current()
        {
            return Ok(PeerAutoWakeClaim::NotEligible);
        }
        let metadata = witness
            .message()
            .peer_agent_data()
            .context("PEER_WAKE_TRIGGER_INVALID")?
            .0;
        let message_id = metadata.message_id.clone();
        let state = witness.target_state().clone();
        let owner = state
            .try_inspection_lifecycle_identity()
            .context("PEER_WAKE_TARGET_OWNER_UNAVAILABLE")?;
        self.access_with_archive(true, |data, mut archive| {
            revision_is(data, expected_revision)?;
            let now = now_ms.max(data.archive_clock_ms);
            let (key, record, previous, deadline, archived) = if let Some((key, value)) = data
                .messages
                .iter()
                .find(|(_, value)| value.receipt.message_id == message_id)
            {
                (
                    key.clone(),
                    CrossSessionMessageRecord::from(value),
                    value.peer_wake_claim.clone(),
                    value
                        .terminal_at_ms
                        .and_then(|at| at.checked_add(archive::WAKE_GRACE_MS)),
                    false,
                )
            } else if let Some(tx) = archive.as_deref_mut() {
                let Some((key, terminal)) = self.terminal_by_message_id(tx, &message_id)? else {
                    return Ok((PeerAutoWakeClaim::NotEligible, false));
                };
                let previous = self.archived_wake_claim(tx, &message_id)?;
                if previous.is_some() {
                    return Ok((PeerAutoWakeClaim::AlreadyClaimed, false));
                }
                if terminal
                    .wake_deadline_ms
                    .is_none_or(|deadline| now >= deadline)
                {
                    if let Some(deadline) = terminal.wake_deadline_ms {
                        let changed = seal_expired_wake(data, &message_id, deadline, now)?;
                        return Ok((PeerAutoWakeClaim::NotEligible, changed));
                    }
                    return Ok((PeerAutoWakeClaim::NotEligible, false));
                }
                let record = terminal.record(tx, &key, now)?;
                (key, record, previous, terminal.wake_deadline_ms, true)
            } else {
                return Ok((PeerAutoWakeClaim::NotEligible, false));
            };
            witness.matches_record(&record)?;
            if record.receipt.status != AgentMessageStatus::Applied
                || record.intent.mode != AgentMessageMode::WakeIfIdle
            {
                return Ok((PeerAutoWakeClaim::NotEligible, false));
            }
            if previous.is_some() {
                return Ok((PeerAutoWakeClaim::AlreadyClaimed, false));
            }
            let Some(admission) = data.peer_idle_wakes.get(&message_id).cloned() else {
                return Ok((PeerAutoWakeClaim::NotEligible, false));
            };
            admission.verify_presence(witness)?;
            if let Some(attached) = witness.idle_wake_admission() {
                ensure!(attached == &admission, "PEER_IDLE_WAKE_ADMISSION_CHANGED");
            }
            let Some(deadline) = deadline.filter(|deadline| now < *deadline) else {
                if let Some(deadline) = deadline {
                    let changed = seal_expired_wake(data, &message_id, deadline, now)?;
                    return Ok((PeerAutoWakeClaim::NotEligible, changed));
                }
                return Ok((PeerAutoWakeClaim::NotEligible, false));
            };
            let thread_id = record.intent.target_thread_id.clone();
            if !data.peer_wake_budgets.contains_key(&thread_id) {
                ensure!(
                    data.peer_wake_budgets.len() < MAX_TARGET_WAKE_BUDGETS,
                    "PEER_WAKE_BUDGET_CAPACITY"
                );
                data.peer_wake_budgets.insert(
                    thread_id.clone(),
                    PeerWakeBudgetRecord::new_admitted_target(),
                );
            }
            let (messages, _, _) = state.shared_messages_with_lifecycle();
            let cohort = self.idle_wakes_in_context(data, &state, &messages);
            let budget = data
                .peer_wake_budgets
                .get_mut(&thread_id)
                .expect("target was inserted");
            if budget.used >= DEFAULT_PEER_AUTO_WAKE_LIMIT {
                let limit = DEFAULT_PEER_AUTO_WAKE_LIMIT;
                let used = budget.used;
                for id in cohort {
                    data.peer_idle_wakes.remove(&id);
                    data.wake_grace_deadlines.remove(&id);
                }
                data.revision = next_revision(data)?;
                return Ok((PeerAutoWakeClaim::Exhausted { limit, used }, true));
            }
            let marker = budget.consume_attempt()?;
            for id in cohort {
                data.peer_idle_wakes.remove(&id);
                data.wake_grace_deadlines.remove(&id);
            }
            if archived {
                self.insert_archived_wake_claim(
                    archive.context("PEER_WAKE_ARCHIVE_MISSING")?,
                    &message_id,
                    &marker,
                )?;
                self.count_archived_claim(data, &thread_id, marker.clone())?;
                data.wake_grace_deadlines.remove(&message_id);
            } else {
                data.messages
                    .get_mut(&key)
                    .expect("original message remains in checkpoint")
                    .peer_wake_claim = Some(marker.clone());
            }
            data.revision = next_revision(data)?;
            let mut presence = witness.retained_presence();
            presence.attach_idle_wake_admission(admission)?;
            let permit = PeerAutoWakePermit {
                presence,
                store: Arc::downgrade(self),
                state: state.clone(),
                owner: owner.clone(),
                namespace: self.header.directory.clone(),
                thread_id,
                message_id: message_id.clone(),
                client_message_id: record.intent.client_message_id.clone(),
                history_uuid: witness.history_uuid().into(),
                marker,
                expires_at_ms: deadline,
                started: AtomicBool::new(false),
                begin_succeeded: AtomicBool::new(false),
                provider_dispatched: AtomicBool::new(false),
                provider_stream: std::sync::OnceLock::new(),
                #[cfg(feature = "peer-wake-test-clock")]
                test_clock: std::sync::OnceLock::new(),
            };
            Ok((PeerAutoWakeClaim::Permit(Box::new(permit)), true))
        })
    }

    pub(crate) fn verify_peer_wake_permit_at(
        &self,
        permit: &PeerAutoWakePermit,
        now_ms: u64,
    ) -> Result<()> {
        self.verify_peer_wake_budget_binding(permit, Some(now_ms))
    }
    pub(crate) fn verify_peer_wake_budget_binding(
        &self,
        permit: &PeerAutoWakePermit,
        now_ms: Option<u64>,
    ) -> Result<()> {
        ensure!(
            permit.namespace == self.header.directory,
            "PEER_WAKE_PERMIT_OWNER_CHANGED"
        );
        match permit.state.try_check_lifecycle_identity(&permit.owner)? {
            Some(true) => {}
            Some(false) => anyhow::bail!("PEER_WAKE_PERMIT_OWNER_CHANGED"),
            None => anyhow::bail!("PEER_WAKE_PERMIT_STATE_BUSY"),
        }
        ensure!(
            permit.state.session_id() == permit.thread_id,
            "PEER_WAKE_PERMIT_OWNER_CHANGED"
        );
        self.access_with_archive(false, |data, archive| {
            if let Some(now_ms) = now_ms {
                ensure!(
                    now_ms.max(data.archive_clock_ms) < permit.expires_at_ms,
                    "PEER_WAKE_PERMIT_EXPIRED"
                );
            }
            let budget = data
                .peer_wake_budgets
                .get(&permit.thread_id)
                .context("PEER_WAKE_PERMIT_BUDGET_MISSING")?;
            ensure!(
                budget.generation == permit.marker.budget_generation,
                "PEER_WAKE_PERMIT_NOT_CURRENT"
            );
            if let Some(value) = data
                .messages
                .values()
                .find(|value| value.receipt.message_id == permit.message_id)
            {
                ensure!(
                    value.peer_wake_claim.as_ref() == Some(&permit.marker)
                        && value.intent.target_thread_id == permit.thread_id
                        && value.intent.mode == AgentMessageMode::WakeIfIdle
                        && value.receipt.status == AgentMessageStatus::Applied
                        && value.history_uuid.as_deref() == Some(permit.history_uuid.as_str()),
                    "PEER_WAKE_PERMIT_NOT_CURRENT"
                );
            } else {
                let tx = archive.context("PEER_WAKE_PERMIT_TRIGGER_MISSING")?;
                let (_, terminal) = self
                    .terminal_by_message_id(tx, &permit.message_id)?
                    .context("PEER_WAKE_PERMIT_TRIGGER_MISSING")?;
                ensure!(
                    self.archived_wake_claim(tx, &permit.message_id)?.as_ref()
                        == Some(&permit.marker)
                        && terminal.thread_id() == permit.thread_id
                        && terminal.binding().receipt.status == AgentMessageStatus::Applied
                        && terminal.binding().mode == AgentMessageMode::WakeIfIdle
                        && terminal.wake_deadline_ms == Some(permit.expires_at_ms)
                        && terminal.history_uuid() == Some(permit.history_uuid.as_str()),
                    "PEER_WAKE_PERMIT_NOT_CURRENT"
                );
            }
            Ok(((), false))
        })
    }
}

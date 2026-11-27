//! Only an original native idle admission may remain pending across retries.
use super::*;
use crate::peer_agent_history::{PeerHistoryCommitWitness, PeerIdleWakeAdmission};

const MAX_PENDING_IDLE_WAKES: usize = 4096;
const MAX_IDLE_WAKE_OBSERVATIONS: usize = 8;

fn idle_context_snapshot(
    state: &crate::AppState,
    owner: &crate::AppStateLifecycleIdentity,
) -> Result<(std::collections::BTreeSet<String>, crate::MessageRevision)> {
    let (messages, revision, captured) = state
        .try_shared_messages_with_lifecycle()?
        .context("PEER_IDLE_WAKE_CONTEXT_BUSY")?;
    ensure!(
        owner.same_lifecycle(&captured),
        "PEER_IDLE_WAKE_OWNER_CHANGED"
    );
    let after_user = messages
        .iter()
        .rposition(kcoder_types::is_real_user_message)
        .map_or(0, |index| index + 1);
    let current = messages
        .iter()
        .skip(after_user)
        .filter_map(|message| {
            message
                .peer_agent_data()
                .map(|(metadata, _)| metadata.message_id.clone())
        })
        .collect();
    Ok((current, revision))
}
fn obsolete_idle_ids(
    data: &Data,
    current: &std::collections::BTreeSet<String>,
    target: &str,
) -> Vec<String> {
    data.peer_idle_wakes
        .iter()
        .filter(|(id, admission)| admission.thread_id == target && !current.contains(id.as_str()))
        .map(|(id, _)| id.clone())
        .collect()
}
fn idle_snapshot_action<T>(
    state: &crate::AppState,
    owner: &crate::AppStateLifecycleIdentity,
    revision: &crate::MessageRevision,
    action: impl FnOnce() -> T,
) -> Result<T> {
    match state.try_with_lifecycle_and_revision(owner, revision, action) {
        crate::TryLifecycleAccess::Current(Some(result)) => Ok(result),
        crate::TryLifecycleAccess::Current(None) => anyhow::bail!("PEER_IDLE_WAKE_CONTEXT_CHANGED"),
        crate::TryLifecycleAccess::Busy => anyhow::bail!("PEER_IDLE_WAKE_CONTEXT_BUSY"),
        crate::TryLifecycleAccess::Changed => anyhow::bail!("PEER_IDLE_WAKE_OWNER_CHANGED"),
        crate::TryLifecycleAccess::Unavailable => {
            anyhow::bail!("PEER_IDLE_WAKE_CONTEXT_UNAVAILABLE")
        }
    }
}

#[derive(Debug)]
struct ProviderSettlementBusy(&'static str);
impl std::fmt::Display for ProviderSettlementBusy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}
impl std::error::Error for ProviderSettlementBusy {}

impl CrossSessionMessageStore {
    pub(super) fn validate_idle_wakes(&self, data: &Data) -> Result<()> {
        ensure!(
            data.peer_idle_wakes.len() <= MAX_PENDING_IDLE_WAKES,
            "PEER_IDLE_WAKE_CAPACITY"
        );
        for (message_id, admission) in &data.peer_idle_wakes {
            admission.validate(&self.header.directory)?;
            ensure!(
                message_id == &admission.message_id
                    && data
                        .peer_wake_budgets
                        .get(&admission.thread_id)
                        .is_some_and(|budget| budget.generation == admission.budget_generation),
                "PEER_IDLE_WAKE_BUDGET_CHANGED"
            );
        }
        Ok(())
    }

    /// This transition is called only by the original host's actual idle
    /// boundary. A reconciliation observation can never create this intent.
    pub fn finish_applied_at_idle(
        &self,
        lease: &CrossSessionDeliveryLease,
        witness: &PeerHistoryCommitWitness,
        expected_revision: u64,
    ) -> Result<AgentMessageReceipt> {
        ensure!(
            lease.directory == self.header.directory,
            "AGENT_MESSAGE_LEASE_MISMATCH"
        );
        self.apply_witness(
            &lease.message_id,
            Some(&lease.reservation),
            witness,
            expected_revision,
            true,
        )
    }

    pub(super) fn register_original_idle_wake(
        &self,
        data: &mut Data,
        record: &CrossSessionMessageRecord,
        witness: &PeerHistoryCommitWitness,
        terminal_at_ms: u64,
    ) -> Result<()> {
        if !witness.newly_inserted_into_context()
            || record.intent.mode != AgentMessageMode::WakeIfIdle
        {
            return Ok(());
        }
        let target = &record.intent.target_thread_id;
        if !data.peer_wake_budgets.contains_key(target) {
            ensure!(
                data.peer_wake_budgets.len() < MAX_PENDING_IDLE_WAKES,
                "PEER_WAKE_BUDGET_CAPACITY"
            );
            data.peer_wake_budgets
                .insert(target.clone(), PeerWakeBudgetRecord::new_admitted_target());
        }
        ensure!(
            data.peer_idle_wakes.len() < MAX_PENDING_IDLE_WAKES,
            "PEER_IDLE_WAKE_CAPACITY"
        );
        let deadline_ms = terminal_at_ms
            .checked_add(archive::WAKE_GRACE_MS)
            .context("PEER_IDLE_WAKE_DEADLINE_INVALID")?;
        let admission = PeerIdleWakeAdmission::from_original(
            witness,
            data.peer_wake_budgets[target].generation,
            deadline_ms,
            record.sequence,
        )?;
        ensure!(
            data.peer_idle_wakes
                .insert(record.receipt.message_id.clone(), admission)
                .is_none(),
            "PEER_IDLE_WAKE_ADMISSION_REPEATED"
        );
        Ok(())
    }

    /// This is an opaque-admission lookup, never a query over mode/history to
    /// guess that an old Applied message has not started a model.
    pub fn pending_peer_idle_wakes_for_target(
        &self,
        target_thread_id: &str,
    ) -> Result<Vec<CrossSessionMessageRecord>> {
        self.access_with_archive(false, |data, mut archive| {
            let now = crate::now_millis().max(data.archive_clock_ms);
            let mut records = Vec::new();
            let mut pending = data
                .peer_idle_wakes
                .iter()
                .filter(|(_, admission)| {
                    admission.thread_id == target_thread_id && now < admission.deadline_ms
                })
                .collect::<Vec<_>>();
            pending.sort_by_key(|(_, admission)| admission.sequence);
            for (message_id, admission) in pending.into_iter().take(MAX_IDLE_WAKE_OBSERVATIONS) {
                let record = if let Some(value) = data
                    .messages
                    .values()
                    .find(|value| &value.receipt.message_id == message_id)
                {
                    ensure!(
                        value.peer_wake_claim.is_none(),
                        "PEER_IDLE_WAKE_ALREADY_CLAIMED"
                    );
                    CrossSessionMessageRecord::from(value)
                } else {
                    let tx = archive
                        .as_deref_mut()
                        .context("PEER_IDLE_WAKE_ARCHIVE_MISSING")?;
                    let (key, terminal) = self
                        .terminal_by_message_id(tx, message_id)?
                        .context("PEER_IDLE_WAKE_ORIGINAL_RECEIPT_MISSING")?;
                    ensure!(
                        self.archived_wake_claim(tx, message_id)?.is_none(),
                        "PEER_IDLE_WAKE_ALREADY_CLAIMED"
                    );
                    terminal.record(tx, &key, now)?
                };
                ensure!(
                    record.receipt.status == AgentMessageStatus::Applied
                        && record.intent.mode == AgentMessageMode::WakeIfIdle,
                    "PEER_IDLE_WAKE_ORIGINAL_RECEIPT_CHANGED"
                );
                admission.matches_record(&record)?;
                records.push(record);
            }
            records.sort_by_key(|record| record.sequence);
            Ok((records, false))
        })
    }

    /// Attach only the exact durable original admission to a current native
    /// presence observation. The fresh-insertion bit remains unchanged.
    pub fn attach_pending_peer_idle_wake(
        &self,
        witness: &mut PeerHistoryCommitWitness,
    ) -> Result<bool> {
        let (metadata, _) = witness
            .message()
            .peer_agent_data()
            .context("PEER_IDLE_WAKE_TRIGGER_INVALID")?;
        let admission = self.access(false, |data| {
            let now = crate::now_millis().max(data.archive_clock_ms);
            Ok((
                data.peer_idle_wakes
                    .get(&metadata.message_id)
                    .filter(|admission| now < admission.deadline_ms)
                    .cloned(),
                false,
            ))
        })?;
        if let Some(admission) = admission {
            witness.attach_idle_wake_admission(admission)?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn has_pending_peer_idle_wake_for_target(&self, target: &str) -> Result<bool> {
        self.access(false, |data| {
            let now = crate::now_millis().max(data.archive_clock_ms);
            Ok((
                data.peer_idle_wakes
                    .values()
                    .any(|admission| admission.thread_id == target && now < admission.deadline_ms),
                false,
            ))
        })
    }

    /// Definite fresh route denial retires only the witnessed original intent.
    /// Unavailable/timeout results must retain it for bounded reconciliation.
    pub fn settle_pending_peer_idle_wake(
        &self,
        witness: &PeerHistoryCommitWitness,
        expected_revision: u64,
    ) -> Result<bool> {
        let admission = witness
            .idle_wake_admission()
            .context("PEER_IDLE_WAKE_ADMISSION_REQUIRED")?;
        admission.verify_presence(witness)?;
        self.access(true, |data| {
            revision_is(data, expected_revision)?;
            if data.peer_idle_wakes.get(&admission.message_id) != Some(admission) {
                return Ok((false, false));
            }
            data.peer_idle_wakes.remove(&admission.message_id);
            data.wake_grace_deadlines.remove(&admission.message_id);
            data.revision = next_revision(data)?;
            Ok((true, true))
        })
    }

    /// A definite current route denial may revoke an original admission even
    /// when that denial also prevents observing the private native body.
    pub fn settle_pending_peer_idle_wake_record(
        &self,
        record: &CrossSessionMessageRecord,
        expected_revision: u64,
    ) -> Result<bool> {
        self.access(true, |data| {
            revision_is(data, expected_revision)?;
            let Some(admission) = data.peer_idle_wakes.get(&record.receipt.message_id) else {
                return Ok((false, false));
            };
            admission.matches_record(record)?;
            data.peer_idle_wakes.remove(&record.receipt.message_id);
            data.wake_grace_deadlines.remove(&record.receipt.message_id);
            data.revision = next_revision(data)?;
            Ok((true, true))
        })
    }

    /// Actual idle ownership can retire a trigger whose exact contribution
    /// is absent from its current native context after clear or compaction.
    /// Absence only revokes a wake; it can never admit or replay one.
    pub fn settle_peer_idle_wakes_absent_from_context(
        &self,
        state: &crate::AppState,
        owner: &crate::AppStateLifecycleIdentity,
    ) -> Result<()> {
        self.settle_peer_idle_wakes_absent_from_context_checked(state, owner, || Ok(()))
    }

    /// Only acquisition of this exact namespace's writer lease may wait. A
    /// host supplies fresh cancellation/weak native-owner checks; no action,
    /// SQL transaction or authorization result is retried.
    pub fn settle_peer_idle_wakes_absent_from_context_checked(
        &self,
        state: &crate::AppState,
        owner: &crate::AppStateLifecycleIdentity,
        verify_host: impl Fn() -> Result<()>,
    ) -> Result<()> {
        let target = owner.session_id();
        verify_host()?;
        let (current, revision) = idle_context_snapshot(state, owner)?;
        let needs_cleanup = self.access(false, |data| {
            let pending = idle_snapshot_action(state, owner, &revision, || {
                !obsolete_idle_ids(data, &current, target).is_empty()
            })?;
            Ok((pending, false))
        })?;
        verify_host()?;
        if !needs_cleanup {
            return Ok(());
        }
        let deadline = std::time::Instant::now() + READ_LOCK_WAIT;
        loop {
            verify_host()?;
            ensure!(
                owner.try_matches(state) == Some(true),
                "PEER_IDLE_WAKE_OWNER_CHANGED"
            );
            if let Some(lease) = self.try_lease(true)? {
                verify_host()?;
                let (current, revision) = idle_context_snapshot(state, owner)?;
                return self
                    .access_with_archive_observed_leased(true, false, lease, |data, _| {
                        verify_host()?;
                        idle_snapshot_action(state, owner, &revision, || -> Result<((), bool)> {
                            let obsolete = obsolete_idle_ids(data, &current, target);
                            if obsolete.is_empty() {
                                return Ok(((), false));
                            }
                            let revision = next_revision(data)?;
                            for id in obsolete {
                                data.peer_idle_wakes.remove(&id);
                                data.wake_grace_deadlines.remove(&id);
                            }
                            data.revision = revision;
                            Ok(((), true))
                        })?
                    })
                    .map(|(result, _)| result);
            }
            ensure!(std::time::Instant::now() < deadline, "AGENT_MESSAGE_BUSY");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    /// A real Provider boundary settles the exact peers in its native context,
    /// including a batch consumed by one automatic or ordinary User turn.
    pub fn settle_peer_idle_wakes_in_provider_context(
        &self,
        state: &crate::AppState,
        owner: &crate::AppStateLifecycleIdentity,
        messages: &kcoder_types::SharedMessages,
    ) -> Result<()> {
        self.settle_peer_idle_wakes_in_provider_context_checked(state, owner, messages, || Ok(()))
    }

    /// Retire only the original intents in this actual Provider request's frozen
    /// input. Later messages are never treated as already read. Only acquisition
    /// of the exact writer lease may wait; a submitted transaction is never retried.
    pub fn settle_peer_idle_wakes_in_provider_context_checked(
        &self,
        state: &crate::AppState,
        owner: &crate::AppStateLifecycleIdentity,
        messages: &kcoder_types::SharedMessages,
        verify_host: impl Fn() -> Result<()>,
    ) -> Result<()> {
        let target = owner.session_id();
        let included = messages
            .iter()
            .filter_map(|message| {
                message
                    .peer_agent_data()
                    .map(|(metadata, _)| metadata.message_id.clone())
            })
            .collect::<std::collections::BTreeSet<_>>();
        let matching = |data: &Data| {
            data.peer_idle_wakes
                .iter()
                .filter(|(_, admission)| {
                    admission.thread_id == target && included.contains(&admission.message_id)
                })
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>()
        };
        verify_host()?;
        let pending = self.access(false, |data| {
            match state.try_with_lifecycle(owner, || !matching(data).is_empty()) {
                crate::TryLifecycleAccess::Current(pending) => Ok((pending, false)),
                crate::TryLifecycleAccess::Busy => anyhow::bail!("PEER_IDLE_WAKE_CONTEXT_BUSY"),
                _ => anyhow::bail!("PEER_IDLE_WAKE_OWNER_CHANGED"),
            }
        })?;
        verify_host()?;
        if !pending {
            return Ok(());
        }
        let deadline = std::time::Instant::now() + READ_LOCK_WAIT;
        loop {
            verify_host()?;
            ensure!(
                owner.try_matches(state) == Some(true),
                "PEER_IDLE_WAKE_OWNER_CHANGED"
            );
            if let Some(lease) = self.try_lease(true)? {
                verify_host()?;
                return self
                    .access_with_archive_observed_leased(true, false, lease, |data, _| {
                        verify_host()?;
                        match state.try_with_lifecycle(owner, || -> Result<((), bool)> {
                            let ids = matching(data);
                            if ids.is_empty() {
                                return Ok(((), false));
                            }
                            let revision = next_revision(data)?;
                            for id in ids {
                                data.peer_idle_wakes.remove(&id);
                                data.wake_grace_deadlines.remove(&id);
                            }
                            data.revision = revision;
                            Ok(((), true))
                        }) {
                            crate::TryLifecycleAccess::Current(result) => result,
                            crate::TryLifecycleAccess::Busy => {
                                anyhow::bail!("PEER_IDLE_WAKE_CONTEXT_BUSY")
                            }
                            _ => anyhow::bail!("PEER_IDLE_WAKE_OWNER_CHANGED"),
                        }
                    })
                    .map(|(result, _)| result);
            }
            if std::time::Instant::now() >= deadline {
                return Err(
                    ProviderSettlementBusy("peer_provider_settlement_message_lease_busy").into(),
                );
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    /// Wait only for acquisition before this original permit's first dispatch.
    /// Once storage work starts, its result is never retried, even if unknown.
    pub fn settle_peer_idle_wakes_before_first_provider(
        &self,
        state: &crate::AppState,
        owner: &crate::AppStateLifecycleIdentity,
        messages: &kcoder_types::SharedMessages,
        permit: &crate::PeerAutoWakePermit,
        stream: uuid::Uuid,
    ) -> Result<()> {
        let deadline = std::time::Instant::now() + READ_LOCK_WAIT;
        let verify_binding = || -> Result<()> {
            permit.verify_provider_binding(state)?;
            ensure!(
                permit
                    .store
                    .upgrade()
                    .is_some_and(|store| std::ptr::eq(store.as_ref(), self)),
                "PEER_PROVIDER_SETTLEMENT_STORE_CHANGED"
            );
            ensure!(
                permit.matches_provider_stream(stream) && permit.owner.same_lifecycle(owner),
                "PEER_PROVIDER_SETTLEMENT_SCOPE_CHANGED"
            );
            ensure!(
                crate::now_millis() < permit.expires_at_ms,
                "PEER_WAKE_PERMIT_EXPIRED"
            );
            Ok(())
        };
        let mut attempts = 0_u32;
        loop {
            attempts += 1;
            verify_binding()?;
            let reason = match state.try_check_lifecycle_identity(owner)? {
                Some(false) => anyhow::bail!("PEER_IDLE_WAKE_OWNER_CHANGED"),
                None => "peer_provider_settlement_state_busy",
                Some(true) => match self.try_lease(true)? {
                    Some(lease) => {
                        verify_binding()?;
                        // Recheck before reading/bootstrap/SQL can start. A lock
                        // lost here is still an acquisition-only observation.
                        match state.try_check_lifecycle_identity(owner)? {
                            Some(false) => anyhow::bail!("PEER_IDLE_WAKE_OWNER_CHANGED"),
                            None => drop(lease),
                            Some(true) => {
                                tracing::debug!(
                                    stage = "peer_provider_context_settlement",
                                    attempts,
                                    reason = "acquired_original_lease"
                                );
                                return self
                                    .access_with_archive_observed_leased(
                                        true,
                                        false,
                                        lease,
                                        |data, _| {
                                            self.settle_provider_context_locked(
                                                data,
                                                state,
                                                owner,
                                                messages,
                                                Some(permit),
                                            )
                                        },
                                    )
                                    .map(|(result, _)| result);
                            }
                        }
                        "peer_provider_settlement_state_busy"
                    }
                    None => "peer_provider_settlement_message_lease_busy",
                },
            };
            tracing::debug!(
                stage = "peer_provider_context_settlement_acquisition",
                reason,
                attempts
            );
            if std::time::Instant::now() >= deadline {
                return Err(ProviderSettlementBusy(reason).into());
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    /// Closed diagnostics only; this classification never permits a retry.
    pub fn provider_context_settlement_failure_reason(error: &anyhow::Error) -> &'static str {
        if let Some(error) = error.downcast_ref::<ProviderSettlementBusy>() {
            return error.0;
        }
        if error.chain().any(|cause| {
            cause
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::WouldBlock)
        }) {
            return "peer_provider_settlement_io_would_block";
        }
        "peer_provider_settlement_unconfirmed"
    }

    fn settle_provider_context_locked(
        &self,
        data: &mut Data,
        state: &crate::AppState,
        owner: &crate::AppStateLifecycleIdentity,
        messages: &kcoder_types::SharedMessages,
        permit: Option<&crate::PeerAutoWakePermit>,
    ) -> Result<((), bool)> {
        if let Some(permit) = permit {
            ensure!(
                data.peer_wake_budgets
                    .get(&permit.thread_id)
                    .is_some_and(|budget| budget.generation == permit.marker.budget_generation),
                "PEER_WAKE_PERMIT_GENERATION_CHANGED"
            );
        }
        let ids = self.idle_wakes_in_context(data, state, messages);
        if ids.is_empty() {
            return Ok(((), false));
        }
        ensure!(
            owner.try_matches(state) == Some(true),
            "PEER_IDLE_WAKE_OWNER_CHANGED"
        );
        for id in ids {
            data.peer_idle_wakes.remove(&id);
            data.wake_grace_deadlines.remove(&id);
        }
        data.revision = next_revision(data)?;
        Ok(((), true))
    }

    pub(super) fn idle_wakes_in_context(
        &self,
        data: &Data,
        state: &crate::AppState,
        messages: &kcoder_types::SharedMessages,
    ) -> Vec<String> {
        let target = state.session_id();
        let included = messages
            .iter()
            .filter_map(|message| {
                message
                    .peer_agent_data()
                    .map(|(metadata, _)| metadata.message_id.as_str())
            })
            .collect::<std::collections::BTreeSet<_>>();
        data.peer_idle_wakes
            .iter()
            .filter(|(_, admission)| {
                admission.thread_id == target && included.contains(admission.message_id.as_str())
            })
            .map(|(id, _)| id.clone())
            .collect()
    }
}

#[cfg(test)]
#[path = "idle_wake/tests.rs"]
mod tests;

//! Destination-owned FIFO delivery. Route labels are data; every delivery needs a fresh host resolver.
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_cli_storage::session_lease::NativeSessionLeaseWitness;
use kcoder_engine::peer_message_runtime::{PeerMessageCall, PeerMessageHost};
use kcoder_state::{
    AppState, AppStateLifecycleIdentity,
    cross_session_messages::{CrossSessionMessageRecord, CrossSessionMessageStore},
    peer_agent_history::{PeerHistoryAccess, PeerHistoryCommitWitness, PeerMessageAuthorization},
};
use kcoder_types::cross_session_messages::AgentMessageStatus;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
pub(crate) mod claimed_validation;

const MAX_DELIVERIES: usize = 8;
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);
const COMMIT_TIMEOUT: Duration = Duration::from_secs(10);
const WAKE_AUTH_TIMEOUT: Duration = Duration::from_secs(10);

/// Definite denial is safe to reject only before a queued row has been reserved.
/// A temporarily unreadable source/route is not a denial or evidence of absence.
pub enum PeerDeliveryResolutionError {
    // Part of the resolver contract; no current resolver returns a definite denial.
    #[expect(dead_code, reason = "denial is part of the resolver contract")]
    Rejected {
        code: &'static str,
    },
    Unavailable {
        code: &'static str,
    },
}
#[async_trait]
pub trait PeerDeliveryAuthorizationResolver: Send + Sync {
    /// Implementations recheck real Native/Gateway source and destination scope,
    /// actual current policy, route generation and original target turn. Returned
    /// check_current must keep checking those captured live owners/revocations.
    /// No implementation is supplied by default and selectors grant nothing.
    async fn resolve(
        &self,
        call: &PeerMessageCall,
        record: &CrossSessionMessageRecord,
    ) -> std::result::Result<Arc<dyn PeerMessageAuthorization>, PeerDeliveryResolutionError>;
}

/// The original SessionLease owner must outlive this weak native witness.
/// Holding this receiver does not keep a disconnected owner's kernel lease alive.
pub struct DestinationPeerMessageDriver {
    state: AppState,
    owner: AppStateLifecycleIdentity,
    history_path: PathBuf,
    lease: Arc<NativeSessionLeaseWitness>,
    store: Arc<CrossSessionMessageStore>,
    resolver: Arc<dyn PeerDeliveryAuthorizationResolver>,
    gate: Mutex<()>,
    #[cfg(test)]
    settlement_workers: Arc<std::sync::atomic::AtomicUsize>,
}
enum DeliveryStep {
    Applied(PeerHistoryCommitWitness),
    AppliedStop(PeerHistoryCommitWitness),
    Progress,
    Stop,
}
struct IdleSettlementOwner(Arc<std::sync::atomic::AtomicBool>);
impl Drop for IdleSettlementOwner {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}
struct BoundAuthority {
    inner: Arc<dyn PeerMessageAuthorization>,
    owner: AppStateLifecycleIdentity,
    history_path: PathBuf,
    lease: Arc<NativeSessionLeaseWitness>,
}
#[async_trait::async_trait]
impl PeerMessageAuthorization for BoundAuthority {
    async fn check_current(
        &self,
        access: PeerHistoryAccess,
        target: &AppState,
        owner: &AppStateLifecycleIdentity,
        record: &CrossSessionMessageRecord,
    ) -> Result<()> {
        ensure!(
            self.owner.same_lifecycle(owner),
            "peer_delivery_target_changed"
        );
        claimed_validation::verify_bound_target(target, owner, &self.history_path, &self.lease)?;
        self.inner
            .check_current(access, target, owner, record)
            .await?;
        claimed_validation::verify_bound_target(target, owner, &self.history_path, &self.lease)
    }
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
impl DestinationPeerMessageDriver {
    /// Called only by a real host holding this exact target's execution/session lease.
    /// The resolver is mandatory; neither queue scope nor a role string authorizes a send.
    pub fn new(
        state: AppState,
        owner: AppStateLifecycleIdentity,
        lease: NativeSessionLeaseWitness,
        store: Arc<CrossSessionMessageStore>,
        resolver: Arc<dyn PeerDeliveryAuthorizationResolver>,
    ) -> Result<Self> {
        let history_path = state
            .history_path()
            .context("peer_delivery_history_required")?;
        ensure!(
            owner.try_matches(&state) == Some(true),
            "peer_delivery_owner_changed"
        );
        lease.verify_target(&history_path)?;
        Ok(Self {
            state,
            owner,
            history_path,
            lease: Arc::new(lease),
            store,
            resolver,
            gate: Mutex::new(()),
            #[cfg(test)]
            settlement_workers: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        })
    }
    fn verify_call(&self, call: &PeerMessageCall) -> Result<()> {
        claimed_validation::verify_target(
            &self.state,
            &self.owner,
            &self.history_path,
            &self.lease,
            Some(call),
        )
    }
    async fn settle_idle_context(&self, call: &PeerMessageCall) -> Result<()> {
        self.settle_context_worker(call, None).await
    }
    async fn settle_context_worker(
        &self,
        call: &PeerMessageCall,
        messages: Option<kcoder_types::SharedMessages>,
    ) -> Result<()> {
        let active = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let owner_guard = IdleSettlementOwner(active.clone());
        let worker_call = call.clone();
        let state = self.state.clone();
        let owner = self.owner.clone();
        let lease = self.lease.clone();
        let path = self.history_path.clone();
        let store = self.store.clone();
        #[cfg(test)]
        let workers = self.settlement_workers.clone();
        let mut worker = tokio::task::spawn_blocking(move || {
            #[cfg(test)]
            let _worker_count = {
                struct Count(Arc<std::sync::atomic::AtomicUsize>);
                impl Drop for Count {
                    fn drop(&mut self) {
                        self.0.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
                    }
                }
                workers.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                Count(workers)
            };
            let verify = || {
                ensure!(
                    active.load(std::sync::atomic::Ordering::Acquire)
                        && !worker_call.is_cancelled(),
                    "peer_idle_owner_cancelled"
                );
                ensure!(
                    worker_call.is_current()
                        && state.try_lifecycle_history_matches(&owner, &path) == Some(true),
                    "peer_delivery_target_changed"
                );
                lease.verify_target(&path)
            };
            match messages.as_ref() {
                Some(messages) => worker_call
                    .settle_idle_wakes_in_provider_context_checked(&store, messages, verify),
                None => {
                    store.settle_peer_idle_wakes_absent_from_context_checked(&state, &owner, verify)
                }
            }
        });
        tokio::select! {
            biased;
            _ = call.cancelled() => {
                owner_guard.0.store(false, std::sync::atomic::Ordering::Release);
                let _ = worker.await;
                anyhow::bail!("peer_idle_owner_cancelled");
            }
            result = &mut worker => result.context("peer_idle_settlement_worker_failed")?,
        }
    }
    fn keep_unknown(
        &self,
        lease: &kcoder_state::cross_session_messages::CrossSessionDeliveryLease,
    ) {
        // A concurrent enqueue may change the namespace revision. Retrying this
        // bookkeeping mutation never retries the history append or external work.
        for _ in 0..3 {
            let Ok(revision) = self.store.revision() else {
                return;
            };
            if self.store.mark_unknown(lease, revision).is_ok() {
                return;
            }
            let Ok(Some(record)) = self
                .store
                .get_record_by_message_id(&lease.record().receipt.message_id)
            else {
                return;
            };
            if record.receipt.status != AgentMessageStatus::Delivering {
                return;
            }
        }
    }
    fn finish_receipt(
        &self,
        lease: &kcoder_state::cross_session_messages::CrossSessionDeliveryLease,
        witness: &PeerHistoryCommitWitness,
        original_idle: bool,
    ) -> bool {
        for _ in 0..3 {
            let Ok(revision) = self.store.revision() else {
                return false;
            };
            let receipt = if original_idle {
                self.store.finish_applied_at_idle(lease, witness, revision)
            } else {
                self.store.finish_applied(lease, witness, revision)
            };
            if receipt.is_ok() {
                return true;
            }
            let Ok(Some(record)) = self
                .store
                .get_record_by_message_id(&lease.record().receipt.message_id)
            else {
                return false;
            };
            if record.receipt.status == AgentMessageStatus::Applied {
                return true;
            }
            if !matches!(
                record.receipt.status,
                AgentMessageStatus::Delivering | AgentMessageStatus::Unknown
            ) {
                return false;
            }
        }
        false
    }
    fn defer_unstarted(
        &self,
        lease: &kcoder_state::cross_session_messages::CrossSessionDeliveryLease,
        proof: &kcoder_state::peer_agent_history::PeerHistoryNoWriteWitness,
    ) -> bool {
        for _ in 0..3 {
            let Ok(revision) = self.store.revision() else {
                return false;
            };
            if self.store.defer_unstarted(lease, proof, revision).is_ok() {
                return true;
            }
            let Ok(Some(record)) = self
                .store
                .get_record_by_message_id(&lease.record().receipt.message_id)
            else {
                return false;
            };
            if record.receipt.status == AgentMessageStatus::Queued {
                return true;
            }
            if record.receipt.status != AgentMessageStatus::Delivering {
                return false;
            }
        }
        false
    }
    async fn apply_one(&self, call: &PeerMessageCall) -> Result<DeliveryStep> {
        self.verify_call(call)?;
        self.store.maintain(now_ms())?;
        // Resolution can yield to another process. Reserve only the same
        // snapshot that supplied this head, never a later row with its guard.
        let resolved_revision = self.store.revision()?;
        let rows = self.store.pending_for_target(&self.state.session_id())?;
        let Some(head) = rows.first() else {
            return Ok(DeliveryStep::Stop);
        };
        let resolved = tokio::select! {
            biased;
            _ = call.cancelled() => anyhow::bail!("peer_delivery_owner_cancelled"),
            result = tokio::time::timeout(RESOLVE_TIMEOUT, self.resolver.resolve(call, head)) => result,
        };
        let authority = match resolved {
            Ok(Ok(authority)) => Arc::new(BoundAuthority {
                inner: authority,
                owner: self.owner.clone(),
                history_path: self.history_path.clone(),
                lease: self.lease.clone(),
            }),
            Ok(Err(PeerDeliveryResolutionError::Rejected { code }))
                if head.receipt.status == AgentMessageStatus::Queued =>
            {
                self.store
                    .reject_queued(&head.receipt.message_id, code, self.store.revision()?)?;
                return Ok(DeliveryStep::Progress);
            }
            Ok(Err(PeerDeliveryResolutionError::Unavailable { .. })) => {
                return Ok(DeliveryStep::Stop);
            }
            Ok(Err(PeerDeliveryResolutionError::Rejected { .. })) => {
                return Ok(DeliveryStep::Stop);
            }
            Err(_) => {
                return Ok(DeliveryStep::Stop);
            }
        };

        self.verify_call(call)?;
        if matches!(
            head.receipt.status,
            AgentMessageStatus::Delivering | AgentMessageStatus::Unknown
        ) {
            // Unknown writers are never restarted. Observe the original row only.
            return match tokio::time::timeout(
                COMMIT_TIMEOUT,
                self.state
                    .observe_peer_message_commit(&self.owner, head, authority.as_ref()),
            )
            .await
            {
                Ok(Ok(Some(witness))) => {
                    self.verify_call(call)?;
                    self.store.reconcile_applied(
                        &head.receipt.message_id,
                        &witness,
                        self.store.revision()?,
                    )?;
                    Ok(DeliveryStep::Applied(witness))
                }
                _ => Ok(DeliveryStep::Stop),
            };
        }
        if head
            .intent
            .expected_turn_id
            .as_deref()
            .is_some_and(|expected| {
                call.is_idle()
                    || call
                        .attempt()
                        .is_none_or(|current| current.turn_id != expected)
            })
        {
            self.store.reject_queued(
                &head.receipt.message_id,
                "target_turn_changed",
                self.store.revision()?,
            )?;
            return Ok(DeliveryStep::Progress);
        }
        tokio::select! {
            biased;
            _ = call.cancelled() => anyhow::bail!("peer_delivery_owner_cancelled"),
            result = authority.check_current(PeerHistoryAccess::Append, &self.state, &self.owner, head) => result?,
        }
        let history_scope = call
            .attempt()
            .map(|attempt| self.state.history_attempt_scope(attempt.clone()))
            .transpose()?;
        let now = now_ms();
        let Some(lease) = self.store.reserve_next(
            &self.state.session_id(),
            resolved_revision,
            now,
            now.saturating_add(60_000),
        )?
        else {
            return Ok(DeliveryStep::Stop);
        };
        let commit = async {
            if let Some(scope) = history_scope {
                scope
                    .run(
                        self.state
                            .commit_peer_message(&self.owner, &lease, authority.as_ref()),
                    )
                    .await
            } else {
                self.state
                    .commit_peer_message(&self.owner, &lease, authority.as_ref())
                    .await
            }
        };
        let witness = match tokio::time::timeout(COMMIT_TIMEOUT, commit).await {
            Ok(Ok(witness)) => witness,
            Ok(Err(error)) => {
                if let Some(proof) = error.no_write_witness()
                    && self.defer_unstarted(&lease, proof)
                {
                    return Ok(DeliveryStep::Stop);
                }

                self.keep_unknown(&lease);
                return Ok(DeliveryStep::Stop);
            }
            _ => {
                self.keep_unknown(&lease);
                return Ok(DeliveryStep::Stop);
            }
        };
        if self.verify_call(call).is_err() || !self.finish_receipt(&lease, &witness, call.is_idle())
        {
            self.keep_unknown(&lease);
            // The native row and context are already known. Return that fact
            // even if queue bookkeeping is unknown, so intent restrictions and
            // presentation do not depend on receiving a second ledger receipt.
            return Ok(DeliveryStep::AppliedStop(witness));
        }

        Ok(DeliveryStep::Applied(witness))
    }
    async fn apply(&self, call: PeerMessageCall) -> Result<Vec<PeerHistoryCommitWitness>> {
        let Ok(_gate) = self.gate.try_lock() else {
            return Ok(Vec::new());
        };
        self.verify_call(&call)?;
        if call.is_idle() {
            self.settle_idle_context(&call).await?;
        }
        let mut applied = Vec::new();
        for _ in 0..MAX_DELIVERIES {
            match self.apply_one(&call).await {
                Ok(DeliveryStep::Applied(witness)) => applied.push(witness),
                Ok(DeliveryStep::AppliedStop(witness)) => {
                    applied.push(witness);
                    break;
                }
                Ok(DeliveryStep::Progress) => {}
                Ok(DeliveryStep::Stop) => break,
                Err(_error) => {
                    break;
                }
            }
        }
        if call.is_cancelled() {
            return Ok(applied);
        }
        if call.is_idle() {
            for witness in &mut applied {
                let _ = self.store.attach_pending_peer_idle_wake(witness);
            }
            let pending = match self
                .store
                .pending_peer_idle_wakes_for_target(&self.state.session_id())
            {
                Ok(pending) => pending,
                Err(_) => return Ok(applied),
            };
            // One surviving trigger starts the whole current model context.
            // Do not hold the target gate for a network retry per old message.
            for record in pending.into_iter().take(1) {
                if applied.iter().any(|witness| {
                    witness
                        .message()
                        .peer_agent_data()
                        .is_some_and(|(metadata, _)| {
                            metadata.message_id == record.receipt.message_id
                        })
                }) {
                    continue;
                }
                self.verify_call(&call)?;
                let authority = match tokio::time::timeout(
                    WAKE_AUTH_TIMEOUT,
                    self.resolver.resolve(&call, &record),
                )
                .await
                {
                    Ok(Ok(inner)) => BoundAuthority {
                        inner,
                        owner: self.owner.clone(),
                        history_path: self.history_path.clone(),
                        lease: self.lease.clone(),
                    },
                    Ok(Err(PeerDeliveryResolutionError::Rejected { .. })) => {
                        if let Ok(revision) = self.store.revision() {
                            let _ = self
                                .store
                                .settle_pending_peer_idle_wake_record(&record, revision);
                        }
                        continue;
                    }
                    _ => continue,
                };
                let observed = tokio::time::timeout(
                    WAKE_AUTH_TIMEOUT,
                    self.state
                        .observe_peer_message_commit(&self.owner, &record, &authority),
                )
                .await;
                if let Ok(Ok(Some(mut witness))) = observed
                    && matches!(
                        self.store.attach_pending_peer_idle_wake(&mut witness),
                        Ok(true)
                    )
                {
                    applied.push(witness);
                }
            }
        }
        Ok(applied)
    }
}

#[async_trait]
impl PeerMessageHost for DestinationPeerMessageDriver {
    async fn authorize_claimed_provider_start(
        &self,
        call: PeerMessageCall,
        permit: &kcoder_state::PeerAutoWakePermit,
    ) -> std::result::Result<(), String> {
        if !call.carries_original_claim(permit) {
            return Err("peer_provider_start_original_permit_not_current".into());
        }
        let witness = permit.native_wake_presence();
        let (metadata, _) = witness
            .message()
            .peer_agent_data()
            .ok_or("peer_provider_start_original_message_required")?;
        self.read_claimed_original(&call, &metadata.message_id)
            .await?;
        if !self
            .authorize_idle_wake(call, std::slice::from_ref(witness))
            .await?
        {
            return Err("peer_provider_start_current_authorization_required".into());
        }
        Ok(())
    }
    async fn settle_idle_wakes_in_provider_context(
        &self,
        call: PeerMessageCall,
        messages: &kcoder_types::SharedMessages,
    ) -> std::result::Result<(), String> {
        self.verify_call(&call)
            .map_err(|_| "peer_provider_owner_changed".to_owned())?;
        let settled = self
            .settle_context_worker(&call, Some(messages.clone()))
            .await;
        settled.map_err(|error| {
            tracing::warn!(
                stage = "peer_provider_context_settlement",
                reason =
                    CrossSessionMessageStore::provider_context_settlement_failure_reason(&error),
            );
            "peer_provider_pending_wake_settlement_unavailable".to_owned()
        })?;
        self.verify_call(&call)
            .map_err(|_| "peer_provider_owner_changed".to_owned())
    }
    async fn record_fresh_user_reset(
        &self,
        call: PeerMessageCall,
        witness: &kcoder_state::PeerWakeUserResetWitness,
    ) -> std::result::Result<(), String> {
        self.verify_call(&call)
            .map_err(|_| "peer_wake_reset_owner_changed".to_owned())?;
        if !witness.matches_target(&self.state, &self.owner) {
            return Err("peer_wake_reset_target_changed".into());
        }
        for _ in 0..3 {
            let revision = self
                .store
                .revision()
                .map_err(|_| "peer_wake_budget_unavailable".to_owned())?;
            if self
                .store
                .record_fresh_peer_user_reset(witness, revision)
                .is_ok()
            {
                return Ok(());
            }
            self.verify_call(&call)
                .map_err(|_| "peer_wake_reset_owner_changed".to_owned())?;
        }
        Err("peer_wake_budget_reset_deferred".into())
    }
    async fn claim_idle_wake(
        &self,
        call: PeerMessageCall,
        witnesses: &[PeerHistoryCommitWitness],
    ) -> std::result::Result<kcoder_state::PeerAutoWakeClaim, String> {
        self.verify_call(&call)
            .map_err(|_| "peer_wake_owner_changed".to_owned())?;
        if !call.is_idle() {
            return Ok(kcoder_state::PeerAutoWakeClaim::NotEligible);
        }
        for witness in witnesses {
            if !self
                .authorize_idle_wake(call.clone(), std::slice::from_ref(witness))
                .await?
            {
                continue;
            }
            for _ in 0..3 {
                self.verify_call(&call)
                    .map_err(|_| "peer_wake_budget_owner_changed".to_owned())?;
                let revision = self
                    .store
                    .revision()
                    .map_err(|_| "peer_wake_budget_unavailable".to_owned())?;
                if let Ok(claim) = self.store.claim_peer_auto_wake(witness, revision) {
                    return Ok(claim);
                }
            }
            return Err("peer_wake_budget_claim_unconfirmed".into());
        }
        Ok(kcoder_state::PeerAutoWakeClaim::NotEligible)
    }
    fn observation_stamp(
        &self,
    ) -> std::result::Result<
        Option<kcoder_state::cross_session_messages::CrossSessionMessageObservationStamp>,
        String,
    > {
        self.store
            .observation_stamp()
            .map(Some)
            .map_err(|_| "peer_delivery_observation_unavailable".into())
    }

    async fn authorize_idle_wake(
        &self,
        call: PeerMessageCall,
        witnesses: &[PeerHistoryCommitWitness],
    ) -> std::result::Result<bool, String> {
        self.verify_call(&call).map_err(|error| {
            claimed_validation::public_read_error(&error, "peer_wake_owner_changed")
        })?;
        if !call.is_idle() {
            call.verify_claimed_peer_start().map_err(|error| {
                if !claimed_validation::is_temporary_read_contention(&error) {
                    tracing::warn!(
                        stage = "peer_claimed_wake_authorization",
                        reason = claimed_validation::claimed_read_reason(&error)
                    );
                }
                claimed_validation::public_read_error(
                    &error,
                    "peer_provider_start_original_permit_not_current",
                )
            })?;
        }
        for witness in witnesses {
            if !witness.has_pending_idle_wake_admission()
                || (call.is_idle() && !witness.is_current())
                || !witness.target_state().shares_state_with(&self.state)
            {
                continue;
            }
            let Some((metadata, _)) = witness.message().peer_agent_data() else {
                continue;
            };
            let record = if call.is_idle() {
                let Some(record) = self
                    .store
                    .get_record_by_message_id(&metadata.message_id)
                    .map_err(|error| {
                        claimed_validation::public_read_error(
                            &error,
                            "peer_wake_record_unavailable",
                        )
                    })?
                else {
                    continue;
                };
                record
            } else {
                self.read_claimed_original(&call, &metadata.message_id)
                    .await?
            };
            if record.receipt.status != AgentMessageStatus::Applied
                || record.intent.mode
                    != kcoder_types::cross_session_messages::AgentMessageMode::WakeIfIdle
            {
                continue;
            }
            if kcoder_state::peer_agent_history::peer_history_uuid(&record)
                .ok()
                .as_deref()
                != Some(witness.history_uuid())
            {
                continue;
            }
            let authority = match tokio::time::timeout(
                WAKE_AUTH_TIMEOUT,
                self.resolver.resolve(&call, &record),
            )
            .await
            {
                Ok(Ok(authority)) => authority,
                Ok(Err(PeerDeliveryResolutionError::Rejected { .. })) => {
                    for _ in 0..3 {
                        let revision = self
                            .store
                            .revision()
                            .map_err(|_| "peer_wake_record_unavailable".to_owned())?;
                        if self
                            .store
                            .settle_pending_peer_idle_wake(witness, revision)
                            .is_ok()
                        {
                            break;
                        }
                    }
                    continue;
                }
                Ok(Err(PeerDeliveryResolutionError::Unavailable {
                    code: "peer_provider_start_original_read_busy",
                })) => return Err("peer_provider_start_original_read_busy".into()),
                _ => return Err("peer_wake_authorization_deferred".into()),
            };
            self.verify_call(&call)
                .map_err(|_| "peer_wake_owner_changed".to_owned())?;
            let bound = BoundAuthority {
                inner: authority,
                owner: self.owner.clone(),
                history_path: self.history_path.clone(),
                lease: self.lease.clone(),
            };
            tokio::time::timeout(
                WAKE_AUTH_TIMEOUT,
                bound.check_current(PeerHistoryAccess::Wake, &self.state, &self.owner, &record),
            )
            .await
            .map_err(|_| "peer_wake_authorization_deferred".to_owned())?
            .map_err(|error| {
                claimed_validation::public_read_error(&error, "peer_wake_authorization_deferred")
            })?;
            self.verify_call(&call).map_err(|error| {
                claimed_validation::public_read_error(&error, "peer_wake_owner_changed")
            })?;
            return Ok(true);
        }
        Ok(false)
    }
    async fn apply_at_boundary(
        &self,
        call: PeerMessageCall,
    ) -> std::result::Result<Vec<PeerHistoryCommitWitness>, String> {
        // Queue, route and permission failures do not end an unrelated user turn.
        // Staged State delivery does not expose unconfirmed peers to model memory.
        match self.apply(call).await {
            Ok(witnesses) => Ok(witnesses),
            Err(_) => {
                tracing::debug!("peer_destination_delivery_deferred");
                Ok(Vec::new())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_cli_storage::session_lease::SessionLease;
    use kcoder_types::{Message, cross_session_messages::*};
    use std::ffi::OsStr;
    struct FixtureResolver {
        source: String,
        target: String,
        wake: Arc<std::sync::atomic::AtomicBool>,
    }
    struct FixtureAuthority {
        source: String,
        target: String,
        wake: Arc<std::sync::atomic::AtomicBool>,
    }
    struct HeadAdvancingResolver {
        delegate: FixtureResolver,
        store: Arc<CrossSessionMessageStore>,
        advanced: std::sync::atomic::AtomicBool,
        calls: Arc<std::sync::atomic::AtomicUsize>,
    }
    #[async_trait]
    impl PeerDeliveryAuthorizationResolver for HeadAdvancingResolver {
        async fn resolve(
            &self,
            call: &PeerMessageCall,
            record: &CrossSessionMessageRecord,
        ) -> std::result::Result<Arc<dyn PeerMessageAuthorization>, PeerDeliveryResolutionError>
        {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if !self
                .advanced
                .swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                // Model another queue owner finishing this head while the
                // actual route authorization RPC is in flight.
                self.store
                    .reject_queued(
                        &record.receipt.message_id,
                        "source_revoked",
                        self.store.revision().unwrap(),
                    )
                    .unwrap();
            }
            self.delegate.resolve(call, record).await
        }
    }
    #[async_trait::async_trait]
    impl PeerMessageAuthorization for FixtureAuthority {
        async fn check_current(
            &self,
            access: PeerHistoryAccess,
            target: &AppState,
            owner: &AppStateLifecycleIdentity,
            record: &CrossSessionMessageRecord,
        ) -> Result<()> {
            ensure!(
                owner.try_matches(target) == Some(true)
                    && target.session_id() == self.target
                    && record.source.thread_id == self.source,
                "owned_fixture_scope_changed"
            );
            ensure!(
                access != PeerHistoryAccess::Wake
                    || self.wake.load(std::sync::atomic::Ordering::SeqCst),
                "owned_fixture_wake_denied"
            );
            Ok(())
        }
    }
    #[async_trait]
    impl PeerDeliveryAuthorizationResolver for FixtureResolver {
        async fn resolve(
            &self,
            _: &PeerMessageCall,
            _: &CrossSessionMessageRecord,
        ) -> std::result::Result<Arc<dyn PeerMessageAuthorization>, PeerDeliveryResolutionError>
        {
            Ok(Arc::new(FixtureAuthority {
                source: self.source.clone(),
                target: self.target.clone(),
                wake: self.wake.clone(),
            }))
        }
    }
    #[tokio::test]
    async fn owned_native_lease_driver_applies_fifo_and_stops_after_its_original_owner_closes() {
        let root = kcoder_config::create_private_temp_dir("peer-native-delivery-driver").unwrap();
        let engine = crate::app_server::tests::catalog_list_test_engine(root.path());
        let path = root
            .path()
            .join("actual-interactive-artifact")
            .join(format!("{}.jsonl", engine.state.session_id()));
        let native = SessionLease::acquire(&path).unwrap();
        engine.state.with_history_path(&path);
        engine
            .state
            .add_message(Message::user_text("Original receiving user task"));
        engine.state.flush_history().await.unwrap();
        let store = Arc::new(
            CrossSessionMessageStore::create_in(
                &kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap(),
                OsStr::new("shared-mailbox"),
                &CrossSessionMessageScope {
                    account_id: "owned-account".into(),
                    target_id: "owned-target".into(),
                    workspace_id: "owned-workspace".into(),
                },
            )
            .unwrap(),
        );
        let source = CrossSessionMessageSource {
            thread_id: "owned-source".into(),
            principal_id: "owned-principal".into(),
            address: None,
        };
        let target_id = engine.state.session_id();
        let intent = |id: &str| AgentMessageIntent {
            reply_to_message_id: None,
            target_thread_id: target_id.clone(),
            target_address: None,
            client_message_id: id.into(),
            mode: AgentMessageMode::EnqueueOnly,
            expected_turn_id: None,
            text: format!("Owned peer contribution {id}"),
        };
        store.enqueue(&source, intent("first"), 1).unwrap();
        store.enqueue(&source, intent("second"), 2).unwrap();
        let wake = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let driver = DestinationPeerMessageDriver::new(
            engine.state.clone(),
            engine.state.inspection_lifecycle_identity(),
            native.native_witness().unwrap(),
            store.clone(),
            Arc::new(FixtureResolver {
                source: source.thread_id.clone(),
                target: engine.state.session_id(),
                wake: wake.clone(),
            }),
        )
        .unwrap();
        let engine = engine.with_peer_message_host(Arc::new(driver));
        let witnesses = engine.apply_peer_messages_at_idle().await.unwrap();
        assert_eq!(witnesses.len(), 2);
        assert!(
            !engine.peer_idle_wake_authorized(&witnesses).await.unwrap(),
            "enqueue_only history presence never authorizes a model wake"
        );
        assert_eq!(
            witnesses[0].message().peer_agent_data().unwrap().1,
            "Owned peer contribution first"
        );
        assert_eq!(
            store
                .get_by_client_id(&source, "first")
                .unwrap()
                .unwrap()
                .status,
            AgentMessageStatus::Applied
        );
        assert_eq!(
            store
                .get_by_client_id(&source, "second")
                .unwrap()
                .unwrap()
                .status,
            AgentMessageStatus::Applied
        );
        assert_eq!(
            engine
                .state
                .messages()
                .iter()
                .filter(|message| kcoder_types::is_real_user_message(message))
                .count(),
            1
        );
        let mut waking = intent("wake-request");
        waking.mode = AgentMessageMode::WakeIfIdle;
        store
            .enqueue(&source, waking, store.revision().unwrap())
            .unwrap();
        let waking = engine.apply_peer_messages_at_idle().await.unwrap();
        assert_eq!(waking.len(), 1);
        assert_eq!(
            engine.peer_idle_wake_authorized(&waking).await,
            Err("peer_wake_authorization_deferred".into()),
            "an unreadable/failed current authority is distinct from NotEligible"
        );
        wake.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(engine.peer_idle_wake_authorized(&waking).await.unwrap());
        wake.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            engine.peer_idle_wake_authorized(&waking).await,
            Err("peer_wake_authorization_deferred".into()),
            "revocation is rechecked and never cached as allow"
        );
        wake.store(true, std::sync::atomic::Ordering::SeqCst);
        let kcoder_state::PeerAutoWakeClaim::Permit(permit) =
            engine.claim_peer_auto_wake(&waking).await.unwrap()
        else {
            panic!("the original unclaimed trigger requires its single permit")
        };
        drop(permit);
        wake.store(false, std::sync::atomic::Ordering::SeqCst);
        store
            .enqueue(&source, intent("racing-head"), store.revision().unwrap())
            .unwrap();
        store
            .enqueue(&source, intent("racing-next"), store.revision().unwrap())
            .unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let driver = DestinationPeerMessageDriver::new(
            engine.state.clone(),
            engine.state.inspection_lifecycle_identity(),
            native.native_witness().unwrap(),
            store.clone(),
            Arc::new(HeadAdvancingResolver {
                delegate: FixtureResolver {
                    source: source.thread_id.clone(),
                    target: engine.state.session_id(),
                    wake: wake.clone(),
                },
                store: store.clone(),
                advanced: std::sync::atomic::AtomicBool::new(false),
                calls: calls.clone(),
            }),
        )
        .unwrap();
        let engine = engine.with_peer_message_host(Arc::new(driver));
        assert!(
            engine
                .apply_peer_messages_at_idle()
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            store
                .get_by_client_id(&source, "racing-next")
                .unwrap()
                .unwrap()
                .status,
            AgentMessageStatus::Queued,
            "a different FIFO head cannot inherit the previous head's authority"
        );
        let next = engine.apply_peer_messages_at_idle().await.unwrap();
        assert_eq!(next.len(), 1);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(
            next[0].message().peer_agent_data().unwrap().1,
            "Owned peer contribution racing-next"
        );
        drop(native);
        store
            .enqueue(&source, intent("after-close"), store.revision().unwrap())
            .unwrap();
        assert!(
            engine
                .apply_peer_messages_at_idle()
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .get_by_client_id(&source, "after-close")
                .unwrap()
                .unwrap()
                .status,
            AgentMessageStatus::Queued
        );
    }
}

#[cfg(test)]
#[path = "delivery/idle_wake_tests.rs"]
mod idle_wake_tests;

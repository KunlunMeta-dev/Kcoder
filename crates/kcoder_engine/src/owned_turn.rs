//! Actual stream owners serialize turn-bound admission with start and finish.
//! An observation or a decoded turn selector never creates an owner.

use kcoder_state::{AppState, AppStateLifecycleIdentity};
use kcoder_types::TurnAttemptIdentity;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;

const MAX_NESTED_OWNERS: usize = 128;

#[derive(Default)]
struct AdmissionLifetime {
    active: AtomicUsize,
    retained: Mutex<Vec<Box<dyn Send>>>,
}
impl AdmissionLifetime {
    fn retain_until_released(&self, owned: impl Send + 'static) {
        let mut retained = self
            .retained
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.active.load(Ordering::Acquire) > 0 {
            retained.push(Box::new(owned));
            return;
        }
        drop(retained);
        drop(owned);
    }
    fn release(&self) {
        let mut retained = self
            .retained
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            let released = std::mem::take(&mut *retained);
            drop(retained);
            drop(released);
        }
    }
}

struct Entry {
    identity: TurnAttemptIdentity,
    state: AppState,
    owner: AppStateLifecycleIdentity,
    cancel: CancellationToken,
    open: AtomicBool,
    wake_read: std::sync::OnceLock<WakeReadOwner>,
}
struct WakeReadOwner {
    permit: std::sync::Weak<kcoder_state::PeerAutoWakePermit>,
    scope: std::sync::Weak<crate::peer_provider_start::PeerProviderScope>,
}
impl Entry {
    fn verify(&self) -> Result<(), &'static str> {
        if !self.open.load(Ordering::Acquire) || self.cancel.is_cancelled() {
            return Err("target_turn_closing");
        }
        match self.state.try_check_lifecycle_identity(&self.owner) {
            Ok(Some(true)) => {}
            Ok(Some(false)) => return Err("target_turn_owner_changed"),
            Ok(None) => return Err("target_turn_owner_busy"),
            Err(_) => return Err("target_turn_owner_unavailable"),
        }
        Ok(())
    }
}

#[derive(Clone, Default)]
pub(crate) struct OwnedTurnRegistry {
    gate: Arc<AsyncMutex<()>>,
    entries: Arc<Mutex<Vec<Arc<Entry>>>>,
    admissions: Arc<AdmissionLifetime>,
}

/// A host may observe or conditionally admit against an actual stream. It
/// cannot register a stream, acquire a session lease or construct an Engine.
#[derive(Clone)]
pub struct OwnedTurnObserver(OwnedTurnRegistry);

/// A weak observation of the actual registered stream, never an admission.
#[derive(Clone)]
pub(crate) struct OwnedTurnWitness {
    registry: OwnedTurnRegistry,
    entry: std::sync::Weak<Entry>,
}
impl OwnedTurnWitness {
    pub(crate) fn verify(
        &self,
        state: &AppState,
        owner: &AppStateLifecycleIdentity,
    ) -> Result<(), &'static str> {
        let entry = self.entry.upgrade().ok_or("target_turn_closed")?;
        entry.verify()?;
        if !entry.state.shares_state_with(state) || !entry.owner.same_lifecycle(owner) {
            return Err("target_turn_owner_changed");
        }
        let entries = self
            .registry
            .entries
            .try_lock()
            .map_err(|error| match error {
                std::sync::TryLockError::WouldBlock => "target_turn_owner_busy",
                std::sync::TryLockError::Poisoned(_) => "target_turn_owner_unavailable",
            })?;
        if !current(&entries)?.is_some_and(|active| Arc::ptr_eq(&active, &entry)) {
            return Err("target_turn_changed");
        }
        Ok(())
    }
    pub(crate) fn verify_current_task(&self, state: &AppState) -> Result<(), &'static str> {
        let entry = self.entry.upgrade().ok_or("target_turn_closed")?;
        self.verify(state, &entry.owner)?;
        if state.current_history_attempt_identity().as_ref() != Some(&entry.identity) {
            return Err("target_turn_history_scope_required");
        }
        Ok(())
    }
}

pub(crate) struct OwnedTurnRegistration {
    registry: OwnedTurnRegistry,
    entry: Arc<Entry>,
}
impl Drop for OwnedTurnRegistration {
    fn drop(&mut self) {
        // Future abandonment revokes new admissions without blocking an async
        // executor on a queue's filesystem transaction or spawning a reaper.
        self.entry.open.store(false, Ordering::Release);
    }
}
impl OwnedTurnRegistration {
    pub(crate) fn bind_wake_read(&self, engine: &crate::QueryEngine) {
        if let (Some(permit), Some(scope)) =
            (&engine.peer_auto_wake_start, &engine.peer_provider_scope)
        {
            let _ = self.entry.wake_read.set(WakeReadOwner {
                permit: Arc::downgrade(permit),
                scope: Arc::downgrade(scope),
            });
        }
    }
    pub(crate) async fn finish(self) {
        // Normal terminal publication waits for an admission already ordered
        // before it. Drop itself never waits for this lock or touches disk.
        let _gate = self.registry.gate.lock().await;
        self.entry.open.store(false, Ordering::Release);
        if let Ok(mut entries) = self.registry.entries.lock() {
            entries.retain(|entry| !Arc::ptr_eq(entry, &self.entry));
        }
    }
}

/// Move this guard into the destination's owned commit worker. Keeping the
/// guard only around a status read would reintroduce a check/write race.
pub struct OwnedTurnAdmission {
    _gate: OwnedMutexGuard<()>,
    entry: Arc<Entry>,
    admissions: Arc<AdmissionLifetime>,
}
impl Drop for OwnedTurnAdmission {
    fn drop(&mut self) {
        self.admissions.release();
    }
}
impl OwnedTurnAdmission {
    pub(crate) fn state(&self) -> &AppState {
        &self.entry.state
    }
    pub(crate) fn owner(&self) -> &AppStateLifecycleIdentity {
        &self.entry.owner
    }
    pub fn identity(&self) -> &TurnAttemptIdentity {
        &self.entry.identity
    }
    pub fn verify_current(&self) -> Result<(), &'static str> {
        self.entry.verify()
    }
}

impl crate::QueryEngine {
    pub fn owned_turn_observer(&self) -> OwnedTurnObserver {
        self.owned_turns.observer()
    }
}

fn current(entries: &[Arc<Entry>]) -> Result<Option<Arc<Entry>>, &'static str> {
    let mut active = entries
        .iter()
        .filter(|entry| entry.open.load(Ordering::Acquire));
    let Some(first) = active.next() else {
        return Ok(None);
    };
    first.verify()?;
    for entry in active {
        entry.verify()?;
        if entry.identity != first.identity || !entry.owner.same_lifecycle(&first.owner) {
            return Err("target_turn_owner_ambiguous");
        }
    }
    Ok(Some(first.clone()))
}
impl OwnedTurnRegistry {
    #[cfg(test)]
    pub(crate) fn with_entries_locked_for_owned_test(&self, held: impl FnOnce()) {
        let entries = self.entries.lock().unwrap();
        assert!(
            current(&entries).unwrap().is_some(),
            "a real registered turn must precede the fixture lock"
        );
        held();
        drop(entries);
    }
    pub(crate) fn witness_current_task(
        &self,
        state: &AppState,
    ) -> Result<OwnedTurnWitness, &'static str> {
        let identity = state
            .current_history_attempt_identity()
            .ok_or("target_turn_history_scope_required")?;
        let entries = self.entries.try_lock().map_err(|error| match error {
            std::sync::TryLockError::WouldBlock => "target_turn_owner_busy",
            std::sync::TryLockError::Poisoned(_) => "target_turn_owner_unavailable",
        })?;
        let entry = current(&entries)?.ok_or("target_turn_changed")?;
        if !entry.state.shares_state_with(state) || entry.identity != identity {
            return Err("target_turn_history_scope_required");
        }
        Ok(OwnedTurnWitness {
            registry: self.clone(),
            entry: Arc::downgrade(&entry),
        })
    }
    pub(crate) fn observer(&self) -> OwnedTurnObserver {
        OwnedTurnObserver(self.clone())
    }
    pub(crate) async fn register(
        &self,
        state: &AppState,
        identity: TurnAttemptIdentity,
        cancel: CancellationToken,
    ) -> Result<OwnedTurnRegistration, &'static str> {
        identity.validate()?;
        if state.current_history_attempt_identity().as_ref() != Some(&identity) {
            return Err("target_turn_history_scope_required");
        }
        let _gate = self.gate.lock().await;
        let owner = state
            .try_inspection_lifecycle_identity()
            .ok_or("target_turn_owner_unavailable")?;
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "target_turn_owner_unavailable")?;
        entries.retain(|entry| entry.open.load(Ordering::Acquire));
        if entries.len() >= MAX_NESTED_OWNERS {
            return Err("target_turn_owner_capacity");
        }
        let entry = Arc::new(Entry {
            identity,
            state: state.clone(),
            owner,
            cancel,
            open: AtomicBool::new(true),
            wake_read: Default::default(),
        });
        entry.verify()?;
        entries.push(entry.clone());
        Ok(OwnedTurnRegistration {
            registry: self.clone(),
            entry,
        })
    }
}
impl OwnedTurnObserver {
    /// Return the triggering message's locators only for a tool batch in this exact live wake.
    pub fn observe_wake_read_origin(
        &self,
        attempt: &TurnAttemptIdentity,
    ) -> anyhow::Result<(kcoder_types::peer_agent_message::PeerAgentMessageV1, String)> {
        use anyhow::{Context, ensure};
        let entry = {
            let entries = self
                .0
                .entries
                .try_lock()
                .map_err(|_| anyhow::anyhow!("target_turn_owner_busy"))?;
            current(&entries)
                .map_err(anyhow::Error::msg)?
                .context("peer_read_wake_not_current")?
        };
        ensure!(&entry.identity == attempt, "peer_read_wake_not_current");
        let owner = entry
            .wake_read
            .get()
            .context("peer_read_wake_owner_required")?;
        let scope = owner
            .scope
            .upgrade()
            .context("peer_read_wake_scope_closed")?;
        let permit = owner
            .permit
            .upgrade()
            .context("peer_read_wake_permit_closed")?;
        ensure!(
            permit.matches_provider_stream(scope.id),
            "peer_read_wake_stream_changed"
        );
        scope.verify_read_tool_batch(&entry.state, &entry.owner)?;
        let budget_owner = permit.observed_provider_budget_owner(&entry.state)?;
        ensure!(
            entry.owner.same_lifecycle(&budget_owner),
            "peer_read_wake_owner_changed"
        );
        let (metadata, _) = permit
            .native_wake_presence()
            .message()
            .peer_agent_data()
            .context("peer_read_wake_message_required")?;
        scope.verify_read_tool_batch(&entry.state, &entry.owner)?;
        Ok((
            metadata.clone(),
            permit.original_client_message_id().to_owned(),
        ))
    }
    /// Called by the actual host before retiring its original resources.
    /// Only already admitted owned work can delay release; no task is spawned.
    pub fn revoke_active(&self) {
        let entries = self
            .0
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for entry in entries.iter() {
            entry.open.store(false, Ordering::Release);
        }
    }
    pub fn retain_until_admissions_released(&self, owned: impl Send + 'static) {
        self.0.admissions.retain_until_released(owned);
    }
    pub async fn wait_for_admissions(&self) {
        let _gate = self.0.gate.lock().await;
    }
    pub fn current_identity(&self) -> Result<Option<TurnAttemptIdentity>, &'static str> {
        let entries = self
            .0
            .entries
            .try_lock()
            .map_err(|_| "target_turn_owner_busy")?;
        current(&entries).map(|entry| entry.map(|entry| entry.identity.clone()))
    }
    pub async fn admit_expected(
        &self,
        expected_turn_id: &str,
    ) -> Result<OwnedTurnAdmission, &'static str> {
        let gate = self.0.gate.clone().lock_owned().await;
        let entry = {
            let entries = self
                .0
                .entries
                .lock()
                .map_err(|_| "target_turn_owner_unavailable")?;
            current(&entries)?.ok_or("target_turn_changed")?
        };
        if entry.identity.turn_id != expected_turn_id {
            return Err("target_turn_changed");
        }
        self.admitted(gate, entry, expected_turn_id)
    }
    /// Use only for a bounded destination worker. Contention remains unavailable
    /// and never becomes a stale-turn denial or an implicit queue admission.
    pub fn try_admit_expected(
        &self,
        expected_turn_id: &str,
    ) -> Result<OwnedTurnAdmission, &'static str> {
        let gate = self
            .0
            .gate
            .clone()
            .try_lock_owned()
            .map_err(|_| "target_turn_owner_busy")?;
        let entry = {
            let entries = self
                .0
                .entries
                .try_lock()
                .map_err(|_| "target_turn_owner_busy")?;
            current(&entries)?.ok_or("target_turn_changed")?
        };
        self.admitted(gate, entry, expected_turn_id)
    }
    fn admitted(
        &self,
        gate: OwnedMutexGuard<()>,
        entry: Arc<Entry>,
        expected_turn_id: &str,
    ) -> Result<OwnedTurnAdmission, &'static str> {
        if entry.identity.turn_id != expected_turn_id {
            return Err("target_turn_changed");
        }
        entry.verify()?;
        self.0.admissions.active.fetch_add(1, Ordering::AcqRel);
        Ok(OwnedTurnAdmission {
            _gate: gate,
            entry,
            admissions: self.0.admissions.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::engine_builder::TestEngineBuilder;

    fn attempt(state: &AppState, turn: &str) -> TurnAttemptIdentity {
        TurnAttemptIdentity {
            thread_id: state.session_id(),
            turn_id: turn.into(),
            attempt_id: format!("attempt-{turn}"),
        }
    }
    #[tokio::test]
    async fn registration_requires_the_real_history_scope_and_cancel_closes_admission() {
        let root = tempfile::tempdir().unwrap();
        let state = TestEngineBuilder::new(root.path()).build().state;
        let registry = OwnedTurnRegistry::default();
        let identity = attempt(&state, "turn");
        assert!(
            registry
                .register(&state, identity.clone(), CancellationToken::new())
                .await
                .is_err()
        );
        let cancel = CancellationToken::new();
        let owner = state
            .history_attempt_scope(identity.clone())
            .unwrap()
            .run(registry.register(&state, identity.clone(), cancel.clone()))
            .await
            .unwrap();
        assert_eq!(
            registry.observer().current_identity().unwrap(),
            Some(identity)
        );
        assert!(registry.observer().admit_expected("other").await.is_err());
        let admitted = registry.observer().admit_expected("turn").await.unwrap();
        assert_eq!(admitted.identity().turn_id, "turn");
        drop(admitted);
        cancel.cancel();
        assert!(registry.observer().admit_expected("turn").await.is_err());
        owner.finish().await;
        assert_eq!(registry.observer().current_identity().unwrap(), None);
    }
    #[tokio::test]
    async fn terminal_and_replacement_wait_for_the_owned_commit_but_drop_never_blocks() {
        let root = tempfile::tempdir().unwrap();
        let state = TestEngineBuilder::new(root.path()).build().state;
        let registry = OwnedTurnRegistry::default();
        let identity = attempt(&state, "original");
        let owner = state
            .history_attempt_scope(identity.clone())
            .unwrap()
            .run(registry.register(&state, identity, CancellationToken::new()))
            .await
            .unwrap();
        let admitted = registry
            .observer()
            .admit_expected("original")
            .await
            .unwrap();
        let finish = owner.finish();
        tokio::pin!(finish);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut finish)
                .await
                .is_err()
        );
        drop(admitted);
        finish.await;
        let identity = attempt(&state, "replacement");
        let owner = state
            .history_attempt_scope(identity.clone())
            .unwrap()
            .run(registry.register(&state, identity, CancellationToken::new()))
            .await
            .unwrap();
        let admitted = registry
            .observer()
            .admit_expected("replacement")
            .await
            .unwrap();
        drop(owner);
        assert!(admitted.verify_current().is_err());
        drop(admitted);
        assert!(
            registry
                .observer()
                .admit_expected("replacement")
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn actual_state_lifecycle_replacement_cannot_reuse_the_original_turn_registration() {
        let root = tempfile::tempdir().unwrap();
        let state = TestEngineBuilder::new(root.path()).build().state;
        let registry = OwnedTurnRegistry::default();
        let identity = attempt(&state, "original");
        let owner = state
            .history_attempt_scope(identity.clone())
            .unwrap()
            .run(registry.register(&state, identity, CancellationToken::new()))
            .await
            .unwrap();
        state.start_new_session().unwrap();
        assert!(
            registry
                .observer()
                .admit_expected("original")
                .await
                .is_err()
        );
        owner.finish().await;
        assert!(registry.observer().current_identity().unwrap().is_none());
    }
}

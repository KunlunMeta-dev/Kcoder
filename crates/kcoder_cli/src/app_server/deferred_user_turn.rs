//! Owned admission waits keep the dispatcher available for private Native replies.
use super::*;
use anyhow::bail;
use kcoder_cli_storage::session_lease::NativeSessionLeaseWitness;
use kcoder_state::{AppState, AppStateLifecycleIdentity};
use std::collections::HashSet;
use std::sync::{Weak, atomic::AtomicUsize};

const MAX_PENDING: usize = 8;
const WAIT_LIMIT: Duration = Duration::from_secs(20);

/// A scheduling hint only. It grants no work, input or session authority.
struct UserWaiting(Arc<AtomicUsize>);
impl UserWaiting {
    fn new(state: &ResidentTurnState) -> Self {
        state.pending_user_admissions.fetch_add(1, Ordering::AcqRel);
        Self(state.pending_user_admissions.clone())
    }
}
impl Drop for UserWaiting {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(super) struct ReadyUserTurn {
    pub line: String,
    pub id: Value,
    thread: String,
    params: Value,
    state: AppState,
    lifecycle: AppStateLifecycleIdentity,
    source: Weak<()>,
    lease: NativeSessionLeaseWitness,
    gate: Arc<Mutex<()>>,
    registration: Option<tokio::sync::OwnedMutexGuard<()>>,
    error: Option<&'static str>,
    _waiting: UserWaiting,
}
impl std::fmt::Debug for ReadyUserTurn {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ReadyUserTurn")
            .field("thread", &self.thread)
            .finish_non_exhaustive()
    }
}
impl ReadyUserTurn {
    pub fn verify(&self, manager: &ThreadManager, state: &ConnectionState) -> Result<()> {
        if let Some(error) = self.error {
            bail!(error);
        }
        ensure!(
            !state.input_ended.is_cancelled()
                && self
                    .source
                    .upgrade()
                    .is_some_and(|source| Arc::ptr_eq(&source, &state.source_management_owner)),
            "TURN_ADMISSION_SOURCE_CHANGED"
        );
        let engine = manager
            .engine(&self.thread)
            .context("TURN_ADMISSION_THREAD_CHANGED")?;
        let turn = manager
            .turn_state(&self.thread)
            .context("TURN_ADMISSION_THREAD_CHANGED")?;
        ensure!(
            engine.state.shares_state_with(&self.state)
                && self.lifecycle.try_matches(&engine.state) == Some(true)
                && Arc::ptr_eq(&turn.activity_gate, &self.gate)
                && turn.accepting_turns.load(Ordering::SeqCst)
                && !turn.running.load(Ordering::SeqCst),
            "TURN_ADMISSION_OWNER_CHANGED"
        );
        self.lease.verify_target(&engine.session_lease_target())?;
        Ok(())
    }
    pub fn take_registration(
        &mut self,
        id: &Value,
        params: &Value,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>> {
        ensure!(
            &self.id == id && &self.params == params,
            "TURN_ADMISSION_REQUEST_CHANGED"
        );
        self.registration
            .take()
            .context("TURN_ADMISSION_REGISTRATION_UNAVAILABLE")
    }
}

#[derive(Default)]
pub(super) struct DeferredUserTurns {
    jobs: tokio::task::JoinSet<ReadyUserTurn>,
    pending: HashSet<String>,
}
impl std::fmt::Debug for DeferredUserTurns {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DeferredUserTurns")
            .field("pending", &self.pending.len())
            .finish()
    }
}
pub(super) enum Preparation {
    Ordinary,
    // Boxed: the admitted turn is far larger than the data-less outcomes.
    Ready(Box<ReadyUserTurn>),
    Deferred,
    Busy,
}
impl DeferredUserTurns {
    /// This runs before turn dispatch, history, Hooks or an Accepted receipt.
    pub fn prepare(
        &mut self,
        line: &str,
        id: &Value,
        params: &Value,
        manager: &ThreadManager,
        source: &Arc<()>,
        ended: &CancellationToken,
    ) -> Result<Preparation> {
        let Ok(input) = serde_json::from_value::<TurnStartParams>(params.clone()) else {
            return Ok(Preparation::Ordinary);
        };
        let Some(engine) = manager.engine(&input.thread_id) else {
            return Ok(Preparation::Ordinary);
        };
        let Some(turn) = manager.turn_state(&input.thread_id) else {
            return Ok(Preparation::Ordinary);
        };
        if turn.running.load(Ordering::SeqCst) || !turn.accepting_turns.load(Ordering::SeqCst) {
            return Ok(Preparation::Ordinary);
        }
        if self.pending.contains(&input.thread_id) || self.pending.len() >= MAX_PENDING {
            return Ok(Preparation::Busy);
        }
        let Some(lifecycle) = engine.state.try_inspection_lifecycle_identity() else {
            return Ok(Preparation::Ordinary);
        };
        let Some(lease) = manager.lease(&input.thread_id) else {
            return Ok(Preparation::Ordinary);
        };
        let gate = turn.activity_gate.clone();
        let mut ready = ReadyUserTurn {
            line: line.to_owned(),
            id: id.clone(),
            thread: input.thread_id,
            params: params.clone(),
            state: engine.state.clone(),
            lifecycle,
            source: Arc::downgrade(source),
            lease: lease.native_witness()?,
            gate: gate.clone(),
            registration: None,
            error: None,
            _waiting: UserWaiting::new(&turn),
        };
        if let Ok(registration) = gate.clone().try_lock_owned() {
            ready.registration = Some(registration);
            return Ok(Preparation::Ready(Box::new(ready)));
        }
        self.pending.insert(ready.thread.clone());
        let ended = ended.clone();
        self.jobs.spawn(async move {
            tokio::select! {
                biased;
                _ = ended.cancelled() => ready.error = Some("TURN_ADMISSION_SOURCE_ENDED"),
                result = tokio::time::timeout(WAIT_LIMIT, gate.lock_owned()) => match result {
                    Ok(registration) => ready.registration = Some(registration),
                    Err(_) => ready.error = Some("TURN_ADMISSION_OUTCOME_UNKNOWN"),
                },
            }
            ready
        });
        Ok(Preparation::Deferred)
    }
    pub fn is_empty(&self) -> bool {
        self.jobs.is_empty()
    }
    pub async fn next(&mut self) -> Option<ReadyUserTurn> {
        let ready = self.jobs.join_next().await?.ok()?;
        self.pending.remove(&ready.thread);
        Some(ready)
    }
    pub async fn shutdown(&mut self) {
        self.jobs.abort_all();
        while self.jobs.join_next().await.is_some() {}
        self.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, ThreadManager, ConnectionState, String) {
        let root = tempfile::tempdir().unwrap();
        let history = root.path().join("owned-original.jsonl");
        let runtime = thread_runtime::test_support::test_runtime("owned", &history);
        let engine = runtime.engine();
        engine.state.with_deferred_history_path(&history);
        let thread = engine.session_id();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        (root, manager, ConnectionState::default(), thread)
    }
    fn request(thread: &str) -> (Value, Value, String) {
        let id = json!(77);
        let params = json!({"threadId":thread,"clientMessageId":"owned-original-user-cid",
            "input":[{"type":"text","text":"Original owned User"}]});
        let line =
            json!({"jsonrpc":"2.0","id":id,"method":"turn/start","params":params}).to_string();
        (id, params, line)
    }
    #[tokio::test]
    async fn idle_gate_wait_preserves_original_request_and_private_reply_progress_without_claiming_a_turn()
     {
        let (_root, manager, mut state, thread) = fixture();
        let turn = manager.turn_state(&thread).unwrap();
        let maintenance = turn.activity_gate.clone().lock_owned().await;
        let (id, params, line) = request(&thread);
        assert!(matches!(
            state
                .deferred_user_turns
                .prepare(
                    &line,
                    &id,
                    &params,
                    &manager,
                    &state.source_management_owner,
                    &state.input_ended
                )
                .unwrap(),
            Preparation::Deferred
        ));
        assert_eq!(turn.pending_user_admissions.load(Ordering::Acquire), 1);
        assert!(!turn.running.load(Ordering::SeqCst));
        assert!(manager.engine(&thread).unwrap().state.messages().is_empty());
        assert!(matches!(
            state
                .deferred_user_turns
                .prepare(
                    &line,
                    &id,
                    &params,
                    &manager,
                    &state.source_management_owner,
                    &state.input_ended
                )
                .unwrap(),
            Preparation::Busy
        ));
        let (reply, received) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ = reply.send("actual-owned-private-reply");
        });
        tokio::select! {
            ready = state.deferred_user_turns.next() => panic!("admission escaped held maintenance gate: {ready:?}"),
            reply = received => assert_eq!(reply.unwrap(), "actual-owned-private-reply"),
        }
        drop(maintenance);
        let mut ready =
            tokio::time::timeout(Duration::from_secs(1), state.deferred_user_turns.next())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(ready.line, line);
        ready.verify(&manager, &state).unwrap();
        let mut changed = params.clone();
        changed["clientMessageId"] = json!("different-cid");
        assert!(ready.take_registration(&id, &changed).is_err());
        let registration = ready.take_registration(&id, &params).unwrap();
        assert!(ready.take_registration(&id, &params).is_err());
        assert!(turn.try_claim_turn());
        drop(ready);
        drop(registration);
        assert_eq!(turn.pending_user_admissions.load(Ordering::Acquire), 0);
        turn.finish_turn_registration().await;
    }
    #[tokio::test]
    async fn source_end_or_owner_replacement_rejects_the_original_deferred_admission() {
        for replace_owner in [false, true] {
            let (_root, manager, mut state, thread) = fixture();
            let turn = manager.turn_state(&thread).unwrap();
            let maintenance = turn.activity_gate.clone().lock_owned().await;
            let (id, params, line) = request(&thread);
            assert!(matches!(
                state
                    .deferred_user_turns
                    .prepare(
                        &line,
                        &id,
                        &params,
                        &manager,
                        &state.source_management_owner,
                        &state.input_ended
                    )
                    .unwrap(),
                Preparation::Deferred
            ));
            if replace_owner {
                state.source_management_owner = Arc::new(());
                drop(maintenance);
            } else {
                state.input_ended.cancel();
            }
            let ready =
                tokio::time::timeout(Duration::from_secs(1), state.deferred_user_turns.next())
                    .await
                    .unwrap()
                    .unwrap();
            assert!(ready.verify(&manager, &state).is_err());
            assert!(!turn.running.load(Ordering::SeqCst));
            assert!(manager.engine(&thread).unwrap().state.messages().is_empty());
            drop(ready);
            assert_eq!(turn.pending_user_admissions.load(Ordering::Acquire), 0);
        }
    }
    #[tokio::test]
    async fn a_real_running_turn_keeps_the_existing_immediate_rejection_path() {
        let (_root, manager, mut state, thread) = fixture();
        let turn = manager.turn_state(&thread).unwrap();
        assert!(turn.try_claim_turn());
        let (id, params, line) = request(&thread);
        assert!(matches!(
            state
                .deferred_user_turns
                .prepare(
                    &line,
                    &id,
                    &params,
                    &manager,
                    &state.source_management_owner,
                    &state.input_ended
                )
                .unwrap(),
            Preparation::Ordinary
        ));
        assert!(state.deferred_user_turns.is_empty());
        assert_eq!(turn.pending_user_admissions.load(Ordering::Acquire), 0);
        turn.finish_turn_registration().await;
    }
}

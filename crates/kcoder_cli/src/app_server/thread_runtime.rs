use super::{
    BackgroundEventPump, BackgroundFollowupScheduler, BackgroundFollowupState,
    BackgroundProjectionState, ResidentTurnState, SessionLease,
};
use kcoder_app_protocol::ThreadRunFacts;
use kcoder_engine::QueryEngine;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::Mutex;

pub(super) const DEFAULT_RESIDENT_THREAD_LIMIT: usize = 16;
pub(super) const DIAGNOSTIC_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

/// Cumulative real-user turns, independent of compacted model context.
/// The owning runtime's activity gate serializes reservations and rewinds.
pub(super) struct ClientTurnCounter(StdMutex<Option<usize>>);

impl Default for ClientTurnCounter {
    fn default() -> Self {
        Self(StdMutex::new(Some(0)))
    }
}

impl ClientTurnCounter {
    pub(super) fn get(&self) -> Option<usize> {
        *self.0.lock().unwrap()
    }

    pub(super) fn reset(&self, count: usize) {
        *self.0.lock().unwrap() = Some(count);
    }

    pub(super) fn invalidate(&self) {
        *self.0.lock().unwrap() = None;
    }

    pub(super) fn increment(&self) -> anyhow::Result<usize> {
        let mut value = self.0.lock().unwrap();
        let count = value.as_mut().ok_or_else(|| {
            anyhow::anyhow!(
                "resident turn count is unavailable; resume the thread before starting another turn"
            )
        })?;
        *count = count.saturating_add(1);
        Ok(*count)
    }
}

/// Resident thread runtime within one workspace app-server.
///
/// Engine, lease, and background projection must remain one ownership unit. Keeping
/// only the engine would route post-switch background events into another thread;
/// keeping only the lease would require rebuilding the engine from disk each time.
pub(super) struct ThreadRuntime {
    engine: QueryEngine,
    lease: SessionLease,
    last_used: u64,
    background_projection: Arc<Mutex<BackgroundProjectionState>>,
    background_followups: Arc<BackgroundFollowupState>,
    background_pump: Option<BackgroundEventPump>,
    background_followup_scheduler: Option<BackgroundFollowupScheduler>,
    turn_state: ResidentTurnState,
    ephemeral: bool,
}

/// Shared runtime fixture for app-server run-state tests.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::app_server::InteractionReceipts;
    use crate::tui_dev_mock::{MockScenarioProvider, TuiDevScenario};
    use kcoder_config::{PermissionMode, Settings};
    use kcoder_engine::WorkspaceRuntimeServices;
    use kcoder_memory::{MemoryManager, MemoryStore};
    use kcoder_permissions::PermissionEngine;
    use kcoder_skills::SkillRegistry;
    use kcoder_tools::{DenyAllUserQuestioner, ToolRegistry};
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;
    use std::sync::atomic::AtomicU64;
    use tokio::sync::mpsc;

    pub(crate) fn test_runtime(_id: &str, history: &std::path::Path) -> ThreadRuntime {
        let settings = Settings {
            history_enabled: false,
            permission_mode: PermissionMode::Bypass,
            ..Settings::default()
        };
        let engine = QueryEngine::try_new_for_client_with_services(
            Arc::new(MockScenarioProvider::new(TuiDevScenario::FullTurn)),
            kcoder_state::AppState::new(history.parent().unwrap()),
            ToolRegistry::new(),
            PermissionEngine::from_settings(&settings),
            settings,
            MemoryManager::global_only(MemoryStore::empty()),
            SkillRegistry::empty(),
            Arc::new(DenyAllUserQuestioner),
            history.parent().unwrap().to_path_buf(),
            Some(true),
            WorkspaceRuntimeServices::new(history.parent().unwrap(), "thread-manager-test"),
        )
        .unwrap();
        let projection = Arc::new(tokio::sync::Mutex::new(BackgroundProjectionState::default()));
        let followups = Arc::new(BackgroundFollowupState::default());
        let (tx, _rx) = mpsc::channel(1);
        let turn_state = ResidentTurnState::new(
            tx.clone(),
            PermissionMode::Bypass,
            Arc::new(AtomicU64::new(1_000_000)),
            Arc::new(AtomicU64::new(2_000_000)),
            Arc::new(StdMutex::new(InteractionReceipts::default())),
        );
        let pump = BackgroundEventPump::spawn(
            &engine,
            Arc::clone(&projection),
            Arc::clone(&followups),
            tx,
        );
        let scheduler = BackgroundFollowupScheduler::disabled_for_test();
        ThreadRuntime::new(
            engine,
            SessionLease::acquire(history).unwrap(),
            projection,
            followups,
            (pump, scheduler),
            turn_state,
        )
    }
}

fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

impl ThreadRuntime {
    /// Authoritative run facts for this runtime.
    ///
    /// Every field is read without blocking; a field stays `None` when its lock
    /// is busy so callers can report "unknown" instead of a fabricated idle.
    fn run_facts(&self) -> ThreadRunFacts {
        let (pending_approvals, pending_questions) = match (
            self.turn_state.pending_approvals.try_lock(),
            self.turn_state.pending_questions.try_lock(),
        ) {
            (Ok(approvals), Ok(questions)) => {
                (Some(count(approvals.len())), Some(count(questions.len())))
            }
            _ => (None, None),
        };
        let (pending_followups, pending_goals) = match (
            self.background_followups.queue.try_lock(),
            self.background_followups.goals.try_lock(),
        ) {
            (Ok(queue), Ok(goals)) => (
                Some(count(queue.pending.len())),
                Some(u32::from(goals.pending())),
            ),
            _ => (None, None),
        };
        let active_jobs = self
            .engine
            .try_background_activity_counts()
            .map(|(jobs, _cancellation_markers, prefire)| count(jobs.saturating_add(prefire)));
        let task_counts = self.engine.state.try_task_activity_counts();
        ThreadRunFacts {
            main_turn_running: Some(self.turn_state.running.load(Ordering::SeqCst)),
            pending_approvals,
            pending_questions,
            active_jobs,
            tasks_pending: task_counts.map(|(pending, _)| count(pending)),
            tasks_running: task_counts.map(|(_, running)| count(running)),
            pending_followups,
            pending_goals,
        }
    }

    fn interaction_activity_counts(&self) -> Option<(usize, usize, usize, usize)> {
        let approvals = self.turn_state.pending_approvals.try_lock().ok()?.len();
        let questions = self.turn_state.pending_questions.try_lock().ok()?.len();
        let followups = self
            .background_followups
            .queue
            .try_lock()
            .ok()?
            .pending
            .len();
        let goals = usize::from(self.background_followups.goals.try_lock().ok()?.pending());
        Some((approvals, questions, followups, goals))
    }
    pub(super) fn new(
        engine: QueryEngine,
        lease: SessionLease,
        background_projection: Arc<Mutex<BackgroundProjectionState>>,
        background_followups: Arc<BackgroundFollowupState>,
        background_tasks: (BackgroundEventPump, BackgroundFollowupScheduler),
        turn_state: ResidentTurnState,
    ) -> Self {
        let (background_pump, background_followup_scheduler) = background_tasks;
        Self {
            engine,
            lease,
            last_used: 0,
            background_projection,
            background_followups,
            background_pump: Some(background_pump),
            background_followup_scheduler: Some(background_followup_scheduler),
            turn_state,
            ephemeral: false,
        }
    }

    pub(super) fn engine(&self) -> QueryEngine {
        self.engine.clone()
    }

    pub(super) fn with_ephemeral(mut self) -> Self {
        self.ephemeral = true;
        self
    }

    pub(super) fn projection(&self) -> Arc<Mutex<BackgroundProjectionState>> {
        Arc::clone(&self.background_projection)
    }

    pub(super) fn followups(&self) -> Arc<BackgroundFollowupState> {
        Arc::clone(&self.background_followups)
    }

    pub(super) fn persistence_paths(&self) -> (Option<PathBuf>, Option<PathBuf>) {
        (
            self.engine.state.history_path(),
            self.engine.state.session_state_path(),
        )
    }

    fn is_evictable(&self) -> bool {
        self.idle_blocker().is_none()
    }

    fn idle_blocker(&self) -> Option<&'static str> {
        if self.ephemeral {
            return Some("ephemeral");
        }
        if self.turn_state.running.load(Ordering::SeqCst) {
            return Some("running_turn");
        }
        if self.engine.state.try_task_activity_counts() != Some((0, 0)) {
            return Some("tasks");
        }
        if self.interaction_activity_counts() != Some((0, 0, 0, 0)) {
            return Some("interactions");
        }
        let Ok(projection) = self.background_projection.try_lock() else {
            return Some("projection_lock");
        };
        if projection.active.is_some() {
            return Some("projection_active");
        }
        if !projection.jobs.is_empty() {
            return Some("projection_jobs");
        }
        if !projection.tool_calls.is_empty() {
            return Some("projection_tools");
        }
        if !projection.pending.is_empty() {
            return Some("projection_pending");
        }
        None
    }

    fn claim_shutdown_if_idle(&self) -> bool {
        self.turn_state.stop_accepting_turns();
        if self.is_evictable()
            && let Some(reservation) = self.engine.try_reserve_background_work_idle()
        {
            reservation.commit();
            return true;
        }
        self.turn_state.resume_accepting_turns();
        false
    }

    fn claim_shutdown_if_not_running(&self) -> bool {
        self.turn_state.stop_accepting_turns();
        if !self.turn_state.running.load(Ordering::SeqCst)
            && self.engine.state.try_task_activity_counts() == Some((0, 0))
        {
            true
        } else {
            self.turn_state.resume_accepting_turns();
            false
        }
    }

    pub(super) async fn shutdown(self) {
        self.shutdown_with_diagnostic_deadline(
            std::time::Instant::now() + DIAGNOSTIC_SHUTDOWN_TIMEOUT,
        )
        .await;
    }

    pub(super) async fn shutdown_with_diagnostic_deadline(mut self, deadline: std::time::Instant) {
        self.shutdown_with_turn_timeout(super::ACTIVE_TURN_SHUTDOWN_TIMEOUT, deadline)
            .await;
    }

    async fn shutdown_with_turn_timeout(
        &mut self,
        turn_timeout: Duration,
        diagnostic_deadline: std::time::Instant,
    ) {
        self.turn_state.stop_accepting_turns();
        let activity_gate = Arc::clone(&self.turn_state.activity_gate);
        let gate = activity_gate.lock_owned().await;
        if let Some(scheduler) = self.background_followup_scheduler.take() {
            scheduler.stop().await;
        }
        let active = self.turn_state.active_turn.lock().await.take();
        drop(gate);
        if let Some(active) = active {
            super::cancel_active_turn_with_timeout(
                active,
                &self.turn_state,
                &self.background_projection,
                &self.background_followups,
                turn_timeout,
            )
            .await;
        } else {
            let _gate = self.turn_state.activity_gate.lock().await;
            self.turn_state.clear_all_turn_state();
            self.background_followups.notify.notify_waiters();
        }
        if let Some(pump) = self.background_pump.take() {
            pump.stop().await;
        }
        self.engine.prepare_session_replacement();
        if !self
            .engine
            .state
            .flush_diagnostics_until(diagnostic_deadline)
            .await
        {
            tracing::warn!(
                "resident diagnostic shutdown flush did not complete before its deadline"
            );
        }
        super::rotate_background_projection(&self.background_projection).await;
        super::clear_background_followups(&self.background_followups).await;
    }
}

/// Owner of resident thread runtimes for a workspace app-server.
///
/// Each thread independently retains its engine, lease, foreground turn, interaction
/// context, pump, and follow-up scheduler. At capacity, evict only the least recently
/// used idle runtime that is not current; the caller asynchronously shuts down the returned runtime.
pub(super) struct ThreadManager {
    runtimes: HashMap<String, ThreadRuntime>,
    active_thread_id: Option<String>,
    resident_limit: usize,
    access_clock: u64,
}

/// Owns all turn gates until the caller commits or rolls back the idle check.
pub(super) struct WorkspaceIdleReservation {
    turns: Vec<(ResidentTurnState, tokio::sync::OwnedMutexGuard<()>)>,
    backgrounds: Vec<kcoder_engine::BackgroundWorkIdleReservation>,
    committed: bool,
}

impl WorkspaceIdleReservation {
    pub(super) fn commit(mut self) {
        for reservation in self.backgrounds.drain(..) {
            reservation.commit();
        }
        self.committed = true;
    }
}

impl Drop for WorkspaceIdleReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.backgrounds.clear();
            for (state, _) in &self.turns {
                state.resume_accepting_turns();
            }
        }
    }
}

impl Default for ThreadManager {
    fn default() -> Self {
        Self::with_resident_limit(DEFAULT_RESIDENT_THREAD_LIMIT)
    }
}

impl ThreadManager {
    #[cfg(test)]
    pub(super) fn try_reserve_workspace_idle(
        &self,
        workspace: &QueryEngine,
    ) -> Option<WorkspaceIdleReservation> {
        self.try_reserve_workspace_idle_with_reason(workspace).ok()
    }
    pub(super) fn try_reserve_workspace_idle_with_reason(
        &self,
        workspace: &QueryEngine,
    ) -> Result<WorkspaceIdleReservation, &'static str> {
        let mut reservation = WorkspaceIdleReservation {
            turns: Vec::new(),
            backgrounds: Vec::new(),
            committed: false,
        };
        for runtime in self.runtimes.values() {
            let gate = Arc::clone(&runtime.turn_state.activity_gate)
                .try_lock_owned()
                .map_err(|_| "turn_gate")?;
            if !runtime.turn_state.accepting_turns.load(Ordering::SeqCst) {
                return Err("turn_admission");
            }
            runtime.turn_state.stop_accepting_turns();
            reservation.turns.push((runtime.turn_state.clone(), gate));
            if let Some(reason) = runtime.idle_blocker() {
                return Err(reason);
            }
            if runtime
                .turn_state
                .active_turn
                .try_lock()
                .map_err(|_| "turn_tail")?
                .as_ref()
                .is_some_and(|turn| !turn.handle.is_finished())
            {
                return Err("turn_tail");
            }
        }
        if workspace.state.try_task_activity_counts() != Some((0, 0)) {
            return Err("workspace_tasks");
        }
        let mut seen: Vec<&QueryEngine> = Vec::new();
        for engine in self
            .runtimes
            .values()
            .map(|runtime| &runtime.engine)
            .chain(std::iter::once(workspace))
        {
            if seen
                .iter()
                .any(|prior| engine.shares_idle_admission_with(prior))
            {
                continue;
            }
            reservation.backgrounds.push(
                engine
                    .try_reserve_background_work_idle()
                    .ok_or("background_workers")?,
            );
            seen.push(engine);
        }
        Ok(reservation)
    }
    pub(super) fn background_activity_counts(
        &self,
        workspace: &QueryEngine,
    ) -> Option<(usize, usize, usize)> {
        let mut seen: Vec<&QueryEngine> = Vec::new();
        let mut total = (0, 0, 0);
        for engine in self
            .runtimes
            .values()
            .map(|runtime| &runtime.engine)
            .chain(std::iter::once(workspace))
        {
            if seen
                .iter()
                .any(|previous| engine.shares_background_activity_with(previous))
            {
                continue;
            }
            let counts = engine.try_background_activity_counts()?;
            total.0 += counts.0;
            total.1 += counts.1;
            total.2 += counts.2;
            seen.push(engine);
        }
        Some(total)
    }
    pub(super) fn interaction_activity_counts(&self) -> Option<(usize, usize, usize, usize)> {
        self.runtimes
            .values()
            .try_fold((0, 0, 0, 0), |total, runtime| {
                let current = runtime.interaction_activity_counts()?;
                Some((
                    total.0 + current.0,
                    total.1 + current.1,
                    total.2 + current.2,
                    total.3 + current.3,
                ))
            })
    }
    pub(super) fn task_activity_counts(&self, workspace: &QueryEngine) -> Option<(usize, usize)> {
        let mut counts = (0, 0);
        let mut includes_workspace = false;
        for runtime in self.runtimes.values() {
            includes_workspace |= runtime.engine.state.shares_state_with(&workspace.state);
            let current = runtime.engine.state.try_task_activity_counts()?;
            counts.0 += current.0;
            counts.1 += current.1;
        }
        if !includes_workspace {
            let current = workspace.state.try_task_activity_counts()?;
            counts.0 += current.0;
            counts.1 += current.1;
        }
        Some(counts)
    }
    pub(super) fn resource_counts(&self) -> (usize, usize) {
        (
            self.runtimes.len(),
            self.runtimes
                .values()
                .filter(|runtime| runtime.turn_state.running.load(Ordering::SeqCst))
                .count(),
        )
    }

    pub(super) fn project_is_idle(&self) -> bool {
        self.runtimes.values().all(|runtime| {
            !runtime.turn_state.running.load(Ordering::SeqCst)
                && runtime.interaction_activity_counts() == Some((0, 0, 0, 0))
                && runtime.engine.state.try_task_activity_counts() == Some((0, 0))
        })
    }
    pub(super) fn with_resident_limit(resident_limit: usize) -> Self {
        Self {
            runtimes: HashMap::new(),
            active_thread_id: None,
            resident_limit: resident_limit.max(1),
            access_clock: 0,
        }
    }

    pub(super) fn insert(
        &mut self,
        mut runtime: ThreadRuntime,
    ) -> Result<Option<ThreadRuntime>, Box<ThreadRuntime>> {
        let thread_id = runtime.engine.session_id();
        let evicted = match self.reserve_capacity() {
            Ok(evicted) => evicted,
            Err(()) => return Err(Box::new(runtime)),
        };
        self.access_clock = self.access_clock.saturating_add(1);
        runtime.last_used = self.access_clock;
        let replaced = self.runtimes.insert(thread_id.clone(), runtime);
        debug_assert!(replaced.is_none(), "resident thread id must be unique");
        self.active_thread_id = Some(thread_id);
        Ok(replaced.or(evicted))
    }

    /// Atomically reserve a resident slot before any persisted resume mutation.
    ///
    /// Remove an evictable candidate runtime from the manager immediately while it is
    /// still safe, then let the caller shut it down first. Background state cannot
    /// reverse between sidecar application and final insertion.
    pub(super) fn reserve_capacity(&mut self) -> Result<Option<ThreadRuntime>, ()> {
        if self.runtimes.len() < self.resident_limit {
            return Ok(None);
        }
        let active = self.active_thread_id.as_deref();
        let mut candidates = self
            .runtimes
            .iter()
            .filter(|(candidate_id, candidate)| {
                Some(candidate_id.as_str()) != active && candidate.is_evictable()
            })
            .map(|(candidate_id, candidate)| (candidate_id.clone(), candidate.last_used))
            .collect::<Vec<_>>();
        candidates.sort_by_key(|(_, last_used)| *last_used);
        for (candidate_id, _) in candidates {
            let claimed = self
                .runtimes
                .get(&candidate_id)
                .is_some_and(ThreadRuntime::claim_shutdown_if_idle);
            if claimed {
                return Ok(self.runtimes.remove(&candidate_id));
            }
        }
        Err(())
    }

    pub(super) fn select(&mut self, thread_id: &str) -> Option<QueryEngine> {
        let runtime = self.runtimes.get_mut(thread_id)?;
        self.access_clock = self.access_clock.saturating_add(1);
        runtime.last_used = self.access_clock;
        self.active_thread_id = Some(thread_id.to_string());
        Some(runtime.engine())
    }

    pub(super) fn engine(&self, thread_id: &str) -> Option<QueryEngine> {
        self.runtimes.get(thread_id).map(ThreadRuntime::engine)
    }

    pub(super) fn owns(&self, thread_id: &str) -> bool {
        self.runtimes.contains_key(thread_id)
    }

    pub(super) fn sole_thread_id(&self) -> Option<String> {
        (self.runtimes.len() == 1)
            .then(|| self.runtimes.keys().next().cloned())
            .flatten()
    }

    pub(super) fn is_empty(&self) -> bool {
        self.runtimes.is_empty()
    }

    pub(super) fn lease(&self, thread_id: &str) -> Option<&SessionLease> {
        self.runtimes.get(thread_id).map(|runtime| &runtime.lease)
    }

    pub(super) fn volatile_turn_count(&self, thread_id: &str) -> usize {
        self.runtimes
            .get(thread_id)
            .and_then(|runtime| runtime.background_followups.client_turn_count.get())
            .expect("resident turn count must be initialized before allocating a turn")
    }

    pub(super) fn set_volatile_turn_count(&mut self, thread_id: &str, count: usize) {
        if let Some(runtime) = self.runtimes.get_mut(thread_id) {
            runtime.background_followups.client_turn_count.reset(count);
        }
    }

    pub(super) fn projection(
        &self,
        thread_id: &str,
    ) -> Option<Arc<Mutex<BackgroundProjectionState>>> {
        self.runtimes.get(thread_id).map(ThreadRuntime::projection)
    }

    pub(super) fn followups(&self, thread_id: &str) -> Option<Arc<BackgroundFollowupState>> {
        self.runtimes.get(thread_id).map(ThreadRuntime::followups)
    }

    pub(super) fn remove_if_idle(&mut self, thread_id: &str) -> Result<Option<ThreadRuntime>, ()> {
        let Some(runtime) = self.runtimes.get(thread_id) else {
            return Ok(None);
        };
        if !runtime.claim_shutdown_if_not_running() {
            return Err(());
        }
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.active_thread_id = None;
        }
        Ok(self.runtimes.remove(thread_id))
    }

    pub(super) fn is_ephemeral(&self, thread_id: &str) -> bool {
        self.runtimes
            .get(thread_id)
            .is_some_and(|runtime| runtime.ephemeral)
    }

    pub(super) fn remove_ephemeral(
        &mut self,
        thread_id: &str,
    ) -> anyhow::Result<Option<ThreadRuntime>> {
        let Some(runtime) = self.runtimes.get(thread_id) else {
            return Ok(None);
        };
        anyhow::ensure!(
            runtime.ephemeral,
            "thread/dispose only accepts an ephemeral thread"
        );
        runtime.turn_state.stop_accepting_turns();
        if self.active_thread_id.as_deref() == Some(thread_id) {
            self.active_thread_id = None;
        }
        Ok(self.runtimes.remove(thread_id))
    }

    pub(super) fn drain(&mut self) -> Vec<ThreadRuntime> {
        self.active_thread_id = None;
        for runtime in self.runtimes.values() {
            runtime.turn_state.stop_accepting_turns();
        }
        self.runtimes.drain().map(|(_, runtime)| runtime).collect()
    }

    pub(super) fn turn_state(&self, thread_id: &str) -> Option<ResidentTurnState> {
        self.runtimes
            .get(thread_id)
            .map(|runtime| runtime.turn_state.clone())
    }

    pub(super) fn is_turn_running(&self, thread_id: &str) -> bool {
        self.runtimes
            .get(thread_id)
            .is_some_and(|runtime| runtime.turn_state.running.load(Ordering::SeqCst))
    }

    pub(super) fn running_thread_ids(&self) -> std::collections::HashSet<String> {
        self.runtimes
            .iter()
            .filter(|(_, runtime)| runtime.turn_state.running.load(Ordering::SeqCst))
            .map(|(thread_id, _)| thread_id.clone())
            .collect()
    }

    /// Authoritative run facts for one thread.
    ///
    /// `None` means this connection holds no runtime for the thread, so live
    /// facts (turn, pending interactions, background jobs) cannot be observed
    /// here. Callers must keep the legacy projection instead of guessing.
    pub(super) fn thread_run_facts(&self, thread_id: &str) -> Option<ThreadRunFacts> {
        self.runtimes.get(thread_id).map(ThreadRuntime::run_facts)
    }

    pub(super) fn resident_engines(&self) -> Vec<QueryEngine> {
        let mut runtimes = self.runtimes.values().collect::<Vec<_>>();
        runtimes.sort_by_key(|runtime| std::cmp::Reverse(runtime.last_used));
        runtimes.into_iter().map(ThreadRuntime::engine).collect()
    }

    pub(super) fn turn_states(&self) -> Vec<ResidentTurnState> {
        self.runtimes
            .values()
            .map(|runtime| runtime.turn_state.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn managed_projection_cleans_associated_job_after_task_record_removal() {
        use kcoder_engine::EngineEvent;
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime("removed-job", &root.path().join("history.jsonl"));
        let mut task = kcoder_state::Task::new("removed-agent", "fixture");
        task.kind = kcoder_state::TaskKind::Subagent;
        runtime.engine.state.upsert_task(task);
        let state = Arc::new(tokio::sync::Mutex::new(BackgroundProjectionState::default()));
        let (sender, _receiver) = mpsc::channel(16);
        let projection = Arc::new(tokio::sync::Mutex::new(StreamProjection::new(
            "server".into(),
            "thread".into(),
            "turn".into(),
            Arc::new(AtomicU64::new(1)),
        )));
        crate::app_server::register_background_tool_call(
            &state, "tool", "thread", "turn", projection,
        )
        .await;
        crate::app_server::project_managed_background_event(
            &runtime.engine,
            &state,
            &sender,
            EngineEvent::BackgroundJobAssociated {
                id: "removed-agent".into(),
                tool_call_id: "tool".into(),
                run_in_background: true,
            },
        )
        .await
        .unwrap();
        assert!(state.lock().await.jobs.contains_key("removed-agent"));
        runtime.engine.state.remove_task("removed-agent");
        crate::app_server::project_managed_background_event(
            &runtime.engine,
            &state,
            &sender,
            EngineEvent::BackgroundJobCompleted {
                id: "removed-agent".into(),
                output: kcoder_tools::ToolOutput::text("stopped"),
            },
        )
        .await
        .unwrap();
        let state = state.lock().await;
        assert!(state.jobs.is_empty());
        assert!(state.tool_calls.is_empty());
        assert!(state.pending.is_empty());
        drop(state);
        runtime.shutdown().await;
    }
    #[tokio::test]
    async fn managed_projection_filters_generic_tools_but_preserves_late_agent_association() {
        use kcoder_engine::EngineEvent;
        use kcoder_tools::ToolOutput;
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime("projection-kind", &root.path().join("history.jsonl"));
        for kind in [
            kcoder_state::TaskKind::Generic,
            kcoder_state::TaskKind::Subagent,
            kcoder_state::TaskKind::Workflow,
        ] {
            let mut task = kcoder_state::Task::new("job", "fixture");
            task.kind = kind;
            runtime.engine.state.upsert_task(task);
            let state = Arc::new(tokio::sync::Mutex::new(BackgroundProjectionState::default()));
            let (sender, mut receiver) = mpsc::channel(16);
            for event in [
                EngineEvent::BackgroundJobStarted {
                    id: "job".into(),
                    description: "not a text classification rule".into(),
                },
                EngineEvent::BackgroundJobCompleted {
                    id: "job".into(),
                    output: ToolOutput::text("done"),
                },
            ] {
                crate::app_server::project_managed_background_event(
                    &runtime.engine,
                    &state,
                    &sender,
                    event,
                )
                .await
                .unwrap();
            }
            if kind == kcoder_state::TaskKind::Generic {
                assert!(state.lock().await.pending.is_empty());
                assert!(receiver.try_recv().is_err());
            } else {
                assert_eq!(state.lock().await.pending["job"].len(), 2);
                let projection = Arc::new(tokio::sync::Mutex::new(StreamProjection::new(
                    "server".into(),
                    "thread".into(),
                    "turn".into(),
                    Arc::new(AtomicU64::new(1)),
                )));
                crate::app_server::register_background_tool_call(
                    &state, "tool", "thread", "turn", projection,
                )
                .await;
                crate::app_server::project_managed_background_event(
                    &runtime.engine,
                    &state,
                    &sender,
                    EngineEvent::BackgroundJobAssociated {
                        id: "job".into(),
                        tool_call_id: "tool".into(),
                        run_in_background: true,
                    },
                )
                .await
                .unwrap();
                assert!(state.lock().await.pending.is_empty());
                assert!(
                    receiver.try_recv().is_ok(),
                    "completed agent events must still be delivered"
                );
                let finalized = state.lock().await;
                assert!(
                    finalized.jobs.is_empty(),
                    "late association must retire completed jobs"
                );
                assert!(finalized.tool_calls.is_empty());
                assert!(finalized.job_tools.is_empty());
                assert!(finalized.associated_jobs.is_empty());
                assert!(finalized.terminal_jobs.contains("job"));
            }
        }
        runtime.shutdown().await;
    }
    #[tokio::test]
    async fn workspace_idle_reservation_rejects_busy_turns_and_preserves_closed_admission() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime("workspace-busy", &root.path().join("history.jsonl"));
        let workspace = runtime.engine();
        let state = runtime.turn_state.clone();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        let gate = state.activity_gate.lock().await;
        assert!(manager.try_reserve_workspace_idle(&workspace).is_none());
        drop(gate);
        state.running.store(true, Ordering::SeqCst);
        assert!(manager.try_reserve_workspace_idle(&workspace).is_none());
        assert!(state.accepting_turns.load(Ordering::SeqCst));
        state.running.store(false, Ordering::SeqCst);
        state.stop_accepting_turns();
        assert!(manager.try_reserve_workspace_idle(&workspace).is_none());
        assert!(!state.accepting_turns.load(Ordering::SeqCst));
        state.resume_accepting_turns();
        let (sender, _receiver) = oneshot::channel();
        state.pending_approvals.lock().unwrap().insert(7, sender);
        assert!(manager.try_reserve_workspace_idle(&workspace).is_none());
        assert!(state.accepting_turns.load(Ordering::SeqCst));
        state.pending_approvals.lock().unwrap().clear();
        assert!(manager.try_reserve_workspace_idle(&workspace).is_some());
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
    }
    #[tokio::test]
    async fn workspace_idle_reservation_rolls_back_every_domain_and_commits_aliases_once() {
        let root = tempfile::tempdir().unwrap();
        let first = test_runtime("workspace-idle-a", &root.path().join("a.jsonl"));
        let workspace = first.engine();
        let first_state = first.turn_state.clone();
        let second = test_runtime("workspace-idle-b", &root.path().join("b.jsonl"));
        let second_engine = second.engine();
        let second_state = second.turn_state.clone();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(first).is_ok());
        assert!(manager.insert(second).is_ok());
        let busy = second_engine.try_reserve_background_work_idle().unwrap();
        assert!(manager.try_reserve_workspace_idle(&workspace).is_none());
        assert!(first_state.accepting_turns.load(Ordering::SeqCst));
        assert!(second_state.accepting_turns.load(Ordering::SeqCst));
        assert!(workspace.try_reserve_background_work_idle().is_some());
        drop(busy);
        let reserved = manager.try_reserve_workspace_idle(&workspace).unwrap();
        assert!(!first_state.accepting_turns.load(Ordering::SeqCst));
        assert!(first_state.activity_gate.try_lock().is_err());
        assert!(second_state.activity_gate.try_lock().is_err());
        drop(reserved);
        assert!(first_state.accepting_turns.load(Ordering::SeqCst));
        assert!(second_state.accepting_turns.load(Ordering::SeqCst));
        manager
            .try_reserve_workspace_idle(&workspace)
            .unwrap()
            .commit();
        assert!(!first_state.accepting_turns.load(Ordering::SeqCst));
        assert!(!second_state.accepting_turns.load(Ordering::SeqCst));
        assert!(workspace.try_reserve_background_work_idle().is_none());
        assert!(second_engine.try_reserve_background_work_idle().is_none());
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
    }
    #[tokio::test]
    async fn eviction_claim_reserves_background_admission_or_restores_turn_admission() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime("idle-reservation", &root.path().join("history.jsonl"));
        let reserved = runtime.engine.try_reserve_background_work_idle().unwrap();
        assert!(!runtime.claim_shutdown_if_idle());
        assert!(runtime.turn_state.accepting_turns.load(Ordering::SeqCst));
        drop(reserved);
        assert!(runtime.claim_shutdown_if_idle());
        assert!(!runtime.turn_state.accepting_turns.load(Ordering::SeqCst));
        assert!(runtime.engine.try_reserve_background_work_idle().is_none());
        runtime.shutdown().await;
    }
    #[tokio::test]
    async fn eviction_preserves_waiting_dialogs_and_fails_closed_on_busy_goals() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime("eviction-observation", &root.path().join("history.jsonl"));
        assert!(runtime.is_evictable());
        let (sender, _receiver) = oneshot::channel();
        runtime
            .turn_state
            .pending_approvals
            .lock()
            .unwrap()
            .insert(1, sender);
        assert!(
            !runtime.is_evictable(),
            "waiting approval must protect the resident"
        );
        runtime.turn_state.pending_approvals.lock().unwrap().clear();
        let held = runtime.background_followups.goals.lock().unwrap();
        assert!(
            !runtime.is_evictable(),
            "busy goals must not block the eviction scan"
        );
        drop(held);
        assert!(runtime.is_evictable());
        runtime.shutdown().await;
    }
    #[tokio::test]
    async fn interaction_activity_protects_waiting_dialogs_and_reports_lock_contention() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime("interactions", &root.path().join("history.jsonl"));
        let state = runtime.turn_state.clone();
        let followups = runtime.followups();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        assert_eq!(manager.interaction_activity_counts(), Some((0, 0, 0, 0)));
        let (approval, _approval_rx) = oneshot::channel();
        let (question, _question_rx) = oneshot::channel();
        state.pending_approvals.lock().unwrap().insert(1, approval);
        state.pending_questions.lock().unwrap().insert(2, question);
        followups
            .queue
            .lock()
            .await
            .pending
            .insert("job".into(), "notification".into());
        assert_eq!(manager.interaction_activity_counts(), Some((1, 1, 1, 0)));
        assert!(!manager.project_is_idle());
        followups.queue.lock().await.pending.clear();
        assert!(
            !manager.project_is_idle(),
            "waiting dialogs alone must prevent idle"
        );
        let held = state.pending_approvals.lock().unwrap();
        assert_eq!(manager.interaction_activity_counts(), None);
        assert!(!manager.project_is_idle());
        drop(held);
        state.pending_approvals.lock().unwrap().clear();
        assert!(
            !manager.project_is_idle(),
            "a remaining question must prevent idle"
        );
        state.pending_questions.lock().unwrap().clear();
        followups.queue.lock().await.pending.clear();
        assert_eq!(manager.interaction_activity_counts(), Some((0, 0, 0, 0)));
        assert!(manager.project_is_idle());
    }
    #[tokio::test]
    async fn task_activity_deduplicates_workspace_and_idle_fails_closed_on_contention() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime("activity", &root.path().join("history.jsonl"));
        let workspace = runtime.engine();
        let followups = runtime.followups();
        let mut manager = ThreadManager::default();
        workspace
            .state
            .upsert_task(kcoder_state::Task::new("pending", "fixture"));
        assert_eq!(manager.task_activity_counts(&workspace), Some((1, 0)));
        assert!(manager.insert(runtime).is_ok());
        assert_eq!(manager.task_activity_counts(&workspace), Some((1, 0)));
        assert!(!manager.project_is_idle());
        let mut task = kcoder_state::Task::new("pending", "fixture");
        task.status = kcoder_state::TaskStatus::Completed;
        workspace.state.upsert_task(task);
        assert!(manager.project_is_idle());
        let held = followups.goals.lock().unwrap();
        assert!(!manager.project_is_idle());
        drop(held);
        assert!(manager.project_is_idle());
    }
    #[tokio::test]
    async fn resource_counts_observe_running_turns_without_materializing_history() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = test_runtime("resources", &temp.path().join("history.jsonl"));
        let running = runtime.turn_state.running.clone();
        let mut manager = ThreadManager::default();
        assert_eq!(manager.resource_counts(), (0, 0));
        assert!(manager.insert(runtime).is_ok());
        assert_eq!(manager.resource_counts(), (1, 0));
        running.store(true, Ordering::SeqCst);
        assert_eq!(manager.resource_counts(), (1, 1));
        running.store(false, Ordering::SeqCst);
        assert_eq!(manager.resource_counts(), (1, 0));
    }
    use super::ThreadManager;
    use super::test_support::test_runtime;
    use crate::app_server::InteractionReceipts;
    use crate::app_server::{
        ActiveTurn, ApprovalContext, BackgroundProjectionState, BackgroundTurnProjection,
        QuestionContext, ResidentTurnState, SessionLease, StreamProjection,
        cancel_active_turn_with_timeout,
    };
    use kcoder_config::PermissionMode;
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;
    use tokio::sync::{mpsc, oneshot};
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn resident_counter_counts_scheduled_messages_after_compacted_model_context() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = test_runtime("counter", &temp.path().join("history.jsonl"));
        let engine = runtime.engine();
        let followups = runtime.followups();
        let id = engine.session_id();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        manager.set_volatile_turn_count(&id, 10);
        engine
            .state
            .set_messages(vec![kcoder_types::Message::compaction_text(
                "Earlier conversation summary: compacted",
            )]);
        crate::app_server::append_background_followup_message(
            &engine,
            &followups,
            "[scheduled task task-a] inspect results".into(),
            kcoder_types::MessageOrigin::User,
        )
        .unwrap();
        assert_eq!(manager.volatile_turn_count(&id), 11);
        crate::app_server::append_background_followup_message(
            &engine,
            &followups,
            "[system] Continue working toward the active goal".into(),
            kcoder_types::MessageOrigin::Runtime,
        )
        .unwrap();
        assert_eq!(manager.volatile_turn_count(&id), 11);
        assert_eq!(followups.client_turn_count.increment().unwrap(), 12);
    }

    #[tokio::test]
    async fn resident_counter_preserves_file_only_rewind_and_recounts_memory_only_rewind() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = test_runtime("rewind", &temp.path().join("history.jsonl"));
        let engine = runtime.engine();
        let followups = runtime.followups();
        followups.client_turn_count.reset(10);
        engine
            .state
            .set_messages(vec![kcoder_types::Message::user_text("remaining request")]);
        crate::app_server::update_client_turn_count_after_rewind(&engine, &followups, None)
            .unwrap();
        assert_eq!(followups.client_turn_count.get(), Some(10));
        crate::app_server::update_client_turn_count_after_rewind(
            &engine,
            &followups,
            Some(kcoder_state::ConversationRewindOutcome {
                removed: 2,
                boundary_recorded: false,
            }),
        )
        .unwrap();
        assert_eq!(followups.client_turn_count.get(), Some(1));
    }

    #[tokio::test]
    async fn resident_counter_rejects_genuine_append_until_reconstructed() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = test_runtime("invalid", &temp.path().join("history.jsonl"));
        let engine = runtime.engine();
        let followups = runtime.followups();
        let before = engine.state.messages().len();
        followups.client_turn_count.invalidate();
        assert!(
            crate::app_server::append_background_followup_message(
                &engine,
                &followups,
                "[scheduled task task-a] inspect results".into(),
                kcoder_types::MessageOrigin::User,
            )
            .is_err()
        );
        assert_eq!(engine.state.messages().len(), before);
        assert_eq!(followups.client_turn_count.get(), None);
        followups.client_turn_count.reset(10);
        assert_eq!(followups.client_turn_count.increment().unwrap(), 11);
    }

    #[tokio::test]
    async fn resident_counter_uses_actual_submit_and_moa_append_not_acceptance() {
        use crate::app_server::explicit_turn_appended_user_message;
        use kcoder_engine::EngineEvent;
        let temp = tempfile::tempdir().unwrap();
        let runtime = test_runtime("submit", &temp.path().join("history.jsonl"));
        let engine = runtime.engine();
        let event = EngineEvent::Error("hook blocked".into());
        assert!(!explicit_turn_appended_user_message(&engine, &event, None));
        assert!(!explicit_turn_appended_user_message(
            &engine,
            &event,
            Some(0)
        ));
        engine
            .state
            .add_message(kcoder_types::Message::runtime_text(
                "[system] hook rewritten reminder",
            ));
        assert!(!explicit_turn_appended_user_message(
            &engine,
            &EngineEvent::UserMessageAdded,
            None
        ));
        engine
            .state
            .add_message(kcoder_types::Message::user_text("real prompt"));
        assert!(explicit_turn_appended_user_message(
            &engine,
            &EngineEvent::UserMessageAdded,
            None
        ));
        engine
            .state
            .add_message(kcoder_types::Message::assistant_text("fast MoA result"));
        assert!(explicit_turn_appended_user_message(
            &engine,
            &event,
            Some(0)
        ));
        assert!(!explicit_turn_appended_user_message(
            &engine,
            &event,
            Some(1)
        ));
    }

    #[tokio::test]
    async fn resident_counter_durable_rewind_preserves_compacted_prefix_and_invalidates_io_failure()
    {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("history.jsonl");
        let runtime = test_runtime("durable", &path);
        let engine = runtime.engine();
        let followups = runtime.followups();
        engine.state.with_history_path(&path);
        for text in ["one", "two", "three"] {
            engine
                .state
                .add_message(kcoder_types::Message::user_text(text));
        }
        engine
            .state
            .set_messages_after_compaction(
                vec![kcoder_types::Message::compaction_text(
                    "Earlier conversation summary: compacted",
                )],
                kcoder_state::CompactionTranscriptEvent {
                    trigger: kcoder_state::CompactionTrigger::Manual,
                    pre_tokens: 100,
                    post_tokens: 10,
                    summary: "compacted".into(),
                },
            )
            .await
            .unwrap();
        engine
            .state
            .add_message(kcoder_types::Message::user_text("four"));
        followups.client_turn_count.reset(4);
        let outcome = engine
            .state
            .truncate_messages_for_rewind(1, 1)
            .await
            .unwrap();
        assert!(outcome.boundary_recorded);
        crate::app_server::update_client_turn_count_after_rewind(
            &engine,
            &followups,
            Some(outcome),
        )
        .unwrap();
        assert_eq!(followups.client_turn_count.get(), Some(3));
        assert_eq!(engine.client_turn_count(), 0);
        let prepared = kcoder_state::prepare_session_resume(&path).unwrap();
        let visible = prepared.load_transcript_messages().unwrap();
        assert_eq!(visible.len(), 3);
        assert_eq!(visible.last().unwrap().preview(100), "three");
        let parked = path.with_extension("parked");
        std::fs::rename(&path, &parked).unwrap();
        crate::app_server::update_client_turn_count_after_rewind(
            &engine,
            &followups,
            Some(kcoder_state::ConversationRewindOutcome {
                removed: 1,
                boundary_recorded: false,
            }),
        )
        .unwrap();
        assert_eq!(followups.client_turn_count.get(), Some(3));
        assert!(
            crate::app_server::update_client_turn_count_after_rewind(
                &engine,
                &followups,
                Some(outcome)
            )
            .is_err()
        );
        assert_eq!(followups.client_turn_count.get(), None);
        std::fs::rename(&parked, &path).unwrap();
        followups
            .client_turn_count
            .reset(crate::app_server::reconstruct_client_turn_count(&engine).unwrap());
        assert_eq!(followups.client_turn_count.increment().unwrap(), 4);
    }

    // Validate manager ownership only; do not start background tasks or make the unit test depend on Tokio time.
    #[tokio::test]
    async fn selecting_threads_keeps_both_leases_and_engines_resident() {
        let temp = tempfile::tempdir().unwrap();
        let first_history = temp.path().join("first.jsonl");
        let second_history = temp.path().join("second.jsonl");
        let mut manager = ThreadManager::default();
        let first = test_runtime("first", &first_history);
        let first_id = first.engine.session_id();
        assert!(matches!(manager.insert(first), Ok(None)));
        let second = test_runtime("second", &second_history);
        let second_id = second.engine.session_id();
        assert!(matches!(manager.insert(second), Ok(None)));

        assert!(manager.select(&first_id).is_some());
        assert!(manager.select(&second_id).is_some());
        assert!(SessionLease::acquire(&first_history).is_err());
        assert!(SessionLease::acquire(&second_history).is_err());

        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn diagnostic_shutdown_waits_for_own_scope() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("history.jsonl");
        let runtime = test_runtime("diagnostic", &path);
        let state = runtime.engine().state;
        state.with_history_path(&path);
        state.set_usage_history_root(Some(&temp.path().join("usage")));
        let capture = state
            .begin_llm_exchange(
                kcoder_state::DiagnosticRequest::new(kcoder_types::MessagesRequest::new(
                    "held",
                    vec![kcoder_types::Message::user_text("held")],
                )),
                false,
            )
            .await;
        let shutdown = runtime.shutdown();
        tokio::pin!(shutdown);
        assert!(
            tokio::time::timeout(Duration::from_millis(30), &mut shutdown)
                .await
                .is_err(),
            "resident teardown must flush its own in-flight diagnostic scope"
        );
        drop(capture);
        tokio::time::timeout(Duration::from_secs(5), shutdown)
            .await
            .unwrap();
        assert!(
            state
                .flush_diagnostics_until(std::time::Instant::now())
                .await
        );
    }

    #[tokio::test]
    async fn diagnostic_shutdown_does_not_wait_for_other_resident_or_close_shared_writer() {
        let temp = tempfile::tempdir().unwrap();
        let first = test_runtime("first", &temp.path().join("first.jsonl"));
        let second = test_runtime("second", &temp.path().join("second.jsonl"));
        let first_state = first.engine().state;
        let second_state = second.engine().state;
        first_state.with_history_path(temp.path().join("first.jsonl"));
        second_state.with_history_path(temp.path().join("second.jsonl"));
        let writer = first_state.diagnostic_writer();
        second_state.set_diagnostic_context(writer.clone(), None);
        let request = kcoder_state::DiagnosticRequest::new(kcoder_types::MessagesRequest::new(
            "held",
            vec![kcoder_types::Message::user_text("held")],
        ));
        let held = second_state
            .begin_llm_exchange(request.clone(), false)
            .await;
        tokio::time::timeout(Duration::from_millis(500), first.shutdown())
            .await
            .expect("unrelated resident scope must not block shutdown");
        let next = second_state.begin_llm_exchange(request, false).await;
        assert_eq!(
            writer.stats().reserved_jobs,
            2,
            "resident shutdown must not close shared writer"
        );
        drop(held);
        drop(next);
        second.shutdown().await;
    }

    #[tokio::test]
    async fn diagnostic_shutdown_shared_deadline_does_not_multiply_wait_by_resident_count() {
        let temp = tempfile::tempdir().unwrap();
        let mut runtimes = Vec::new();
        let mut held = Vec::new();
        let mut states = Vec::new();
        for index in 0..3 {
            let path = temp.path().join(format!("resident-{index}.jsonl"));
            let runtime = test_runtime("held", &path);
            let state = runtime.engine().state;
            state.with_history_path(path);
            held.push(
                state
                    .begin_llm_exchange(
                        kcoder_state::DiagnosticRequest::new(kcoder_types::MessagesRequest::new(
                            "held",
                            vec![],
                        )),
                        false,
                    )
                    .await,
            );
            states.push(state);
            runtimes.push(runtime);
        }
        let deadline = std::time::Instant::now() + Duration::from_millis(30);
        tokio::time::timeout(Duration::from_millis(500), async {
            for runtime in runtimes {
                runtime.shutdown_with_diagnostic_deadline(deadline).await;
            }
        })
        .await
        .expect("all residents share one diagnostic deadline");
        assert!(
            std::time::Instant::now() >= deadline,
            "first scope must honor the flush wait"
        );
        for state in &states {
            assert!(
                !state
                    .flush_diagnostics_until(std::time::Instant::now())
                    .await
            );
        }
        drop(held);
        for state in &states {
            assert!(
                state
                    .flush_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
                    .await
            );
        }
    }

    #[tokio::test]
    async fn lru_eviction_never_removes_the_newly_selected_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let mut manager = ThreadManager::with_resident_limit(2);
        let first = test_runtime("first", &temp.path().join("first.jsonl"));
        let first_id = first.engine.session_id();
        assert!(matches!(manager.insert(first), Ok(None)));
        let second = test_runtime("second", &temp.path().join("second.jsonl"));
        let second_id = second.engine.session_id();
        assert!(matches!(manager.insert(second), Ok(None)));
        manager.select(&first_id).unwrap();
        let third = test_runtime("third", &temp.path().join("third.jsonl"));
        let third_id = third.engine.session_id();
        let evicted = match manager.insert(third) {
            Ok(Some(evicted)) => evicted,
            _ => panic!("one runtime is evicted"),
        };

        assert_eq!(evicted.engine.session_id(), second_id);
        assert!(manager.owns(&first_id));
        assert!(manager.owns(&third_id));
        evicted.shutdown().await;
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn capacity_rejects_insertion_when_only_runtime_is_selected() {
        let temp = tempfile::tempdir().unwrap();
        let mut manager = ThreadManager::with_resident_limit(1);
        let first = test_runtime("first", &temp.path().join("first.jsonl"));
        let first_id = first.engine.session_id();
        assert!(matches!(manager.insert(first), Ok(None)));

        let second = test_runtime("second", &temp.path().join("second.jsonl"));
        let rejected = match manager.insert(second) {
            Err(rejected) => rejected,
            Ok(_) => panic!("active runtime must not be evicted"),
        };
        assert!(manager.owns(&first_id));
        assert_eq!(manager.runtimes.len(), 1);

        (*rejected).shutdown().await;
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn resident_threads_own_independent_execution_gates() {
        let temp = tempfile::tempdir().unwrap();
        let mut manager = ThreadManager::default();
        let first = test_runtime("first", &temp.path().join("first.jsonl"));
        let first_id = first.engine.session_id();
        assert!(manager.insert(first).is_ok());
        let second = test_runtime("second", &temp.path().join("second.jsonl"));
        let second_id = second.engine.session_id();
        assert!(manager.insert(second).is_ok());

        let first_state = manager.turn_state(&first_id).unwrap();
        let second_state = manager.turn_state(&second_id).unwrap();
        let first_running = Arc::clone(&first_state.running);
        let second_running = Arc::clone(&second_state.running);
        first_running.store(true, Ordering::SeqCst);

        assert!(first_running.load(Ordering::SeqCst));
        assert!(!second_running.load(Ordering::SeqCst));
        assert!(!Arc::ptr_eq(
            &first_state.activity_gate,
            &second_state.activity_gate
        ));
        assert!(!Arc::ptr_eq(
            &first_state.active_turn,
            &second_state.active_turn
        ));
        assert!(!Arc::ptr_eq(
            &first_state.question_context,
            &second_state.question_context
        ));
        assert!(!Arc::ptr_eq(
            &first_state.pending_questions,
            &second_state.pending_questions
        ));
        assert!(!Arc::ptr_eq(
            &first_state.approval_context,
            &second_state.approval_context
        ));
        assert!(!Arc::ptr_eq(
            &first_state.pending_approvals,
            &second_state.pending_approvals
        ));

        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn timed_out_turn_cancellation_resets_only_the_matching_turn_state() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = test_runtime("cancelled", &temp.path().join("cancelled.jsonl"));
        let turn_state = runtime.turn_state.clone();
        let projection = runtime.background_projection.clone();
        let followups = runtime.background_followups.clone();
        let (question_tx, _question_rx) = oneshot::channel();
        let (approval_tx, _approval_rx) = oneshot::channel();
        turn_state
            .pending_questions
            .lock()
            .unwrap()
            .insert(1, question_tx);
        turn_state
            .pending_approvals
            .lock()
            .unwrap()
            .insert(2, approval_tx);
        *turn_state.question_context.lock().unwrap() = Some(QuestionContext {
            server_id: "server".into(),
            thread_id: "thread".into(),
            turn_id: "turn".into(),
        });
        *turn_state.approval_context.lock().unwrap() = Some(ApprovalContext {
            server_id: "server".into(),
            thread_id: "thread".into(),
            turn_id: "turn".into(),
        });
        projection.lock().await.active = Some(BackgroundTurnProjection {
            thread_id: "thread".into(),
            turn_id: "turn".into(),
            projection: Arc::new(tokio::sync::Mutex::new(StreamProjection::new(
                "server".into(),
                "thread".into(),
                "turn".into(),
                Arc::new(AtomicU64::new(1)),
            ))),
        });
        turn_state.running.store(true, Ordering::SeqCst);
        let active = ActiveTurn {
            handle: tokio::spawn(std::future::pending()),
            cancel: CancellationToken::new(),
            thread_id: "thread".into(),
            turn_id: "turn".into(),
        };
        let notified_followups = Arc::clone(&followups);
        let (notified_tx, notified_rx) = oneshot::channel();
        tokio::spawn(async move {
            notified_followups.notify.notified().await;
            let _ = notified_tx.send(());
        });
        tokio::task::yield_now().await;

        cancel_active_turn_with_timeout(
            active,
            &turn_state,
            &projection,
            &followups,
            std::time::Duration::from_millis(10),
        )
        .await;

        assert!(!turn_state.running.load(Ordering::SeqCst));
        assert!(turn_state.pending_questions.lock().unwrap().is_empty());
        assert!(turn_state.pending_approvals.lock().unwrap().is_empty());
        assert!(turn_state.question_context.lock().unwrap().is_none());
        assert!(turn_state.approval_context.lock().unwrap().is_none());
        assert!(projection.lock().await.active.is_none());
        tokio::time::timeout(std::time::Duration::from_millis(10), notified_rx)
            .await
            .expect("cancel finalizer must notify follow-up scheduler")
            .expect("notification witness remains alive");
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn stale_cancel_finalizer_does_not_clear_a_newer_turn() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = test_runtime("newer", &temp.path().join("newer.jsonl"));
        let turn_state = runtime.turn_state.clone();
        let projection = runtime.background_projection.clone();
        let followups = runtime.background_followups.clone();
        let (question_tx, _question_rx) = oneshot::channel();
        turn_state
            .pending_questions
            .lock()
            .unwrap()
            .insert(1, question_tx);
        *turn_state.question_context.lock().unwrap() = Some(QuestionContext {
            server_id: "server".into(),
            thread_id: "thread".into(),
            turn_id: "newer-turn".into(),
        });
        projection.lock().await.active = Some(BackgroundTurnProjection {
            thread_id: "thread".into(),
            turn_id: "newer-turn".into(),
            projection: Arc::new(tokio::sync::Mutex::new(StreamProjection::new(
                "server".into(),
                "thread".into(),
                "newer-turn".into(),
                Arc::new(AtomicU64::new(1)),
            ))),
        });
        turn_state.running.store(true, Ordering::SeqCst);
        *turn_state.active_turn.lock().await = Some(ActiveTurn {
            handle: tokio::spawn(std::future::pending()),
            cancel: CancellationToken::new(),
            thread_id: "thread".into(),
            turn_id: "newer-turn".into(),
        });
        let stale = ActiveTurn {
            handle: tokio::spawn(std::future::pending()),
            cancel: CancellationToken::new(),
            thread_id: "thread".into(),
            turn_id: "stale-turn".into(),
        };

        cancel_active_turn_with_timeout(
            stale,
            &turn_state,
            &projection,
            &followups,
            std::time::Duration::from_millis(10),
        )
        .await;

        assert!(turn_state.running.load(Ordering::SeqCst));
        assert_eq!(
            turn_state
                .question_context
                .lock()
                .unwrap()
                .as_ref()
                .map(|context| context.turn_id.as_str()),
            Some("newer-turn")
        );
        assert!(!turn_state.pending_questions.lock().unwrap().is_empty());
        assert_eq!(
            projection
                .lock()
                .await
                .active
                .as_ref()
                .map(|active| active.turn_id.as_str()),
            Some("newer-turn")
        );

        let newer = turn_state.active_turn.lock().await.take().unwrap();
        newer.handle.abort();
        let _ = newer.handle.await;
        turn_state.clear_all_turn_state();
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn idle_removal_claim_blocks_late_turn_start_and_running_runtime_stays_owned() {
        let temp = tempfile::tempdir().unwrap();
        let mut manager = ThreadManager::with_resident_limit(2);
        let runtime = test_runtime("claimed", &temp.path().join("claimed.jsonl"));
        let thread_id = runtime.engine.session_id();
        let turn_state = runtime.turn_state.clone();
        assert!(manager.insert(runtime).is_ok());

        turn_state.running.store(true, Ordering::SeqCst);
        assert!(manager.remove_if_idle(&thread_id).is_err());
        assert!(manager.owns(&thread_id));

        turn_state.running.store(false, Ordering::SeqCst);
        let gate = Arc::clone(&turn_state.activity_gate).lock_owned().await;
        let late_turn_state = turn_state.clone();
        let late_claim = tokio::spawn(async move {
            let _gate = late_turn_state.activity_gate.lock().await;
            late_turn_state.try_claim_turn()
        });
        tokio::task::yield_now().await;
        let removed = manager
            .remove_if_idle(&thread_id)
            .expect("idle runtime can be claimed")
            .expect("resident runtime exists");
        assert!(!manager.owns(&thread_id));
        drop(gate);
        assert!(!late_claim.await.unwrap());
        removed.shutdown().await;
    }

    #[tokio::test]
    async fn turn_registration_guard_blocks_scheduler_until_active_handle_is_published() {
        let (tx, _rx) = mpsc::channel(1);
        let turn_state = ResidentTurnState::new(
            tx,
            PermissionMode::Bypass,
            Arc::new(AtomicU64::new(1_000_000)),
            Arc::new(AtomicU64::new(2_000_000)),
            Arc::new(StdMutex::new(InteractionReceipts::default())),
        );
        let registration = turn_state
            .claim_turn_registration()
            .await
            .expect("explicit turn claims the idle runtime");

        // Simulate a turn that finishes before its active handle is published. Even
        // after observing running=false, the scheduler must wait for the old handle to
        // finish publication before starting the next turn.
        turn_state.running.store(false, Ordering::SeqCst);
        let scheduler_state = turn_state.clone();
        let mut scheduler_claim =
            tokio::spawn(async move { scheduler_state.claim_turn_registration().await.is_some() });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut scheduler_claim)
                .await
                .is_err(),
            "scheduler must not enter the registration window"
        );

        *turn_state.active_turn.lock().await = Some(ActiveTurn {
            handle: tokio::spawn(std::future::pending()),
            cancel: CancellationToken::new(),
            thread_id: "thread".into(),
            turn_id: "fast-turn".into(),
        });
        drop(registration);
        assert!(scheduler_claim.await.unwrap());

        let active = turn_state.active_turn.lock().await.take().unwrap();
        active.handle.abort();
        let _ = active.handle.await;
        turn_state.clear_all_turn_state();
    }
}

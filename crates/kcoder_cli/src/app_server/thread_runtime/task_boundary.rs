//! A task-local idle boundary; it transfers neither a lease nor input authority.
use super::*;

/// Keep the original task stable while a configuration/creation transaction runs.
/// Dropping the guard restores only the admissions acquired by this guard.
#[must_use = "the task is stable only while its reservation is held"]
pub(in crate::app_server) struct TaskIdleReservation {
    state: ResidentTurnState,
    engine: QueryEngine,
    _gate: tokio::sync::OwnedMutexGuard<()>,
    background: Option<kcoder_engine::BackgroundWorkIdleReservation>,
}

impl TaskIdleReservation {
    pub(in crate::app_server) fn engine(&self) -> QueryEngine {
        self.engine.clone()
    }

    /// A retained neutral configuration may share the State, but not substitute
    /// another task or project for the actual reserved owner.
    pub(in crate::app_server) fn verify_configuration_source(
        &self,
        source: &QueryEngine,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            source.state.shares_state_with(&self.engine.state)
                && source.session_id() == self.engine.session_id()
                && source.state.cwd() == self.engine.state.cwd()
                && source.shares_idle_admission_with(&self.engine)
                && !self.state.accepting_turns.load(Ordering::SeqCst),
            "TASK_BOUNDARY_CONFIGURATION_OWNER_CHANGED"
        );
        Ok(())
    }
}

impl Drop for TaskIdleReservation {
    fn drop(&mut self) {
        self.background.take();
        self.state.resume_accepting_turns();
    }
}

impl ThreadManager {
    /// The caller must separately verify its source, binding revision and access.
    /// This guard excludes execution on this task without stopping peer tasks.
    pub(in crate::app_server) fn try_reserve_task_idle(
        &self,
        thread: &str,
    ) -> anyhow::Result<TaskIdleReservation> {
        let runtime = self
            .runtimes
            .get(thread)
            .ok_or_else(|| anyhow::anyhow!("TASK_BOUNDARY_RESIDENT_REQUIRED"))?;
        let gate = Arc::clone(&runtime.turn_state.activity_gate)
            .try_lock_owned()
            .map_err(|_| anyhow::anyhow!("TASK_BOUNDARY_TURN_BUSY"))?;
        runtime
            .turn_state
            .accepting_turns
            .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| anyhow::anyhow!("TASK_BOUNDARY_ADMISSION_CLOSED"))?;
        let mut reservation = TaskIdleReservation {
            state: runtime.turn_state.clone(),
            engine: runtime.engine(),
            _gate: gate,
            background: None,
        };
        anyhow::ensure!(
            runtime
                .lease
                .matches_target(&runtime.engine.session_lease_target()),
            "TASK_BOUNDARY_OWNER_CHANGED"
        );
        anyhow::ensure!(
            runtime.idle_blocker().is_none(),
            "TASK_BOUNDARY_ACTIVITY_BUSY"
        );
        anyhow::ensure!(
            !runtime
                .turn_state
                .active_turn
                .try_lock()
                .map_err(|_| anyhow::anyhow!("TASK_BOUNDARY_TURN_BUSY"))?
                .as_ref()
                .is_some_and(|turn| !turn.handle.is_finished()),
            "TASK_BOUNDARY_TURN_BUSY"
        );
        reservation.background = Some(
            runtime
                .engine
                .try_reserve_background_work_idle()
                .ok_or_else(|| anyhow::anyhow!("TASK_BOUNDARY_BACKGROUND_BUSY"))?,
        );
        Ok(reservation)
    }
}

#[cfg(test)]
mod tests;

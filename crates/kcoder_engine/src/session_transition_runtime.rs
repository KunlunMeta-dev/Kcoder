//! Session transition runtime within the shared engine ownership boundary.

use super::*;

impl QueryEngine {
    /// Subscribe to durable scheduled-task fires. The UI facade translates
    /// these into the same idle-gated follow-up queue used by sub-agents.
    pub fn subscribe_cron(&self) -> tokio::sync::broadcast::Receiver<CronFire> {
        self.cron_scheduler.subscribe()
    }

    pub fn cron_scheduler(&self) -> Arc<CronScheduler> {
        Arc::clone(&self.cron_scheduler)
    }

    /// Rotate to a clean chat and stop jobs owned by the previous session.
    pub fn start_new_session(&self) -> anyhow::Result<()> {
        let id = self.state.reserve_new_session_id()?;
        self.prepare_session_replacement();
        self.state.start_new_session_with_reserved_id(id);
        self.rebind_checkpoints_to_current_session();
        Ok(())
    }

    /// Apply a prepared durable-session replacement and rotate all engine
    /// services whose storage is keyed by the active session id.
    pub fn apply_prepared_session_resume(
        &self,
        prepared: kcoder_state::PreparedSessionResume,
    ) -> anyhow::Result<usize> {
        self.prepare_session_replacement();
        let count = self.state.apply_prepared_session_resume(prepared)?;
        self.rebind_checkpoints_to_current_session();
        Ok(count)
    }

    pub(super) fn rebind_checkpoints_to_current_session(&self) {
        self.checkpoints.rebind(kcoder_state::session_dir_path(
            &self.session_storage_root,
            &self.state.artifact_session_id(),
        ));
    }

    /// Stop runtime work and discard prompt snapshots before replacing AppState
    /// with another durable session.
    pub fn prepare_session_replacement(&self) {
        self.prefire_owner.cancel();
        self.background_jobs.advance_generation_and_abort_all();
        if let Some(handle) = self
            .session_memory_update_handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            handle.abort();
        }
        self.mark_session_memory_update_finished();
        if let Some(handle) = self
            .memory_observer_worker_handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            handle.abort();
        }
        recover_write_lock(&self.memory_observer_queue, "memory_observer_queue").drain_all();
        self.memory_observer_worker_running
            .store(false, Ordering::SeqCst);
        *recover_write_lock(&self.last_cache_safe_params, "last_cache_safe_params") = None;
    }
}

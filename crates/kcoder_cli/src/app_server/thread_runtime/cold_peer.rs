//! Cold activation reserves the same resident capacity as normal resume.
use super::*;

#[cfg(test)]
#[path = "cold_peer/idle_tests.rs"]
mod idle_tests;

impl ThreadManager {
    pub(in crate::app_server) async fn observe_cold_idle(
        &self,
    ) -> anyhow::Result<super::super::session_messages::cold_target_runtime::ColdIdleObservation>
    {
        self.cold_idle_handoff
            .observe(self.peer_service.clone(), self.cold_preparing.len())
            .await
    }

    pub(in crate::app_server) fn take_completed_local_cold_peers(
        &mut self,
        idle: &super::super::session_messages::idle::PeerIdleDriver,
    ) -> Vec<ThreadRuntime> {
        let ids = self
            .runtimes
            .iter()
            .filter_map(|(id, runtime)| {
                let owner = runtime.engine.state.try_inspection_lifecycle_identity()?;
                let retire = runtime.local_peer_hosts
                    && runtime.cold_peer_artifacts.is_some()
                    && idle.completed_pass_for(id, &owner)
                    && runtime.claim_shutdown_if_idle();
                retire.then(|| id.clone())
            })
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| self.runtimes.remove(&id))
            .collect()
    }
    /// One reservation table for stdio and shared clients on this workspace
    /// host. The weak entry retires with the owning preparation or response.
    pub(in crate::app_server) fn reserve_resume_preparation(
        &mut self,
        thread: &str,
    ) -> Option<(Arc<()>, Option<CancellationToken>)> {
        self.resume_preparing
            .retain(|_, owner| owner.strong_count() != 0);
        if self.is_resume_preparing(thread) {
            return None;
        }
        let owner = Arc::new(());
        self.resume_preparing
            .insert(thread.to_owned(), Arc::downgrade(&owner));
        Some((owner, self.cold_preparing.get(thread).cloned()))
    }

    pub(in crate::app_server) fn is_resume_preparing(&self, thread: &str) -> bool {
        self.resume_preparing
            .get(thread)
            .is_some_and(|owner| owner.strong_count() != 0)
    }

    pub(in crate::app_server) fn reserve_cold_peer(
        &mut self,
        thread: &str,
    ) -> Result<Option<ThreadRuntime>, ()> {
        if self.runtimes.contains_key(thread)
            || self.cold_preparing.contains_key(thread)
            || self.is_resume_preparing(thread)
        {
            return Err(());
        }
        let evicted = self.reserve_capacity()?;
        self.cold_preparing
            .insert(thread.to_owned(), CancellationToken::new());
        Ok(evicted)
    }
    pub(in crate::app_server) fn release_cold_peer(&mut self, thread: &str) {
        if let Some(finished) = self.cold_preparing.remove(thread) {
            finished.cancel();
        }
    }
    pub(in crate::app_server) fn insert_cold_peer(
        &mut self,
        runtime: ThreadRuntime,
    ) -> Result<Option<ThreadRuntime>, Box<ThreadRuntime>> {
        let thread = runtime.engine.session_id();
        let preparation = self.cold_preparing.remove(&thread);
        let selected = self.active_thread_id.clone();
        let result = self.insert(runtime);
        self.active_thread_id = selected;
        if let Some(finished) = preparation {
            if result.is_ok() {
                finished.cancel();
            } else {
                // A failed insertion still owns the candidate lease until
                // the caller shuts it down and releases the reservation.
                self.cold_preparing.insert(thread, finished);
            }
        }
        result
    }
}
impl ThreadRuntime {
    pub(in crate::app_server) fn with_local_peer_hosts(mut self) -> Self {
        self.local_peer_hosts = true;
        self
    }
    pub(in crate::app_server) fn with_cold_peer_artifacts(
        mut self,
        artifacts: Arc<super::super::session_discovery::session_directory::cold_target::ColdPeerTargetArtifacts>,
    ) -> Self {
        self.cold_peer_artifacts = Some(artifacts);
        self
    }
}

//! An idle receiver borrows the real runtime's gate and weak kernel lease.
use super::*;
use kcoder_cli_storage::session_lease::NativeSessionLeaseWitness;
use kcoder_state::{
    AppStateLifecycleIdentity, cross_session_messages::CrossSessionMessageObservationStamp,
};

pub(in crate::app_server) struct PeerIdleObservation {
    pub thread_id: String,
    pub owner: AppStateLifecycleIdentity,
    pub stamp: Result<Option<CrossSessionMessageObservationStamp>, String>,
}

pub(in crate::app_server) struct PeerIdleRuntime {
    pub engine: QueryEngine,
    pub owner: AppStateLifecycleIdentity,
    pub lease: NativeSessionLeaseWitness,
    pub turn_state: ResidentTurnState,
    pub background_projection: Arc<Mutex<BackgroundProjectionState>>,
    pub followups: Arc<BackgroundFollowupState>,
    // RAII guards: the idle reservation and registration lock last as long as this runtime.
    _background: Option<kcoder_engine::BackgroundWorkIdleReservation>,
    _registration: tokio::sync::OwnedMutexGuard<()>,
    source: Arc<crate::peer_sessions::BoundPeerSource>,
    artifacts: Option<Arc<super::super::session_discovery::session_directory::cold_target::ColdPeerTargetArtifacts>>,
}
impl PeerIdleRuntime {
    pub(in crate::app_server) fn verify_service(
        &self,
        service: &Arc<crate::app_server::session_messages::service::PeerMessageService>,
    ) -> anyhow::Result<()> {
        self.verify_owner()?;
        anyhow::ensure!(
            Arc::ptr_eq(self.source.service(), service),
            "peer_idle_service_owner_changed"
        );
        Ok(())
    }
    /// Valid before and after awaited work. Holding this value never keeps the
    /// original SessionLease or a revoked endpoint's authority alive.
    pub(in crate::app_server) fn verify_owner(&self) -> anyhow::Result<()> {
        if let Some(artifacts) = &self.artifacts {
            artifacts.verify(&self.engine.session_id())?;
        }
        anyhow::ensure!(
            self.turn_state.accepting_turns.load(Ordering::SeqCst)
                && self.owner.try_matches(&self.engine.state) == Some(true)
                && self.source.owner().same_lifecycle(&self.owner)
                && self.source.state().shares_state_with(&self.engine.state)
                && self.source.address()?.thread_id == self.engine.session_id()
                && self.engine.is_independent_discovery_session(),
            "peer_idle_runtime_owner_changed"
        );
        self.lease
            .verify_target(&self.engine.session_lease_target())
    }
}
impl ThreadManager {
    /// Metadata-only observations; no queue header/body, archive or conversation reads.
    pub(in crate::app_server) fn peer_idle_observations(&self) -> Vec<PeerIdleObservation> {
        let mut observations = self
            .runtimes
            .iter()
            .filter_map(|(id, runtime)| {
                if runtime.ephemeral
                    || runtime.peer_source.is_none()
                    || !runtime.engine.has_peer_message_host()
                    || !runtime.engine.is_independent_discovery_session()
                {
                    return None;
                }
                Some(PeerIdleObservation {
                    thread_id: id.clone(),
                    owner: runtime.engine.state.try_inspection_lifecycle_identity()?,
                    stamp: runtime.engine.peer_message_observation_stamp(),
                })
            })
            .collect::<Vec<_>>();
        observations.sort_by(|a, b| a.thread_id.cmp(&b.thread_id));
        observations
    }
    /// The returned registration remains held through apply and ActiveTurn publication.
    pub(in crate::app_server) fn try_peer_idle_runtime(&self, id: &str) -> Option<PeerIdleRuntime> {
        let runtime = self.runtimes.get(id)?;
        if runtime.ephemeral
            || runtime
                .turn_state
                .pending_user_admissions
                .load(Ordering::Acquire)
                != 0
            || !runtime.engine.has_peer_message_host()
            || !runtime.engine.is_independent_discovery_session()
        {
            return None;
        }
        let registration = Arc::clone(&runtime.turn_state.activity_gate)
            .try_lock_owned()
            .ok()?;
        if !runtime.turn_state.accepting_turns.load(Ordering::SeqCst)
            || runtime
                .turn_state
                .pending_user_admissions
                .load(Ordering::Acquire)
                != 0
            || runtime.engine.turn_driver_active()
            || runtime.idle_blocker().is_some()
            || runtime.engine.try_background_activity_counts() != Some((0, 0, 0))
        {
            return None;
        }
        {
            let active = runtime.turn_state.active_turn.try_lock().ok()?;
            if active
                .as_ref()
                .is_some_and(|turn| !turn.handle.is_finished())
            {
                return None;
            }
        }
        let work = PeerIdleRuntime {
            _background: Some(runtime.engine.try_reserve_background_work_idle()?),
            engine: runtime.engine.clone(),
            owner: runtime.engine.state.try_inspection_lifecycle_identity()?,
            lease: runtime.lease.native_witness().ok()?,
            turn_state: runtime.turn_state.clone(),
            background_projection: runtime.background_projection.clone(),
            followups: runtime.background_followups.clone(),
            _registration: registration,
            source: runtime.peer_source.as_ref()?.source().ok()?,
            artifacts: runtime.cold_peer_artifacts.clone(),
        };
        work.verify_owner().ok()?;
        Some(work)
    }
}

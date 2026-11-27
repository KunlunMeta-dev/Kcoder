//! The original TUI owns one dispatcher, sharing Native restore and idle work.
use super::*;
use crate::app_server::session_messages::{
    idle::PeerIdleDriver, idle_turn::PeerIdleTurnContext, router_rpc::ColdPeerSourceVerifier,
};
use crate::peer_sessions::BoundPeerSource;

pub(crate) struct OwnedPeerColdTargets {
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl OwnedPeerColdTargets {
    pub(crate) fn start(
        factory: AppServerEngineFactory,
        source: &Arc<BoundPeerSource>,
        cold_source: Arc<dyn ColdPeerSourceVerifier>,
    ) -> Result<Self> {
        source.address()?;
        let service =
            PeerMessageService::capture(factory.profile_paths()?, source.state().cwd(), None)?;
        service.install_cold_source_verifier(&cold_source)?;
        let cancel = CancellationToken::new();
        source.service().bind_cold_target_owner(cancel.clone())?;
        let (outbound, mut events) = mpsc::channel(128);
        let server = format!("peer-owned-{}", uuid::Uuid::new_v4());
        let sequence = Arc::new(AtomicU64::new(1));
        let mut cold = ColdTargetDriver::new(
            factory,
            service.clone(),
            source.storage_root().to_owned(),
            None,
            outbound.clone(),
            server.clone(),
            sequence.clone(),
            Arc::new(AtomicU64::new(1)),
            Arc::new(Mutex::new(InteractionReceipts::default())),
            true,
            Some(cancel.child_token()),
        )?;
        let mut idle = PeerIdleDriver::new(PeerIdleTurnContext {
            outbound,
            server_id: server,
            sequence,
            next_turn_id: Arc::new(AtomicU64::new(1)),
            cancel: cancel.clone(),
            attended: false,
        });
        let mut manager = ThreadManager::with_resident_limit(4);
        manager.configure_peer_services(service.clone(), None);
        let source = Arc::downgrade(source);
        let stop = cancel.clone();

        let task = tokio::spawn(async move {
            // The actual foreground owner keeps this reader valid throughout
            // the owned dispatcher; its saved signature is never an allow.
            let _cold_source = cold_source;
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! { biased; _ = stop.cancelled() => {

                    break;
                }, Some(_) = events.recv() => continue, _ = tick.tick() => {} }
                let Some(source) = source.upgrade() else {
                    break;
                };
                if source.communication_revoked() {
                    break;
                }
                // A transient State lock is not revocation or permission.
                if source.address().is_err() {
                    continue;
                }

                cold.tick(&mut manager).await;
                idle.tick(&manager, Some(&service));
                for runtime in manager.take_completed_local_cold_peers(&idle) {
                    let empty = runtime
                        .engine()
                        .state
                        .try_inspection_lifecycle_identity()
                        .is_some_and(|owner| {
                            idle.verified_empty_pass_for(&runtime.engine().session_id(), &owner)
                        });
                    cold.note_retired(&runtime, empty);
                    runtime.shutdown().await;
                }
            }
            stop.cancel();
            cold.shutdown(&mut manager).await;
            idle.shutdown().await;
            for runtime in manager.drain() {
                runtime.shutdown().await;
            }
        });
        Ok(Self {
            cancel,
            task: Some(task),
        })
    }
    pub(crate) fn cancel(&self) {
        self.cancel.cancel();
    }
    pub(crate) async fn close(&mut self) {
        self.cancel.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}
impl Drop for OwnedPeerColdTargets {
    fn drop(&mut self) {
        // Keep the existing owned cleanup future alive until its cancelled
        // drivers/turns and original leases settle. Normal close awaits it.
        self.cancel.cancel();
    }
}

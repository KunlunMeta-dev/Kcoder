use super::*;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

pub(in super::super) struct SourceTransferWorkers {
    cancellation: CancellationToken,
    tasks: Mutex<JoinSet<()>>,
    running: Arc<AtomicUsize>,
}
struct Count(Arc<AtomicUsize>);
impl Drop for Count {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
impl SourceTransferWorkers {
    pub(in super::super) fn new(cancellation: CancellationToken) -> Self {
        Self {
            cancellation,
            tasks: Mutex::new(JoinSet::new()),
            running: Arc::new(AtomicUsize::new(0)),
        }
    }
    pub(in super::super) fn activity(&self) -> usize {
        self.running.load(Ordering::Acquire)
    }
    pub(super) fn start(&self, peer: AuthorizedMigrationPeer) -> Result<()> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "source_transfer_capture_interrupted"
        );
        peer.validate()?;
        let native = source(&peer)?;
        let journal = intent(&peer)?;
        let destination = journal.destination(peer.request_id(), peer.target_authority())?;
        let state = native.state(peer.request_id(), &destination)?;
        if state.ready {
            return Ok(());
        }
        let observed = journal.observe(peer.request_id(), false)?;
        if observed.status == "running" {
            return Ok(());
        }
        ensure!(observed.status == "idle", "source_transfer_resume_required");
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| anyhow::anyhow!("source_transfer_busy"))?;
        while tasks.try_join_next().is_some() {}
        ensure!(self.activity() < 2, "source_transfer_worker_capacity");
        let permit = journal.start_capture(peer.request_id())?;
        let cancellation = self.cancellation.clone();
        self.running.fetch_add(1, Ordering::AcqRel);
        let count = Count(self.running.clone());
        tasks.spawn_blocking(move || {
            let _count = count;
            let authority = || -> Result<()> {
                for binding in journal.bindings(peer.request_id())? {
                    if let ResolvedTransferSelection::Configuration { binding } = binding {
                        binding.verify_codex_layer_authority(peer.profile())?;
                    }
                }
                Ok(())
            };
            let mut result = authority().and_then(|()| {
                native
                    .capture(peer.request_id(), &destination, |_| {
                        !cancellation.is_cancelled()
                            && peer.validate().is_ok()
                            && journal.active(peer.request_id()).is_ok()
                    })
                    .map(drop)
            });
            if cancellation.is_cancelled() {
                result = Err(anyhow::anyhow!("source_transfer_capture_interrupted"));
            } else if peer.validate().is_err() {
                result = Err(anyhow::anyhow!("source_transfer_authority_changed"));
            } else if journal
                .state(peer.request_id(), false)
                .is_ok_and(|s| s.cancelled)
            {
                result = Err(anyhow::anyhow!("source_transfer_cancelled"));
            }
            let _ = permit.complete(result);
        });
        Ok(())
    }
    pub(in super::super) async fn shutdown(&self) {
        self.cancellation.cancel();
        let mut tasks = {
            let mut guard = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut *guard)
        };
        while !tasks.is_empty() {
            let _ = tokio::time::timeout(std::time::Duration::from_millis(100), tasks.join_next())
                .await;
        }
    }
}

//! Loaded mailbox housekeeping is independent of foreground model activity.
use super::PeerMessageService;
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

pub(super) struct MailboxMaintenance {
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for MailboxMaintenance {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.task.abort();
    }
}
pub(super) fn start(service: Arc<PeerMessageService>) -> MailboxMaintenance {
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let task = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {biased;_=stop.cancelled()=>break,_=tick.tick()=>{}}
            if !service.has_loaded_mailbox() {
                continue;
            }
            let observed = service.clone();
            // Only one bounded worker exists per owner. The verified store's
            // warm path stats its held data identity without reading bodies or
            // writing; namespace corruption remains an error, never a repair.
            let _ = tokio::task::spawn_blocking(move || observed.maintain_mailbox()).await;
        }
    });
    MailboxMaintenance { cancel, task }
}

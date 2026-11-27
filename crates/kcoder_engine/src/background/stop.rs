//! Stop registered work without discovering or terminating external services.
use super::*;

impl BackgroundJobManager {
    /// Fence admission before any asynchronous cleanup. No job callback or I/O runs here.
    pub fn stop_accepting_work(&self) {
        crate::recover_read_lock(&self.stop_signal, "managed_stop_signal").cancel();
    }

    /// Optional resource owners may observe this signal and perform their own bounded teardown.
    /// A child token cannot cancel the owning session, and observers never enter the stop wait set.
    pub fn stop_signal(&self) -> tokio_util::sync::CancellationToken {
        crate::recover_read_lock(&self.stop_signal, "managed_stop_signal").child_token()
    }

    /// Reopen only after the previous owned work has settled.
    pub fn resume_accepting_work(&self) -> bool {
        let _admission = self.admission.lock().unwrap_or_else(|p| p.into_inner());
        if !crate::recover_read_lock(&self.handles, "background_job_handles").is_empty()
            || !crate::recover_read_lock(&self.cancelled, "background_job_cancelled").is_empty()
        {
            return false;
        }
        let mut signal = crate::recover_write_lock(&self.stop_signal, "managed_stop_signal");
        if signal.is_cancelled() {
            *signal = tokio_util::sync::CancellationToken::new();
        }
        true
    }

    /// Existing per-job cancellation preserves checkpoints and terminal delivery.
    /// Start every cancellation concurrently, rather than multiplying the grace period.
    pub async fn stop_registered_work(&self) -> bool {
        self.stop_accepting_work();
        let ids: Vec<_> = {
            // A spawn that passed its signal check before stop must finish publishing its
            // handle before the snapshot. This wait belongs to cleanup, never the stop signal.
            let _admission = self.admission.lock().unwrap_or_else(|p| p.into_inner());
            crate::recover_read_lock(&self.handles, "background_job_handles")
                .keys()
                .cloned()
                .collect()
        };
        futures::future::join_all(ids.iter().map(|id| self.abort_and_wait(id))).await;
        // An independently claimed cancellation may still be settling. Do not report it stopped.
        self.try_resource_counts() == Some((0, 0))
    }
}

#[cfg(test)]
#[path = "stop_tests.rs"]
mod tests;

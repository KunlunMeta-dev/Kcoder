//! Background lifetime fences over an existing resident; never a second owner.
use super::*;
use anyhow::Result;

/// A background lifetime cannot outlive its actual source consent or binding version.
/// This private witness supplies no Engine, execution or background authority.
pub(in crate::app_server) trait PreparedThreadOwnerFence:
    Send + Sync
{
    fn verify(&self) -> Result<()>;
    fn allows_ui_resume(&self) -> bool {
        false
    }
}

impl ThreadManager {
    pub(in crate::app_server) fn has_background_lifetime(&self, thread: &str) -> bool {
        self.runtimes
            .get(thread)
            .and_then(|runtime| runtime.background_lifetime.as_ref())
            .is_some_and(|fence| fence.allows_ui_resume() && fence.verify().is_ok())
    }

    pub(in crate::app_server) fn prune_revoked_background_lifetimes(&mut self) {
        // Revocation fences future channel admission at its own PDP boundary.
        // Clearing lifetime policy must not stop a lawful Web client's turn.
        for runtime in self.runtimes.values_mut() {
            if runtime
                .background_lifetime
                .as_ref()
                .is_some_and(|fence| fence.verify().is_err())
            {
                runtime.background_lifetime = None;
            }
        }
    }
}

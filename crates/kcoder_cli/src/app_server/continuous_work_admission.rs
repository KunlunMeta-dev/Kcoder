//! Supply the existing resident owner to continuous-work admission.
use super::*;
use kcoder_cli_storage::session_lease::DeferredSessionLeaseWitness;
use kcoder_foreground_work::{ForegroundSession, InitialWorkOwners};
pub(super) use kcoder_foreground_work::{PendingFollowupWork, PendingInitialWork, automatic::*};

impl ForegroundSession for ThreadManager {
    fn is_ephemeral(&self, thread_id: &str) -> bool {
        ThreadManager::is_ephemeral(self, thread_id)
    }

    fn deferred_lease(
        &self,
        thread_id: &str,
        target: &Path,
    ) -> Option<DeferredSessionLeaseWitness> {
        self.lease(thread_id)?.deferred_witness(target)
    }

    fn initial_work_capacity(&self) -> kcoder_state::continuous_work::NativeInitialWorkCapacity {
        ThreadManager::initial_work_capacity(self)
    }

    fn initial_work_owners(&self, thread_id: &str) -> Option<InitialWorkOwners> {
        ThreadManager::initial_work_owners(self, thread_id)
    }
}

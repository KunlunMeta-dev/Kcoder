use std::sync::{Mutex, MutexGuard};

/// Large archive and catalog fixtures compete for disk/cache capacity. Keep
/// their existing sizes and real read deadlines, but do not let these fixtures
/// manufacture budget failures in each other's bounded observations.
pub(crate) fn large_storage_fixture() -> MutexGuard<'static, ()> {
    static OWNER: Mutex<()> = Mutex::new(());
    OWNER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

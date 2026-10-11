//! Target/identity-scoped feature lifecycle, owned by the authenticated host.
use anyhow::{Result, ensure};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub struct KnowledgeAccess {
    state: Mutex<State>,
}
struct State {
    enabled: bool,
    cancellation: CancellationToken,
}
impl Default for KnowledgeAccess {
    fn default() -> Self {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        Self {
            state: Mutex::new(State {
                enabled: false,
                cancellation,
            }),
        }
    }
}
impl KnowledgeAccess {
    pub fn set_enabled(&self, enabled: bool) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("knowledge access state unavailable"))?;
        if enabled && !state.enabled {
            state.cancellation = CancellationToken::new();
        }
        if !enabled {
            state.cancellation.cancel();
        }
        state.enabled = enabled;
        Ok(())
    }
    /// Acquisition never implicitly enables Wiki. A permit belongs to exactly
    /// one enabled generation; re-enabling does not revive cancelled tasks.
    pub fn acquire(&self) -> Result<CancellationToken> {
        let state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("knowledge access state unavailable"))?;
        ensure!(state.enabled, "Wiki is disabled");
        Ok(state.cancellation.child_token())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_by_default_and_old_tasks_stay_cancelled_after_reenable() -> Result<()> {
        let access = KnowledgeAccess::default();
        assert!(access.acquire().is_err());
        access.set_enabled(true)?;
        let first = access.acquire()?;
        let second = access.acquire()?;
        first.cancel();
        assert!(!second.is_cancelled());
        access.set_enabled(false)?;
        assert!(second.is_cancelled());
        assert!(access.acquire().is_err());
        access.set_enabled(true)?;
        assert!(second.is_cancelled());
        assert!(!access.acquire()?.is_cancelled());
        Ok(())
    }
}

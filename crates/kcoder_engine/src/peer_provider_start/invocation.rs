//! Ephemeral invocation ownership, separate from original peer authorization.
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

const PROVIDER: usize = usize::MAX;
const MAX_TOOL_OWNERS: usize = PROVIDER - 1;

#[derive(Default)]
pub(super) struct Invocations(AtomicUsize);
pub(crate) struct Invocation {
    // This keeps only an invocation counter. The actual turn witness remains
    // weak in PeerProviderScope and is rechecked separately at dispatch.
    owners: Arc<Invocations>,
    provider: bool,
}
impl Invocations {
    pub(super) fn provider(self: &Arc<Self>) -> Result<Invocation, &'static str> {
        self.0
            .compare_exchange(0, PROVIDER, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "peer_provider_invocation_busy")?;
        Ok(Invocation {
            owners: self.clone(),
            provider: true,
        })
    }
    pub(super) fn tools(self: &Arc<Self>) -> Result<Invocation, &'static str> {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_TOOL_OWNERS).then(|| active + 1)
            })
            .map_err(|_| "peer_provider_invocation_busy")?;
        Ok(Invocation {
            owners: self.clone(),
            provider: false,
        })
    }
    pub(super) fn provider_active(&self) -> bool {
        self.0.load(Ordering::Acquire) == PROVIDER
    }
    pub(super) fn tools_active(&self) -> bool {
        (1..PROVIDER).contains(&self.0.load(Ordering::Acquire))
    }
    #[cfg(test)]
    pub(super) fn is_idle(&self) -> bool {
        self.0.load(Ordering::Acquire) == 0
    }
}
impl Drop for Invocation {
    fn drop(&mut self) {
        if self.provider {
            let _ =
                self.owners
                    .0
                    .compare_exchange(PROVIDER, 0, Ordering::AcqRel, Ordering::Acquire);
        } else {
            self.owners.0.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

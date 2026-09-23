//! Turn-driver ownership tracking.
//!
//! While a host is running a main-thread turn stream, the engine's turn loop
//! is the only consumer allowed to claim background completion notifications:
//! it defers events and injects them at the next protocol boundary. Host watch
//! loops consult [`QueryEngine::turn_driver_active`] and stay idle until the
//! turn stream is dropped.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Shared depth counter. Depth (not a boolean) keeps nested streams on the
/// same engine correct: the flag clears only when the outermost stream drops.
#[derive(Debug, Clone, Default)]
pub struct TurnDriverSignal {
    depth: Arc<AtomicUsize>,
}

impl TurnDriverSignal {
    pub fn enter(&self) {
        self.depth.fetch_add(1, Ordering::SeqCst);
    }

    pub fn exit(&self) {
        let _ = self
            .depth
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |depth| {
                Some(depth.saturating_sub(1))
            });
    }

    pub fn active(&self) -> bool {
        self.depth.load(Ordering::SeqCst) > 0
    }
}

/// Sets the signal on creation and clears it on drop, so cancellation and
/// early stream drops restore host watch loops automatically.
pub struct TurnDriverActiveGuard {
    engine: crate::QueryEngine,
}

impl TurnDriverActiveGuard {
    pub fn new(engine: &crate::QueryEngine) -> Self {
        engine.turn_driver_signal().enter();
        Self {
            engine: engine.clone(),
        }
    }
}

impl Drop for TurnDriverActiveGuard {
    fn drop(&mut self) {
        self.engine.turn_driver_signal().exit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_entries_keep_the_signal_active_until_the_last_exit() {
        let signal = TurnDriverSignal::default();
        assert!(!signal.active());
        signal.enter();
        signal.enter();
        assert!(signal.active());
        signal.exit();
        assert!(signal.active(), "inner exit must not clear an outer turn");
        signal.exit();
        assert!(!signal.active());
    }

    #[test]
    fn extra_exits_saturate_at_zero() {
        let signal = TurnDriverSignal::default();
        signal.exit();
        signal.exit();
        assert!(!signal.active());
        signal.enter();
        assert!(signal.active());
    }
}

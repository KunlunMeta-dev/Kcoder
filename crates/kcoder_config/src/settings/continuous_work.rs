//! Internal continuous-work dispatch valve.

use serde::{Deserialize, Serialize};

/// Host-owned switch for automatic continuous-work dispatch.
///
/// A model cannot write it: no tool or RPC surface exposes this group, and only
/// the target host's own configuration path (settings file, deployment default,
/// or operator command) sets the value.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContinuousWorkSettings {
    /// When false, automatic continuation, background follow-up and source
    /// dispatch are blocked. Ordinary sessions, reads, reconciliation, pause and
    /// stop remain available, and already dispatched work still settles by its
    /// original receipt.
    #[serde(default = "default_continuous_work_dispatch_enabled")]
    pub dispatch_enabled: bool,
}

pub(crate) const fn default_continuous_work_dispatch_enabled() -> bool {
    true
}

impl Default for ContinuousWorkSettings {
    fn default() -> Self {
        Self {
            dispatch_enabled: default_continuous_work_dispatch_enabled(),
        }
    }
}

impl ContinuousWorkSettings {
    pub fn dispatch_enabled(&self) -> bool {
        self.dispatch_enabled
    }
}

#[cfg(test)]
#[path = "continuous_work.test.rs"]
mod tests;

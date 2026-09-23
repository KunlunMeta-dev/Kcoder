use serde::{Deserialize, Serialize};

/// A durable execution identity; wall-clock timestamps are not identifiers.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundRunKey {
    pub parent_session_id: String,
    pub agent_id: String,
    pub run_id: String,
}

/// Logical identity survives transport reconnection and event replay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundEventIdentity {
    pub run: BackgroundRunKey,
    pub event_id: String,
    pub run_sequence: u64,
}

impl BackgroundEventIdentity {
    pub fn terminal(run: BackgroundRunKey) -> Self {
        Self {
            event_id: format!("{}:terminal", run.run_id),
            run,
            run_sequence: 9_007_199_254_740_991,
        }
    }
}

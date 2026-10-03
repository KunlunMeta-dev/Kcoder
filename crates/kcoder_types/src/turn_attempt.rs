use serde::{Deserialize, Serialize};

/// One execution attempt of a logical turn. Shared by recovery and model snapshots.
/// The server chooses attempt_id; credentials are never part of this identity.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnAttemptIdentity {
    pub thread_id: String,
    pub turn_id: String,
    pub attempt_id: String,
}
impl TurnAttemptIdentity {
    pub fn validate(&self) -> Result<(), &'static str> {
        if [&self.thread_id, &self.turn_id, &self.attempt_id]
            .into_iter()
            .any(|value| value.trim().is_empty() || value.len() > 256)
        {
            return Err("attempt identity components must contain 1..=256 bytes");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnAttemptStatus {
    Accepted,
    Completed,
    Failed,
    Interrupted,
}

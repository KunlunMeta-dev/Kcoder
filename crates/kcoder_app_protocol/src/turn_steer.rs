//! Main-thread steering: user input added to the running turn of a thread.
//!
//! A steer enters history only after the current provider response and its
//! complete tool batch, so it never splits a tool call from its result. A
//! steer that reached no turn is reported back so the client can fall back to
//! its own queue instead of losing the text.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_TURN_STEER_V1: &str = "turnSteerV1";

/// Maximum accepted steer text, in bytes.
pub const TURN_STEER_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerParams {
    pub thread_id: String,
    /// When set, the steer is accepted only by this running turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
}

impl TurnSteerParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.text.trim().is_empty() {
            return Err("steer text must not be empty");
        }
        if self.text.len() > TURN_STEER_MAX_BYTES {
            return Err("steer text exceeds 65536 bytes");
        }
        if self
            .client_message_id
            .as_ref()
            .is_some_and(|id| id.trim().is_empty() || id.len() > 1024)
        {
            return Err("clientMessageId must contain 1..=1024 bytes");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnSteerStatus {
    /// Accepted by the running turn; `turn/steer/applied` follows once it is
    /// in history, or `turn/steer/dropped` if the turn ends first.
    Queued,
    /// No matching turn is running. Nothing was recorded; start a turn instead.
    NoActiveTurn,
    /// The running turn could not take input right now. Nothing was recorded.
    Busy,
    /// The running turn already holds the maximum number of pending steers.
    QueueFull,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerResult {
    pub status: TurnSteerStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    /// Server identity of a queued steer, repeated in its later notification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steer_id: Option<u64>,
}

/// Params of `turn/steer/applied` and `turn/steer/dropped`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerSettledParams {
    pub thread_id: String,
    pub turn_id: String,
    pub steer_id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
    /// Present on `turn/steer/dropped` so the client can resend the text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steer_params_reject_empty_or_oversized_text() {
        let mut params = TurnSteerParams {
            thread_id: "t".into(),
            turn_id: None,
            text: "  ".into(),
            client_message_id: None,
        };
        assert!(params.validate().is_err());
        params.text = "x".repeat(TURN_STEER_MAX_BYTES + 1);
        assert!(params.validate().is_err());
        params.text = "use the staging database".into();
        assert!(params.validate().is_ok());
        params.client_message_id = Some(String::new());
        assert!(params.validate().is_err());
    }

    #[test]
    fn steer_wire_names_are_stable() {
        let value = serde_json::to_value(TurnSteerResult {
            status: TurnSteerStatus::NoActiveTurn,
            turn_id: None,
            steer_id: None,
        })
        .unwrap();
        assert_eq!(value, serde_json::json!({"status": "no_active_turn"}));
        let params: TurnSteerParams = serde_json::from_value(serde_json::json!({
            "threadId": "t", "text": "hi", "clientMessageId": "c1"
        }))
        .unwrap();
        assert_eq!(params.client_message_id.as_deref(), Some("c1"));
    }
}

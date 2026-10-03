//! Read-only evidence for submissions whose transport response was lost.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_TURN_RECEIPTS_V1: &str = "turnReceiptsV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnReceiptReadParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_operation_id: Option<String>,
}
impl TurnReceiptReadParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        let identity = match (&self.client_message_id, &self.retry_operation_id) {
            (Some(value), None) | (None, Some(value)) => value,
            _ => return Err("exactly one submission or retry identity is required"),
        };
        if identity.trim().is_empty() || identity.len() > 1024 {
            return Err("operation identity must contain 1..=1024 bytes");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnReceiptStatus {
    Running,
    Completed,
    Failed,
    Interrupted,
    /// Acceptance exists, but the terminal state is not verifiable. Never re-execute automatically.
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnAcceptanceReceipt {
    pub thread_id: String,
    pub turn_id: String,
    pub status: TurnReceiptStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnReceiptReadResult {
    /// Null means no receipt was observed, not permission to replay a side effect.
    pub receipt: Option<TurnAcceptanceReceipt>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn receipt_query_requires_exactly_one_bounded_identity() {
        for (client, retry, valid) in [
            (None, None, false),
            (Some("a"), Some("b"), false),
            (Some("a"), None, true),
            (None, Some("b"), true),
            (Some(" "), None, false),
        ] {
            let params = TurnReceiptReadParams {
                thread_id: "thread".into(),
                client_message_id: client.map(str::to_owned),
                retry_operation_id: retry.map(str::to_owned),
            };
            assert_eq!(params.validate().is_ok(), valid);
        }
        let params = TurnReceiptReadParams {
            thread_id: "thread".into(),
            client_message_id: Some("x".repeat(1025)),
            retry_operation_id: None,
        };
        assert!(params.validate().is_err());
    }
}

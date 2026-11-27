//! Read-only status lookup for one exact approval or question request.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum InteractionStatusKindV1 {
    Approval,
    Question,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum InteractionStatusV1 {
    Pending,
    Resolved,
    Unknown,
}

/// Identifies one request without carrying its text, answers, or decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionStatusReadParamsV1 {
    pub server_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub request_id: u64,
    pub app_server_epoch: String,
    pub kind: InteractionStatusKindV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
}

impl InteractionStatusReadParamsV1 {
    pub fn validate(&self) -> Result<(), &'static str> {
        for value in [
            &self.server_id,
            &self.thread_id,
            &self.turn_id,
            &self.app_server_epoch,
        ] {
            if value.trim().is_empty() || value.len() > 1024 {
                return Err("interaction identity fields must contain 1..=1024 bytes");
            }
        }
        let interaction_id = match (self.kind, &self.approval_id, &self.question_id) {
            (InteractionStatusKindV1::Approval, Some(id), None)
            | (InteractionStatusKindV1::Question, None, Some(id)) => id,
            _ => return Err("interaction kind must match exactly one interaction id"),
        };
        if interaction_id.trim().is_empty() || interaction_id.len() > 1024 {
            return Err("interaction id must contain 1..=1024 bytes");
        }
        if self.request_id == 0 {
            return Err("request id must be nonzero");
        }
        Ok(())
    }
}

/// Echoes the exact selector so callers can reject a mismatched response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionStatusReadResultV1 {
    pub server_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub request_id: u64,
    pub app_server_epoch: String,
    pub kind: InteractionStatusKindV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
    pub status: InteractionStatusV1,
}

impl From<(&InteractionStatusReadParamsV1, InteractionStatusV1)> for InteractionStatusReadResultV1 {
    fn from((params, status): (&InteractionStatusReadParamsV1, InteractionStatusV1)) -> Self {
        Self {
            server_id: params.server_id.clone(),
            thread_id: params.thread_id.clone(),
            turn_id: params.turn_id.clone(),
            request_id: params.request_id,
            app_server_epoch: params.app_server_epoch.clone(),
            kind: params.kind,
            approval_id: params.approval_id.clone(),
            question_id: params.question_id.clone(),
            status,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn approval() -> InteractionStatusReadParamsV1 {
        InteractionStatusReadParamsV1 {
            server_id: "server-1".into(),
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
            request_id: 2_000_001,
            app_server_epoch: "epoch-1".into(),
            kind: InteractionStatusKindV1::Approval,
            approval_id: Some("approval-2000001".into()),
            question_id: None,
        }
    }

    #[test]
    fn status_read_requires_an_exact_bounded_selector_and_echoes_it() {
        let params = approval();
        assert!(params.validate().is_ok());
        let decoded: InteractionStatusReadParamsV1 =
            serde_json::from_value(serde_json::to_value(&params).unwrap()).unwrap();
        assert_eq!(decoded, params);
        let result = InteractionStatusReadResultV1::from((&params, InteractionStatusV1::Pending));
        let encoded = serde_json::to_value(&result).unwrap();
        assert_eq!(encoded["status"], "pending");
        assert_eq!(encoded["appServerEpoch"], "epoch-1");
        assert!(encoded.get("answer").is_none());
        assert!(encoded.get("request").is_none());
    }

    #[test]
    fn status_read_rejects_ambiguous_or_unbounded_selectors() {
        let mut params = approval();
        params.question_id = Some("question-2".into());
        assert!(params.validate().is_err());
        params.question_id = None;
        params.approval_id = None;
        assert!(params.validate().is_err());
        params = approval();
        params.app_server_epoch = " ".into();
        assert!(params.validate().is_err());
        params = approval();
        params.request_id = 0;
        assert!(params.validate().is_err());
        assert!(
            serde_json::from_value::<InteractionStatusReadParamsV1>(json!({
                "serverId":"server-1", "threadId":"thread-1", "turnId":"turn-1",
                "requestId":2000001, "appServerEpoch":"epoch-1", "kind":"approval",
                "approvalId":"approval-2000001", "answer":"secret"
            }))
            .is_err()
        );
    }
}

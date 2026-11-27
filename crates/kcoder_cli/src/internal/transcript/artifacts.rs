use kcoder_app_protocol::{ApprovalAction, ApprovalDecision};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnOutcomeArtifact {
    pub version: u8,
    pub thread_id: String,
    pub turn_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_failure: Option<kcoder_types::ProviderFailureDetails>,
    pub completed_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation_context_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalDecisionArtifact {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub version: u8,
    pub artifact_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub approval_id: String,
    pub action: ApprovalAction,
    pub reason: String,
    pub decision: ApprovalDecision,
    pub resolution_reason: String,
    pub requested_at_ms: u64,
    pub resolved_at_ms: u64,
}

//! Optional exact native run selectors. They do not grant permission or create a run.
use kcoder_types::BackgroundRunKey;
use serde::{Deserialize, Serialize};
pub const CAPABILITY_AGENT_EXACT_RUN_V1: &str = "agentExactRunV1";
pub const CAPABILITY_AGENT_EXACT_CONTROL_V1: &str = "agentExactControlV1";
pub const CAPABILITY_AGENT_EXACT_CONTINUATION_V1: &str = "agentExactContinuationV1";
pub const AGENT_STREAM_CLOSED: &str = "agent/stream/closed";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum AgentStreamCloseReason {
    RunChanged,
    OwnerUnavailable,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentStreamClosedParams {
    pub thread_id: String,
    pub agent_id: String,
    pub subscription_id: String,
    pub expected_background_run: BackgroundRunKey,
    pub reason_code: AgentStreamCloseReason,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_observer_retains_original_run_and_strict_known_reason() {
        let value = serde_json::json!({"threadId":"parent","agentId":"child","subscriptionId":"original-observer","expectedBackgroundRun":{"parentSessionId":"parent","agentId":"child","runId":"run-1"},"reasonCode":"run_changed"});
        let parsed: AgentStreamClosedParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        let mut unknown = value;
        unknown["reasonCode"] = serde_json::json!("completed");
        assert!(serde_json::from_value::<AgentStreamClosedParams>(unknown).is_err());
    }
    #[test]
    fn omitted_constraints_preserve_legacy_request_and_result_shapes() {
        let old =
            serde_json::json!({"threadId":"parent","agentId":"child","subscriptionId":"observer"});
        let request: crate::AgentStreamSubscribeParams =
            serde_json::from_value(old.clone()).unwrap();
        assert!(request.expected_background_run.is_none());
        assert_eq!(serde_json::to_value(request).unwrap(), old);
        let read: crate::AgentLiveReadParams =
            serde_json::from_value(serde_json::json!({"threadId":"parent","agentId":"child"}))
                .unwrap();
        assert!(read.expected_background_run.is_none());
        let artifact: crate::AgentArtifactReadParams =
            serde_json::from_value(serde_json::json!({"threadId":"parent","agentId":"child"}))
                .unwrap();
        assert!(artifact.expected_background_run.is_none());
    }
}

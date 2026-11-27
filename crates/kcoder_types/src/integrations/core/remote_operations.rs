//! Native remote-operation control projections. References never grant task or resource authority.
use super::{IntegrationOperationPhase, IntegrationScope, IntegrationValidationError, id, invalid};
use crate::TurnAttemptIdentity;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteOperationControlParams {
    pub request_id: String,
    pub scope: IntegrationScope,
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}
impl RemoteOperationControlParams {
    pub fn validate(&self, cancellation: bool) -> Result<(), IntegrationValidationError> {
        self.scope.validate()?;
        id(&self.request_id, "requestId")?;
        id(&self.operation_id, "operationId")?;
        if self.request_id.chars().any(char::is_control)
            || self.operation_id.chars().any(char::is_control)
        {
            return Err(invalid(
                "operationId",
                "control characters are not identifiers",
            ));
        }
        if cancellation && self.expected_revision.is_none_or(|revision| revision == 0) {
            return Err(invalid(
                "expectedRevision",
                "cancellation requires the observed original operation revision",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteOperationListParams {
    pub request_id: String,
    pub scope: IntegrationScope,
}
impl RemoteOperationListParams {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        self.scope.validate()?;
        id(&self.request_id, "requestId")?;
        if self.request_id.chars().any(char::is_control) {
            return Err(invalid(
                "requestId",
                "control characters are not identifiers",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteOperationSummary {
    pub operation_id: String,
    pub journal_revision: u64,
    pub receiver_observed: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteOperationListReply {
    pub request_id: String,
    pub scope: IntegrationScope,
    pub items: Vec<RemoteOperationSummary>,
    pub total: u32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum RemoteOperationReceiverStatus {
    NotObserved,
    Accepted,
    Completed,
    Failed,
    Interrupted,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum RemoteOperationCleanupStatus {
    NotObserved,
    Unconfirmed,
    Confirmed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum RemoteOperationProtocolStatus {
    Dispatched,
    Received,
    Unknown,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteOperationProtocolStage {
    pub stage: String,
    pub status: RemoteOperationProtocolStatus,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteOperationReceiver {
    pub status: RemoteOperationReceiverStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<TurnAttemptIdentity>,
    pub terminal_confirmed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteOperationArtifact {
    pub id: String,
    pub revision: u64,
    pub sha256: String,
    pub bytes: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteOperationSnapshot {
    pub operation_id: String,
    pub operation_revision: u64,
    pub operation_phase: IntegrationOperationPhase,
    pub journal_revision: u64,
    pub receiver: RemoteOperationReceiver,
    pub cleanup: RemoteOperationCleanupStatus,
    pub protocol: Vec<RemoteOperationProtocolStage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<RemoteOperationArtifact>,
    pub business_completed: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum RemoteOperationControlOutcome {
    Observed,
    CancellationRequested,
    AlreadyTerminal,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteOperationControlReply {
    pub request_id: String,
    pub scope: IntegrationScope,
    pub operation_id: String,
    pub outcome: RemoteOperationControlOutcome,
    pub snapshot: Option<RemoteOperationSnapshot>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_shape_cannot_supply_execution_flags_or_skip_original_cancel_revision() {
        let value = serde_json::json!({"requestId":"actual-read","scope":{"accountId":"account","targetId":"target","workspaceId":"workspace","identityGeneration":"generation","targetRevision":"config"},"operationId":"original"});
        let read: RemoteOperationControlParams = serde_json::from_value(value.clone()).unwrap();
        read.validate(false).unwrap();
        assert!(read.validate(true).is_err());
        let mut cancel = value.clone();
        cancel["expectedRevision"] = serde_json::json!(2);
        serde_json::from_value::<RemoteOperationControlParams>(cancel)
            .unwrap()
            .validate(true)
            .unwrap();
        for field in ["command", "approved", "actor", "environment", "peerId"] {
            let mut wrong = value.clone();
            wrong[field] = serde_json::json!(true);
            assert!(serde_json::from_value::<RemoteOperationControlParams>(wrong).is_err());
        }
    }
}

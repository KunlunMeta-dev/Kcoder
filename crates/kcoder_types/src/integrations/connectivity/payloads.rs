//! Method payloads keep platform addresses and credentials outside public ports.
use super::{ChannelDeliveryState, ReadinessObservation};
use crate::integrations::core::{IntegrationEntityKind, IntegrationEntityRef, IntegrationNullable};
use serde::{Deserialize, Serialize};

/// A revisioned reference is a locator; the current private grant still authorizes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityDestinationRef {
    pub id: String,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityDeliveryContent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default)]
    pub artifact_refs: Vec<IntegrationEntityRef>,
}

impl ConnectivityDeliveryContent {
    pub fn is_valid(&self) -> bool {
        let text_present = self
            .text
            .as_ref()
            .is_some_and(|text| !text.trim().is_empty());
        (text_present || !self.artifact_refs.is_empty())
            && self.text.as_ref().is_none_or(|text| text.len() <= 131_072)
            && self.artifact_refs.len() <= 20
            && self.artifact_refs.iter().all(|reference| {
                reference.kind == IntegrationEntityKind::Artifact
                    && !reference.id.is_empty()
                    && reference
                        .revision
                        .as_ref()
                        .is_some_and(|value| !value.is_empty())
            })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityDeliverySubmit {
    pub delivery_id: String,
    pub destination_ref: ConnectivityDestinationRef,
    pub content: ConnectivityDeliveryContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription_ref: Option<ConnectivityDestinationRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityDeliveryAccepted {
    pub delivery_id: String,
    pub delivery_state: ChannelDeliveryState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityDeliveryLookup {
    pub delivery_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ConnectivityCapabilityState {
    Ready,
    Denied,
    Unavailable,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityToolRef {
    pub name: String,
    pub schema_revision: String,
    pub source_revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityCapabilityReadiness {
    pub capability_id: String,
    pub state: ConnectivityCapabilityState,
    pub reason_code: String,
    pub tool_refs: Vec<ConnectivityToolRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityReadinessRequest {
    #[serde(default)]
    pub capability_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub resource_refs: Vec<IntegrationEntityRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityReadinessReport {
    pub id: String,
    pub revision: String,
    pub connection_id: Option<String>,
    pub connection_revision: Option<String>,
    pub target_revision: String,
    pub identity_generation: String,
    pub request_revision: Option<String>,
    pub observed_at: String,
    pub observations: Vec<ReadinessObservation>,
    pub capabilities: Vec<ConnectivityCapabilityReadiness>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ConnectivityProbeState {
    Verified,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityProbeRequest {
    pub capability_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    pub resource_refs: Vec<IntegrationEntityRef>,
    pub tool_ref: ConnectivityToolRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityProbeEvidence {
    pub verifier_id: String,
    pub verifier_version: String,
    pub tool_ref: ConnectivityToolRef,
    pub resource_refs: Vec<IntegrationEntityRef>,
    pub identity_generation: String,
    pub target_revision: String,
    pub policy_revision: String,
    pub request_revision: String,
    pub input_sha256: String,
    pub result_sha256: String,
    pub observed_at_ms: u64,
    pub check_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityProbeReport {
    pub capability_id: String,
    pub state: ConnectivityProbeState,
    pub business_validated: bool,
    pub evidence: IntegrationNullable<ConnectivityProbeEvidence>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_ref_is_not_an_arbitrary_platform_destination() {
        assert!(
            serde_json::from_value::<ConnectivityDeliverySubmit>(serde_json::json!({
                "deliveryId": "delivery", "destination": {"conversationId":"other"},
                "content": {"text":"hello"}
            }))
            .is_err()
        );
    }

    #[test]
    fn delivery_content_requires_nonempty_text_or_revisioned_artifacts() {
        let mut content = ConnectivityDeliveryContent {
            text: Some(" ".into()),
            artifact_refs: vec![],
        };
        assert!(!content.is_valid());
        content.artifact_refs.push(IntegrationEntityRef {
            kind: IntegrationEntityKind::Artifact,
            id: "artifact".into(),
            revision: Some("1".into()),
        });
        assert!(content.is_valid());
        content.artifact_refs[0].kind = IntegrationEntityKind::Thread;
        assert!(!content.is_valid());
    }

    #[test]
    fn completed_port_operation_cannot_be_deserialized_as_capability_state() {
        assert!(
            serde_json::from_value::<ConnectivityCapabilityState>(serde_json::json!("completed"))
                .is_err()
        );
    }
}

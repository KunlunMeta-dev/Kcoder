//! Reviewed method classification. This is a contract allowlist, not authorization.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum IntegrationPort {
    #[serde(rename = "P-RUNTIME")]
    Runtime,
    #[serde(rename = "P-POLICY")]
    Policy,
    #[serde(rename = "P-MODEL")]
    Model,
    #[serde(rename = "P-ASSET")]
    Asset,
    #[serde(rename = "P-CONNECTION")]
    Connection,
    #[serde(rename = "P-READINESS")]
    Readiness,
    #[serde(rename = "P-DELIVERY")]
    Delivery,
    #[serde(rename = "P-KNOWLEDGE")]
    Knowledge,
    #[serde(rename = "P-MEMORY")]
    Memory,
    #[serde(rename = "P-AUTOMATION")]
    Automation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IntegrationMethod<'a> {
    pub name: &'a str,
    pub operation_identity_required: bool,
}

impl IntegrationPort {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Runtime => "P-RUNTIME",
            Self::Policy => "P-POLICY",
            Self::Model => "P-MODEL",
            Self::Asset => "P-ASSET",
            Self::Connection => "P-CONNECTION",
            Self::Readiness => "P-READINESS",
            Self::Delivery => "P-DELIVERY",
            Self::Knowledge => "P-KNOWLEDGE",
            Self::Memory => "P-MEMORY",
            Self::Automation => "P-AUTOMATION",
        }
    }

    pub fn method(self, name: &str) -> Option<IntegrationMethod<'_>> {
        let mutation = match (self, name) {
            (Self::Runtime, "acceptTask" | "steerTask" | "cancelTask" | "respondInteraction")
            | (Self::Policy, "prepareDelegation" | "revokeDelegation")
            | (Self::Model, "recordAttempt")
            | (Self::Asset, "prepareInput" | "publishManifest" | "prepareExport")
            | (Self::Connection, "prepareConnectionAction")
            | (Self::Readiness, "verifyCapability")
            | (Self::Delivery, "submitDelivery" | "cancelDelivery" | "reconcileDelivery")
            | (Self::Knowledge, "publishKnowledge" | "revokePublication")
            | (Self::Memory, "proposeMemory" | "reviewMemory" | "setMemoryEnabled")
            | (
                Self::Automation,
                "saveSubscription" | "setSubscriptionEnabled" | "triggerApprovedSubscription",
            ) => true,
            (Self::Runtime, "readOperation" | "readTask")
            | (Self::Policy, "inspectScope" | "evaluateAction" | "readDelegation")
            | (Self::Model, "resolveSelection" | "inspectModel" | "readHealth")
            | (Self::Asset, "readInputReceipt" | "readManifest" | "readDatasetPage")
            | (
                Self::Connection,
                "listConnections" | "readConnection" | "resolveCapability" | "readResourceGrant",
            )
            | (Self::Readiness, "inspectReadiness" | "readReadiness")
            | (Self::Delivery, "readDelivery")
            | (Self::Knowledge, "resolvePublication" | "retrieveKnowledge" | "readCitation")
            | (Self::Memory, "listMemories" | "readMemory")
            | (Self::Automation, "previewSubscription" | "readAutomationRun") => false,
            _ => return None,
        };
        Some(IntegrationMethod {
            name,
            operation_identity_required: mutation,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_names_and_unreviewed_methods_cannot_change_classification() {
        assert!(IntegrationPort::Model.method("infer").is_none());
        assert!(IntegrationPort::Runtime.method("readtask").is_none());
        assert!(IntegrationPort::Policy.method("acceptTask").is_none());
        assert!(
            !IntegrationPort::Runtime
                .method("readTask")
                .unwrap()
                .operation_identity_required
        );
        assert!(
            IntegrationPort::Asset
                .method("publishManifest")
                .unwrap()
                .operation_identity_required
        );
        assert_eq!(
            serde_json::to_string(&IntegrationPort::Asset).unwrap(),
            "\"P-ASSET\""
        );
    }
}

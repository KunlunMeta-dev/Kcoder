//! Private owned-SDK observations. These contracts confer no task or delivery authority.
use kcoder_types::integrations::core::{IntegrationRevisionRef, IntegrationScope};
use serde::{Deserialize, Serialize};

pub const CAPABILITY_SDK_ORIGINAL_MESSAGE_READBACK_V1: &str = "originalMessageReadbackV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SdkOriginalMessageReadbackRequest {
    pub source_message_id: String,
}

/// Optional negotiation keeps older owned workers usable without inventing support.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SdkWorkerReadyObservation {
    pub worker_id: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SdkOriginalMessageObservation {
    pub source_message_id: String,
    pub conversation_id: String,
    pub tenant_id: String,
    pub sender_id: String,
    pub bot_id: String,
    pub text: String,
    pub topic_id: Option<String>,
}

/// Private Native recovery locators. No sender, credential, grant or endpoint is accepted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceMemberOriginalIngressRequest {
    pub scope: IntegrationScope,
    pub connection_id: String,
    pub binding_ref: IntegrationRevisionRef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceMemberOriginalIngressObservation {
    pub ingress_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceMemberReadbackConfirmation {
    pub scope: IntegrationScope,
    pub connection_id: String,
    pub binding_ref: IntegrationRevisionRef,
    pub ingress_id: String,
    pub worker_id: String,
}

/// Private metadata selection. An absent ingress selects a bounded original
/// platform observation; no task state, claimed identity or permission is input.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceMemberIdentityReadbackRequest {
    pub scope: IntegrationScope,
    pub connection_id: String,
    pub binding_ref: IntegrationRevisionRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ingress_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceMemberIdentityReadbackEvidence {
    pub native_namespace_id: String,
    pub connection_ref: IntegrationRevisionRef,
    pub binding_ref: IntegrationRevisionRef,
    pub observed_subject_ref: IntegrationRevisionRef,
    pub source_revision: String,
    pub ingress_id: Option<String>,
    pub original: Option<SdkOriginalMessageObservation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceConnectionMemberObservations {
    pub native_namespace_id: String,
    pub connection_ref: IntegrationRevisionRef,
    pub members: Vec<IntegrationRevisionRef>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identity_readback_has_no_model_or_caller_supplied_identity_authority() {
        let base = json!({"scope":{"accountId":"a","targetId":"t","workspaceId":null,"identityGeneration":"1","targetRevision":"1"},
            "connectionId":"connection","bindingRef":{"id":"member","revision":"2"}});
        let parsed: ServiceMemberIdentityReadbackRequest =
            serde_json::from_value(base.clone()).unwrap();
        assert!(parsed.ingress_id.is_none());
        for key in [
            "text",
            "senderId",
            "tenantId",
            "taskId",
            "threadId",
            "model",
            "allowed",
            "url",
            "expiresAtMs",
        ] {
            let mut bad = base.clone();
            bad[key] = json!("caller-value");
            assert!(serde_json::from_value::<ServiceMemberIdentityReadbackRequest>(bad).is_err());
        }
    }

    #[test]
    fn old_sdk_ready_does_not_claim_readback_support() {
        let ready: SdkWorkerReadyObservation =
            serde_json::from_value(json!({"workerId":"old-worker"})).unwrap();
        assert!(ready.capabilities.is_empty());
        let current: SdkWorkerReadyObservation = serde_json::from_value(json!({
            "workerId":"current-worker", "capabilities":[CAPABILITY_SDK_ORIGINAL_MESSAGE_READBACK_V1]
        })).unwrap();
        assert_eq!(
            current.capabilities,
            [CAPABILITY_SDK_ORIGINAL_MESSAGE_READBACK_V1]
        );
    }

    #[test]
    fn member_readback_control_rejects_caller_supplied_identity_or_authority() {
        let request = json!({"scope":{"accountId":"a","targetId":"t","workspaceId":null,"identityGeneration":"1","targetRevision":"1"},
            "connectionId":"connection","bindingRef":{"id":"member","revision":"2"},"ingressId":"original-ingress","workerId":"current-worker"});
        assert!(
            serde_json::from_value::<ServiceMemberReadbackConfirmation>(request.clone()).is_ok()
        );
        for field in [
            "allowed",
            "readOnly",
            "senderId",
            "sourceRevision",
            "message",
            "url",
            "expiresAtMs",
        ] {
            let mut invalid = request.clone();
            invalid[field] = json!(true);
            assert!(serde_json::from_value::<ServiceMemberReadbackConfirmation>(invalid).is_err());
        }
    }

    #[test]
    fn readback_caller_cannot_supply_identity_endpoint_or_authority() {
        for key in [
            "senderId",
            "tenantId",
            "conversationId",
            "url",
            "allowed",
            "text",
        ] {
            let mut value = json!({"sourceMessageId":"original-message"});
            value[key] = json!("caller-value");
            assert!(serde_json::from_value::<SdkOriginalMessageReadbackRequest>(value).is_err());
        }
    }
}

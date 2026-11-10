use kcoder_types::integrations::core::{IntegrationPort, IntegrationReply, IntegrationRequest};
/// The native composition root resolves actual drivers and rechecks authority on every call.
#[async_trait::async_trait]
pub trait KnowledgeDependencyPort: Send + Sync {
    /// Registration metadata avoids preparing work when no driver exists. This is not permission.
    fn registered(&self, port: IntegrationPort, method: &str) -> bool;
    async fn call_authorized_delivery(
        &self,
        proof: std::sync::Arc<super::NativeAutomationDeliveryUse>,
    ) -> IntegrationReply {
        unavailable_delivery(proof.request())
    }
    async fn call(
        &self,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
    ) -> IntegrationReply;
}

/// A stale or mismatched transport receipt cannot settle the original side effect.
pub(super) fn validate_dependency_reply(
    request: &IntegrationRequest,
    reply: &IntegrationReply,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        reply.contract_version == request.contract_version
            && reply.request_id == request.request_id
            && request
                .operation_id
                .as_ref()
                .is_none_or(|operation| reply.operation_id.as_ref() == Some(operation)),
        "AUTOMATION_DEPENDENCY_UNCONFIRMED"
    );
    Ok(())
}

pub(super) fn unavailable_delivery(request: &IntegrationRequest) -> IntegrationReply {
    use kcoder_types::integrations::core::*;
    IntegrationReply {
        contract_version: request.contract_version,
        request_id: request.request_id.clone(),
        operation_id: request
            .operation_id
            .clone()
            .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
        entity_revision: IntegrationNullable::Null,
        observed_at: chrono::Utc::now().to_rfc3339(),
        status: IntegrationStatus::Unavailable,
        result: IntegrationNullable::Null,
        error: IntegrationNullable::Value(IntegrationError {
            code: "AUTOMATION_NATIVE_DELIVERY_UNAVAILABLE".into(),
            recovery: IntegrationRecovery::ReconcileOriginal,
            message_key: "knowledgeIntegration.operationFailed".into(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::integrations::core::*;
    #[test]
    fn stale_request_or_wrong_original_operation_never_confirms_a_dependency_effect() {
        let request: IntegrationRequest =
            serde_json::from_value(serde_json::json!({"contractVersion":"parallel-v1",
            "requestId":"native-call","operationId":"original-write","scope":{"accountId":"owner",
            "targetId":"target","workspaceId":null,"identityGeneration":"1","targetRevision":"1"},
            "timeoutMs":1000,"payload":{}}))
            .unwrap();
        let mut reply = IntegrationReply {
            contract_version: request.contract_version,
            request_id: request.request_id.clone(),
            operation_id: IntegrationNullable::Value("original-write".into()),
            status: IntegrationStatus::Accepted,
            entity_revision: IntegrationNullable::Null,
            observed_at: "2026-10-24T00:00:00Z".into(),
            result: IntegrationNullable::Null,
            error: IntegrationNullable::Null,
        };
        assert!(validate_dependency_reply(&request, &reply).is_ok());
        reply.request_id = "stale-call".into();
        assert!(validate_dependency_reply(&request, &reply).is_err());
        reply.request_id = request.request_id.clone();
        reply.operation_id = IntegrationNullable::Value("another-write".into());
        assert!(validate_dependency_reply(&request, &reply).is_err());
        reply.operation_id = IntegrationNullable::Null;
        assert!(validate_dependency_reply(&request, &reply).is_err());
    }
}

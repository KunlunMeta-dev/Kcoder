use super::*;
use crate::app_server::integrations::office::native_host::NativeOfficePorts;
use async_trait::async_trait;

/// Only the Model leaf is supplied here. Other capabilities retain their original provider.
pub(crate) struct NativeOfficeModelPorts {
    resolver: Arc<NativeModelPolicyResolver>,
    next: Option<Arc<dyn NativeOfficePorts>>,
}
impl NativeOfficeModelPorts {
    pub(crate) fn capture(
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        next: Option<Arc<dyn NativeOfficePorts>>,
    ) -> Result<Self> {
        Ok(Self {
            resolver: Arc::new(NativeModelPolicyResolver::capture(native, engine)?),
            next,
        })
    }
}
#[async_trait]
#[kcoder_async_box::shared]
impl NativeOfficePorts for NativeOfficeModelPorts {
    async fn call(
        &self,
        native: &NativeIntegrationContext,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<IntegrationReply> {
        native.validate_scope(&request.scope)?;
        self.resolver.validate(native.scope())?;
        if port != IntegrationPort::Model || method != "resolveSelection" {
            return self
                .next
                .as_ref()
                .context("MODEL_OTHER_PORT_PROVIDER_UNAVAILABLE")?
                .call(native, port, method, request, cancel)
                .await;
        }
        let model = self
            .resolver
            .clone()
            .resolve_owned(request.clone(), cancel)
            .await?;
        let result = serde_json::to_value(model)?
            .as_object()
            .context("MODEL_POLICY_INVALID_RESULT")?
            .clone();
        Ok(IntegrationReply {
            contract_version: request.contract_version,
            request_id: request.request_id.clone(),
            operation_id: request
                .operation_id
                .clone()
                .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
            entity_revision: IntegrationNullable::Null,
            status: IntegrationStatus::Completed,
            observed_at: chrono::Utc::now().to_rfc3339(),
            result: IntegrationNullable::Value(result),
            error: IntegrationNullable::Null,
        })
    }
}

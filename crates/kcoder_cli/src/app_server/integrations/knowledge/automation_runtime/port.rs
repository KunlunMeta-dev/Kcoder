//! Actual connection-owned Runtime consumer for the existing automation host.
use super::*;
use crate::app_server::integrations::core::runtime_pump::NativeRuntimeClient;
use crate::app_server::integrations::knowledge::{KnowledgeDependencyPort, NativeKnowledgeRpc};
use std::sync::Weak;
use tokio::sync::Mutex as AsyncMutex;

pub(crate) struct NativeAutomationRuntimePort {
    native: NativeIntegrationContext,
    engine: QueryEngine,
    cache: Weak<AsyncMutex<NativeKnowledgeRpc>>,
    runtime: NativeRuntimeClient,
    presentation: Option<ClientPresentationV1>,
    office: Option<AutomationOfficeFactory>,
}
impl NativeAutomationRuntimePort {
    pub(crate) fn capture(
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        cache: Weak<AsyncMutex<NativeKnowledgeRpc>>,
        runtime: NativeRuntimeClient,
        presentation: Option<ClientPresentationV1>,
    ) -> Result<Self> {
        super::super::rpc::configuration::EngineSnapshot::capture(engine)?
            .verify_binding(engine, native)?;
        Ok(Self {
            native: native.recapture_for_owned_service()?,
            engine: engine.clone(),
            cache,
            runtime,
            presentation,
            office: None,
        })
    }
    pub(crate) fn with_office(mut self, office: Option<AutomationOfficeFactory>) -> Self {
        self.office = office;
        self
    }
    async fn dispatch(
        &self,
        method: &str,
        request: &IntegrationRequest,
    ) -> Result<IntegrationReply> {
        request.validate_method(IntegrationPort::Runtime, method)?;
        let mut native = self.native.recapture_for_owned_service()?;
        native.refresh_configuration_revision(
            self.engine.active_model_configuration_summary()?.revision,
        )?;
        native.validate_scope(&request.scope)?;
        let native = Arc::new(native);
        match method {
            "acceptTask" => {
                let cache = self
                    .cache
                    .upgrade()
                    .context("AUTOMATION_NATIVE_OWNER_UNAVAILABLE")?;
                let host = { cache.lock().await.host_for_engine(&native, &self.engine)? };
                #[cfg(test)]
                eprintln!("native D runtime Office binding: {}", self.office.is_some());
                let prepared = prepare_native_automation_with_office(
                    &native,
                    &self.engine,
                    host,
                    request,
                    self.presentation.clone(),
                    &CancellationToken::new(),
                    self.office.as_ref(),
                )
                .inspect_err(|_error| {
                    #[cfg(test)]
                    eprintln!(
                        "native automation preparation rejected: {}",
                        super::native_admission_code(_error)
                    );
                })
                .context("AUTOMATION_NATIVE_REJECTED_BEFORE_QUEUE")?;
                self.runtime
                    .accept(native, request.clone(), prepared.task, prepared.authority)
                    .await
            }
            "readOperation" => self.runtime.read_operation(native, request.clone()).await,
            "readTask" => {
                let reply = self
                    .runtime
                    .read_task(native.clone(), request.clone())
                    .await?;
                if let Some(office) = &self.office
                    && office.collect(&native, request)?
                {
                    return self.runtime.read_task(native, request.clone()).await;
                }
                Ok(reply)
            }
            // The calling Automation cancel path has already checked the real
            // current owner policy. Cleanup never requires enabled=true again.
            "cancelTask" => self.runtime.cancel_task(native, request.clone()).await,
            _ => anyhow::bail!("AUTOMATION_NATIVE_METHOD_UNAVAILABLE"),
        }
    }
}
#[async_trait::async_trait]
#[kcoder_async_box::shared]
impl KnowledgeDependencyPort for NativeAutomationRuntimePort {
    fn registered(&self, port: IntegrationPort, method: &str) -> bool {
        port == IntegrationPort::Runtime
            && matches!(
                method,
                "acceptTask" | "readOperation" | "readTask" | "cancelTask"
            )
    }
    async fn call(
        &self,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
    ) -> IntegrationReply {
        let outcome = if self.registered(port, method) {
            self.dispatch(method, request).await
        } else {
            Err(anyhow::anyhow!("AUTOMATION_NATIVE_METHOD_UNAVAILABLE"))
        };
        match outcome {
            Ok(reply) => reply,
            Err(error) => IntegrationReply {
                contract_version: request.contract_version,
                request_id: request.request_id.clone(),
                operation_id: request
                    .operation_id
                    .clone()
                    .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
                entity_revision: IntegrationNullable::Null,
                observed_at: chrono::Utc::now().to_rfc3339(),
                status: if method == "acceptTask" {
                    if error
                        .chain()
                        .any(|cause| cause.to_string() == "AUTOMATION_NATIVE_REJECTED_BEFORE_QUEUE")
                    {
                        IntegrationStatus::Rejected
                    } else {
                        IntegrationStatus::Unknown
                    }
                } else {
                    IntegrationStatus::Unavailable
                },
                result: IntegrationNullable::Null,
                error: IntegrationNullable::Value(IntegrationError {
                    code: "AUTOMATION_NATIVE_RUNTIME_UNCONFIRMED".into(),
                    recovery: if method == "acceptTask" {
                        IntegrationRecovery::ReconcileOriginal
                    } else {
                        IntegrationRecovery::RetryRead
                    },
                    message_key: "knowledgeIntegration.operationFailed".into(),
                }),
            },
        }
    }
}

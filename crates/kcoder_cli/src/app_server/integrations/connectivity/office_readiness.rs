//! Office static checks reuse the already owned Main and its readonly method.
//! A check never starts Main, initializes storage or grants tool/resource access.
use super::{main_public::NativeConnectivityPublicCall, main_rpc::NativeConnectivityMainService};
use crate::app_server::{
    ConnectionState,
    integrations::{core::NativeIntegrationContext, office::native_host::NativeOfficePorts},
};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_app_protocol::integrations::connectivity::{
    ConnectivityMethod, ConnectivityPort, ConnectivityPortCall,
};
use kcoder_types::integrations::{core::*, office::*};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(crate) struct NativeOfficeReadinessPort {
    caller: Arc<NativeConnectivityPublicCall>,
    main: Arc<NativeConnectivityMainService>,
}
impl NativeOfficeReadinessPort {
    pub(crate) fn capture(
        state: &ConnectionState,
        request: &IntegrationRequest,
        definition: &OfficeAssistantDefinition,
    ) -> Result<Arc<Self>> {
        let mut actual = request.clone();
        let refs = definition
            .resources
            .iter()
            .map(|reference| {
                let kind = match reference.kind.as_str() {
                    "office_input" => "input",
                    "artifact" => "artifact",
                    "dataset" => "dataset",
                    "publication" | "knowledge_publication" => "publication",
                    "connection" => "connection",
                    _ => anyhow::bail!("OFFICE_RESOURCE_KIND_UNSUPPORTED"),
                };
                Ok(json!({"kind":kind,"id":reference.id,"revision":reference.revision}))
            })
            .collect::<Result<Vec<_>>>()?;
        actual.payload = json!({"capabilityIds":definition.capabilities.iter().map(|value| &value.capability_id).collect::<Vec<_>>(),"resourceRefs":refs})
            .as_object().context("OFFICE_INVALID_INPUT")?.clone();
        let caller = NativeConnectivityPublicCall::capture(
            state,
            ConnectivityPortCall {
                port: ConnectivityPort::Readiness,
                method: ConnectivityMethod::InspectReadiness,
                request: actual,
            },
        )?;
        Ok(Arc::new(Self {
            caller,
            main: state.integration_connectivity.clone(),
        }))
    }
    pub(crate) async fn observe(
        &self,
        native: &NativeIntegrationContext,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let request = &self.caller.call().request;
        let reply = self
            .call(
                native,
                IntegrationPort::Readiness,
                "inspectReadiness",
                request,
                cancel,
            )
            .await?;
        reply.validate()?;
        ensure!(
            reply.status == IntegrationStatus::Completed
                && reply.request_id == request.request_id
                && reply.operation_id.as_ref() == request.operation_id.as_ref(),
            "OFFICE_READINESS_UNCONFIRMED"
        );
        Ok(Value::Object(
            reply
                .result
                .as_ref()
                .context("OFFICE_READINESS_UNCONFIRMED")?
                .clone(),
        ))
    }
}
#[async_trait]
#[kcoder_async_box::shared]
impl NativeOfficePorts for NativeOfficeReadinessPort {
    async fn call(
        &self,
        native: &NativeIntegrationContext,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<IntegrationReply> {
        native.validate_scope(&request.scope)?;
        self.caller.verify(&request.scope)?;
        let original = &self.caller.call().request;
        ensure!(
            port == IntegrationPort::Readiness
                && method == "inspectReadiness"
                && request.payload == original.payload
                && request.request_id == original.request_id
                && request.operation_id == original.operation_id,
            "OFFICE_READINESS_METHOD_DENIED"
        );
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        // existing_host is observation only. Missing Main remains unknown to the
        // caller instead of acquiring another host or initializing its store.
        let host = self.main.existing_host().await?;
        let reply = tokio::select! { biased;
            _ = cancel.cancelled() => anyhow::bail!("OFFICE_CANCELLED"),
            result = host.call(self.caller.clone()) => result?,
        };
        self.caller.verify(&request.scope)?;
        native.validate_scope(&request.scope)?;
        Ok(reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::integrations::core::runtime_driver::test_support::Fixture;
    fn definition() -> OfficeAssistantDefinition {
        kcoder_config::integrations::office::builtin_office_assistant(
            "builtin.meeting-minutes",
            "en",
        )
        .unwrap()
    }
    #[tokio::test]
    async fn missing_original_main_is_not_started_and_foreign_methods_cannot_reuse_readiness_owner()
    -> Result<()> {
        let fixture = Fixture::new();
        let state = ConnectionState {
            initialized: true,
            integration_context: Some(fixture.context),
            ..Default::default()
        };
        let request = IntegrationRequest {
            contract_version: IntegrationContractVersion::ParallelV1,
            request_id: "office-static".into(),
            scope: state.integration_context.as_ref().unwrap().scope().clone(),
            operation_id: None,
            expected_revision: None,
            timeout_ms: 1000,
            cancellation_ref: None,
            payload: Default::default(),
        };
        let port = NativeOfficeReadinessPort::capture(&state, &request, &definition())?;
        let native = state.integration_context.as_ref().unwrap();
        assert!(
            port.observe(native, &CancellationToken::new())
                .await
                .is_err()
        );
        assert!(
            state
                .integration_connectivity
                .existing_host()
                .await
                .is_err()
        );
        assert!(
            port.call(
                native,
                IntegrationPort::Runtime,
                "acceptTask",
                &request,
                &CancellationToken::new()
            )
            .await
            .is_err()
        );
        let mut changed = port.caller.call().request.clone();
        changed
            .payload
            .insert("capabilityIds".into(), json!(["foreign.capability"]));
        assert!(
            port.call(
                native,
                IntegrationPort::Readiness,
                "inspectReadiness",
                &changed,
                &CancellationToken::new()
            )
            .await
            .is_err()
        );
        let mut foreign = port.caller.call().request.clone();
        foreign.scope.target_revision = "foreign-revision".into();
        assert!(
            port.call(
                native,
                IntegrationPort::Readiness,
                "inspectReadiness",
                &foreign,
                &CancellationToken::new()
            )
            .await
            .is_err()
        );
        state.input_ended.cancel();
        assert!(
            port.observe(native, &CancellationToken::new())
                .await
                .is_err()
        );
        Ok(())
    }
}

//! Finite public controls capture the real connection then run outside its loop.
use super::{
    installed_resources::NativeConnectivityStartupBinding, main_host::NativeConnectivityMainHost,
    main_public::NativeConnectivityPublicCall,
    task_capability_scope_runtime::NativeTaskCapabilityScopeRuntime,
};
use crate::app_server::task_spawn::JoinSetExt as _;
use crate::app_server::{
    AppServerEngineFactory, ConnectionState, error_response,
    integrations::core::runtime_pump::NativeRuntimeClient, send, success_response,
};
use anyhow::{Context, Result, ensure};
pub(crate) use kcoder_app_protocol::integrations::connectivity::CAPABILITY_NATIVE_CONNECTIVITY_V1;
use kcoder_app_protocol::integrations::connectivity::{
    ConnectivityControlMethod, ConnectivityMethod, ConnectivityPortCall,
};
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_config::{CredentialBackend, OsCredentialBackend};
use kcoder_types::integrations::core::*;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{Mutex, mpsc};
mod failure;

#[derive(Default, Debug)]
pub(crate) struct NativeConnectivityMainService {
    host: Mutex<Option<Arc<NativeConnectivityMainHost>>>,
}
pub(super) struct NativeConnectivityMainAssembly {
    pub office_resources: Option<
        Arc<crate::app_server::integrations::office::startup_binding::NativeOfficeStartupBinding>,
    >,
    pub scope_host: Option<Arc<crate::app_server::NativeScopeHostBootstrap>>,
    pub factory: AppServerEngineFactory,
    pub origin: kcoder_engine::QueryEngine,
    pub vault: Arc<dyn CredentialBackend>,
    pub runtime: NativeRuntimeClient,
    pub sources: Arc<NativeTaskCapabilityScopeRuntime>,
}
impl NativeConnectivityMainService {
    pub(crate) async fn validate_office_application_sources(
        &self,
        native: &crate::app_server::integrations::core::NativeIntegrationContext,
        sources: &[kcoder_types::integrations::office::OfficeResourceRef],
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<Vec<kcoder_types::integrations::office::OfficeCanonicalInputIdentity>> {
        self.existing_host()
            .await?
            .validate_office_application_sources(native, sources, cancel)
            .await
    }
    pub(super) async fn owned_host(
        &self,
        caller: &Arc<NativeConnectivityPublicCall>,
        installed: super::installed_resources::NativeConnectivityInstalledPaths,
        assembly: NativeConnectivityMainAssembly,
    ) -> Result<Arc<NativeConnectivityMainHost>> {
        let mut current = self.host.lock().await;
        caller.verify(caller.context().scope())?;
        if let Some(old) = current.as_ref()
            && !old.owned_parts().1.parent().alive()?
        {
            // Keep the original owner reachable until its actual Main, SDKs
            // and in-flight launches have produced a cleanup receipt.
            old.close().await?;
            *current = None;
        }
        if current.is_none() {
            *current = Some(
                NativeConnectivityMainHost::spawn_from_assembly(caller, installed, assembly)
                    .await?,
            );
        }
        caller.verify(caller.context().scope())?;
        current
            .as_ref()
            .context("CONNECTIVITY_NATIVE_UNAVAILABLE")
            .cloned()
    }
    /// Read only the actual current Main. An automation cannot create a public owner or spawn one.
    #[cfg(test)]
    pub(super) fn from_owned_fixture(
        caller: &Arc<NativeConnectivityPublicCall>,
        host: Arc<NativeConnectivityMainHost>,
    ) -> Result<Self> {
        let (native, actual) = host.owned_parts();
        caller.verify(native.scope())?;
        actual.parent().verify(native)?;
        Ok(Self {
            host: Mutex::new(Some(host)),
            ..Default::default()
        })
    }
    pub(super) async fn existing_host(&self) -> Result<Arc<NativeConnectivityMainHost>> {
        self.host
            .lock()
            .await
            .as_ref()
            .cloned()
            .context("AUTOMATION_ORIGINAL_MAIN_UNAVAILABLE")
    }
    pub(super) async fn retire_exited_main(
        &self,
        observed: &Arc<NativeConnectivityMainHost>,
    ) -> Result<()> {
        ensure!(
            !observed.owned_parts().1.parent().alive()?,
            "AUTOMATION_ORIGINAL_MAIN_STILL_ACTIVE"
        );
        {
            let mut current = self.host.lock().await;
            ensure!(
                current
                    .as_ref()
                    .is_none_or(|current| Arc::ptr_eq(current, observed)),
                "AUTOMATION_ORIGINAL_MAIN_CHANGED"
            );
            if let Some(old) = current.as_ref() {
                old.close().await?;
                *current = None;
            }
        }
        Ok(())
    }
    /// Observe only the already owned Main. Resource checks never start it.
    pub(super) async fn task_resource_fact(
        &self,
        native: &crate::app_server::integrations::core::NativeIntegrationContext,
        connection: &IntegrationRevisionRef,
        refs: &[IntegrationTaskResourceRef],
    ) -> Result<Value> {
        native.verify()?;
        self.existing_host()
            .await?
            .task_resource_fact(native, connection, refs)
            .await
    }
    pub(crate) async fn close(&self) -> Result<()> {
        let host = self.host.lock().await.take();
        if let Some(host) = host {
            host.close().await
        } else {
            Ok(())
        }
    }
}
pub(super) struct PreparedConnectivityCall {
    office_resources: Option<
        Arc<crate::app_server::integrations::office::startup_binding::NativeOfficeStartupBinding>,
    >,
    caller: Arc<NativeConnectivityPublicCall>,
    scope_host: Option<Arc<crate::app_server::NativeScopeHostBootstrap>>,
    resources: Arc<NativeConnectivityStartupBinding>,
    service: Arc<NativeConnectivityMainService>,
    factory: AppServerEngineFactory,
    origin: kcoder_engine::QueryEngine,
    runtime: NativeRuntimeClient,
    sources: Arc<NativeTaskCapabilityScopeRuntime>,
}
impl PreparedConnectivityCall {
    pub(super) fn capture(
        state: &ConnectionState,
        method: ConnectivityMethod,
        request: IntegrationRequest,
        factory: &AppServerEngineFactory,
        origin: kcoder_engine::QueryEngine,
    ) -> Result<Self> {
        ensure!(
            state.integration_connectivity_v1 && state.knowledge_rpc_tasks.len() < 64,
            "CONNECTIVITY_NATIVE_UNAVAILABLE"
        );
        let caller = NativeConnectivityPublicCall::capture(
            state,
            ConnectivityPortCall {
                port: method.port(),
                method,
                request,
            },
        )?;
        Ok(Self {
            office_resources: state.integration_office_resources.clone(),
            caller,
            scope_host: state.native_scope_host.clone(),
            resources: state
                .integration_connectivity_resources
                .clone()
                .context("CHANNEL_NATIVE_RESOURCES_UNAVAILABLE")?,
            service: state.integration_connectivity.clone(),
            factory: factory.clone(),
            origin,
            runtime: state
                .integration_runtime
                .clone()
                .context("CONNECTIVITY_NATIVE_RUNTIME_UNAVAILABLE")?,
            sources: state.integration_task_capability_scope.clone(),
        })
    }
    pub(super) async fn run(self) -> Result<IntegrationReply> {
        if let Some(reply) = super::connection_directory::directory_only(&self.caller)? {
            return Ok(reply);
        }
        let cancel = self.caller.cancellation();
        let installed = self
            .resources
            .resolve(self.caller.context(), &cancel)
            .await?;
        if let Some(catalog) = super::cold_catalog::read(&self.caller, &installed)? {
            return Ok(catalog);
        }
        ensure!(
            self.scope_host.is_some(),
            "APP_SERVER_HOST_GATEWAY_REQUIRED"
        );
        if let Some(host) = &self.scope_host {
            host.verify()?;
        }
        let host = self
            .service
            .owned_host(
                &self.caller,
                installed,
                NativeConnectivityMainAssembly {
                    office_resources: self.office_resources.clone(),
                    scope_host: self.scope_host.clone(),
                    factory: self.factory,
                    origin: self.origin,
                    vault: Arc::new(OsCredentialBackend::new()),
                    runtime: self.runtime,
                    sources: self.sources,
                },
            )
            .await?;
        host.call(self.caller).await
    }
}
pub(in crate::app_server) async fn dispatch(
    wire: &str,
    id: &Value,
    params: &Value,
    factory: &AppServerEngineFactory,
    origin: kcoder_engine::QueryEngine,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    let Some(public) = ConnectivityControlMethod::parse(wire) else {
        return Ok(false);
    };
    let method = public.port_method();
    let capture = (|| -> Result<_> {
        let request: IntegrationRequest = rpc_codec::decode(params.clone())?;
        let prepared =
            PreparedConnectivityCall::capture(state, method, request.clone(), factory, origin)?;
        Ok((request, prepared))
    })();
    let (request, prepared) = match capture {
        Ok(value) => value,
        Err(error) => {
            send(
                outbound,
                error_response(id.clone(), -32078, failure::public_failure(&error).0),
            )
            .await?;
            return Ok(true);
        }
    };
    let id = id.clone();
    let outbound = outbound.clone();
    let cancel = state.input_ended.child_token();
    state.knowledge_rpc_tasks.spawn_shared(async move {
        let result = tokio::select! { biased;
            _ = cancel.cancelled() => Err(anyhow::anyhow!("CONNECTIVITY_CALL_CANCELLED")),
            result = tokio::time::timeout(std::time::Duration::from_millis(request.timeout_ms), prepared.run()) =>
                result.map_err(|_|anyhow::anyhow!("CONNECTIVITY_ORIGINAL_OPERATION_UNCONFIRMED")).and_then(|result|result),
        };
        // Observe the entire original call outcome before its public unknown projection.
        // Fixed stages and bounded digests preserve private source and peer failures.
        if let Err(error) = &result {
            use crate::app_server::integrations::core::service_leases::scope_host::frontend::{
                OriginalPreparationStage, report_original_failure,
            };
            report_original_failure(OriginalPreparationStage::OriginalUiCall, error);
        }
        let reply = result.unwrap_or_else(|error| {
            let (code, message_key, recovery) = failure::public_failure(&error);
            IntegrationReply {
            contract_version: request.contract_version, request_id: request.request_id,
            operation_id: request.operation_id.map_or(IntegrationNullable::Null,IntegrationNullable::Value),
            status: if method.is_mutation() { IntegrationStatus::Unknown } else { IntegrationStatus::Unavailable },
            entity_revision: IntegrationNullable::Null, observed_at: chrono::Utc::now().to_rfc3339(),
            result: IntegrationNullable::Null, error: IntegrationNullable::Value(IntegrationError {
                code:code.into(), message_key:message_key.into(),
                recovery:if method.is_mutation(){IntegrationRecovery::ReconcileOriginal}else{recovery},
            }),
        }});
        let response = serde_json::to_value(reply).map(|reply|success_response(id.clone(),reply))
            .unwrap_or_else(|_|error_response(id,-32078,"CONNECTIVITY_NATIVE_UNAVAILABLE"));
        let _ = send(&outbound,response).await;
    });
    Ok(true)
}

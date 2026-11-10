//! Owned Node application host over the original resource and task services.
#[cfg(test)]
use super::task_capability_scope_runtime::NativeTaskCapabilityScopeRuntime;
use super::{
    NativeConnectivityHost, NativeConnectivityLeaseFacade, NativeConnectivitySourceCatalog,
    installed_resources::NativeConnectivityInstalledPaths,
    main_provider::{NativeConnectivityMainContributions, NativeConnectivityMainProvider},
    main_public::NativeConnectivityPublicCall,
    native_mcp_source_facts,
};
#[cfg(test)]
use crate::app_server::engine_factory::AppServerEngineFactory;
use crate::app_server::integrations::core::{
    NativeIntegrationContext, runtime_pump::NativeRuntimeClient,
};
use anyhow::{Context, Result};
#[cfg(test)]
use kcoder_config::CredentialBackend;
#[cfg(test)]
use kcoder_tools::ToolRegistry;
use kcoder_types::integrations::core::{IntegrationReply, IntegrationStatus};
use serde_json::Value;
use std::sync::Arc;

pub(crate) struct NativeConnectivityMainHost {
    context: Arc<NativeIntegrationContext>,
    host: Arc<NativeConnectivityHost>,
    provider: Arc<NativeConnectivityMainProvider>,
}
impl std::fmt::Debug for NativeConnectivityMainHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeConnectivityMainHost { actual_owned_target: bound }")
    }
}
impl NativeConnectivityMainHost {
    pub(super) async fn validate_office_application_sources(
        &self,
        native: &NativeIntegrationContext,
        sources: &[kcoder_types::integrations::office::OfficeResourceRef],
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<Vec<kcoder_types::integrations::office::OfficeCanonicalInputIdentity>> {
        self.provider
            .validate_office_application_sources(native, self.host.parent(), sources, cancel)
            .await
    }
    pub(super) async fn task_resource_fact(
        &self,
        native: &NativeIntegrationContext,
        connection: &kcoder_types::integrations::core::IntegrationRevisionRef,
        refs: &[kcoder_types::integrations::core::IntegrationTaskResourceRef],
    ) -> Result<serde_json::Value> {
        use super::NativeConnectivityFactPipe;
        self.context.check_captured_scope(native.scope())?;
        let result = self.host.read_owned(self.host.parent(), "connectivity.resolveApplicationResources",
            serde_json::json!({"scope":native.scope(),"connectionId":connection.id,"resourceRefs":refs})).await?;
        let facade = NativeConnectivityLeaseFacade::observe(native)?
            .context("TASK_RESOURCE_MAIN_UNAVAILABLE")?;
        anyhow::ensure!(
            result["nativeNamespaceId"].as_str() == Some(facade.namespace_id(native)?)
                && result["connectionId"].as_str() == Some(connection.id.as_str())
                && result["connectionRevision"].as_str() == Some(connection.revision.as_str()),
            "TASK_RESOURCE_GRANT_CHANGED"
        );
        self.host.parent().verify(native)?;
        Ok(result)
    }
    pub(in crate::app_server::integrations::connectivity) async fn spawn_from_assembly(
        caller: &Arc<NativeConnectivityPublicCall>,
        installed: NativeConnectivityInstalledPaths,
        assembly: super::main_rpc::NativeConnectivityMainAssembly,
    ) -> Result<Arc<Self>> {
        Self::spawn_inner(caller, installed, assembly).await
    }
    /// paths comes only from the verified native installed-bundle resolver.
    /// Neither a public call nor the model supplies an executable or host path.
    #[cfg(test)]
    pub(crate) async fn spawn(
        caller: &Arc<NativeConnectivityPublicCall>,
        installed: NativeConnectivityInstalledPaths,
        factory: AppServerEngineFactory,
        origin: kcoder_engine::QueryEngine,
        vault: Arc<dyn CredentialBackend>,
        runtime: NativeRuntimeClient,
        sources: Arc<NativeTaskCapabilityScopeRuntime>,
    ) -> Result<Arc<Self>> {
        Self::spawn_in_scope(
            caller, installed, factory, origin, vault, runtime, sources, None,
        )
        .await
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "The compatibility entry keeps each original owner and component binding explicit"
    )]
    #[cfg(test)]
    pub(crate) async fn spawn_in_scope(
        caller: &Arc<NativeConnectivityPublicCall>,
        installed: NativeConnectivityInstalledPaths,
        factory: AppServerEngineFactory,
        origin: kcoder_engine::QueryEngine,
        vault: Arc<dyn CredentialBackend>,
        runtime: NativeRuntimeClient,
        sources: Arc<NativeTaskCapabilityScopeRuntime>,
        scope_host: Option<Arc<crate::app_server::NativeScopeHostBootstrap>>,
    ) -> Result<Arc<Self>> {
        Self::spawn_inner(
            caller,
            installed,
            super::main_rpc::NativeConnectivityMainAssembly {
                office_resources: None,
                scope_host,
                factory,
                origin,
                vault,
                runtime,
                sources,
            },
        )
        .await
    }
    async fn spawn_inner(
        caller: &Arc<NativeConnectivityPublicCall>,
        installed: NativeConnectivityInstalledPaths,
        assembly: super::main_rpc::NativeConnectivityMainAssembly,
    ) -> Result<Arc<Self>> {
        let super::main_rpc::NativeConnectivityMainAssembly {
            office_resources,
            scope_host,
            factory,
            origin,
            vault,
            runtime,
            sources,
        } = assembly;
        caller.verify(caller.context().scope())?;
        let NativeConnectivityInstalledPaths {
            task_first_routing_supported: _,
            paths,
            verifier: resources,
            ..
        } = installed;
        let context = Arc::new(caller.context().recapture_for_owned_service()?);
        let facade = Arc::new(match NativeConnectivityLeaseFacade::observe(&context)? {
            Some(facade) => facade,
            None => {
                NativeConnectivityLeaseFacade::initialize(&context, caller.initialize_operation()?)?
            }
        });
        let initialize = caller.initialize_operation().ok().map(|_| caller);
        let contributions = NativeConnectivityMainContributions::capture(
            &context,
            facade.clone(),
            factory.clone(),
            origin,
            vault.clone(),
            runtime,
            &sources,
            office_resources,
        )?;
        if let Some(caller) = initialize
            && NativeConnectivitySourceCatalog::observe(&context)?.is_none()
        {
            let catalog = NativeConnectivitySourceCatalog::initialize(
                &context,
                caller.initialize_operation()?,
            )?;
            let facts = native_mcp_source_facts(&context, &factory, vault.as_ref())?;
            catalog.register(
                &context,
                &format!("{}-source-catalog", caller.initialize_operation()?),
                &facts,
            )?;
        }
        // Every delegate is a real native service. Missing business providers
        // remain unavailable in MainProvider; no permissive Runtime is installed.
        let handler: Arc<dyn super::NativeConnectivityReverseHandler> =
            contributions.provider.clone();
        caller.verify(context.scope())?;
        let launch_resources = resources.clone();
        let launch_cancel = caller.cancellation();
        // TODO(channel-latency): let one load-boundary owner prepare and consume
        // the bundle proof; cached resolution alone cannot prove a later load.
        tokio::task::spawn_blocking(move || launch_resources.verify_for_launch(&launch_cancel))
            .await
            .context("CHANNEL_COMPONENT_UNAVAILABLE")??;
        caller.verify(context.scope())?;
        let host = NativeConnectivityHost::spawn_in_scope(
            context.clone(),
            facade,
            paths,
            handler,
            scope_host,
        )
        .await?;
        contributions.provider.bind_owned_main(&host)?;
        caller.verify(context.scope())?;
        Ok(Arc::new(Self {
            context,
            host,
            provider: contributions.provider,
        }))
    }
    pub(super) fn owned_parts(&self) -> (&NativeIntegrationContext, Arc<NativeConnectivityHost>) {
        (&self.context, self.host.clone())
    }
    pub(crate) async fn call(
        &self,
        caller: Arc<NativeConnectivityPublicCall>,
    ) -> Result<IntegrationReply> {
        caller.verify(self.context.scope())?;
        let _registration = self.provider.register_public(&caller)?;
        let cancel = caller.cancellation();
        let reply = self
            .host
            .call(caller.call(), Some(&cancel))
            .await
            .context("CONNECTIVITY_ORIGINAL_OPERATION_UNCONFIRMED")?;
        caller.verify(self.context.scope())?;
        if caller.call().method == kcoder_app_protocol::integrations::connectivity::ConnectivityMethod::PrepareConnectionAction
            && reply.status == IntegrationStatus::Completed
            && caller.call().request.payload.get("action").and_then(Value::as_str) == Some("save")
            && self.context.scope().organization_id.is_none()
            && self.provider.record_connection_directory_source(&caller).is_err()
        {
            // A derived locator failure must not rewrite the original effect receipt.
            // Target directory reads expose this namespace as unregistered/unavailable.
            tracing::warn!("CONNECTION_DIRECTORY_SOURCE_REGISTRATION_UNCONFIRMED");
        }
        Ok(reply)
    }
    pub(crate) async fn close(&self) -> Result<()> {
        self.host.close().await
    }
}

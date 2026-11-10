//! Production Main contributions are assembled from actual native services.
mod verification_slot;
use super::super::core::NativeIntegrationContext;
use super::{
    NativeConnectivityFactPipe, NativeConnectivityLeaseFacade, NativeConnectivityParent,
    NativeConnectivityReverseHandler, NativeConnectivitySourceCatalog,
    main_public::NativeConnectivityPublicCall, native_mcp_source_facts,
};
use crate::app_server::{
    engine_factory::AppServerEngineFactory, integrations::core::runtime_pump::NativeRuntimeClient,
};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_config::{CredentialBackend, CredentialStoreMode};
use kcoder_tools::ToolRegistry;
use kcoder_types::integrations::core::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
#[path = "application_office_sources.rs"]
mod application_office_sources;

pub(crate) struct NativeConnectivityMainProvider {
    office_resources: Option<
        Arc<crate::app_server::integrations::office::startup_binding::NativeOfficeStartupBinding>,
    >,
    context: NativeIntegrationContext,
    factory: AppServerEngineFactory,
    registry: ToolRegistry,
    origin: kcoder_engine::QueryEngine,
    mode: CredentialStoreMode,
    vault: Arc<dyn CredentialBackend>,
    facade: Arc<NativeConnectivityLeaseFacade>,
    parent: Mutex<Weak<NativeConnectivityParent>>,
    main: Mutex<Weak<super::NativeConnectivityHost>>,
    callers: Mutex<std::collections::BTreeMap<String, Weak<NativeConnectivityPublicCall>>>,
    blocking: Arc<Semaphore>,
    application_tasks: Arc<super::application_task::NativeApplicationTaskGrants>,
    // This is the original connection-owned queue, never a second task runtime.
    runtime: NativeRuntimeClient,
    task_capability_scope:
        Weak<super::task_capability_scope_runtime::NativeTaskCapabilityScopeRuntime>,
}
pub(crate) struct NativeConnectivityMainContributions {
    pub(crate) provider: Arc<NativeConnectivityMainProvider>,
}
impl NativeConnectivityMainContributions {
    /// Capture application dependencies without channel credential or SDK context stores.
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep native context, original runtime, resolved services and verified resources explicit at the composition boundary"
    )]
    pub(crate) fn capture(
        context: &NativeIntegrationContext,
        facade: Arc<NativeConnectivityLeaseFacade>,
        factory: AppServerEngineFactory,
        origin: kcoder_engine::QueryEngine,
        vault: Arc<dyn CredentialBackend>,
        runtime: NativeRuntimeClient,
        task_capability_scope: &Arc<
            super::task_capability_scope_runtime::NativeTaskCapabilityScopeRuntime,
        >,
        office_resources: Option<Arc<crate::app_server::integrations::office::startup_binding::NativeOfficeStartupBinding>>,
    ) -> Result<Self> {
        context.verify()?;
        if let Some(resources) = &office_resources {
            resources.verify_context(context, &origin)?;
        }
        let registry = origin.active_tool_registry().clone();
        let settings = factory.current_settings()?;
        let mode = settings.credential_store;
        let provider = Arc::new(NativeConnectivityMainProvider {
            context: context.recapture_for_owned_service()?,
            factory,
            registry,
            origin,
            mode,
            vault,
            facade,
            parent: Mutex::new(Weak::new()),
            main: Mutex::new(Weak::new()),
            callers: Mutex::new(Default::default()),
            blocking: Arc::new(Semaphore::new(2)),
            application_tasks: Arc::new(Default::default()),
            runtime,
            task_capability_scope: Arc::downgrade(task_capability_scope),
            office_resources,
        });
        Ok(Self { provider })
    }
}
pub(crate) struct NativePublicCallRegistration {
    provider: Arc<NativeConnectivityMainProvider>,
    id: String,
}
impl Drop for NativePublicCallRegistration {
    fn drop(&mut self) {
        if let Ok(mut callers) = self.provider.callers.lock() {
            callers.remove(&self.id);
        }
    }
}
impl NativeConnectivityMainProvider {
    pub(super) fn bind_owned_main(&self, main: &Arc<super::NativeConnectivityHost>) -> Result<()> {
        self.bind_owned_parent(main.parent_arc())?;
        let mut owned = self
            .main
            .lock()
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_MAIN_OWNER_UNAVAILABLE"))?;
        ensure!(
            owned.upgrade().is_none_or(|old| Arc::ptr_eq(&old, main)),
            "CONNECTIVITY_MAIN_OWNER_CHANGED"
        );
        *owned = Arc::downgrade(main);
        Ok(())
    }
    fn application_resource_host(
        &self,
        context: &NativeIntegrationContext,
        parent: &NativeConnectivityParent,
    ) -> Result<super::application_resources::NativeApplicationResourceHost> {
        self.verify(context, parent)?;
        let main = self
            .main
            .lock()
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_MAIN_OWNER_UNAVAILABLE"))?
            .upgrade()
            .context("CONNECTIVITY_MAIN_OWNER_UNAVAILABLE")?;
        let actual = main.parent_arc();
        ensure!(actual.id == parent.id, "CONNECTIVITY_MAIN_OWNER_CHANGED");
        Ok(
            super::application_resources::NativeApplicationResourceHost {
                facade: self.facade.clone(),
                parent: actual,
                pipe: main,
                factory: self.factory.clone(),
            },
        )
    }
    pub(crate) fn bind_owned_parent(&self, parent: Arc<NativeConnectivityParent>) -> Result<()> {
        parent.verify(&self.context)?;
        let mut owner = self
            .parent
            .lock()
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_MAIN_OWNER_UNAVAILABLE"))?;
        ensure!(
            owner.upgrade().is_none_or(|old| old.id == parent.id),
            "CONNECTIVITY_MAIN_OWNER_CHANGED"
        );
        *owner = Arc::downgrade(&parent);
        Ok(())
    }
    pub(crate) fn register_public(
        self: &Arc<Self>,
        caller: &Arc<NativeConnectivityPublicCall>,
    ) -> Result<NativePublicCallRegistration> {
        caller.verify(self.context.scope())?;
        let mut callers = self
            .callers
            .lock()
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_CALLERS_UNAVAILABLE"))?;
        callers.retain(|_, caller| caller.upgrade().is_some());
        ensure!(callers.len() < 64, "CONNECTIVITY_PUBLIC_CALL_CAPACITY");
        let id = uuid::Uuid::new_v4().to_string();
        callers.insert(id.clone(), Arc::downgrade(caller));
        Ok(NativePublicCallRegistration {
            provider: self.clone(),
            id,
        })
    }
    fn verify(
        &self,
        context: &NativeIntegrationContext,
        parent: &NativeConnectivityParent,
    ) -> Result<()> {
        context.check_captured_scope(self.context.scope())?;
        parent.verify(context)?;
        ensure!(
            self.factory.current_settings()?.credential_store == self.mode,
            "CONNECTIVITY_CREDENTIAL_CONFIGURATION_CHANGED"
        );
        Ok(())
    }
    fn callers(&self) -> Result<Vec<Arc<NativeConnectivityPublicCall>>> {
        Ok(self
            .callers
            .lock()
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_CALLERS_UNAVAILABLE"))?
            .values()
            .filter_map(Weak::upgrade)
            .collect())
    }
    async fn integration(
        &self,
        context: &NativeIntegrationContext,
        parent: &NativeConnectivityParent,
        params: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let input: IntegrationCall = serde_json::from_value(params)
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_NATIVE_CALL_INVALID"))?;
        input.validate_application_route()?;
        context.validate_scope(&input.request.scope)?;
        input.request.validate_method(input.port, &input.method)?;
        match (input.port, input.method.as_str()) {
            (IntegrationPort::Policy, "evaluateAction") => {
                if matches!(
                    input.request.payload.get("action").and_then(Value::as_str),
                    Some("application.selectResources" | "application.runOfficeTask")
                ) {
                    for caller in self.callers()? {
                        if super::application_inputs::matches_policy(&caller, &input.request)? {
                            let host = self.application_resource_host(context, parent)?;
                            super::application_inputs::verify_policy_source(
                                context,
                                &host,
                                &self.origin,
                                self.vault.clone(),
                                &caller,
                                &input.request,
                                &cancel,
                            )
                            .await?;
                            self.application_tasks.before_public_mutation(&caller)?;
                            return reply(
                                &input.request,
                                json!({"decision":"allow","policyRevision":format!("native-application-{}",context.source_authority_epoch()?.1),"reasonCode":"EXACT_NATIVE_PUBLIC_APPLICATION_SELECTION"}),
                            );
                        }
                    }
                    anyhow::bail!("APPLICATION_ORIGINAL_PUBLIC_TASK_REQUIRED");
                }
                for caller in self.callers()? {
                    if let Ok(Some(result)) = caller.authorize_top_level(context, &input.request) {
                        self.application_tasks.before_public_mutation(&caller)?;
                        return reply(&input.request, result);
                    }
                }
                anyhow::bail!("APPLICATION_ORIGINAL_PUBLIC_TASK_REQUIRED")
            }
            (IntegrationPort::Runtime, "acceptTask") => {
                let operation = input
                    .request
                    .operation_id
                    .as_deref()
                    .context("APPLICATION_ORIGINAL_OPERATION_REQUIRED")?;
                if let Some(driver) =
                    super::super::core::runtime_driver::NativeRuntimeDriver::load(context)?
                    && let Some(original) = driver.source_intent(context, operation)?
                {
                    ensure!(
                        original.original(context)?.payload == input.request.payload,
                        "APPLICATION_ORIGINAL_RUNTIME_CHANGED"
                    );
                    let receipt = driver
                        .read_operation(context, operation)?
                        .context("APPLICATION_ORIGINAL_OPERATION_UNCONFIRMED")?;
                    let accepted = receipt
                        .runtime_acceptance
                        .context("APPLICATION_ORIGINAL_OPERATION_UNCONFIRMED")?;
                    let mut response: IntegrationReply =
                        rpc_codec::decode(reply(&input.request, serde_json::to_value(accepted)?)?)?;
                    response.status = IntegrationStatus::Accepted;
                    return Ok(serde_json::to_value(response)?);
                }
                let (source, text) =
                    super::application_inputs::NativeApplicationTaskSource::read_original(
                        context,
                        self.application_resource_host(context, parent)?,
                        &self.origin,
                        self.vault.clone(),
                        self.callers()?,
                        &self.application_tasks,
                        input.request.clone(),
                        &cancel,
                    )
                    .await?;
                let authority = super::application_runtime::NativeApplicationRuntime::prepare(
                    context,
                    &self.origin,
                    &self.factory,
                    input.request.clone(),
                    source,
                    text,
                    &cancel,
                )
                .await?;
                let response = self
                    .runtime
                    .accept(
                        Arc::new(context.recapture_for_owned_service()?),
                        input.request,
                        authority.task(),
                        authority,
                    )
                    .await?;
                Ok(serde_json::to_value(response)?)
            }
            _ => anyhow::bail!("APPLICATION_NATIVE_PROVIDER_UNAVAILABLE"),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IntegrationCall {
    port: IntegrationPort,
    method: String,
    request: IntegrationRequest,
}
impl IntegrationCall {
    fn validate_application_route(&self) -> Result<()> {
        let supported = match (self.port, self.method.as_str()) {
            (IntegrationPort::Policy, "evaluateAction") => matches!(
                self.request.payload.get("action").and_then(Value::as_str),
                Some(
                    "application.selectResources"
                        | "application.runOfficeTask"
                        | "connectivity.listConnections"
                        | "connectivity.readConnection"
                        | "connectivity.resolveCapability"
                        | "connectivity.readResourceGrant"
                        | "connectivity.prepareConnectionAction"
                        | "connectivity.inspectReadiness"
                        | "connectivity.readReadiness"
                        | "connectivity.verifyCapability"
                )
            ),
            (IntegrationPort::Runtime, "acceptTask") => {
                self.request
                    .payload
                    .get("source")
                    .and_then(|source| source.get("kind"))
                    .and_then(Value::as_str)
                    == Some("application")
                    && !self.request.payload.contains_key("command")
            }
            _ => false,
        };
        ensure!(supported, "APPLICATION_NATIVE_PROVIDER_UNAVAILABLE");
        Ok(())
    }
}

#[async_trait]
#[kcoder_async_box::shared]
impl NativeConnectivityReverseHandler for NativeConnectivityMainProvider {
    async fn handle(
        &self,
        context: &NativeIntegrationContext,
        parent: &NativeConnectivityParent,
        pipe: &dyn NativeConnectivityFactPipe,
        method: &str,
        params: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.verify(context, parent)?;
        ensure!(!cancel.is_cancelled(), "CONNECTIVITY_CALL_CANCELLED");
        let value = match method {
            "private.applications.call" => {
                super::main_applications::NativeApplicationHost {
                    native: context,
                    parent,
                    pipe,
                    factory: &self.factory,
                    engine: &self.origin,
                    registry: &self.registry,
                    vault: self.vault.clone(),
                    callers: self.callers()?,
                }
                .handle(params, &cancel)
                .await?
            }
            "private.host.configuration" => {
                ensure!(
                    params == json!({}),
                    "APPLICATION_CONFIGURATION_INPUT_INVALID"
                );
                let settings = self.factory.current_settings()?;
                let application = &settings.integrations.connectivity;
                application
                    .validate()
                    .map_err(|_| anyhow::anyhow!("APPLICATION_CONFIGURATION_INVALID"))?;
                json!({"enabled":application.enabled,
                    "maxPendingEvents":application.max_pending_events,
                    "maxMetadataBytes":application.max_metadata_bytes})
            }
            "private.integration.call" => {
                Box::pin(self.integration(context, parent, params, cancel.clone())).await?
            }
            "private.connectivity.inventory" => {
                let expected = json!({"scope":context.scope()});
                ensure!(params == expected, "CONNECTIVITY_INVENTORY_SCOPE_REQUIRED");
                let permit = verification_slot::acquire(self.blocking.clone(), &cancel).await?;
                let native = context.recapture_for_owned_service()?;
                let factory = self.factory.clone();
                let registry = self.registry.clone();
                let vault = self.vault.clone();
                let mut inventory =
                    crate::app_server::task_spawn::spawn_blocking(move || -> Result<Value> {
                        let _permit = permit;
                        let catalog = NativeConnectivitySourceCatalog::observe(&native)?
                            .context("NATIVE_SOURCE_CATALOG_NOT_OBSERVED")?;
                        let facts = native_mcp_source_facts(&native, &factory, vault.as_ref())?;
                        Ok(serde_json::to_value(
                            catalog.inventory(&native, &facts, &registry)?,
                        )?)
                    })
                    .await
                    .context("CONNECTIVITY_INVENTORY_UNAVAILABLE")??;
                let components = pipe
                    .read_owned(parent, "connectivity.installationFacts", json!({}))
                    .await?;
                inventory
                    .as_object_mut()
                    .context("CONNECTIVITY_INVENTORY_UNAVAILABLE")?
                    .insert("components".into(), components);
                inventory
            }
            _ => anyhow::bail!("CONNECTIVITY_NATIVE_PROVIDER_UNAVAILABLE"),
        };
        self.verify(context, parent)?;
        ensure!(!cancel.is_cancelled(), "CONNECTIVITY_CALL_CANCELLED");
        Ok(value)
    }
}
fn reply(request: &IntegrationRequest, result: Value) -> Result<Value> {
    Ok(serde_json::to_value(IntegrationReply {
        contract_version: request.contract_version,
        request_id: request.request_id.clone(),
        operation_id: request
            .operation_id
            .clone()
            .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
        status: IntegrationStatus::Completed,
        entity_revision: IntegrationNullable::Null,
        observed_at: chrono::Utc::now().to_rfc3339(),
        result: IntegrationNullable::Value(
            result
                .as_object()
                .cloned()
                .context("CONNECTIVITY_NATIVE_RESULT_INVALID")?,
        ),
        error: IntegrationNullable::Null,
    })?)
}

#[cfg(test)]
#[path = "main_provider/application_wire_tests.rs"]
mod application_wire_tests;

impl NativeConnectivityMainProvider {
    pub(super) fn record_connection_directory_source(
        &self,
        caller: &NativeConnectivityPublicCall,
    ) -> Result<()> {
        super::connection_directory::register(caller, &self.facade)
    }
}

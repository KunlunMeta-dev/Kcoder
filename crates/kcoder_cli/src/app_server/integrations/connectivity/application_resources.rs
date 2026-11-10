//! Actual registered MCP resource connection. Registration metadata never authorizes a read.
use super::{
    NativeConnectivitySourceCatalog, NativeMcpSourceFact, native_sources::leased::for_engine,
};
use crate::app_server::{AppServerEngineFactory, integrations::core::NativeIntegrationContext};
use anyhow::{Context, Result, ensure};
use kcoder_config::CredentialBackend;
use kcoder_engine::QueryEngine;
use kcoder_types::integrations::core::IntegrationTaskCapabilitySourceChoice;
use std::sync::{Arc, Weak};
use tokio_util::sync::CancellationToken;

/// Original application metadata transport, without channel credentials or SDK authority.
pub(super) struct NativeApplicationResourceHost {
    pub(super) facade: Arc<super::NativeConnectivityLeaseFacade>,
    pub(super) parent: Arc<super::NativeConnectivityParent>,
    pub(super) pipe: Arc<dyn super::NativeConnectivityFactPipe>,
    pub(super) factory: AppServerEngineFactory,
}

pub(crate) struct NativeApplicationResourceConnection {
    engine: QueryEngine,
    factory: AppServerEngineFactory,
    vault: Arc<dyn CredentialBackend>,
    choice: IntegrationTaskCapabilitySourceChoice,
    tool: Weak<dyn kcoder_tools::Tool>,
    origin: Weak<kcoder_mcp::native_origin::NativeMcpConnectionOrigin>,
    connection: Weak<tokio::sync::Mutex<kcoder_mcp::McpClient>>,
}
impl NativeApplicationResourceConnection {
    pub(crate) fn capture(
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        factory: &AppServerEngineFactory,
        vault: Arc<dyn CredentialBackend>,
        choice: IntegrationTaskCapabilitySourceChoice,
    ) -> Result<Arc<Self>> {
        choice.validate()?;
        let facts = for_engine(native, factory, vault.as_ref(), engine)?;
        let catalog = NativeConnectivitySourceCatalog::observe(native)?
            .context("AUTOMATION_APPLICATION_SOURCE_CATALOG_UNAVAILABLE")?;
        let selector = catalog.resolve_choice(native, &choice, &facts)?;
        let registry = engine.active_tool_registry();
        ensure!(
            registry.names().len() <= 4096,
            "AUTOMATION_APPLICATION_SOURCE_LIMIT"
        );
        let mut candidate = None;
        for tool in registry.all() {
            let Ok(birth) = NativeMcpSourceFact::from_registered_engine_tool(native, engine, &tool)
            else {
                continue;
            };
            if !birth.matches_selector(&selector) {
                continue;
            }
            // Current source/account must match the original connection's exact birth stamp.
            catalog.resolve_choice(native, &choice, &[birth])?;
            let actual: &dyn std::any::Any = tool.as_ref();
            let actual = actual
                .downcast_ref::<kcoder_mcp::McpTool>()
                .context("AUTOMATION_APPLICATION_ACTUAL_CONNECTION_REQUIRED")?;
            ensure!(
                actual.app_authority_current(),
                "AUTOMATION_APPLICATION_SOURCE_REVOKED"
            );
            let origin = actual
                .native_origin()
                .context("AUTOMATION_APPLICATION_ACTUAL_CONNECTION_REQUIRED")?;
            let connection = actual.native_connection_gate();
            if let Some((_, previous, _)) = &candidate {
                ensure!(
                    Weak::ptr_eq(previous, &connection),
                    "AUTOMATION_APPLICATION_SOURCE_AMBIGUOUS"
                );
            } else {
                candidate = Some((Arc::downgrade(&tool), connection, Arc::downgrade(origin)));
            }
        }
        let (tool, connection, origin) =
            candidate.context("AUTOMATION_APPLICATION_ACTUAL_CONNECTION_REQUIRED")?;
        let source = Arc::new(Self {
            engine: engine.clone(),
            factory: factory.clone(),
            vault,
            choice,
            tool,
            origin,
            connection,
        });
        source.verify_current(native)?;
        Ok(source)
    }
    pub(crate) fn validate_resource_uri(&self, uri: &str) -> Result<()> {
        let connection = self
            .connection
            .upgrade()
            .context("AUTOMATION_APPLICATION_SOURCE_ENDED")?;
        let client = connection
            .try_lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_APPLICATION_SOURCE_BUSY"))?;
        client.validate_native_resource_uri(uri)
    }
    pub(crate) fn verify_resource_support(&self) -> Result<()> {
        let connection = self
            .connection
            .upgrade()
            .context("AUTOMATION_APPLICATION_SOURCE_ENDED")?;
        let client = connection
            .try_lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_APPLICATION_SOURCE_BUSY"))?;
        ensure!(
            client.resources_supported(),
            "AUTOMATION_APPLICATION_RESOURCE_PROTOCOL_UNAVAILABLE"
        );
        Ok(())
    }
    pub(crate) fn choice(&self) -> &IntegrationTaskCapabilitySourceChoice {
        &self.choice
    }
    pub(super) fn matches_registered_tool(&self, tool: &kcoder_mcp::McpTool) -> bool {
        Weak::ptr_eq(&self.connection, &tool.native_connection_gate())
            && tool.native_origin().is_some_and(|origin| {
                self.origin
                    .upgrade()
                    .is_some_and(|current| Arc::ptr_eq(&current, origin))
            })
    }
    pub(crate) fn verify_current(&self, native: &NativeIntegrationContext) -> Result<()> {
        native.verify()?;
        let settings = self.factory.current_settings()?;
        ensure!(
            !settings.training_mode && settings.integrations.connectivity.enabled,
            "AUTOMATION_APPLICATION_SOURCE_DISABLED"
        );
        let tool = self
            .tool
            .upgrade()
            .context("AUTOMATION_APPLICATION_SOURCE_ENDED")?;
        ensure!(
            self.engine
                .active_tool_registry()
                .all()
                .iter()
                .any(|current| Arc::ptr_eq(current, &tool)),
            "AUTOMATION_APPLICATION_SOURCE_CHANGED"
        );
        let actual: &dyn std::any::Any = tool.as_ref();
        let actual = actual
            .downcast_ref::<kcoder_mcp::McpTool>()
            .context("AUTOMATION_APPLICATION_ACTUAL_CONNECTION_REQUIRED")?;
        let origin = self
            .origin
            .upgrade()
            .context("AUTOMATION_APPLICATION_SOURCE_ENDED")?;
        ensure!(
            actual
                .native_origin()
                .is_some_and(|current| Arc::ptr_eq(current, &origin))
                && actual.app_authority_current(),
            "AUTOMATION_APPLICATION_SOURCE_REVOKED"
        );
        origin.verify_owner()?;
        let catalog = NativeConnectivitySourceCatalog::observe(native)?
            .context("AUTOMATION_APPLICATION_SOURCE_CATALOG_UNAVAILABLE")?;
        let current = for_engine(native, &self.factory, self.vault.as_ref(), &self.engine)?;
        let selector = catalog.resolve_choice(native, &self.choice, &current)?;
        let birth = NativeMcpSourceFact::from_registered_engine_tool(native, &self.engine, &tool)?;
        birth.verify_lease_policy(native, &settings)?;
        ensure!(
            birth.matches_selector(&selector),
            "AUTOMATION_APPLICATION_SOURCE_CHANGED"
        );
        catalog.resolve_choice(native, &self.choice, &[birth])?;
        Ok(())
    }
    /// Metadata discovery retains the exact original public call and current source.
    /// It never reads a resource body or creates a subscription/read grant.
    pub(crate) async fn list_resources(
        &self,
        native: &NativeIntegrationContext,
        permission: &super::application_discovery::NativeApplicationDiscoveryUse,
        cancel: &CancellationToken,
    ) -> Result<Vec<kcoder_mcp::apps::ResourceDescriptor>> {
        permission.verify_current(native, self)?;
        self.verify_current(native)?;
        let connection = self
            .connection
            .upgrade()
            .context("AUTOMATION_APPLICATION_SOURCE_ENDED")?;
        let mut client = tokio::select! {
            biased;
            _ = cancel.cancelled() => anyhow::bail!("AUTOMATION_APPLICATION_READ_CANCELLED"),
            value = connection.lock() => value,
        };
        let origin = self
            .origin
            .upgrade()
            .context("AUTOMATION_APPLICATION_SOURCE_ENDED")?;
        ensure!(
            client
                .native_origin()
                .is_some_and(|current| Arc::ptr_eq(&current, &origin)),
            "AUTOMATION_APPLICATION_SOURCE_CHANGED"
        );
        permission.verify_current(native, self)?;
        let resources = client
            .list_native_resources(&self.engine.state.cwd(), cancel)
            .await?;
        drop(client);
        permission.verify_current(native, self)?;
        self.verify_current(native)?;
        Ok(resources)
    }
    /// Original public task material, separate from metadata discovery and D consent.
    pub(crate) async fn read_for_task(
        &self,
        native: &NativeIntegrationContext,
        permission: &super::application_task::NativeApplicationTaskReadUse,
        cancel: &CancellationToken,
    ) -> Result<kcoder_mcp::client::NativeResourceSnapshot> {
        permission.verify_current(native, self)?;
        self.verify_current(native)?;
        let connection = self
            .connection
            .upgrade()
            .context("AUTOMATION_APPLICATION_SOURCE_ENDED")?;
        let mut client = tokio::select! {
            biased;
            _ = cancel.cancelled() => anyhow::bail!("AUTOMATION_APPLICATION_READ_CANCELLED"),
            value = connection.lock() => value,
        };
        let origin = self
            .origin
            .upgrade()
            .context("AUTOMATION_APPLICATION_SOURCE_ENDED")?;
        ensure!(
            client
                .native_origin()
                .is_some_and(|current| Arc::ptr_eq(&current, &origin)),
            "AUTOMATION_APPLICATION_SOURCE_CHANGED"
        );
        permission.verify_current(native, self)?;
        let value = client
            .read_native_resource(permission.resource_uri(), &self.engine.state.cwd(), cancel)
            .await?;
        drop(client);
        permission.verify_current(native, self)?;
        self.verify_current(native)?;
        Ok(value)
    }
    /// Only D's original explicitly selected URI and current enabled subscription
    /// can construct the opaque read use. No callback or caller JSON can mint it.
    pub(crate) async fn read(
        &self,
        native: &NativeIntegrationContext,
        permission: &crate::app_server::integrations::knowledge::NativeApplicationResourceReadUse,
        cancel: &CancellationToken,
    ) -> Result<kcoder_mcp::client::NativeResourceSnapshot> {
        permission.verify_current(native, self)?;
        self.verify_current(native)?;
        let connection = self
            .connection
            .upgrade()
            .context("AUTOMATION_APPLICATION_SOURCE_ENDED")?;
        let mut client = tokio::select! {
            biased;
            _ = cancel.cancelled() => anyhow::bail!("AUTOMATION_APPLICATION_READ_CANCELLED"),
            value = connection.lock() => value,
        };
        let origin = self
            .origin
            .upgrade()
            .context("AUTOMATION_APPLICATION_SOURCE_ENDED")?;
        ensure!(
            client
                .native_origin()
                .is_some_and(|current| Arc::ptr_eq(&current, &origin)),
            "AUTOMATION_APPLICATION_SOURCE_CHANGED"
        );
        permission.verify_current(native, self)?;
        let value = client
            .read_native_resource(permission.resource_uri(), &self.engine.state.cwd(), cancel)
            .await?;
        drop(client);
        permission.verify_current(native, self)?;
        self.verify_current(native)?;
        Ok(value)
    }
}

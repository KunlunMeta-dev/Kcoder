//! Register real Office tools without creating storage before a Native write call.
use super::native_host::{
    NativeOfficeComposition, NativeOfficeInstalledPaths, NativeOfficeProviders,
};
use crate::app_server::integrations::core::NativeIntegrationContext;
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_config::PrivateDirectory;
use kcoder_engine::{QueryEngine, integrations::office::*};
use kcoder_tools::{ToolContext, ToolError, ToolRegistry, integrations::office::*};
use kcoder_types::integrations::{core::IntegrationOwner, office::*};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
#[cfg(test)]
#[path = "lazy_session_tests.rs"]
mod tests;

struct Inner {
    context: NativeIntegrationContext,
    engine: QueryEngine,
    installed: NativeOfficeInstalledPaths,
    providers: NativeOfficeProviders,
    source_revision: String,
    resolve: OfficeToolOwnerResolver,
    configured_enabled: bool,
    composition: Mutex<Option<Arc<NativeOfficeComposition>>>,
}
#[derive(Clone)]
pub(crate) struct NativeOfficeLazySession {
    inner: Arc<Inner>,
}
impl NativeOfficeLazySession {
    pub(crate) fn for_current_turn(
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        installed: NativeOfficeInstalledPaths,
        providers: NativeOfficeProviders,
        source_revision: String,
        resolve: OfficeToolOwnerResolver,
    ) -> Result<Self> {
        context.verify()?;
        check_engine(context, engine)?;
        let settings = engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("OFFICE_SETTINGS_UNAVAILABLE"))?
            .integrations
            .office
            .clone();
        settings.validate()?;
        ensure!(
            !source_revision.is_empty()
                && source_revision.len() <= 128
                && !source_revision.chars().any(char::is_control),
            "OFFICE_NATIVE_SOURCE_REVISION_REQUIRED"
        );
        if settings.enabled {
            ensure!(
                providers.tasks.is_some(),
                "OFFICE_NATIVE_TASK_PROVIDER_UNAVAILABLE"
            );
            ensure!(
                (engine.effective_studio_work_mode() == kcoder_types::StudioWorkMode::Kworker
                    || engine.native_core_workflow_office_child_allowed())
                    && engine.state.session_mode() == kcoder_state::SessionMode::Default,
                "OFFICE_KWORKER_TURN_REQUIRED"
            );
        }
        Ok(Self {
            inner: Arc::new(Inner {
                context: context.recapture_for_owned_service()?,
                engine: engine.clone(),
                installed,
                providers,
                source_revision,
                resolve,
                configured_enabled: settings.enabled,
                composition: Mutex::new(None),
            }),
        })
    }
    pub(crate) fn registry(&self) -> Result<ToolRegistry> {
        self.inner.context.verify()?;
        check_engine(&self.inner.context, &self.inner.engine)?;
        let mut registry = ToolRegistry::new();
        if !self.inner.configured_enabled
            || !self
                .inner
                .engine
                .settings
                .read()
                .map_err(|_| anyhow::anyhow!("OFFICE_SETTINGS_UNAVAILABLE"))?
                .integrations
                .office
                .enabled
        {
            return Ok(registry);
        }
        self.inner.check()?;
        let backend = self.tool_backend()?;
        for tool in [
            Arc::new(OfficeReadTool::new(backend.clone())?) as Arc<dyn kcoder_tools::Tool>,
            Arc::new(OfficeDataTool::new(backend.clone())?),
            Arc::new(OfficeDocumentTool::new(backend.clone())?),
            Arc::new(OfficeCardTool::new(backend.clone())?),
            Arc::new(OfficeExportTool::new(backend)?),
        ] {
            registry.try_register(tool)?;
        }
        Ok(registry)
    }
    /// A finite native consumer can reuse the same checked lazy backend without
    /// registering or invoking a second tool. This does not initialize storage.
    pub(crate) fn tool_backend(&self) -> Result<Arc<dyn OfficeToolBackend>> {
        self.inner.check()?;
        Ok(Arc::new(LazyBackend {
            inner: self.inner.clone(),
        }))
    }
    pub(crate) fn projection_authority(&self) -> Arc<dyn NativeOfficeToolProjectionAuthority> {
        Arc::new(LazyProjection {
            inner: self.inner.clone(),
        })
    }
}
impl Inner {
    fn check(&self) -> Result<()> {
        self.context.verify()?;
        check_engine(&self.context, &self.engine)?;
        let settings = self
            .engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("OFFICE_SETTINGS_UNAVAILABLE"))?
            .integrations
            .office
            .clone();
        settings.validate()?;
        ensure!(
            self.configured_enabled && settings.enabled,
            "OFFICE_DISABLED"
        );
        ensure!(
            (self.engine.effective_studio_work_mode() == kcoder_types::StudioWorkMode::Kworker
                || self.engine.native_core_workflow_office_child_allowed())
                && self.engine.state.session_mode() == kcoder_state::SessionMode::Default,
            "OFFICE_KWORKER_TURN_REQUIRED"
        );
        Ok(())
    }
    fn composition(
        &self,
        first_write_operation: Option<&str>,
    ) -> Result<Option<Arc<NativeOfficeComposition>>> {
        self.check()?;
        let mut slot = self
            .composition
            .lock()
            .map_err(|_| anyhow::anyhow!("OFFICE_NATIVE_STORE_UNCONFIRMED"))?;
        if let Some(current) = slot.as_ref() {
            current.verify(&self.context)?;
            return Ok(Some(current.clone()));
        }
        if let Some(current) = NativeOfficeComposition::observe(
            &self.context,
            &self.engine,
            self.installed.clone(),
            self.providers.clone(),
        )? {
            let current = Arc::new(current);
            *slot = Some(current.clone());
            return Ok(Some(current));
        }
        let Some(operation) = first_write_operation else {
            return Ok(None);
        };
        let current = Arc::new(NativeOfficeComposition::initialize(
            &self.context,
            &self.engine,
            self.installed.clone(),
            self.providers.clone(),
            operation,
        )?);
        *slot = Some(current.clone());
        Ok(Some(current))
    }
    fn backend(
        &self,
        ctx: &ToolContext,
        tool: &str,
        initialize: bool,
    ) -> Result<OfficeNativeToolBackend> {
        self.check()?;
        ensure!(!ctx.is_aborted(), "OFFICE_CANCELLED");
        let mut owner = (self.resolve)(ctx)?;
        self.context.validate_scope(&owner.scope)?;
        ensure!(
            owner.state_identity.matches(&ctx.state)
                && ctx.state.session_id() == self.engine.session_id()
                && owner.task.thread_id == self.engine.session_id()
                && ctx.tool_call_id.as_deref() == Some(owner.native_call_id.as_str()),
            "OFFICE_NATIVE_CALL_OWNER_MISMATCH"
        );
        self.providers
            .tasks
            .as_ref()
            .context("OFFICE_NATIVE_TASK_PROVIDER_UNAVAILABLE")?
            .validate(&self.context, &self.engine, &owner.task)?;
        // The Native call identity is authoritative. Caller JSON and request IDs
        // cannot allocate a second action for an uncertain replay.
        owner.operation_id = format!(
            "office-call-{:x}",
            Sha256::digest(serde_json::to_vec(&(
                IntegrationOwner::from(&owner.scope),
                &owner.task,
                &owner.native_call_id,
                tool
            ))?)
        );
        let current = self
            .composition(initialize.then_some(owner.operation_id.as_str()))?
            .context("OFFICE_NATIVE_STORE_UNCONFIRMED")?;
        ensure!(!ctx.is_aborted(), "OFFICE_CANCELLED");
        let scope = owner.scope;
        let task = owner.task;
        let identity = owner.state_identity;
        let call = owner.native_call_id;
        let operation = owner.operation_id;
        let captured: OfficeToolOwnerResolver = Arc::new(move |actual| {
            ensure!(
                identity.matches(&actual.state)
                    && actual.tool_call_id.as_deref() == Some(call.as_str()),
                "OFFICE_NATIVE_CALL_OWNER_MISMATCH"
            );
            Ok(OfficeNativeToolOwner {
                scope: scope.clone(),
                task: task.clone(),
                state_identity: identity.clone(),
                native_call_id: call.clone(),
                operation_id: operation.clone(),
            })
        });
        OfficeNativeToolBackend::new(current.service(), self.source_revision.clone(), captured)
    }
}
fn check_engine(context: &NativeIntegrationContext, engine: &QueryEngine) -> Result<()> {
    context.verify()?;
    let settings = engine
        .native_settings_source_path()
        .context("OFFICE_NATIVE_PROFILE_UNAVAILABLE")?;
    let profile = PrivateDirectory::open_existing(
        settings
            .parent()
            .context("OFFICE_NATIVE_PROFILE_UNAVAILABLE")?,
    )?;
    let workspace = PrivateDirectory::open_existing(&engine.state.cwd())?;
    ensure!(
        profile.directory_identity()? == context.profile()?.directory_identity()?
            && workspace.directory_identity()? == context.workspace_directory_identity()?,
        "OFFICE_NATIVE_CALL_OWNER_MISMATCH"
    );
    Ok(())
}
fn public(error: anyhow::Error) -> ToolError {
    let code = error
        .chain()
        .find_map(|cause| office_public_error_code(&cause.to_string()))
        .unwrap_or("OFFICE_OPERATION_FAILED");
    ToolError::Execution(code.into())
}
struct LazyBackend {
    inner: Arc<Inner>,
}
#[async_trait]
#[kcoder_async_box::shared]
impl OfficeToolBackend for LazyBackend {
    fn source_revision(&self) -> &str {
        &self.inner.source_revision
    }
    async fn create_document(
        &self,
        specification: OfficeGenerationSpec,
        sources: Vec<OfficeResourceRef>,
        original_input: Value,
        ctx: &ToolContext,
    ) -> Result<Value, ToolError> {
        self.inner
            .backend(ctx, "OfficeDocument", true)
            .map_err(public)?
            .create_document(specification, sources, original_input, ctx)
            .await
    }
    async fn create_card(
        &self,
        title: String,
        presentation: OfficeArtifactPresentation,
        sources: Vec<OfficeResourceRef>,
        original_input: Value,
        ctx: &ToolContext,
    ) -> Result<Value, ToolError> {
        self.inner
            .backend(ctx, "OfficeCard", true)
            .map_err(public)?
            .create_card(title, presentation, sources, original_input, ctx)
            .await
    }
    async fn export_artifact(
        &self,
        source: OfficeExportSource,
        reference: OfficeArtifactRef,
        format: OfficeFileFormat,
        ctx: &ToolContext,
    ) -> Result<Value, ToolError> {
        self.inner
            .backend(ctx, "OfficeExport", false)
            .map_err(public)?
            .export_artifact(source, reference, format, ctx)
            .await
    }
    async fn read_input(
        &self,
        reference: OfficeArtifactRef,
        cursor: Option<String>,
        limit: usize,
        ctx: &ToolContext,
    ) -> Result<Value, ToolError> {
        self.inner
            .backend(ctx, "OfficeRead", false)
            .map_err(public)?
            .read_input(reference, cursor, limit, ctx)
            .await
    }
    async fn read_canonical_source(
        &self,
        parameters: OfficeCanonicalSourceReadParams,
        ctx: &ToolContext,
    ) -> Result<Value, ToolError> {
        self.inner
            .backend(ctx, "OfficeData", false)
            .map_err(public)?
            .read_canonical_source(parameters, ctx)
            .await
    }
    async fn read_data(
        &self,
        action: OfficeDataAction,
        reference: OfficeArtifactRef,
        query: Option<OfficeDatasetQuery>,
        ctx: &ToolContext,
    ) -> Result<Value, ToolError> {
        self.inner
            .backend(ctx, "OfficeData", false)
            .map_err(public)?
            .read_data(action, reference, query, ctx)
            .await
    }
}
struct LazyProjection {
    inner: Arc<Inner>,
}
#[async_trait]
#[kcoder_async_box::shared]
impl NativeOfficeToolProjectionAuthority for LazyProjection {
    async fn resolve(
        &self,
        request: &NativeOfficeToolProjectionRequest<'_>,
    ) -> Result<Option<NativeOfficeToolProjection>> {
        self.inner.check()?;
        ensure!(
            request.session_id == self.inner.engine.session_id(),
            "OFFICE_NATIVE_CALL_OWNER_MISMATCH"
        );
        let Some(current) = self.inner.composition(None)? else {
            return Ok(None);
        };
        current
            .projection_authority(&self.inner.context)?
            .resolve(request)
            .await
    }
}

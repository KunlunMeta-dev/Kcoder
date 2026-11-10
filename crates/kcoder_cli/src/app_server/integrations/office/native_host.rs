//! Office composition over real native identity, current policy and held resources.
use super::OfficeNodeGenerator;
use crate::app_server::integrations::core::{
    NativeDomain, NativeDomainGuard, NativeIntegrationContext,
};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_config::{PrivateDirectory, integrations::office::OfficeSettings};
use kcoder_engine::{QueryEngine, integrations::office::*};
use kcoder_state::integrations::office::{OfficeInputReceipt, OfficeStore};
use kcoder_tools::ToolContext;
use kcoder_types::integrations::{core::*, office::*};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, sync::Arc};
use tokio_util::sync::CancellationToken;
#[path = "application_results.rs"]
mod application_results;
#[cfg(test)]
#[path = "native_host_tests.rs"]
mod tests;

pub(crate) use kcoder_office_worker::installed_resources::NativeOfficeInstalledPaths;

pub(crate) trait NativeOfficeTaskAuthority: Send + Sync {
    /// Check actual accepted Native task/turn facts, not the shape of an ID.
    fn validate(
        &self,
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        task: &OfficeTaskRef,
    ) -> Result<()>;
}
/// Ordinary personal app-server turns can be checked against the existing
/// private Accepted ledger. Workflow/child ownership uses Root's wider adapter.
pub(crate) struct NativeOfficeAcceptedTurnAuthority;
impl NativeOfficeTaskAuthority for NativeOfficeAcceptedTurnAuthority {
    fn validate(
        &self,
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        task: &OfficeTaskRef,
    ) -> Result<()> {
        context.verify()?;
        validate_engine(context, engine)?;
        ensure!(
            task.thread_id == engine.session_id() && task.run_id.is_none(),
            "OFFICE_NATIVE_TASK_PROVIDER_UNAVAILABLE"
        );
        let store = kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing(
            &engine.session_storage_dir_for(&task.thread_id),
            &task.thread_id,
        )?
        .context("OFFICE_NATIVE_TASK_NOT_FOUND")?;
        ensure!(
            store
                .list()?
                .iter()
                .any(|record| record.identity.thread_id == task.thread_id
                    && record.identity.turn_id == task.turn_id
                    && record.status.is_known()),
            "OFFICE_NATIVE_TASK_NOT_FOUND"
        );
        Ok(())
    }
}
#[async_trait]
pub(crate) trait NativeOfficePorts: Send + Sync {
    async fn call(
        &self,
        context: &NativeIntegrationContext,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<IntegrationReply>;
}
#[async_trait]
pub(crate) trait NativeOfficeAssets: Send + Sync {
    async fn validate_sources(
        &self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        sources: &[OfficeResourceRef],
        cancel: &CancellationToken,
    ) -> Result<Vec<OfficeCanonicalInputIdentity>>;
    async fn prepare_input(
        &self,
        _context: &NativeIntegrationContext,
        _request: &IntegrationRequest,
        _cancel: &CancellationToken,
    ) -> Result<OfficeInputReceipt> {
        anyhow::bail!("OFFICE_INPUT_PROVIDER_UNAVAILABLE")
    }
    async fn read_input(
        &self,
        _context: &NativeIntegrationContext,
        _request: &IntegrationRequest,
        _reference: &OfficeArtifactRef,
        _cursor: Option<&str>,
        _limit: usize,
        _tool: &ToolContext,
    ) -> Result<Value> {
        anyhow::bail!("OFFICE_INPUT_PROVIDER_UNAVAILABLE")
    }
    async fn accept_written(
        &self,
        _context: &NativeIntegrationContext,
        _request: &IntegrationRequest,
        _cancel: &CancellationToken,
    ) -> Result<OfficePublishedContent> {
        anyhow::bail!("OFFICE_NATIVE_ARTIFACT_UNAVAILABLE")
    }
    async fn prepare_export(
        &self,
        _context: &NativeIntegrationContext,
        _request: &IntegrationRequest,
        _manifest: &OfficeArtifactManifest,
        _bytes: Vec<u8>,
        _cancel: &CancellationToken,
    ) -> Result<Value> {
        anyhow::bail!("OFFICE_EXPORT_PROVIDER_UNAVAILABLE")
    }
    async fn verify(
        &self,
        _context: &NativeIntegrationContext,
        _request: &IntegrationRequest,
        _manifest: &OfficeArtifactManifest,
        _bytes: Vec<u8>,
        _cancel: &CancellationToken,
    ) -> Result<OfficeVerification> {
        anyhow::bail!("OFFICE_VERIFICATION_PROVIDER_UNAVAILABLE")
    }
    async fn authorize_action(
        &self,
        _context: &NativeIntegrationContext,
        _request: &IntegrationRequest,
        _intent: &Value,
        _cancel: &CancellationToken,
    ) -> Result<()> {
        anyhow::bail!("OFFICE_ACTION_AUTHORIZATION_UNAVAILABLE")
    }
}
#[derive(Clone, Default)]
pub(crate) struct NativeOfficeProviders {
    pub tasks: Option<Arc<dyn NativeOfficeTaskAuthority>>,
    pub ports: Option<Arc<dyn NativeOfficePorts>>,
    pub assets: Option<Arc<dyn NativeOfficeAssets>>,
}

struct Binding {
    context: NativeIntegrationContext,
    guard: NativeDomainGuard,
    engine: QueryEngine,
    settings: OfficeSettings,
    store: Arc<OfficeStore>,
}
impl Binding {
    fn check(&self, scope: &IntegrationScope) -> Result<()> {
        self.context.validate_scope(scope)?;
        self.context.verify()?;
        super::organization_policy::verify(&self.context)?;
        validate_engine(&self.context, &self.engine)?;
        let current = office_settings(&self.engine)?;
        ensure!(
            current.enabled
                && serde_json::to_value(&current)? == serde_json::to_value(&self.settings)?,
            "OFFICE_SCOPE_CHANGED"
        );
        let namespace = self.guard.directory(self.context.profile()?)?;
        let held = namespace
            .open_entry_handle(OsStr::new("data"))?
            .open_child_directory()?;
        ensure!(
            held.directory_identity()? == self.store.storage_directory_identity()?
                && self.store.owner() == &IntegrationOwner::from(scope),
            "OFFICE_NATIVE_STORE_UNCONFIRMED"
        );
        Ok(())
    }
}
struct NativeHost {
    binding: Arc<Binding>,
    generator: Option<Arc<OfficeNodeGenerator>>,
    providers: NativeOfficeProviders,
}

pub(crate) struct NativeOfficeComposition {
    binding: Arc<Binding>,
    service: Arc<OfficeService>,
}
impl NativeOfficeComposition {
    pub(crate) fn observe(
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        installed: NativeOfficeInstalledPaths,
        providers: NativeOfficeProviders,
    ) -> Result<Option<Self>> {
        validate_engine(context, engine)?;
        let settings = office_settings(engine)?;
        if !settings.enabled {
            return Ok(None);
        }
        let Some(guard) =
            NativeDomainGuard::observe(context.profile()?, context.scope(), NativeDomain::Office)?
        else {
            return Ok(None);
        };
        let namespace = guard.directory(context.profile()?)?;
        let store = OfficeStore::open_in(
            &namespace,
            OsStr::new("data"),
            IntegrationOwner::from(context.scope()),
        )?
        .context("OFFICE_NATIVE_STORE_UNCONFIRMED")?;
        Self::assemble(
            context,
            engine,
            settings,
            guard,
            store,
            Some(installed),
            providers,
        )
        .map(Some)
    }
    /// Invoke only for an actual authorized first mutation. Reads use observe.
    pub(crate) fn initialize(
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        installed: NativeOfficeInstalledPaths,
        providers: NativeOfficeProviders,
        operation_id: &str,
    ) -> Result<Self> {
        validate_engine(context, engine)?;
        let settings = office_settings(engine)?;
        ensure!(settings.enabled, "OFFICE_DISABLED");
        if let Some(guard) =
            NativeDomainGuard::observe(context.profile()?, context.scope(), NativeDomain::Office)?
        {
            let namespace = guard.directory(context.profile()?)?;
            let store = OfficeStore::open_in(
                &namespace,
                OsStr::new("data"),
                IntegrationOwner::from(context.scope()),
            )?
            .context("OFFICE_NATIVE_STORE_UNCONFIRMED")?;
            return Self::assemble(
                context,
                engine,
                settings,
                guard,
                store,
                Some(installed),
                providers,
            );
        }
        super::organization_policy::authorize(context, "write", operation_id)?;
        let (guard, store) = NativeDomainGuard::initialize(
            context.profile()?,
            context.scope(),
            NativeDomain::Office,
            operation_id,
            |namespace| {
                OfficeStore::create_in(
                    namespace,
                    OsStr::new("data"),
                    IntegrationOwner::from(context.scope()),
                )
            },
        )?;
        Self::assemble(
            context,
            engine,
            settings,
            guard,
            store,
            Some(installed),
            providers,
        )
    }
    /// Existing metadata never needs a Node probe or creates a missing namespace.
    pub(crate) fn observe_metadata(
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        providers: NativeOfficeProviders,
    ) -> Result<Option<Self>> {
        validate_engine(context, engine)?;
        let settings = office_settings(engine)?;
        ensure!(settings.enabled, "OFFICE_DISABLED");
        let Some(guard) =
            NativeDomainGuard::observe(context.profile()?, context.scope(), NativeDomain::Office)?
        else {
            return Ok(None);
        };
        let namespace = guard.directory(context.profile()?)?;
        let store = OfficeStore::open_in(
            &namespace,
            OsStr::new("data"),
            IntegrationOwner::from(context.scope()),
        )?
        .context("OFFICE_NATIVE_STORE_UNCONFIRMED")?;
        Self::assemble(context, engine, settings, guard, store, None, providers).map(Some)
    }

    /// Called only for the authenticated user's explicit first management write.
    pub(crate) fn initialize_metadata(
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        providers: NativeOfficeProviders,
        operation_id: &str,
    ) -> Result<Self> {
        if let Some(existing) = Self::observe_metadata(context, engine, providers.clone())? {
            return Ok(existing);
        }
        let settings = office_settings(engine)?;
        super::organization_policy::authorize(context, "write", operation_id)?;
        let (guard, store) = NativeDomainGuard::initialize(
            context.profile()?,
            context.scope(),
            NativeDomain::Office,
            operation_id,
            |namespace| {
                OfficeStore::create_in(
                    namespace,
                    OsStr::new("data"),
                    IntegrationOwner::from(context.scope()),
                )
            },
        )?;
        Self::assemble(context, engine, settings, guard, store, None, providers)
    }

    fn assemble(
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        settings: OfficeSettings,
        guard: NativeDomainGuard,
        store: OfficeStore,
        installed: Option<NativeOfficeInstalledPaths>,
        providers: NativeOfficeProviders,
    ) -> Result<Self> {
        let binding = Arc::new(Binding {
            context: context.recapture_for_owned_service()?,
            guard,
            engine: engine.clone(),
            settings: settings.clone(),
            store: Arc::new(store),
        });
        binding.check(context.scope())?;
        let mut providers = providers;
        providers.ports = Some(Arc::new(
            super::super::core::model_policy::NativeOfficeModelPorts::capture(
                context,
                engine,
                providers.ports.take(),
            )?,
        ));
        let host = Arc::new(NativeHost {
            binding: binding.clone(),
            generator: installed.map(NativeOfficeInstalledPaths::into_generator),
            providers,
        });
        let service = Arc::new(OfficeService::new(binding.store.clone(), settings, host)?);
        Ok(Self { binding, service })
    }
    pub(crate) fn service(&self) -> Arc<OfficeService> {
        self.service.clone()
    }
    pub(crate) fn artifact_task(&self, reference: &OfficeArtifactRef) -> Result<OfficeTaskRef> {
        self.binding.check(self.binding.context.scope())?;
        let request_id = format!("office-task-{}", uuid::Uuid::new_v4());
        super::organization_policy::authorize(&self.binding.context, "read", &request_id)?;
        let task = self
            .binding
            .store
            .read_artifact(reference)?
            .context("OFFICE_ARTIFACT_NOT_FOUND")?
            .task;
        super::organization_policy::authorize(&self.binding.context, "read", &request_id)?;
        Ok(task)
    }
    /// Return only real Office contributions. Root merges with its actual
    /// registry and applies current task ceilings/guards; no default TUI change.
    #[cfg(test)]
    pub(crate) fn tool_registry(
        &self,
        context: &NativeIntegrationContext,
        source_revision: String,
        resolve: OfficeToolOwnerResolver,
    ) -> Result<kcoder_tools::ToolRegistry> {
        self.verify(context)?;
        use kcoder_tools::integrations::office::{
            OfficeCardTool, OfficeDataTool, OfficeDocumentTool, OfficeExportTool, OfficeReadTool,
            OfficeToolBackend,
        };
        let backend: Arc<dyn OfficeToolBackend> = Arc::new(OfficeNativeToolBackend::new(
            self.service.clone(),
            source_revision,
            resolve,
        )?);
        let mut tools = kcoder_tools::ToolRegistry::new();
        for tool in [
            Arc::new(OfficeReadTool::new(backend.clone())?) as Arc<dyn kcoder_tools::Tool>,
            Arc::new(OfficeDataTool::new(backend.clone())?),
            Arc::new(OfficeDocumentTool::new(backend.clone())?),
            Arc::new(OfficeCardTool::new(backend.clone())?),
            Arc::new(OfficeExportTool::new(backend)?),
        ] {
            tools.try_register(tool)?;
        }
        Ok(tools)
    }
    pub(crate) fn projection_authority(
        &self,
        context: &NativeIntegrationContext,
    ) -> Result<Arc<dyn NativeOfficeToolProjectionAuthority>> {
        self.verify(context)?;
        let binding = self.binding.clone();
        let resolver: OfficeProjectionScopeResolver = Arc::new(move |session| {
            binding.check(binding.context.scope())?;
            ensure!(
                session == binding.engine.session_id(),
                "OFFICE_NATIVE_CALL_OWNER_MISMATCH"
            );
            Ok(binding.context.scope().clone())
        });
        Ok(Arc::new(OfficeNativeProjectionAuthority::new(
            self.service.clone(),
            resolver,
        )))
    }
    pub(crate) fn verify(&self, context: &NativeIntegrationContext) -> Result<()> {
        context.verify()?;
        self.binding.check(context.scope())
    }
    pub(crate) async fn dispatch(
        &self,
        context: &NativeIntegrationContext,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<IntegrationReply> {
        self.verify(context)?;
        context.validate_scope(&request.scope)?;
        let reply = super::dispatch(method, request, &self.service, cancel).await;
        self.verify(context)?;
        if matches!(
            reply.status,
            IntegrationStatus::Completed | IntegrationStatus::Accepted
        ) {
            let method_kind =
                kcoder_app_protocol::integrations::office::OfficeMethod::parse(method)
                    .context("OFFICE_METHOD_UNSUPPORTED")?;
            if let Err(error) = super::organization_policy::authorize_office_action(
                context,
                method_kind.action(),
                &request.request_id,
            ) {
                return Ok(super::reply_result(
                    method,
                    request,
                    Err(if method_kind.is_mutation() {
                        anyhow::anyhow!("OFFICE_RECONCILIATION_REQUIRED")
                    } else {
                        error
                    }),
                ));
            }
        }
        Ok(reply)
    }
}

fn office_settings(engine: &QueryEngine) -> Result<OfficeSettings> {
    let settings = engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("OFFICE_SETTINGS_UNAVAILABLE"))?
        .integrations
        .office
        .clone();
    settings.validate()?;
    Ok(settings)
}
fn validate_engine(context: &NativeIntegrationContext, engine: &QueryEngine) -> Result<()> {
    context.verify()?;
    super::organization_policy::verify(context)?;
    let path = engine
        .native_settings_source_path()
        .context("OFFICE_NATIVE_PROFILE_UNAVAILABLE")?;
    ensure!(path.is_absolute(), "OFFICE_NATIVE_PROFILE_UNAVAILABLE");
    let profile = PrivateDirectory::open_existing(
        path.parent().context("OFFICE_NATIVE_PROFILE_UNAVAILABLE")?,
    )?;
    ensure!(
        profile.directory_identity()? == context.profile()?.directory_identity()?,
        "OFFICE_NATIVE_PROFILE_MISMATCH"
    );
    let workspace = PrivateDirectory::open_existing(&engine.state.cwd())?;
    ensure!(
        workspace.directory_identity()? == context.workspace_directory_identity()?,
        "OFFICE_NATIVE_WORKSPACE_MISMATCH"
    );
    Ok(())
}

#[async_trait]
#[kcoder_async_box::shared]
impl OfficeHost for NativeHost {
    fn validate_scope(&self, scope: &IntegrationScope) -> Result<()> {
        self.binding.check(scope)
    }
    fn validate_task(&self, scope: &IntegrationScope, task: &OfficeTaskRef) -> Result<()> {
        self.binding.check(scope)?;
        self.providers
            .tasks
            .as_ref()
            .context("OFFICE_NATIVE_TASK_PROVIDER_UNAVAILABLE")?
            .validate(&self.binding.context, &self.binding.engine, task)
    }
    async fn validate_sources(
        &self,
        request: &IntegrationRequest,
        sources: &[OfficeResourceRef],
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.resolve_source_content_identities(request, sources, cancel)
            .await
            .map(|_| ())
    }
    async fn resolve_source_content_identities(
        &self,
        request: &IntegrationRequest,
        sources: &[OfficeResourceRef],
        cancel: &CancellationToken,
    ) -> Result<Vec<OfficeCanonicalInputIdentity>> {
        self.binding.check(&request.scope)?;
        if cancel.is_cancelled() {
            anyhow::bail!("OFFICE_CANCELLED")
        }
        if sources.is_empty() {
            return Ok(Vec::new());
        }
        super::organization_policy::authorize(&self.binding.context, "read", &request.request_id)?;
        if sources.iter().all(|source| source.kind == "dataset") {
            let mut identities = Vec::new();
            for source in sources {
                source.validate()?;
                let revision = source
                    .revision
                    .parse::<u64>()
                    .context("OFFICE_INPUT_REVISION_MISMATCH")?;
                let data = self
                    .binding
                    .store
                    .read_dataset(&OfficeArtifactRef {
                        id: source.id.clone(),
                        revision,
                    })?
                    .context("OFFICE_DATASET_NOT_FOUND")?;
                ensure!(
                    data.owner == IntegrationOwner::from(&request.scope),
                    "OFFICE_OWNER_MISMATCH"
                );
                identities.push(OfficeCanonicalInputIdentity {
                    reference: source.clone(),
                    sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(&data)?)),
                });
            }
            super::organization_policy::authorize(
                &self.binding.context,
                "read",
                &request.request_id,
            )?;
            return Ok(identities);
        }
        let actual = self
            .providers
            .assets
            .as_ref()
            .context("OFFICE_SOURCE_IDENTITIES_UNAVAILABLE")?
            .validate_sources(&self.binding.context, request, sources, cancel)
            .await?;
        ensure!(
            actual
                .iter()
                .map(|item| &item.reference)
                .collect::<Vec<_>>()
                == sources.iter().collect::<Vec<_>>(),
            "OFFICE_CANONICAL_INPUT_IDENTITY_MISMATCH"
        );
        for identity in &actual {
            identity.validate()?;
        }
        self.binding.check(&request.scope)?;
        super::organization_policy::authorize(&self.binding.context, "read", &request.request_id)?;
        Ok(actual)
    }
    async fn call_port(
        &self,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<IntegrationReply> {
        self.binding.check(&request.scope)?;
        request.validate_method(port, method)?;
        if port == IntegrationPort::Policy && method == "evaluateAction" {
            let action = request
                .payload
                .get("action")
                .and_then(Value::as_str)
                .context("OFFICE_POLICY_UNCONFIRMED")?;
            let allow = super::organization_policy::required_actions(action).is_some();
            let revision = if allow {
                super::organization_policy::authorize_office_action(
                    &self.binding.context,
                    action,
                    &request.request_id,
                )?
            } else {
                super::organization_policy::verify(&self.binding.context)?
            };
            let policy_revision = revision.map_or_else(
                || {
                    format!(
                        "personal-owner:{}",
                        self.binding.context.scope().target_revision
                    )
                },
                |revision| format!("organization:{revision}"),
            );
            let result = json!({"decision":if allow{"allow"}else{"deny"},"policyRevision":policy_revision,"reasonCode":if allow{"current_native_authority"}else{"provider_required"}});
            return Ok(IntegrationReply {
                contract_version: request.contract_version,
                request_id: request.request_id.clone(),
                status: IntegrationStatus::Completed,
                operation_id: request
                    .operation_id
                    .clone()
                    .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
                entity_revision: IntegrationNullable::Null,
                observed_at: chrono::Utc::now().to_rfc3339(),
                result: IntegrationNullable::Value(
                    result
                        .as_object()
                        .context("OFFICE_POLICY_UNCONFIRMED")?
                        .clone(),
                ),
                error: IntegrationNullable::Null,
            });
        }
        self.providers
            .ports
            .as_ref()
            .context("OFFICE_PORT_UNAVAILABLE")?
            .call(&self.binding.context, port, method, request, cancel)
            .await
    }
    async fn generate(
        &self,
        request: &IntegrationRequest,
        specification: &Value,
        cancel: &CancellationToken,
    ) -> Result<OfficeGeneratedFile> {
        self.binding.check(&request.scope)?;
        super::organization_policy::authorize_office_action(
            &self.binding.context,
            "office.document.generate",
            &request.request_id,
        )?;
        let typed: OfficeGenerationSpec = rpc_codec::decode(specification.clone())?;
        typed.validate()?;
        let kind = match typed.kind {
            OfficeGenerationKind::Docx => OfficeFileFormat::Docx,
            OfficeGenerationKind::Xlsx => OfficeFileFormat::Xlsx,
            OfficeGenerationKind::Pptx => OfficeFileFormat::Pptx,
        };
        ensure!(
            self.binding.settings.allowed_formats.contains(&kind),
            "OFFICE_FORMAT_UNAVAILABLE"
        );
        let result = self
            .generator
            .as_ref()
            .context("OFFICE_DEPENDENCY_UNAVAILABLE")?
            .generate(
                specification,
                self.binding.settings.generation_timeout_ms,
                cancel,
            )
            .await?;
        self.binding.check(&request.scope)?;
        super::organization_policy::authorize_office_action(
            &self.binding.context,
            "office.document.generate",
            &request.request_id,
        )
        .map_err(|_| anyhow::anyhow!("OFFICE_RECONCILIATION_REQUIRED"))?;
        Ok(result)
    }
    async fn generator_readiness(
        &self,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.binding.check(&request.scope)?;
        self.generator
            .as_ref()
            .context("OFFICE_DEPENDENCY_UNAVAILABLE")?
            .readiness(cancel)
            .await
    }
    async fn prepare_export(
        &self,
        request: &IntegrationRequest,
        manifest: &OfficeArtifactManifest,
        bytes: Vec<u8>,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.binding.check(&request.scope)?;
        self.providers
            .assets
            .as_ref()
            .context("OFFICE_EXPORT_PROVIDER_UNAVAILABLE")?
            .prepare_export(&self.binding.context, request, manifest, bytes, cancel)
            .await
    }
    async fn verify(
        &self,
        request: &IntegrationRequest,
        manifest: &OfficeArtifactManifest,
        bytes: Vec<u8>,
        cancel: &CancellationToken,
    ) -> Result<OfficeVerification> {
        self.binding.check(&request.scope)?;
        self.providers
            .assets
            .as_ref()
            .context("OFFICE_VERIFICATION_PROVIDER_UNAVAILABLE")?
            .verify(&self.binding.context, request, manifest, bytes, cancel)
            .await
    }
    async fn prepare_input(
        &self,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<OfficeInputReceipt> {
        self.binding.check(&request.scope)?;
        self.providers
            .assets
            .as_ref()
            .context("OFFICE_INPUT_PROVIDER_UNAVAILABLE")?
            .prepare_input(&self.binding.context, request, cancel)
            .await
    }
    async fn read_input(
        &self,
        request: &IntegrationRequest,
        reference: &OfficeArtifactRef,
        cursor: Option<&str>,
        limit: usize,
        tool: &ToolContext,
    ) -> Result<Value> {
        self.binding.check(&request.scope)?;
        self.providers
            .assets
            .as_ref()
            .context("OFFICE_INPUT_PROVIDER_UNAVAILABLE")?
            .read_input(
                &self.binding.context,
                request,
                reference,
                cursor,
                limit,
                tool,
            )
            .await
    }
    async fn accept_written_artifact(
        &self,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<OfficePublishedContent> {
        self.binding.check(&request.scope)?;
        self.providers
            .assets
            .as_ref()
            .context("OFFICE_NATIVE_ARTIFACT_UNAVAILABLE")?
            .accept_written(&self.binding.context, request, cancel)
            .await
    }
    async fn authorize_artifact_action(
        &self,
        request: &IntegrationRequest,
        intent: &Value,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.binding.check(&request.scope)?;
        self.providers
            .assets
            .as_ref()
            .context("OFFICE_ACTION_AUTHORIZATION_UNAVAILABLE")?
            .authorize_action(&self.binding.context, request, intent, cancel)
            .await
    }
}

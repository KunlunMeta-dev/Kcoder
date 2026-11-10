//! Account-owned migration requests use native source grants and durable per-profile jobs.
use host::MigrationHost;
use kcoder_host_transport::protocol_io::{error_response, success_response};
use kcoder_migration_client::migration_view::{items_result, read_result};

pub mod host;
#[path = "../migration_source_authority.rs"]
pub mod migration_source_authority;
use anyhow::{Result, ensure};
use kcoder_app_protocol::*;
use kcoder_migration::{
    assets::{AssetResolution, AssetTarget},
    discovery::SourceRegistry,
    mcp::{McpResolution, McpTarget},
    providers::{ModelLimits, ProviderResolution, ProviderTarget},
    store::MigrationStore,
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
mod batch;
mod codex_layers;
mod configuration_layers;
mod continuation;
mod credentials;
mod definitions;
mod history;
mod instructions;
mod observations;
mod plugins;
mod projects;
mod source_bindings;
mod source_directory;
mod source_dispatch;
mod source_transfer;
mod source_upload;
mod undo;
pub use observations::MAX_HISTORY_OBSERVATIONS;
mod mcp_credentials;
mod memory;

pub struct MigrationProcessor {
    registry: Mutex<Option<SourceRegistry>>,
    project_targets: Mutex<projects::Targets>,
    instructions: Mutex<kcoder_migration::instruction_sources::InstructionSourceCatalog>,
    directory_choice: Mutex<Option<MigrationSourceDirectorySelectParams>>,
    uploaded_choice: Mutex<Option<MigrationSourceProductParams>>,
    history: history::HistoryWorkers,
    views: history::ViewWorkers,
    batch_workers: batch::BatchWorkers,
    transcript_cursor: history::TranscriptCursor,
    search_cursor: history::SearchCursor,
    branches: history::BranchWorkers,
    continuations: continuation::ContinuationWorkers,
    undos: undo::UndoWorkers,
    plugins: plugins::PluginWorkers,
    source_transfer_workers: source_transfer::SourceTransferWorkers,
    source_upload_workers: source_upload::UploadWorkers,
    source_attempt_owners: source_transfer::AttemptOwners,
    source_adoption_workers: source_transfer::AdoptionWorkers,
    observations: std::sync::Arc<tokio::sync::Semaphore>,
    history_worker_state_v1: AtomicBool,
}

impl MigrationProcessor {
    fn initialize_registry(
        &self,
        registry: &mut Option<SourceRegistry>,
        factory: &dyn MigrationHost,
    ) -> Result<()> {
        if registry.is_none() {
            ensure!(
                self.directory_choice
                    .lock()
                    .map_err(|_| anyhow::anyhow!("migration_busy"))?
                    .is_none(),
                "migration_selected_root_unavailable"
            );
            ensure!(
                self.uploaded_choice
                    .lock()
                    .map_err(|_| anyhow::anyhow!("migration_busy"))?
                    .is_none(),
                "source_upload_product_selection_unavailable"
            );
            *registry = Some(SourceRegistry::new(factory.migration_source_roots()?));
        }
        Ok(())
    }
    pub fn new() -> Self {
        let history = history::HistoryWorkers::default();
        Self {
            registry: Mutex::new(None),
            project_targets: Mutex::new(Default::default()),
            instructions: Mutex::new(Default::default()),
            directory_choice: Mutex::new(None),
            uploaded_choice: Mutex::new(None),
            views: history::ViewWorkers::new(history.cancellation()),
            batch_workers: batch::BatchWorkers::new(history.cancellation()),
            branches: history::BranchWorkers::new(history.cancellation()),
            continuations: continuation::ContinuationWorkers::new(history.cancellation()),
            undos: undo::UndoWorkers::new(history.cancellation()),
            plugins: plugins::PluginWorkers::new(history.cancellation()),
            source_transfer_workers: source_transfer::SourceTransferWorkers::new(
                history.cancellation(),
            ),
            source_attempt_owners: source_transfer::AttemptOwners::default(),
            source_upload_workers: source_upload::UploadWorkers::new(history.cancellation()),
            source_adoption_workers: source_transfer::AdoptionWorkers::new(history.cancellation()),
            history,
            observations: std::sync::Arc::new(tokio::sync::Semaphore::new(
                observations::ACTIVE_HISTORY_OBSERVATIONS,
            )),
            transcript_cursor: history::TranscriptCursor::default(),
            search_cursor: history::SearchCursor::default(),
            history_worker_state_v1: AtomicBool::new(false),
        }
    }

    pub fn negotiate_history_worker_state(&self, requested: bool) {
        self.history_worker_state_v1
            .store(requested, Ordering::Release);
    }

    fn project_history_worker_state(&self, operation: &str, mut value: Value) -> Value {
        if !self.history_worker_state_v1.load(Ordering::Acquire) {
            if operation == method::MIGRATION_HISTORY_JOBS {
                if let Some(jobs) = value.get_mut("jobs").and_then(Value::as_array_mut) {
                    for job in jobs {
                        if let Some(job) = job.as_object_mut() {
                            job.remove("workerState");
                        }
                    }
                }
            } else if matches!(
                operation,
                method::MIGRATION_HISTORY_CREATE
                    | method::MIGRATION_HISTORY_READ
                    | method::MIGRATION_HISTORY_RUN
                    | method::MIGRATION_HISTORY_CANCEL
                    | method::MIGRATION_HISTORY_RESUME
                    | method::MIGRATION_HISTORY_REINTERPRET_CREATE
            ) && let Some(result) = value.as_object_mut()
            {
                result.remove("workerState");
            }
        }
        value
    }

    pub fn history_observation(operation: &str) -> bool {
        observations::handles(operation)
    }
    pub async fn observation_permit(
        &self,
    ) -> Result<tokio::sync::OwnedSemaphorePermit, tokio::sync::AcquireError> {
        self.observations.clone().acquire_owned().await
    }
    pub fn history_control(operation: &str) -> bool {
        history::control(operation)
            || plugins::control(operation)
            || matches!(
                operation,
                method::MIGRATION_BATCH_RUN
                    | method::MIGRATION_BATCH_CONTROL_CANCEL
                    | method::MIGRATION_CANCEL
                    | method::MIGRATION_MEMORY_CONTROL
                    | method::MIGRATION_SOURCE_PRODUCT_RUN
                    | method::MIGRATION_SOURCE_PRODUCT_CANCEL
                    | method::MIGRATION_SOURCE_PRODUCT_RESUME
                    | method::MIGRATION_SOURCE_UPLOAD_CANCEL
                    | method::MIGRATION_SOURCE_UPLOAD_RESUME
                    | method::MIGRATION_SOURCE_UPLOAD_FINISH
            )
    }

    pub fn cancellation(&self) -> tokio_util::sync::CancellationToken {
        self.history.cancellation()
    }

    pub async fn shutdown(&self) {
        self.views.shutdown().await;
        self.source_attempt_owners.clear();
        self.history.shutdown().await;
        self.branches.shutdown().await;
        self.continuations.shutdown().await;
        self.undos.shutdown().await;
        self.plugins.shutdown().await;
        self.batch_workers.shutdown().await;
        self.source_transfer_workers.shutdown().await;
        self.source_upload_workers.shutdown().await;
        self.source_adoption_workers.shutdown().await;
    }

    pub fn activity(&self) -> usize {
        self.history.activity()
            + self.branches.activity()
            + self.continuations.activity()
            + self.undos.activity()
            + self.plugins.activity()
            + self.batch_workers.activity()
            + self.source_transfer_workers.activity()
            + self.source_upload_workers.activity()
            + self.source_attempt_owners.activity()
            + self.source_adoption_workers.activity()
    }

    pub fn process(
        &self,
        factory: &dyn MigrationHost,
        id: Value,
        operation: &str,
        params: Value,
    ) -> Value {
        if !projects::handles(operation)
            && !definitions::handles(operation)
            && !instructions::handles(operation)
            && !codex_layers::handles(operation)
            && !memory::handles(operation)
            && !source_upload::handles(operation)
            && !batch::handles(operation)
            && !plugins::handles(operation)
            && !history::handles(operation)
            && !continuation::handles(operation)
            && !undo::handles(operation)
            && !matches!(
                operation,
                method::MIGRATION_SOURCE_BINDINGS
                    | method::MIGRATION_SOURCE_DIRECTORY_SELECT
                    | method::MIGRATION_CONFIGURATION_LAYERS
                    | method::MIGRATION_DISCOVER
                    | method::MIGRATION_SCAN
                    | method::MIGRATION_READ
                    | method::MIGRATION_ITEMS
                    | method::MIGRATION_PROVIDER_PLAN
                    | method::MIGRATION_PROVIDER_APPLY
                    | method::MIGRATION_PROVIDER_ROLLBACK
                    | method::MIGRATION_CANCEL
                    | method::MIGRATION_MCP_PLAN
                    | method::MIGRATION_MCP_APPLY
                    | method::MIGRATION_MCP_ROLLBACK
                    | method::MIGRATION_ASSET_PLAN
                    | method::MIGRATION_ASSET_APPLY
                    | method::MIGRATION_ASSET_ROLLBACK
                    | method::MIGRATION_ASSET_PREVIEW
                    | method::MIGRATION_BATCH_SCAN
                    | method::MIGRATION_BATCH_RESOURCES_INCREASE
                    | method::MIGRATION_BATCH_PLAN
                    | method::MIGRATION_BATCH_APPLY
                    | method::MIGRATION_BATCH_ROLLBACK
                    | method::MIGRATION_BATCH_ITEM_PLAN
                    | method::MIGRATION_JOBS_LIST
                    | method::MIGRATION_CREDENTIAL_PLAN
                    | method::MIGRATION_CREDENTIAL_APPLY
                    | method::MIGRATION_CREDENTIAL_UNDO
                    | method::MIGRATION_MCP_CREDENTIAL_READ
                    | method::MIGRATION_BATCH_MCP_CREDENTIAL_READ
                    | method::MIGRATION_MCP_CREDENTIAL_PLAN
                    | method::MIGRATION_MCP_CREDENTIAL_APPLY
                    | method::MIGRATION_MCP_CREDENTIAL_UNDO
            )
        {
            return error_response(id, -32601, "migration_unknown_operation");
        }
        match self.execute(factory, operation, params) {
            Ok(value) => success_response(id, self.project_history_worker_state(operation, value)),
            Err(error) => {
                let io_error = error
                    .chain()
                    .find_map(|cause| cause.downcast_ref::<std::io::Error>());
                tracing::debug!(target: "kcoder::migration", operation,
                    io_code = io_error.and_then(std::io::Error::raw_os_error),
                    io_kind = ?io_error.map(std::io::Error::kind),
                    catalog_busy = kcoder_state::history_index::HistoryCatalogBusy::from_error(&error).is_some(),
                    "Migration operation rejected; private error text omitted");
                if let Some(contention) =
                    error.downcast_ref::<kcoder_migration::contention::MigrationContention>()
                {
                    tracing::debug!(target: "kcoder::migration", lease = contention.lease.label(), operation,
                        "Migration lease is busy");
                }
                let code = if plugins::handles(operation) {
                    plugins::safe_error(&error)
                } else {
                    safe_error(&error)
                };
                error_response(id, -32047, &code)
            }
        }
    }

    fn execute(
        &self,
        factory: &dyn MigrationHost,
        operation: &str,
        params: Value,
    ) -> Result<Value> {
        let settings = factory.hook_user_settings_path()?;
        ensure!(
            settings
                .file_name()
                .is_some_and(|name| name == "settings.json"),
            "migration_target_unavailable"
        );
        let profile = settings
            .parent()
            .ok_or_else(|| anyhow::anyhow!("migration_target_unavailable"))?;
        if projects::handles(operation) {
            return projects::execute(self, factory, profile, operation, params);
        }
        if source_upload::handles(operation) {
            return source_upload::execute(self, profile, operation, params);
        }
        if definitions::handles(operation) {
            return definitions::execute(self, factory, profile, operation, params);
        }
        if instructions::handles(operation) {
            return instructions::execute(self, factory, profile, operation, params);
        }
        if memory::handles(operation) {
            return memory::execute(self, factory, profile, operation, params);
        }
        if operation == method::MIGRATION_SOURCE_BINDINGS {
            return source_bindings::execute(self, params);
        }
        if operation == method::MIGRATION_SOURCE_DIRECTORY_SELECT {
            return source_directory::execute(self, params);
        }
        if codex_layers::handles(operation) {
            return codex_layers::execute(self, factory, profile, operation, params);
        }
        if operation == method::MIGRATION_CONFIGURATION_LAYERS {
            return configuration_layers::execute(self, profile, params);
        }
        if plugins::handles(operation) {
            return plugins::execute(self, factory, profile, operation, params);
        }
        if undo::handles(operation) {
            return undo::execute(self, factory, profile, operation, params);
        }
        if continuation::handles(operation) {
            return continuation::execute(self, factory, profile, operation, params);
        }
        if history::handles(operation) {
            return history::execute(self, factory, profile, operation, params);
        }
        if batch::handles(operation) {
            return batch::execute(self, factory, profile, operation, params);
        }
        if mcp_credentials::handles(operation) {
            return mcp_credentials::execute(factory, profile, operation, params);
        }
        if credentials::handles(operation) {
            return credentials::execute(factory, profile, operation, params);
        }
        if operation == method::MIGRATION_DISCOVER {
            let params: MigrationDiscoverParams = decode(params)?;
            ensure!(params.sources.len() <= 2, "migration_invalid_parameters");
            let mut registry = self
                .registry
                .lock()
                .map_err(|_| anyhow::anyhow!("migration_busy"))?;
            self.initialize_registry(&mut registry, factory)?;
            if params.include_project {
                let roots = factory.migration_source_roots()?;
                registry
                    .as_mut()
                    .unwrap()
                    .authorize_selected_project(profile, roots.project.as_deref())?;
            }
            let (sources, problems) = registry
                .as_mut()
                .unwrap()
                .discover(&params.sources, params.include_project);
            return Ok(serde_json::to_value(MigrationDiscoverResult {
                sources: sources
                    .into_iter()
                    .map(|source| MigrationSourceSummary {
                        source_id: source.source_id,
                        kind: source.kind,
                        display_name: source.display_name,
                        format_revision: source.format_revision,
                        available_categories: source.categories,
                        scope: source.scope.into(),
                    })
                    .collect(),
                problems: problems
                    .into_iter()
                    .map(|problem| MigrationDiscoveryProblem {
                        kind: problem.kind,
                        scope: problem.scope.into(),
                        code: problem.code.into(),
                    })
                    .collect(),
            })?);
        }
        if operation == method::MIGRATION_SCAN {
            let params: MigrationScanParams = decode(params)?;
            let registry = self
                .registry
                .lock()
                .map_err(|_| anyhow::anyhow!("migration_busy"))?;
            let registry = registry
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("migration_source_selection_expired"))?;
            let job = match registry.selected_asset(&params.source_id) {
                Ok(binding) => {
                    MigrationStore::open_or_create(profile)?.create_asset_scan(binding)?
                }
                Err(_) => {
                    let binding = registry.selected(&params.source_id)?;
                    binding.verify_codex_layer_authority(profile)?;
                    MigrationStore::open_or_create(profile)?.create_bound_scan(binding)?
                }
            };
            return Ok(serde_json::to_value(read_result(&job))?);
        }
        let store = MigrationStore::open_existing(profile)?;
        if operation == method::MIGRATION_ASSET_PREVIEW {
            let params: MigrationAssetPreviewParams = decode(params)?;
            if let Some(text) = store.asset_snapshot(&params.job_id, &params.item_id)? {
                return Ok(serde_json::to_value(text_preview(
                    params.item_id,
                    params.offset,
                    &text,
                )?)?);
            }
            let job = store.read(&params.job_id)?;
            let candidate = job
                .inventory
                .items
                .iter()
                .find(|item| item.preview.id == params.item_id)
                .and_then(|item| item.asset.as_ref())
                .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
            let binding = match &job.batch {
                Some(batch) => match batch.source_for(&params.item_id)? {
                    kcoder_migration::batch::BatchSource::Assets(binding) => binding,
                    _ => anyhow::bail!("migration_asset_source_required"),
                },
                None => job
                    .asset_binding
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("migration_asset_source_required"))?,
            };
            let source = binding.read(&candidate.entry)?;
            let entry = if binding.category == kcoder_types::migration::MigrationCategory::Skill {
                "SKILL.md"
            } else {
                &candidate.entry
            };
            let file = source
                .files
                .iter()
                .find(|file| file.relative_path == std::path::Path::new(entry))
                .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
            let text = std::str::from_utf8(&file.content)
                .map_err(|_| anyhow::anyhow!("migration_asset_encoding"))?;
            return Ok(serde_json::to_value(text_preview(
                params.item_id,
                params.offset,
                text,
            )?)?);
        }
        if matches!(
            operation,
            method::MIGRATION_ASSET_PLAN
                | method::MIGRATION_ASSET_APPLY
                | method::MIGRATION_ASSET_ROLLBACK
        ) {
            let target = AssetTarget::open(profile)?;
            let job = if operation == method::MIGRATION_ASSET_PLAN {
                let params: MigrationAssetPlanParams = decode(params)?;
                let preview = store.read(&params.job_id)?;
                let category = preview
                    .inventory
                    .items
                    .iter()
                    .find(|item| item.preview.id == params.item_id)
                    .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?
                    .preview
                    .category;
                if matches!(
                    category,
                    kcoder_types::migration::MigrationCategory::Skill
                        | kcoder_types::migration::MigrationCategory::Command
                ) {
                    ensure!(
                        !factory
                            .current_skills()?
                            .list_catalog()
                            .iter()
                            .any(|skill| skill.name == params.target_name),
                        "migration_target_conflict"
                    );
                }
                let job = store.select(
                    &params.job_id,
                    params.expected_sequence,
                    std::slice::from_ref(&params.item_id),
                )?;
                store.prepare_asset(
                    &job.job_id,
                    job.sequence,
                    &target,
                    &AssetResolution {
                        agent_adaptation: None,
                        item_id: params.item_id,
                        target_name: params.target_name,
                        enable_after_import: params.enable_after_import,
                        memory_scope: memory::mapping(factory, profile, params.memory_mapping)?,
                    },
                )?
            } else {
                let params: MigrationProviderOperationParams = decode(params)?;
                if operation == method::MIGRATION_ASSET_APPLY {
                    store.apply_asset(
                        &params.job_id,
                        params.expected_sequence,
                        &params.plan_id,
                        &target,
                    )?
                } else {
                    store.rollback_asset(
                        &params.job_id,
                        params.expected_sequence,
                        &params.plan_id,
                        &target,
                    )?
                }
            };
            return Ok(serde_json::to_value(read_result(&job))?);
        }
        if operation == method::MIGRATION_READ {
            let params: MigrationOperationParams = decode(params)?;
            return Ok(serde_json::to_value(read_result(
                &store.read(&params.job_id)?,
            ))?);
        }
        if operation == method::MIGRATION_ITEMS {
            let params: MigrationItemsParams = decode(params)?;
            let job = store.read(&params.job_id)?;
            let mut result = items_result(&job, params.cursor.as_deref(), params.page_index)?;
            if params.include_templates {
                kcoder_migration_client::migration_view::include_template_candidates(
                    &job,
                    &mut result,
                );
            }
            return Ok(serde_json::to_value(result)?);
        }
        if operation == method::MIGRATION_CANCEL {
            let params: MigrationCancelParams = decode(params)?;
            return Ok(serde_json::to_value(read_result(
                &store.cancel(&params.job_id, params.expected_sequence)?,
            ))?);
        }
        if matches!(
            operation,
            method::MIGRATION_MCP_PLAN
                | method::MIGRATION_MCP_APPLY
                | method::MIGRATION_MCP_ROLLBACK
        ) {
            ensure!(
                factory.migration_mcp_settings_path()? == settings,
                "migration_wrong_target"
            );
            let target = McpTarget::open(profile)?;
            let job = if operation == method::MIGRATION_MCP_PLAN {
                let params: MigrationMcpPlanParams = decode(params)?;
                let job = store.read(&params.job_id)?;
                ensure!(
                    job.source_binding.is_some(),
                    "migration_source_selection_required"
                );
                ensure!(
                    job.sequence == params.expected_sequence,
                    "migration_revision_conflict"
                );
                ensure!(
                    !factory.current_mcp_names()?.iter().any(|server| {
                        kcoder_mcp_policy::mcp_tool_name(server, "migration_namespace_probe")
                            == kcoder_mcp_policy::mcp_tool_name(
                                &params.target_name,
                                "migration_namespace_probe",
                            )
                    }),
                    "migration_target_conflict"
                );
                let job = store.select(
                    &params.job_id,
                    params.expected_sequence,
                    std::slice::from_ref(&params.item_id),
                )?;
                store.prepare_mcp(
                    &job.job_id,
                    job.sequence,
                    &target,
                    &McpResolution {
                        item_id: params.item_id,
                        target_name: params.target_name,
                        cwd: params.cwd,
                        enable_after_import: params.enable_after_import,
                    },
                )?
            } else {
                let params: MigrationProviderOperationParams = decode(params)?;
                if operation == method::MIGRATION_MCP_APPLY {
                    let job = store.read(&params.job_id)?;
                    ensure!(
                        job.source_binding.is_some()
                            || job
                                .receipts
                                .iter()
                                .any(|receipt| receipt.operation_id == params.plan_id),
                        "migration_source_selection_required"
                    );
                    store.apply_mcp(
                        &params.job_id,
                        params.expected_sequence,
                        &params.plan_id,
                        &target,
                    )?
                } else {
                    store.rollback_mcp(
                        &params.job_id,
                        params.expected_sequence,
                        &params.plan_id,
                        &target,
                    )?
                }
            };
            return Ok(serde_json::to_value(read_result(&job))?);
        }
        // The user layer must not silently lose to project/executable/CLI Provider overlays.
        ensure!(
            factory.migration_user_settings_path()? == settings,
            "migration_wrong_target"
        );
        let target = ProviderTarget::open(profile)?;
        let job = if operation == method::MIGRATION_PROVIDER_PLAN {
            let params: MigrationProviderPlanParams = decode(params)?;
            let job = store.read(&params.job_id)?;
            ensure!(
                job.source_binding.is_some(),
                "migration_source_selection_required"
            );
            ensure!(
                job.sequence == params.expected_sequence,
                "migration_revision_conflict"
            );
            let job = store.select(
                &params.job_id,
                params.expected_sequence,
                std::slice::from_ref(&params.item_id),
            )?;
            store.prepare_provider(
                &job.job_id,
                job.sequence,
                &target,
                &ProviderResolution {
                    item_id: params.item_id,
                    target_name: params.target_name,
                    endpoint: params.endpoint,
                    model: params.model,
                    limits: Some(ModelLimits {
                        context_window_tokens: params.context_window_tokens,
                        output_headroom_tokens: params.output_headroom_tokens,
                        max_output_tokens: params.max_output_tokens,
                    }),
                },
            )?
        } else {
            let params: MigrationProviderOperationParams = decode(params)?;
            if operation == method::MIGRATION_PROVIDER_APPLY {
                let job = store.read(&params.job_id)?;
                ensure!(
                    job.source_binding.is_some()
                        || job
                            .receipts
                            .iter()
                            .any(|receipt| receipt.operation_id == params.plan_id),
                    "migration_source_selection_required"
                );
                store.apply_provider(
                    &params.job_id,
                    params.expected_sequence,
                    &params.plan_id,
                    &target,
                )?
            } else if operation == method::MIGRATION_PROVIDER_ROLLBACK {
                store.rollback_provider(
                    &params.job_id,
                    params.expected_sequence,
                    &params.plan_id,
                    &target,
                )?
            } else {
                anyhow::bail!("migration_unknown_operation");
            }
        };
        Ok(serde_json::to_value(read_result(&job))?)
    }
}

fn safe_error(error: &anyhow::Error) -> String {
    if kcoder_state::history_index::HistoryCatalogBusy::from_error(error).is_some() {
        return "history_catalog_busy".into();
    }
    // Only these two private prepare states belong on the ordinary batch lane.
    if let Some(code) = error.chain().map(ToString::to_string).find(|code| {
        matches!(
            code.as_str(),
            "private_credentials_preparation_pending" | "private_credentials_publication_unknown"
        )
    }) {
        return code;
    }
    error
        .chain()
        .find_map(|cause| {
            let message = cause.to_string();
            (message.len() < 128
                && message
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                && [
                    "migration_",
                    "imported_context_",
                    "imported_memory_",
                    "history_",
                    "external_history_",
                    "continuation_",
                    "historical_projection_",
                    "historical_seed_",
                    "historical_undo_",
                    "local_attachment_",
                    "local_upload_",
                    "source_upload_",
                    "source_transfer_",
                ]
                .iter()
                .any(|prefix| message.starts_with(prefix)))
            .then_some(message)
        })
        .unwrap_or_else(|| "migration_operation_failed".into())
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| anyhow::anyhow!("migration_invalid_parameters"))
}

fn text_preview(item_id: String, offset: usize, text: &str) -> Result<MigrationAssetPreviewResult> {
    ensure!(
        offset <= text.len() && text.is_char_boundary(offset),
        "migration_invalid_cursor"
    );
    let mut end = offset.saturating_add(64 * 1024).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok(MigrationAssetPreviewResult {
        item_id,
        text: text[offset..end].into(),
        total_bytes: text.len(),
        next_offset: (end < text.len()).then_some(end),
    })
}

#[cfg(test)]
mod preparation_error_tests {
    use super::safe_error;
    #[test]
    fn catalog_contention_preserves_its_safe_retry_code_through_context() {
        let error = anyhow::Error::new(kcoder_state::history_index::HistoryCatalogBusy)
            .context("private catalog observation failed");
        assert_eq!(safe_error(&error), "history_catalog_busy");
        assert_eq!(
            safe_error(&anyhow::Error::new(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "private fixture path"
            ))),
            "migration_operation_failed"
        );
    }
    #[test]
    fn preparation_cancel_errors_preserve_only_the_two_fixed_recovery_codes() {
        for code in [
            "private_credentials_preparation_pending",
            "private_credentials_publication_unknown",
        ] {
            assert_eq!(safe_error(&anyhow::anyhow!(code)), code);
        }
        for text in [
            "private_credentials_SYNTHETIC_SECRET",
            "SYNTHETIC_SECRET/path",
            "private_credentials_preparation_pending:SECRET",
        ] {
            assert_eq!(
                safe_error(&anyhow::anyhow!(text)),
                "migration_operation_failed"
            );
        }
    }
}

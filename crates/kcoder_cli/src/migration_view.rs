//! Shared public projections keep CLI and RPC output free of private journal bindings.
#[path = "migration_view/plan_details.rs"]
mod plan_details;
use anyhow::{Result, ensure};
use kcoder_app_protocol::*;
use kcoder_migration::{
    batch::{BatchActionKind, BatchResolution, settings::SettingsStep},
    store::MigrationJob,
};
use kcoder_types::migration::{MigrationIssueSeverity, MigrationItemStatus as Status};
pub use plan_details::batch_item_plan;

pub fn read_result(job: &MigrationJob) -> MigrationJobReadResult {
    let credential_states = job
        .credential_plans
        .iter()
        .map(|plan| (&plan.plan_id, plan.phase))
        .chain(
            job.mcp_credential_plans
                .iter()
                .map(|plan| (&plan.plan_id, plan.phase)),
        )
        .collect::<Vec<_>>();
    MigrationJobReadResult {
        credential_plans: job
            .credential_plans
            .iter()
            .map(|plan| MigrationCredentialPlanSummary {
                grouped: plan.atomic_group_id.is_some(),
                error_code: plan.error_code.clone(),
                undo_requested: plan.undo_requested,
                plan_id: plan.plan_id.clone(),
                item_id: plan.item_id.clone(),
                target_name: plan.target_name.clone(),
                endpoint: plan.endpoint.clone(),
                storage: match plan.reference.storage {
                    kcoder_config::imported_credentials::ImportStorage::File => {
                        MigrationCredentialStorage::File
                    }
                    kcoder_config::imported_credentials::ImportStorage::Keyring => {
                        MigrationCredentialStorage::Keyring
                    }
                },
                source: match plan.selector {
                    kcoder_migration::credentials::ApiKeySelector::ClaudeConfiguration => {
                        MigrationApiKeySource::Configuration
                    }
                    _ => MigrationApiKeySource::Environment,
                },
                source_field: match &plan.selector {
                    kcoder_migration::credentials::ApiKeySelector::ClaudeConfiguration => {
                        "env.ANTHROPIC_API_KEY".into()
                    }
                    kcoder_migration::credentials::ApiKeySelector::Environment(variable) => {
                        variable.clone()
                    }
                },
                phase: plan.phase,
            })
            .collect(),
        batch: job.batch.as_ref().map(|batch| MigrationBatchSummary {
            atomic_credentials: batch.atomic_credentials,
            credential_actions: batch.credential_plan_ids.len(),
            published_credentials: credential_states
                .iter()
                .filter(|(id, phase)| {
                    batch.credential_plan_ids.contains(id)
                        && *phase == kcoder_migration::credentials::CredentialPhase::Published
                })
                .count(),
            reused_items: batch
                .actions
                .iter()
                .filter(|action| {
                    action.status == Status::Skipped
                        && matches!(
                            action.action,
                            kcoder_migration::batch::BatchActionKind::Reuse { .. }
                        )
                })
                .map(|action| action.item_ids.len())
                .sum(),
            plan_id: batch.plan_id.clone(),
            selected_items: job.selected_item_ids.len(),
            total_actions: batch.actions.len() + batch.credential_plan_ids.len(),
            committed_actions: batch
                .actions
                .iter()
                .filter(|action| action.status == Status::Committed)
                .count()
                + credential_states
                    .iter()
                    .filter(|(id, phase)| {
                        batch.credential_plan_ids.contains(id)
                            && *phase == kcoder_migration::credentials::CredentialPhase::Published
                    })
                    .count(),
            unresolved_actions: batch
                .actions
                .iter()
                .filter(|action| {
                    !matches!(
                        action.status,
                        Status::Committed | Status::RolledBack | Status::Skipped
                    )
                })
                .count()
                + credential_states
                    .iter()
                    .filter(|(id, phase)| {
                        batch.credential_plan_ids.contains(id)
                            && !matches!(
                                *phase,
                                kcoder_migration::credentials::CredentialPhase::Published
                                    | kcoder_migration::credentials::CredentialPhase::Undone
                            )
                    })
                    .count(),
            default_item_ids: job
                .inventory
                .items
                .iter()
                .filter(|item| {
                    item.preview.selected_by_default
                        && kcoder_migration::batch::default_resolution(job, item).is_some()
                })
                .map(|item| item.preview.id.clone())
                .collect(),
        }),
        job: MigrationJobSummary {
            job_id: job.job_id.clone(),
            source_id: format!("source-for-{}", job.job_id),
            status: job.status,
            sequence: job.sequence,
            total_items: job.inventory.items.len(),
            has_unconfirmed_outcomes: job.status
                == kcoder_types::migration::MigrationJobStatus::RollingBack
                || job.has_unconfirmed_credentials()
                || job.inventory.items.iter().any(|item| {
                    matches!(
                        item.preview.status,
                        Status::Committing | Status::CommitUnknown
                    )
                }),
            committed_items: job
                .inventory
                .items
                .iter()
                .filter(|item| matches!(item.preview.status, Status::Committed | Status::Ready))
                .count(),
            requires_action_items: job
                .inventory
                .items
                .iter()
                .filter(|item| {
                    item.preview.status == Status::RequiresAction
                        || item
                            .preview
                            .issues
                            .iter()
                            .any(|issue| issue.severity == MigrationIssueSeverity::Blocking)
                })
                .count(),
        },
        source: job.inventory.source,
        plans: job
            .provider_plans
            .iter()
            .map(|plan| MigrationProviderPlanSummary {
                plan_id: plan.id().into(),
                item_id: plan.item().preview.id.clone(),
                target_name: plan.target_name().into(),
                provider: MigrationProviderCandidate {
                    item_id: plan.item().preview.id.clone(),
                    api_format: plan.provider().api_format.as_str().into(),
                    endpoint: Some(plan.provider().endpoint.clone()),
                    model: Some(plan.provider().default_model.clone()),
                    context_window_tokens: Some(plan.provider().context_window_tokens as u64),
                    output_headroom_tokens: Some(plan.provider().output_headroom_tokens as u64),
                    max_output_tokens: Some(plan.provider().max_output_tokens as u64),
                },
            })
            .collect(),
        issues: job.inventory.issues.clone(),
        mcp_plans: job
            .mcp_plans
            .iter()
            .map(|plan| MigrationMcpPlanSummary {
                plan_id: plan.id().into(),
                item_id: plan.item().preview.id.clone(),
                config: plan.config().clone(),
                enable_after_import: plan.enabled(),
            })
            .collect(),
        asset_plans: job
            .asset_plans
            .iter()
            .map(|plan| MigrationAssetPlanSummary {
                plan_id: plan.id().into(),
                item_id: plan.item().preview.id.clone(),
                target_name: plan.name().into(),
                enable_after_import: plan.enabled(),
                native_reference: plan.native_reference(),
                project_scoped: plan.project_scoped(),
            })
            .collect(),
    }
}

pub fn items_result(
    job: &MigrationJob,
    cursor: Option<&str>,
    page_index: Option<usize>,
) -> Result<MigrationItemsResult> {
    ensure!(
        page_index.is_none() || cursor.is_none() && job.batch.is_some(),
        "migration_invalid_parameters"
    );
    let prefix = format!("{}:{}:", job.job_id, job.sequence);
    let offset = match cursor {
        None => page_index
            .unwrap_or(0)
            .checked_mul(10)
            .ok_or_else(|| anyhow::anyhow!("migration_invalid_cursor"))?,
        Some(value) => value
            .strip_prefix(&prefix)
            .filter(|v| v.len() <= 6)
            .and_then(|v| v.parse::<usize>().ok())
            .ok_or_else(|| anyhow::anyhow!("migration_stale_cursor"))?,
    };
    ensure!(
        offset <= job.inventory.items.len(),
        "migration_invalid_cursor"
    );
    let page = job
        .inventory
        .items
        .iter()
        .skip(offset)
        .take(10)
        .collect::<Vec<_>>();
    Ok(MigrationItemsResult {
        templates: Vec::new(),
        drafts: if job.batch.is_some() {
            page.iter()
                .map(|item| {
                    Ok(MigrationBatchDraft {
                        item_id: item.preview.id.clone(),
                        target_name: kcoder_migration::batch::proposed_name(job, item)?,
                        choice: kcoder_migration::batch::default_resolution(job, item)
                            .map(wire_choice),
                    })
                })
                .collect::<Result<Vec<_>>>()?
        } else {
            Vec::new()
        },
        planned: page
            .iter()
            .filter_map(|item| item_summary(job, &item.preview.id))
            .collect(),
        assets: page
            .iter()
            .filter_map(|item| {
                item.asset.as_ref().map(|asset| MigrationAssetCandidate {
                    item_id: item.preview.id.clone(),
                    name: asset.name.clone(),
                    bytes: asset.bytes,
                    files: asset.files,
                    native_reference: asset.native_reference,
                })
            })
            .collect(),
        next_cursor: (offset + page.len() < job.inventory.items.len())
            .then(|| format!("{prefix}{}", offset + page.len())),
        items: page.iter().map(|item| item.preview.clone()).collect(),
        providers: page
            .iter()
            .filter_map(|item| {
                item.provider
                    .as_ref()
                    .map(|provider| MigrationProviderCandidate {
                        item_id: item.preview.id.clone(),
                        api_format: provider.api_format.clone(),
                        endpoint: provider.endpoint.clone(),
                        model: provider.model.clone(),
                        context_window_tokens: provider.context_window_tokens,
                        output_headroom_tokens: provider.output_headroom_tokens,
                        max_output_tokens: provider.max_output_tokens,
                    })
            })
            .collect(),
        mcps: page
            .iter()
            .filter_map(|item| {
                item.mcp.as_ref().map(|mcp| MigrationMcpCandidate {
                    item_id: item.preview.id.clone(),
                    name: mcp.config.name.clone(),
                    transport: mcp.config.transport.clone(),
                    command: mcp.config.command.clone(),
                    url: mcp.config.url.clone(),
                    cwd: mcp.config.policy.cwd.clone(),
                    source_cwd: mcp.source_cwd.clone(),
                    required_env: mcp.config.policy.required_env.clone(),
                    required_headers: mcp.config.policy.required_headers.clone(),
                    enabled_in_source: mcp.enabled_in_source,
                })
            })
            .collect(),
    })
}

pub fn wire_choice(choice: BatchResolution) -> MigrationBatchChoice {
    match choice {
        BatchResolution::Project(value) => MigrationBatchChoice::Project {
            item_id: value.item_id,
            mapping: value.mapping,
        },
        BatchResolution::Plugin(value) => MigrationBatchChoice::Plugin {
            item_id: value.item_id,
            target_name: value.target_name,
        },
        BatchResolution::History(value) => MigrationBatchChoice::History {
            item_id: value.item_id,
        },
        BatchResolution::Template(value) => MigrationBatchChoice::Template {
            item_id: value.item_id,
            target_name: value.target_name,
            provider_item_id: value.provider_item_id,
        },
        BatchResolution::Asset(value) => MigrationBatchChoice::Asset {
            agent_adaptation: value.agent_adaptation.clone(),
            item_id: value.item_id,
            target_name: value.target_name,
            enable_after_import: value.enable_after_import,
            memory_mapping: value.memory_scope.as_ref().map(|scope| match scope {
                kcoder_config::imported_context::ImportedContextScope::Global => {
                    kcoder_types::imported_memory::ImportedMemoryMapping::Global
                }
                kcoder_config::imported_context::ImportedContextScope::Project { .. } => {
                    kcoder_types::imported_memory::ImportedMemoryMapping::CurrentWorkspace
                }
            }),
        },
        BatchResolution::Mcp(value) => MigrationBatchChoice::Mcp {
            item_id: value.item_id,
            target_name: value.target_name,
            cwd: value.cwd,
            enable_after_import: value.enable_after_import,
        },
        BatchResolution::Provider(value) => {
            let limits = value
                .limits
                .expect("Resolved provider choices contain explicit limits");
            MigrationBatchChoice::Provider {
                item_id: value.item_id,
                target_name: value.target_name,
                endpoint: value.endpoint,
                model: value.model,
                context_window_tokens: limits.context_window_tokens,
                output_headroom_tokens: limits.output_headroom_tokens,
                max_output_tokens: limits.max_output_tokens,
            }
        }
    }
}

pub fn item_summary(job: &MigrationJob, item_id: &str) -> Option<MigrationBatchItemSummary> {
    let batch = job.batch.as_ref()?;
    let action = batch
        .actions
        .iter()
        .find(|action| action.item_ids.iter().any(|id| id == item_id))?;
    let mut summary = MigrationBatchItemSummary {
        history_job_id: None,
        reused: false,
        reused_from_job_id: None,
        item_id: item_id.into(),
        target_name: None,
        enabled: false,
        project_scoped: false,
        native_reference: false,
        error_code: action.error.clone(),
    };
    match &action.action {
        BatchActionKind::Project { plan } => {
            summary.target_name = Some(plan.target_name().into());
            summary.enabled = false;
            summary.project_scoped = true;
        }
        BatchActionKind::Plugin { plan } => {
            summary.target_name = Some(plan.target_name.clone());
        }
        BatchActionKind::History { plan } => {
            summary.history_job_id = Some(plan.history_job_id.clone())
        }
        BatchActionKind::Template { plan } => summary.target_name = Some(plan.template_id().into()),
        BatchActionKind::Reuse { proof } => {
            summary.history_job_id = proof.history_job_id.clone();
            summary.target_name = Some(proof.target_name.clone());
            summary.enabled = proof.enabled;
            summary.project_scoped = proof.project_scoped;
            summary.native_reference = proof.native_reference;
            summary.reused = true;
            summary.reused_from_job_id = Some(proof.job_id.clone());
        }
        BatchActionKind::Asset {
            target_name,
            enabled,
            project_scoped,
            native_reference,
            ..
        } => {
            summary.target_name = Some(target_name.clone());
            summary.enabled = *enabled;
            summary.project_scoped = *project_scoped;
            summary.native_reference = *native_reference;
        }
        BatchActionKind::Settings { plan } => {
            let step = plan
                .steps
                .iter()
                .find(|step| step.item().preview.id == item_id)?;
            summary.target_name = Some(step.target_name().into());
            if let SettingsStep::Mcp(plan) = step {
                summary.enabled = plan.enabled();
                summary.project_scoped = plan.config().policy.workspace.is_some();
            }
        }
    }
    Some(summary)
}

pub fn include_template_candidates(job: &MigrationJob, result: &mut MigrationItemsResult) {
    result.templates = result
        .items
        .iter()
        .filter_map(|preview| {
            let item = job
                .inventory
                .items
                .iter()
                .find(|item| item.preview.id == preview.id)?;
            let candidate = item.template.as_ref()?;
            let provider_item_id =
                kcoder_migration::store::template_provider_item_id(job, &preview.id);
            let dependency = job
                .inventory
                .items
                .iter()
                .enumerate()
                .find(|(_, item)| Some(&item.preview.id) == provider_item_id.as_ref());
            Some(MigrationTemplateCandidate {
                item_id: preview.id.clone(),
                name: preview.source_name.clone(),
                provider_item_id,
                provider_name: dependency.map(|(_, item)| item.preview.source_name.clone()),
                provider_page_index: dependency.map(|(index, _)| index / 10),
                reasoning_effort: candidate.reasoning_effort.clone(),
            })
        })
        .collect();
}

pub fn records_result(
    records: Vec<kcoder_migration::store::MigrationRecord>,
    next_cursor: Option<String>,
) -> MigrationJobsListResult {
    MigrationJobsListResult {
        jobs: records
            .into_iter()
            .map(|record| MigrationJobRecord {
                source: record.source,
                created_at_ms: record.created_at_ms,
                is_batch: record.batch,
                selected_items: record.selected_items,
                reused_items: record.reused_items,
                job: MigrationJobSummary {
                    job_id: record.job_id,
                    sequence: record.sequence,
                    status: record.status,
                    source_id: "record".into(),
                    total_items: record.total_items,
                    committed_items: record.committed_items,
                    requires_action_items: record.requires_action_items,
                    has_unconfirmed_outcomes: record.has_unconfirmed_outcomes,
                },
            })
            .collect(),
        next_cursor,
    }
}

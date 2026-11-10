//! Explicit migration operations precede normal Agent bootstrap and never start source programs.
use crate::cli_args::{MigrationAction, MigrationSourceArg};
use anyhow::{Result, ensure};
use kcoder_migration::{
    discovery::ConfigurationBinding,
    providers::{ModelLimits, ProviderResolution, ProviderTarget},
    source::SourceDocument,
    store::MigrationStore,
};
use std::path::{Path, PathBuf};
#[path = "../../migration_cli/agent_adaptation.rs"]
mod agent_adaptation;
#[path = "../../migration_cli/batch.rs"]
mod batch;
#[path = "../../migration_cli/budget.rs"]
mod budget;
#[path = "../../migration_cli/context.rs"]
mod context;
#[path = "../../migration_cli/guide.rs"]
mod guide;
#[path = "../../migration_cli/history.rs"]
mod history;
#[path = "../../migration_cli/planning.rs"]
mod planning;
#[path = "../../migration_cli/plugin.rs"]
mod plugin;
#[path = "../../migration_cli/projects.rs"]
mod projects;
#[path = "../../migration_cli/settings_targets.rs"]
mod settings_targets;
#[path = "../../migration_cli/transfer.rs"]
mod transfer;

pub fn run(action: &MigrationAction, cwd: Option<&Path>, overlays: &[PathBuf]) -> Result<()> {
    if let MigrationAction::Budget {
        target_profile,
        action,
    } = action
    {
        return budget::run(
            action,
            &context::Context::open(target_profile, cwd, overlays)?,
        );
    }
    if let MigrationAction::Transfer { options } = action {
        return transfer::run(options, cwd);
    }
    if let MigrationAction::Plugin {
        target_profile,
        action,
    } = action
    {
        return plugin::run(
            action,
            &context::Context::open(target_profile, cwd, overlays)?,
        );
    }
    if let MigrationAction::Configure { options } = action {
        return guide::run(options, cwd, overlays);
    }
    if let MigrationAction::History {
        target_profile,
        action,
    } = action
    {
        return history::run(
            action,
            &context::Context::open(target_profile, cwd, overlays)?,
            overlays,
        );
    }
    if let MigrationAction::PlanProvider { target_profile, .. }
    | MigrationAction::ApplyProvider { target_profile, .. }
    | MigrationAction::RollbackProvider { target_profile, .. } = action
    {
        context::Context::open(target_profile, cwd, overlays)?.require_writable(&["providers"])?;
    }
    match action {
        MigrationAction::Scan { source, config } => {
            let inventory = selected(*source, &absolute(config, cwd)?)?.inventory()?;
            println!("{}", serde_json::to_string_pretty(&inventory)?);
        }
        MigrationAction::PlanProvider {
            source,
            config,
            item_id,
            target_profile,
            target_name,
            endpoint,
            model,
            context_window_tokens,
            output_headroom_tokens,
            max_output_tokens,
        } => {
            let binding = selected(*source, &absolute(config, cwd)?)?;
            let inventory = binding.inventory()?;
            ensure!(
                !inventory.issues.iter().any(|issue| issue.blocks_import()),
                "migration_source_requires_resolution"
            );
            let item = inventory
                .items
                .iter()
                .find(|item| &item.preview.id == item_id)
                .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
            let profile = absolute(target_profile, cwd)?;
            let target = ProviderTarget::open(&profile)?;
            let resolution = ProviderResolution {
                item_id: item_id.clone(),
                target_name: target_name.clone(),
                endpoint: endpoint.clone(),
                model: model.clone(),
                limits: Some(ModelLimits {
                    context_window_tokens: *context_window_tokens,
                    output_headroom_tokens: *output_headroom_tokens,
                    max_output_tokens: *max_output_tokens,
                }),
            };
            // Validate before creating a durable job that would otherwise be stranded.
            target.prepare(item, &resolution)?;
            let store = MigrationStore::open_or_create(&profile)?;
            let job = store.create_bound_scan(binding)?;
            let job = store.select(&job.job_id, job.sequence, std::slice::from_ref(item_id))?;
            let job = store.prepare_provider(&job.job_id, job.sequence, &target, &resolution)?;
            println!("{}", serde_json::to_string_pretty(&public_job(&job))?);
        }
        MigrationAction::ApplyProvider {
            target_profile,
            config,
            job_id,
            plan_id,
            expected_sequence,
        } => {
            let profile = absolute(target_profile, cwd)?;
            let store = MigrationStore::open_existing(&profile)?;
            let job = store.read(job_id)?;
            let source = SourceDocument::read_selected_configuration(&absolute(config, cwd)?)?;
            ensure!(
                job.source_binding
                    .as_ref()
                    .map(|binding| binding.revision.as_str())
                    .unwrap_or(&job.source_id)
                    == source.revision(),
                "migration_source_changed"
            );
            let target = ProviderTarget::open(&profile)?;
            let job = store.apply_provider(job_id, *expected_sequence, plan_id, &target)?;
            println!("{}", serde_json::to_string_pretty(&public_job(&job))?);
        }
        MigrationAction::RollbackProvider {
            target_profile,
            job_id,
            plan_id,
            expected_sequence,
        } => {
            let profile = absolute(target_profile, cwd)?;
            let store = MigrationStore::open_existing(&profile)?;
            let target = ProviderTarget::open(&profile)?;
            let job = store.rollback_provider(job_id, *expected_sequence, plan_id, &target)?;
            println!("{}", serde_json::to_string_pretty(&public_job(&job))?);
        }
        MigrationAction::Status {
            target_profile,
            job_id,
        } => {
            let store = MigrationStore::open_existing(&absolute(target_profile, cwd)?)?;
            let job = store.read(job_id)?;
            if job.batch.is_some() {
                batch::print(&crate::migration_view::read_result(&job))?;
            } else {
                batch::print(&public_job(&job))?;
            }
        }
        _ => return batch::run(action, cwd, overlays),
    }
    Ok(())
}

fn selected(source: MigrationSourceArg, path: &Path) -> Result<ConfigurationBinding> {
    ConfigurationBinding::capture_selected(
        path,
        match source {
            MigrationSourceArg::ClaudeCode => {
                kcoder_types::migration::MigrationSourceKind::ClaudeCode
            }
            MigrationSourceArg::Codex => kcoder_types::migration::MigrationSourceKind::Codex,
        },
    )
}

/// Public output is an allowlist, never the private journal or credential-derived hashes.
fn public_job(job: &kcoder_migration::store::MigrationJob) -> serde_json::Value {
    serde_json::json!({
        "jobId": job.job_id, "sourceId":format!("source-for-{}", job.job_id),
        "sequence":job.sequence, "status":job.status, "inventory":job.inventory,
        "selectedItemIds":job.selected_item_ids,
        "providerPlans": job.provider_plans.iter().map(|plan| serde_json::json!({
            "planId":plan.id(),"itemId":plan.item().preview.id,"targetName":plan.target_name(),
            "provider": {"apiFormat":plan.provider().api_format.as_str(), "endpoint":plan.provider().endpoint,
                "model":plan.provider().default_model, "contextWindowTokens":plan.provider().context_window_tokens,
                "outputHeadroomTokens":plan.provider().output_headroom_tokens, "maxOutputTokens":plan.provider().max_output_tokens,
                "capabilities":plan.provider().capabilities}
        })).collect::<Vec<_>>(),
        "receipts":job.receipts.iter().map(|receipt|serde_json::json!({
            "itemId":receipt.item_id,"operationId":receipt.operation_id,"ownershipConfirmed":receipt.ownership_confirmed
        })).collect::<Vec<_>>()
    })
}

fn absolute(path: &Path, cwd: Option<&Path>) -> Result<PathBuf> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    let base = match cwd {
        Some(path) => path.to_path_buf(),
        None => std::env::current_dir()?,
    };
    Ok(base.join(path))
}

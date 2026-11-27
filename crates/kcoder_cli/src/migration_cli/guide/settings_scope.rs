//! Destination consent is independent of source project discovery.
use super::*;
use crate::cli_args::MigrationSettingsScope;
use serde_json::json;

pub(super) fn choose(
    guide: &Guide<'_>,
    args: &MigrationGuideArgs,
) -> Result<MigrationSettingsScope> {
    let selected = match args.target_scope {
        Some(scope) => scope,
        None => loop {
            match guide.io.ask("target_settings_scope", "Explicitly select settings destination: user configuration or current_workspace trusted workspace settings. Source --project does not determine the target; assets keep their separate mappings. Preserve effective connections and the default model; the plan explicitly retains public built-ins when needed. Initial project MCP declarations separately confirm the inherited names to retain. Project credentials and templates are still explicitly rejected by Native guardrails, without falling back to user scope.", json!([
                {"value":"user","label":"User configuration (preserve the existing default model)"},
                {"value":"current_workspace","label":"Current trusted workspace settings"}
            ]), Some("user"))?.as_str() {
                "user" => break MigrationSettingsScope::User,
                "current_workspace" | "current-workspace" => break MigrationSettingsScope::CurrentWorkspace,
                _ => guide.io.notice("migration_guide_invalid_selection", "Choose user or current_workspace; no migration record was created.")?,
            }
        },
    };
    if matches!(selected, MigrationSettingsScope::CurrentWorkspace) {
        let context = guide.fresh()?;
        ensure!(
            kcoder_config::FolderTrustStore::load(&context.profile).check(&context.cwd)
                == kcoder_config::FolderTrust::Trusted,
            "migration_project_target_untrusted"
        );
    }
    Ok(selected)
}

pub(super) fn save(
    guide: &Guide<'_>,
    inputs: Vec<kcoder_migration::batch::BatchSource>,
    scope: MigrationSettingsScope,
) -> Result<MigrationJob> {
    let context = guide.fresh()?;
    let store = MigrationStore::open_or_create(&context.profile)?;
    match (scope, guide.initial_resources.clone()) {
        (MigrationSettingsScope::User, Some(limits)) => {
            store.create_batch_scan_with_resource_limits(inputs, limits)
        }
        (MigrationSettingsScope::User, None) => store.create_batch_scan(inputs),
        (MigrationSettingsScope::CurrentWorkspace, Some(limits)) => {
            store.create_batch_scan_in_project_with_resource_limits(inputs, &context.cwd, limits)
        }
        (MigrationSettingsScope::CurrentWorkspace, None) => {
            store.create_batch_scan_in_project(inputs, &context.cwd)
        }
    }
}

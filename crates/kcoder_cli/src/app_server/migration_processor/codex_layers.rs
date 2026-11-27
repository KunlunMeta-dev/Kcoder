//! Independent Codex selection/read DTOs never extend the old Claude report enum.
use super::*;
use std::path::Path;
pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_CODEX_LAYERS_SELECT | method::MIGRATION_CODEX_LAYERS_READ
    )
}
pub(super) fn execute(
    processor: &MigrationProcessor,
    factory: &dyn MigrationHost,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    if operation == method::MIGRATION_CODEX_LAYERS_SELECT {
        let params: MigrationCodexLayersSelectParams = decode(params)?;
        ensure!(
            params.include_project,
            "migration_codex_project_consent_required"
        );
        let (root, cwd) = trusted_hierarchy(factory, profile)?;
        let mut registry = processor
            .registry
            .lock()
            .map_err(|_| anyhow::anyhow!("migration_busy"))?;
        let selected = registry
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("migration_source_selection_expired"))?
            .select_codex_layers(&params.source_id, &root, &cwd)?;
        let source = selected.source;
        return Ok(serde_json::to_value(MigrationCodexLayersSelectResult {
            source: MigrationSourceSummary {
                source_id: source.source_id,
                kind: source.kind,
                display_name: source.display_name,
                format_revision: source.format_revision,
                available_categories: source.categories,
                scope: source.scope.into(),
            },
            replaces_source_ids: selected.replaces_source_ids,
        })?);
    }
    let params: MigrationCodexLayersReadParams = decode(params)?;
    ensure!(params.page_index <= 102, "migration_invalid_page");
    let (binding, live) =
        configuration_layers::selected_binding(processor, profile, &params.target)?;
    if live && let Some(source) = &binding {
        source.verify_codex_layer_authority(profile)?;
    }
    let report = match &binding {
        Some(source) if live => source.codex_layer_report()?,
        Some(source) => source.codex_layer_snapshot_report()?,
        None => None,
    };
    let applicable = binding
        .as_ref()
        .is_some_and(|source| source.source_scope() == "codex-project-layers");
    let mut result = MigrationCodexLayersReadResult {
        target: params.target,
        status: if applicable {
            MigrationConfigurationLayersStatus::Unavailable
        } else {
            MigrationConfigurationLayersStatus::NotApplicable
        },
        page_index: params.page_index,
        adapter_revision: None,
        layers: vec![],
        fields: vec![],
        total_fields: 0,
        next_page: None,
        unobserved: vec![],
    };
    if let Some(report) = report {
        let start = params.page_index as usize * 10;
        ensure!(
            start < report.fields.len() || start == 0,
            "migration_invalid_page"
        );
        result.status = MigrationConfigurationLayersStatus::Available;
        result.adapter_revision =
            Some(kcoder_migration::discovery::codex_layers::CODEX_LAYERS_REVISION.into());
        result.total_fields = report.fields.len() as u32;
        result.next_page = (start + 10 < report.fields.len()).then_some(params.page_index + 1);
        result.fields = report.fields.into_iter().skip(start).take(10).collect();
        result.layers = report
            .present
            .into_iter()
            .enumerate()
            .map(|(index, present)| CodexConfigurationLayerState {
                index: index as u32,
                kind: if index == 0 {
                    CodexConfigurationLayerKind::User
                } else if index == 1 && report.profile_selected {
                    CodexConfigurationLayerKind::Profile
                } else {
                    CodexConfigurationLayerKind::Project
                },
                present,
            })
            .collect();
        result.unobserved = report.unobserved;
        result
            .unobserved
            .push("git_worktree_runtime_routing".into());
    } else {
        ensure!(params.page_index == 0, "migration_invalid_page");
    }
    Ok(serde_json::to_value(result)?)
}
fn trusted_hierarchy(
    factory: &dyn MigrationHost,
    profile: &Path,
) -> Result<(std::path::PathBuf, std::path::PathBuf)> {
    use kcoder_config::{FolderTrust, FolderTrustStore, PrivateDirectory};
    let cwd = factory
        .migration_source_roots()?
        .project
        .ok_or_else(|| anyhow::anyhow!("migration_codex_project_untrusted"))?;
    let cwd = cwd
        .canonicalize()
        .map_err(|_| anyhow::anyhow!("migration_unsafe_source_path"))?;
    let trust = FolderTrustStore::load(profile);
    ensure!(
        trust.check(&cwd) == FolderTrust::Trusted,
        "migration_codex_project_untrusted"
    );
    let mut root = cwd.clone();
    for _ in 0..63 {
        let Some(parent) = root.parent() else {
            break;
        };
        if trust.check(parent) != FolderTrust::Trusted {
            break;
        }
        let directory = PrivateDirectory::open_existing(parent)
            .map_err(|_| anyhow::anyhow!("migration_unsafe_source_path"))?;
        directory.verify_trusted_config_directory()?;
        root = parent.to_owned();
    }
    Ok((root, cwd))
}

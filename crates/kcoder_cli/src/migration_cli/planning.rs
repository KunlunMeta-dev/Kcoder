//! Explicit source selection and bounded public choices create the same immutable plans as RPC.
use super::context::Context;
use super::*;
use crate::{migration_input, migration_view::read_result};
use kcoder_app_protocol::MigrationBatchPlanParams;
use kcoder_migration::{
    batch::{BatchResolution, BatchSource},
    discovery::{DiscoveryRoots, SourceRegistry},
    store::CredentialResolution,
};
use std::{ffi::OsStr, io::Read};

pub(super) fn scan(
    source: MigrationSourceArg,
    home: &Path,
    config_dir: Option<&Path>,
    project: Option<&Path>,
    configuration_only: bool,
    resource_limits: Option<kcoder_types::migration_resource::MigrationResourceLimits>,
    context: &Context,
) -> Result<()> {
    super::batch::print(&read_result(&discover_job(
        source,
        home,
        config_dir,
        project,
        configuration_only,
        resource_limits,
        context,
    )?))
}

pub(super) fn discover_job(
    source: MigrationSourceArg,
    home: &Path,
    config_dir: Option<&Path>,
    project: Option<&Path>,
    configuration_only: bool,
    resource_limits: Option<kcoder_types::migration_resource::MigrationResourceLimits>,
    context: &Context,
) -> Result<kcoder_migration::store::MigrationJob> {
    let (_, inputs, _) = discover_inputs(
        source,
        home,
        config_dir,
        project,
        configuration_only,
        context,
    )?;
    ensure!(!inputs.is_empty(), "migration_source_unavailable");
    let store = MigrationStore::open_or_create(&context.profile)?;
    match resource_limits {
        Some(limits) => store.create_batch_scan_with_resource_limits(inputs, limits),
        None => store.create_batch_scan(inputs),
    }
}

pub(super) fn registry(
    source: MigrationSourceArg,
    home: &Path,
    config_dir: Option<&Path>,
    project: Option<&Path>,
    context: &Context,
) -> Result<(SourceRegistry, kcoder_types::migration::MigrationSourceKind)> {
    let home = absolute(home, Some(&context.cwd))?;
    kcoder_config::PrivateDirectory::open_existing(&home)?.verify_trusted_config_directory()?;
    let custom = config_dir
        .map(|path| absolute(path, Some(&context.cwd)))
        .transpose()?;
    let project = project
        .map(|path| absolute(path, Some(&context.cwd)))
        .transpose()?;
    ensure!(
        project.as_ref().is_none_or(|path| context.trusted(path)),
        "migration_project_source_not_trusted"
    );
    let kind = match source {
        MigrationSourceArg::ClaudeCode => kcoder_types::migration::MigrationSourceKind::ClaudeCode,
        MigrationSourceArg::Codex => kcoder_types::migration::MigrationSourceKind::Codex,
    };
    let registry = SourceRegistry::new(DiscoveryRoots {
        home,
        claude_config_dir: (kind == kcoder_types::migration::MigrationSourceKind::ClaudeCode)
            .then(|| custom.clone())
            .flatten(),
        codex_home: (kind == kcoder_types::migration::MigrationSourceKind::Codex)
            .then_some(custom)
            .flatten(),
        project: project.clone(),
    });
    Ok((registry, kind))
}

pub(super) fn discover_inputs(
    source: MigrationSourceArg,
    home: &Path,
    config_dir: Option<&Path>,
    project: Option<&Path>,
    configuration_only: bool,
    context: &Context,
) -> Result<(
    SourceRegistry,
    Vec<BatchSource>,
    kcoder_types::migration::MigrationSourceKind,
)> {
    let (mut registry, kind) = registry(source, home, config_dir, project, context)?;
    let (sources, problems) =
        registry.discover_with_assets(&[kind], project.is_some(), !configuration_only);
    ensure!(problems.is_empty(), "migration_source_discovery_incomplete");
    let mut inputs = Vec::new();
    for source in sources {
        if let Ok(binding) = registry.selected(&source.source_id) {
            inputs.push(BatchSource::Configuration(binding));
        } else if !configuration_only {
            inputs.push(BatchSource::Assets(
                registry.selected_asset(&source.source_id)?,
            ));
        }
    }
    Ok((registry, inputs, kind))
}

pub(super) fn options(path: &Path, cwd: &Path) -> Result<MigrationBatchPlanParams> {
    let path = absolute(path, Some(cwd))?;
    let directory = kcoder_config::PrivateDirectory::open_existing(
        path.parent()
            .ok_or_else(|| anyhow::anyhow!("migration_invalid_options"))?,
    )?;
    directory.verify_trusted_config_directory()?;
    let file =
        directory.open_single_link_regular_file(path.file_name().unwrap_or(OsStr::new("")))?;
    const LIMIT: u64 = 2 * 1024 * 1024;
    ensure!(
        file.metadata()?.len() <= LIMIT,
        "migration_options_budget_exceeded"
    );
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= LIMIT,
        "migration_options_budget_exceeded"
    );
    serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("migration_invalid_options"))
}

pub(super) fn plan(context: &Context, params: &MigrationBatchPlanParams) -> Result<()> {
    super::batch::print(&read_result(&prepare(context, params)?))
}

pub(super) fn prepare(
    context: &Context,
    params: &MigrationBatchPlanParams,
) -> Result<kcoder_migration::store::MigrationJob> {
    let store = MigrationStore::open_existing(&context.profile)?;
    let scanned = store.read(&params.job_id)?;
    let choices = migration_input::batch_choices_in_scope(
        params,
        &scanned,
        Some(
            kcoder_config::imported_context::ImportedContextScope::Project {
                root: context.cwd.clone(),
            },
        ),
    )?;
    require_writable(context, &scanned, &choices)?;
    let mut policy = context.catalog(&choices)?;
    policy.reuse_existing = params.reuse_existing;
    policy.mcp_credentials = params
        .mcp_credentials
        .iter()
        .map(|choice| kcoder_migration::batch::McpCredentialChoice {
            item_id: choice.item_id.clone(),
            fields: choice.fields.clone(),
            consent_private_values: choice.consent_private_values,
        })
        .collect();
    policy.credentials = params
        .credentials
        .iter()
        .map(|choice| {
            Ok(CredentialResolution {
                item_id: choice.item_id.clone(),
                consent_api_key: choice.consent_api_key,
                selector: migration_input::selector(&scanned, &choice.item_id, choice.source)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    super::batch::with_project_mcp_selection(
        context,
        &scanned,
        true,
        params.project_mcp_inheritance.as_ref(),
        |targets| {
            store.prepare_batch_with_policy(
                &params.job_id,
                params.expected_sequence,
                &choices,
                targets,
                &policy,
            )
        },
    )
}
pub(super) fn require_writable(
    context: &Context,
    job: &kcoder_migration::store::MigrationJob,
    choices: &[BatchResolution],
) -> Result<()> {
    if choices
        .iter()
        .any(|choice| matches!(choice, BatchResolution::Provider(_)))
    {
        super::settings_targets::writable(context, job, &["providers"])?;
    }
    if choices
        .iter()
        .any(|choice| matches!(choice, BatchResolution::Mcp(_)))
    {
        super::settings_targets::writable(context, job, &["mcp_servers", "mcp_disabled_servers"])?;
    }
    Ok(())
}

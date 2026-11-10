//! Discovery and previously accepted Ready copies converge on the same immutable Native inventory.
use super::super::plugin;
use super::*;
use kcoder_migration::batch::BatchSource;
use std::collections::BTreeSet;

pub(super) fn run(
    guide: &Guide<'_>,
    args: &MigrationGuideArgs,
    history: bool,
    plugins: bool,
    memory: bool,
    definitions: bool,
) -> Result<MigrationJob> {
    ensure!(
        args.plugin_operations.len() <= 64,
        "migration_batch_budget_exceeded"
    );
    // Decode after Clap so an invalid value cannot be echoed in parser diagnostics.
    let bindings = args
        .plugin_operations
        .iter()
        .map(|value| {
            value
                .parse::<crate::cli_args::MigrationPluginBinding>()
                .map_err(|_| anyhow::anyhow!("plugin_migration_invalid_binding"))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut ids = BTreeSet::new();
    let mut inputs = bindings
        .iter()
        .map(|binding| {
            ensure!(
                ids.insert(&binding.operation_id),
                "plugin_migration_duplicate_selection"
            );
            plugin::binding(&guide.fresh()?, binding)
        })
        .collect::<Result<Vec<_>>>()?;
    let target_scope = super::settings_scope::choose(guide, args)?;
    let needs_source = inputs.is_empty()
        || args.source.is_some()
        || args.source_home.is_some()
        || args.source_config_dir.is_some()
        || args.project.is_some()
        || history
        || plugins
        || memory
        || definitions;
    if needs_source {
        let source = match args.source {
            Some(source) => source,
            None => match guide
                .io
                .text("source", "选择来源：claude-code 或 codex", None)?
                .as_str()
            {
                "claude-code" => MigrationSourceArg::ClaudeCode,
                "codex" => MigrationSourceArg::Codex,
                _ => anyhow::bail!("migration_guide_invalid_source"),
            },
        };
        let home = match &args.source_home {
            Some(home) => home.clone(),
            None => PathBuf::from(guide.io.text(
                "source_home",
                "明确选择来源账户目录；不会读取认证缓存或扫描其他账户。",
                None,
            )?),
        };
        let context = guide.fresh()?;
        let (mut registry, discovered, kind) = if let Some(project) = &args.project {
            let (mut registry, kind) = planning::registry(
                source,
                &home,
                args.source_config_dir.as_deref(),
                Some(project),
                &context,
            )?;
            let (rows, problems) =
                registry.discover_with_assets(&[kind], true, !args.configuration_only);
            ensure!(problems.is_empty(), "migration_source_discovery_incomplete");
            let project = super::super::absolute(project, Some(&context.cwd))?;
            let discovered = super::source_views::choose(guide, &mut registry, rows, &project)?;
            (registry, discovered, kind)
        } else {
            planning::discover_inputs(
                source,
                &home,
                args.source_config_dir.as_deref(),
                None,
                args.configuration_only,
                &context,
            )?
        };
        inputs.extend(discovered);
        if definitions {
            if let Some(project) = &args.project {
                let project = super::super::absolute(project, Some(&context.cwd))?;
                registry.authorize_definition_project(&context.profile, Some(&project))?;
            }
            inputs.extend(super::definitions::choose(
                guide,
                &mut registry,
                kind,
                args.project.is_some(),
                inputs.len(),
            )?);
        }
        if memory {
            ensure!(
                !args.configuration_only,
                "migration_conflicting_source_scope"
            );
            let found = super::memory::choose(guide, &mut registry, kind, inputs.len())?;
            inputs.extend(found);
        }
        if history {
            ensure!(
                !args.configuration_only,
                "migration_conflicting_source_scope"
            );
            let found = history_sources::choose(guide, &mut registry, kind, inputs.len())?;
            inputs.extend(found);
        }
        if plugins {
            ensure!(
                !args.configuration_only,
                "migration_conflicting_source_scope"
            );
            let found = plugin_sources::choose(guide, &mut registry, kind, inputs.len())?;
            inputs.extend(found);
        }
    }
    ensure!(!inputs.is_empty(), "migration_source_unavailable");
    ensure!(inputs.len() <= 64, "migration_batch_budget_exceeded");
    let context = guide.fresh()?;
    if inputs
        .iter()
        .any(|input| matches!(input, BatchSource::History(_)))
    {
        kcoder_migration::history_jobs::HistoryJobStore::open(&context.profile)?;
    }
    guide.fresh()?;
    super::settings_scope::save(guide, inputs, target_scope)
}

//! Re-discovery requires an exact public tuple; it never selects a new version by position.
use super::*;
use kcoder_migration::{
    discovery::{DiscoveredPluginPage, SourceRegistry},
    plugin_migration::PluginMigrationCandidate,
};
use kcoder_types::migration::MigrationSourceKind;

pub(in crate::migration_cli) fn registry(
    context: &Context,
    args: &MigrationPluginSourceArgs,
) -> Result<(SourceRegistry, MigrationSourceKind)> {
    super::super::planning::registry(
        args.source,
        &args.source_home,
        args.source_config_dir.as_deref(),
        None,
        context,
    )
}
pub(in crate::migration_cli) fn page(
    registry: &mut SourceRegistry,
    kind: MigrationSourceKind,
    page: u16,
    cancel: &PluginCancellationToken,
) -> Result<DiscoveredPluginPage> {
    let mut cursor = None;
    for at in 0..=page {
        let value = registry.discover_plugins(&[kind], cursor.as_deref(), cancel)?;
        if at == page {
            return Ok(value);
        }
        cursor = Some(
            value
                .next_cursor
                .ok_or_else(|| anyhow::anyhow!("plugin_migration_invalid_page"))?,
        );
    }
    unreachable!()
}
pub(super) fn select(
    context: &Context,
    args: &MigrationPluginSourceArgs,
    name: &str,
    scope: &str,
    version: Option<&str>,
    cancel: &PluginCancellationToken,
) -> Result<PluginMigrationCandidate> {
    ensure!(
        !name.is_empty()
            && name.len() <= 128
            && !scope.is_empty()
            && scope.len() <= 128
            && version.is_none_or(|v| v.len() <= 128),
        "plugin_migration_invalid_selection"
    );
    let (mut registry, kind) = registry(context, args)?;
    let mut cursor = None;
    let mut selected = None;
    loop {
        let page = registry.discover_plugins(&[kind], cursor.as_deref(), cancel)?;
        for item in page.candidates {
            let value = &item.candidate;
            if value.name == name
                && value.scope == scope
                && value.installed_version.as_deref() == version
            {
                ensure!(selected.is_none(), "plugin_migration_ambiguous_selection");
                selected = Some(registry.selected_plugin(&item.candidate_id)?);
            }
        }
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    selected.ok_or_else(|| anyhow::anyhow!("plugin_migration_selection_not_found"))
}

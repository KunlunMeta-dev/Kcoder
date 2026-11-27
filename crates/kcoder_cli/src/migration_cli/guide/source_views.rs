//! Select an effective static view explicitly; overlapping single-file views cannot remain selected.
use super::*;
use kcoder_migration::{
    batch::BatchSource,
    discovery::{DiscoveredConfiguration, SourceRegistry},
};
use kcoder_types::{
    migration::MigrationSourceKind,
    migration_source_bindings::MigrationSourceBindingFamily as Family,
};
use serde_json::json;
use std::collections::BTreeSet;

pub(super) fn choose(
    guide: &Guide<'_>,
    registry: &mut SourceRegistry,
    mut rows: Vec<DiscoveredConfiguration>,
    project: &Path,
) -> Result<Vec<BatchSource>> {
    let originals = rows.clone();
    let initial = rows
        .iter()
        .filter(|row| !matches!(row.scope, "project-effective" | "codex-project-layers"))
        .map(|row| row.source_id.clone())
        .collect::<BTreeSet<_>>();
    let mut chosen = initial.clone();
    let mut page = 0;
    loop {
        guide.fresh()?;
        ensure!(
            kcoder_config::FolderTrustStore::load(&guide.context.profile).check(project)
                == kcoder_config::FolderTrust::Trusted,
            "migration_project_source_not_trusted"
        );
        let visible=rows.iter().skip(page*10).take(10).enumerate().map(|(n,row)|json!({"number":n+1,"title":row.display_name,"scope":row.scope,"selected":chosen.contains(&row.source_id)})).collect::<Vec<_>>();
        let answer=guide.io.ask("configuration_sources", "Select static source views: toggle N toggles; layers N explicitly replaces a single file with this Codex user/profile and trusted project layers; report N views layers; originals reselects original single files; next/prev changes pages; done fixes the selection. Different views are not implicitly imported together.",json!({"page":page,"selected":chosen.len(),"items":visible}),Some("done"))?;
        let mut words = answer.split_whitespace();
        let action = words.next().unwrap_or("");
        let index = words
            .next()
            .and_then(|n| n.parse::<usize>().ok())
            .filter(|n| (1..=10).contains(n))
            .map(|n| page * 10 + n - 1)
            .filter(|n| *n < rows.len());
        match action {
            "next" if (page + 1) * 10 < rows.len() => page += 1,
            "prev" if page > 0 => page -= 1,
            "originals" => {
                rows = originals.clone();
                chosen = initial.clone();
                page = 0;
            }
            "done" => {
                ensure!(!chosen.is_empty(), "migration_source_unavailable");
                break;
            }
            "report" if index.is_some() => {
                let result = registry
                    .selected(&rows[index.unwrap()].source_id)
                    .and_then(|binding| super::layer_report::show(guide, &binding, false));
                if let Err(error) = result {
                    guide.io.notice(
                        &safe_error(&error),
                        "No readable layer report is available for this source; selected sources were not changed.",
                    )?;
                }
            }
            "layers" if index.is_some() => {
                let selected = match codex_layers(guide, registry, &rows[index.unwrap()], project) {
                    Ok(selected) => selected,
                    Err(error) => {
                        guide.io.notice(
                            &safe_error(&error),
                            "Layer selection did not succeed. Keep the original source and check the trusted project, or explicitly choose a single file.",
                        )?;
                        continue;
                    }
                };
                for id in &selected.replaces_source_ids {
                    chosen.remove(id);
                }
                rows.retain(|row| !selected.replaces_source_ids.contains(&row.source_id));
                chosen.insert(selected.source.source_id.clone());
                rows.insert(0, selected.source);
                page = 0;
                super::layer_report::show(guide, &registry.selected(&rows[0].source_id)?, false)?;
            }
            "toggle" if index.is_some() => {
                let row = &rows[index.unwrap()];
                if !chosen.remove(&row.source_id) {
                    if row.scope == "project-effective" {
                        for old in &rows {
                            if matches!(old.scope, "user" | "project" | "project-local")
                                && old.kind == row.kind
                            {
                                chosen.remove(&old.source_id);
                            }
                        }
                    } else if matches!(row.scope, "user" | "project" | "project-local") {
                        for old in &rows {
                            if old.scope == "project-effective" && old.kind == row.kind {
                                chosen.remove(&old.source_id);
                            }
                        }
                    }
                    chosen.insert(row.source_id.clone());
                }
            }
            _ => guide.io.notice(
                "migration_guide_invalid_selection",
                "Choose an operation and number on the current page.",
            )?,
        }
    }
    rows.into_iter()
        .filter(|row| chosen.contains(&row.source_id))
        .map(
            |row| match registry.source_binding_family(&row.source_id)? {
                Family::Configuration => {
                    let binding = registry.selected(&row.source_id)?;
                    binding.verify_codex_layer_authority(&guide.context.profile)?;
                    Ok(BatchSource::Configuration(binding))
                }
                Family::Assets => Ok(BatchSource::Assets(
                    registry.selected_asset(&row.source_id)?,
                )),
            },
        )
        .collect()
}

fn codex_layers(
    guide: &Guide<'_>,
    registry: &mut SourceRegistry,
    row: &DiscoveredConfiguration,
    project: &Path,
) -> Result<kcoder_migration::discovery::codex_layers::SelectedCodexLayers> {
    ensure!(
        row.kind == MigrationSourceKind::Codex && row.scope == "user",
        "migration_codex_user_source_required"
    );
    let cwd = project
        .canonicalize()
        .map_err(|_| anyhow::anyhow!("migration_unsafe_source_path"))?;
    let trust = kcoder_config::FolderTrustStore::load(&guide.context.profile);
    ensure!(
        trust.check(&cwd) == kcoder_config::FolderTrust::Trusted,
        "migration_codex_project_untrusted"
    );
    let mut root = cwd.clone();
    for _ in 0..63 {
        let Some(parent) = root.parent() else { break };
        if trust.check(parent) != kcoder_config::FolderTrust::Trusted {
            break;
        }
        kcoder_config::PrivateDirectory::open_existing(parent)?
            .verify_trusted_config_directory()?;
        root = parent.into();
    }
    registry.select_codex_layers(&row.source_id, &root, &cwd)
}

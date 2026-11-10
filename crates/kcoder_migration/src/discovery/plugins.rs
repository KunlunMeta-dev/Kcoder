//! Account-scoped plugin grants are snapshots of Native discovery, never client-provided paths.
use super::*;
use crate::plugin_migration::{PluginMigrationCandidate, PluginSourceProject};
use kcoder_plugins::PluginCancellationToken;
const MAX_PLUGIN_GRANTS: usize = 1024;
pub(super) struct Catalog {
    created: Instant,
    kinds: Vec<MigrationSourceKind>,
    entries: Vec<DiscoveredPlugin>,
    problems: Vec<DiscoveryProblem>,
    projects: Vec<PluginSourceProject>,
}
#[derive(Clone)]
pub struct DiscoveredPlugin {
    pub candidate_id: String,
    pub candidate: PluginMigrationCandidate,
}
pub struct DiscoveredPluginPage {
    pub candidates: Vec<DiscoveredPlugin>,
    pub next_cursor: Option<String>,
    pub problems: Vec<DiscoveryProblem>,
}
fn kinds(values: &[MigrationSourceKind]) -> Result<Vec<MigrationSourceKind>> {
    ensure!(values.len() <= 2, "plugin_migration_invalid_parameters");
    Ok(
        [MigrationSourceKind::ClaudeCode, MigrationSourceKind::Codex]
            .into_iter()
            .filter(|kind| values.is_empty() || values.contains(kind))
            .collect(),
    )
}
impl SourceRegistry {
    pub fn discover_plugins(
        &mut self,
        requested: &[MigrationSourceKind],
        cursor: Option<&str>,
        cancel: &PluginCancellationToken,
    ) -> Result<DiscoveredPluginPage> {
        self.discover_plugins_inner(requested, cursor, None, false, cancel)
    }
    /// Uploaded data grants never authorize inspecting the host's project or original paths.
    pub fn discover_uploaded_plugins(
        &mut self,
        requested: &[MigrationSourceKind],
        cursor: Option<&str>,
        cancel: &PluginCancellationToken,
    ) -> Result<DiscoveredPluginPage> {
        self.discover_plugins_inner(requested, cursor, None, true, cancel)
    }
    /// Source project inspection requires the host's separately authorized actual workspace.
    pub fn discover_plugins_in_project(
        &mut self,
        requested: &[MigrationSourceKind],
        cursor: Option<&str>,
        source_profile: &Path,
        workspace: &Path,
        cancel: &PluginCancellationToken,
    ) -> Result<DiscoveredPluginPage> {
        let expected = self
            .roots
            .project
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_project_source_not_trusted"))?;
        ensure!(
            PrivateDirectory::open_existing(expected)?.directory_identity()?
                == PrivateDirectory::open_existing(workspace)?.directory_identity()?,
            "migration_project_source_changed"
        );
        self.discover_plugins_inner(
            requested,
            cursor,
            Some((source_profile, workspace)),
            false,
            cancel,
        )
    }
    fn discover_plugins_inner(
        &mut self,
        requested: &[MigrationSourceKind],
        cursor: Option<&str>,
        project: Option<(&Path, &Path)>,
        include_uploaded: bool,
        cancel: &PluginCancellationToken,
    ) -> Result<DiscoveredPluginPage> {
        self.verify_selected_root(None)?;
        let mut requested = kinds(requested)?;
        let uploaded = self
            .selected_root
            .as_ref()
            .and_then(|selected| selected.binding.uploaded())
            .cloned();
        ensure!(
            uploaded.is_some() == include_uploaded,
            "migration_selected_root_plugins_unsupported"
        );
        if let Some(selected) = &self.selected_root {
            requested.retain(|kind| *kind == selected.binding.kind());
            ensure!(
                !requested.is_empty(),
                "migration_selected_root_scope_changed"
            );
        }
        let projects = project
            .map(|(profile, workspace)| {
                requested
                    .iter()
                    .map(|kind| PluginSourceProject::capture(profile, workspace, *kind))
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?
            .unwrap_or_default();
        let project_ids = projects
            .iter()
            .map(PluginSourceProject::revision)
            .collect::<Result<Vec<_>>>()?;
        let now = Instant::now();
        self.plugin_catalogs
            .retain(|_, catalog| now.duration_since(catalog.created) < GRANT_LIFETIME);
        let (id, offset) = match cursor {
            Some(cursor) => {
                ensure!(cursor.len() <= 96, "plugin_migration_invalid_cursor");
                let (id, offset) = cursor
                    .split_once(':')
                    .ok_or_else(|| anyhow::anyhow!("plugin_migration_invalid_cursor"))?;
                let offset = offset
                    .parse::<usize>()
                    .map_err(|_| anyhow::anyhow!("plugin_migration_invalid_cursor"))?;
                (id.to_string(), offset)
            }
            None => {
                let mut entries = vec![];
                let mut problems = vec![];
                for kind in &requested {
                    ensure!(!cancel.is_cancelled(), "plugin_migration_cancelled");
                    let custom = match kind {
                        MigrationSourceKind::ClaudeCode => &self.roots.claude_config_dir,
                        MigrationSourceKind::Codex => &self.roots.codex_home,
                    };
                    let root = custom.clone().unwrap_or_else(|| {
                        self.roots
                            .home
                            .join(if *kind == MigrationSourceKind::ClaudeCode {
                                ".claude"
                            } else {
                                ".codex"
                            })
                    });
                    if !root.is_absolute() {
                        problems.push(DiscoveryProblem {
                            kind: *kind,
                            scope: "user-plugins",
                            code: "migration_unsafe_source_path",
                        });
                        continue;
                    }
                    self.verify_selected_root(Some(*kind))?;
                    let discovered = if let Some(uploaded) = &uploaded {
                        crate::plugin_migration::discover_uploaded(uploaded, cancel)
                    } else if let Some(project) =
                        projects.iter().find(|project| project.kind() == *kind)
                    {
                        crate::plugin_migration::discover_with_project(
                            &root, *kind, project, cancel,
                        )
                    } else {
                        crate::plugin_migration::discover(&root, *kind, cancel)
                    };
                    match discovered {
                        Ok(catalog) => {
                            for candidate in catalog.candidates {
                                entries.push(DiscoveredPlugin {
                                    candidate_id: format!("plug-{}", uuid::Uuid::new_v4().simple()),
                                    candidate,
                                });
                            }
                            for issue in catalog.issues {
                                let code = match issue.as_str() {
                                    "plugin_install_index_missing" => {
                                        "plugin_install_index_missing"
                                    }
                                    "plugin_private_index_fields_pending" => {
                                        "plugin_private_index_fields_pending"
                                    }
                                    _ => "plugin_install_identity_pending",
                                };
                                problems.push(DiscoveryProblem {
                                    kind: *kind,
                                    scope: "user-plugins",
                                    code,
                                });
                            }
                        }
                        Err(_) => problems.push(DiscoveryProblem {
                            kind: *kind,
                            scope: "user-plugins",
                            code: "migration_source_unavailable",
                        }),
                    }
                }
                ensure!(!cancel.is_cancelled(), "plugin_migration_cancelled");
                ensure!(
                    entries.len() <= MAX_PLUGIN_GRANTS,
                    "plugin_migration_catalog_budget_exceeded"
                );
                while self
                    .plugin_catalogs
                    .values()
                    .map(|catalog| catalog.entries.len())
                    .sum::<usize>()
                    + entries.len()
                    > MAX_PLUGIN_GRANTS
                    || self.plugin_catalogs.len() >= 4
                {
                    let Some(oldest) = self
                        .plugin_catalogs
                        .iter()
                        .min_by_key(|(_, catalog)| catalog.created)
                        .map(|(id, _)| id.clone())
                    else {
                        break;
                    };
                    self.plugin_catalogs.remove(&oldest);
                }
                let id = format!("pcat-{}", uuid::Uuid::new_v4().simple());
                self.plugin_catalogs.insert(
                    id.clone(),
                    Catalog {
                        created: now,
                        kinds: requested.clone(),
                        entries,
                        problems,
                        projects: projects.clone(),
                    },
                );
                (id, 0)
            }
        };
        let catalog = self
            .plugin_catalogs
            .get(&id)
            .ok_or_else(|| anyhow::anyhow!("migration_source_selection_expired"))?;
        ensure!(
            catalog.kinds == requested
                && catalog
                    .projects
                    .iter()
                    .map(PluginSourceProject::revision)
                    .collect::<Result<Vec<_>>>()?
                    == project_ids
                && offset <= catalog.entries.len()
                && offset % 10 == 0,
            "plugin_migration_invalid_cursor"
        );
        let end = (offset + 10).min(catalog.entries.len());
        Ok(DiscoveredPluginPage {
            candidates: catalog.entries[offset..end].to_vec(),
            next_cursor: (end < catalog.entries.len()).then(|| format!("{id}:{end}")),
            problems: catalog.problems.clone(),
        })
    }
    pub fn selected_plugin(&self, candidate_id: &str) -> Result<PluginMigrationCandidate> {
        ensure!(
            candidate_id.len() <= 64,
            "plugin_migration_invalid_candidate"
        );
        for catalog in self
            .plugin_catalogs
            .values()
            .filter(|catalog| catalog.created.elapsed() < GRANT_LIFETIME)
        {
            if let Some(entry) = catalog
                .entries
                .iter()
                .find(|entry| entry.candidate_id == candidate_id)
            {
                self.verify_selected_root(Some(entry.candidate.source))?;
                for project in &catalog.projects {
                    project.verify()?;
                }
                return Ok(entry.candidate.clone());
            }
        }
        Err(anyhow::anyhow!("migration_source_selection_expired"))
    }
}

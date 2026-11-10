//! Explicit, bounded source-definition grants reuse the existing asset and configuration authority.
use super::*;
use crate::asset_sources::AssetBundleBinding;
use kcoder_config::imported_context::ImportedContextScope;

impl ConfigurationBinding {
    pub(crate) fn definition_location(&self) -> (&Path, &str) {
        (&self.root, &self.directory_identity)
    }
    pub(crate) fn definition_hook_bytes(&self) -> Result<Option<Vec<u8>>> {
        ensure!(
            !self.has_configuration_layers(),
            "migration_definition_single_source_required"
        );
        // MCP namespaces and legacy profile-table views do not establish a Hook file layout.
        if self.codex_profile.is_some()
            || !matches!(
                (self.kind, self.name.as_str(), self.scope.as_str()),
                (
                    MigrationSourceKind::ClaudeCode,
                    "settings.json",
                    "user" | "project"
                ) | (
                    MigrationSourceKind::ClaudeCode,
                    "settings.local.json",
                    "project-local"
                ) | (
                    MigrationSourceKind::Codex,
                    "config.toml",
                    "user" | "project"
                )
            )
        {
            return Ok(None);
        }
        self.verify_selected_directory()?;
        let directory = PrivateDirectory::open_existing(&self.root)?;
        directory.verify_trusted_config_directory()?;
        ensure!(
            directory.directory_identity()? == self.directory_identity,
            "migration_source_changed"
        );
        let source = SourceDocument::read_configuration_at(&directory, OsStr::new(&self.name))?;
        ensure!(
            source.revision() == self.revision,
            "migration_source_changed"
        );
        if let Some(root) = &self.selected_root {
            root.verify_uploaded_bytes(&self.root.join(&self.name), source.text().as_bytes())?;
        }
        let fragment = crate::definition_adapter::hooks_fragment(self.kind, source.text())?;
        self.verify_selected_directory()?;
        Ok(fragment)
    }
}
impl SourceRegistry {
    /// A selected product directory and a default home both require separate fresh project proof.
    pub fn authorize_definition_project(
        &mut self,
        profile: &Path,
        root: Option<&Path>,
    ) -> Result<()> {
        let root = root.ok_or_else(|| anyhow::anyhow!("migration_project_source_not_trusted"))?;
        if let Some(original) = &self.definition_project {
            ensure!(
                original.profile() == profile && original.root() == root,
                "migration_project_source_changed"
            );
            return original.verify();
        }
        let project = crate::selected_source_root::SelectedProjectRoot::capture(profile, root)?;
        ensure!(
            self.roots.project.as_deref() == Some(project.root()),
            "migration_project_source_changed"
        );
        self.definition_project = Some(project);
        Ok(())
    }
    fn verify_definition_project(&self) -> Result<()> {
        self.verify_selected_project()?;
        if let Some(root) = &self.roots.project {
            let project = self
                .definition_project
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("migration_project_source_not_trusted"))?;
            ensure!(project.root() == root, "migration_project_source_changed");
            project.verify()?;
        }
        Ok(())
    }
    /// Callers separately authorize the current project before setting include_project.
    pub fn discover_definitions(
        &mut self,
        kinds: &[MigrationSourceKind],
        include_project: bool,
    ) -> (Vec<DiscoveredConfiguration>, Vec<DiscoveryProblem>) {
        use MigrationCategory as Category;
        if include_project && self.verify_definition_project().is_err() {
            return (
                Vec::new(),
                vec![DiscoveryProblem {
                    kind: kinds
                        .first()
                        .copied()
                        .unwrap_or(MigrationSourceKind::ClaudeCode),
                    scope: "project-definitions",
                    code: "migration_project_source_unavailable",
                }],
            );
        }
        let (configuration, mut problems) =
            self.discover_with_assets(kinds, include_project, false);
        if include_project && self.verify_selected_project().is_err() {
            return (Vec::new(), problems);
        }
        let mut found = Vec::new();
        for row in configuration {
            let selected = self.selected(&row.source_id);
            let Ok(binding) = selected else {
                continue;
            };
            if binding.has_configuration_layers() {
                continue;
            }
            match AssetBundleBinding::from_inline_hooks(binding) {
                Ok(Some(binding)) => {
                    let scope = if row.scope == "project-local" {
                        "project-local-inline-hooks"
                    } else if row.scope.starts_with("project") {
                        "project-inline-hooks"
                    } else {
                        "user-inline-hooks"
                    };
                    if self
                        .grant_definition_asset(binding, scope, &mut found)
                        .is_err()
                    {
                        problems.push(DiscoveryProblem {
                            kind: row.kind,
                            scope,
                            code: "migration_definition_source_unavailable",
                        });
                    }
                }
                Ok(None) => {}
                Err(_) => problems.push(DiscoveryProblem {
                    kind: row.kind,
                    scope: row.scope,
                    code: "migration_definition_source_unavailable",
                }),
            }
        }
        for kind in [MigrationSourceKind::ClaudeCode, MigrationSourceKind::Codex] {
            if !kinds.is_empty() && !kinds.contains(&kind)
                || self.verify_selected_root(Some(kind)).is_err()
            {
                continue;
            }
            let custom = match kind {
                MigrationSourceKind::ClaudeCode => &self.roots.claude_config_dir,
                MigrationSourceKind::Codex => &self.roots.codex_home,
            };
            if custom.as_ref().is_some_and(|path| !path.is_absolute()) {
                problems.push(DiscoveryProblem {
                    kind,
                    scope: "user-definitions",
                    code: "migration_unsafe_source_path",
                });
                continue;
            }
            let home = custom.clone().unwrap_or_else(|| {
                self.roots
                    .home
                    .join(if kind == MigrationSourceKind::ClaudeCode {
                        ".claude"
                    } else {
                        ".codex"
                    })
            });
            let mut candidates = vec![(
                "user-agents",
                home.join("agents"),
                Category::Agent,
                ImportedContextScope::Global,
                true,
            )];
            if kind == MigrationSourceKind::Codex {
                candidates.push((
                    "user-hooks",
                    home.join("hooks.json"),
                    Category::Hook,
                    ImportedContextScope::Global,
                    false,
                ));
            }
            if include_project && let Some(project) = &self.roots.project {
                let root = project.join(if kind == MigrationSourceKind::ClaudeCode {
                    ".claude"
                } else {
                    ".codex"
                });
                let scope = ImportedContextScope::Project {
                    root: project.clone(),
                };
                candidates.push((
                    "project-agents",
                    root.join("agents"),
                    Category::Agent,
                    scope.clone(),
                    true,
                ));
                if kind == MigrationSourceKind::Codex {
                    candidates.push((
                        "project-hooks",
                        root.join("hooks.json"),
                        Category::Hook,
                        scope,
                        false,
                    ));
                }
            }
            for (scope, path, category, target_scope, directory) in candidates {
                match std::fs::symlink_metadata(&path) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(_) => {
                        problems.push(DiscoveryProblem {
                            kind,
                            scope,
                            code: "migration_definition_source_unavailable",
                        });
                        continue;
                    }
                    Ok(_) => {}
                }
                let source =
                    AssetBundleBinding::capture(&path, kind, category, target_scope, directory)
                        .and_then(|binding| {
                            binding.with_selected_root(
                                self.selected_root.as_ref().map(|root| root.binding.clone()),
                            )
                        });
                if source
                    .and_then(|binding| self.grant_definition_asset(binding, scope, &mut found))
                    .is_err()
                {
                    problems.push(DiscoveryProblem {
                        kind,
                        scope,
                        code: "migration_definition_source_unavailable",
                    });
                }
            }
        }
        (found, problems)
    }
    fn grant_definition_asset(
        &mut self,
        binding: AssetBundleBinding,
        scope: &'static str,
        found: &mut Vec<DiscoveredConfiguration>,
    ) -> Result<()> {
        let project = if matches!(binding.scope, ImportedContextScope::Project { .. }) {
            Some(
                self.definition_project
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("migration_project_source_not_trusted"))?
                    .clone(),
            )
        } else {
            None
        };
        let (binding, inventory) = binding.with_definition_project(project)?.freeze()?;
        if inventory.items.is_empty() {
            return Ok(());
        }
        let source_id = self
            .asset_grants
            .iter()
            .find(|(_, grant)| grant.binding == binding && grant.scope == scope)
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| format!("src-{}", uuid::Uuid::new_v4().simple()));
        ensure!(
            self.asset_grants.len() < MAX_GRANTS || self.asset_grants.contains_key(&source_id),
            "migration_source_budget_exceeded"
        );
        let kind = binding.kind;
        let category = binding.category;
        self.asset_grants.insert(
            source_id.clone(),
            AssetGrant {
                binding,
                scope,
                created: Instant::now(),
            },
        );
        found.push(DiscoveredConfiguration {
            source_id,
            kind,
            scope,
            format_revision: inventory.adapter_revision,
            categories: vec![category],
            display_name: format!(
                "{} · {}",
                product_name(kind),
                definition_location(kind, scope)
            ),
        });
        Ok(())
    }
}

fn definition_location(kind: MigrationSourceKind, scope: &str) -> &'static str {
    match (kind, scope) {
        (MigrationSourceKind::ClaudeCode, "user-agents") => "agents/*.md",
        (MigrationSourceKind::Codex, "user-agents") => "agents/*.toml",
        (MigrationSourceKind::ClaudeCode, "project-agents") => ".claude/agents/*.md",
        (MigrationSourceKind::Codex, "project-agents") => ".codex/agents/*.toml",
        (MigrationSourceKind::ClaudeCode, "user-inline-hooks") => "settings.json · hooks",
        (MigrationSourceKind::Codex, "user-inline-hooks") => "config.toml · hooks",
        (MigrationSourceKind::ClaudeCode, "project-local-inline-hooks") => {
            ".claude/settings.local.json · hooks"
        }
        (MigrationSourceKind::ClaudeCode, "project-inline-hooks") => {
            ".claude/settings.json · hooks"
        }
        (MigrationSourceKind::Codex, "project-inline-hooks") => ".codex/config.toml · hooks",
        (_, "project-hooks") => ".codex/hooks.json",
        _ => "hooks.json",
    }
}

pub struct DefinitionSourcePage {
    pub catalog_id: String,
    pub sources: Vec<DiscoveredConfiguration>,
    pub problems: Vec<DiscoveryProblem>,
    pub total_sources: u32,
    pub next_page: Option<u32>,
}
pub(super) struct Catalog {
    created: Instant,
    sources: Vec<DiscoveredConfiguration>,
    problems: Vec<DiscoveryProblem>,
    kinds: Vec<MigrationSourceKind>,
    include_project: bool,
}
impl SourceRegistry {
    /// Later pages keep the original finite discovery snapshot and never renew its grants.
    pub fn definition_page(
        &mut self,
        kinds: &[MigrationSourceKind],
        include_project: bool,
        catalog_id: Option<&str>,
        page_index: u32,
    ) -> Result<DefinitionSourcePage> {
        self.verify_selected_root(None)?;
        if include_project {
            self.verify_definition_project()?;
        }
        ensure!(
            kinds.len() <= 2 && page_index < 26,
            "migration_invalid_page"
        );
        self.definition_catalogs
            .retain(|_, catalog| catalog.created.elapsed() < GRANT_LIFETIME);
        let id = if let Some(id) = catalog_id {
            ensure!(id.len() <= 80, "migration_invalid_parameters");
            id.to_owned()
        } else {
            ensure!(
                page_index == 0 && self.definition_catalogs.len() < 8,
                "migration_definition_catalog_limit"
            );
            let (sources, problems) = self.discover_definitions(kinds, include_project);
            ensure!(
                sources.len() <= MAX_GRANTS,
                "migration_definition_catalog_limit"
            );
            let id = format!("defcat-{}", uuid::Uuid::new_v4().simple());
            self.definition_catalogs.insert(
                id.clone(),
                Catalog {
                    created: Instant::now(),
                    sources,
                    problems,
                    kinds: kinds.into(),
                    include_project,
                },
            );
            id
        };
        let catalog = self
            .definition_catalogs
            .get(&id)
            .ok_or_else(|| anyhow::anyhow!("migration_source_selection_expired"))?;
        ensure!(
            catalog.kinds == kinds && catalog.include_project == include_project,
            "migration_definition_catalog_changed"
        );
        let start = page_index as usize * 10;
        ensure!(
            start < catalog.sources.len() || start == 0,
            "migration_invalid_page"
        );
        Ok(DefinitionSourcePage {
            catalog_id: id,
            sources: catalog
                .sources
                .iter()
                .skip(start)
                .take(10)
                .cloned()
                .collect(),
            problems: catalog.problems.clone(),
            total_sources: catalog.sources.len() as u32,
            next_page: (start + 10 < catalog.sources.len()).then_some(page_index + 1),
        })
    }
}

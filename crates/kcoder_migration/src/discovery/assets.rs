//! Fixed source locations; no source-provided helper or credential file is evaluated.
use super::*;
use crate::asset_sources::AssetBundleBinding;
use kcoder_config::imported_context::ImportedContextScope;

impl SourceRegistry {
    pub fn selected_asset(&self, source_id: &str) -> Result<AssetBundleBinding> {
        self.verify_selected_root(None)?;
        self.asset_grants
            .get(source_id)
            .filter(|grant| grant.created.elapsed() < GRANT_LIFETIME)
            .map(|grant| grant.binding.clone())
            .ok_or_else(|| anyhow::anyhow!("migration_source_selection_expired"))
    }
    pub(super) fn discover_assets(
        &mut self,
        kinds: &[MigrationSourceKind],
        include_project: bool,
    ) -> (Vec<DiscoveredConfiguration>, Vec<DiscoveryProblem>) {
        use MigrationCategory as Category;
        let now = Instant::now();
        self.asset_grants
            .retain(|_, grant| now.duration_since(grant.created) < GRANT_LIFETIME);
        let mut candidates = Vec::new();
        let mut problems = Vec::new();
        for kind in [MigrationSourceKind::ClaudeCode, MigrationSourceKind::Codex] {
            if !kinds.is_empty() && !kinds.contains(&kind) {
                continue;
            }
            if self.verify_selected_root(Some(kind)).is_err() {
                continue;
            }
            let custom = match kind {
                MigrationSourceKind::ClaudeCode => &self.roots.claude_config_dir,
                MigrationSourceKind::Codex => &self.roots.codex_home,
            };
            if custom.as_ref().is_some_and(|path| !path.is_absolute()) {
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
            let global = ImportedContextScope::Global;
            let instructions = if kind == MigrationSourceKind::ClaudeCode {
                "CLAUDE.md"
            } else {
                "AGENTS.md"
            };
            candidates.push((
                kind,
                "user-instructions",
                home.join(instructions),
                Category::Instructions,
                global.clone(),
                false,
            ));
            if kind == MigrationSourceKind::Codex {
                candidates.push((
                    kind,
                    "user-override",
                    home.join("AGENTS.override.md"),
                    Category::Instructions,
                    global.clone(),
                    false,
                ));
                if self.selected_root.is_none() {
                    candidates.push((
                        kind,
                        "user-skills",
                        self.roots.home.join(".agents/skills"),
                        Category::Skill,
                        global.clone(),
                        true,
                    ));
                }
                candidates.push((
                    kind,
                    "user-legacy-skills",
                    home.join("skills"),
                    Category::Skill,
                    global.clone(),
                    true,
                ));
            } else {
                candidates.push((
                    kind,
                    "user-skills",
                    home.join("skills"),
                    Category::Skill,
                    global.clone(),
                    true,
                ));
                candidates.push((
                    kind,
                    "user-commands",
                    home.join("commands"),
                    Category::Command,
                    global.clone(),
                    true,
                ));
                candidates.push((
                    kind,
                    "user-rules",
                    home.join("rules"),
                    Category::Instructions,
                    global.clone(),
                    true,
                ));
            }
            if include_project && let Some(project) = &self.roots.project {
                let scope = ImportedContextScope::Project {
                    root: project.clone(),
                };
                candidates.push((
                    kind,
                    "project-instructions",
                    project.join(instructions),
                    Category::Instructions,
                    scope.clone(),
                    false,
                ));
                if kind == MigrationSourceKind::ClaudeCode {
                    candidates.push((
                        kind,
                        "project-local-instructions",
                        project.join("CLAUDE.local.md"),
                        Category::Instructions,
                        scope.clone(),
                        false,
                    ));
                    candidates.push((
                        kind,
                        "project-internal-instructions",
                        project.join(".claude/CLAUDE.md"),
                        Category::Instructions,
                        scope.clone(),
                        false,
                    ));
                    for (scope_name, name, category) in [
                        ("project-skills", "skills", Category::Skill),
                        ("project-commands", "commands", Category::Command),
                        ("project-rules", "rules", Category::Instructions),
                    ] {
                        candidates.push((
                            kind,
                            scope_name,
                            project.join(".claude").join(name),
                            category,
                            scope.clone(),
                            true,
                        ));
                    }
                } else {
                    candidates.push((
                        kind,
                        "project-override",
                        project.join("AGENTS.override.md"),
                        Category::Instructions,
                        scope.clone(),
                        false,
                    ));
                    candidates.push((
                        kind,
                        "project-skills",
                        project.join(".agents/skills"),
                        Category::Skill,
                        scope.clone(),
                        true,
                    ));
                    candidates.push((
                        kind,
                        "project-legacy-skills",
                        project.join(".codex/skills"),
                        Category::Skill,
                        scope,
                        true,
                    ));
                }
            }
        }
        let mut found = Vec::new();
        for (kind, scope, path, category, asset_scope, directory) in candidates {
            match std::fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    problems.push(DiscoveryProblem {
                        kind,
                        scope,
                        code: "migration_source_unavailable",
                    });
                    continue;
                }
                Ok(_) => {}
            }
            let result = AssetBundleBinding::capture(&path, kind, category, asset_scope, directory)
                .and_then(|binding| {
                    binding.with_selected_root(
                        self.selected_root.as_ref().map(|root| root.binding.clone()),
                    )
                })
                .and_then(AssetBundleBinding::freeze);
            match result {
                Ok((binding, inventory)) => {
                    let source_id = self
                        .asset_grants
                        .iter()
                        .find(|(_, grant)| grant.binding == binding && grant.scope == scope)
                        .map(|(id, _)| id.clone())
                        .unwrap_or_else(|| format!("src-{}", uuid::Uuid::new_v4().simple()));
                    if self.asset_grants.len() >= MAX_GRANTS
                        && !self.asset_grants.contains_key(&source_id)
                        && let Some(oldest) = self
                            .asset_grants
                            .iter()
                            .min_by_key(|(_, grant)| grant.created)
                            .map(|(id, _)| id.clone())
                    {
                        self.asset_grants.remove(&oldest);
                    }
                    self.asset_grants.insert(
                        source_id.clone(),
                        AssetGrant {
                            binding,
                            scope,
                            created: now,
                        },
                    );
                    found.push(DiscoveredConfiguration {
                        source_id,
                        kind,
                        scope,
                        format_revision: inventory.adapter_revision,
                        categories: vec![category],
                        display_name: super::product_name(kind).into(),
                    });
                }
                Err(_) => problems.push(DiscoveryProblem {
                    kind,
                    scope,
                    code: "migration_source_unreadable_or_unsupported",
                }),
            }
        }
        (found, problems)
    }
}

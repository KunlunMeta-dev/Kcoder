//! Explicit memory inventories never guess a workspace from a vendor directory encoding.
use super::*;
use crate::asset_sources::AssetBundleBinding;
use kcoder_config::imported_context::ImportedContextScope;
use kcoder_types::imported_memory::*;

pub(super) struct Catalog {
    created: Instant,
    bindings: Vec<(String, AssetBundleBinding)>,
    summaries: BTreeMap<String, ImportedMemorySourceSummary>,
    problems: Vec<ImportedMemoryDiscoveryProblem>,
}

impl SourceRegistry {
    pub fn discover_memories(
        &mut self,
        source: MigrationSourceKind,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<ImportedMemorySourcePage> {
        self.verify_selected_root(Some(source))?;
        self.memory_catalogs
            .retain(|_, catalog| catalog.created.elapsed() < GRANT_LIFETIME);
        ensure!(
            self.memory_catalogs.len() < 8,
            "migration_memory_catalog_limit"
        );
        let root = match source {
            MigrationSourceKind::ClaudeCode => self
                .roots
                .claude_config_dir
                .clone()
                .unwrap_or_else(|| self.roots.home.join(".claude")),
            MigrationSourceKind::Codex => self
                .roots
                .codex_home
                .clone()
                .unwrap_or_else(|| self.roots.home.join(".codex")),
        };
        let guard = match &self.selected_root {
            Some(selected) => selected.binding.clone(),
            None => crate::selected_source_root::SelectedRootBinding::capture(&root, source)?,
        };
        let parent = PrivateDirectory::open_existing(guard.root())?;
        let mut candidates = Vec::new();
        if source == MigrationSourceKind::ClaudeCode {
            let projects = match parent.open_child(std::ffi::OsStr::new("projects"), false) {
                Ok(directory) => Some(directory),
                Err(error) if missing(&error) => None,
                Err(error) => return Err(error),
            };
            if let Some(projects) = projects {
                projects.visit_entry_names_bounded(4096, |name| {
                    ensure!(check(candidates.len() as u64), "migration_cancelled");
                    let name = name
                        .to_str()
                        .filter(|name| {
                            !name.is_empty()
                                && name.len() <= 256
                                && !name.chars().any(char::is_control)
                        })
                        .ok_or_else(|| anyhow::anyhow!("migration_memory_layout_unsupported"))?;
                    let metadata = projects.entry_metadata(std::ffi::OsStr::new(name))?;
                    if !metadata.is_dir() || metadata.file_type().is_symlink() {
                        return Ok(());
                    }
                    let child = projects.open_child(std::ffi::OsStr::new(name), false)?;
                    match child.entry_metadata(std::ffi::OsStr::new("memory")) {
                        Ok(_) => {
                            ensure!(candidates.len() < 64, "migration_memory_catalog_limit");
                            candidates.push((
                                guard.root().join("projects").join(name).join("memory"),
                                name.to_string(),
                                ImportedMemoryLayout::ClaudeAutoMemoryV1,
                            ));
                        }
                        Err(error) if missing(&error) => {}
                        Err(error) => return Err(error),
                    }
                    Ok(())
                })?;
            }
        } else {
            candidates.push((
                guard.root().join("memories"),
                "memories".into(),
                ImportedMemoryLayout::CodexMemoryFilesV1,
            ));
        }
        let mut bindings = Vec::new();
        let mut problems = BTreeMap::<String, u32>::new();
        for (path, group, layout) in candidates {
            ensure!(check(bindings.len() as u64), "migration_cancelled");
            let result = AssetBundleBinding::capture(
                &path,
                source,
                MigrationCategory::Memory,
                ImportedContextScope::Global,
                true,
            )
            .and_then(|binding| binding.with_selected_root(Some(guard.clone())))
            .and_then(|binding| binding.with_memory(layout, group));
            match result {
                Ok(binding) => {
                    bindings.push((format!("src-{}", uuid::Uuid::new_v4().simple()), binding))
                }
                Err(_) => {
                    *problems
                        .entry("memory_source_unavailable_or_unsupported".into())
                        .or_default() += 1
                }
            }
        }
        let id = format!("memory-{}", uuid::Uuid::new_v4().simple());
        self.memory_catalogs.insert(
            id.clone(),
            Catalog {
                created: Instant::now(),
                bindings,
                summaries: BTreeMap::new(),
                problems: problems
                    .into_iter()
                    .map(|(code, count)| ImportedMemoryDiscoveryProblem { code, count })
                    .collect(),
            },
        );
        self.memory_page(&id, None, check)
    }

    pub fn memory_page(
        &mut self,
        catalog_id: &str,
        cursor: Option<&str>,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<ImportedMemorySourcePage> {
        self.verify_selected_root(None)?;
        let start = match cursor {
            Some(cursor) => {
                let (id, offset) = cursor
                    .rsplit_once(':')
                    .ok_or_else(|| anyhow::anyhow!("migration_memory_cursor_invalid"))?;
                ensure!(id == catalog_id, "migration_memory_cursor_invalid");
                offset
                    .parse::<usize>()
                    .map_err(|_| anyhow::anyhow!("migration_memory_cursor_invalid"))?
            }
            None => 0,
        };
        let catalog = self
            .memory_catalogs
            .get_mut(catalog_id)
            .ok_or_else(|| anyhow::anyhow!("migration_memory_catalog_unavailable"))?;
        ensure!(
            catalog.created.elapsed() < GRANT_LIFETIME
                && start % 10 == 0
                && (start < catalog.bindings.len() || start == 0),
            "migration_memory_catalog_unavailable"
        );
        let mut items = Vec::new();
        for (id, original) in catalog.bindings.iter().skip(start).take(10) {
            ensure!(check(items.len() as u64), "migration_cancelled");
            original.entries()?;
            if !catalog.summaries.contains_key(id) {
                let (binding, inventory) = original.clone().freeze_checked(&mut *check)?;
                let (layout, source_group) = binding
                    .memory_descriptor()
                    .ok_or_else(|| anyhow::anyhow!("migration_invalid_source_binding"))?;
                let row = ImportedMemorySourceSummary {
                    source_id: id.clone(),
                    source: binding.kind,
                    layout,
                    source_group,
                    files: inventory.items.len() as u32,
                    bytes: inventory
                        .items
                        .iter()
                        .filter_map(|item| item.asset.as_ref())
                        .map(|item| item.bytes as u64)
                        .sum(),
                    blocked_items: inventory
                        .items
                        .iter()
                        .filter(|item| {
                            item.preview
                                .issues
                                .iter()
                                .any(|issue| issue.blocks_import())
                        })
                        .count() as u32,
                };
                if self.asset_grants.len() >= MAX_GRANTS
                    && !self.asset_grants.contains_key(id)
                    && let Some(oldest) = self
                        .asset_grants
                        .iter()
                        .min_by_key(|(_, grant)| grant.created)
                        .map(|(id, _)| id.clone())
                {
                    self.asset_grants.remove(&oldest);
                }
                self.asset_grants.insert(
                    id.clone(),
                    AssetGrant {
                        binding,
                        scope: "memory",
                        created: catalog.created,
                    },
                );
                catalog.summaries.insert(id.clone(), row);
            }
            ensure!(
                self.asset_grants
                    .get(id)
                    .is_some_and(|grant| grant.created.elapsed() < GRANT_LIFETIME),
                "migration_source_selection_expired"
            );
            items.push(catalog.summaries[id].clone());
        }
        Ok(ImportedMemorySourcePage {
            catalog_id: catalog_id.into(),
            items,
            next_cursor: (start + 10 < catalog.bindings.len())
                .then(|| format!("{catalog_id}:{}", start + 10)),
            problems: catalog.problems.clone(),
            unobserved: vec![
                "source_runtime_selection".into(),
                "custom_memory_directories".into(),
                "subagent_memory".into(),
                "encoded_project_path_mapping".into(),
            ],
        })
    }
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

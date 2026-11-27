//! Connection-owned Native target catalogs. Clients select handles, never target paths.
use super::{binding::ProjectBatchSource, target::ProjectTargetSelection};
use anyhow::{Result, ensure};
use kcoder_config::{
    PrivateDirectory,
    imported_projects::{ProjectWorkspaceMembership, ProjectWorkspaceRegistry},
};
use kcoder_types::migration_projects::*;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

enum EntryAuthority {
    Registered(ProjectWorkspaceMembership),
    Current,
}
struct Entry {
    handle: String,
    project_key: String,
    observed: Mutex<Option<Vec<Option<String>>>>,
    label: String,
    roots: Vec<String>,
    current: bool,
    authority: EntryAuthority,
}
pub struct ProjectTargetCatalog {
    id: String,
    profile_identity: String,
    created: Instant,
    entries: Vec<Entry>,
    registry_observed: bool,
}
fn identity(path: &Path) -> Result<String> {
    let directory = PrivateDirectory::open_existing(path)?;
    directory.verify_trusted_config_directory()?;
    directory.directory_identity()
}
fn root_handle(catalog: &str, target: &str, index: usize) -> String {
    format!(
        "target-root-{:x}",
        Sha256::digest(format!("project-target/1\0{catalog}\0{target}\0{index}"))
    )
}
impl ProjectTargetCatalog {
    /// All arguments come from the original Native Host context. None is taken from an RPC path.
    /// None registry means the registered inventory was not observed; only current context is offered.
    pub fn capture(
        profile: &Path,
        current_workspace: &Path,
        current_project_key: &str,
        registry: Option<&ProjectWorkspaceRegistry>,
    ) -> Result<Self> {
        let profile_identity = identity(profile)?;
        let current_identity = identity(current_workspace)?;
        let current_workspace = current_workspace.canonicalize()?;
        ensure!(
            identity(&current_workspace)? == current_identity,
            "migration_project_target_changed"
        );
        let mut entries = Vec::new();
        if let Some(registry) = registry {
            for (row, membership) in registry.pinned_projects()? {
                // Display affinity only; authorization checks the observed native identities again below.
                let current = row
                    .roots
                    .iter()
                    .any(|root| Path::new(root) == current_workspace);
                entries.push(Entry {
                    handle: format!("target-project-{}", uuid::Uuid::new_v4().simple()),
                    project_key: row.project_key,
                    observed: Mutex::new(None),
                    label: row.label,
                    roots: row.roots,
                    current,
                    authority: EntryAuthority::Registered(membership),
                });
            }
        }
        if !entries.iter().any(|entry| entry.current) {
            entries.insert(
                0,
                Entry {
                    handle: format!("target-project-{}", uuid::Uuid::new_v4().simple()),
                    project_key: current_project_key.to_owned(),
                    observed: Mutex::new(Some(vec![Some(current_identity.clone())])),
                    label: current_workspace
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(str::to_owned)
                        .unwrap_or_else(|| current_workspace.to_string_lossy().into_owned()),
                    roots: vec![current_workspace.to_string_lossy().into_owned()],
                    current: true,
                    authority: EntryAuthority::Current,
                },
            );
        }
        // The key is the original Native workspace key, not a source-derived project label.
        if let Some(entry) = entries
            .iter_mut()
            .find(|entry| matches!(entry.authority, EntryAuthority::Current))
        {
            if current_project_key.is_empty() {
                anyhow::bail!("migration_project_target_unavailable");
            }
            entry.label = if entry.label.is_empty() {
                current_project_key.to_owned()
            } else {
                entry.label.clone()
            };
        }
        Ok(Self {
            id: format!("project-targets-{}", uuid::Uuid::new_v4().simple()),
            profile_identity,
            created: Instant::now(),
            entries,
            registry_observed: registry.is_some(),
        })
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn expired(&self) -> bool {
        self.created.elapsed() > Duration::from_secs(600)
    }
    fn valid(&self, profile: &Path) -> Result<()> {
        ensure!(!self.expired(), "migration_project_target_catalog_expired");
        ensure!(
            identity(profile)? == self.profile_identity,
            "migration_wrong_target"
        );
        Ok(())
    }
    pub fn page(&self, profile: &Path, page: u32) -> Result<MigrationProjectTargetsResult> {
        self.valid(profile)?;
        let start = (page as usize)
            .checked_mul(10)
            .ok_or_else(|| anyhow::anyhow!("migration_invalid_cursor"))?;
        ensure!(start <= self.entries.len(), "migration_invalid_cursor");
        Ok(MigrationProjectTargetsResult {
            target_catalog_id: self.id.clone(),
            page_index: page,
            registered_workspaces_observed: self.registry_observed,
            items: self
                .entries
                .iter()
                .skip(start)
                .take(10)
                .map(|entry| MigrationProjectTargetSummary {
                    target_handle: entry.handle.clone(),
                    display_name: entry.label.clone(),
                    roots: entry.roots.len() as u32,
                    current_workspace: entry.current,
                })
                .collect(),
            total_items: self.entries.len() as u32,
            next_page: (start + 10 < self.entries.len()).then_some(page + 1),
        })
    }
    pub fn roots(
        &self,
        profile: &Path,
        target: &str,
        page: u32,
    ) -> Result<MigrationProjectTargetRootsResult> {
        self.valid(profile)?;
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.handle == target)
            .ok_or_else(|| anyhow::anyhow!("migration_project_target_unknown"))?;
        let start = (page as usize)
            .checked_mul(10)
            .ok_or_else(|| anyhow::anyhow!("migration_invalid_cursor"))?;
        ensure!(start <= entry.roots.len(), "migration_invalid_cursor");
        let read = || {
            let mut observed = entry
                .observed
                .lock()
                .map_err(|_| anyhow::anyhow!("migration_project_target_unavailable"))?;
            if observed.is_none() {
                let mut handles = Vec::new();
                let started = Instant::now();
                for path in &entry.roots {
                    ensure!(
                        started.elapsed() < Duration::from_secs(1),
                        "migration_project_target_budget_exceeded"
                    );
                    handles.push(identity(Path::new(path)).ok());
                }
                *observed = Some(handles);
            }
            let captured = observed
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("migration_project_target_unavailable"))?;
            let trust = kcoder_config::FolderTrustStore::load(profile);
            let roots = entry
                .roots
                .iter()
                .enumerate()
                .skip(start)
                .take(10)
                .map(|(index, path)| MigrationProjectTargetRoot {
                    target_root_handle: root_handle(&self.id, &entry.handle, index),
                    ordinal: index as u32,
                    path: path.clone(),
                    trusted: trust.check(Path::new(path)) == kcoder_config::FolderTrust::Trusted,
                    available: captured[index].as_ref().is_some_and(|original| {
                        Some(original) == identity(Path::new(path)).ok().as_ref()
                    }),
                })
                .collect();
            Ok(MigrationProjectTargetRootsResult {
                target_catalog_id: self.id.clone(),
                target_handle: target.to_owned(),
                page_index: page,
                roots,
                total_roots: entry.roots.len() as u32,
                next_page: (start + 10 < entry.roots.len()).then_some(page + 1),
            })
        };
        match &entry.authority {
            EntryAuthority::Registered(membership) => membership.with_registered(read),
            EntryAuthority::Current => read(),
        }
    }
    pub fn resolve(
        &self,
        profile: &Path,
        source: &ProjectBatchSource,
        choice: &MigrationProjectMappingChoice,
    ) -> Result<ProjectTargetSelection> {
        self.valid(profile)?;
        ensure!(
            choice.target_catalog_id == self.id,
            "migration_wrong_target"
        );
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.handle == choice.target_handle)
            .ok_or_else(|| anyhow::anyhow!("migration_project_target_unknown"))?;
        ensure!(
            choice.mappings.len() == source.record().roots.len(),
            "migration_project_mapping_required"
        );
        let observed = entry
            .observed
            .lock()
            .map_err(|_| anyhow::anyhow!("migration_project_target_unavailable"))?;
        let observed = observed
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_project_target_observation_required"))?;
        for index in std::iter::once(0).chain(choice.mappings.iter().filter_map(|mapping| {
            (0..entry.roots.len()).find(|index| {
                root_handle(&self.id, &entry.handle, *index) == mapping.target_root_handle
            })
        })) {
            let original = observed[index]
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("migration_project_target_unavailable"))?;
            ensure!(
                *original == identity(Path::new(&entry.roots[index]))?,
                "migration_project_target_changed"
            );
        }
        let mut mappings = Vec::new();
        let mut seen = BTreeSet::new();
        for (source_index, _) in source.record().roots.iter().enumerate() {
            let source_id = source.source_root_id(source_index)?;
            let matched = choice
                .mappings
                .iter()
                .filter(|mapping| mapping.source_root_id == source_id)
                .collect::<Vec<_>>();
            ensure!(matched.len() == 1, "migration_project_invalid_mapping");
            let target_index = (0..entry.roots.len())
                .find(|index| {
                    root_handle(&self.id, &entry.handle, *index) == matched[0].target_root_handle
                })
                .ok_or_else(|| anyhow::anyhow!("migration_project_invalid_mapping"))?;
            ensure!(
                seen.insert(target_index),
                "migration_project_invalid_mapping"
            );
            mappings.push((source_index, target_index));
        }
        let selection = match &entry.authority {
            EntryAuthority::Registered(membership) => {
                ProjectTargetSelection::registered(profile, membership.clone(), source, &mappings)
            }
            EntryAuthority::Current => ProjectTargetSelection::current_workspace(
                profile,
                &PathBuf::from(&entry.roots[0]),
                &entry.project_key,
                source,
            ),
        }?;
        ensure!(
            selection.target().workspace_identity
                == observed[0]
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("migration_project_target_unavailable"))?
                    .clone(),
            "migration_project_target_changed"
        );
        for (source_index, target_index) in &mappings {
            ensure!(
                selection.target().roots[*source_index].target_identity
                    == observed[*target_index]
                        .as_ref()
                        .ok_or_else(|| anyhow::anyhow!("migration_project_target_unavailable"))?
                        .clone(),
                "migration_project_target_changed"
            );
        }
        Ok(selection)
    }
}

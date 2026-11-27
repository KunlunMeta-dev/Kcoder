//! Only Native target catalogs construct these mappings. Source roots grant no target access.
use super::binding::ProjectBatchSource;
use anyhow::{Result, ensure};
use kcoder_config::{PrivateDirectory, imported_projects::ProjectWorkspaceMembership};
use kcoder_types::imported_projects::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Authority {
    Registered {
        membership: ProjectWorkspaceMembership,
    },
    CurrentWorkspace,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectTargetSelection {
    version: u32,
    source_fingerprint: String,
    profile_identity: String,
    authority: Authority,
    target: ImportedProjectTarget,
}
fn identity(path: &Path) -> Result<String> {
    let directory = PrivateDirectory::open_existing(path)?;
    directory.verify_trusted_config_directory()?;
    directory.directory_identity()
}
impl ProjectTargetSelection {
    /// Every index is resolved from the original Native source and target catalogs. The RPC
    /// accepts only their opaque handles, never these path values or a serialized membership.
    pub fn registered(
        profile: &Path,
        membership: ProjectWorkspaceMembership,
        source: &ProjectBatchSource,
        mappings: &[(usize, usize)],
    ) -> Result<Self> {
        ensure!(
            mappings.len() == source.record().roots.len(),
            "migration_project_mapping_required"
        );
        let mut source_roots = BTreeSet::new();
        let mut target_roots = BTreeSet::new();
        let mut roots = Vec::new();
        for (source_index, target_index) in mappings {
            let source_path = source
                .record()
                .roots
                .get(*source_index)
                .ok_or_else(|| anyhow::anyhow!("migration_project_invalid_mapping"))?;
            let target_path = membership
                .roots()
                .get(*target_index)
                .ok_or_else(|| anyhow::anyhow!("migration_project_invalid_mapping"))?;
            ensure!(
                source_roots.insert(*source_index) && target_roots.insert(*target_index),
                "migration_project_invalid_mapping"
            );
            roots.push((
                *source_index,
                ImportedProjectRoot {
                    source_root_id: source.source_root_id(*source_index)?,
                    source_path: source_path.clone(),
                    target_root: PathBuf::from(target_path),
                    target_identity: identity(Path::new(target_path))?,
                },
            ));
        }
        roots.sort_by_key(|(index, _)| *index);
        let workspace = membership
            .roots()
            .first()
            .ok_or_else(|| anyhow::anyhow!("migration_project_invalid_mapping"))?;
        let target = ImportedProjectTarget {
            project_key: membership.project_key().to_owned(),
            workspace: PathBuf::from(workspace),
            workspace_identity: identity(Path::new(workspace))?,
            roots: roots.into_iter().map(|(_, root)| root).collect(),
        };
        let selection = Self {
            version: 1,
            source_fingerprint: source.identity().to_owned(),
            profile_identity: identity(profile)?,
            authority: Authority::Registered { membership },
            target,
        };
        Ok(selection)
    }
    /// The caller passes the current original Engine workspace, not a source or client path.
    /// Multi-root source projects require an explicitly registered Native multi-root project.
    pub fn current_workspace(
        profile: &Path,
        workspace: &Path,
        project_key: &str,
        source: &ProjectBatchSource,
    ) -> Result<Self> {
        ensure!(
            source.record().roots.len() <= 1,
            "migration_project_multi_root_mapping_required"
        );
        let workspace_identity = identity(workspace)?;
        let workspace = workspace.canonicalize()?;
        ensure!(
            identity(&workspace)? == workspace_identity,
            "migration_project_target_changed"
        );
        Ok(Self {
            version: 1,
            source_fingerprint: source.identity().to_owned(),
            profile_identity: identity(profile)?,
            authority: Authority::CurrentWorkspace,
            target: ImportedProjectTarget {
                project_key: project_key.to_owned(),
                workspace: workspace.clone(),
                workspace_identity: workspace_identity.clone(),
                roots: if let Some(source_root) = source.record().roots.first() {
                    vec![ImportedProjectRoot {
                        source_root_id: source.source_root_id(0)?,
                        source_path: source_root.clone(),
                        target_root: workspace,
                        target_identity: workspace_identity,
                    }]
                } else {
                    Vec::new()
                },
            },
        })
    }
    pub fn verify_host_context(
        &self,
        profile: &Path,
        workspace: &Path,
        registry: Option<&Path>,
    ) -> Result<()> {
        self.verify_profile(profile)?;
        match &self.authority {
            Authority::Registered { membership } => membership.verify_registry_root(
                registry.ok_or_else(|| anyhow::anyhow!("migration_wrong_target"))?,
            ),
            Authority::CurrentWorkspace => {
                ensure!(
                    identity(workspace)? == self.target.workspace_identity,
                    "migration_wrong_target"
                );
                Ok(())
            }
        }
    }
    pub fn target_name(&self) -> &str {
        &self.target.project_key
    }
    pub(super) fn verify_source(&self, source: &ProjectBatchSource) -> Result<()> {
        ensure!(
            self.source_fingerprint == source.identity(),
            "migration_project_source_changed"
        );
        Ok(())
    }
    pub(super) fn target(&self) -> &ImportedProjectTarget {
        &self.target
    }
    pub(super) fn verify_profile(&self, profile: &Path) -> Result<()> {
        ensure!(
            self.version == 1,
            "migration_project_target_binding_unsupported"
        );
        ensure!(
            identity(profile)? == self.profile_identity,
            "migration_wrong_target"
        );
        Ok(())
    }
    pub(super) fn check(
        &self,
        profile: &Path,
        store: &kcoder_config::imported_projects::ImportedProjectAssociationsStore,
        record: &ImportedProjectAssociation,
    ) -> Result<()> {
        self.verify_profile(profile)?;
        ensure!(
            record.target == self.target,
            "migration_project_target_changed"
        );
        match &self.authority {
            Authority::Registered { membership } => membership.check_association(store, record),
            Authority::CurrentWorkspace => store.check_association(record),
        }
    }
    pub(super) fn associate(
        &self,
        profile: &Path,
        store: &kcoder_config::imported_projects::ImportedProjectAssociationsStore,
        record: &ImportedProjectAssociation,
    ) -> Result<ImportedProjectReceipt> {
        self.verify_profile(profile)?;
        ensure!(
            record.target == self.target,
            "migration_project_target_changed"
        );
        match &self.authority {
            Authority::Registered { membership } => membership.associate(store, record),
            Authority::CurrentWorkspace => store.associate(record),
        }
    }
}

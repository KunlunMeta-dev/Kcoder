//! Explicit product-directory grants; default homes are never a fallback for a selection.
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    path::{Component, Path, PathBuf},
    time::Instant,
};

mod project;
pub(crate) use project::SelectedProjectRoot;

/// Private durable authority carried by bindings created from an explicit directory.
/// It is not accepted from RPC and does not confer permission to execute its contents.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectedRootBinding {
    root: PathBuf,
    identity: String,
    kind: MigrationSourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    uploaded: Option<Box<crate::source_transfer::uploads::UploadedRootBinding>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<Box<SelectedProjectRoot>>,
}

impl fmt::Debug for SelectedRootBinding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SelectedRootBinding")
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

impl SelectedRootBinding {
    pub(crate) fn capture(root: &Path, kind: MigrationSourceKind) -> Result<Self> {
        ensure!(
            root.is_absolute()
                && !root
                    .components()
                    .any(|part| matches!(part, Component::ParentDir | Component::CurDir)),
            "migration_unsafe_selected_root"
        );
        let directory = PrivateDirectory::open_existing(root)
            .map_err(|_| anyhow::anyhow!("migration_selected_root_unavailable"))?;
        directory.verify_trusted_config_directory()?;
        let binding = Self {
            root: root
                .canonicalize()
                .map_err(|_| anyhow::anyhow!("migration_selected_root_unavailable"))?,
            identity: directory.directory_identity()?,
            kind,
            uploaded: None,
            project: None,
        };
        binding.verify(&binding.root, kind)?;
        Ok(binding)
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
    pub(crate) fn kind(&self) -> MigrationSourceKind {
        self.kind
    }
    /// Scope new grants to the domains they actually read. Persisted grants are never rewritten.
    pub(crate) fn for_read_scope(&self, project: bool) -> Self {
        let mut binding = self.clone();
        if !project {
            binding.project = None;
        }
        binding
    }
    pub(crate) fn logical_identity(&self) -> String {
        if let Some(uploaded) = &self.uploaded {
            return uploaded.logical_identity();
        }
        let mut hash = Sha256::new();
        hash.update(self.root.as_os_str().as_encoded_bytes());
        hash.update([0]);
        hash.update(self.identity.as_bytes());
        hash.update([0]);
        hash.update(format!("{:?}", self.kind).as_bytes());
        if let Some(project) = &self.project {
            hash.update(b"\0selected-project:");
            hash.update(project.identity().as_bytes());
        }
        format!("{:x}", hash.finalize())
    }

    pub(crate) fn verify(&self, child: &Path, kind: MigrationSourceKind) -> Result<()> {
        ensure!(
            kind == self.kind
                && self.root.is_absolute()
                && child.is_absolute()
                && (child.starts_with(&self.root)
                    || self
                        .project
                        .as_ref()
                        .is_some_and(|project| child.starts_with(project.root())))
                && !child
                    .components()
                    .any(|part| matches!(part, Component::ParentDir | Component::CurDir)),
            "migration_selected_root_scope_changed"
        );
        let directory = PrivateDirectory::open_existing(&self.root)
            .map_err(|_| anyhow::anyhow!("migration_selected_root_changed"))?;
        directory.verify_trusted_config_directory()?;
        ensure!(
            directory.directory_identity()? == self.identity,
            "migration_selected_root_changed"
        );
        if let Some(project) = &self.project {
            ensure!(
                self.uploaded.is_none(),
                "source_upload_project_selection_forbidden"
            );
            project.verify()?;
        }
        if let Some(uploaded) = &self.uploaded {
            uploaded.verify(&self.root, kind)?;
        }
        Ok(())
    }
    pub(crate) fn authorize_project(&mut self, profile: &Path, project: &Path) -> Result<PathBuf> {
        self.verify(&self.root, self.kind)?;
        ensure!(
            self.uploaded.is_none(),
            "source_upload_project_selection_forbidden"
        );
        if let Some(original) = &self.project {
            ensure!(
                original.root() == project && original.profile() == profile,
                "migration_project_source_changed"
            );
            original.verify()?;
            return Ok(original.root().to_owned());
        }
        let binding = SelectedProjectRoot::capture(profile, project)?;
        let root = binding.root().to_owned();
        self.project = Some(Box::new(binding));
        self.verify(&self.root, self.kind)?;
        Ok(root)
    }

    pub(crate) fn verify_uploaded_bytes(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        if let Some(uploaded) = &self.uploaded {
            uploaded.verify_bytes(path, bytes)?;
        }
        Ok(())
    }
    pub(crate) fn verify_uploaded_files<'a>(
        &self,
        files: impl IntoIterator<Item = (PathBuf, &'a [u8])>,
    ) -> Result<()> {
        if let Some(uploaded) = &self.uploaded {
            uploaded.verify_file_set(files)?;
        }
        Ok(())
    }
    pub(crate) fn uploaded(&self) -> Option<&crate::source_transfer::uploads::UploadedRootBinding> {
        self.uploaded.as_deref()
    }
}

pub(crate) struct SelectedRootGrant {
    pub(crate) binding: SelectedRootBinding,
    pub(crate) created: Instant,
}

impl crate::discovery::SourceRegistry {
    pub(crate) fn from_uploaded_product(
        uploaded: crate::source_transfer::uploads::UploadedRootBinding,
    ) -> Result<Self> {
        let mut registry =
            Self::from_selected_product_directory(&uploaded.root_path()?, uploaded.source())?;
        registry.selected_root.as_mut().unwrap().binding.uploaded = Some(Box::new(uploaded));
        registry.verify_selected_root(None)?;
        Ok(registry)
    }
    /// Opaque operation provenance only; it never asserts the browser's OS identity.
    pub fn uploaded_operation_id(&self) -> Option<&str> {
        Some(
            self.selected_root
                .as_ref()?
                .binding
                .uploaded()?
                .operation_id(),
        )
    }
    /// Read the original grant without renewing its lifetime or choosing another directory.
    pub fn selected_product_directory_remaining_ms(&self) -> Result<u64> {
        self.verify_selected_root(None)?;
        let grant = self
            .selected_root
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_selected_root_unavailable"))?;
        Ok(std::time::Duration::from_secs(600)
            .saturating_sub(grant.created.elapsed())
            .as_millis() as u64)
    }
    /// The Native host must obtain an explicit directory selection first. The selected
    /// directory is the product root itself, not a home, arbitrary archive or project root.
    pub fn from_selected_product_directory(root: &Path, kind: MigrationSourceKind) -> Result<Self> {
        let binding = SelectedRootBinding::capture(root, kind)?;
        let mut registry = Self::new(crate::discovery::DiscoveryRoots {
            home: binding.root().into(),
            claude_config_dir: (kind == MigrationSourceKind::ClaudeCode)
                .then(|| binding.root().into()),
            codex_home: (kind == MigrationSourceKind::Codex).then(|| binding.root().into()),
            project: None,
        });
        registry.selected_root = Some(SelectedRootGrant {
            binding,
            created: Instant::now(),
        });
        Ok(registry)
    }

    pub(crate) fn verify_selected_root(&self, kind: Option<MigrationSourceKind>) -> Result<()> {
        if let Some(selected) = &self.selected_root {
            ensure!(
                selected.created.elapsed() < std::time::Duration::from_secs(600),
                "migration_selected_root_expired"
            );
            selected.binding.for_read_scope(false).verify(
                selected.binding.root(),
                kind.unwrap_or(selected.binding.kind()),
            )?;
        }
        Ok(())
    }

    pub(crate) fn verify_selected_project(&self) -> Result<()> {
        self.verify_selected_root(None)?;
        if let Some(selected) = &self.selected_root {
            selected
                .binding
                .verify(selected.binding.root(), selected.binding.kind())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;

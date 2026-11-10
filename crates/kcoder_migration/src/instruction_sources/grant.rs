//! A workspace instruction grant is independent of product roots and cannot imply parent access.
use anyhow::{Result, ensure};
use kcoder_config::{FolderTrust, FolderTrustStore, PrivateDirectory};
use kcoder_types::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};
use std::{
    fmt,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RootBinding {
    profile: PathBuf,
    profile_identity: String,
    root: PathBuf,
    root_identity: String,
    cwd: PathBuf,
    cwd_identity: String,
    source: MigrationSourceKind,
}
impl fmt::Debug for RootBinding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InstructionRootBinding")
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}
impl RootBinding {
    pub(super) fn capture(
        profile: &Path,
        root: &Path,
        cwd: &Path,
        source: MigrationSourceKind,
    ) -> Result<Self> {
        for path in [profile, root, cwd] {
            ensure!(
                path.is_absolute()
                    && !path
                        .components()
                        .any(|part| matches!(part, Component::ParentDir | Component::CurDir)),
                "migration_instruction_root_invalid"
            );
        }
        let profile_dir = directory(profile)?;
        let root_dir = directory(root)?;
        let cwd_dir = directory(cwd)?;
        let this = Self {
            profile: canonical(profile)?,
            profile_identity: profile_dir.directory_identity()?,
            root: canonical(root)?,
            root_identity: root_dir.directory_identity()?,
            cwd: canonical(cwd)?,
            cwd_identity: cwd_dir.directory_identity()?,
            source,
        };
        ensure!(
            this.root.parent().is_some() && this.cwd.starts_with(&this.root),
            "migration_instruction_cwd_outside_grant"
        );
        this.verify()?;
        Ok(this)
    }
    pub(super) fn verify(&self) -> Result<()> {
        ensure!(
            self.cwd.starts_with(&self.root),
            "migration_instruction_root_changed"
        );
        for (path, identity) in [
            (&self.profile, &self.profile_identity),
            (&self.root, &self.root_identity),
            (&self.cwd, &self.cwd_identity),
        ] {
            ensure!(
                canonical(path)? == *path && directory(path)?.directory_identity()? == *identity,
                "migration_instruction_root_changed"
            );
        }
        let trust = FolderTrustStore::load(&self.profile);
        ensure!(
            trust.check(&self.root) == FolderTrust::Trusted
                && trust.check(&self.cwd) == FolderTrust::Trusted,
            "migration_instruction_root_untrusted"
        );
        Ok(())
    }
    pub(super) fn root(&self) -> &Path {
        &self.root
    }
    pub(super) fn cwd(&self) -> &Path {
        &self.cwd
    }
    pub(super) fn source(&self) -> MigrationSourceKind {
        self.source
    }
    pub(super) fn relative(&self, path: &Path) -> Result<String> {
        ensure!(
            path.is_absolute()
                && !path
                    .components()
                    .any(|part| matches!(part, Component::ParentDir | Component::CurDir)),
            "migration_instruction_path_outside_grant"
        );
        let relative = path
            .strip_prefix(&self.root)
            .map_err(|_| anyhow::anyhow!("migration_instruction_path_outside_grant"))?;
        let parts = relative
            .components()
            .map(|part| match part {
                Component::Normal(value) => value
                    .to_str()
                    .filter(|s| !s.is_empty() && !s.chars().any(char::is_control))
                    .ok_or_else(|| anyhow::anyhow!("migration_instruction_path_unsupported")),
                _ => Err(anyhow::anyhow!("migration_instruction_path_outside_grant")),
            })
            .collect::<Result<Vec<_>>>()?;
        let value = parts.join("/");
        ensure!(
            parts.len() <= 64 && value.len() <= 4096,
            "migration_instruction_path_budget_exceeded"
        );
        Ok(value)
    }
}

pub struct InstructionSourceGrant {
    pub(super) binding: RootBinding,
    created: Instant,
}
impl InstructionSourceGrant {
    /// Native composition must obtain explicit authority for root and cwd before calling this.
    /// The current workspace or a Git marker does not automatically authorize its parents.
    pub fn capture(
        profile: &Path,
        root: &Path,
        cwd: &Path,
        source: MigrationSourceKind,
    ) -> Result<Self> {
        Ok(Self {
            binding: RootBinding::capture(profile, root, cwd, source)?,
            created: Instant::now(),
        })
    }
    pub fn verify(&self) -> Result<()> {
        ensure!(
            self.created.elapsed() < Duration::from_secs(600),
            "migration_instruction_grant_expired"
        );
        self.binding.verify()
    }
}
fn directory(path: &Path) -> Result<PrivateDirectory> {
    let directory = PrivateDirectory::open_existing(path)
        .map_err(|_| anyhow::anyhow!("migration_instruction_root_unavailable"))?;
    directory
        .verify_trusted_config_directory()
        .map_err(|_| anyhow::anyhow!("migration_instruction_root_unsafe"))?;
    Ok(directory)
}
fn canonical(path: &Path) -> Result<PathBuf> {
    path.canonicalize()
        .map_err(|_| anyhow::anyhow!("migration_instruction_root_unavailable"))
}

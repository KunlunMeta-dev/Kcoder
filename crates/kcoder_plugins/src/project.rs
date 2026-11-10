//! Explicit project installation authority; source provenance never constructs this binding.
use anyhow::{Result, ensure};
use kcoder_config::{FolderTrust, FolderTrustStore, PrivateDirectory};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

/// Private durable target authority. RPC callers choose the current workspace, not these fields.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginProjectBinding {
    profile: PathBuf,
    profile_identity: String,
    root: PathBuf,
    root_identity: String,
}
impl std::fmt::Debug for PluginProjectBinding {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("PluginProjectBinding")
            .finish_non_exhaustive()
    }
}
fn identity(root: &Path, native: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"plugin-project-root/1\0");
    hash.update(root.as_os_str().as_encoded_bytes());
    hash.update([0]);
    hash.update(native.as_bytes());
    format!("{:x}", hash.finalize())
}
impl PluginProjectBinding {
    pub fn capture(profile: &Path, authorized_workspace: &Path) -> Result<Self> {
        ensure!(
            profile.is_absolute() && authorized_workspace.is_absolute(),
            "plugin_project_mapping_required"
        );
        ensure!(
            !authorized_workspace
                .components()
                .any(|part| matches!(part, Component::ParentDir | Component::CurDir)),
            "plugin_project_mapping_required"
        );
        let profile_directory = PrivateDirectory::open_existing(profile)?;
        profile_directory.verify_private_directory()?;
        let root = PrivateDirectory::open_existing(authorized_workspace)?;
        root.verify_trusted_config_directory()?;
        let binding = Self {
            profile: profile.canonicalize()?,
            profile_identity: profile_directory.directory_identity()?,
            root: authorized_workspace.canonicalize()?,
            root_identity: root.directory_identity()?,
        };
        binding.verify()?;
        Ok(binding)
    }
    pub fn verify(&self) -> Result<()> {
        let profile = PrivateDirectory::open_existing(&self.profile)?;
        profile.verify_private_directory()?;
        let root = PrivateDirectory::open_existing(&self.root)?;
        root.verify_trusted_config_directory()?;
        ensure!(
            profile.directory_identity()? == self.profile_identity
                && root.directory_identity()? == self.root_identity,
            "plugin_project_mapping_changed"
        );
        ensure!(
            FolderTrustStore::load(&self.profile).check(&self.root) == FolderTrust::Trusted,
            "plugin_project_target_untrusted"
        );
        Ok(())
    }
    pub fn verify_for_profile(&self, profile: &Path) -> Result<()> {
        self.verify()?;
        let directory = PrivateDirectory::open_existing(profile)?;
        directory.verify_private_directory()?;
        ensure!(
            directory.directory_identity()? == self.profile_identity,
            "plugin_project_mapping_changed"
        );
        Ok(())
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn identity(&self) -> String {
        identity(&self.root, &self.root_identity)
    }
    pub(crate) fn verify_store(&self, store: &Path) -> Result<()> {
        self.verify()?;
        let parent = store
            .parent()
            .ok_or_else(|| anyhow::anyhow!("plugin_project_mapping_changed"))?;
        let profile = PrivateDirectory::open_existing(parent)?;
        profile.verify_private_directory()?;
        ensure!(
            store.file_name() == Some(std::ffi::OsStr::new("plugin_store"))
                && profile.directory_identity()? == self.profile_identity,
            "plugin_project_mapping_changed"
        );
        Ok(())
    }
}
/// A stored opaque identity cannot grant an arbitrary path. Only an actually opened
/// ancestor of this runtime's current workspace can satisfy the binding.
pub(crate) fn runtime_root(cwd: &Path, expected: &str) -> Result<Option<PathBuf>> {
    ensure!(
        expected.len() == 64
            && expected
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "plugin_project_mapping_changed"
    );
    let canonical = cwd.canonicalize()?;
    for root in canonical.ancestors().take(256) {
        let directory = PrivateDirectory::open_existing(root)?;
        directory.verify_trusted_config_directory()?;
        if identity(root, &directory.directory_identity()?) == expected {
            return Ok(Some(root.to_owned()));
        }
    }
    Ok(None)
}

//! A destination workspace is captured by Native, never copied from source provenance.
use super::super::*;
use std::path::{Path, PathBuf};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceivedProjectTarget {
    profile_identity: String,
    root: PathBuf,
    root_identity: String,
}
impl std::fmt::Debug for ReceivedProjectTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReceivedProjectTarget")
            .finish_non_exhaustive()
    }
}
impl ReceivedProjectTarget {
    /// The Native caller must first authorize this actual workspace through its
    /// target policy. This private binding is not deserialized from an RPC path.
    pub fn capture(profile: &Path, authorized_workspace: &Path) -> Result<Self> {
        ensure!(
            profile.is_absolute() && authorized_workspace.is_absolute(),
            "source_transfer_project_mapping_required"
        );
        let profile = PrivateDirectory::open_existing(profile)?;
        profile.verify_private_directory()?;
        let project = PrivateDirectory::open_existing(authorized_workspace)?;
        project.verify_trusted_config_directory()?;
        let root = authorized_workspace.canonicalize()?;
        let root_identity = project.directory_identity()?;
        ensure!(
            PrivateDirectory::open_existing(&root)?.directory_identity()? == root_identity,
            "source_transfer_project_mapping_changed"
        );
        Ok(Self {
            profile_identity: profile.directory_identity()?,
            root,
            root_identity,
        })
    }
    pub fn verify(&self, profile: &Path) -> Result<()> {
        let receiver = PrivateDirectory::open_existing(profile)?;
        receiver.verify_private_directory()?;
        ensure!(
            receiver.directory_identity()? == self.profile_identity,
            "source_transfer_wrong_consumer"
        );
        let project = PrivateDirectory::open_existing(&self.root)?;
        project.verify_trusted_config_directory()?;
        ensure!(
            project.directory_identity()? == self.root_identity,
            "source_transfer_project_mapping_changed"
        );
        Ok(())
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn identity(&self) -> &str {
        &self.root_identity
    }
}

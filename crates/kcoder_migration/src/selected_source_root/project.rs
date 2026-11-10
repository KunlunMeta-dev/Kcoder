//! A separately authorized workspace never becomes a child of the selected product directory.
use super::*;
use kcoder_config::{FolderTrust, FolderTrustStore};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectedProjectRoot {
    root: PathBuf,
    identity: String,
    profile: PathBuf,
    profile_identity: String,
}
impl fmt::Debug for SelectedProjectRoot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SelectedProjectRoot")
            .finish_non_exhaustive()
    }
}
impl SelectedProjectRoot {
    pub(crate) fn capture(profile: &Path, root: &Path) -> Result<Self> {
        ensure!(
            profile.is_absolute() && root.is_absolute(),
            "migration_project_source_not_trusted"
        );
        let profile_directory = PrivateDirectory::open_existing(profile)?;
        profile_directory.verify_trusted_config_directory()?;
        let directory = PrivateDirectory::open_existing(root)?;
        directory.verify_trusted_config_directory()?;
        let binding = Self {
            root: root.canonicalize()?,
            identity: directory.directory_identity()?,
            profile: profile.canonicalize()?,
            profile_identity: profile_directory.directory_identity()?,
        };
        binding.verify()?;
        Ok(binding)
    }
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
    pub(crate) fn profile(&self) -> &Path {
        &self.profile
    }
    pub(crate) fn verify(&self) -> Result<()> {
        let profile = PrivateDirectory::open_existing(&self.profile)
            .map_err(|_| anyhow::anyhow!("migration_project_source_changed"))?;
        let directory = PrivateDirectory::open_existing(&self.root)
            .map_err(|_| anyhow::anyhow!("migration_project_source_changed"))?;
        profile.verify_trusted_config_directory()?;
        directory.verify_trusted_config_directory()?;
        ensure!(
            profile.directory_identity()? == self.profile_identity
                && directory.directory_identity()? == self.identity,
            "migration_project_source_changed"
        );
        ensure!(
            FolderTrustStore::load(&self.profile).check(&self.root) == FolderTrust::Trusted,
            "migration_project_source_not_trusted"
        );
        Ok(())
    }
    pub(crate) fn identity(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(self.root.as_os_str().as_encoded_bytes());
        hash.update([0]);
        hash.update(self.identity.as_bytes());
        hash.update([0]);
        hash.update(self.profile.as_os_str().as_encoded_bytes());
        hash.update([0]);
        hash.update(self.profile_identity.as_bytes());
        format!("{:x}", hash.finalize())
    }
}

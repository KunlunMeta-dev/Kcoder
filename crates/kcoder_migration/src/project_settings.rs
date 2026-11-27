//! A received project's target stays bound to its authenticated profile and actual workspace.
use crate::source_transfer::ReceivedProjectTarget;
use anyhow::{Result, ensure};
use kcoder_config::{FolderTrust, FolderTrustStore, PrivateDirectory, ProfileSettingsFile};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

pub(crate) struct ProjectSettingsScope {
    profile: PathBuf,
    binding: ReceivedProjectTarget,
    settings_identity: String,
}
impl ProjectSettingsScope {
    pub fn open(
        profile: &Path,
        binding: &ReceivedProjectTarget,
        create: bool,
    ) -> Result<(Self, PrivateDirectory, String)> {
        binding.verify(profile)?;
        let profile = profile.canonicalize()?;
        ensure!(
            FolderTrustStore::load(&profile).check(binding.root()) == FolderTrust::Trusted,
            "migration_project_target_untrusted"
        );
        let root = PrivateDirectory::open_existing(binding.root())?;
        root.verify_trusted_config_directory()?;
        ensure!(
            root.directory_identity()? == binding.identity(),
            "source_transfer_project_mapping_changed"
        );
        let directory = root.open_child(OsStr::new(".kcoder"), create)?;
        directory.verify_trusted_config_directory()?;
        let settings_identity = directory.directory_identity()?;
        let mut hash = Sha256::new();
        hash.update(b"received-project-settings/v1\0");
        hash.update(
            PrivateDirectory::open_existing(&profile)?
                .directory_identity()?
                .as_bytes(),
        );
        hash.update([0]);
        hash.update(binding.identity().as_bytes());
        hash.update([0]);
        hash.update(settings_identity.as_bytes());
        let id = format!("project-{:x}", hash.finalize());
        let value = Self {
            profile,
            binding: binding.clone(),
            settings_identity,
        };
        value.verify()?;
        Ok((value, directory, id))
    }
    pub fn verify(&self) -> Result<()> {
        self.binding.verify(&self.profile)?;
        ensure!(
            FolderTrustStore::load(&self.profile).check(self.binding.root())
                == FolderTrust::Trusted,
            "migration_project_target_untrusted"
        );
        let root = PrivateDirectory::open_existing(self.binding.root())?;
        let directory = root.open_child(OsStr::new(".kcoder"), false)?;
        directory.verify_trusted_config_directory()?;
        ensure!(
            directory.directory_identity()? == self.settings_identity,
            "migration_project_target_changed"
        );
        Ok(())
    }
    pub fn mcp_catalog(&self) -> Result<kcoder_config::ProjectMcpCatalog> {
        self.verify()?;
        let loaded = kcoder_config::SettingsLoader::new(self.binding.root())
            .with_config_dir(&self.profile)
            .load()
            .map_err(|_| anyhow::anyhow!("migration_target_configuration_unavailable"))?;
        kcoder_config::ProjectMcpCatalog::from_settings(&loaded.settings)
    }
    pub fn mcp_server_enabled(&self, name: &str) -> Result<bool> {
        self.verify()?;
        let loaded = kcoder_config::SettingsLoader::new(self.binding.root())
            .with_config_dir(&self.profile)
            .load()
            .map_err(|_| anyhow::anyhow!("migration_target_configuration_unavailable"))?;
        self.verify()?;
        Ok(loaded.settings.mcp_server_enabled(name))
    }
    pub fn update_preserving_catalogs(
        &self,
        settings: &ProfileSettingsFile,
        provider: Option<&Value>,
        mcp: Option<&kcoder_config::ProjectMcpCatalogSelection>,
        change: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<()> {
        self.verify()?;
        settings
            .update_project_with_catalogs(&self.profile, self.binding.root(), provider, mcp, change)
            .map(|_| ())
    }
    pub fn binding(&self) -> &ReceivedProjectTarget {
        &self.binding
    }
    /// Only shipped public defaults may be materialized automatically. Arbitrary
    /// inherited documents and credentials never become a project snapshot.
    pub fn implicit_provider_catalog(&self, current: &Value) -> Result<Option<Value>> {
        self.verify()?;
        if current.get("providers").is_some() {
            return Ok(None);
        }
        let loaded = kcoder_config::SettingsLoader::new(self.binding.root())
            .with_config_dir(&self.profile)
            .load()?;
        if loaded
            .field_sources
            .keys()
            .any(|field| field == "providers" || field.starts_with("providers."))
        {
            return Ok(None);
        }
        let defaults = kcoder_config::validate_and_resolve_settings_document(
            &kcoder_config::default_settings_document(),
        )?;
        ensure!(
            loaded.settings.providers == defaults.providers,
            "migration_project_catalog_preservation_required"
        );
        Ok(Some(serde_json::to_value(defaults.providers)?))
    }

    pub fn validate(
        &self,
        settings: &ProfileSettingsFile,
        before: &Value,
        next: &Value,
    ) -> Result<()> {
        self.verify()?;
        settings.validate_project_change(&self.profile, self.binding.root(), before, next)
    }
    pub fn update_preserving_catalog(
        &self,
        settings: &ProfileSettingsFile,
        expected: Option<&Value>,
        change: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<()> {
        self.verify()?;
        settings
            .update_project_with_catalog(&self.profile, self.binding.root(), expected, change)
            .map(|_| ())
    }

    pub fn update(
        &self,
        settings: &ProfileSettingsFile,
        change: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<()> {
        self.verify()?;
        settings
            .update_project(&self.profile, self.binding.root(), change)
            .map(|_| ())
    }
}

pub(crate) fn user_plan(project: &bool) -> bool {
    !project
}

#[cfg(test)]
mod tests;

//! A first-declaration preview never creates the project's configuration directory.
use super::McpTarget;
use crate::source_transfer::ReceivedProjectTarget;
use anyhow::{Result, ensure};
use kcoder_config::{
    ConfigScope, FolderTrust, FolderTrustStore, PrivateDirectory, ProjectMcpCatalog,
};
use std::{ffi::OsStr, path::Path};

impl McpTarget {
    /// Read inherited names before opening a writable project target. The returned
    /// revision must still be verified by `with_project_mcp_catalog` when planning.
    pub fn preview_project_mcp_catalog(
        profile: &Path,
        binding: &ReceivedProjectTarget,
    ) -> Result<ProjectMcpCatalog> {
        let before = verify(profile, binding)?;
        let loaded = kcoder_config::SettingsLoader::new(binding.root())
            .with_config_dir(profile)
            .load()
            .map_err(|_| anyhow::anyhow!("migration_target_configuration_unavailable"))?;
        ensure!(
            !matches!(
                loaded.field_sources.get("mcp_servers"),
                Some(ConfigScope::Project | ConfigScope::Local)
            ),
            "migration_project_mcp_catalog_already_declared"
        );
        ensure!(
            before == verify(profile, binding)?,
            "migration_project_target_changed"
        );
        ProjectMcpCatalog::from_settings(&loaded.settings)
    }
}

fn verify(profile: &Path, binding: &ReceivedProjectTarget) -> Result<Option<String>> {
    binding.verify(profile)?;
    ensure!(
        FolderTrustStore::load(profile).check(binding.root()) == FolderTrust::Trusted,
        "migration_project_target_untrusted"
    );
    let root = PrivateDirectory::open_existing(binding.root())?;
    root.verify_trusted_config_directory()?;
    ensure!(
        root.directory_identity()? == binding.identity(),
        "migration_project_target_changed"
    );
    match root.open_child(OsStr::new(".kcoder"), false) {
        Ok(directory) => {
            directory.verify_trusted_config_directory()?;
            Ok(Some(directory.directory_identity()?))
        }
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

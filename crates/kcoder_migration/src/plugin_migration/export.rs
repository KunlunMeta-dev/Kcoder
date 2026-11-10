//! Static package export grants are Native selections, not path-bearing RPC parameters.
use super::{PluginMigrationCandidate, discovery::Source};
use anyhow::{Context, Result, ensure};
use kcoder_plugins::{
    InstallLimits, PluginCancellationToken,
    migration::{
        PluginPackageRevision, PluginTransferEstimate, estimate_transfer_package,
        write_transfer_package,
    },
};
use kcoder_types::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;

/// Private transport metadata. Source paths, settings, registry records and credentials are absent.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginPackageOrigin {
    pub source: MigrationSourceKind,
    pub logical_identity: String,
    pub name: String,
    pub version: Option<String>,
    pub scope: String,
    pub source_enabled: Option<bool>,
    pub pending: Vec<String>,
    pub package: PluginPackageRevision,
}
impl PluginPackageOrigin {
    pub fn validate(&self) -> Result<()> {
        let sha = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        ensure!(
            sha(&self.logical_identity) && sha(&self.package.sha256),
            "plugin_migration_invalid_package"
        );
        ensure!(
            self.name.len() <= 128
                && format!("{}@received", self.name)
                    .parse::<kcoder_plugins::PluginId>()
                    .is_ok(),
            "plugin_migration_invalid_package"
        );
        ensure!(
            self.version.as_ref().is_none_or(|value| !value.is_empty()
                && value.len() <= 128
                && value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'))),
            "plugin_migration_invalid_package"
        );
        ensure!(
            matches!(self.scope.as_str(), "user" | "project" | "local")
                && self.pending.len() <= 1
                && self
                    .pending
                    .iter()
                    .all(|code| code == "plugin_project_mapping_required"),
            "plugin_migration_pending_resolution_required"
        );
        let limits = InstallLimits::default();
        ensure!(
            self.package.files > 0
                && self.package.files <= limits.max_files
                && self.package.bytes <= limits.max_total_bytes,
            "plugin_migration_tree_budget_exceeded"
        );
        Ok(())
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginExportSelection {
    binding: Source,
    name: String,
    version: Option<String>,
    source_enabled: Option<bool>,
    pending: Vec<String>,
    estimate: PluginTransferEstimate,
}
impl PluginMigrationCandidate {
    /// An explicit grant can transport data before destination project mapping.
    /// It does not authorize installation or inherit the source's executable policy.
    pub fn export_selection(&self) -> Result<PluginExportSelection> {
        let binding = self
            .binding
            .as_ref()
            .context("plugin_migration_invalid_candidate")?;
        ensure!(
            binding.received.is_none(),
            "plugin_migration_export_original_source_required"
        );
        ensure!(
            matches!(binding.source_scope.as_str(), "user" | "project" | "local"),
            "plugin_migration_pending_resolution_required"
        );
        ensure!(
            binding.source_scope == "user"
                || binding.project.is_some()
                || binding.uploaded.is_some(),
            "migration_project_source_not_trusted"
        );
        let root = binding.verify()?;
        let estimate = estimate_transfer_package(
            &root,
            InstallLimits::default(),
            &PluginCancellationToken::default(),
        )?;
        binding.verify()?;
        Ok(PluginExportSelection {
            binding: binding.clone(),
            name: self.name.clone(),
            version: self.installed_version.clone(),
            source_enabled: self.source_enabled,
            pending: self.pending.clone(),
            estimate,
        })
    }
}
impl PluginExportSelection {
    pub fn reserved_bytes(&self) -> Result<u64> {
        self.estimate
            .bytes
            .checked_mul(2)
            .context("plugin_migration_tree_budget_exceeded")
    }
    pub fn source(&self) -> MigrationSourceKind {
        self.binding.kind
    }
    pub fn uploaded_source(
        &self,
    ) -> Option<kcoder_types::migration_source_upload::SourceUploadProvenance> {
        self.binding
            .uploaded
            .as_ref()
            .map(|source| source.provenance())
    }
    pub fn verify(&self) -> Result<()> {
        self.binding.verify().map(drop)
    }
    pub fn logical_identity(&self) -> Result<String> {
        if let Some(uploaded) = &self.binding.uploaded {
            return Ok(format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&(
                    "uploaded-plugin-package-origin/1",
                    uploaded.logical_identity(),
                    self.binding.kind,
                    &self.binding.source_id,
                    &self.binding.source_scope,
                ))?)
            ));
        }
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "plugin-package-origin/1",
                self.binding.kind,
                &self.binding.identity,
                &self.binding.source_id,
                &self.binding.source_scope,
                self.binding
                    .project
                    .as_ref()
                    .map(|project| project.identity())
            ))?)
        ))
    }
    /// The receiver must validate its own target authority and explicit mapping.
    pub fn write_package(
        &self,
        output: &mut dyn Write,
        cancel: &PluginCancellationToken,
    ) -> Result<PluginPackageOrigin> {
        let root = self.binding.verify()?;
        ensure!(
            estimate_transfer_package(&root, InstallLimits::default(), cancel)? == self.estimate,
            "plugin_migration_source_changed"
        );
        ensure!(
            self.pending
                .iter()
                .all(|code| code == "plugin_project_mapping_required"),
            "plugin_migration_pending_resolution_required"
        );
        let temporary = kcoder_config::create_private_temp_dir("kcoder-plugin-source-export")?;
        let frozen = temporary.path().join("package");
        kcoder_config::PrivateDirectory::open_existing(temporary.path())?
            .create_private_child(std::ffi::OsStr::new("package"))?;
        let revision = kcoder_plugins::migration::snapshot_package(
            &root,
            &frozen,
            InstallLimits::default(),
            cancel,
        )?;
        self.binding.verify_uploaded_copy(&frozen, cancel)?;
        let inspection = kcoder_plugins::migration::inspect_package(&frozen, cancel)?;
        ensure!(
            inspection.compatible,
            "plugin_migration_pending_resolution_required"
        );
        let package = write_transfer_package(&frozen, output, InstallLimits::default(), cancel)?;
        ensure!(
            package == revision
                && kcoder_plugins::migration::package_revision(
                    &root,
                    InstallLimits::default(),
                    cancel
                )? == revision,
            "plugin_migration_source_changed"
        );
        self.binding.verify()?;
        let origin = PluginPackageOrigin {
            source: self.binding.kind,
            logical_identity: self.logical_identity()?,
            name: self.name.clone(),
            version: self.version.clone(),
            scope: self.binding.source_scope.clone(),
            source_enabled: self.source_enabled,
            pending: self.pending.clone(),
            package,
        };
        origin.validate()?;
        Ok(origin)
    }
}

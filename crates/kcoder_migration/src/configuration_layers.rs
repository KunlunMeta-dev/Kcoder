//! Explicit settings snapshots retain each authorized layer and never synthesize a credential source.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

use crate::{MigrationInventory, source::SourceDocument};
mod merge;
mod report;
pub(crate) mod storage;
#[cfg(test)]
mod tests;

pub const CLAUDE_LAYERS_REVISION: &str = "claude-settings-layers/v1";
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_FIELDS: usize = 1024;

pub use kcoder_types::configuration_layers::{
    ConfigurationFieldOrigin, ConfigurationLayerReport, ConfigurationLayerScope,
    ConfigurationLayerState,
};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigurationLayersBinding {
    version: u32,
    layers: Vec<storage::Layer>,
    project: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    snapshot_report: Option<ConfigurationLayerReport>,
}
impl std::fmt::Debug for ConfigurationLayersBinding {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ConfigurationLayersBinding")
            .field("layers", &self.layers.len())
            .finish_non_exhaustive()
    }
}
impl ConfigurationLayersBinding {
    pub(crate) fn user_directory(&self) -> Result<PathBuf> {
        self.layers
            .first()
            .filter(|layer| {
                layer.scope() == ConfigurationLayerScope::User && layer.name() == "settings.json"
            })
            .map(storage::Layer::directory_path)
            .ok_or_else(|| anyhow::anyhow!("migration_invalid_source_binding"))
    }
    /// Roots are supplied by the native account's explicit source selection, never an RPC path.
    pub fn capture_claude(user: &Path, project: Option<&Path>) -> Result<Option<Self>> {
        use ConfigurationLayerScope::*;
        let mut layers = vec![storage::Layer::capture(user, "settings.json", User)?];
        let project = project
            .map(|path| -> Result<PathBuf> {
                let directory = kcoder_config::PrivateDirectory::open_existing(path)?;
                directory.verify_trusted_config_directory()?;
                path.canonicalize()
                    .map_err(|_| anyhow::anyhow!("migration_unsafe_source_path"))
            })
            .transpose()?;
        if let Some(project) = &project {
            layers.push(storage::Layer::capture(
                &project.join(".claude"),
                "settings.json",
                Project,
            )?);
            layers.push(storage::Layer::capture(
                &project.join(".claude"),
                "settings.local.json",
                Local,
            )?);
        }
        if !layers.iter().any(|layer| layer.present()) {
            return Ok(None);
        }
        let mut binding = Self {
            version: 1,
            layers,
            project,
            snapshot_report: None,
        };
        binding.snapshot_report = Some(binding.resolve()?.report);
        Ok(Some(binding))
    }
    fn validate(&self) -> Result<()> {
        use ConfigurationLayerScope::*;
        ensure!(
            self.version == 1 && matches!(self.layers.len(), 1 | 3),
            "migration_invalid_source_binding"
        );
        ensure!(
            self.layers[0].scope() == User && self.layers[0].name() == "settings.json",
            "migration_invalid_source_binding"
        );
        if self.layers.len() == 3 {
            ensure!(
                self.project.as_ref().is_some_and(|path| path.is_absolute())
                    && self.layers[1].scope() == Project
                    && self.layers[2].scope() == Local
                    && self.layers[1].name() == "settings.json"
                    && self.layers[2].name() == "settings.local.json",
                "migration_invalid_source_binding"
            );
            let directory = self.layers[1].directory_path();
            ensure!(
                directory == self.layers[2].directory_path()
                    && directory.parent() == self.project.as_deref(),
                "migration_invalid_source_binding"
            );
        } else {
            ensure!(self.project.is_none(), "migration_invalid_source_binding");
        }
        Ok(())
    }
    fn resolve(&self) -> Result<merge::Resolved> {
        self.validate()?;
        let mut total = 0usize;
        let mut sources = Vec::new();
        for layer in &self.layers {
            let source = layer.read()?;
            if let Some(source) = &source {
                total = total.saturating_add(source.text().len());
            }
            ensure!(total <= MAX_BYTES, "migration_source_budget_exceeded");
            sources.push(source);
        }
        let result = merge::resolve(self, &sources)?;
        // Recheck absence as well as all contributing bytes after the combined read.
        for layer in &self.layers {
            layer.read()?;
        }
        Ok(result)
    }
    pub(crate) fn read(&self) -> Result<SourceDocument> {
        Ok(self.resolve()?.document)
    }
    pub fn report(&self) -> Result<ConfigurationLayerReport> {
        Ok(self.resolve()?.report)
    }
    pub(crate) fn primary_path(&self) -> Result<PathBuf> {
        self.validate()?;
        self.layers
            .iter()
            .rev()
            .find(|layer| layer.present())
            .map(storage::Layer::path)
            .ok_or_else(|| anyhow::anyhow!("migration_source_unavailable"))
    }
    pub(crate) fn project_root(&self) -> Option<PathBuf> {
        self.project.clone()
    }
    pub(crate) fn revision(&self) -> Result<String> {
        use sha2::{Digest, Sha256};
        self.validate()?;
        let bytes = serde_json::to_vec(self)
            .map_err(|_| anyhow::anyhow!("migration_invalid_source_binding"))?;
        Ok(format!("layers-{:x}", Sha256::digest(bytes)))
    }
    pub(crate) fn logical_identity(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut digest = Sha256::new();
        digest.update(CLAUDE_LAYERS_REVISION.as_bytes());
        for layer in &self.layers {
            layer.hash_logical(&mut digest);
        }
        format!("{:x}", digest.finalize())
    }
    pub(crate) fn refreshed(&self) -> Result<Self> {
        self.validate()?;
        let mut next = self.clone();
        next.layers = self
            .layers
            .iter()
            .map(storage::Layer::refreshed)
            .collect::<Result<_>>()?;
        next.snapshot_report = Some(next.resolve()?.report);
        Ok(next)
    }
    /// Values come from the original winning source, after every layer has been verified.
    pub(crate) fn private_field(&self, pointer: &str) -> Result<Zeroizing<String>> {
        ensure!(
            pointer == "/env/ANTHROPIC_API_KEY",
            "migration_credential_source_not_declared"
        );
        let _ = self.resolve()?;
        for layer in self.layers.iter().rev() {
            if let Some(source) = layer.read()? {
                let parsed = merge::PrivateValue::parse(source.text())?;
                if let Some(value) = parsed.0.pointer(pointer) {
                    let value = value
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("migration_credential_invalid_api_key"))?;
                    let key = Zeroizing::new(value.to_owned());
                    for layer in &self.layers {
                        layer.read()?;
                    }
                    return Ok(key);
                }
            }
        }
        anyhow::bail!("migration_credential_key_missing")
    }
    pub(crate) fn inventory(&self) -> Result<MigrationInventory> {
        let resolved = self.resolve()?;
        let mut inventory = crate::adapters::parse_claude_settings_with_redactions(
            resolved.document.text(),
            &resolved.document.private_values(),
        )?;
        inventory.adapter_revision = CLAUDE_LAYERS_REVISION.into();
        inventory
            .issues
            .push(kcoder_types::migration::MigrationIssue {
                code: kcoder_types::migration::MigrationIssueCode::RequiresReview,
                severity: kcoder_types::migration::MigrationIssueSeverity::Notice,
                phase: kcoder_types::migration::MigrationIssuePhase::Import,
                field: Some("unobserved_managed_runtime_layers".into()),
            });
        if resolved
            .report
            .fields
            .iter()
            .any(|field| field.field.as_deref() == Some("/mcpServers"))
        {
            use kcoder_types::migration::*;
            inventory.items.push(crate::NormalizedItem {
                preview: MigrationItemPreview {
                    id: "claude-layers:mcp-namespace".into(),
                    category: MigrationCategory::Mcp,
                    source_name: "Separate MCP settings namespace".into(),
                    status: MigrationItemStatus::RequiresAction,
                    selected_by_default: false,
                    issues: vec![MigrationIssue {
                        code: MigrationIssueCode::UnsupportedField,
                        severity: MigrationIssueSeverity::Blocking,
                        phase: MigrationIssuePhase::Import,
                        field: Some("mcp_settings_namespace".into()),
                    }],
                },
                provider: None,
                mcp: None,
                asset: None,
                template: None,
            });
        }
        if resolved.report.fields.iter().any(|field| !field.supported) {
            use kcoder_types::migration::{
                MigrationIssue, MigrationIssueCode, MigrationIssuePhase, MigrationIssueSeverity,
                MigrationItemStatus,
            };
            let issue = MigrationIssue {
                code: MigrationIssueCode::UnsupportedField,
                severity: MigrationIssueSeverity::Blocking,
                phase: MigrationIssuePhase::Import,
                field: Some("selected_settings_layers".into()),
            };
            inventory.issues.push(issue.clone());
            for item in &mut inventory.items {
                item.preview.issues.push(issue.clone());
                item.preview.selected_by_default = false;
                item.preview.status = MigrationItemStatus::RequiresAction;
            }
        }
        Ok(inventory)
    }
}

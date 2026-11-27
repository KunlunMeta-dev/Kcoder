//! Bounded multi-source plans. Native stores remain the authority for publication.
use crate::{
    MigrationInventory, asset_sources::AssetBundleBinding, assets::AssetResolution,
    discovery::ConfigurationBinding, mcp::McpResolution, providers::ProviderResolution,
};
use anyhow::{Result, ensure};
use kcoder_types::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};

pub mod control;
mod defaults;
pub mod execution;
pub mod history;
pub mod plugins;
pub mod projects;
pub mod settings;
pub use defaults::{default_resolution, proposed_name};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "binding",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum BatchSource {
    Configuration(ConfigurationBinding),
    TransferredConfiguration(Box<crate::source_transfer::TransferredConfigurationBinding>),
    Assets(AssetBundleBinding),
    History(Box<history::HistoryBatchSource>),
    Plugin(Box<crate::plugin_migration::PluginBatchSource>),
    Project(Box<crate::project_migration::binding::ProjectBatchSource>),
}
impl BatchSource {
    pub fn kind(&self) -> MigrationSourceKind {
        match self {
            Self::Configuration(binding) => binding.kind,
            Self::TransferredConfiguration(binding) => binding.kind(),
            Self::Assets(binding) => binding.kind,
            Self::History(binding) => binding.source(),
            Self::Plugin(binding) => binding.source(),
            Self::Project(binding) => binding.source(),
        }
    }
    pub fn inventory(&self) -> Result<MigrationInventory> {
        match self {
            Self::Configuration(binding) => binding.inventory(),
            Self::TransferredConfiguration(binding) => binding.inventory(),
            Self::Assets(binding) => binding.inventory(),
            Self::History(binding) => binding.inventory(),
            Self::Plugin(binding) => binding.inventory(),
            Self::Project(binding) => binding.inventory(),
        }
    }
    pub(crate) fn unchanged(&self, item: &crate::NormalizedItem) -> bool {
        match self {
            Self::TransferredConfiguration(binding) => binding.validate_item(item).is_ok(),
            Self::Configuration(binding) => {
                if item.template.is_some() {
                    binding.inventory().is_ok_and(|inventory| {
                        inventory.items.iter().any(|source| {
                            source.preview.source_name == item.preview.source_name
                                && source.template == item.template
                                && !source
                                    .preview
                                    .issues
                                    .iter()
                                    .any(|issue| issue.blocks_import())
                        })
                    })
                } else if item.provider.is_some() {
                    binding.validate_provider_item(item).is_ok()
                } else {
                    binding.read().is_ok()
                }
            }
            Self::Assets(binding) => item
                .asset
                .as_ref()
                .is_some_and(|candidate| binding.read(&candidate.entry).is_ok()),
            Self::History(binding) => {
                item.preview.category == kcoder_types::migration::MigrationCategory::History
                    && binding.validate().is_ok()
            }
            Self::Project(binding) => {
                item.preview.category == kcoder_types::migration::MigrationCategory::Project
                    && binding.validate(&Default::default()).is_ok()
            }
            Self::Plugin(binding) => {
                item.preview.category == kcoder_types::migration::MigrationCategory::Plugin
                    && binding.validate().is_ok()
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatchResolution {
    Provider(ProviderResolution),
    Mcp(McpResolution),
    Asset(AssetResolution),
    Template(crate::templates::TemplateResolution),
    History(history::HistoryBatchResolution),
    Plugin(plugins::PluginBatchResolution),
    Project(Box<projects::ProjectBatchResolution>),
}
impl BatchResolution {
    pub fn item_id(&self) -> &str {
        match self {
            Self::Provider(value) => &value.item_id,
            Self::Mcp(value) => &value.item_id,
            Self::Asset(value) => &value.item_id,
            Self::Template(value) => &value.item_id,
            Self::History(value) => &value.item_id,
            Self::Plugin(value) => &value.item_id,
            Self::Project(value) => &value.item_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchItemSource {
    pub item_id: String,
    pub source_index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) execution_control: Option<Box<control::ExecutionControlRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation: Option<Box<crate::store::BatchCreationBinding>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_limits: Option<kcoder_types::migration_resource::MigrationResourceLimits>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub atomic_credentials: bool,
    pub sources: Vec<BatchSource>,
    pub item_sources: Vec<BatchItemSource>,
    pub plan_id: Option<String>,
    pub actions: Vec<BatchAction>,
    #[serde(default)]
    pub request_kinds: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub credential_plan_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub received: Option<Box<ReceivedBatchBinding>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_project: Option<crate::source_transfer::ReceivedProjectTarget>,
}
/// Original receiving intent; a scan receipt never confirms target publication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceivedBatchBinding {
    pub request_id: String,
    pub adoption_id: String,
    pub binding_digest: String,
    pub group: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<crate::source_transfer::ReceivedProjectTarget>,
}
impl BatchState {
    pub fn project_target(&self) -> Option<&crate::source_transfer::ReceivedProjectTarget> {
        self.local_project.as_ref().or_else(|| {
            self.received
                .as_ref()
                .and_then(|value| value.project.as_ref())
        })
    }
    pub fn source_for(&self, item_id: &str) -> Result<&BatchSource> {
        let index = self
            .item_sources
            .iter()
            .find(|item| item.item_id == item_id)
            .map(|item| item.source_index)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        self.sources
            .get(index)
            .ok_or_else(|| anyhow::anyhow!("migration_invalid_journal"))
    }
    pub fn validate(&self) -> Result<()> {
        self.validate_execution_control()?;
        if let Some(creation) = &self.creation {
            creation.validate_shape()?;
            ensure!(self.received.is_none(), "migration_invalid_journal");
        }
        ensure!(
            self.resource_limits
                .as_ref()
                .is_none_or(|limits| limits.is_supported()),
            "migration_invalid_resource_limits"
        );
        ensure!(
            self.local_project.is_none() || self.received.is_none(),
            "migration_invalid_journal"
        );
        ensure!(
            !self.sources.is_empty()
                && self.sources.len() <= 64
                && self.item_sources.len() <= 1024
                && self.actions.len() <= 1024
                && self.execution_request_count() <= 256,
            "migration_batch_budget_exceeded"
        );
        ensure!(
            self.credential_plan_ids.len() <= 128,
            "migration_credential_budget_exceeded"
        );
        ensure!(
            self.item_sources
                .iter()
                .all(|item| item.source_index < self.sources.len()),
            "migration_invalid_journal"
        );
        for (index, action) in self.actions.iter().enumerate() {
            if let BatchActionKind::Reuse { proof } = &action.action
                && let Some(dependency) = &proof.dependency_action_id
            {
                ensure!(
                    self.actions[..index]
                        .iter()
                        .any(|earlier| &earlier.action_id == dependency),
                    "migration_invalid_journal"
                );
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BatchActionKind {
    Project {
        plan: Box<crate::project_migration::plan::ProjectAssociationPlan>,
    },
    Plugin {
        plan: Box<plugins::PluginBatchAction>,
    },
    History {
        plan: history::HistoryBatchAction,
    },
    Template {
        plan: Box<crate::templates::TemplatePlan>,
    },
    Reuse {
        proof: ReuseProof,
    },
    Settings {
        plan: settings::SettingsGroupPlan,
    },
    Asset {
        plan_id: String,
        target_name: String,
        enabled: bool,
        project_scoped: bool,
        native_reference: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReuseProof {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) history_reference:
        Option<Box<kcoder_state::external_history::lifecycle::ArchiveReferenceReceipt>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency_action_id: Option<String>,
    pub job_id: String,
    pub action_id: String,
    pub item_id: String,
    pub source_key: String,
    pub fingerprint: String,
    pub target_name: String,
    pub enabled: bool,
    pub project_scoped: bool,
    pub native_reference: bool,
}

#[derive(Debug, Clone)]
pub struct McpCredentialChoice {
    pub item_id: String,
    pub fields: Vec<kcoder_types::migration::MigrationMcpPrivateField>,
    pub consent_private_values: bool,
}

#[derive(Debug, Default)]
pub struct BatchPlanPolicy {
    pub reuse_existing: bool,
    pub reserved_skills: std::collections::BTreeSet<String>,
    pub reserved_mcp: std::collections::BTreeSet<String>,
    pub credentials: Vec<crate::store::CredentialResolution>,
    pub mcp_credentials: Vec<McpCredentialChoice>,
}

impl BatchSource {
    pub(crate) fn logical_identity(&self) -> String {
        match self {
            Self::Configuration(binding) => binding.logical_identity(),
            Self::TransferredConfiguration(binding) => binding.stable_identity().to_owned(),
            Self::Assets(binding) => binding.logical_identity(),
            Self::History(binding) => binding.identity().to_owned(),
            Self::Plugin(binding) => binding.logical_identity().to_owned(),
            Self::Project(binding) => binding.logical_identity(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchAction {
    pub action_id: String,
    pub item_ids: Vec<String>,
    pub action: BatchActionKind,
    pub status: kcoder_types::migration::MigrationItemStatus,
    pub error: Option<String>,
}

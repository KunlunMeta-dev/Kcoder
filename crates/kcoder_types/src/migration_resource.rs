//! Explicit target-side limits for a migration's combined historical payload resources.
use serde::{Deserialize, Serialize};

pub const DEFAULT_MIGRATION_RESOURCE_BYTES: u64 = 20 * 1024 * 1024 * 1024;
pub const MAX_MIGRATION_RESOURCE_BYTES: u64 = 512 * 1024 * 1024 * 1024;
pub const MAX_MIGRATION_RESOURCE_FILES: u32 = 16_384;

/// Existing per-file, frame, archive and decoding limits remain independent hard bounds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct MigrationResourceLimits {
    pub max_total_bytes: u64,
    pub max_payload_files: u32,
    pub min_free_bytes: u64,
    pub min_free_file_nodes: u32,
}

impl Default for MigrationResourceLimits {
    fn default() -> Self {
        Self {
            max_total_bytes: DEFAULT_MIGRATION_RESOURCE_BYTES,
            max_payload_files: 10_000,
            min_free_bytes: 128 * 1024 * 1024,
            min_free_file_nodes: 32,
        }
    }
}

impl MigrationResourceLimits {
    /// Wire values must stay inside target-supported bounds, independently of available capacity.
    pub fn is_supported(&self) -> bool {
        self.max_total_bytes > 0
            && self.max_total_bytes <= MAX_MIGRATION_RESOURCE_BYTES
            && self.max_payload_files > 0
            && self.max_payload_files <= MAX_MIGRATION_RESOURCE_FILES
            && (1024 * 1024..=16 * 1024 * 1024 * 1024).contains(&self.min_free_bytes)
            && self.min_free_file_nodes <= MAX_MIGRATION_RESOURCE_FILES
    }
}

/// Planned limits are not an allocation receipt. Legacy jobs remain explicitly untracked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationResourceBudgetPhase {
    NotApplicable,
    LegacyUntracked,
    Planned,
    Active,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationResourceUsage {
    pub reserved_bytes: u64,
    pub committed_bytes: u64,
    pub reserved_files: u32,
    pub committed_files: u32,
}

/// Responses contain observed complete facts; omitted request fields may have defaults instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationResourceLimitFacts {
    pub max_total_bytes: u64,
    pub max_payload_files: u32,
    pub min_free_bytes: u64,
    pub min_free_file_nodes: u32,
}
impl From<MigrationResourceLimits> for MigrationResourceLimitFacts {
    fn from(value: MigrationResourceLimits) -> Self {
        Self {
            max_total_bytes: value.max_total_bytes,
            max_payload_files: value.max_payload_files,
            min_free_bytes: value.min_free_bytes,
            min_free_file_nodes: value.min_free_file_nodes,
        }
    }
}

/// A receipt identifies the accepted intent, even when a newer policy already exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationResourceIncreaseReceipt {
    pub job_id: String,
    pub request_id: String,
    pub previous_revision: u64,
    pub revision: u64,
    pub limits: MigrationResourceLimitFacts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "phase",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MigrationResourceBudgetView {
    #[serde(rename_all = "camelCase")]
    NotApplicable { job_id: String },
    #[serde(rename_all = "camelCase")]
    LegacyUntracked { job_id: String },
    #[serde(rename_all = "camelCase")]
    Planned {
        job_id: String,
        limits: MigrationResourceLimitFacts,
    },
    #[serde(rename_all = "camelCase")]
    Active {
        job_id: String,
        limits: MigrationResourceLimitFacts,
        policy_revision: u64,
        usage: MigrationResourceUsage,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        requested_receipt: Option<MigrationResourceIncreaseReceipt>,
    },
}
impl MigrationResourceBudgetView {
    pub fn phase(&self) -> MigrationResourceBudgetPhase {
        match self {
            Self::NotApplicable { .. } => MigrationResourceBudgetPhase::NotApplicable,
            Self::LegacyUntracked { .. } => MigrationResourceBudgetPhase::LegacyUntracked,
            Self::Planned { .. } => MigrationResourceBudgetPhase::Planned,
            Self::Active { .. } => MigrationResourceBudgetPhase::Active,
        }
    }
    pub fn limits(&self) -> Option<&MigrationResourceLimitFacts> {
        match self {
            Self::Planned { limits, .. } | Self::Active { limits, .. } => Some(limits),
            _ => None,
        }
    }
    pub fn policy_revision(&self) -> Option<u64> {
        match self {
            Self::Active {
                policy_revision, ..
            } => Some(*policy_revision),
            _ => None,
        }
    }
    pub fn usage(&self) -> Option<&MigrationResourceUsage> {
        match self {
            Self::Active { usage, .. } => Some(usage),
            _ => None,
        }
    }
    pub fn requested_receipt(&self) -> Option<&MigrationResourceIncreaseReceipt> {
        match self {
            Self::Active {
                requested_receipt, ..
            } => requested_receipt.as_ref(),
            _ => None,
        }
    }
}

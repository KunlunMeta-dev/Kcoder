//! Durable facts for one offline storage-location operation.
use super::{StorageLocationRecord, StoragePaths};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

/// The Native profile is the full persistent root; Studio owns its subdirectories.
pub const STORAGE_PERSISTENT_ROOT_DOMAIN: &str = "persistent-root";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum StorageMigrationPhase {
    Planned,
    Stopping,
    Stopped,
    Copying,
    Verifying,
    Prepared,
    Committed,
    Verified,
}

impl StorageMigrationPhase {
    pub fn next_phase(self) -> Option<Self> {
        match self {
            Self::Planned => Some(Self::Stopping),
            Self::Stopping => Some(Self::Stopped),
            Self::Stopped => Some(Self::Copying),
            Self::Copying => Some(Self::Verifying),
            Self::Verifying => Some(Self::Prepared),
            Self::Prepared => Some(Self::Committed),
            Self::Committed => Some(Self::Verified),
            Self::Verified => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum StorageMigrationDisposition {
    Active,
    Deferred,
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum StorageLaunchIntent {
    Cli,
    Gateway,
    Desktop,
    VerifyOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageMigrationComponent {
    pub domain: String,
    pub source: PathBuf,
    pub destination: PathBuf,
    pub source_identity: String,
    pub estimated_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageTargetBinding {
    pub path: PathBuf,
    pub existing_ancestor: PathBuf,
    pub ancestor_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageMigrationPlan {
    pub version: u32,
    pub operation_id: String,
    pub original: Option<StorageLocationRecord>,
    pub from: StoragePaths,
    pub target: StorageLocationRecord,
    pub components: Vec<StorageMigrationComponent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub target_bindings: Vec<StorageTargetBinding>,
    pub launch_intent: StorageLaunchIntent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageMigrationReceipt {
    pub plan: StorageMigrationPlan,
    pub phase: StorageMigrationPhase,
    pub disposition: StorageMigrationDisposition,
    /// Domain-owned physical publication facts; never cached authorization decisions.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub owner_receipts: BTreeMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

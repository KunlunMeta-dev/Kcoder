//! Local storage selection metadata; never contains credentials or ACL grants.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const STORAGE_LOCATION_VERSION: u32 = 1;
pub const STORAGE_LOCATION_MAX_BYTES: u64 = 32 * 1024;
pub const STORAGE_LOCATION_MAX_REVISION: u64 = 9_007_199_254_740_991;
pub const STORAGE_STARTUP_ENV: &str = "KCODER_STORAGE_CONTEXT_V1";
pub const STORAGE_STARTUP_MAX_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageConsumer {
    #[default]
    Cli,
    Gateway,
    Desktop,
}

/// Frozen non-secret resolution inputs for an owned child, not an authorization grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageStartupContext {
    pub version: u32,
    pub home: Option<PathBuf>,
    pub platform_config: Option<PathBuf>,
    pub overrides: BTreeMap<String, PathBuf>,
    pub record: Option<StorageLocationRecord>,
    pub consumer: StorageConsumer,
    pub development: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageLocationRecord {
    #[cfg_attr(feature = "json-schema", schemars(range(min = 1, max = 1)))]
    #[serde(deserialize_with = "deserialize_version")]
    pub version: u32,
    #[cfg_attr(
        feature = "json-schema",
        schemars(range(min = 1, max = 9007199254740991u64))
    )]
    #[serde(deserialize_with = "deserialize_revision")]
    pub revision: u64,
    pub data_root: PathBuf,
    pub cache_root: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

// JSON numbers with integral values have the same meaning in Rust and JavaScript.
fn deserialize_revision<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<u64, D::Error> {
    let number = serde_json::Number::deserialize(deserializer)?;
    if let Some(value) = number.as_u64() {
        return Ok(value);
    }
    let value = number
        .as_f64()
        .ok_or_else(|| serde::de::Error::custom("invalid integer"))?;
    if (0.0..=STORAGE_LOCATION_MAX_REVISION as f64).contains(&value) && value.fract() == 0.0 {
        Ok(value as u64)
    } else {
        Err(serde::de::Error::custom("invalid integer"))
    }
}

fn deserialize_version<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    u32::try_from(deserialize_revision(deserializer)?).map_err(serde::de::Error::custom)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum StorageLayout {
    Legacy,
    Unified,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum StorageLocationSource {
    Default,
    Selection,
    ConfigOverride,
    HomeOverride,
    CacheOverride,
    DataOverride,
    ServersStoreOverride,
    DesktopOverride,
    Development,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct StoragePathSources {
    pub data_root: StorageLocationSource,
    pub cache_root: StorageLocationSource,
    pub gateway_root: StorageLocationSource,
    pub desktop_root: StorageLocationSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct StoragePaths {
    pub data_root: PathBuf,
    pub cache_root: PathBuf,
    pub gateway_root: PathBuf,
    pub desktop_root: PathBuf,
    pub temporary_root: PathBuf,
    pub location_file: Option<PathBuf>,
    pub layout: StorageLayout,
    pub sources: StoragePathSources,
    pub externally_configured: bool,
    pub selection_revision: Option<u64>,
    pub operation_id: Option<String>,
}

#[cfg(all(test, feature = "json-schema"))]
mod schema_tests {
    #[test]
    fn published_storage_location_schema_matches_rust_contract() {
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../schema/storage-location.schema.json")).unwrap();
        assert_eq!(
            serde_json::to_value(schemars::schema_for!(super::StorageLocationRecord)).unwrap(),
            expected
        );
    }
}

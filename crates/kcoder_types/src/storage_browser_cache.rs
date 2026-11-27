//! Domain-owned facts stored inside the original offline storage receipt.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const STORAGE_BROWSER_CACHE_RECEIPT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum StorageBrowserCacheSourceKind {
    Directory,
    DirectoryLink,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageBrowserCacheSource {
    pub kind: StorageBrowserCacheSourceKind,
    pub identity: String,
    pub target: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageBrowserCacheRetainedSource {
    pub operation_id: String,
    pub source: StorageBrowserCacheSource,
}

/// Identity is evidence for the original executor, never a stopped/allow verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageBrowserCacheReceipt {
    pub version: u32,
    pub operation_id: String,
    pub partition_identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_partition_identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_target_identity: Option<String>,
    pub source: Option<StorageBrowserCacheSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepared_link_identity: Option<String>,
    pub retained_entry_identity: Option<String>,
    pub published_link_identity: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub retained_sources: Vec<StorageBrowserCacheRetainedSource>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roundtrip_preserves_prepared_and_published_facts_and_rejects_unknown_fields() {
        let value = json!({
            "version": 1, "operationId": "same-operation",
            "partitionIdentity": "unix:1:2", "httpTargetIdentity": "unix:1:3",
            "source": {"kind": "directoryLink", "identity": "unix:1:4", "target": "/old/http"},
            "preparedLinkIdentity": "unix:1:5", "retainedEntryIdentity": "unix:1:4",
            "publishedLinkIdentity": "unix:1:5"
        });
        let receipt: StorageBrowserCacheReceipt = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&receipt).unwrap(), value);
        let mut unknown = value.clone();
        unknown["instanceStopped"] = json!(true);
        assert!(serde_json::from_value::<StorageBrowserCacheReceipt>(unknown).is_err());
        let mut unknown_source = value;
        unknown_source["source"]["allow"] = json!(true);
        assert!(serde_json::from_value::<StorageBrowserCacheReceipt>(unknown_source).is_err());
    }

    #[test]
    fn frozen_relocation_and_final_target_keep_the_source_identity_and_legacy_shape() {
        let frozen = json!({
            "version": 1, "operationId": "move-persistent-root",
            "partitionIdentity": "unix:1:2",
            "source": {"kind": "directory", "identity": "unix:1:3", "target": null},
            "retainedEntryIdentity": null, "publishedLinkIdentity": null,
            "retainedSources": [{
                "operationId": "previous-cache-move",
                "source": {"kind": "directoryLink", "identity": "unix:1:4", "target": "/previous/http"}
            }]
        });
        let receipt: StorageBrowserCacheReceipt = serde_json::from_value(frozen.clone()).unwrap();
        assert!(receipt.target_partition_identity.is_none());
        assert!(receipt.http_target_identity.is_none());
        assert!(receipt.prepared_link_identity.is_none());
        assert_eq!(serde_json::to_value(&receipt).unwrap(), frozen);
        let mut bound = frozen;
        bound["targetPartitionIdentity"] = json!("unix:2:20");
        bound["httpTargetIdentity"] = json!("unix:3:30");
        bound["preparedLinkIdentity"] = json!("unix:2:21");
        bound["publishedLinkIdentity"] = json!("unix:2:21");
        let receipt: StorageBrowserCacheReceipt = serde_json::from_value(bound.clone()).unwrap();
        assert_eq!(receipt.partition_identity, "unix:1:2");
        assert_eq!(serde_json::to_value(&receipt).unwrap(), bound);
    }
}

//! A public cursor is authenticated by the host; raw body offsets are not accepted.
use kcoder_types::historical_search::HistoricalSearchMatch;
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistorySearchParams {
    pub job_id: String,
    pub view_id: Option<String>,
    pub query: String,
    #[serde(default)]
    pub case_sensitive: bool,
    pub cursor: Option<String>,
    pub limit: Option<u8>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistorySearchHit {
    #[serde(flatten)]
    pub found: HistoricalSearchMatch,
    pub body_cursor: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistorySearchResult {
    pub items: Vec<MigrationHistorySearchHit>,
    pub next_cursor: Option<String>,
    pub scanned_records: u64,
    pub total_records: u64,
    pub processed_bytes: u64,
    pub unsupported_blocks: u64,
    pub excluded_blocks: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nonempty_search_hits_roundtrip_without_losing_the_signed_body_cursor() {
        let hit = serde_json::json!({
            "position": 4, "record": 10, "role": "assistant",
            "block": {"index": 2, "kind": "text", "preview": null,
                "sourceBytes": 100, "decodedBytes": null, "bodyAvailable": true,
                "callId": null, "name": null, "namespace": null, "sourceType": null, "outcome": null},
            "before": "before", "matched": "中文", "after": "after", "bodyCursor": "signed-original-body"
        });
        let parsed: MigrationHistorySearchHit = serde_json::from_value(hit.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), hit);
        let mut unexpected = hit;
        unexpected["sourcePath"] = serde_json::json!("not-accepted");
        assert!(serde_json::from_value::<MigrationHistorySearchHit>(unexpected).is_err());
    }
}

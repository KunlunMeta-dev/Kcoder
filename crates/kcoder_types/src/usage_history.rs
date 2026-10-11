use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageCounters {
    pub requests: u64,
    pub unreported_requests: u64,
    pub estimated_total_requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHistory {
    pub version: u32,
    pub tracked_since_ms: u64,
    pub last_recorded_at_ms: u64,
    pub days: BTreeMap<String, BTreeMap<String, UsageCounters>>,
}

use kcoder_types::usage_history::UsageHistory;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsageStatsParams {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatsResult {
    pub window_days: u32,
    pub time_zone: String,
    pub generated_at_ms: u64,
    pub history: Option<UsageHistory>,
}

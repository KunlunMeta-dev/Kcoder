//! Read-only matches in decoded historical bodies, never executable messages.
use crate::{historical_display::HistoricalDisplayBlock, imported_transcript::HistoricalRole};
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalSearchMatch {
    pub position: u64,
    pub record: u64,
    pub block: HistoricalDisplayBlock,
    pub role: Option<HistoricalRole>,
    pub before: String,
    pub matched: String,
    pub after: String,
}

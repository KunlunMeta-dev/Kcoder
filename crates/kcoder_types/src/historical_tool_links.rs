//! Historical correlation facts, never live tool tasks or execution authority.
use crate::imported_transcript::HistoricalToolOutcome;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalToolLocation {
    pub sequence: u64,
    pub record: u64,
    pub block: Option<u32>,
    #[serde(default, skip_serializing_if = "zero")]
    pub source_index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacement_index: Option<u32>,
    /// The physical content-block index, when rollback omitted preceding context blocks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_block: Option<u32>,
}
fn zero(value: &u32) -> bool {
    *value == 0
}

/// Native-only selected-item provenance, not a transport-authorized source reference.
pub struct HistoricalToolOrigin {
    pub source_index: u32,
    pub replacement_index: Option<u32>,
    pub omitted_blocks: Vec<u32>,
}
impl HistoricalToolOrigin {
    pub fn location(
        &self,
        sequence: u64,
        record: u64,
        block: Option<u32>,
    ) -> Option<HistoricalToolLocation> {
        let original = block.and_then(|index| {
            let mut original = index;
            for omitted in &self.omitted_blocks {
                if *omitted <= original {
                    original = original.checked_add(1)?;
                } else {
                    break;
                }
            }
            Some(original)
        });
        if block.is_some() && original.is_none() {
            return None;
        }
        Some(HistoricalToolLocation {
            sequence,
            record,
            block,
            source_index: self.source_index,
            replacement_index: self.replacement_index,
            source_block: original.filter(|original| Some(*original) != block),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum HistoricalToolLinkStatus {
    Linked,
    MissingResult,
    OrphanResult,
    UnmatchedExecutionEvent,
    Ambiguous,
    ConflictingOutcome,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalToolLink {
    pub id: String,
    pub call_id: String,
    pub name: Option<String>,
    pub namespace: Option<String>,
    pub source_turn_id: Option<String>,
    pub call: Option<HistoricalToolLocation>,
    pub result: Option<HistoricalToolLocation>,
    pub execution_event: Option<HistoricalToolLocation>,
    #[serde(default)]
    pub execution_outcome: Option<HistoricalToolOutcome>,
    pub status: HistoricalToolLinkStatus,
    pub outcome: HistoricalToolOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalToolLinkProgress {
    pub processed_records: u64,
    pub recorded_links: u64,
    pub unresolved_links: u64,
    pub sealed: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalToolLinkPage {
    pub links: Vec<HistoricalToolLink>,
    pub next_cursor: Option<String>,
    pub progress: HistoricalToolLinkProgress,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum HistoricalToolLinkStage {
    Planned,
    Correlating,
    Ready,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalToolLinkRun {
    pub sequence: u64,
    pub stage: HistoricalToolLinkStage,
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalBranchToolState {
    pub view_id: String,
    pub run: Option<HistoricalToolLinkRun>,
    pub progress: Option<HistoricalToolLinkProgress>,
    pub worker_running: bool,
    pub cancel_requested: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_locations_keep_their_wire_shape_and_omitted_blocks_map_to_physical_indexes() {
        let legacy = serde_json::json!({"sequence":1,"record":2,"block":0});
        let decoded: HistoricalToolLocation = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), legacy);
        let origin = HistoricalToolOrigin {
            source_index: 2,
            replacement_index: Some(3),
            omitted_blocks: vec![0, 2],
        };
        let location = origin.location(1, 7, Some(1)).unwrap();
        assert_eq!(location.block, Some(1));
        assert_eq!(location.source_block, Some(3));
        assert_eq!(location.source_index, 2);
        assert_eq!(location.replacement_index, Some(3));
    }
}

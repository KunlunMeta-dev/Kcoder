//! Display-only source facts. These types are not model requests, tools or resumed tasks.
use crate::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum HistoricalValueEncoding {
    JsonString,
    Json,
}

/// Private history content. Previews can contain user-pasted secrets and are not diagnostics.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalValueRef {
    pub record: u64,
    pub offset: u64,
    pub bytes: u64,
    pub encoding: HistoricalValueEncoding,
    pub decoded_bytes: Option<u64>,
    pub decoded_sha256: Option<String>,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum HistoricalToolOutcome {
    RecordedSuccess,
    RecordedError,
    RecordedCancelled,
    /// A result exists, but the source did not record whether execution succeeded.
    RecordedResult,
    OutcomeUnknown,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HistoricalBlock {
    Text {
        value: HistoricalValueRef,
    },
    Thinking {
        value: HistoricalValueRef,
    },
    Opaque {
        source_type: String,
        value: HistoricalValueRef,
    },
    ToolCall {
        call_id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_type: Option<String>,
        input: HistoricalValueRef,
    },
    ToolResult {
        call_id: String,
        output: HistoricalValueRef,
        outcome: HistoricalToolOutcome,
    },
    Attachment {
        source_type: String,
        value: HistoricalValueRef,
        media_type: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum HistoricalRole {
    User,
    Assistant,
    System,
    Developer,
    Tool,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalDiagnostic {
    pub code: String,
    pub blocks_continuation: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalCodexBase {
    pub rollout_id: String,
    pub end_ordinal_exclusive: u64,
    pub end_byte_offset: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalCodexMetadata {
    pub source_type: String,
    pub response_type: Option<String>,
    pub client_authored: bool,
    pub inherited_user_message: bool,
    pub compaction_output: bool,
    pub user_input_order: Option<u64>,
    pub user_turn_boundary: Option<bool>,
    pub contextual_message: Option<bool>,
    pub rollback_first_context_blocks: Vec<u32>,
    pub turn_id: Option<String>,
    pub history_base: Option<HistoricalCodexBase>,
    pub forked_from_id: Option<String>,
    pub forked_before_ordinal: Option<u64>,
    pub thread_id: Option<String>,
    pub root_session_id: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalCompactionItem {
    pub index: u32,
    pub source_id: Option<String>,
    pub metadata: HistoricalCodexMetadata,
    pub data: HistoricalRecordData,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalCompaction {
    pub payload: HistoricalValueRef,
    pub message: Option<HistoricalValueRef>,
    pub replacement: Option<Vec<HistoricalCompactionItem>>,
    pub window_number: Option<u64>,
    pub resume_metadata: Option<HistoricalValueRef>,
    pub resume_turn_id: Option<String>,
    pub retained_context: Option<HistoricalValueRef>,
    pub guardian_history: Option<HistoricalValueRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalCodexItemRef {
    #[serde(default, skip_serializing_if = "first_source")]
    pub source_index: u32,
    pub record: u64,
    pub replacement_index: Option<u32>,
    /// Source blocks omitted by rollback, never edits to the immutable archive.
    pub omitted_blocks: Vec<u32>,
}

fn first_source(value: &u32) -> bool {
    *value == 0
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HistoricalRecordData {
    Compaction {
        checkpoint: Box<HistoricalCompaction>,
    },
    Message {
        role: HistoricalRole,
        phase: Option<String>,
        blocks: Vec<HistoricalBlock>,
    },
    Session {
        session_id: String,
        version: Option<String>,
        project: Option<String>,
        title: Option<HistoricalValueRef>,
        parent_session_id: Option<String>,
        history_mode: Option<String>,
        inherited_before_ordinal: Option<u64>,
    },
    Boundary {
        source_type: String,
        payload: HistoricalValueRef,
        rollback_turns: Option<u64>,
        replacement_history: Option<HistoricalValueRef>,
    },
    Metadata {
        source_type: String,
        payload: HistoricalValueRef,
    },
    /// Supplementary events are kept but are not a second user/assistant message.
    Event {
        source_type: String,
        payload: HistoricalValueRef,
        call_id: Option<String>,
        outcome: Option<HistoricalToolOutcome>,
    },
    Unknown {
        source_type: Option<String>,
        payload: Option<HistoricalValueRef>,
    },
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalRecord {
    pub source: MigrationSourceKind,
    pub record: u64,
    pub source_id: Option<String>,
    pub parent_id: Option<String>,
    pub logical_parent_id: Option<String>,
    pub source_session_id: Option<String>,
    pub timestamp: Option<String>,
    pub source_version: Option<String>,
    pub turn_id: Option<String>,
    pub persisted_ordinal: Option<u64>,
    pub sidechain: bool,
    pub hidden: bool,
    pub compact_summary: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<HistoricalCodexMetadata>,
    pub data: HistoricalRecordData,
    pub diagnostics: Vec<HistoricalDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalProjectionProgress {
    pub source_records: u64,
    pub normalized_records: u64,
    pub records_with_diagnostics: u64,
    pub normalization_complete: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalProjectionItem {
    pub record: u64,
    pub bytes: u64,
    pub sha256: String,
    /// Large encoded records use the chunk API instead of overflowing a response frame.
    pub value: Option<HistoricalRecord>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalProjectionPage {
    pub items: Vec<HistoricalProjectionItem>,
    pub next_cursor: Option<u64>,
    pub progress: HistoricalProjectionProgress,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryNormalizationProgress {
    pub committed: HistoricalProjectionProgress,
    pub current_record: Option<u64>,
    pub current_record_bytes: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalSourceNode {
    pub record: u64,
    pub source_id: String,
    pub parent_id: Option<String>,
    pub is_message: bool,
    pub hidden: bool,
    pub sidechain: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalSourceNodePage {
    pub nodes: Vec<HistoricalSourceNode>,
    pub next_cursor: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_tool_calls_without_namespace_or_transport_kind_stay_readable() {
        let legacy = serde_json::json!({"kind":"tool_call","call_id":"historical-call","name":"write","input":{"record":0,"offset":1,"bytes":2,"encoding":"json","decodedBytes":null,"decodedSha256":null,"preview":null}});
        let value: HistoricalBlock = serde_json::from_value(legacy.clone()).unwrap();
        assert!(
            matches!(&value, HistoricalBlock::ToolCall {namespace:None,source_type:None,call_id,..} if call_id=="historical-call")
        );
        assert_eq!(serde_json::to_value(value).unwrap(), legacy);
    }

    #[test]
    fn older_normalized_compaction_boundaries_without_codex_metadata_stay_readable() {
        let legacy = serde_json::json!({
            "source":"codex","record":0,"sourceId":null,"parentId":null,"logicalParentId":null,
            "sourceSessionId":"s","timestamp":null,"sourceVersion":null,"turnId":null,"persistedOrdinal":null,
            "sidechain":false,"hidden":false,"compactSummary":false,"diagnostics":[],
            "data":{"kind":"boundary","source_type":"compaction","rollback_turns":null,"replacement_history":null,
            "payload":{"record":0,"offset":1,"bytes":2,"encoding":"json","decodedBytes":null,"decodedSha256":null,"preview":null}}
        });
        let record: HistoricalRecord = serde_json::from_value(legacy.clone()).unwrap();
        assert!(record.codex.is_none());
        assert!(matches!(record.data, HistoricalRecordData::Boundary { .. }));
        assert!(serde_json::to_value(record).unwrap() == legacy);
    }

    #[cfg(feature = "json-schema")]
    #[test]
    fn compaction_schema_uses_recursive_references_instead_of_unbounded_expansion() {
        let schema = schemars::schema_for!(HistoricalRecord);
        let encoded = serde_json::to_string(&schema).unwrap();
        assert!(encoded.contains("HistoricalCompaction"));
        assert!(encoded.contains("$ref"));
        assert!(encoded.len() < 64 * 1024);
    }
}

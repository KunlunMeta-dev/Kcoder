//! Imported archives are historical evidence, never queued tools or active sessions.
use crate::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};

pub const EXTERNAL_HISTORY_CHUNK_BYTES: usize = 256 * 1024;
pub const EXTERNAL_HISTORY_PAGE_SIZE: u32 = 10;
pub const EXTERNAL_HISTORY_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const EXTERNAL_HISTORY_MAX_RECORDS: u64 = 1_000_000;

/// Private provenance. Do not include this object in diagnostics or tool catalogs.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalHistoryOrigin {
    pub source: MigrationSourceKind,
    pub source_instance: String,
    pub source_session_id: String,
    /// Source artifact identity, distinct from a stable thread/session ID.
    /// Codex uses the immutable rollout ID; Claude selections bind their transcript location.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_artifact_id: Option<String>,
    pub source_format: String,
    pub adapter_revision: String,
    pub title: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub project: Option<String>,
    pub archived: bool,
    pub parent_session_id: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalHistorySnapshot {
    pub origin: ExternalHistoryOrigin,
    pub source_bytes: u64,
    pub source_sha256: String,
    pub record_limit: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<ExternalHistoryEncodedSource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ExternalHistoryEncoding {
    Zstd,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalHistoryEncodedSource {
    pub encoding: ExternalHistoryEncoding,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalHistoryOriginalReceipt {
    pub source: ExternalHistoryEncodedSource,
    pub chunks_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalHistoryReceipt {
    pub schema_version: u32,
    pub archive_id: String,
    pub session_id: String,
    pub snapshot_sha256: String,
    pub source_bytes: u64,
    pub source_sha256: String,
    pub record_count: u64,
    pub index_bytes: u64,
    pub index_sha256: String,
    pub source_chunks_sha256: String,
    pub index_chunks_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<ExternalHistoryOriginalReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalHistoryRecord {
    pub ordinal: u64,
    pub offset: u64,
    pub bytes: u64,
    pub sha256: String,
    pub newline_terminated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalHistoryRecordPage {
    pub records: Vec<ExternalHistoryRecord>,
    pub next_cursor: Option<u64>,
    pub total_records: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExternalHistoryPhase {
    CopyingOriginal,
    ReadingOriginal,
    Decoding,
    Copying,
    Indexing,
    Verifying,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExternalHistoryProgress {
    pub phase: ExternalHistoryPhase,
    pub processed_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum HistoryImportStage {
    Capturing,
    Planned,
    Archiving,
    Normalizing,
    /// Parsing completed; branch selection, attachments and continuation are separate gates.
    Normalized,
    Cancelled,
    Failed,
}

/// A target-owned job projection, without source paths or transcript content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryImportJobView {
    pub job_id: String,
    pub sequence: u64,
    pub source: MigrationSourceKind,
    pub stage: HistoryImportStage,
    pub archive_id: Option<String>,
    pub archived: bool,
    pub normalization: Option<crate::imported_transcript::HistoricalProjectionProgress>,
    pub failure_code: Option<String>,
    pub cancel_requested: bool,
}

/// User-visible source metadata; titles and project labels are private user content.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistorySourceSummary {
    pub source_handle: String,
    pub source: MigrationSourceKind,
    pub source_session_id: String,
    pub source_artifact_id: Option<String>,
    pub parent_session_id: Option<String>,
    pub agent_id: Option<String>,
    pub bytes: u64,
    pub modified_at_ms: Option<u64>,
    pub archived: bool,
    pub compressed: bool,
    pub title: Option<String>,
    pub project: Option<String>,
    pub preview_incomplete: bool,
    /// Known import blockers, independent of bounded preview availability.
    pub import_issues: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryDiscoveryProblem {
    pub code: String,
    pub count: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistorySourcePage {
    pub catalog_id: String,
    pub items: Vec<HistorySourceSummary>,
    pub total_items: u64,
    pub next_cursor: Option<String>,
    pub discovery_complete: bool,
    pub problems: Vec<HistoryDiscoveryProblem>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unencoded_snapshots_and_receipts_keep_their_legacy_wire_representation() {
        let origin = serde_json::json!({"source":"codex","sourceInstance":"owned","sourceSessionId":"old-thread","sourceFormat":"jsonl","adapterRevision":"raw/1","title":null,"createdAt":null,"updatedAt":null,"project":null,"archived":false,"parentSessionId":null});
        let snapshot = serde_json::json!({"origin":origin,"sourceBytes":0,"sourceSha256":"a".repeat(64),"recordLimit":100});
        let decoded: ExternalHistorySnapshot = serde_json::from_value(snapshot.clone()).unwrap();
        assert!(decoded.original.is_none());
        assert!(serde_json::to_value(decoded).unwrap() == snapshot);
        let receipt = serde_json::json!({"schemaVersion":1,"archiveId":"archive","sessionId":"session","snapshotSha256":"a".repeat(64),"sourceBytes":0,"sourceSha256":"b".repeat(64),"recordCount":0,"indexBytes":0,"indexSha256":"c".repeat(64),"sourceChunksSha256":"d".repeat(64),"indexChunksSha256":"e".repeat(64)});
        let decoded: ExternalHistoryReceipt = serde_json::from_value(receipt.clone()).unwrap();
        assert!(decoded.original.is_none());
        assert_eq!(serde_json::to_value(decoded).unwrap(), receipt);
    }

    #[test]
    fn record_references_preserve_offsets_and_reject_unrecognized_fields() {
        let record = ExternalHistoryRecord {
            ordinal: 900_000,
            offset: EXTERNAL_HISTORY_MAX_BYTES - 1,
            bytes: 1,
            sha256: "a".repeat(64),
            newline_terminated: false,
        };
        let mut json = serde_json::to_value(&record).unwrap();
        assert_eq!(json["newlineTerminated"], false);
        assert_eq!(
            serde_json::from_value::<ExternalHistoryRecord>(json.clone()).unwrap(),
            record
        );
        json["executeTool"] = true.into();
        assert!(serde_json::from_value::<ExternalHistoryRecord>(json).is_err());
    }

    #[test]
    fn older_origins_without_a_physical_artifact_keep_their_wire_representation() {
        let legacy = serde_json::json!({"source":"codex","sourceInstance":"owned","sourceSessionId":"old-thread","sourceFormat":"jsonl","adapterRevision":"raw/1","title":null,"createdAt":null,"updatedAt":null,"project":null,"archived":false,"parentSessionId":null});
        let origin: ExternalHistoryOrigin = serde_json::from_value(legacy.clone()).unwrap();
        assert!(origin.source_artifact_id.is_none());
        assert!(serde_json::to_value(origin).unwrap() == legacy);
    }
}

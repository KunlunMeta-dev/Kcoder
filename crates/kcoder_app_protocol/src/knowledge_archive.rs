//! Bounded, connection-owned Wiki archive transfers. No client filesystem paths.
use kcoder_types::knowledge::KnowledgeLibrary;
use serde::{Deserialize, Serialize};

pub const CAPABILITY_KNOWLEDGE_ARCHIVE_STREAM_V1: &str = "knowledgeArchiveStreamV1";
pub mod knowledge_archive_method {
    pub const CAPABILITIES: &str = "knowledge/archiveTransfer/capabilities";
    pub const EXPORT_START: &str = "knowledge/archiveTransfer/exportStart";
    pub const IMPORT_START: &str = "knowledge/archiveTransfer/importStart";
    pub const STATUS: &str = "knowledge/archiveTransfer/status";
    pub const READ: &str = "knowledge/archiveTransfer/read";
    pub const CHUNK: &str = "knowledge/archiveTransfer/chunk";
    pub const IMPORT_FINISH: &str = "knowledge/archiveTransfer/importFinish";
    pub const CANCEL: &str = "knowledge/archiveTransfer/cancel";
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeArchiveSegment {
    pub index: usize,
    pub name: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeArchiveManifest {
    pub format: String,
    pub version: u32,
    pub collection_id: String,
    pub size: u64,
    pub sha256: String,
    pub segments: Vec<KnowledgeArchiveSegment>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeArchiveExportParams {
    pub library_id: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeArchiveImportParams {
    pub manifest: KnowledgeArchiveManifest,
    pub idempotency_key: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeArchiveIdParams {
    pub transfer_id: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeArchiveReadParams {
    pub transfer_id: String,
    pub index: usize,
    pub offset: u64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeArchiveChunkParams {
    pub transfer_id: String,
    pub index: usize,
    pub offset: u64,
    pub content_base64: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeArchiveStatus {
    pub transfer_id: String,
    pub phase: String,
    pub completed_bytes: u64,
    pub total_bytes: u64,
    pub manifest: Option<KnowledgeArchiveManifest>,
    pub library: Option<KnowledgeLibrary>,
    pub error: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeArchiveReadResult {
    pub content_base64: String,
    pub next_offset: u64,
    pub size: u64,
    pub eof: bool,
}

//! Personal Wiki RPC draft. Advertise capability only after server wiring exists.
use kcoder_types::knowledge::{KnowledgeLibrary, KnowledgePageDraft};
use serde::{Deserialize, Serialize};

pub const CAPABILITY_KNOWLEDGE_V1: &str = "knowledgeV1";
pub const CAPABILITY_KNOWLEDGE_HTML_V1: &str = "knowledgeHtmlV1";
pub const CAPABILITY_KNOWLEDGE_FILES_V1: &str = "knowledgeOriginalFilesV1";
pub const CAPABILITY_KNOWLEDGE_FILE_CAPABILITIES_V1: &str = "knowledgeFileCapabilitiesV1";

pub mod knowledge_method {
    pub const IMAGE_IMPORT_LIST: &str = "knowledge/imageImport/list";
    pub const IMAGE_IMPORT_RESUME: &str = "knowledge/imageImport/resume";
    pub const IMAGE_IMPORT_CANCEL: &str = "knowledge/imageImport/cancel";
    pub const FILE_CAPABILITIES: &str = "knowledge/fileCapabilities";
    pub const ATTACHMENT_DIGEST: &str = "knowledge/attachment/digest";
    pub const DIRECTORY_STAGE: &str = "knowledge/source/directoryStage";
    pub const DIRECTORY_PREVIEW: &str = "knowledge/source/directoryPreview";
    pub const ORIGINAL_EXPORT: &str = "knowledge/source/original/export";
    pub const PAGE_LINKS: &str = "knowledge/page/links";
    pub const JOB_CANCEL: &str = "knowledge/job/cancel";
    pub const DEFAULT_READ: &str = "knowledge/default/read";
    pub const DEFAULT_SET: &str = "knowledge/default/set";
    pub const MARKDOWN_EXPORT: &str = "knowledge/markdown/export";
    pub const MARKDOWN_IMPORT: &str = "knowledge/markdown/import";
    pub const JOB_BUDGET: &str = "knowledge/job/budget";
    pub const JOB_BUDGET_EXTEND: &str = "knowledge/job/budget/extend";
    pub const JOB_OVERVIEW: &str = "knowledge/job/overview";
    pub const SOURCE_REMOVE: &str = "knowledge/source/remove";
    pub const SOURCE_REMOVED: &str = "knowledge/source/removed";
    pub const EXPORT: &str = "knowledge/export";
    pub const EXPORT_READ: &str = "knowledge/export/read";
    pub const IMPORT_ARCHIVE: &str = "knowledge/importArchive";
    pub const ARCHIVE: &str = "knowledge/archive";
    pub const REINDEX: &str = "knowledge/reindex";
    pub const INSPECT: &str = "knowledge/inspect";
    pub const IMPORT_ATTACHMENT: &str = "knowledge/source/importAttachment";
    pub const UPDATE: &str = "knowledge/update";
    pub const PAGE_EDIT: &str = "knowledge/page/edit";
    pub const PAGE_HISTORY: &str = "knowledge/page/history";
    pub const PAGE_RESTORE: &str = "knowledge/page/restore";
    pub const REVIEW_READ: &str = "knowledge/review/read";
    pub const REVIEW_PAGE: &str = "knowledge/review/page";
    pub const REVIEW_DECIDE: &str = "knowledge/review/decide";
    pub const CITATION_RESOLVE: &str = "knowledge/citation/resolve";
    pub const JOB_RESUME: &str = "knowledge/job/resume";
    pub const JOB_LIST: &str = "knowledge/job/list";
    pub const JOB_START: &str = "knowledge/job/start";
    pub const JOB_GET: &str = "knowledge/job/get";
    pub const JOB_PAUSE: &str = "knowledge/job/pause";
    pub const JOB_PAUSE_ALL: &str = "knowledge/job/pauseAll";
    pub const STATUS: &str = "knowledge/status";
    pub const CONFIGURE: &str = "knowledge/configure";
    pub const IMPORT_TEXT: &str = "knowledge/source/importText";
    pub const SOURCE_LIST: &str = "knowledge/source/list";
    pub const SOURCE_READ: &str = "knowledge/source/read";
    pub const PAGE_LIST: &str = "knowledge/page/list";
    pub const PAGE_READ: &str = "knowledge/page/read";
    pub const LIST: &str = "knowledge/list";
    pub const CREATE: &str = "knowledge/create";
    pub const READ: &str = "knowledge/read";
    pub const SEARCH: &str = "knowledge/search";
    pub const PROPOSE_CHANGE: &str = "knowledge/change/propose";
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeListParams {
    #[serde(default)]
    pub after_id: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

/// Target-owned file rules; these do not certify the active model's vision support.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeFileCapability {
    pub format: String,
    pub extensions: Vec<String>,
    pub mime_types: Vec<String>,
    pub max_file_bytes: usize,
    pub max_extracted_bytes: usize,
    pub requires_vision: bool,
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeFileCapabilitiesResult {
    pub supported: bool,
    pub items: Vec<KnowledgeFileCapability>,
    pub batch_max_files: usize,
    pub batch_max_bytes: usize,
}
fn default_limit() -> usize {
    20
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeCreateParams {
    pub idempotency_key: String,
    pub name: String,
    #[serde(default)]
    pub purpose: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeReadParams {
    pub library_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeJobOverviewParams {
    pub library_id: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeJobOverviewResult {
    /// Domain-authored public job summaries, never private stage artifacts.
    pub items: Vec<serde_json::Value>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeSearchParams {
    pub library_id: String,
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeProposeChangeParams {
    pub library_id: String,
    pub idempotency_key: String,
    pub pages: Vec<KnowledgePageDraft>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeListResult {
    pub items: Vec<KnowledgeLibrary>,
    pub next_after_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn caller_cannot_supply_an_owner_or_target_override() {
        for key in ["principal", "owner", "ownerId", "target", "targetId"] {
            let mut input = json!({"idempotencyKey":"request", "name":"Wiki"});
            input[key] = json!("another-user");
            assert!(serde_json::from_value::<KnowledgeCreateParams>(input).is_err());
        }
        assert!(
            serde_json::from_value::<KnowledgeCreateParams>(
                json!({"idempotencyKey":"request", "name":"Wiki"})
            )
            .is_ok()
        );
    }
}

pub const CAPABILITY_KNOWLEDGE_CATALOG_V1: &str = "knowledgeCatalogV1";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeStatusParams {}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeConfigureParams {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub retrieval_enabled: Option<bool>,
    #[serde(default)]
    pub organization_enabled: Option<bool>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeStatusResult {
    pub enabled: bool,
    pub retrieval_enabled: bool,
    pub organization_enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeImportTextParams {
    pub library_id: String,
    pub idempotency_key: String,
    pub title: String,
    pub text: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeContentsParams {
    pub library_id: String,
    #[serde(default)]
    pub after_id: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: usize,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgePageReadParams {
    pub library_id: String,
    pub page_id: String,
    #[serde(default)]
    pub revision_id: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeSourceReadParams {
    pub library_id: String,
    pub source_id: String,
    pub revision_id: String,
    #[serde(default)]
    pub after_chunk: usize,
    #[serde(default = "default_chunk_limit")]
    pub limit: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeOriginalExportParams {
    pub library_id: String,
    pub source_id: String,
    pub revision_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeOriginalExportResult {
    pub path: std::path::PathBuf,
    pub size: u64,
    pub filename: String,
    pub mime_type: String,
}
fn default_chunk_limit() -> usize {
    4
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeJobStartParams {
    pub library_id: String,
    pub source_id: String,
    pub revision_id: String,
    pub idempotency_key: String,
    pub language: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeJobParams {
    pub library_id: String,
    pub job_id: String,
}

pub const CAPABILITY_KNOWLEDGE_INGEST_V1: &str = "knowledgeIngestV1";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeCitationParams {
    pub library_id: String,
    pub source_id: String,
    pub revision_id: String,
    pub chunk_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeReviewPageParams {
    pub library_id: String,
    pub job_id: String,
    pub token: String,
    pub page_id: String,
    #[serde(default)]
    pub offset: usize,
}
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeReviewDecision {
    Accept,
    Reject,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeReviewDecisionParams {
    pub library_id: String,
    pub job_id: String,
    pub token: String,
    pub decision: KnowledgeReviewDecision,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgePageEditParams {
    pub library_id: String,
    pub page_id: String,
    pub expected_revision: String,
    pub idempotency_key: String,
    pub title: String,
    pub markdown: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgePageHistoryParams {
    pub library_id: String,
    pub page_id: String,
    #[serde(default)]
    pub before_sequence: Option<u64>,
    #[serde(default = "default_limit")]
    pub limit: usize,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgePageRestoreParams {
    pub library_id: String,
    pub page_id: String,
    pub expected_revision: String,
    pub revision_id: String,
    pub idempotency_key: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeLibraryUpdateParams {
    pub library_id: String,
    pub expected_revision: u64,
    pub name: String,
    #[serde(default)]
    pub purpose: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeImportAttachmentParams {
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub expected_revision: Option<String>,
    pub library_id: String,
    pub idempotency_key: String,
    pub title: String,
    pub attachment_path: String,
}

/// Pause this authenticated target's pending work without changing its opt-in.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KnowledgePauseAllParams {}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgePauseAllResult {
    pub paused_jobs: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeArchiveParams {
    pub library_id: String,
    pub expected_revision: u64,
    pub archived: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeExportReadParams {
    pub attachment_path: String,
    pub offset: u64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeImportArchiveParams {
    pub attachment_path: String,
    pub idempotency_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeSourceRemoveParams {
    pub library_id: String,
    pub source_id: String,
    pub expected_revision: String,
    pub removed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeBudgetExtendParams {
    pub library_id: String,
    pub job_id: String,
    pub expected_limit: u32,
    pub new_limit: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeMarkdownImportParams {
    pub library_id: String,
    pub attachment_path: String,
    pub idempotency_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgePageLinksParams {
    pub library_id: String,
    pub page_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeDirectoryParams {
    pub directory: String,
    /// Optional explicit leaf names. Omission retains legacy whole-folder staging.
    #[serde(default)]
    pub selected_titles: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDirectoryPreviewEntry {
    pub title: String,
    pub size: u64,
    pub available: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDirectoryPreviewResult {
    pub items: Vec<KnowledgeDirectoryPreviewEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeAttachmentDigestParams {
    pub attachment_path: String,
    pub title: String,
}

/// Versioned recovery contract; older clients keep synchronous importAttachment semantics.
pub const CAPABILITY_KNOWLEDGE_IMAGE_IMPORT_V1: &str = "knowledgeImageImportV1";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeImageImportParams {
    pub library_id: String,
    pub import_id: String,
    /// Explicit additional call authorization; cached response retries consume no calls.
    #[serde(default)]
    pub additional_call_budget: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeImageImportListParams {
    pub library_id: String,
    #[serde(default)]
    pub after_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeImageImportListResult {
    pub supported: bool,
    pub items: Vec<kcoder_types::knowledge::WikiImageImport>,
    pub next_after_id: Option<String>,
}

#[cfg(test)]
mod image_import_contract_tests {
    use super::*;
    #[test]
    fn resume_pins_import_identity_and_authorizes_only_explicit_nonnegative_call_budget() {
        let input = serde_json::json!({"libraryId":"library","importId":"import"});
        assert_eq!(
            serde_json::from_value::<KnowledgeImageImportParams>(input.clone())
                .unwrap()
                .additional_call_budget,
            0
        );
        for (key, value) in [
            ("owner", serde_json::json!("other")),
            ("response", serde_json::json!("unverified")),
            ("additionalCallBudget", serde_json::json!(-1)),
        ] {
            let mut invalid = input.clone();
            invalid[key] = value;
            assert!(serde_json::from_value::<KnowledgeImageImportParams>(invalid).is_err());
        }
        assert!(
            serde_json::from_value::<KnowledgeImageImportListParams>(
                serde_json::json!({"libraryId":"library","attachmentPath":"/host"})
            )
            .is_err()
        );
    }
}

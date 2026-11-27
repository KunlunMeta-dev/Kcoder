//! Personal Wiki domain services, independent of UI, Engine and Provider.
//! The host must construct a scope from its authenticated connection identity.
mod catalog;
mod directory_writer;
mod migrations;
#[cfg(test)]
mod test_support;
pub use directory_writer::DirectoryKnowledgeWriter;
pub mod integrations;
pub use catalog::{KnowledgeCatalog, KnowledgeScope, LIBRARY_TRASH_RETENTION_MS, Library};
mod profile_scope;
pub use profile_scope::{
    ProfileCredentialFileMapping, personal_profile_scope, relocated_profile_credential_file,
};
pub mod relocation;

mod search;
pub use search::{IndexedDocument, KnowledgeHit};

mod changes;
mod citation_repair;
pub use changes::{EvidenceChunk, ExistingPage, ValidatedChanges, validate_generated_changes};

mod objects;
mod sources;
pub use sources::{MAX_SOURCE_CHUNK_BYTES, SourceChunk, SourceRevision};

mod pages;
pub use pages::{PageRevisionRef, StoredPage};

mod ingest;
pub use ingest::{
    PREPARATION_VERSION, PreparedWikiUpdate, WIKI_MAX_OUTPUT_BYTES, WIKI_MAX_OUTPUT_TOKENS,
    WIKI_MAX_PAGE_BYTES, WikiAnalysis, WikiIngestRequest, WikiModel, WikiModelRequest,
    WikiOutputTruncated, WikiProposal, WikiSourceChunkExceedsContext, WikiToolStep,
    WikiToolsRejected, WikiTurnRequest, WikiTurnResponse, file_contract_call_limit,
};

mod selection;
pub use selection::LibrarySelection;

mod access;
pub use access::KnowledgeAccess;

mod jobs;
pub use jobs::{
    WikiCheckpoint, WikiJob, WikiJobLease, WikiJobOverviewItem, WikiJobOverviewPage,
    WikiJobProgress,
};

#[cfg(test)]
mod jobs_tests;

mod reviews;
pub use reviews::{ReviewRequired, WikiReviewExcerpt, WikiReviewPage, WikiReviewSummary};

mod page_edit;
pub use page_edit::WikiPageVersion;

mod library_edit;
mod library_lifecycle;

mod maintenance;
pub use maintenance::{WikiIndexReport, WikiInspection, WikiInspectionIssue};

mod archive_cleanup;
mod portable;
pub use portable::archive_stream::{ARCHIVE_STREAM_MAGIC, ArchiveStreamProgress, MAX_STREAM_BYTES};
mod archive_segments;
pub use archive_segments::{
    ArchiveCollection, ArchiveCollectionManifest, ArchiveSegment, ArchiveSegmentReader,
    ArchiveSegmentWriter, MAX_ARCHIVE_SEGMENT_BYTES,
};

mod source_lifecycle;
pub use source_lifecycle::{SourceAffectedPage, SourceStatus};

mod budget;
pub use budget::{WikiBudgetReservation, WikiBudgetSummary, WikiTokenUsage};

mod projection;
pub use projection::{WikiMarkdownBundle, WikiMarkdownPage};

mod navigation;
pub use navigation::{WikiPageLink, WikiPageLinks};

mod findings;
mod pipeline;
mod stage_cache;
mod tool_loop_store;
pub use pipeline::{WikiStageBinding, WikiStageInput, WikiStagePageRevision};
mod automatic_merge;
pub use automatic_merge::WikiAutomaticMergeLease;

mod image_import;
pub use image_import::{
    ImageImportClaimFacts, ImageImportInput, ImageImportLease, ImageImportOriginal,
};

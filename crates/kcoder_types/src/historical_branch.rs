//! Historical branch indexes are derived evidence, never active messages or permissions.
use crate::{imported_transcript::HistoricalCodexItemRef, migration::MigrationSourceKind};
use serde::{Deserialize, Serialize};

/// Native-only immutable bindings. Do not export source fingerprints as UI metadata.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalBranchSource {
    pub archive_id: String,
    pub projection_fingerprint: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalBranchRecipe {
    pub revision: String,
    pub normalization_revision: String,
    pub source: MigrationSourceKind,
    /// The root is source zero; other explicitly selected archives are sorted by identity.
    pub sources: Vec<HistoricalBranchSource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum HistoricalBranchStage {
    Planned,
    Reconstructing,
    Saving,
    Ready,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalBranchProgress {
    pub view_id: String,
    pub sequence: u64,
    pub source: MigrationSourceKind,
    pub stage: HistoricalBranchStage,
    pub checks: u64,
    pub written_items: u64,
    pub total_items: Option<u64>,
    /// Structural reconstruction only; not approval or proof of safe continuation.
    pub structural_complete: Option<bool>,
    pub source_records_with_diagnostics: u64,
    pub issues: Vec<String>,
    pub cancel_requested: bool,
    pub failure_code: Option<String>,
}

/// Private compiled-plan proof; contents are validated again against the immutable recipe.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalBranchPlan {
    pub selection_sha256: String,
    pub total_items: u64,
    pub structural_complete: bool,
    pub source_records_with_diagnostics: u64,
    pub issues: Vec<String>,
}

pub struct HistoricalBranchItems {
    pub recipe: HistoricalBranchRecipe,
    pub progress: HistoricalBranchProgress,
    pub items: Vec<HistoricalCodexItemRef>,
    pub next_cursor: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalBranchChoice {
    pub view_id: String,
    pub related_job_ids: Vec<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalBranchDisplayItem {
    pub position: u64,
    pub source_index: u32,
    pub source_session_id: String,
    pub replacement_index: Option<u32>,
    pub omitted_blocks: u32,
    pub record: crate::historical_display::HistoricalDisplayRecord,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalBranchDisplayPage {
    pub progress: HistoricalBranchProgress,
    pub title: Option<String>,
    pub source_session_id: String,
    pub items: Vec<HistoricalBranchDisplayItem>,
    pub next_cursor: Option<u64>,
}

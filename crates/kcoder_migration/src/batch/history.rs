//! An explicitly chosen history file participates in the existing batch journal.
use crate::{
    MigrationInventory, NormalizedItem, history_discovery::HistoryPendingSelection,
    history_normalization::HISTORY_NORMALIZATION_REVISION,
};
use anyhow::{Result, ensure};
use kcoder_types::migration::*;
use serde::{Deserialize, Serialize};
pub const HISTORY_BATCH_SOURCE_BUDGET_BYTES: u64 = 20 * 1024 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryBatchSource {
    selection: HistoryPendingSelection,
    fingerprint: String,
    normalization_revision: String,
}
impl std::fmt::Debug for HistoryBatchSource {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("HistoryBatchSource")
            .field("source", &self.source())
            .finish_non_exhaustive()
    }
}
impl PartialEq for HistoryBatchSource {
    fn eq(&self, other: &Self) -> bool {
        self.fingerprint == other.fingerprint
            && self.normalization_revision == other.normalization_revision
    }
}
impl Eq for HistoryBatchSource {}

impl HistoryBatchSource {
    pub fn new(selection: HistoryPendingSelection) -> Result<Self> {
        let fingerprint = selection.batch_fingerprint()?;
        let value = Self {
            selection,
            fingerprint,
            normalization_revision: HISTORY_NORMALIZATION_REVISION.into(),
        };
        value.validate()?;
        Ok(value)
    }
    pub fn source(&self) -> MigrationSourceKind {
        self.selection.source()
    }
    pub fn bytes(&self) -> u64 {
        self.selection.bound_bytes()
    }
    pub(crate) fn identity(&self) -> &str {
        &self.fingerprint
    }
    pub(crate) fn selection(&self) -> &HistoryPendingSelection {
        &self.selection
    }
    pub(crate) fn revision(&self) -> &str {
        &self.normalization_revision
    }
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(
            self.fingerprint == self.selection.batch_fingerprint()?
                && crate::history_normalization::executable_revision(&self.normalization_revision),
            "migration_history_batch_binding_changed"
        );
        ensure!(
            self.selection.summary().import_issues.is_empty(),
            "migration_history_source_budget_exceeded"
        );
        Ok(())
    }
    pub(crate) fn inventory(&self) -> Result<MigrationInventory> {
        self.validate()?;
        let summary = self.selection.summary();
        Ok(MigrationInventory {
            source: self.source(),
            adapter_revision: "history-batch/1".into(),
            issues: Vec::new(),
            items: vec![NormalizedItem {
                preview: MigrationItemPreview {
                    id: "selected-history".into(),
                    category: MigrationCategory::History,
                    source_name: summary
                        .title
                        .clone()
                        .filter(|title| !title.is_empty())
                        .unwrap_or_else(|| summary.source_session_id.clone()),
                    status: MigrationItemStatus::Discovered,
                    selected_by_default: true,
                    issues: Vec::new(),
                },
                provider: None,
                mcp: None,
                asset: None,
                template: None,
            }],
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryBatchResolution {
    pub item_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryBatchAction {
    pub history_job_id: String,
    pub source_fingerprint: String,
    pub normalization_revision: String,
}

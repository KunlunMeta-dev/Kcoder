//! Read-only model-window selection. This does not resume source operations or grant permissions.
use anyhow::{Context, Result, ensure};
use kcoder_state::external_history::projection::HistoricalProjectionStore;
use kcoder_types::{
    external_history::EXTERNAL_HISTORY_MAX_RECORDS, imported_transcript::*,
    migration::MigrationSourceKind,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

mod collect;
mod execution;
mod lineage;
mod reconstruction;
mod replay;
pub use lineage::{
    CodexHistoryLineage, CodexLineageSegment, resolve_codex_history_lineage,
    resolve_codex_history_lineage_with_revision,
};
pub use reconstruction::{
    ReconstructedCodexHistory, reconstruct_readable_history,
    reconstruct_readable_history_with_tool_declarations,
};
pub(crate) use reconstruction::{inert_search_reference, inert_search_summary};

const SELECTION_MEMORY_BYTES: usize = 64 * 1024 * 1024;

pub struct CodexHistorySelection {
    source_fingerprint: String,
    lineage: Option<CodexHistoryLineage>,
    selection_sha256: String,
    items: Vec<HistoricalCodexItemRef>,
    checkpoint: Option<u64>,
    checkpoint_source: u32,
    source_records_with_diagnostics: u64,
    issues: BTreeSet<String>,
}

impl CodexHistorySelection {
    pub fn source_archive_ids(&self) -> Option<Vec<&str>> {
        self.lineage
            .as_ref()
            .map(|lineage| lineage.source_archive_ids().collect())
    }
    pub fn items(&self) -> &[HistoricalCodexItemRef] {
        &self.items
    }
    pub fn checkpoint(&self) -> Option<u64> {
        self.checkpoint
    }
    pub fn checkpoint_source(&self) -> Option<u32> {
        self.checkpoint.map(|_| self.checkpoint_source)
    }
    pub fn selection_sha256(&self) -> &str {
        &self.selection_sha256
    }
    pub fn source_records_with_diagnostics(&self) -> u64 {
        self.source_records_with_diagnostics
    }
    pub fn issues(&self) -> &BTreeSet<String> {
        &self.issues
    }
    /// Only the selected window's structural reconstruction. This is not continuation approval.
    pub fn complete_window(&self) -> bool {
        self.issues.is_empty()
    }

    /// Recheck the source binding before returning private source data. The result is
    /// still HistoricalRecordData, never a native Message or executable tool request.
    pub fn item(
        &self,
        index: &HistoricalProjectionStore,
        position: usize,
    ) -> Result<HistoricalRecordData> {
        ensure!(
            self.lineage.is_none(),
            "history_selection_requires_scoped_store"
        );
        ensure!(
            index.source_fingerprint() == self.source_fingerprint,
            "history_selection_source_changed"
        );
        let selected = self
            .items
            .get(position)
            .context("history_selection_item_not_found")?;
        let record = index.record(selected.record)?;
        selected_data(record, selected)
    }

    pub fn item_from_store(
        &self,
        store: &kcoder_state::external_history::ExternalHistoryStore,
        position: usize,
    ) -> Result<HistoricalRecordData> {
        let lineage = self
            .lineage
            .as_ref()
            .context("history_selection_requires_index")?;
        let selected = self
            .items
            .get(position)
            .context("history_selection_item_not_found")?;
        selected_data(
            lineage.record(store, selected.source_index, selected.record)?,
            selected,
        )
    }
}

pub(crate) fn selected_data(
    record: HistoricalRecord,
    selected: &HistoricalCodexItemRef,
) -> Result<HistoricalRecordData> {
    Ok(selected_record(record, selected)?.data)
}

pub(crate) fn selected_record(
    mut record: HistoricalRecord,
    selected: &HistoricalCodexItemRef,
) -> Result<HistoricalRecord> {
    let original = std::mem::replace(
        &mut record.data,
        HistoricalRecordData::Unknown {
            source_type: None,
            payload: None,
        },
    );
    let mut data = match selected.replacement_index {
        None => original,
        Some(at) => {
            let HistoricalRecordData::Compaction { checkpoint } = original else {
                anyhow::bail!("history_selection_checkpoint_changed")
            };
            let replacement = checkpoint
                .replacement
                .context("history_selection_checkpoint_changed")?
                .into_iter()
                .nth(at as usize)
                .context("history_selection_item_not_found")?;
            record.source_id = replacement.source_id;
            record.parent_id = None;
            record.logical_parent_id = None;
            record.timestamp = None;
            record.turn_id = replacement.metadata.turn_id.clone();
            record.compact_summary = replacement.metadata.compaction_output;
            record.codex = Some(replacement.metadata);
            replacement.data
        }
    };
    if !selected.omitted_blocks.is_empty() {
        let HistoricalRecordData::Message { blocks, .. } = &mut data else {
            anyhow::bail!("history_selection_block_mismatch")
        };
        ensure!(
            selected
                .omitted_blocks
                .iter()
                .all(|at| (*at as usize) < blocks.len()),
            "history_selection_block_mismatch"
        );
        let mut at = 0;
        blocks.retain(|_| {
            let keep = selected.omitted_blocks.binary_search(&at).is_err();
            at += 1;
            keep
        });
    }
    record.data = data;
    Ok(record)
}

#[derive(Clone)]
struct Item {
    location: HistoricalCodexItemRef,
    metadata: HistoricalCodexMetadata,
    role: HistoricalRole,
    blocks: usize,
}
impl Item {
    fn from_data(
        record: u64,
        replacement_index: Option<u32>,
        metadata: &HistoricalCodexMetadata,
        data: &HistoricalRecordData,
    ) -> Self {
        let (role, blocks) = match data {
            HistoricalRecordData::Message { role, blocks, .. } => (*role, blocks.len()),
            _ => (HistoricalRole::Unknown, 0),
        };
        Self {
            location: HistoricalCodexItemRef {
                source_index: 0,
                record,
                replacement_index,
                omitted_blocks: Vec::new(),
            },
            metadata: metadata.clone(),
            role,
            blocks,
        }
    }
    fn charged_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.metadata.source_type.len()
            + self.metadata.response_type.as_ref().map_or(0, String::len)
            + self.metadata.turn_id.as_ref().map_or(0, String::len)
            + self.metadata.rollback_first_context_blocks.len() * std::mem::size_of::<u32>()
    }
}

enum Kind {
    Item(Box<Item>),
    Supplemental(Box<Item>),
    Compaction {
        replacement: Option<Vec<Item>>,
        bounds_input: bool,
        resume_turn_id: Option<String>,
    },
    Start,
    Complete,
    Abort,
    UserEvent,
    Context,
    Rollback(u64),
    InterAgent,
    Other,
}
struct Entry {
    source_index: u32,
    record: u64,
    turn_id: Option<String>,
    kind: Kind,
}

/// A single captured rollout. An unresolved history_base stays a blocking issue;
/// source IDs never become paths or authorize loading another account's history.
pub fn select_codex_history(
    index: &HistoricalProjectionStore,
    mut check: impl FnMut(u64) -> bool,
) -> Result<CodexHistorySelection> {
    ensure!(
        index.source_kind() == MigrationSourceKind::Codex,
        "history_selection_source_mismatch"
    );
    let progress = index.progress()?;
    ensure!(
        progress.normalization_complete,
        "history_selection_normalization_incomplete"
    );
    let mut collected = collect::Collection::new(
        progress.normalized_records,
        false,
        crate::history_normalization::supports_execution_events(index.adapter_revision()),
    );
    if progress.normalized_records > 0 {
        let head = index.record(0)?;
        if let HistoricalRecordData::Session {
            history_mode,
            inherited_before_ordinal: Some(start),
            ..
        } = head.data
            && history_mode.as_deref() == Some("paginated")
            && index
                .record(progress.normalized_records - 1)?
                .persisted_ordinal
                .and_then(|last| last.checked_add(1))
                .is_none_or(|next| next < start)
        {
            collected
                .issues
                .insert("codex_child_history_incomplete".into());
        }
    }
    for ordinal in 0..progress.normalized_records {
        collected.push(index.record(ordinal)?, 0, &mut check)?;
    }
    if !collected.session_seen {
        collected
            .issues
            .insert("codex_session_metadata_missing".into());
    }
    finish_selection(
        collected,
        index.source_fingerprint(),
        None,
        progress.records_with_diagnostics,
        &mut check,
    )
}

/// Compile the same rollback/compaction window over verified parent prefixes and
/// the root's suffix. Metadata rows describe their files, not new user messages.
pub fn select_codex_history_from_lineage(
    store: &kcoder_state::external_history::ExternalHistoryStore,
    lineage: CodexHistoryLineage,
    mut check: impl FnMut(u64) -> bool,
) -> Result<CodexHistorySelection> {
    lineage.verify_owner(store)?;
    let records = lineage
        .segments()
        .iter()
        .map(|segment| segment.end_record_exclusive())
        .sum();
    let mut collected = collect::Collection::new(
        records,
        true,
        !lineage.sources.is_empty()
            && lineage.sources.iter().all(|source| {
                crate::history_normalization::supports_execution_events(
                    &source.normalization_revision,
                )
            }),
    );
    collected.session_seen = true;
    let mut diagnostics = 0;
    for segment in lineage.segments() {
        ensure!(
            check(segment.first_ordinal()),
            "history_selection_cancelled"
        );
        let source = &lineage.sources[segment.source_index() as usize];
        let head = lineage::header(source)?;
        // This one source diagnostic has been satisfied by the verified closure.
        // Keep the archive and diagnostic count intact rather than rewriting it.
        if !head.diagnostics.is_empty() {
            diagnostics += 1;
        }
        let index = lineage::projection(&source.reader, &source.normalization_revision)?;
        for ordinal in 1..segment.end_record_exclusive() {
            let record = index.record(ordinal)?;
            let expected = segment
                .first_ordinal()
                .checked_add(ordinal - 1)
                .context("history_lineage_ordinal_overflow")?;
            ensure!(
                record.persisted_ordinal == Some(expected),
                "history_lineage_ordinal_mismatch"
            );
            if !record.diagnostics.is_empty() {
                diagnostics += 1;
            }
            collected.push(record, segment.source_index(), &mut check)?;
        }
    }
    let fingerprint = lineage.lineage_sha256().to_owned();
    finish_selection(
        collected,
        fingerprint,
        Some(lineage),
        diagnostics,
        &mut check,
    )
}

fn finish_selection(
    collected: collect::Collection,
    source_fingerprint: String,
    lineage: Option<CodexHistoryLineage>,
    source_records_with_diagnostics: u64,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<CodexHistorySelection> {
    let entries = collected.entries;
    let mut issues = collected.issues;
    let checkpoint = replay::checkpoint(&entries, check)?;
    let mut selected = replay::window(&entries, checkpoint, &mut issues, check)?;
    if let Some(execution) = collected.execution {
        selected = execution.selected(selected, &mut issues, collected.charged, check)?;
    }
    let items = selected
        .into_iter()
        .map(|item| item.location)
        .collect::<Vec<_>>();
    let checkpoint_source = checkpoint.map_or(0, |at| entries[at].source_index);
    let checkpoint = checkpoint.map(|at| entries[at].record);
    let mut hash = Sha256::new();
    serde_json::to_writer(
        HashWriter(&mut hash),
        &(
            if lineage.is_some() {
                "codex-lineage-window/v1"
            } else {
                "codex-window/v1"
            },
            &source_fingerprint,
            checkpoint,
            &items,
            &issues,
        ),
    )?;
    Ok(CodexHistorySelection {
        source_fingerprint,
        lineage,
        checkpoint_source,
        selection_sha256: format!("{:x}", hash.finalize()),
        items,
        checkpoint,
        source_records_with_diagnostics,
        issues,
    })
}

struct HashWriter<'a>(&'a mut Sha256);
impl std::io::Write for HashWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

//! Explicit archive-only lineage. Foreign identifiers never become filesystem paths.
use super::*;
use crate::history_normalization::HISTORY_NORMALIZATION_REVISION;
use crate::history_records::CODEX_ROLLOUT_BASELINE;
use kcoder_state::external_history::{ExternalHistoryReader, ExternalHistoryStore};
use kcoder_types::external_history::{EXTERNAL_HISTORY_MAX_BYTES, ExternalHistoryReceipt};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

const MAX_ARCHIVES: usize = 256;
const MAX_BUNDLE_BYTES: u64 = 20 * 1024 * 1024 * 1024;

pub(super) struct Source {
    pub archive_id: String,
    pub reader: ExternalHistoryReader,
    pub receipt: ExternalHistoryReceipt,
    pub rollout_id: Option<Uuid>,
    pub normalization_revision: String,
}

/// Physical local record numbers include the source's metadata at zero; inherited
/// model history starts at one, independently of its persisted global ordinal.
pub struct CodexLineageSegment {
    source: u32,
    end_record_exclusive: u64,
    first_ordinal: u64,
    prefix_sha256: String,
}
impl CodexLineageSegment {
    pub fn source_index(&self) -> u32 {
        self.source
    }
    pub fn end_record_exclusive(&self) -> u64 {
        self.end_record_exclusive
    }
    pub fn first_ordinal(&self) -> u64 {
        self.first_ordinal
    }
}

pub struct CodexHistoryLineage {
    pub(super) owner_scope: String,
    pub(super) sources: Vec<Source>,
    segments: Vec<CodexLineageSegment>,
    lineage_sha256: String,
}
impl CodexHistoryLineage {
    pub fn source_archive_ids(&self) -> impl Iterator<Item = &str> {
        self.sources.iter().map(|source| source.archive_id.as_str())
    }
    pub fn segments(&self) -> &[CodexLineageSegment] {
        &self.segments
    }
    pub fn lineage_sha256(&self) -> &str {
        &self.lineage_sha256
    }
    pub(super) fn verify_owner(&self, store: &ExternalHistoryStore) -> Result<()> {
        ensure!(
            store.scope_fingerprint()? == self.owner_scope,
            "history_lineage_owner_mismatch"
        );
        Ok(())
    }
    /// Historical source data only, not a provider message or executable tool call.
    pub fn record(
        &self,
        store: &ExternalHistoryStore,
        source: u32,
        record: u64,
    ) -> Result<HistoricalRecord> {
        self.verify_owner(store)?;
        let segment = self
            .segments
            .iter()
            .find(|segment| segment.source == source)
            .context("history_lineage_source_not_selected")?;
        ensure!(
            (1..segment.end_record_exclusive).contains(&record),
            "history_lineage_record_outside_prefix"
        );
        let selected = &self.sources[source as usize];
        let reader = store.reader(&selected.archive_id)?;
        ensure!(
            reader.receipt()?.as_ref() == Some(&selected.receipt),
            "history_lineage_source_changed"
        );
        let index = projection(&reader, &selected.normalization_revision)?;
        let value = index.record(record)?;
        let expected = segment
            .first_ordinal
            .checked_add(record - 1)
            .context("history_lineage_ordinal_overflow")?;
        ensure!(
            value.persisted_ordinal == Some(expected),
            "history_lineage_ordinal_mismatch"
        );
        Ok(value)
    }
}

pub(super) fn projection(
    reader: &ExternalHistoryReader,
    revision: &str,
) -> Result<HistoricalProjectionStore> {
    reader
        .projection(revision, false)?
        .context("history_lineage_normalization_missing")
}

pub(super) fn header(source: &Source) -> Result<HistoricalRecord> {
    let index = projection(&source.reader, &source.normalization_revision)?;
    let record = index.record(0)?;
    let HistoricalRecordData::Session {
        session_id,
        history_mode,
        ..
    } = &record.data
    else {
        anyhow::bail!("history_lineage_session_metadata_missing")
    };
    ensure!(
        history_mode.as_deref() == Some("paginated"),
        "history_lineage_source_not_paginated"
    );
    ensure!(
        source.normalization_revision == HISTORY_NORMALIZATION_REVISION
            || record.source_version.as_deref() == Some(CODEX_ROLLOUT_BASELINE),
        "history_lineage_source_version_unsupported"
    );
    ensure!(
        Uuid::parse_str(session_id).ok()
            == Uuid::parse_str(&source.reader.origin().source_session_id).ok()
            && Uuid::parse_str(session_id).is_ok(),
        "history_lineage_session_identity_mismatch"
    );
    ensure!(
        !record
            .diagnostics
            .iter()
            .any(|issue| issue.blocks_continuation && issue.code != "source_history_base_required"),
        "history_lineage_source_metadata_invalid"
    );
    let metadata = record
        .codex
        .as_ref()
        .context("history_lineage_adapter_incompatible")?;
    let expected = metadata
        .history_base
        .as_ref()
        .map_or(0, |base| base.end_ordinal_exclusive);
    ensure!(
        record.persisted_ordinal == Some(expected),
        "history_lineage_metadata_ordinal_mismatch"
    );
    Ok(record)
}

struct Scan {
    checked: u64,
}
impl Scan {
    fn tick(&mut self, check: &mut impl FnMut(u64) -> bool) -> Result<()> {
        self.checked += 1;
        ensure!(
            self.checked <= 4 * EXTERNAL_HISTORY_MAX_RECORDS,
            "history_lineage_scan_budget_exceeded"
        );
        ensure!(check(self.checked), "history_selection_cancelled");
        Ok(())
    }
}

fn range(
    source: &Source,
    head: &HistoricalRecord,
    end: Option<&HistoricalCodexBase>,
    scan: &mut Scan,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<(u64, String)> {
    let first = head
        .persisted_ordinal
        .context("history_lineage_metadata_ordinal_mismatch")?;
    let mut cursor = source.reader.record_cursor()?;
    let records = if let Some(end) = end {
        ensure!(
            end.end_ordinal_exclusive > 0
                && end.end_byte_offset > 0
                && end.end_byte_offset <= source.receipt.source_bytes,
            "history_lineage_invalid_cutoff"
        );
        let mut lo = 0;
        let mut hi = source.receipt.record_count;
        while lo < hi {
            scan.tick(check)?;
            let at = lo + (hi - lo) / 2;
            let value = cursor.metadata(at)?;
            if value.offset < end.end_byte_offset {
                lo = at + 1;
            } else {
                hi = at;
            }
        }
        ensure!(lo > 0, "history_lineage_invalid_cutoff");
        let last = cursor.metadata(lo - 1)?;
        ensure!(
            last.offset + last.bytes == end.end_byte_offset && last.newline_terminated,
            "history_lineage_cutoff_not_record_boundary"
        );
        ensure!(
            first.checked_add(lo) == Some(end.end_ordinal_exclusive),
            "history_lineage_cutoff_ordinal_mismatch"
        );
        lo
    } else {
        if let HistoricalRecordData::Session {
            inherited_before_ordinal: Some(start),
            ..
        } = &head.data
        {
            ensure!(
                first
                    .checked_add(source.receipt.record_count)
                    .is_some_and(|next| next >= *start),
                "history_lineage_child_prefix_incomplete"
            );
        }
        source.receipt.record_count
    };
    let index = projection(&source.reader, &source.normalization_revision)?;
    let progress = index.progress()?;
    ensure!(
        progress.normalized_records >= records,
        "history_lineage_normalization_incomplete"
    );
    let mut hash = Sha256::new();
    hash.update(b"codex-physical-prefix/v1\0");
    let mut next_offset = 0;
    for at in 0..records {
        scan.tick(check)?;
        let value = cursor.metadata(at)?;
        let expected = first
            .checked_add(at)
            .context("history_lineage_ordinal_overflow")?;
        ensure!(
            index.record(at)?.persisted_ordinal == Some(expected),
            "history_lineage_ordinal_mismatch"
        );
        ensure!(
            value.offset == next_offset,
            "history_lineage_record_index_gap"
        );
        next_offset = value.offset + value.bytes;
        hash.update(value.offset.to_le_bytes());
        hash.update(value.bytes.to_le_bytes());
        hash.update(value.sha256.as_bytes());
        hash.update([u8::from(value.newline_terminated)]);
    }
    Ok((records, format!("{:x}", hash.finalize())))
}

/// `selected_archives` contains explicit grants in this one target store. This never
/// enumerates the account or follows source paths, sessions, hooks, or live writers.
pub fn resolve_codex_history_lineage(
    store: &ExternalHistoryStore,
    root_archive: &str,
    selected_archives: &[String],
    check: impl FnMut(u64) -> bool,
) -> Result<CodexHistoryLineage> {
    resolve_codex_history_lineage_with_revision(
        store,
        root_archive,
        selected_archives,
        HISTORY_NORMALIZATION_REVISION,
        check,
    )
}

pub fn resolve_codex_history_lineage_with_revision(
    store: &ExternalHistoryStore,
    root_archive: &str,
    selected_archives: &[String],
    revision: &str,
    mut check: impl FnMut(u64) -> bool,
) -> Result<CodexHistoryLineage> {
    ensure!(
        selected_archives.len() < MAX_ARCHIVES,
        "history_lineage_archive_budget_exceeded"
    );
    let owner_scope = store.scope_fingerprint()?;
    let mut sources = Vec::new();
    let mut seen_archives = HashSet::new();
    let mut scope = None::<String>;
    let mut total_bytes = 0u64;
    let mut lookup = HashMap::<Uuid, Vec<usize>>::new();
    let mut scan = Scan { checked: 0 };
    for id in std::iter::once(root_archive).chain(selected_archives.iter().map(String::as_str)) {
        scan.tick(&mut check)?;
        if !seen_archives.insert(id.to_owned()) {
            continue;
        }
        let reader = store.reader(id)?;
        let origin = reader.origin();
        ensure!(
            origin.source == MigrationSourceKind::Codex,
            "history_lineage_source_mismatch"
        );
        ensure!(
            scope
                .as_ref()
                .is_none_or(|scope| scope == &origin.source_instance),
            "history_lineage_source_scope_mismatch"
        );
        scope.get_or_insert_with(|| origin.source_instance.clone());
        let receipt = reader
            .receipt()?
            .context("history_lineage_archive_incomplete")?;
        ensure!(
            receipt.record_count > 0 && receipt.source_bytes <= EXTERNAL_HISTORY_MAX_BYTES,
            "history_lineage_empty_source"
        );
        total_bytes = total_bytes
            .checked_add(receipt.source_bytes)
            .context("history_lineage_byte_budget_exceeded")?;
        total_bytes = total_bytes
            .checked_add(
                receipt
                    .original
                    .as_ref()
                    .map_or(0, |original| original.source.bytes),
            )
            .context("history_lineage_byte_budget_exceeded")?;
        ensure!(
            total_bytes <= MAX_BUNDLE_BYTES,
            "history_lineage_byte_budget_exceeded"
        );
        let rollout_id = origin
            .source_artifact_id
            .as_deref()
            .map(Uuid::parse_str)
            .transpose()
            .map_err(|_| anyhow::anyhow!("history_lineage_invalid_artifact_identity"))?;
        if let Some(id) = rollout_id {
            lookup.entry(id).or_default().push(sources.len());
        }
        sources.push(Source {
            archive_id: id.into(),
            reader,
            receipt,
            rollout_id,
            normalization_revision: revision.into(),
        });
    }
    let mut current = 0usize;
    ensure!(
        projection(&sources[0].reader, revision)?
            .progress()?
            .normalization_complete,
        "history_lineage_normalization_incomplete"
    );
    let mut end = None::<HistoricalCodexBase>;
    let mut seen = HashSet::new();
    let mut segments = Vec::new();
    let mut total_records = 0u64;
    loop {
        scan.tick(&mut check)?;
        ensure!(
            segments.len() < MAX_ARCHIVES,
            "history_lineage_depth_exceeded"
        );
        let source = &sources[current];
        if let Some(id) = source.rollout_id {
            ensure!(seen.insert(id), "history_lineage_cycle");
        }
        let head = header(source)?;
        let (records, prefix_sha256) = range(source, &head, end.as_ref(), &mut scan, &mut check)?;
        total_records += records;
        ensure!(
            total_records <= EXTERNAL_HISTORY_MAX_RECORDS,
            "history_lineage_record_budget_exceeded"
        );
        segments.push(CodexLineageSegment {
            source: current as u32,
            end_record_exclusive: records,
            first_ordinal: head
                .persisted_ordinal
                .and_then(|ordinal| ordinal.checked_add(1))
                .context("history_lineage_ordinal_overflow")?,
            prefix_sha256,
        });
        let Some(base) = head
            .codex
            .as_ref()
            .and_then(|metadata| metadata.history_base.clone())
        else {
            break;
        };
        let id = Uuid::parse_str(&base.rollout_id)
            .map_err(|_| anyhow::anyhow!("history_lineage_invalid_base_identity"))?;
        ensure!(!seen.contains(&id), "history_lineage_cycle");
        let candidates = lookup
            .get(&id)
            .context("history_lineage_missing_selected_base")?;
        let mut chosen = None::<(usize, u64, String)>;
        for at in candidates {
            scan.tick(&mut check)?;
            let candidate = &sources[*at];
            if candidate.receipt.source_bytes < base.end_byte_offset {
                continue;
            }
            let meta = header(candidate)?;
            let (records, signature) = range(candidate, &meta, Some(&base), &mut scan, &mut check)?;
            if let Some((previous, previous_records, previous_signature)) = &chosen {
                ensure!(
                    *previous_records == records && *previous_signature == signature,
                    "history_lineage_ambiguous_prefix"
                );
                if candidate.archive_id >= sources[*previous].archive_id {
                    continue;
                }
            }
            chosen = Some((*at, records, signature));
        }
        current = chosen
            .context("history_lineage_selected_prefix_too_short")?
            .0;
        end = Some(base);
    }
    segments.reverse();
    let mut hash = Sha256::new();
    hash.update(owner_scope.as_bytes());
    hash.update(b"codex-lineage/v1\0");
    hash.update(revision.as_bytes());
    for segment in &segments {
        let source = &sources[segment.source as usize];
        hash.update(source.archive_id.as_bytes());
        hash.update(segment.first_ordinal.to_le_bytes());
        hash.update(segment.end_record_exclusive.to_le_bytes());
        hash.update(segment.prefix_sha256.as_bytes());
    }
    // Stable local handles depend on chosen archives, not candidate enumeration order.
    let mut used = segments
        .iter()
        .map(|segment| segment.source as usize)
        .collect::<Vec<_>>();
    used.retain(|at| *at != 0);
    used.sort_unstable();
    used.dedup();
    used.sort_by(|left, right| sources[*left].archive_id.cmp(&sources[*right].archive_id));
    used.insert(0, 0);
    let remap = used
        .iter()
        .enumerate()
        .map(|(new, old)| (*old, new as u32))
        .collect::<HashMap<_, _>>();
    for segment in &mut segments {
        segment.source = remap[&(segment.source as usize)];
    }
    let mut available = sources.into_iter().map(Some).collect::<Vec<_>>();
    let sources = used
        .into_iter()
        .map(|at| available[at].take().expect("unique source index"))
        .collect();
    ensure!(check(scan.checked), "history_selection_cancelled");
    Ok(CodexHistoryLineage {
        owner_scope,
        sources,
        segments,
        lineage_sha256: format!("{:x}", hash.finalize()),
    })
}

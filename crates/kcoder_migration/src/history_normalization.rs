//! Resumable vendor-record normalization, independent of providers and active sessions.
use crate::history_records::{
    parse_reader, parse_reader_legacy_v3, parse_reader_legacy_v4, parse_reader_legacy_v5,
};
use anyhow::{Context, Result, ensure};
use kcoder_state::external_history::{
    ExternalHistoryReader, ExternalHistoryRecordCursor, projection::HistoricalProjectionStore,
};
use kcoder_types::imported_transcript::{
    HistoricalDiagnostic, HistoricalProjectionProgress, HistoryNormalizationProgress,
};

/// Revision identity changes whenever the normalized source interpretation changes.
pub const LEGACY_HISTORY_NORMALIZATION_REVISION: &str =
    "foreign-records/3;codex/0.163.0;claude/2.1.301";
/// Exact-path /4 records retain their original supplemental event interpretation.
pub const HISTORY_NORMALIZATION_REVISION_V4: &str =
    "foreign-records/4;codex/0.163.0;claude/2.1.301;capture/exact-path/1";
/// New execution facts require a separate projection, never mutation of /3 or /4.
pub const HISTORY_NORMALIZATION_REVISION_V5: &str =
    "foreign-records/5;codex/0.163.0;claude/2.1.301;capture/exact-path/1;execution-events/1";
/// Product versions are provenance; record shapes still determine compatibility.
pub const HISTORY_NORMALIZATION_REVISION: &str =
    "foreign-records/6;capture/exact-path/1;execution-events/1;structural-compatibility/1";
pub(crate) fn supports_execution_events(revision: &str) -> bool {
    matches!(
        revision,
        HISTORY_NORMALIZATION_REVISION_V5 | HISTORY_NORMALIZATION_REVISION
    )
}
pub const HISTORY_REINTERPRETATION_REVISION: &str = HISTORY_NORMALIZATION_REVISION;

pub(crate) fn executable_revision(revision: &str) -> bool {
    matches!(
        revision,
        LEGACY_HISTORY_NORMALIZATION_REVISION
            | HISTORY_NORMALIZATION_REVISION_V4
            | HISTORY_NORMALIZATION_REVISION_V5
            | HISTORY_NORMALIZATION_REVISION
    )
}

pub struct HistoryNormalizer {
    archive: ExternalHistoryReader,
    cursor: ExternalHistoryRecordCursor,
    projection: HistoricalProjectionStore,
}

impl HistoryNormalizer {
    pub fn open(archive: ExternalHistoryReader) -> Result<Self> {
        Self::open_with_revision(archive, HISTORY_NORMALIZATION_REVISION)
    }

    /// Explicit /3 selection reproduces its original capture strategy for known legacy data.
    /// Ordinary persisted /3 jobs may also contain a shipped fixed prefix; HistoryJobStore
    /// therefore forbids appending to their unsealed projections and requires a new current job.
    pub fn open_with_revision(archive: ExternalHistoryReader, revision: &str) -> Result<Self> {
        ensure!(executable_revision(revision), "history_job_adapter_changed");
        let projection = archive
            .projection(revision, true)?
            .context("history_normalization_store_missing")?;
        let cursor = archive.record_cursor()?;
        Ok(Self {
            archive,
            cursor,
            projection,
        })
    }

    pub fn progress(&self) -> Result<HistoricalProjectionProgress> {
        self.projection.progress()
    }

    /// At most ten records are processed per step. Cancellation inside a long record
    /// keeps the last committed cursor; a retry never executes historical tool calls.
    pub fn step(
        &mut self,
        limit: u32,
        mut check: impl FnMut(HistoryNormalizationProgress) -> bool,
    ) -> Result<HistoricalProjectionProgress> {
        ensure!(
            (1..=10).contains(&limit),
            "history_normalization_invalid_limit"
        );
        let mut committed = self.projection.progress()?;
        if committed.normalization_complete {
            return Ok(committed);
        }
        for _ in 0..limit {
            ensure!(
                check(HistoryNormalizationProgress {
                    committed: committed.clone(),
                    current_record: None,
                    current_record_bytes: 0,
                }),
                "history_normalization_cancelled"
            );
            let ordinal = committed.normalized_records;
            if ordinal == committed.source_records {
                return self.projection.finish();
            }
            let origin = self.archive.origin();
            let source = self.cursor.record(ordinal)?;
            let mut parse_check = |bytes| {
                check(HistoryNormalizationProgress {
                    committed: committed.clone(),
                    current_record: Some(ordinal),
                    current_record_bytes: bytes,
                })
            };
            let mut record = match self.projection.adapter_revision() {
                LEGACY_HISTORY_NORMALIZATION_REVISION => {
                    parse_reader_legacy_v3(origin.source, ordinal, source, &mut parse_check)?
                }
                HISTORY_NORMALIZATION_REVISION_V4 => {
                    parse_reader_legacy_v4(origin.source, ordinal, source, &mut parse_check)?
                }
                HISTORY_NORMALIZATION_REVISION_V5 => {
                    parse_reader_legacy_v5(origin.source, ordinal, source, &mut parse_check)?
                }
                _ => parse_reader(origin.source, ordinal, source, &mut parse_check)?,
            };
            match record.source_session_id.as_deref() {
                Some(id) if id != origin.source_session_id => {
                    record.diagnostics.push(HistoricalDiagnostic {
                        code: "source_session_identity_mismatch".into(),
                        blocks_continuation: true,
                    })
                }
                None => record.source_session_id = Some(origin.source_session_id.clone()),
                _ => {}
            }
            ensure!(
                check(HistoryNormalizationProgress {
                    committed: committed.clone(),
                    current_record: Some(ordinal),
                    current_record_bytes: 0,
                }),
                "history_normalization_cancelled"
            );
            committed = self.projection.append(ordinal, &[record])?;
        }
        if committed.normalized_records == committed.source_records {
            committed = self.projection.finish()?;
        }
        Ok(committed)
    }
}

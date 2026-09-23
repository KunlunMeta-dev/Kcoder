use super::*;
use crate::history_metadata::{HistoryTimestampBounds, load_metadata_state};
mod bounded_transcript;
mod projected_transcript;
mod replay;
mod resume_checkpoint;
pub use projected_transcript::ProjectedTranscriptReader;
mod incremental_transcript;
pub use bounded_transcript::{BoundedTranscriptReader, load_transcript_history_bounded};

/// Load history entries from a JSONL file.
pub fn load_history(path: &Path) -> anyhow::Result<Vec<HistoryEntry>> {
    let _span = tracing::debug_span!("history.model_replay").entered();
    let values = read_history_values(path, false)?;
    model_history_from_values(&values, false)
}

fn read_history_values(
    path: &Path,
    strict: bool,
) -> anyhow::Result<Vec<(usize, serde_json::Value)>> {
    let file = fs::File::open(path)?;
    let reader = std::io::BufReader::new(file);
    let mut values = Vec::new();
    for (index, line) in reader.lines().enumerate() {
        let line_number = index + 1;
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str(&line) {
            Ok(value) => values.push((line_number, value)),
            Err(error) if strict => anyhow::bail!(
                "failed to parse history JSON at {}:{}: {}",
                path.display(),
                line_number,
                error
            ),
            Err(error) => warn!("failed to parse history line: {}", error),
        }
    }
    Ok(values)
}

fn model_history_from_values(
    values: &[(usize, serde_json::Value)],
    strict: bool,
) -> anyhow::Result<Vec<HistoryEntry>> {
    let mut entries = Vec::new();
    let mut pending_preserved_segment: Option<Vec<HistoryEntry>> = None;
    for (line_number, value) in values {
        if is_transcript_system_event(value) {
            let subtype = value.get("subtype").and_then(serde_json::Value::as_str);
            if subtype == Some("compact_boundary") {
                if !compact_boundary_declares_preserved_segment(value) {
                    pending_preserved_segment = None;
                    entries.clear();
                } else if let Some(preserved) = preserved_entries_for_boundary(&entries, value) {
                    pending_preserved_segment = Some(preserved);
                    entries.clear();
                } else {
                    warn!(
                        line = line_number,
                        "compact boundary did not reference a valid preserved segment; keeping existing transcript context"
                    );
                    pending_preserved_segment = None;
                }
            } else if subtype == Some("rewind_boundary") {
                apply_rewind_boundary(&mut entries, value, *line_number);
            }
            continue;
        }
        let is_compact_summary = is_compact_summary_record(value);
        match serde_json::from_value(value.clone()) {
            Ok(entry) => {
                if is_compact_summary {
                    entries.push(entry);
                    if let Some(preserved) = pending_preserved_segment.take() {
                        entries.extend(preserved);
                    }
                } else {
                    entries.push(entry);
                }
            }
            Err(error) if strict => anyhow::bail!(
                "failed to parse history message at line {}: {}",
                line_number,
                error
            ),
            Err(error) => warn!("failed to parse history message entry: {}", error),
        }
    }
    Ok(entries)
}

/// Load the append-only user-visible transcript from JSONL.
///
/// Unlike `load_history`, this does not apply compact-boundary model-context
/// reconstruction. It skips system boundary records and hidden compact summary
/// anchors so the TUI can show the original human-visible scrollback.
pub fn load_transcript_history(path: &Path) -> anyhow::Result<Vec<HistoryEntry>> {
    let _span = tracing::debug_span!("history.transcript_replay").entered();
    let values = read_history_values(path, false)?;
    transcript_history_from_values(&values, false)
}

fn transcript_history_from_values(
    values: &[(usize, serde_json::Value)],
    strict: bool,
) -> anyhow::Result<Vec<HistoryEntry>> {
    let mut entries = Vec::new();
    let mut summary_anchors = std::collections::HashMap::new();
    let mut compact_boundary = None;
    for (line_number, value) in values {
        if is_transcript_system_event(value) {
            if value.get("subtype").and_then(serde_json::Value::as_str) == Some("compact_boundary")
            {
                compact_boundary = Some(value);
            }
            if value.get("subtype").and_then(serde_json::Value::as_str) == Some("rewind_boundary") {
                let boundary = visible_rewind_boundary(value, &summary_anchors);
                apply_rewind_boundary(&mut entries, &boundary, *line_number);
            }
            continue;
        }
        if is_compact_summary_record(value) {
            if let Some(uuid) = value.get("uuid").and_then(serde_json::Value::as_str)
                && let Some(anchor) = visible_summary_anchor(
                    compact_boundary,
                    entries
                        .iter()
                        .map(|entry: &HistoryEntry| entry.uuid.as_deref()),
                )
            {
                summary_anchors.insert(uuid.to_owned(), anchor);
            }
            continue;
        }
        match serde_json::from_value(value.clone()) {
            Ok(entry) => entries.push(entry),
            Err(error) if strict => anyhow::bail!(
                "failed to parse transcript message at line {}: {}",
                line_number,
                error
            ),
            Err(error) => warn!("failed to parse history message entry: {}", error),
        }
    }
    Ok(entries)
}

/// Hidden summaries anchor the visible prefix preceding them, not a visible row.
/// Store UUIDs rather than lengths so a removed prefix cannot alias later rows.
fn visible_summary_anchor<'a>(
    boundary: Option<&serde_json::Value>,
    uuids: impl Iterator<Item = Option<&'a str>>,
) -> Option<Option<String>> {
    let head = boundary
        .and_then(|value| value.get("compactMetadata"))
        .and_then(|meta| meta.get("preservedSegment"))
        .and_then(|segment| segment.get("headUuid"))
        .and_then(serde_json::Value::as_str);
    let mut previous = Some(None);
    for uuid in uuids {
        if head.is_some() && uuid == head {
            return previous.map(|uuid: Option<&str>| uuid.map(str::to_owned));
        }
        previous = uuid.map(Some);
    }
    // An unresolved preserved head or UUID-less non-empty prefix is not an empty prefix.
    if head.is_some() {
        None
    } else {
        previous.map(|uuid| uuid.map(str::to_owned))
    }
}

fn visible_rewind_boundary(
    boundary: &serde_json::Value,
    summary_anchors: &std::collections::HashMap<String, Option<String>>,
) -> serde_json::Value {
    let mut visible = boundary.clone();
    if let Some(anchor) = boundary
        .get("rewindMetadata")
        .and_then(|meta| meta.get("anchorUuid"))
        .and_then(serde_json::Value::as_str)
        .and_then(|uuid| summary_anchors.get(uuid))
    {
        visible["rewindMetadata"]["anchorUuid"] = serde_json::json!(anchor);
    }
    visible
}

#[cfg(test)]
mod visible_rewind_tests {
    use super::*;

    #[tokio::test]
    async fn counted_replay_ignores_summaries_and_preserves_unknown_anchor() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let state = AppState::new(temp.path());
        state.with_history_path(&path);
        state.add_message(Message::user_text("first"));
        state
            .set_messages_after_compaction(
                vec![Message::user_text("Earlier conversation summary: hidden")],
                CompactionTranscriptEvent {
                    trigger: CompactionTrigger::Manual,
                    pre_tokens: 100,
                    post_tokens: 10,
                    summary: "hidden".into(),
                },
            )
            .await
            .unwrap();
        state.add_message(Message::user_text("second"));
        state.flush_history().await.unwrap();
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type":"system","subtype":"rewind_boundary",
            "rewindMetadata":{"anchorUuid":"unknown"}})
        )
        .unwrap();
        let visited = std::cell::Cell::new(0);
        let (prepared, count) = prepare_session_resume_counting(&path, |message| {
            assert!(
                !message
                    .preview(100)
                    .contains("Earlier conversation summary")
            );
            visited.set(visited.get() + 1);
            true
        })
        .unwrap();
        assert_eq!(visited.get(), 2);
        assert_eq!(count, prepared.transcript_len());
        assert_eq!(count, 2);
        assert_eq!(
            prepared.load_transcript_messages().unwrap(),
            prepare_session_resume(&path)
                .unwrap()
                .load_transcript_messages()
                .unwrap()
        );
    }

    #[tokio::test]
    async fn hidden_summary_rewind_aligns_visible_and_prepared_prefixes() {
        for preserve_tail in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("history.jsonl");
            let state = AppState::new(temp.path());
            state.with_history_path(&path);
            state.add_message(Message::user_text("old user"));
            state.add_message(Message::assistant_text("old answer"));
            let tail = vec![
                Message::user_text("recent user"),
                Message::assistant_text("recent answer"),
            ];
            for message in &tail {
                state.add_message(message.clone());
            }
            let mut compacted = vec![Message::user_text(
                "Earlier conversation summary: compacted",
            )];
            if preserve_tail {
                compacted.extend(tail);
            }
            state
                .set_messages_after_compaction(
                    compacted,
                    CompactionTranscriptEvent {
                        trigger: CompactionTrigger::Manual,
                        pre_tokens: 100,
                        post_tokens: 10,
                        summary: "compacted".into(),
                    },
                )
                .await
                .unwrap();
            state.add_message(Message::user_text("after compaction"));
            assert!(
                state
                    .truncate_messages_for_rewind(1, 1)
                    .await
                    .unwrap()
                    .boundary_recorded
            );
            let expected = if preserve_tail {
                vec!["old user", "old answer"]
            } else {
                vec!["old user", "old answer", "recent user", "recent answer"]
            };
            let visible: Vec<_> = load_transcript_history(&path)
                .unwrap()
                .iter()
                .map(|entry| entry.message.preview(100))
                .collect();
            assert_eq!(visible, expected, "preserve_tail={preserve_tail}");
            let prepared: Vec<_> = prepare_session_resume(&path)
                .unwrap()
                .load_transcript_messages()
                .unwrap()
                .iter()
                .map(|message| message.preview(100))
                .collect();
            assert_eq!(prepared, visible);
            assert_eq!(load_history(&path).unwrap().len(), 1);
        }
    }

    #[test]
    fn hidden_summary_unknown_head_and_uuidless_prefix_do_not_alias_empty_history() {
        let boundary =
            serde_json::json!({"compactMetadata":{"preservedSegment":{"headUuid":"head"}}});
        assert_eq!(
            visible_summary_anchor(Some(&boundary), [Some("other")].into_iter()),
            None
        );
        assert_eq!(visible_summary_anchor(None, [None].into_iter()), None);
        assert_eq!(
            visible_summary_anchor(Some(&boundary), [Some("head")].into_iter()),
            Some(None)
        );
        assert_eq!(visible_summary_anchor(None, std::iter::empty()), Some(None));
    }
}

/// Apply a rewind boundary during transcript replay: drop every entry after
/// the anchored message (`None` anchor discards the whole pre-boundary
/// transcript). A missing anchor means the boundary cannot be honored
/// reliably, so the existing context is kept.
fn apply_rewind_boundary(
    entries: &mut Vec<HistoryEntry>,
    boundary: &serde_json::Value,
    line_number: usize,
) {
    let anchor = boundary
        .get("rewindMetadata")
        .and_then(|meta| meta.get("anchorUuid"))
        .and_then(serde_json::Value::as_str);
    match anchor {
        Some(anchor) => {
            if let Some(position) = entries
                .iter()
                .rposition(|entry| entry.uuid.as_deref() == Some(anchor))
            {
                entries.truncate(position + 1);
            } else {
                warn!(
                    line = line_number,
                    "rewind boundary anchor not found; keeping existing transcript context"
                );
            }
        }
        None => entries.clear(),
    }
}

fn preserved_entries_for_boundary(
    entries: &[HistoryEntry],
    boundary: &serde_json::Value,
) -> Option<Vec<HistoryEntry>> {
    let segment = boundary.get("compactMetadata")?.get("preservedSegment")?;
    let head_uuid = segment.get("headUuid")?.as_str()?;
    let tail_uuid = segment.get("tailUuid")?.as_str()?;
    let start = entries
        .iter()
        .position(|entry| entry.uuid.as_deref() == Some(head_uuid))?;
    let end = entries
        .iter()
        .position(|entry| entry.uuid.as_deref() == Some(tail_uuid))?;
    if start > end {
        return None;
    }
    Some(entries[start..=end].to_vec())
}

fn compact_boundary_declares_preserved_segment(boundary: &serde_json::Value) -> bool {
    let Some(segment) = boundary
        .get("compactMetadata")
        .and_then(|metadata| metadata.get("preservedSegment"))
    else {
        return false;
    };
    segment.get("headUuid").is_some() || segment.get("tailUuid").is_some()
}

fn is_compact_summary_record(value: &serde_json::Value) -> bool {
    value
        .get("isCompactSummary")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn is_transcript_system_event(value: &serde_json::Value) -> bool {
    value.get("type").and_then(serde_json::Value::as_str) == Some("system")
        || value.get("subtype").and_then(serde_json::Value::as_str) == Some("compact_boundary")
}

/// Extract a human-readable preview of a session: the first real user prompt.
///
/// Only the head of the history file is read, so this stays cheap even for
/// large sessions. Compact-boundary/system records, tool results, and internal
/// nudges are skipped; the text is single-lined and truncated to `max_chars`.
pub fn session_first_prompt(path: &Path, max_chars: usize) -> Option<String> {
    const HEAD_BYTES: usize = 64 * 1024;
    let file = fs::File::open(path).ok()?;
    let mut head = vec![0u8; HEAD_BYTES];
    let read = std::io::Read::read(&mut &file, &mut head).ok()?;
    head.truncate(read);
    first_prompt_from_head(&head, max_chars)
}

pub(crate) fn first_prompt_from_head(head: &[u8], max_chars: usize) -> Option<String> {
    let text = String::from_utf8_lossy(head);
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("role").and_then(serde_json::Value::as_str) != Some("user") {
            continue;
        }
        if is_transcript_system_event(&value) {
            continue;
        }
        let blocks = value.get("content").and_then(serde_json::Value::as_array)?;
        let mut parts = Vec::new();
        let mut only_tool_results = !blocks.is_empty();
        for block in blocks {
            match block.get("type").and_then(serde_json::Value::as_str) {
                Some("text") => {
                    only_tool_results = false;
                    if let Some(text) = block.get("text").and_then(serde_json::Value::as_str) {
                        parts.push(text);
                    }
                }
                Some("tool_result") => {}
                _ => only_tool_results = false,
            }
        }
        if only_tool_results || parts.is_empty() {
            continue;
        }
        let joined = parts.join(" ");
        let single_line = joined.split_whitespace().collect::<Vec<_>>().join(" ");
        if single_line.is_empty() {
            continue;
        }
        let mut preview: String = single_line.chars().take(max_chars).collect();
        if single_line.chars().count() > max_chars {
            preview.push('…');
        }
        return Some(preview);
    }
    None
}

/// Return the millisecond timestamp of the first timestamped record in session history.
///
/// Read only the file head so thread/list can recover a stable creation time. Do not
/// use history-file mtime because each appended message changes it and would make a
/// refreshed session look newly created.
pub fn session_first_timestamp_ms(path: &Path) -> Option<u64> {
    const HEAD_BYTES: usize = 64 * 1024;
    let file = fs::File::open(path).ok()?;
    let mut head = vec![0u8; HEAD_BYTES];
    let read = std::io::Read::read(&mut &file, &mut head).ok()?;
    head.truncate(read);
    let text = String::from_utf8_lossy(&head);
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let timestamp = value
            .get("timestamp_ms")
            .or_else(|| value.get("timestampMs"));
        if let Some(timestamp) = timestamp {
            if let Some(timestamp) = timestamp.as_u64() {
                return Some(timestamp);
            }
            if let Some(timestamp) = timestamp.as_str().and_then(|value| value.parse().ok()) {
                return Some(timestamp);
            }
        }
    }
    None
}

/// Recover timestamps from session content, never from the time of a read or resume.
pub fn session_timestamps_ms(path: &Path) -> anyhow::Result<(u64, u64)> {
    crate::prepare_session_metadata(path)?.timestamps_ms()
}

/// List recent session history files, newest first.
///
/// Returns tuples of `(session_id, path, message_count)` for each `.jsonl`
/// file found in `history_dir`.
pub fn recent_sessions(
    history_dir: &Path,
    limit: usize,
) -> anyhow::Result<Vec<(String, PathBuf, usize)>> {
    recent_sessions_with_message_count(history_dir, limit, |path| {
        load_history(path).map(|entries| entries.len())
    })
}

/// Read directory-entry metadata only and list candidate sessions without parsing JSONL content.
///
/// The multi-project session picker merges and sorts candidates first, then computes message counts only for records that may be displayed.
pub fn recent_session_candidates(
    history_dir: &Path,
) -> anyhow::Result<Vec<(String, PathBuf, std::time::SystemTime)>> {
    if !history_dir.is_dir() {
        return Ok(Vec::new());
    }
    Ok(scan_session_candidates(history_dir, false)?.candidates)
}

/// Candidate discovery with aggregate uncertainty, never a proof that omitted sessions were deleted.
#[derive(Default)]
pub struct SessionCandidateScan {
    pub candidates: Vec<(String, PathBuf, std::time::SystemTime)>,
    pub issue_count: u64,
    /// Bounded per-entry failure details so callers can surface WHY entries
    /// were counted as issues instead of an opaque total.
    pub issues: Vec<SessionScanIssue>,
}

/// One skipped history entry and why it failed validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionScanIssue {
    pub name: String,
    pub reason: String,
}

/// Upper bound on collected per-entry issue details; the count stays exact.
pub const MAX_SESSION_SCAN_ISSUE_DETAILS: usize = 20;

/// Incremental discovery only; callers must establish baseline completeness and source freshness.
/// Directory order is unspecified. Final list ordering belongs to the published catalog.
pub struct SessionCandidateScanner {
    entries: Option<fs::ReadDir>,
}

pub struct SessionCandidateBatch {
    pub scan: SessionCandidateScan,
    pub examined_entries: usize,
    pub complete: bool,
}

impl SessionCandidateScanner {
    /// Missing directories are empty; other directory errors remain errors. Never creates files.
    pub fn open(history_dir: &Path) -> anyhow::Result<Self> {
        let entries = match fs::read_dir(history_dir) {
            Ok(entries) => Some(entries),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        Ok(Self { entries })
    }

    /// Bound raw directory entries, including skipped files and failures, not just valid sessions.
    pub fn next_batch(&mut self, maximum_entries: usize) -> anyhow::Result<SessionCandidateBatch> {
        anyhow::ensure!(
            (1..=4096).contains(&maximum_entries),
            "invalid candidate batch budget"
        );
        let mut batch = SessionCandidateBatch {
            scan: SessionCandidateScan::default(),
            examined_entries: 0,
            complete: self.entries.is_none(),
        };
        if let Some(entries) = self.entries.as_mut() {
            for _ in 0..maximum_entries {
                let Some(entry) = entries.next() else {
                    batch.complete = true;
                    break;
                };
                batch.examined_entries += 1;
                let name = entry
                    .as_ref()
                    .ok()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned());
                match read_session_candidate(entry) {
                    Ok(Some(candidate)) => batch.scan.candidates.push(candidate),
                    Ok(None) => {}
                    Err(error) => {
                        batch.scan.issue_count = batch.scan.issue_count.saturating_add(1);
                        if batch.scan.issues.len() < MAX_SESSION_SCAN_ISSUE_DETAILS {
                            batch.scan.issues.push(SessionScanIssue {
                                name: name.unwrap_or_default(),
                                reason: error.to_string(),
                            });
                        }
                    }
                }
            }
        }
        if batch.complete {
            self.entries = None;
        }
        Ok(batch)
    }
}

fn read_session_candidate(
    entry: std::io::Result<fs::DirEntry>,
) -> anyhow::Result<Option<(String, PathBuf, std::time::SystemTime)>> {
    let entry = entry?;
    let path = entry.path();
    if !is_primary_session_history_path(&path) {
        return Ok(None);
    }
    match crate::history_store::validate_live_source(&path) {
        Ok(()) => {}
        Err(error) if crate::history_store::is_deleted_source(&error) => return Ok(None),
        Err(error) => return Err(error),
    }
    let session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let mtime = entry
        .metadata()?
        .modified()
        .unwrap_or(std::time::UNIX_EPOCH);
    Ok(Some((session_id, path, mtime)))
}

/// Continue past per-entry failures while preserving directory-wide failures as errors.
pub fn recent_session_candidates_report(
    history_dir: &Path,
) -> anyhow::Result<SessionCandidateScan> {
    match fs::metadata(history_dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SessionCandidateScan::default());
        }
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    scan_session_candidates(history_dir, true)
}

fn scan_session_candidates(
    history_dir: &Path,
    allow_partial: bool,
) -> anyhow::Result<SessionCandidateScan> {
    let mut report = SessionCandidateScan::default();
    for entry in fs::read_dir(history_dir)? {
        let name = entry
            .as_ref()
            .ok()
            .map(|entry| entry.file_name().to_string_lossy().into_owned());
        let candidate = read_session_candidate(entry);
        match candidate {
            Ok(Some(candidate)) => report.candidates.push(candidate),
            Ok(None) => {}
            Err(error) if allow_partial => {
                report.issue_count = report.issue_count.saturating_add(1);
                if report.issues.len() < MAX_SESSION_SCAN_ISSUE_DETAILS {
                    report.issues.push(SessionScanIssue {
                        name: name.unwrap_or_default(),
                        reason: error.to_string(),
                    });
                }
            }
            Err(error) => return Err(error),
        }
    }
    report
        .candidates
        .sort_by_key(|candidate| std::cmp::Reverse(candidate.2));
    Ok(report)
}

#[cfg(test)]
mod partial_candidate_tests {
    use super::*;

    #[test]
    fn bounded_candidates_count_ignored_entries_and_preserve_complete_results() {
        let temp = tempfile::tempdir().unwrap();
        for index in 0..20 {
            let extension = if index < 3 { "jsonl" } else { "txt" };
            fs::write(temp.path().join(format!("{index}.{extension}")), b"{}\n").unwrap();
        }
        let mut scanner = SessionCandidateScanner::open(temp.path()).unwrap();
        assert!(scanner.next_batch(0).is_err());
        assert!(scanner.next_batch(4097).is_err());
        let mut examined = 0;
        let mut ids = std::collections::BTreeSet::new();
        loop {
            let batch = scanner.next_batch(2).unwrap();
            assert!(
                batch.examined_entries <= 2,
                "examined {} entries",
                batch.examined_entries
            );
            examined += batch.examined_entries;
            assert_eq!(batch.scan.issue_count, 0);
            for (id, _, _) in batch.scan.candidates {
                assert!(ids.insert(id));
            }
            if batch.complete {
                break;
            }
        }
        assert_eq!(examined, 20);
        assert_eq!(ids, ["0", "1", "2"].into_iter().map(String::from).collect());
        let exhausted = scanner.next_batch(2).unwrap();
        assert!(exhausted.complete);
        assert_eq!(exhausted.examined_entries, 0);
    }

    #[test]
    fn bounded_candidates_match_legacy_uncertainty_and_directory_errors() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("healthy.jsonl"), b"{}\n").unwrap();
        let corrupt = temp.path().join("corrupt.jsonl");
        fs::write(&corrupt, b"{}\n").unwrap();
        fs::create_dir(corrupt.with_extension("hctl")).unwrap();
        fs::write(
            corrupt.with_extension("hctl").join("source.json"),
            b"broken",
        )
        .unwrap();
        let deleted = temp.path().join("deleted.jsonl");
        crate::history_store::HistorySource::bind(&deleted)
            .unwrap()
            .append(b"{}\n")
            .unwrap();
        crate::history_store::delete_records(&deleted).unwrap();
        fs::write(&deleted, b"{}\n").unwrap();
        let oracle = recent_session_candidates_report(temp.path()).unwrap();
        let mut scanner = SessionCandidateScanner::open(temp.path()).unwrap();
        let mut ids = std::collections::BTreeSet::new();
        let mut issues = 0;
        loop {
            let batch = scanner.next_batch(1).unwrap();
            assert!(batch.examined_entries <= 1);
            issues += batch.scan.issue_count;
            ids.extend(batch.scan.candidates.into_iter().map(|c| c.0));
            if batch.complete {
                break;
            }
        }
        assert_eq!(issues, oracle.issue_count);
        assert_eq!(issues, 1);
        assert_eq!(ids, oracle.candidates.into_iter().map(|c| c.0).collect());
        assert!(SessionCandidateScanner::open(&corrupt).is_err());
        let missing = temp.path().join("missing");
        let mut empty = SessionCandidateScanner::open(&missing).unwrap();
        assert!(empty.next_batch(1).unwrap().complete);
        assert!(!missing.exists());
    }

    #[test]
    fn partial_candidates_keep_healthy_sources_but_strict_api_rejects_corruption() {
        let temp = tempfile::tempdir().unwrap();
        let healthy = temp.path().join("healthy.jsonl");
        crate::history_store::HistorySource::bind(&healthy)
            .unwrap()
            .append(b"{}\n")
            .unwrap();
        let corrupt = temp.path().join("unknown-private-id.jsonl");
        fs::write(&corrupt, b"{}\n").unwrap();
        fs::create_dir(corrupt.with_extension("hctl")).unwrap();
        fs::write(
            corrupt.with_extension("hctl").join("source.json"),
            b"{broken",
        )
        .unwrap();
        let report = recent_session_candidates_report(temp.path()).unwrap();
        assert_eq!(report.issue_count, 1);
        assert_eq!(report.candidates.len(), 1);
        assert_eq!(report.candidates[0].0, "healthy");
        assert!(recent_session_candidates(temp.path()).is_err());
    }

    #[test]
    fn partial_candidates_deleted_residue_is_confirmed_exclusion() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("deleted.jsonl");
        crate::history_store::HistorySource::bind(&path)
            .unwrap()
            .append(b"{}\n")
            .unwrap();
        crate::history_store::delete_records(&path).unwrap();
        fs::write(&path, b"{}\n").unwrap();
        let report = recent_session_candidates_report(temp.path()).unwrap();
        assert!(report.candidates.is_empty());
        assert_eq!(report.issue_count, 0);
        assert!(recent_session_candidates(temp.path()).unwrap().is_empty());
    }

    #[test]
    fn partial_candidates_directory_failure_stays_an_error() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("not-directory");
        fs::write(&path, b"file").unwrap();
        assert!(recent_session_candidates_report(&path).is_err());
        let absent = recent_session_candidates_report(&temp.path().join("absent")).unwrap();
        assert!(absent.candidates.is_empty());
        assert_eq!(absent.issue_count, 0);
    }
}

pub(super) fn recent_sessions_with_message_count(
    history_dir: &Path,
    limit: usize,
    mut message_count: impl FnMut(&Path) -> anyhow::Result<usize>,
) -> anyhow::Result<Vec<(String, PathBuf, usize)>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let candidates = recent_session_candidates(history_dir)?;

    let mut sessions = Vec::with_capacity(limit.min(candidates.len()));
    for (session_id, path, _) in candidates {
        let count = match message_count(&path) {
            Ok(count) => count,
            Err(e) => {
                warn!("failed to read session history {:?}: {}", path, e);
                continue;
            }
        };
        if count == 0 {
            continue;
        }
        sessions.push((session_id, path, count));
        if sessions.len() == limit {
            break;
        }
    }
    Ok(sessions)
}

/// Delete older persisted session history files, keeping the newest
/// `keep_latest` `.jsonl` sessions by modification time.
///
/// Each pruned session also removes its session artifact directory and legacy
/// `.state.json` sidecar if present.
pub fn prune_session_history(
    history_dir: &Path,
    keep_latest: usize,
) -> anyhow::Result<PruneSessionHistoryReport> {
    if !history_dir.is_dir() {
        return Ok(PruneSessionHistoryReport {
            kept_sessions: 0,
            deleted_sessions: 0,
            deleted_files: Vec::new(),
        });
    }

    let mut sessions: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    for entry in fs::read_dir(history_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !is_primary_session_history_path(&path) {
            continue;
        }
        let mtime = entry
            .metadata()?
            .modified()
            .unwrap_or(std::time::UNIX_EPOCH);
        sessions.push((path, mtime));
    }
    sessions.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));

    let mut kept_sessions = sessions.len().min(keep_latest);
    let mut deleted_files = Vec::new();
    let mut deleted_sessions = 0usize;

    for (history_path, _) in sessions.into_iter().skip(keep_latest) {
        let lease_path = history_path.with_extension("lease");
        let lease = open_prune_session_lease(&lease_path)?;
        match lease.try_lock_exclusive() {
            Ok(()) => {}
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error().is_some_and(|code| {
                        Some(code) == fs2::lock_contended_error().raw_os_error()
                    }) =>
            {
                kept_sessions += 1;
                continue;
            }
            Err(error) => return Err(error.into()),
        }
        let session_id = history_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(ToOwned::to_owned);
        if crate::history_store::delete_records(&history_path)? {
            deleted_files.push(history_path.clone());
            deleted_sessions += 1;
        }

        if let (Some(project_dir), Some(session_id)) =
            (history_path.parent(), session_id.as_deref())
        {
            let session_dir = session_dir_path(project_dir, session_id);
            if session_dir.exists() {
                remove_history_dir(&session_dir, &mut deleted_files)?;
            }
        }

        // Legacy sidecar path used before per-session directories.
        let state_path = session_state_path_for_history(&history_path);
        if state_path.exists() {
            remove_history_file(&state_path, &mut deleted_files)?;
        }

        let exit_diagnostic_path = exit_diagnostic_path_for_history(&history_path);
        if exit_diagnostic_path.exists() {
            remove_history_file(&exit_diagnostic_path, &mut deleted_files)?;
        }
        // Keep the lock file identity stable for handles already opened by another process.
        drop(lease);
    }

    Ok(PruneSessionHistoryReport {
        kept_sessions,
        deleted_sessions,
        deleted_files,
    })
}

fn open_prune_session_lease(path: &Path) -> anyhow::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .with_context(|| format!("failed to open session prune lease {}", path.display()))?;
    let metadata = file.metadata()?;
    anyhow::ensure!(
        metadata.is_file(),
        "session prune lease is not a regular file: {}",
        path.display()
    );
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        anyhow::ensure!(
            metadata.file_attributes()
                & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                == 0,
            "session prune lease is a reparse point: {}",
            path.display(),
        );
    }
    Ok(file)
}

/// Delete one persisted session after the caller has acquired its exclusive lease.
/// The lease file must remain in place after unlocking to preserve its stable lock identity.
pub fn delete_session_history_files(history_path: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let metadata = match fs::symlink_metadata(history_path) {
        Ok(metadata) => Some(metadata),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && crate::history_store::has_source_record(history_path)? =>
        {
            None
        }
        Err(error) => {
            return Err(error).with_context(|| {
                format!("persisted thread not found: {}", history_path.display())
            });
        }
    };
    if metadata
        .as_ref()
        .is_some_and(|metadata| !metadata.file_type().is_file())
        || !is_primary_session_history_path(history_path)
    {
        anyhow::bail!(
            "persisted thread is not a primary history file: {}",
            history_path.display()
        )
    }
    let session_id = session_id_from_history_path(history_path)?;
    let mut deleted_files = Vec::new();
    if crate::history_store::delete_records(history_path)? {
        deleted_files.push(history_path.to_path_buf());
    }
    if let Some(project_dir) = history_path.parent() {
        let session_dir = session_dir_path(project_dir, &session_id);
        if session_dir.exists() {
            remove_history_dir(&session_dir, &mut deleted_files)?;
        }
    }
    let legacy_state_path = session_state_path_for_history(history_path);
    if legacy_state_path.exists() {
        remove_history_file(&legacy_state_path, &mut deleted_files)?;
    }
    let exit_diagnostic_path = exit_diagnostic_path_for_history(history_path);
    if exit_diagnostic_path.exists() {
        remove_history_file(&exit_diagnostic_path, &mut deleted_files)?;
    }
    Ok(deleted_files)
}

/// Whether a persisted session state records the working directory needed for
/// safe cross-project resume.
pub fn history_has_persisted_session_cwd(history_path: &Path) -> anyhow::Result<bool> {
    let session_id = session_id_from_history_path(history_path)?;
    let state_path = history_path
        .parent()
        .map(|project_dir| session_state_path(project_dir, &session_id))
        .unwrap_or_else(|| session_state_path_for_history(history_path));
    let legacy_state_path = session_state_path_for_history(history_path);
    let state = if state_path.exists() || !legacy_state_path.exists() {
        load_session_state(&state_path)?
    } else {
        load_session_state(&legacy_state_path)?
    };
    Ok(state.cwd.is_some() || state.base_cwd.is_some())
}

/// Return the directory the engine was created for when this session began.
/// Callers use this to reject a cross-project resume before mutating live
/// state; cwd-bound registries and sandbox policy cannot be safely swapped by
/// replacing only [`AppState`].
pub fn history_persisted_base_cwd(history_path: &Path) -> anyhow::Result<Option<PathBuf>> {
    let session_id = session_id_from_history_path(history_path)?;
    let state_path = history_path
        .parent()
        .map(|project_dir| session_state_path(project_dir, &session_id))
        .unwrap_or_else(|| session_state_path_for_history(history_path));
    let legacy_state_path = session_state_path_for_history(history_path);
    let state = if state_path.exists() || !legacy_state_path.exists() {
        load_session_state(&state_path)?
    } else {
        load_session_state(&legacy_state_path)?
    };
    Ok(state.base_cwd.or(state.cwd))
}

/// Read the goal sidecar for a persisted session without acquiring ownership of the session.
///
/// This is intentionally immutable: gateway clients may inspect the same thread while another
/// app-server still owns its execution lease.
pub fn history_persisted_goal(history_path: &Path) -> anyhow::Result<Option<Goal>> {
    let session_id = session_id_from_history_path(history_path)?;
    let state_path = history_path
        .parent()
        .map(|project_dir| session_state_path(project_dir, &session_id))
        .unwrap_or_else(|| session_state_path_for_history(history_path));
    let legacy_state_path = session_state_path_for_history(history_path);
    let state = if state_path.exists() || !legacy_state_path.exists() {
        load_session_state(&state_path)?
    } else {
        load_session_state(&legacy_state_path)?
    };
    Ok(state.goal)
}

/// Read session mode without resuming a conversation or running its hooks.
pub fn history_persisted_session_mode(history_path: &Path) -> anyhow::Result<crate::SessionMode> {
    let session_id = session_id_from_history_path(history_path)?;
    let path = history_path
        .parent()
        .map(|directory| session_state_path(directory, &session_id))
        .unwrap_or_else(|| session_state_path_for_history(history_path));
    let legacy = session_state_path_for_history(history_path);
    let state = load_session_state(if path.exists() || !legacy.exists() {
        &path
    } else {
        &legacy
    })?;
    Ok(state.session_mode)
}

/// Read terminal goal history for a persisted session without acquiring its lease.
pub fn history_persisted_goal_history(history_path: &Path) -> anyhow::Result<Vec<Goal>> {
    let session_id = session_id_from_history_path(history_path)?;
    let state_path = history_path
        .parent()
        .map(|project_dir| session_state_path(project_dir, &session_id))
        .unwrap_or_else(|| session_state_path_for_history(history_path));
    let legacy_state_path = session_state_path_for_history(history_path);
    let state = if state_path.exists() || !legacy_state_path.exists() {
        load_session_state(&state_path)?
    } else {
        load_session_state(&legacy_state_path)?
    };
    Ok(state.goal_history)
}

struct PreparedHistoryReplay {
    entries: Vec<HistoryEntry>,
    transcript_history: PreparedTranscriptHistory,
    last_transcript_uuid: Option<String>,
    timestamps: HistoryTimestampBounds,
}

/// Rebuild model context and the visible-transcript offset index in one scan.
///
/// A former implementation cached every `serde_json::Value`, then cloned and
/// deserialized twice for model and TUI history. Long-session recovery therefore
/// consumed duplicate memory proportional to JSONL size.
fn prepare_history_replay(
    path: &Path,
    matches: Option<&dyn Fn(&Message) -> bool>,
) -> anyhow::Result<PreparedHistoryReplay> {
    let file = fs::File::open(path)?;
    let state =
        replay::ReplayState::default().read(path, std::io::BufReader::new(file), matches, None)?;
    Ok(state.finish(path))
}
fn apply_rewind_boundary_to_transcript_records(
    records: &mut Vec<TranscriptRecordRef>,
    boundary: &serde_json::Value,
    line_number: usize,
) {
    let anchor = boundary
        .get("rewindMetadata")
        .and_then(|meta| meta.get("anchorUuid"))
        .and_then(serde_json::Value::as_str);
    match anchor {
        Some(anchor) => {
            if let Some(position) = records
                .iter()
                .rposition(|record| record.uuid.as_deref() == Some(anchor))
            {
                records.truncate(position + 1);
            } else {
                warn!(
                    line = line_number,
                    "rewind boundary anchor not found; keeping existing transcript context"
                );
            }
        }
        None => records.clear(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TranscriptRecordRef {
    offset: u64,
    line_number: usize,
    uuid: Option<String>,
    matching_prefix: usize,
}

/// Visible-session index after boundary replay completes.
///
/// Recovery preflight retains only JSONL offsets instead of copying all visible
/// messages. The TUI can read the tail first and load full content only when the user reviews older records.
#[derive(Debug)]
pub struct PreparedTranscriptHistory {
    path: PathBuf,
    records: Vec<TranscriptRecordRef>,
}

impl PreparedTranscriptHistory {
    fn empty() -> Self {
        Self {
            path: PathBuf::new(),
            records: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn load_all(&self) -> anyhow::Result<Vec<Message>> {
        self.load_range(0..self.records.len())
    }

    /// Read the visible history tail and return its starting index in the complete record plus its messages.
    pub fn load_tail(&self, max_messages: usize) -> anyhow::Result<(usize, Vec<Message>)> {
        let start = self.records.len().saturating_sub(max_messages);
        Ok((start, self.load_range(start..self.records.len())?))
    }

    pub fn load_range(&self, range: std::ops::Range<usize>) -> anyhow::Result<Vec<Message>> {
        anyhow::ensure!(
            range.start <= range.end && range.end <= self.records.len(),
            "transcript range {:?} exceeds {} indexed records",
            range,
            self.records.len()
        );
        if range.is_empty() {
            return Ok(Vec::new());
        }

        let file = fs::File::open(&self.path)
            .with_context(|| format!("failed to reopen history {}", self.path.display()))?;
        let mut reader = std::io::BufReader::new(file);
        let mut messages = Vec::with_capacity(range.len());
        let records = &self.records[range];
        let mut offset = records[0].offset;
        std::io::Seek::seek(&mut reader, std::io::SeekFrom::Start(offset))?;
        let mut line = String::new();
        for record in records {
            while offset < record.offset {
                line.clear();
                let bytes = std::io::BufRead::read_line(&mut reader, &mut line)?;
                anyhow::ensure!(
                    bytes > 0,
                    "history {} ended before indexed line {}",
                    self.path.display(),
                    record.line_number
                );
                offset = offset.saturating_add(bytes as u64);
            }
            anyhow::ensure!(
                offset == record.offset,
                "history {} changed after resume preflight before line {}",
                self.path.display(),
                record.line_number
            );
            line.clear();
            let bytes = std::io::BufRead::read_line(&mut reader, &mut line)?;
            anyhow::ensure!(
                bytes > 0,
                "history {} ended before indexed line {}",
                self.path.display(),
                record.line_number
            );
            offset = offset.saturating_add(bytes as u64);
            let entry: HistoryEntry = serde_json::from_str(&line).with_context(|| {
                format!(
                    "failed to parse indexed history message at {}:{}",
                    self.path.display(),
                    record.line_number
                )
            })?;
            anyhow::ensure!(
                entry.uuid == record.uuid,
                "history {} changed after resume preflight at line {}",
                self.path.display(),
                record.line_number
            );
            messages.push(entry.message);
        }
        Ok(messages)
    }
}

/// Fully parsed, immutable input for a session replacement. Preparing this
/// value performs every fallible history/sidecar read before the caller stops
/// work owned by the current session.
#[derive(Debug)]
pub struct PreparedSessionResume {
    pub(super) session_id: String,
    pub(super) path: PathBuf,
    pub(super) source_stamp: crate::history_store::SourceStamp,
    pub(super) messages: Vec<Message>,
    pub(super) message_history_ids: Vec<Option<String>>,
    pub(super) last_assistant_message_timestamp_ms: Option<u64>,
    pub(super) transcript_history: PreparedTranscriptHistory,
    pub(super) last_transcript_uuid: Option<String>,
    pub(super) persisted_state: PersistedSessionState,
}

impl PreparedSessionResume {
    pub fn persisted_base_cwd(&self) -> Option<&Path> {
        self.persisted_state
            .base_cwd
            .as_deref()
            .or(self.persisted_state.cwd.as_deref())
    }

    pub fn has_persisted_cwd(&self) -> bool {
        self.persisted_state.cwd.is_some() || self.persisted_state.base_cwd.is_some()
    }

    pub fn transcript_len(&self) -> usize {
        self.transcript_history.len()
    }

    pub fn load_transcript_messages(&self) -> anyhow::Result<Vec<Message>> {
        self.transcript_history.load_all()
    }

    pub fn take_transcript_history(&mut self) -> PreparedTranscriptHistory {
        std::mem::replace(
            &mut self.transcript_history,
            PreparedTranscriptHistory::empty(),
        )
    }
}

pub fn prepare_session_resume(path: &Path) -> anyhow::Result<PreparedSessionResume> {
    prepare_session_resume_inner(path, None, false).map(|(prepared, _)| prepared)
}

fn prepare_session_resume_inner(
    path: &Path,
    matches: Option<&dyn Fn(&Message) -> bool>,
    use_checkpoint: bool,
) -> anyhow::Result<(PreparedSessionResume, usize)> {
    let source_stamp = crate::history_store::prepare_source_stamp(path)?;
    let session_id = session_id_from_history_path(path)?;
    let PreparedHistoryReplay {
        entries,
        transcript_history,
        last_transcript_uuid,
        timestamps,
    } = if use_checkpoint {
        match resume_checkpoint::replay(path, &source_stamp) {
            Ok(replay) => replay,
            Err(error) => {
                tracing::debug!(%error, "resume checkpoint unavailable; replaying authoritative history");
                prepare_history_replay(path, matches)?
            }
        }
    } else {
        prepare_history_replay(path, matches)?
    };
    let matching_count = transcript_history
        .records
        .last()
        .map_or(0, |record| record.matching_prefix);
    let message_history_ids = entries.iter().map(|entry| entry.uuid.clone()).collect();
    let last_assistant_message_timestamp_ms = entries.iter().rev().find_map(|entry| {
        matches!(entry.message, Message::Assistant { .. }).then_some(entry.timestamp_ms)
    });
    let mut persisted_state = load_metadata_state(path)?;
    let (created_at_ms, updated_at_ms) = timestamps.resolve(
        path,
        persisted_state.created_at_ms,
        persisted_state.updated_at_ms,
    );
    persisted_state.created_at_ms = Some(created_at_ms);
    persisted_state.updated_at_ms = Some(updated_at_ms);
    anyhow::ensure!(
        crate::history_store::source_stamp(path)? == source_stamp,
        "history source changed during resume preparation; prepare it again"
    );
    let messages = entries.into_iter().map(|entry| entry.message).collect();
    Ok((
        PreparedSessionResume {
            session_id,
            path: path.to_path_buf(),
            source_stamp,
            messages,
            message_history_ids,
            last_assistant_message_timestamp_ms,
            transcript_history,
            last_transcript_uuid,
            persisted_state,
        },
        matching_count,
    ))
}

/// Prepare recovery and count visible messages matching a caller-owned semantic predicate.
pub fn prepare_session_resume_counting(
    path: &Path,
    matches: impl Fn(&Message) -> bool,
) -> anyhow::Result<(PreparedSessionResume, usize)> {
    prepare_session_resume_inner(path, Some(&matches), false)
}

/// Prepare recovery with the shared real-user counting policy.
pub fn prepare_session_resume_real_user_counting(
    path: &Path,
) -> anyhow::Result<(PreparedSessionResume, usize)> {
    prepare_session_resume_inner(path, Some(&kcoder_types::is_real_user_message), true)
}

#[cfg(test)]
mod resume_checkpoint_tests {
    use super::*;
    use crate::history_index::journal::{JournalDomain, JournalFence};

    thread_local! {
        pub(super) static REPLAY_BYTES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
        pub(super) static CHECKPOINT_BYTES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
        pub(super) static CHECKPOINT_WRITTEN_BYTES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    }

    fn measured(path: &Path) -> (PreparedSessionResume, usize, u64) {
        REPLAY_BYTES.with(|total| total.set(0));
        CHECKPOINT_BYTES.with(|total| total.set(0));
        CHECKPOINT_WRITTEN_BYTES.with(|total| total.set(0));
        let (prepared, count) = prepare_session_resume_real_user_counting(path).unwrap();
        (prepared, count, REPLAY_BYTES.with(std::cell::Cell::get))
    }

    #[test]
    fn resume_checkpoint_reuses_prefix_and_reads_only_committed_tail() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let source = crate::history_store::HistorySource::bind(&path).unwrap();
        let record = |uuid: &str, text: &str| {
            format!(
                "{}\n",
                serde_json::json!({"session_id":"session","timestamp_ms":1,
                "uuid":uuid,"role":"user","content":[{"type":"text","text":text}]})
            )
        };
        let first = record("first", "hello");
        source.append(first.as_bytes()).unwrap();
        JournalFence::try_acquire(temp.path(), JournalDomain::History)
            .unwrap()
            .activate()
            .unwrap();
        let (_, count, read) = measured(&path);
        assert_eq!(read, first.len() as u64);
        assert_eq!(count, 1);
        let (_, count, read) = measured(&path);
        assert_eq!(read, 0, "unchanged committed prefix must not be replayed");
        assert_eq!(
            CHECKPOINT_WRITTEN_BYTES.with(std::cell::Cell::get),
            0,
            "unchanged checkpoint must not be rewritten"
        );
        assert_eq!(count, 1);
        let tail = record("second", "next");
        source.append(tail.as_bytes()).unwrap();
        let (prepared, count, read) = measured(&path);
        assert_eq!(read, tail.len() as u64);
        assert_eq!(count, 2);
        let (oracle, expected_count) =
            prepare_session_resume_counting(&path, |m| matches!(m, Message::User { .. })).unwrap();
        assert_eq!(prepared.messages, oracle.messages);
        assert_eq!(prepared.message_history_ids, oracle.message_history_ids);
        assert_eq!(
            prepared.load_transcript_messages().unwrap(),
            oracle.load_transcript_messages().unwrap()
        );
        assert_eq!(count, expected_count);
    }

    fn activate(root: &Path) {
        JournalFence::try_acquire(root, JournalDomain::History)
            .unwrap()
            .activate()
            .unwrap();
    }

    fn entry(uuid: &str, message: Message) -> serde_json::Value {
        serde_json::to_value(HistoryEntry {
            session_id: "session".into(),
            timestamp_ms: 7,
            uuid: Some(uuid.into()),
            parent_uuid: None,
            message,
        })
        .unwrap()
    }

    fn lines(values: &[serde_json::Value]) -> Vec<u8> {
        values
            .iter()
            .flat_map(|value| format!("{value}\n").into_bytes())
            .collect()
    }

    fn assert_oracle(path: &Path, actual: &PreparedSessionResume, count: usize) {
        // Independent legacy model/transcript projectors guard the shared replay refactor itself.
        let model = load_history(path).unwrap();
        assert_eq!(
            actual.messages,
            model
                .iter()
                .map(|entry| entry.message.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            actual.message_history_ids,
            model
                .iter()
                .map(|entry| entry.uuid.clone())
                .collect::<Vec<_>>()
        );
        let visible = load_transcript_history(path).unwrap();
        assert_eq!(
            actual.load_transcript_messages().unwrap(),
            visible
                .iter()
                .map(|entry| entry.message.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            count,
            visible
                .iter()
                .filter(|entry| kcoder_types::is_real_user_message(&entry.message))
                .count()
        );
        let (oracle, expected) =
            prepare_session_resume_counting(path, kcoder_types::is_real_user_message).unwrap();
        assert_eq!(actual.messages, oracle.messages);
        assert_eq!(actual.message_history_ids, oracle.message_history_ids);
        assert_eq!(
            actual.last_assistant_message_timestamp_ms,
            oracle.last_assistant_message_timestamp_ms
        );
        assert_eq!(actual.last_transcript_uuid, oracle.last_transcript_uuid);
        assert_eq!(
            actual.load_transcript_messages().unwrap(),
            oracle.load_transcript_messages().unwrap()
        );
        assert_eq!(
            format!("{:?}", actual.transcript_history.records),
            format!("{:?}", oracle.transcript_history.records)
        );
        assert_eq!(
            serde_json::to_value(&actual.persisted_state).unwrap(),
            serde_json::to_value(&oracle.persisted_state).unwrap()
        );
        assert_eq!(count, expected);
    }

    #[test]
    fn resume_checkpoint_every_boundary_split_matches_full_replay_and_generic_callbacks() {
        let mut summary = entry(
            "summary",
            Message::user_text("Earlier conversation summary: hidden"),
        );
        summary["isCompactSummary"] = serde_json::json!(true);
        let values = vec![
            entry("u1", Message::user_text("first")),
            entry("a1", Message::assistant_text("first answer")),
            entry("u2", Message::user_text("preserved")),
            entry(
                "call",
                Message::Assistant {
                    usage: None,
                    content: vec![kcoder_types::ContentBlock::ToolUse {
                        id: "tool-1".into(),
                        name: "read".into(),
                        input: serde_json::json!({"path":"file"}),
                    }],
                },
            ),
            entry(
                "result",
                Message::User {
                    content: vec![kcoder_types::ContentBlock::ToolResult {
                        tool_use_id: "tool-1".into(),
                        content: vec![kcoder_types::ContentBlock::Text {
                            text: "result".into(),
                        }],
                        is_error: None,
                    }],
                },
            ),
            serde_json::json!({"type":"system","subtype":"compact_boundary","uuid":"boundary",
                "compactMetadata":{"preservedSegment":{"headUuid":"u2","tailUuid":"result"}}}),
            summary,
            entry("a3", Message::assistant_text("after summary")),
            serde_json::json!({"type":"system","subtype":"rewind_boundary","rewindMetadata":{"anchorUuid":"summary"}}),
            entry("u3", Message::user_text("[system] synthetic notification")),
            entry("u4", Message::user_text("last real turn")),
            serde_json::json!({"type":"system","subtype":"rewind_boundary","rewindMetadata":{"anchorUuid":"unknown"}}),
        ];
        for split in 1..values.len() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("session.jsonl");
            let source = crate::history_store::HistorySource::bind(&path).unwrap();
            source.append(&lines(&values[..split])).unwrap();
            activate(temp.path());
            measured(&path);
            let tail = lines(&values[split..]);
            source.append(&tail).unwrap();
            let (actual, count, read) = measured(&path);
            assert_eq!(read, tail.len() as u64, "split={split}");
            assert_oracle(&path, &actual, count);
            let visited = std::cell::RefCell::new(Vec::new());
            prepare_session_resume_counting(&path, |message| {
                visited.borrow_mut().push(message.clone());
                kcoder_types::is_real_user_message(message)
            })
            .unwrap();
            assert_eq!(
                visited.borrow().len(),
                8,
                "generic callback includes later rewound records"
            );
            assert!(
                visited
                    .borrow()
                    .iter()
                    .any(|message| message.preview(100) == "after summary")
            );
        }
    }

    #[test]
    fn resume_checkpoint_refreshes_sidecar_and_rejects_epoch_generation_and_bad_cache() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let source = crate::history_store::HistorySource::bind(&path).unwrap();
        let body = lines(&[entry("u", Message::user_text("original"))]);
        source.append(&body).unwrap();
        // No tracking means no checkpoint files and unchanged full-replay semantics.
        assert_eq!(measured(&path).2, body.len() as u64);
        assert!(!temp.path().join(".kcoder-resume-checkpoints").exists());
        activate(temp.path());
        measured(&path);
        let sidecar = session_state_path(temp.path(), "session");
        source.write_metadata(&sidecar, || Ok(serde_json::to_vec(&serde_json::json!({
            "schema_version":1,"base_cwd":temp.path(),"cwd":temp.path(),"created_at_ms":1,"updated_at_ms":123,
            "session_memory":{"summary_path":"fresh.md","updated_at_ms":123,"updated_message_count":1,"update_count":2,"source":"fresh"}
        }))?)).unwrap();
        let (prepared, count, read) = measured(&path);
        assert_eq!(read, 0);
        assert_eq!(prepared.persisted_state.updated_at_ms, Some(123));
        assert_eq!(prepared.persisted_base_cwd(), Some(temp.path()));
        assert_eq!(
            prepared
                .persisted_state
                .session_memory
                .as_ref()
                .unwrap()
                .source,
            "fresh"
        );
        assert_oracle(&path, &prepared, count);
        let checkpoint = fs::read_dir(temp.path().join(".kcoder-resume-checkpoints"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::write(&checkpoint, b"corrupt").unwrap();
        assert_eq!(measured(&path).2, body.len() as u64);
        // A valid checksum cannot authorize an offset that disagrees with its committed proof.
        let bytes = fs::read(&checkpoint).unwrap();
        let mut payload: serde_json::Value = serde_json::from_slice(&bytes[32..]).unwrap();
        payload["state"]["offset"] = serde_json::json!(1);
        let payload = serde_json::to_vec(&payload).unwrap();
        use sha2::Digest;
        let mut invalid = sha2::Sha256::digest(&payload).to_vec();
        invalid.extend(payload);
        fs::write(&checkpoint, invalid).unwrap();
        assert_eq!(measured(&path).2, body.len() as u64);
        activate(temp.path());
        assert_eq!(measured(&path).2, body.len() as u64);
        {
            let mut fence = JournalFence::try_acquire(temp.path(), JournalDomain::History).unwrap();
            let _pending = fence.begin("session").unwrap();
            let before = fs::read(&checkpoint).unwrap();
            assert_eq!(measured(&path).2, body.len() as u64);
            assert_eq!(fs::read(&checkpoint).unwrap(), before);
        }
        activate(temp.path());
        let replacement = lines(&[entry("v", Message::user_text("replaced"))]);
        source.replace(&replacement).unwrap();
        let (prepared, count, read) = measured(&path);
        assert_eq!(read, replacement.len() as u64);
        assert_oracle(&path, &prepared, count);
    }

    #[test]
    fn resume_checkpoint_empty_compaction_unknown_preserved_and_clear_rewind_match_oracle() {
        let mut summary = entry(
            "summary",
            Message::user_text("Earlier conversation summary: minimal"),
        );
        summary["isCompactSummary"] = serde_json::json!(true);
        let values = vec![
            entry("u", Message::user_text("before")),
            serde_json::json!({"type":"system","subtype":"compact_boundary"}),
            summary.clone(),
            entry("v", Message::user_text("after")),
            serde_json::json!({"type":"system","subtype":"compact_boundary","compactMetadata":{"preservedSegment":{"headUuid":"missing","tailUuid":"v"}}}),
            summary,
            serde_json::json!({"type":"system","subtype":"rewind_boundary","rewindMetadata":{"anchorUuid":null}}),
            entry("w", Message::user_text("restart")),
        ];
        for split in 1..values.len() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("session.jsonl");
            let source = crate::history_store::HistorySource::bind(&path).unwrap();
            source.append(&lines(&values[..split])).unwrap();
            activate(temp.path());
            measured(&path);
            let tail = lines(&values[split..]);
            source.append(&tail).unwrap();
            let (actual, count, read) = measured(&path);
            assert_eq!(read, tail.len() as u64);
            assert_oracle(&path, &actual, count);
        }
    }

    #[test]
    fn resume_checkpoint_unterminated_records_and_cache_write_failure_keep_legacy_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let source = crate::history_store::HistorySource::bind(&path).unwrap();
        let mut body = lines(&[entry("u", Message::user_text("hello"))]);
        source.append(&body).unwrap();
        activate(temp.path());
        *body.last_mut().unwrap() = b' ';
        fs::write(&path, &body).unwrap();
        let (prepared, count, _) = measured(&path);
        assert_oracle(&path, &prepared, count);
        assert!(!temp.path().join(".kcoder-resume-checkpoints").exists());
        *body.last_mut().unwrap() = b'\n';
        fs::write(&path, &body).unwrap();
        fs::write(
            temp.path().join(".kcoder-resume-checkpoints"),
            b"not a directory",
        )
        .unwrap();
        let (prepared, count, read) = measured(&path);
        assert_eq!(read, body.len() as u64);
        assert_oracle(&path, &prepared, count);
        assert_eq!(fs::read(&path).unwrap(), body);
    }

    #[test]
    fn resume_checkpoint_compacted_fixture_reports_cache_and_jsonl_bytes_separately() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let source = crate::history_store::HistorySource::bind(&path).unwrap();
        let mut values: Vec<_> = (0..128)
            .map(|i| entry(&format!("u{i}"), Message::user_text("x".repeat(4096))))
            .collect();
        values.push(serde_json::json!({"type":"system","subtype":"compact_boundary"}));
        let mut summary = entry(
            "summary",
            Message::user_text("Earlier conversation summary: concise"),
        );
        summary["isCompactSummary"] = serde_json::json!(true);
        values.push(summary);
        let body = lines(&values);
        source.append(&body).unwrap();
        activate(temp.path());
        measured(&path);
        let tail = lines(&[entry("next", Message::user_text("continue"))]);
        source.append(&tail).unwrap();
        let (prepared, count, jsonl_bytes) = measured(&path);
        let checkpoint_bytes = CHECKPOINT_BYTES.with(std::cell::Cell::get);
        let full_jsonl_bytes = (body.len() + tail.len()) as u64;
        eprintln!(
            "checkpoint_io fixture=compacted full_jsonl_bytes={full_jsonl_bytes} checkpoint_read_bytes={checkpoint_bytes} tail_jsonl_bytes={jsonl_bytes}; excludes control/sidecar IO, not a latency measurement"
        );
        assert_eq!(jsonl_bytes, tail.len() as u64);
        assert!(checkpoint_bytes > 0);
        assert!(checkpoint_bytes + jsonl_bytes < full_jsonl_bytes);
        assert_oracle(&path, &prepared, count);
    }
}

fn remove_history_dir(path: &Path, deleted_files: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => deleted_files.push(path.to_path_buf()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(())
}

fn remove_history_file(path: &Path, deleted_files: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => deleted_files.push(path.to_path_buf()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(())
}

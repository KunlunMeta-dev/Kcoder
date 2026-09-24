use super::*;
use std::io::{BufRead, Read};

/// All state that can affect a later compact summary or rewind, including invisible anchors.
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReplayState {
    entries: Vec<HistoryEntry>,
    pending_preserved_segment: Option<Vec<HistoryEntry>>,
    transcript_records: Vec<TranscriptRecordRef>,
    summary_anchors: std::collections::HashMap<String, Option<String>>,
    compact_boundary: Option<serde_json::Value>,
    last_transcript_uuid: Option<String>,
    pub(super) line_number: usize,
    pub(super) offset: u64,
    first_timestamp: Option<u64>,
    latest_timestamp: Option<u64>,
}

impl ReplayState {
    pub(super) fn read(
        mut self,
        path: &Path,
        mut reader: impl BufRead,
        matches: Option<&dyn Fn(&Message) -> bool>,
        max_line_bytes: Option<u64>,
    ) -> anyhow::Result<Self> {
        let mut line = String::new();
        loop {
            line.clear();
            let bytes = match max_line_bytes {
                Some(limit) => (&mut reader).take(limit + 1).read_line(&mut line)?,
                None => reader.read_line(&mut line)?,
            };
            #[cfg(test)]
            super::resume_checkpoint_tests::REPLAY_BYTES.with(|n| n.set(n.get() + bytes as u64));
            if bytes == 0 {
                break;
            }
            if let Some(limit) = max_line_bytes {
                anyhow::ensure!(
                    bytes as u64 <= limit && line.ends_with('\n'),
                    "checkpoint tail has an oversized or incomplete record"
                );
            }
            let line_offset = self.offset;
            self.offset = self
                .offset
                .checked_add(bytes as u64)
                .context("history offset overflow")?;
            self.line_number = self
                .line_number
                .checked_add(1)
                .context("history line count overflow")?;
            if line.trim().is_empty() {
                continue;
            }
            let value: serde_json::Value = serde_json::from_str(&line).with_context(|| {
                format!(
                    "failed to parse history JSON at {}:{}",
                    path.display(),
                    self.line_number
                )
            })?;
            self.apply(value, line_offset, matches)?;
        }
        Ok(self)
    }

    fn apply(
        &mut self,
        value: serde_json::Value,
        line_offset: u64,
        matches: Option<&dyn Fn(&Message) -> bool>,
    ) -> anyhow::Result<()> {
        if let Some(timestamp) = value
            .get("timestamp_ms")
            .or_else(|| value.get("timestampMs"))
            .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
        {
            self.first_timestamp.get_or_insert(timestamp);
            self.latest_timestamp = Some(self.latest_timestamp.unwrap_or(0).max(timestamp));
        }
        if let Some(uuid) = value.get("uuid").and_then(serde_json::Value::as_str) {
            self.last_transcript_uuid = Some(uuid.to_owned());
        }
        if is_transcript_system_event(&value) {
            match value.get("subtype").and_then(serde_json::Value::as_str) {
                Some("compact_boundary") => {
                    self.compact_boundary = Some(value.clone());
                    if !compact_boundary_declares_preserved_segment(&value) {
                        self.pending_preserved_segment = None;
                        self.entries.clear();
                    } else if let Some(preserved) =
                        preserved_entries_for_boundary(&self.entries, &value)
                    {
                        self.pending_preserved_segment = Some(preserved);
                        self.entries.clear();
                    } else {
                        warn!(
                            line = self.line_number,
                            "compact boundary did not reference a valid preserved segment; keeping existing transcript context"
                        );
                        self.pending_preserved_segment = None;
                    }
                }
                Some("rewind_boundary") => {
                    apply_rewind_boundary(&mut self.entries, &value, self.line_number);
                    let visible = visible_rewind_boundary(&value, &self.summary_anchors);
                    apply_rewind_boundary_to_transcript_records(
                        &mut self.transcript_records,
                        &visible,
                        self.line_number,
                    );
                }
                _ => {}
            }
            return Ok(());
        }
        let summary = is_compact_summary_record(&value);
        let mut entry: HistoryEntry = serde_json::from_value(value).with_context(|| {
            format!(
                "failed to parse history message at line {}",
                self.line_number
            )
        })?;
        if summary {
            entry.message = entry
                .message
                .with_origin(kcoder_types::MessageOrigin::Compaction);
        }
        if !summary {
            // Generic predicates run on every original non-summary record, even if later rewound.
            let matching_prefix = self
                .transcript_records
                .last()
                .map_or(0, |r| r.matching_prefix)
                + usize::from(matches.is_some_and(|predicate| predicate(&entry.message)));
            self.transcript_records.push(TranscriptRecordRef {
                offset: line_offset,
                line_number: self.line_number,
                uuid: entry.uuid.clone(),
                matching_prefix,
            });
        } else if let Some(uuid) = &entry.uuid
            && let Some(anchor) = visible_summary_anchor(
                self.compact_boundary.as_ref(),
                self.transcript_records.iter().map(|r| r.uuid.as_deref()),
            )
        {
            self.summary_anchors.insert(uuid.clone(), anchor);
        }
        self.entries.push(entry);
        if summary && let Some(preserved) = self.pending_preserved_segment.take() {
            self.entries.extend(preserved);
        }
        Ok(())
    }

    pub(super) fn finish(self, path: &Path) -> PreparedHistoryReplay {
        let mut timestamps = HistoryTimestampBounds::default();
        for timestamp in [self.first_timestamp, self.latest_timestamp]
            .into_iter()
            .flatten()
        {
            timestamps.observe(&serde_json::json!({"timestamp_ms":timestamp}));
        }
        PreparedHistoryReplay {
            entries: self.entries,
            transcript_history: PreparedTranscriptHistory {
                path: path.to_path_buf(),
                records: self.transcript_records,
            },
            last_transcript_uuid: self.last_transcript_uuid,
            timestamps,
        }
    }
}

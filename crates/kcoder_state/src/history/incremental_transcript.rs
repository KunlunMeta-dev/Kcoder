use super::{
    apply_rewind_boundary, is_compact_summary_record, is_transcript_system_event,
    visible_rewind_boundary, visible_summary_anchor,
};
use crate::HistoryEntry;
use anyhow::Context;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct IncrementalTranscript {
    entries: Vec<HistoryEntry>,
    summary_anchors: HashMap<String, Option<String>>,
    compact_boundary: Option<Value>,
}

impl IncrementalTranscript {
    pub(super) fn apply(&mut self, value: Value, line: usize) -> anyhow::Result<()> {
        if is_transcript_system_event(&value) {
            match value.get("subtype").and_then(Value::as_str) {
                Some("compact_boundary") => self.compact_boundary = Some(value),
                Some("rewind_boundary") => {
                    let boundary = visible_rewind_boundary(&value, &self.summary_anchors);
                    apply_rewind_boundary(&mut self.entries, &boundary, line);
                }
                _ => {}
            }
            return Ok(());
        }
        if is_compact_summary_record(&value) {
            if let Some(uuid) = value.get("uuid").and_then(Value::as_str)
                && let Some(anchor) = visible_summary_anchor(
                    self.compact_boundary.as_ref(),
                    self.entries.iter().map(|entry| entry.uuid.as_deref()),
                )
            {
                self.summary_anchors.insert(uuid.to_owned(), anchor);
            }
            return Ok(());
        }
        self.entries.push(
            serde_json::from_value(value)
                .with_context(|| format!("failed to parse transcript message at line {line}"))?,
        );
        Ok(())
    }

    pub(super) fn finish(self) -> Vec<HistoryEntry> {
        self.entries
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn incremental_transcript_every_prefix_matches_legacy_boundary_replay() {
        let entry = |id: &str| json!({"session_id":"fixture","timestamp_ms":1,"uuid":id,"role":"user","content":[{"type":"text","text":id}]});
        let mut summary = entry("summary");
        summary["isCompactSummary"] = json!(true);
        let values = vec![
            entry("a"),
            entry("b"),
            json!({"type":"system","subtype":"compact_boundary","compactMetadata":{"preservedSegment":{"headUuid":"b"}}}),
            summary,
            entry("c"),
            json!({"type":"system","subtype":"rewind_boundary","rewindMetadata":{"anchorUuid":"summary"}}),
            entry("d"),
            json!({"type":"system","subtype":"rewind_boundary","rewindMetadata":{"anchorUuid":"unknown"}}),
            json!({"type":"system","subtype":"rewind_boundary","rewindMetadata":{"anchorUuid":null}}),
            entry("e"),
        ];
        for end in 0..=values.len() {
            let prefix = values[..end]
                .iter()
                .cloned()
                .enumerate()
                .map(|(index, value)| (index + 1, value))
                .collect::<Vec<_>>();
            let expected = super::super::transcript_history_from_values(&prefix, true).unwrap();
            let mut replay = IncrementalTranscript::default();
            for (line, value) in prefix {
                replay.apply(value, line).unwrap();
            }
            assert_eq!(
                serde_json::to_value(replay.finish()).unwrap(),
                serde_json::to_value(expected).unwrap(),
                "prefix {end}"
            );
        }
    }
}

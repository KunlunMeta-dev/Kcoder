//! Versioned source records remain display evidence, never executable protocol messages.
use crate::history_json::{self, Node, Segment, Value};
use anyhow::{Result, ensure};
use kcoder_state::external_history::ExternalHistoryReader;
use kcoder_types::{imported_transcript::*, migration::MigrationSourceKind};
use std::{collections::BTreeMap, io::Read};

mod capture;
mod claude;
mod codex;

const MAX_CAPTURE_BYTES: usize = 8 * 1024 * 1024;
pub const CODEX_ROLLOUT_BASELINE: &str = "0.163.0";
pub const CLAUDE_TRANSCRIPT_BASELINE: &str = "2.1.301";

struct Fields {
    nodes: BTreeMap<Vec<Segment>, Node>,
    record: u64,
    budget: usize,
    policy: CapturePolicy,
}
#[derive(Clone, Copy)]
enum CapturePolicy {
    LegacyV3,
    ReferencePayloads,
    SupplementalExecutionV5,
    StructuralV6,
}
impl CapturePolicy {
    fn captures_execution_events(self) -> bool {
        matches!(self, Self::SupplementalExecutionV5 | Self::StructuralV6)
    }
    fn pins_product_version(self) -> bool {
        !matches!(self, Self::StructuralV6)
    }
}
fn path(parts: &[&str]) -> Vec<Segment> {
    parts
        .iter()
        .map(|part| Segment::Key((*part).into()))
        .collect()
}
fn child(base: &[Segment], key: &str) -> Vec<Segment> {
    let mut result = base.to_vec();
    result.push(Segment::Key(key.into()));
    result
}

impl Fields {
    fn capture(&mut self, path: &[Segment], node: Node) -> Result<()> {
        // These consumers retain only the direct payload reference. Its descendants
        // still pass the bounded JSON walker, but do not belong in this metadata map.
        if matches!(
            self.policy,
            CapturePolicy::ReferencePayloads
                | CapturePolicy::SupplementalExecutionV5
                | CapturePolicy::StructuralV6
        ) && capture::is_reference_payload_descendant(path)
        {
            return Ok(());
        }
        if path.len() > 24 || path[..path.len().saturating_sub(1)].iter().any(|part| {
            matches!(part, Segment::Key(key) if matches!(key.as_str(), "input" | "arguments" | "signature" | "encrypted_content" | "data" | "base_instructions" | "dynamic_tools"))
        }) { return Ok(()); }
        let execution_success = self.policy.captures_execution_events()
            && matches!(path, [Segment::Key(parent), Segment::Key(key)] if parent == "payload" && key == "success");
        if let Some(Segment::Key(key)) = path.last()
            && !execution_success
            && !matches!(
                key.as_str(),
                "type"
                    | "timestamp"
                    | "ordinal"
                    | "payload"
                    | "message"
                    | "content"
                    | "summary"
                    | "id"
                    | "uuid"
                    | "parentUuid"
                    | "logicalParentUuid"
                    | "sessionId"
                    | "session_id"
                    | "turn_id"
                    | "role"
                    | "phase"
                    | "text"
                    | "thinking"
                    | "signature"
                    | "encrypted_content"
                    | "call_id"
                    | "tool_use_id"
                    | "name"
                    | "namespace"
                    | "arguments"
                    | "input"
                    | "output"
                    | "is_error"
                    | "status"
                    | "version"
                    | "cli_version"
                    | "cwd"
                    | "history_mode"
                    | "history_base"
                    | "subagent_history_start_ordinal"
                    | "forked_from_id"
                    | "parent_thread_id"
                    | "forked_from_ordinal_exclusive"
                    | "replacement_history"
                    | "replacement_history_metadata"
                    | "retained_context"
                    | "guardian_history"
                    | "thread_id"
                    | "end_ordinal_exclusive"
                    | "end_byte_offset"
                    | "user_input_order"
                    | "window_number"
                    | "resume_metadata"
                    | "last_started_turn_id"
                    | "turn_attribution"
                    | "num_turns"
                    | "isSidechain"
                    | "isMeta"
                    | "isCompactSummary"
                    | "teamName"
                    | "subtype"
                    | "source"
                    | "media_type"
                    | "data"
                    | "url"
                    | "image_url"
                    | "path"
                    | "metadata"
                    | "internal_chat_message_metadata_passthrough"
                    | "window_id"
                    | "inherited_user_message"
                    | "compaction_output"
                    | "client_authored"
                    | "exit_code"
                    | "title"
                    | "customTitle"
                    | "custom_title"
                    | "parentToolUseId"
                    | "isSynthetic"
            )
        {
            return Ok(());
        }
        let size = path
            .iter()
            .map(|part| match part {
                Segment::Key(key) => key.len() + 32,
                Segment::Index(_) => 32,
            })
            .sum::<usize>()
            + match &node.value {
                Value::String(text) => {
                    text.preview.len() + text.trimmed_head.len() + text.trimmed_tail.len()
                }
                Value::Number(number) => number.len(),
                _ => 0,
            }
            + 256;
        self.budget += size;
        ensure!(
            self.budget <= MAX_CAPTURE_BYTES,
            "migration_history_record_metadata_budget_exceeded"
        );
        self.nodes.insert(path.to_vec(), node);
        Ok(())
    }
    fn string(&self, key: &[Segment]) -> Option<&str> {
        match &self.nodes.get(key)?.value {
            Value::String(text) if text.bytes == text.preview.len() as u64 => {
                Some(text.preview.as_str())
            }
            _ => None,
        }
    }
    fn text(&self, base: &[Segment], key: &str) -> Option<String> {
        self.string(&child(base, key)).map(str::to_owned)
    }
    fn boolean(&self, base: &[Segment], key: &str) -> Option<bool> {
        match self.nodes.get(&child(base, key)).map(|node| &node.value) {
            Some(Value::Bool(value)) => Some(*value),
            _ => None,
        }
    }
    fn number(&self, base: &[Segment], key: &str) -> Option<u64> {
        match self.nodes.get(&child(base, key)).map(|node| &node.value) {
            Some(Value::Number(value)) => value.parse().ok(),
            _ => None,
        }
    }
    fn integer(&self, base: &[Segment], key: &str) -> Option<i64> {
        match self.nodes.get(&child(base, key)).map(|node| &node.value) {
            Some(Value::Number(value)) => value.parse().ok(),
            _ => None,
        }
    }
    fn reference(&self, key: &[Segment], preview: bool) -> Option<HistoricalValueRef> {
        let node = self.nodes.get(key)?;
        let (encoding, bytes, hash, text) = match &node.value {
            Value::String(text) => (
                HistoricalValueEncoding::JsonString,
                Some(text.bytes),
                Some(text.sha256.clone()),
                preview.then(|| text.preview.clone()),
            ),
            _ => (HistoricalValueEncoding::Json, None, None, None),
        };
        Some(HistoricalValueRef {
            record: self.record,
            offset: node.span.start,
            bytes: node.span.end - node.span.start,
            encoding,
            decoded_bytes: bytes,
            decoded_sha256: hash,
            preview: text,
        })
    }
    fn indices(&self, base: &[Segment]) -> Vec<u64> {
        let mut indices = std::collections::BTreeSet::new();
        for key in self.nodes.keys() {
            if key.starts_with(base)
                && let Some(Segment::Index(index)) = key.get(base.len())
            {
                indices.insert(*index);
            }
        }
        indices.into_iter().collect()
    }
}

fn diagnostic(record: &mut HistoricalRecord, code: &str, critical: bool) {
    record.diagnostics.push(HistoricalDiagnostic {
        code: code.into(),
        blocks_continuation: critical,
    });
}

fn role(value: Option<&str>) -> HistoricalRole {
    match value {
        Some("user") => HistoricalRole::User,
        Some("assistant") => HistoricalRole::Assistant,
        Some("system") => HistoricalRole::System,
        Some("developer") => HistoricalRole::Developer,
        Some("tool") => HistoricalRole::Tool,
        _ => HistoricalRole::Unknown,
    }
}

fn empty(source: MigrationSourceKind, record: u64) -> HistoricalRecord {
    HistoricalRecord {
        source,
        record,
        source_id: None,
        parent_id: None,
        logical_parent_id: None,
        source_session_id: None,
        timestamp: None,
        source_version: None,
        turn_id: None,
        persisted_ordinal: None,
        sidechain: false,
        hidden: false,
        compact_summary: false,
        codex: None,
        data: HistoricalRecordData::Unknown {
            source_type: None,
            payload: None,
        },
        diagnostics: Vec::new(),
    }
}

/// Parses one immutable record. The caller must retain diagnostics and the source reference;
/// a readable message does not establish a valid branch or authorize continuation.
pub fn parse_record(
    archive: &ExternalHistoryReader,
    ordinal: u64,
    check: impl FnMut(u64) -> bool,
) -> Result<HistoricalRecord> {
    let mut record = parse_reader(
        archive.origin().source,
        ordinal,
        archive.open_record(ordinal)?,
        check,
    )?;
    if record.source_session_id.is_none() {
        record.source_session_id = Some(archive.origin().source_session_id.clone());
    }
    Ok(record)
}

pub fn parse_reader(
    source: MigrationSourceKind,
    ordinal: u64,
    reader: impl Read,
    check: impl FnMut(u64) -> bool,
) -> Result<HistoricalRecord> {
    parse_with_policy(source, ordinal, reader, check, CapturePolicy::StructuralV6)
}

/// Reproduce the known original /3 capture strategy. Persisted /3 jobs have no implementation
/// fingerprint; normal job recovery must refuse an ambiguous unsealed projection instead.
pub(crate) fn parse_reader_legacy_v3(
    source: MigrationSourceKind,
    ordinal: u64,
    reader: impl Read,
    check: impl FnMut(u64) -> bool,
) -> Result<HistoricalRecord> {
    parse_with_policy(source, ordinal, reader, check, CapturePolicy::LegacyV3)
}

/// Keep /4 capture and event interpretation exact when resuming its accepted prefix.
pub(crate) fn parse_reader_legacy_v4(
    source: MigrationSourceKind,
    ordinal: u64,
    reader: impl Read,
    check: impl FnMut(u64) -> bool,
) -> Result<HistoricalRecord> {
    parse_with_policy(
        source,
        ordinal,
        reader,
        check,
        CapturePolicy::ReferencePayloads,
    )
}

/// Keep /5 interpretation exact for an existing accepted projection.
pub(crate) fn parse_reader_legacy_v5(
    source: MigrationSourceKind,
    ordinal: u64,
    reader: impl Read,
    check: impl FnMut(u64) -> bool,
) -> Result<HistoricalRecord> {
    parse_with_policy(
        source,
        ordinal,
        reader,
        check,
        CapturePolicy::SupplementalExecutionV5,
    )
}

fn parse_with_policy(
    source: MigrationSourceKind,
    ordinal: u64,
    reader: impl Read,
    check: impl FnMut(u64) -> bool,
    policy: CapturePolicy,
) -> Result<HistoricalRecord> {
    let mut fields = Fields {
        nodes: BTreeMap::new(),
        record: ordinal,
        budget: 0,
        policy,
    };
    if let Err(error) = history_json::walk(reader, |path, node| fields.capture(path, node), check) {
        if error
            .chain()
            .any(|cause| cause.downcast_ref::<std::io::Error>().is_some())
            || error.to_string() == "history_json_cancelled"
        {
            return Err(error);
        }
        let mut record = empty(source, ordinal);
        diagnostic(&mut record, "invalid_or_over_budget_source_record", true);
        return Ok(record);
    }
    let mut record = empty(source, ordinal);
    let result = match source {
        MigrationSourceKind::Codex => codex::parse(&fields, &mut record),
        MigrationSourceKind::ClaudeCode => claude::parse(&fields, &mut record),
    };
    if result.is_err() {
        record = empty(source, ordinal);
        record.data = HistoricalRecordData::Unknown {
            source_type: fields.text(&[], "type"),
            payload: fields.reference(&[], false),
        };
        diagnostic(&mut record, "invalid_source_record_structure", true);
    }
    Ok(record)
}

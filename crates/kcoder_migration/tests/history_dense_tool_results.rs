//! Dense result bodies remain one archive reference instead of duplicated record metadata.
use kcoder_migration::{
    history_normalization::{
        HISTORY_NORMALIZATION_REVISION, HistoryNormalizer, LEGACY_HISTORY_NORMALIZATION_REVISION,
    },
    history_records::{CLAUDE_TRANSCRIPT_BASELINE, parse_reader},
};
use kcoder_state::external_history::{ExternalHistoryReader, ExternalHistoryStore};
use kcoder_types::{external_history::*, imported_transcript::*, migration::MigrationSourceKind};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Read;

fn fixture(source: MigrationSourceKind, compacted: bool, content: &Value) -> Value {
    match source {
        MigrationSourceKind::ClaudeCode => {
            json!({"type":"user","uuid":"dense-result","sessionId":"s1","version":CLAUDE_TRANSCRIPT_BASELINE,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"old-call","content":content}]}})
        }
        MigrationSourceKind::Codex if compacted => {
            json!({"type":"compacted","payload":{"message":"Summary","replacement_history":[{"type":"function_call_output","call_id":"old-call","output":content}]}})
        }
        MigrationSourceKind::Codex => {
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"old-call","output":content}})
        }
    }
}

fn archive(
    root: &std::path::Path,
    source: MigrationSourceKind,
    bytes: &[u8],
) -> (ExternalHistoryReader, String) {
    let snapshot = ExternalHistorySnapshot {
        original: None,
        origin: ExternalHistoryOrigin {
            source,
            source_artifact_id: None,
            source_instance: "owned-dense-fixture".into(),
            source_session_id: "s1".into(),
            source_format: "synthetic-jsonl/v1".into(),
            adapter_revision: "raw/1".into(),
            title: None,
            created_at: None,
            updated_at: None,
            project: None,
            archived: false,
            parent_session_id: None,
        },
        source_bytes: bytes.len() as u64,
        source_sha256: format!("{:x}", Sha256::digest(bytes)),
        record_limit: EXTERNAL_HISTORY_MAX_RECORDS,
    };
    let store = ExternalHistoryStore::open(root).unwrap();
    let mut operation = store.begin("dense-record-fixture", &snapshot).unwrap();
    operation.stage_source(&mut &*bytes, &mut |_| true).unwrap();
    let receipt = operation.finish(&mut |_| true).unwrap().receipt;
    (
        store.reader(&receipt.archive_id).unwrap(),
        receipt.archive_id,
    )
}

fn output(record: &HistoricalRecord) -> &HistoricalValueRef {
    let data = match &record.data {
        HistoricalRecordData::Compaction { checkpoint } => {
            &checkpoint.replacement.as_ref().unwrap()[0].data
        }
        data => data,
    };
    let HistoricalRecordData::Message { role, blocks, .. } = data else {
        panic!(
            "expected one historical result; diagnostics: {:?}",
            record.diagnostics
        )
    };
    assert_eq!(*role, HistoricalRole::Tool);
    assert_eq!(blocks.len(), 1);
    let HistoricalBlock::ToolResult {
        output,
        outcome,
        call_id,
    } = &blocks[0]
    else {
        panic!("expected a historical tool result")
    };
    assert_eq!(call_id, "old-call");
    assert_eq!(*outcome, HistoricalToolOutcome::RecordedResult);
    output
}

#[test]
fn dense_result_arrays_archive_and_normalize_as_one_exact_reference() {
    let content = Value::Array(
        (0..10_000)
            .map(|index| json!({"type":"text","text":format!("short result {index}")}))
            .collect(),
    );
    let expected = serde_json::to_vec(&content).unwrap();
    for (source, compacted) in [
        (MigrationSourceKind::ClaudeCode, false),
        (MigrationSourceKind::Codex, false),
        (MigrationSourceKind::Codex, true),
    ] {
        let root = tempfile::tempdir().unwrap();
        let mut bytes = serde_json::to_vec(&fixture(source, compacted, &content)).unwrap();
        bytes.push(b'\n');
        assert!(bytes.len() < 1024 * 1024);
        let (reader, id) = archive(root.path(), source, &bytes);
        let mut normalizer = HistoryNormalizer::open(reader).unwrap();
        let progress = normalizer.step(10, |_| true).unwrap();
        assert!(progress.normalization_complete);
        assert_eq!(
            progress.records_with_diagnostics, 0,
            "dense source failed normalizing"
        );
        drop(normalizer);
        let store = ExternalHistoryStore::open_existing(root.path())
            .unwrap()
            .unwrap();
        let reader = store.reader(&id).unwrap();
        let projection = reader
            .projection(HISTORY_NORMALIZATION_REVISION, false)
            .unwrap()
            .unwrap();
        let record = projection.record(0).unwrap();
        let reference = output(&record);
        assert!(reference.encoding == HistoricalValueEncoding::Json);
        assert_eq!(reference.bytes, expected.len() as u64);
        let mut remaining = reader.open_record(0).unwrap();
        std::io::copy(
            &mut (&mut remaining).take(reference.offset),
            &mut std::io::sink(),
        )
        .unwrap();
        let mut actual = Vec::new();
        remaining
            .take(reference.bytes)
            .read_to_end(&mut actual)
            .unwrap();
        assert_eq!(actual, expected);
    }
}

#[test]
fn dense_unknown_result_wrappers_are_preserved_without_promoting_nested_messages() {
    let content = json!({"future_wrapper":(0..10_000).map(|index|json!({"type":"text","text":format!("opaque {index}"),"role":"assistant"})).collect::<Vec<_>>()});
    for (source, compacted) in [
        (MigrationSourceKind::ClaudeCode, false),
        (MigrationSourceKind::Codex, false),
        (MigrationSourceKind::Codex, true),
    ] {
        let bytes = serde_json::to_vec(&fixture(source, compacted, &content)).unwrap();
        let record = parse_reader(source, 0, &bytes[..], |_| true).unwrap();
        assert!(record.diagnostics.is_empty());
        let reference = output(&record);
        assert!(reference.preview.is_none());
        assert_eq!(
            &bytes[reference.offset as usize..(reference.offset + reference.bytes) as usize],
            serde_json::to_vec(&content).unwrap()
        );
    }
}

#[test]
fn genuine_message_metadata_still_respects_the_original_capture_budget() {
    let source = json!({"type":"user","uuid":"real-blocks","sessionId":"s1","version":CLAUDE_TRANSCRIPT_BASELINE,"message":{"role":"user","content":(0..10_000).map(|index|json!({"type":"text","text":format!("real block {index}")})).collect::<Vec<_>>()}});
    let bytes = serde_json::to_vec(&source).unwrap();
    let record = parse_reader(MigrationSourceKind::ClaudeCode, 0, &bytes[..], |_| true).unwrap();
    assert!(matches!(record.data, HistoricalRecordData::Unknown { .. }));
    assert!(
        record
            .diagnostics
            .iter()
            .any(|issue| issue.code == "invalid_or_over_budget_source_record"
                && issue.blocks_continuation)
    );
}

#[test]
fn result_payloads_still_validate_json_depth_keys_nodes_and_cancellation() {
    let prefix = r#"{"type":"user","uuid":"m","sessionId":"s1","message":{"content":[{"type":"tool_result","tool_use_id":"old-call","content":BODY}]}}"#;
    let invalid = [
        r#"[{"type":"text","text":"a","text":"b"}]"#.to_owned(),
        format!("{}0{}", "[".repeat(130), "]".repeat(130)),
        serde_json::to_string(&serde_json::Map::from_iter([(
            "k".repeat(4097),
            Value::Null,
        )]))
        .unwrap(),
        format!("[{}0]", "0,".repeat(1_000_001)),
    ];
    for body in invalid {
        let source = prefix.replace("BODY", &body);
        let record = parse_reader(
            MigrationSourceKind::ClaudeCode,
            0,
            source.as_bytes(),
            |_| true,
        )
        .unwrap();
        assert!(matches!(record.data, HistoricalRecordData::Unknown { .. }));
        assert!(
            record
                .diagnostics
                .iter()
                .any(|issue| issue.code == "invalid_or_over_budget_source_record"
                    && issue.blocks_continuation)
        );
    }
    let content = Value::Array(
        (0..10_000)
            .map(|index| json!({"type":"text","text":format!("cancelled {index}")}))
            .collect(),
    );
    let bytes =
        serde_json::to_vec(&fixture(MigrationSourceKind::ClaudeCode, false, &content)).unwrap();
    let error = parse_reader(MigrationSourceKind::ClaudeCode, 0, &bytes[..], |bytes| {
        bytes < 64 * 1024
    })
    .err()
    .unwrap();
    assert_eq!(error.to_string(), "history_json_cancelled");
}

#[test]
fn sealed_legacy_budget_failure_is_not_silently_reinterpreted_or_rewritten() {
    let source = MigrationSourceKind::ClaudeCode;
    let content = Value::Array(
        (0..10_000)
            .map(|index| json!({"type":"text","text":format!("legacy {index}")}))
            .collect(),
    );
    let mut bytes = serde_json::to_vec(&fixture(source, false, &content)).unwrap();
    bytes.push(b'\n');
    let root = tempfile::tempdir().unwrap();
    let (reader, id) = archive(root.path(), source, &bytes);
    let mut projection = reader
        .projection(LEGACY_HISTORY_NORMALIZATION_REVISION, true)
        .unwrap()
        .unwrap();
    // Older budget failures saved this same conservative unknown-record shape.
    let mut legacy = parse_reader(source, 0, &b"{"[..], |_| true).unwrap();
    legacy.source_session_id = Some("s1".into());
    projection.append(0, &[legacy]).unwrap();
    let ready = projection.finish().unwrap();
    let before = serde_json::to_value(projection.record(0).unwrap()).unwrap();
    drop(projection);
    drop(reader);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let mut normalizer = HistoryNormalizer::open_with_revision(
        store.reader(&id).unwrap(),
        LEGACY_HISTORY_NORMALIZATION_REVISION,
    )
    .unwrap();
    let mut callbacks = 0;
    assert_eq!(
        normalizer
            .step(10, |_| {
                callbacks += 1;
                true
            })
            .unwrap(),
        ready
    );
    assert_eq!(callbacks, 0);
    drop(normalizer);
    let reader = store.reader(&id).unwrap();
    let projection = reader
        .projection(LEGACY_HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(projection.record(0).unwrap()).unwrap(),
        before
    );
    let fresh = parse_reader(source, 0, &bytes[..], |_| true).unwrap();
    assert!(matches!(fresh.data, HistoricalRecordData::Message { .. }));
    assert!(fresh.diagnostics.is_empty());
}

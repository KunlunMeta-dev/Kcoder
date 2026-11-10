use kcoder_migration::{
    history_codex::{resolve_codex_history_lineage, select_codex_history_from_lineage},
    history_normalization::{HISTORY_NORMALIZATION_REVISION, HistoryNormalizer},
    history_records::CODEX_ROLLOUT_BASELINE,
    history_sources::HistorySourceBinding,
};
use kcoder_state::external_history::ExternalHistoryStore;
use kcoder_types::{external_history::*, imported_transcript::*, migration::MigrationSourceKind};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path};

const A: &str = "11111111-1111-4111-8111-111111111111";
const B: &str = "22222222-2222-4222-8222-222222222222";
fn origin(id: &str) -> ExternalHistoryOrigin {
    ExternalHistoryOrigin {
        source: MigrationSourceKind::Codex,
        source_instance: "owned-source".into(),
        source_session_id: id.into(),
        source_artifact_id: None,
        source_format: "synthetic-codex-jsonl".into(),
        adapter_revision: "raw/1".into(),
        title: None,
        created_at: None,
        updated_at: None,
        project: None,
        archived: false,
        parent_session_id: None,
    }
}
fn lines(records: Vec<Value>) -> Vec<u8> {
    let mut bytes = Vec::new();
    for record in records {
        serde_json::to_writer(&mut bytes, &record).unwrap();
        bytes.push(b'\n');
    }
    bytes
}
fn meta(id: &str) -> Value {
    json!({"type":"session_meta","ordinal":0,"payload":{"id":id,"session_id":id,"cli_version":CODEX_ROLLOUT_BASELINE,"history_mode":"paginated"}})
}
fn name(id: &str) -> String {
    format!("rollout-2026-10-16T00-00-00-{id}.jsonl.zst")
}
fn capture(root: &Path, id: &str) -> HistorySourceBinding {
    HistorySourceBinding::capture(root, Path::new(&name(id)), origin(id), &mut |_, _| true).unwrap()
}
fn normalize(store: &ExternalHistoryStore, id: &str) {
    let mut job = HistoryNormalizer::open(store.reader(id).unwrap()).unwrap();
    while !job.progress().unwrap().normalization_complete {
        job.step(10, |_| true).unwrap();
    }
}

#[test]
fn multiframe_source_keeps_original_bytes_and_normalizes_long_outputs_from_decoded_offsets() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let text = "x".repeat(8 * 1024 * 1024);
    let logical = lines(vec![
        meta(A),
        json!({"type":"response_item","ordinal":1,"payload":{"type":"function_call_output","call_id":"old-call","output":text}}),
    ]);
    let mut original = zstd::stream::encode_all(&logical[..37], 1).unwrap();
    original.extend(zstd::stream::encode_all(&logical[37..], 1).unwrap());
    std::fs::write(from.path().join(name(A)), &original).unwrap();
    let binding = capture(from.path(), A);
    assert_eq!(binding.snapshot().source_bytes, logical.len() as u64);
    assert_eq!(
        binding.snapshot().original.as_ref().unwrap().bytes,
        original.len() as u64
    );
    assert_eq!(
        binding.snapshot().origin.source_artifact_id.as_deref(),
        Some(A)
    );
    let binding: HistorySourceBinding =
        serde_json::from_slice(&serde_json::to_vec(&binding).unwrap()).unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let receipt = binding
        .archive(&store, "compressed", &mut |_| true)
        .unwrap()
        .receipt;
    normalize(&store, &receipt.archive_id);
    let reader = store.reader(&receipt.archive_id).unwrap();
    assert_eq!(
        reader
            .read_original_chunk(0, EXTERNAL_HISTORY_CHUNK_BYTES)
            .unwrap(),
        original
    );
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let record = index.record(1).unwrap();
    assert!(record.diagnostics.is_empty());
    let HistoricalRecordData::Message { blocks, .. } = record.data else {
        panic!("message expected")
    };
    let HistoricalBlock::ToolResult {
        output,
        outcome: HistoricalToolOutcome::RecordedResult,
        ..
    } = &blocks[0]
    else {
        panic!("result expected")
    };
    assert_eq!(output.decoded_bytes, Some(text.len() as u64));
    assert_eq!(
        output.decoded_sha256.as_deref(),
        Some(format!("{:x}", Sha256::digest(text.as_bytes())).as_str())
    );
    assert_eq!(output.preview.as_ref().unwrap().len(), 4096);
    assert!(
        reader
            .read_record_chunk(1, output.offset, output.bytes.min(256 * 1024) as usize)
            .unwrap()
            .starts_with(b"\"xxxx")
    );
}

#[test]
fn decode_cancellation_and_lost_receipt_recover_after_the_selected_source_is_removed() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let original = zstd::stream::encode_all(&lines(vec![meta(A)])[..], 1).unwrap();
    let path = from.path().join(name(A));
    std::fs::write(&path, original).unwrap();
    let binding = capture(from.path(), A);
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    assert!(
        binding
            .archive(&store, "resume", &mut |progress| progress.phase
                != ExternalHistoryPhase::Decoding)
            .is_err()
    );
    std::fs::remove_file(&path).unwrap();
    let committed = binding.archive(&store, "resume", &mut |_| true).unwrap();
    std::fs::remove_file(
        to.path()
            .join("external-history")
            .join(&committed.receipt.archive_id)
            .join("receipt.json"),
    )
    .unwrap();
    let restored = binding.archive(&store, "resume", &mut |_| true).unwrap();
    assert_eq!(committed.receipt, restored.receipt);
    assert!(restored.owns_archive);
}

#[test]
fn source_growth_is_frozen_at_a_complete_compressed_frame_boundary() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let first = zstd::stream::encode_all(&lines(vec![meta(A)])[..], 1).unwrap();
    let path = from.path().join(name(A));
    std::fs::write(&path, &first).unwrap();
    let binding = capture(from.path(), A);
    let second=zstd::stream::encode_all(&lines(vec![json!({"type":"event_msg","ordinal":1,"payload":{"type":"task_complete","turn_id":"later"}})])[..],1).unwrap();
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(&second)
        .unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let receipt = binding
        .archive(&store, "frozen", &mut |_| true)
        .unwrap()
        .receipt;
    let reader = store.reader(&receipt.archive_id).unwrap();
    assert_eq!(reader.records(0, 10).unwrap().total_records, 1);
    assert_eq!(reader.read_original_chunk(0, 1024).unwrap(), first);
    assert!(capture(from.path(), A).snapshot().source_bytes > binding.snapshot().source_bytes);
}

#[test]
fn malformed_frames_and_cancellation_in_output_free_data_do_not_change_the_source() {
    let from = tempfile::tempdir().unwrap();
    let path = from.path().join(name(A));
    for bytes in [
        b"PRIVATE-CANARY not zstd".to_vec(),
        vec![0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x90, 0x01, 0, 0],
    ] {
        std::fs::write(&path, &bytes).unwrap();
        let error = HistorySourceBinding::capture(
            from.path(),
            Path::new(&name(A)),
            origin(A),
            &mut |_, _| true,
        )
        .err()
        .unwrap();
        assert!(!error.to_string().contains("PRIVATE-CANARY"));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
    let mut bytes = 0x184d2a50u32.to_le_bytes().to_vec();
    bytes.extend((1024 * 1024u32).to_le_bytes());
    bytes.extend(vec![b'x'; 1024 * 1024]);
    bytes.extend(zstd::stream::encode_all(&lines(vec![meta(A)])[..], 1).unwrap());
    std::fs::write(&path, &bytes).unwrap();
    let error = HistorySourceBinding::capture(
        from.path(),
        Path::new(&name(A)),
        origin(A),
        &mut |processed, _| processed < 64 * 1024,
    )
    .err()
    .unwrap();
    assert!(error.to_string().contains("cancelled"));
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn a_compressed_parent_and_plain_child_use_logical_jsonl_prefix_offsets() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let logical = lines(vec![
        meta(A),
        json!({"type":"response_item","ordinal":1,"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"parent input"}]}}),
    ]);
    let original = zstd::stream::encode_all(&logical[..], 1).unwrap();
    std::fs::write(from.path().join(name(A)), original).unwrap();
    let parent = capture(from.path(), A)
        .archive(&store, "parent", &mut |_| true)
        .unwrap()
        .receipt;
    normalize(&store, &parent.archive_id);
    let mut header = meta(B);
    header["ordinal"] = 2.into();
    header["payload"]["history_base"] =
        json!({"thread_id":A,"end_ordinal_exclusive":2,"end_byte_offset":logical.len()});
    let child = lines(vec![
        header,
        json!({"type":"response_item","ordinal":3,"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"child answer"}]}}),
    ]);
    let filename = name(B).strip_suffix(".zst").unwrap().to_owned();
    std::fs::write(from.path().join(&filename), child).unwrap();
    let binding =
        HistorySourceBinding::capture(from.path(), Path::new(&filename), origin(B), &mut |_, _| {
            true
        })
        .unwrap();
    let child = binding
        .archive(&store, "child", &mut |_| true)
        .unwrap()
        .receipt;
    normalize(&store, &child.archive_id);
    let lineage =
        resolve_codex_history_lineage(&store, &child.archive_id, &[parent.archive_id], |_| true)
            .unwrap();
    let selected = select_codex_history_from_lineage(&store, lineage, |_| true).unwrap();
    assert!(selected.complete_window());
    assert_eq!(selected.items().len(), 2);
    assert!(matches!(
        selected.item_from_store(&store, 0).unwrap(),
        HistoricalRecordData::Message {
            role: HistoricalRole::User,
            ..
        }
    ));
    assert!(matches!(
        selected.item_from_store(&store, 1).unwrap(),
        HistoricalRecordData::Message {
            role: HistoricalRole::Assistant,
            ..
        }
    ));
}

#[test]
fn compressed_codex_with_opaque_compaction_reconstructs_from_sealed_original_records() {
    use kcoder_migration::history_codex::reconstruct_readable_history;
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let logical = lines(vec![
        meta(A),
        json!({"type":"response_item","ordinal":1,"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"original task"}]}}),
        json!({"type":"response_item","ordinal":2,"payload":{"type":"custom_tool_call","call_id":"old","name":"bash","input":"NEVER_EXECUTE_COMPRESSED"}}),
        json!({"type":"response_item","ordinal":3,"payload":{"type":"custom_tool_call_output","call_id":"old","output":"old output"}}),
        json!({"type":"compacted","ordinal":4,"payload":{"message":"","window_number":1,"replacement_history":[{"type":"compaction","encrypted_content":"OPAQUE-CANARY"}]}}),
        json!({"type":"response_item","ordinal":5,"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"continue"}]}}),
    ]);
    let original = zstd::stream::encode_all(&logical[..], 1).unwrap();
    let path = from.path().join(name(A));
    std::fs::write(&path, &original).unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let receipt = capture(from.path(), A)
        .archive(&store, "reconstruction", &mut |_| true)
        .unwrap()
        .receipt;
    normalize(&store, &receipt.archive_id);
    let reader = store.reader(&receipt.archive_id).unwrap();
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let candidate = reconstruct_readable_history(&index, |_| true).unwrap();
    assert_eq!(
        candidate
            .items()
            .iter()
            .map(|row| row.record)
            .collect::<Vec<_>>(),
        [1, 5]
    );
    assert_eq!(
        candidate
            .tool_records()
            .iter()
            .map(|row| row.record)
            .collect::<Vec<_>>(),
        [2, 3]
    );
    assert_eq!(candidate.opaque_checkpoints(), 1);
    assert_eq!(
        reader
            .read_original_chunk(0, EXTERNAL_HISTORY_CHUNK_BYTES)
            .unwrap(),
        original
    );
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert!(!from.path().join("NEVER_EXECUTE_COMPRESSED").exists());
}

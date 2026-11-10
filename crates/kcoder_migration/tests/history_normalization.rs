use kcoder_migration::{
    history_normalization::{
        HISTORY_NORMALIZATION_REVISION, HISTORY_NORMALIZATION_REVISION_V4,
        HISTORY_NORMALIZATION_REVISION_V5, HistoryNormalizer,
        LEGACY_HISTORY_NORMALIZATION_REVISION,
    },
    history_records::{CLAUDE_TRANSCRIPT_BASELINE, CODEX_ROLLOUT_BASELINE},
};
use kcoder_state::external_history::{ExternalHistoryReader, ExternalHistoryStore};
use kcoder_types::{external_history::*, imported_transcript::*, migration::MigrationSourceKind};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path};

fn archive(
    root: &Path,
    source: MigrationSourceKind,
    bytes: &[u8],
) -> (ExternalHistoryReader, String) {
    archive_stream(
        root,
        source,
        bytes.len() as u64,
        format!("{:x}", Sha256::digest(bytes)),
        &mut &bytes[..],
    )
}

fn archive_stream(
    root: &Path,
    source: MigrationSourceKind,
    total: u64,
    sha256: String,
    input: &mut impl Read,
) -> (ExternalHistoryReader, String) {
    let snapshot = ExternalHistorySnapshot {
        original: None,
        origin: ExternalHistoryOrigin {
            source,
            source_artifact_id: None,
            source_instance: "synthetic-explicit-source".into(),
            source_session_id: "s1".into(),
            source_format: "synthetic-jsonl/v1".into(),
            adapter_revision: "raw/1".into(),
            title: Some("Original title".into()),
            created_at: None,
            updated_at: None,
            project: Some("/source/project".into()),
            archived: true,
            parent_session_id: None,
        },
        source_bytes: total,
        source_sha256: sha256,
        record_limit: EXTERNAL_HISTORY_MAX_RECORDS,
    };
    let store = ExternalHistoryStore::open(root).unwrap();
    let mut import = store
        .begin("normalize-selected-history", &snapshot)
        .unwrap();
    import.stage_source(input, &mut |_| true).unwrap();
    let receipt = import.finish(&mut |_| true).unwrap().receipt;
    (
        store.reader(&receipt.archive_id).unwrap(),
        receipt.archive_id,
    )
}

fn lines(records: impl IntoIterator<Item = Value>) -> Vec<u8> {
    let mut bytes = vec![];
    for value in records {
        serde_json::to_writer(&mut bytes, &value).unwrap();
        bytes.push(b'\n');
    }
    bytes
}

#[test]
fn v4_resume_keeps_its_original_patch_interpretation_and_v5_uses_a_separate_projection() {
    let root = tempfile::tempdir().unwrap();
    let bytes = lines([
        json!({"type":"session_meta","payload":{"id":"s1","cli_version":CODEX_ROLLOUT_BASELINE}}),
        json!({"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"patch-one","success":true,"status":"completed"}}),
        json!({"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"patch-two","success":false,"status":"failed"}}),
    ]);
    let (reader, archive_id) = archive(root.path(), MigrationSourceKind::Codex, &bytes);
    let mut old =
        HistoryNormalizer::open_with_revision(reader, HISTORY_NORMALIZATION_REVISION_V4).unwrap();
    let checkpoint = old.step(2, |_| true).unwrap();
    assert_eq!(checkpoint.normalized_records, 2);
    assert!(!checkpoint.normalization_complete);
    drop(old);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let reader = store.reader(&archive_id).unwrap();
    let old_projection = reader
        .projection(HISTORY_NORMALIZATION_REVISION_V4, false)
        .unwrap()
        .unwrap();
    let before = serde_json::to_value(old_projection.record(1).unwrap()).unwrap();
    drop(old_projection);
    drop(reader);
    let mut resumed = HistoryNormalizer::open_with_revision(
        store.reader(&archive_id).unwrap(),
        HISTORY_NORMALIZATION_REVISION_V4,
    )
    .unwrap();
    assert_eq!(resumed.progress().unwrap(), checkpoint);
    let old_ready = resumed.step(10, |_| true).unwrap();
    assert!(old_ready.normalization_complete);
    drop(resumed);
    let reader = store.reader(&archive_id).unwrap();
    let old_projection = reader
        .projection(HISTORY_NORMALIZATION_REVISION_V4, false)
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(old_projection.record(1).unwrap()).unwrap(),
        before
    );
    for index in [1, 2] {
        assert!(matches!(
            old_projection.record(index).unwrap().data,
            HistoricalRecordData::Event { outcome: None, .. }
        ));
    }
    drop(old_projection);
    drop(reader);
    let mut current = HistoryNormalizer::open(store.reader(&archive_id).unwrap()).unwrap();
    assert_eq!(current.progress().unwrap().normalized_records, 0);
    assert!(current.step(10, |_| true).unwrap().normalization_complete);
    drop(current);
    let reader = store.reader(&archive_id).unwrap();
    let current = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    assert!(matches!(
        current.record(1).unwrap().data,
        HistoricalRecordData::Event {
            outcome: Some(HistoricalToolOutcome::RecordedSuccess),
            ..
        }
    ));
    assert!(matches!(
        current.record(2).unwrap().data,
        HistoricalRecordData::Event {
            outcome: Some(HistoricalToolOutcome::RecordedError),
            ..
        }
    ));
    drop(current);
    drop(reader);
    let mut old_sealed = HistoryNormalizer::open_with_revision(
        store.reader(&archive_id).unwrap(),
        HISTORY_NORMALIZATION_REVISION_V4,
    )
    .unwrap();
    assert_eq!(
        old_sealed
            .step(10, |_| panic!("sealed /4 cannot be reinterpreted"))
            .unwrap(),
        old_ready
    );
    drop(old_sealed);
    let reader = store.reader(&archive_id).unwrap();
    let old_projection = reader
        .projection(HISTORY_NORMALIZATION_REVISION_V4, false)
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(old_projection.record(1).unwrap()).unwrap(),
        before
    );
}

#[test]
fn explicit_legacy_v3_normalization_does_not_acquire_v5_execution_facts_or_diagnostics() {
    let root = tempfile::tempdir().unwrap();
    let bytes = lines([
        json!({"type":"session_meta","payload":{"id":"s1","cli_version":CODEX_ROLLOUT_BASELINE}}),
        json!({"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"patch-one","success":true,"status":"failed"}}),
    ]);
    let (reader, id) = archive(root.path(), MigrationSourceKind::Codex, &bytes);
    let mut legacy =
        HistoryNormalizer::open_with_revision(reader, LEGACY_HISTORY_NORMALIZATION_REVISION)
            .unwrap();
    assert!(legacy.step(10, |_| true).unwrap().normalization_complete);
    drop(legacy);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let reader = store.reader(&id).unwrap();
    let projection = reader
        .projection(LEGACY_HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let record = projection.record(1).unwrap();
    assert!(matches!(
        record.data,
        HistoricalRecordData::Event { outcome: None, .. }
    ));
    assert!(record.diagnostics.is_empty());
}

#[test]
fn restart_uses_durable_record_cursor_and_does_not_create_native_sessions() {
    let root = tempfile::tempdir().unwrap();
    let bytes=lines((0..23).map(|id|json!({"type":"assistant","uuid":format!("m{id}"),"parentUuid":(id>0).then(||format!("m{}",id-1)),"sessionId":"s1","version":CLAUDE_TRANSCRIPT_BASELINE,"message":{"role":"assistant","content":[{"type":"text","text":format!("Historical {id}")}]}})));
    let (reader, id) = archive(root.path(), MigrationSourceKind::ClaudeCode, &bytes);
    let mut normalizer = HistoryNormalizer::open(reader).unwrap();
    let saved = normalizer.step(4, |_| true).unwrap();
    assert_eq!(saved.normalized_records, 4);
    assert!(!saved.normalization_complete);
    drop(normalizer);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let reader = store.reader(&id).unwrap();
    let mut normalizer = HistoryNormalizer::open(reader).unwrap();
    assert_eq!(normalizer.progress().unwrap(), saved);
    assert!(normalizer.step(11, |_| true).is_err());
    while !normalizer.progress().unwrap().normalization_complete {
        normalizer.step(10, |_| true).unwrap();
    }
    drop(normalizer);
    let reader = store.reader(&id).unwrap();
    let projection = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let page = projection.page(10, 10).unwrap();
    assert_eq!(page.items.len(), 10);
    let value = page.items[0].value.as_ref().unwrap();
    assert_eq!(value.source_id.as_deref(), Some("m10"));
    assert_eq!(value.parent_id.as_deref(), Some("m9"));
    assert_eq!(projection.progress().unwrap().records_with_diagnostics, 0);
    assert_eq!(
        std::fs::read_dir(root.path()).unwrap().count(),
        1,
        "no native history or active tasks"
    );
    assert_eq!(reader.origin().title.as_deref(), Some("Original title"));
}

#[test]
fn cancellation_inside_a_long_record_retains_the_previous_commit_and_resumes() {
    let root = tempfile::tempdir().unwrap();
    let bytes = lines([
        json!({"type":"session_meta","payload":{"id":"s1","cli_version":CODEX_ROLLOUT_BASELINE}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"x".repeat(8*1024*1024)}]}}),
        json!({"type":"response_item","payload":{"type":"function_call","name":"write","call_id":"c1","arguments":"{\"file_path\":\"NEVER_CREATED\",\"content\":\"historical\"}"}}),
    ]);
    let (reader, id) = archive(root.path(), MigrationSourceKind::Codex, &bytes);
    let mut normalizer = HistoryNormalizer::open(reader).unwrap();
    let mut observed_bytes = 0;
    assert!(
        normalizer
            .step(10, |progress| {
                if progress.current_record == Some(1) {
                    observed_bytes = observed_bytes.max(progress.current_record_bytes);
                }
                !(progress.current_record == Some(1) && progress.current_record_bytes >= 64 * 1024)
            })
            .is_err()
    );
    assert!(observed_bytes >= 64 * 1024);
    assert_eq!(normalizer.progress().unwrap().normalized_records, 1);
    drop(normalizer);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let mut normalizer = HistoryNormalizer::open(store.reader(&id).unwrap()).unwrap();
    assert!(
        normalizer
            .step(10, |_| true)
            .unwrap()
            .normalization_complete
    );
    drop(normalizer);
    let projection = store
        .reader(&id)
        .unwrap()
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let record = projection.record(1).unwrap();
    let HistoricalRecordData::Message { blocks, .. } = record.data else {
        panic!("message")
    };
    let HistoricalBlock::Text { value } = &blocks[0] else {
        panic!("text")
    };
    assert_eq!(value.decoded_bytes, Some(8 * 1024 * 1024));
    assert_eq!(value.preview.as_ref().unwrap().len(), 4096);
    assert!(!root.path().join("NEVER_CREATED").exists());
    assert_eq!(projection.page(0, 10).unwrap().items.len(), 3);
}

#[test]
fn malformed_unknown_and_missing_results_are_retained_without_becoming_successful_execution() {
    let root = tempfile::tempdir().unwrap();
    let mut bytes = lines([
        json!({"type":"session_meta","payload":{"id":"s1","cli_version":"999.0.0"}}),
        json!({"type":"response_item","payload":{"type":"function_call","name":"PowerShell","call_id":"unsettled","arguments":"{}"}}),
        json!({"type":"future_vendor_event","payload":{"private":"MALFORMED-CANARY"}}),
    ]);
    bytes.extend_from_slice(b"{broken tail MALFORMED-CANARY");
    let (reader, id) = archive(root.path(), MigrationSourceKind::Codex, &bytes);
    let mut normalizer = HistoryNormalizer::open(reader).unwrap();
    let progress = normalizer.step(10, |_| true).unwrap();
    assert!(progress.normalization_complete);
    assert_eq!(progress.normalized_records, 4);
    assert_eq!(progress.records_with_diagnostics, 2);
    drop(normalizer);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let projection = store
        .reader(&id)
        .unwrap()
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    assert!(
        matches!(projection.record(1).unwrap().data,HistoricalRecordData::Message {blocks,..} if matches!(&blocks[0],HistoricalBlock::ToolCall {call_id,..} if call_id=="unsettled"))
    );
    assert!(projection.record(0).unwrap().diagnostics.is_empty());
    assert!(
        projection
            .record(2)
            .unwrap()
            .diagnostics
            .iter()
            .any(|issue| issue.blocks_continuation)
    );
    let tail = projection.record(3).unwrap();
    assert!(matches!(tail.data, HistoricalRecordData::Unknown { .. }));
    assert!(
        tail.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.blocks_continuation)
    );
    assert!(
        !serde_json::to_string(&tail)
            .unwrap()
            .contains("MALFORMED-CANARY")
    );
}

#[test]
fn normalization_rejects_changed_archived_bytes_instead_of_hiding_an_io_failure() {
    let root = tempfile::tempdir().unwrap();
    let bytes = lines([
        json!({"type":"session_meta","payload":{"id":"s1","cli_version":CODEX_ROLLOUT_BASELINE}}),
    ]);
    let (reader, id) = archive(root.path(), MigrationSourceKind::Codex, &bytes);
    let mut normalizer = HistoryNormalizer::open(reader).unwrap();
    let file = root
        .path()
        .join("external-history")
        .join(id)
        .join("source.bin");
    let changed = vec![b' '; bytes.len()];
    std::fs::write(file, changed).unwrap();
    assert!(normalizer.step(10, |_| true).is_err());
    assert_eq!(normalizer.progress().unwrap().normalized_records, 0);
}

#[test]
fn a_different_source_session_is_a_diagnostic_not_silently_rebound() {
    let root = tempfile::tempdir().unwrap();
    let bytes = lines([
        json!({"type":"user","uuid":"u","sessionId":"different","version":CLAUDE_TRANSCRIPT_BASELINE,"message":{"content":"foreign"}}),
    ]);
    let (reader, id) = archive(root.path(), MigrationSourceKind::ClaudeCode, &bytes);
    let mut normalizer = HistoryNormalizer::open(reader).unwrap();
    assert_eq!(
        normalizer
            .step(10, |_| true)
            .unwrap()
            .records_with_diagnostics,
        1
    );
    drop(normalizer);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let record = store
        .reader(&id)
        .unwrap()
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap()
        .record(0)
        .unwrap();
    assert_eq!(record.source_session_id.as_deref(), Some("different"));
    assert!(
        record
            .diagnostics
            .iter()
            .any(|d| d.code == "source_session_identity_mismatch" && d.blocks_continuation)
    );
}

struct LargeJson {
    prefix: std::io::Cursor<&'static [u8]>,
    remaining: u64,
    suffix: std::io::Cursor<&'static [u8]>,
}
impl LargeJson {
    const PREFIX:&'static [u8]=b"{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"";
    const SUFFIX: &'static [u8] = b"\"}]}}\n";
    fn new(bytes: u64) -> Self {
        Self {
            prefix: std::io::Cursor::new(Self::PREFIX),
            remaining: bytes,
            suffix: std::io::Cursor::new(Self::SUFFIX),
        }
    }
}
impl Read for LargeJson {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let count = self.prefix.read(output)?;
        if count > 0 {
            return Ok(count);
        }
        if self.remaining > 0 {
            let count = output.len().min(self.remaining as usize);
            output[..count].fill(b'x');
            self.remaining -= count as u64;
            return Ok(count);
        }
        self.suffix.read(output)
    }
}

#[cfg(target_os = "linux")]
fn peak_kib() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .unwrap()
        .lines()
        .find_map(|line| {
            line.strip_prefix("VmHWM:")
                .and_then(|value| value.split_whitespace().next()?.parse().ok())
        })
        .unwrap()
}

#[test]
#[ignore = "manual 500 MiB immutable archive and normalized-record memory measurement"]
fn large_history_normalization_keeps_memory_bounded() {
    let root = tempfile::tempdir().unwrap();
    #[cfg(target_os = "linux")]
    let start = std::time::Instant::now();
    #[cfg(target_os = "linux")]
    let peak_before = peak_kib();
    let payload = 500 * 1024 * 1024;
    let mut source = LargeJson::new(payload);
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = source.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let total = payload + LargeJson::PREFIX.len() as u64 + LargeJson::SUFFIX.len() as u64;
    let (reader, id) = archive_stream(
        root.path(),
        MigrationSourceKind::Codex,
        total,
        format!("{:x}", digest.finalize()),
        &mut LargeJson::new(payload),
    );
    let mut normalizer = HistoryNormalizer::open(reader).unwrap();
    let cancellation_start = std::time::Instant::now();
    let mut cancelled_after_bytes = 0;
    assert!(
        normalizer
            .step(1, |progress| {
                cancelled_after_bytes = progress.current_record_bytes;
                progress.current_record_bytes < 128 * 1024
            })
            .is_err()
    );
    let cancellation_ms = cancellation_start.elapsed().as_millis();
    assert!(cancelled_after_bytes >= 128 * 1024);
    assert!(
        cancellation_ms < 5000,
        "owned normalization must stop promptly"
    );
    assert_eq!(normalizer.progress().unwrap().normalized_records, 0);
    drop(normalizer);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let mut normalizer = HistoryNormalizer::open(store.reader(&id).unwrap()).unwrap();
    let mut checks = 0;
    assert!(
        normalizer
            .step(1, |_| {
                checks += 1;
                true
            })
            .unwrap()
            .normalization_complete
    );
    drop(normalizer);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let projection = store
        .reader(&id)
        .unwrap()
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let record = projection.record(0).unwrap();
    assert!(serde_json::to_vec(&record).unwrap().len() < 16 * 1024);
    assert!(checks > 1000);
    let HistoricalRecordData::Message { blocks, .. } = record.data else {
        panic!("message")
    };
    assert!(
        matches!(&blocks[0],HistoricalBlock::Text {value} if value.decoded_bytes==Some(payload))
    );
    #[cfg(target_os = "linux")]
    {
        let peak_after = peak_kib();
        assert!(
            peak_after.saturating_sub(peak_before) < 64 * 1024,
            "bounded source parsing must not collect the record"
        );
        println!(
            "{}",
            json!({"sourceBytes":total,"payloadBytes":payload,"peakBeforeKiB":peak_before,"peakAfterKiB":peak_after,"elapsedMs":start.elapsed().as_millis(),"progressChecks":checks,"cancellationMs":cancellation_ms,"cancelledAfterBytes":cancelled_after_bytes})
        );
    }
}

#[test]
fn version_independent_interpretation_preserves_existing_v5_projections() {
    for (source, record, version) in [
        (
            MigrationSourceKind::ClaudeCode,
            json!({"type":"user","uuid":"u","sessionId":"s1","version":"2.1.191","message":{"role":"user","content":"original source text"}}),
            "2.1.191",
        ),
        (
            MigrationSourceKind::Codex,
            json!({"type":"session_meta","payload":{"id":"s1","cli_version":"999.0.0"}}),
            "999.0.0",
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let bytes = lines([record]);
        let (reader, id) = archive(root.path(), source, &bytes);
        let mut old =
            HistoryNormalizer::open_with_revision(reader, HISTORY_NORMALIZATION_REVISION_V5)
                .unwrap();
        old.step(10, |_| true).unwrap();
        drop(old);
        let store = ExternalHistoryStore::open_existing(root.path())
            .unwrap()
            .unwrap();
        let old_record = || {
            let reader = store.reader(&id).unwrap();
            reader
                .projection(HISTORY_NORMALIZATION_REVISION_V5, false)
                .unwrap()
                .unwrap()
                .record(0)
                .unwrap()
        };
        let before = old_record();
        assert!(
            before
                .diagnostics
                .iter()
                .any(|issue| issue.code.starts_with("unsupported_")
                    && issue.code.ends_with("_source_version"))
        );
        let mut current = HistoryNormalizer::open(store.reader(&id).unwrap()).unwrap();
        current.step(10, |_| true).unwrap();
        drop(current);
        let reader = store.reader(&id).unwrap();
        let current = reader
            .projection(HISTORY_NORMALIZATION_REVISION, false)
            .unwrap()
            .unwrap()
            .record(0)
            .unwrap();
        assert_eq!(current.source_version.as_deref(), Some(version));
        assert!(
            !current
                .diagnostics
                .iter()
                .any(|issue| issue.code.ends_with("_source_version"))
        );
        assert_eq!(
            serde_json::to_value(old_record()).unwrap(),
            serde_json::to_value(before).unwrap()
        );
    }
}

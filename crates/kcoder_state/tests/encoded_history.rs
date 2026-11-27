use kcoder_state::external_history::ExternalHistoryStore;
use kcoder_types::{external_history::*, migration::MigrationSourceKind};
use sha2::{Digest, Sha256};
use std::io::Read;

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn snapshot(logical: &[u8], original: &[u8]) -> ExternalHistorySnapshot {
    ExternalHistorySnapshot {
        origin: ExternalHistoryOrigin {
            source: MigrationSourceKind::Codex,
            source_instance: "owned-fixture".into(),
            source_session_id: "fixture-session".into(),
            source_artifact_id: None,
            source_format: "synthetic-zstd-jsonl".into(),
            adapter_revision: "raw/1".into(),
            title: None,
            created_at: None,
            updated_at: None,
            project: None,
            archived: false,
            parent_session_id: None,
        },
        source_bytes: logical.len() as u64,
        source_sha256: sha(logical),
        record_limit: EXTERNAL_HISTORY_MAX_RECORDS,
        original: Some(ExternalHistoryEncodedSource {
            encoding: ExternalHistoryEncoding::Zstd,
            bytes: original.len() as u64,
            sha256: sha(original),
        }),
    }
}
struct MustNotRead;
impl Read for MustNotRead {
    fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
        panic!("recovery must use its preserved original")
    }
}
fn compress(bytes: &[u8]) -> Vec<u8> {
    zstd::stream::encode_all(bytes, 1).unwrap()
}

#[test]
fn exact_original_and_all_concatenated_frames_are_preserved_and_indexed() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let logical = b"{\"first\":1}\n{\"second\":2}\n";
    let mut original = compress(&logical[..12]);
    original.extend(compress(&logical[12..]));
    let snapshot = snapshot(logical, &original);
    let mut job = store.begin("encoded", &snapshot).unwrap();
    assert!(job.stage_source(&mut &logical[..], &mut |_| true).is_err());
    assert!(job.decode_original_source(&mut |_| true).is_err());
    job.stage_original_source(&mut &original[..], &mut |_| true)
        .unwrap();
    let mut phases = Vec::new();
    job.decode_original_source(&mut |progress| {
        phases.push(progress.phase);
        true
    })
    .unwrap();
    assert!(phases.contains(&ExternalHistoryPhase::Decoding));
    assert!(phases.contains(&ExternalHistoryPhase::ReadingOriginal));
    let result = job.finish(&mut |_| true).unwrap();
    let reader = store.reader(&result.receipt.archive_id).unwrap();
    assert_eq!(
        reader
            .read_original_chunk(0, EXTERNAL_HISTORY_CHUNK_BYTES)
            .unwrap(),
        original
    );
    assert_eq!(reader.records(0, 10).unwrap().total_records, 2);
    assert_eq!(
        reader.read_record_chunk(1, 0, 1024).unwrap(),
        b"{\"second\":2}\n"
    );
    assert_eq!(
        result.receipt.original.as_ref().unwrap().source.sha256,
        sha(&original)
    );
    assert!(
        reader
            .read_original_chunk(0, EXTERNAL_HISTORY_CHUNK_BYTES + 1)
            .is_err()
    );
    drop(job);
    let mut reuse = store.begin("reuse", &snapshot).unwrap();
    reuse
        .stage_original_source(&mut MustNotRead, &mut |_| true)
        .unwrap();
    reuse.decode_original_source(&mut |_| true).unwrap();
    let reused = reuse.finish(&mut |_| true).unwrap();
    assert!(!reused.owns_archive);
    assert_eq!(reused.receipt, result.receipt);
}

#[test]
fn cancellation_after_original_copy_recovers_without_any_source_reader() {
    let root = tempfile::tempdir().unwrap();
    let snapshot_bytes = b"{\"owned\":true}\n";
    let original = compress(snapshot_bytes);
    let snapshot = snapshot(snapshot_bytes, &original);
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let mut job = store.begin("resume", &snapshot).unwrap();
    job.stage_original_source(&mut &original[..], &mut |_| true)
        .unwrap();
    assert!(job.decode_original_source(&mut |progress|progress.phase!=ExternalHistoryPhase::Decoding).is_err());
    let id = job.archive_id().to_owned();
    let session = job.session_id().to_owned();
    assert!(store.reader(&id).unwrap().receipt().unwrap().is_none());
    drop(job);
    drop(store);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let mut job = store.begin("resume", &snapshot).unwrap();
    assert_eq!(job.session_id(), session);
    job.stage_original_source(&mut MustNotRead, &mut |_| true)
        .unwrap();
    job.decode_original_source(&mut |_| true).unwrap();
    assert_eq!(job.finish(&mut |_| true).unwrap().receipt.archive_id, id);
}

#[test]
fn wrong_original_or_logical_digest_never_publishes_a_completion_receipt() {
    for wrong_original in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let store = ExternalHistoryStore::open(root.path()).unwrap();
        let original = compress(b"{}\n");
        let mut snapshot = snapshot(b"{}\n", &original);
        if wrong_original {
            snapshot.original.as_mut().unwrap().sha256 = "0".repeat(64);
        } else {
            snapshot.source_sha256 = "0".repeat(64);
        }
        let mut job = store.begin("wrong", &snapshot).unwrap();
        if wrong_original {
            assert!(
                job.stage_original_source(&mut &original[..], &mut |_| true)
                    .is_err()
            );
        } else {
            job.stage_original_source(&mut &original[..], &mut |_| true)
                .unwrap();
            assert!(job.decode_original_source(&mut |_| true).is_err());
        }
        assert!(job.finish(&mut |_| true).is_err());
        assert!(
            store
                .reader(job.archive_id())
                .unwrap()
                .receipt()
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn malformed_truncated_and_over_window_frames_never_become_ready() {
    let valid = compress(b"{}\n");
    let over_window = vec![0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x90, 0x01, 0x00, 0x00];
    let mut decoder =
        kcoder_state::external_history::codec::zstd_decoder(&over_window[..]).unwrap();
    assert!(
        decoder
            .read(&mut [0u8; 1])
            .err()
            .unwrap()
            .to_string()
            .to_lowercase()
            .contains("memory")
    );
    for original in [
        b"not a frame".to_vec(),
        valid[..valid.len() - 1].to_vec(),
        over_window,
    ] {
        let root = tempfile::tempdir().unwrap();
        let store = ExternalHistoryStore::open(root.path()).unwrap();
        let snapshot = snapshot(b"{}\n", &original);
        let mut job = store.begin("bad-frame", &snapshot).unwrap();
        job.stage_original_source(&mut &original[..], &mut |_| true)
            .unwrap();
        assert!(job.decode_original_source(&mut |_| true).is_err());
        assert!(job.finish(&mut |_| true).is_err());
    }
}

#[test]
fn decoded_size_claim_is_enforced_and_an_empty_document_still_preserves_its_frame() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let original = compress(b"{}\n");
    let mut small = snapshot(b"{}\n", &original);
    small.source_bytes = 1;
    let mut job = store.begin("too-small", &small).unwrap();
    job.stage_original_source(&mut &original[..], &mut |_| true)
        .unwrap();
    assert!(job.decode_original_source(&mut |_| true).is_err());
    assert!(job.finish(&mut |_| true).is_err());
    let original = compress(b"");
    let empty = snapshot(b"", &original);
    let mut job = store.begin("empty", &empty).unwrap();
    job.stage_original_source(&mut &original[..], &mut |_| true)
        .unwrap();
    job.decode_original_source(&mut |_| true).unwrap();
    let receipt = job.finish(&mut |_| true).unwrap().receipt;
    assert_eq!(receipt.record_count, 0);
    assert_eq!(
        store
            .reader(&receipt.archive_id)
            .unwrap()
            .read_original_chunk(0, 1024)
            .unwrap(),
        original
    );
}

#[test]
fn decoder_checks_cancellation_even_when_skippable_frames_produce_no_output() {
    let logical = b"{}\n";
    let mut original = 0x184d2a50u32.to_le_bytes().to_vec();
    original.extend((1024 * 1024u32).to_le_bytes());
    original.extend(vec![b'x'; 1024 * 1024]);
    original.extend(compress(logical));
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let snapshot = snapshot(logical, &original);
    let mut job = store.begin("skippable", &snapshot).unwrap();
    job.stage_original_source(&mut &original[..], &mut |_| true)
        .unwrap();
    let error = job
        .decode_original_source(&mut |progress| {
            !(progress.phase == ExternalHistoryPhase::ReadingOriginal
                && progress.processed_bytes >= 64 * 1024)
        })
        .err()
        .unwrap();
    assert!(error.to_string().contains("cancelled"));
    assert!(
        store
            .reader(job.archive_id())
            .unwrap()
            .receipt()
            .unwrap()
            .is_none()
    );
    job.decode_original_source(&mut |_| true).unwrap();
    assert_eq!(job.finish(&mut |_| true).unwrap().receipt.record_count, 1);
}

#[test]
fn original_corruption_is_not_repaired_by_replaying_an_external_source() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let original = compress(b"{}\n");
    let snapshot = snapshot(b"{}\n", &original);
    let mut job = store.begin("corrupt", &snapshot).unwrap();
    job.stage_original_source(&mut &original[..], &mut |_| true)
        .unwrap();
    job.decode_original_source(&mut |_| true).unwrap();
    let receipt = job.finish(&mut |_| true).unwrap().receipt;
    drop(job);
    let path = root
        .path()
        .join("external-history")
        .join(&receipt.archive_id)
        .join("original.bin");
    let mut corrupt = original;
    corrupt[0] ^= 1;
    std::fs::write(path, corrupt).unwrap();
    assert!(
        store
            .reader(&receipt.archive_id)
            .unwrap()
            .read_original_chunk(0, 1024)
            .is_err()
    );
    let mut retry = store.begin("corrupt", &snapshot).unwrap();
    assert!(
        retry
            .stage_original_source(&mut MustNotRead, &mut |_| true)
            .is_err()
    );
}

#[test]
fn committed_receipt_remains_authoritative_when_staging_metadata_is_missing() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let original = compress(b"{}\n");
    let snapshot = snapshot(b"{}\n", &original);
    let mut job = store.begin("receipt", &snapshot).unwrap();
    job.stage_original_source(&mut &original[..], &mut |_| true)
        .unwrap();
    job.decode_original_source(&mut |_| true).unwrap();
    let receipt = job.finish(&mut |_| true).unwrap().receipt;
    drop(job);
    std::fs::remove_file(
        root.path()
            .join("external-history")
            .join(&receipt.archive_id)
            .join("original.json"),
    )
    .unwrap();
    let mut retry = store.begin("receipt", &snapshot).unwrap();
    retry
        .stage_original_source(&mut MustNotRead, &mut |_| true)
        .unwrap();
    assert_eq!(retry.finish(&mut |_| true).unwrap().receipt, receipt);
}

use kcoder_state::external_history::ExternalHistoryStore;
use kcoder_types::{external_history::*, historical_attachment::*, migration::MigrationSourceKind};
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Read},
    path::PathBuf,
};

struct Fixture {
    root: tempfile::TempDir,
    archive: String,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let store = ExternalHistoryStore::open(root.path()).unwrap();
        let source = b"{\"foreign\":true}\n";
        let snapshot = ExternalHistorySnapshot {
            original: None,
            source_bytes: source.len() as u64,
            source_sha256: format!("{:x}", Sha256::digest(source)),
            record_limit: EXTERNAL_HISTORY_MAX_RECORDS,
            origin: ExternalHistoryOrigin {
                source: MigrationSourceKind::Codex,
                source_artifact_id: None,
                source_instance: "fixture".into(),
                source_session_id: "foreign".into(),
                source_format: "synthetic/1".into(),
                adapter_revision: "synthetic/1".into(),
                title: None,
                created_at: None,
                updated_at: None,
                project: None,
                archived: false,
                parent_session_id: None,
            },
        };
        let mut pending = store.begin("owned-request", &snapshot).unwrap();
        pending
            .stage_source(&mut Cursor::new(source), &mut |_| true)
            .unwrap();
        let archive = pending.finish(&mut |_| true).unwrap().receipt.archive_id;
        Self { root, archive }
    }
    fn reader(&self) -> kcoder_state::external_history::ExternalHistoryReader {
        ExternalHistoryStore::open(self.root.path())
            .unwrap()
            .reader(&self.archive)
            .unwrap()
    }
    fn blob_dir(&self, id: &str) -> PathBuf {
        self.root
            .path()
            .join("external-history")
            .join(&self.archive)
            .join("attachments-v1")
            .join(id)
    }
}

#[test]
fn blobs_stream_cross_chunk_boundaries_reopen_and_never_reconsume_a_committed_input() {
    let f = Fixture::new();
    let id = "a".repeat(64);
    let payload: Vec<u8> = (0..700_001).map(|i| (i % 251) as u8).collect();
    let reader = f.reader();
    let mut blob = reader.attachment_blob(&id, true).unwrap().unwrap();
    let receipt = blob
        .publish(
            &mut Cursor::new(&payload),
            HISTORICAL_ATTACHMENT_MAX_BYTES,
            |_| true,
        )
        .unwrap();
    assert_eq!(receipt.bytes, payload.len() as u64);
    assert_eq!(receipt.sha256, format!("{:x}", Sha256::digest(&payload)));
    let at = HISTORICAL_ATTACHMENT_CHUNK_BYTES - 13;
    assert_eq!(
        blob.read_chunk(at as u64, 100).unwrap(),
        payload[at..at + 100]
    );
    assert!(
        blob.read_chunk(0, HISTORICAL_ATTACHMENT_CHUNK_BYTES + 1)
            .is_err()
    );
    assert!(blob.read_chunk(payload.len() as u64 + 1, 1).is_err());
    assert!(blob.read_chunk(payload.len() as u64, 1).unwrap().is_empty());
    struct NeverRead;
    impl Read for NeverRead {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            panic!("committed payload must not be replayed")
        }
    }
    assert_eq!(
        blob.publish(&mut NeverRead, HISTORICAL_ATTACHMENT_MAX_BYTES, |_| true)
            .unwrap(),
        receipt
    );
    drop(blob);
    drop(reader);
    let reopened = f.reader().attachment_blob(&id, false).unwrap().unwrap();
    assert_eq!(reopened.receipt().unwrap(), Some(receipt));
    assert_eq!(reopened.read_chunk(0, 4).unwrap(), payload[..4]);
}

#[test]
fn cancellation_limits_and_lost_receipts_reconcile_without_replacing_payloads() {
    let f = Fixture::new();
    let id = "b".repeat(64);
    let reader = f.reader();
    let mut blob = reader.attachment_blob(&id, true).unwrap().unwrap();
    let payload = vec![7u8; 400_000];
    assert!(
        blob.publish(
            &mut Cursor::new(&payload),
            HISTORICAL_ATTACHMENT_MAX_BYTES,
            |at| at < 100_000
        )
        .is_err()
    );
    assert!(blob.receipt().unwrap().is_none());
    assert!(!f.blob_dir(&id).join("payload.bin").exists());
    assert!(
        blob.publish(&mut Cursor::new(&payload), 12, |_| true)
            .is_err()
    );
    assert!(blob.receipt().unwrap().is_none());
    let saved = blob
        .publish(
            &mut Cursor::new(&payload),
            HISTORICAL_ATTACHMENT_MAX_BYTES,
            |_| true,
        )
        .unwrap();
    std::fs::remove_file(f.blob_dir(&id).join("receipt.json")).unwrap();
    assert_eq!(
        blob.publish(
            &mut Cursor::new(&payload),
            HISTORICAL_ATTACHMENT_MAX_BYTES,
            |_| true
        )
        .unwrap(),
        saved
    );
    std::fs::remove_file(f.blob_dir(&id).join("receipt.json")).unwrap();
    let different = vec![8u8; payload.len()];
    assert!(
        blob.publish(
            &mut Cursor::new(different),
            HISTORICAL_ATTACHMENT_MAX_BYTES,
            |_| true
        )
        .is_err()
    );
    assert_eq!(
        std::fs::read(f.blob_dir(&id).join("payload.bin")).unwrap(),
        payload
    );
    assert!(blob.receipt().unwrap().is_none());
}

#[test]
fn empty_payloads_and_corruption_are_distinct_and_the_archive_range_is_bounded() {
    let f = Fixture::new();
    let reader = f.reader();
    let mut blob = reader
        .attachment_blob(&"c".repeat(64), true)
        .unwrap()
        .unwrap();
    assert_eq!(
        blob.publish(&mut Cursor::new([]), 0, |_| true)
            .unwrap()
            .bytes,
        0
    );
    assert!(blob.read_chunk(0, 1).unwrap().is_empty());
    drop(blob);
    let id = "d".repeat(64);
    let mut blob = reader.attachment_blob(&id, true).unwrap().unwrap();
    blob.publish(&mut Cursor::new(b"original"), 100, |_| true)
        .unwrap();
    std::fs::write(f.blob_dir(&id).join("payload.bin"), b"modified").unwrap();
    assert!(blob.read_chunk(0, 8).is_err());
    assert!(
        blob.publish(&mut Cursor::new(b"original"), 100, |_| true)
            .is_err()
    );
    let mut range = reader.open_record_range(0, 2, 4).unwrap();
    let mut bytes = Vec::new();
    range.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"fore");
    assert!(reader.open_record_range(0, u64::MAX, 2).is_err());
    assert!(reader.open_record_range(0, 1, u64::MAX).is_err());
}

#[test]
fn writer_ownership_does_not_block_readers_or_adopt_a_payload_without_its_binding() {
    let f = Fixture::new();
    let reader = f.reader();
    let id = "e".repeat(64);
    let mut blob = reader.attachment_blob(&id, true).unwrap().unwrap();
    assert!(reader.attachment_blob(&id, true).is_err());
    assert!(
        reader
            .attachment_blob(&id, false)
            .unwrap()
            .unwrap()
            .receipt()
            .unwrap()
            .is_none()
    );
    blob.publish(&mut Cursor::new(b"known"), 100, |_| true)
        .unwrap();
    drop(blob);
    std::fs::remove_file(f.blob_dir(&id).join("binding.json")).unwrap();
    assert!(reader.attachment_blob(&id, true).is_err());
    assert_eq!(
        std::fs::read(f.blob_dir(&id).join("payload.bin")).unwrap(),
        b"known"
    );
    assert!(reader.attachment_blob("../../outside", true).is_err());
}

#[cfg(unix)]
#[test]
fn hard_links_symlinks_and_copied_directory_bindings_are_rejected() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let reader = f.reader();
    let id = "f".repeat(64);
    let mut blob = reader.attachment_blob(&id, true).unwrap().unwrap();
    blob.publish(&mut Cursor::new(b"private"), 100, |_| true)
        .unwrap();
    drop(blob);
    let outside = tempfile::tempdir().unwrap();
    let payload = f.blob_dir(&id).join("payload.bin");
    std::fs::hard_link(&payload, outside.path().join("alias")).unwrap();
    assert!(
        reader
            .attachment_blob(&id, false)
            .unwrap()
            .unwrap()
            .read_chunk(0, 1)
            .is_err()
    );
    std::fs::remove_file(outside.path().join("alias")).unwrap();
    std::fs::remove_file(&payload).unwrap();
    std::fs::write(outside.path().join("source"), b"private").unwrap();
    symlink(outside.path().join("source"), &payload).unwrap();
    assert!(
        reader
            .attachment_blob(&id, false)
            .unwrap()
            .unwrap()
            .read_chunk(0, 1)
            .is_err()
    );
    std::fs::remove_file(payload).unwrap();
    let old = f.blob_dir(&id).with_extension("old");
    std::fs::rename(f.blob_dir(&id), &old).unwrap();
    std::fs::create_dir(f.blob_dir(&id)).unwrap();
    std::fs::set_permissions(
        f.blob_dir(&id),
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .unwrap();
    for name in ["binding.json", "receipt.json"] {
        std::fs::copy(old.join(name), f.blob_dir(&id).join(name)).unwrap();
    }
    assert!(reader.attachment_blob(&id, false).is_err());
}

#[cfg(unix)]
#[test]
fn aggregate_budget_counts_unreceipted_payloads_before_admitting_another_writer() {
    let f = Fixture::new();
    let reader = f.reader();
    let id = "1".repeat(64);
    let mut blob = reader.attachment_blob(&id, true).unwrap().unwrap();
    blob.publish(&mut Cursor::new(b"small"), 100, |_| true)
        .unwrap();
    drop(blob);
    std::fs::remove_file(f.blob_dir(&id).join("receipt.json")).unwrap();
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(f.blob_dir(&id).join("payload.bin"))
        .unwrap();
    // Sparse length exercises the accounting limit without allocating the represented bytes.
    file.set_len(20 * 1024 * 1024 * 1024 + 1).unwrap();
    drop(file);
    assert!(reader.attachment_blob(&"2".repeat(64), true).is_err());
    assert!(reader.attachment_blob(&id, true).is_err());
    assert!(!f.blob_dir(&"2".repeat(64)).exists());
}

#[test]
fn cancellation_before_blob_admission_does_not_create_an_attachment_directory() {
    let f = Fixture::new();
    let reader = f.reader();
    let id = "3".repeat(64);
    assert!(
        reader
            .attachment_blob_with_check(&id, true, || false)
            .is_err()
    );
    assert!(!f.blob_dir(&id).exists());
}

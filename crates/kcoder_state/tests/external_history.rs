use kcoder_state::external_history::ExternalHistoryStore;
use kcoder_types::{external_history::*, migration::MigrationSourceKind};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};

fn snapshot(bytes: &[u8]) -> ExternalHistorySnapshot {
    ExternalHistorySnapshot {
        original: None,
        origin: ExternalHistoryOrigin {
            source: MigrationSourceKind::Codex,
            source_artifact_id: None,
            source_instance: "synthetic-selected-root".into(),
            source_session_id: "foreign-session".into(),
            source_format: "synthetic-jsonl/v1".into(),
            adapter_revision: "fixture/1".into(),
            title: Some("原标题 / imported title".into()),
            created_at: Some("2026-10-15T12:00:00Z".into()),
            updated_at: None,
            project: Some("/selected/project".into()),
            archived: true,
            parent_session_id: Some("foreign-parent".into()),
        },
        source_bytes: bytes.len() as u64,
        source_sha256: format!("{:x}", Sha256::digest(bytes)),
        record_limit: EXTERNAL_HISTORY_MAX_RECORDS,
    }
}

#[test]
fn exact_archive_preserves_unknown_lines_tail_metadata_and_ten_record_pages() {
    let root = tempfile::tempdir().unwrap();
    let mut bytes = Vec::new();
    for ordinal in 0..23 {
        writeln!(
            &mut bytes,
            "{{\"unknown_record\":{ordinal},\"text\":\"中文\"}}"
        )
        .unwrap();
    }
    bytes.extend_from_slice(b"\n{broken trailing bytes");
    let original = bytes.clone();
    let selected = snapshot(&bytes);
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let mut import = store.begin("request-1", &selected).unwrap();
    assert_ne!(import.session_id(), selected.origin.source_session_id);
    let id = import.archive_id().to_string();
    let reader = store.reader(&id).unwrap();
    assert!(reader.receipt().unwrap().is_none());
    assert!(reader.records(0, 10).is_err());
    import
        .stage_source(&mut Cursor::new(bytes), &mut |_| true)
        .unwrap();
    assert!(
        reader.receipt().unwrap().is_none(),
        "a staged snapshot is not a committed import"
    );
    let committed = import.finish(&mut |_| true).unwrap();
    assert!(committed.owns_archive);
    assert_eq!(committed.receipt.record_count, 25);
    assert_eq!(reader.origin().title, selected.origin.title);
    assert_eq!(
        reader.origin().parent_session_id,
        selected.origin.parent_session_id
    );
    assert!(reader.origin().archived);
    let mut recovered = Vec::new();
    let mut cursor = 0;
    let mut page_sizes = Vec::new();
    loop {
        let page = reader.records(cursor, 10).unwrap();
        page_sizes.push(page.records.len());
        for record in page.records {
            let content = reader
                .read_record_chunk(record.ordinal, 0, EXTERNAL_HISTORY_CHUNK_BYTES)
                .unwrap();
            assert_eq!(format!("{:x}", Sha256::digest(&content)), record.sha256);
            assert_eq!(record.newline_terminated, content.ends_with(b"\n"));
            recovered.extend(content);
        }
        let Some(next) = page.next_cursor else {
            break;
        };
        cursor = next;
    }
    assert_eq!(page_sizes, [10, 10, 5]);
    assert_eq!(recovered, original);
    assert!(reader.records(0, 11).is_err());
    assert!(reader.records(26, 10).is_err());
    assert!(
        reader
            .read_record_chunk(0, 0, EXTERNAL_HISTORY_CHUNK_BYTES + 1)
            .is_err()
    );
    assert_eq!(
        std::fs::read_dir(root.path()).unwrap().count(),
        1,
        "no native history, tasks, or active session created"
    );
}

struct UnreadableSource;

#[test]
fn pinned_record_cursor_bounds_each_read_and_reuses_only_authenticated_blocks() {
    let root = tempfile::tempdir().unwrap();
    let large = vec![b'x'; 2 * EXTERNAL_HISTORY_CHUNK_BYTES + 19];
    let mut bytes = b"first\n".to_vec();
    bytes.extend_from_slice(&large);
    bytes.extend_from_slice(b"\nlast without newline");
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let mut import = store.begin("cursor", &snapshot(&bytes)).unwrap();
    import.stage_source(&mut &bytes[..], &mut |_| true).unwrap();
    let receipt = import.finish(&mut |_| true).unwrap().receipt;
    let reader = store.reader(&receipt.archive_id).unwrap();
    let mut cursor = reader.record_cursor().unwrap();
    for (ordinal, expected) in [
        (2, &bytes[large.len() + 7..]),
        (0, &bytes[..6]),
        (1, &bytes[6..large.len() + 7]),
    ] {
        let mut observed = Vec::new();
        let mut buffer = vec![0; EXTERNAL_HISTORY_CHUNK_BYTES];
        let record = cursor.record(ordinal).unwrap();
        loop {
            let count = record.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            assert!(count <= 64 * 1024);
            observed.extend_from_slice(&buffer[..count]);
        }
        assert_eq!(observed, expected);
    }
    assert!(cursor.record(3).is_err());
    let mut cursor = reader.record_cursor().unwrap();
    let mut prefix = [0; 1];
    cursor.record(1).unwrap().read_exact(&mut prefix).unwrap();
    let raw = root
        .path()
        .join("external-history")
        .join(&receipt.archive_id)
        .join("source.bin");
    let mut changed = bytes;
    changed[2 * EXTERNAL_HISTORY_CHUNK_BYTES + 1] = b'z';
    std::fs::write(raw, changed).unwrap();
    assert!(std::io::copy(cursor.record(1).unwrap(), &mut std::io::sink()).is_err());
}

impl Read for UnreadableSource {
    fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
        panic!("committed source must not be re-read");
    }
}

#[test]
fn restart_and_lost_receipt_reconcile_from_the_private_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let bytes = b"{\"old_tool_call\":\"write\"}\n{\"result\":\"unknown\"}\n";
    let selected = snapshot(bytes);
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let mut import = store.begin("request-1", &selected).unwrap();
    let session_id = import.session_id().to_string();
    import.stage_source(&mut &bytes[..], &mut |_| true).unwrap();
    drop(import);
    drop(store);
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let mut import = store.begin("request-1", &selected).unwrap();
    let first = import.finish(&mut |_| true).unwrap();
    assert_eq!(first.receipt.session_id, session_id);
    drop(import);
    let mut replay = store.begin("request-1", &selected).unwrap();
    replay
        .stage_source(&mut UnreadableSource, &mut |_| true)
        .unwrap();
    let second = replay.finish(&mut |_| true).unwrap();
    assert_eq!(second.receipt, first.receipt);
    assert!(second.owns_archive);
    drop(replay);
    let mut reuse = store.begin("request-2", &selected).unwrap();
    reuse
        .stage_source(&mut UnreadableSource, &mut |_| true)
        .unwrap();
    let reused = reuse.finish(&mut |_| true).unwrap();
    assert_eq!(reused.receipt, first.receipt);
    assert!(
        !reused.owns_archive,
        "reuse grants no original-operation deletion ownership"
    );
}

#[test]
fn cancellation_keeps_the_source_and_never_publishes_a_partial_archive() {
    let root = tempfile::tempdir().unwrap();
    let bytes = vec![b'x'; 2 * EXTERNAL_HISTORY_CHUNK_BYTES];
    let selected = snapshot(&bytes);
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let mut import = store.begin("cancelled", &selected).unwrap();
    let mut calls = 0;
    let result = import.stage_source(&mut Cursor::new(&bytes), &mut |_| {
        calls += 1;
        calls < 4
    });
    assert!(format!("{:#}", result.err().unwrap()).contains("external_history_cancelled"));
    let directory = root
        .path()
        .join("external-history")
        .join(import.archive_id());
    assert!(!directory.join("source.bin").exists());
    assert!(!directory.join("receipt.json").exists());
    assert!(
        std::fs::read_dir(&directory).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("tmp"))
    );
    import
        .stage_source(&mut Cursor::new(&bytes), &mut |_| true)
        .unwrap();
    assert!(import.finish(&mut |_| false).is_err());
    assert!(!directory.join("receipt.json").exists());
    assert_eq!(
        import.finish(&mut |_| true).unwrap().receipt.source_bytes,
        bytes.len() as u64
    );
}

#[test]
fn a_changed_source_or_reused_operation_never_overwrites_original_bytes() {
    let root = tempfile::tempdir().unwrap();
    let selected = snapshot(b"original\n");
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let mut import = store.begin("operation", &selected).unwrap();
    assert!(
        import
            .stage_source(&mut &b"modified\n"[..], &mut |_| true)
            .is_err()
    );
    assert!(
        !root
            .path()
            .join("external-history")
            .join(import.archive_id())
            .join("source.bin")
            .exists()
    );
    import
        .stage_source(&mut &b"original\n"[..], &mut |_| true)
        .unwrap();
    let receipt = import.finish(&mut |_| true).unwrap().receipt;
    drop(import);
    assert!(
        store
            .begin("operation", &snapshot(b"new revision\n"))
            .is_err()
    );
    let reader = store.reader(&receipt.archive_id).unwrap();
    assert_eq!(reader.read_record_chunk(0, 0, 128).unwrap(), b"original\n");
}

#[test]
fn oversized_records_are_preserved_and_read_in_verified_chunks() {
    let root = tempfile::tempdir().unwrap();
    let mut bytes = vec![b'x'; EXTERNAL_HISTORY_CHUNK_BYTES * 5 + 47];
    bytes.push(b'\n');
    bytes.extend_from_slice(b"next record");
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let mut import = store.begin("large", &snapshot(&bytes)).unwrap();
    import
        .stage_source(&mut Cursor::new(&bytes), &mut |_| true)
        .unwrap();
    let receipt = import.finish(&mut |_| true).unwrap().receipt;
    let reader = store.reader(&receipt.archive_id).unwrap();
    let page = reader.records(0, 10).unwrap();
    assert_eq!(page.records.len(), 2);
    assert_eq!(
        page.records[0].bytes,
        (EXTERNAL_HISTORY_CHUNK_BYTES * 5 + 48) as u64
    );
    assert_eq!(
        reader
            .read_record_chunk(0, 11, EXTERNAL_HISTORY_CHUNK_BYTES)
            .unwrap(),
        bytes[11..11 + EXTERNAL_HISTORY_CHUNK_BYTES]
    );
    assert!(
        reader
            .read_record_chunk(0, page.records[0].bytes, 1024)
            .unwrap()
            .is_empty()
    );
    assert_eq!(reader.read_record_chunk(1, 0, 128).unwrap(), b"next record");
}

#[test]
fn changed_archive_or_reference_index_fails_without_silent_repair() {
    for name in [
        "source.bin",
        "source-chunks.bin",
        "records.bin",
        "record-chunks.bin",
    ] {
        let root = tempfile::tempdir().unwrap();
        let store = ExternalHistoryStore::open(root.path()).unwrap();
        let selected = snapshot(b"original\n");
        let mut import = store.begin("one", &selected).unwrap();
        import
            .stage_source(&mut &b"original\n"[..], &mut |_| true)
            .unwrap();
        let receipt = import.finish(&mut |_| true).unwrap().receipt;
        drop(import);
        let path = root
            .path()
            .join("external-history")
            .join(&receipt.archive_id)
            .join(name);
        let mut content = std::fs::read(&path).unwrap();
        content[0] ^= 1;
        std::fs::write(&path, &content).unwrap();
        assert!(
            store
                .reader(&receipt.archive_id)
                .unwrap()
                .read_record_chunk(0, 0, 128)
                .is_err(),
            "{name}"
        );
        let mut replay = store.begin("one", &selected).unwrap();
        assert!(replay.finish(&mut |_| true).is_err(), "{name}");
        assert_eq!(std::fs::read(path).unwrap(), content);
    }
}

#[test]
fn pending_archives_are_exclusive_and_reuse_cannot_take_over_a_writer() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let selected = snapshot(b"content\n");
    let first = store.begin("one", &selected).unwrap();
    assert!(store.begin("one", &selected).is_err());
    assert!(store.begin("two", &selected).is_err());
    let reader = store.reader(first.archive_id()).unwrap();
    assert!(reader.receipt().unwrap().is_none());
    drop(first);
    assert!(store.begin("one", &selected).is_ok());
}

#[test]
fn observing_matching_json_after_a_lost_ownership_record_does_not_claim_deletion_rights() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let selected = snapshot(b"original\n");
    let mut import = store.begin("one", &selected).unwrap();
    import
        .stage_source(&mut &b"original\n"[..], &mut |_| true)
        .unwrap();
    let first = import.finish(&mut |_| true).unwrap().receipt;
    drop(import);
    let request = root
        .path()
        .join("external-history")
        .join(format!("request-{:x}.json", Sha256::digest(b"one")));
    std::fs::remove_file(request).unwrap();
    let recovered = store
        .begin("one", &selected)
        .unwrap()
        .finish(&mut |_| true)
        .unwrap();
    assert_eq!(recovered.receipt, first);
    assert!(!recovered.owns_archive);
}

#[test]
fn publication_intent_recovers_the_exact_prepared_directory_before_rename() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let selected = snapshot(b"original\n");
    let mut import = store.begin("one", &selected).unwrap();
    import
        .stage_source(&mut &b"original\n"[..], &mut |_| true)
        .unwrap();
    let id = import.archive_id().to_string();
    let session = import.session_id().to_string();
    drop(import);
    let directory = root.path().join("external-history");
    let request = directory.join(format!("request-{:x}.json", Sha256::digest(b"one")));
    let data: serde_json::Value = serde_json::from_slice(&std::fs::read(request).unwrap()).unwrap();
    let staging = data["staging_name"].as_str().unwrap();
    std::fs::rename(directory.join(&id), directory.join(staging)).unwrap();
    let recovered = store
        .begin("one", &selected)
        .unwrap()
        .finish(&mut |_| true)
        .unwrap();
    assert_eq!(recovered.receipt.session_id, session);
    assert!(recovered.owns_archive);
    assert!(!directory.join(staging).exists());
}

#[cfg(unix)]
#[test]
fn a_prepared_directory_with_a_live_writer_is_not_republished() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let selected = snapshot(b"original\n");
    let import = store.begin("one", &selected).unwrap();
    let id = import.archive_id().to_string();
    let directory = root.path().join("external-history");
    let request = directory.join(format!("request-{:x}.json", Sha256::digest(b"one")));
    let data: serde_json::Value = serde_json::from_slice(&std::fs::read(request).unwrap()).unwrap();
    let staging = data["staging_name"].as_str().unwrap();
    std::fs::rename(directory.join(&id), directory.join(staging)).unwrap();
    assert!(store.begin("one", &selected).is_err());
    assert!(!directory.join(&id).exists());
    assert!(directory.join(staging).exists());
    drop(import);
    assert!(store.begin("one", &selected).is_ok());
    assert!(directory.join(&id).exists());
}

#[test]
fn a_replaced_directory_cannot_inherit_an_old_requests_ownership() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let selected = snapshot(b"original\n");
    let mut import = store.begin("one", &selected).unwrap();
    import
        .stage_source(&mut &b"original\n"[..], &mut |_| true)
        .unwrap();
    let receipt = import.finish(&mut |_| true).unwrap().receipt;
    drop(import);
    let directory = root.path().join("external-history");
    let path = directory.join(&receipt.archive_id);
    let prior = directory.join("preserved");
    std::fs::rename(&path, &prior).unwrap();
    let parent = kcoder_config::PrivateDirectory::open_existing(&directory).unwrap();
    let replacement = parent
        .create_private_child(std::ffi::OsStr::new(&receipt.archive_id))
        .unwrap();
    for entry in std::fs::read_dir(prior).unwrap() {
        let entry = entry.unwrap();
        replacement
            .atomic_replace(&entry.file_name(), &std::fs::read(entry.path()).unwrap())
            .unwrap();
    }
    assert!(store.begin("one", &selected).is_err());
    assert_eq!(
        std::fs::read(path.join("source.bin")).unwrap(),
        b"original\n"
    );
}

#[test]
fn budgets_record_limits_and_empty_snapshots_are_explicit() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let mut selected = snapshot(b"first\nsecond\n");
    selected.source_bytes = EXTERNAL_HISTORY_MAX_BYTES + 1;
    assert!(store.begin("oversized", &selected).is_err());
    selected = snapshot(b"first\nsecond\n");
    selected.record_limit = 1;
    let mut import = store.begin("record-budget", &selected).unwrap();
    import
        .stage_source(&mut &b"first\nsecond\n"[..], &mut |_| true)
        .unwrap();
    assert!(
        format!("{:#}", import.finish(&mut |_| true).err().unwrap())
            .contains("record_budget_exceeded")
    );
    assert!(
        store
            .reader(import.archive_id())
            .unwrap()
            .receipt()
            .unwrap()
            .is_none()
    );
    let mut empty = store.begin("empty", &snapshot(b"")).unwrap();
    empty.stage_source(&mut &b""[..], &mut |_| true).unwrap();
    let receipt = empty.finish(&mut |_| true).unwrap().receipt;
    let page = store
        .reader(&receipt.archive_id)
        .unwrap()
        .records(0, 10)
        .unwrap();
    assert!(page.records.is_empty());
    assert_eq!(page.next_cursor, None);
}

#[test]
fn read_only_store_observation_does_not_create_a_directory() {
    let root = tempfile::tempdir().unwrap();
    assert!(
        ExternalHistoryStore::open_existing(root.path())
            .unwrap()
            .is_none()
    );
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    assert!(
        ExternalHistoryStore::open_existing(&root.path().join("missing"))
            .unwrap()
            .is_none()
    );
    assert!(!root.path().join("missing").exists());
}

#[test]
fn recovery_index_verification_remains_cancellable_before_receipt_publication() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let bytes = b"entry\n".repeat(100);
    let selected = snapshot(&bytes);
    let mut import = store.begin("recovery-cancel", &selected).unwrap();
    import.stage_source(&mut &bytes[..], &mut |_| true).unwrap();
    let receipt = import.finish(&mut |_| true).unwrap().receipt;
    let path = root
        .path()
        .join("external-history")
        .join(&receipt.archive_id)
        .join("receipt.json");
    std::fs::remove_file(&path).unwrap();
    let result = import.finish(&mut |progress| progress.phase != ExternalHistoryPhase::Verifying);
    assert!(result.is_err());
    assert!(!path.exists());
    assert_eq!(import.finish(&mut |_| true).unwrap().receipt, receipt);
}

#[cfg(unix)]
#[test]
fn raw_data_is_private_and_link_aliases_are_rejected() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let mut import = store.begin("one", &snapshot(b"original\n")).unwrap();
    import
        .stage_source(&mut &b"original\n"[..], &mut |_| true)
        .unwrap();
    let receipt = import.finish(&mut |_| true).unwrap().receipt;
    let path = root
        .path()
        .join("external-history")
        .join(&receipt.archive_id)
        .join("source.bin");
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let alias = root.path().join("alias");
    std::fs::hard_link(&path, &alias).unwrap();
    assert!(
        store
            .reader(&receipt.archive_id)
            .unwrap()
            .read_record_chunk(0, 0, 20)
            .is_err()
    );
    std::fs::remove_file(&alias).unwrap();
    std::fs::rename(&path, &alias).unwrap();
    symlink(&alias, &path).unwrap();
    assert!(
        store
            .reader(&receipt.archive_id)
            .unwrap()
            .read_record_chunk(0, 0, 20)
            .is_err()
    );
    assert!(store.reader("../alias").is_err());
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "manual 500 MiB archive I/O and bounded-memory acceptance"]
fn archive_500_mib_with_one_oversized_record_uses_bounded_memory() {
    fn peak_kib() -> u64 {
        std::fs::read_to_string("/proc/self/status")
            .unwrap()
            .lines()
            .find_map(|line| {
                line.strip_prefix("VmHWM:")
                    .and_then(|value| value.split_whitespace().next())
                    .and_then(|value| value.parse().ok())
            })
            .unwrap()
    }
    struct Pattern {
        remaining: u64,
        maximum_read: usize,
    }
    impl Read for Pattern {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.maximum_read = self.maximum_read.max(buffer.len());
            let count = self.remaining.min(buffer.len() as u64) as usize;
            buffer[..count].fill(b'x');
            self.remaining -= count as u64;
            Ok(count)
        }
    }
    let before = peak_kib();
    let began = std::time::Instant::now();
    let size = 500 * 1024 * 1024u64;
    let block = [b'x'; 64 * 1024];
    let mut digest = Sha256::new();
    for _ in 0..size / block.len() as u64 {
        digest.update(block);
    }
    let mut selected = snapshot(b"");
    selected.source_bytes = size;
    selected.source_sha256 = format!("{:x}", digest.finalize());
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let mut import = store.begin("performance", &selected).unwrap();
    let mut source = Pattern {
        remaining: size,
        maximum_read: 0,
    };
    import.stage_source(&mut source, &mut |_| true).unwrap();
    let receipt = import.finish(&mut |_| true).unwrap().receipt;
    assert_eq!(receipt.record_count, 1);
    assert_eq!(receipt.source_bytes, size);
    let reader = store.reader(&receipt.archive_id).unwrap();
    assert_eq!(
        reader
            .read_record_chunk(0, size / 2 + 7, EXTERNAL_HISTORY_CHUNK_BYTES)
            .unwrap(),
        vec![b'x'; EXTERNAL_HISTORY_CHUNK_BYTES]
    );
    let after = peak_kib();
    assert!(source.maximum_read <= 64 * 1024);
    assert!(
        after <= before + 32 * 1024,
        "archive buffers must not grow with a 500 MiB line: {before} -> {after}"
    );
    eprintln!(
        "ARCHIVE_PERFORMANCE {}",
        serde_json::json!({"sourceBytes":size,"recordCount":1,
        "maximumReadBytes":source.maximum_read,"peakBeforeKiB":before,"peakAfterKiB":after,"elapsedMs":began.elapsed().as_millis()})
    );
}

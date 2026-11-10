use super::*;
use crate::external_history::{ExternalHistoryReader, ExternalHistoryStore};
use kcoder_types::historical_attachment::HISTORICAL_ATTACHMENT_MAX_BYTES;
use std::{
    io::{Cursor, Read},
    sync::atomic::{AtomicUsize, Ordering as AtomicOrdering},
};

const MIB: u64 = 1024 * 1024;
fn fixture(
    files: u32,
    bytes: u64,
) -> (
    tempfile::TempDir,
    ExternalHistoryStore,
    ExternalHistoryReader,
    ResourceBudgetReference,
) {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let reference = store
        .prepare_resource_budget(
            "stream-batch",
            vec!["stream-history".into()],
            MigrationResourceLimits {
                max_total_bytes: bytes,
                max_payload_files: files,
                min_free_bytes: MIB,
                min_free_file_nodes: 0,
            },
        )
        .unwrap();
    let body = b"{\"fixture\":true}\n";
    let snapshot = super::super::archive::tests::snapshot(body);
    let mut archive = store.begin_managed("stream-history", &snapshot).unwrap();
    archive
        .stage_source(&mut Cursor::new(body), &mut |_| true)
        .unwrap();
    let committed = archive.finish(&mut |_| true).unwrap();
    drop(archive);
    let reader = store
        .reader_for_operation(&committed.receipt.archive_id, "stream-history")
        .unwrap();
    (root, store, reader, reference)
}

struct NeverRead(AtomicUsize);
impl Read for NeverRead {
    fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
        self.0.fetch_add(1, AtomicOrdering::Relaxed);
        Err(std::io::Error::other("fixture original source is offline"))
    }
}

#[test]
fn a_small_attachment_never_reserves_its_entire_hard_ceiling() {
    let (_root, store, reader, budget) = fixture(5, MIB);
    let before = store.resource_budget_usage(&budget).unwrap();
    let mut blob = reader
        .attachment_blob(&"a".repeat(64), true)
        .unwrap()
        .unwrap();
    let body = b"tiny native attachment";
    let receipt = blob
        .publish(
            &mut Cursor::new(body),
            HISTORICAL_ATTACHMENT_MAX_BYTES,
            |_| true,
        )
        .unwrap();
    assert_eq!(receipt.bytes, body.len() as u64);
    let after = store.resource_budget_usage(&budget).unwrap();
    assert_eq!(
        after.committed_bytes,
        before.committed_bytes + body.len() as u64
    );
    assert_eq!(after.committed_files, 5);
    assert_eq!((after.reserved_bytes, after.reserved_files), (0, 0));
    let mut unavailable = NeverRead(AtomicUsize::new(0));
    assert_eq!(
        blob.publish(&mut unavailable, HISTORICAL_ATTACHMENT_MAX_BYTES, |_| true)
            .unwrap(),
        receipt
    );
    assert_eq!(unavailable.0.load(AtomicOrdering::Relaxed), 0);
    assert_eq!(store.resource_budget_usage(&budget).unwrap(), after);
}

#[test]
fn interrupted_payload_keeps_its_original_watermark_and_reuses_it_after_reopen() {
    let (root, store, reader, budget) = fixture(5, 8 * MIB);
    let archive = reader.receipt().unwrap().unwrap().archive_id;
    let id = "b".repeat(64);
    let body = vec![b'x'; 3 * MIB as usize];
    let mut blob = reader.attachment_blob(&id, true).unwrap().unwrap();
    assert!(
        blob.publish(
            &mut Cursor::new(&body),
            HISTORICAL_ATTACHMENT_MAX_BYTES,
            |bytes| bytes < 128 * 1024
        )
        .is_err()
    );
    let interrupted = store.resource_budget_usage(&budget).unwrap();
    assert!(interrupted.reserved_bytes >= 128 * 1024);
    assert_eq!(interrupted.reserved_files, 1);
    assert!(blob.receipt().unwrap().is_none());
    drop(blob);
    drop(reader);
    drop(store);
    let reopened = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        reopened.recorded_resource_budget("stream-batch").unwrap(),
        Some(budget.clone())
    );
    assert_eq!(
        reopened.resource_budget_usage(&budget).unwrap(),
        interrupted
    );
    let reader = reopened
        .reader_for_operation(&archive, "stream-history")
        .unwrap();
    let mut blob = reader.attachment_blob(&id, true).unwrap().unwrap();
    let receipt = blob
        .publish(
            &mut Cursor::new(&body),
            HISTORICAL_ATTACHMENT_MAX_BYTES,
            |_| true,
        )
        .unwrap();
    assert_eq!(receipt.bytes, body.len() as u64);
    let after = reopened.resource_budget_usage(&budget).unwrap();
    assert_eq!((after.reserved_bytes, after.reserved_files), (0, 0));
    assert_eq!(after.committed_files, 5);
}

#[test]
fn empty_embedded_and_local_payloads_share_the_file_limit_before_input_is_read() {
    let (_root, store, reader, budget) = fixture(6, MIB);
    for (id, local) in [('c', false), ('d', true)] {
        let mut blob = reader
            .attachment_blob(&id.to_string().repeat(64), true)
            .unwrap()
            .unwrap();
        if local {
            blob.mark_local_resource();
        }
        blob.publish(
            &mut Cursor::new([]),
            HISTORICAL_ATTACHMENT_MAX_BYTES,
            |_| true,
        )
        .unwrap();
    }
    let before = store.resource_budget_usage(&budget).unwrap();
    assert_eq!(before.committed_files, 6);
    let mut blob = reader
        .attachment_blob(&"e".repeat(64), true)
        .unwrap()
        .unwrap();
    let mut input = NeverRead(AtomicUsize::new(0));
    assert_eq!(
        blob.publish(&mut input, HISTORICAL_ATTACHMENT_MAX_BYTES, |_| true)
            .unwrap_err()
            .to_string(),
        "history_resource_file_budget_exceeded"
    );
    assert_eq!(input.0.load(AtomicOrdering::Relaxed), 0);
    assert_eq!(store.resource_budget_usage(&budget).unwrap(), before);
}

#[test]
fn a_lost_growth_reply_reopens_the_same_native_stream_without_resetting_or_recharging_it() {
    let (root, store, reader, budget) = fixture(6, 2 * MIB);
    let archive = reader.receipt().unwrap().unwrap().archive_id;
    let native_identity = "f".repeat(64);
    let stream = reader
        .lifecycle
        .resource_stream(
            ResourceKind::DerivedIndex,
            &native_identity,
            8 * MIB,
            2,
            false,
        )
        .unwrap()
        .unwrap();
    stream.ensure_extent(1).unwrap();
    let before = store.resource_budget_usage(&budget).unwrap();
    assert_eq!(before.reserved_bytes, MIB);
    drop(stream);
    drop(reader);
    drop(store);
    let reopened = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let reader = reopened
        .reader_for_operation(&archive, "stream-history")
        .unwrap();
    let same = reader
        .lifecycle
        .resource_stream(
            ResourceKind::DerivedIndex,
            &native_identity,
            8 * MIB,
            2,
            true,
        )
        .unwrap()
        .unwrap();
    same.ensure_extent(1).unwrap();
    assert_eq!(reopened.resource_budget_usage(&budget).unwrap(), before);
    assert!(same.ensure_extent(2 * MIB).is_err());
    assert_eq!(reopened.resource_budget_usage(&budget).unwrap(), before);
    same.settle(1, 1, &"a".repeat(64)).unwrap();
    assert!(same.ensure_extent(2).is_err());
}

#[test]
fn existing_unaccounted_payloads_remain_legacy_observations_without_new_receipts() {
    let (root, store, reader, budget) = fixture(5, MIB);
    // Model a pre-budget archive while retaining its separate original group.
    let path = root
        .path()
        .join("external-history/managed-v2/lifecycle.json");
    let mut document: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for archive in document["archives"].as_object_mut().unwrap().values_mut() {
        archive.as_object_mut().unwrap().remove("resource_budget");
    }
    std::fs::write(path, serde_json::to_vec(&document).unwrap()).unwrap();
    let before = store.resource_budget_usage(&budget).unwrap();
    assert!(
        reader
            .lifecycle
            .resource_stream(
                ResourceKind::EmbeddedAttachment,
                &"9".repeat(64),
                HISTORICAL_ATTACHMENT_MAX_BYTES,
                1,
                true
            )
            .unwrap()
            .is_none()
    );
    assert_eq!(store.resource_budget_usage(&budget).unwrap(), before);
}

#[test]
fn a_born_archive_cannot_write_new_payload_after_its_original_group_disappears() {
    let (root, _store, reader, _budget) = fixture(5, MIB);
    let path = root
        .path()
        .join("external-history/managed-v2/lifecycle.json");
    let mut document: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    document["resource_groups"] = serde_json::json!({});
    std::fs::write(path, serde_json::to_vec(&document).unwrap()).unwrap();
    assert_eq!(
        reader
            .lifecycle
            .resource_stream(ResourceKind::DerivedIndex, &"7".repeat(64), MIB, 1, false,)
            .err()
            .map(|error| error.to_string())
            .as_deref(),
        Some("history_resource_ledger_missing")
    );
    assert!(reader.receipt().unwrap().is_some());
}

#[test]
fn a_born_archive_accounts_existing_untracked_payload_before_new_growth() {
    let (_root, store, reader, budget) = fixture(5, MIB);
    let before = store.resource_budget_usage(&budget).unwrap();
    let stream = reader
        .lifecycle
        .resource_stream(
            ResourceKind::DerivedIndex,
            &"8".repeat(64),
            2 * MIB,
            1,
            true,
        )
        .unwrap()
        .expect("a born budget cannot exempt an existing writable cache");
    assert!(stream.ensure_extent(MIB).is_err());
    assert_eq!(
        store
            .resource_budget_usage(&budget)
            .unwrap()
            .committed_bytes,
        before.committed_bytes
    );
}

fn historical_record() -> kcoder_types::imported_transcript::HistoricalRecord {
    use kcoder_types::{imported_transcript::*, migration::MigrationSourceKind};
    HistoricalRecord {
        source: MigrationSourceKind::Codex,
        record: 0,
        source_id: None,
        parent_id: None,
        logical_parent_id: None,
        source_session_id: Some("original-history".into()),
        timestamp: None,
        source_version: None,
        turn_id: None,
        persisted_ordinal: Some(0),
        sidechain: false,
        hidden: false,
        compact_summary: false,
        codex: None,
        data: HistoricalRecordData::Unknown {
            source_type: Some("synthetic".into()),
            payload: None,
        },
        diagnostics: Vec::new(),
    }
}

#[test]
fn actual_sqlite_normalization_and_attachments_share_one_budget_and_settle_real_files() {
    let (_root, store, reader, budget) = fixture(6, MIB);
    let original = store.resource_budget_usage(&budget).unwrap();
    let mut projection = reader
        .projection("quota-fixture/v1", true)
        .unwrap()
        .unwrap();
    projection.append(0, &[historical_record()]).unwrap();
    let done = projection.finish().unwrap();
    assert!(done.normalization_complete);
    assert_eq!(projection.finish().unwrap(), done);
    let after_sqlite = store.resource_budget_usage(&budget).unwrap();
    assert_eq!(after_sqlite.committed_files, original.committed_files + 1);
    assert!(after_sqlite.committed_bytes > original.committed_bytes);
    assert_eq!(
        (after_sqlite.reserved_bytes, after_sqlite.reserved_files),
        (0, 0)
    );
    drop(projection);
    let mut reopened = reader
        .projection("quota-fixture/v1", true)
        .unwrap()
        .unwrap();
    assert!(reopened.finish().unwrap().normalization_complete);
    assert_eq!(store.resource_budget_usage(&budget).unwrap(), after_sqlite);
    let mut blob = reader
        .attachment_blob(&"8".repeat(64), true)
        .unwrap()
        .unwrap();
    blob.publish(
        &mut Cursor::new(b"x"),
        HISTORICAL_ATTACHMENT_MAX_BYTES,
        |_| true,
    )
    .unwrap();
    let with_attachment = store.resource_budget_usage(&budget).unwrap();
    assert_eq!(with_attachment.committed_files, 6);
    assert_eq!(
        with_attachment.committed_bytes,
        after_sqlite.committed_bytes + 1
    );
}

#[test]
fn sqlite_file_admission_failure_never_publishes_a_partial_normalized_store() {
    let (_root, store, reader, budget) = fixture(5, MIB);
    let before = store.resource_budget_usage(&budget).unwrap();
    assert_eq!(
        reader
            .projection("file-quota/v1", true)
            .err()
            .unwrap()
            .to_string(),
        "history_resource_file_budget_exceeded"
    );
    assert!(reader.projection("file-quota/v1", false).unwrap().is_none());
    assert_eq!(store.resource_budget_usage(&budget).unwrap(), before);
    assert!(reader.receipt().unwrap().is_some());
}

#[test]
fn real_selected_local_copy_commits_to_the_same_archive_budget_and_stays_readable_offline() {
    use crate::external_history::local_attachment::SelectedLocalFile;
    use kcoder_types::local_attachment::HistoricalLocalAttachmentStage;
    let (_root, store, reader, budget) = fixture(5, MIB);
    let source = tempfile::tempdir().unwrap();
    let body = b"explicitly selected source";
    std::fs::write(source.path().join("report.bin"), body).unwrap();
    let selected = SelectedLocalFile::select(
        source.path(),
        std::path::Path::new("report.bin"),
        true,
        |_| true,
    )
    .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let reference = "7".repeat(64);
    let before = store.resource_budget_usage(&budget).unwrap();
    let import = reader.local_attachment_import(&id, true).unwrap().unwrap();
    let authorized = import.authorize(&reference, &selected).unwrap();
    let ready = import
        .run(&reference, authorized.sequence, |_| true)
        .unwrap();
    assert!(ready.stage == HistoricalLocalAttachmentStage::Ready);
    let receipt = ready.receipt.as_ref().unwrap();
    assert_eq!(receipt.bytes, body.len() as u64);
    let after = store.resource_budget_usage(&budget).unwrap();
    assert_eq!(after.committed_files, 5);
    assert_eq!(
        after.committed_bytes,
        before.committed_bytes + body.len() as u64
    );
    drop(import);
    std::fs::remove_file(source.path().join("report.bin")).unwrap();
    let reopened = reader.local_attachment_import(&id, false).unwrap().unwrap();
    let observed = reopened.view(&reference).unwrap();
    assert!(observed.stage == HistoricalLocalAttachmentStage::Ready);
    assert_eq!(observed.receipt, ready.receipt);
    assert_eq!(store.resource_budget_usage(&budget).unwrap(), after);
}

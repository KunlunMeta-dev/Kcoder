use super::*;
use crate::external_history::ExternalHistoryStore;
use kcoder_types::{external_history::*, migration::MigrationSourceKind};
use sha2::{Digest, Sha256};
use std::io::Cursor;

pub(in crate::external_history::lifecycle::resource_budget) fn snapshot(
    bytes: &[u8],
) -> ExternalHistorySnapshot {
    ExternalHistorySnapshot {
        original: None,
        origin: ExternalHistoryOrigin {
            source: MigrationSourceKind::Codex,
            source_artifact_id: None,
            source_instance: "owned-budget-fixture".into(),
            source_session_id: "original-history".into(),
            source_format: "synthetic-jsonl/v1".into(),
            adapter_revision: "fixture/1".into(),
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
    }
}
fn limits(max_total_bytes: u64, files: u32) -> MigrationResourceLimits {
    MigrationResourceLimits {
        max_total_bytes,
        max_payload_files: files,
        min_free_bytes: 1024 * 1024,
        min_free_file_nodes: 0,
    }
}

#[test]
fn real_archive_reserves_before_payload_and_reconciles_the_original_completion() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let bytes = b"{\"fixture\":1}\n{\"fixture\":2}\n";
    let selected = snapshot(bytes);
    let expected = specification("history-a", &selected).unwrap();
    let budget = store
        .prepare_resource_budget(
            "batch-a",
            vec!["history-a".into(), "history-b".into()],
            limits(expected.maximum_bytes, 4),
        )
        .unwrap();
    let mut first = store.begin_managed("history-a", &selected).unwrap();
    let id = first.archive_id().to_owned();
    let (_, original) = store
        .find_history_resource_reservation(&budget, &expected)
        .unwrap()
        .unwrap();
    assert_eq!(original, ResourceOutcome::Reserved);
    assert!(
        !root
            .path()
            .join("external-history")
            .join(&id)
            .join("source.bin")
            .exists()
    );
    let mut other = selected.clone();
    other.origin.source_session_id = "other-history".into();
    let other_id = store.reserve_managed_archive("history-b", &other).unwrap();
    assert!(store.begin_managed("history-b", &other).is_err());
    assert!(!root.path().join("external-history").join(other_id).exists());
    first
        .stage_source(&mut Cursor::new(bytes), &mut |_| true)
        .unwrap();
    let committed = first.finish(&mut |_| true).unwrap();
    let used = store.resource_budget_usage(&budget).unwrap();
    assert_eq!(used.reserved_bytes, 0);
    assert_eq!(used.committed_files, 4);
    assert!(used.committed_bytes < expected.maximum_bytes);
    drop(first);
    let reopened = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let mut retry = reopened.begin_managed("history-a", &selected).unwrap();
    assert_eq!(
        retry.finish(&mut |_| true).unwrap().receipt,
        committed.receipt
    );
    assert_eq!(reopened.resource_budget_usage(&budget).unwrap(), used);
}

#[test]
fn interrupted_real_write_retains_the_allocation_across_restart() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let bytes = vec![b'\n'; 256 * 1024];
    let selected = snapshot(&bytes);
    let expected = specification("history-a", &selected).unwrap();
    let budget = store
        .prepare_resource_budget(
            "batch-a",
            vec!["history-a".into()],
            limits(expected.maximum_bytes, 4),
        )
        .unwrap();
    let mut import = store.begin_managed("history-a", &selected).unwrap();
    assert!(
        import
            .stage_source(&mut Cursor::new(&bytes), &mut |progress| progress
                .processed_bytes
                < 65536)
            .is_err()
    );
    drop(import);
    let reopened = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let (original, outcome) = reopened
        .find_history_resource_reservation(&budget, &expected)
        .unwrap()
        .unwrap();
    assert_eq!(outcome, ResourceOutcome::Reserved);
    assert_eq!(
        reopened
            .resource_budget_usage(&budget)
            .unwrap()
            .reserved_bytes,
        expected.maximum_bytes
    );
    assert_eq!(
        reopened.history_resource_outcome(&original).unwrap(),
        ResourceOutcome::Reserved
    );
    let mut retry = reopened.begin_managed("history-a", &selected).unwrap();
    retry
        .stage_source(&mut Cursor::new(&bytes), &mut |_| true)
        .unwrap();
    retry.finish(&mut |_| true).unwrap();
    assert_eq!(
        reopened
            .resource_budget_usage(&budget)
            .unwrap()
            .reserved_bytes,
        0
    );
}

#[test]
fn encoded_and_decoded_payloads_share_one_preallocation_and_reuse_keeps_the_original_owner() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let bytes = b"{\"synthetic\":true}\n";
    let encoded = zstd::stream::encode_all(Cursor::new(bytes), 1).unwrap();
    let mut selected = snapshot(bytes);
    selected.original = Some(ExternalHistoryEncodedSource {
        encoding: ExternalHistoryEncoding::Zstd,
        bytes: encoded.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&encoded)),
    });
    let expected = specification("history-a", &selected).unwrap();
    let budget = store
        .prepare_resource_budget(
            "batch-a",
            vec!["history-a".into()],
            limits(expected.maximum_bytes, 6),
        )
        .unwrap();
    let mut import = store.begin_managed("history-a", &selected).unwrap();
    import
        .stage_original_source(&mut Cursor::new(encoded), &mut |_| true)
        .unwrap();
    import.decode_original_source(&mut |_| true).unwrap();
    let first = import.finish(&mut |_| true).unwrap();
    drop(import);
    let old_usage = store.resource_budget_usage(&budget).unwrap();
    assert_eq!(old_usage.committed_files, 6);
    assert!(
        old_usage.committed_bytes >= bytes.len() as u64 + selected.original.as_ref().unwrap().bytes
    );
    let alias_budget = store
        .prepare_resource_budget("batch-b", vec!["history-alias".into()], limits(1, 1))
        .unwrap();
    let mut alias = store.begin_managed("history-alias", &selected).unwrap();
    assert!(!alias.finish(&mut |_| true).unwrap().owns_archive);
    assert_eq!(alias.archive_id(), first.receipt.archive_id);
    assert_eq!(store.resource_budget_usage(&budget).unwrap(), old_usage);
    let alias_usage = store.resource_budget_usage(&alias_budget).unwrap();
    assert_eq!(
        (alias_usage.committed_bytes, alias_usage.reserved_bytes),
        (0, 0)
    );
}

#[test]
fn an_existing_unbudgeted_birth_cannot_be_relabelled_as_a_new_allocation() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    store
        .reserve_managed_archive("history-a", &snapshot(b"{}\n"))
        .unwrap();
    assert_eq!(
        store
            .prepare_resource_budget("batch-late", vec!["history-a".into()], limits(1024, 4))
            .unwrap_err()
            .to_string(),
        "history_resource_member_already_started"
    );
}

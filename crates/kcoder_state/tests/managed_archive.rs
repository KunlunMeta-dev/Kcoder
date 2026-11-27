use kcoder_state::external_history::{ExternalHistoryStore, lifecycle::*};
use kcoder_types::{external_history::*, migration::MigrationSourceKind};
use sha2::{Digest, Sha256};
use std::io::Read;

fn snapshot(bytes: &[u8]) -> ExternalHistorySnapshot {
    ExternalHistorySnapshot {
        origin: ExternalHistoryOrigin {
            source: MigrationSourceKind::Codex,
            source_instance: "owned-synthetic-grant".into(),
            source_session_id: "source-session".into(),
            source_artifact_id: None,
            source_format: "jsonl/fixture".into(),
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
        record_limit: 10,
        original: None,
    }
}
fn imported(store: &ExternalHistoryStore, operation: &str, bytes: &[u8]) -> ExternalHistoryReceipt {
    let mut import = store.begin_managed(operation, &snapshot(bytes)).unwrap();
    import.stage_source(&mut &*bytes, &mut |_| true).unwrap();
    import.finish(&mut |_| true).unwrap().receipt
}

#[test]
fn a_managed_birth_does_not_retarget_legacy_ids_and_a_lost_result_reopens_only_its_operation() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let bytes = b"{\"text\":\"owned evidence\"}\n";
    let legacy = ExternalHistoryStore::archive_id_for_snapshot(&snapshot(bytes)).unwrap();
    let first = imported(&store, "first", bytes);
    assert_ne!(first.archive_id, legacy);
    assert!(
        store
            .reader(&first.archive_id)
            .unwrap()
            .lifecycle_guard()
            .is_managed()
    );
    assert_eq!(imported(&store, "first", bytes), first);
    let alias = imported(&store, "alias", bytes);
    assert_eq!(alias, first);
    let mut legacy_import = store.begin("legacy", &snapshot(bytes)).unwrap();
    assert_eq!(legacy_import.archive_id(), legacy);
    legacy_import
        .stage_source(&mut &bytes[..], &mut |_| true)
        .unwrap();
    legacy_import.finish(&mut |_| true).unwrap();
    assert!(
        !store
            .reader(&legacy)
            .unwrap()
            .lifecycle_guard()
            .is_managed()
    );
    assert!(store.begin_managed("legacy", &snapshot(bytes)).is_err());
}

#[test]
fn a_record_descendant_and_explicit_idle_view_share_the_native_read_fence() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let bytes = b"first record\nlast record";
    let receipt = imported(&store, "first", bytes);
    assert!(
        store
            .archive_lifecycle_observation(&receipt.archive_id)
            .unwrap()
            .read_leases_idle
    );
    let reader = store.reader(&receipt.archive_id).unwrap();
    let idle_view = reader.lifecycle_guard();
    let mut record = reader.open_record(0).unwrap();
    drop(reader);
    assert!(
        !store
            .archive_lifecycle_observation(&receipt.archive_id)
            .unwrap()
            .read_leases_idle
    );
    let mut observed = String::new();
    record.read_to_string(&mut observed).unwrap();
    assert_eq!(observed, "first record\n");
    drop(record);
    assert!(
        !store
            .archive_lifecycle_observation(&receipt.archive_id)
            .unwrap()
            .read_leases_idle
    );
    drop(idle_view);
    assert!(
        store
            .archive_lifecycle_observation(&receipt.archive_id)
            .unwrap()
            .read_leases_idle
    );
}

#[test]
fn a_native_reference_is_durable_but_does_not_borrow_a_foreign_profiles_authority() {
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let foreign = ExternalHistoryStore::open(other.path()).unwrap();
    let receipt = imported(&store, "first", b"fixture\n");
    imported(&foreign, "first", b"fixture\n");
    let reader = store.reader(&receipt.archive_id).unwrap();
    let owner = ArchiveReferenceOwner::new(
        ArchiveReferenceKind::Preparation,
        "owned-preparation",
        &"a".repeat(64),
    )
    .unwrap();
    let pin = store
        .retain_archive_reference(owner.clone(), &[reader.lifecycle_guard()])
        .unwrap();
    assert!(
        foreign
            .retain_archive_reference(owner, &[reader.lifecycle_guard()])
            .is_err()
    );
    drop(reader);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        store
            .archive_lifecycle_observation(&receipt.archive_id)
            .unwrap()
            .durable_references,
        2
    );
    store.release_archive_reference(&pin).unwrap();
    store.release_archive_reference(&pin).unwrap();
    assert_eq!(
        store
            .archive_lifecycle_observation(&receipt.archive_id)
            .unwrap()
            .durable_references,
        1
    );
    assert!(foreign.release_archive_reference(&pin).is_err());
}

#[cfg(target_os = "linux")]
#[test]
fn birth_seals_reject_changed_bytes_replacements_and_unowned_entries_without_collecting() {
    for change in ["bytes", "identity", "extra"] {
        let root = tempfile::tempdir().unwrap();
        let store = ExternalHistoryStore::open(root.path()).unwrap();
        let bytes = b"owned fixture\n";
        let receipt = imported(&store, "first", bytes);
        let mut checks = 0;
        store
            .verify_archive_birth(&receipt.archive_id, || {
                checks += 1;
                // A long hash must not keep the namespace mutation coordinator locked.
                assert!(
                    store
                        .archive_lifecycle_observation(&receipt.archive_id)
                        .is_ok()
                );
                true
            })
            .unwrap();
        assert!(checks > 0);
        assert!(
            store
                .verify_archive_birth(&receipt.archive_id, || false)
                .is_err()
        );
        let archive = root
            .path()
            .join("external-history")
            .join(&receipt.archive_id);
        let raw = archive.join("source.bin");
        match change {
            "bytes" => std::fs::write(&raw, b"other fixture\n").unwrap(),
            "identity" => {
                std::fs::rename(&raw, archive.join("saved-source.bin")).unwrap();
                std::fs::write(&raw, bytes).unwrap();
            }
            "extra" => std::fs::write(archive.join("user-document.md"), "keep this").unwrap(),
            _ => unreachable!(),
        }
        assert!(
            store
                .verify_archive_birth(&receipt.archive_id, || true)
                .is_err()
        );
        assert!(raw.is_file());
        assert!(archive.join("receipt.json").is_file());
        if change == "extra" {
            assert_eq!(
                std::fs::read_to_string(archive.join("user-document.md")).unwrap(),
                "keep this"
            );
        }
    }
}

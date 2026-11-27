use kcoder_state::external_history::{ExternalHistoryStore, lifecycle::*};
use kcoder_types::{external_history::*, migration::MigrationSourceKind};
use sha2::{Digest, Sha256};

fn snapshot(bytes: &[u8]) -> ExternalHistorySnapshot {
    ExternalHistorySnapshot {
        origin: ExternalHistoryOrigin {
            source: MigrationSourceKind::ClaudeCode,
            source_instance: "fixture-only".into(),
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
fn import(store: &ExternalHistoryStore, operation: &str) -> ExternalHistoryReceipt {
    let bytes = b"owned archive\n";
    let mut import = store.begin_managed(operation, &snapshot(bytes)).unwrap();
    import.stage_source(&mut &bytes[..], &mut |_| true).unwrap();
    import.finish(&mut |_| true).unwrap().receipt
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn an_active_old_archive_without_a_birth_baseline_stays_readable_and_is_never_adopted_for_collection()
 {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let receipt = import(&store, "old-windows-no-baseline");
    let metadata = root
        .path()
        .join("external-history/managed-v2/lifecycle.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&metadata).unwrap()).unwrap();
    value["archives"][&receipt.archive_id]["baseline"] = serde_json::Value::Null;
    std::fs::write(&metadata, serde_json::to_vec(&value).unwrap()).unwrap();
    drop(store);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    assert!(store.reader(&receipt.archive_id).is_ok());
    let read_before = std::fs::read(
        root.path()
            .join("external-history")
            .join(&receipt.archive_id)
            .join("source.bin"),
    )
    .unwrap();
    let prepared = store
        .prepare_archive_retirement("retain-old", "old-windows-no-baseline")
        .unwrap();
    let blocked = store
        .run_archive_retirement("retain-old", prepared.sequence, || true)
        .unwrap();
    assert!(matches!(blocked.phase, ArchiveRetirementPhase::Blocked));
    assert!(!blocked.logical_retired);
    assert_eq!(
        blocked.failure_code.as_deref(),
        Some("external_history_lifecycle_unsealed_retained")
    );
    assert_eq!(
        std::fs::read(
            root.path()
                .join("external-history")
                .join(&receipt.archive_id)
                .join("source.bin")
        )
        .unwrap(),
        read_before
    );
    assert!(store.reader(&receipt.archive_id).is_ok());
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn an_unreferenced_managed_archive_is_collected_and_its_original_operation_cannot_resurrect_it() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let receipt = import(&store, "first");
    let prepared = store
        .prepare_archive_retirement("retire-first", "first")
        .unwrap();
    let result = store
        .run_archive_retirement(&prepared.operation_id, prepared.sequence, || true)
        .unwrap();
    assert!(
        matches!(result.phase, ArchiveRetirementPhase::Collected),
        "{:?}",
        result.failure_code
    );
    assert!(result.logical_retired);
    assert!(result.collected_bytes > 0);
    assert_eq!(result.retained_references, 0);
    assert!(
        !root
            .path()
            .join("external-history")
            .join(&receipt.archive_id)
            .exists()
    );
    assert!(store.reader(&receipt.archive_id).is_err());
    assert!(
        store
            .begin_managed("first", &snapshot(b"owned archive\n"))
            .is_err()
    );
    assert!(matches!(
        store.read_archive_retirement("retire-first").unwrap().phase,
        ArchiveRetirementPhase::Collected
    ));
    assert!(
        root.path()
            .join("external-history/managed-v2/lifecycle.json")
            .is_file()
    );
    let fresh = import(&store, "new-explicit-operation");
    assert_ne!(fresh.archive_id, receipt.archive_id);
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn aliases_durable_dependents_and_live_reader_descendants_keep_the_original_archive() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let receipt = import(&store, "first");
    assert_eq!(import(&store, "alias"), receipt);
    let reader = store.reader(&receipt.archive_id).unwrap();
    let idle = reader.lifecycle_guard();
    let pin = store
        .retain_archive_reference(
            ArchiveReferenceOwner::new(
                ArchiveReferenceKind::Preparation,
                "preparation",
                &"a".repeat(64),
            )
            .unwrap(),
            &[reader.lifecycle_guard()],
        )
        .unwrap();
    drop(reader);
    let prepared = store
        .prepare_archive_retirement("retire-first", "first")
        .unwrap();
    let blocked = store
        .run_archive_retirement(&prepared.operation_id, prepared.sequence, || true)
        .unwrap();
    assert!(matches!(blocked.phase, ArchiveRetirementPhase::Blocked));
    assert_eq!(blocked.retained_references, 2);
    assert!(store.reader(&receipt.archive_id).is_ok());
    let alias = store
        .prepare_archive_retirement("retire-alias", "alias")
        .unwrap();
    let retained = store
        .run_archive_retirement(&alias.operation_id, alias.sequence, || true)
        .unwrap();
    assert!(!retained.owns_archive && !retained.logical_retired);
    assert!(matches!(retained.phase, ArchiveRetirementPhase::Blocked));
    store.release_archive_reference(&pin).unwrap();
    let blocked = store
        .run_archive_retirement("retire-alias", retained.sequence, || true)
        .unwrap();
    assert!(matches!(blocked.phase, ArchiveRetirementPhase::Blocked));
    assert_eq!(
        blocked.failure_code.as_deref(),
        Some("external_history_retirement_readers_busy")
    );
    drop(idle);
    let retired = store
        .run_archive_retirement("retire-alias", blocked.sequence, || true)
        .unwrap();
    assert!(retired.logical_retired && !retired.owns_archive);
    let current = store.read_archive_retirement("retire-first").unwrap();
    let collected = store
        .run_archive_retirement("retire-first", current.sequence, || true)
        .unwrap();
    assert!(matches!(collected.phase, ArchiveRetirementPhase::Collected));
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn cancel_after_quarantine_retains_known_effects_and_explicit_resume_finishes_the_same_operation() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let receipt = import(&store, "first");
    let prepared = store
        .prepare_archive_retirement("retire-first", "first")
        .unwrap();
    let mut cancelled = false;
    let paused = store
        .run_archive_retirement("retire-first", prepared.sequence, || {
            if !cancelled
                && !root
                    .path()
                    .join("external-history")
                    .join(&receipt.archive_id)
                    .exists()
            {
                cancelled = true;
                let current = store.read_archive_retirement("retire-first").unwrap();
                store
                    .cancel_archive_retirement("retire-first", current.sequence)
                    .unwrap();
            }
            true
        })
        .unwrap();
    assert!(cancelled);
    assert!(paused.cancel_requested && paused.logical_retired);
    assert!(matches!(paused.phase, ArchiveRetirementPhase::Retired));
    assert!(
        store
            .resume_archive_retirement("retire-first", prepared.sequence)
            .is_err()
    );
    let resumed = store
        .resume_archive_retirement("retire-first", paused.sequence)
        .unwrap();
    assert!(!resumed.cancel_requested);
    let collected = store
        .run_archive_retirement("retire-first", resumed.sequence, || true)
        .unwrap();
    assert!(matches!(collected.phase, ArchiveRetirementPhase::Collected));
    assert_eq!(collected.operation_id, prepared.operation_id);
}

#[test]
fn retired_request_identity_cancel_and_legacy_gates_do_not_create_another_operation() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    import(&store, "first");
    let prepared = store
        .prepare_archive_retirement("retire-first", "first")
        .unwrap();
    assert_eq!(
        store
            .prepare_archive_retirement("another-id", "first")
            .unwrap()
            .operation_id,
        "retire-first"
    );
    let cancelled = store
        .cancel_archive_retirement("retire-first", prepared.sequence)
        .unwrap();
    assert!(matches!(cancelled.phase, ArchiveRetirementPhase::Cancelled));
    assert!(!cancelled.logical_retired);
    assert!(
        store
            .prepare_archive_retirement("retire-first", "other")
            .is_err()
    );
    assert!(
        store
            .run_archive_retirement("retire-first", prepared.sequence, || true)
            .is_err()
    );
    assert!(
        !store
            .run_archive_retirement("retire-first", cancelled.sequence, || true)
            .unwrap()
            .logical_retired
    );
    let bytes = b"legacy\n";
    let mut legacy = store.begin("legacy", &snapshot(bytes)).unwrap();
    legacy.stage_source(&mut &bytes[..], &mut |_| true).unwrap();
    let legacy = legacy.finish(&mut |_| true).unwrap();
    assert!(
        store
            .prepare_archive_retirement("retire-legacy", "legacy")
            .is_err()
    );
    assert!(store.reader(&legacy.receipt.archive_id).is_ok());
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn changed_owned_raw_bytes_and_added_user_content_prevent_logical_retirement_and_collection() {
    for change in ["source", "extra", "nonempty-control"] {
        let root = tempfile::tempdir().unwrap();
        let store = ExternalHistoryStore::open(root.path()).unwrap();
        let receipt = import(&store, "first");
        let raw = root
            .path()
            .join("external-history")
            .join(&receipt.archive_id);
        if change == "extra" {
            std::fs::write(raw.join("user-added.md"), "keep me").unwrap();
        } else if change == "nonempty-control" {
            std::fs::write(raw.join("import.lock"), "not an empty control").unwrap();
        } else {
            std::fs::write(raw.join("source.bin"), "other archive\n").unwrap();
        }
        let prepared = store
            .prepare_archive_retirement("retire-first", "first")
            .unwrap();
        let result = store
            .run_archive_retirement("retire-first", prepared.sequence, || true)
            .unwrap();
        assert!(matches!(result.phase, ArchiveRetirementPhase::Blocked));
        assert!(!result.logical_retired);
        assert!(!store.managed_archive_operation_retired("first").unwrap());
        assert!(store.reader(&receipt.archive_id).is_ok());
        assert_eq!(result.collected_bytes, 0);
        assert!(raw.join("receipt.json").is_file());
        if change == "extra" {
            assert_eq!(
                std::fs::read_to_string(raw.join("user-added.md")).unwrap(),
                "keep me"
            );
        }
    }
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn independent_live_references_keep_aliases_live_and_released_receipts_cannot_revive_access() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let receipt = import(&store, "first");
    assert_eq!(import(&store, "alias"), receipt);
    let reader = store.reader(&receipt.archive_id).unwrap();
    let pin = store
        .retain_archive_reference(
            ArchiveReferenceOwner::new(
                ArchiveReferenceKind::Continuation,
                "owned-continuation",
                &"b".repeat(64),
            )
            .unwrap(),
            &[reader.lifecycle_guard()],
        )
        .unwrap();
    drop(reader);
    let operation = store
        .prepare_archive_retirement("retire-alias", "alias")
        .unwrap();
    let blocked = store
        .run_archive_retirement("retire-alias", operation.sequence, || true)
        .unwrap();
    assert!(!blocked.logical_retired);
    assert_eq!(blocked.retained_references, 2);
    let referenced = store
        .reader_with_reference(&receipt.archive_id, &pin)
        .unwrap();
    assert_eq!(
        referenced.read_record_chunk(0, 0, 64).unwrap(),
        b"owned archive\n"
    );
    store.release_archive_reference(&pin).unwrap();
    assert!(
        store
            .reader_with_reference(&receipt.archive_id, &pin)
            .is_err()
    );
    let idle = store
        .run_archive_retirement("retire-alias", blocked.sequence, || true)
        .unwrap();
    assert_eq!(
        idle.failure_code.as_deref(),
        Some("external_history_retirement_readers_busy")
    );
    drop(referenced);
    let retired = store
        .run_archive_retirement("retire-alias", idle.sequence, || true)
        .unwrap();
    assert!(retired.logical_retired);
    let primary = store
        .prepare_archive_retirement("retire-first", "first")
        .unwrap();
    let collected = store
        .run_archive_retirement("retire-first", primary.sequence, || true)
        .unwrap();
    assert!(matches!(collected.phase, ArchiveRetirementPhase::Collected));
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn cancelling_raw_preflight_preserves_the_unmodified_live_import() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let receipt = import(&store, "first");
    let prepared = store
        .prepare_archive_retirement("retire-first", "first")
        .unwrap();
    let mut checks = 0;
    let cancelled = store
        .run_archive_retirement("retire-first", prepared.sequence, || {
            checks += 1;
            if checks == 4 {
                let current = store.read_archive_retirement("retire-first").unwrap();
                assert!(!current.logical_retired);
                store
                    .cancel_archive_retirement("retire-first", current.sequence)
                    .unwrap();
            }
            true
        })
        .unwrap();
    assert!(checks >= 4);
    assert!(cancelled.cancel_requested && !cancelled.logical_retired);
    assert!(matches!(cancelled.phase, ArchiveRetirementPhase::Cancelled));
    assert!(store.reader(&receipt.archive_id).is_ok());
    let resumed = store
        .resume_archive_retirement("retire-first", cancelled.sequence)
        .unwrap();
    let collected = store
        .run_archive_retirement("retire-first", resumed.sequence, || true)
        .unwrap();
    assert!(matches!(collected.phase, ArchiveRetirementPhase::Collected));
}

#[test]
fn retired_alias_admission_and_its_completed_receipt_do_not_follow_later_shared_generation_users() {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let archive = import(&store, "first").archive_id;
    assert_eq!(import(&store, "alias").archive_id, archive);
    let operation = store
        .prepare_archive_retirement("retire-alias", "alias")
        .unwrap();
    let retired = store
        .run_archive_retirement("retire-alias", operation.sequence, || true)
        .unwrap();
    assert!(retired.logical_retired && !retired.owns_archive);
    assert!(store.reader_for_operation(&archive, "alias").is_err());
    let active = store.reader_for_operation(&archive, "first").unwrap();
    let pin = store
        .retain_archive_reference(
            ArchiveReferenceOwner::new(
                ArchiveReferenceKind::Preparation,
                "later-independent-owner",
                &"d".repeat(64),
            )
            .unwrap(),
            &[active.lifecycle_guard()],
        )
        .unwrap();
    let repeated = store
        .run_archive_retirement("retire-alias", retired.sequence, || true)
        .unwrap();
    assert!(matches!(repeated.phase, ArchiveRetirementPhase::Retired));
    assert_eq!(repeated.sequence, retired.sequence);
    assert!(
        !store
            .cancel_archive_retirement("retire-alias", repeated.sequence)
            .unwrap()
            .cancel_requested
    );
    assert_eq!(
        store
            .resume_archive_retirement("retire-alias", repeated.sequence)
            .unwrap()
            .sequence,
        retired.sequence
    );
    store.verify_archive_reference(&pin).unwrap();
}

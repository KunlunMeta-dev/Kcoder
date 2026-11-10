use super::*;
use crate::external_history::ExternalHistoryStore;
use kcoder_types::{external_history::*, migration::MigrationSourceKind};

#[cfg(target_os = "linux")]
fn claimed() -> (tempfile::TempDir, ExternalHistoryStore, Box<Collection>) {
    claimed_kind(false)
}
fn claimed_kind(with_cache: bool) -> (tempfile::TempDir, ExternalHistoryStore, Box<Collection>) {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    assert!(
        store
            .directory
            .portable_retention_filesystem_supported()
            .unwrap(),
        "the owned receipt fixture requires a supported native filesystem"
    );
    let bytes: &[u8] = if with_cache {
        b""
    } else {
        b"owned fault-window fixture\n"
    };
    let snapshot = ExternalHistorySnapshot {
        origin: ExternalHistoryOrigin {
            source: MigrationSourceKind::Codex,
            source_instance: "owned".into(),
            source_session_id: "foreign".into(),
            source_artifact_id: None,
            source_format: "fixture/1".into(),
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
    };
    let mut import = store.begin_managed("first", &snapshot).unwrap();
    import.stage_source(&mut &bytes[..], &mut |_| true).unwrap();
    let receipt = import.finish(&mut |_| true).unwrap().receipt;
    drop(import);
    if with_cache {
        let reader = store.reader(&receipt.archive_id).unwrap();
        let mut projection = reader
            .projection("fixture/sealed-cache", true)
            .unwrap()
            .unwrap();
        projection.finish().unwrap();
        projection.seal_for_collection(|| true).unwrap();
    }
    let mut catalog = Catalog::open(&store.directory, false).unwrap().unwrap();
    let prepared = catalog.prepare_retirement("retire-first", "first").unwrap();
    let Run::Collect(mut claim) = catalog
        .start_retirement("retire-first", prepared.sequence)
        .unwrap()
    else {
        panic!("owned, idle raw archive must acquire its exact collection claim")
    };
    drop(catalog);
    let directory = claim
        .base
        .portable_open_verified_child(OsStr::new(&claim.archive.id), &claim.manifest.directory)
        .unwrap();
    claim
        .verify_remaining(&directory, &[], &mut || true)
        .unwrap();
    claim
        .catalogue()
        .unwrap()
        .retire_request(&claim.operation)
        .unwrap();
    (root, store, claim)
}

#[test]
#[cfg(target_os = "linux")]
fn a_lost_quarantine_receipt_reconciles_only_the_original_birth_and_retirement() {
    let (root, store, claim) = claimed();
    let record = claim
        .catalogue()
        .unwrap()
        .retirement(&claim.operation)
        .unwrap()
        .clone();
    let quarantine = record.quarantine.as_ref().unwrap();
    claim
        .base
        .portable_quarantine_verified_entry(
            OsStr::new(&claim.archive.id),
            &claim.manifest.directory,
            OsStr::new(quarantine),
        )
        .unwrap();
    // The rename and fsync happened, but its metadata acknowledgement is deliberately lost.
    drop(claim);
    drop(store);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let observed = store.read_archive_retirement("retire-first").unwrap();
    let result = store
        .run_archive_retirement("retire-first", observed.sequence, || true)
        .unwrap();
    assert!(matches!(result.phase, ArchiveRetirementPhase::Collected));
    assert_eq!(result.operation_id, "retire-first");
}

#[test]
#[cfg(target_os = "linux")]
fn a_lost_unlink_receipt_reconciles_the_durable_pending_leaf_without_replaying_another_owner() {
    let (root, store, claim) = claimed();
    let mut catalog = claim.catalogue().unwrap();
    let record = catalog.retirement(&claim.operation).unwrap().clone();
    let quarantine = record.quarantine.as_ref().unwrap();
    claim
        .base
        .portable_quarantine_verified_entry(
            OsStr::new(&claim.archive.id),
            &claim.manifest.directory,
            OsStr::new(quarantine),
        )
        .unwrap();
    let directory = claim
        .base
        .portable_open_verified_child(OsStr::new(quarantine), &claim.manifest.directory)
        .unwrap();
    let leaf = claim
        .manifest
        .leaves
        .iter()
        .find(|leaf| leaf.name == "source.bin")
        .unwrap();
    let record = catalog
        .document
        .retirements
        .get_mut(&claim.operation)
        .unwrap();
    record.quarantined = true;
    record.pending = Some(leaf.name.clone());
    bump(record).unwrap();
    catalog.save().unwrap();
    drop(catalog);
    let removed = directory
        .portable_remove_verified_regular_leaf(OsStr::new(&leaf.name), &leaf.identity)
        .unwrap();
    assert!(removed.failure.is_none());
    assert_eq!(removed.removed.len(), 1);
    // Native unlink succeeded; no removed-name or bytes receipt was committed.
    drop(claim);
    drop(store);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let observed = store.read_archive_retirement("retire-first").unwrap();
    assert_eq!(observed.collected_bytes, 0);
    let result = store
        .run_archive_retirement("retire-first", observed.sequence, || true)
        .unwrap();
    assert!(matches!(result.phase, ArchiveRetirementPhase::Collected));
    assert!(result.collected_bytes > 0);
}

#[test]
fn lost_cache_leaf_and_empty_directory_delete_receipts_reconcile_only_the_original_pending_path() {
    for directory_window in [false, true] {
        let (root, store, claim) = claimed_kind(true);
        let record = claim
            .catalogue()
            .unwrap()
            .retirement(&claim.operation)
            .unwrap()
            .clone();
        let quarantine = record.quarantine.as_ref().unwrap();
        claim
            .base
            .portable_quarantine_verified_entry(
                OsStr::new(&claim.archive.id),
                &claim.manifest.directory,
                OsStr::new(quarantine),
            )
            .unwrap();
        let directory = claim
            .base
            .portable_open_verified_child(OsStr::new(quarantine), &claim.manifest.directory)
            .unwrap();
        {
            let mut catalog = claim.catalogue().unwrap();
            catalog
                .document
                .retirements
                .get_mut(&claim.operation)
                .unwrap()
                .quarantined = true;
            catalog.save().unwrap();
        }
        let (name, derived) = claim.archive.derived.iter().next().unwrap();
        let seal = derived.seal.as_ref().unwrap();
        let child = directory
            .portable_open_verified_child(OsStr::new(name), &seal.directory)
            .unwrap();
        assert!(
            seal.leaves
                .iter()
                .any(|leaf| leaf.name == "catalog.sqlite3" && leaf.bytes >= 16),
            "the lost-ack fixture must include a real SQLite database"
        );
        for leaf in seal
            .leaves
            .iter()
            .filter(|leaf| directory_window || leaf.name == "catalog.sqlite3")
        {
            let path = format!("{name}/{}", leaf.name);
            {
                let mut catalog = claim.catalogue().unwrap();
                catalog
                    .document
                    .retirements
                    .get_mut(&claim.operation)
                    .unwrap()
                    .pending = Some(path.clone());
                catalog.save().unwrap();
            }
            let removed = child
                .portable_remove_verified_regular_leaf(OsStr::new(&leaf.name), &leaf.identity)
                .unwrap();
            assert!(removed.failure.is_none());
            if !directory_window {
                break;
            }
            claim.removed(&path).unwrap();
        }
        if directory_window {
            let marker = format!("{name}/");
            let mut catalog = claim.catalogue().unwrap();
            catalog
                .document
                .retirements
                .get_mut(&claim.operation)
                .unwrap()
                .pending = Some(marker);
            catalog.save().unwrap();
            drop(catalog);
            directory
                .portable_remove_verified_empty_directory(OsStr::new(name), &seal.directory)
                .unwrap();
        }
        drop(claim);
        drop(store);
        let store = ExternalHistoryStore::open_existing(root.path())
            .unwrap()
            .unwrap();
        let previous = store.read_archive_retirement("retire-first").unwrap();
        let collected = store
            .run_archive_retirement("retire-first", previous.sequence, || true)
            .unwrap();
        assert!(matches!(collected.phase, ArchiveRetirementPhase::Collected));
        assert!(collected.collected_bytes > 0);
    }
}

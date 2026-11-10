use super::*;
use crate::external_history::ExternalHistoryStore;
use kcoder_types::{external_history::*, migration::MigrationSourceKind};
use std::sync::mpsc;

fn owned() -> (tempfile::TempDir, ExternalHistoryStore, String) {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let bytes = b"owned execution fixture\n";
    let snapshot = ExternalHistorySnapshot {
        origin: ExternalHistoryOrigin {
            source: MigrationSourceKind::ClaudeCode,
            source_instance: "owned".into(),
            source_session_id: "source".into(),
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
    let mut import = store.begin_managed("owned-source", &snapshot).unwrap();
    import.stage_source(&mut &bytes[..], &mut |_| true).unwrap();
    let archive = import.finish(&mut |_| true).unwrap().receipt.archive_id;
    drop(import);
    store
        .prepare_archive_retirement("owned-retirement", "owned-source")
        .unwrap();
    (root, store, archive)
}

#[test]
fn readers_and_concurrent_shared_observers_never_impersonate_a_retirement_worker() {
    let (_root, store, archive) = owned();
    let reader = store.reader(&archive).unwrap();
    assert!(
        !store
            .archive_lifecycle_observation(&archive)
            .unwrap()
            .read_leases_idle
    );
    let catalog = Catalog::open_readonly(&store.directory).unwrap().unwrap();
    let record = catalog.retirement("owned-retirement").unwrap();
    let anchor = record.execution.as_ref().unwrap();
    let probe = catalog
        .directory
        .try_existing_portable_lock(
            OsStr::new(&format!(
                "{}.execution.lock",
                stem("owned-retirement").unwrap()
            )),
            &anchor.identity,
            PrivateLeaseMode::Shared,
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        catalog
            .retirement_execution_state("owned-retirement")
            .unwrap(),
        ArchiveRetirementExecutionState::Stopped
    );
    drop(probe);
    drop(reader);
}

#[test]
fn a_real_running_collector_is_seen_cross_process_and_cancel_does_not_claim_unknown_side_effects() {
    let (root, store, _archive) = owned();
    let before = store.read_archive_retirement("owned-retirement").unwrap();
    let (entered, seen) = mpsc::sync_channel(0);
    let (release, wait) = mpsc::sync_channel(0);
    std::thread::scope(|scope| {
        let path = root.path().to_owned();
        let worker = scope.spawn(move || {
            let store = ExternalHistoryStore::open_existing(&path).unwrap().unwrap();
            let mut calls = 0;
            store
                .run_archive_retirement("owned-retirement", before.sequence, || {
                    calls += 1;
                    if calls == 2 {
                        entered.send(()).unwrap();
                        wait.recv().unwrap();
                    }
                    true
                })
                .unwrap()
        });
        seen.recv_timeout(Duration::from_secs(5)).unwrap();
        let catalog = Catalog::open_readonly(&store.directory).unwrap().unwrap();
        assert_eq!(
            catalog
                .retirement_execution_state("owned-retirement")
                .unwrap(),
            ArchiveRetirementExecutionState::Running
        );
        drop(catalog);
        let cancelled = store
            .request_archive_retirement_cancel("owned-retirement")
            .unwrap();
        assert!(cancelled.cancel_requested);
        assert!(
            store
                .resume_archive_retirement("owned-retirement", cancelled.sequence)
                .is_err()
        );
        release.send(()).unwrap();
        let result = worker.join().unwrap();
        assert!(!result.logical_retired);
        assert!(matches!(result.phase, ArchiveRetirementPhase::Cancelled));
    });
    let catalog = Catalog::open_readonly(&store.directory).unwrap().unwrap();
    assert_eq!(
        catalog
            .retirement_execution_state("owned-retirement")
            .unwrap(),
        ArchiveRetirementExecutionState::Stopped
    );
}

#[test]
fn lost_prepare_receipt_reuses_only_the_same_prepublication_execution_birth() {
    let (_root, store, _archive) = owned();
    let original = {
        let mut catalog = Catalog::open(&store.directory, false).unwrap().unwrap();
        let anchor = catalog
            .document
            .retirements
            .remove("owned-retirement")
            .unwrap()
            .execution
            .unwrap();
        catalog
            .document
            .requests
            .get_mut(&hash(&"owned-source").unwrap())
            .unwrap()
            .retirement = None;
        catalog.save().unwrap();
        anchor
    };
    assert!(store.read_archive_retirement("owned-retirement").is_err());
    let recovered = store
        .prepare_archive_retirement("owned-retirement", "owned-source")
        .unwrap();
    assert_eq!(recovered.sequence, 1);
    let catalog = Catalog::open_readonly(&store.directory).unwrap().unwrap();
    let current = catalog
        .retirement("owned-retirement")
        .unwrap()
        .execution
        .as_ref()
        .unwrap();
    assert!(current.identity == original.identity && current.birth_sha256 == original.birth_sha256);
}

#[test]
fn an_orphan_execution_leaf_without_its_birth_marker_is_never_adopted() {
    let (root, store, _archive) = owned();
    let original = {
        let mut catalog = Catalog::open(&store.directory, false).unwrap().unwrap();
        let anchor = catalog
            .document
            .retirements
            .remove("owned-retirement")
            .unwrap()
            .execution
            .unwrap();
        catalog
            .document
            .requests
            .get_mut(&hash(&"owned-source").unwrap())
            .unwrap()
            .retirement = None;
        catalog.save().unwrap();
        anchor
    };
    let name = stem("owned-retirement").unwrap();
    std::fs::remove_file(
        root.path()
            .join("external-history/managed-v2")
            .join(format!("{name}.execution.birth")),
    )
    .unwrap();
    assert!(
        store
            .prepare_archive_retirement("owned-retirement", "owned-source")
            .is_err()
    );
    let catalog = Catalog::open_readonly(&store.directory).unwrap().unwrap();
    assert!(
        !catalog
            .document
            .retirements
            .contains_key("owned-retirement")
    );
    assert!(
        catalog
            .directory
            .portable_regular_identity(OsStr::new(&format!("{name}.execution.lock")))
            .unwrap()
            == original.identity
    );
}

#[test]
fn readonly_missing_or_replaced_execution_birth_is_unknown_and_never_repaired() {
    let (root, store, _) = owned();
    let catalog = Catalog::open_readonly(&store.directory).unwrap().unwrap();
    let name = format!("{}.execution.lock", stem("owned-retirement").unwrap());
    let original = root.path().join("external-history/managed-v2").join(&name);
    // The controlled namespace is obtained from the fixture, not a historical path.
    let saved = original.with_extension("saved");
    std::fs::rename(&original, &saved).unwrap();
    assert_eq!(
        catalog
            .retirement_execution_state("owned-retirement")
            .unwrap(),
        ArchiveRetirementExecutionState::Unknown
    );
    assert!(!original.exists());
    std::fs::write(&original, b"replacement").unwrap();
    assert_eq!(
        catalog
            .retirement_execution_state("owned-retirement")
            .unwrap(),
        ArchiveRetirementExecutionState::Unknown
    );
    assert_eq!(std::fs::read(&original).unwrap(), b"replacement");
}

#[test]
fn legacy_untracked_retirement_requires_explicit_resume_and_the_original_reader_fence() {
    let (root, store, archive) = owned();
    let initial = {
        let mut catalog = Catalog::open(&store.directory, false).unwrap().unwrap();
        catalog
            .document
            .retirements
            .get_mut("owned-retirement")
            .unwrap()
            .execution = None;
        let stem = stem("owned-retirement").unwrap();
        let parent = root.path().join("external-history/managed-v2");
        std::fs::remove_file(parent.join(format!("{stem}.execution.lock"))).unwrap();
        std::fs::remove_file(parent.join(format!("{stem}.execution.birth"))).unwrap();
        catalog.save().unwrap();
        catalog.retirement_view("owned-retirement").unwrap()
    };
    assert!(
        store
            .run_archive_retirement("owned-retirement", initial.sequence, || true)
            .is_err()
    );
    let reader = store.reader(&archive).unwrap();
    assert!(
        store
            .resume_archive_retirement("owned-retirement", initial.sequence)
            .is_err()
    );
    drop(reader);
    let resumed = store
        .resume_archive_retirement("owned-retirement", initial.sequence)
        .unwrap();
    assert!(!resumed.logical_retired);
    let catalog = Catalog::open_readonly(&store.directory).unwrap().unwrap();
    assert_eq!(
        catalog
            .retirement_execution_state("owned-retirement")
            .unwrap(),
        ArchiveRetirementExecutionState::Stopped
    );
}

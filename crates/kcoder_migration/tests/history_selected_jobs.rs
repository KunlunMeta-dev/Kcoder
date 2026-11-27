use kcoder_migration::{
    history_discovery::HistoryCatalog,
    history_jobs::{HistoryImportEvent, HistoryJobStore},
};
use kcoder_types::{external_history::*, migration::MigrationSourceKind};
use std::{fs, io::Write};
const SESSION: &str = "11111111-1111-4111-8111-111111111111";

fn selected(root: &std::path::Path, text: &[u8]) -> std::path::PathBuf {
    let file = root.join(format!("projects/project/{SESSION}.jsonl"));
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, text).unwrap();
    file
}
fn pin(root: &std::path::Path) -> kcoder_migration::history_discovery::HistoryPendingSelection {
    let catalog =
        HistoryCatalog::discover(root, MigrationSourceKind::ClaudeCode, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    catalog
        .selection(&page.items[0].source_handle)
        .unwrap()
        .pin()
        .unwrap()
}

#[test]
fn selection_is_durable_before_hashing_and_cancel_remains_available_during_capture() {
    let root = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let source = selected(root.path(), &vec![b' '; 512 * 1024]);
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let initial = store.create_selected(&id, pin(root.path())).unwrap();
    assert_eq!(initial.stage, HistoryImportStage::Capturing);
    assert!(initial.archive_id.is_none());
    drop(store);
    let store = HistoryJobStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let peer = HistoryJobStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let mut observed = false;
    let cancelled = store
        .step(&id, initial.sequence, 10, |event| {
            if let HistoryImportEvent::Capture {
                processed_bytes,
                total_bytes,
            } = event
            {
                assert_eq!(total_bytes, 512 * 1024);
                if processed_bytes >= 64 * 1024 && !observed {
                    assert_eq!(peer.read(&id).unwrap().stage, HistoryImportStage::Capturing);
                    assert!(peer.request_cancel(&id).unwrap().cancel_requested);
                    observed = true;
                }
            }
            true
        })
        .unwrap();
    assert!(observed);
    assert_eq!(cancelled.stage, HistoryImportStage::Cancelled);
    assert!(cancelled.archive_id.is_none());
    let resumed = peer.resume(&id, cancelled.sequence).unwrap();
    assert_eq!(resumed.stage, HistoryImportStage::Capturing);
    let ready = peer.step(&id, resumed.sequence, 10, |_| true).unwrap();
    assert_eq!(ready.stage, HistoryImportStage::Planned);
    assert!(ready.archive_id.is_some());
    assert!(!ready.archived);
    assert_eq!(fs::metadata(source).unwrap().len(), 512 * 1024);
    assert!(
        !serde_json::to_string(&ready)
            .unwrap()
            .contains(root.path().to_str().unwrap())
    );
}

#[test]
fn accepted_boundary_and_original_metadata_survive_append_and_process_restart() {
    let root = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let content = b"{\"type\":\"custom-title\",\"customTitle\":\"Original\"}\n";
    let source = selected(root.path(), content);
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let initial = store.create_selected(&id, pin(root.path())).unwrap();
    fs::OpenOptions::new()
        .append(true)
        .open(&source)
        .unwrap()
        .write_all(b"{\"type\":\"custom-title\",\"customTitle\":\"Appended\"}\n")
        .unwrap();
    assert_eq!(
        store.create_selected(&id, pin(root.path())).unwrap(),
        initial
    );
    drop(store);
    let store = HistoryJobStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let captured = store.step(&id, 0, 10, |_| true).unwrap();
    let archived = store.step(&id, captured.sequence, 10, |_| true).unwrap();
    let archive = profile
        .path()
        .join("external-history")
        .join(archived.archive_id.unwrap());
    assert_eq!(fs::read(archive.join("source.bin")).unwrap(), content);
    let snapshot = fs::read_to_string(archive.join("binding.json")).unwrap();
    assert!(snapshot.contains("Original"));
    assert!(!snapshot.contains("Appended"));
}

#[test]
fn capture_rejects_shrunk_or_replaced_sources_and_a_conflicting_request_identity() {
    for replace in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let source = selected(root.path(), b"{\"type\":\"user\"}\n");
        let store = HistoryJobStore::open(profile.path()).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        store.create_selected(&id, pin(root.path())).unwrap();
        if replace {
            fs::rename(&source, root.path().join("original.jsonl")).unwrap();
            fs::write(&source, b"{\"type\":\"user\"}\n").unwrap();
            assert!(store.create_selected(&id, pin(root.path())).is_err());
        } else {
            fs::write(&source, b"{}\n").unwrap();
        }
        let failed = store.step(&id, 0, 10, |_| true).unwrap();
        assert_eq!(failed.stage, HistoryImportStage::Failed);
        assert!(failed.archive_id.is_none());
        assert!(!failed.archived);
    }
}

#[test]
fn invalid_compressed_content_is_accepted_as_a_selection_then_fails_in_the_worker_stage() {
    let root = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let folder = root.path().join("sessions/2026/10/16");
    fs::create_dir_all(&folder).unwrap();
    let path = folder.join(format!("rollout-2026-10-16T10-00-00-{SESSION}.jsonl.zst"));
    fs::write(&path, b"invalid zstd input").unwrap();
    let catalog =
        HistoryCatalog::discover(root.path(), MigrationSourceKind::Codex, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    assert!(page.items[0].preview_incomplete);
    let selection = catalog
        .selection(&page.items[0].source_handle)
        .unwrap()
        .pin()
        .unwrap();
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        store.create_selected(&id, selection).unwrap().stage,
        HistoryImportStage::Capturing
    );
    let failed = store.step(&id, 0, 10, |_| true).unwrap();
    assert_eq!(failed.stage, HistoryImportStage::Failed);
    assert!(failed.archive_id.is_none());
    assert!(path.exists());
}

#[test]
fn cancelled_before_capture_never_opens_the_source_and_requires_explicit_resume() {
    let root = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let source = selected(root.path(), b"{}\n");
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    store.create_selected(&id, pin(root.path())).unwrap();
    fs::remove_file(source).unwrap();
    store.request_cancel(&id).unwrap();
    let cancelled = store
        .step(&id, 0, 10, |_| panic!("cancelled capture must not read"))
        .unwrap();
    assert_eq!(cancelled.stage, HistoryImportStage::Cancelled);
    assert_eq!(
        store
            .step(&id, cancelled.sequence, 10, |_| panic!(
                "resume must be explicit"
            ))
            .unwrap(),
        cancelled
    );
}

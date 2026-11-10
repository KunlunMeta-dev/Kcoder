use super::*;
use crate::local_attachment::test_fixture::Fixture;
use std::{fs, sync::mpsc, time::Duration};
fn key() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[test]
fn a_running_snapshot_is_reloaded_under_the_original_idle_execution_lease_after_its_worker_stops() {
    let f = Fixture::new();
    assert!(f.root.path().is_dir());
    let id = key();
    let bytes = b"original concurrent collection input";
    let uploads = f.uploads();
    let upload = f.fill(&id, bytes);
    let prepared = uploads.prepare_collection(&id, upload.sequence).unwrap();
    let profile = f.profile.clone();
    let worker_id = id.clone();
    let collection = prepared.collection_id.clone();
    let (entered_tx, entered_rx) = mpsc::sync_channel(0);
    let (go_tx, go_rx) = mpsc::sync_channel(0);
    let worker = std::thread::spawn(move || {
        let uploads = HistoryLocalAttachmentUploads::open_existing(&profile)
            .unwrap()
            .unwrap();
        uploads
            .run_collection(&worker_id, &collection, prepared.sequence, |_| {
                entered_tx.send(()).unwrap();
                go_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                false
            })
            .unwrap()
    });
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let operation = uploads.operation_inner(&id, false).unwrap();
    let running = operation.collection_record().unwrap().unwrap();
    assert!(running.stage == UploadCollectionStage::Collecting);
    go_tx.send(()).unwrap();
    let stopped = worker.join().unwrap();
    assert!(stopped.stage == UploadCollectionStage::Cancelled);
    let observed = operation.collection_view(&running).unwrap();
    assert!(observed.stage == UploadCollectionStage::Cancelled);
    assert_eq!(observed.sequence, stopped.sequence);
    assert_eq!(observed.failure_code, stopped.failure_code);
    assert!(!observed.worker_running && !observed.storage_retired);
    assert_eq!(
        fs::read(f.op(&id).join("parts/part-0000.bin")).unwrap(),
        bytes
    );
}

#[test]
fn concurrent_read_observers_do_not_claim_a_shared_probe_is_a_native_collector() {
    let fixture = Fixture::new();
    let id = key();
    let uploads = fixture.uploads();
    let upload = fixture.fill(&id, b"original observed bytes");
    uploads.prepare_collection(&id, upload.sequence).unwrap();
    let operation = uploads.operation_inner(&id, false).unwrap();
    let birth = operation.collection_birth().unwrap();
    let _reader = operation
        .directory
        .try_existing_portable_lock(
            OsStr::new("collection-writer.lock"),
            &birth.collection_writer,
            PrivateLeaseMode::Shared,
        )
        .unwrap()
        .unwrap();
    let observed = uploads.read_collection(&id).unwrap().unwrap();
    assert!(!observed.worker_running);
    assert!(observed.stage == UploadCollectionStage::Prepared);
}

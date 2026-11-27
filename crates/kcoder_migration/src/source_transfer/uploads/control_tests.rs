use super::*;
use kcoder_types::migration::MigrationSourceKind;

fn fixture() -> (tempfile::TempDir, SourceUploads, String) {
    let root = tempfile::tempdir().unwrap();
    let store = SourceUploads::open(root.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    store
        .prepare(
            &id,
            SourceUploadManifest {
                version: 1,
                source: MigrationSourceKind::Codex,
                files: vec![SourceUploadFile {
                    relative_path: "AGENTS.md".into(),
                    bytes: 4,
                    sha256: format!("{:x}", Sha256::digest(b"body")),
                }],
            },
        )
        .unwrap();
    store.part(&id, 0, 0, 0, b"body").unwrap();
    (root, store, id)
}

#[test]
fn completed_upload_controls_preserve_the_committed_receipt_and_sequence() {
    let (_root, store, id) = fixture();
    let ready = store.finish(&id, 0, |_, _| true).unwrap();
    let command = uuid::Uuid::new_v4().to_string();
    assert_eq!(store.cancel(&id, &command).unwrap(), ready);
    assert_eq!(store.resume(&id, 0, 0).unwrap(), ready);
    assert!(!store.read(&id).unwrap().cancel_requested);
    assert!(store.cancel(&id, "not-a-command-id").is_err());
}

#[test]
fn a_lost_cancel_receipt_cannot_cancel_again_after_explicit_resume() {
    let (_root, store, id) = fixture();
    let first = uuid::Uuid::new_v4().to_string();
    let cancelled = store.cancel(&id, &first).unwrap();
    assert_eq!(store.cancel(&id, &first).unwrap(), cancelled);
    let resumed = store
        .resume(&id, cancelled.sequence, cancelled.cancel_watermark)
        .unwrap();
    assert!(!resumed.cancel_requested);
    assert_eq!(store.cancel(&id, &first).unwrap(), resumed);
    let second = uuid::Uuid::new_v4().to_string();
    let cancelled_again = store.cancel(&id, &second).unwrap();
    assert!(
        store
            .resume(&id, resumed.sequence, resumed.cancel_watermark)
            .is_err()
    );
    assert_eq!(store.read(&id).unwrap(), cancelled_again);
}

#[test]
fn controls_require_the_original_commit_lease_even_after_completion() {
    let (_root, store, id) = fixture();
    let ready = store.finish(&id, 0, |_, _| true).unwrap();
    let (directory, _) = store.selected(&id).unwrap();
    let held = operation_lease(&directory, "control.lock").unwrap();
    assert!(
        store
            .cancel(&id, &uuid::Uuid::new_v4().to_string())
            .is_err()
    );
    assert!(store.resume(&id, 0, 0).is_err());
    drop(held);
    assert_eq!(store.read(&id).unwrap(), ready);
}

#[test]
fn accepted_worker_holds_its_lease_before_execution_and_releases_on_drop() {
    let (_root, store, id) = fixture();
    let worker = store.prepare_verification(&id, 0).unwrap();
    assert_eq!(
        store.read(&id).unwrap().worker_state,
        SourceUploadWorkerState::Running
    );
    assert!(store.prepare_verification(&id, 0).is_err());
    let cancelled = store
        .cancel(&id, &uuid::Uuid::new_v4().to_string())
        .unwrap();
    assert!(
        store
            .resume(&id, cancelled.sequence, cancelled.cancel_watermark)
            .is_err()
    );
    drop(worker);
    assert_eq!(
        store.read(&id).unwrap().worker_state,
        SourceUploadWorkerState::Stopped
    );
    store
        .resume(&id, cancelled.sequence, cancelled.cancel_watermark)
        .unwrap();
    let worker = store
        .prepare_verification(&id, cancelled.cancel_watermark)
        .unwrap();
    assert_eq!(
        worker.run(|_, _| true).unwrap().stage,
        SourceUploadStage::Ready
    );
}

#[test]
fn upload_receipt_pages_are_bounded_and_report_only_accepted_offsets() {
    let (_root, store, id) = fixture();
    let page = store.files(&id, None).unwrap();
    assert_eq!(page.files[0].accepted_bytes, 4);
    assert_eq!(page.files[0].next_part, 1);
    assert!(page.files[0].complete);
    assert!(store.files(&id, Some(2)).is_err());
    let id = uuid::Uuid::new_v4().to_string();
    let files = (0..23)
        .map(|i| SourceUploadFile {
            relative_path: format!("skills/example/file-{i}.md"),
            bytes: 1,
            sha256: format!("{:x}", Sha256::digest(b"x")),
        })
        .collect();
    store
        .prepare(
            &id,
            SourceUploadManifest {
                version: 1,
                source: MigrationSourceKind::Codex,
                files,
            },
        )
        .unwrap();
    let first = store.files(&id, None).unwrap();
    let second = store.files(&id, first.next_cursor).unwrap();
    let third = store.files(&id, second.next_cursor).unwrap();
    assert_eq!(
        (first.files.len(), second.files.len(), third.files.len()),
        (10, 10, 3)
    );
    assert!(third.next_cursor.is_none());
    assert!(
        first
            .files
            .iter()
            .all(|file| file.accepted_bytes == 0 && !file.complete)
    );
}

#[test]
fn completing_between_progress_and_receipt_reads_returns_a_consistent_snapshot() {
    let (_root, store, id) = fixture();
    let worker = store.prepare_verification(&id, 0).unwrap();
    VIEW_AFTER_PROGRESS.with(|callback| {
        *callback.borrow_mut() = Some(Box::new(move || {
            worker.run(|_, _| true).unwrap();
        }))
    });
    let observed = store.read(&id).unwrap();
    assert_eq!(observed.stage, SourceUploadStage::Ready);
    assert_eq!(observed.verified_bytes, 4);
    assert_eq!(observed.completed_files, 1);
}

use super::*;
use kcoder_types::migration::MigrationSourceKind;
use std::fs;

fn manifest(files: &[(&str, &[u8])]) -> SourceUploadManifest {
    SourceUploadManifest {
        version: 1,
        source: MigrationSourceKind::Codex,
        files: files
            .iter()
            .map(|(path, bytes)| SourceUploadFile {
                relative_path: (*path).into(),
                bytes: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(bytes)),
            })
            .collect(),
    }
}
fn upload(store: &SourceUploads, id: &str, index: usize, bytes: &[u8], watermark: u64) {
    for (part, data) in bytes.chunks(SOURCE_UPLOAD_PART_BYTES).enumerate() {
        store.part(id, watermark, index, part as u32, data).unwrap();
    }
}

#[test]
fn selected_files_are_private_bounded_and_ready_only_after_actual_hashes() {
    let root = tempfile::tempdir().unwrap();
    let store = SourceUploads::open(root.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let data = vec![b'x'; SOURCE_UPLOAD_PART_BYTES + 13];
    let input = manifest(&[("config.toml", &data), ("skills/example/empty.txt", b"")]);
    assert_eq!(
        store.prepare(&id, input.clone()).unwrap().stage,
        SourceUploadStage::Prepared
    );
    assert!(store.finish(&id, 0, |_, _| true).is_err());
    upload(&store, &id, 0, &data, 0);
    assert_eq!(store.read(&id).unwrap().received_bytes, data.len() as u64);
    let ready = store.finish(&id, 0, |_, _| true).unwrap();
    assert_eq!(ready.stage, SourceUploadStage::Ready);
    assert_eq!(ready.completed_files, 2);
    assert_eq!(ready.verified_bytes, data.len() as u64);
    let reopened = SourceUploads::open_existing(root.path()).unwrap();
    assert_eq!(
        reopened.prepare(&id, input).unwrap_err().to_string(),
        "source_transfer_recovery_scope"
    );
    assert_eq!(reopened.read(&id).unwrap(), ready);
    let mut copied = Vec::new();
    reopened
        .copy_verified_file(&id, 0, &mut copied, |_| true)
        .unwrap();
    assert_eq!(copied, data);
    assert!(
        serde_json::to_string(&ready)
            .unwrap()
            .find("relativePath")
            .is_none()
    );
}

#[test]
fn lost_partial_or_complete_append_receipts_require_the_original_part_bytes() {
    for copied in [5, 40] {
        let root = tempfile::tempdir().unwrap();
        let store = SourceUploads::open(root.path()).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let data = vec![b'a'; 40];
        store
            .prepare(&id, manifest(&[("AGENTS.md", &data)]))
            .unwrap();
        FAIL_PART_AFTER_BYTES.with(|value| value.set(Some(copied)));
        assert!(store.part(&id, 0, 0, 0, &data).is_err());
        assert_eq!(store.read(&id).unwrap().received_bytes, 0);
        assert!(store.part(&id, 0, 0, 0, &[b'b'; 40]).is_err());
        assert_eq!(store.part(&id, 0, 0, 0, &data).unwrap().received_bytes, 40);
        assert_eq!(store.part(&id, 0, 0, 0, &data).unwrap().received_bytes, 40);
        assert_eq!(
            store.finish(&id, 0, |_, _| true).unwrap().stage,
            SourceUploadStage::Ready
        );
    }
}

#[test]
fn independent_cancel_stops_verification_and_stale_parts_cannot_cross_a_resume() {
    let root = tempfile::tempdir().unwrap();
    let store = SourceUploads::open(root.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let data = vec![b'x'; SOURCE_UPLOAD_PART_BYTES + 1];
    store
        .prepare(&id, manifest(&[("AGENTS.md", &data)]))
        .unwrap();
    upload(&store, &id, 0, &data, 0);
    let command = uuid::Uuid::new_v4().to_string();
    let mut requested = false;
    assert!(
        store
            .finish(&id, 0, |_, _| {
                if !requested {
                    requested = true;
                    let state = store.cancel(&id, &command).unwrap();
                    assert_eq!(state.stage, SourceUploadStage::CancelRequested);
                    assert_eq!(state.worker_state, SourceUploadWorkerState::Running);
                    assert!(
                        store
                            .resume(&id, state.sequence, state.cancel_watermark)
                            .is_err()
                    );
                }
                true
            })
            .is_err()
    );
    let cancelled = store.read(&id).unwrap();
    assert_eq!(cancelled.stage, SourceUploadStage::Cancelled);
    assert!(
        store
            .resume(&id, cancelled.sequence - 1, cancelled.cancel_watermark)
            .is_err()
    );
    store
        .resume(&id, cancelled.sequence, cancelled.cancel_watermark)
        .unwrap();
    assert!(store.finish(&id, 0, |_, _| true).is_err());
    assert_eq!(
        store
            .finish(&id, cancelled.cancel_watermark, |_, _| true)
            .unwrap()
            .stage,
        SourceUploadStage::Ready
    );
}

#[test]
fn untracked_or_changed_birth_and_published_receipts_are_not_repaired() {
    let root = tempfile::tempdir().unwrap();
    let store = SourceUploads::open(root.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let input = manifest(&[("AGENTS.md", b"body")]);
    store.prepare(&id, input.clone()).unwrap();
    let base = root
        .path()
        .join("migrations/source-transfer/browser-uploads")
        .join(&id);
    fs::remove_file(base.join(PROGRESS)).unwrap();
    assert!(store.prepare(&id, input).is_err());
    assert!(!base.join(PROGRESS).exists());
    let id = uuid::Uuid::new_v4().to_string();
    store
        .prepare(&id, manifest(&[("AGENTS.md", b"body")]))
        .unwrap();
    upload(&store, &id, 0, b"body", 0);
    store.finish(&id, 0, |_, _| true).unwrap();
    let base = root
        .path()
        .join("migrations/source-transfer/browser-uploads")
        .join(&id);
    fs::remove_file(base.join(RECEIPT)).unwrap();
    assert!(store.read(&id).is_err());
    assert!(store.finish(&id, 0, |_, _| true).is_err());
    assert!(!base.join(RECEIPT).exists());
}

#[test]
fn same_bytes_at_a_replaced_file_never_inherit_ready_authority() {
    let root = tempfile::tempdir().unwrap();
    let store = SourceUploads::open(root.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    store
        .prepare(&id, manifest(&[("AGENTS.md", b"body")]))
        .unwrap();
    upload(&store, &id, 0, b"body", 0);
    store.finish(&id, 0, |_, _| true).unwrap();
    let (directory, _) = store.selected(&id).unwrap();
    directory
        .atomic_replace(OsStr::new(&payload(0)), b"body")
        .unwrap();
    assert!(store.read(&id).is_err());
    assert!(
        store
            .copy_verified_file(&id, 0, &mut Vec::new(), |_| true)
            .is_err()
    );
}

#[test]
fn actual_copy_rejects_a_same_inode_content_change_despite_a_saved_ready_receipt() {
    let root = tempfile::tempdir().unwrap();
    let store = SourceUploads::open(root.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    store
        .prepare(&id, manifest(&[("AGENTS.md", b"body")]))
        .unwrap();
    upload(&store, &id, 0, b"body", 0);
    store.finish(&id, 0, |_, _| true).unwrap();
    let (directory, _) = store.selected(&id).unwrap();
    let mut file = directory
        .open_read_write_file(OsStr::new(&payload(0)), false)
        .unwrap();
    file.write_all(b"evil").unwrap();
    file.sync_all().unwrap();
    assert!(
        store
            .copy_verified_file(&id, 0, &mut Vec::new(), |_| true)
            .is_err()
    );
}

#[test]
fn missing_execution_lock_is_unknown_and_never_recreated_by_controls() {
    let root = tempfile::tempdir().unwrap();
    let store = SourceUploads::open(root.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    store
        .prepare(&id, manifest(&[("AGENTS.md", b"body")]))
        .unwrap();
    let base = root
        .path()
        .join("migrations/source-transfer/browser-uploads")
        .join(&id);
    fs::remove_file(base.join("writer.lock")).unwrap();
    assert_eq!(
        store.read(&id).unwrap().worker_state,
        SourceUploadWorkerState::Unknown
    );
    assert!(store.part(&id, 0, 0, 0, b"body").is_err());
    assert!(store.resume(&id, 0, 0).is_err());
    assert!(!base.join("writer.lock").exists());
}

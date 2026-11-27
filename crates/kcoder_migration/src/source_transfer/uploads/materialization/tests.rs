use super::*;
use kcoder_types::migration::MigrationSourceKind;

fn upload(files: &[(&str, &[u8])]) -> (tempfile::TempDir, SourceUploads, String, String) {
    let profile = tempfile::tempdir().unwrap();
    let store = SourceUploads::open(profile.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let manifest = SourceUploadManifest {
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
    };
    let digest = store.prepare(&id, manifest).unwrap().manifest_sha256;
    for (index, (_, bytes)) in files.iter().enumerate() {
        for (part, bytes) in bytes.chunks(SOURCE_UPLOAD_PART_BYTES).enumerate() {
            store.part(&id, 0, index, part as u32, bytes).unwrap();
        }
    }
    store.finish(&id, 0, |_, _| true).unwrap();
    (profile, store, id, digest)
}

#[test]
fn a_ready_upload_is_not_a_product_or_an_import_and_materialization_has_its_own_lease() {
    let (_profile, store, id, digest) = upload(&[("AGENTS.md", b"Synthetic office instructions")]);
    assert!(store.product_registry(&id, &digest).is_err());
    let (prepared, worker) = store.prepare_materialization(&id, &digest).unwrap();
    assert_eq!(prepared.worker_state, SourceUploadWorkerState::Running);
    assert_eq!(store.read(&id).unwrap().stage, SourceUploadStage::Ready);
    assert!(store.product_registry(&id, &digest).is_err());
    let ready = worker.unwrap().run(|_, _| true).unwrap();
    assert_eq!(ready.stage, SourceUploadStage::Ready);
    let registry = store.product_registry(&id, &digest).unwrap();
    assert_eq!(registry.uploaded_operation_id(), Some(id.as_str()));
    assert!(!_profile.path().join("sessions").exists());
    assert!(!_profile.path().join("settings.json").exists());
}

#[test]
fn cancellation_keeps_the_original_upload_ready_and_resume_reconciles_the_original_product() {
    let data = vec![b'x'; SOURCE_UPLOAD_PART_BYTES * 2 + 31];
    let (_profile, store, id, digest) = upload(&[("AGENTS.md", &data)]);
    let (_, worker) = store.prepare_materialization(&id, &digest).unwrap();
    let mut cancelled = false;
    assert!(
        worker
            .unwrap()
            .run(|bytes, _| {
                if bytes >= SOURCE_UPLOAD_PART_BYTES as u64 && !cancelled {
                    cancelled = true;
                    let view = store
                        .cancel_materialization(&id, &digest, &uuid::Uuid::new_v4().to_string())
                        .unwrap();
                    assert_eq!(view.stage, SourceUploadStage::CancelRequested);
                    assert_eq!(view.worker_state, SourceUploadWorkerState::Running);
                    assert!(
                        store
                            .resume_materialization(
                                &id,
                                &digest,
                                view.sequence,
                                view.cancel_watermark
                            )
                            .is_err()
                    );
                }
                true
            })
            .is_err()
    );
    let current = store.read_materialization(&id, &digest).unwrap();
    assert_eq!(current.stage, SourceUploadStage::Cancelled);
    assert_eq!(store.read(&id).unwrap().stage, SourceUploadStage::Ready);
    assert_eq!(store.read(&id).unwrap().cancel_watermark, 0);
    assert!(store.resume_materialization(&id, &digest, 0, 0).is_err());
    store
        .resume_materialization(&id, &digest, current.sequence, current.cancel_watermark)
        .unwrap();
    let (_, worker) = store.prepare_materialization(&id, &digest).unwrap();
    assert_eq!(
        worker.unwrap().run(|_, _| true).unwrap().stage,
        SourceUploadStage::Ready
    );
    assert!(store.product_registry(&id, &digest).is_ok());
}

#[test]
fn a_lost_file_publication_reply_reuses_its_inode_without_another_copy() {
    let (_profile, store, id, digest) = upload(&[("AGENTS.md", b"A fixed synthetic body")]);
    let (_, worker) = store.prepare_materialization(&id, &digest).unwrap();
    worker::FAIL_FILE_PUBLISH.with(|flag| flag.set(true));
    assert!(worker.unwrap().run(|_, _| true).is_err());
    let (_, directory, _) = store.selected_product(&id, &digest).unwrap();
    let root = directory.open_child(OsStr::new(PRODUCT), false).unwrap();
    let original = root
        .portable_regular_identity(OsStr::new("AGENTS.md"))
        .unwrap();
    let failed = store.read_materialization(&id, &digest).unwrap();
    store
        .resume_materialization(&id, &digest, failed.sequence, failed.cancel_watermark)
        .unwrap();
    let (_, worker) = store.prepare_materialization(&id, &digest).unwrap();
    assert_eq!(
        worker.unwrap().run(|_, _| true).unwrap().stage,
        SourceUploadStage::Ready
    );
    assert_eq!(
        root.portable_regular_identity(OsStr::new("AGENTS.md"))
            .unwrap(),
        original
    );
}

#[test]
fn metadata_reservation_uses_actual_nodes_and_cannot_be_zero_for_empty_payloads() {
    let (_profile, store, id, digest) = upload(&[("one/two/three/empty.md", b"")]);
    let (_, worker) = store.prepare_materialization(&id, &digest).unwrap();
    drop(worker);
    let (material, _, manifest) = store.selected_product(&id, &digest).unwrap();
    assert!(metadata_budget(&manifest).unwrap() >= 4 * 1024 * 1024 + 5 * 32 * 1024);
    let saved: serde_json::Value = load(&material.root().unwrap(), &format!("reserve-{id}.json"))
        .unwrap()
        .unwrap();
    assert_eq!(
        saved["bytes"].as_u64(),
        Some(metadata_budget(&manifest).unwrap())
    );
}

mod memory;
mod publication;

#[test]
fn a_missing_born_namespace_operation_or_intent_is_unknown_and_prepare_never_repairs_it() {
    for component in ["role", "operation", "intent", "start"] {
        let (profile, store, id, digest) = upload(&[("AGENTS.md", b"Original synthetic body")]);
        let (_, worker) = store.prepare_materialization(&id, &digest).unwrap();
        worker.unwrap().run(|_, _| true).unwrap();
        let role = profile
            .path()
            .join("migrations/source-transfer/browser-products");
        let path = match component {
            "role" => role.clone(),
            "operation" => role.join(&id),
            "intent" => role.join(&id).join(INTENT),
            _ => profile
                .path()
                .join("migrations/source-transfer/browser-uploads")
                .join(&id)
                .join(START),
        };
        std::fs::rename(&path, profile.path().join("owned-withheld")).unwrap();
        assert!(store.product_registry(&id, &digest).is_err());
        assert!(store.prepare_materialization(&id, &digest).is_err());
        assert!(
            !path.exists(),
            "missing born data must not be recreated by recovery"
        );
    }
}

#[test]
fn equal_byte_replacements_unknown_files_and_a_foreign_profile_do_not_gain_product_authority() {
    for unknown in [false, true] {
        let (profile, store, id, digest) = upload(&[("AGENTS.md", b"Original synthetic body")]);
        let (_, worker) = store.prepare_materialization(&id, &digest).unwrap();
        worker.unwrap().run(|_, _| true).unwrap();
        let (_, directory, _) = store.selected_product(&id, &digest).unwrap();
        let root = directory.open_child(OsStr::new(PRODUCT), false).unwrap();
        root.atomic_replace(
            OsStr::new(if unknown { "extra.md" } else { "AGENTS.md" }),
            b"Original synthetic body",
        )
        .unwrap();
        assert!(store.product_registry(&id, &digest).is_err());
        let peer = tempfile::tempdir().unwrap();
        let peer = SourceUploads::open(peer.path()).unwrap();
        assert!(peer.product_registry(&id, &digest).is_err());
        assert!(
            profile
                .path()
                .join("migrations/source-transfer/browser-products")
                .exists()
        );
    }
}

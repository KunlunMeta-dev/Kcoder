use kcoder_state::external_history::{ExternalHistoryStore, lifecycle::ArchiveRetirementPhase};
use kcoder_types::{external_history::*, migration::MigrationSourceKind};
use sha2::{Digest, Sha256};
use std::{fs, io::Cursor};
fn archive() -> (tempfile::TempDir, ExternalHistoryStore, String) {
    let root = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let snapshot = ExternalHistorySnapshot {
        origin: ExternalHistoryOrigin {
            source: MigrationSourceKind::Codex,
            source_instance: "owned-payload-fixture".into(),
            source_session_id: "synthetic".into(),
            source_artifact_id: None,
            source_format: "fixture/1".into(),
            adapter_revision: "raw/1".into(),
            title: None,
            created_at: None,
            updated_at: None,
            project: None,
            archived: false,
            parent_session_id: None,
        },
        source_bytes: 0,
        source_sha256: format!("{:x}", Sha256::digest([])),
        record_limit: 10,
        original: None,
    };
    let mut import = store.begin_managed("first", &snapshot).unwrap();
    import.stage_source(&mut &b""[..], &mut |_| true).unwrap();
    let id = import.finish(&mut |_| true).unwrap().receipt.archive_id;
    drop(import);
    (root, store, id)
}
fn blob(store: &ExternalHistoryStore, archive: &str, id: &str, data: &[u8]) {
    let reader = store.reader(archive).unwrap();
    let mut blob = reader.attachment_blob(id, true).unwrap().unwrap();
    blob.publish(&mut Cursor::new(data), 4 * 1024 * 1024, |_| true)
        .unwrap();
}
#[cfg(any(target_os = "linux", windows))]
#[test]
fn original_payload_births_are_collected_with_the_archive_and_preserve_control_audit() {
    let (root, store, id) = archive();
    for index in 0..12 {
        blob(
            &store,
            &id,
            &format!("{index:064x}"),
            b"owned payload bytes",
        );
    }
    let operation = store.prepare_archive_retirement("retire", "first").unwrap();
    let result = store
        .run_archive_retirement("retire", operation.sequence, || true)
        .unwrap();
    assert!(
        matches!(result.phase, ArchiveRetirementPhase::Collected),
        "{:?}",
        result.failure_code
    );
    assert!(result.logical_retired && result.collected_bytes > 12 * 19);
    assert!(!root.path().join("external-history").join(&id).exists());
    assert!(
        root.path()
            .join("external-history/managed-v2")
            .join(id)
            .join("payload-tree")
            .is_dir()
    );
}
#[cfg(any(target_os = "linux", windows))]
#[test]
fn changed_payload_bytes_same_byte_replacements_and_unknown_family_entries_are_never_adopted() {
    for mode in ["bytes", "replacement", "unknown"] {
        let (root, store, id) = archive();
        let key = "a".repeat(64);
        blob(&store, &id, &key, b"original bytes");
        let path = root
            .path()
            .join("external-history")
            .join(&id)
            .join("attachments-v1")
            .join(&key);
        match mode {
            "bytes" => fs::write(path.join("payload.bin"), b"different byte").unwrap(),
            "replacement" => {
                let directory = kcoder_config::PrivateDirectory::open_existing(&path).unwrap();
                let original = directory
                    .portable_regular_identity(std::ffi::OsStr::new("payload.bin"))
                    .unwrap();
                fs::rename(
                    path.join("payload.bin"),
                    root.path().join("saved-original-payload.bin"),
                )
                .unwrap();
                directory
                    .atomic_replace(std::ffi::OsStr::new("payload.bin"), b"original bytes")
                    .unwrap();
                assert_ne!(
                    directory
                        .portable_regular_identity(std::ffi::OsStr::new("payload.bin"))
                        .unwrap(),
                    original
                );
                assert_eq!(
                    fs::read(path.join("payload.bin")).unwrap(),
                    b"original bytes"
                );
            }
            _ => fs::write(
                path.parent().unwrap().join("user-notes.md"),
                b"keep this user file",
            )
            .unwrap(),
        }
        let operation = store
            .prepare_archive_retirement("preserve", "first")
            .unwrap();
        let blocked = store
            .run_archive_retirement("preserve", operation.sequence, || true)
            .unwrap();
        assert!(matches!(blocked.phase, ArchiveRetirementPhase::Blocked));
        assert!(!blocked.logical_retired);
        assert!(store.reader(&id).is_ok());
        assert!(path.join("payload.bin").exists());
    }
}
#[cfg(any(target_os = "linux", windows))]
#[test]
fn payload_collection_cancel_and_lost_parent_checkpoint_reopen_the_original_plan() {
    let (root, store, id) = archive();
    let key = "b".repeat(64);
    blob(&store, &id, &key, &vec![7; 2 * 1024 * 1024]);
    let operation = store.prepare_archive_retirement("resume", "first").unwrap();
    let stopped = store
        .run_archive_retirement("resume", operation.sequence, || {
            let base = root.path().join("external-history");
            for entry in fs::read_dir(&base).unwrap() {
                let entry = entry.unwrap();
                if entry.file_name().to_string_lossy().starts_with("retired-") {
                    let family = entry.path().join("attachments-v1");
                    if family.exists() && !family.join(&key).exists() {
                        return false;
                    }
                }
            }
            true
        })
        .unwrap();
    assert!(stopped.logical_retired);
    assert!(matches!(stopped.phase, ArchiveRetirementPhase::Retired));
    assert!(stopped.collected_bytes >= 2 * 1024 * 1024);
    let metadata = root
        .path()
        .join("external-history/managed-v2/lifecycle.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    value["retirements"]["resume"]["payload_removed_bytes"] = serde_json::json!(0);
    value["retirements"]["resume"]["payload_removed_nodes"] = serde_json::json!(0);
    fs::write(&metadata, serde_json::to_vec(&value).unwrap()).unwrap();
    drop(store);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let previous = store.read_archive_retirement("resume").unwrap();
    let done = store
        .run_archive_retirement("resume", previous.sequence, || true)
        .unwrap();
    assert!(
        matches!(done.phase, ArchiveRetirementPhase::Collected),
        "{:?}",
        done.failure_code
    );
    assert!(done.collected_bytes > stopped.collected_bytes);
    assert!(!root.path().join("external-history").join(&id).exists());
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn a_mutable_local_copy_tree_is_owned_separately_from_its_selected_source_and_collected_after_ready()
 {
    use kcoder_state::external_history::local_attachment::SelectedLocalFile;
    use kcoder_types::local_attachment::HistoricalLocalAttachmentStage;
    let (root, store, id) = archive();
    let chosen = root.path().join("explicit-choice");
    kcoder_config::PrivateDirectory::open_or_create(&chosen).unwrap();
    fs::write(chosen.join("data.bin"), b"explicitly selected bytes").unwrap();
    let selected =
        SelectedLocalFile::select(&chosen, std::path::Path::new("data.bin"), true, |_| true)
            .unwrap();
    let operation = uuid::Uuid::new_v4().to_string();
    let reference = "c".repeat(64);
    {
        let reader = store.reader(&id).unwrap();
        let local = reader
            .local_attachment_import(&operation, true)
            .unwrap()
            .unwrap();
        let authorized = local.authorize(&reference, &selected).unwrap();
        let ready = local
            .run(&reference, authorized.sequence, |_| true)
            .unwrap();
        assert!(ready.stage == HistoricalLocalAttachmentStage::Ready);
        assert_eq!(
            local
                .read_chunk(&reference, ready.receipt.as_ref().unwrap(), 0, 128)
                .unwrap(),
            b"explicitly selected bytes"
        );
    }
    let retirement = store
        .prepare_archive_retirement("local-retire", "first")
        .unwrap();
    let done = store
        .run_archive_retirement("local-retire", retirement.sequence, || true)
        .unwrap();
    assert!(
        matches!(done.phase, ArchiveRetirementPhase::Collected),
        "{:?}",
        done.failure_code
    );
    assert!(!root.path().join("external-history").join(&id).exists());
    assert_eq!(
        fs::read(chosen.join("data.bin")).unwrap(),
        b"explicitly selected bytes"
    );
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn a_payload_leaf_delete_lost_ack_is_reconciled_from_its_original_node_pending_receipt() {
    let (root, store, id) = archive();
    let key = "d".repeat(64);
    blob(&store, &id, &key, b"known blob");
    let operation = store
        .prepare_archive_retirement("leaf-window", "first")
        .unwrap();
    let stopped = store
        .run_archive_retirement("leaf-window", operation.sequence, || {
            for entry in fs::read_dir(root.path().join("external-history")).unwrap() {
                let entry = entry.unwrap();
                if entry.file_name().to_string_lossy().starts_with("retired-") {
                    let child = entry.path().join("attachments-v1").join(&key);
                    if child.exists() && !child.join("payload.bin").exists() {
                        return false;
                    }
                }
            }
            true
        })
        .unwrap();
    assert!(stopped.logical_retired && matches!(stopped.phase, ArchiveRetirementPhase::Retired));
    let control = root
        .path()
        .join("external-history/managed-v2")
        .join(&id)
        .join("payload-tree");
    let plan = fs::read_dir(&control)
        .unwrap()
        .map(Result::unwrap)
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("retirement-")
        })
        .unwrap()
        .path();
    let progress = plan.join("progress-00000.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&progress).unwrap()).unwrap();
    value["removed"]
        .as_array_mut()
        .unwrap()
        .retain(|name| name.as_str() != Some("payload.bin"));
    value["pending"] = serde_json::json!("payload.bin");
    fs::write(&progress, serde_json::to_vec(&value).unwrap()).unwrap();
    drop(store);
    let store = ExternalHistoryStore::open_existing(root.path())
        .unwrap()
        .unwrap();
    let previous = store.read_archive_retirement("leaf-window").unwrap();
    let done = store
        .run_archive_retirement("leaf-window", previous.sequence, || true)
        .unwrap();
    assert!(
        matches!(done.phase, ArchiveRetirementPhase::Collected),
        "{:?}",
        done.failure_code
    );
    assert!(!root.path().join("external-history").join(&id).exists());
}

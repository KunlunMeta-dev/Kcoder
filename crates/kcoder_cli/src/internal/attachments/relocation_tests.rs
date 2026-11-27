use super::*;

#[test]
fn empty_locked_attachment_entries_are_observed_without_reading_locked_ranges() {
    for payload in [b"".as_slice(), b"retained".as_slice()] {
        let temp = tempfile::tempdir().unwrap();
        let session = temp.path().join("session");
        let attachments = PrivateDirectory::open_or_create(&session.join("attachments")).unwrap();
        let name = OsStr::new("existing-entry");
        attachments.atomic_replace(name, payload).unwrap();
        let held = attachments.open_read_write_file(name, false).unwrap();
        fs2::FileExt::try_lock_exclusive(&held).unwrap();
        let snapshot = relocation_snapshot(&session, "thread-a");
        if payload.is_empty() {
            let snapshot = snapshot.unwrap();
            let entry = &snapshot.files[Path::new("attachments/existing-entry")];
            assert_eq!(entry.size, 0);
            assert_eq!(entry.sha256, hex_sha256(b""));
        } else if cfg!(windows) {
            assert!(snapshot.is_err());
        }
        let contender = attachments.open_read_write_file(name, false).unwrap();
        assert!(fs2::FileExt::try_lock_exclusive(&contender).is_err());
        drop(held);
        assert_eq!(
            std::fs::read(session.join("attachments/existing-entry")).unwrap(),
            payload
        );
    }
}

pub(super) fn publish(
    source: &Path,
    target: &Path,
    operation: &str,
) -> (
    kcoder_config::storage::StorageCoordinator,
    kcoder_config::storage::StoragePublishedComponent,
) {
    use kcoder_config::storage::{StorageCoordinator, StorageResolveInput, resolve_storage_paths};
    use kcoder_types::{
        StorageLaunchIntent, StorageLocationRecord, StorageMigrationComponent,
        StorageMigrationPhase as Phase, StorageMigrationPlan, StorageTargetBinding,
    };
    let home = target.parent().unwrap().join("migration-control");
    PrivateDirectory::open_or_create(&home).unwrap();
    let parent = target.parent().unwrap();
    let mut coordinator = StorageCoordinator::acquire(&home).unwrap();
    let plan = StorageMigrationPlan {
        version: 1,
        operation_id: operation.into(),
        original: None,
        from: resolve_storage_paths(&StorageResolveInput {
            home: Some(home.clone()),
            ..Default::default()
        })
        .unwrap(),
        target: StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: target.into(),
            cache_root: home.join("cache"),
            operation_id: Some(operation.into()),
        },
        components: vec![StorageMigrationComponent {
            domain: kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
            source: source.into(),
            destination: target.into(),
            source_identity: PrivateDirectory::open_existing(source)
                .unwrap()
                .directory_identity()
                .unwrap(),
            estimated_bytes: 0,
        }],
        target_bindings: vec![StorageTargetBinding {
            path: target.into(),
            existing_ancestor: parent.into(),
            ancestor_identity: PrivateDirectory::open_existing(parent)
                .unwrap()
                .directory_identity()
                .unwrap(),
        }],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    };
    coordinator.begin(plan).unwrap();
    for (from, to) in [
        (Phase::Planned, Phase::Stopping),
        (Phase::Stopping, Phase::Stopped),
        (Phase::Stopped, Phase::Copying),
    ] {
        coordinator
            .advance(operation, from, to)
            .with_context(|| {
                format!(
                    "test publication {operation} {from:?} -> {to:?} at {}",
                    source.display()
                )
            })
            .unwrap();
    }
    coordinator
        .publish_component(
            operation,
            kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN,
            &std::collections::BTreeSet::new(),
        )
        .unwrap();
    let proof = coordinator
        .open_published_component(operation, kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN)
        .unwrap();
    (coordinator, proof)
}

#[test]
fn old_history_address_reads_the_final_copy_without_changing_visible_text() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("old/session-a");
    let history = source.join("attachments/turn-a");
    let parent = PrivateDirectory::open_or_create(&history).unwrap();
    parent
        .atomic_replace(OsStr::new("00-note.txt"), b"original history")
        .unwrap();
    let old = history.join("00-note.txt");
    let prompt = format!(
        "User cwd {}\n{KCODER_ATTACHMENTS_OPEN}{}{KCODER_ATTACHMENTS_CLOSE}",
        source.display(),
        serde_json::json!({"filename":"note.txt","path":old})
    );
    std::fs::write(source.join("history.jsonl"), &prompt).unwrap();
    let snapshot = relocation_snapshot(&source, "thread-a").unwrap();
    let target = temp.path().join("new/session-a");
    let (_coordinator, published) = publish(
        source.parent().unwrap(),
        target.parent().unwrap(),
        "operation-a",
    );
    relocate(&source, &target, "operation-a", &snapshot, &published).unwrap();
    verify_relocation(&source, &target, "operation-a", &snapshot, &published).unwrap();
    relocate(&source, &target, "operation-a", &snapshot, &published).unwrap();
    assert_eq!(
        std::fs::read_to_string(source.join("history.jsonl")).unwrap(),
        prompt
    );
    std::fs::write(&old, b"changed source!").unwrap();
    let read = attachment_read(
        &target.join("attachments"),
        &AttachmentReadParams {
            thread_id: "thread-a".into(),
            path: old.to_string_lossy().into_owned(),
        },
        &AttachmentDirectories::default(),
    )
    .unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(read.content_base64)
            .unwrap(),
        b"original history"
    );
    assert!(resolve_session_path(&target, &old).unwrap().is_some());
    assert!(
        attachment_read(
            &temp.path().join("peer/attachments"),
            &AttachmentReadParams {
                thread_id: "thread-b".into(),
                path: old.to_string_lossy().into_owned()
            },
            &AttachmentDirectories::default()
        )
        .is_err()
    );
    let current = target.join("attachments/turn-a/00-note.txt");
    let parent = PrivateDirectory::open_existing(current.parent().unwrap()).unwrap();
    let original_handle = parent
        .open_single_link_regular_file(current.file_name().unwrap())
        .unwrap();
    let original_identity = parent
        .portable_regular_handle_identity(&original_handle)
        .unwrap();
    std::fs::remove_file(&current).unwrap();
    parent
        .atomic_replace(current.file_name().unwrap(), b"original history")
        .unwrap();
    let replacement_identity = parent
        .portable_regular_identity(current.file_name().unwrap())
        .unwrap();
    assert_ne!(original_identity, replacement_identity);
    assert!(
        resolve_session_path(&target, &old).is_err(),
        "same bytes at a new inode are not the original published file"
    );
    drop(original_handle);
}

#[test]
fn durable_draft_recovers_the_original_owner_and_old_address_after_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("old/session-a");
    PrivateDirectory::open_or_create(&source).unwrap();
    let mut staged = AttachmentDirectories::default();
    let upload = attachment_save(
        "thread-a",
        &AttachmentSaveParams {
            filename: "draft.txt".into(),
            content_base64: "aGVsbG8=".into(),
            retention: None,
        },
        &mut staged,
    )
    .unwrap();
    let mut params = kcoder_app_protocol::AttachmentDraftRetainParams {
        thread_id: "thread-a".into(),
        owner_scope: "a".repeat(64),
        paths: vec![upload.path],
        recover_only: false,
    };
    let draft = retain_draft_attachments(&source, &params, &mut staged)
        .unwrap()
        .drafts
        .remove(0)
        .path;
    assert!(
        relocation_snapshot(&source, "thread-a").is_err(),
        "a live owner remains busy"
    );
    drop(staged);
    let snapshot = relocation_snapshot(&source, "thread-a").unwrap();
    let target = temp.path().join("new/session-a");
    let (_coordinator, published) = publish(
        source.parent().unwrap(),
        target.parent().unwrap(),
        "draft-op",
    );
    relocate(&source, &target, "draft-op", &snapshot, &published).unwrap();
    params.paths = vec![draft.clone()];
    params.recover_only = true;
    let mut recovered = AttachmentDirectories::default();
    retain_draft_attachments(&target, &params, &mut recovered).unwrap();
    let read = attachment_read(
        &target.join("attachments"),
        &AttachmentReadParams {
            thread_id: "thread-a".into(),
            path: draft.clone(),
        },
        &recovered,
    )
    .unwrap();
    assert_eq!(read.content_base64, "aGVsbG8=");
    let mut foreign = params.clone();
    foreign.owner_scope = "b".repeat(64);
    assert!(
        retain_draft_attachments(&target, &foreign, &mut AttachmentDirectories::default()).is_err()
    );
    let prompt = format!(
        "{KCODER_ATTACHMENTS_OPEN}{}{KCODER_ATTACHMENTS_CLOSE}",
        serde_json::json!({"filename":"draft.txt","path":draft})
    );
    materialize_turn_attachments(
        &target.join("attachments"),
        "thread-a",
        "turn-a",
        &prompt,
        &mut recovered,
    )
    .unwrap();
}

#[cfg(unix)]
#[test]
fn linked_external_payload_and_changed_operation_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("old/session-a");
    let parent = PrivateDirectory::open_or_create(&source.join("attachments/turn-a")).unwrap();
    parent
        .atomic_replace(OsStr::new("note.txt"), b"hello")
        .unwrap();
    let snapshot = relocation_snapshot(&source, "thread-a").unwrap();
    let target = temp.path().join("new/session-a");
    let (_coordinator, published) =
        publish(source.parent().unwrap(), target.parent().unwrap(), "first");
    relocate(&source, &target, "first", &snapshot, &published).unwrap();
    assert!(
        relocate(
            &source,
            &target,
            "replacement-operation",
            &snapshot,
            &published
        )
        .is_err()
    );
    let outside = temp.path().join("external.txt");
    std::fs::write(&outside, b"external").unwrap();
    std::os::unix::fs::symlink(&outside, source.join("attachments/turn-a/external.txt")).unwrap();
    assert!(relocation_snapshot(&source, "thread-a").is_err());
    assert_eq!(std::fs::read(&outside).unwrap(), b"external");
}

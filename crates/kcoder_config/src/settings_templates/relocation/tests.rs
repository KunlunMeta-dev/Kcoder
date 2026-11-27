use super::*;
use std::io::Read;

const CONTENT: &str = r#"{"permission_mode":"ask"}"#;

fn import(store: &SettingsTemplateStore, id: &str) -> TemplateImportRef {
    let reference = store.prepare_owned(id, id, None, CONTENT).unwrap();
    store.install_owned(&reference, CONTENT).unwrap();
    reference
}

fn copy_directory(source: &PrivateDirectory, target: &PrivateDirectory) {
    source
        .visit_entry_names_bounded(4096, |name| {
            if source.entry_metadata(name)?.is_dir() {
                copy_directory(
                    &source.open_child(name, false)?,
                    &target.create_private_child(name)?,
                );
                return Ok(());
            }
            let mut bytes = Vec::new();
            let file = source.open_single_link_regular_file(name)?;
            // Windows enforces byte-range locks even for an EOF read. The
            // stopped copier need not read any bytes from an empty mutex.
            if file.metadata()?.len() != 0 {
                file.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
            }
            target.atomic_replace(name, &bytes)
        })
        .unwrap();
}

fn map_profile(source: &SettingsTemplateStore, target: &Path, operation: &str) {
    let target = PrivateDirectory::open_existing(target).unwrap();
    ProfileIdentity::observe(&source.directory)
        .unwrap()
        .relocate(&source.directory, &target, operation)
        .unwrap();
}

#[test]
fn relocation_rebinds_only_active_import_stamps_and_preserves_frozen_and_terminal_receipts() {
    let root = tempfile::tempdir().unwrap();
    let target_root = tempfile::tempdir().unwrap();
    let source = SettingsTemplateStore::open(root.path()).unwrap();
    let active = import(&source, "active");
    let superseded = import(&source, "superseded");
    source
        .save(&SettingsTemplateSaveParams {
            id: Some("superseded".into()),
            name: "User edited".into(),
            description: None,
            content: r#"{"permission_mode":"auto"}"#.into(),
        })
        .unwrap();
    let undone = import(&source, "undone");
    source.undo_owned(&undone).unwrap();
    let (_, binding) = source.freeze_for_session("active").unwrap();
    source.set_default(Some("active")).unwrap();
    let original_index = source.read_index().unwrap();
    let prepared = source
        .prepare_relocation("owned-template-relocation")
        .unwrap();
    let target = PrivateDirectory::open_existing(target_root.path()).unwrap();
    copy_directory(&source.directory, &target);
    let copied = SettingsTemplateStore::open(target_root.path()).unwrap();
    assert!(copied.import_state(&active).is_err());
    assert!(prepared.verify_target(target_root.path()).is_err());
    map_profile(&source, target_root.path(), "owned-template-relocation");
    assert_eq!(
        copied.import_state(&active).unwrap_err().to_string(),
        "settings_template_import_target_changed"
    );
    let snapshot = std::fs::read(source.observe_recorded_session_path(&binding).unwrap()).unwrap();
    prepared.relocate(target_root.path()).unwrap();
    prepared.verify_target(target_root.path()).unwrap();
    assert_eq!(
        copied.import_state(&active).unwrap(),
        Some(TemplateImportState::Committed)
    );
    assert_eq!(
        copied.import_state(&superseded).unwrap(),
        Some(TemplateImportState::Superseded)
    );
    assert_eq!(
        copied.import_state(&undone).unwrap(),
        Some(TemplateImportState::Undone)
    );
    assert_eq!(
        std::fs::read(copied.observe_recorded_session_path(&binding).unwrap()).unwrap(),
        snapshot
    );
    let target_index = copied.read_index().unwrap();
    assert_eq!(target_index.templates, original_index.templates);
    assert_eq!(target_index.default_id, original_index.default_id);
    for (id, original) in &original_index.imports {
        let relocated = &target_index.imports[id];
        assert_eq!(relocated.reference, original.reference);
        assert_eq!(relocated.state, original.state);
        assert_eq!(relocated.entry, original.entry);
        if original.state == TemplateImportState::Committed {
            assert!(
                original
                    .stamp
                    .as_ref()
                    .unwrap()
                    .same_content(relocated.stamp.as_ref().unwrap())
            );
            assert!(original.stamp != relocated.stamp);
        } else {
            assert!(original.stamp == relocated.stamp);
        }
    }
    let index_bytes = copied
        .read_file(INDEX_FILE, storage::INDEX_LIMIT)
        .unwrap()
        .unwrap();
    prepared.relocate(target_root.path()).unwrap();
    assert_eq!(
        copied
            .read_file(INDEX_FILE, storage::INDEX_LIMIT)
            .unwrap()
            .unwrap(),
        index_bytes
    );
    drop(prepared);
    copied.set_default(None).unwrap();
    assert_eq!(
        copied.undo_owned(&active).unwrap(),
        TemplateImportState::Undone
    );
}

#[test]
fn pending_transaction_preview_is_read_only_and_source_recovery_precedes_copying() {
    for step in 1..=4 {
        let root = tempfile::tempdir().unwrap();
        let target_root = tempfile::tempdir().unwrap();
        let source = SettingsTemplateStore::open(root.path()).unwrap();
        let reference = source
            .prepare_owned("active", "Active", None, CONTENT)
            .unwrap();
        transaction::FAIL_STEP.with(|value| value.set(step));
        assert!(source.install_owned(&reference, CONTENT).is_err());
        transaction::FAIL_STEP.with(|value| value.set(0));
        let journal = source
            .read_file(".transaction.json", 16 * 1024)
            .unwrap()
            .unwrap();
        assert_eq!(
            source.preview_relocation().unwrap_err().to_string(),
            "SETTINGS_TEMPLATE_RELOCATION_RECOVERY_REQUIRED"
        );
        assert_eq!(
            source
                .read_file(".transaction.json", 16 * 1024)
                .unwrap()
                .unwrap(),
            journal
        );
        let prepared = source
            .prepare_relocation("recover-original-template")
            .unwrap();
        assert!(
            source
                .read_file(".transaction.json", 16 * 1024)
                .unwrap()
                .is_none()
        );
        let before = source.read_index().unwrap().imports[&reference.operation_id].state;
        assert_eq!(
            before,
            if step == 4 {
                TemplateImportState::Committed
            } else {
                TemplateImportState::Staged
            }
        );
        copy_directory(
            &source.directory,
            &PrivateDirectory::open_existing(target_root.path()).unwrap(),
        );
        map_profile(&source, target_root.path(), "recover-original-template");
        prepared.relocate(target_root.path()).unwrap();
        let copied = SettingsTemplateStore::open(target_root.path()).unwrap();
        assert_eq!(copied.import_state(&reference).unwrap(), Some(before));
    }
}

#[test]
fn lost_ack_reconciles_the_original_operation_without_reissuing_an_index() {
    let root = tempfile::tempdir().unwrap();
    let target_root = tempfile::tempdir().unwrap();
    let source = SettingsTemplateStore::open(root.path()).unwrap();
    let reference = import(&source, "active");
    let prepared = source.prepare_relocation("original-operation").unwrap();
    copy_directory(
        &source.directory,
        &PrivateDirectory::open_existing(target_root.path()).unwrap(),
    );
    map_profile(&source, target_root.path(), "original-operation");
    prepared.lose_ack.set(true);
    assert_eq!(
        prepared
            .relocate(target_root.path())
            .unwrap_err()
            .to_string(),
        "SETTINGS_TEMPLATE_RELOCATION_UNCONFIRMED"
    );
    let copied = SettingsTemplateStore::open(target_root.path()).unwrap();
    let directory = copied.directory(false).unwrap().unwrap();
    let index_identity = directory
        .regular_file_identity(OsStr::new(INDEX_FILE))
        .unwrap();
    drop(prepared);
    let resumed = source.prepare_relocation("original-operation").unwrap();
    resumed.relocate(target_root.path()).unwrap();
    resumed.verify_target(target_root.path()).unwrap();
    assert_eq!(
        directory
            .regular_file_identity(OsStr::new(INDEX_FILE))
            .unwrap(),
        index_identity
    );
    assert_eq!(
        copied.import_state(&reference).unwrap(),
        Some(TemplateImportState::Committed)
    );
    drop(resumed);
    let unrelated = source.prepare_relocation("different-operation").unwrap();
    let index_bytes = copied.read_file(INDEX_FILE, storage::INDEX_LIMIT).unwrap();
    // The coordinator owns operation admission; the stable seed is not a move
    // ledger. Already-adapted data is verified without another index write.
    unrelated.relocate(target_root.path()).unwrap();
    unrelated.verify_target(target_root.path()).unwrap();
    assert_eq!(
        copied.read_file(INDEX_FILE, storage::INDEX_LIMIT).unwrap(),
        index_bytes
    );
    assert_eq!(
        directory
            .regular_file_identity(OsStr::new(INDEX_FILE))
            .unwrap(),
        index_identity
    );
}

#[test]
fn preview_creates_nothing_and_a_live_owner_blocks_preparation() {
    let root = tempfile::tempdir().unwrap();
    let source = SettingsTemplateStore::open(root.path()).unwrap();
    assert_eq!(source.preview_relocation().unwrap().templates, 0);
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    let owner = source
        .directory
        .try_exclusive_lock(OsStr::new(LOCK))
        .unwrap()
        .unwrap();
    assert!(source.preview_relocation().is_err());
    assert!(source.prepare_relocation("live-owner").is_err());
    drop(owner);
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn changed_source_and_replaced_frozen_binding_block_target_adaptation() {
    for change_source in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let target_root = tempfile::tempdir().unwrap();
        let source = SettingsTemplateStore::open(root.path()).unwrap();
        import(&source, "active");
        let (_, binding) = source.freeze_for_session("active").unwrap();
        let prepared = source.prepare_relocation("tamper-negative").unwrap();
        copy_directory(
            &source.directory,
            &PrivateDirectory::open_existing(target_root.path()).unwrap(),
        );
        map_profile(&source, target_root.path(), "tamper-negative");
        let copied = SettingsTemplateStore::open(target_root.path()).unwrap();
        let index_before = copied.read_file(INDEX_FILE, storage::INDEX_LIMIT).unwrap();
        if change_source {
            source
                .directory(false)
                .unwrap()
                .unwrap()
                .atomic_replace(OsStr::new("active.jsonc"), CONTENT.as_bytes())
                .unwrap();
        } else {
            copied
                .bindings_directory(false)
                .unwrap()
                .unwrap()
                .atomic_replace(OsStr::new(&bindings::filename(&binding).unwrap()), b"{}")
                .unwrap();
        }
        assert!(prepared.relocate(target_root.path()).is_err());
        assert_eq!(
            copied.read_file(INDEX_FILE, storage::INDEX_LIMIT).unwrap(),
            index_before
        );
    }
}
#[cfg(windows)]
#[test]
fn ordinary_template_lock_requires_empty_content_and_real_exclusion() {
    use fs2::FileExt;
    let temporary = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_existing(temporary.path()).unwrap();
    let directory = parent.create_private_child(OsStr::new("profile")).unwrap();
    let path = temporary.path().join("profile");
    let lock_path = path.join(LOCK);
    // Exercise the ordinary Windows file creator, without an ACL repair step.
    let lock = std::fs::OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(&lock_path)
        .unwrap();
    let identity = PrivateDirectory::identity_of_file(&lock).unwrap();
    let store = SettingsTemplateStore::open(&path).unwrap();
    store.preview_relocation().unwrap();
    lock.lock_exclusive().unwrap();
    assert_eq!(
        store.preview_relocation().unwrap_err().to_string(),
        "SETTINGS_TEMPLATE_RELOCATION_BUSY"
    );
    FileExt::unlock(&lock).unwrap();
    store.preview_relocation().unwrap();
    assert_eq!(
        directory.regular_file_identity(OsStr::new(LOCK)).unwrap(),
        identity
    );
    assert_eq!(std::fs::metadata(&lock_path).unwrap().len(), 0);
    std::fs::write(&lock_path, b"not a coordination-only leaf").unwrap();
    assert!(store.preview_relocation().is_err());
}

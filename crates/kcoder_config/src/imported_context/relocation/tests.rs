use super::*;

struct Fixture {
    root: tempfile::TempDir,
    profile: PathBuf,
    workspace: PathBuf,
    store: ImportedContextStore,
}

impl Fixture {
    fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        let profile = root.path().join("source");
        let workspace = root.path().join("external-project");
        PrivateDirectory::open_or_create(&profile)?;
        PrivateDirectory::open_or_create(&workspace)?;
        crate::FolderTrustStore::load(&profile).trust(&workspace)?;
        let store = ImportedContextStore::open(&profile)?;
        let scope = ImportedContextScope::Project {
            root: workspace.clone(),
        };
        let record = ImportedContext {
            id: "ctx-original".into(),
            operation_id: "original-import".into(),
            name: "Original note".into(),
            kind: ImportedContextKind::Memory,
            memory_workspace_identity: store.capture_memory_workspace(&scope)?,
            scope,
            content: "UNVERIFIED_REFERENCE".into(),
            enabled: false,
            memory_provenance: None,
            instruction_provenance: None,
        };
        store.create(record)?;
        Ok(Self {
            root,
            profile,
            workspace,
            store,
        })
    }
    fn copy(&self, source: &ImportedContextStore, name: &str) -> Result<PathBuf> {
        let path = self.root.path().join(name);
        let directory = PrivateDirectory::open_or_create(&path)?;
        for name in [STATE, LOCK] {
            directory
                .atomic_replace(OsStr::new(name), &read(&source.directory, name, MAX_BYTES)?)?;
        }
        if let Some(bytes) = optional_receipt(&source.directory)? {
            directory.atomic_replace(OsStr::new(RECEIPT), &bytes)?;
        }
        crate::FolderTrustStore::load(&path).trust(&self.workspace)?;
        Ok(path)
    }
}

#[test]
fn binding_convergence_context_does_not_create_a_second_migration_ledger() -> Result<()> {
    let f = Fixture::new()?;
    let expected = f.store.relocation_snapshot()?;
    let path = f.copy(&f.store, "first-target")?;
    let first = f.store.relocate(&path, "first-move", &expected)?;
    assert!(!path.join(RECEIPT).exists());
    let expected = first.relocation_snapshot()?;
    let second_path = f.copy(&first, "second-target")?;
    let second = first.relocate(&second_path, "second-move", &expected)?;
    assert!(!second_path.join(RECEIPT).exists());
    assert_eq!(second.list()?, f.store.list()?);
    Ok(())
}

#[test]
fn observe_absent_context_and_ordinary_empty_reader_lock_without_initialization() -> Result<()> {
    let root = tempfile::tempdir()?;
    let missing = root.path().join("missing-profile");
    assert!(ImportedContextStore::observe(&missing)?.is_none());
    assert!(!missing.exists());
    let profile = root.path().join("profile");
    let directory = PrivateDirectory::open_or_create(&profile)?;
    assert!(ImportedContextStore::observe(&profile)?.is_none());
    assert_eq!(std::fs::read_dir(&profile)?.count(), 0);
    let store = ImportedContextStore::open(&profile)?;
    assert!(store.list()?.is_empty());
    let original_lock = directory.portable_regular_identity(OsStr::new(LOCK))?;
    assert!(ImportedContextStore::observe(&profile)?.is_none());
    assert!(directory.portable_regular_identity(OsStr::new(LOCK))? == original_lock);
    assert!(!profile.join(STATE).exists());
    assert!(!profile.join(RECEIPT).exists());
    assert_eq!(std::fs::read_dir(&profile)?.count(), 1);
    assert!(store.relocation_snapshot().is_err());
    Ok(())
}

#[test]
fn observe_existing_context_reuses_original_data_binding_and_respects_its_lease() -> Result<()> {
    let f = Fixture::new()?;
    let before = read(&f.store.directory, STATE, MAX_BYTES)?;
    let original = f.store.relocation_snapshot()?;
    let observed = ImportedContextStore::observe(&f.profile)?.unwrap();
    assert_eq!(observed.list()?, f.store.list()?);
    assert!(observed.relocation_snapshot()? == original);
    assert_eq!(read(&f.store.directory, STATE, MAX_BYTES)?, before);
    let lease = f
        .store
        .directory
        .try_existing_exclusive_lock(OsStr::new(LOCK))?
        .unwrap();
    assert!(ImportedContextStore::observe(&f.profile).is_err());
    assert_eq!(read(&f.store.directory, STATE, MAX_BYTES)?, before);
    assert!(!f.profile.join(RECEIPT).exists());
    drop(lease);
    Ok(())
}

#[test]
fn observe_partial_context_does_not_recreate_state_lock_or_relocation_receipt() -> Result<()> {
    let f = Fixture::new()?;
    let original = read(&f.store.directory, STATE, MAX_BYTES)?;
    f.store.directory.remove_regular_file(OsStr::new(LOCK))?;
    assert_eq!(
        ImportedContextStore::observe(&f.profile)
            .err()
            .unwrap()
            .to_string(),
        "imported_context_initialization_unconfirmed"
    );
    assert!(!f.profile.join(LOCK).exists());
    assert_eq!(read(&f.store.directory, STATE, MAX_BYTES)?, original);
    for has_lock in [false, true] {
        let root = tempfile::tempdir()?;
        let directory = PrivateDirectory::open_existing(root.path())?;
        if has_lock {
            directory.open_read_write_file(OsStr::new(LOCK), true)?;
        }
        directory.atomic_replace(OsStr::new(RECEIPT), b"UNCONFIRMED_RECEIPT")?;
        assert_eq!(
            ImportedContextStore::observe(root.path())
                .err()
                .unwrap()
                .to_string(),
            "imported_context_initialization_unconfirmed"
        );
        assert_eq!(
            read(&directory, RECEIPT, RECEIPT_LIMIT)?,
            b"UNCONFIRMED_RECEIPT"
        );
        assert!(!root.path().join(STATE).exists());
        assert_eq!(root.path().join(LOCK).exists(), has_lock);
    }
    Ok(())
}

#[test]
fn exact_state_activation_control_receipts_and_external_paths_survive_original_operation_replay()
-> Result<()> {
    let f = Fixture::new()?;
    let record = f.store.list()?.remove(0);
    let request = ImportedMemoryControl {
        request_id: "enable-original".into(),
        id: record.id.clone(),
        owner_operation_id: record.operation_id.clone(),
        expected_revision: imported_context_revision(&record)?,
        enabled: true,
        confirm_unverified_notes: true,
    };
    let receipt = f.store.memory_control(&request)?;
    let expected = f.store.relocation_snapshot()?;
    let before = read(&f.store.directory, STATE, MAX_BYTES)?;
    let path = f.copy(&f.store, "target")?;
    f.store
        .verify_relocation(&path, "original-move", &expected)?;
    drop(f.store.relocate(&path, "original-move", &expected)?);
    let target = f.store.relocate(&path, "original-move", &expected)?;
    let witness = optional_receipt(&target.directory)?;
    f.store
        .verify_relocation(&path, "original-move", &expected)?;
    assert_eq!(optional_receipt(&target.directory)?, witness);
    assert_eq!(read(&target.directory, STATE, MAX_BYTES)?, before);
    assert_eq!(read(&f.store.directory, STATE, MAX_BYTES)?, before);
    assert_eq!(target.list()?, f.store.list()?);
    assert!(target.memory_control_receipt(&request.request_id)? == Some(receipt));
    f.store
        .verify_relocation(&path, "different-operation", &expected)?;
    let expected = target.relocation_snapshot()?;
    let second_path = f.copy(&target, "second-target")?;
    let second = target.relocate(&second_path, "second-move", &expected)?;
    assert_eq!(read(&second.directory, STATE, MAX_BYTES)?, before);
    assert_eq!(
        second.list()?[0].scope,
        ImportedContextScope::Project {
            root: f.workspace.clone()
        }
    );
    Ok(())
}

#[test]
fn revoked_trust_replaced_external_project_and_source_edits_block_before_witness_publication()
-> Result<()> {
    for reason in ["trust", "replace", "edit"] {
        let f = Fixture::new()?;
        let expected = f.store.relocation_snapshot()?;
        let target = f.copy(&f.store, "target")?;
        match reason {
            "trust" => crate::FolderTrustStore::load(&f.profile).revoke(&f.workspace)?,
            "replace" => {
                std::fs::rename(&f.workspace, f.root.path().join("held-original"))?;
                PrivateDirectory::open_or_create(&f.workspace)?;
            }
            _ => {
                f.store
                    .set_enabled("ctx-original", "original-import", true)?;
            }
        }
        assert!(f.store.relocate(&target, "migration", &expected).is_err());
        assert!(!target.join(RECEIPT).exists());
    }
    Ok(())
}

#[test]
fn real_source_lease_and_changed_target_are_preserved_and_missing_state_is_never_initialized()
-> Result<()> {
    let f = Fixture::new()?;
    let expected = f.store.relocation_snapshot()?;
    let path = f.copy(&f.store, "target")?;
    let lease = f
        .store
        .directory
        .try_existing_shared_lock(OsStr::new(LOCK))?;
    assert!(lease.is_some());
    assert!(f.store.relocate(&path, "migration", &expected).is_err());
    drop(lease);
    let directory = PrivateDirectory::open_existing(&path)?;
    directory.atomic_replace(OsStr::new(STATE), b"UNKNOWN_TARGET_CONTENT")?;
    assert!(f.store.relocate(&path, "migration", &expected).is_err());
    assert_eq!(
        read(&directory, STATE, MAX_BYTES)?,
        b"UNKNOWN_TARGET_CONTENT"
    );
    assert!(!path.join(RECEIPT).exists());
    let empty = f.root.path().join("empty");
    PrivateDirectory::open_or_create(&empty)?;
    assert!(
        ImportedContextStore::open(&empty)?
            .relocation_snapshot()
            .is_err()
    );
    assert!(!empty.join(LOCK).exists());
    assert!(!empty.join(STATE).exists());
    Ok(())
}

#[test]
fn old_context_receipt_is_preserved_as_history_across_two_moves_and_conflicts_are_not_repaired()
-> Result<()> {
    let f = Fixture::new()?;
    let snapshot = f.store.relocation_snapshot()?;
    let legacy = RelocationReceipt {
        version: 1,
        operation_id: "legacy-operation".into(),
        source: snapshot.clone(),
        target_profile_identity: "historical-profile".into(),
        target_lock_identity: snapshot.lock_identity.clone(),
        target_state_identity: snapshot.state_identity.clone(),
    };
    let history = serde_json::to_vec(&legacy)?;
    f.store
        .directory
        .atomic_replace(OsStr::new(RECEIPT), &history)?;
    let expected = f.store.relocation_snapshot()?;
    let first_path = f.copy(&f.store, "first-legacy-target")?;
    let first = f.store.relocate(&first_path, "first-move", &expected)?;
    assert_eq!(optional_receipt(&first.directory)?, Some(history.clone()));
    let expected = first.relocation_snapshot()?;
    let second_path = f.copy(&first, "second-legacy-target")?;
    let second = first.relocate(&second_path, "second-move", &expected)?;
    assert_eq!(optional_receipt(&second.directory)?, Some(history.clone()));
    let mut conflicting: serde_json::Value = serde_json::from_slice(&history)?;
    conflicting["operationId"] = serde_json::json!("unknown-peer-operation");
    let bytes = serde_json::to_vec(&conflicting)?;
    second
        .directory
        .atomic_replace(OsStr::new(RECEIPT), &bytes)?;
    assert!(
        first
            .verify_relocation(&second_path, "second-move", &expected)
            .is_err()
    );
    assert_eq!(optional_receipt(&second.directory)?, Some(bytes));
    Ok(())
}

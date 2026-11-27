use super::*;
use kcoder_types::migration::MigrationSourceKind;

struct Fixture {
    root: tempfile::TempDir,
    profile: PathBuf,
    workspace: PathBuf,
    registry_path: PathBuf,
    registry: ProjectWorkspaceRegistry,
    store: ImportedProjectAssociationsStore,
}

impl Fixture {
    fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        let profile = root.path().join("source-profile");
        let workspace = root.path().join("external-workspace");
        let registry_path = root.path().join("original-native-registry");
        PrivateDirectory::open_or_create(&profile)?;
        PrivateDirectory::open_or_create(&workspace)?;
        let registry_directory = PrivateDirectory::open_or_create(&registry_path)?;
        registry_directory.open_read_write_file(OsStr::new("client-workspaces.lock"), true)?;
        let path = workspace.to_str().unwrap();
        registry_directory.atomic_replace(
            OsStr::new("client-workspaces.json"),
            &serde_json::to_vec(&serde_json::json!({
                "version": 1, "projectOrder": ["original-project"],
                "records": {path: {"workspacePath": path, "projectKey": "original-project",
                    "roots": [path], "label": "Original label", "pinned": true}}
            }))?,
        )?;
        crate::FolderTrustStore::load(&profile).trust(&workspace)?;
        let registry = ProjectWorkspaceRegistry::open_native(&registry_path)?;
        let store = ImportedProjectAssociationsStore::open(&profile)?;
        Ok(Self {
            root,
            profile,
            workspace,
            registry_path,
            registry,
            store,
        })
    }

    fn record(&self, id: &str) -> Result<ImportedProjectAssociation> {
        let identity = PrivateDirectory::open_existing(&self.workspace)?.directory_identity()?;
        Ok(ImportedProjectAssociation {
            id: format!("association-{id}"),
            owner: ImportedProjectOwner {
                operation_id: format!("import-{id}"),
                action_id: format!("action-{id}"),
            },
            source: ImportedProjectSource {
                source: MigrationSourceKind::Codex,
                format_revision: "codex-project-registry/sqlite/1".into(),
                project_id: format!("source-{id}"),
                project_name: "Source label".into(),
                snapshot_sha256: "a".repeat(64),
            },
            target: ImportedProjectTarget {
                project_key: "original-project".into(),
                workspace: self.workspace.clone(),
                workspace_identity: identity.clone(),
                roots: vec![ImportedProjectRoot {
                    source_root_id: "root-0".into(),
                    source_path: "external-source-name".into(),
                    target_root: self.workspace.clone(),
                    target_identity: identity,
                }],
            },
            revision: 1,
        })
    }

    fn copy(&self, store: &ImportedProjectAssociationsStore, name: &str) -> Result<PathBuf> {
        let profile = self.root.path().join(name);
        let parent = PrivateDirectory::open_or_create(&profile)?;
        let directory = parent.create_private_child(OsStr::new(DIRECTORY))?;
        for name in [BIRTH, STATE, LOCK] {
            directory
                .atomic_replace(OsStr::new(name), &bytes(&store.directory, name, MAX_BYTES)?)?;
        }
        crate::FolderTrustStore::load(&profile).trust(&self.workspace)?;
        Ok(profile)
    }
}

#[test]
fn relocation_preserves_exact_state_receipts_registry_and_only_changes_the_lock_pin() -> Result<()>
{
    let f = Fixture::new()?;
    let active = f.record("active")?;
    let removed = f.record("removed")?;
    f.store.associate(&active)?;
    f.store.associate(&removed)?;
    let removed_receipt = f.store.remove_owned(&removed)?;
    let expected = f.store.relocation_snapshot(Some(&f.registry))?;
    let source_data = bytes(&f.store.directory, STATE, MAX_BYTES)?;
    let registry_before = std::fs::read(f.registry_path.join("client-workspaces.json"))?;
    let target_path = f.copy(&f.store, "final-target")?;
    assert!(ImportedProjectAssociationsStore::open(&target_path).is_err());
    assert!(
        f.store
            .verify_relocation(
                &target_path,
                "relocate-original",
                &expected,
                Some(&f.registry)
            )
            .is_err()
    );
    // A same-named preparation file has no ownership authority and is never adopted.
    let target_directory =
        PrivateDirectory::open_existing(&target_path)?.open_child(OsStr::new(DIRECTORY), false)?;
    let unknown = OsStr::new(".birth.json.unknown.prepared");
    target_directory.atomic_replace(unknown, b"UNKNOWN_PREPARATION")?;
    // The first reply is deliberately discarded, as if transport acknowledgement was lost.
    drop(f.store.relocate(
        &target_path,
        "relocate-original",
        &expected,
        Some(&f.registry),
    )?);
    let target_birth = bytes(&target_directory, BIRTH, 32 * 1024)?;
    let birth_identity = target_directory.portable_regular_identity(OsStr::new(BIRTH))?;
    let target = f.store.relocate(
        &target_path,
        "relocate-original",
        &expected,
        Some(&f.registry),
    )?;
    f.store.verify_relocation(
        &target_path,
        "relocate-original",
        &expected,
        Some(&f.registry),
    )?;
    assert_eq!(bytes(&target.directory, STATE, MAX_BYTES)?, source_data);
    assert_eq!(bytes(&f.store.directory, STATE, MAX_BYTES)?, source_data);
    assert_eq!(bytes(&target.directory, BIRTH, 32 * 1024)?, target_birth);
    let mut historical_birth = target.birth.clone();
    historical_birth.lock_identity = f.store.birth.lock_identity.clone();
    assert!(historical_birth == f.store.birth);
    assert!(
        target
            .directory
            .portable_regular_identity(OsStr::new(BIRTH))?
            == birth_identity
    );
    assert!(target.list()? == [active.clone()]);
    assert!(target.receipt(&removed.owner)? == Some(removed_receipt));
    assert!(target.receipt(&active.owner)? == f.store.receipt(&active.owner)?);
    assert_eq!(
        std::fs::read(target_path.join(DIRECTORY).join(unknown))?,
        b"UNKNOWN_PREPARATION"
    );
    assert_eq!(
        std::fs::read(f.registry_path.join("client-workspaces.json"))?,
        registry_before
    );
    // Operation authority belongs to the existing coordinator, not a second
    // per-owner relocation ledger. Verification is read-only and idempotent.
    f.store.verify_relocation(
        &target_path,
        "another-operation",
        &expected,
        Some(&f.registry),
    )?;
    assert!(ImportedProjectAssociationsStore::open(&target_path)?.list()? == [active]);
    Ok(())
}

#[test]
fn source_generation_change_and_revoked_project_trust_block_before_publication() -> Result<()> {
    let f = Fixture::new()?;
    f.store.associate(&f.record("first")?)?;
    let expected = f.store.relocation_snapshot(Some(&f.registry))?;
    let target = f.copy(&f.store, "target")?;
    let before = std::fs::read(target.join(DIRECTORY).join(BIRTH))?;
    f.store.associate(&f.record("new-generation")?)?;
    assert!(
        f.store
            .relocate(&target, "migration", &expected, Some(&f.registry))
            .is_err()
    );
    assert_eq!(std::fs::read(target.join(DIRECTORY).join(BIRTH))?, before);
    let expected = f.store.relocation_snapshot(Some(&f.registry))?;
    let target = f.copy(&f.store, "revoked-target")?;
    let before = std::fs::read(target.join(DIRECTORY).join(BIRTH))?;
    crate::FolderTrustStore::load(&f.profile).revoke(&f.workspace)?;
    assert!(
        f.store
            .relocate(&target, "migration", &expected, Some(&f.registry))
            .is_err()
    );
    assert_eq!(std::fs::read(target.join(DIRECTORY).join(BIRTH))?, before);
    Ok(())
}

#[test]
fn original_registry_replacement_and_external_workspace_replacement_are_not_retargeted()
-> Result<()> {
    let f = Fixture::new()?;
    f.store.associate(&f.record("original")?)?;
    let expected = f.store.relocation_snapshot(Some(&f.registry))?;
    let target = f.copy(&f.store, "target")?;
    let before = std::fs::read(target.join(DIRECTORY).join(BIRTH))?;
    PrivateDirectory::open_existing(&f.registry_path)?
        .atomic_replace(OsStr::new("client-workspaces.lock"), b"")?;
    assert!(
        f.store
            .relocate(&target, "migration", &expected, Some(&f.registry))
            .is_err()
    );
    assert_eq!(std::fs::read(target.join(DIRECTORY).join(BIRTH))?, before);

    let f = Fixture::new()?;
    f.store.associate(&f.record("original")?)?;
    let expected = f.store.relocation_snapshot(Some(&f.registry))?;
    let target = f.copy(&f.store, "target")?;
    let before = std::fs::read(target.join(DIRECTORY).join(BIRTH))?;
    std::fs::rename(&f.workspace, f.root.path().join("held-workspace"))?;
    PrivateDirectory::open_or_create(&f.workspace)?;
    assert!(
        f.store
            .relocate(&target, "migration", &expected, Some(&f.registry))
            .is_err()
    );
    assert_eq!(std::fs::read(target.join(DIRECTORY).join(BIRTH))?, before);
    Ok(())
}

#[test]
fn active_associations_need_the_registry_and_real_owner_leases_refuse_conversion() -> Result<()> {
    let f = Fixture::new()?;
    f.store.associate(&f.record("active")?)?;
    assert!(f.store.relocation_snapshot(None).is_err());
    let expected = f.store.relocation_snapshot(Some(&f.registry))?;
    let target = f.copy(&f.store, "target")?;
    let before = std::fs::read(target.join(DIRECTORY).join(BIRTH))?;
    let lease = f.store.lock(PrivateLeaseMode::Shared)?;
    assert!(
        f.store
            .relocate(&target, "migration", &expected, Some(&f.registry))
            .is_err()
    );
    drop(lease);
    let directory =
        PrivateDirectory::open_existing(&target)?.open_child(OsStr::new(DIRECTORY), false)?;
    let identity = directory.portable_regular_identity(OsStr::new(LOCK))?;
    let _lease = directory.try_existing_portable_lock(
        OsStr::new(LOCK),
        &identity,
        PrivateLeaseMode::Exclusive,
    )?;
    assert!(
        f.store
            .relocate(&target, "migration", &expected, Some(&f.registry))
            .is_err()
    );
    assert_eq!(std::fs::read(target.join(DIRECTORY).join(BIRTH))?, before);
    Ok(())
}

#[test]
fn removed_receipts_and_second_relocation_keep_the_original_epoch_and_business_state() -> Result<()>
{
    let f = Fixture::new()?;
    let record = f.record("removed")?;
    f.store.associate(&record)?;
    let receipt = f.store.remove_owned(&record)?;
    let expected = f.store.relocation_snapshot(None)?;
    let first_path = f.copy(&f.store, "first-target")?;
    let first = f
        .store
        .relocate(&first_path, "first-move", &expected, None)?;
    let expected = first.relocation_snapshot(None)?;
    let second_path = f.copy(&first, "second-target")?;
    let second = first.relocate(&second_path, "second-move", &expected, None)?;
    assert_eq!(
        bytes(&second.directory, STATE, MAX_BYTES)?,
        bytes(&f.store.directory, STATE, MAX_BYTES)?
    );
    assert!(second.receipt(&record.owner)? == Some(receipt));
    assert!(second.list()?.is_empty());
    assert!(second.associate(&record).is_err());
    let mut historical_birth = second.birth.clone();
    historical_birth.lock_identity = f.store.birth.lock_identity.clone();
    assert!(historical_birth == f.store.birth);
    Ok(())
}

#[test]
fn cold_open_uses_epoch_and_current_handles_instead_of_historical_directory_ids() -> Result<()> {
    let f = Fixture::new()?;
    let record = f.record("original")?;
    f.store.associate(&record)?;
    let parent = PrivateDirectory::open_or_create(&f.root.path().join("moved-profile"))?;
    std::fs::rename(
        f.profile.join(DIRECTORY),
        f.root.path().join("moved-profile").join(DIRECTORY),
    )?;
    assert!(f.store.list().is_err());
    let moved =
        ImportedProjectAssociationsStore::observe(&f.root.path().join("moved-profile"))?.unwrap();
    assert!(moved.birth == f.store.birth);
    assert!(moved.list()? == [record]);
    // The lock's persistent pin still rejects a replacement even on cold open.
    parent
        .open_child(OsStr::new(DIRECTORY), false)?
        .atomic_replace(OsStr::new(LOCK), b"")?;
    assert!(moved.list().is_err());
    assert!(
        ImportedProjectAssociationsStore::observe(&f.root.path().join("moved-profile"),).is_err()
    );
    Ok(())
}

#[test]
fn legacy_v2_birth_remains_readable_and_its_compatibility_receipt_does_not_grow() -> Result<()> {
    let f = Fixture::new()?;
    let mut source = f.store.relocation_snapshot(None)?;
    source.profile_identity = "legacy-source-profile".into();
    source.directory_identity = "legacy-source-directory".into();
    let mut birth = f.store.birth.clone();
    birth.version = 2;
    birth.relocation = Some(RelocationReceipt {
        operation_id: "legacy-move".into(),
        source,
    });
    f.store
        .directory
        .atomic_replace(OsStr::new(BIRTH), &serde_json::to_vec(&birth)?)?;
    let legacy = ImportedProjectAssociationsStore::observe(&f.profile)?.unwrap();
    let expected = legacy.relocation_snapshot(None)?;
    let first_path = f.copy(&legacy, "first-target")?;
    let first = legacy.relocate(&first_path, "first-move", &expected, None)?;
    let expected = first.relocation_snapshot(None)?;
    let second_path = f.copy(&first, "second-target")?;
    let second = first.relocate(&second_path, "second-move", &expected, None)?;
    let mut observed = second.birth.clone();
    observed.lock_identity = birth.lock_identity.clone();
    assert!(observed == birth);
    assert!(ImportedProjectAssociationsStore::observe(&second_path)?.is_some());
    Ok(())
}

#[test]
fn changed_target_state_is_not_repaired_or_overwritten() -> Result<()> {
    let f = Fixture::new()?;
    f.store.associate(&f.record("original")?)?;
    let expected = f.store.relocation_snapshot(Some(&f.registry))?;
    let target = f.copy(&f.store, "target")?;
    let directory =
        PrivateDirectory::open_existing(&target)?.open_child(OsStr::new(DIRECTORY), false)?;
    let before = bytes(&directory, BIRTH, 32 * 1024)?;
    directory.atomic_replace(OsStr::new(STATE), b"{\"unknown\":true}")?;
    assert!(
        f.store
            .relocate(&target, "migration", &expected, Some(&f.registry))
            .is_err()
    );
    assert_eq!(bytes(&directory, BIRTH, 32 * 1024)?, before);
    assert_eq!(bytes(&directory, STATE, MAX_BYTES)?, b"{\"unknown\":true}");
    Ok(())
}

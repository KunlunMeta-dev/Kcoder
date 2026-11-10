use super::*;
use kcoder_types::migration::MigrationSourceKind;

struct Fixture {
    root: tempfile::TempDir,
    profile: PathBuf,
    workspace: PathBuf,
    store: ImportedProjectAssociationsStore,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        PrivateDirectory::open_or_create(&profile).unwrap();
        let workspace = root.path().join("existing-non-git-workspace");
        PrivateDirectory::open_or_create(&workspace).unwrap();
        std::fs::write(workspace.join("DO_NOT_DELETE"), b"USER_WORKTREE").unwrap();
        std::fs::write(
            profile.join("client-workspaces.json"),
            b"USER_LABEL_ORDER_PIN_MUST_STAY",
        )
        .unwrap();
        crate::FolderTrustStore::load(&profile)
            .trust(&workspace)
            .unwrap();
        let store = ImportedProjectAssociationsStore::open(&profile).unwrap();
        Self {
            root,
            profile,
            workspace,
            store,
        }
    }
    fn record(&self, id: &str) -> ImportedProjectAssociation {
        let identity = PrivateDirectory::open_existing(&self.workspace)
            .unwrap()
            .directory_identity()
            .unwrap();
        ImportedProjectAssociation {
            id: format!("prj-{id}"),
            owner: ImportedProjectOwner {
                operation_id: format!("mig-{id}"),
                action_id: format!("action-{id}"),
            },
            source: ImportedProjectSource {
                source: MigrationSourceKind::Codex,
                format_revision: "codex-project-registry/sqlite/1".into(),
                project_id: format!("source-{id}"),
                project_name: "Original project".into(),
                snapshot_sha256: "a".repeat(64),
            },
            target: ImportedProjectTarget {
                project_key: "native-existing-project-key".into(),
                workspace: self.workspace.clone(),
                workspace_identity: identity.clone(),
                roots: vec![ImportedProjectRoot {
                    source_root_id: "root-0".into(),
                    source_path: "Z:\\foreign-source-that-does-not-exist".into(),
                    target_root: self.workspace.clone(),
                    target_identity: identity,
                }],
            },
            revision: 1,
        }
    }
    fn unchanged_user_files(&self) {
        assert_eq!(
            std::fs::read(self.workspace.join("DO_NOT_DELETE")).unwrap(),
            b"USER_WORKTREE"
        );
        assert_eq!(
            std::fs::read(self.profile.join("client-workspaces.json")).unwrap(),
            b"USER_LABEL_ORDER_PIN_MUST_STAY"
        );
    }
    fn state_path(&self) -> PathBuf {
        self.profile.join(DIRECTORY).join(STATE)
    }
}

#[test]
fn reopen_original_receipts_and_owned_undo_preserve_peer_associations_and_existing_workspaces() {
    let f = Fixture::new();
    let first = f.record("first");
    let peer = f.record("peer");
    // The caller deliberately does not use the first publication reply.
    f.store.associate(&first).unwrap();
    f.store.associate(&peer).unwrap();
    let reopened = ImportedProjectAssociationsStore::open(&f.profile).unwrap();
    let original = reopened.receipt(&first.owner).unwrap().unwrap();
    assert_eq!(original.stage, ImportedProjectReceiptStage::Associated);
    assert!(reopened.associate(&first).unwrap() == original);
    assert_eq!(reopened.list().unwrap().len(), 2);
    let removed = reopened.remove_owned(&first).unwrap();
    assert_eq!(removed.stage, ImportedProjectReceiptStage::Removed);
    assert!(reopened.remove_owned(&first).unwrap() == removed);
    assert!(reopened.list().unwrap() == [peer]);
    assert!(reopened.associate(&first).is_err());
    f.unchanged_user_files();
}

#[test]
fn target_identity_and_each_bound_root_trust_are_fresh_and_never_borrowed_from_current_workspace() {
    let f = Fixture::new();
    let mut record = f.record("foreign-root");
    let outside = f.root.path().join("untrusted-other-root");
    let handle = PrivateDirectory::open_or_create(&outside).unwrap();
    record.target.roots[0].target_root = outside.clone();
    record.target.roots[0].target_identity = handle.directory_identity().unwrap();
    assert!(f.store.associate(&record).is_err());
    assert!(f.store.list().unwrap().is_empty());
    crate::FolderTrustStore::load(&f.profile)
        .trust(&outside)
        .unwrap();
    f.store.check_association(&record).unwrap();
    std::fs::rename(&outside, f.root.path().join("original-held-root")).unwrap();
    PrivateDirectory::open_or_create(&outside).unwrap();
    assert!(f.store.associate(&record).is_err());
    assert!(f.store.list().unwrap().is_empty());
    f.unchanged_user_files();
}

#[test]
fn changed_records_and_wrong_owners_never_gain_undo_authority_or_overwrite_original_receipts() {
    let f = Fixture::new();
    let record = f.record("original");
    f.store.associate(&record).unwrap();
    let before = std::fs::read(f.state_path()).unwrap();
    let mut changed = record.clone();
    changed.source.project_name = "Changed display".into();
    assert!(f.store.remove_owned(&changed).is_err());
    changed = record.clone();
    changed.owner.operation_id = "mig-other".into();
    assert!(f.store.remove_owned(&changed).is_err());
    changed = record.clone();
    changed.revision = 2;
    assert!(f.store.remove_owned(&changed).is_err());
    assert_eq!(before, std::fs::read(f.state_path()).unwrap());
    assert!(f.store.list().unwrap() == [record]);
    f.unchanged_user_files();
}

#[test]
fn missing_sealed_state_unknown_birth_wrong_profile_and_replaced_coordinator_fail_closed() {
    let f = Fixture::new();
    let record = f.record("original");
    f.store.associate(&record).unwrap();
    std::fs::remove_file(f.state_path()).unwrap();
    assert!(f.store.list().is_err());
    assert!(ImportedProjectAssociationsStore::open(&f.profile).is_err());
    assert!(!f.state_path().exists());
    let unknown = f.root.path().join("unknown-profile");
    let parent = PrivateDirectory::open_or_create(&unknown).unwrap();
    parent.create_private_child(OsStr::new(DIRECTORY)).unwrap();
    assert!(ImportedProjectAssociationsStore::open(&unknown).is_err());
    let foreign = f.root.path().join("copied-profile");
    let parent = PrivateDirectory::open_or_create(&foreign).unwrap();
    let child = parent.create_private_child(OsStr::new(DIRECTORY)).unwrap();
    for name in [BIRTH, LOCK] {
        let bytes = std::fs::read(f.profile.join(DIRECTORY).join(name)).unwrap();
        child.atomic_replace(OsStr::new(name), &bytes).unwrap();
    }
    assert!(ImportedProjectAssociationsStore::open(&foreign).is_err());
    let fresh = Fixture::new();
    let lock = fresh.profile.join(DIRECTORY).join(LOCK);
    std::fs::rename(&lock, fresh.root.path().join("held-lock")).unwrap();
    fresh
        .store
        .directory
        .open_read_write_file(OsStr::new(LOCK), true)
        .unwrap();
    assert!(fresh.store.list().is_err());
    f.unchanged_user_files();
    fresh.unchanged_user_files();
}

#[test]
fn source_duplicate_requires_native_reuse_and_never_steals_a_peer_owner() {
    let f = Fixture::new();
    let first = f.record("first");
    f.store.associate(&first).unwrap();
    let mut duplicate = f.record("second");
    duplicate.source = first.source.clone();
    assert!(f.store.associate(&duplicate).is_err());
    assert!(f.store.list().unwrap() == [first.clone()]);
    assert!(f.store.receipt(&duplicate.owner).unwrap().is_none());
    let before = std::fs::read(f.state_path()).unwrap();
    duplicate.id = first.id;
    assert!(f.store.associate(&duplicate).is_err());
    assert_eq!(before, std::fs::read(f.state_path()).unwrap());
    f.unchanged_user_files();
}

#[test]
fn independent_native_writers_merge_under_the_original_coordinator_and_receipts_remain_owned() {
    let f = Fixture::new();
    let records = [f.record("one"), f.record("two")];
    std::thread::scope(|scope| {
        let mut workers = Vec::new();
        for record in &records {
            let profile = &f.profile;
            workers.push(scope.spawn(move || {
                ImportedProjectAssociationsStore::open(profile)
                    .unwrap()
                    .associate(record)
                    .unwrap()
            }));
        }
        for worker in workers {
            assert_eq!(
                worker.join().unwrap().stage,
                ImportedProjectReceiptStage::Associated
            );
        }
    });
    assert_eq!(f.store.list().unwrap().len(), 2);
    for record in records {
        f.store.remove_owned(&record).unwrap();
    }
    assert!(f.store.list().unwrap().is_empty());
    f.unchanged_user_files();
}

fn registry(f: &Fixture) -> ProjectWorkspaceRegistry {
    let parent = PrivateDirectory::open_existing(&f.profile).unwrap();
    parent
        .open_read_write_file(OsStr::new("client-workspaces.lock"), true)
        .unwrap();
    let path = f.workspace.to_str().unwrap();
    let bytes = serde_json::to_vec(&serde_json::json!({"version":1,"projectOrder":["native-existing-project-key"],"pinnedTasks":["KEEP_PIN"],
        "records":{path:{"workspacePath":path,"projectKey":"native-existing-project-key","roots":[path],"label":"User label","pinned":true,"pinnedOrder":7,"appearance":{"private":"KEEP_APPEARANCE"},"active":true,"createdAt":123,"updatedAt":456}}})).unwrap();
    parent
        .atomic_replace(OsStr::new("client-workspaces.json"), &bytes)
        .unwrap();
    ProjectWorkspaceRegistry::open_native(&f.profile).unwrap()
}
#[test]
fn actual_registry_membership_is_separate_from_trust_and_preserves_all_user_metadata() {
    let f = Fixture::new();
    let registry = registry(&f);
    let record = f.record("registry");
    let membership = registry.pin(&record.target.project_key).unwrap();
    let before = std::fs::read(f.profile.join("client-workspaces.json")).unwrap();
    assert_eq!(registry.list().unwrap()[0].label, "User label");
    membership.check_association(&f.store, &record).unwrap();
    membership.associate(&f.store, &record).unwrap();
    assert_eq!(
        before,
        std::fs::read(f.profile.join("client-workspaces.json")).unwrap()
    );
    f.store.remove_owned(&record).unwrap();
    let outside = f.root.path().join("trusted-but-not-registered");
    PrivateDirectory::open_or_create(&outside).unwrap();
    crate::FolderTrustStore::load(&f.profile)
        .trust(&outside)
        .unwrap();
    let mut moved = f.record("outside");
    moved.target.roots[0].target_root = outside;
    moved.target.roots[0].target_identity =
        PrivateDirectory::open_existing(&moved.target.roots[0].target_root)
            .unwrap()
            .directory_identity()
            .unwrap();
    assert!(membership.associate(&f.store, &moved).is_err());
    assert!(f.store.list().unwrap().is_empty());
    assert_eq!(
        before,
        std::fs::read(f.profile.join("client-workspaces.json")).unwrap()
    );
}
#[test]
fn a_user_label_change_does_not_rebind_a_project_but_removing_its_registered_root_blocks_publication()
 {
    let f = Fixture::new();
    let registry = registry(&f);
    let record = f.record("membership");
    let membership = registry.pin(&record.target.project_key).unwrap();
    let path = f.profile.join("client-workspaces.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    value["records"][f.workspace.to_str().unwrap()]["label"] = "Changed by user".into();
    let parent = PrivateDirectory::open_existing(&f.profile).unwrap();
    parent
        .atomic_replace(
            OsStr::new("client-workspaces.json"),
            &serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    membership.check_association(&f.store, &record).unwrap();
    value["records"] = serde_json::json!({});
    parent
        .atomic_replace(
            OsStr::new("client-workspaces.json"),
            &serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    assert!(membership.associate(&f.store, &record).is_err());
    assert!(f.store.list().unwrap().is_empty());
}
#[test]
fn the_original_workspace_writer_lock_prevents_claims_and_replacement_is_not_an_idle_registry() {
    let f = Fixture::new();
    let registry = registry(&f);
    let record = f.record("lease");
    let membership = registry.pin(&record.target.project_key).unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(f.profile.join("client-workspaces.lock"))
        .unwrap();
    fs2::FileExt::try_lock_exclusive(&lock).unwrap();
    assert!(membership.associate(&f.store, &record).is_err());
    assert!(f.store.list().unwrap().is_empty());
    fs2::FileExt::unlock(&lock).unwrap();
    membership.associate(&f.store, &record).unwrap();
    std::fs::rename(
        f.profile.join("client-workspaces.lock"),
        f.root.path().join("original-registry-lock"),
    )
    .unwrap();
    PrivateDirectory::open_existing(&f.profile)
        .unwrap()
        .open_read_write_file(OsStr::new("client-workspaces.lock"), true)
        .unwrap();
    assert!(membership.with_registered(|| Ok(())).is_err());
    assert_eq!(f.store.list().unwrap().len(), 1);
}
#[test]
fn corrupt_and_conflicting_existing_registry_rows_never_become_an_empty_authoritative_catalog() {
    let f = Fixture::new();
    let registry = registry(&f);
    let parent = PrivateDirectory::open_existing(&f.profile).unwrap();
    for bytes in [b"{".as_slice(), br#"{"version":99,"records":{}}"#.as_slice(), br#"{"version":1,"records":{"wrong-key":{"workspacePath":"/other","projectKey":"x","label":"x","roots":["/other"]}}}"#.as_slice()] {
        parent.atomic_replace(OsStr::new("client-workspaces.json"), bytes).unwrap(); assert!(registry.list().is_err());
    }
}

#[cfg(unix)]
#[test]
fn an_owned_nonwritable_metadata_parent_is_not_repaired_or_mistaken_for_a_private_secret_directory()
{
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let _registry = registry(&f);
    std::fs::set_permissions(&f.profile, std::fs::Permissions::from_mode(0o755)).unwrap();
    let registry = ProjectWorkspaceRegistry::open_native(&f.profile).unwrap();
    let record = f.record("trusted-metadata-parent");
    let membership = registry.pin(&record.target.project_key).unwrap();
    let before = std::fs::read(f.profile.join("client-workspaces.json")).unwrap();
    membership.associate(&f.store, &record).unwrap();
    assert_eq!(
        std::fs::metadata(&f.profile).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert_eq!(
        before,
        std::fs::read(f.profile.join("client-workspaces.json")).unwrap()
    );
}

use super::*;
use crate::{profile_identity::ProfileIdentity, storage::*};
use kcoder_types::{
    STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLaunchIntent, StorageLocationRecord,
    StorageMigrationComponent, StorageMigrationPhase as Phase, StorageMigrationPlan,
    StorageTargetBinding,
};

fn directory(path: &Path) -> Result<PrivateDirectory> {
    PrivateDirectory::open_existing(path)
}

fn publish(
    outer: &Path,
    source: &Path,
    target: &Path,
    operation: &str,
) -> Result<StoragePublishedComponent> {
    let home = outer.join(format!("control-{operation}"));
    directory(outer)?.create_private_child(OsStr::new(&format!("control-{operation}")))?;
    let plan = StorageMigrationPlan {
        version: 1,
        operation_id: operation.into(),
        original: None,
        from: resolve_storage_paths(&StorageResolveInput {
            home: Some(home.clone()),
            ..Default::default()
        })?,
        target: StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: target.into(),
            cache_root: outer.join(format!("cache-{operation}")),
            operation_id: Some(operation.into()),
        },
        components: vec![StorageMigrationComponent {
            domain: STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
            source: source.into(),
            destination: target.into(),
            source_identity: directory(source)?.directory_identity()?,
            estimated_bytes: 0,
        }],
        target_bindings: vec![StorageTargetBinding {
            path: target.into(),
            existing_ancestor: outer.into(),
            ancestor_identity: directory(outer)?.directory_identity()?,
        }],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    };
    let mut coordinator = StorageCoordinator::acquire(&home)?;
    coordinator.begin(plan)?;
    coordinator.advance(operation, Phase::Planned, Phase::Stopping)?;
    coordinator.advance(operation, Phase::Stopping, Phase::Stopped)?;
    coordinator.advance(operation, Phase::Stopped, Phase::Copying)?;
    coordinator.publish_component(operation, STORAGE_PERSISTENT_ROOT_DOMAIN, &BTreeSet::new())?;
    coordinator.open_published_component(operation, STORAGE_PERSISTENT_ROOT_DOMAIN)
}

fn complete(outer: &Path, operation: &str) -> Result<()> {
    let mut coordinator = StorageCoordinator::acquire(&outer.join(format!("control-{operation}")))?;
    coordinator.advance(operation, Phase::Copying, Phase::Verifying)?;
    coordinator.advance(operation, Phase::Verifying, Phase::Prepared)?;
    coordinator.commit(operation)?;
    coordinator.complete(operation)?;
    Ok(())
}

/// The Config fixture owns a real publication and a pinned registration file.
/// Actual Git registration verification belongs to the managed owner tests.
struct Owner<'a> {
    publication: &'a StoragePublishedComponent,
    source: PrivateDirectory,
    target: PrivateDirectory,
    source_path: PathBuf,
    target_path: PathBuf,
    relative: PathBuf,
    registry: File,
    registry_identity: PortableLeaseIdentity,
    registry_bytes: Vec<u8>,
}
impl<'a> Owner<'a> {
    fn new(publication: &'a StoragePublishedComponent) -> Result<Self> {
        let relative = PathBuf::from("managed/tree/repository");
        let source_path = publication.source_path().join(&relative);
        let target_path = publication.destination_path().join(&relative);
        let registry = directory(publication.source_path())?
            .open_single_link_regular_file(OsStr::new("owned-registration.json"))?;
        let registry_identity = PortableLeaseIdentity::from_private_regular_handle(&registry)?;
        use std::io::Read;
        let mut registry_bytes = Vec::new();
        (&registry).read_to_end(&mut registry_bytes)?;
        Ok(Self {
            publication,
            source: directory(&source_path)?,
            target: directory(&target_path)?,
            source_path,
            target_path,
            relative,
            registry,
            registry_identity,
            registry_bytes,
        })
    }
}
impl ManagedWorkspaceRelocationProof for Owner<'_> {
    fn verify(&self) -> Result<()> {
        self.publication.verify()?;
        let root = directory(self.publication.source_path())?;
        let current = root.open_single_link_regular_file(OsStr::new("owned-registration.json"))?;
        ensure!(
            PortableLeaseIdentity::from_private_regular_handle(&current)? == self.registry_identity
                && PortableLeaseIdentity::from_private_regular_handle(&self.registry)?
                    == self.registry_identity
                && std::fs::read(
                    self.publication
                        .source_path()
                        .join("owned-registration.json")
                )? == self.registry_bytes,
            "owned registration changed"
        );
        Ok(())
    }
    fn operation_id(&self) -> &str {
        self.publication.operation_id()
    }
    fn worktree_id(&self) -> &str {
        "tree"
    }
    fn source_path(&self) -> &Path {
        &self.source_path
    }
    fn destination_path(&self) -> &Path {
        &self.target_path
    }
    fn relative_path(&self) -> &Path {
        &self.relative
    }
    fn source_directory(&self) -> &PrivateDirectory {
        &self.source
    }
    fn target_directory(&self) -> &PrivateDirectory {
        &self.target
    }
    fn published_component(&self) -> &StoragePublishedComponent {
        self.publication
    }
}

fn source_root(outer: &Path) -> Result<PathBuf> {
    let root = directory(outer)?.create_private_child(OsStr::new("source"))?;
    root.create_private_child(OsStr::new("profile"))?;
    root.create_private_child(OsStr::new("managed"))?
        .create_private_child(OsStr::new("tree"))?
        .create_private_child(OsStr::new("repository"))?;
    root.atomic_replace(
        OsStr::new("owned-registration.json"),
        br#"{"worktreeId":"tree","revision":7}"#,
    )?;
    Ok(outer.join("source"))
}

fn profile_pair(owner: &Owner<'_>) -> Result<(PrivateDirectory, PrivateDirectory)> {
    let source = directory(&owner.publication.source_path().join("profile"))?;
    let target = directory(&owner.publication.destination_path().join("profile"))?;
    ProfileIdentity::observe(&source)?.relocate(&source, &target, owner.operation_id())?;
    Ok((source, target))
}

#[test]
fn missing_workspace_mapping_is_pure_and_keeps_external_legacy_identity() -> Result<()> {
    let profile_root = tempfile::tempdir()?;
    let workspace_root = tempfile::tempdir()?;
    let profile = directory(profile_root.path())?;
    let workspace = directory(workspace_root.path())?;
    let original = WorkspaceIdentity::observe(&profile, &workspace)?;
    assert_eq!(original.logical_seed(), workspace.directory_identity()?);
    assert!(original.project_storage_key().is_none());
    assert!(original.storage_workspace_path().is_none());
    assert!(WorkspaceIdentity::lookup(&profile, workspace_root.path())?.is_none());
    original.verify(&profile, &workspace)?;
    assert_eq!(std::fs::read_dir(profile_root.path())?.count(), 0);
    assert_eq!(std::fs::read_dir(workspace_root.path())?.count(), 0);
    Ok(())
}

#[test]
fn published_owner_preserves_seed_storage_address_and_same_operation_receipt() -> Result<()> {
    let outer = tempfile::tempdir()?;
    let source_root = source_root(outer.path())?;
    let publication = publish(
        outer.path(),
        &source_root,
        &outer.path().join("target"),
        "move-one",
    )?;
    let owner = Owner::new(&publication)?;
    let (source, target) = profile_pair(&owner)?;
    assert!(WorkspaceIdentity::verify_relocation(&source, &target, &owner).is_err());
    assert!(read_index(&target)?.is_none());
    let empty_page = WorkspaceIdentity::observe_addresses(&target)?;
    assert!(empty_page.lookup(&target, owner.source_path())?.is_none());
    let original = WorkspaceIdentity::observe(&source, &owner.source)?;
    let mapped = WorkspaceIdentity::relocate(&source, &target, &owner)?;
    assert!(
        empty_page
            .verify(&target)
            .unwrap_err()
            .to_string()
            .contains("WORKSPACE_IDENTITY_OBSERVATION_STALE")
    );
    assert_eq!(mapped.logical_seed(), original.logical_seed());
    assert_ne!(mapped.logical_seed(), owner.target.directory_identity()?);
    assert_eq!(
        mapped.project_storage_key(),
        Some(crate::project_key_for_path(owner.source_path()).as_str())
    );
    assert_eq!(mapped.storage_workspace_path(), Some(owner.source_path()));
    assert!(
        WorkspaceIdentity::observe(&target, &owner.source)
            .unwrap_err()
            .to_string()
            .contains("WORKSPACE_IDENTITY_MOVED")
    );
    let Some(WorkspaceAddressLookup::Moved(location)) =
        WorkspaceIdentity::lookup(&target, owner.source_path())?
    else {
        anyhow::bail!("expected original address to be Moved")
    };
    assert_eq!(location.workspace_path(), owner.destination_path());
    assert_eq!(
        location.recorded_directory_identity(),
        owner.source.directory_identity()?
    );
    assert_eq!(
        location.directory_identity(),
        owner.target.directory_identity()?
    );
    location.verify(&target)?;
    assert!(matches!(
        WorkspaceIdentity::lookup(&target, owner.destination_path())?,
        Some(WorkspaceAddressLookup::Current(_))
    ));
    let before = std::fs::read(publication.destination_path().join("profile").join(INDEX))?;
    let identity = target.regular_file_identity(OsStr::new(INDEX))?;
    WorkspaceIdentity::relocate(&source, &target, &owner)?;
    WorkspaceIdentity::verify_relocation(&source, &target, &owner)?;
    assert_eq!(
        std::fs::read(publication.destination_path().join("profile").join(INDEX))?,
        before
    );
    assert_eq!(target.regular_file_identity(OsStr::new(INDEX))?, identity);
    original.verify(&source, &owner.source)?;
    Ok(())
}

#[test]
fn second_move_keeps_the_first_seed_key_and_missing_original_address() -> Result<()> {
    let outer = tempfile::tempdir()?;
    let original_root = source_root(outer.path())?;
    let first = publish(
        outer.path(),
        &original_root,
        &outer.path().join("first"),
        "move-one",
    )?;
    let first_owner = Owner::new(&first)?;
    let (original_profile, first_profile) = profile_pair(&first_owner)?;
    let initial = WorkspaceIdentity::relocate(&original_profile, &first_profile, &first_owner)?;
    complete(outer.path(), "move-one")?;
    let second = publish(
        outer.path(),
        first.destination_path(),
        &outer.path().join("second"),
        "move-two",
    )?;
    let second_owner = Owner::new(&second)?;
    let (source, target) = profile_pair(&second_owner)?;
    let mapped = WorkspaceIdentity::relocate(&source, &target, &second_owner)?;
    assert_eq!(mapped.logical_seed(), initial.logical_seed());
    assert_eq!(mapped.project_storage_key(), initial.project_storage_key());
    assert_eq!(
        mapped.storage_workspace_path(),
        initial.storage_workspace_path()
    );
    WorkspaceIdentity::verify_profile_rebinding(&source, &target, "move-two")?;
    complete(outer.path(), "move-two")?;
    let original_legacy_key = crate::legacy_project_key_for_path(first_owner.source_path());
    std::fs::remove_dir_all(original_root.join("managed"))?;
    let Some(WorkspaceAddressLookup::Moved(location)) =
        WorkspaceIdentity::lookup(&target, first_owner.source_path())?
    else {
        anyhow::bail!("expected first address to survive its directory")
    };
    assert_eq!(location.workspace_path(), second_owner.destination_path());
    assert_eq!(
        location.recorded_directory_identity(),
        first_owner.source.directory_identity()?
    );
    assert_eq!(
        location.project_storage_key(),
        initial.project_storage_key().unwrap()
    );
    location.verify(&target)?;
    let profile_path = second.destination_path().join("profile");
    let expected_bundle = profile_path
        .join("projects")
        .join(initial.project_storage_key().unwrap());
    assert_eq!(
        crate::Settings::project_data_dir_at(&profile_path, second_owner.destination_path())?,
        expected_bundle
    );
    for old in [first_owner.source_path(), second_owner.source_path()] {
        assert!(crate::Settings::project_data_dir_at(&profile_path, old).is_err());
    }
    for cwd in [first_owner.source_path(), second_owner.destination_path()] {
        let candidates = crate::Settings::project_data_dirs_for_read_at(&profile_path, cwd)?;
        assert_eq!(candidates.first(), Some(&expected_bundle));
        assert!(candidates.contains(&profile_path.join("projects").join(&original_legacy_key)));
    }
    assert!(
        !profile_path.join("projects").exists(),
        "path queries must not initialize history"
    );
    assert!(WorkspaceIdentity::observe(&target, &first_owner.target).is_err());
    Ok(())
}

fn copy_profile(source: &Path, target: &Path) -> Result<()> {
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        ensure!(
            entry.file_type()?.is_file(),
            "owned profile fixture must contain files only"
        );
        std::fs::copy(entry.path(), target.join(entry.file_name()))?;
    }
    Ok(())
}

#[test]
fn profile_only_rebinding_preserves_an_unmoved_workspace_after_seed_copy() -> Result<()> {
    let outer = tempfile::tempdir()?;
    let original = source_root(outer.path())?;
    let publication = publish(
        outer.path(),
        &original,
        &outer.path().join("first"),
        "move-one",
    )?;
    let owner = Owner::new(&publication)?;
    let (source_profile, source) = profile_pair(&owner)?;
    let original_mapping = WorkspaceIdentity::relocate(&source_profile, &source, &owner)?;
    let path = outer.path().join("profile-only");
    directory(outer.path())?.create_private_child(OsStr::new("profile-only"))?;
    copy_profile(&publication.destination_path().join("profile"), &path)?;
    let target = directory(&path)?;
    assert!(WorkspaceIdentity::observe(&target, &owner.target).is_err());
    ProfileIdentity::observe(&source)?.relocate(&source, &target, "profile-only")?;
    assert_eq!(
        WorkspaceIdentity::rebind_profile(&source, &target, "profile-only")?,
        1
    );
    assert_eq!(
        WorkspaceIdentity::verify_profile_rebinding(&source, &target, "profile-only")?,
        1
    );
    let current = WorkspaceIdentity::observe(&target, &owner.target)?;
    assert_eq!(current.logical_seed(), original_mapping.logical_seed());
    assert_eq!(
        current.project_storage_key(),
        original_mapping.project_storage_key()
    );
    assert!(matches!(
        WorkspaceIdentity::lookup(&target, owner.destination_path())?,
        Some(WorkspaceAddressLookup::Current(_))
    ));
    assert!(WorkspaceIdentity::rebind_profile(&source, &target, "other-operation").is_err());
    Ok(())
}

#[test]
fn replaced_mapping_leaf_never_falls_back_to_new_scope() -> Result<()> {
    let outer = tempfile::tempdir()?;
    let original = source_root(outer.path())?;
    let publication = publish(
        outer.path(),
        &original,
        &outer.path().join("first"),
        "move-one",
    )?;
    let owner = Owner::new(&publication)?;
    let (source, target) = profile_pair(&owner)?;
    let identity = WorkspaceIdentity::relocate(&source, &target, &owner)?;
    let page = WorkspaceIdentity::observe_addresses(&target)?;
    let name = record_name(&owner.target.directory_identity()?);
    let bytes = std::fs::read(publication.destination_path().join("profile").join(&name))?;
    target.atomic_replace(OsStr::new(&name), &bytes)?;
    assert!(identity.verify(&target, &owner.target).is_err());
    assert!(WorkspaceIdentity::observe(&target, &owner.target).is_err());
    assert!(WorkspaceIdentity::lookup(&target, owner.source_path()).is_err());
    assert!(
        crate::Settings::project_data_dir_at(
            &publication.destination_path().join("profile"),
            owner.destination_path()
        )
        .is_err()
    );
    assert!(
        crate::Settings::project_data_dirs_for_read_at(
            &publication.destination_path().join("profile"),
            owner.source_path()
        )
        .is_err()
    );
    assert!(
        crate::Settings::project_data_dirs_for_read_observed(
            &publication.destination_path().join("profile"),
            &page,
            owner.source_path()
        )
        .is_err()
    );
    assert!(WorkspaceIdentity::relocate(&source, &target, &owner).is_err());
    Ok(())
}

#[test]
fn replaced_address_index_is_rejected_even_when_all_workspace_leaves_are_original() -> Result<()> {
    let outer = tempfile::tempdir()?;
    let original = source_root(outer.path())?;
    let publication = publish(
        outer.path(),
        &original,
        &outer.path().join("first"),
        "move-one",
    )?;
    let owner = Owner::new(&publication)?;
    let (source, target) = profile_pair(&owner)?;
    let identity = WorkspaceIdentity::relocate(&source, &target, &owner)?;
    let bytes = std::fs::read(publication.destination_path().join("profile").join(INDEX))?;
    target.atomic_replace(OsStr::new(INDEX), &bytes)?;
    assert!(identity.verify(&target, &owner.target).is_err());
    assert!(WorkspaceIdentity::observe(&target, &owner.target).is_err());
    assert!(WorkspaceIdentity::lookup(&target, owner.source_path()).is_err());
    assert!(WorkspaceIdentity::relocate(&source, &target, &owner).is_err());
    Ok(())
}

#[test]
fn owner_or_published_relative_change_is_rejected_before_mapping_writes() -> Result<()> {
    let outer = tempfile::tempdir()?;
    let original = source_root(outer.path())?;
    let publication = publish(
        outer.path(),
        &original,
        &outer.path().join("first"),
        "move-one",
    )?;
    let mut owner = Owner::new(&publication)?;
    let (source, target) = profile_pair(&owner)?;
    owner.relative = PathBuf::from("managed/other/repository");
    assert!(WorkspaceIdentity::relocate(&source, &target, &owner).is_err());
    assert!(read_index(&target)?.is_none());
    owner.relative = PathBuf::from("managed/tree/repository");
    directory(publication.source_path())?
        .atomic_replace(OsStr::new("owned-registration.json"), b"{}")
        .unwrap();
    assert!(WorkspaceIdentity::relocate(&source, &target, &owner).is_err());
    assert!(read_index(&target)?.is_none());
    Ok(())
}

#[test]
fn held_address_page_reads_index_once_and_rejects_named_or_in_place_changes() -> Result<()> {
    for replace_name in [false, true] {
        let outer = tempfile::tempdir()?;
        let original = source_root(outer.path())?;
        let publication = publish(
            outer.path(),
            &original,
            &outer.path().join("first"),
            "move-one",
        )?;
        let owner = Owner::new(&publication)?;
        let (source, target) = profile_pair(&owner)?;
        WorkspaceIdentity::relocate(&source, &target, &owner)?;
        let index_path = publication.destination_path().join("profile").join(INDEX);
        let index_bytes = std::fs::metadata(&index_path)?.len() as usize;
        storage::reset_index_io();
        let page = WorkspaceIdentity::observe_addresses(&target)?;
        assert_eq!(storage::index_io(), (1, index_bytes));
        for _ in 0..64 {
            let Some(WorkspaceAddressLookup::Moved(location)) =
                page.lookup(&target, owner.source_path())?
            else {
                anyhow::bail!("expected mapped original address")
            };
            location.verify(&target)?;
            assert!(
                page.lookup(&target, &outer.path().join("unmapped-workspace"))?
                    .is_none()
            );
            let profile_path = publication.destination_path().join("profile");
            let candidates = crate::Settings::project_data_dirs_for_read_observed(
                &profile_path,
                &page,
                owner.source_path(),
            )?;
            assert_eq!(
                candidates[0],
                profile_path
                    .join("projects")
                    .join(location.project_storage_key())
            );
        }
        page.verify(&target)?;
        assert_eq!(storage::index_io(), (1, index_bytes));
        if replace_name {
            let bytes = std::fs::read(&index_path)?;
            target.atomic_replace(OsStr::new(INDEX), &bytes)?;
        } else {
            use std::io::Write;
            let file = target.open_read_write_file(OsStr::new(INDEX), false)?;
            (&file).write_all(b"!")?;
            file.sync_all()?;
        }
        assert!(
            page.verify(&target)
                .unwrap_err()
                .to_string()
                .contains("WORKSPACE_IDENTITY_OBSERVATION_STALE")
        );
        assert!(page.lookup(&target, owner.source_path()).is_err());
        assert_eq!(storage::index_io(), (1, index_bytes));
        assert!(WorkspaceIdentity::lookup(&target, owner.source_path()).is_err());
    }
    Ok(())
}

#[test]
fn project_storage_recorded_reads_survive_missing_or_foreign_old_cwd_without_redirecting_writes()
-> Result<()> {
    let outer = tempfile::tempdir()?;
    let original = source_root(outer.path())?;
    let publication = publish(
        outer.path(),
        &original,
        &outer.path().join("target"),
        "move-one",
    )?;
    let owner = Owner::new(&publication)?;
    let (source, target) = profile_pair(&owner)?;
    let identity = WorkspaceIdentity::relocate(&source, &target, &owner)?;
    let profile = publication.destination_path().join("profile");
    let expected_bundle = profile
        .join("projects")
        .join(identity.project_storage_key().unwrap());
    let expected_reads =
        crate::Settings::project_data_dirs_for_read_at(&profile, owner.destination_path())?;
    let page = WorkspaceIdentity::observe_addresses(&target)?;
    assert!(crate::Settings::project_data_dir_at(&profile, owner.source_path()).is_err());
    std::fs::remove_dir_all(owner.source_path())?;
    assert_eq!(
        crate::Settings::project_data_dirs_for_read_at(&profile, owner.source_path())?,
        expected_reads
    );
    assert_eq!(
        crate::Settings::project_data_dirs_for_read_observed(&profile, &page, owner.source_path())?,
        expected_reads
    );
    assert!(crate::Settings::project_data_dir_at(&profile, owner.source_path()).is_err());
    std::fs::create_dir_all(owner.source_path())?;
    assert_ne!(
        directory(owner.source_path())?.directory_identity()?,
        owner.source.directory_identity()?
    );
    assert_eq!(
        crate::Settings::project_data_dirs_for_read_at(&profile, owner.source_path())?,
        expected_reads
    );
    assert_eq!(
        crate::Settings::project_data_dirs_for_read_observed(&profile, &page, owner.source_path())?,
        expected_reads
    );
    assert!(crate::Settings::project_data_dir_at(&profile, owner.source_path()).is_err());
    assert_eq!(
        crate::Settings::project_data_dir_at(&profile, owner.destination_path())?,
        expected_bundle
    );
    assert!(!profile.join("projects").exists());
    Ok(())
}

#[cfg(unix)]
#[test]
fn project_storage_reads_do_not_follow_reused_old_symlinks_and_writes_check_actual_directory()
-> Result<()> {
    let outer = tempfile::tempdir()?;
    let original = source_root(outer.path())?;
    let publication = publish(
        outer.path(),
        &original,
        &outer.path().join("target"),
        "move-one",
    )?;
    let owner = Owner::new(&publication)?;
    let (source, target) = profile_pair(&owner)?;
    let identity = WorkspaceIdentity::relocate(&source, &target, &owner)?;
    let profile = publication.destination_path().join("profile");
    let expected_bundle = profile
        .join("projects")
        .join(identity.project_storage_key().unwrap());
    let expected_reads =
        crate::Settings::project_data_dirs_for_read_at(&profile, owner.destination_path())?;
    let page = WorkspaceIdentity::observe_addresses(&target)?;
    let foreign = outer.path().join("foreign-workspace");
    directory(outer.path())?.create_private_child(OsStr::new("foreign-workspace"))?;
    std::fs::remove_dir_all(owner.source_path())?;
    std::os::unix::fs::symlink(&foreign, owner.source_path())?;
    assert_eq!(
        crate::Settings::project_data_dirs_for_read_at(&profile, owner.source_path())?,
        expected_reads
    );
    assert_eq!(
        crate::Settings::project_data_dirs_for_read_observed(&profile, &page, owner.source_path())?,
        expected_reads
    );
    assert!(crate::Settings::project_data_dir_at(&profile, owner.source_path()).is_err());
    let foreign_bundle = crate::Settings::project_data_dir_at(&profile, &foreign)?;
    assert_eq!(
        foreign_bundle,
        profile
            .join("projects")
            .join(crate::project_key_for_path(&foreign))
    );
    assert_ne!(foreign_bundle, expected_bundle);
    std::fs::remove_file(owner.source_path())?;
    std::os::unix::fs::symlink(owner.destination_path(), owner.source_path())?;
    assert_eq!(
        crate::Settings::project_data_dir_at(&profile, owner.source_path())?,
        expected_bundle
    );
    assert_eq!(
        crate::Settings::project_data_dir_at(&profile, owner.destination_path())?,
        expected_bundle
    );
    assert_eq!(
        crate::Settings::project_data_dirs_for_read_at(&profile, owner.source_path())?,
        expected_reads
    );
    assert_eq!(
        crate::Settings::project_data_dirs_for_read_observed(&profile, &page, owner.source_path())?,
        expected_reads
    );
    assert!(!profile.join("projects").exists());
    Ok(())
}

#[test]
fn project_storage_path_queries_do_not_create_a_missing_profile() -> Result<()> {
    let outer = tempfile::tempdir()?;
    let profile = outer.path().join("missing-profile");
    let cwd = outer.path().join("workspace");
    directory(outer.path())?.create_private_child(OsStr::new("workspace"))?;
    let expected = profile
        .join("projects")
        .join(crate::project_key_for_path(&cwd));
    assert_eq!(
        crate::Settings::project_data_dir_at(&profile, &cwd)?,
        expected
    );
    assert_eq!(
        crate::Settings::project_data_dirs_for_read_at(&profile, &cwd)?.first(),
        Some(&expected)
    );
    assert!(!profile.exists());
    Ok(())
}

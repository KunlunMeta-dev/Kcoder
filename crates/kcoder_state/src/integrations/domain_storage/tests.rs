use super::*;
use kcoder_types::integrations::core::IntegrationNullable;

fn scope() -> IntegrationScope {
    IntegrationScope {
        account_id: "account".into(),
        target_id: "target".into(),
        workspace_id: IntegrationNullable::Value("workspace".into()),
        identity_generation: "generation".into(),
        target_revision: "configuration".into(),
        organization_id: None,
    }
}

#[test]
fn task_capability_scope_keeps_the_legacy_domain_identity() -> Result<()> {
    assert_eq!(
        serde_json::to_value(StorageDomain::ConnectivityTaskCapabilityScope)?,
        "connectivity_task_sources"
    );
    Ok(())
}

#[test]
fn observation_is_read_only_and_initialization_is_durable() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(temp.path())?;
    assert!(DomainStorageGuard::observe(&profile, &scope(), StorageDomain::Memory)?.is_none());
    assert_eq!(std::fs::read_dir(temp.path())?.count(), 0);
    let (guard, ()) = DomainStorageGuard::initialize(
        &profile,
        &scope(),
        StorageDomain::Memory,
        "initialize-once",
        |directory| {
            directory.append(OsStr::new("material"), b"retained")?;
            Ok(())
        },
    )?;
    let count = std::fs::read_dir(temp.path())?.count();
    assert_eq!(count, 2);
    assert!(DomainStorageGuard::observe(&profile, &scope(), StorageDomain::Memory)?.is_some());
    assert_eq!(std::fs::read_dir(temp.path())?.count(), count);
    assert!(
        DomainStorageGuard::initialize(
            &profile,
            &scope(),
            StorageDomain::Memory,
            "different-operation",
            |_| Ok(())
        )
        .is_err()
    );
    assert!(
        DomainStorageGuard::observe(&profile, &scope(), StorageDomain::WorkspaceResources)?
            .is_none()
    );
    guard.directory(&profile)?;
    Ok(())
}

#[test]
fn failed_initialization_is_not_reset_on_read_or_retry() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(temp.path())?;
    assert!(
        DomainStorageGuard::initialize::<()>(
            &profile,
            &scope(),
            StorageDomain::Memory,
            "operation",
            |_| anyhow::bail!("synthetic interrupted initialization")
        )
        .is_err()
    );
    let count = std::fs::read_dir(temp.path())?.count();
    assert!(DomainStorageGuard::observe(&profile, &scope(), StorageDomain::Memory).is_err());
    assert!(
        DomainStorageGuard::initialize(
            &profile,
            &scope(),
            StorageDomain::Memory,
            "operation",
            |_| Ok(())
        )
        .is_err()
    );
    assert_eq!(std::fs::read_dir(temp.path())?.count(), count);
    Ok(())
}

/// Duplicate every open descriptor of a regular file directly inside `parent`,
/// as a child forked at that moment would inherit it until exec.
#[cfg(target_os = "linux")]
fn inherited_file_descriptors(parent: &std::path::Path) -> Vec<std::os::fd::OwnedFd> {
    use std::os::fd::{BorrowedFd, RawFd};
    let mut duplicates = Vec::new();
    for entry in std::fs::read_dir("/proc/self/fd").unwrap().flatten() {
        let Ok(fd) = entry.file_name().to_string_lossy().parse::<RawFd>() else {
            continue;
        };
        let Ok(target) = std::fs::read_link(entry.path()) else {
            continue;
        };
        if target.parent() != Some(parent) || !target.is_file() {
            continue;
        }
        // SAFETY: the descriptor stays open for the duration of the enclosing
        // initializer call, which is where this runs.
        let borrowed = unsafe { BorrowedFd::borrow_raw(fd) };
        if let Ok(duplicate) = borrowed.try_clone_to_owned() {
            duplicates.push(duplicate);
        }
    }
    duplicates
}

#[cfg(target_os = "linux")]
#[test]
fn failed_initialization_unlocks_the_marker_despite_an_inherited_descriptor() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = std::fs::canonicalize(temp.path())?;
    let profile = PrivateDirectory::open_or_create(&root)?;
    let mut inherited = Vec::new();
    assert!(
        DomainStorageGuard::initialize::<()>(
            &profile,
            &scope(),
            StorageDomain::Memory,
            "operation",
            |_| {
                inherited = inherited_file_descriptors(&root);
                anyhow::bail!("synthetic interrupted initialization")
            }
        )
        .is_err()
    );
    assert!(!inherited.is_empty(), "the locked marker must be open here");
    // The duplicate shares the marker's open file description, as a forked
    // child does until exec. The failed initializer released the lock itself,
    // so observers see the unconfirmed state rather than a busy marker.
    let error = DomainStorageGuard::observe(&profile, &scope(), StorageDomain::Memory)
        .expect_err("interrupted initialization stays unconfirmed");
    assert!(
        format!("{error:#}").contains("INTEGRATION_STORAGE_INITIALIZATION_UNCONFIRMED"),
        "{error:#}"
    );
    drop(inherited);
    Ok(())
}

#[test]
fn missing_domain_data_does_not_become_an_empty_store() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(temp.path())?;
    let (guard, ()) = DomainStorageGuard::initialize(
        &profile,
        &scope(),
        StorageDomain::Memory,
        "operation",
        |_| Ok(()),
    )?;
    let path = temp.path().join(&guard.initialization.directory_name);
    drop(guard);
    std::fs::remove_dir(&path)?;
    assert!(DomainStorageGuard::observe(&profile, &scope(), StorageDomain::Memory).is_err());
    assert!(!path.exists());
    Ok(())
}

#[test]
fn control_replacement_invalidates_live_guard_and_cold_open_pins_the_current_file() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(temp.path())?;
    let (guard, ()) = DomainStorageGuard::initialize(
        &profile,
        &scope(),
        StorageDomain::Memory,
        "operation",
        |_| Ok(()),
    )?;
    let control = temp.path().join(&guard.marker_name);
    let bytes = std::fs::read(&control)?;
    profile.atomic_replace(OsStr::new(&guard.marker_name), &bytes)?;
    assert!(guard.directory(&profile).is_err());
    let fresh = DomainStorageGuard::observe(&profile, &scope(), StorageDomain::Memory)?.unwrap();
    assert_eq!(fresh.initialization, guard.initialization);
    assert_ne!(fresh.marker_identity, fresh.initialization.marker_identity);
    fresh.directory(&profile)?;
    let lease = profile
        .try_existing_config_root_lock(
            OsStr::new(&fresh.marker_name),
            &fresh.marker_identity,
            PrivateLeaseMode::Exclusive,
        )?
        .unwrap();
    assert!(DomainStorageGuard::observe(&profile, &scope(), StorageDomain::Memory).is_err());
    drop(lease);
    assert!(DomainStorageGuard::observe(&profile, &scope(), StorageDomain::Memory)?.is_some());
    assert_eq!(std::fs::read(control)?, bytes);
    Ok(())
}

#[test]
fn live_guard_rejects_namespace_replacement() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(temp.path())?;
    let (guard, ()) = DomainStorageGuard::initialize(
        &profile,
        &scope(),
        StorageDomain::Memory,
        "operation",
        |_| Ok(()),
    )?;
    std::fs::rename(
        temp.path().join(guard.namespace_id()),
        temp.path().join("retained-original-namespace"),
    )?;
    let replacement = profile.create_private_child(OsStr::new(guard.namespace_id()))?;
    assert_ne!(
        replacement.directory_identity()?,
        guard.directory.directory_identity()?
    );
    assert!(guard.verified_directory(&profile).is_err());
    Ok(())
}

#[test]
fn warm_control_reads_recheck_bytes_on_the_same_file() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(temp.path())?;
    let (guard, ()) = DomainStorageGuard::initialize(
        &profile,
        &scope(),
        StorageDomain::Memory,
        "operation",
        |_| Ok(()),
    )?;
    let path = temp.path().join(&guard.marker_name);
    let original = std::fs::read(&path)?;
    guard.directory(&profile)?;

    let equivalent = [b" ".as_slice(), original.as_slice()].concat();
    std::fs::write(&path, equivalent)?;
    guard.directory(&profile)?;

    let mut changed = guard.initialization.clone();
    changed.operation_id = "different-operation".into();
    std::fs::write(
        &path,
        format!(
            "{}\n{}\n",
            serde_json::to_string(&changed)?,
            serde_json::to_string(&guard.ready)?
        ),
    )?;
    assert!(guard.directory(&profile).is_err());
    std::fs::write(&path, &original[..original.len() - 1])?;
    assert!(guard.directory(&profile).is_err());
    std::fs::write(&path, original)?;
    guard.directory(&profile)?;
    Ok(())
}

#[test]
fn unreceipted_directories_are_not_adopted() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(temp.path())?;
    let (_, directory) = names(&IntegrationOwner::from(&scope()), StorageDomain::Memory)?;
    profile.create_private_child(OsStr::new(&directory))?;
    assert!(DomainStorageGuard::observe(&profile, &scope(), StorageDomain::Memory).is_err());
    assert!(
        DomainStorageGuard::initialize(
            &profile,
            &scope(),
            StorageDomain::Memory,
            "operation",
            |_| Ok(())
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn owner_directory_enumerates_committed_workspaces_and_never_other_targets() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(temp.path())?;
    let first = scope();
    let mut second = first.clone();
    second.workspace_id = IntegrationNullable::Value("second-workspace".into());
    let mut foreign = first.clone();
    foreign.target_id = "another-native-target".into();
    for (name, owner) in [
        ("first", &first),
        ("second", &second),
        ("foreign", &foreign),
    ] {
        DomainStorageGuard::initialize(&profile, owner, StorageDomain::Connectivity, name, |_| {
            Ok(())
        })?;
    }
    let before = std::fs::read_dir(temp.path())?.count();
    let (rows, complete) = DomainStorageGuard::observe_owned_domains(
        &profile,
        temp.path(),
        &first,
        StorageDomain::Connectivity,
    )?;
    assert!(complete);
    assert_eq!(rows.len(), 2);
    assert!(
        rows.iter()
            .all(|(owner, _)| owner.target_id == first.target_id)
    );
    assert_ne!(rows[0].0.workspace_id, rows[1].0.workspace_id);
    assert_eq!(std::fs::read_dir(temp.path())?.count(), before);
    Ok(())
}

#[test]
fn interrupted_domain_does_not_make_target_directory_falsely_complete() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(temp.path())?;
    DomainStorageGuard::initialize(
        &profile,
        &scope(),
        StorageDomain::Connectivity,
        "committed",
        |_| Ok(()),
    )?;
    assert!(
        DomainStorageGuard::initialize::<()>(
            &profile,
            &scope(),
            StorageDomain::Memory,
            "interrupted",
            |_| anyhow::bail!("controlled interrupted initialization")
        )
        .is_err()
    );
    let before = std::fs::read_dir(temp.path())?.count();
    let (rows, complete) = DomainStorageGuard::observe_owned_domains(
        &profile,
        temp.path(),
        &scope(),
        StorageDomain::Connectivity,
    )?;
    assert!(!complete);
    assert_eq!(rows.len(), 1);
    assert_eq!(std::fs::read_dir(temp.path())?.count(), before);
    Ok(())
}

#[test]
fn shared_workspace_resources_keep_existing_office_namespace_identity() -> Result<()> {
    let owner = IntegrationOwner::from(&scope());
    assert_eq!(
        serde_json::to_value(StorageDomain::WorkspaceResources)?,
        "office"
    );
    assert_eq!(
        serde_json::from_value::<StorageDomain>(serde_json::json!("office"))?,
        StorageDomain::WorkspaceResources
    );
    let legacy = Sha256::digest(serde_json::to_vec(&("native-domain-v1", &owner, "office"))?);
    assert_eq!(
        names(&owner, StorageDomain::WorkspaceResources)?,
        (
            format!(".integration-{legacy:x}.jsonl"),
            format!("integration-{legacy:x}")
        )
    );
    Ok(())
}

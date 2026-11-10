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
        serde_json::to_value(NativeDomain::ConnectivityTaskCapabilityScope)?,
        "connectivity_task_sources"
    );
    Ok(())
}

#[test]
fn observation_is_read_only_and_initialization_is_durable() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(temp.path())?;
    assert!(NativeDomainGuard::observe(&profile, &scope(), NativeDomain::Memory)?.is_none());
    assert_eq!(std::fs::read_dir(temp.path())?.count(), 0);
    let (guard, ()) = NativeDomainGuard::initialize(
        &profile,
        &scope(),
        NativeDomain::Memory,
        "initialize-once",
        |directory| {
            directory.append(OsStr::new("material"), b"retained")?;
            Ok(())
        },
    )?;
    let count = std::fs::read_dir(temp.path())?.count();
    assert_eq!(count, 2);
    assert!(NativeDomainGuard::observe(&profile, &scope(), NativeDomain::Memory)?.is_some());
    assert_eq!(std::fs::read_dir(temp.path())?.count(), count);
    assert!(
        NativeDomainGuard::initialize(
            &profile,
            &scope(),
            NativeDomain::Memory,
            "different-operation",
            |_| Ok(())
        )
        .is_err()
    );
    assert!(NativeDomainGuard::observe(&profile, &scope(), NativeDomain::Office)?.is_none());
    guard.directory(&profile)?;
    Ok(())
}

#[test]
fn failed_initialization_is_not_reset_on_read_or_retry() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(temp.path())?;
    assert!(
        NativeDomainGuard::initialize::<()>(
            &profile,
            &scope(),
            NativeDomain::Memory,
            "operation",
            |_| anyhow::bail!("synthetic interrupted initialization")
        )
        .is_err()
    );
    let count = std::fs::read_dir(temp.path())?.count();
    assert!(NativeDomainGuard::observe(&profile, &scope(), NativeDomain::Memory).is_err());
    assert!(
        NativeDomainGuard::initialize(
            &profile,
            &scope(),
            NativeDomain::Memory,
            "operation",
            |_| Ok(())
        )
        .is_err()
    );
    assert_eq!(std::fs::read_dir(temp.path())?.count(), count);
    Ok(())
}

#[test]
fn missing_domain_data_does_not_become_an_empty_store() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(temp.path())?;
    let (guard, ()) = NativeDomainGuard::initialize(
        &profile,
        &scope(),
        NativeDomain::Memory,
        "operation",
        |_| Ok(()),
    )?;
    let path = temp.path().join(&guard.initialization.directory_name);
    std::fs::remove_dir(&path)?;
    assert!(guard.directory(&profile).is_err());
    assert!(NativeDomainGuard::observe(&profile, &scope(), NativeDomain::Memory).is_err());
    assert!(!path.exists());
    Ok(())
}

#[test]
fn control_replacement_is_rejected_by_live_and_fresh_observers() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(temp.path())?;
    let (guard, ()) = NativeDomainGuard::initialize(
        &profile,
        &scope(),
        NativeDomain::Memory,
        "operation",
        |_| Ok(()),
    )?;
    let control = temp.path().join(&guard.marker_name);
    let bytes = std::fs::read(&control)?;
    profile.atomic_replace(OsStr::new(&guard.marker_name), &bytes)?;
    assert!(guard.directory(&profile).is_err());
    assert!(NativeDomainGuard::observe(&profile, &scope(), NativeDomain::Memory).is_err());
    Ok(())
}

#[test]
fn warm_control_reads_recheck_bytes_on_the_same_file() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(temp.path())?;
    let (guard, ()) = NativeDomainGuard::initialize(
        &profile,
        &scope(),
        NativeDomain::Memory,
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
    let (_, directory) = names(&IntegrationOwner::from(&scope()), NativeDomain::Memory)?;
    profile.create_private_child(OsStr::new(&directory))?;
    assert!(NativeDomainGuard::observe(&profile, &scope(), NativeDomain::Memory).is_err());
    assert!(
        NativeDomainGuard::initialize(
            &profile,
            &scope(),
            NativeDomain::Memory,
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
        NativeDomainGuard::initialize(&profile, owner, NativeDomain::Connectivity, name, |_| {
            Ok(())
        })?;
    }
    let before = std::fs::read_dir(temp.path())?.count();
    let (rows, complete) = NativeDomainGuard::observe_owned_domains(
        &profile,
        temp.path(),
        &first,
        NativeDomain::Connectivity,
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
    NativeDomainGuard::initialize(
        &profile,
        &scope(),
        NativeDomain::Connectivity,
        "committed",
        |_| Ok(()),
    )?;
    assert!(
        NativeDomainGuard::initialize::<()>(
            &profile,
            &scope(),
            NativeDomain::Memory,
            "interrupted",
            |_| anyhow::bail!("controlled interrupted initialization")
        )
        .is_err()
    );
    let before = std::fs::read_dir(temp.path())?.count();
    let (rows, complete) = NativeDomainGuard::observe_owned_domains(
        &profile,
        temp.path(),
        &scope(),
        NativeDomain::Connectivity,
    )?;
    assert!(!complete);
    assert_eq!(rows.len(), 1);
    assert_eq!(std::fs::read_dir(temp.path())?.count(), before);
    Ok(())
}

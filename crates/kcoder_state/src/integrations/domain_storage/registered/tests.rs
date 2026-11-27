use super::*;
use kcoder_types::integrations::core::IntegrationNullable;

fn scope(workspace: &str) -> IntegrationScope {
    IntegrationScope {
        account_id: "account".into(),
        target_id: "target".into(),
        workspace_id: IntegrationNullable::Value(workspace.into()),
        organization_id: None,
        identity_generation: "generation".into(),
        target_revision: "revision".into(),
    }
}

#[test]
fn registered_inventory_is_pure_and_retains_all_workspace_and_organization_owners() -> Result<()> {
    let root = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_existing(root.path())?;
    assert!(DomainStorageGuard::observe_registered_domains(&profile)?.is_empty());
    assert_eq!(std::fs::read_dir(root.path())?.count(), 0);
    let first = scope("first");
    let mut second = scope("second");
    second.organization_id = Some(IntegrationNullable::Value("organization".into()));
    for owner in [&first, &second] {
        DomainStorageGuard::initialize(
            &profile,
            owner,
            StorageDomain::Memory,
            "owned",
            |_| Ok(()),
        )?;
    }
    let registered = DomainStorageGuard::observe_registered_domains(&profile)?;
    assert_eq!(registered.len(), 2);
    assert!(
        registered
            .iter()
            .any(|entry| entry.owner() == &IntegrationOwner::from(&first))
    );
    assert!(
        registered
            .iter()
            .any(|entry| entry.owner() == &IntegrationOwner::from(&second))
    );
    for entry in &registered {
        entry.verify(&profile)?;
    }
    Ok(())
}

#[test]
fn registered_inventory_accepts_cold_copies_without_rewriting_initialization() -> Result<()> {
    let source_root = tempfile::tempdir()?;
    let target_root = tempfile::tempdir()?;
    let source_profile = PrivateDirectory::open_existing(source_root.path())?;
    let target_profile = PrivateDirectory::open_existing(target_root.path())?;
    let (source, ()) = DomainStorageGuard::initialize(
        &source_profile,
        &scope("one"),
        StorageDomain::Services,
        "original-initialization",
        |_| Ok(()),
    )?;
    let control = std::fs::read(source_root.path().join(&source.marker_name))?;
    std::fs::copy(
        source_root.path().join(&source.marker_name),
        target_root.path().join(&source.marker_name),
    )?;
    target_profile.create_private_child(OsStr::new(source.namespace_id()))?;
    let inventory = DomainStorageGuard::observe_registered_domains(&target_profile)?;
    assert_eq!(inventory.len(), 1);
    let copied = &inventory[0];
    assert_eq!(copied.domain(), StorageDomain::Services);
    assert_eq!(copied.owner(), &source.initialization.owner);
    assert_eq!(copied.guard.initialization, source.initialization);
    assert_eq!(copied.guard.ready, source.ready);
    assert_ne!(copied.guard.marker_identity, source.marker_identity);
    copied.verify(&target_profile)?;
    assert_eq!(
        std::fs::read(target_root.path().join(&source.marker_name))?,
        control
    );
    assert_eq!(std::fs::read_dir(target_root.path())?.count(), 2);
    Ok(())
}

#[test]
fn reserved_partial_unknown_and_orphan_entries_are_named_and_never_skipped() -> Result<()> {
    for kind in ["partial", "unknown", "orphan", "prepared"] {
        let root = tempfile::tempdir()?;
        let profile = PrivateDirectory::open_existing(root.path())?;
        let (marker, directory) = names(
            &IntegrationOwner::from(&scope("one")),
            StorageDomain::Memory,
        )?;
        let name = match kind {
            "partial" => {
                profile.atomic_replace(OsStr::new(&marker), b"{}\n")?;
                marker
            }
            "unknown" => {
                let (guard, ()) = DomainStorageGuard::initialize(
                    &profile,
                    &scope("one"),
                    StorageDomain::Memory,
                    "owned",
                    |_| Ok(()),
                )?;
                let file = profile.open_single_link_regular_file(OsStr::new(&guard.marker_name))?;
                let bytes = read_control_bytes(&file)?;
                let text = String::from_utf8(bytes)?.replace("\"memory\"", "\"unknown_domain\"");
                profile.atomic_replace(OsStr::new(&marker), text.as_bytes())?;
                marker
            }
            "orphan" => {
                profile.create_private_child(OsStr::new(&directory))?;
                directory
            }
            _ => {
                let name = ".integration-relocation-owned.prepared";
                profile.atomic_replace(OsStr::new(name), b"{}")?;
                name.into()
            }
        };
        let error = DomainStorageGuard::observe_registered_domains(&profile)
            .err()
            .context("partial entry was accepted")?;
        assert!(format!("{error:#}").contains(&name), "{error:#}");
    }
    Ok(())
}

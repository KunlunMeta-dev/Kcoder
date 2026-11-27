use super::*;

fn fixture() -> Result<(
    tempfile::TempDir,
    PrivateDirectory,
    IntegrationScope,
    NativeIdentity,
)> {
    let root = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_existing(root.path())?;
    let logical = ProfileIdentity::observe(&profile)?;
    let derive = |domain| {
        kcoder_integration_storage::profile_resources::profile_resource_identity(
            domain,
            logical.logical_seed(),
        )
    };
    let mut scope = IntegrationScope {
        account_id: derive("account-profile"),
        target_id: derive("native-target"),
        workspace_id: IntegrationNullable::Null,
        organization_id: None,
        identity_generation: "initial-handshake".into(),
        target_revision: "revision".into(),
    };
    let identity = NativeIdentity::initialize(&profile, &scope, "owned-native")?;
    scope.identity_generation = identity.snapshot(&profile)?.generation;
    Ok((root, profile, scope, identity))
}

#[test]
fn offline_inventory_keeps_disabled_epoch_and_every_registered_data_scope() -> Result<()> {
    let (_root, profile, global, identity) = fixture()?;
    for workspace in ["first", "second"] {
        let mut scope = global.clone();
        scope.workspace_id = IntegrationNullable::Value(workspace.into());
        scope.organization_id = Some(IntegrationNullable::Value(format!("org-{workspace}")));
        NativeDomainGuard::initialize(
            &profile,
            &scope,
            NativeDomain::Memory,
            "owned-memory",
            |_| Ok(()),
        )?;
    }
    identity.disable(&profile, "disabled-original", 1, 1000)?;
    let inventory = identity.observe_domains(&profile, "revision")?;
    assert!(!inventory.snapshot().enabled);
    assert_eq!(inventory.domains().len(), 3);
    assert_eq!(
        inventory
            .domains()
            .iter()
            .filter(|entry| entry.domain() == NativeDomain::Memory)
            .count(),
        2
    );
    for entry in inventory.domains() {
        entry.verify(&identity, &profile)?;
    }
    inventory.verify(&identity, &profile)?;
    Ok(())
}

#[test]
fn new_partial_control_or_revocation_invalidates_the_existing_inventory() -> Result<()> {
    let (_root, profile, _global, identity) = fixture()?;
    let inventory = identity.observe_domains(&profile, "revision")?;
    identity.disable(&profile, "revoke-after-observe", 1, 1000)?;
    assert!(inventory.verify(&identity, &profile).is_err());
    let current = identity.observe_domains(&profile, "revision")?;
    let marker = format!(".integration-{}.jsonl", "a".repeat(64));
    profile.atomic_replace(OsStr::new(&marker), b"{}\n")?;
    assert!(current.verify(&identity, &profile).is_err());
    assert!(NativeProfileDomains::observe(&profile, "revision").is_err());
    Ok(())
}

#[test]
fn identity_free_preview_never_initializes_or_ignores_partial_domains() -> Result<()> {
    let root = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_existing(root.path())?;
    assert!(NativeProfileDomains::observe(&profile, "revision")?.is_none());
    assert_eq!(std::fs::read_dir(root.path())?.count(), 0);
    let marker = format!(".integration-{}.jsonl", "b".repeat(64));
    profile.atomic_replace(OsStr::new(&marker), b"{}\n")?;
    assert!(NativeProfileDomains::observe(&profile, "revision").is_err());
    assert_eq!(std::fs::read_dir(root.path())?.count(), 1);
    Ok(())
}

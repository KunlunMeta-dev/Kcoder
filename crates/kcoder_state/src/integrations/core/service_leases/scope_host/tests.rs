use super::*;
use kcoder_types::integrations::core::NativeScopeHostResources;
fn fixture() -> Result<(
    tempfile::TempDir,
    IntegrationServiceLeaseStore,
    NativeScopeHostLaunchSpec,
)> {
    let root = tempfile::tempdir()?;
    let directory = PrivateDirectory::open_or_create(root.path())?;
    let scope: IntegrationScope =
        serde_json::from_value(serde_json::json!({"accountId":"owner","targetId":"target",
        "workspaceId":"workspace","identityGeneration":"1","targetRevision":"1"}))?;
    let store =
        IntegrationServiceLeaseStore::create_in(&directory, OsStr::new("services"), &scope)?;
    let spec = NativeScopeHostLaunchSpec {
        schema_version: 1,
        scope,
        profile_path: root.path().join("profile"),
        workspace_path: root.path().join("workspace"),
        settings_file: root.path().join("profile/settings.json"),
        configuration_sha256: "a".repeat(64),
        native_image_sha256: "b".repeat(64),
        office: None,
        resources: NativeScopeHostResources {
            component_root: root.path().join("resources"),
            component_manifest_sha256: "c".repeat(64),
            node_program: root.path().join("node"),
            node_image_sha256: "d".repeat(64),
            runtime_mode: "standalone_node".into(),
            node_version: None,
            electron_version: None,
        },
    };
    Ok((root, store, spec))
}
#[test]
fn all_launch_generations_share_one_actual_kernel_slot_and_metadata_is_not_running() -> Result<()> {
    let (_root, store, spec) = fixture()?;
    let first = store.prepare_scope_host(&spec, "original-foreground-save")?;
    assert_eq!(
        store.prepare_scope_host(&spec, "another-explicit-ui-operation")?,
        first
    );
    let held = store
        .try_claim_scope_host(&first)?
        .context("initial original slot unavailable")?;
    store.verify_scope_host_descriptor(&first, held.file())?;
    let foreign = store
        .directory
        .open_single_link_regular_file(OsStr::new("writer.lock"))?;
    assert!(
        store
            .verify_scope_host_descriptor(&first, &foreign)
            .is_err()
    );
    let mut successor = spec.clone();
    successor.configuration_sha256 = "e".repeat(64);
    let next = store.prepare_scope_host(&successor, "explicit-next-configuration")?;
    assert_ne!(first, next);
    assert_eq!(store.list_scope_hosts()?.len(), 2);
    assert!(store.try_claim_scope_host(&next)?.is_none());
    assert_eq!(store.read_scope_host(&first)?.unwrap(), spec);
    assert_eq!(store.read_scope_host(&next)?.unwrap(), successor);
    drop(held);
    assert!(store.try_claim_scope_host(&next)?.is_some());
    Ok(())
}
#[test]
fn wrong_owner_read_and_slot_replacement_never_adopt_the_original_host() -> Result<()> {
    let (root, store, mut spec) = fixture()?;
    let first = store.prepare_scope_host(&spec, "original-save")?;
    spec.scope.account_id = "another-owner".into();
    assert!(
        store
            .prepare_scope_host(&spec, "foreign-operation")
            .is_err()
    );
    std::fs::rename(
        root.path().join("services").join(HOST_SLOT),
        root.path().join("services/retained-original-slot.lock"),
    )?;
    store
        .directory
        .open_read_write_file(OsStr::new(HOST_SLOT), true)?;
    assert!(store.read_scope_host(&first).is_err());
    assert!(store.try_claim_scope_host(&first).is_err());
    Ok(())
}
#[test]
fn read_missing_and_orphan_slot_do_not_create_or_repair_a_preparation() -> Result<()> {
    let (_root, store, spec) = fixture()?;
    assert!(store.read_scope_host(&"a".repeat(64))?.is_none());
    assert!(
        store
            .directory
            .open_single_link_regular_file(OsStr::new(HOST_SLOT))
            .is_err()
    );
    store
        .directory
        .open_read_write_file(OsStr::new(HOST_SLOT), true)?;
    assert!(
        store
            .prepare_scope_host(&spec, "original-unknown-save")
            .is_err()
    );
    Ok(())
}

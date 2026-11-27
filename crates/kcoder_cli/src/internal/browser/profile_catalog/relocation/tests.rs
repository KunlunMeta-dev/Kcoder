use super::*;
use kcoder_config::storage::{
    StorageCoordinator, StoragePublishedComponent, StorageResolveInput, resolve_storage_paths,
};
use kcoder_types::{
    STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLaunchIntent, StorageLocationRecord,
    StorageMigrationComponent, StorageMigrationPhase as Phase, StorageMigrationPlan,
    StorageTargetBinding,
};
use std::{collections::BTreeSet, path::Path};

fn publish(outer: &Path, source: &Path, target: &Path) -> Result<StoragePublishedComponent> {
    let home = outer.join("operation-home");
    PrivateDirectory::open_existing(outer)?.create_private_child(OsStr::new("operation-home"))?;
    let id = "native-browser-move";
    let mut coordinator = StorageCoordinator::acquire(&home)?;
    coordinator.begin(StorageMigrationPlan {
        version: 1,
        operation_id: id.into(),
        original: None,
        from: resolve_storage_paths(&StorageResolveInput {
            home: Some(home),
            ..Default::default()
        })?,
        target: StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: target.into(),
            cache_root: outer.join("cache"),
            operation_id: Some(id.into()),
        },
        components: vec![StorageMigrationComponent {
            domain: STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
            source: source.into(),
            destination: target.into(),
            source_identity: PrivateDirectory::open_existing(source)?.directory_identity()?,
            estimated_bytes: 0,
        }],
        target_bindings: vec![StorageTargetBinding {
            path: target.into(),
            existing_ancestor: outer.into(),
            ancestor_identity: PrivateDirectory::open_existing(outer)?.directory_identity()?,
        }],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    })?;
    coordinator.advance(id, Phase::Planned, Phase::Stopping)?;
    coordinator.advance(id, Phase::Stopping, Phase::Stopped)?;
    coordinator.advance(id, Phase::Stopped, Phase::Copying)?;
    coordinator.publish_component(id, STORAGE_PERSISTENT_ROOT_DOMAIN, &BTreeSet::new())?;
    coordinator.open_published_component(id, STORAGE_PERSISTENT_ROOT_DOMAIN)
}

#[test]
fn native_catalog_owner_preserves_disabled_epoch_and_business_receipts_at_final_root() -> Result<()>
{
    let outer = tempfile::tempdir()?;
    let base = PrivateDirectory::open_existing(outer.path())?;
    let source_profile = base.create_private_child(OsStr::new("source"))?;
    base.create_private_child(OsStr::new("workspace"))?;
    let source_path = outer.path().join("source");
    let workspace_path = outer.path().join("workspace");
    let native =
        NativeIntegrationContext::capture(&source_path, &workspace_path, "owned", "revision")?;
    let (_, store) = NativeDomainGuard::initialize(
        &source_profile,
        native.scope(),
        NativeDomain::BrowserProfiles,
        "owned-catalog",
        |directory| {
            BrowserProfileStore::create_in(directory, OsStr::new("catalog"), native.scope())
        },
    )?;
    let original = store.save(
        "original-browser-account",
        kcoder_types::browser_profiles::BrowserAccountProfileDraft {
            id: "office".into(),
            label: "Owned account".into(),
            account_label: None,
            purpose: kcoder_types::browser_profiles::BrowserProfilePurpose::Business,
        },
        0,
    )?;
    let (global, identity, _) =
        NativeIntegrationContext::observe_global_profile(&source_profile, "revision")?.unwrap();
    identity.disable(&source_profile, "original-disabled-state", 1, 1000)?;
    assert!(native.verify().is_err());
    let inventory = identity.observe_domains(&source_profile, "revision")?;
    let entry = inventory
        .domains()
        .iter()
        .find(|entry| entry.domain() == NativeDomain::BrowserProfiles)
        .unwrap();
    let owner = NativeBrowserCatalogRelocation::observe(entry, &identity, &source_profile)?;
    let prepared = owner.prepare_relocation(entry, &identity, &source_profile)?;
    let published = publish(outer.path(), &source_path, &outer.path().join("target"))?;
    prepared.verify()?;
    let expected = identity.snapshot(&source_profile)?;
    let target_identity = identity.relocate(
        &source_profile,
        published.directory(),
        &global,
        published.operation_id(),
        &expected,
    )?;
    let transaction = entry.prepare_relocation(
        &identity,
        &source_profile,
        &target_identity,
        published.directory(),
        &published,
        Path::new(""),
    )?;
    let target_guard = prepared.relocate(transaction)?;
    assert!(!target_identity.snapshot(published.directory())?.enabled);
    let directory = target_guard.directory(published.directory())?;
    let target_store =
        BrowserProfileStore::open_in(&directory, OsStr::new("catalog"), entry.scope())?.unwrap();
    assert_eq!(target_store.list(None, true)?.items, vec![original]);
    let transaction = entry.prepare_relocation(
        &identity,
        &source_profile,
        &target_identity,
        published.directory(),
        &published,
        Path::new(""),
    )?;
    assert!(transaction.is_committed());
    owner.verify_relocation(transaction)?;
    assert!(
        NativeIntegrationContext::capture_existing(
            published.destination_path(),
            &workspace_path,
            "must-remain-disabled",
            "revision"
        )
        .is_err()
    );
    Ok(())
}

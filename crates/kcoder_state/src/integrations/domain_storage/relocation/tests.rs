use super::*;
use kcoder_types::integrations::core::IntegrationNullable;
use std::io::Read;
use std::path::Path;

fn scope() -> IntegrationScope {
    IntegrationScope {
        account_id: "owned-account".into(),
        target_id: "owned-target".into(),
        workspace_id: IntegrationNullable::Value("owned-workspace".into()),
        organization_id: None,
        identity_generation: "original-generation".into(),
        target_revision: "original-revision".into(),
    }
}

fn copy_domain(source_root: &Path, target_root: &Path, source: &DomainStorageGuard) -> Result<()> {
    std::fs::copy(
        source_root.join(&source.marker_name),
        target_root.join(&source.marker_name),
    )?;
    let target = PrivateDirectory::open_existing(target_root)?;
    target.create_private_child(OsStr::new(source.namespace_id()))?;
    std::fs::copy(
        source_root.join(source.namespace_id()).join("state.json"),
        target_root.join(source.namespace_id()).join("state.json"),
    )?;
    Ok(())
}

fn initialize(profile: &PrivateDirectory) -> Result<DomainStorageGuard> {
    Ok(DomainStorageGuard::initialize(
        profile,
        &scope(),
        StorageDomain::Memory,
        "original-initialization",
        |directory| {
            directory.atomic_replace(
                OsStr::new("state.json"),
                br#"{"generation":8,"operationId":"original-business-receipt","status":"unknown"}"#,
            )
        },
    )?
    .0)
}

#[test]
fn raw_copy_requires_the_existing_owner_and_preserves_business_receipts() -> Result<()> {
    let source_root = tempfile::tempdir()?;
    let target_root = tempfile::tempdir()?;
    let source_profile = PrivateDirectory::open_existing(source_root.path())?;
    let target_profile = PrivateDirectory::open_existing(target_root.path())?;
    let source = initialize(&source_profile)?;
    copy_domain(source_root.path(), target_root.path(), &source)?;
    let source_control = std::fs::read(source_root.path().join(&source.marker_name))?;
    let copied = DomainStorageGuard::observe(&target_profile, &scope(), StorageDomain::Memory)?
        .context("copied initialization was not readable")?;
    assert_eq!(copied.initialization, source.initialization);
    assert_eq!(copied.ready, source.ready);
    assert_ne!(copied.marker_identity, source.marker_identity);
    assert_ne!(
        copied.directory(&target_profile)?.directory_identity()?,
        copied.ready.directory_identity
    );
    assert!(source.directory(&target_profile).is_err());
    assert_eq!(
        std::fs::read(target_root.path().join(&source.marker_name))?,
        source_control
    );
    assert_eq!(std::fs::read_dir(target_root.path())?.count(), 2);
    drop(copied);
    let original_state = std::fs::read(
        source_root
            .path()
            .join(source.namespace_id())
            .join("state.json"),
    )?;
    let facade = source.try_clone(&source_profile)?;
    let transaction = facade.prepare_relocation(&source_profile, &target_profile, "move-once")?;
    assert!(!transaction.is_committed());
    // Repeated reads use the original lease handles without releasing either
    // real lock, including Windows mandatory byte-range exclusion.
    transaction.verify()?;
    transaction.verify()?;
    for (profile, identity) in [
        (&source_profile, &source.marker_identity),
        (&target_profile, &transaction.target_marker_identity),
    ] {
        assert!(
            profile
                .try_existing_config_root_lock(
                    OsStr::new(&source.marker_name),
                    identity,
                    PrivateLeaseMode::Exclusive,
                )?
                .is_none()
        );
    }
    let target = transaction.commit(|source_directory, target| {
        source.directory(&source_profile)?;
        let read = |directory: &PrivateDirectory| -> Result<Vec<u8>> {
            let mut bytes = Vec::new();
            directory
                .open_single_link_regular_file(OsStr::new("state.json"))?
                .read_to_end(&mut bytes)?;
            Ok(bytes)
        };
        ensure!(
            read(source_directory)? == read(target)?,
            "business receipt changed"
        );
        Ok(())
    })?;
    assert_eq!(target.initialization.owner, source.initialization.owner);
    assert_eq!(
        target.initialization.operation_id,
        "original-initialization"
    );
    assert_eq!(
        std::fs::read(source_root.path().join(&source.marker_name))?,
        source_control
    );
    assert_eq!(
        std::fs::read(
            target_root
                .path()
                .join(target.namespace_id())
                .join("state.json")
        )?,
        original_state
    );
    target.directory(&target_profile)?;
    DomainStorageGuard::observe(&target_profile, &scope(), StorageDomain::Memory)?.unwrap();
    Ok(())
}

#[test]
fn a_legacy_relocation_receipt_is_history_on_the_next_cold_copy() -> Result<()> {
    let source_root = tempfile::tempdir()?;
    let target_root = tempfile::tempdir()?;
    let next_root = tempfile::tempdir()?;
    let source_profile = PrivateDirectory::open_existing(source_root.path())?;
    let target_profile = PrivateDirectory::open_existing(target_root.path())?;
    let next_profile = PrivateDirectory::open_existing(next_root.path())?;
    let source = initialize(&source_profile)?;
    copy_domain(source_root.path(), target_root.path(), &source)?;
    let relocated = source
        .prepare_relocation(&source_profile, &target_profile, "legacy-move")?
        .commit(|_, _| Ok(()))?;
    let original = std::fs::read(target_root.path().join(&relocated.marker_name))?;
    copy_domain(target_root.path(), next_root.path(), &relocated)?;
    let copied = DomainStorageGuard::observe(&next_profile, &scope(), StorageDomain::Memory)?
        .context("legacy receipt did not survive a cold copy")?;
    assert_eq!(copied.initialization, relocated.initialization);
    assert_eq!(copied.ready, relocated.ready);
    assert_ne!(copied.marker_identity, relocated.marker_identity);
    assert_ne!(
        copied
            .initialization
            .relocation
            .as_ref()
            .unwrap()
            .target_profile_identity,
        next_profile.directory_identity()?
    );
    copied.directory(&next_profile)?;
    assert_eq!(
        std::fs::read(next_root.path().join(&copied.marker_name))?,
        original
    );
    assert_eq!(std::fs::read_dir(next_root.path())?.count(), 2);
    Ok(())
}

#[test]
fn lost_ack_reconciles_the_same_binding_and_rejects_another_operation() -> Result<()> {
    let source_root = tempfile::tempdir()?;
    let target_root = tempfile::tempdir()?;
    let source_profile = PrivateDirectory::open_existing(source_root.path())?;
    let target_profile = PrivateDirectory::open_existing(target_root.path())?;
    let source = initialize(&source_profile)?;
    copy_domain(source_root.path(), target_root.path(), &source)?;
    drop(
        source
            .prepare_relocation(&source_profile, &target_profile, "move")?
            .commit(|_, _| Ok(()))?,
    );
    let path = target_root.path().join(&source.marker_name);
    let bytes = std::fs::read(&path)?;
    let marker_identity = target_profile.regular_file_identity(OsStr::new(&source.marker_name))?;
    let transaction = source.prepare_relocation(&source_profile, &target_profile, "move")?;
    assert!(transaction.is_committed());
    transaction.commit(|_, _| Ok(()))?;
    assert_eq!(std::fs::read(&path)?, bytes);
    assert_eq!(
        target_profile.regular_file_identity(OsStr::new(&source.marker_name))?,
        marker_identity
    );
    assert!(
        source
            .prepare_relocation(&source_profile, &target_profile, "different-move")
            .is_err()
    );
    assert_eq!(std::fs::read(&path)?, bytes);
    Ok(())
}

#[test]
fn a_real_source_lease_or_owner_validation_failure_prevents_publication() -> Result<()> {
    let source_root = tempfile::tempdir()?;
    let target_root = tempfile::tempdir()?;
    let source_profile = PrivateDirectory::open_existing(source_root.path())?;
    let target_profile = PrivateDirectory::open_existing(target_root.path())?;
    let source = initialize(&source_profile)?;
    copy_domain(source_root.path(), target_root.path(), &source)?;
    let before = std::fs::read(target_root.path().join(&source.marker_name))?;
    let lease = source_profile
        .try_existing_config_root_lock(
            OsStr::new(&source.marker_name),
            &source.marker_identity,
            PrivateLeaseMode::Shared,
        )?
        .unwrap();
    assert!(
        source
            .prepare_relocation(&source_profile, &target_profile, "move")
            .is_err()
    );
    drop(lease);
    assert!(
        source
            .prepare_relocation(&source_profile, &target_profile, "move")?
            .commit(|_, _| anyhow::bail!("owner has an unresolved receipt"))
            .is_err()
    );
    assert_eq!(
        std::fs::read(target_root.path().join(&source.marker_name))?,
        before
    );
    let copied = DomainStorageGuard::observe(&target_profile, &scope(), StorageDomain::Memory)?
        .context("owner rejection must not invalidate the original marker copy")?;
    assert!(copied.initialization.relocation.is_none());
    source.directory(&source_profile)?;
    Ok(())
}

#[test]
fn replacement_after_prepare_is_rejected_before_owner_callback() -> Result<()> {
    let source_root = tempfile::tempdir()?;
    let target_root = tempfile::tempdir()?;
    let source_profile = PrivateDirectory::open_existing(source_root.path())?;
    let target_profile = PrivateDirectory::open_existing(target_root.path())?;
    let source = initialize(&source_profile)?;
    copy_domain(source_root.path(), target_root.path(), &source)?;
    let before = std::fs::read(target_root.path().join(&source.marker_name))?;
    let transaction = source.prepare_relocation(&source_profile, &target_profile, "move")?;
    target_profile.atomic_replace(OsStr::new(&source.marker_name), &before)?;
    let mut called = false;
    assert!(
        transaction
            .commit(|_, _| {
                called = true;
                Ok(())
            })
            .is_err()
    );
    assert!(!called);
    assert_eq!(
        std::fs::read(target_root.path().join(&source.marker_name))?,
        before
    );
    Ok(())
}

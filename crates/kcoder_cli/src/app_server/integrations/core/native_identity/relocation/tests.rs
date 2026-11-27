use super::*;
use std::path::Path;

fn global_scope(profile: &PrivateDirectory) -> Result<IntegrationScope> {
    let seed = ProfileIdentity::observe(profile)?;
    let derive = |domain| {
        kcoder_integration_storage::profile_resources::profile_resource_identity(
            domain,
            seed.logical_seed(),
        )
    };
    Ok(IntegrationScope {
        account_id: derive("account-profile"),
        target_id: derive("native-target"),
        workspace_id: IntegrationNullable::Null,
        organization_id: None,
        identity_generation: "initial-handshake".into(),
        target_revision: "source-configuration".into(),
    })
}

fn copy_identity(source_root: &Path, target_root: &Path, source: &NativeIdentity) -> Result<()> {
    let namespace = source.guard.namespace_id();
    let marker = format!(".{namespace}.jsonl");
    std::fs::copy(source_root.join(&marker), target_root.join(&marker))?;
    PrivateDirectory::open_existing(target_root)?.create_private_child(OsStr::new(namespace))?;
    for name in [RECORD, LOCK, HEAD] {
        std::fs::copy(
            source_root.join(namespace).join(name),
            target_root.join(namespace).join(name),
        )?;
    }
    let placement = source_root.join(namespace).join(LOCK_PLACEMENT);
    if placement.exists() {
        std::fs::copy(placement, target_root.join(namespace).join(LOCK_PLACEMENT))?;
    }
    if source_root.join(".profile-identity.json").exists() {
        std::fs::copy(
            source_root.join(".profile-identity.json"),
            target_root.join(".profile-identity.json"),
        )?;
    }
    Ok(())
}

#[test]
fn relocation_preserves_logical_owner_epoch_and_exact_original_epoch_receipts() -> Result<()> {
    for disabled in [false, true] {
        let source_root = tempfile::tempdir()?;
        let target_root = tempfile::tempdir()?;
        let source_profile = PrivateDirectory::open_existing(source_root.path())?;
        let target_profile = PrivateDirectory::open_existing(target_root.path())?;
        let mut scope = global_scope(&source_profile)?;
        let source =
            NativeIdentity::initialize(&source_profile, &scope, "original-initialization")?;
        if disabled {
            source.disable(&source_profile, "original-revocation", 1, 1000)?;
        }
        let expected = source.snapshot(&source_profile)?;
        scope.identity_generation = expected.generation.clone();
        copy_identity(source_root.path(), target_root.path(), &source)?;
        assert!(NativeIdentity::observe(&target_profile, &scope).is_err());
        let record = read_anchored_bytes(&source.record_anchor)?;
        let head = read_anchored_bytes(&source.head_anchor)?;
        let target =
            source.relocate(&source_profile, &target_profile, &scope, "move", &expected)?;
        assert_eq!(target.header.owner, source.header.owner);
        assert_eq!(
            target.header.initial_generation,
            source.header.initial_generation
        );
        assert_eq!(
            target.header.initialization_operation,
            source.header.initialization_operation
        );
        assert_eq!(target.snapshot(&target_profile)?, expected);
        assert_eq!(source.snapshot(&source_profile)?, expected);
        assert_eq!(read_anchored_bytes(&target.record_anchor)?, record);
        assert_eq!(read_anchored_bytes(&target.head_anchor)?, head);
        assert_eq!(read_anchored_bytes(&source.record_anchor)?, record);
        assert_eq!(
            ProfileIdentity::observe(&target_profile)?.logical_seed(),
            source.logical_profile.logical_seed()
        );
        assert!(target.header == source.header);
        let first_placement = read_lock_placement(&target.directory)?.unwrap().bytes;
        assert!(first_placement.len() <= MAX_LOCK_PLACEMENT_BYTES as usize);
        let first_placement: serde_json::Value = serde_json::from_slice(&first_placement)?;
        assert_eq!(first_placement.as_object().unwrap().len(), 3);
        assert_eq!(first_placement["version"], 1);
        assert_eq!(first_placement["headerDigest"], hash(&source.header)?);
        assert_ne!(
            target.binding.profile_identity,
            source.binding.profile_identity
        );
        let third_root = tempfile::tempdir()?;
        let third_profile = PrivateDirectory::open_existing(third_root.path())?;
        copy_identity(target_root.path(), third_root.path(), &target)?;
        let seed_bytes = std::fs::read(target_root.path().join(".profile-identity.json"))?;
        let third = target.relocate(
            &target_profile,
            &third_profile,
            &scope,
            "move-again",
            &expected,
        )?;
        assert_eq!(read_anchored_bytes(&third.record_anchor)?, record);
        assert_eq!(read_anchored_bytes(&third.head_anchor)?, head);
        assert_eq!(
            std::fs::read(third_root.path().join(".profile-identity.json"))?,
            seed_bytes
        );
        assert_eq!(third.snapshot(&third_profile)?, expected);
        let second_placement = read_lock_placement(&third.directory)?.unwrap().bytes;
        assert!(second_placement.len() <= MAX_LOCK_PLACEMENT_BYTES as usize);
        let second_placement: serde_json::Value = serde_json::from_slice(&second_placement)?;
        assert_eq!(second_placement.as_object().unwrap().len(), 3);
        assert_eq!(second_placement["version"], first_placement["version"]);
        assert_eq!(
            second_placement["headerDigest"],
            first_placement["headerDigest"]
        );
        assert_ne!(
            second_placement["lockIdentity"],
            first_placement["lockIdentity"]
        );
        let original = std::fs::read(
            third_root
                .path()
                .join(third.guard.namespace_id())
                .join(LOCK_PLACEMENT),
        )?;
        third.directory.atomic_replace(OsStr::new(LOCK), b"")?;
        assert!(third.snapshot(&third_profile).is_err());
        assert!(NativeIdentity::observe(&third_profile, &scope).is_err());
        assert_eq!(
            std::fs::read(
                third_root
                    .path()
                    .join(third.guard.namespace_id())
                    .join(LOCK_PLACEMENT)
            )?,
            original
        );
    }
    Ok(())
}

#[test]
fn source_revoked_after_preflight_cannot_publish_an_older_enabled_target() -> Result<()> {
    let source_root = tempfile::tempdir()?;
    let target_root = tempfile::tempdir()?;
    let source_profile = PrivateDirectory::open_existing(source_root.path())?;
    let target_profile = PrivateDirectory::open_existing(target_root.path())?;
    let mut scope = global_scope(&source_profile)?;
    let source = NativeIdentity::initialize(&source_profile, &scope, "initialize")?;
    let expected = source.snapshot(&source_profile)?;
    scope.identity_generation = expected.generation.clone();
    copy_identity(source_root.path(), target_root.path(), &source)?;
    source.disable(&source_profile, "revoke-after-preflight", 1, 1000)?;
    let before = std::fs::read(
        target_root
            .path()
            .join(source.guard.namespace_id())
            .join(RECORD),
    )?;
    assert!(
        source
            .relocate(&source_profile, &target_profile, &scope, "move", &expected)
            .is_err()
    );
    assert_eq!(
        std::fs::read(
            target_root
                .path()
                .join(source.guard.namespace_id())
                .join(RECORD)
        )?,
        before
    );
    assert_eq!(std::fs::read_dir(target_root.path())?.count(), 2);
    assert!(!source.snapshot(&source_profile)?.enabled);
    Ok(())
}

#[test]
fn lost_ack_keeps_original_epoch_and_reconciliation_is_read_only() -> Result<()> {
    let source_root = tempfile::tempdir()?;
    let target_root = tempfile::tempdir()?;
    let source_profile = PrivateDirectory::open_existing(source_root.path())?;
    let target_profile = PrivateDirectory::open_existing(target_root.path())?;
    let mut scope = global_scope(&source_profile)?;
    let source = NativeIdentity::initialize(&source_profile, &scope, "initialize")?;
    let expected = source.snapshot(&source_profile)?;
    scope.identity_generation = expected.generation.clone();
    copy_identity(source_root.path(), target_root.path(), &source)?;
    source
        .lose_relocation_ack
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(
        source
            .relocate(
                &source_profile,
                &target_profile,
                &scope,
                "move-original",
                &expected
            )
            .unwrap_err()
            .to_string()
            .contains("UNCONFIRMED")
    );
    let target_directory =
        target_profile.open_child(OsStr::new(source.guard.namespace_id()), false)?;
    let bytes = std::fs::read(
        target_root
            .path()
            .join(source.guard.namespace_id())
            .join(RECORD),
    )?;
    let before = target_directory.regular_file_identity(OsStr::new(RECORD))?;
    let placement_before =
        target_directory.portable_regular_identity(OsStr::new(LOCK_PLACEMENT))?;
    let placement_bytes = read_lock_placement(&target_directory)?.unwrap().bytes;
    let reopened = NativeIdentity::observe(&source_profile, &scope)?.unwrap();
    let target = reopened.relocate(
        &source_profile,
        &target_profile,
        &scope,
        "move-original",
        &expected,
    )?;
    assert_eq!(target.snapshot(&target_profile)?, expected);
    assert_eq!(
        std::fs::read(
            target_root
                .path()
                .join(source.guard.namespace_id())
                .join(RECORD)
        )?,
        bytes
    );
    assert_eq!(
        target_directory.regular_file_identity(OsStr::new(RECORD))?,
        before
    );
    assert_eq!(
        target_directory.portable_regular_identity(OsStr::new(LOCK_PLACEMENT))?,
        placement_before
    );
    assert_eq!(
        read_lock_placement(&target_directory)?.unwrap().bytes,
        placement_bytes
    );
    // Operation admission belongs to the existing coordinator, not the epoch file.
    Ok(())
}

#[test]
fn an_actual_source_identity_lease_prevents_mapping_and_conversion() -> Result<()> {
    let source_root = tempfile::tempdir()?;
    let target_root = tempfile::tempdir()?;
    let source_profile = PrivateDirectory::open_existing(source_root.path())?;
    let target_profile = PrivateDirectory::open_existing(target_root.path())?;
    let mut scope = global_scope(&source_profile)?;
    let source = NativeIdentity::initialize(&source_profile, &scope, "initialize")?;
    let expected = source.snapshot(&source_profile)?;
    scope.identity_generation = expected.generation.clone();
    copy_identity(source_root.path(), target_root.path(), &source)?;
    let lease = source
        .directory
        .try_existing_portable_lock(
            OsStr::new(LOCK),
            &source.header.lock_identity,
            PrivateLeaseMode::Shared,
        )?
        .unwrap();
    assert!(
        source
            .relocate(&source_profile, &target_profile, &scope, "move", &expected)
            .is_err()
    );
    assert_eq!(std::fs::read_dir(target_root.path())?.count(), 2);
    drop(lease);
    source.snapshot(&source_profile)?;
    Ok(())
}

#[test]
fn warm_observers_reject_added_replaced_or_changed_lock_placements() -> Result<()> {
    let source_root = tempfile::tempdir()?;
    let target_root = tempfile::tempdir()?;
    let source_profile = PrivateDirectory::open_existing(source_root.path())?;
    let target_profile = PrivateDirectory::open_existing(target_root.path())?;
    let mut scope = global_scope(&source_profile)?;
    let source = NativeIdentity::initialize(&source_profile, &scope, "initialize")?;
    let expected = source.snapshot(&source_profile)?;
    scope.identity_generation = expected.generation.clone();
    copy_identity(source_root.path(), target_root.path(), &source)?;
    let target = source.relocate(&source_profile, &target_profile, &scope, "move", &expected)?;
    let bytes = read_lock_placement(&target.directory)?.unwrap().bytes;

    source
        .directory
        .atomic_replace(OsStr::new(LOCK_PLACEMENT), &bytes)?;
    assert!(source.snapshot(&source_profile).is_err());
    assert!(NativeIdentity::observe(&source_profile, &scope).is_err());

    target
        .directory
        .atomic_replace(OsStr::new(LOCK_PLACEMENT), &bytes)?;
    assert!(target.snapshot(&target_profile).is_err());
    let current = NativeIdentity::observe(&target_profile, &scope)?.unwrap();
    assert_eq!(current.snapshot(&target_profile)?, expected);
    let placement_path = target_root
        .path()
        .join(target.guard.namespace_id())
        .join(LOCK_PLACEMENT);
    for mutation in ["header", "version", "oversized", "missing"] {
        if mutation == "missing" {
            std::fs::remove_file(&placement_path)?;
        } else {
            let altered = match mutation {
                "oversized" => vec![b' '; MAX_LOCK_PLACEMENT_BYTES as usize + 1],
                _ => {
                    let mut value: serde_json::Value = serde_json::from_slice(&bytes)?;
                    if mutation == "header" {
                        value["headerDigest"] = "0".repeat(64).into();
                    } else {
                        value["version"] = 2.into();
                    }
                    serde_json::to_vec(&value)?
                }
            };
            std::fs::write(&placement_path, altered)?;
        }
        assert!(current.snapshot(&target_profile).is_err());
        assert!(NativeIdentity::observe(&target_profile, &scope).is_err());
    }
    Ok(())
}

#[test]
fn offline_lock_placement_never_overwrites_unknown_target_facts() -> Result<()> {
    let source_root = tempfile::tempdir()?;
    let target_root = tempfile::tempdir()?;
    let source_profile = PrivateDirectory::open_existing(source_root.path())?;
    let target_profile = PrivateDirectory::open_existing(target_root.path())?;
    let mut scope = global_scope(&source_profile)?;
    let source = NativeIdentity::initialize(&source_profile, &scope, "initialize")?;
    let expected = source.snapshot(&source_profile)?;
    scope.identity_generation = expected.generation.clone();
    copy_identity(source_root.path(), target_root.path(), &source)?;
    let target_directory =
        target_profile.open_child(OsStr::new(source.guard.namespace_id()), false)?;
    let unknown = b"{unregistered-placement}";
    target_directory.atomic_replace(OsStr::new(LOCK_PLACEMENT), unknown)?;
    let identity = target_directory.portable_regular_identity(OsStr::new(LOCK_PLACEMENT))?;
    assert!(
        source
            .relocate(&source_profile, &target_profile, &scope, "move", &expected)
            .is_err()
    );
    assert_eq!(
        read_lock_placement(&target_directory)?.unwrap().bytes,
        unknown
    );
    assert_eq!(
        target_directory.portable_regular_identity(OsStr::new(LOCK_PLACEMENT))?,
        identity
    );
    assert_eq!(source.snapshot(&source_profile)?, expected);
    Ok(())
}

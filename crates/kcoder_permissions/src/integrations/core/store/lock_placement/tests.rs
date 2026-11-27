use super::*;
use crate::core::store::tests::{params, policy, scope, subject};
use kcoder_config::storage::{StorageResolveInput, resolve_storage_paths};
use kcoder_types::{
    STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLaunchIntent, StorageLocationRecord,
    StorageMigrationComponent, StorageMigrationPhase as Phase, StorageMigrationPlan,
    StorageTargetBinding,
};
use std::path::Path;

fn publish(
    root: &Path,
    source: &Path,
    target: &Path,
    operation: &str,
) -> Result<(StorageCoordinator, StoragePublishedComponent)> {
    let home = root.join(format!("control-{operation}"));
    PrivateDirectory::open_existing(root)?.create_private_child(home.file_name().unwrap())?;
    let mut owner = StorageCoordinator::acquire(&home)?;
    owner.begin(StorageMigrationPlan {
        version: 1,
        operation_id: operation.into(),
        original: None,
        from: resolve_storage_paths(&StorageResolveInput {
            home: Some(home),
            ..Default::default()
        })?,
        target: StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: target.into(),
            cache_root: root.join(format!("cache-{operation}")),
            operation_id: Some(operation.into()),
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
            existing_ancestor: root.into(),
            ancestor_identity: PrivateDirectory::open_existing(root)?.directory_identity()?,
        }],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    })?;
    owner.advance(operation, Phase::Planned, Phase::Stopping)?;
    owner.advance(operation, Phase::Stopping, Phase::Stopped)?;
    owner.advance(operation, Phase::Stopped, Phase::Copying)?;
    owner.publish_component(
        operation,
        STORAGE_PERSISTENT_ROOT_DOMAIN,
        &Default::default(),
    )?;
    let published = owner.open_published_component(operation, STORAGE_PERSISTENT_ROOT_DOMAIN)?;
    Ok((owner, published))
}

fn finish(owner: &mut StorageCoordinator, published: &StoragePublishedComponent) -> Result<()> {
    let operation = published.operation_id();
    owner.advance(operation, Phase::Copying, Phase::Verifying)?;
    owner.advance(operation, Phase::Verifying, Phase::Prepared)?;
    owner.commit(operation)?;
    owner.complete(operation)?;
    Ok(())
}

fn fixture(root: &Path) -> Result<NativeDelegationAuthority> {
    let source =
        PrivateDirectory::open_existing(root)?.create_private_child(OsStr::new("source"))?;
    let namespace = source.create_private_child(OsStr::new("policy-domain"))?;
    NativeDelegationAuthority::create_in(&namespace, OsStr::new("issuer"), &scope())
}

fn root() -> Result<tempfile::TempDir> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    Ok(root)
}

#[test]
fn stopped_lock_placement_twice_preserves_original_genesis_signatures_and_revocations() -> Result<()>
{
    let root = root()?;
    let source = fixture(root.path())?;
    let (issued, proof) =
        source.issue("original-operation", &params(), &subject(), &policy(), 100)?;
    let (revoked, revoked_proof) =
        source.issue("to-revoke", &params(), &subject(), &policy(), 101)?;
    source.revoke("revoke-original", &revoked.delegation_ref.id, "1", 102)?;
    let original = [BINDING_FILE, KEY_FILE, JOURNAL_FILE, HEAD_FILE]
        .map(|name| read_file(&source.directory, name, MAX_JOURNAL_BYTES).unwrap());
    let namespace = OsStr::new("policy-domain");
    let mut stores = vec![source];
    for (index, (from, to)) in [("source", "first"), ("first", "second")]
        .into_iter()
        .enumerate()
    {
        let previous = &stores[index];
        let (mut owner, published) = publish(
            root.path(),
            &root.path().join(from),
            &root.path().join(to),
            to,
        )?;
        assert!(
            previous
                .verify_lock_relocation(&published, namespace)
                .is_err()
        );
        let parent = published
            .directory()
            .open_entry_handle(namespace)?
            .open_child_directory()?;
        assert!(
            NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).is_err()
        );
        previous.relocate_lock(&mut owner, &published, namespace)?;
        let cold = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
        let placement = read(&cold.directory)?.unwrap();
        assert!(placement.bytes.len() <= MAX_BYTES);
        let shape: serde_json::Value = serde_json::from_slice(&placement.bytes)?;
        assert_eq!(shape.as_object().unwrap().len(), 3);
        assert_eq!(shape["bindingDigest"], binding_digest(&stores[0].binding)?);
        assert_eq!(
            shape["lockIdentity"],
            serde_json::to_value(&cold.lock_identity)?
        );
        previous.relocate_lock(&mut owner, &published, namespace)?;
        previous.verify_lock_relocation(&published, namespace)?;
        verify(&cold.directory, Some(&placement))?;
        // Reconcile the original issue after a lost response, without reissuing
        // or extending the signed proof, and retain durable revocation.
        let (reconciled, retained_proof) =
            cold.issue("original-operation", &params(), &subject(), &policy(), 200)?;
        assert_eq!(reconciled, issued);
        assert_eq!(
            retained_proof.to_private_bytes()?,
            proof.to_private_bytes()?
        );
        assert_eq!(
            cold.read(&revoked.delegation_ref.id, 200)?.unwrap().status,
            IntegrationDelegationStatus::Revoked
        );
        assert_eq!(
            cold.read(&issued.delegation_ref.id, 200)?.unwrap().status,
            IntegrationDelegationStatus::Active
        );
        cold.authorize(
            &proof,
            &policy(),
            &subject(),
            IntegrationDelegationAction::ReadTask,
            &policy().resource_refs,
            200,
        )?;
        assert!(
            cold.authorize(
                &revoked_proof,
                &policy(),
                &subject(),
                IntegrationDelegationAction::ReadTask,
                &policy().resource_refs,
                200,
            )
            .is_err()
        );
        for (name, expected) in [BINDING_FILE, KEY_FILE, JOURNAL_FILE, HEAD_FILE]
            .iter()
            .zip(&original)
        {
            assert_eq!(
                read_file(&cold.directory, name, MAX_JOURNAL_BYTES)?,
                *expected
            );
        }
        finish(&mut owner, &published)?;
        stores.push(cold);
    }
    // Ordinary post-move compaction must keep using the current held journal,
    // while signed genesis and original grant proofs retain their old bytes.
    let final_store = stores.last().unwrap();
    assert_ne!(
        final_store.journal_identity,
        final_store.binding.journal_identity
    );
    final_store.compact()?;
    let (_, retained_proof) =
        final_store.issue("original-operation", &params(), &subject(), &policy(), 201)?;
    assert_eq!(
        retained_proof.to_private_bytes()?,
        proof.to_private_bytes()?
    );
    assert_eq!(
        final_store
            .read(&revoked.delegation_ref.id, 201)?
            .unwrap()
            .status,
        IntegrationDelegationStatus::Revoked
    );
    for (name, expected) in [BINDING_FILE, KEY_FILE].iter().zip(&original[..2]) {
        assert_eq!(
            read_file(&final_store.directory, name, MAX_JOURNAL_BYTES)?,
            *expected
        );
    }
    for (name, expected) in [BINDING_FILE, KEY_FILE, JOURNAL_FILE, HEAD_FILE]
        .iter()
        .zip(&original)
    {
        assert_eq!(
            read_file(&stores[0].directory, name, MAX_JOURNAL_BYTES)?,
            *expected
        );
    }
    Ok(())
}

#[test]
fn both_writer_locks_and_unknown_placement_block_conversion_without_overwrite() -> Result<()> {
    let root = root()?;
    let source = fixture(root.path())?;
    let namespace = OsStr::new("policy-domain");
    let (mut owner, published) = publish(
        root.path(),
        &root.path().join("source"),
        &root.path().join("target"),
        "move",
    )?;
    let target = published
        .directory()
        .open_entry_handle(namespace)?
        .open_child_directory()?
        .open_entry_handle(OsStr::new("issuer"))?
        .open_child_directory()?;
    let held = source.lock(PrivateLeaseMode::Exclusive)?;
    assert!(
        source
            .relocate_lock(&mut owner, &published, namespace)
            .is_err()
    );
    drop(held);
    let held = target
        .try_existing_portable_lock(
            OsStr::new(LOCK_FILE),
            &target.portable_regular_identity(OsStr::new(LOCK_FILE))?,
            PrivateLeaseMode::Exclusive,
        )?
        .unwrap();
    assert!(
        source
            .relocate_lock(&mut owner, &published, namespace)
            .is_err()
    );
    drop(held);
    assert!(read(&target)?.is_none());
    let unknown = b"{unknown-placement}";
    target.atomic_replace(OsStr::new(FILE), unknown)?;
    assert!(
        source
            .relocate_lock(&mut owner, &published, namespace)
            .is_err()
    );
    assert!(
        source
            .verify_lock_relocation(&published, namespace)
            .is_err()
    );
    assert_eq!(read(&target)?.unwrap().bytes, unknown);
    Ok(())
}

#[test]
fn cold_open_rejects_a_second_lock_while_original_writer_is_still_locked() -> Result<()> {
    let root = root()?;
    let source = fixture(root.path())?;
    let held = source.lock(PrivateLeaseMode::Exclusive)?;
    let directory = root.path().join("source/policy-domain/issuer");
    std::fs::rename(
        directory.join(LOCK_FILE),
        directory.join("retained-original-lock"),
    )?;
    source
        .directory
        .open_read_write_file(OsStr::new(LOCK_FILE), true)?;
    let parent = PrivateDirectory::open_existing(&root.path().join("source/policy-domain"))?;
    assert!(NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).is_err());
    assert!(source.verify_storage().is_err());
    drop(held);
    Ok(())
}

#[test]
fn relocated_cold_open_preserves_the_same_l1_l2_exclusion() -> Result<()> {
    let root = root()?;
    let source = fixture(root.path())?;
    let namespace = OsStr::new("policy-domain");
    let (mut owner, published) = publish(
        root.path(),
        &root.path().join("source"),
        &root.path().join("target"),
        "move",
    )?;
    source.relocate_lock(&mut owner, &published, namespace)?;
    let parent = published
        .directory()
        .open_entry_handle(namespace)?
        .open_child_directory()?;
    let cold = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
    let held = cold.lock(PrivateLeaseMode::Exclusive)?;
    let directory = root.path().join("target/policy-domain/issuer");
    std::fs::rename(
        directory.join(LOCK_FILE),
        directory.join("retained-original-lock"),
    )?;
    cold.directory
        .open_read_write_file(OsStr::new(LOCK_FILE), true)?;
    assert!(NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).is_err());
    assert!(cold.verify_storage().is_err());
    drop(held);
    Ok(())
}

#[test]
fn live_authorities_reject_added_replaced_or_missing_current_placements() -> Result<()> {
    let root = root()?;
    let source = fixture(root.path())?;
    let namespace = OsStr::new("policy-domain");
    let (mut owner, published) = publish(
        root.path(),
        &root.path().join("source"),
        &root.path().join("target"),
        "move",
    )?;
    source.relocate_lock(&mut owner, &published, namespace)?;
    let parent = published
        .directory()
        .open_entry_handle(namespace)?
        .open_child_directory()?;
    let cold = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
    let placement = read(&cold.directory)?.unwrap();
    cold.directory
        .atomic_replace(OsStr::new(FILE), &placement.bytes)?;
    assert!(cold.verify_storage().is_err());
    let cold = NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope())?;
    std::fs::remove_file(root.path().join("target/policy-domain/issuer").join(FILE))?;
    assert!(cold.verify_storage().is_err());
    assert!(NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).is_err());
    source.directory.atomic_replace(
        OsStr::new(FILE),
        &serde_json::to_vec(&Placement {
            version: 1,
            binding_digest: binding_digest(&source.binding)?,
            lock_identity: source.lock_identity.clone(),
        })?,
    )?;
    assert!(source.verify_storage().is_err());
    Ok(())
}

#[test]
fn cold_placement_requires_original_genesis_supported_version_and_bounded_input() -> Result<()> {
    let root = root()?;
    let source = fixture(root.path())?;
    let parent = PrivateDirectory::open_existing(&root.path().join("source/policy-domain"))?;
    for (version, genesis) in [(2, binding_digest(&source.binding)?), (1, "a".repeat(64))] {
        let bytes = serde_json::to_vec(&Placement {
            version,
            binding_digest: genesis,
            lock_identity: source.lock_identity.clone(),
        })?;
        source.directory.atomic_replace(OsStr::new(FILE), &bytes)?;
        assert!(
            NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).is_err()
        );
        assert_eq!(read(&source.directory)?.unwrap().bytes, bytes);
    }
    let oversized = vec![b' '; MAX_BYTES + 1];
    source
        .directory
        .atomic_replace(OsStr::new(FILE), &oversized)?;
    assert!(NativeDelegationAuthority::open_in(&parent, OsStr::new("issuer"), &scope()).is_err());
    assert_eq!(
        std::fs::read(root.path().join("source/policy-domain/issuer").join(FILE))?,
        oversized
    );
    Ok(())
}

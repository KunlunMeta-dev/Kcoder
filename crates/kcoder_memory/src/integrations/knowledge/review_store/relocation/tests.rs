use super::*;
use crate::integrations::knowledge::review_store::tests::{fixture_root, proposal, scope};
use kcoder_config::storage::{StorageResolveInput, resolve_storage_paths};
use kcoder_types::integrations::knowledge::MemoryOrigin;
use kcoder_types::{
    STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLaunchIntent, StorageLocationRecord,
    StorageMigrationComponent, StorageMigrationPhase as Phase, StorageMigrationPlan,
    StorageTargetBinding,
};

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

fn fixture(root: &Path) -> Result<MemoryReviewStore> {
    let source =
        PrivateDirectory::open_existing(root)?.create_private_child(OsStr::new("source"))?;
    let namespace = source.create_private_child(OsStr::new("memory-domain"))?;
    MemoryReviewStore::create_in(&namespace, OsStr::new("data"), &scope("alice"))
}

#[test]
fn stopped_lock_placement_twice_keeps_receipts_and_frozen_snapshot_bytes() -> Result<()> {
    let root = fixture_root()?;
    let source = fixture(root.path())?;
    let candidate = source.propose("original", proposal(MemoryOrigin::Manual), 1)?;
    source.review(
        "review",
        &candidate.id,
        1,
        MemoryReview::Accept {
            edited_content: None,
        },
        2,
    )?;
    let frozen = source.capture_task_snapshot("accepted-turn", 3)?;
    source
        .ack_loss
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(
        source
            .edit("unknown-edit", &candidate.id, 2, "Keep receipt".into(), 4)
            .is_err()
    );
    let original = std::fs::read(root.path().join("source/memory-domain/data").join(FILE))?;
    let namespace = OsStr::new("memory-domain");
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
        assert!(MemoryReviewStore::open_in(&parent, OsStr::new("data"), &scope("alice")).is_err());
        previous.relocate_lock(&mut owner, &published, namespace)?;
        let current = MemoryReviewStore::open_in(&parent, OsStr::new("data"), &scope("alice"))?;
        let binding_identity = current.binding_identity.clone();
        previous.relocate_lock(&mut owner, &published, namespace)?;
        previous.verify_lock_relocation(&published, namespace)?;
        assert_eq!(
            current
                .directory
                .portable_regular_identity(OsStr::new("memory-binding.json"))?,
            binding_identity
        );
        assert_eq!(
            current.read_task_snapshot("accepted-turn")?,
            Some(frozen.clone())
        );
        assert_eq!(
            current.read_operation_result("original")?,
            Some(candidate.clone())
        );
        let edited = current.read_operation_result("unknown-edit")?.unwrap();
        assert_eq!(edited.proposal.content, "Keep receipt");
        assert_eq!(current.read(&candidate.id)?, edited);
        assert_eq!(
            std::fs::read(root.path().join(to).join("memory-domain/data").join(FILE))?,
            original
        );
        assert_eq!(
            std::fs::read_dir(root.path().join(to).join("memory-domain/data"))?.count(),
            3
        );
        finish(&mut owner, &published)?;
        stores.push(current);
    }
    assert_eq!(
        std::fs::read(root.path().join("source/memory-domain/data").join(FILE))?,
        original
    );
    Ok(())
}

#[test]
fn both_actual_writer_locks_and_unknown_target_bindings_block_placement() -> Result<()> {
    let root = fixture_root()?;
    let source = fixture(root.path())?;
    let namespace = OsStr::new("memory-domain");
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
        .open_entry_handle(OsStr::new("data"))?
        .open_child_directory()?;
    let original: StoreBinding = read_private_json(&target, "memory-binding.json", 16 * 1024)?;
    let held = source
        .directory
        .try_existing_portable_lock(
            OsStr::new(LOCK),
            &source.binding.lock_identity,
            PrivateLeaseMode::Exclusive,
        )?
        .unwrap();
    assert!(
        source
            .relocate_lock(&mut owner, &published, namespace)
            .is_err()
    );
    drop(held);
    let held = target
        .try_existing_portable_lock(
            OsStr::new(LOCK),
            &target.portable_regular_identity(OsStr::new(LOCK))?,
            PrivateLeaseMode::Exclusive,
        )?
        .unwrap();
    assert!(
        source
            .relocate_lock(&mut owner, &published, namespace)
            .is_err()
    );
    drop(held);
    assert_eq!(
        read_private_json::<StoreBinding>(&target, "memory-binding.json", 16 * 1024)?,
        original
    );
    let mut unknown = original;
    unknown.owner = KnowledgeOwner::from(&scope("another-owner"));
    let unknown = serde_json::to_vec(&unknown)?;
    target.atomic_replace(OsStr::new("memory-binding.json"), &unknown)?;
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
    assert_eq!(
        std::fs::read(
            root.path()
                .join("target/memory-domain/data/memory-binding.json")
        )?,
        unknown
    );
    Ok(())
}

#[test]
fn cold_open_cannot_adopt_a_second_lock_while_original_writer_remains_locked() -> Result<()> {
    let root = fixture_root()?;
    let source = fixture(root.path())?;
    let held = source
        .directory
        .try_existing_portable_lock(
            OsStr::new(LOCK),
            &source.binding.lock_identity,
            PrivateLeaseMode::Exclusive,
        )?
        .unwrap();
    let path = root.path().join("source/memory-domain/data");
    std::fs::rename(path.join(LOCK), path.join("retained-original-lock"))?;
    source
        .directory
        .open_read_write_file(OsStr::new(LOCK), true)?;
    assert!(MemoryReviewStore::open(&path, &scope("alice")).is_err());
    assert!(source.verify_binding().is_err());
    drop(held);
    Ok(())
}

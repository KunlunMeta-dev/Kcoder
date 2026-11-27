use super::*;

#[tokio::test]
async fn managed_worktree_profile_original_operation_reconciles_lost_ack_and_rejects_missing_journal()
 {
    let fixture = Fixture::new();
    fixture.dirty();
    let operation = "managed-original-operation";
    let (mut coordinator, control) =
        copying_fixture(&fixture.root, &fixture.source, &fixture.target, operation);
    let before_copy = profile_relocation_snapshots(&fixture.source, &fixture.target)
        .await
        .unwrap();
    assert_eq!(before_copy.len(), 1);
    coordinator
        .publish_component(
            operation,
            kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN,
            &Default::default(),
        )
        .unwrap();
    let published = coordinator
        .open_published_component(operation, kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN)
        .unwrap();
    // Publication without a mutation receipt still has the original source Git
    // registration and raw target bytes, so a first capture remains possible.
    let owners = profile_relocation_snapshots_for_operation(
        &fixture.source,
        &fixture.target,
        operation,
        &control,
        &published,
    )
    .await
    .unwrap();
    assert_eq!(owners[0].snapshot, before_copy[0].snapshot);
    drop(before_copy);
    let owner = &owners[0];
    let transformed = owner
        .source_store
        .target_bytes(&owner.target_store, &owner.snapshot)
        .unwrap();
    let mut receipt = prepare_receipt(
        &owner.target_store,
        operation,
        &control,
        &owner.snapshot,
        &transformed,
    )
    .await
    .unwrap();
    write_receipt(&control, &receipt).unwrap();
    let git = owner.snapshot.entries[0].git.as_ref().unwrap().clone();
    let target_path = owner.snapshot.entries[0].target.clone();
    // Simulate a process exit after the original Git CAS and before the registry
    // CAS. The target registry still contains the untouched coordinator copy.
    replace_owned(
        &control,
        &mut receipt,
        0,
        &gitdir_replacement(&target_path).unwrap(),
    )
    .unwrap();
    let registration = read_path(&git.admin.join("gitdir")).unwrap();
    let target_registry = read_path(&owner.target_store.state_path).unwrap();
    let journal_name = receipt_name(&owner.snapshot.source_registry);
    let original_journal = read_leaf(&control, OsStr::new(&journal_name)).unwrap();
    drop(receipt);
    drop(owners);

    assert!(
        fixture
            .store
            .relocation_snapshot(&fixture.source, &fixture.target)
            .await
            .is_err()
    );
    let resumed = profile_relocation_snapshots_for_operation(
        &fixture.source,
        &fixture.target,
        operation,
        &control,
        &published,
    )
    .await
    .unwrap();
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].snapshot.entries[0].worktree_id, "task-a");
    assert_eq!(resumed[0].snapshot.entries[0].revision, 7);
    assert_eq!(
        read_leaf(&control, OsStr::new(&journal_name)).unwrap(),
        original_journal
    );
    assert_eq!(read_path(&git.admin.join("gitdir")).unwrap(), registration);
    assert_eq!(
        read_path(&resumed[0].target_store.state_path).unwrap(),
        target_registry
    );
    drop(resumed);

    // The source JSON is not its own authority: keep the actual registry stamp,
    // operation and control identity while substituting another worktree ID.
    control
        .rename_no_replace(
            OsStr::new(&journal_name),
            OsStr::new("test-retained-original-journal"),
        )
        .unwrap();
    let mut forged: Value = serde_json::from_slice(&original_journal.0).unwrap();
    forged["source"]["entries"][0]["worktreeId"] = json!("unregistered-worktree");
    control
        .atomic_replace(
            OsStr::new(&journal_name),
            &serde_json::to_vec(&forged).unwrap(),
        )
        .unwrap();
    let forged_journal = read_leaf(&control, OsStr::new(&journal_name)).unwrap();
    assert!(
        profile_relocation_snapshots_for_operation(
            &fixture.source,
            &fixture.target,
            operation,
            &control,
            &published,
        )
        .await
        .err()
        .unwrap()
        .to_string()
        .contains("unsettled")
    );
    assert_eq!(
        read_leaf(&control, OsStr::new(&journal_name)).unwrap(),
        forged_journal
    );
    control
        .rename_no_replace(
            OsStr::new(&journal_name),
            OsStr::new("test-retained-forged-journal"),
        )
        .unwrap();
    // A missing original journal after external CAS must not capture a new
    // source, create a new journal, or reissue the Git change.
    assert!(
        profile_relocation_snapshots_for_operation(
            &fixture.source,
            &fixture.target,
            operation,
            &control,
            &published,
        )
        .await
        .err()
        .unwrap()
        .to_string()
        .contains("unsettled")
    );
    assert!(read_optional(&control, &journal_name).unwrap().is_none());
    assert_eq!(read_path(&git.admin.join("gitdir")).unwrap(), registration);
    assert_eq!(
        read_path(&fixture.target_store().state_path).unwrap(),
        target_registry
    );
    assert_eq!(
        read_leaf(&control, OsStr::new("test-retained-original-journal")).unwrap(),
        original_journal
    );

    control
        .rename_no_replace(
            OsStr::new("test-retained-original-journal"),
            OsStr::new(&journal_name),
        )
        .unwrap();
    let resumed = profile_relocation_snapshots_for_operation(
        &fixture.source,
        &fixture.target,
        operation,
        &control,
        &published,
    )
    .await
    .unwrap();
    let owner = &resumed[0];
    let completed = owner
        .source_store
        .relocate(
            &owner.target_store,
            operation,
            &control,
            &owner.snapshot,
            &published,
        )
        .await
        .unwrap();
    assert_eq!(completed.workspace_facts().len(), 1);
    completed.workspace_facts()[0].verify().unwrap();
    assert_eq!(read_path(&git.admin.join("gitdir")).unwrap(), registration);
    let completed_journal = read_leaf(&control, OsStr::new(&journal_name)).unwrap();
    drop(completed);
    drop(resumed);
    let resumed = profile_relocation_snapshots_for_operation(
        &fixture.source,
        &fixture.target,
        operation,
        &control,
        &published,
    )
    .await
    .unwrap();
    let owner = &resumed[0];
    owner
        .source_store
        .verify_relocation(
            &owner.target_store,
            operation,
            &control,
            &owner.snapshot,
            &published,
        )
        .await
        .unwrap();
    assert_eq!(
        read_leaf(&control, OsStr::new(&journal_name)).unwrap(),
        completed_journal
    );
    assert_eq!(read_path(&git.admin.join("gitdir")).unwrap(), registration);
}

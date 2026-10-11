fn metadata_journal_patch(engine: &QueryEngine, mut patch: Value) -> ThreadMetadataUpdateParams {
    patch["threadId"] = json!(engine.session_id());
    serde_json::from_value(patch).unwrap()
}

// Legacy fixture setup uses the same guarded writer without changing its call sites.
fn write_test_thread_metadata(directory: &Path, metadata: &ThreadClientMetadata) -> Result<()> {
    use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
    let root = directory
        .parent()
        .context("metadata fixture directory has no parent")?;
    let mut fence = JournalFence::try_acquire(root, JournalDomain::ClientMetadata)?;
    super::write_thread_metadata(directory, metadata, &mut fence)
}

#[test]
fn client_metadata_journal_invalidates_changes_but_not_noops() {
    use kcoder_state::history_index::journal::{JournalDomain, JournalFence, changes_since};
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    update_thread_metadata(
        &engine,
        metadata_journal_patch(&engine, json!({"title":"original"})),
        &HashSet::new(),
        true,
    )
    .unwrap();
    let root = engine.client_storage_root();
    let mut fence = JournalFence::try_acquire(&root, JournalDomain::ClientMetadata).unwrap();
    let mut watermark = fence.activate().unwrap();
    drop(fence);
    for patch in [
        json!({"title":"renamed"}),
        json!({"model":"fixture-model"}),
        json!({"archivedAt":"2026-09-12T00:00:00Z"}),
        json!({"parent":null}),
    ] {
        let before = read_thread_metadata(&engine, &engine.session_id())
            .unwrap()
            .unwrap();
        update_thread_metadata(
            &engine,
            metadata_journal_patch(&engine, patch.clone()),
            &HashSet::new(),
            true,
        )
        .unwrap();
        let changes = changes_since(&root, JournalDomain::ClientMetadata, &watermark, 10)
            .unwrap()
            .unwrap();
        assert_eq!(changes.session_ids, vec![engine.session_id()], "{patch}");
        assert_ne!(changes.watermark, watermark);
        watermark = changes.watermark;
        let committed = read_thread_metadata(&engine, &engine.session_id())
            .unwrap()
            .unwrap();
        assert_eq!(committed.revision, before.revision + 1);
        update_thread_metadata(
            &engine,
            metadata_journal_patch(&engine, patch),
            &HashSet::new(),
            true,
        )
        .unwrap();
        let unchanged = changes_since(&root, JournalDomain::ClientMetadata, &watermark, 10)
            .unwrap()
            .unwrap();
        assert!(unchanged.session_ids.is_empty());
        assert_eq!(unchanged.watermark, watermark);
        assert_eq!(
            read_thread_metadata(&engine, &engine.session_id())
                .unwrap()
                .unwrap()
                .revision,
            committed.revision
        );
        assert!(JournalFence::try_acquire(&root, JournalDomain::ClientMetadata).is_ok());
    }
}

#[test]
fn client_metadata_journal_fence_precedes_metadata_read() {
    use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let directory = ensure_thread_metadata_directory(&engine, &engine.session_id()).unwrap();
    let fence =
        JournalFence::try_acquire(&engine.client_storage_root(), JournalDomain::ClientMetadata)
            .unwrap();
    std::fs::write(directory.join(THREAD_METADATA_FILE), b"{malformed").unwrap();
    let error = update_thread_metadata(
        &engine,
        metadata_journal_patch(&engine, json!({"title":"must not write"})),
        &HashSet::new(),
        true,
    )
    .unwrap_err();
    assert!(
        format!("{error:#}").contains("journal mutation fence is busy"),
        "metadata must not be read before acquiring its domain fence: {error:#}"
    );
    assert_eq!(
        std::fs::read(directory.join(THREAD_METADATA_FILE)).unwrap(),
        b"{malformed"
    );
    drop(fence);
}

#[test]
fn client_metadata_journal_missing_token_keeps_untracked_compatibility() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    update_thread_metadata(
        &engine,
        metadata_journal_patch(&engine, json!({"title":"untracked"})),
        &HashSet::new(),
        true,
    )
    .unwrap();
    let metadata = read_thread_metadata(&engine, &engine.session_id())
        .unwrap()
        .unwrap();
    assert_eq!(
        metadata.fields.get("title"),
        Some(&Some("untracked".into()))
    );
    assert_eq!(metadata.revision, 1);
    assert!(
        !engine
            .client_storage_root()
            .join(".kcoder-client-metadata-tracking.json")
            .exists()
    );
}

#[test]
fn thread_metadata_workspace_comparison_is_form_insensitive() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let thread_id = engine.session_id().clone();
    let storage = super::ensure_thread_metadata_directory(&engine, &thread_id).unwrap();
    // Older builds stamped the workspace in a non-canonical form (the Windows
    // verbatim-prefix migration produced exactly this class of drift); a plain
    // string comparison then rejected every legacy thread as foreign.
    let stale_form = format!("{}/.", workspace.path().display());
    let metadata = ThreadClientMetadata {
        version: 1,
        revision: 1,
        thread_id: thread_id.clone(),
        workspace: stale_form.clone(),
        fields: BTreeMap::new(),
        updated_at: "0".to_string(),
    };
    write_test_thread_metadata(&storage, &metadata).unwrap();
    let read = read_thread_metadata(&engine, &thread_id)
        .expect("a stale workspace form must be accepted")
        .expect("metadata exists");
    assert_eq!(read.workspace, stale_form);
}

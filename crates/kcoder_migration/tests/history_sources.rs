use kcoder_migration::history_sources::HistorySourceBinding;
use kcoder_state::external_history::ExternalHistoryStore;
use kcoder_types::{external_history::*, migration::MigrationSourceKind};
use std::{io::Write, path::Path};

fn origin(source: MigrationSourceKind) -> ExternalHistoryOrigin {
    ExternalHistoryOrigin {
        source,
        source_artifact_id: None,
        source_instance: "fixture-account".into(),
        source_session_id: "foreign-id".into(),
        source_format: "synthetic-history/v1".into(),
        adapter_revision: "raw-foundation/1".into(),
        title: Some("Original title".into()),
        created_at: None,
        updated_at: None,
        project: None,
        archived: false,
        parent_session_id: None,
    }
}

#[test]
fn a_canonical_rollout_filename_is_required_to_claim_a_physical_source_id() {
    let from = tempfile::tempdir().unwrap();
    let stable = "11111111-1111-4111-8111-111111111111";
    let physical = "22222222-2222-4222-8222-222222222222";
    let name = format!("rollout-2026-10-16T12-30-00-{stable}_{physical}.jsonl");
    std::fs::write(from.path().join(&name), b"{}\n").unwrap();
    let mut valid = origin(MigrationSourceKind::Codex);
    valid.source_session_id = stable.into();
    let binding =
        HistorySourceBinding::capture(from.path(), Path::new(&name), valid.clone(), &mut |_, _| {
            true
        })
        .unwrap();
    assert_eq!(
        binding.snapshot().origin.source_artifact_id.as_deref(),
        Some(physical)
    );
    let mut wrong = valid.clone();
    wrong.source_session_id = physical.into();
    assert!(
        HistorySourceBinding::capture(from.path(), Path::new(&name), wrong, &mut |_, _| true)
            .is_err()
    );
    wrong = valid.clone();
    wrong.source_artifact_id = Some(stable.into());
    assert!(
        HistorySourceBinding::capture(from.path(), Path::new(&name), wrong, &mut |_, _| true)
            .is_err()
    );
    std::fs::write(from.path().join("export.jsonl"), b"{}\n").unwrap();
    let renamed = HistorySourceBinding::capture(
        from.path(),
        Path::new("export.jsonl"),
        valid.clone(),
        &mut |_, _| true,
    )
    .unwrap();
    assert!(renamed.snapshot().origin.source_artifact_id.is_none());
    valid.source_artifact_id = Some(physical.into());
    assert!(
        HistorySourceBinding::capture(
            from.path(),
            Path::new("export.jsonl"),
            valid.clone(),
            &mut |_, _| true
        )
        .is_err()
    );
    for name in [
        format!("rollout-2026-02-30T12-30-00-{stable}.jsonl"),
        format!("rollout-2026-10-16T12-30-60-{stable}.jsonl"),
    ] {
        std::fs::write(from.path().join(&name), b"{}\n").unwrap();
        assert!(
            HistorySourceBinding::capture(
                from.path(),
                Path::new(&name),
                valid.clone(),
                &mut |_, _| true
            )
            .is_err()
        );
    }
}

#[test]
fn selected_history_snapshot_freezes_growth_and_recovers_without_a_source() {
    for source in [MigrationSourceKind::Codex, MigrationSourceKind::ClaudeCode] {
        let from = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let path = from.path().join("selected.jsonl");
        let bytes = b"{\"user\":\"hello\"}\n{\"tool\":\"unknown result\"}\n";
        std::fs::write(&path, bytes).unwrap();
        let binding = HistorySourceBinding::capture(
            from.path(),
            Path::new("selected.jsonl"),
            origin(source),
            &mut |_, _| true,
        )
        .unwrap();
        let mut appended = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        appended
            .write_all(b"{\"newer\":\"not selected\"}\n")
            .unwrap();
        drop(appended);
        let binding: HistorySourceBinding =
            serde_json::from_slice(&serde_json::to_vec(&binding).unwrap()).unwrap();
        let store = ExternalHistoryStore::open(target.path()).unwrap();
        let receipt = binding
            .archive(&store, "explicit-request", &mut |_| true)
            .unwrap()
            .receipt;
        assert_eq!(receipt.source_bytes, bytes.len() as u64);
        let reader = store.reader(&receipt.archive_id).unwrap();
        assert_eq!(reader.records(0, 10).unwrap().total_records, 2);
        assert_eq!(
            reader.read_record_chunk(1, 0, 1024).unwrap(),
            b"{\"tool\":\"unknown result\"}\n"
        );
        std::fs::remove_file(&path).unwrap();
        let replay = binding
            .archive(&store, "explicit-request", &mut |_| true)
            .unwrap();
        assert_eq!(replay.receipt, receipt);
        assert!(replay.owns_archive);
    }
}

#[test]
fn a_mutated_prefix_or_replaced_file_invalidates_the_selected_snapshot() {
    for replacement in [false, true] {
        let from = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let path = from.path().join("selected.jsonl");
        std::fs::write(&path, b"original\n").unwrap();
        let binding = HistorySourceBinding::capture(
            from.path(),
            Path::new("selected.jsonl"),
            origin(MigrationSourceKind::Codex),
            &mut |_, _| true,
        )
        .unwrap();
        if replacement {
            std::fs::rename(&path, from.path().join("old.jsonl")).unwrap();
        }
        std::fs::write(
            &path,
            if replacement {
                b"original\n"
            } else {
                b"modified\n"
            },
        )
        .unwrap();
        let store = ExternalHistoryStore::open(target.path()).unwrap();
        assert!(binding.archive(&store, "selected", &mut |_| true).is_err());
        let import = store.begin("selected", binding.snapshot()).unwrap();
        assert!(
            store
                .reader(import.archive_id())
                .unwrap()
                .receipt()
                .unwrap()
                .is_none()
        );
        assert!(
            !target
                .path()
                .join("external-history")
                .join(import.archive_id())
                .join("source.bin")
                .exists()
        );
    }
}

#[test]
fn durable_staging_finishes_after_the_original_source_is_removed() {
    let from = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let path = from.path().join("selected.jsonl");
    let bytes = b"unrecognized but preserved\n";
    std::fs::write(&path, bytes).unwrap();
    let binding = HistorySourceBinding::capture(
        from.path(),
        Path::new("selected.jsonl"),
        origin(MigrationSourceKind::Codex),
        &mut |_, _| true,
    )
    .unwrap();
    let store = ExternalHistoryStore::open(target.path()).unwrap();
    let mut import = store
        .begin("lost-stage-receipt", binding.snapshot())
        .unwrap();
    let session = import.session_id().to_string();
    import.stage_source(&mut &bytes[..], &mut |_| true).unwrap();
    drop(import);
    std::fs::remove_file(&path).unwrap();
    let committed = binding
        .archive(&store, "lost-stage-receipt", &mut |_| true)
        .unwrap();
    assert_eq!(committed.receipt.session_id, session);
    assert_eq!(committed.receipt.record_count, 1);
}

#[test]
fn source_instance_identity_does_not_depend_only_on_a_display_label() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    for root in [first.path(), second.path()] {
        std::fs::write(root.join("selected.jsonl"), b"same\n").unwrap();
    }
    let capture = |root: &Path| {
        HistorySourceBinding::capture(
            root,
            Path::new("selected.jsonl"),
            origin(MigrationSourceKind::Codex),
            &mut |_, _| true,
        )
        .unwrap()
    };
    assert_ne!(
        capture(first.path()).snapshot().origin.source_instance,
        capture(second.path()).snapshot().origin.source_instance
    );
}

#[test]
fn history_selection_rejects_traversal_non_history_files_and_cancels_reads() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("selected.jsonl"), b"private fixture\n").unwrap();
    for path in [
        "../selected.jsonl",
        "/selected.jsonl",
        "auth.json",
        "config.toml",
        "",
    ] {
        assert!(
            HistorySourceBinding::capture(
                root.path(),
                Path::new(path),
                origin(MigrationSourceKind::Codex),
                &mut |_, _| true
            )
            .is_err()
        );
    }
    assert!(
        HistorySourceBinding::capture(
            root.path(),
            Path::new("selected.jsonl"),
            origin(MigrationSourceKind::Codex),
            &mut |_, _| false
        )
        .is_err()
    );
}

#[cfg(unix)]
#[test]
fn history_selection_rejects_link_aliases_without_changing_the_source() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let actual = outside.path().join("actual.jsonl");
    std::fs::write(&actual, b"private fixture\n").unwrap();
    let selected = root.path().join("selected.jsonl");
    symlink(&actual, &selected).unwrap();
    let capture = || {
        HistorySourceBinding::capture(
            root.path(),
            Path::new("selected.jsonl"),
            origin(MigrationSourceKind::Codex),
            &mut |_, _| true,
        )
    };
    assert!(capture().is_err());
    std::fs::remove_file(&selected).unwrap();
    std::fs::hard_link(&actual, &selected).unwrap();
    assert!(capture().is_err());
    assert_eq!(std::fs::read(actual).unwrap(), b"private fixture\n");
}

#[cfg(unix)]
#[test]
fn a_source_parent_replaced_during_copy_is_rejected_before_publication() {
    let from = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let nested = from.path().join("nested");
    std::fs::create_dir(&nested).unwrap();
    let bytes = vec![b'x'; 2 * EXTERNAL_HISTORY_CHUNK_BYTES];
    std::fs::write(nested.join("selected.jsonl"), &bytes).unwrap();
    let binding = HistorySourceBinding::capture(
        from.path(),
        Path::new("nested/selected.jsonl"),
        origin(MigrationSourceKind::Codex),
        &mut |_, _| true,
    )
    .unwrap();
    let store = ExternalHistoryStore::open(target.path()).unwrap();
    let mut moved = false;
    let result = binding.archive(&store, "moving-parent", &mut |progress| {
        if progress.phase == ExternalHistoryPhase::Copying
            && progress.processed_bytes >= 64 * 1024
            && !moved
        {
            std::fs::rename(&nested, from.path().join("preserved-parent")).unwrap();
            std::fs::create_dir(&nested).unwrap();
            std::fs::write(nested.join("selected.jsonl"), &bytes).unwrap();
            moved = true;
        }
        true
    });
    assert!(moved && result.is_err());
    let import = store.begin("moving-parent", binding.snapshot()).unwrap();
    assert!(
        !target
            .path()
            .join("external-history")
            .join(import.archive_id())
            .join("source.bin")
            .exists()
    );
}

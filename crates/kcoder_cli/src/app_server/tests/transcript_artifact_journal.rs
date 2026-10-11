fn artifact_journal_begin(
    engine: &QueryEngine,
) -> kcoder_state::history_index::journal::JournalWatermark {
    use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
    let mut fence =
        JournalFence::try_acquire(&engine.client_storage_root(), JournalDomain::ClientMetadata)
            .unwrap();
    fence.activate().unwrap()
}

fn artifact_journal_changed(
    engine: &QueryEngine,
    id: &str,
    watermark: &mut kcoder_state::history_index::journal::JournalWatermark,
) {
    use kcoder_state::history_index::journal::{JournalDomain, changes_since};
    let changes = changes_since(
        &engine.client_storage_root(),
        JournalDomain::ClientMetadata,
        watermark,
        10,
    )
    .unwrap()
    .unwrap();
    assert_eq!(changes.session_ids, vec![id.to_string()]);
    assert_ne!(&changes.watermark, watermark);
    *watermark = changes.watermark;
}

#[test]
fn transcript_artifact_journal_tracks_outcomes_id_clear_and_clone() {
    use kcoder_state::history_index::journal::{JournalDomain, changes_since};
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let id = engine.session_id();
    let mut mark = artifact_journal_begin(&engine);
    save_turn_outcome(&engine, &id, "turn-1", "failed", Some("failure"), None).unwrap();
    artifact_journal_changed(&engine, &id, &mut mark);
    assert_eq!(load_turn_outcomes(&engine, &id).len(), 1);
    clear_turn_outcome(&engine, &id, "turn-1").unwrap();
    artifact_journal_changed(&engine, &id, &mut mark);
    clear_turn_outcome(&engine, &id, "turn-1").unwrap();
    assert_eq!(
        changes_since(
            &engine.client_storage_root(),
            JournalDomain::ClientMetadata,
            &mark,
            10
        )
        .unwrap()
        .unwrap()
        .watermark,
        mark
    );
    save_turn_client_message_id(&engine, &id, "turn-1", Some("client-1")).unwrap();
    artifact_journal_changed(&engine, &id, &mut mark);
    clone_turn_client_message_ids(&engine, &id, "clone-thread").unwrap();
    artifact_journal_changed(&engine, "clone-thread", &mut mark);
    assert_eq!(
        load_turn_client_message_ids(&engine, "clone-thread")
            .get("turn-1")
            .map(String::as_str),
        Some("client-1")
    );
    save_turn_client_message_id(&engine, &id, "turn-1", None).unwrap();
    artifact_journal_changed(&engine, &id, &mut mark);
    save_turn_client_message_id(&engine, &id, "turn-1", Some(" ")).unwrap();
    assert_eq!(
        changes_since(
            &engine.client_storage_root(),
            JournalDomain::ClientMetadata,
            &mark,
            10
        )
        .unwrap()
        .unwrap()
        .watermark,
        mark
    );
}

#[test]
fn transcript_artifact_journal_tracks_approval_decisions() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let id = engine.session_id();
    let (mut prompt, _, _) = test_permission_prompt(kcoder_config::PermissionMode::Ask);
    prompt.artifact_dir = Arc::new(StdMutex::new(Some(
        engine
            .session_storage_dir_for(&id)
            .join("approval-decisions"),
    )));
    let mut mark = artifact_journal_begin(&engine);
    prompt
        .persist_decision(ApprovalDecisionArtifact {
            version: 1,
            artifact_id: hex_sha256(b"approval"),
            thread_id: id.clone(),
            turn_id: "turn-1".into(),
            approval_id: "approval-1".into(),
            action: ApprovalAction::Command {
                command: "pwd".into(),
            },
            reason: "test".into(),
            decision: ApprovalDecision::Accept,
            resolution_reason: "user".into(),
            requested_at_ms: 1,
            resolved_at_ms: 2,
        })
        .unwrap();
    artifact_journal_changed(&engine, &id, &mut mark);
    assert_eq!(load_approval_decisions(&engine, &id).len(), 1);
}

#[test]
fn transcript_artifact_journal_tracks_file_change_status() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let id = engine.session_id();
    let directory = engine
        .session_storage_dir_for(&id)
        .join("turn-file-changes");
    ensure_private_artifact_directory(&directory).unwrap();
    let mut artifact = TurnFileChangesArtifact {
        version: 1,
        status: "active".into(),
        artifact_id: hex_sha256(b"patch"),
        thread_id: id.clone(),
        turn_id: "turn-1".into(),
        workspace_path: canonical_workspace(&engine).unwrap(),
        snapshot_backend: GitSnapshotBackend::Workspace,
        before_tree: "before".into(),
        after_tree: "after".into(),
        patch_sha256: hex_sha256(b"patch"),
        file_count: 0,
        additions: 0,
        deletions: 0,
        files: Vec::new(),
        created_at: "1".into(),
        reverted_at: None,
    };
    write_private_artifact_file(
        &directory.join(format!("{}.patch", artifact.artifact_id)),
        b"patch",
    )
    .unwrap();
    let mut mark = artifact_journal_begin(&engine);
    for status in ["active", "conflicted", "reverted"] {
        artifact.status = status.into();
        save_turn_file_changes_artifact(&directory, &artifact).unwrap();
        artifact_journal_changed(&engine, &id, &mut mark);
        assert_eq!(
            load_turn_file_change_summaries(&engine, &id)["turn-1"]["status"],
            status
        );
    }
}

#[test]
fn transcript_artifact_journal_is_pending_before_write_and_never_replays_after_finish_error() {
    use kcoder_state::history_index::journal::{JournalDomain, changes_since};
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let id = engine.session_id();
    let directory = engine.session_storage_dir_for(&id).join("turn-outcomes");
    let mark = artifact_journal_begin(&engine);
    let mut writes = 0;
    let result = transcript_artifact_journal::write(
        &directory,
        &id,
        transcript_artifact_journal::Kind::TurnOutcomes,
        || {
            assert!(
                changes_since(
                    &engine.client_storage_root(),
                    JournalDomain::ClientMetadata,
                    &mark,
                    10
                )
                .is_err()
            );
            writes += 1;
            write_private_artifact_file(&directory.join("committed.json"), b"committed")?;
            let token = engine
                .client_storage_root()
                .join(".kcoder-client-metadata-tracking.json");
            assert!(token.is_file());
            std::fs::remove_file(&token)?;
            std::fs::create_dir(&token)?;
            Ok(42)
        },
    )
    .unwrap();
    assert_eq!(result, 42);
    assert_eq!(writes, 1);
    assert_eq!(
        std::fs::read(directory.join("committed.json")).unwrap(),
        b"committed"
    );
}

#[test]
fn transcript_artifact_journal_patch_and_json_share_one_mutation_and_fail_pending() {
    use kcoder_state::history_index::journal::{JournalDomain, changes_since};
    for fail_json in [false, true] {
        let workspace = tempfile::tempdir().unwrap();
        let engine = catalog_list_test_engine(workspace.path());
        let id = engine.session_id();
        let directory = engine
            .session_storage_dir_for(&id)
            .join("turn-file-changes");
        ensure_private_artifact_directory(&directory).unwrap();
        let artifact: TurnFileChangesArtifact = serde_json::from_value(json!({
            "version":1,"status":"active","artifact_id":hex_sha256(b"pair"),"thread_id":id,"turn_id":"turn-1",
            "workspace_path":canonical_workspace(&engine).unwrap(),"before_tree":"before","after_tree":"after",
            "patch_sha256":hex_sha256(b"patch"),"file_count":0,"additions":0,"deletions":0,"files":[],"created_at":"1"
        })).unwrap();
        if fail_json {
            std::fs::create_dir(directory.join(format!("{}.json", artifact.artifact_id))).unwrap();
        }
        let mark = artifact_journal_begin(&engine);
        let result =
            save_turn_file_changes_artifact_with_patch(&directory, &artifact, Some(b"patch"));
        assert_eq!(
            std::fs::read(directory.join(format!("{}.patch", artifact.artifact_id))).unwrap(),
            b"patch"
        );
        let changes = changes_since(
            &engine.client_storage_root(),
            JournalDomain::ClientMetadata,
            &mark,
            10,
        );
        if fail_json {
            assert!(result.is_err());
            assert!(
                changes.is_err(),
                "a patch-only partial authority write must remain pending"
            );
        } else {
            result.unwrap();
            let changes = changes.unwrap().unwrap();
            assert_eq!(changes.session_ids, vec![engine.session_id()]);
            assert_eq!(
                serde_json::to_value(changes.watermark).unwrap()["sequence"],
                2
            );
            assert_eq!(
                load_turn_file_change_summaries(&engine, &engine.session_id())["turn-1"]["status"],
                "active"
            );
        }
    }
}

#[test]
fn transcript_artifact_journal_rejects_unbound_kind_or_thread_before_authority() {
    let root = tempfile::tempdir().unwrap();
    for path in [
        root.path().join("other/turn-outcomes"),
        root.path().join("thread/attachments"),
    ] {
        let mut wrote = false;
        assert!(
            transcript_artifact_journal::write(
                &path,
                "thread",
                transcript_artifact_journal::Kind::TurnOutcomes,
                || {
                    wrote = true;
                    Ok(())
                }
            )
            .is_err()
        );
        assert!(!wrote);
        assert!(!path.exists());
    }
}

#[test]
fn transcript_artifact_authority_write_waits_for_another_resident_writer() {
    use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let root = engine.client_storage_root();
    let held = JournalFence::try_acquire(&root, JournalDomain::ClientMetadata).unwrap();
    let directory = root.join("other-thread").join("turn-outcomes");
    let (started, ready) = std::sync::mpsc::channel();
    let (done, result) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        started.send(()).unwrap();
        let written = transcript_artifact_journal::write(
            &directory,
            "other-thread",
            transcript_artifact_journal::Kind::TurnOutcomes,
            || write_private_artifact_file(&directory.join("fixture.json"), b"{}"),
        );
        done.send(written).unwrap();
    });
    ready.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(
        matches!(
            result.recv_timeout(Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ),
        "normal resident contention must wait, not reject an authority write"
    );
    drop(held);
    result
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    worker.join().unwrap();
    assert!(
        root.join("other-thread/turn-outcomes/fixture.json")
            .is_file()
    );
}

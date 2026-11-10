fn capture_identity(
    engine: &QueryEngine,
    turn: &str,
    attempt: &str,
) -> kcoder_types::TurnAttemptIdentity {
    kcoder_types::TurnAttemptIdentity {
        thread_id: engine.session_id(),
        turn_id: turn.into(),
        attempt_id: attempt.into(),
    }
}

#[test]
fn turn_file_capture_unsettled_record_restores_as_unknown_not_unchanged() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let owner = capture_identity(&engine, "turn-1", "turn-1");
    let capture = TurnFileCaptureTracker::new(&engine, &owner, true);
    assert_eq!(
        capture.record.state,
        kcoder_app_protocol::TurnFileCaptureState::Capturing
    );
    drop(capture);
    let loaded = load_turn_file_captures(&engine, &owner.thread_id).unwrap();
    let record = &loaded[&owner.attempt_id];
    assert_eq!(
        record.state,
        kcoder_app_protocol::TurnFileCaptureState::Unknown
    );
    assert!(
        record
            .limitations
            .contains(&kcoder_app_protocol::TurnFileCaptureLimitation::CaptureIncomplete)
    );
    assert!(record.artifact_id.is_none());
}

#[test]
fn turn_file_capture_disabled_and_failed_are_independent_durable_results() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let first = capture_identity(&engine, "turn-1", "turn-1");
    let mut disabled = TurnFileCaptureTracker::new(&engine, &first, false);
    assert_eq!(
        disabled.settle(false, false).state,
        kcoder_app_protocol::TurnFileCaptureState::Disabled
    );
    let second = capture_identity(&engine, "turn-2", "turn-2");
    let mut failed = TurnFileCaptureTracker::new(&engine, &second, true);
    failed.failed();
    assert_eq!(
        failed.settle(false, false).state,
        kcoder_app_protocol::TurnFileCaptureState::Failed
    );
    let loaded = load_turn_file_captures(&engine, &engine.session_id()).unwrap();
    assert_eq!(loaded.len(), 2);
    assert_eq!(
        loaded["turn-1"].state,
        kcoder_app_protocol::TurnFileCaptureState::Disabled
    );
    assert_eq!(
        loaded["turn-2"].state,
        kcoder_app_protocol::TurnFileCaptureState::Failed
    );
}

#[tokio::test]
async fn turn_file_capture_policy_exclusions_are_partial_even_without_a_visible_diff() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let owner = capture_identity(&engine, "turn-1", "turn-1");
    let artifact_dir = engine
        .session_storage_dir_for(&owner.thread_id)
        .join("turn-file-changes");
    let git = run_git_command(workspace.path(), &["init"], 4096, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(git.success, "{}", git.stderr);
    std::fs::write(workspace.path().join("visible.txt"), "base\n").unwrap();
    std::fs::write(workspace.path().join("excluded.gguf"), "private\n").unwrap();
    let policy = kcoder_config::TurnFileChangesSettings {
        ignore_globs: vec!["**/*.gguf".into()],
        ..Default::default()
    };
    let mut capture = TurnFileCaptureTracker::new(&engine, &owner, true);
    let before = capture_worktree_tree_with_policy(
        workspace.path(),
        &artifact_dir,
        &owner.turn_id,
        "before",
        &policy,
    )
    .await
    .unwrap()
    .unwrap();
    capture.baseline(&before);
    let report = finalize_turn_file_changes_with_policy(
        workspace.path(),
        &artifact_dir,
        &owner.thread_id,
        &owner.turn_id,
        before,
        &policy,
    )
    .await
    .unwrap();
    assert!(report.artifact.is_none());
    capture.finalized(&report);
    let record = capture.settle(false, false);
    assert_eq!(
        record.state,
        kcoder_app_protocol::TurnFileCaptureState::Partial
    );
    assert!(record.base.is_some() && record.head.is_some());
    assert!(
        record
            .limitations
            .contains(&kcoder_app_protocol::TurnFileCaptureLimitation::PolicyExclusions)
    );
}

#[test]
fn turn_file_capture_projects_each_attempt_without_consuming_a_peer_attempt() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    for attempt in ["turn-1", "retry-1"] {
        TurnFileCaptureTracker::new(
            &engine,
            &capture_identity(&engine, "turn-1", attempt),
            false,
        )
        .settle(false, false);
    }
    let mut loaded = load_turn_file_captures(&engine, &engine.session_id()).unwrap();
    let row = |turn: &str, attempt: &str| {
        serde_json::from_value::<ThreadMessage>(json!({
        "id":attempt,"turnId":turn,"attemptId":attempt,"role":"assistant","content":"answer","timestampMs":1
    })).unwrap()
    };
    let mut first = vec![row("turn-1", "turn-1"), row("peer-turn", "retry-1")];
    attach_turn_file_captures(&mut first, &mut loaded);
    assert!(first[0].file_changes_capture.is_some());
    assert!(first[1].file_changes_capture.is_none());
    assert_eq!(loaded.len(), 1);
    let mut second = vec![row("turn-1", "retry-1")];
    attach_turn_file_captures(&mut second, &mut loaded);
    assert!(second[0].file_changes_capture.is_some());
    assert!(loaded.is_empty());
}

#[test]
fn turn_file_capture_rejects_a_foreign_owner_instead_of_writing_its_directory() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let owner = kcoder_types::TurnAttemptIdentity {
        thread_id: "foreign-thread".into(),
        turn_id: "turn-1".into(),
        attempt_id: "turn-1".into(),
    };
    let mut capture = TurnFileCaptureTracker::new(&engine, &owner, true);
    assert_eq!(
        capture.settle(false, false).state,
        kcoder_app_protocol::TurnFileCaptureState::Unknown
    );
    assert!(!engine.session_storage_dir_for("foreign-thread").exists());
}

#[test]
fn turn_file_capture_budget_respects_the_active_owner_lease() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let owner = capture_identity(&engine, "turn-1", "turn-1");
    let mut capture = TurnFileCaptureTracker::new(&engine, &owner, false);
    capture.settle(false, false);
    let directory = engine
        .session_storage_dir_for(&owner.thread_id)
        .join("turn-file-captures");
    let policy = kcoder_config::TurnFileChangesSettings {
        retention_days: 0,
        max_total_bytes: 1,
        ..Default::default()
    };
    let outcome = storage_diagnostics::enforce_turn_snapshot_budget_at(
        &engine.client_storage_root(),
        &policy,
        SystemTime::now(),
    );
    assert_eq!(outcome.removed_snapshots, 0);
    assert!(directory.is_dir());
    drop(capture);
    let mut watermark = artifact_journal_begin(&engine);
    let outcome = storage_diagnostics::enforce_turn_snapshot_budget_at(
        &engine.client_storage_root(),
        &policy,
        SystemTime::now(),
    );
    assert_eq!(outcome.removed_snapshots, 1);
    assert!(!directory.exists());
    artifact_journal_changed(&engine, &owner.thread_id, &mut watermark);
}

#[tokio::test]
async fn turn_file_capture_all_history_readers_restore_the_same_observation() {
    for tracked in [false, true] {
        let workspace = tempfile::tempdir().unwrap();
        let history = tempfile::tempdir().unwrap();
        let engine = catalog_list_test_engine(workspace.path());
        if tracked {
            for (root, domain) in [
                (
                    history.path().to_path_buf(),
                    kcoder_state::history_index::journal::JournalDomain::History,
                ),
                (
                    engine.client_storage_root(),
                    kcoder_state::history_index::journal::JournalDomain::ClientMetadata,
                ),
            ] {
                kcoder_state::history_index::journal::JournalFence::try_acquire(&root, domain)
                    .unwrap()
                    .activate()
                    .unwrap();
            }
        }
        catalog_list_seed(&engine, history.path());
        engine
            .state
            .add_message(kcoder_types::Message::assistant_text("result"));
        engine.state.save_history().unwrap();
        let owner = capture_identity(&engine, "turn-1", "turn-1");
        let mut capture = TurnFileCaptureTracker::new(&engine, &owner, true);
        capture.failed();
        let expected = capture.settle(false, false);
        let review = record_native_process_review(&engine, &owner);
        let params = ThreadReadParams {
            thread_id: owner.thread_id.clone(),
            limit: Some(50),
            before_cursor: None,
        };
        let projection = ThreadRunProjection {
            negotiated: false,
            facts: None,
        };
        let legacy = thread_transcript(&engine, params.clone(), &HashSet::new(), projection)
            .await
            .unwrap();
        assert_eq!(
            legacy
                .messages
                .last()
                .unwrap()
                .file_changes_capture
                .as_ref(),
            Some(&expected)
        );
        assert_eq!(
            legacy.messages.last().unwrap().review_evidence.as_ref(),
            Some(&review)
        );
        if tracked {
            let indexed = indexed_transcript::read(
                &engine,
                params.clone(),
                &HashSet::new(),
                projection,
                true,
                false,
            )
            .await
            .unwrap()
            .finish(projection);
            assert!(
                matches!(
                    indexed.transcript_snapshot_v1,
                    Some(kcoder_app_protocol::ThreadTranscriptSnapshotV1::Available { .. })
                ),
                "indexed reader must not silently fall back"
            );
            assert_eq!(
                indexed.messages.last().unwrap().review_evidence.as_ref(),
                Some(&review)
            );
            assert_eq!(
                indexed
                    .messages
                    .last()
                    .unwrap()
                    .file_changes_capture
                    .as_ref(),
                Some(&expected)
            );
        } else {
            let observed = observed_transcript::read(&engine, &params, &HashSet::new(), true)
                .await
                .unwrap()
                .expect("observed reader must be proven")
                .finish(projection);
            assert!(observed.transcript_observation_v1.is_some());
            assert_eq!(
                observed.messages.last().unwrap().review_evidence.as_ref(),
                Some(&review)
            );
            assert_eq!(
                observed
                    .messages
                    .last()
                    .unwrap()
                    .file_changes_capture
                    .as_ref(),
                Some(&expected)
            );
        }
    }
}

#[test]
fn turn_file_capture_budget_does_not_claim_similarly_named_wiki_sources() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("demo/wiki/sources/turn-file-captures");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("original.json"), "original source").unwrap();
    let policy = kcoder_config::TurnFileChangesSettings {
        retention_days: 0,
        max_total_bytes: 1,
        ..Default::default()
    };
    let outcome = storage_diagnostics::enforce_turn_snapshot_budget_at(
        root.path(),
        &policy,
        SystemTime::now(),
    );
    assert_eq!(outcome.removed_snapshots, 0);
    assert!(source.join("original.json").exists());
}

#[test]
fn turn_file_capture_history_rejects_a_record_renamed_to_another_identity() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let owner = capture_identity(&engine, "turn-1", "turn-1");
    let mut tracker = TurnFileCaptureTracker::new(&engine, &owner, true);
    tracker.failed();
    let capture = tracker.settle(false, false);
    let directory = engine
        .session_storage_dir_for(&owner.thread_id)
        .join("turn-file-captures");
    let original = directory.join(format!("{}.json", capture.capture_id));
    std::fs::rename(&original, directory.join("different.json")).unwrap();
    assert!(load_turn_file_captures(&engine, &owner.thread_id).is_err());
}

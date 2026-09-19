    #[test]
    fn session_timestamps_preserve_creation_across_messages_resume_and_reset() {
        let tmp = TempDir::new().unwrap();
        let state = AppState::new(tmp.path());
        let path = tmp.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        let initial = state.session_timestamps_ms();
        std::thread::sleep(std::time::Duration::from_millis(10));
        state.add_message(Message::user_text("timestamp fixture"));
        let after_message = state.session_timestamps_ms();
        assert_eq!(after_message.0, initial.0);
        assert!(after_message.1 > initial.1);
        assert_eq!(session_timestamps_ms(&path).unwrap(), after_message);
        let resumed = AppState::new(tmp.path());
        resumed.resume_from_history(&path).unwrap();
        assert_eq!(resumed.session_timestamps_ms(), after_message);
        std::thread::sleep(std::time::Duration::from_millis(10));
        resumed.start_new_session().unwrap();
        let reset = resumed.session_timestamps_ms();
        assert!(reset.0 > after_message.1);
        assert_eq!(reset.0, reset.1);
    }

    #[test]
    fn session_timestamps_restore_legacy_history_and_include_boundary_changes() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("legacy.jsonl");
        let entry = HistoryEntry {
            session_id: "legacy".into(),
            timestamp_ms: 1234,
            uuid: None,
            parent_uuid: None,
            message: Message::user_text("legacy fixture"),
        };
        std::fs::write(&path, format!("{}\n{}\n", serde_json::to_string(&entry).unwrap(), serde_json::json!({
            "type":"system", "subtype":"rewind_boundary", "timestamp_ms": 5678
        }))).unwrap();
        assert_eq!(session_timestamps_ms(&path).unwrap(), (1234, 5678));
        let resumed = AppState::new(tmp.path());
        resumed.resume_from_history(&path).unwrap();
        assert_eq!(resumed.session_timestamps_ms(), (1234, 5678));
    }

    #[test]
    fn save_and_load_history() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("history.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);
        state.add_message(Message::user_text("hello"));
        state.add_message(Message::assistant_text("hi"));
        state.save_history().unwrap();

        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn image_message_survives_history_resume_and_remains_in_next_turn_context() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("image-history.jsonl");
        let image_data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
        let image_message = Message::User {
            content: vec![
                ContentBlock::Text {
                    text: "[Image #1] describe this image".to_string(),
                },
                ContentBlock::Image {
                    source: kcoder_types::ImageSource::base64("image/png", image_data),
                },
            ],
        };

        let state = AppState::new("/");
        state.with_history_path(&path);
        state.add_message(image_message.clone());
        state.add_message(Message::assistant_text("It is a test image."));
        state.save_history().unwrap();

        let resumed = AppState::new("/");
        resumed.resume_from_history(&path).unwrap();
        resumed.add_message(Message::user_text("Can you still see the previous image?"));

        let next_turn = MessagesRequest::new("test-model", resumed.messages());
        assert_eq!(next_turn.messages.first(), Some(&image_message));
        assert!(next_turn.messages.iter().any(|message| {
            matches!(
                message,
                Message::User { content }
                    if content.iter().any(|block| matches!(
                        block,
                        ContentBlock::Image {
                            source: kcoder_types::ImageSource { media_type, data, .. },
                        } if media_type == "image/png" && data == image_data
                    ))
            )
        }));
        assert_eq!(
            next_turn
                .messages
                .last()
                .map(|message| message.preview(200)),
            Some("Can you still see the previous image?".to_string())
        );
    }

    #[tokio::test]
    async fn compaction_appends_boundary_and_summary_without_model_state_sidecar() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);
        state.add_message(Message::user_text("old user"));
        state.add_message(Message::assistant_text("old assistant"));

        state
            .set_messages_after_compaction(
                vec![Message::user_text(
                    "Earlier conversation summary: compacted",
                )],
                CompactionTranscriptEvent {
                    trigger: CompactionTrigger::Manual,
                    pre_tokens: 100,
                    post_tokens: 20,
                    summary: "compacted".to_string(),
                },
            )
            .await
            .unwrap();

        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].message.preview(500).contains("compacted"));
        assert!(!entries[0].message.preview(500).contains("old user"));

        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"subtype\":\"compact_boundary\""));
        assert!(raw.contains("\"isCompactSummary\":true"));
        assert!(raw.contains("This session is being continued"));

        let persisted_state =
            load_session_state(&state.session_state_path().expect("state sidecar")).unwrap();
        assert!(persisted_state.compacted_messages.is_none());

        let resumed = AppState::new("/");
        resumed.resume_from_history(&path).unwrap();
        let resumed_messages = resumed.messages();
        assert_eq!(resumed_messages.len(), 1);
        assert!(resumed_messages[0].preview(200).contains("compacted"));
    }

    #[tokio::test]
    async fn compaction_resume_restores_summary_then_preserved_tail_from_jsonl() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);
        state.add_message(Message::user_text("old user"));
        state.add_message(Message::assistant_text("old assistant"));
        let recent_user = Message::user_text("recent user");
        let recent_assistant = Message::assistant_text("recent assistant");
        state.add_message(recent_user.clone());
        state.add_message(recent_assistant.clone());

        state
            .set_messages_after_compaction(
                vec![
                    Message::user_text("Earlier conversation summary: compacted"),
                    recent_user,
                    recent_assistant,
                ],
                CompactionTranscriptEvent {
                    trigger: CompactionTrigger::Manual,
                    pre_tokens: 100,
                    post_tokens: 20,
                    summary: "compacted".to_string(),
                },
            )
            .await
            .unwrap();

        let entries = load_history(&path).unwrap();
        let previews = entries
            .iter()
            .map(|entry| entry.message.preview(200))
            .collect::<Vec<_>>();
        assert_eq!(previews.len(), 3);
        assert!(previews[0].contains("compacted"));
        assert_eq!(previews[1], "recent user");
        assert_eq!(previews[2], "recent assistant");
        assert!(!previews.iter().any(|text| text.contains("old user")));

        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"parentUuid\""));
        assert!(raw.contains("\"logicalParentUuid\""));
        assert!(raw.contains("\"preservedSegment\""));

        let resumed = AppState::new("/");
        resumed.resume_from_history(&path).unwrap();
        let resumed_previews = resumed
            .messages()
            .iter()
            .map(|message| message.preview(200))
            .collect::<Vec<_>>();
        assert_eq!(resumed_previews, previews);
    }

    #[tokio::test]
    async fn rewind_truncation_is_durable_across_resume() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);
        state.add_message(Message::user_text("first user"));
        state.add_message(Message::assistant_text("first answer"));
        state.add_message(Message::user_text("second user"));
        state.add_message(Message::assistant_text("second answer"));

        let outcome = state.truncate_messages_for_rewind(2, 2).await.unwrap();
        assert_eq!(
            outcome,
            ConversationRewindOutcome {
                removed: 2,
                boundary_recorded: true,
            }
        );
        assert_eq!(state.messages().len(), 2);

        // Model context replay drops everything after the anchored message.
        let entries = load_history(&path).unwrap();
        let previews = entries
            .iter()
            .map(|entry| entry.message.preview(200))
            .collect::<Vec<_>>();
        assert_eq!(previews, vec!["first user", "first answer"]);

        // The user-visible transcript is truncated consistently.
        let transcript = load_transcript_history(&path).unwrap();
        assert_eq!(transcript.len(), 2);

        let resumed = AppState::new("/");
        resumed.resume_from_history(&path).unwrap();
        let resumed_previews = resumed
            .messages()
            .iter()
            .map(|message| message.preview(200))
            .collect::<Vec<_>>();
        assert_eq!(resumed_previews, vec!["first user", "first answer"]);
    }

    #[tokio::test]
    async fn rewind_to_zero_messages_clears_replay_context() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);
        state.add_message(Message::user_text("only user"));
        state.add_message(Message::assistant_text("only answer"));

        let outcome = state.truncate_messages_for_rewind(0, 1).await.unwrap();
        assert!(outcome.boundary_recorded);
        assert_eq!(outcome.removed, 2);
        assert!(state.messages().is_empty());
        assert!(load_history(&path).unwrap().is_empty());
        assert!(load_transcript_history(&path).unwrap().is_empty());
    }

    #[tokio::test]
    async fn rewind_beyond_current_length_is_a_noop() {
        let state = AppState::new("/");
        state.add_message(Message::user_text("hello"));
        let outcome = state.truncate_messages_for_rewind(5, 1).await.unwrap();
        assert_eq!(outcome.removed, 0);
        assert!(!outcome.boundary_recorded);
        assert_eq!(state.messages().len(), 1);
    }

    #[test]
    fn resume_ignores_legacy_compacted_messages_sidecar() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);
        state.add_message(Message::user_text("transcript user"));
        state.save_history().unwrap();
        fs::write(
            session_state_path(tmp.path(), "session"),
            serde_json::json!({
                "compacted_messages": [Message::user_text("legacy sidecar should not win")]
            })
            .to_string(),
        )
        .unwrap();

        let resumed = AppState::new("/");
        resumed.resume_from_history(&path).unwrap();

        let text = resumed
            .messages()
            .iter()
            .map(|message| message.preview(200))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("transcript user"));
        assert!(!text.contains("legacy sidecar should not win"));
        let state_text = fs::read_to_string(session_state_path(tmp.path(), "session")).unwrap();
        assert!(!state_text.contains("compacted_messages"));
    }

    #[tokio::test]
    async fn goal_state_updates_do_not_create_compacted_model_sidecar() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("history.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);
        state.add_message(Message::user_text("old user"));
        state
            .set_messages_after_compaction(
                vec![Message::user_text(
                    "Earlier conversation summary: compacted",
                )],
                CompactionTranscriptEvent {
                    trigger: CompactionTrigger::Manual,
                    pre_tokens: 100,
                    post_tokens: 20,
                    summary: "compacted".to_string(),
                },
            )
            .await
            .unwrap();

        state.set_goal("keep compacted state", None);

        let persisted_state =
            load_session_state(&state.session_state_path().expect("state sidecar")).unwrap();
        assert!(persisted_state.goal.is_some());
        assert!(persisted_state.compacted_messages.is_none());
    }

    #[tokio::test]
    async fn session_memory_snapshot_persists_and_resume_restores() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("history.jsonl");
        let summary_path = session_memory_summary_path(tmp.path(), "session");
        let state = AppState::new(tmp.path());
        state.with_history_path(&path);
        state.add_message(Message::user_text("visible transcript"));
        state.set_session_memory(SessionMemorySnapshot::new(
            &summary_path,
            state.messages().len(),
            42,
            1,
            "model:test-summary",
        ));
        state.save_history().unwrap();

        let persisted_state =
            load_session_state(&state.session_state_path().expect("state sidecar")).unwrap();
        let persisted_memory = persisted_state.session_memory.unwrap();
        assert_eq!(persisted_memory.summary_path, summary_path);
        assert_eq!(persisted_memory.update_count, 1);

        let resumed = AppState::new(tmp.path());
        resumed.resume_from_history(&path).unwrap();
        assert_eq!(
            resumed.session_memory().unwrap().source,
            "model:test-summary"
        );
    }

    #[tokio::test]
    async fn compact_and_goal_state_updates_preserve_session_memory_snapshot() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("history.jsonl");
        let summary_path = session_memory_summary_path(tmp.path(), "session");
        let state = AppState::new(tmp.path());
        state.with_history_path(&path);
        state.set_session_memory(SessionMemorySnapshot::new(
            &summary_path,
            0,
            42,
            1,
            "model:test-summary",
        ));
        state
            .set_messages_after_compaction(
                vec![Message::user_text(
                    "Earlier conversation summary: compacted",
                )],
                CompactionTranscriptEvent {
                    trigger: CompactionTrigger::Manual,
                    pre_tokens: 100,
                    post_tokens: 20,
                    summary: "compacted".to_string(),
                },
            )
            .await
            .unwrap();
        state.set_goal("keep memory", None);

        let persisted_state =
            load_session_state(&state.session_state_path().expect("state sidecar")).unwrap();
        assert_eq!(
            persisted_state.session_memory.unwrap().summary_path,
            summary_path
        );
        assert!(persisted_state.goal.is_some());
        assert!(persisted_state.compacted_messages.is_none());
    }

    #[test]
    fn history_path_accessors_return_history_and_sidecar_paths() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("history.jsonl");
        let state = AppState::new("/");

        assert_eq!(state.history_path(), None);
        assert_eq!(state.session_state_path(), None);
        assert_eq!(state.llm_request_history_dir(), None);

        state.with_history_path(&path);

        assert_eq!(state.history_path().as_deref(), Some(path.as_path()));
        assert_eq!(
            state.session_state_path().as_deref(),
            Some(session_state_path(tmp.path(), "history").as_path())
        );
        assert_eq!(
            state.llm_request_history_dir().as_deref(),
            Some(llm_request_history_dir_path(tmp.path(), "history").as_path())
        );
        assert_eq!(
            state.session_memory_llm_request_history_dir().as_deref(),
            Some(session_memory_llm_request_history_dir_path(tmp.path(), "history").as_path())
        );
    }

    #[test]
    fn session_first_prompt_extracts_first_real_user_text() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("s.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);
        state.add_message(Message::user_text("调查 compact 边界的行为并写报告"));
        state.add_message(Message::assistant_text("好的，我先看一下相关实现。"));
        state.save_history().unwrap();

        assert_eq!(
            session_first_prompt(&path, 80).as_deref(),
            Some("调查 compact 边界的行为并写报告")
        );
    }

    #[test]
    fn session_first_prompt_skips_tool_result_only_users_and_truncates() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("s.jsonl");
        let lines = [
            r#"{"session_id":"s","timestamp_ms":1,"uuid":"0","role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"big output"}],"is_error":false}]}"#,
            r#"{"session_id":"s","timestamp_ms":2,"uuid":"1","role":"user","content":[{"type":"text","text":"first  real\n\nprompt with a very long tail that should be truncated somewhere"}]}"#,
        ];
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();

        let preview = session_first_prompt(&path, 30).unwrap();
        assert_eq!(preview, "first real prompt with a very …");
    }

    #[test]
    fn session_first_timestamp_uses_the_first_persisted_record() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("timestamps.jsonl");
        std::fs::write(
            &path,
            concat!(
                "not-json\n",
                r#"{"session_id":"s","timestamp_ms":"1234","role":"user","content":[]}"#,
                "\n",
                r#"{"session_id":"s","timestamp_ms":5678,"role":"assistant","content":[]}"#,
                "\n"
            ),
        )
        .unwrap();

        assert_eq!(session_first_timestamp_ms(&path), Some(1234));
    }

    #[test]
    fn resume_from_history_replaces_messages() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("resumed-session.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);
        state.add_message(Message::user_text("hello"));
        state.add_message(Message::assistant_text("hi"));
        state.save_history().unwrap();

        let new_path = tmp.path().join("new-session.jsonl");
        let new_state = AppState::new("/");
        new_state.with_history_path(&new_path);
        let count = new_state.resume_from_history(&path).unwrap();
        assert_eq!(count, 2);
        assert_eq!(new_state.messages().len(), 2);
        assert_eq!(new_state.session_id(), "resumed-session");
        assert_eq!(new_state.history_path().as_deref(), Some(path.as_path()));
        assert_eq!(
            new_state.session_state_path().as_deref(),
            Some(session_state_path(tmp.path(), "resumed-session").as_path())
        );

        new_state.add_message(Message::assistant_text("after resume"));
        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries.last().unwrap().session_id, "resumed-session");
        assert!(!new_path.exists());
    }

    #[test]
    fn prepared_resume_does_not_reread_source_files_when_applied() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("prepared-session.jsonl");
        let source = AppState::new("/");
        source.with_history_path(&path);
        source.add_message(Message::user_text("captured before replacement"));
        source.set_session_memory(SessionMemorySnapshot::new(
            tmp.path().join("memory.md"),
            1,
            12,
            3,
            "prepared-test",
        ));
        source.save_history().unwrap();

        let prepared = prepare_session_resume(&path).unwrap();
        let expected_parent_uuid = prepared.last_transcript_uuid.clone().unwrap();
        assert_eq!(prepared.transcript_len(), 1);
        assert!(
            prepared.load_transcript_messages().unwrap()[0]
                .preview(1_000)
                .contains("captured before replacement")
        );
        fs::remove_file(&path).unwrap();
        let sidecar_path = session_state_path(tmp.path(), "prepared-session");
        let stale_sidecar = PersistedSessionState {
            cwd: Some(PathBuf::from("/stale-cwd")),
            ..PersistedSessionState::default()
        };
        let stale_bytes = serde_json::to_vec_pretty(&stale_sidecar).unwrap();
        fs::write(&sidecar_path, &stale_bytes).unwrap();

        let target = AppState::new("/");
        assert_eq!(target.apply_prepared_session_resume(prepared).unwrap(), 1);
        assert_eq!(target.session_id(), "prepared-session");
        assert!(
            target.messages()[0]
                .preview(1_000)
                .contains("captured before replacement")
        );
        assert_eq!(target.session_memory().unwrap().update_count, 3);
        let restored_sidecar =
            load_session_state(&target.session_state_path().expect("prepared sidecar path"))
                .unwrap();
        assert_eq!(restored_sidecar.session_memory.unwrap().update_count, 3);
        assert_ne!(fs::read(&sidecar_path).unwrap(), stale_bytes);

        target.add_message(Message::assistant_text("continued after prepared resume"));
        target.save_history().unwrap();
        let raw_entries = fs::read_to_string(&path).unwrap();
        let last: serde_json::Value =
            serde_json::from_str(raw_entries.lines().last().unwrap()).unwrap();
        assert_eq!(
            last.get("parentUuid").and_then(serde_json::Value::as_str),
            Some(expected_parent_uuid.as_str())
        );
    }

    #[test]
    fn concurrent_goal_and_cwd_commits_preserve_memory_and_sidecar_order() {
        let tmp = TempDir::new().unwrap();
        let history_path = tmp.path().join("ordered-session.jsonl");
        let initial_cwd = tmp.path().join("initial");
        let state = AppState::new(&initial_cwd);
        state.with_history_path(&history_path);
        let sidecar_path = state.session_state_path().unwrap();

        let write_entered = Arc::new(std::sync::Barrier::new(2));
        let write_release = Arc::new(std::sync::Barrier::new(2));
        install_session_state_write_barrier(
            &state,
            sidecar_path.clone(),
            Arc::clone(&write_entered),
            Arc::clone(&write_release),
        );

        let goal_state = state.clone();
        let goal_thread = std::thread::spawn(move || {
            goal_state.set_goal("ordered goal", Some(100));
        });
        write_entered.wait();

        let cwd = tmp.path().join("latest-cwd");
        let lock_entered = Arc::new(std::sync::Barrier::new(2));
        let lock_release = Arc::new(std::sync::Barrier::new(2));
        install_session_state_lock_barrier(
            &state,
            Arc::clone(&lock_entered),
            Arc::clone(&lock_release),
        );
        let cwd_state = state.clone();
        let cwd_for_thread = cwd.clone();
        let cwd_thread = std::thread::spawn(move || {
            cwd_state.set_cwd(cwd_for_thread);
        });
        lock_entered.wait();
        assert_eq!(state.cwd(), initial_cwd);
        lock_release.wait();
        assert_eq!(state.cwd(), initial_cwd);

        write_release.wait();
        goal_thread.join().unwrap();
        cwd_thread.join().unwrap();
        clear_session_state_write_barrier();
        clear_session_state_lock_barrier();

        let persisted = load_session_state(&sidecar_path).unwrap();
        assert_eq!(state.cwd(), cwd);
        assert_eq!(persisted.cwd.as_deref(), Some(cwd.as_path()));
        assert_eq!(state.goal().unwrap().objective, "ordered goal");
        assert_eq!(persisted.goal.unwrap().objective, "ordered goal");
    }

    #[test]
    fn prepared_resume_persist_failure_leaves_live_session_unchanged() {
        let tmp = TempDir::new().unwrap();
        let history_path = tmp.path().join("blocked-session.jsonl");
        let source = AppState::new(tmp.path().join("resumed-cwd"));
        source.with_history_path(&history_path);
        source.add_message(Message::user_text("resume payload"));
        source.set_goal("resumed goal", None);
        let interrupted_output = tmp.path().join("interrupted/output.txt");
        let mut task = Task::new("resume-task", "恢复时应标记中断");
        task.managed = true;
        task.delivery = TaskDelivery::Background;
        task.status = TaskStatus::Running;
        task.output_path = Some(interrupted_output.clone());
        source.upsert_task(task);
        source.save_history().unwrap();
        let prepared = prepare_session_resume(&history_path).unwrap();

        let blocked_sidecar = session_state_path(tmp.path(), "blocked-session");
        let original_sidecar_bytes = fs::read(&blocked_sidecar).unwrap();
        let _failpoint = install_atomic_replace_failpoint(blocked_sidecar.clone());

        let target = AppState::new(tmp.path().join("original-cwd"));
        target.add_message(Message::user_text("original message"));
        target.set_goal("original goal", Some(12));
        let original_session_id = target.session_id();
        let original_cwd = target.cwd();
        let original_messages = target.messages();
        let original_goal = target.goal();
        let original_history_path = target.history_path();
        let original_sidecar_path = target.session_state_path();

        let error = target.apply_prepared_session_resume(prepared).unwrap_err();

        assert!(error.to_string().contains("failed to persist prepared session state"));
        assert_eq!(target.session_id(), original_session_id);
        assert_eq!(target.cwd(), original_cwd);
        assert_eq!(target.messages(), original_messages);
        assert_eq!(target.goal(), original_goal);
        assert_eq!(target.history_path(), original_history_path);
        assert_eq!(target.session_state_path(), original_sidecar_path);
        assert_eq!(fs::read(&blocked_sidecar).unwrap(), original_sidecar_bytes);
        assert!(!interrupted_output.exists());
        assert!(atomic_temp_paths(&blocked_sidecar).is_empty());
    }

    #[test]
    fn atomic_write_creates_and_replaces_target() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        write_bytes_atomic(&path, b"first").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"first");
        assert!(atomic_temp_paths(&path).is_empty());

        write_bytes_atomic(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert!(atomic_temp_paths(&path).is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn atomic_write_failure_preserves_old_bytes_and_removes_temp() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        fs::write(&path, b"old-state").unwrap();
        let _failpoint = install_atomic_replace_failpoint(path.clone());

        let error = write_bytes_atomic(&path, b"new-state").unwrap_err();

        assert!(error.to_string().contains("测试注入"));
        assert_eq!(fs::read(&path).unwrap(), b"old-state");
        assert!(atomic_temp_paths(&path).is_empty());
    }

    #[test]
    fn atomic_replace_failpoints_are_isolated_by_target_during_parallel_writes() {
        let tmp = TempDir::new().unwrap();
        let blocked_path = tmp.path().join("blocked-state.json");
        let allowed_path = tmp.path().join("allowed-state.json");
        fs::write(&blocked_path, b"blocked-old").unwrap();
        fs::write(&allowed_path, b"allowed-old").unwrap();
        let failpoint = install_atomic_replace_failpoint(blocked_path.clone());
        let start = Arc::new(std::sync::Barrier::new(3));

        let blocked_start = Arc::clone(&start);
        let blocked_for_thread = blocked_path.clone();
        let blocked = std::thread::spawn(move || {
            blocked_start.wait();
            write_bytes_atomic(&blocked_for_thread, b"blocked-new")
        });
        let allowed_start = Arc::clone(&start);
        let allowed_for_thread = allowed_path.clone();
        let allowed = std::thread::spawn(move || {
            allowed_start.wait();
            write_bytes_atomic(&allowed_for_thread, b"allowed-new")
        });
        start.wait();

        assert!(blocked.join().unwrap().is_err());
        allowed.join().unwrap().unwrap();
        assert_eq!(fs::read(&blocked_path).unwrap(), b"blocked-old");
        assert_eq!(fs::read(&allowed_path).unwrap(), b"allowed-new");
        assert!(atomic_temp_paths(&blocked_path).is_empty());
        assert!(atomic_temp_paths(&allowed_path).is_empty());

        drop(failpoint);
        write_bytes_atomic(&blocked_path, b"blocked-after-drop").unwrap();
        assert_eq!(fs::read(&blocked_path).unwrap(), b"blocked-after-drop");
    }

    #[test]
    fn atomic_replace_failpoint_remains_until_last_same_target_guard_drops() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        fs::write(&path, b"old-state").unwrap();
        let first = install_atomic_replace_failpoint(path.clone());
        let second = install_atomic_replace_failpoint(path.clone());

        assert!(write_bytes_atomic(&path, b"first-attempt").is_err());
        drop(first);
        assert!(write_bytes_atomic(&path, b"second-attempt").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old-state");

        drop(second);
        write_bytes_atomic(&path, b"after-last-drop").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"after-last-drop");
        assert!(atomic_temp_paths(&path).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn atomic_write_uses_windows_replace_existing_semantics() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        fs::write(&path, b"old-state").unwrap();

        write_bytes_atomic(&path, b"windows-replaced").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"windows-replaced");
        assert!(atomic_temp_paths(&path).is_empty());
    }

    #[test]
    fn malformed_resume_sidecar_fails_during_prepare() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("broken-session.jsonl");
        let source = AppState::new("/");
        source.with_history_path(&path);
        source.add_message(Message::user_text("valid history"));
        source.save_history().unwrap();
        fs::write(session_state_path(tmp.path(), "broken-session"), "{").unwrap();

        let error = prepare_session_resume(&path).unwrap_err();
        assert!(error.to_string().contains("failed to parse session state"));
    }

    #[test]
    fn malformed_resume_jsonl_fails_during_prepare_instead_of_skipping_the_line() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("broken-history.jsonl");
        fs::write(&path, "{not-json}\n").unwrap();

        let error = prepare_session_resume(&path).unwrap_err();
        assert!(error.to_string().contains("failed to parse history JSON"));
        assert!(format!("{error:#}").contains(&format!("{}:1:", path.display())));
    }

    #[test]
    fn resume_from_history_restores_goal_sidecar() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);
        state.add_message(Message::user_text("hello"));
        state.set_goal("keep going", Some(100));
        state.account_goal_usage(12, 3);
        state.save_history().unwrap();

        let new_path = tmp.path().join("new-session.jsonl");
        let new_state = AppState::new("/");
        new_state.with_history_path(&new_path);
        let count = new_state.resume_from_history(&path).unwrap();

        assert_eq!(count, 1);
        let goal = new_state.goal().unwrap();
        assert_eq!(goal.objective, "keep going");
        assert_eq!(goal.tokens_used, 12);
        assert_eq!(goal.token_budget, Some(100));
        assert_eq!(new_state.session_id(), "session");
        assert_eq!(new_state.history_path().as_deref(), Some(path.as_path()));
        assert!(session_state_path(tmp.path(), "session").exists());
        assert!(!session_state_path_for_history(&new_path).exists());
    }

    #[test]
    fn recent_sessions_lists_newest_first() {
        let tmp = TempDir::new().unwrap();
        let a = tmp.path().join("a.jsonl");
        let b = tmp.path().join("b.jsonl");
        fs::write(&a, "").unwrap();
        fs::write(&b, "").unwrap();
        // Both empty, so they are skipped.
        let sessions = recent_sessions(tmp.path(), 10).unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn recent_sessions_counts_only_newest_candidates_needed_by_limit() {
        let tmp = TempDir::new().unwrap();
        let old = tmp.path().join("old.jsonl");
        let new = tmp.path().join("new.jsonl");
        fs::write(&old, "old\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&new, "new\n").unwrap();
        let mut inspected = Vec::new();

        let sessions = crate::history::recent_sessions_with_message_count(
            tmp.path(),
            1,
            |path| {
                inspected.push(path.to_path_buf());
                Ok(1)
            },
        )
        .unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].1, new);
        assert_eq!(inspected, vec![new]);
    }

    #[test]
    fn prepared_resume_loads_only_requested_transcript_tail() {
        let tmp = TempDir::new().unwrap();
        let history = tmp.path().join("indexed.jsonl");
        for index in 0..12 {
            append_history_entry(
                &history,
                &HistoryEntry {
                    session_id: "indexed".to_string(),
                    timestamp_ms: index,
                    uuid: Some(format!("uuid-{index}")),
                    parent_uuid: index.checked_sub(1).map(|value| format!("uuid-{value}")),
                    message: Message::user_text(format!("message-{index}")),
                },
            );
        }

        let prepared = prepare_session_resume(&history).unwrap();
        let (start, tail) = prepared.transcript_history.load_tail(3).unwrap();

        assert_eq!(prepared.transcript_len(), 12);
        assert_eq!(start, 9);
        assert_eq!(tail.len(), 3);
        assert!(tail[0].preview(1_000).contains("message-9"));
        assert!(tail[2].preview(1_000).contains("message-11"));
    }

    #[test]
    fn generated_session_ids_are_process_scoped_and_unique() {
        let first = generate_session_id();
        let second = generate_session_id();
        assert_ne!(first, second);
        let process_component = format!("-{:08x}-", std::process::id());
        assert!(first.contains(&process_component));
        assert!(second.contains(&process_component));
    }

    #[test]
    fn recent_sessions_skips_exit_diagnostics() {
        let tmp = TempDir::new().unwrap();
        let history = tmp.path().join("session.jsonl");
        let exit_diagnostic = exit_diagnostic_path_for_history(&history);
        let entry = HistoryEntry {
            session_id: "session".to_string(),
            timestamp_ms: now_millis(),
            uuid: Some(generate_transcript_uuid()),
            parent_uuid: None,
            message: Message::user_text("hello"),
        };
        append_history_entry(&history, &entry);
        append_history_entry(&exit_diagnostic, &entry);

        let sessions = recent_sessions(tmp.path(), 10).unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].0, "session");
        assert_eq!(sessions[0].1, history);
    }

    #[test]
    fn prune_session_history_removes_old_sessions_and_sidecars() {
        let tmp = TempDir::new().unwrap();
        let old = tmp.path().join("old.jsonl");
        let mid = tmp.path().join("mid.jsonl");
        let new = tmp.path().join("new.jsonl");
        fs::write(&old, "{}\n").unwrap();
        fs::write(session_state_path_for_history(&old), "{}").unwrap();
        fs::write(exit_diagnostic_path_for_history(&old), "{}\n").unwrap();
        fs::write(old.with_extension("lease"), "").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(25));
        fs::write(&mid, "{}\n").unwrap();
        fs::write(session_state_path_for_history(&mid), "{}").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(25));
        fs::write(&new, "{}\n").unwrap();
        fs::write(session_state_path_for_history(&new), "{}").unwrap();

        let report = prune_session_history(tmp.path(), 1).unwrap();

        assert_eq!(report.kept_sessions, 1);
        assert_eq!(report.deleted_sessions, 2);
        assert_eq!(report.deleted_files.len(), 5);
        assert!(!old.exists());
        assert!(!session_state_path_for_history(&old).exists());
        assert!(!exit_diagnostic_path_for_history(&old).exists());
        assert!(old.with_extension("lease").exists());
        assert!(mid.with_extension("lease").exists());
        assert!(!mid.exists());
        assert!(!session_state_path_for_history(&mid).exists());
        assert!(new.exists());
        assert!(session_state_path_for_history(&new).exists());
    }

    #[test]
    fn prune_session_history_keeps_an_exclusively_leased_session() {
        let tmp = TempDir::new().unwrap();
        let history = tmp.path().join("active.jsonl");
        let lease_path = history.with_extension("lease");
        fs::write(&history, "{}\n").unwrap();
        fs::write(&lease_path, "").unwrap();
        let lease = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lease_path)
            .unwrap();
        lease.try_lock_exclusive().unwrap();

        let report = prune_session_history(tmp.path(), 0).unwrap();
        assert_eq!(report.kept_sessions, 1);
        assert_eq!(report.deleted_sessions, 0);
        assert!(history.exists());
        assert!(lease_path.exists());

        drop(lease);
        let report = prune_session_history(tmp.path(), 0).unwrap();
        assert_eq!(report.deleted_sessions, 1);
        assert!(!history.exists());
        assert!(lease_path.exists());
    }

    #[test]
    fn prune_session_history_creates_and_retains_missing_lease() {
        let tmp = TempDir::new().unwrap();
        let history = tmp.path().join("unleased.jsonl");
        let lease_path = history.with_extension("lease");
        fs::write(&history, "{}\n").unwrap();
        let report = prune_session_history(tmp.path(), 0).unwrap();
        assert_eq!(report.deleted_sessions, 1);
        assert_eq!(report.deleted_files, vec![history]);
        assert!(lease_path.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(lease_path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[cfg(unix)]
    #[test]
    fn prune_session_history_retains_existing_lease_inode() {
        use std::os::unix::fs::MetadataExt;
        let tmp = TempDir::new().unwrap();
        let history = tmp.path().join("stable.jsonl");
        let lease_path = history.with_extension("lease");
        fs::write(&history, "{}\n").unwrap();
        fs::write(&lease_path, "stable lease").unwrap();
        let old_handle = fs::OpenOptions::new().read(true).write(true).open(&lease_path).unwrap();
        let before = old_handle.metadata().unwrap();

        let report = prune_session_history(tmp.path(), 0).unwrap();

        assert_eq!(report.deleted_sessions, 1);
        let after = fs::metadata(&lease_path).expect("prune must retain the stable lease inode");
        assert_eq!((after.dev(), after.ino()), (before.dev(), before.ino()));
        assert_eq!(fs::read(&lease_path).unwrap(), b"stable lease");
        old_handle.try_lock_exclusive().unwrap();
        let later_handle = fs::OpenOptions::new().read(true).write(true).open(&lease_path).unwrap();
        assert_eq!(later_handle.try_lock_exclusive().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
        assert!(!report.deleted_files.contains(&lease_path));
    }

    #[cfg(unix)]
    #[test]
    fn prune_session_history_rejects_symlinked_lease_without_deleting_history() {
        let tmp = TempDir::new().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let history = tmp.path().join("linked.jsonl");
        let outside_file = outside.path().join("lease-target");
        fs::write(&history, "{}\n").unwrap();
        fs::write(&outside_file, "outside").unwrap();
        std::os::unix::fs::symlink(&outside_file, history.with_extension("lease")).unwrap();
        assert!(prune_session_history(tmp.path(), 0).is_err());
        assert!(history.exists());
        assert_eq!(fs::read(outside_file).unwrap(), b"outside");
    }

    #[test]
    fn export_and_import_snapshot_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("snapshot.json");
        let state = AppState::new("/tmp");
        state.add_message(Message::user_text("hello"));
        state.set_todos(vec![TodoItem {
            id: "1".into(),
            content: "test".into(),
            active_form: None,
            status: TodoStatus::InProgress,
        }]);
        state.export_snapshot(&path).unwrap();

        let new_state = AppState::new("/tmp");
        let count = new_state.import_snapshot(&path).unwrap();
        assert_eq!(count, 1);
        assert_eq!(new_state.messages().len(), 1);
        assert_eq!(new_state.todos().len(), 1);
    }

    #[test]
    fn resume_materializes_legacy_subagent_messages_in_fifo_order() {
        let tmp = TempDir::new().unwrap();
        let history = tmp.path().join("legacy-delivery.jsonl");
        let state = AppState::new(tmp.path());
        state.with_history_path(&history);
        state.add_message(Message::user_text("parent turn"));
        state.save_history().unwrap();
        let mut task = Task::new("legacy-agent", "legacy delivery");
        task.kind = TaskKind::Subagent;
        task.managed = true;
        task.status = TaskStatus::Running;
        task.pending_messages = vec!["first".to_string(), "second".to_string()];
        state.upsert_task(task);

        let resumed = AppState::new(tmp.path());
        resumed.resume_from_history(&history).unwrap();
        let task = resumed.task("legacy-agent").unwrap();
        assert!(task.pending_messages.is_empty());
        assert_eq!(
            task.message_queue
                .iter()
                .map(|message| message.body.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        assert_eq!(task.status, TaskStatus::Failed);

        let persisted = load_session_state(&session_state_path(tmp.path(), "legacy-delivery"))
            .unwrap();
        let persisted_task = &persisted.tasks["legacy-agent"];
        assert!(persisted_task.pending_messages.is_empty());
        assert_eq!(persisted_task.message_queue.len(), 2);
    }

    #[test]
    fn legacy_delivery_upgrade_creates_exact_rollback_backup_and_v2_sidecar() {
        let tmp = TempDir::new().unwrap();
        let history = tmp.path().join("legacy-upgrade.jsonl");
        let source = AppState::new(tmp.path());
        source.with_history_path(&history);
        source.add_message(Message::user_text("parent turn"));
        source.save_history().unwrap();

        let mut task = Task::new("legacy-upgrade-agent", "legacy delivery");
        task.kind = TaskKind::Subagent;
        task.managed = true;
        task.status = TaskStatus::Running;
        task.pending_messages = vec!["first".to_string(), "second".to_string()];
        let legacy = PersistedSessionState {
            schema_version: 1,
            delivery_format: None,
            cwd: Some(tmp.path().to_path_buf()),
            tasks: HashMap::from([(task.id.clone(), task)]),
            ..PersistedSessionState::default()
        };
        let sidecar = session_state_path(tmp.path(), "legacy-upgrade");
        let legacy_bytes = serde_json::to_vec_pretty(&legacy).unwrap();
        fs::write(&sidecar, &legacy_bytes).unwrap();

        let resumed = AppState::new(tmp.path());
        resumed.resume_from_history(&history).unwrap();

        let backup = sidecar.with_extension("pre-reliable-delivery.bak");
        assert_eq!(fs::read(&backup).unwrap(), legacy_bytes);
        let upgraded = load_session_state(&sidecar).unwrap();
        assert_eq!(upgraded.schema_version, SESSION_STATE_SCHEMA_VERSION);
        assert_eq!(
            upgraded.delivery_format.as_deref(),
            Some(RELIABLE_DELIVERY_FORMAT)
        );
        assert!(upgraded.tasks["legacy-upgrade-agent"].pending_messages.is_empty());
        assert_eq!(
            upgraded.tasks["legacy-upgrade-agent"].message_queue.len(),
            2
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(backup).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn future_delivery_sidecar_is_rejected_before_live_session_changes() {
        let tmp = TempDir::new().unwrap();
        let history = tmp.path().join("future-delivery.jsonl");
        let source = AppState::new(tmp.path());
        source.with_history_path(&history);
        source.add_message(Message::user_text("future source"));
        source.save_history().unwrap();
        let sidecar = session_state_path(tmp.path(), "future-delivery");
        fs::write(
            &sidecar,
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema_version": SESSION_STATE_SCHEMA_VERSION + 1,
                "delivery_format": "future_format"
            }))
            .unwrap(),
        )
        .unwrap();

        let target = AppState::new(tmp.path().join("live"));
        target.add_message(Message::user_text("keep live"));
        let session_id = target.session_id();
        let error = target.resume_from_history(&history).unwrap_err();

        assert!(error.to_string().contains("unsupported future schema version"));
        assert_eq!(target.session_id(), session_id);
        assert_eq!(target.messages()[0].preview(100), "keep live");
    }

    #[test]
    fn conflicting_legacy_and_reliable_queues_fail_closed_without_live_mutation() {
        let tmp = TempDir::new().unwrap();
        let history = tmp.path().join("conflicting-delivery.jsonl");
        let source = AppState::new(tmp.path());
        source.with_history_path(&history);
        source.add_message(Message::user_text("conflicting source"));
        source.save_history().unwrap();
        let mut task = Task::new("conflicting-agent", "conflicting delivery");
        task.kind = TaskKind::Subagent;
        task.managed = true;
        task.pending_messages.push("legacy".to_string());
        task.message_queue.push(QueuedAgentMessage::new("reliable"));
        let sidecar = session_state_path(tmp.path(), "conflicting-delivery");
        let state = PersistedSessionState {
            tasks: HashMap::from([(task.id.clone(), task)]),
            ..PersistedSessionState::default()
        };
        let original_sidecar = serde_json::to_vec_pretty(&state).unwrap();
        fs::write(&sidecar, &original_sidecar).unwrap();

        let target = AppState::new(tmp.path().join("live"));
        target.add_message(Message::user_text("keep live"));
        let session_id = target.session_id();
        let error = target.resume_from_history(&history).unwrap_err();

        assert!(error.to_string().contains("both legacy and reliable"));
        assert_eq!(target.session_id(), session_id);
        assert_eq!(target.messages()[0].preview(100), "keep live");
        assert_eq!(fs::read(sidecar).unwrap(), original_sidecar);
    }

    #[test]
    fn resume_requeues_lease_owned_by_interrupted_process() {
        let tmp = TempDir::new().unwrap();
        let history = tmp.path().join("leased-delivery.jsonl");
        let state = AppState::new(tmp.path());
        state.with_history_path(&history);
        state.add_message(Message::user_text("parent turn"));
        state.save_history().unwrap();
        let mut task = Task::new("leased-agent", "leased delivery");
        task.kind = TaskKind::Subagent;
        task.managed = true;
        task.status = TaskStatus::Running;
        state.upsert_task(task);
        state
            .enqueue_subagent_delivery("leased-agent", "survive restart")
            .unwrap()
            .unwrap();
        let claim = state
            .claim_next_subagent_delivery("leased-agent", 3600, 8)
            .unwrap();
        assert!(matches!(claim, AgentDeliveryClaimOutcome::Claimed(_)));

        let resumed = AppState::new(tmp.path());
        resumed.resume_from_history(&history).unwrap();
        let task = resumed.task("leased-agent").unwrap();
        assert_eq!(task.message_queue.len(), 1);
        assert_eq!(task.message_queue[0].status, AgentMessageStatus::Queued);
        assert!(task.message_queue[0].lease.is_none());
        assert_eq!(task.message_queue[0].attempts, 1);
    }

    #[test]
    fn reliable_enqueue_rolls_back_memory_when_sidecar_commit_fails() {
        let tmp = TempDir::new().unwrap();
        let history = tmp.path().join("delivery-persist-failure.jsonl");
        let sidecar = session_state_path(tmp.path(), "delivery-persist-failure");
        let state = AppState::new(tmp.path());
        state.with_history_path(&history);
        let mut task = Task::new("persist-agent", "persist delivery");
        task.kind = TaskKind::Subagent;
        task.managed = true;
        task.status = TaskStatus::Running;
        state.upsert_task(task);
        let _failpoint = install_atomic_replace_failpoint(sidecar.clone());

        let error = state
            .enqueue_subagent_delivery("persist-agent", "must not be reported queued")
            .expect_err("failed sidecar replacement must fail the reliable enqueue");

        assert!(error.to_string().contains("failed to persist reliable"));
        assert!(
            state
                .task("persist-agent")
                .unwrap()
                .message_queue
                .is_empty()
        );
        let persisted = load_session_state(&sidecar).unwrap();
        assert!(persisted.tasks["persist-agent"].message_queue.is_empty());
    }

    fn atomic_temp_paths(path: &Path) -> Vec<PathBuf> {
        let prefix = format!(
            ".{}.tmp-",
            path.file_name().unwrap_or_default().to_string_lossy()
        );
        path.parent()
            .into_iter()
            .flat_map(|parent| fs::read_dir(parent).into_iter().flatten())
            .flatten()
            .map(|entry| entry.path())
            .filter(|candidate| {
                candidate
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(&prefix))
            })
            .collect()
    }

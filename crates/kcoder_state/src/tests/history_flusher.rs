    #[tokio::test]
    async fn resume_from_history_restarts_history_flusher_for_resumed_path() {
        let tmp = TempDir::new().unwrap();
        let resumed_path = tmp.path().join("resumed-session.jsonl");
        let fresh_path = tmp.path().join("fresh-session.jsonl");
        append_history_entry(
            &resumed_path,
            &HistoryEntry {
                session_id: "resumed-session".to_string(),
                timestamp_ms: now_millis(),
                uuid: Some(generate_transcript_uuid()),
                parent_uuid: None,
                message: Message::user_text("before"),
            },
        );

        let state = AppState::new("/");
        state.with_history_path(&fresh_path);
        state.resume_from_history(&resumed_path).unwrap();
        state.add_message(Message::assistant_text("after resume"));
        drop(state);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        let entries = load_history(&resumed_path).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries.last().unwrap().session_id, "resumed-session");
        assert!(!fresh_path.exists());
    }

    #[tokio::test]
    async fn history_flusher_writes_entries() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("history.jsonl");
        let state = AppState::new("/");
        state.with_history_path(&path);
        state.add_message(Message::user_text("hello"));
        state.add_message(Message::assistant_text("hi"));

        // Drop the state to close the flusher channel and trigger a final flush.
        drop(state);
        // Give the background task a moment to finish writing.
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn resume_restores_last_assistant_timestamp_for_time_based_compaction() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("timestamped.jsonl");
        append_history_entry(
            &path,
            &HistoryEntry {
                session_id: "timestamped".to_string(),
                timestamp_ms: 1_000,
                uuid: Some("user-1".to_string()),
                parent_uuid: None,
                message: Message::user_text("hello"),
            },
        );
        append_history_entry(
            &path,
            &HistoryEntry {
                session_id: "timestamped".to_string(),
                timestamp_ms: 2_000,
                uuid: Some("assistant-1".to_string()),
                parent_uuid: Some("user-1".to_string()),
                message: Message::assistant_text("hi"),
            },
        );
        append_history_entry(
            &path,
            &HistoryEntry {
                session_id: "timestamped".to_string(),
                timestamp_ms: 3_000,
                uuid: Some("user-2".to_string()),
                parent_uuid: Some("assistant-1".to_string()),
                message: Message::user_text("continue"),
            },
        );

        let state = AppState::new(tmp.path());
        state.resume_from_history(&path).unwrap();

        assert_eq!(state.last_assistant_message_timestamp_ms(), Some(2_000));
    }

    #[tokio::test]
    async fn history_flusher_ingress_preserves_large_parent_chain_in_order() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("ingress.jsonl");
        let state = AppState::new("/");
        let (tx, mut rx) = mpsc::unbounded_channel();
        {
            let mut inner = state.inner.write().unwrap();
            let source = HistorySource::bind(&path).unwrap();
            inner.history_source = Some(source.clone());
            inner.history_flusher = Some(HistoryFlusher::new(tx, source));
        }

        for index in 0..5_000 {
            state.add_message(Message::user_text(format!("message-{index}")));
        }

        let mut previous_uuid = None;
        for index in 0..5_000 {
            let HistoryFlusherCommand::Entry(entry) =
                rx.try_recv().expect("every entry must remain queued").command
            else {
                panic!("add_message must enqueue only entry commands");
            };
            assert_eq!(entry.message.preview(32), format!("message-{index}"));
            assert_eq!(entry.parent_uuid, previous_uuid);
            previous_uuid = entry.uuid;
        }
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn direct_history_fallback_preserves_parent_chain_under_concurrency() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("fallback-history.jsonl");
        let state = AppState::new(tmp.path());
        {
            let mut inner = state.inner.write().unwrap();
            inner.history_path = Some(path.clone());
            inner.history_flusher = None;
            inner.history_source = Some(HistorySource::bind(&path).unwrap());
        }

        let workers = (0..8)
            .map(|worker| {
                let state = state.clone();
                std::thread::spawn(move || {
                    for index in 0..100 {
                        state.add_message(Message::user_text(format!("{worker}-{index}")));
                    }
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            worker.join().unwrap();
        }

        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 800);
        let mut previous_uuid = None;
        for entry in entries {
            assert_eq!(entry.parent_uuid, previous_uuid);
            previous_uuid = entry.uuid;
        }
    }

    #[tokio::test]
    async fn compaction_barrier_keeps_old_and_new_entries_on_opposite_sides() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("compaction-barrier.jsonl");
        let state = AppState::new(tmp.path());
        let (tx, mut rx) = mpsc::unbounded_channel();
        {
            let mut inner = state.inner.write().unwrap();
            inner.history_path = Some(path.clone());
            let source = HistorySource::bind(&path).unwrap();
            inner.history_source = Some(source.clone());
            inner.history_flusher = Some(HistoryFlusher::new(tx, source));
        }

        state.add_message(Message::user_text("old queued entry"));
        let compact_state = state.clone();
        let compact = tokio::spawn(async move {
            compact_state
                .set_messages_after_compaction(
                    vec![Message::user_text(
                        "Earlier conversation summary: compacted state",
                    )],
                    CompactionTranscriptEvent {
                        trigger: CompactionTrigger::Manual,
                        pre_tokens: 100,
                        post_tokens: 20,
                        summary: "compacted state".to_string(),
                    },
                )
                .await
                .unwrap();
        });

        let old = rx.recv().await.unwrap();
        let boundary = rx.recv().await.unwrap();
        assert!(matches!(
            boundary.command,
            HistoryFlusherCommand::AppendCompaction { .. }
        ));

        state.add_message(Message::user_text("new entry after compact command"));
        let new = rx.recv().await.unwrap();

        let queue = state.read_inner().history_flusher.as_ref().unwrap().queue.clone();
        process_history_flusher_command(&path, &queue, old);
        process_history_flusher_command(&path, &queue, boundary);
        process_history_flusher_command(&path, &queue, new);
        queue.flush(&path).unwrap();
        compact.await.unwrap();

        let lines = std::fs::read_to_string(&path).unwrap();
        let entries = lines
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0]["content"][0]["text"], "old queued entry");
        assert_eq!(entries[1]["subtype"], "compact_boundary");
        assert_eq!(entries[2]["isCompactSummary"], true);
        assert_eq!(
            entries[3]["content"][0]["text"],
            "new entry after compact command"
        );
        assert_eq!(entries[0]["parentUuid"], serde_json::Value::Null);
        assert_eq!(entries[1]["parentUuid"], serde_json::Value::Null);
        assert_eq!(entries[1]["logicalParentUuid"], entries[0]["uuid"]);
        assert_eq!(entries[2]["parentUuid"], entries[1]["uuid"]);
        assert_eq!(entries[3]["parentUuid"], entries[2]["uuid"]);
    }

    #[tokio::test]
    async fn flush_barrier_cannot_be_overtaken_by_a_new_entry() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("flush-barrier.jsonl");
        let state = AppState::new(tmp.path());
        let (tx, mut rx) = mpsc::unbounded_channel();
        {
            let mut inner = state.inner.write().unwrap();
            inner.history_path = Some(path.clone());
            let source = HistorySource::bind(&path).unwrap();
            inner.history_source = Some(source.clone());
            inner.history_flusher = Some(HistoryFlusher::new(tx, source));
        }

        state.add_message(Message::user_text("old queued entry"));
        let save_state = state.clone();
        let save = tokio::spawn(async move {
            save_state
                .set_messages_and_save_history(vec![Message::user_text("replacement")])
                .await
                .unwrap();
        });
        let old = rx.recv().await.unwrap();
        let flush = rx.recv().await.unwrap();
        assert!(matches!(flush.command, HistoryFlusherCommand::Flush(_)));

        state.add_message(Message::user_text("new entry after flush command"));
        let new = rx.recv().await.unwrap();

        let queue = state.read_inner().history_flusher.as_ref().unwrap().queue.clone();
        process_history_flusher_command(&path, &queue, old);
        process_history_flusher_command(&path, &queue, flush);
        process_history_flusher_command(&path, &queue, new);
        queue.flush(&path).unwrap();
        save.await.unwrap();

        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].message.preview(100), "old queued entry");
        assert_eq!(
            entries[1].message.preview(100),
            "new entry after flush command"
        );
        assert_eq!(entries[1].parent_uuid, entries[0].uuid);
    }

    #[test]
    fn history_flush_reports_write_failure_without_dropping_batch() {
        let tmp = TempDir::new().unwrap();
        let blocking_parent = tmp.path().join("not-a-directory");
        std::fs::write(&blocking_parent, "file").unwrap();
        let path = blocking_parent.join("history.jsonl");
        let mut batch = vec![HistoryEntry {
            session_id: "session".to_string(),
            timestamp_ms: 1,
            uuid: Some("entry".to_string()),
            parent_uuid: None,
	            message: Message::user_text("must survive failed flush"),
        }];

        let error = flush_history_batch(&path, &mut batch).unwrap_err();

        assert!(error.to_string().contains("not-a-directory"), "{error:#}");
        assert_eq!(batch.len(), 1, "failed flush must retain entries for retry");
    }

    #[tokio::test]
    async fn history_flush_barrier_propagates_write_failure() {
        let tmp = TempDir::new().unwrap();
        let blocking_parent = tmp.path().join("not-a-directory");
        let history_path = blocking_parent.join("history.jsonl");
        let source = HistorySource::bind(&history_path).unwrap();
        std::fs::write(&blocking_parent, "file").unwrap();
        let state = AppState::new(tmp.path());
        let (tx, rx) = mpsc::unbounded_channel();
        {
            let mut inner = state.inner.write().unwrap();
            inner.history_path = Some(history_path.clone());
            inner.history_source = Some(source.clone());
            inner.history_flusher = Some(HistoryFlusher::new(tx, source));
        }
        let queue = state.read_inner().history_flusher.as_ref().unwrap().queue.clone();
        tokio::spawn(history_flusher_task(history_path, rx, queue));
        state.add_message(Message::user_text("queued"));

        let error = state
            .set_messages_and_save_history(vec![Message::user_text("replacement")])
            .await
            .unwrap_err();

        assert!(error.to_string().contains("history"), "{error:#}");
    }
    #[tokio::test(flavor = "current_thread")]
    async fn synchronous_snapshot_supersedes_queued_entries() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("snapshot-queue.jsonl");
        let state = AppState::new(tmp.path());
        state.with_history_path(&path);
        state.add_message(Message::user_text("before snapshot"));
        state.save_history().unwrap();
        state.add_message(Message::assistant_text("after snapshot"));
        state.flush_history().await.unwrap();

        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 2, "snapshot entries must not be replayed");
        assert_eq!(entries[0].message.preview(100), "before snapshot");
        assert_eq!(entries[1].message.preview(100), "after snapshot");
        assert_eq!(entries[1].parent_uuid, entries[0].uuid);
    }

    #[tokio::test]
    async fn synchronous_snapshot_supersedes_buffered_entries() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("snapshot-batch.jsonl");
        let state = AppState::new(tmp.path());
        let (tx, mut rx) = mpsc::unbounded_channel();
        {
            let mut inner = state.inner.write().unwrap();
            inner.history_path = Some(path.clone());
            let source = HistorySource::bind(&path).unwrap();
            inner.history_source = Some(source.clone());
            inner.history_flusher = Some(HistoryFlusher::new(tx, source));
        }
        state.add_message(Message::user_text("buffered before snapshot"));
        let queue = state.read_inner().history_flusher.as_ref().unwrap().queue.clone();
        process_history_flusher_command(&path, &queue, rx.try_recv().unwrap());
        state.save_history().unwrap();
        state.add_message(Message::assistant_text("after snapshot"));
        process_history_flusher_command(&path, &queue, rx.try_recv().unwrap());
        queue.flush(&path).unwrap();
        assert_eq!(load_history(&path).unwrap().len(), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn uncertain_history_append_stays_faulted_until_explicit_snapshot() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("partial-history.jsonl");
        std::fs::write(&path, "{\"incomplete\":").unwrap();
        let state = AppState::new(tmp.path());
        state.with_history_path(&path);
        state.add_message(Message::user_text("retained in memory"));
        assert!(state.flush_history().await.is_err());
        let unchanged = std::fs::read(&path).unwrap();
        assert!(state.flush_history().await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), unchanged);

        state.save_history().unwrap();
        state.add_message(Message::assistant_text("after recovery"));
        state.flush_history().await.unwrap();
        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].message.preview(100), "retained in memory");
        assert_eq!(entries[1].message.preview(100), "after recovery");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn failed_snapshot_before_mutation_preserves_buffered_and_queued_entries() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("snapshot-failure.jsonl");
        let state = AppState::new(tmp.path());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let flusher = HistoryFlusher::new(tx, HistorySource::bind(&path).unwrap());
        let queue = flusher.queue.clone();
        {
            let mut inner = state.write_inner();
            inner.history_path = Some(path.clone());
            inner.history_flusher = Some(flusher);
            inner.history_source = Some(queue.source.clone());
        }
        state.add_message(Message::user_text("buffered"));
        process_history_flusher_command(&path, &queue, rx.try_recv().unwrap());
        state.add_message(Message::assistant_text("queued"));
        std::fs::create_dir(&path).unwrap();
        let error = state.save_history().unwrap_err();
        assert!(!crate::history_store::is_uncertain_mutation(&error));
        std::fs::remove_dir(&path).unwrap();

        process_history_flusher_command(&path, &queue, rx.try_recv().unwrap());
        queue.flush(&path).unwrap();
        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].message.preview(100), "buffered");
        assert_eq!(entries[1].message.preview(100), "queued");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn direct_history_fault_blocks_empty_flush_until_snapshot() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("direct-partial.jsonl");
        std::fs::write(&path, "{").unwrap();
        let state = AppState::new(tmp.path());
        state.write_inner().history_path = Some(path.clone());
        state.write_inner().history_source = Some(HistorySource::bind(&path).unwrap());
        state.add_message(Message::user_text("first"));
        assert!(state.flush_history().await.is_err());
        state.add_message(Message::assistant_text("second"));
        assert_eq!(std::fs::read(&path).unwrap(), b"{");
        assert!(state.flush_history().await.is_err());
        state.save_history().unwrap();
        state.flush_history().await.unwrap();
        assert_eq!(load_history(&path).unwrap().len(), 2);
    }

    #[test]
    fn direct_history_prewrite_failure_stays_faulted_until_snapshot() {
        let tmp = TempDir::new().unwrap();
        let blocked_parent = tmp.path().join("not-a-directory");
        let path = blocked_parent.join("history.jsonl");
        let state = AppState::new(tmp.path());
        state.with_deferred_history_path(&path);
        std::fs::write(&blocked_parent, "fixture blocker").unwrap();
        assert!(state.read_inner().history_flusher.is_none());
        state.add_message(Message::user_text("failed direct write"));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert!(runtime.block_on(state.flush_history()).is_err());

        std::fs::rename(&blocked_parent, tmp.path().join("saved-blocker")).unwrap();
        std::fs::create_dir(&blocked_parent).unwrap();
        state.add_message(Message::assistant_text("retained until snapshot"));
        assert!(runtime.block_on(state.flush_history()).is_err());
        assert!(!path.exists(), "direct writes must remain gated after the I/O cause is fixed");
        state.save_history().unwrap();
        state.add_message(Message::user_text("after recovery"));
        runtime.block_on(state.flush_history()).unwrap();
        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].message.preview(100), "failed direct write");
        assert_eq!(entries[1].message.preview(100), "retained until snapshot");
        assert_eq!(entries[2].message.preview(100), "after recovery");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn uncertain_snapshot_invalidates_old_commands_but_keeps_barriers_faulted() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("uncertain-snapshot.jsonl");
        let state = AppState::new(tmp.path());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let flusher = HistoryFlusher::new(tx, HistorySource::bind(&path).unwrap());
        let queue = flusher.queue.clone();
        {
            let mut inner = state.write_inner();
            inner.history_path = Some(path.clone());
            inner.history_flusher = Some(flusher);
            inner.history_source = Some(queue.source.clone());
        }
        state.add_message(Message::user_text("before uncertain snapshot"));
        let (done, result) = oneshot::channel();
        state.read_inner().history_flusher.as_ref().unwrap()
            .send(HistoryFlusherCommand::Flush(done)).unwrap();
        // A real half-record produces the same uncertainty classification as a failed replace.
        std::fs::write(&path, "{").unwrap();
        assert!(queue.replace_snapshot(|| crate::history_store::append_records(&path, b"{}\n")).is_err());
        while let Ok(command) = rx.try_recv() {
            process_history_flusher_command(&path, &queue, command);
        }
        assert!(result.await.unwrap().is_err());
        assert!(queue.flush(&path).is_err(), "empty batches must still expose the fault");
        assert_eq!(std::fs::read(&path).unwrap(), b"{");
        state.save_history().unwrap();
        queue.flush(&path).unwrap();
        assert_eq!(load_history(&path).unwrap().len(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn closed_history_worker_preserves_uncertain_fault_for_all_barriers() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("closed-worker.jsonl");
        std::fs::write(&path, "{").unwrap();
        let state = AppState::new(tmp.path());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let flusher = HistoryFlusher::new(tx, HistorySource::bind(&path).unwrap());
        let queue = flusher.queue.clone();
        {
            let mut inner = state.write_inner();
            inner.history_path = Some(path.clone());
            inner.history_flusher = Some(flusher);
            inner.history_source = Some(queue.source.clone());
        }
        state.add_message(Message::user_text("before worker exit"));
        process_history_flusher_command(&path, &queue, rx.try_recv().unwrap());
        assert!(queue.flush(&path).is_err());
        drop(rx);
        assert!(state.flush_history().await.is_err());
        assert!(state.set_messages_after_compaction(
            vec![Message::user_text("summary")],
            CompactionTranscriptEvent {
                trigger: CompactionTrigger::Manual,
                pre_tokens: 100,
                post_tokens: 10,
                summary: "summary".into(),
            },
        ).await.is_err());
        assert!(state.truncate_messages_for_rewind(0, 1).await.is_err());
        state.add_message(Message::user_text("after worker exit"));
        assert_eq!(std::fs::read(&path).unwrap(), b"{");
        state.save_history().unwrap();
        state.flush_history().await.unwrap();
        assert_eq!(load_history(&path).unwrap().len(), 1);
    }
    fn app_state_test_source_record(path: &Path, incarnation: uuid::Uuid) -> PathBuf {
        let controls = path.with_extension("hctl");
        fs::create_dir_all(&controls).unwrap();
        let marker = controls.join("source.json");
        fs::write(&marker, serde_json::to_vec(&serde_json::json!({
            "schema_version": 1, "incarnation": incarnation, "deleted": false,
        })).unwrap()).unwrap();
        marker
    }

    #[tokio::test(flavor = "current_thread")]
    async fn app_state_source_binding_rejects_changed_uuid_with_empty_queue() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("bound.jsonl");
        app_state_test_source_record(&path, uuid::Uuid::new_v4());
        let state = AppState::new(tmp.path());
        state.with_deferred_history_path(&path);
        state.add_message(Message::user_text("original"));
        state.flush_history().await.unwrap();
        let before = fs::read(&path).unwrap();
        app_state_test_source_record(&path, uuid::Uuid::new_v4());
        assert!(state.flush_history().await.is_err());
        state.add_message(Message::assistant_text("must not append"));
        assert!(state.flush_history().await.is_err());
        assert!(state.save_history().is_err());
        state.with_deferred_history_path(&path);
        assert!(state.save_history().is_err(), "same-path installation must not rebind");
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn app_state_source_binding_rejects_missing_marker_for_direct_writes() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("direct-bound.jsonl");
        let marker = app_state_test_source_record(&path, uuid::Uuid::new_v4());
        let state = AppState::new(tmp.path());
        state.with_deferred_history_path(&path);
        state.add_message(Message::user_text("original"));
        let before = fs::read(&path).unwrap();
        fs::rename(&marker, marker.with_extension("parked")).unwrap();
        state.add_message(Message::assistant_text("must not append"));
        assert!(state.save_history().is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(!marker.exists(), "an initialized writer must not recreate its source marker");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn app_state_source_binding_failure_cannot_fall_back_after_marker_repair() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("invalid-source.jsonl");
        let marker = app_state_test_source_record(&path, uuid::Uuid::new_v4());
        fs::write(&marker, "invalid control").unwrap();
        let state = AppState::new(tmp.path());
        state.with_history_path(&path);
        let sidecar = session_state_path_for_history(&path);
        assert!(!sidecar.exists(), "failed binding must not create a sidecar");
        app_state_test_source_record(&path, uuid::Uuid::new_v4());
        state.add_message(Message::user_text("must stay unbound"));
        assert!(state.flush_history().await.is_err());
        assert!(state.save_history().is_err());
        assert!(!path.exists());
        state.commit_session_state();
        assert!(!sidecar.exists(), "an unbound writer must not commit a sidecar after marker repair");
        fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        fs::write(&sidecar, b"existing sidecar fixture").unwrap();
        state.commit_session_state();
        assert_eq!(fs::read(&sidecar).unwrap(), b"existing sidecar fixture");
    }

    #[test]
    fn app_state_source_binding_failure_cannot_persist_orchestrate_mode() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("invalid-mode-source.jsonl");
        let marker = app_state_test_source_record(&path, uuid::Uuid::new_v4());
        fs::write(&marker, "invalid control").unwrap();
        let state = AppState::new(tmp.path());
        state.with_deferred_history_path(&path);
        assert!(state.read_inner().history_source.is_none());
        assert!(state.enter_orchestrate_before_first_message().is_err());
        assert!(!session_state_path_for_history(&path).exists());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn app_state_source_binding_deferred_and_empty_flush_do_not_create_files() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("missing-parent").join("deferred.jsonl");
        let state = AppState::new(tmp.path());
        state.with_deferred_history_path(&path);
        state.flush_history().await.unwrap();
        assert!(fs::read_dir(tmp.path()).unwrap().next().is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn app_state_source_binding_snapshot_and_worker_share_first_initialization() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("shared-source.jsonl");
        let first = AppState::new(tmp.path());
        let competing = AppState::new(tmp.path());
        first.with_deferred_history_path(&path);
        competing.with_deferred_history_path(&path);
        first.add_message(Message::user_text("included in snapshot"));
        first.save_history().unwrap();
        first.add_message(Message::assistant_text("same bound worker"));
        first.flush_history().await.unwrap();
        let before = fs::read(&path).unwrap();
        competing.add_message(Message::user_text("competing uninitialized writer"));
        assert!(competing.flush_history().await.is_err());
        assert!(competing.save_history().is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(load_history(&path).unwrap().len(), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn app_state_source_binding_stale_epoch_barrier_still_checks_identity() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("stale-epoch-source.jsonl");
        let source = HistorySource::bind(&path).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let flusher = HistoryFlusher::new(tx, source.clone());
        let queue = flusher.queue.clone();
        let state = AppState::new(tmp.path());
        {
            let mut inner = state.write_inner();
            inner.history_path = Some(path.clone());
            inner.history_source = Some(source);
            inner.history_flusher = Some(flusher);
        }
        state.add_message(Message::user_text("snapshot"));
        let (done, result) = oneshot::channel();
        state.read_inner().history_flusher.as_ref().unwrap()
            .send(HistoryFlusherCommand::Flush(done)).unwrap();
        state.save_history().unwrap();
        let before = fs::read(&path).unwrap();
        app_state_test_source_record(&path, uuid::Uuid::new_v4());
        while let Ok(command) = rx.try_recv() {
            process_history_flusher_command(&path, &queue, command);
        }
        assert!(result.await.unwrap().is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
    }

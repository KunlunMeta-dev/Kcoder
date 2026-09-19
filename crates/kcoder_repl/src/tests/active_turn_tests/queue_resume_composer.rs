#[test]
fn user_message_queue_has_hard_cap_and_can_be_cleared() {
    let mut app = ReplApp::default();

    assert_eq!(app.queue_status_label(), "");
    for idx in 0..USER_MESSAGE_QUEUE_MAX {
        assert!(app.enqueue_user_message_for_turn(Message::user_text(format!("queued {idx}"))));
    }
    assert!(!app.enqueue_user_message_for_turn(Message::user_text("overflow")));
    assert_eq!(app.queued_user_message_count(), USER_MESSAGE_QUEUE_MAX);
    assert_eq!(
        app.queue_status_label(),
        format!("queue {USER_MESSAGE_QUEUE_MAX} pending")
    );
    assert_eq!(app.clear_user_message_queue(), USER_MESSAGE_QUEUE_MAX);
    assert_eq!(app.queued_user_message_count(), 0);
    assert_eq!(app.queue_status_label(), "");
}

#[test]
fn compact_status_label_excludes_queued_preview_count() {
    let mut app = ReplApp::default();

    assert!(app.enqueue_user_message_for_turn(Message::user_text("follow up after this turn")));

    assert_eq!(app.queue_status_label(), "queue 1 pending");
    assert!(!app.compact_status_label().contains("queue 1 pending"));
}

#[test]
fn queued_user_messages_render_outside_transcript() {
    let mut app = ReplApp::default();

    assert!(app.enqueue_user_message_for_turn(Message::user_text("follow up after this turn")));
    let rendered = lines_to_text(&app.render_queued_user_message_lines(80));

    assert!(app.messages.is_empty());
    assert!(rendered.contains("Queued follow-up inputs"));
    assert!(!rendered.contains("1 pending"));
    assert!(rendered.contains("follow up after this turn"));
}

#[test]
fn pending_turn_steer_moves_into_transcript_at_applied_boundary() {
    let mut app = ReplApp::default();
    app.start_loading();
    app.append_streaming_text("answer before steer");
    let id = app.next_turn_steer_id();
    app.track_pending_turn_steer(
        id,
        QueuedUserMessage::from_model_message(Message::user_text("new constraint")),
    );

    let pending = lines_to_text(&app.render_queued_user_message_lines(96));
    assert!(pending.contains("Messages to be submitted after next tool call"));
    assert!(pending.contains("new constraint"));
    assert_eq!(app.queued_user_message_count(), 0);

    assert!(app.apply_pending_turn_steer(id));
    assert_eq!(
        messages_as_pairs(&app),
        vec![
            (MessageRole::Assistant, "answer before steer".to_string()),
            (MessageRole::User, "new constraint".to_string()),
        ]
    );
    assert!(app.pending_turn_steers.is_empty());
    assert!(app.render_queued_user_message_lines(96).is_empty());
}

#[test]
fn unapplied_turn_steer_becomes_priority_next_turn_input() {
    let mut app = ReplApp::default();
    let id = app.next_turn_steer_id();
    app.track_pending_turn_steer(
        id,
        QueuedUserMessage::from_model_message(Message::user_text("retry after turn")),
    );
    assert!(app.enqueue_user_message_for_turn(Message::user_text("ordinary queued")));

    assert_eq!(app.defer_unapplied_turn_steers(), 1);
    let pending = lines_to_text(&app.render_queued_user_message_lines(96));
    assert!(pending.contains("Messages to be submitted at end of turn"));
    assert!(pending.contains("retry after turn"));
    assert_eq!(app.queued_user_message_count(), 2);

    let first = app.pop_user_message_for_turn().expect("deferred steer");
    assert!(matches!(
        first,
        QueuedTurnInput::User { model_message, .. }
            if model_message.preview(200) == "retry after turn"
    ));
    let second = app
        .pop_user_message_for_turn()
        .expect("ordinary queued input");
    assert!(matches!(
        second,
        QueuedTurnInput::User { model_message, .. }
            if model_message.preview(200) == "ordinary queued"
    ));
}

#[test]
fn user_input_stays_after_live_subagent_output_at_both_submission_boundaries() {
    for steer in [false, true] {
        let mut app = ReplApp { fullscreen_surface: true, ..ReplApp::default() };
        app.push_message(MessageRole::User, "initial task");
        app.push_subagent_pending("spawn-1".into(), "spawn_agent".into(),
            serde_json::json!({"message": "background inspection"}).to_string());
        assert!(app.associate_subagent_panel("child-1", "spawn-1", true));
        app.append_streaming_text("response before pause");
        let input = Message::user_text("PAUSE_INPUT_SENTINEL");
        if steer {
            let id = app.next_turn_steer_id();
            app.track_pending_turn_steer(id, QueuedUserMessage::from_model_message(input));
            assert!(app.apply_pending_turn_steer(id));
        } else {
            app.push_scheduled_user_message(&input);
        }
        app.append_streaming_text("response after pause");
        let visible = app.messages.iter().cloned()
            .chain(app.active_turn_display_messages_for_render()).collect::<Vec<_>>();
        let before = visible.iter().position(|m| m.text.contains("response before pause")).unwrap();
        let user = visible.iter().position(|m| m.role == MessageRole::User && m.text == "PAUSE_INPUT_SENTINEL").unwrap();
        let after = visible.iter().position(|m| m.text.contains("response after pause")).unwrap();
        assert!(before < user && user < after, "user input must not move ahead of earlier live-panel output (steer={steer})");
        assert_eq!(app.scrollback_commit_target(0), 1, "native scrollback must still stop before the live panel");
        assert!(app.update_subagent_panel_progress("child-1", "Running read", Some("progress after user input"), Some(2), Some(60)));
        assert!(app.finish_subagent_panel("child-1", SubagentPhase::Completed, "Completed"));
        app.flush_active_turn();
        assert_eq!(app.messages.iter().filter(|m| m.text == "PAUSE_INPUT_SENTINEL").count(), 1);
        assert_eq!(app.messages.iter().filter(|m| panel_message_id(&m.text).is_some()).count(), 1);
        assert!(app.messages.iter().any(|m| m.text.contains("progress after user input")));
        let mut terminal = Terminal::with_options_and_cursor_position(
            CaptureBackend::new(100, 30), Position { x: 0, y: 0 },
        ).unwrap();
        terminal.set_viewport_area(Rect::new(0, 0, 100, 30));
        terminal.draw(|frame| app.draw(frame)).unwrap();
        let screen = buffer_dump(terminal.rendered_buffer_for_tests());
        assert!(screen.contains("PAUSE_INPUT_SENTINEL"), "{screen}");
    }
}

#[derive(Debug)]
struct GatedTuiSteerProvider {
    calls: AtomicUsize,
    requests: Arc<Mutex<Vec<kcoder_types::MessagesRequest>>>,
    first_started: Arc<tokio::sync::Notify>,
    release_first: Arc<tokio::sync::Notify>,
}

impl kcoder_api::Provider for GatedTuiSteerProvider {
    fn name(&self) -> &'static str {
        "gated-tui-steer"
    }

    fn stream_messages(
        &self,
        request: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let call = self.calls.fetch_add(1, AtomicOrdering::SeqCst);
        let first_started = Arc::clone(&self.first_started);
        let release_first = Arc::clone(&self.release_first);
        let start = futures::stream::iter([Ok(kcoder_types::StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: format!("tui-steer-{call}"),
                role: "assistant".to_string(),
                content: Vec::new(),
                model: "test".to_string(),
                stop_reason: None,
                stop_sequence: None,
                usage: None,
            },
        })]);
        let gate = futures::stream::once(async move {
            if call == 0 {
                first_started.notify_one();
                release_first.notified().await;
            }
            Ok::<_, kcoder_api::ApiErrorKind>(kcoder_types::StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text {
                    text: String::new(),
                },
            })
        });
        let rest = futures::stream::iter([
            Ok(kcoder_types::StreamEvent::ContentBlockDelta {
                index: 0,
                delta: kcoder_types::ContentDelta::TextDelta {
                    text: if call == 0 {
                        "first response".to_string()
                    } else {
                        "response after steer".to_string()
                    },
                },
            }),
            Ok(kcoder_types::StreamEvent::ContentBlockStop { index: 0 }),
            Ok(kcoder_types::StreamEvent::MessageStop),
        ]);
        Ok(Box::pin(start.chain(gate).chain(rest)))
    }
}

#[tokio::test]
async fn submitted_input_steers_live_tui_turn_instead_of_starting_new_turn() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let first_started = Arc::new(tokio::sync::Notify::new());
    let release_first = Arc::new(tokio::sync::Notify::new());
    let engine = test_engine_with_provider(
        tmp.path(),
        Arc::new(GatedTuiSteerProvider {
            calls: AtomicUsize::new(0),
            requests: Arc::clone(&requests),
            first_started: Arc::clone(&first_started),
            release_first: Arc::clone(&release_first),
        }),
    );
    let mut app = ReplApp::default();
    let (raw_tx, mut rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    assert!(
        !handle_submitted_message(
            SubmittedMessage::text("initial request".to_string()),
            &engine,
            &mut app,
            &tx,
            &prompt,
        )
        .await
        .unwrap()
    );
    assert!(
        !handle_submitted_message(
            SubmittedMessage::text("steer this turn".to_string()),
            &engine,
            &mut app,
            &tx,
            &prompt,
        )
        .await
        .unwrap()
    );
    assert_eq!(app.pending_turn_steers.len(), 1);
    assert_eq!(app.queued_user_message_count(), 0);
    tokio::time::timeout(Duration::from_secs(2), first_started.notified())
        .await
        .expect("first provider request should start");
    release_first.notify_one();

    loop {
        let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("live turn should continue")
            .expect("event channel should remain open");
        let finished = matches!(event, AppEvent::TurnFinished);
        let handled = handle_app_event(event, &mut app, &engine, &tx, &prompt).await;
        assert!(handled.action.is_none());
        if finished {
            break;
        }
    }
    while app.deferred_turn_finish_pending {
        let handled = handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;
        assert!(handled.action.is_none());
    }

    assert_eq!(requests.lock().unwrap().len(), 2);
    assert!(app.pending_turn_steers.is_empty());
    assert_eq!(app.queued_user_message_count(), 0);
    let messages = messages_as_pairs(&app);
    let first_response = messages
        .iter()
        .position(|(_, text)| text == "first response")
        .expect("first response in transcript");
    let steer = messages
        .iter()
        .position(|(role, text)| *role == MessageRole::User && text == "steer this turn")
        .expect("steer in transcript");
    let second_response = messages
        .iter()
        .position(|(_, text)| text == "response after steer")
        .expect("second response in transcript");
    assert!(first_response < steer && steer < second_response);
}

#[test]
fn queued_user_message_preview_height_stays_bounded_at_queue_cap() {
    let mut app = ReplApp::default();
    for idx in 0..USER_MESSAGE_QUEUE_MAX {
        assert!(
            app.enqueue_user_message_for_turn(Message::user_text(format!(
                "queued follow-up {idx}"
            )))
        );
    }

    let preview = app.pending_input_preview();
    let rendered = lines_to_text(&preview.lines(80));

    assert!(rendered.contains("queued follow-up 0"));
    assert!(rendered.contains("queued follow-up 2"));
    assert!(!rendered.contains("queued follow-up 3"));
    assert!(rendered.contains("+61 more queued"));
    assert!(
        preview.desired_height(80) <= 6,
        "queued preview should keep a stable bottom-pane height even at queue cap"
    );
}

#[test]
fn tab_submits_draft_when_idle() {
    let mut app = ReplApp::default();
    app.input = "run tests".to_string();
    app.cursor_grapheme_index = app.input_graphemes().len();

    let action = app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));

    assert!(matches!(
        action,
        Some(UserAction::Submit(submitted)) if submitted.text == "run tests"
    ));
    assert!(app.input.is_empty());
}

#[test]
fn tab_submits_draft_for_queueing_while_streaming() {
    let mut app = ReplApp::default();
    app.input = "follow up after this turn".to_string();
    app.cursor_grapheme_index = app.input_graphemes().len();
    app.start_loading();

    let action = app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));

    assert!(matches!(
        action,
        Some(UserAction::Submit(submitted)) if submitted.text == "follow up after this turn"
    ));
    assert!(app.input.is_empty());
}

#[test]
fn enter_submits_bang_prompt_as_shell_action() {
    let mut app = ReplApp::default();
    app.input = "!echo hi".to_string();
    app.cursor_grapheme_index = app.input_graphemes().len();

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert!(matches!(
        action,
        Some(UserAction::RunShellCommand { command, history_text })
            if command == "echo hi" && history_text == "!echo hi"
    ));
    assert!(app.input.is_empty());
}

#[test]
fn bang_enters_shell_prompt_immediately() {
    let mut app = ReplApp::default();

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('!'), KeyModifiers::NONE));

    assert!(action.is_none());
    assert_eq!(app.input, "!");
    assert_eq!(app.cursor_grapheme_index, 1);
}

#[test]
fn tab_does_not_submit_bang_shell_prompt_when_idle() {
    let mut app = ReplApp::default();
    app.input = "!ls".to_string();
    app.cursor_grapheme_index = app.input_graphemes().len();

    let action = app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));

    assert!(action.is_none());
    assert_eq!(app.input, "!ls");
}

#[test]
fn shell_prompt_display_absorbs_bang_for_cursor_math() {
    let mut app = ReplApp::default();
    app.input = "!git".to_string();
    app.cursor_grapheme_index = app.input_graphemes().len();

    assert_eq!(app.composer_display_text(), "git");
    assert_eq!(app.composer_display_cursor_visual_position(80), (0, 3));
}

#[test]
fn esc_exits_empty_shell_prompt() {
    let mut app = ReplApp::default();
    app.input = "!".to_string();
    app.cursor_grapheme_index = app.input_graphemes().len();

    let action = app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert!(action.is_none());
    assert!(app.input.is_empty());
    assert_eq!(app.cursor_grapheme_index, 0);
    assert!(!app.edit_previous_primed);
}

#[test]
fn esc_keeps_nonempty_shell_prompt() {
    let mut app = ReplApp::default();
    app.input = "!g".to_string();
    app.cursor_grapheme_index = app.input_graphemes().len();

    let action = app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert!(action.is_none());
    assert_eq!(app.input, "!g");
    assert!(!app.edit_previous_primed);
}

#[tokio::test]
async fn shell_action_queues_while_turn_is_running() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(async {
        std::future::pending::<()>().await;
    });
    app.begin_turn(handle, cancel.clone());
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let should_quit = handle_user_action(
        UserAction::RunShellCommand {
            command: "echo hi".to_string(),
            history_text: "!echo hi".to_string(),
        },
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await
    .unwrap();

    assert!(!should_quit);
    assert_eq!(app.queued_user_message_count(), 1);
    let queued = app.user_message_queue.front().unwrap();
    assert_eq!(queued.action, QueuedInputAction::RunShell);
    assert_eq!(queued.restore_text, "!echo hi");
    let handle = app.abort_turn_for_shutdown().unwrap();
    let _ = handle.await;
}

#[tokio::test]
async fn fatal_event_writes_exit_diagnostic_sidecar() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let history_path = tmp.path().join("session.jsonl");
    engine.state.with_history_path(&history_path);
    let mut task = kcoder_state::Task::new("job-1", "still running");
    task.status = TaskStatus::Running;
    engine.state.upsert_task(task);
    let mut app = ReplApp::default();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let handled = handle_app_event(
        AppEvent::Fatal("exit requested by SIGTERM".to_string()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;

    assert!(matches!(handled.action, Some(UserAction::Quit)));
    let diagnostic_path = history_path.with_extension("exit.jsonl");
    let content = std::fs::read_to_string(diagnostic_path).unwrap();
    let entry: serde_json::Value = serde_json::from_str(content.lines().next().unwrap()).unwrap();
    assert_eq!(entry["event"], "fatal");
    assert_eq!(entry["reason"], "exit requested by SIGTERM");
    assert_eq!(entry["pid"].as_u64(), Some(u64::from(std::process::id())));
    assert_eq!(
        entry["cwd"].as_str(),
        Some(tmp.path().to_string_lossy().as_ref())
    );
    assert_eq!(
        entry["history_path"].as_str(),
        Some(history_path.to_string_lossy().as_ref())
    );
    assert_eq!(
        entry["model"].as_str(),
        Some(Settings::default().model.as_str())
    );
    assert_eq!(
        entry["provider"].as_str(),
        Settings::default().provider.as_deref()
    );
    assert_eq!(entry["active_tasks"][0]["id"], "job-1");
    assert_eq!(entry["active_tasks"][0]["status"], "running");
}

#[test]
fn engine_failure_events_write_exit_diagnostic_sidecar() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let history_path = tmp.path().join("session.jsonl");
    engine.state.with_history_path(&history_path);

    append_repl_engine_event_diagnostic(&engine, &EngineEvent::Error("provider down".into()));
    append_repl_engine_event_diagnostic(
        &engine,
        &EngineEvent::StreamAborted {
            reason: "stream idle".into(),
        },
    );
    append_repl_engine_event_diagnostic(
        &engine,
        &EngineEvent::CompactionFailed {
            error: "too large".into(),
            details: None,
        },
    );
    append_repl_engine_event_diagnostic(
        &engine,
        &EngineEvent::CompactionRecovered {
            details: kcoder_engine::context::CompactionFailureDetails {
                phase: "auto_full".into(),
                reason: "protocol_tag_count".into(),
                opening_summary_tags: 2,
                closing_summary_tags: 1,
                response_chars: 6842,
                response_fingerprint: "deadbeef".into(),
                stop_reason: Some("end_turn".into()),
                attempt: 1,
                will_retry: true,
                state_mutated: false,
            },
        },
    );
    append_repl_engine_event_diagnostic(
        &engine,
        &EngineEvent::BackgroundJobFailed {
            id: "task-1".into(),
            error: "boom".into(),
        },
    );

    let diagnostic_path = history_path.with_extension("exit.jsonl");
    let content = std::fs::read_to_string(diagnostic_path).unwrap();
    let entries = content
        .lines()
        .map(serde_json::from_str::<serde_json::Value>)
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    let events = entries
        .iter()
        .map(|entry| entry["event"].as_str().unwrap())
        .collect::<Vec<_>>();
    let reasons = entries
        .iter()
        .map(|entry| entry["reason"].as_str().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(
        events,
        vec![
            "engine_error",
            "stream_aborted",
            "compaction_failed",
            "background_job_failed"
        ]
    );
    assert_eq!(
        reasons,
        vec!["provider down", "stream idle", "too large", "task-1: boom"]
    );
}

#[test]
fn recovered_compaction_maps_to_an_informational_notice() {
    let event = engine_event_to_app_event(EngineEvent::CompactionRecovered {
        details: kcoder_engine::context::CompactionFailureDetails {
            phase: "auto_full".into(),
            reason: "protocol_tag_count".into(),
            opening_summary_tags: 2,
            closing_summary_tags: 1,
            response_chars: 6842,
            response_fingerprint: "deadbeef".into(),
            stop_reason: Some("end_turn".into()),
            attempt: 1,
            will_retry: true,
            state_mutated: false,
        },
    });

    assert!(matches!(
        event,
        Some(AppEvent::SystemNotice(text))
            if text.contains("Compaction recovered") && text.contains("protocol_tag_count")
    ));
}

#[tokio::test]
async fn slash_action_queues_while_turn_is_running_without_validation() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(async {
        std::future::pending::<()>().await;
    });
    app.begin_turn(handle, cancel.clone());
    let (raw_tx, mut rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let should_quit = handle_user_action(
        UserAction::SlashCommand("/does-not-exist".to_string()),
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await
    .unwrap();

    assert!(!should_quit);
    assert_eq!(app.queued_user_message_count(), 1);
    let queued = app.user_message_queue.front().unwrap();
    assert_eq!(queued.action, QueuedInputAction::Slash);
    assert_eq!(queued.restore_text, "/does-not-exist");
    assert!(rx.try_recv().is_err());
    let handle = app.abort_turn_for_shutdown().unwrap();
    let _ = handle.await;
}

#[tokio::test]
async fn immediate_agent_control_bypasses_active_parent_turn_queue() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let agent_id = "agent-immediate-steer";
    let mut task = kcoder_state::Task::new(agent_id, "General agent: active child");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.status = TaskStatus::Running;
    task.parent_session_id = Some(engine.state.session_id());
    task.arrangement_mode = Some(false);
    task.agent_kind = Some("general".to_string());
    task.agent_provider = Some(engine.provider_name());
    task.agent_model = Some(engine.model_name());
    engine.state.upsert_task(task);

    let mut app = ReplApp::default();
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(async {
        std::future::pending::<()>().await;
    });
    app.begin_turn(handle, cancel);
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let should_quit = handle_user_action(
        UserAction::SlashCommand(format!(
            "/agent steer {agent_id} change only this child"
        )),
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await
    .unwrap();

    assert!(!should_quit);
    assert_eq!(app.queued_user_message_count(), 0);
    assert!(app.pending_turn_steers.is_empty());
    let task = engine.state.task(agent_id).unwrap();
    assert_eq!(task.message_queue.len(), 1);
    assert_eq!(task.message_queue[0].body, "change only this child");
    let handle = app.abort_turn_for_shutdown().unwrap();
    let _ = handle.await;
}

#[tokio::test]
async fn selected_agent_submit_never_enters_parent_turn_steer_mailbox() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let agent_id = "agent-selected-view";
    let mut task = kcoder_state::Task::new(agent_id, "General agent: selected view");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.status = TaskStatus::Running;
    task.parent_session_id = Some(engine.state.session_id());
    task.arrangement_mode = Some(false);
    task.agent_kind = Some("general".to_string());
    task.agent_provider = Some(engine.provider_name());
    task.agent_model = Some(engine.model_name());
    engine.state.upsert_task(task);

    let mut app = ReplApp::default();
    app.enter_agent_view(agent_id.to_string(), agent_id.to_string());
    let handle = tokio::spawn(async {
        std::future::pending::<()>().await;
    });
    app.begin_turn(handle, CancellationToken::new());
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let should_quit = handle_user_action(
        UserAction::Submit(SubmittedMessage::text("only change this agent".to_string())),
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await
    .unwrap();

    assert!(!should_quit);
    assert!(app.pending_turn_steers.is_empty());
    assert_eq!(app.queued_user_message_count(), 0);
    let task = engine.state.task(agent_id).unwrap();
    assert_eq!(task.message_queue.len(), 1);
    assert_eq!(task.message_queue[0].body, "only change this agent");
    assert!(engine.state.messages().is_empty());
    assert_eq!(
        app.agent_view
            .as_ref()
            .and_then(|view| view.steer_status.as_deref()),
        Some("Steering queued (queued_live)")
    );
    assert!(!app.apply_subagent_steer_to_panel(
        agent_id,
        &task.message_queue[0].message_id,
        0
    ));
    assert_eq!(
        app.agent_view
            .as_ref()
            .and_then(|view| view.steer_status.as_deref()),
        Some("Steering applied")
    );
    let handle = app.abort_turn_for_shutdown().unwrap();
    let _ = handle.await;
}

#[tokio::test]
async fn escape_leaves_agent_view_without_interrupting_parent_turn() {
    let mut app = ReplApp::default();
    app.enter_agent_view("agent-1".to_string(), "agent-1".to_string());
    let handle = tokio::spawn(async {
        std::future::pending::<()>().await;
    });
    app.begin_turn(handle, CancellationToken::new());

    let action = app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert!(action.is_none());
    assert!(app.agent_view.is_none());
    assert!(app.has_interruptible_turn());
    let handle = app.abort_turn_for_shutdown().unwrap();
    let _ = handle.await;
}

#[test]
fn agent_view_renders_child_transcript_and_restores_parent_viewport() {
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "PARENT_TRANSCRIPT_SENTINEL");
    app.transcript_viewport
        .set_position(TranscriptScroll::at_line(12));
    app.enter_agent_view_with_transcript(
        "agent-1".to_string(),
        "agent-1".to_string(),
        std::path::PathBuf::from("/tmp/agent-1-transcript.json"),
        vec![Message::user_text("CHILD_TRANSCRIPT_SENTINEL")],
        None,
    );
    assert!(app.transcript_viewport.is_at_tail());

    app.fullscreen_surface = true;
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(100, 30),
        Position { x: 0, y: 0 },
    )
    .unwrap();
    terminal.set_viewport_area(Rect::new(0, 0, 100, 30));
    terminal.draw(|frame| app.draw(frame)).unwrap();
    let child = buffer_dump(terminal.rendered_buffer_for_tests());
    assert!(child.contains("CHILD_TRANSCRIPT_SENTINEL"));
    assert!(!child.contains("PARENT_TRANSCRIPT_SENTINEL"));

    assert!(app.leave_agent_view());
    assert_eq!(
        app.transcript_viewport.position(),
        TranscriptScroll::at_line(12)
    );
    terminal.draw(|frame| app.draw(frame)).unwrap();
    let parent = buffer_dump(terminal.rendered_buffer_for_tests());
    assert!(parent.contains("PARENT_TRANSCRIPT_SENTINEL"));
    assert!(!parent.contains("CHILD_TRANSCRIPT_SENTINEL"));
}

#[tokio::test]
async fn agent_picker_lists_descriptions_and_enters_selected_canonical_id() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    for (id, description) in [("job-100", "Review architecture"), ("job-200", "Check concurrency")] {
        let mut task = kcoder_state::Task::new(id, format!("Explore agent: {description}"));
        task.kind = kcoder_state::TaskKind::Subagent;
        task.status = TaskStatus::Running;
        task.parent_session_id = Some(engine.state.session_id());
        engine.state.upsert_task(task);
    }
    let mut foreign = kcoder_state::Task::new("foreign", "another session");
    foreign.kind = kcoder_state::TaskKind::Subagent;
    foreign.parent_session_id = Some("different owner".into());
    engine.state.upsert_task(foreign);
    let mut app = ReplApp { input: "preserved draft".into(), fullscreen_surface: true, ..ReplApp::default() };
    handle_slash_command("/agent list", &mut app, &engine).await;
    let picker = app.picker_overlay.as_ref().unwrap();
    assert_eq!(picker.item_values, ["job-100", "job-200"]);
    assert!(picker.all_items[0].contains("Review architecture"));
    assert!(picker.all_items[1].contains("Check concurrency"));
    assert!(app.messages.is_empty());
    let mut terminal = Terminal::with_options_and_cursor_position(CaptureBackend::new(100, 30), Position { x: 0, y: 0 }).unwrap();
    terminal.set_viewport_area(Rect::new(0, 0, 100, 30));
    terminal.draw(|frame| app.draw(frame)).unwrap();
    let screen = buffer_dump(terminal.rendered_buffer_for_tests());
    for text in ["Sub-agents", "job-100", "Review architecture", "job-200", "Check concurrency"] { assert!(screen.contains(text), "{text}: {screen}"); }
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    let Some(UserAction::SlashCommand(command)) = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)) else { panic!("selection must enter an agent"); };
    assert_eq!(command, "/agent view job-200");
    handle_slash_command(&command, &mut app, &engine).await;
    assert_eq!(app.viewed_agent_id(), Some("job-200"));
    assert_eq!(app.input, "preserved draft");
    assert_eq!(engine.state.task("job-100").unwrap().status, TaskStatus::Running);
}

#[tokio::test]
async fn agent_picker_search_refresh_and_escape_preserve_identity_and_draft() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp { input: "draft".into(), ..ReplApp::default() };
    handle_slash_command("/agent list", &mut app, &engine).await;
    assert!(app.picker_overlay.as_ref().unwrap().all_items.is_empty());
    assert!(app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)).is_none());
    for id in ["job-200", "job-100"] {
        let mut task = kcoder_state::Task::new(id, format!("Review agent: Scope {id}"));
        task.kind = kcoder_state::TaskKind::Subagent;
        task.parent_session_id = Some(engine.state.session_id());
        engine.state.upsert_task(task);
        slash::refresh_agent_picker(&mut app, &engine);
    }
    let picker = app.picker_overlay.as_ref().unwrap();
    assert_eq!(picker.item_values[picker.matches_indexed()[picker.selected].0], "job-200");
    engine.state.update_task("job-200", |task| task.status = TaskStatus::Completed);
    slash::refresh_agent_picker(&mut app, &engine);
    assert!(app.picker_overlay.as_ref().unwrap().all_items[1].contains("completed"));
    for ch in "Scope job-100".chars() { app.handle_key(KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE)); }
    assert_eq!(app.picker_overlay.as_ref().unwrap().matches().len(), 1);
    let Some(UserAction::SlashCommand(command)) = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)) else { panic!("filtered selection missing"); };
    assert_eq!(command, "/agent view job-100");
    handle_slash_command("/agent list", &mut app, &engine).await;
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.picker_overlay.is_none());
    assert_eq!(app.input, "draft");
}

#[test]
fn agent_view_scroll_geometry_ignores_the_live_parent_turn() {
    fn draw_child_view(parent_active: bool) -> (usize, String) {
        let mut app = ReplApp {
            fullscreen_surface: true,
            active_turn: parent_active.then(ActiveCell::default),
            ..ReplApp::default()
        };
        let transcript = (0..30)
            .map(|index| Message::assistant_text(format!("child-chunk-{index:02}")))
            .collect::<Vec<_>>();
        app.enter_agent_view_with_transcript(
            "agent-scroll".to_string(),
            "agent-scroll".to_string(),
            std::path::PathBuf::from("/tmp/agent-scroll-transcript.json"),
            transcript,
            None,
        );
        app.transcript_viewport = TranscriptViewport::with_layout(
            TranscriptScroll::from_tail(3),
            100,
            20,
            None,
        );

        let mut terminal = Terminal::with_options_and_cursor_position(
            CaptureBackend::new(100, 30),
            Position { x: 0, y: 0 },
        )
        .unwrap();
        terminal.set_viewport_area(Rect::new(0, 0, 100, 30));
        terminal.draw(|frame| app.draw(frame)).unwrap();
        (
            app.transcript_viewport.live_content_rows(),
            buffer_dump(terminal.rendered_buffer_for_tests()),
        )
    }

    let (idle_rows, idle_screen) = draw_child_view(false);
    let (active_rows, active_screen) = draw_child_view(true);

    assert_eq!(
        active_rows, idle_rows,
        "父 Turn 是否运行不能改变 child transcript 的 scrollbar 总行数"
    );
    assert_eq!(
        active_screen
            .lines()
            .filter(|line| line.contains("child-chunk-"))
            .count(),
        idle_screen
            .lines()
            .filter(|line| line.contains("child-chunk-"))
            .count(),
        "父 Turn 运行时 Agent View 不得把可见正文替换成空行"
    );
}

#[test]
fn agent_live_projection_updates_text_and_tools_without_moving_review_or_parent() {
    use kcoder_engine::agent_live_view::AgentLiveSnapshot;
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "parent only");
    app.enter_agent_view("child".into(), "child".into());
    let mut snapshot = AgentLiveSnapshot {
        revision: 1, messages: Arc::new(vec![Message::user_text("child only")]),
        pending_text: "partial".into(), text_truncated: false, phase: "Writing response".into(),
    };
    app.apply_agent_live_snapshot(snapshot.clone());
    assert!(app.transcript_viewport.is_at_tail());
    app.transcript_viewport.set_position(TranscriptScroll::at_line(3));
    snapshot.pending_text.push_str(" final");
    snapshot.revision += 1;
    app.apply_agent_live_snapshot(snapshot.clone());
    assert_eq!(app.transcript_viewport.position(), TranscriptScroll::at_line(3));
    snapshot.pending_text.clear();
    snapshot.messages = Arc::new(vec![Message::user_text("child only"), Message::assistant_text("partial final")]);
    snapshot.phase = "Running bash".into();
    snapshot.revision += 1;
    app.apply_agent_live_snapshot(snapshot);
    let view = app.agent_view.as_ref().unwrap();
    assert_eq!(view.transcript.iter().filter(|m| m.text.contains("partial final")).count(), 1);
    assert!(view.transcript.iter().any(|m| m.text.contains("Running bash")));
    assert!(!view.transcript.iter().any(|m| m.text.contains("parent only")));
    assert!(!app.messages.iter().any(|m| m.text.contains("partial")));
    app.leave_agent_view();
    assert!(app.messages.iter().any(|m| m.text.contains("parent only")));
}

#[tokio::test]
async fn agent_view_unchanged_tick_keeps_live_polling_without_parent_activity() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    app.enter_agent_view("child".into(), "child".into());
    let (raw_tx, _rx) = mpsc::channel(16);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    let handled = handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;
    assert!(app.needs_scheduled_frame_tick());
    assert!(handled.redraw, "没有新快照的 tick 也必须续订下一次刷新，不能等待任务完成事件唤醒");
}

#[test]
fn agent_live_tail_stays_by_composer_and_preserves_review_geometry() {
    use kcoder_engine::agent_live_view::AgentLiveSnapshot;
    let mut app = ReplApp { fullscreen_surface: true, ..ReplApp::default() };
    app.enter_agent_view("child".into(), "child".into());
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 30), Position { x: 0, y: 0 },
    ).unwrap();
    terminal.set_viewport_area(Rect::new(0, 0, 80, 30));
    let mut snapshot = AgentLiveSnapshot {
        revision: 1, messages: Arc::new(vec![Message::user_text("child task")]),
        pending_text: "live-line-001\n".into(), text_truncated: false, phase: "Writing response".into(),
    };
    for count in [1, 40, 180] {
        snapshot.pending_text = (1..=count).map(|n| format!("live-line-{n:03}\n")).collect();
        snapshot.revision += 1;
        app.apply_agent_live_snapshot(snapshot.clone());
        terminal.draw(|frame| app.draw(frame)).unwrap();
        let screen = buffer_dump(terminal.rendered_buffer_for_tests());
        let area = app.transcript_viewport.transcript_area().unwrap();
        let last = screen.lines().position(|line| line.contains("Agent status: Writing response")).unwrap();
        assert!(last + 3 >= usize::from(area.bottom()), "实时状态与输入框之间不能留下大片空白: {screen}");
        assert!(screen.contains(&format!("live-line-{count:03}")), "{screen}");
        assert!(app.transcript_viewport.is_at_tail());
    }
    app.transcript_viewport.set_position(TranscriptScroll::from_tail(3));
    terminal.draw(|frame| app.draw(frame)).unwrap();
    let old_top = app.transcript_viewport.resolve_top(
        app.transcript_viewport.content_rows(), app.transcript_viewport.viewport_rows(),
    );
    let old_rows = app.transcript_viewport.content_rows();
    snapshot.pending_text.push_str("live-line-181\n");
    snapshot.revision += 1;
    app.apply_agent_live_snapshot(snapshot);
    assert_eq!(app.transcript_viewport.content_rows(), old_rows, "更新内容后，下一帧前必须保留滚轮使用的已显示几何");
    terminal.draw(|frame| app.draw(frame)).unwrap();
    assert_eq!(app.transcript_viewport.resolve_top(app.transcript_viewport.content_rows(), app.transcript_viewport.viewport_rows()), old_top);
    assert!(!app.transcript_viewport.is_at_tail());
}

#[tokio::test]
async fn agent_view_refresh_replaces_pending_item_once_and_preserves_scroll_anchor() {
    let tmp = tempfile::tempdir().unwrap();
    let transcript = tmp.path().join("child-transcript.json");
    std::fs::write(
        &transcript,
        serde_json::to_vec(&vec![Message::user_text("child initial")]).unwrap(),
    )
    .unwrap();
    let engine = test_engine(tmp.path());
    let mut task = kcoder_state::Task::new("agent-refresh", "General agent: refresh");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.status = TaskStatus::Running;
    task.parent_session_id = Some(engine.state.session_id());
    task.transcript_path = Some(transcript.clone());
    engine.state.upsert_task(task);
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "parent remains isolated");
    app.enter_agent_view_from_task(
        &engine,
        "agent-refresh".to_string(),
        "agent-refresh".to_string(),
    )
    .await
    .unwrap();
    app.transcript_viewport
        .set_position(TranscriptScroll::at_line(4));
    assert!(app.queue_agent_view_steer(
        "agent-refresh",
        "msg-refresh",
        "child redirected"
    ));

    std::fs::write(
        &transcript,
        serde_json::to_vec(&vec![
            Message::user_text("child initial"),
            Message::user_text("child redirected"),
        ])
        .unwrap(),
    )
    .unwrap();
    assert!(app.finish_agent_view_steer("agent-refresh", "msg-refresh"));
    assert!(app.refresh_agent_view_transcript(&engine, true).await);

    let view = app.agent_view.as_ref().unwrap();
    assert_eq!(
        view.transcript
            .iter()
            .filter(|message| message.text.contains("child redirected"))
            .count(),
        1
    );
    assert!(
        view.transcript
            .iter()
            .all(|message| !message.text.contains("Steering queued"))
    );
    assert_eq!(
        app.transcript_viewport.position(),
        TranscriptScroll::at_line(4)
    );
    assert!(
        app.messages
            .iter()
            .any(|message| message.text == "parent remains isolated")
    );
}

#[tokio::test]
async fn queued_slash_action_executes_when_turn_is_idle() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    assert!(
        app.enqueue_user_message_for_turn(QueuedUserMessage::from_slash_command(
            "/mention".to_string()
        ))
    );
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let started = try_start_next_turn(&engine, &mut app, &tx, &prompt)
        .await
        .unwrap()
        .started();

    assert!(!started);
    assert_eq!(app.input, "@");
    assert_eq!(app.cursor_grapheme_index, 1);
    assert_eq!(app.queued_user_message_count(), 0);
    assert!(app.messages.is_empty());
}

#[tokio::test]
async fn queued_quit_action_propagates_shutdown() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    assert!(
        app.enqueue_user_message_for_turn(QueuedUserMessage::from_slash_command(
            "/quit".to_string()
        ))
    );
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let outcome = try_start_next_turn(&engine, &mut app, &tx, &prompt)
        .await
        .unwrap();

    assert!(
        matches!(outcome, StartTurnOutcome::Quit),
        "a queued /quit must propagate shutdown instead of being swallowed"
    );
}

#[tokio::test]
async fn background_followups_wait_for_all_agents_and_start_one_aggregate_turn() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    engine.settings.write().unwrap().goal_max_auto_continuations = 1;
    let goal = engine.state.set_goal("aggregate agent results", None);
    let mut app = ReplApp::default();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let mut completed = kcoder_state::Task::new("agent-a", "first agent");
    completed.kind = kcoder_state::TaskKind::Subagent;
    completed.status = TaskStatus::Completed;
    engine.state.upsert_task(completed);

    let mut running = kcoder_state::Task::new("agent-b", "second agent");
    running.kind = kcoder_state::TaskKind::Subagent;
    running.status = TaskStatus::Running;
    engine.state.upsert_task(running);

    app.pending_background_followups
        .push_back(PendingBackgroundFollowup {
            ids: vec!["agent-a".to_string()],
            events: vec!["[completed: agent-a]".to_string()],
            summary: "[completed: agent-a]".to_string(),
        });

    let started = try_start_next_turn(&engine, &mut app, &tx, &prompt)
        .await
        .unwrap()
        .started();
    assert!(!started, "aggregation must wait while agent-b is running");
    assert_eq!(app.pending_background_followups.len(), 1);

    engine.state.update_task("agent-b", |task| {
        task.status = TaskStatus::Completed;
    });
    app.pending_background_followups
        .push_back(PendingBackgroundFollowup {
            ids: vec!["agent-b".to_string()],
            events: vec!["[completed: agent-b]".to_string()],
            summary: "[completed: agent-b]".to_string(),
        });

    let started = try_start_next_turn(&engine, &mut app, &tx, &prompt)
        .await
        .unwrap()
        .started();
    assert!(
        started,
        "all terminal agents should trigger one aggregate turn"
    );
    assert!(app.pending_background_followups.is_empty());
    assert_eq!(
        app.goal_auto_continuations_started.get(&goal.goal_id),
        Some(&1)
    );
    assert_eq!(engine.state.goal().unwrap().continuation_count, 1);

    let nudge = engine
        .state
        .messages()
        .iter()
        .map(|message| message.preview(1_000))
        .find(|text| text.contains("background sub-agent"))
        .expect("aggregate follow-up context");
    assert_eq!(nudge.matches("[completed: agent-a]").count(), 1);
    assert_eq!(nudge.matches("[completed: agent-b]").count(), 1);
    assert!(nudge.contains("All tracked background sub-agents have finished"));
    assert!(!nudge.contains("do not block waiting for additional sub-agents"));

    if let Some(handle) = app.abort_turn_for_shutdown() {
        let _ = handle.await;
    }
}

#[tokio::test]
async fn paused_subagent_does_not_block_the_aggregate_turn() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let mut paused = kcoder_state::Task::new("agent-paused", "paused agent");
    paused.kind = kcoder_state::TaskKind::Subagent;
    paused.status = TaskStatus::Paused;
    paused.notify_parent_on_completion = true;
    engine.state.upsert_task(paused);
    let mut completed = kcoder_state::Task::new("agent-a", "first agent");
    completed.kind = kcoder_state::TaskKind::Subagent;
    completed.status = TaskStatus::Completed;
    engine.state.upsert_task(completed);
    app.pending_background_followups
        .push_back(PendingBackgroundFollowup {
            ids: vec!["agent-a".to_string()],
            events: vec!["[completed: agent-a]".to_string()],
            summary: "[completed: agent-a]".to_string(),
        });

    let started = try_start_next_turn(&engine, &mut app, &tx, &prompt)
        .await
        .unwrap()
        .started();
    assert!(
        started,
        "a paused agent neither notifies nor recovers and must not gate the aggregate turn"
    );
    assert!(app.pending_background_followups.is_empty());
    assert!(engine.state.messages().iter().any(|message| {
        message
            .preview(1_000)
            .contains("All tracked background sub-agents have finished")
    }));

    if let Some(handle) = app.abort_turn_for_shutdown() {
        let _ = handle.await;
    }
}

#[tokio::test]
async fn a_paused_agent_alone_does_not_gate_aggregate_turns() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());

    let mut paused = kcoder_state::Task::new("job-paused", "Implementer agent: patch");
    paused.kind = kcoder_state::TaskKind::Subagent;
    paused.notify_parent_on_completion = true;
    paused.status = kcoder_state::TaskStatus::Paused;
    engine.state.upsert_task(paused);
    assert!(
        !has_nonterminal_background_subagents(&engine),
        "a paused agent must not count as non-terminal"
    );

    // A running sibling still gates: results may still be incoming.
    let mut running = kcoder_state::Task::new("job-running", "Explore agent: survey");
    running.kind = kcoder_state::TaskKind::Subagent;
    running.notify_parent_on_completion = true;
    running.status = kcoder_state::TaskStatus::Running;
    engine.state.upsert_task(running);
    assert!(has_nonterminal_background_subagents(&engine));
}

#[tokio::test]
async fn background_followup_cannot_bypass_the_goal_auto_continuation_limit() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    engine.settings.write().unwrap().goal_max_auto_continuations = 0;
    engine.state.set_goal("finish it", None);
    let mut app = ReplApp::default();
    let mut completed = kcoder_state::Task::new("agent-a", "first agent");
    completed.kind = kcoder_state::TaskKind::Subagent;
    completed.status = TaskStatus::Completed;
    engine.state.upsert_task(completed);
    app.pending_background_followups
        .push_back(PendingBackgroundFollowup {
            ids: vec!["agent-a".to_string()],
            events: vec!["[completed: agent-a]".to_string()],
            summary: "[completed: agent-a]".to_string(),
        });
    let (raw_tx, mut rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let outcome = try_start_next_turn(&engine, &mut app, &tx, &prompt)
        .await
        .unwrap();

    assert_eq!(outcome, StartTurnOutcome::Idle);
    assert_eq!(app.pending_background_followups.len(), 1);
    assert_eq!(engine.state.goal().unwrap().continuation_count, 0);
    assert!(app.goal_auto_continuations_started.is_empty());
    assert!(matches!(
        rx.recv().await,
        Some(AppEvent::SystemNotice(text))
            if text.contains("[goal_auto_continuation_limit]")
    ));
}

#[tokio::test]
async fn scheduled_user_message_allows_immediate_visible_redraw() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    let emitted_at = Instant::now();
    app.frame_rate_limiter.mark_emitted(emitted_at);
    assert!(
        app.frame_rate_limiter
            .time_until_next_draw(emitted_at + Duration::from_millis(1))
            .is_some()
    );
    assert!(app.enqueue_user_message_for_turn(Message::user_text("plain test message")));
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let started = try_start_next_turn(&engine, &mut app, &tx, &prompt)
        .await
        .unwrap()
        .started();

    assert!(started);
    assert!(app.turn_state.is_active());
    assert!(
        app.frame_rate_limiter
            .time_until_next_draw(emitted_at + Duration::from_millis(1))
            .is_none(),
        "the submitted user message must be drawable before fast model events coalesce it away"
    );
    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(role, text)| *role == MessageRole::User && text == "plain test message")
    );
    let handle = app.abort_turn_for_shutdown().unwrap();
    let _ = handle.await;
}

#[tokio::test]
async fn rapid_page_scrolls_coalesce_without_resetting_frame_limiter() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let emitted_at = Instant::now();
    let mut app = ReplApp {
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            120,
            20,
            None,
        ),
        ..ReplApp::default()
    };
    app.frame_rate_limiter.mark_emitted(emitted_at);
    assert!(
        app.frame_rate_limiter
            .time_until_next_draw(emitted_at + Duration::from_millis(1))
            .is_some()
    );
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let (batch_tx, mut batch_rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    for key in [
        KeyCode::PageUp,
        KeyCode::PageUp,
        KeyCode::PageUp,
        KeyCode::PageDown,
        KeyCode::PageDown,
        KeyCode::PageDown,
    ] {
        batch_tx
            .try_send(AppEvent::Terminal(CEvent::Key(KeyEvent::new(
                key,
                KeyModifiers::NONE,
            ))))
            .unwrap();
    }

    let handled = handle_event_batch(
        batch_rx.recv().await.unwrap(),
        &mut app,
        &engine,
        &tx,
        &prompt,
        &mut batch_rx,
    )
    .await;

    assert!(handled.redraw);
    assert!(app.transcript_viewport.position().is_at_tail());
    assert!(
        app.time_until_next_viewport_draw(emitted_at + Duration::from_millis(1))
            .is_some(),
        "rapid page scrolls should coalesce at the interaction rate instead of resetting the limiter for every key"
    );
}

#[tokio::test]
async fn tool_phase_transitions_flush_before_queued_completion() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    app.start_loading();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    let (batch_tx, mut batch_rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);

    for event in [
        AppEvent::ToolInputProgress {
            name: "write".to_string(),
            chars: 0,
        },
        AppEvent::ToolUseStarted {
            id: "write-1".to_string(),
            name: "write".to_string(),
            input: r#"{"file_path":"story.txt","content":"hello"}"#.to_string(),
        },
        AppEvent::ToolResult {
            id: "write-1".to_string(),
            name: "write".to_string(),
            text: "File created successfully".to_string(),
            is_error: false,
        },
    ] {
        batch_tx.try_send(event).unwrap();
    }

    let preparing = handle_event_batch(
        batch_rx.recv().await.unwrap(),
        &mut app,
        &engine,
        &tx,
        &prompt,
        &mut batch_rx,
    )
    .await;
    assert!(preparing.flush_frame);
    assert_eq!(app.spinner.preparing_tool_progress(), Some(("write", 0)));
    assert_eq!(
        batch_rx.len(),
        2,
        "tool start and result must remain queued"
    );

    let running = handle_event_batch(
        batch_rx.recv().await.unwrap(),
        &mut app,
        &engine,
        &tx,
        &prompt,
        &mut batch_rx,
    )
    .await;
    assert!(running.flush_frame);
    assert!(matches!(
        app.active_turn
            .as_ref()
            .and_then(|active| active.entries.last()),
        Some(ActiveEntry::Tool(ToolStatus::Running { name, .. })) if name == "write"
    ));
    assert_eq!(
        batch_rx.len(),
        1,
        "tool result must wait for the running frame"
    );

    let completed = handle_event_batch(
        batch_rx.recv().await.unwrap(),
        &mut app,
        &engine,
        &tx,
        &prompt,
        &mut batch_rx,
    )
    .await;
    assert!(!completed.flush_frame);
    assert!(matches!(
        app.active_turn
            .as_ref()
            .and_then(|active| active.entries.last()),
        Some(ActiveEntry::Tool(ToolStatus::Done { id, .. })) if id == "write-1"
    ));
}

#[tokio::test]
async fn ordinary_mouse_move_is_quiet_to_avoid_scrollbar_hover_jitter() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp {
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            110,
            10,
            Some(Rect::new(99, 0, 1, 20)),
        ),
        ..ReplApp::default()
    };
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    let mouse = MouseEvent {
        kind: MouseEventKind::Moved,
        column: 20,
        row: 5,
        modifiers: KeyModifiers::NONE,
    };

    let handled = handle_app_event(
        AppEvent::Terminal(CEvent::Mouse(mouse)),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;

    assert!(handled.action.is_none());
    assert!(!handled.redraw);
    assert_eq!(app.last_mouse_pos, Some((20, 5)));
}

fn write_test_history(path: &Path, session_id: &str, text: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    let entry = kcoder_state::HistoryEntry {
        session_id: session_id.to_string(),
        timestamp_ms: 1,
        uuid: None,
        parent_uuid: None,
        message: Message::user_text(text),
    };
    std::fs::write(
        path,
        format!("{}\n", serde_json::to_string(&entry).unwrap()),
    )
    .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn slash_resume_without_args_reads_project_scoped_sessions_by_default() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = tmp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let config_home = tmp.path().join("xdg");
    let _env_lock = ENV_LOCK.lock().await;
    let _config = EnvVarGuard::set("KCODER_CONFIG_DIR", &config_home);
    let _history_override = EnvVarGuard::remove("KCODER_HISTORY_DIR");

    let project_dir = Settings::project_data_dir(&workspace).unwrap();
    write_test_history(&project_dir.join("older.jsonl"), "older", "older request");
    write_test_history(
        &project_dir.join("latest.jsonl"),
        "latest",
        "latest request",
    );
    let legacy_history_dir = Settings::config_dir().unwrap().join("history");
    write_test_history(
        &legacy_history_dir.join("legacy.jsonl"),
        "legacy",
        "legacy request",
    );

    let engine = test_engine_with_settings(&workspace, Settings::default());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/resume", &mut app, &engine).await;

    assert!(action.is_none());
    let picker = app
        .resume_session_picker
        .as_ref()
        .expect("resume picker should open");
    let ids: Vec<_> = picker
        .entries
        .iter()
        .map(|entry| entry.session_id.as_str())
        .collect();
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&"older"));
    assert!(ids.contains(&"latest"));
    assert!(!ids.contains(&"legacy"));
    assert!(
        picker
            .entries
            .iter()
            .all(|entry| entry.path.parent() == Some(project_dir.as_path()))
    );
}

#[tokio::test]
async fn slash_resume_without_args_opens_picker_instead_of_latest_session() {
    let tmp = tempfile::tempdir().unwrap();
    let history_dir = tmp.path().join("history");
    write_test_history(&history_dir.join("older.jsonl"), "older", "older request");
    write_test_history(
        &history_dir.join("latest.jsonl"),
        "latest",
        "latest request",
    );
    let settings = Settings {
        history_directory: Some(history_dir),
        ..Settings::default()
    };
    let engine = test_engine_with_settings(tmp.path(), settings);
    let mut app = ReplApp::default();

    let action = handle_slash_command("/resume", &mut app, &engine).await;

    assert!(action.is_none());
    assert!(app.resume_session_picker.is_some());
    assert!(engine.state.messages().is_empty());
    assert_eq!(app.resume_session_picker.as_ref().unwrap().entries.len(), 2);
}

#[tokio::test(flavor = "current_thread")]
async fn slash_resume_all_includes_other_project_sessions() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = tmp.path().join("workspace");
    let other_workspace = tmp.path().join("other-workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&other_workspace).unwrap();
    let config_home = tmp.path().join("xdg");
    let _env_lock = ENV_LOCK.lock().await;
    let _config = EnvVarGuard::set("KCODER_CONFIG_DIR", &config_home);
    let _history_override = EnvVarGuard::remove("KCODER_HISTORY_DIR");

    let project_dir = Settings::project_data_dir(&workspace).unwrap();
    let other_project_dir = Settings::project_data_dir(&other_workspace).unwrap();
    write_test_history(
        &project_dir.join("current.jsonl"),
        "current",
        "current request",
    );
    write_test_history(
        &other_project_dir.join("other.jsonl"),
        "other",
        "other request",
    );
    let engine = test_engine_with_settings(&workspace, Settings::default());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/resume", &mut app, &engine).await;
    assert!(action.is_none());
    let picker = app
        .resume_session_picker
        .as_ref()
        .expect("resume picker should open");
    let same_project_ids: Vec<_> = picker
        .entries
        .iter()
        .map(|entry| entry.session_id.as_str())
        .collect();
    assert!(same_project_ids.contains(&"current"));
    assert!(!same_project_ids.contains(&"other"));

    let mut app = ReplApp::default();
    let action = handle_slash_command("/resume --all", &mut app, &engine).await;

    assert!(action.is_none());
    let picker = app
        .resume_session_picker
        .as_ref()
        .expect("resume picker should open");
    let ids: Vec<_> = picker
        .entries
        .iter()
        .map(|entry| entry.session_id.as_str())
        .collect();
    assert!(ids.contains(&"current"));
    assert!(ids.contains(&"other"));
}

#[tokio::test(flavor = "current_thread")]
async fn slash_resume_from_repo_root_includes_subdirectory_sessions() {
    let tmp = tempfile::tempdir().unwrap();
    let repo_root = tmp.path().join("repo");
    let package_a = repo_root.join("packages/a");
    std::fs::create_dir_all(&package_a).unwrap();
    let config_home = tmp.path().join("xdg");
    let _env_lock = ENV_LOCK.lock().await;
    let _config = EnvVarGuard::set("KCODER_CONFIG_DIR", &config_home);
    let _history_override = EnvVarGuard::remove("KCODER_HISTORY_DIR");

    let package_project_dir = Settings::project_data_dir(&package_a).unwrap();
    write_test_history(
        &package_project_dir.join("package-a-session.jsonl"),
        "package-a-session",
        "subdir request",
    );
    let engine = test_engine_with_settings(&repo_root, Settings::default());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/resume", &mut app, &engine).await;

    assert!(action.is_none());
    let picker = app
        .resume_session_picker
        .as_ref()
        .expect("resume picker should open");
    assert!(
        picker
            .entries
            .iter()
            .any(|entry| entry.session_id == "package-a-session")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn slash_resume_all_rejects_a_different_engine_project() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = tmp.path().join("workspace");
    let other_workspace = tmp.path().join("other-workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&other_workspace).unwrap();
    let config_home = tmp.path().join("xdg");
    let _env_lock = ENV_LOCK.lock().await;
    let _config = EnvVarGuard::set("KCODER_CONFIG_DIR", &config_home);
    let _history_override = EnvVarGuard::remove("KCODER_HISTORY_DIR");

    let other_project_dir = Settings::project_data_dir(&other_workspace).unwrap();
    let other_history = other_project_dir.join("other-session.jsonl");
    let source_state = kcoder_state::AppState::new(&other_workspace);
    source_state.with_history_path(&other_history);
    source_state.add_message(Message::user_text("other project request"));
    source_state.save_history().unwrap();

    let engine = test_engine_with_settings(&workspace, Settings::default());
    let original_session_id = engine.state.session_id();
    let mut app = ReplApp::default();

    let action = handle_slash_command("/resume --all other-session", &mut app, &engine).await;

    assert!(action.is_none());
    assert_eq!(engine.state.session_id(), original_session_id);
    assert_eq!(engine.state.cwd(), workspace);
    assert!(engine.state.history_path().is_none());
    assert!(app.messages.iter().any(|message| {
        message.text.contains("belongs to")
            && message.text.contains("Start KCoder from that directory")
    }));
}

#[tokio::test(flavor = "current_thread")]
async fn slash_resume_all_refuses_cross_project_session_without_cwd_metadata() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = tmp.path().join("workspace");
    let other_workspace = tmp.path().join("other-workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&other_workspace).unwrap();
    let config_home = tmp.path().join("xdg");
    let _env_lock = ENV_LOCK.lock().await;
    let _config = EnvVarGuard::set("KCODER_CONFIG_DIR", &config_home);
    let _history_override = EnvVarGuard::remove("KCODER_HISTORY_DIR");

    let other_project_dir = Settings::project_data_dir(&other_workspace).unwrap();
    let old_history = other_project_dir.join("old-other-session.jsonl");
    write_test_history(
        &old_history,
        "old-other-session",
        "old cross-project request",
    );
    let engine = test_engine_with_settings(&workspace, Settings::default());
    let original_session_id = engine.state.session_id();
    let mut app = ReplApp::default();

    let action = handle_slash_command("/resume --all old-other-session", &mut app, &engine).await;

    assert!(action.is_none());
    assert_eq!(engine.state.session_id(), original_session_id);
    assert!(engine.state.history_path().is_none());
    assert!(
        app.messages
            .iter()
            .any(|message| message.text.contains("working-directory metadata"))
    );
    assert!(
        !old_history
            .parent()
            .unwrap()
            .join("old-other-session/state.json")
            .exists()
    );
    assert!(!old_history.with_extension("state.json").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn slash_resume_with_session_id_uses_project_path_as_append_target() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = tmp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let config_home = tmp.path().join("xdg");
    let _env_lock = ENV_LOCK.lock().await;
    let _config = EnvVarGuard::set("KCODER_CONFIG_DIR", &config_home);
    let _history_override = EnvVarGuard::remove("KCODER_HISTORY_DIR");

    let project_dir = Settings::project_data_dir(&workspace).unwrap();
    let resumed_path = project_dir.join("project-session.jsonl");
    write_test_history(&resumed_path, "project-session", "before resume");
    let engine = test_engine_with_settings(&workspace, Settings::default());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/resume project-session", &mut app, &engine).await;

    assert!(action.is_none());
    assert_eq!(engine.state.session_id(), "project-session");
    assert_eq!(
        engine.state.history_path().as_deref(),
        Some(resumed_path.as_path())
    );
    engine
        .state
        .add_message(Message::assistant_text("after resume"));
    engine.state.save_history().unwrap();

    let entries = kcoder_state::load_history(&resumed_path).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries.last().unwrap().session_id, "project-session");
    assert_eq!(entries.last().unwrap().message.preview(100), "after resume");
}

#[test]
fn resume_session_picker_enter_returns_selected_history_path() {
    let first = PathBuf::from("/tmp/first.jsonl");
    let second = PathBuf::from("/tmp/second.jsonl");
    let mut app = ReplApp {
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            10,
            None,
        ),
        ..ReplApp::default()
    };
    app.open_resume_session_picker(vec![
        ResumeSessionEntry {
            session_id: "first".to_string(),
            path: first,
            message_count: 1,
            preview: Some("first prompt".to_string()),
        },
        ResumeSessionEntry {
            session_id: "second".to_string(),
            path: second.clone(),
            message_count: 2,
            preview: Some("second prompt".to_string()),
        },
    ]);

    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    match action {
        Some(UserAction::ResumeSession(path)) => assert_eq!(path, second),
        other => panic!("expected ResumeSession action, got {other:?}"),
    }
    assert!(app.resume_session_picker.is_none());
}

#[test]
fn resume_session_picker_lines_show_session_id_and_first_prompt() {
    let picker = ResumeSessionPicker {
        entries: vec![ResumeSessionEntry {
            session_id: "XXSAF".to_string(),
            path: PathBuf::from("/tmp/session-one.jsonl"),
            message_count: 3,
            preview: Some("review the compaction plan".to_string()),
        }],
        selected: 0,
        filter: String::new(),
    };

    let rendered = lines_to_text(&resume_session_picker_lines(&picker, 80, 10));

    assert!(rendered.contains("Resume a previous session"));
    assert!(rendered.contains("XXSAF:review the compaction plan"));
    assert!(!rendered.contains("3 messages"));
    assert!(!rendered.contains("session-one.jsonl"));
    assert!(!rendered.contains("ago"));
}

#[test]
fn resume_session_picker_entry_label_truncates_long_prompts() {
    let long_prompt = "x".repeat(60);
    let picker = ResumeSessionPicker {
        entries: vec![ResumeSessionEntry {
            session_id: "XXSAF".to_string(),
            path: PathBuf::from("/tmp/long.jsonl"),
            message_count: 1,
            preview: Some(format!("{long_prompt}…")),
        }],
        selected: 0,
        filter: String::new(),
    };

    let rendered = lines_to_text(&resume_session_picker_lines(&picker, 200, 10));

    assert!(rendered.contains("XXSAF:"));
    assert!(rendered.contains('…'));
}

#[tokio::test]
async fn turn_finished_defers_queued_user_message_until_next_wake() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(async {});
    app.begin_turn(handle, cancel.clone());
    app.append_streaming_text("previous answer");
    assert!(app.enqueue_user_message_for_turn(Message::user_text("queued follow-up")));
    let (raw_tx, mut rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let finished = handle_app_event(AppEvent::TurnFinished, &mut app, &engine, &tx, &prompt).await;

    assert!(finished.redraw);
    assert!(finished.action.is_none());
    assert_eq!(app.queued_user_message_count(), 1);
    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::Assistant, "previous answer".to_string())]
    );
    assert!(matches!(rx.recv().await, Some(AppEvent::TurnWakeRequested)));

    let started = try_start_next_turn(&engine, &mut app, &tx, &prompt)
        .await
        .unwrap()
        .started();

    assert!(started);
    assert_eq!(app.queued_user_message_count(), 0);
    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(role, text)| *role == MessageRole::User && text == "queued follow-up")
    );
    let handle = app.abort_turn_for_shutdown().unwrap();
    let _ = handle.await;
}

#[tokio::test]
async fn empty_shell_action_reports_help_without_starting_turn() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let should_quit = handle_user_action(
        UserAction::RunShellCommand {
            command: String::new(),
            history_text: "!".to_string(),
        },
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await
    .unwrap();

    assert!(!should_quit);
    assert!(!app.turn_state.is_active());
    let rendered = messages_as_pairs(&app)
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(rendered.contains(USER_SHELL_COMMAND_HELP_TITLE));
    assert!(rendered.contains(USER_SHELL_COMMAND_HELP_HINT));
}

#[tokio::test]
async fn idle_shell_action_starts_user_shell_task() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_default_tools(tmp.path());
    let mut app = ReplApp::default();
    let (raw_tx, mut rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let command = if cfg!(windows) {
        "Write-Output repl-shell-ok"
    } else {
        "printf repl-shell-ok"
    };
    let history_text = format!("!{command}");
    let expected_tool = if cfg!(windows) { "PowerShell" } else { "bash" };
    let should_quit = handle_user_action(
        UserAction::RunShellCommand {
            command: command.to_string(),
            history_text,
        },
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await
    .unwrap();

    assert!(!should_quit);
    assert!(app.turn_state.is_active());
    assert!(matches!(rx.recv().await, Some(AppEvent::TurnStarted)));
    let tool_started = rx.recv().await.expect("tool started");
    assert!(matches!(
        tool_started,
        AppEvent::ToolUseStarted { ref name, ref input, .. }
            if name == expected_tool && input.contains(command)
    ));
    let tool_result = rx.recv().await.expect("tool result");
    assert!(matches!(
        tool_result,
        AppEvent::ToolResult { ref name, ref text, is_error, .. }
            if name == expected_tool && text.contains("repl-shell-ok") && !is_error
    ));
    assert!(matches!(rx.recv().await, Some(AppEvent::TurnFinished)));

    let handle = app.finish_turn_state().unwrap();
    let _ = handle.await;
    app.set_loading(false);
}

#[tokio::test]
async fn queued_empty_shell_prompt_reports_help_and_drains_next_input() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    assert!(
        app.enqueue_user_message_for_turn(QueuedUserMessage::from_shell_prompt("!".to_string()))
    );
    assert!(app.enqueue_user_message_for_turn(Message::user_text("after shell help")));
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let started = try_start_next_turn(&engine, &mut app, &tx, &prompt)
        .await
        .unwrap()
        .started();

    assert!(started);
    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(role, text)| *role == MessageRole::System
                && text.contains(USER_SHELL_COMMAND_HELP_TITLE))
    );
    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(role, text)| *role == MessageRole::User && text == "after shell help")
    );
    assert_eq!(app.queued_user_message_count(), 0);
    assert_eq!(
        engine.state.messages(),
        vec![Message::user_text("after shell help")]
    );

    let handle = app.abort_turn_for_shutdown().unwrap();
    let _ = handle.await;
}

#[test]
fn alt_up_edits_latest_queued_user_message() {
    let mut app = ReplApp::default();
    assert!(app.enqueue_user_message_for_turn(Message::user_text("first queued")));
    assert!(app.enqueue_user_message_for_turn(Message::user_text("second queued")));

    let action = app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::ALT));

    assert!(action.is_none());
    assert_eq!(app.input, "second queued");
    assert_eq!(
        app.cursor_grapheme_index,
        "second queued".graphemes(true).count()
    );
    assert_eq!(app.queued_user_message_count(), 1);
    assert_eq!(
        app.user_message_queue
            .front()
            .map(|message| queued_user_message_preview(&message.model_message))
            .as_deref(),
        Some("first queued")
    );
}

#[test]
fn shift_left_edits_latest_queued_user_message() {
    let mut app = ReplApp::default();
    assert!(app.enqueue_user_message_for_turn(Message::user_text("first queued")));
    assert!(app.enqueue_user_message_for_turn(Message::user_text("second queued")));

    let action = app.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::SHIFT));

    assert!(action.is_none());
    assert_eq!(app.input, "second queued");
    assert_eq!(app.queued_user_message_count(), 1);
    assert_eq!(
        app.user_message_queue
            .front()
            .map(|message| queued_user_message_preview(&message.model_message))
            .as_deref(),
        Some("first queued")
    );
}

#[test]
fn edit_queued_user_message_restores_composer_sidecars() {
    let placeholder = "[Pasted Content 12 chars]".to_string();
    let image = local_image_placeholder(2);
    let submitted = SubmittedMessage {
        visible_text: format!("{image} {placeholder}"),
        text: format!("{image} abcdefghijkl"),
        images: vec![LocalImageAttachment {
            path: std::path::PathBuf::from("/tmp/example.png"),
            placeholder: image.clone(),
            media_type: "image/png".to_string(),
            clipboard_image: None,
        }],
        remote_image_urls: vec!["https://example.com/remote.png".to_string()],
        pending_pastes: vec![(placeholder.clone(), "abcdefghijkl".to_string())],
    };
    let model_message = Message::user_text("model-visible queued message");
    let mut app = ReplApp::default();
    assert!(
        app.enqueue_user_message_for_turn(QueuedUserMessage::from_submitted(
            model_message,
            &submitted,
        ))
    );

    let action = app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::ALT));

    assert!(action.is_none());
    assert_eq!(app.input, format!("{image} {placeholder}"));
    assert_eq!(app.local_image_attachments, submitted.images);
    assert_eq!(app.remote_image_urls, submitted.remote_image_urls);
    assert_eq!(app.pending_pastes, submitted.pending_pastes);
    assert_eq!(app.queued_user_message_count(), 0);
}

#[test]
fn local_image_placeholders_are_offset_after_remote_image_rows() {
    let first = LocalImageAttachment {
        path: std::path::PathBuf::from("/tmp/first.png"),
        placeholder: "[Image #1]".to_string(),
        media_type: "image/png".to_string(),
        clipboard_image: None,
    };
    let mut app = ReplApp {
        input: "[Image #1] describe".to_string(),
        cursor_grapheme_index: "[Image #1] describe".graphemes(true).count(),
        remote_image_urls: vec!["https://example.com/remote.png".to_string()],
        local_image_attachments: vec![first],
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.sync_composer_sidecars();

    assert_eq!(app.input, "[Image #2] describe");
    assert_eq!(app.local_image_attachments[0].placeholder, "[Image #2]");
}

#[test]
fn composer_height_for_width_reserves_remote_image_rows() {
    let mut app = ReplApp {
        input: "describe".to_string(),
        cursor_grapheme_index: "describe".graphemes(true).count(),
        ..ReplApp::default()
    };
    let base_height = composer_height_for_width(&app, 80);
    app.remote_image_urls = vec![
        "https://example.com/one.png".to_string(),
        "https://example.com/two.png".to_string(),
    ];

    assert_eq!(composer_height_for_width(&app, 80), base_height + 3);
}

#[test]
fn composer_height_can_grow_past_legacy_five_row_cap() {
    let input = (0..12).map(|_| "a").collect::<Vec<_>>().join("\n");
    let app = ReplApp {
        cursor_grapheme_index: input.graphemes(true).count(),
        input,
        ..ReplApp::default()
    };

    assert_eq!(composer_height_for_width(&app, 80), 14);
}

#[test]
fn composer_height_limit_preserves_half_screen_for_transcript() {
    let input = (0..20).map(|_| "a").collect::<Vec<_>>().join("\n");
    let app = ReplApp {
        cursor_grapheme_index: input.graphemes(true).count(),
        input,
        ..ReplApp::default()
    };
    let footer_height = app.footer_height();
    let (status_height, pending_height) = app.bottom_pane_stack_heights(80);
    let limit = composer_height_limit_for_terminal(
        12,
        status_height,
        pending_height,
        footer_height,
        todo_status_height(&app.todos),
    );
    let composer_height = composer_height_for_width_with_limit(&app, 80, Some(limit));

    assert_eq!(limit, 6);
    assert_eq!(composer_height, limit);
}

#[test]
fn composer_height_limit_caps_remote_image_rows() {
    let mut app = ReplApp {
        input: "describe".to_string(),
        cursor_grapheme_index: "describe".graphemes(true).count(),
        ..ReplApp::default()
    };
    app.remote_image_urls = (0..64)
        .map(|idx| format!("https://example.com/{idx}.png"))
        .collect();

    let footer_height = app.footer_height();
    let (status_height, pending_height) = app.bottom_pane_stack_heights(80);
    let limit = composer_height_limit_for_terminal(
        12,
        status_height,
        pending_height,
        footer_height,
        todo_status_height(&app.todos),
    );
    let composer_height = composer_height_for_width_with_limit(&app, 80, Some(limit));

    assert!(
        composer_height <= limit,
        "remote image preview rows must not force the live viewport beyond its bottom-pane budget"
    );
    assert_eq!(limit, 6);
}

#[test]
fn draw_reserves_remote_image_rows_in_composer_area() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 17 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 17, 80, 7));
    let mut app = ReplApp {
        input: "describe".to_string(),
        cursor_grapheme_index: "describe".graphemes(true).count(),
        remote_image_urls: vec![
            "https://example.com/one.png".to_string(),
            "https://example.com/two.png".to_string(),
        ],
        ..ReplApp::default()
    };

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    let footer_height = app.footer_height();
    let (status_height, pending_height) = app.bottom_pane_stack_heights(80);
    let composer_limit = composer_height_limit_for_terminal(
        terminal.viewport_area.height,
        status_height,
        pending_height,
        footer_height,
        todo_status_height(&app.todos),
    );
    assert_eq!(
        app.last_composer_area.expect("composer area").height,
        composer_height_for_width_with_limit(&app, 80, Some(composer_limit))
    );
    assert_eq!(
        app.last_composer_content.expect("composer content").height,
        MIN_COMPOSER_ROWS
    );
}

#[test]
fn footer_treats_remote_image_rows_as_draft() {
    let mut app = ReplApp {
        remote_image_urls: vec!["https://example.com/one.png".to_string()],
        ..ReplApp::default()
    };
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 12),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 12));

    terminal.draw(|frame| app.draw(frame)).unwrap();

    let rendered = buffer_dump(terminal.rendered_buffer_for_tests());
    assert!(rendered.contains("[Image #1]"));
    assert!(!rendered.contains("? for shortcuts"));
}

#[test]
fn up_at_composer_start_selects_last_remote_image_row() {
    let mut app = ReplApp {
        input: "describe".to_string(),
        cursor_grapheme_index: 0,
        remote_image_urls: vec![
            "https://example.com/one.png".to_string(),
            "https://example.com/two.png".to_string(),
        ],
        ..ReplApp::default()
    };

    let action = app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));

    assert!(action.is_none());
    assert_eq!(app.selected_remote_image_index, Some(1));
}

#[test]
fn remote_image_selection_moves_down_and_clears_after_last_row() {
    let mut app = ReplApp {
        remote_image_urls: vec![
            "https://example.com/one.png".to_string(),
            "https://example.com/two.png".to_string(),
        ],
        selected_remote_image_index: Some(0),
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(app.selected_remote_image_index, Some(1));

    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    assert_eq!(app.selected_remote_image_index, None);
}

#[test]
fn delete_selected_remote_image_relabels_local_placeholders() {
    let local = LocalImageAttachment {
        path: std::path::PathBuf::from("/tmp/local.png"),
        placeholder: "[Image #3]".to_string(),
        media_type: "image/png".to_string(),
        clipboard_image: None,
    };
    let mut app = ReplApp {
        input: "[Image #3] describe".to_string(),
        cursor_grapheme_index: "[Image #3] describe".graphemes(true).count(),
        remote_image_urls: vec![
            "https://example.com/one.png".to_string(),
            "https://example.com/two.png".to_string(),
        ],
        selected_remote_image_index: Some(0),
        local_image_attachments: vec![local],
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE));

    assert_eq!(
        app.remote_image_urls,
        vec!["https://example.com/two.png".to_string()]
    );
    assert_eq!(app.selected_remote_image_index, Some(0));
    assert_eq!(app.input, "[Image #2] describe");
    assert_eq!(app.local_image_attachments[0].placeholder, "[Image #2]");
}

#[test]
fn scheduled_queued_user_message_enters_transcript_at_turn_boundary() {
    let mut app = ReplApp::default();
    let message = Message::user_text("queued follow-up");

    app.push_scheduled_user_message(&message);

    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::User, "queued follow-up".to_string())]
    );
}

#[test]
fn scheduled_user_image_message_uses_single_codex_image_placeholder() {
    let mut app = ReplApp::default();
    let message = Message::user_content(vec![
        ContentBlock::Text {
            text: "[Image #1] describe this".to_string(),
        },
        ContentBlock::Image {
            source: kcoder_types::ImageSource::base64("image/png", "abc123"),
        },
    ]);

    app.push_scheduled_user_message(&message);

    assert_eq!(app.messages.len(), 1);
    assert_eq!(app.messages[0].role, MessageRole::User);
    assert_eq!(app.messages[0].text, "[Image #1] describe this");
    assert!(!app.messages[0].text.contains("[image:"));
}

#[test]
fn clear_resets_derived_transcript_state() {
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "hello");
    app.append_streaming_text("partial");
    app.scrollback_committed_until = 2;
    app.transcript_viewport.set_live_content_rows(42);
    app.input_scroll_row = 3;
    app.transcript_viewport.queue_wheel(ScrollDirection::Up);
    app.render_cache
        .insert(0, None, false, false, vec![Line::from("stale")]);

    app.reset_transcript_state_after_clear();

    assert!(app.messages.is_empty());
    assert_eq!(app.scrollback_committed_until, 0);
    assert_eq!(app.transcript_viewport.live_content_rows(), 0);
    assert_eq!(app.input_scroll_row, 0);
    assert_eq!(app.transcript_viewport.pending_delta(), 0);
    assert!(app.active_turn.is_none());
    assert!(app.render_cache.get(0, None, false, false).is_none());
}

#[test]
fn messages_are_separated_by_one_caller_blank_line() {
    let first = DisplayMessage {
        role: MessageRole::User,
        text: "hi".to_string(),
    };
    let second = DisplayMessage {
        role: MessageRole::Assistant,
        text: "hello".to_string(),
    };
    let mut visible = Vec::new();
    let first_lines = render_message(&first, None, false, false, false, "");
    visible.extend(first_lines);
    push_separator_after_message(&mut visible);
    visible.extend(render_message(&second, None, false, false, false, ""));

    let blank_count = visible
        .windows(2)
        .filter(|pair| pair[0].spans.is_empty() && pair[1].spans.is_empty())
        .count();
    assert_eq!(blank_count, 0);
    assert_eq!(
        visible.iter().filter(|line| line.spans.is_empty()).count(),
        2
    );
}

#[test]
fn assistant_markdown_link_label_preserves_hyperlink_after_prefix() {
    let destination = "https://example.com/docs";
    let msg = DisplayMessage {
        role: MessageRole::Assistant,
        text: format!("See [docs]({destination})."),
    };

    let lines = render_message_hyperlink(&msg, None, false, false, true, "base16-ocean.dark", None);

    let first = lines.first().expect("assistant line should render");
    let text = hyperlink_line_text(first);
    assert_eq!(text, format!("• See docs ({destination})."));
    assert!(
        first
            .hyperlinks
            .contains(&crate::terminal_hyperlinks::TerminalHyperlink {
                columns: text_column_range(&text, "docs"),
                destination: destination.to_string(),
            })
    );
    assert!(
        first
            .hyperlinks
            .contains(&crate::terminal_hyperlinks::TerminalHyperlink {
                columns: text_column_range(&text, destination),
                destination: destination.to_string(),
            })
    );
}

#[test]
fn assistant_markdown_ordered_list_preserves_first_marker_in_hyperlink_path() {
    let msg = DisplayMessage {
        role: MessageRole::Assistant,
        text: concat!(
            "1. 我是KCoder-Arrangement，由昆仑元人工智能技术（上海）有限公司开发。\n",
            "2. Arrangement模式角色：主智能体是编排者。"
        )
        .to_string(),
    };

    let lines = render_message_hyperlink(
        &msg,
        None,
        false,
        false,
        true,
        "base16-ocean.dark",
        Some(120),
    );

    assert_eq!(
        lines.iter().map(hyperlink_line_text).collect::<Vec<_>>(),
        vec![
            "  1. 我是KCoder-Arrangement，由昆仑元人工智能技术（上海）有限公司开发。",
            "  2. Arrangement模式角色：主智能体是编排者。",
        ]
    );
}

#[tokio::test]
async fn closed_agent_is_dropped_from_the_pending_aggregate_turn() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    // Register one live notifying sub-agent and one that was already closed.
    let mut live = kcoder_state::Task::new("job-live", "Implementer agent: patch");
    live.kind = kcoder_state::TaskKind::Subagent;
    live.notify_parent_on_completion = true;
    live.status = TaskStatus::Completed;
    engine.state.upsert_task(live);
    let mut closed = kcoder_state::Task::new("job-closed", "Explore agent: survey");
    closed.kind = kcoder_state::TaskKind::Subagent;
    closed.notify_parent_on_completion = true;
    closed.status = TaskStatus::Completed;
    engine.state.upsert_task(closed);
    engine.state.remove_task("job-closed");

    let mut followup = PendingBackgroundFollowup {
        ids: vec!["job-live".into(), "job-closed".into()],
        events: vec![
            "background sub-agent `job-live` completed".into(),
            "background sub-agent `job-closed` completed".into(),
        ],
        summary: String::new(),
    };
    followup.summary = followup.events.join(" ");
    followup.retain_followup_tasks(&engine);

    assert_eq!(followup.ids, vec!["job-live".to_string()]);
    assert_eq!(followup.events.len(), 1);
    assert!(followup.summary.contains("job-live"));
    assert!(!followup.summary.contains("job-closed"));
}

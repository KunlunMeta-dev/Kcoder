#[tokio::test]
async fn btw_starts_immediately_while_foreground_turn_is_busy() {
    let temp = tempfile::tempdir().unwrap();
    let engine = test_engine(temp.path());
    let mut app = ReplApp::default();
    app.start_loading();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let quit = handle_user_action(
        UserAction::SlashCommand("/btw what is already known?".to_string()),
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await
    .unwrap();

    assert!(!quit);
    assert!(app.user_message_queue.is_empty());
    let overlay = app.side_question_overlay.as_ref().unwrap();
    assert_eq!(overlay.question, "what is already known?");
    assert!(matches!(overlay.status, SideQuestionStatus::Loading));
    assert!(app.is_loading, "the foreground turn must remain active");
}

#[tokio::test]
async fn slash_compact_dispatch_does_not_wait_for_summary_provider() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_provider(tmp.path(), Arc::new(PendingCompactSummaryProvider));
    engine.state.set_messages(vec![
        Message::user_text(format!("old user request {}", "detail ".repeat(200))),
        Message::assistant_text(format!("old assistant answer {}", "detail ".repeat(200))),
        Message::user_text(format!("second user request {}", "detail ".repeat(200))),
        Message::assistant_text(format!("second assistant answer {}", "detail ".repeat(200))),
        Message::user_text(format!("recent user request {}", "detail ".repeat(80))),
        Message::assistant_text(format!("recent assistant answer {}", "detail ".repeat(80))),
    ]);
    let mut app = ReplApp::default();

    let dispatch = tokio::time::timeout(
        Duration::from_millis(100),
        handle_slash_command("/compact", &mut app, &engine),
    )
    .await;

    assert!(
        dispatch.is_ok(),
        "/compact dispatch must return to the TUI event loop before summary generation finishes"
    );
    assert!(matches!(
        dispatch.unwrap(),
        Some(UserAction::CompactConversation)
    ));
}

#[tokio::test]
async fn path_like_slash_input_submits_as_plain_text() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    // A multi-segment absolute path with a trailing question is not a
    // command; it must reach the model untouched.
    let action = handle_slash_command("/tmp/devuser 介绍这个项目", &mut app, &engine).await;
    match action {
        Some(UserAction::Submit(submitted)) => {
            assert_eq!(submitted.text, "/tmp/devuser 介绍这个项目");
        }
        other => panic!("expected Submit for path-like input, got {other:?}"),
    }
    assert!(app.messages.is_empty(), "no error message should be shown");

    // A single-segment absolute path that exists on disk is also plain text.
    let action = handle_slash_command("/tmp 介绍这个项目", &mut app, &engine).await;
    assert!(matches!(action, Some(UserAction::Submit(_))));
}

#[tokio::test]
async fn non_path_unknown_slash_input_still_reports_unknown_command() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/definitely-not-a-command", &mut app, &engine).await;
    assert!(action.is_none());
    let last = app.messages.last().expect("an error message");
    assert!(last.text.contains("Unknown command"), "{}", last.text);
    assert!(
        last.text.contains("start the input with a space"),
        "{}",
        last.text
    );
}

#[test]
fn slash_token_path_detection_covers_paths_and_rejects_plain_words() {
    assert!(slash_token_looks_like_path("/data/devuser"));
    assert!(slash_token_looks_like_path("/a/b/c.txt"));
    assert!(slash_token_looks_like_path("/tmp"));
    assert!(!slash_token_looks_like_path("/hlep"));
    assert!(!slash_token_looks_like_path("/model"));
    assert!(!slash_token_looks_like_path("/definitely-not-a-command"));
    assert!(!slash_token_looks_like_path("/"));
}

#[tokio::test]
async fn rewind_command_truncates_conversation_display_and_restores_files() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("a.txt");
    std::fs::write(&file, b"original").unwrap();
    let engine = test_engine_with_default_tools(tmp.path());
    engine
        .state
        .with_history_path(tmp.path().join("session.jsonl"));
    engine
        .state
        .add_message(Message::user_text("first request"));
    // Hand-craft the turn-1 checkpoint the write tool would have created:
    // the file was later mutated to "mutated".
    let checkpoint_dir = tmp
        .path()
        .join(".kcoder")
        .join("sessions")
        .join(engine.session_id())
        .join("checkpoints")
        .join("1");
    std::fs::create_dir_all(&checkpoint_dir).unwrap();
    std::fs::write(checkpoint_dir.join("f-a.snap"), b"original").unwrap();
    std::fs::write(
        checkpoint_dir.join("meta.json"),
        serde_json::json!({
            "turn": 1,
            "files": [{"path": file, "snapshot": "f-a.snap", "existed": true}],
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(&file, b"mutated").unwrap();
    engine
        .state
        .add_message(Message::assistant_text("answer one"));
    // Engine-injected context blocks occupy turn numbers but must never
    // flood the rebuilt display.
    engine.state.add_message(Message::runtime_text(
        "<relevant-memories>\n# Memories\n- old fact\n</relevant-memories>",
    ));
    engine
        .state
        .add_message(Message::user_text("second request"));
    engine
        .state
        .add_message(Message::assistant_text("answer two"));

    let mut app = ReplApp::default();
    // Rewind to the second prompt (turn 3: the memories block is turn 2):
    // the first exchange survives, the file (snapshotted at turn 1) is
    // untouched.
    handle_slash_command("/rewind 3", &mut app, &engine).await;
    let engine_previews = engine
        .state
        .messages()
        .iter()
        .map(|message| message.preview(120))
        .collect::<Vec<_>>();
    assert!(
        engine_previews
            .iter()
            .any(|text| text.contains("first request")),
        "{engine_previews:?}"
    );
    assert!(
        !engine_previews
            .iter()
            .any(|text| text.contains("second request")),
        "{engine_previews:?}"
    );
    let display_text = app
        .messages
        .iter()
        .map(|message| message.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(display_text.contains("first request"), "{display_text}");
    assert!(!display_text.contains("second request"), "{display_text}");
    assert!(
        !display_text.contains("relevant-memories"),
        "{display_text}"
    );
    assert!(
        std::fs::read(&file).unwrap() == b"mutated",
        "turn-1 file snapshot must survive a turn-3 rewind"
    );

    // Rewind to the first prompt: everything goes, file restored.
    handle_slash_command("/rewind 1", &mut app, &engine).await;
    let display_text = app
        .messages
        .iter()
        .map(|message| message.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!display_text.contains("first request"), "{display_text}");
    // The model-facing rewind reminder must not leak into the display.
    assert!(!display_text.contains("<system-reminder"), "{display_text}");
    assert_eq!(std::fs::read(&file).unwrap(), b"original");

    // The truncated conversation is durable: replaying the transcript
    // drops the rewound entries as well. Only the final rewind reminder
    // (appended after the second boundary) survives replay.
    engine
        .state
        .set_messages_and_save_history(engine.state.messages())
        .await
        .unwrap();
    let transcript =
        kcoder_state::load_transcript_history(&tmp.path().join("session.jsonl")).unwrap();
    assert_eq!(transcript.len(), 1);
    assert!(
        transcript[0]
            .message
            .preview(200)
            .contains("Rewind to checkpoint turn 1"),
        "{:?}",
        transcript[0].message.preview(200)
    );
}

#[tokio::test]
async fn rewind_command_without_args_opens_prompt_picker() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    engine
        .state
        .add_message(Message::user_text("first real prompt"));
    engine.state.add_message(Message::assistant_text("answer"));
    // Hidden engine-generated user messages keep their turn number but are
    // not offered as picker entries.
    engine.state.add_message(Message::runtime_text(
        "<system-reminder>Rewind to checkpoint turn 1 completed.</system-reminder>",
    ));
    engine.state.add_message(Message::runtime_text(
        "<relevant-memories>\n# Memories\nold fact\n</relevant-memories>",
    ));
    engine.state.add_message(Message::runtime_text(
        "<skill_content name=\"review\">\nskill body\n</skill_content>",
    ));
    engine
        .state
        .add_message(Message::user_text("second real prompt"));

    let mut app = ReplApp::default();
    handle_slash_command("/rewind", &mut app, &engine).await;

    let picker = app.picker_overlay.as_ref().expect("picker opens");
    assert!(matches!(picker.on_confirm, PickerAction::RewindToTurn));
    assert_eq!(
        picker.all_items,
        vec![
            "1. first real prompt".to_string(),
            "5. second real prompt".to_string(),
        ]
    );
    assert_eq!(picker.item_turns, vec![1, 5]);
    // The latest prompt is preselected for quick recent rewinds.
    assert_eq!(picker.selected, 1);
}

#[tokio::test]
async fn rewind_command_without_prompts_reports_nothing_to_rewind() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    handle_slash_command("/rewind", &mut app, &engine).await;
    assert!(app.picker_overlay.is_none());
    let last = app.messages.last().expect("a message");
    assert!(last.text.contains("No prompts to rewind"), "{}", last.text);
}

#[test]
fn rewind_picker_confirm_emits_selected_turn() {
    let mut app = ReplApp::default();
    app.open_rewind_picker(vec![
        (1, "first prompt".to_string()),
        (2, "second prompt".to_string()),
        (3, "third prompt".to_string()),
    ]);
    // Preselects the latest prompt.
    let picker = app.picker_overlay.as_ref().unwrap();
    assert_eq!(picker.selected, 2);
    assert_eq!(picker.selected_turn(), Some(3));

    assert!(app.handle_picker_key(KeyEvent::from(KeyCode::Up)).is_none());
    let action = app.handle_picker_key(KeyEvent::from(KeyCode::Enter));
    match action {
        Some(UserAction::SlashCommand(command)) => assert_eq!(command, "/rewind 2"),
        other => panic!("expected /rewind command, got {other:?}"),
    }
    assert!(app.picker_overlay.is_none());
}

#[test]
fn rewind_picker_filter_preserves_turn_mapping() {
    let mut app = ReplApp::default();
    app.open_rewind_picker(vec![
        (1, "alpha task".to_string()),
        (2, "beta task".to_string()),
        (3, "alpha follow-up".to_string()),
    ]);
    let picker = app.picker_overlay.as_mut().unwrap();
    picker.filter = "beta".to_string();
    // Typing a filter resets the selection to the first match.
    picker.selected = 0;
    assert_eq!(picker.matches(), vec!["2. beta task".to_string()]);
    assert_eq!(picker.selected_turn(), Some(2));
}

#[tokio::test]
async fn manual_compaction_shows_animated_interruptible_status() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_provider(tmp.path(), Arc::new(PendingCompactSummaryProvider));
    engine.state.set_messages(vec![
        Message::user_text(format!("old user request {}", "detail ".repeat(200))),
        Message::assistant_text(format!("old assistant answer {}", "detail ".repeat(200))),
        Message::user_text(format!("second user request {}", "detail ".repeat(200))),
        Message::assistant_text(format!("second assistant answer {}", "detail ".repeat(200))),
        Message::user_text(format!("recent user request {}", "detail ".repeat(80))),
        Message::assistant_text(format!("recent assistant answer {}", "detail ".repeat(80))),
    ]);
    let mut app = ReplApp::default();
    let action = handle_slash_command("/compact", &mut app, &engine)
        .await
        .expect("manual compact should dispatch foreground work");
    let (raw_tx, mut rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    handle_user_action(action, &engine, &mut app, &tx, &prompt)
        .await
        .unwrap();
    assert!(app.has_interruptible_turn());
    assert!(app.needs_scheduled_frame_tick());
    assert_eq!(app.activity_presentation().label, "Compacting context");

    let started = rx.recv().await.expect("manual compact should start");
    assert!(matches!(started, AppEvent::TurnStarted));
    handle_app_event(started, &mut app, &engine, &tx, &prompt).await;
    assert_eq!(app.activity_presentation().label, "Compacting context");

    assert!(matches!(
        app.interrupt_current_turn(),
        Some(UserAction::Interrupt)
    ));
    let finished = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect("cancelled compact should finish promptly")
        .expect("turn completion event should be delivered");
    assert!(matches!(finished, AppEvent::TurnFinished));
    handle_app_event(finished, &mut app, &engine, &tx, &prompt).await;

    assert!(app.foreground_operation_label.is_none());
    assert!(!app.has_interruptible_turn());
}

#[tokio::test]
async fn slash_compact_rebuilds_transcript_from_compacted_state() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("AGENTS.md"), "SECRET_PROJECT_RULE").unwrap();
    let engine = test_engine_with_provider(tmp.path(), Arc::new(CompactSummaryProvider));
    engine.state.set_messages(vec![
        Message::user_text(format!("old user request {}", "detail ".repeat(200))),
        Message::assistant_text(format!("old assistant answer {}", "detail ".repeat(200))),
        Message::user_text(format!("second user request {}", "detail ".repeat(200))),
        Message::assistant_text(format!("second assistant answer {}", "detail ".repeat(200))),
        Message::user_text(format!("recent user request {}", "detail ".repeat(80))),
        Message::assistant_text(format!("recent assistant answer {}", "detail ".repeat(80))),
    ]);
    let mut app = ReplApp::default();
    app.replace_transcript_from_history(&engine.state.messages());

    let action = handle_slash_command("/compact", &mut app, &engine).await;

    assert!(matches!(action, Some(UserAction::CompactConversation)));
    run_foreground_action_to_completion(action.unwrap(), &engine, &mut app).await;
    let state_text = engine
        .state
        .messages()
        .into_iter()
        .map(|message| message.preview(20_000))
        .collect::<Vec<_>>()
        .join("\n");
    let compact_prefix = "This session is being continued from a previous conversation";
    assert!(state_text.contains(compact_prefix));
    assert!(state_text.contains("compact ok"));
    assert!(!state_text.contains("Project instructions (KCODER.md):"));
    assert!(!state_text.contains("SECRET_PROJECT_RULE"));
    assert!(!state_text.contains("old user request"));
    let ui_text = messages_as_pairs(&app)
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!ui_text.contains(compact_prefix));
    assert!(!ui_text.contains("compact ok"));
    assert!(!ui_text.contains("Project instructions (KCODER.md):"));
    assert!(!ui_text.contains("SECRET_PROJECT_RULE"));
    assert!(ui_text.contains("old user request"));
    assert!(ui_text.contains("recent user request"));
    assert!(ui_text.contains("Context compaction completed"));
    assert!(app.transcript_viewport.position().is_at_tail());
}

#[tokio::test]
async fn resume_session_shows_full_jsonl_transcript_after_compact_boundary() {
    let tmp = tempfile::tempdir().unwrap();
    let history_path = tmp.path().join("178compact.jsonl");
    let source_state = kcoder_state::AppState::new(tmp.path());
    source_state.with_history_path(&history_path);
    source_state.add_message(Message::user_text("alpha user visible only in jsonl"));
    source_state.add_message(Message::assistant_text(
        "alpha assistant visible only in jsonl",
    ));
    source_state.add_message(Message::user_text("beta user retained"));
    source_state.add_message(Message::assistant_text("beta assistant retained"));
    source_state
        .set_messages_after_compaction(
            vec![
                Message::user_text("Earlier conversation summary: compacted older messages"),
                Message::user_text("beta user retained"),
                Message::assistant_text("beta assistant retained"),
            ],
            kcoder_state::CompactionTranscriptEvent {
                trigger: kcoder_state::CompactionTrigger::Manual,
                pre_tokens: 100,
                post_tokens: 20,
                summary: "compacted older messages".to_string(),
            },
        )
        .await
        .unwrap();
    assert_eq!(kcoder_state::load_history(&history_path).unwrap().len(), 3);
    assert_eq!(
        kcoder_state::load_transcript_history(&history_path)
            .unwrap()
            .len(),
        4
    );

    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    resume_session_from_history_path(&history_path, &engine, &mut app);

    let model_text = engine
        .state
        .messages()
        .into_iter()
        .map(|message| message.preview(20_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(model_text.contains("compacted older messages"));
    assert!(model_text.contains("beta user retained"));
    assert!(model_text.contains("beta assistant retained"));
    assert!(!model_text.contains("alpha user visible only in jsonl"));
    assert!(!model_text.contains("alpha assistant visible only in jsonl"));

    let ui_text = messages_as_pairs(&app)
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(ui_text.contains("alpha user visible only in jsonl"));
    assert!(ui_text.contains("alpha assistant visible only in jsonl"));
    assert!(ui_text.contains("beta user retained"));
    assert!(ui_text.contains("beta assistant retained"));
    assert!(!ui_text.contains("compacted older messages"));
    assert!(ui_text.contains("(4 messages)"));
}

#[tokio::test]
async fn fullscreen_resume_loads_tail_first_and_expands_history_on_demand() {
    let tmp = tempfile::tempdir().unwrap();
    let history_path = tmp.path().join("long-resume.jsonl");
    let source_state = kcoder_state::AppState::new(tmp.path());
    source_state.with_history_path(&history_path);
    for index in 0..260 {
        let message = if index % 2 == 0 {
            Message::user_text(format!("long-message-{index}"))
        } else {
            Message::assistant_text(format!("long-message-{index}"))
        };
        source_state.add_message(message);
    }
    source_state.flush_history().await.unwrap();
    source_state.save_history().unwrap();

    let engine = test_engine(tmp.path());
    let mut app = ReplApp {
        fullscreen_surface: true,
        ..ReplApp::default()
    };

    resume_session_from_history_path(&history_path, &engine, &mut app);

    let initial_text = messages_as_pairs(&app)
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(app.deferred_resumed_transcript.is_some());
    assert!(!initial_text.contains("long-message-0"));
    assert!(initial_text.contains("long-message-259"));
    assert!(initial_text.contains("(260 messages)"));

    app.transcript_viewport
        .begin_frame(ratatui::layout::Rect::new(0, 0, 80, 10));
    app.transcript_viewport.set_live_content_rows(100);
    app.transcript_viewport.snap_to_bottom();
    app.scroll_transcript_lines(-3);

    let expanded_text = messages_as_pairs(&app)
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(app.deferred_resumed_transcript.is_none());
    assert!(!app.transcript_viewport.position().is_at_tail());
    assert!(expanded_text.contains("long-message-0"));
    assert!(expanded_text.contains("long-message-259"));
    assert!(expanded_text.contains("(260 messages)"));
}

#[tokio::test]
async fn starting_turn_expands_deferred_resume_without_losing_turn_boundary() {
    let tmp = tempfile::tempdir().unwrap();
    let history_path = tmp.path().join("long-resume-before-turn.jsonl");
    let source_state = kcoder_state::AppState::new(tmp.path());
    source_state.with_history_path(&history_path);
    for index in 0..260 {
        source_state.add_message(Message::user_text(format!("old-message-{index}")));
    }
    source_state.flush_history().await.unwrap();
    source_state.save_history().unwrap();

    let engine = test_engine(tmp.path());
    let mut app = ReplApp {
        fullscreen_surface: true,
        ..ReplApp::default()
    };
    resume_session_from_history_path(&history_path, &engine, &mut app);
    assert!(app.deferred_resumed_transcript.is_some());

    let transcript_start = app.messages.len();
    app.push_message(MessageRole::User, "new turn after resume");
    let handle = tokio::spawn(async {});
    app.begin_turn_with_transcript_start(
        handle,
        tokio_util::sync::CancellationToken::new(),
        Some(transcript_start),
    );

    assert!(app.deferred_resumed_transcript.is_none());
    assert!(app.turn_state.is_active());
    let remapped_start = app.recent_turn_transcript_start.unwrap();
    assert_eq!(app.messages[remapped_start].text, "new turn after resume");
    assert!(
        app.messages
            .iter()
            .any(|message| message.text.contains("old-message-0"))
    );

    app.scroll_transcript_lines(-3);
    assert!(app.turn_state.is_active());
}

#[tokio::test]
async fn slash_compact_reports_noop_without_internal_context() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("AGENTS.md"), "NOOP_SECRET_PROJECT_RULE").unwrap();
    let engine = test_engine_with_provider(tmp.path(), Arc::new(CompactSummaryProvider));
    engine.state.set_messages(vec![
        Message::user_text("recent user request"),
        Message::assistant_text("recent assistant answer"),
    ]);
    let mut app = ReplApp::default();
    app.replace_transcript_from_history(&engine.state.messages());

    let action = handle_slash_command("/compact", &mut app, &engine).await;

    assert!(action.is_none());
    let state_text = engine
        .state
        .messages()
        .into_iter()
        .map(|message| message.preview(20_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!state_text.contains("Project instructions (KCODER.md):"));
    assert!(!state_text.contains("NOOP_SECRET_PROJECT_RULE"));
    let ui_text = messages_as_pairs(&app)
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(ui_text.contains("Context compaction skipped: current model context is only"));
    assert!(!ui_text.contains("Context compaction completed"));
    assert!(!ui_text.contains("Project instructions (KCODER.md):"));
    assert!(!ui_text.contains("NOOP_SECRET_PROJECT_RULE"));
}

#[tokio::test]
async fn slash_compact_rejects_arguments_with_usage() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/compact now", &mut app, &engine).await;

    assert!(action.is_none());
    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| text == "Usage: /compact")
    );
}

#[tokio::test]
async fn slash_compact_reports_failure_reason() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/compact", &mut app, &engine).await;

    assert!(matches!(action, Some(UserAction::CompactConversation)));
    run_foreground_action_to_completion(action.unwrap(), &engine, &mut app).await;
    let ui_text = messages_as_pairs(&app)
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(ui_text.contains("Context compaction failed:"));
    assert!(ui_text.contains("cannot compact an empty conversation"));
}

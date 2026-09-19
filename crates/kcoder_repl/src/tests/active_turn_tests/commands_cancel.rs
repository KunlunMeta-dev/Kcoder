#[test]
fn permission_requests_queue_instead_of_overwriting_active_dialog() {
    let mut app = ReplApp::default();
    let (tx1, mut rx1) = tokio::sync::oneshot::channel();
    let (tx2, mut rx2) = tokio::sync::oneshot::channel();

    app.enqueue_permission_dialog(permission_dialog("bash", tx1));
    app.enqueue_permission_dialog(permission_dialog("edit", tx2));

    assert_eq!(
        app.pending_permission
            .as_ref()
            .map(|dialog| dialog.tool_name.as_str()),
        Some("bash")
    );
    assert_eq!(app.permission_queue.len(), 1);
    assert!(rx1.try_recv().is_err());
    assert!(rx2.try_recv().is_err());

    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(
        rx1.try_recv().unwrap().response,
        PermissionResponse::AllowOnce
    );
    assert_eq!(
        app.pending_permission
            .as_ref()
            .map(|dialog| dialog.tool_name.as_str()),
        Some("edit")
    );
    assert!(rx2.try_recv().is_err());

    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert_eq!(
        rx2.try_recv().unwrap().response,
        PermissionResponse::DenyOnce
    );
    assert!(app.pending_permission.is_none());
    assert!(app.permission_queue.is_empty());
}

#[test]
fn permission_dialog_accepts_letter_and_number_shortcuts() {
    let mut app = ReplApp::default();
    let (tx1, mut rx1) = tokio::sync::oneshot::channel();
    let (tx2, mut rx2) = tokio::sync::oneshot::channel();

    app.enqueue_permission_dialog(permission_dialog("bash", tx1));
    app.handle_key(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::NONE));
    assert_eq!(
        rx1.try_recv().unwrap().response,
        PermissionResponse::DenyOnce
    );

    app.enqueue_permission_dialog(permission_dialog("edit", tx2));
    app.handle_key(KeyEvent::new(KeyCode::Char('2'), KeyModifiers::NONE));
    assert_eq!(
        rx2.try_recv().unwrap().response,
        PermissionResponse::AllowAlways
    );
}

#[cfg(windows)]
#[test]
fn altgr_permission_shortcuts_do_not_approve_dialog() {
    let mut app = ReplApp::default();
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    app.enqueue_permission_dialog(permission_dialog("bash", tx));
    let altgr = KeyModifiers::CONTROL | KeyModifiers::ALT;

    app.handle_key(KeyEvent::new(KeyCode::Char('y'), altgr));
    app.handle_key(KeyEvent::new(KeyCode::Enter, altgr));

    assert!(app.pending_permission.is_some());
    assert!(rx.try_recv().is_err());
}

#[test]
fn permission_dialog_home_end_select_edges() {
    let mut app = ReplApp::default();
    let (tx, _rx) = tokio::sync::oneshot::channel();

    app.enqueue_permission_dialog(permission_dialog("bash", tx));
    app.handle_key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
    assert_eq!(
        app.pending_permission.as_ref().unwrap().selected,
        PERMISSION_OPTION_RESPONSES.len() - 1
    );

    app.handle_key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
    assert_eq!(app.pending_permission.as_ref().unwrap().selected, 0);
}

#[tokio::test]
async fn esc_does_not_interrupt_turn_when_permission_dialog_is_open() {
    let mut app = ReplApp::default();
    let cancel = CancellationToken::new();
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async {
        std::future::pending::<()>().await;
    });

    app.begin_turn(handle, cancel.clone());
    app.enqueue_permission_dialog(permission_dialog("bash", tx));

    let action = app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert!(action.is_none());
    assert!(!cancel.is_cancelled());
    assert!(app.is_loading);
    assert!(app.pending_permission.is_none());
    assert_eq!(
        rx.try_recv().unwrap().response,
        PermissionResponse::DenyOnce
    );
    assert!(
        !messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| text == "Cancelled.")
    );
    let handle = app.abort_turn_for_shutdown().unwrap();
    let _ = handle.await;
}

#[tokio::test]
async fn ctrl_c_cancels_permission_before_interrupting_turn() {
    let mut app = ReplApp::default();
    let cancel = CancellationToken::new();
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async {
        std::future::pending::<()>().await;
    });

    app.begin_turn(handle, cancel.clone());
    app.enqueue_permission_dialog(permission_dialog("bash", tx));

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));

    assert!(action.is_none());
    assert!(!cancel.is_cancelled());
    assert!(app.is_loading);
    assert!(app.pending_permission.is_none());
    assert_eq!(
        rx.try_recv().unwrap().response,
        PermissionResponse::DenyOnce
    );
    assert!(
        !messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| text == "Cancelled.")
    );
    let handle = app.abort_turn_for_shutdown().unwrap();
    let _ = handle.await;
}

#[test]
fn ctrl_l_requests_clear_ui_when_idle() {
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "hello");

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('l'), KeyModifiers::CONTROL));

    assert!(matches!(action, Some(UserAction::ClearUi)));
    assert_eq!(messages_as_pairs(&app).len(), 1);
}

#[tokio::test]
async fn ctrl_l_is_disabled_while_turn_is_running() {
    let mut app = ReplApp::default();
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(async {
        std::future::pending::<()>().await;
    });

    app.begin_turn(handle, cancel.clone());

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('l'), KeyModifiers::CONTROL));

    assert!(action.is_none());
    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| text == "Ctrl+L is disabled while a task is in progress.")
    );
    let handle = app.abort_turn_for_shutdown().unwrap();
    let _ = handle.await;
}

#[tokio::test]
async fn clear_ui_action_clears_app_and_engine_state() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    engine.state.set_short_id_registry(&tmp.path().join("ids"));
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "visible");
    engine.state.add_message(Message::user_text("model"));
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let should_quit = handle_user_action(UserAction::ClearUi, &engine, &mut app, &tx, &prompt)
        .await
        .unwrap();

    assert!(!should_quit);
    assert!(engine.state.messages().is_empty());
    assert_eq!(engine.state.session_id().len(), 5);
    assert_eq!(
        messages_as_pairs(&app),
        vec![(
            MessageRole::System,
            "Conversation cleared. Type /help for available commands.".to_string()
        )]
    );
}

#[test]
fn clear_ui_short_id_failure_preserves_visible_and_model_history() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let invalid = tmp.path().join("occupied");
    std::fs::write(&invalid, "not a directory").unwrap();
    engine.state.set_short_id_registry(&invalid);
    engine.state.add_message(Message::user_text("model history"));
    let before = engine.state.messages_with_revision();
    let id = engine.state.session_id();
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "visible history");
    app.clear_conversation_ui(&engine);
    assert_eq!(engine.state.messages_with_revision(), before);
    assert_eq!(engine.state.session_id(), id);
    let visible = messages_as_pairs(&app);
    assert_eq!(visible[0], (MessageRole::User, "visible history".into()));
    assert!(visible.last().unwrap().1.contains("无法新建会话"));
}

#[tokio::test]
async fn slash_new_starts_fresh_chat() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let old_session_id = engine.state.session_id();
    let old_history = tmp.path().join(format!("{old_session_id}.jsonl"));
    engine.state.with_history_path(&old_history);
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "visible");
    engine.state.add_message(Message::user_text("model"));
    engine.state.save_history().unwrap();

    let action = handle_slash_command("/new", &mut app, &engine).await;

    assert!(action.is_none());
    assert!(engine.state.messages().is_empty());
    assert_ne!(engine.state.session_id(), old_session_id);
    let new_history = engine.state.history_path().expect("new history path");
    let new_session_id = engine.state.session_id();
    assert_ne!(new_history, old_history);
    assert_eq!(
        new_history.file_stem().and_then(|name| name.to_str()),
        Some(new_session_id.as_str())
    );
    engine
        .state
        .add_message(Message::user_text("new conversation"));
    engine.state.save_history().unwrap();
    assert_eq!(kcoder_state::load_history(&old_history).unwrap().len(), 1);
    assert_eq!(kcoder_state::load_history(&new_history).unwrap().len(), 1);
    assert_eq!(
        messages_as_pairs(&app),
        vec![(
            MessageRole::System,
            "Conversation cleared. Type /help for available commands.".to_string()
        )]
    );
}

#[tokio::test]
async fn slash_new_id_failure_keeps_history_and_mode() {
    for (command, luna) in [("/new", true), ("/clear", true), ("/luna", false)] {
        let tmp = tempfile::tempdir().unwrap();
        let engine = test_engine(tmp.path());
        engine.set_luna_mode(luna);
        let invalid = tmp.path().join("occupied");
        std::fs::write(&invalid, "file").unwrap();
        engine.state.set_short_id_registry(&invalid);
        engine.state.add_message(Message::user_text("keep history"));
        let before = engine.state.messages_with_revision();
        let mut app = ReplApp::default();
        app.push_message(MessageRole::User, "keep visible");
        handle_slash_command(command, &mut app, &engine).await;
        assert_eq!(engine.is_luna_mode_active(), luna);
        assert_eq!(engine.state.messages_with_revision(), before);
        assert_eq!(messages_as_pairs(&app)[0].1, "keep visible");
    }
}

#[tokio::test]
async fn slash_luna_starts_fresh_chat_and_new_restores_full_tool_mode() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_default_tools(tmp.path());
    let old_session_id = engine.state.session_id();
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "visible");
    engine.state.add_message(Message::user_text("model"));

    let action = handle_slash_command("/luna", &mut app, &engine).await;

    assert!(action.is_none());
    assert!(engine.is_luna_mode_active());
    assert!(engine.state.messages().is_empty());
    assert_ne!(engine.state.session_id(), old_session_id);
    assert!(
        messages_as_pairs(&app)
            .last()
            .unwrap()
            .1
            .starts_with("Luna mode active. Tools: ")
    );

    let action = handle_slash_command("/new", &mut app, &engine).await;

    assert!(action.is_none());
    assert!(!engine.is_luna_mode_active());
}

#[tokio::test]
async fn slash_init_submits_agents_prompt() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/init", &mut app, &engine).await;

    let Some(UserAction::Submit(submitted)) = action else {
        panic!("/init should submit an AGENTS.md prompt");
    };
    assert!(submitted.images.is_empty());
    assert!(submitted.pending_pastes.is_empty());
    assert!(submitted.text.contains("Generate a file named AGENTS.md"));
    assert!(
        submitted
            .text
            .contains("Before writing, check whether AGENTS.md already exists")
    );
    assert!(messages_as_pairs(&app).is_empty());
}

#[tokio::test]
async fn slash_review_submits_review_prompt_with_args() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/review focus on panic paths", &mut app, &engine).await;

    let Some(UserAction::Submit(submitted)) = action else {
        panic!("/review should submit a review prompt");
    };
    assert!(submitted.text.contains("Review my current changes"));
    assert!(
        submitted
            .text
            .contains("Inspect the git diff, including untracked files.")
    );
    assert!(submitted.text.contains("focus on panic paths"));
    assert!(messages_as_pairs(&app).is_empty());
}

#[tokio::test]
async fn slash_ocr_submits_ocr_tool_prompt_with_args() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/ocr focus on LSP files", &mut app, &engine).await;

    let Some(UserAction::Submit(submitted)) = action else {
        panic!("/ocr should submit an OCR tool prompt");
    };
    assert_eq!(
        submitted.visible_text,
        "Run OpenCodeReview review for current changes. focus on LSP files"
    );
    assert!(!submitted.visible_text.contains("Required workflow"));
    assert!(!submitted.visible_text.contains("\"command\""));
    assert!(submitted.text.contains("built-in `ocr` model tool"));
    assert!(
        submitted
            .text
            .contains("\"command\": \"review\", \"preview\": true")
    );
    assert!(submitted.text.contains("focus on LSP files"));
    assert!(messages_as_pairs(&app).is_empty());
}

#[tokio::test]
async fn slash_learn_submits_skill_learning_prompt_with_args() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action =
        handle_slash_command("/learn docs/api.md focus on auth flow", &mut app, &engine).await;

    let Some(UserAction::Submit(submitted)) = action else {
        panic!("/learn should submit a skill-learning prompt");
    };
    assert!(submitted.text.contains("[/learn]"));
    assert!(submitted.text.contains("docs/api.md focus on auth flow"));
    assert!(submitted.text.contains("skill_manage"));
    assert!(submitted.text.contains("DiscoverSkills"));
    assert!(messages_as_pairs(&app).is_empty());
}

#[test]
fn copy_last_assistant_response_reports_when_empty() {
    let mut app = ReplApp::default();

    app.copy_last_assistant_response_with(|_| panic!("copy should not run without a response"));

    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::System, "No agent response to copy".to_string())]
    );
}

#[test]
fn copy_last_assistant_response_uses_latest_assistant_text() {
    let mut app = ReplApp::default();
    app.push_message(MessageRole::Assistant, "first response");
    app.push_message(MessageRole::User, "follow-up");
    app.push_message(MessageRole::System, "status");
    app.push_message(MessageRole::Assistant, "latest **markdown**");
    let mut copied = String::new();

    app.copy_last_assistant_response_with(|text| {
        copied = text.to_string();
        Ok(clipboard_copy::ClipboardCopyResult::Native(None))
    });

    assert_eq!(copied, "latest **markdown**");
    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| text == "Copied last message to clipboard")
    );
}

#[test]
fn copy_last_assistant_response_warns_when_using_osc52() {
    let mut app = ReplApp::default();
    app.push_message(MessageRole::Assistant, "copy me");

    app.copy_last_assistant_response_with(|_| Ok(clipboard_copy::ClipboardCopyResult::Osc52));

    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| text == clipboard_copy::OSC52_COPY_NOTICE)
    );
}

#[test]
fn copy_last_assistant_response_reports_copy_failure() {
    let mut app = ReplApp::default();
    app.push_message(MessageRole::Assistant, "copy me");

    app.copy_last_assistant_response_with(|text| {
        assert_eq!(text, "copy me");
        Err("blocked".to_string())
    });

    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| text == "Copy failed: blocked")
    );
}

#[test]
fn ctrl_o_requests_copy_last_response_action() {
    let mut app = ReplApp::default();

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL));

    assert!(matches!(action, Some(UserAction::CopyLastResponse)));
}

#[test]
fn shift_tab_cycles_into_plan_mode() {
    let mut app = ReplApp::default();

    let action = app.handle_key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT));

    assert!(matches!(
        action,
        Some(UserAction::SlashCommand(command)) if command == "/plan"
    ));
}

#[test]
fn shift_tab_cycles_out_of_plan_mode() {
    let mut app = ReplApp {
        plan_mode: Some("plan first".to_string()),
        ..ReplApp::default()
    };

    let action = app.handle_key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT));

    assert!(matches!(
        action,
        Some(UserAction::SlashCommand(command)) if command == "/unplan"
    ));
}

#[test]
fn esc_esc_requests_edit_previous_message() {
    let mut app = ReplApp::default();

    let first = app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert!(first.is_none());
    assert!(app.edit_previous_primed);

    let second = app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert!(matches!(second, Some(UserAction::EditPreviousMessage)));
    assert!(!app.edit_previous_primed);
}

#[test]
fn normal_key_clears_edit_previous_prompt() {
    let mut app = ReplApp::default();

    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE));

    assert!(!app.edit_previous_primed);
    assert_eq!(app.input, "x");
}

#[test]
fn ctrl_g_requests_external_editor_action() {
    let mut app = ReplApp::default();

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL));

    assert!(matches!(action, Some(UserAction::OpenExternalEditor)));
}

#[tokio::test]
async fn copy_last_response_action_reports_when_empty() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let should_quit = handle_user_action(
        UserAction::CopyLastResponse,
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await
    .unwrap();

    assert!(!should_quit);
    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::System, "No agent response to copy".to_string())]
    );
}

#[tokio::test]
async fn edit_previous_message_action_truncates_ui_and_engine_history() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    engine.state.add_message(Message::user_text("first"));
    engine
        .state
        .add_message(Message::assistant_text("first answer"));
    engine.state.add_message(Message::user_text("second"));
    engine
        .state
        .add_message(Message::assistant_text("second answer"));

    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "first");
    app.push_message(MessageRole::Assistant, "first answer");
    app.push_message(MessageRole::User, "second");
    app.push_message(MessageRole::Assistant, "second answer");
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let should_quit = handle_user_action(
        UserAction::EditPreviousMessage,
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await
    .unwrap();

    assert!(!should_quit);
    assert_eq!(app.input, "second");
    assert_eq!(
        messages_as_pairs(&app),
        vec![
            (MessageRole::User, "first".to_string()),
            (MessageRole::Assistant, "first answer".to_string())
        ]
    );
    let state_messages = engine.state.messages();
    assert_eq!(state_messages.len(), 2);
    assert!(matches!(&state_messages[0], Message::User { .. }));
    assert!(matches!(&state_messages[1], Message::Assistant { .. }));
}

#[tokio::test]
async fn edit_previous_message_skips_hidden_internal_user_messages() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    engine
        .state
        .add_message(Message::user_text("real question"));
    engine
        .state
        .add_message(Message::assistant_text("real answer"));
    // Hidden internal user message, as produced by /goal continuations
    // and sub-agent follow-up nudges.
    engine.state.add_message(Message::user_text(
        "[system] Continue working toward the active `/goal` objective. keep going",
    ));
    engine
        .state
        .add_message(Message::assistant_text("nudge answer"));

    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "real question");
    app.push_message(MessageRole::Assistant, "real answer");
    app.push_message(MessageRole::Assistant, "nudge answer");
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let should_quit = handle_user_action(
        UserAction::EditPreviousMessage,
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await
    .unwrap();

    assert!(!should_quit);
    // The composer is prefilled with the real user message, not the
    // hidden internal scaffolding text.
    assert_eq!(app.input, "real question");
    // Engine and UI truncation points agree: everything from the real
    // user message onward (including the hidden nudge turn) is removed.
    assert!(engine.state.messages().is_empty());
    assert!(app.messages.is_empty());
}

#[tokio::test]
async fn slash_copy_reports_when_empty() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/copy", &mut app, &engine).await;

    assert!(action.is_none());
    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::System, "No agent response to copy".to_string())]
    );
}

#[test]
fn alt_r_requests_raw_output_toggle_action() {
    let mut app = ReplApp::default();

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::ALT));

    assert!(matches!(action, Some(UserAction::ToggleRawOutput)));
}

#[test]
fn alt_period_and_comma_request_reasoning_adjustment_actions() {
    let mut app = ReplApp::default();

    let raise = app.handle_key(KeyEvent::new(KeyCode::Char('.'), KeyModifiers::ALT));
    let lower = app.handle_key(KeyEvent::new(KeyCode::Char(','), KeyModifiers::ALT));

    assert!(matches!(
        raise,
        Some(UserAction::AdjustReasoning(
            ReasoningShortcutDirection::Raise
        ))
    ));
    assert!(matches!(
        lower,
        Some(UserAction::AdjustReasoning(
            ReasoningShortcutDirection::Lower
        ))
    ));
}

#[tokio::test]
async fn adjust_reasoning_action_raises_from_default_profile() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let should_quit = handle_user_action(
        UserAction::AdjustReasoning(ReasoningShortcutDirection::Raise),
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await
    .unwrap();

    assert!(!should_quit);
    assert_eq!(
        engine.settings.read().unwrap().model_reasoning_effort,
        Some(ReasoningEffort::XHigh)
    );
    assert_eq!(app.reasoning_effort, Some(ReasoningEffort::XHigh));
    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| text == "Reasoning set to extra high.")
    );
}

#[tokio::test]
async fn adjust_reasoning_action_reports_highest_boundary() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    engine.settings.write().unwrap().model_reasoning_effort = Some(ReasoningEffort::XHigh);
    let mut app = ReplApp::default();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let should_quit = handle_user_action(
        UserAction::AdjustReasoning(ReasoningShortcutDirection::Raise),
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await
    .unwrap();

    assert!(!should_quit);
    assert_eq!(
        engine.settings.read().unwrap().model_reasoning_effort,
        Some(ReasoningEffort::XHigh)
    );
    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| { text == "Reasoning is already at the highest level (extra high)." })
    );
}

#[tokio::test]
async fn toggle_raw_output_action_changes_mode_without_notice() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "before");
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let should_quit =
        handle_user_action(UserAction::ToggleRawOutput, &engine, &mut app, &tx, &prompt)
            .await
            .unwrap();

    assert!(!should_quit);
    assert!(app.raw_output_mode());
    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::User, "before".to_string())]
    );
}

#[tokio::test]
async fn slash_raw_toggles_and_accepts_on_off_args() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    assert!(
        handle_slash_command("/raw", &mut app, &engine)
            .await
            .is_none()
    );
    assert!(app.raw_output_mode());
    assert!(messages_as_pairs(&app).iter().any(|(_, text)| {
        text == "Raw output mode on: transcript text is shown for clean terminal selection."
    }));

    assert!(
        handle_slash_command("/raw off", &mut app, &engine)
            .await
            .is_none()
    );
    assert!(!app.raw_output_mode());
    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| text == "Raw output mode off: rich transcript rendering restored.")
    );

    assert!(
        handle_slash_command("/raw on", &mut app, &engine)
            .await
            .is_none()
    );
    assert!(app.raw_output_mode());
}

#[tokio::test]
async fn slash_rename_sets_local_session_title() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/rename   Project Phoenix   ", &mut app, &engine).await;

    assert!(action.is_none());
    assert_eq!(app.session_title(), Some("Project Phoenix"));
    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| text == "Session renamed to: Project Phoenix")
    );
}

#[tokio::test]
async fn slash_rename_without_args_prefills_existing_title() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    app.set_session_title("Existing Title");

    let action = handle_slash_command("/rename", &mut app, &engine).await;

    assert!(action.is_none());
    assert_eq!(app.input, "/rename Existing Title");
    assert_eq!(app.cursor_grapheme_index, app.input_graphemes().len());
    assert!(messages_as_pairs(&app).iter().any(
            |(_, text)| text == "Type a session title and press Enter to rename this session."
        ));
}

#[tokio::test]
async fn slash_status_renders_session_status_card() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("AGENTS.md"), "project instructions").unwrap();
    let engine = test_engine(tmp.path());
    {
        let mut settings = engine.settings.write().unwrap();
        settings.model = "gpt-4o".to_string();
        settings.model_reasoning_effort = Some(ReasoningEffort::High);
        settings.permission_mode = kcoder_config::PermissionMode::AcceptEdits;
        settings.sandbox.enabled = true;
        settings.sandbox.readonly = true;
    }
    let mut app = ReplApp::default();
    app.set_raw_output_mode(true);
    app.set_session_title("Status Title");

    let action = handle_slash_command("/status", &mut app, &engine).await;

    assert!(action.is_none());
    let status = messages_as_pairs(&app)
        .into_iter()
        .find(|(_, text)| text.contains(">_ KCoder"))
        .map(|(_, text)| text)
        .expect("/status should add a status message");
    for expected in [
        " >_ KCoder",
        "Session status",
        "Model details",
        "Model:",
        "gpt-4o",
        "Provider:",
        "Endpoint:",
        "not reported",
        "Permissions:",
        "Accept edits",
        "Sandbox:",
        "read-only",
        "Agents.md:",
        "loaded (AGENTS.md)",
        "Token usage:",
        "0 total  (0 input + 0 output)",
        "Context:",
        "Context window:",
        "Queue:",
        "0 /",
        "Rendering:",
        "markdown",
        "raw output on",
        "Thread name:",
        "Status Title",
    ] {
        assert!(status.contains(expected), "missing {expected} in {status}");
    }
}

#[tokio::test]
async fn slash_hooks_lists_configured_lifecycle_hooks() {
    let tmp = tempfile::tempdir().unwrap();
    let kcoder_dir = tmp.path().join(".kcoder");
    std::fs::create_dir_all(&kcoder_dir).unwrap();
    std::fs::write(
        kcoder_dir.join("settings.json"),
        r#"{
              "hooks": {
                "PreToolUse": [
                  {
                    "matcher": "Bash",
                    "hooks": [
                      {
                        "type": "command",
                        "command": "echo ok",
                        "timeout": 5
                      }
                    ]
                  }
                ]
              }
            }"#,
    )
    .unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/hooks", &mut app, &engine).await;

    assert!(action.is_none());
    let hooks = messages_as_pairs(&app)
        .into_iter()
        .find(|(_, text)| text.contains("Lifecycle hooks:"))
        .map(|(_, text)| text)
        .expect("/hooks should add a hooks status message");
    assert!(hooks.contains("PreToolUse"));
    assert!(hooks.contains("- matcher `Bash`"));
    let default_shell = if cfg!(windows) {
        "powershell.exe"
    } else {
        "bash"
    };
    assert!(hooks.contains(&format!("command [{default_shell}, timeout 5s]: echo ok")));
}

#[tokio::test]
async fn slash_plugins_lists_discovered_plugins() {
    let _env_lock = ENV_LOCK.lock().await;
    let tmp = tempfile::tempdir().unwrap();
    let plugin_dir = tmp.path().join(".kcoder/plugins/demo-plugin");
    std::fs::create_dir_all(&plugin_dir).unwrap();
    std::fs::write(
        plugin_dir.join("plugin.json"),
        r#"{
              "id": "demo-plugin",
              "name": "Demo Plugin",
              "version": "1.2.3",
              "description": "Adds demo lifecycle hooks",
              "enabled": true,
              "hooks": {
                "Stop": [
                  {
                    "hooks": [
                      {
                        "type": "command",
                        "command": "echo stopped"
                      }
                    ]
                  }
                ]
              }
            }"#,
    )
    .unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/plugins", &mut app, &engine).await;

    assert!(action.is_none());
    let plugins = messages_as_pairs(&app)
        .into_iter()
        .find(|(_, text)| text.contains("Plugins:"))
        .map(|(_, text)| text)
        .expect("/plugins should add a plugin status message");
    assert!(plugins.contains("Demo Plugin (demo-plugin) [enabled, manual v1.2.3]"));
    assert!(plugins.contains("Adds demo lifecycle hooks"));
    assert!(plugins.contains("hooks: 1 matcher(s)"));
    assert!(plugins.contains(".kcoder/plugins/demo-plugin"));
}

#[tokio::test]
async fn slash_plugins_surfaces_incompatible_manifest_diagnostics() {
    let _env_lock = ENV_LOCK.lock().await;
    let tmp = tempfile::tempdir().unwrap();
    let plugin_dir = tmp.path().join(".kcoder/plugins/future-plugin");
    std::fs::create_dir_all(&plugin_dir).unwrap();
    std::fs::write(
        plugin_dir.join("plugin.json"),
        r#"{
          "$schema": "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
          "name": "future-plugin"
        }"#,
    )
    .unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/plugins", &mut app, &engine).await;

    assert!(action.is_none());
    let status = messages_as_pairs(&app)
        .into_iter()
        .map(|(_, text)| text)
        .find(|text| text.contains("Plugin diagnostics:"))
        .expect("/plugins should surface invalid plugin diagnostics");
    assert!(status.contains("unsupported_schema"));
    assert!(status.contains(".kcoder/plugins/future-plugin"));
}

#[tokio::test]
async fn slash_rollout_reports_session_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let history_path = tmp.path().join(".kcoder/sessions/current.jsonl");
    engine.state.with_history_path(&history_path);
    let mut app = ReplApp::default();

    let action = handle_slash_command("/rollout", &mut app, &engine).await;

    assert!(action.is_none());
    let rollout = messages_as_pairs(&app)
        .into_iter()
        .find(|(_, text)| text.contains("History path:"))
        .map(|(_, text)| text)
        .expect("/rollout should add a session path message");
    assert!(rollout.contains("Session:"));
    assert!(rollout.contains(&format!("History path: {}", history_path.display())));
    let state_path = engine
        .state
        .session_state_path()
        .expect("history path should configure session state path");
    assert!(rollout.contains(&format!("Session state path: {}", state_path.display())));
}

#[tokio::test]
async fn slash_apps_reports_mcp_connector_status() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/apps", &mut app, &engine).await;

    assert!(action.is_none());
    assert_eq!(
        messages_as_pairs(&app),
        vec![(
            MessageRole::System,
            "No MCP servers configured.".to_string()
        )]
    );
}

#[tokio::test]
async fn slash_mcp_supports_summary_verbose_and_usage() {
    let tmp = tempfile::tempdir().unwrap();
    let mut engine = test_engine(tmp.path());
    engine.tools = engine.tools.clone().register(NamedTool {
        name: "mcp__docs__search",
    });
    engine.settings.write().unwrap().mcp_servers = vec![kcoder_types::McpServerConfig {
        name: "docs".to_string(),
        transport: "stdio".to_string(),
        command: "docs-mcp".to_string(),
        args: Vec::new(),
        url: String::new(),
        env: Default::default(),
        headers: Default::default(),
    }];
    let mut app = ReplApp::default();

    assert!(
        handle_slash_command("/mcp", &mut app, &engine)
            .await
            .is_none()
    );
    let summary = messages_as_pairs(&app)
        .into_iter()
        .last()
        .map(|(_, text)| text)
        .expect("/mcp should add a message");
    assert!(summary.contains("- docs (stdio): 1 tools"));
    assert!(!summary.contains("mcp__docs__search"));

    assert!(
        handle_slash_command("/mcp verbose", &mut app, &engine)
            .await
            .is_none()
    );
    let verbose = messages_as_pairs(&app)
        .into_iter()
        .last()
        .map(|(_, text)| text)
        .expect("/mcp verbose should add a message");
    assert!(verbose.contains("- docs (stdio): 1 tools"));
    assert!(verbose.contains("mcp__docs__search"));

    assert!(
        handle_slash_command("/mcp full", &mut app, &engine)
            .await
            .is_none()
    );
    let usage = messages_as_pairs(&app)
        .into_iter()
        .last()
        .map(|(_, text)| text)
        .expect("/mcp full should add a usage message");
    assert_eq!(usage, "Usage: /mcp [verbose]");
}

#[tokio::test]
async fn slash_ps_reports_when_no_background_tasks_are_running() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/ps", &mut app, &engine).await;

    assert!(action.is_none());
    assert_eq!(
        messages_as_pairs(&app),
        vec![(
            MessageRole::System,
            "No background tasks running.".to_string()
        )]
    );
}

#[tokio::test]
async fn slash_ps_lists_active_background_tasks() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut running = kcoder_state::Task::new("job-b", "review renderer parity");
    running.status = kcoder_state::TaskStatus::Running;
    engine.state.upsert_task(running);
    let mut pending = kcoder_state::Task::new("job-a", "prepare tui diff");
    pending.status = kcoder_state::TaskStatus::Pending;
    engine.state.upsert_task(pending);
    let mut completed = kcoder_state::Task::new("job-c", "already done");
    completed.status = kcoder_state::TaskStatus::Completed;
    engine.state.upsert_task(completed);
    let mut app = ReplApp::default();

    let action = handle_slash_command("/ps", &mut app, &engine).await;

    assert!(action.is_none());
    assert_eq!(
            messages_as_pairs(&app),
            vec![(
                MessageRole::System,
                "Background tasks:\n- job-a [pending] prepare tui diff\n- job-b [running] review renderer parity"
                    .to_string()
            )]
        );
}

#[tokio::test]
async fn slash_stop_reports_when_no_background_tasks_are_running() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/stop", &mut app, &engine).await;

    assert!(action.is_none());
    assert_eq!(
        messages_as_pairs(&app),
        vec![(
            MessageRole::System,
            "No background tasks running.".to_string()
        )]
    );
}

#[tokio::test]
async fn slash_stop_with_id_cancels_only_the_paused_target() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    for id in ["agent-target", "agent-sibling"] {
        let mut task = kcoder_state::Task::new(id, format!("General agent: {id}"));
        task.kind = kcoder_state::TaskKind::Subagent;
        task.managed = true;
        task.status = kcoder_state::TaskStatus::Paused;
        task.parent_session_id = Some(engine.state.session_id());
        engine.state.upsert_task(task);
    }
    engine
        .state
        .enqueue_subagent_delivery("agent-target", "queued correction")
        .unwrap()
        .unwrap();
    let mut app = ReplApp::default();

    let action = handle_slash_command("/stop agent-target", &mut app, &engine).await;

    assert!(action.is_none());
    let target = engine.state.task("agent-target").unwrap();
    assert_eq!(target.status, kcoder_state::TaskStatus::Cancelled);
    assert!(target.message_queue.is_empty());
    assert_eq!(target.dead_letter_messages.len(), 1);
    assert_eq!(
        engine.state.task("agent-sibling").unwrap().status,
        kcoder_state::TaskStatus::Paused
    );
    assert!(messages_as_pairs(&app).iter().any(|(_, text)| {
        text.contains("Stopping 1 background task(s): agent-target")
    }));
}

#[tokio::test]
async fn slash_diff_renders_tracked_and_untracked_changes() {
    if std::process::Command::new("git")
        .arg("--version")
        .output()
        .is_err()
    {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    run_git_for_slash_diff_test(tmp.path(), &["init"]);
    std::fs::write(tmp.path().join("tracked.txt"), "old\n").unwrap();
    run_git_for_slash_diff_test(tmp.path(), &["add", "tracked.txt"]);
    std::fs::write(tmp.path().join("tracked.txt"), "new\n").unwrap();
    std::fs::write(tmp.path().join("untracked.txt"), "fresh\n").unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/diff", &mut app, &engine).await;

    assert!(action.is_none());
    let diff = messages_as_pairs(&app)
        .into_iter()
        .map(|(_, text)| text)
        .find(|text| text.starts_with("[Tool diff: git]"))
        .expect("/diff should add a rendered diff message");
    for expected in [
        "git diff (+2 -1)",
        "-old",
        "+new",
        "untracked.txt",
        "+fresh",
    ] {
        assert!(diff.contains(expected), "missing {expected} in {diff}");
    }
}

fn run_git_for_slash_diff_test(cwd: &Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .expect("git should be available");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn slash_raw_reports_usage_for_invalid_arg() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/raw status", &mut app, &engine).await;

    assert!(action.is_none());
    assert!(!app.raw_output_mode());
    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::System, "Usage: /raw [on|off]".to_string())]
    );
}

#[tokio::test]
async fn slash_model_without_args_opens_current_model_picker() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    {
        let mut settings = engine.settings.write().unwrap();
        settings.model_discovery.enabled = false;
        settings.model = "kimi-for-coding/k2p6".to_string();
    }
    let mut app = ReplApp::default();

    let action = handle_slash_command("/model", &mut app, &engine).await;

    assert!(action.is_none());
    let picker = app.picker_overlay.as_ref().expect("model picker opens");
    assert_eq!(
        picker.title,
        "Select Model (grouped by provider / profile / endpoint)"
    );
    assert_eq!(picker.on_confirm, PickerAction::SwitchModel);
    assert!(picker.all_items[picker.selected].contains("kimi-for-coding/k2p6"));
    assert!(picker.all_items[picker.selected].contains("kunlunmeta / kunlunmeta"));
    assert!(messages_as_pairs(&app).is_empty());
}

#[tokio::test]
async fn slash_model_picker_includes_custom_current_model() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    {
        let mut settings = engine.settings.write().unwrap();
        settings.model_discovery.enabled = false;
        settings.model = "custom-local-model".to_string();
    }
    let mut app = ReplApp::default();

    let action = handle_slash_command("/model", &mut app, &engine).await;

    assert!(action.is_none());
    let picker = app.picker_overlay.as_ref().expect("model picker opens");
    assert!(picker.all_items[picker.selected].contains("custom-local-model"));
    assert!(
        !picker
            .all_items
            .iter()
            .any(|model| model.contains("kimi-for-coding"))
    );
}

#[tokio::test]
async fn slash_model_picker_lists_only_configured_profiles() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    {
        let mut settings = engine.settings.write().unwrap();
        settings.model_discovery.enabled = false;
        settings.providers.retain(|name, _| name == "kunlunmeta");
    }
    let mut app = ReplApp::default();

    handle_slash_command("/model", &mut app, &engine).await;

    let picker = app.picker_overlay.as_ref().expect("model picker opens");
    let (provider_model, current) = {
        let settings = engine.settings.read().unwrap();
        (
            settings.providers["kunlunmeta"].default_model.clone(),
            settings.model.clone(),
        )
    };
    assert!(
        picker
            .all_items
            .iter()
            .all(|item| item.contains(&provider_model) || item.contains(&current)),
        "picker must list only configured profiles: {:?}",
        picker.all_items
    );
    assert!(
        !picker.all_items.iter().any(|item| item.contains("gpt")),
        "hardcoded known-models must not leak into the picker: {:?}",
        picker.all_items
    );
}

#[tokio::test]
async fn slash_model_switches_provider_profile_and_endpoint() {
    // The provider endpoint below must come from the fixture settings, not
    // from an ambient `KUNLUNMETA_BASE_URL` in the invoking shell.
    let _env_lock = ENV_LOCK.lock().await;
    let _base_url = EnvVarGuard::remove("KUNLUNMETA_BASE_URL");
    let _api_key = EnvVarGuard::remove("KUNLUNMETA_BASE_API_KEY");
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = Settings {
        openai_api_key: Some("test-kimi-key".to_string()),
        kunlunmeta_api_key: Some("test-kunlunmeta-key".to_string()),
        ..Settings::default()
    };
    let mut kimi = settings.providers["kunlunmeta"].clone();
    kimi.api_format = kcoder_config::ApiFormat::OpenaiChatCompletions;
    kimi.endpoint = "https://api.kimi.com/coding/v1".to_string();
    kimi.default_model = "kimi-for-coding".to_string();
    settings.providers.insert("kimi".to_string(), kimi);
    settings
        .stored_provider_credentials
        .insert("kimi".to_string(), "test-kimi-key".to_string());
    settings
        .stored_provider_credentials
        .insert("kunlunmeta".to_string(), "test-kunlunmeta-key".to_string());
    let engine = test_engine_with_settings(tmp.path(), settings);
    let mut app = ReplApp::default();

    let action = handle_slash_command("/model kimi", &mut app, &engine).await;

    assert!(action.is_none());
    assert_eq!(engine.provider_name(), "openai");
    assert_eq!(
        engine.provider_endpoint().as_deref(),
        Some("https://api.kimi.com/coding/v1")
    );
    {
        let settings = engine.settings.read().unwrap();
        assert_eq!(settings.active_provider.as_deref(), Some("kimi"));
        assert_eq!(settings.model, "kimi-for-coding");
    }

    let action = handle_slash_command("/model kunlunmeta", &mut app, &engine).await;
    assert!(action.is_none());
    assert_eq!(engine.provider_name(), "kunlunmeta");
    assert_eq!(
        engine.provider_endpoint().as_deref(),
        Some("http://127.0.0.1:8000")
    );
    let settings = engine.settings.read().unwrap();
    assert_eq!(settings.active_provider.as_deref(), Some("kunlunmeta"));
    assert_eq!(settings.model, "MiniMax-M3");
}

#[tokio::test]
async fn slash_model_switches_qualified_unknown_model_with_provider_notice() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        kunlunmeta_api_key: Some("test-kunlunmeta-key".to_string()),
        ..Settings::default()
    };
    let engine = test_engine_with_settings(tmp.path(), settings);
    let mut app = ReplApp::default();

    let action = handle_slash_command("/model kunlunmeta::Kimi-2.7", &mut app, &engine).await;

    assert!(action.is_none());
    assert_eq!(engine.provider_name(), "kunlunmeta");
    let settings = engine.settings.read().unwrap();
    assert_eq!(settings.model, "Kimi-2.7");
    assert_eq!(settings.context_window_tokens, Some(1_048_576));
    assert_eq!(settings.auto_compact_threshold_tokens, None);
    assert_eq!(settings.context_output_headroom, Some(100_000));
    assert_eq!(settings.max_tokens, Some(100_000));
    assert!(settings.model_capabilities.tools);
    assert!(settings.model_capabilities.vision);
    assert!(settings.provider_extra_body.is_empty());
    drop(settings);
    let notices = messages_as_pairs(&app);
    assert!(
        notices
            .iter()
            .any(|(_, text)| text.contains("First-use notice"))
    );
    assert!(
        notices
            .iter()
            .any(|(_, text)| text.contains("complete 'kunlunmeta' Provider configuration"))
    );
}

#[tokio::test]
async fn slash_model_rejects_ambiguous_unqualified_model_name() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default();
    settings.model_discovery.enabled = false;
    let duplicate = settings.providers["kunlunmeta"].clone();
    settings
        .providers
        .insert("second-deployment".to_string(), duplicate);
    let engine = test_engine_with_settings(tmp.path(), settings);
    let mut app = ReplApp::default();

    let action = handle_slash_command("/model MiniMax-M3", &mut app, &engine).await;

    assert!(action.is_none());
    let messages = messages_as_pairs(&app);
    assert_eq!(messages.len(), 1);
    assert!(messages[0].1.contains("ambiguous across deployments"));
    assert!(messages[0].1.contains("kunlunmeta"));
    assert!(messages[0].1.contains("second-deployment"));
}

#[tokio::test]
async fn slash_models_is_removed_after_status_merge() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/models", &mut app, &engine).await;

    assert!(action.is_none());
    assert!(app.picker_overlay.is_none());
    let messages = messages_as_pairs(&app);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].0, MessageRole::System);
    assert!(messages[0].1.contains("Unknown command: /models"));
}

#[tokio::test]
async fn slash_theme_without_args_opens_current_theme_picker() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    engine.settings.write().unwrap().code_theme = "custom-local-theme".to_string();
    let mut app = ReplApp::default();

    let action = handle_slash_command("/theme", &mut app, &engine).await;

    assert!(action.is_none());
    let picker = app.picker_overlay.as_ref().expect("theme picker opens");
    assert_eq!(picker.title, "Select Theme");
    assert_eq!(picker.on_confirm, PickerAction::SwitchTheme);
    assert_eq!(picker.selected, 0);
    assert_eq!(picker.all_items[0], "custom-local-theme");
    assert!(messages_as_pairs(&app).is_empty());
}

#[tokio::test]
async fn slash_theme_with_arg_updates_code_theme() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/theme Solarized (dark)", &mut app, &engine).await;

    assert!(action.is_none());
    assert_eq!(
        engine.settings.read().unwrap().code_theme,
        "Solarized (dark)"
    );
    assert_eq!(app.code_theme, "Solarized (dark)");
    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| text == "Theme switched to: Solarized (dark)")
    );
    let persisted = std::fs::read_to_string(tmp.path().join("test-config/settings.json"))
        .expect("/theme 应只写入测试拥有的 Settings 路径");
    let persisted: serde_json::Value =
        serde_json::from_str(&persisted).expect("持久化的 Settings 应是有效 JSON");
    assert_eq!(persisted["code_theme"], "Solarized (dark)");
}

#[tokio::test]
async fn slash_mention_prefills_file_mention_trigger() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    let action = handle_slash_command("/mention", &mut app, &engine).await;

    assert!(action.is_none());
    assert_eq!(app.input, "@");
    assert_eq!(app.cursor_grapheme_index, 1);
    assert!(messages_as_pairs(&app).is_empty());
}

#[test]
fn ctrl_c_requires_second_press_to_quit_when_idle() {
    let mut app = ReplApp::default();
    let key = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);

    let first = app.handle_key(key);

    assert!(first.is_none());
    assert_eq!(
        app.active_quit_shortcut_key(),
        Some(key_hint::ctrl(KeyCode::Char('c')))
    );

    let second = app.handle_key(key);

    assert!(matches!(second, Some(UserAction::Quit)));
    assert!(app.active_quit_shortcut_key().is_none());
}

#[test]
fn bare_c0_ctrl_c_uses_the_same_double_press_flow() {
    let mut app = ReplApp::default();
    let key = KeyEvent::new(KeyCode::Char('\u{3}'), KeyModifiers::NONE);

    let first = app.handle_key(key);
    let second = app.handle_key(key);

    assert!(first.is_none());
    assert!(matches!(second, Some(UserAction::Quit)));
}

#[test]
fn expired_ctrl_c_quit_window_requires_a_new_first_press() {
    let mut app = ReplApp::default();
    let key = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
    app.arm_quit_shortcut(key_hint::ctrl(KeyCode::Char('c')));
    app.quit_shortcut_expires_at = Some(Instant::now() - Duration::from_millis(1));

    let action = app.handle_key(key);

    assert!(action.is_none());
    assert_eq!(
        app.active_quit_shortcut_key(),
        Some(key_hint::ctrl(KeyCode::Char('c')))
    );
}

#[test]
fn armed_quit_hint_schedules_redraw_at_codex_timeout() {
    let mut app = ReplApp::default();
    app.arm_quit_shortcut(key_hint::ctrl(KeyCode::Char('c')));

    let delay = app.next_frame_tick_delay();

    assert!(delay > Duration::ZERO);
    assert!(delay <= Duration::from_secs(1));
}

#[test]
fn ctrl_z_requests_terminal_suspend() {
    let mut app = ReplApp::default();
    let key = KeyEvent::new(KeyCode::Char('z'), KeyModifiers::CONTROL);

    let action = app.handle_key(key);

    assert!(matches!(action, Some(UserAction::Suspend)));
    assert!(app.input.is_empty());
}

#[test]
fn bare_c0_ctrl_z_requests_terminal_suspend() {
    let mut app = ReplApp::default();
    let key = KeyEvent::new(KeyCode::Char('\u{1a}'), KeyModifiers::NONE);

    let action = app.handle_key(key);

    assert!(matches!(action, Some(UserAction::Suspend)));
    assert!(app.input.is_empty());
}

#[test]
fn ctrl_z_repeat_does_not_resuspend() {
    let mut app = ReplApp::default();
    let key = KeyEvent::new_with_kind(
        KeyCode::Char('z'),
        KeyModifiers::CONTROL,
        KeyEventKind::Repeat,
    );

    let action = app.handle_key(key);

    assert!(action.is_none());
    assert!(app.input.is_empty());
}

#[test]
fn first_ctrl_c_renders_quit_reminder_in_footer() {
    let mut app = ReplApp::default();
    app.arm_quit_shortcut(key_hint::ctrl(KeyCode::Char('c')));
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 12),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 12));

    terminal.draw(|frame| app.draw(frame)).unwrap();

    let rendered = terminal.backend().output();
    assert!(rendered.contains("ctrl + c again to quit"));
}

#[test]
fn shutdown_feedback_overrides_composer_draft() {
    let mut app = ReplApp {
        input: "draft that should not be rendered".to_string(),
        cursor_grapheme_index: "draft that should not be rendered".graphemes(true).count(),
        ..ReplApp::default()
    };
    app.arm_quit_shortcut(key_hint::ctrl(KeyCode::Char('c')));
    app.show_shutdown_in_progress();
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 12),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 12));

    terminal.draw(|frame| app.draw(frame)).unwrap();

    let rendered = buffer_dump(terminal.rendered_buffer_for_tests());
    assert!(rendered.contains("Shutting down..."));
    assert!(!rendered.contains("draft that should not be rendered"));
    assert!(!rendered.contains("again to quit"));
}

#[test]
fn ctrl_c_clears_draft_without_arming_quit_flow() {
    let mut app = ReplApp {
        input: "draft text".to_string(),
        cursor_grapheme_index: "draft text".graphemes(true).count(),
        ..ReplApp::default()
    };
    let key = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);

    let first = app.handle_key(key);

    assert!(first.is_none());
    assert!(app.input.is_empty());
    assert_eq!(app.cursor_grapheme_index, 0);
    assert_eq!(app.input_history, vec!["draft text".to_string()]);
    assert!(app.active_quit_shortcut_key().is_none());
}

#[test]
fn ctrl_c_records_expanded_large_paste_history() {
    let mut app = ReplApp::default();
    let large = "x".repeat(LARGE_PASTE_CHAR_THRESHOLD + 3);
    app.handle_paste_text(&large).unwrap();

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));

    assert!(action.is_none());
    assert!(app.input.is_empty());
    assert!(app.pending_pastes.is_empty());
    assert_eq!(app.input_history, vec![large]);
    assert!(app.active_quit_shortcut_key().is_none());
}

#[tokio::test]
async fn ctrl_c_clears_draft_before_interrupting_active_turn() {
    let mut app = ReplApp {
        input: "draft while running".to_string(),
        cursor_grapheme_index: "draft while running".graphemes(true).count(),
        ..ReplApp::default()
    };
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(async {
        std::future::pending::<()>().await;
    });

    app.begin_turn(handle, cancel.clone());
    let action = app.handle_key(KeyEvent::new(KeyCode::Char('C'), KeyModifiers::CONTROL));

    assert!(action.is_none());
    assert!(app.input.is_empty());
    assert_eq!(app.input_history, vec!["draft while running".to_string()]);
    assert!(!cancel.is_cancelled());
    assert!(app.is_loading);

    let handle = app.abort_turn_for_shutdown().unwrap();
    let _ = handle.await;
}

#[test]
fn ctrl_d_quits_immediately_when_composer_is_empty() {
    let mut app = ReplApp::default();
    let ctrl_d = KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL);

    assert!(matches!(app.handle_key(ctrl_d), Some(UserAction::Quit)));
    assert!(app.active_quit_shortcut_key().is_none());
}

#[test]
fn ctrl_d_deletes_forward_when_composer_has_text() {
    let mut app = ReplApp {
        input: "abc".to_string(),
        cursor_grapheme_index: 1,
        last_input_width: 80,
        ..ReplApp::default()
    };

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL));

    assert!(action.is_none());
    assert_eq!(app.input, "ac");
    assert_eq!(app.cursor_grapheme_index, 1);
    assert!(app.active_quit_shortcut_key().is_none());
}

#[test]
fn normal_key_clears_manually_armed_quit_shortcut() {
    let mut app = ReplApp::default();

    app.arm_quit_shortcut(key_hint::ctrl(KeyCode::Char('c')));
    app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE));

    assert!(app.active_quit_shortcut_key().is_none());
}

#[test]
fn ctrl_q_still_quits_immediately() {
    let mut app = ReplApp::default();

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL));

    assert!(matches!(action, Some(UserAction::Quit)));
}

#[tokio::test]
async fn esc_interrupts_active_turn_when_no_overlay_is_open() {
    let mut app = ReplApp::default();
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(async {
        std::future::pending::<()>().await;
    });

    app.begin_turn(handle, cancel.clone());

    let action = app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert!(matches!(action, Some(UserAction::Interrupt)));
    assert!(cancel.is_cancelled());
    assert!(!app.is_loading);
    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| text == "Cancelled.")
    );

    let handle = app.abort_turn_for_shutdown().unwrap();
    let _ = handle.await;
}

#[test]
fn esc_pauses_active_goal_even_between_turns() {
    let mut app = ReplApp {
        goal: Some(Goal::new("keep going", None)),
        ..ReplApp::default()
    };

    let action = app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert!(matches!(action, Some(UserAction::Interrupt)));
    assert!(
        !messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| text == "Cancelled."),
        "idle goal pause should not claim an active turn was cancelled"
    );
}

#[tokio::test]
async fn interrupt_cancels_starting_turn_before_turn_started_event() {
    let mut app = ReplApp::default();
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(async {
        std::future::pending::<()>().await;
    });

    app.begin_turn(handle, cancel.clone());
    let action = app.interrupt_current_turn();

    assert!(matches!(action, Some(UserAction::Interrupt)));
    assert!(cancel.is_cancelled());
    assert!(!app.is_loading);
    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| text == "Cancelled.")
    );

    let handle = app.abort_turn_for_shutdown().unwrap();
    let _ = handle.await;
}

#[test]
fn question_requests_wait_for_active_permission_dialog() {
    let mut app = ReplApp::default();
    let (permission_tx, mut permission_rx) = tokio::sync::oneshot::channel();
    let (question_tx, mut question_rx) = tokio::sync::oneshot::channel();

    app.enqueue_permission_dialog(permission_dialog("bash", permission_tx));
    app.enqueue_question_dialog(question_dialog(question_tx));

    assert!(app.pending_permission.is_some());
    assert!(app.pending_question.is_none());
    assert_eq!(app.question_queue.len(), 1);

    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(
        permission_rx.try_recv().unwrap().response,
        PermissionResponse::AllowOnce
    );
    assert!(app.pending_permission.is_none());
    assert!(app.pending_question.is_some());
    assert!(question_rx.try_recv().is_err());

    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    let response = question_rx.try_recv().unwrap();
    assert_eq!(
        response.answers.get("Pick one").map(String::as_str),
        Some("A")
    );
    assert!(app.pending_question.is_none());
    assert!(app.question_queue.is_empty());
}

#[test]
fn escape_shortens_running_waits_instead_of_cancelling_the_turn() {
    let mut app = ReplApp::default();
    app.set_loading(true);
    app.push_tool_running("tool-1".to_string(), "Sleep".to_string(), "{}".to_string());

    let action = app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert!(matches!(action, Some(UserAction::ShortenToolWait)));
    assert!(
        app.has_interruptible_turn(),
        "shortening must keep the turn alive so the model can continue"
    );
}

#[test]
fn escape_still_interrupts_when_only_regular_tools_run() {
    let mut app = ReplApp::default();
    app.set_loading(true);
    app.push_tool_running("tool-1".to_string(), "bash".to_string(), "{}".to_string());

    let action = app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert!(matches!(action, Some(UserAction::Interrupt)));
}

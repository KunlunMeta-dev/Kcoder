#[test]
fn goal_status_label_reports_active_budget() {
    let mut app = ReplApp::default();
    let mut goal = Goal::new("finish", Some(100));
    goal.tokens_used = 25;
    goal.turn_count = 2;
    app.goal = Some(goal);

    assert_eq!(
        app.goal_status_label(),
        "Goal running turn 2 · Esc pauses · 25 / 100"
    );
}

#[test]
fn goal_pro_creation_selection_freezes_the_configured_rejection_limit() {
    let root = tempfile::tempdir().unwrap();
    let mut settings = kcoder_config::Settings::default();
    settings.goal_pro.completion_rejection_limit = 5;
    let engine = test_engine_with_settings(root.path(), settings);

    let frozen = goal_pro_verifier_selection(&engine);
    engine
        .settings
        .write()
        .unwrap()
        .goal_pro
        .completion_rejection_limit = 3;

    assert_eq!(frozen.completion_rejection_limit, Some(5));
    assert_eq!(
        goal_pro_verifier_selection(&engine).completion_rejection_limit,
        Some(3)
    );
}

#[test]
fn goal_status_label_uses_goal_controls() {
    let mut goal = Goal::new("finish", None);
    goal.turn_count = 1;
    assert_eq!(
        goal_status_label(&goal),
        "Goal running turn 1 · Esc pauses · 0s"
    );

    goal.status = GoalStatus::Paused;
    assert_eq!(goal_status_label(&goal), "Goal paused (/goal resume)");

    goal.status = GoalStatus::Blocked;
    assert_eq!(goal_status_label(&goal), "Goal blocked (/goal resume)");

    goal.status = GoalStatus::UsageLimited;
    assert_eq!(
        goal_status_label(&goal),
        "Goal hit usage limits (/goal resume)"
    );

    goal.status = GoalStatus::BudgetLimited;
    assert_eq!(goal_status_label(&goal), "Goal abandoned");

    goal.status = GoalStatus::Complete;
    goal.token_budget = Some(10_000);
    goal.tokens_used = 1_250;
    assert_eq!(goal_status_label(&goal), "Goal complete (1.25K tokens)");
}

#[test]
fn goal_status_label_reports_completed_elapsed_without_budget() {
    let mut goal = Goal::new("finish", None);
    goal.status = GoalStatus::Complete;
    goal.time_used_seconds = 120;

    assert_eq!(goal_status_label(&goal), "Goal complete (2m)");
}

#[test]
fn turn_divider_hides_short_worked_label() {
    let line = render_turn_divider("Worked for 60s", 20);
    let text = line
        .spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect::<String>();

    assert_eq!(text, "─".repeat(20));
}

#[test]
fn turn_divider_shows_worked_label_after_one_minute() {
    let line = render_turn_divider("Worked for 1m 01s", 28);
    let text = line
        .spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect::<String>();

    assert!(text.starts_with("─ Worked for 1m 01s ─"));
    assert_eq!(unicode_width::UnicodeWidthStr::width(text.as_str()), 28);
}

#[test]
fn finish_turn_separator_is_omitted_without_work_activity() {
    let mut app = ReplApp {
        turn_started_at: Some(Instant::now() - Duration::from_secs(61)),
        turn_had_work_activity: false,
        ..ReplApp::default()
    };

    assert!(app.finish_turn_separator_text().is_none());
    assert!(app.turn_started_at.is_none());
    assert!(!app.turn_had_work_activity);
}

#[test]
fn finish_turn_separator_is_emitted_after_work_activity() {
    let mut app = ReplApp {
        turn_started_at: Some(Instant::now() - Duration::from_secs(61)),
        turn_had_work_activity: true,
        ..ReplApp::default()
    };

    let text = app
        .finish_turn_separator_text()
        .expect("worked turn should emit separator");

    assert!(text.starts_with(&format!("{TURN_DIVIDER_PREFIX}Worked for ")));
    assert!(app.turn_started_at.is_none());
    assert!(!app.turn_had_work_activity);
}

#[test]
fn goal_status_label_reports_budget_limited_usage() {
    let mut goal = Goal::new("finish", Some(10_000));
    goal.status = GoalStatus::BudgetLimited;
    goal.tokens_used = 15_200;

    assert_eq!(goal_status_label(&goal), "Goal unmet (15.2K / 10K tokens)");
}

#[test]
fn compact_token_count_uses_expected_suffixes() {
    assert_eq!(compact_token_count(999), "999");
    assert_eq!(compact_token_count(1_250), "1.25K");
    assert_eq!(compact_token_count(12_500), "12.5K");
    assert_eq!(compact_token_count(123_456), "123K");
    assert_eq!(compact_token_count(1_200_000), "1.2M");
}

#[test]
fn goal_continuation_prompt_reads_materialized_objective() {
    let dir = unique_temp_dir("goal-objective");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("goal-objective.md");
    std::fs::write(&path, "real objective from file").unwrap();
    let goal = Goal::new_with_file("file ref", Some(path), None);

    let prompt = format_goal_continuation_prompt(&goal);

    assert!(prompt.contains("real objective from file"));
    assert!(!prompt.contains("<objective>\nfile ref\n</objective>"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn goal_continuation_prompt_is_strict_and_escapes_objective() {
    let goal = Goal::new("finish <tag> & prove it", Some(100));

    let prompt = format_goal_continuation_prompt(&goal);

    assert!(prompt.contains("Completion audit:"));
    assert!(prompt.contains("Blocked audit:"));
    assert!(prompt.contains("finish &lt;tag&gt; &amp; prove it"));
    assert!(prompt.contains("Turn count: 0"));
    assert!(prompt.contains("Token budget: 100"));
    assert!(prompt.contains("Tokens remaining: 100"));
}

#[test]
fn goal_continuation_prompt_is_hidden_when_restoring_ui_transcript() {
    let goal = Goal::new("finish the work", Some(100));
    let messages = vec![
        Message::user_text("visible user request"),
        Message::runtime_text(format_goal_continuation_prompt(&goal)),
        Message::assistant_text("visible assistant answer"),
    ];
    let mut app = ReplApp::default();

    app.replace_transcript_from_history(&messages);

    let ui_text = messages_as_pairs(&app)
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(ui_text.contains("visible user request"));
    assert!(ui_text.contains("visible assistant answer"));
    assert!(!ui_text.contains("Continue working toward the active `/goal` objective"));
    assert!(!ui_text.contains("The objective below is user-provided data"));
}

#[test]
fn ultgoal_continuation_prompt_is_hidden_when_restoring_ui_transcript() {
    let goal = Goal::new_with_file_and_mode(
        "finish the orchestrated work",
        None,
        Some(100),
        GoalMode::Arrangement,
    );
    let messages = vec![
        Message::user_text("visible user request"),
        Message::runtime_text(format_goal_continuation_prompt(&goal)),
        Message::assistant_text("visible assistant answer"),
    ];
    let mut app = ReplApp::default();

    app.replace_transcript_from_history(&messages);

    let ui_text = messages_as_pairs(&app)
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(ui_text.contains("visible user request"));
    assert!(ui_text.contains("visible assistant answer"));
    assert!(!ui_text.contains("Continue working toward the active `/ultgoal` objective"));
    assert!(!ui_text.contains("This is an `/ultgoal` continuation"));
}

#[test]
fn goal_pro_continuation_prompt_is_hidden_when_restoring_ui_transcript() {
    let goal =
        Goal::new_with_file_and_mode("finish the strict work", None, Some(100), GoalMode::Strict);
    let messages = vec![
        Message::user_text("visible user request"),
        Message::runtime_text(format_goal_continuation_prompt(&goal)),
        Message::assistant_text("visible assistant answer"),
    ];
    let mut app = ReplApp::default();

    app.replace_transcript_from_history(&messages);

    let ui_text = messages_as_pairs(&app)
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(ui_text.contains("visible user request"));
    assert!(ui_text.contains("visible assistant answer"));
    assert!(!ui_text.contains("Continue working toward the active `/goal-pro` objective"));
    assert!(!ui_text.contains("This is a strict `/goal-pro` continuation"));
}

#[test]
fn internal_followup_context_is_hidden_when_pushed_directly() {
    let goal = Goal::new("finish the work", Some(100));
    let mut app = ReplApp::default();

    app.push_message(MessageRole::System, "visible notice");
    app.push_message(MessageRole::User, format_goal_continuation_prompt(&goal));
    app.push_message(
        MessageRole::Assistant,
        "[system] A background sub-agent run just completed while you were idle.",
    );
    app.push_message(
        MessageRole::Assistant,
        "[system] All tracked background sub-agents have finished. Aggregate their results.",
    );

    let ui_text = messages_as_pairs(&app)
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(ui_text.contains("visible notice"));
    assert!(ui_text.contains("Continue working toward the active `/goal` objective"));
    assert!(ui_text.contains("background sub-agent run just completed"));
    assert!(ui_text.contains("All tracked background sub-agents have finished"));
}

#[test]
fn background_notification_tags_are_model_only_context() {
    let messages = vec![
        Message::user_text("visible request"),
        Message::user_text(
            "<skill_content name=\"using-superpowers\">\ninternal skill body\n</skill_content>",
        ),
        Message::user_text(r#"<workflow_notification id="workflow-1" status="completed"/>"#),
        Message::user_text(r#"<subagent_notification id="agent-1" status="completed"/>"#),
        Message::assistant_text("visible response"),
        Message::user_text("I wrote <skill_content as ordinary visible prose."),
        Message::user_text(
            r#"<workflow_notification id="example" status="completed"/> shown as an XML example"#,
        ),
        Message::user_text(
            "<skill_content name=\"example\">visible body</skill_content>\nThis explains the example.",
        ),
        Message::assistant_text(
            r#"<workflow_notification id="assistant-text" status="completed"/>"#,
        ),
    ];
    let mut app = ReplApp::default();
    app.replace_transcript_from_history(&messages);

    let ui_text = messages_as_pairs(&app)
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(ui_text.contains("visible request"));
    assert!(ui_text.contains("visible response"));
    assert!(ui_text.contains("I wrote <skill_content as ordinary visible prose."));
    assert!(ui_text.contains("id=\"example\""));
    assert!(ui_text.contains("This explains the example."));
    assert!(ui_text.contains("id=\"assistant-text\""));
    assert!(!ui_text.contains("internal skill body"));
    assert!(!ui_text.contains("id=\"workflow-1\""));
    assert!(!ui_text.contains("id=\"agent-1\""));
}

#[test]
fn goal_turn_failure_detection_ignores_user_cancel() {
    let failure = EngineEvent::ProviderFailed {
        message: "Check API key and provider permissions.".into(),
        details: kcoder_types::ProviderFailureDetails {
            category: kcoder_types::ProviderFailureCategory::AuthenticationError,
            recovery_action: kcoder_types::ProviderFailureRecoveryAction::NeedsHuman,
            http_status: Some(401),
            retryable: false,
            resume_safe: false,
            retry_after_ms: None,
        },
    };
    assert!(goal_turn_failure_from_engine_event(&failure).is_some());
    assert!(matches!(
        engine_event_to_app_event(failure),
        Some(AppEvent::Error(_))
    ));
    assert!(
        goal_turn_failure_from_engine_event(&EngineEvent::Error("provider down".into())).is_some()
    );
    assert!(
        goal_turn_failure_from_engine_event(&EngineEvent::StreamAborted {
            reason: "provider stream idle".into()
        })
        .is_some()
    );
    assert!(
        goal_turn_failure_from_engine_event(&EngineEvent::StreamAborted {
            reason: "cancelled by user".into()
        })
        .is_none()
    );
}

#[test]
fn goal_failure_status_never_infers_blocked_from_turn_errors() {
    assert_eq!(
        goal_failure_status("Usage limit exceeded for this account"),
        GoalStatus::UsageLimited
    );
    assert_eq!(
        goal_failure_status("insufficient credit balance for this account"),
        GoalStatus::UsageLimited
    );
    for reason in [
        "provider stream idle timeout",
        "missing_api_key: no API credential is configured",
        "API error 502 Bad Gateway: anthropic_error_type=billing_gateway_error",
        "transport connection reset by peer",
        "compaction protocol repair budget exhausted",
        "unexpected turn failure",
    ] {
        assert_eq!(
            goal_failure_status(reason),
            GoalStatus::Paused,
            "turn error must stay resumable: {reason}"
        );
    }
}

#[test]
fn goal_continuation_wake_uses_cooldown_only_when_idle() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();

    assert_eq!(turn_wake_delay_after_finish(&engine, &app), Duration::ZERO);

    engine.state.set_goal("finish it", None);
    assert_eq!(
        turn_wake_delay_after_finish(&engine, &app),
        GOAL_CONTINUATION_COOLDOWN
    );

    assert!(app.enqueue_user_message_for_turn(Message::user_text("queued follow-up")));
    assert_eq!(turn_wake_delay_after_finish(&engine, &app), Duration::ZERO);
}

#[test]
fn goal_continuation_wake_stops_at_the_configured_process_limit() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    engine.settings.write().unwrap().goal_max_auto_continuations = 2;
    let goal = engine.state.set_goal("finish it", None);
    let mut app = ReplApp::default();

    app.goal_auto_continuations_started
        .insert(goal.goal_id.clone(), 1);
    assert_eq!(
        turn_wake_delay_after_finish(&engine, &app),
        GOAL_CONTINUATION_COOLDOWN
    );

    app.goal_auto_continuations_started
        .insert(goal.goal_id.clone(), 2);
    assert_eq!(turn_wake_delay_after_finish(&engine, &app), Duration::ZERO);
}

#[test]
fn goal_continuation_limit_marker_accepts_only_a_bounded_safe_token() {
    assert_eq!(
        format_goal_auto_continuation_notice_marker(Some("run_123-abc")),
        "[goal_auto_continuation_limit:run_123-abc]"
    );
    for token in ["", "contains:delimiter", "contains space", &"x".repeat(65)] {
        assert_eq!(
            format_goal_auto_continuation_notice_marker(Some(token)),
            "[goal_auto_continuation_limit]"
        );
    }
}

#[cfg(unix)]
#[test]
fn goal_continuation_limit_marker_consumes_and_closes_the_inherited_pipe() {
    let mut descriptors = [0; 2];
    assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
    let [reader, writer] = descriptors;
    // Parallel tests quickly reuse ordinary low-numbered FDs, so an F_GETFD assertion
    // after close may observe another thread's new file. Duplicate to a high number
    // before passing it to the function, preserving the inherited-descriptor closure
    // check while avoiding descriptor-number reuse races.
    let mut descriptor_limit = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    assert_eq!(
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, descriptor_limit.as_mut_ptr()) },
        0
    );
    let descriptor_limit = unsafe { descriptor_limit.assume_init() }.rlim_cur;
    let high_floor = if descriptor_limit == libc::RLIM_INFINITY {
        65_536
    } else {
        descriptor_limit
            .saturating_sub(64)
            .min(i32::MAX as libc::rlim_t) as i32
    };
    assert!(high_floor > libc::STDERR_FILENO);
    let inherited_reader = unsafe { libc::fcntl(reader, libc::F_DUPFD_CLOEXEC, high_floor) };
    assert!(inherited_reader >= high_floor);
    assert_eq!(unsafe { libc::close(reader) }, 0);
    let token = b"one_time_marker_123";
    assert_eq!(
        unsafe { libc::write(writer, token.as_ptr().cast(), token.len()) },
        token.len() as isize
    );
    assert_eq!(unsafe { libc::close(writer) }, 0);

    assert_eq!(
        goal_auto_continuation_notice_marker_from_fd(inherited_reader),
        "[goal_auto_continuation_limit:one_time_marker_123]"
    );
    assert_eq!(unsafe { libc::fcntl(inherited_reader, libc::F_GETFD) }, -1);
}

#[cfg(unix)]
#[test]
fn goal_continuation_limit_marker_rejects_non_pipe_descriptors_without_closing_them() {
    use std::os::fd::AsRawFd;

    let file = tempfile::tempfile().unwrap();
    let descriptor = file.as_raw_fd();
    assert_eq!(
        goal_auto_continuation_notice_marker_from_fd(descriptor),
        "[goal_auto_continuation_limit]"
    );
    assert_ne!(unsafe { libc::fcntl(descriptor, libc::F_GETFD) }, -1);
}

#[tokio::test]
async fn goal_continuation_limit_emits_one_notice_without_mutating_goal_audit_count() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    engine.settings.write().unwrap().goal_max_auto_continuations = 0;
    engine.state.set_goal("finish it", None);
    let mut app = ReplApp::default();
    let (raw_tx, mut rx) = tokio::sync::mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    assert!(!try_start_goal_continuation(
        &engine, &mut app, &tx, &prompt
    ));
    assert_eq!(engine.state.goal().unwrap().continuation_count, 0);
    let notice = rx.recv().await.expect("continuation limit notice");
    assert!(matches!(
        notice,
        AppEvent::SystemNotice(text)
            if text.contains("[goal_auto_continuation_limit]")
                && text.contains("auto-continuation limit reached (0)")
                && text.contains("goal remains active")
    ));

    assert!(!try_start_goal_continuation(
        &engine, &mut app, &tx, &prompt
    ));
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn interrupt_pauses_goal_with_objective_and_goal_controls() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    engine
        .state
        .set_goal("finish the migration carefully", None);
    let mut app = ReplApp::default();
    let (raw_tx, mut rx) = tokio::sync::mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let should_quit = handle_user_action(UserAction::Interrupt, &engine, &mut app, &tx, &prompt)
        .await
        .unwrap();

    assert!(!should_quit);
    assert_eq!(engine.state.goal().unwrap().status, GoalStatus::Paused);
    assert_eq!(app.goal.as_ref().unwrap().status, GoalStatus::Paused);
    let notice = rx.recv().await.expect("pause notice");
    assert!(matches!(
        notice,
        AppEvent::SystemNotice(text)
            if text.contains("/goal resume")
                && text.contains("/goal status")
                && text.contains("finish the migration carefully")
    ));
}

#[tokio::test]
async fn turn_failure_pauses_active_goal_without_overwriting_terminal_status() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let start_goal = engine.state.set_goal("finish it", None);
    let (raw_tx, mut rx) = tokio::sync::mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);

    stop_active_goal_after_turn_failure(
        &engine,
        &start_goal,
        GoalTurnFailure {
            reason: "kunlunmeta provider request rejected: API error missing_api_key".to_string(),
            status: GoalStatus::Paused,
        },
        &tx,
    )
    .await;

    let goal = engine.state.goal().expect("goal should remain present");
    assert_eq!(goal.status, GoalStatus::Paused);
    assert_eq!(goal.blocked_candidate_count, 0);
    assert!(matches!(rx.try_recv(), Ok(AppEvent::SystemNotice(message))
            if message.contains("automatically marked paused")
                && !message.contains("marked blocked")));

    engine.state.update_goal_status(GoalStatus::Complete);
    stop_active_goal_after_turn_failure(
        &engine,
        &start_goal,
        GoalTurnFailure {
            reason: "second error".to_string(),
            status: GoalStatus::Paused,
        },
        &tx,
    )
    .await;

    assert_eq!(
        engine
            .state
            .goal()
            .expect("goal should remain present")
            .status,
        GoalStatus::Complete
    );
}

#[tokio::test]
async fn provider_failure_goal_status_uses_typed_category_not_quota_text() {
    for (category, message, expected) in [
        (kcoder_types::ProviderFailureCategory::AuthenticationError, "insufficient_quota usage limit", GoalStatus::Paused),
        (kcoder_types::ProviderFailureCategory::QuotaExceeded, "opaque provider failure", GoalStatus::UsageLimited),
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let engine = test_engine(tmp.path());
        let start_goal = engine.state.set_goal("finish it", None);
        let (raw_tx, _rx) = tokio::sync::mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let failure = goal_turn_failure_from_engine_event(&EngineEvent::ProviderFailed {
            message: message.into(),
            details: kcoder_types::ProviderFailureDetails {
                category,
                recovery_action: kcoder_types::ProviderFailureRecoveryAction::NeedsHuman,
                http_status: None,
                retryable: false,
                resume_safe: false,
                retry_after_ms: None,
            },
        }).unwrap();
        stop_active_goal_after_turn_failure(&engine, &start_goal, failure, &tx).await;
        let goal = engine.state.goal().unwrap();
        assert_eq!(goal.status, expected, "{category:?}");
        assert_eq!(goal.blocked_candidate_count, 0);
    }
}

#[test]
fn goal_replacement_dialog_confirms_and_cancels() {
    let mut app = ReplApp::default();
    app.open_goal_replacement_confirmation_with_verification(
        Goal::new("old objective", Some(100)),
        "new objective".to_string(),
        Some(200),
        GoalMode::Strict,
        GoalVerificationKind::Answer,
    );

    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(100, 24),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 100, 24));
    terminal.draw(|frame| app.draw(frame)).unwrap();
    assert!(buffer_dump(terminal.rendered_buffer_for_tests()).contains("Verification: answer"));

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE));

    assert!(matches!(
        action,
        Some(UserAction::ConfirmGoalReplacement {
            objective,
            token_budget: Some(200),
            mode: GoalMode::Strict,
            verification_kind: GoalVerificationKind::Answer,
        }) if objective == "new objective"
    ));
    assert!(app.pending_goal_replacement.is_none());

    app.open_goal_replacement_confirmation(
        Goal::new("old objective", None),
        "discarded objective".to_string(),
        None,
        GoalMode::Standard,
    );

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::NONE));

    assert!(action.is_none());
    assert!(app.pending_goal_replacement.is_none());
    assert!(
        messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| text == "Goal replacement cancelled.")
    );
}

#[cfg(windows)]
#[test]
fn altgr_y_does_not_confirm_goal_replacement() {
    let mut app = ReplApp::default();
    app.open_goal_replacement_confirmation(
        Goal::new("old objective", None),
        "new objective".to_string(),
        None,
        GoalMode::Standard,
    );

    let action = app.handle_key(KeyEvent::new(
        KeyCode::Char('y'),
        KeyModifiers::CONTROL | KeyModifiers::ALT,
    ));

    assert!(action.is_none());
    assert!(app.pending_goal_replacement.is_some());
}

fn messages_as_pairs(app: &ReplApp) -> Vec<(MessageRole, String)> {
    app.messages
        .iter()
        .map(|m| (m.role, m.text.clone()))
        .collect()
}

fn active_text(app: &ReplApp) -> String {
    app.active_turn
        .as_ref()
        .map(|active| {
            active.entries.iter().fold(String::new(), |mut out, entry| {
                if let ActiveEntry::Text(text) = entry {
                    out.push_str(text);
                }
                out
            })
        })
        .unwrap_or_default()
}

fn permission_dialog(
    tool_name: &str,
    response_tx: tokio::sync::oneshot::Sender<PermissionDialogResult>,
) -> PermissionDialog {
    PermissionDialog {
        tool_name: tool_name.to_string(),
        description: format!("{tool_name} request"),
        input: serde_json::json!({ "tool": tool_name }),
        risk: PermissionRisk::Low,
        detail_lines: Vec::new(),
        response_tx,
        selected: 0,
    }
}

fn layout_sample_todos() -> Vec<TodoItem> {
    vec![
        TodoItem {
            id: "todo-1".to_string(),
            content: "Inspect renderer".to_string(),
            active_form: None,
            status: TodoStatus::Pending,
        },
        TodoItem {
            id: "todo-2".to_string(),
            content: "Patch TUI".to_string(),
            active_form: None,
            status: TodoStatus::InProgress,
        },
    ]
}

#[test]
fn permission_dialog_title_matches_question_style() {
    let (bash_tx, _bash_rx) = tokio::sync::oneshot::channel();
    let (edit_tx, _edit_rx) = tokio::sync::oneshot::channel();
    let (read_tx, _read_rx) = tokio::sync::oneshot::channel();

    assert_eq!(
        permission_dialog_title(&permission_dialog("bash", bash_tx)),
        "Would you like to run the following command?"
    );
    assert_eq!(
        permission_dialog_title(&permission_dialog("edit", edit_tx)),
        "Would you like to make the following edits?"
    );
    assert_eq!(
        permission_dialog_title(&permission_dialog("read", read_tx)),
        "Would you like to allow read?"
    );
}

#[test]
fn permission_option_labels_match_approval_style() {
    assert_eq!(
        PERMISSION_OPTION_LABELS,
        [
            "Yes, proceed",
            "Yes, and don't ask again",
            "Yes, and allow for this session",
            "No, continue without it",
            "No, and don't ask again",
            "No, and deny for this session",
            "Edit input before deciding",
        ]
    );
}

#[test]
fn permission_dialog_footer_matches_confirm_cancel_hint() {
    let line = permission_dialog_footer_line();
    let spans = line
        .spans
        .iter()
        .map(|span| span.content.to_string())
        .collect::<Vec<_>>();

    assert_eq!(
        spans,
        vec![
            "Press ".to_string(),
            "enter".to_string(),
            " to confirm or ".to_string(),
            "esc".to_string(),
            " to cancel".to_string(),
        ]
    );
}

#[test]
fn permission_dialog_lines_match_codex_approval_spacing() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let mut dialog = permission_dialog("bash", tx);
    dialog.input = serde_json::json!({ "command": "pwd" });

    let texts = permission_dialog_lines(&dialog, "")
        .iter()
        .map(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
        })
        .collect::<Vec<_>>();

    assert_eq!(texts[0], "Would you like to run the following command?");
    assert_eq!(texts[1], "");
    assert_eq!(texts[2], "Reason: bash request");
    assert_eq!(texts[3], "");
    assert_eq!(texts[4], "$ pwd");
    assert_eq!(texts[5], "");
    assert_eq!(texts[6], "› 1. Yes, proceed (y)");
    assert_eq!(
        texts.last().map(String::as_str),
        Some("Press enter to confirm or esc to cancel")
    );
}

#[test]
fn permission_dialog_geometry_handles_tiny_inline_viewport() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let dialog = permission_dialog("bash", tx);
    let area = Rect::new(0, 0, 80, 7);

    let geometry = permission_dialog_geometry(area, &dialog);

    assert!(geometry.outer.height > 0);
    assert!(geometry.outer.bottom() <= area.bottom());
}

#[test]
fn permission_dialog_geometry_handles_single_available_overlay_row() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let dialog = permission_dialog("bash", tx);
    let area = Rect::new(0, 0, 80, 5);

    let geometry = permission_dialog_geometry(area, &dialog);

    assert_eq!(geometry.outer.height, 1);
    assert!(geometry.outer.bottom() <= area.bottom());
}

fn question_dialog(
    response_tx: tokio::sync::oneshot::Sender<UserQuestionResponse>,
) -> QuestionDialog {
    let request = UserQuestionRequest {
        questions: vec![kcoder_tools::Question {
            question: "Pick one".to_string(),
            header: "Choice".to_string(),
            options: vec![
                kcoder_tools::QuestionOption {
                    label: "A".to_string(),
                    description: "First".to_string(),
                    preview: None,
                },
                kcoder_tools::QuestionOption {
                    label: "B".to_string(),
                    description: "Second".to_string(),
                    preview: None,
                },
            ],
            multi_select: false,
        }],
        answers: std::collections::HashMap::new(),
        annotations: None,
    };
    let states = question_dialog_initial_states(&request);
    let current = states.first().cloned().unwrap_or_default();
    QuestionDialog {
        request,
        response_tx,
        states,
        selected: current.selected,
        cursor: current.cursor,
        scroll_top: current.scroll_top,
        focused: 0,
    }
}

fn question_dialog_with_option_count(
    response_tx: tokio::sync::oneshot::Sender<UserQuestionResponse>,
    count: usize,
) -> QuestionDialog {
    let mut dialog = question_dialog(response_tx);
    dialog.request.questions[0].options = (1..=count)
        .map(|index| kcoder_tools::QuestionOption {
            label: format!("Option {index}"),
            description: format!("Description {index}"),
            preview: None,
        })
        .collect();
    dialog
}

fn question_dialog_with_two_questions(
    response_tx: tokio::sync::oneshot::Sender<UserQuestionResponse>,
) -> QuestionDialog {
    let mut dialog = question_dialog(response_tx);
    dialog.request.questions.push(kcoder_tools::Question {
        question: "Pick two".to_string(),
        header: "Next".to_string(),
        options: vec![
            kcoder_tools::QuestionOption {
                label: "C".to_string(),
                description: "Third".to_string(),
                preview: None,
            },
            kcoder_tools::QuestionOption {
                label: "D".to_string(),
                description: "Fourth".to_string(),
                preview: None,
            },
        ],
        multi_select: false,
    });
    dialog
}

#[test]
fn question_dialog_render_matches_expected_surface() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let dialog = question_dialog(tx);

    let rendered = question_dialog_render(&dialog, 72);
    let text = lines_to_text(&rendered.lines);

    assert!(text.contains("Question 1/1"));
    assert!(text.contains("single choice"));
    assert!(text.contains("[Choice] Pick one"));
    assert!(text.contains("› ● A - First"));
    assert!(text.contains("  ○ B - Second"));
    assert!(text.contains("enter to submit answer"));
    assert_eq!(rendered.option_start, 3);
}

#[test]
fn question_dialog_geometry_handles_tiny_inline_viewport() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let dialog = question_dialog(tx);
    let area = Rect::new(0, 0, 80, 7);

    let geometry = question_dialog_geometry(area, &dialog);

    assert!(geometry.outer.height > 0);
    assert!(geometry.outer.bottom() <= area.bottom());
}

#[test]
fn question_dialog_geometry_handles_single_available_overlay_row() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let dialog = question_dialog(tx);
    let area = Rect::new(0, 0, 80, 5);

    let geometry = question_dialog_geometry(area, &dialog);

    assert_eq!(geometry.outer.height, 1);
    assert!(geometry.outer.bottom() <= area.bottom());
}

#[test]
fn pending_question_dialog_draw_handles_single_available_overlay_row() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 5),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 5));
    let mut app = ReplApp {
        pending_question: Some(question_dialog(tx)),
        ..ReplApp::default()
    };

    terminal.draw(|frame| app.draw(frame)).unwrap();

    assert!(
        terminal.backend().hide_cursor_count > 0,
        "centered question dialog should own the live viewport cursor state"
    );
}

#[test]
fn question_dialog_footer_wraps_tips_without_splitting_tips() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let dialog = question_dialog_with_two_questions(tx);

    let width = 34usize;
    let lines = question_dialog_footer_tip_lines(&dialog, width, false, false);
    assert!(lines.len() > 1);
    let separator_width = unicode_width::UnicodeWidthStr::width(QUESTION_DIALOG_FOOTER_SEPARATOR);
    for tips in lines {
        let used = tips.iter().enumerate().fold(0usize, |acc, (index, tip)| {
            let tip_width = unicode_width::UnicodeWidthStr::width(tip.text.as_str()).min(width);
            let extra = if index == 0 {
                tip_width
            } else {
                separator_width.saturating_add(tip_width)
            };
            acc.saturating_add(extra)
        });
        assert!(used <= width, "footer line exceeds width: {used} > {width}");
    }
}

#[test]
fn question_dialog_adds_auto_other_option_for_single_choice() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let dialog = question_dialog(tx);

    let rendered = question_dialog_render(&dialog, 72);
    let text = lines_to_text(&rendered.lines);

    assert_eq!(
        question_dialog_option_count(&dialog.request.questions[0]),
        dialog.request.questions[0].options.len() + 1
    );
    assert!(text.contains("None of the above"));
    assert!(text.contains("Optionally, describe the better answer"));
}

#[test]
fn question_dialog_does_not_add_auto_other_option_for_multi_select() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let mut dialog = question_dialog(tx);
    dialog.request.questions[0].multi_select = true;

    assert_eq!(
        question_dialog_option_count(&dialog.request.questions[0]),
        dialog.request.questions[0].options.len()
    );
}

#[test]
fn question_dialog_other_option_submits_label() {
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    let dialog = question_dialog(tx);
    let mut app = ReplApp {
        pending_question: Some(dialog),
        last_frame_area: Some(Rect::new(0, 0, 100, 30)),
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    let response = rx.try_recv().expect("question response");
    assert_eq!(
        response.answers.get("Pick one").map(String::as_str),
        Some(QUESTION_DIALOG_OTHER_OPTION_LABEL)
    );
    assert!(app.pending_question.is_none());
}

#[test]
fn question_dialog_wraps_long_option_descriptions() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let mut dialog = question_dialog(tx);
    dialog.request.questions[0].options[0].description =
        "First option description continues with important tail text".to_string();

    let rendered = question_dialog_render(&dialog, 34);
    let text = lines_to_text(&rendered.lines);

    assert!(text.contains("› ● A - First option description"));
    assert!(text.contains("important"));
    assert!(text.contains("tail text"));
    assert!(rendered.lines.len() > 6);
}

#[test]
fn slash_menu_row_renders_command_and_description_together() {
    let line = slash_menu_row_line(
        "/resume",
        "resume a saved chat with a deliberately long tail",
        true,
        9,
        30,
    );
    let text = lines_to_text(std::slice::from_ref(&line));

    assert!(text.starts_with("/resume  resume"));
    assert!(!text.contains('›'));
    assert!(line_truncation::line_width(&line) <= 30);
    for span in line.spans {
        assert_eq!(span.style.fg, Some(KCODER_UI_THEME.accent_primary));
        assert!(span.style.add_modifier.contains(Modifier::BOLD));
    }
}

#[test]
fn slash_menu_geometry_matches_bottom_overlay_shape() {
    let overlay_area = Rect::new(2, 16, 80, 8);
    let geometry = slash_menu_geometry(overlay_area, 12, 0).expect("geometry");

    assert_eq!(geometry.visible_items, SLASH_MENU_MAX_ITEMS);
    assert_eq!(geometry.outer.height, SLASH_MENU_MAX_ITEMS as u16);
    assert_eq!(geometry.outer.y, overlay_area.y);
    assert_eq!(geometry.outer.x, overlay_area.x);
    assert_eq!(geometry.inner.y, geometry.outer.y);
    assert_eq!(geometry.inner.height, geometry.outer.height);
    assert_eq!(
        geometry.inner.x,
        geometry.outer.x.saturating_add(SLASH_MENU_LEFT_INSET)
    );
    assert_eq!(
        geometry.inner.width,
        geometry.outer.width.saturating_sub(SLASH_MENU_LEFT_INSET)
    );
}

#[test]
fn slash_menu_geometry_clips_to_bottom_overlay_height() {
    let overlay_area = Rect::new(0, 14, 100, 5);
    let geometry = slash_menu_geometry(overlay_area, 12, 0).expect("geometry");

    assert!(geometry.outer.y >= overlay_area.y);
    assert!(geometry.outer.bottom() <= overlay_area.bottom());
    assert_eq!(geometry.visible_items, 5);
}

#[test]
fn slash_menu_geometry_returns_none_without_bottom_overlay_rows() {
    let overlay_area = Rect::new(0, 14, 100, 0);

    assert!(slash_menu_geometry(overlay_area, 12, 0).is_none());
}

#[test]
fn slash_menu_geometry_never_replaces_composer() {
    let overlay_area = Rect::new(0, 14, 100, 2);
    let composer_area = Rect::new(0, 16, 100, 3);
    let geometry = slash_menu_geometry(overlay_area, 12, 0).expect("geometry");

    assert_eq!(geometry.outer.y, overlay_area.y);
    assert!(geometry.outer.bottom() <= composer_area.y);
    assert_eq!(geometry.visible_items, 2);
}

#[test]
fn slash_menu_filters_by_command_or_alias_prefix_not_description() {
    let app = ReplApp {
        input: "/saved".to_string(),
        cursor_grapheme_index: 6,
        ..ReplApp::default()
    };

    assert!(
        app.slash_menu_matches().is_empty(),
        "description text like 'saved chat' should not match slash-command filtering"
    );
}

#[test]
fn slash_menu_exact_matches_precede_prefix_matches() {
    let app = ReplApp {
        input: "/model".to_string(),
        cursor_grapheme_index: 6,
        ..ReplApp::default()
    };

    let names: Vec<&str> = app
        .slash_menu_matches()
        .into_iter()
        .map(|cmd| cmd.name())
        .collect();

    assert_eq!(names.first().copied(), Some("/model"));
    assert!(!names.contains(&"/models"));
}

#[test]
fn slash_menu_prefix_matches_preserve_registry_order() {
    let app = ReplApp {
        input: "/m".to_string(),
        cursor_grapheme_index: 2,
        ..ReplApp::default()
    };

    let names: Vec<&str> = app
        .slash_menu_matches()
        .into_iter()
        .map(|cmd| cmd.name())
        .collect();

    assert_eq!(
        names,
        vec![
            "/model",
            "/mention",
            "/memories",
            "/moa",
            "/moa-plan",
            "/mcp",
        ]
    );
}

#[test]
fn slash_menu_matches_alias_prefix_to_primary_command() {
    let app = ReplApp {
        input: "/exit".to_string(),
        cursor_grapheme_index: 5,
        ..ReplApp::default()
    };

    let names: Vec<&str> = app
        .slash_menu_matches()
        .into_iter()
        .map(|cmd| cmd.name())
        .collect();

    assert_eq!(names, vec!["/quit"]);
}

#[test]
fn question_dialog_scrolls_cursor_into_visible_window() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let mut dialog = question_dialog_with_option_count(tx, 10);
    dialog.cursor = 9;
    dialog.selected = vec![9];
    let area = Rect::new(0, 0, 100, 16);

    let geometry = question_dialog_geometry(area, &dialog);
    let rendered = question_dialog_render_window(
        &dialog,
        geometry.inner.width,
        geometry.first_option,
        geometry.visible_options,
        geometry.option_rows,
        geometry.footer_lines,
    );
    let text = lines_to_text(&rendered.lines);

    assert_eq!(geometry.visible_options, 5);
    assert_eq!(geometry.first_option, 5);
    assert_eq!(rendered.lines.len(), usize::from(geometry.inner.height));
    assert!(text.contains("Option 6"));
    assert!(text.contains("› ● Option 10 - Description 10"));
    assert!(text.contains("↑/↓ more options"));
    assert!(!text.contains("Option 5"));
}

#[test]
fn question_dialog_left_right_navigation_preserves_ui_state_without_committing_answers() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let mut dialog = question_dialog_with_two_questions(tx);
    dialog.cursor = 1;
    dialog.selected = vec![1];

    let mut app = ReplApp {
        pending_question: Some(dialog),
        last_frame_area: Some(Rect::new(0, 0, 100, 30)),
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
    {
        let dialog = app.pending_question.as_ref().expect("question dialog");
        assert_eq!(dialog.focused, 1);
        assert!(!dialog.request.answers.contains_key("Pick one"));
        assert_eq!(dialog.selected, vec![0]);
    }

    {
        let dialog = app.pending_question.as_mut().expect("question dialog");
        dialog.cursor = 1;
        dialog.selected = vec![1];
    }

    app.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
    let dialog = app.pending_question.as_ref().expect("question dialog");
    assert_eq!(dialog.focused, 0);
    assert_eq!(dialog.cursor, 1);
    assert_eq!(dialog.selected, vec![1]);
    assert!(!dialog.request.answers.contains_key("Pick two"));
}

#[test]
fn question_dialog_navigation_does_not_submit_default_answer() {
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    let dialog = question_dialog_with_two_questions(tx);
    let mut app = ReplApp {
        pending_question: Some(dialog),
        last_frame_area: Some(Rect::new(0, 0, 100, 30)),
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    let response = rx.try_recv().expect("question response");
    assert!(!response.answers.contains_key("Pick one"));
    assert_eq!(
        response.answers.get("Pick two").map(String::as_str),
        Some("C")
    );
}

#[test]
fn question_dialog_hit_index_tracks_rendered_option_start() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let dialog = question_dialog(tx);
    let area = Rect::new(0, 0, 100, 30);
    let geometry = question_dialog_geometry(area, &dialog);

    assert_eq!(
        question_option_hit_index(
            area,
            &dialog,
            geometry.inner.x,
            geometry.option_start_y.saturating_add(1),
        ),
        Some(1)
    );
}

#[test]
fn question_dialog_hit_index_maps_wrapped_description_rows_to_option() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let mut dialog = question_dialog(tx);
    dialog.request.questions[0].options[0].description =
        "First option description continues with important tail text".to_string();
    let area = Rect::new(0, 0, 60, 16);
    let geometry = question_dialog_geometry(area, &dialog);

    assert!(
        question_option_height(
            &dialog.request.questions[0],
            0,
            usize::from(geometry.inner.width)
        ) > 1
    );
    assert_eq!(
        question_option_hit_index(
            area,
            &dialog,
            geometry.inner.x,
            geometry.option_start_y.saturating_add(1),
        ),
        Some(0)
    );
}

#[test]
fn question_dialog_hit_index_uses_visible_window() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let mut dialog = question_dialog_with_option_count(tx, 10);
    dialog.cursor = 9;
    dialog.selected = vec![9];
    let area = Rect::new(0, 0, 100, 16);
    let geometry = question_dialog_geometry(area, &dialog);

    assert_eq!(
        question_option_hit_index(area, &dialog, geometry.inner.x, geometry.option_start_y),
        Some(5)
    );
    assert_eq!(
        question_option_hit_index(
            area,
            &dialog,
            geometry.inner.x,
            geometry.option_start_y.saturating_add(4),
        ),
        Some(9)
    );
    assert_eq!(
        question_option_hit_index(
            area,
            &dialog,
            geometry.inner.x,
            geometry.option_start_y.saturating_add(5),
        ),
        None
    );
}

#[test]
fn question_dialog_page_keys_keep_cursor_visible() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let dialog = question_dialog_with_option_count(tx, 10);
    let mut app = ReplApp {
        last_frame_area: Some(Rect::new(0, 0, 100, 16)),
        ..ReplApp::default()
    };
    app.enqueue_question_dialog(dialog);

    app.handle_question_key(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE));
    let dialog = app.pending_question.as_ref().unwrap();
    assert_eq!(dialog.cursor, 5);
    assert_eq!(dialog.scroll_top, 1);

    app.handle_question_key(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE));
    let dialog = app.pending_question.as_ref().unwrap();
    let last_index = question_dialog_option_count(&dialog.request.questions[0]) - 1;
    assert_eq!(dialog.cursor, last_index);
    assert!(question_option_visible_from_top(
        &dialog.request.questions[0],
        usize::MAX,
        dialog.scroll_top,
        dialog.cursor,
        QUESTION_DIALOG_DEFAULT_VISIBLE_OPTIONS,
    ));

    let page_up_step = question_dialog_visible_options_for_area(dialog, app.last_frame_area);
    app.handle_question_key(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE));
    let dialog = app.pending_question.as_ref().unwrap();
    assert_eq!(dialog.cursor, last_index.saturating_sub(page_up_step));
    assert!(question_option_visible_from_top(
        &dialog.request.questions[0],
        usize::MAX,
        dialog.scroll_top,
        dialog.cursor,
        QUESTION_DIALOG_DEFAULT_VISIBLE_OPTIONS,
    ));
}

#[test]
fn multi_select_question_cursor_does_not_mutate_selection() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let mut dialog = question_dialog(tx);
    dialog.request.questions[0].multi_select = true;
    let mut app = ReplApp::default();
    app.enqueue_question_dialog(dialog);

    app.handle_question_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));

    let dialog = app.pending_question.as_ref().unwrap();
    assert_eq!(dialog.cursor, 1);
    assert_eq!(dialog.selected, vec![0]);

    app.handle_question_key(KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE));
    let dialog = app.pending_question.as_ref().unwrap();
    assert_eq!(dialog.cursor, 1);
    assert_eq!(dialog.selected, vec![0, 1]);

    app.handle_question_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    let dialog = app.pending_question.as_ref().unwrap();
    assert_eq!(dialog.cursor, 0);
    assert_eq!(dialog.selected, vec![0, 1]);
}

fn assert_overlay_consistent(app: &ReplApp) {
    assert_eq!(app.active_overlay_kinds(), app.overlay_payload_kinds());
}

#[test]
fn nonblocking_overlays_replace_each_other() {
    let mut app = ReplApp::default();

    app.open_history_search();
    assert_eq!(app.active_overlay_kinds(), vec![OverlayKind::HistorySearch]);
    assert_overlay_consistent(&app);

    app.open_keys_overlay();

    assert_eq!(app.active_overlay_kinds(), vec![OverlayKind::Keys]);
    assert!(app.history_search.is_none());
    assert_overlay_consistent(&app);

    app.open_transcript_overlay();

    assert_eq!(app.active_overlay_kinds(), vec![OverlayKind::Transcript]);
    assert!(app.keys_overlay.is_none());
    assert_overlay_consistent(&app);
}

#[test]
fn close_nonblocking_overlays_clears_active_overlay_state() {
    let mut app = ReplApp::default();

    app.open_keys_overlay();
    assert_eq!(app.active_overlay_kinds(), vec![OverlayKind::Keys]);

    app.close_nonblocking_overlays();

    assert!(app.active_overlay_kinds().is_empty());
    assert!(app.keys_overlay.is_none());
    assert_overlay_consistent(&app);
}

#[test]
fn readonly_overlays_close_on_ctrl_c() {
    let mut app = ReplApp::default();
    app.open_context_inspector(ContextBreakdown {
        total_window: 0,
        system: 0,
        tools: 0,
        reserved_output: 0,
        message_budget: 0,
        messages_used: 0,
        user: 0,
        assistant: 0,
        tool_use: 0,
        tool_result: 0,
        thinking: 0,
    });
    app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
    assert!(app.context_inspector.is_none());
    assert!(app.active_overlay_kinds().is_empty());

    app.open_settings_inspector(vec!["setting = value".to_string()]);
    app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
    assert!(app.settings_inspector.is_none());
    assert!(app.active_overlay_kinds().is_empty());

    app.open_keys_overlay();
    app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
    assert!(app.keys_overlay.is_none());
    assert!(app.active_overlay_kinds().is_empty());

    app.open_transcript_overlay();
    app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
    assert!(app.transcript_overlay.is_none());
    assert!(app.active_overlay_kinds().is_empty());

    assert!(app.active_quit_shortcut_key().is_none());
    assert_overlay_consistent(&app);
}

#[test]
fn question_mark_opens_footer_shortcuts_overlay_when_composer_empty() {
    let mut app = ReplApp::default();

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE))
            .is_none()
    );

    assert!(app.footer_shortcuts_overlay);
    assert!(app.active_overlay_kinds().is_empty());
    assert!(app.keys_overlay.is_none());
    assert_overlay_consistent(&app);
}

#[test]
fn shift_question_mark_opens_footer_shortcuts_overlay_when_composer_empty() {
    let mut app = ReplApp::default();

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::SHIFT))
            .is_none()
    );

    assert!(app.footer_shortcuts_overlay);
    assert!(app.active_overlay_kinds().is_empty());
    assert!(app.keys_overlay.is_none());
    assert_overlay_consistent(&app);
}

#[test]
fn question_mark_toggles_footer_shortcuts_overlay_closed() {
    let mut app = ReplApp::default();

    app.handle_key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE));

    assert!(app.active_overlay_kinds().is_empty());
    assert!(!app.footer_shortcuts_overlay);
    assert!(app.keys_overlay.is_none());
    assert_overlay_consistent(&app);
}

#[test]
fn repeated_question_mark_does_not_retoggle_footer_shortcuts_overlay() {
    let mut app = ReplApp::default();

    app.handle_key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE));
    app.handle_key(KeyEvent::new_with_kind(
        KeyCode::Char('?'),
        KeyModifiers::NONE,
        KeyEventKind::Repeat,
    ));

    assert!(app.footer_shortcuts_overlay);
    assert!(app.input.is_empty());
    assert_overlay_consistent(&app);
}

#[test]
fn footer_shortcuts_overlay_closes_on_escape() {
    let mut app = ReplApp::default();

    app.handle_key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert!(!app.footer_shortcuts_overlay);
    assert!(app.edit_previous_hint_visible);
    assert!(!app.edit_previous_primed);
    assert!(app.active_overlay_kinds().is_empty());
    assert_overlay_consistent(&app);
}

#[test]
fn edit_previous_hint_after_overlay_primes_on_next_escape() {
    let mut app = ReplApp::default();

    app.handle_key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    let action = app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert!(action.is_none());
    assert!(!app.edit_previous_hint_visible);
    assert!(app.edit_previous_primed);
}

#[test]
fn shortcut_overlay_preserves_primed_edit_previous_hint() {
    let mut app = ReplApp::default();

    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.edit_previous_primed);

    app.handle_key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE));

    assert!(app.footer_shortcuts_overlay);
    assert!(app.edit_previous_primed);
}

#[test]
fn escape_after_quit_reminder_shows_edit_previous_hint() {
    let mut app = ReplApp::default();

    app.arm_quit_shortcut(key_hint::ctrl(KeyCode::Char('c')));
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert!(app.quit_shortcut_key.is_none());
    assert!(app.edit_previous_hint_visible);
    assert!(!app.edit_previous_primed);
}

#[test]
fn footer_shortcuts_overlay_closes_when_typing_and_keeps_input() {
    let mut app = ReplApp::default();

    app.handle_key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE));

    assert!(!app.footer_shortcuts_overlay);
    assert_eq!(app.input, "a");
    assert_overlay_consistent(&app);
}

#[test]
fn question_mark_in_draft_inserts_literal_input() {
    let mut app = ReplApp {
        input: "h".to_string(),
        cursor_grapheme_index: 1,
        ..ReplApp::default()
    };

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE))
            .is_none()
    );

    assert!(app.keys_overlay.is_none());
    assert!(!app.footer_shortcuts_overlay);
    assert_eq!(app.input, "h?");
    assert!(app.active_overlay_kinds().is_empty());
    assert_overlay_consistent(&app);
}

#[test]
fn permission_edit_transitions_active_overlay_to_editor() {
    let mut app = ReplApp::default();
    let (tx, _rx) = tokio::sync::oneshot::channel();

    app.enqueue_permission_dialog(permission_dialog("bash", tx));
    app.finish_permission_dialog_with_response(PermissionResponse::Edit);

    assert_eq!(
        app.active_overlay_kinds(),
        vec![OverlayKind::PermissionEditor]
    );
    assert!(app.pending_permission.is_none());
    assert!(app.permission_editor.is_some());
    assert_overlay_consistent(&app);
}

#[test]
fn blocking_permission_prompt_closes_nonblocking_overlay() {
    let mut app = ReplApp::default();
    let (tx, mut rx) = tokio::sync::oneshot::channel();

    app.open_keys_overlay();
    app.enqueue_permission_dialog(permission_dialog("bash", tx));

    assert_eq!(app.active_overlay_kinds(), vec![OverlayKind::Permission]);
    assert!(app.keys_overlay.is_none());
    assert!(rx.try_recv().is_err());
    assert_overlay_consistent(&app);
}

#[test]
fn blocking_modal_prevents_new_nonblocking_overlay() {
    let mut app = ReplApp::default();
    let (tx, _rx) = tokio::sync::oneshot::channel();

    app.enqueue_permission_dialog(permission_dialog("bash", tx));
    app.open_history_search();

    assert_eq!(app.active_overlay_kinds(), vec![OverlayKind::Permission]);
    assert!(app.history_search.is_none());
    assert_overlay_consistent(&app);
}

#[test]
fn slash_menu_is_suppressed_while_overlay_is_active() {
    let mut app = ReplApp {
        input: "/".to_string(),
        cursor_grapheme_index: 1,
        ..ReplApp::default()
    };

    app.open_keys_overlay();
    app.sync_slash_menu();

    assert_eq!(app.active_overlay_kinds(), vec![OverlayKind::Keys]);
    assert!(app.slash_menu.is_none());
    assert_overlay_consistent(&app);
}

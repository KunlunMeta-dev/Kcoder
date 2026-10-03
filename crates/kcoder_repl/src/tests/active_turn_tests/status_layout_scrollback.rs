#[test]
fn pending_scroll_delta_accumulates() {
    let mut app = ReplApp::default();

    app.transcript_viewport.queue_wheel(ScrollDirection::Up);
    app.transcript_viewport.queue_wheel(ScrollDirection::Up);

    assert_eq!(app.transcript_viewport.pending_delta(), -6);
}

#[test]
fn tool_result_expands_when_expanded_true() {
    let msg = DisplayMessage {
        role: MessageRole::System,
        text: "✓ Tool succeeded: bash - ok\nfirst line\nsecond line".to_string(),
    };

    let collapsed = render_message(&msg, None, false, false, false, "");
    let expanded = render_message(&msg, None, false, true, false, "");

    assert!(expanded.len() > collapsed.len());
    assert!(lines_to_text(&expanded).contains("second line"));
}

#[test]
fn scrollback_commit_target_advances_when_not_at_tail() {
    let app = ReplApp {
        messages: (0..TRANSCRIPT_SCROLLBACK_FLUSH_MAX_MESSAGES + 2)
            .map(|idx| DisplayMessage {
                role: MessageRole::Assistant,
                text: format!("message {idx}"),
            })
            .collect(),
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(0),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };

    let target =
        transcript_scrollback_commit_target(app.messages.len(), app.scrollback_committed_until);

    assert!(target > app.scrollback_committed_until);
}

#[test]
fn scrollback_commit_target_commits_single_completed_overflowing_message() {
    let app = ReplApp {
        messages: vec![DisplayMessage {
            role: MessageRole::System,
            text: (0..40)
                .map(|idx| format!("help line {idx}"))
                .collect::<Vec<_>>()
                .join("\n"),
        }]
        .into(),
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };

    assert_eq!(app.scrollback_commit_target(0), 1);
    assert_eq!(app.scrollback_commit_target_for_viewport(0, 80, 10), 1);
}

#[test]
fn scrollback_commit_target_keeps_stable_stream_chunks_in_live_viewport() {
    let app = ReplApp {
        messages: vec![DisplayMessage {
            role: MessageRole::Assistant,
            text: (0..40)
                .map(|idx| format!("stream line {idx}"))
                .collect::<Vec<_>>()
                .join("\n"),
        }]
        .into(),
        is_loading: true,
        active_turn: Some(ActiveCell::default()),
        streaming_transcript_start: Some(0),
        recent_turn_transcript_start: Some(0),
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };

    assert_eq!(app.scrollback_commit_target_for_viewport(0, 80, 10), 0);
}

#[test]
fn scrollback_commit_target_commits_finalized_response_without_recent_turn_retention() {
    let app = ReplApp {
        messages: vec![
            DisplayMessage {
                role: MessageRole::User,
                text: "介绍你的工具".to_string(),
            },
            DisplayMessage {
                role: MessageRole::Assistant,
                text: "finalized answer".to_string(),
            },
        ]
        .into(),
        recent_turn_transcript_start: Some(0),
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };

    assert_eq!(app.scrollback_commit_target_for_viewport(0, 80, 10), 2);
}

#[test]
fn scrollback_commit_target_retains_current_viewport_stream_tail() {
    let old_messages = TRANSCRIPT_SCROLLBACK_FLUSH_MAX_MESSAGES + 20;
    let stream_chunks = TRANSCRIPT_SCROLLBACK_FLUSH_MAX_MESSAGES + 20;
    let app = ReplApp {
        messages: (0..old_messages + stream_chunks)
            .map(|idx| DisplayMessage {
                role: MessageRole::Assistant,
                text: format!("message {idx}\n"),
            })
            .collect(),
        streaming_output_active: true,
        streaming_transcript_start: Some(old_messages),
        recent_turn_transcript_start: Some(old_messages),
        is_loading: true,
        scrollback_committed_until: old_messages,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };

    let target = app.scrollback_commit_target_for_viewport(old_messages, 80, 10);
    assert_eq!(
        target,
        old_messages + stream_chunks - 10,
        "older chunks should flush while one viewport tail remains live"
    );
}

#[test]
fn scrollback_commit_target_holds_completed_messages_while_turn_is_live() {
    let mut app = ReplApp {
        messages: vec![DisplayMessage {
            role: MessageRole::User,
            text: "介绍你的工具".to_string(),
        }]
        .into(),
        is_loading: true,
        active_turn: Some(ActiveCell::default()),
        recent_turn_transcript_start: Some(0),
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };

    assert_eq!(app.scrollback_commit_target_for_viewport(0, 80, 10), 0);

    app.push_message(MessageRole::Assistant, "stable line");
    assert_eq!(app.scrollback_commit_target_for_viewport(0, 80, 10), 0);
}

#[test]
fn scrollback_commit_target_commits_recent_turn_when_finalized() {
    let old_messages = 6;
    let app = ReplApp {
        messages: (0..old_messages)
            .map(|idx| DisplayMessage {
                role: MessageRole::Assistant,
                text: format!("old message {idx}"),
            })
            .chain([
                DisplayMessage {
                    role: MessageRole::User,
                    text: "ordinary second message".to_string(),
                },
                DisplayMessage {
                    role: MessageRole::Assistant,
                    text: "long final answer".to_string(),
                },
            ])
            .collect(),
        recent_turn_transcript_start: Some(old_messages),
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };

    assert_eq!(app.scrollback_commit_target(0), old_messages + 2);
}

#[test]
fn scrollback_commit_target_returns_to_natural_target_after_stream_finalization() {
    let old_messages = TRANSCRIPT_SCROLLBACK_FLUSH_MAX_MESSAGES + 20;
    let stream_chunks = TRANSCRIPT_SCROLLBACK_FLUSH_MAX_MESSAGES + 20;
    let mut app = ReplApp {
        messages: (0..old_messages + stream_chunks)
            .map(|idx| DisplayMessage {
                role: MessageRole::Assistant,
                text: format!("message {idx}\n"),
            })
            .collect(),
        streaming_output_active: true,
        streaming_transcript_start: Some(old_messages),
        scrollback_committed_until: old_messages,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };

    assert!(app.consolidate_finished_assistant_stream());
    app.finish_streaming_text_status();

    assert!(app.streaming_transcript_start.is_none());
    assert_eq!(
        app.scrollback_commit_target(0),
        transcript_scrollback_commit_target(app.messages.len(), 0)
    );
}

#[test]
fn background_status_label_reports_running_and_failed_agents() {
    let mut app = ReplApp::default();
    app.record_background_job_hint(BackgroundJobHint {
        id: "job-running".to_string(),
        description: "running".to_string(),
        state: BackgroundJobHintState::Running,
        error: None,
        started_at: None,
    });
    app.record_background_job_hint(BackgroundJobHint {
        id: "job-failed".to_string(),
        description: "failed".to_string(),
        state: BackgroundJobHintState::Failed,
        error: Some("boom".to_string()),
        started_at: None,
    });

    assert_eq!(app.background_status_label(), "agents 1 running 1 failed");
}

#[test]
fn repeated_stable_job_id_replaces_the_previous_running_hint() {
    let mut app = ReplApp::default();
    for attempt in 0..3 {
        app.record_background_job_hint(BackgroundJobHint {
            id: "workflow-stable".to_string(),
            description: format!("Workflow attempt {attempt}"),
            state: BackgroundJobHintState::Running,
            error: None,
            started_at: Some(Instant::now()),
        });
    }
    assert_eq!(app.background_job_hints().len(), 1);
    assert!(app.complete_background_job_hint(
        "workflow-stable",
        BackgroundJobHintState::Completed,
        None,
    ));
    assert_eq!(app.background_status_label(), "");
}

#[test]
fn background_status_reports_a_long_quiet_period_without_marking_failure() {
    let mut app = ReplApp::default();
    app.record_background_job_hint(BackgroundJobHint {
        id: "job-running".to_string(),
        description: "Explore agent: inspect project".to_string(),
        state: BackgroundJobHintState::Running,
        error: None,
        started_at: Some(Instant::now() - Duration::from_secs(16)),
    });

    let label = app.background_status_label();
    assert!(label.contains("agents 1 running"), "{label}");
    assert!(label.contains("no background update 16s"), "{label}");
    assert!(!label.contains("failed"), "{label}");
    assert!(app.needs_scheduled_frame_tick());
    assert_eq!(app.next_frame_tick_delay(), Duration::from_secs(1));
}

#[test]
fn foreground_agent_activity_uses_the_latest_child_progress() {
    let mut app = ReplApp::default();
    app.push_tool_running(
        "tool-agent".to_string(),
        "spawn_agent".to_string(),
        r#"{"description":"Inspect scheduler","message":"Inspect scheduler"}"#.to_string(),
    );
    app.record_background_job_hint(BackgroundJobHint {
        id: "agent-progress".to_string(),
        description: "Explore agent: Inspect scheduler".to_string(),
        state: BackgroundJobHintState::Running,
        error: None,
        started_at: Some(Instant::now()),
    });
    assert!(app.update_background_job_progress(
        "agent-progress",
        "Running read".to_string(),
        Some(2),
        Some(60),
    ));

    let activity = app.activity_presentation();
    assert!(
        activity.label.starts_with("Turn 2/max 60 · Running read"),
        "{}",
        activity.label
    );
}

#[test]
fn foreground_activity_reports_parallel_tool_count() {
    let mut app = ReplApp::default();
    app.push_tool_running(
        "tool-1".to_string(),
        "read".to_string(),
        r#"{"file":"README.md"}"#.to_string(),
    );
    app.push_tool_running(
        "tool-2".to_string(),
        "bash".to_string(),
        r#"{"command":"cargo test"}"#.to_string(),
    );

    assert!(
        app.activity_presentation()
            .label
            .ends_with("2 tools running")
    );
}

#[test]
fn background_status_label_separates_tool_tasks_from_agents() {
    let mut app = ReplApp::default();
    app.record_background_job_hint(BackgroundJobHint {
        id: "job-agent".to_string(),
        description: "Explore agent: inspect project".to_string(),
        state: BackgroundJobHintState::Running,
        error: None,
        started_at: None,
    });
    app.record_background_job_hint(BackgroundJobHint {
        id: "job-task".to_string(),
        description: kcoder_tools::background::tool_background_description("bash", "cargo test"),
        state: BackgroundJobHintState::Failed,
        error: Some("timeout".to_string()),
        started_at: None,
    });

    assert_eq!(
        app.background_status_label(),
        "agents 1 running · tasks 1 failed"
    );
}

#[test]
fn background_bash_status_reports_remaining_and_total_timeout() {
    let mut app = ReplApp::default();
    let expires_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 61_000;
    assert!(app.update_background_job_lifetime_from_tool_result(
        &serde_json::json!({
            "task_id": "job-bash",
            "status": "running",
            "total_lifetime_ms": 120_000,
            "expires_at_ms": expires_at_ms,
            "lifecycle_scope": "kcoder_session"
        })
        .to_string()
    ));
    // ToolResult and BackgroundJobStarted are delivered by independent event
    // channels. Keep the lifetime metadata if the result wins that race.
    app.record_background_job_hint(BackgroundJobHint {
        id: "job-bash".to_string(),
        description: kcoder_tools::background::tool_background_description("bash", "dev server"),
        state: BackgroundJobHintState::Running,
        error: None,
        started_at: Some(Instant::now()),
    });

    let label = app.background_status_label();
    assert!(label.contains("tasks 1 running"), "{label}");
    assert!(label.contains("left / 2m00s timeout"), "{label}");
}

#[tokio::test]
async fn cancelled_background_tool_task_does_not_show_failed_footer() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    app.record_background_job_hint(BackgroundJobHint {
        id: "job-ocr".to_string(),
        description: kcoder_tools::background::tool_background_description("ocr", "ocr review"),
        state: BackgroundJobHintState::Running,
        error: None,
        started_at: None,
    });
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let _ = handle_app_event(
        AppEvent::BackgroundJobFailed {
            id: "job-ocr".to_string(),
            error: "cancelled by user".to_string(),
        },
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;

    assert_eq!(app.background_status_label(), "");
}

#[test]
fn todo_status_lines_render_visible_todos() {
    let todos = vec![
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
        TodoItem {
            id: "todo-3".to_string(),
            content: "Run tests".to_string(),
            active_form: None,
            status: TodoStatus::Completed,
        },
        TodoItem {
            id: "todo-4".to_string(),
            content: "Check formatting".to_string(),
            active_form: None,
            status: TodoStatus::Pending,
        },
        TodoItem {
            id: "todo-5".to_string(),
            content: "Summarize changes".to_string(),
            active_form: None,
            status: TodoStatus::Pending,
        },
    ];

    let lines = render_todo_status_lines(&todos, 80);
    let text = lines_to_text(&lines);

    assert!(text.contains("TodoList 1/5 done"));
    assert!(text.contains("Inspect renderer"));
    assert!(text.contains("Patch TUI"));
    assert!(text.contains("Run tests"));
    assert!(text.contains("+1 more"));
}

#[test]
fn desired_height_reserves_todo_status_area() {
    let mut base = ReplApp::default();
    let mut with_todos = ReplApp {
        todos: vec![
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
        ],
        ..ReplApp::default()
    };

    assert_eq!(
        with_todos.desired_height(100, 40),
        base.desired_height(100, 40) + todo_status_height(&with_todos.todos)
    );
}

#[test]
fn todo_status_layout_is_pinned_to_bottom() {
    let area = Rect::new(0, 0, 80, 24);
    let with_todo = split_repl_layout(area, [0, 0, 5, 0, 0, 1, 3].into());

    let todo = with_todo.todo.expect("todo area should be visible");
    assert_eq!(todo.bottom(), area.bottom());
    assert!(with_todo.footer.bottom() <= todo.top());
    assert_eq!(with_todo.input.bottom(), with_todo.footer.top());

    let without_todo = split_repl_layout(area, [0, 0, 5, 0, 0, 1, 0].into());
    assert!(without_todo.todo.is_none());
    assert!(without_todo.footer.bottom() < area.bottom());
    assert_eq!(without_todo.input.bottom(), without_todo.footer.top());
}

#[test]
fn dialog_host_area_keeps_dialog_above_todo_status() {
    let frame_area = Rect::new(0, 0, 100, 30);
    let todo_height = todo_status_height(&layout_sample_todos());
    let host = dialog_host_area_for_todo(frame_area, todo_height);
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let dialog = permission_dialog("bash", tx);
    let geometry = permission_dialog_geometry(host, &dialog);

    assert_eq!(
        host.bottom(),
        frame_area.bottom().saturating_sub(todo_height)
    );
    assert!(geometry.outer.bottom() <= host.bottom());
}

#[test]
fn permission_dialog_hit_testing_uses_todo_adjusted_host_area() {
    let frame_area = Rect::new(0, 0, 100, 30);
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    let mut app = ReplApp {
        last_frame_area: Some(frame_area),
        todos: layout_sample_todos(),
        ..ReplApp::default()
    };
    app.enqueue_permission_dialog(permission_dialog("bash", tx));
    let host = app.dialog_host_area().expect("frame area should be known");
    let dialog = app.pending_permission.as_ref().unwrap();
    let deny = permission_option_bounds(host, dialog, 3).unwrap();

    let action = handle_mouse_event(
        MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: deny.x.saturating_add(1),
            row: deny.y,
            modifiers: KeyModifiers::NONE,
        },
        &mut app,
    );

    assert!(action.is_none());
    assert_eq!(
        rx.try_recv().unwrap().response,
        PermissionResponse::DenyOnce
    );
    assert!(app.pending_permission.is_none());
}

#[test]
fn live_status_layout_sits_above_composer() {
    let area = Rect::new(0, 0, 80, 24);
    let layout = split_repl_layout(area, [3, 0, 5, 1, 0, 1, 0].into());

    let status = layout.status.expect("status area should be visible");
    assert_eq!(
        status.top(),
        layout.message.bottom() + BOTTOM_PANE_TOP_SPACER
    );
    assert_eq!(status.bottom(), layout.input.top());
    assert_eq!(layout.input.bottom(), layout.footer.top());
}

#[test]
fn composer_keeps_codex_top_gap_without_status_or_pending() {
    let area = Rect::new(0, 0, 80, 24);
    let layout = split_repl_layout(area, [3, 0, 5, 0, 0, 1, 0].into());

    assert!(layout.status.is_none());
    assert!(layout.pending_input.is_none());
    assert_eq!(
        layout.input.top(),
        layout.message.bottom() + BOTTOM_PANE_TOP_SPACER
    );
    assert_eq!(layout.input.bottom(), layout.footer.top());
}

#[test]
fn bottom_overlay_sits_between_transcript_and_composer_stack() {
    let area = Rect::new(0, 0, 80, 24);
    let layout = split_repl_layout(area, [3, 4, 5, 0, 0, 1, 0].into());
    let overlay = layout
        .bottom_overlay
        .expect("bottom overlay area should be visible");

    assert_eq!(overlay.top(), layout.message.bottom());
    assert_eq!(overlay.height, 4);
    assert_eq!(
        layout.input.top(),
        overlay.bottom() + BOTTOM_PANE_TOP_SPACER
    );
    assert_eq!(layout.input.bottom(), layout.footer.top());
    assert!(layout.footer.bottom() < area.bottom());
}

#[test]
fn live_status_layout_height_adds_codex_spacer_without_pending_preview() {
    assert_eq!(status_indicator_layout_height(0, 0), 0);
    assert_eq!(status_indicator_layout_height(1, 0), 2);
    assert_eq!(status_indicator_layout_height(3, 0), 4);
    assert_eq!(status_indicator_layout_height(3, 2), 3);
}

#[test]
fn loading_status_header_describes_the_current_phase() {
    let mut app = ReplApp {
        is_loading: true,
        ..ReplApp::default()
    };
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 12),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 12));

    terminal.draw(|frame| app.draw(frame)).unwrap();

    let rendered = terminal.backend().output();
    assert!(rendered.contains("Connecting model"), "{rendered}");
    assert!(!rendered.contains("Starting"), "{rendered}");
}

#[test]
fn activity_label_uses_tool_then_todo_then_phase_priority() {
    let mut app = ReplApp::default();
    app.start_loading();
    assert_eq!(app.activity_presentation().label, "Connecting model");

    app.todos = vec![TodoItem {
        id: "todo-1".to_string(),
        content: "Inspect renderer".to_string(),
        active_form: Some("Inspecting renderer".to_string()),
        status: TodoStatus::InProgress,
    }];
    app.spinner.mark_responding(12);
    assert_eq!(app.activity_presentation().label, "Inspecting renderer");

    app.push_tool_running(
        "tool-1".to_string(),
        "bash".to_string(),
        r#"{"description":"Checking workspace health","command":"cargo check"}"#.to_string(),
    );
    assert_eq!(
        app.activity_presentation().label,
        "Checking workspace health"
    );
}

#[test]
fn tool_input_progress_count_stays_compact_as_it_grows() {
    assert_eq!(format_progress_count(878), "878");
    assert_eq!(format_progress_count(2_117), "2.1K");
    assert_eq!(format_progress_count(9_663), "9.7K");
    assert_eq!(format_progress_count(10_000), "10K");
    assert_eq!(format_progress_count(45_312), "45K");
}

#[test]
fn running_empty_composer_footer_keeps_shortcuts_instead_of_duplicate_interrupt() {
    let mut app = ReplApp {
        is_loading: true,
        ..ReplApp::default()
    };
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 12),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 12));

    terminal.draw(|frame| app.draw(frame)).unwrap();

    let rendered = terminal.backend().output();
    assert!(rendered.contains("? for shortcuts"), "{rendered}");
    assert!(rendered.contains("to interrupt"), "{rendered}");
    assert_eq!(rendered.matches("to interrupt").count(), 1, "{rendered}");
}

#[test]
fn transient_copy_status_does_not_replace_running_tool_status() {
    let mut app = ReplApp::default();
    app.push_tool_running(
        "tool-1".to_string(),
        "bash".to_string(),
        r#"{"command":"echo hi"}"#.to_string(),
    );
    app.set_transient_status("Copied selected text to clipboard");
    app.transient_status.as_mut().unwrap().expires_at = Instant::now() + Duration::from_secs(60);

    let detail = app.active_status_detail().unwrap_or_default();
    assert!(detail.contains("echo hi"), "{detail}");
    assert_eq!(app.activity_presentation().label, "Running bash");
    assert!(
        app.compact_status_label()
            .contains("Copied selected text to clipboard")
    );
    assert!(app.status_indicator_visible());

    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(100, 16),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 100, 16));

    terminal.draw(|frame| app.draw(frame)).unwrap();

    let rendered = terminal.backend().output();
    assert!(rendered.contains("Copied selected text"), "{rendered}");
}

#[test]
fn transient_copy_status_expires_without_committed_message() {
    let mut app = ReplApp::default();
    app.set_transient_status("Copied selected text to clipboard");
    let expires_at = app.transient_status.as_ref().unwrap().expires_at;

    assert!(app.needs_scheduled_frame_tick());
    assert!(
        app.compact_status_label()
            .contains("Copied selected text to clipboard")
    );
    assert!(app.clear_expired_transient_status_at(expires_at));

    assert!(app.transient_status.is_none());
    assert!(!app.needs_scheduled_frame_tick());
    assert!(app.compact_status_label().is_empty());
    assert!(app.messages.is_empty());
}

#[test]
fn transient_copy_status_is_visible_in_idle_footer() {
    let mut app = ReplApp {
        fullscreen_surface: true,
        ..ReplApp::default()
    };
    app.push_message(MessageRole::System, "Resumed session from history.");
    app.set_transient_status("Copied selected text to clipboard");

    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(100, 16),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 100, 16));

    terminal.draw(|frame| app.draw(frame)).unwrap();

    let rendered = terminal.backend().output();
    assert!(rendered.contains("Copied selected text"), "{rendered}");
    assert!(!app.status_indicator_visible());
    assert_eq!(
        app.messages
            .iter()
            .filter(|message| message.text.contains("Copied selected text"))
            .count(),
        0
    );
}

#[test]
fn running_status_follows_short_transcript_without_preallocated_blank_area() {
    let mut app = ReplApp {
        is_loading: true,
        ..ReplApp::default()
    };
    app.push_message(MessageRole::User, "hello");
    app.push_message(MessageRole::Assistant, "hello! how can I help?");
    app.push_message(MessageRole::User, "what tools are available?");
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 30),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 30));

    terminal.draw(|frame| app.draw(frame)).unwrap();

    let buffer = terminal.rendered_buffer_for_tests();
    let dump = buffer_dump(buffer);
    let user_row = buffer_find_row_containing(buffer, "what tools are available?")
        .unwrap_or_else(|| panic!("latest user message should render\n{dump}"));
    let working_row = buffer_find_row_containing(buffer, "Connecting model")
        .unwrap_or_else(|| panic!("running status should render\n{dump}"));
    let footer_row = buffer_find_row_containing(buffer, "? for shortcuts")
        .unwrap_or_else(|| panic!("footer should render\n{dump}"));

    assert!(
        working_row <= user_row.saturating_add(4),
        "running status should grow directly below transcript, not reserve a blank viewport\n{dump}"
    );
    assert!(
        footer_row < buffer.area.bottom().saturating_sub(4),
        "compact stack should leave unused rows below the footer\n{dump}"
    );
}

#[test]
fn fullscreen_working_status_does_not_resize_transcript_surface() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 23 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 24));
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "hello");
    app.push_message(MessageRole::Assistant, "hello! how can I help?");

    draw_kcoder_frame_with_mode(&mut terminal, &mut app, TerminalSurfaceMode::Fullscreen).unwrap();
    let idle_transcript_area = app
        .transcript_viewport
        .transcript_area()
        .expect("fullscreen transcript area should render");

    app.start_loading();
    draw_kcoder_frame_with_mode(&mut terminal, &mut app, TerminalSurfaceMode::Fullscreen).unwrap();
    let running_transcript_area = app
        .transcript_viewport
        .transcript_area()
        .expect("fullscreen transcript area should render while running");
    let dump = buffer_dump(terminal.rendered_buffer_for_tests());

    assert_eq!(
        running_transcript_area, idle_transcript_area,
        "Working/status must live in the footer layer instead of shrinking transcript\n{dump}"
    );
    assert!(dump.contains("Connecting model"), "{dump}");
    assert!(dump.contains("interrupt"), "{dump}");
}

#[cfg(windows)]
#[test]
fn fullscreen_resize_physically_clears_windows_console_before_repaint() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 23 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 24));
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "resize repaint anchor");

    draw_kcoder_frame_with_mode(&mut terminal, &mut app, TerminalSurfaceMode::Fullscreen).unwrap();
    assert_eq!(terminal.backend().clear_region_count, 0);

    terminal.backend_mut().size = Size::new(120, 40);
    draw_kcoder_frame_with_mode(&mut terminal, &mut app, TerminalSurfaceMode::Fullscreen).unwrap();

    assert_eq!(
        terminal.backend().clear_region_count,
        1,
        "a native Windows fullscreen resize must physically clear stale console cells"
    );
    assert_eq!(
        terminal.backend().clear_region_positions,
        vec![Position { x: 0, y: 0 }],
        "the full-screen clear must start at the console origin"
    );
    assert_eq!(terminal.viewport_area, Rect::new(0, 0, 120, 40));
    let dump = buffer_dump(terminal.rendered_buffer_for_tests());
    assert!(dump.contains("resize repaint anchor"), "{dump}");
}

#[test]
fn fullscreen_transcript_cache_ignores_footer_only_working_ticks() {
    let mut app = ReplApp {
        fullscreen_surface: true,
        ..ReplApp::default()
    };
    app.push_message(MessageRole::User, "hello");
    app.push_message(MessageRole::Assistant, "hello! how can I help?");

    let first = app.render_fullscreen_transcript_window(80, 20);
    let first_key = app
        .fullscreen_transcript_render_cache
        .as_ref()
        .expect("fullscreen render should cache")
        .key
        .clone();

    app.start_loading();
    let _ = app.spinner.tick();
    let second = app.render_fullscreen_transcript_window(80, 20);
    let second_key = app
        .fullscreen_transcript_render_cache
        .as_ref()
        .expect("fullscreen render should stay cached")
        .key
        .clone();

    assert_eq!(first_key, second_key);
    assert_eq!(first.lines, second.lines);
    assert_eq!(first.total_rows, second.total_rows);
}

#[test]
fn fullscreen_review_window_ignores_same_height_active_tail_updates() {
    let mut app = ReplApp {
        fullscreen_surface: true,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(0),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };
    for index in 0..40 {
        app.push_message(
            MessageRole::Assistant,
            format!("committed history row {index:02}"),
        );
    }

    app.append_streaming_text("active-a");
    let first = app.render_fullscreen_transcript_window(80, 12);
    let first_key = app
        .fullscreen_transcript_render_cache
        .as_ref()
        .expect("review window should cache")
        .key
        .clone();

    app.append_streaming_text("b");
    let second = app.render_fullscreen_transcript_window(80, 12);
    let second_key = app
        .fullscreen_transcript_render_cache
        .as_ref()
        .expect("review window should remain cached")
        .key
        .clone();
    let text = transcript_visible_rows_for_selection(&second.lines, 80, 12, second.local_top).join("\n");

    assert_eq!(
        first_key, second_key,
        "same-height tail updates must not invalidate review"
    );
    assert_eq!(first.lines, second.lines, "review rows must stay anchored");
    assert!(
        !text.contains("active-a"),
        "active tail belongs below the review window: {text}"
    );
}

#[test]
fn fullscreen_active_tail_reuses_unchanged_keyed_message_blocks() {
    let mut app = ReplApp {
        fullscreen_surface: true,
        ..ReplApp::default()
    };
    app.push_message(MessageRole::User, "inspect the repository");
    app.push_message(
        MessageRole::Assistant,
        "A committed markdown block with **formatting** that must remain stable.",
    );
    app.append_streaming_text("active-a");

    let _ = app.render_fullscreen_transcript_window(80, 20);
    let first_hits = app.keyed_transcript_block_render_cache.hit_count();
    let first_entries = app.keyed_transcript_block_render_cache.len();

    app.append_streaming_text("b");
    let _ = app.render_fullscreen_transcript_window(80, 20);

    assert!(
        app.keyed_transcript_block_render_cache.hit_count() > first_hits,
        "unchanged committed blocks should be reused when only the active block changes"
    );
    assert_eq!(
        app.keyed_transcript_block_render_cache.len(),
        first_entries,
        "a growing active block must not leave stale render variants in the keyed cache"
    );
}

#[test]
fn active_markdown_below_64_kib_keeps_full_streaming_render() {
    let mut app = ReplApp {
        fullscreen_surface: true,
        ..ReplApp::default()
    };
    let long_markdown = format!(
        "# Live heading\n\n{}",
        "## **markdown** body 0123456789 0123456789 0123456789 0123456789 0123456789\n"
            .repeat(700)
    );
    assert!(long_markdown.len() > 32 * 1024);
    assert!(long_markdown.len() <= 64 * 1024);
    let active = vec![DisplayMessage {
        role: MessageRole::Assistant,
        text: long_markdown,
    }];

    let rendered = app.render_display_messages_keyed_with_mode(
        &active,
        80,
        Some(120),
        LineLimitMode::Tail,
        false,
        Some(0),
    );
    let text = lines_to_text(&rendered);

    assert!(
        !text.contains("**markdown** body"),
        "active Markdown below 64 KiB should retain full rendering"
    );
    assert_eq!(
        app.keyed_transcript_block_render_cache.len(),
        0,
        "active streaming variants must bypass the stable-block cache"
    );
}

#[test]
fn active_markdown_above_64_kib_matches_committed_styles() {
    let mut app = ReplApp {
        fullscreen_surface: true,
        ..ReplApp::default()
    };
    let long_markdown = format!(
        "# Live heading\n\n{}",
        "## **markdown** body 0123456789 0123456789 0123456789 0123456789 0123456789\n"
            .repeat(900)
    );
    assert!(long_markdown.len() > 64 * 1024);
    let active = vec![DisplayMessage {
        role: MessageRole::Assistant,
        text: long_markdown,
    }];

    let rendered = app.render_display_messages_keyed_with_mode(
        &active,
        80,
        Some(120),
        LineLimitMode::Tail,
        false,
        Some(0),
    );
    let text = lines_to_text(&rendered);

    assert!(
        !text.contains("**markdown** body"),
        "长流式消息不能使整条 Markdown 退化为源码"
    );
    assert_eq!(
        app.keyed_transcript_block_render_cache.len(),
        0,
        "active streaming variants must bypass the stable-block cache"
    );

    let committed = app.render_display_messages_keyed_with_mode(
        &active,
        80,
        Some(120),
        LineLimitMode::Tail,
        false,
        None,
    );
    let committed_text = lines_to_text(&committed);
    assert_eq!(rendered, committed, "流式和完成后的排版、颜色必须一致");
    assert!(
        !committed_text.contains("**markdown** body"),
        "committed output must return to full Markdown rendering"
    );
    assert_eq!(
        app.keyed_transcript_block_render_cache.len(),
        1,
        "the committed Markdown block should become cacheable"
    );
}

#[test]
fn large_open_code_fence_keeps_colors_in_active_preview() {
    let mut app = ReplApp::default();
    let code = "let color = \"stream\"; // 彩色代码\n".repeat(2200);
    assert!(code.len() > 64 * 1024);
    let active = vec![DisplayMessage {
        role: MessageRole::Assistant,
        text: format!("```rust\n{code}"),
    }];
    let live = app.render_display_messages_keyed_with_mode(
        &active, 80, Some(20), LineLimitMode::Tail, false, Some(0),
    );
    assert!(live.iter().flat_map(|line| &line.spans).any(|span| {
        matches!(span.style.fg, Some(ratatui::style::Color::Rgb(..)))
    }), "长代码在流式阶段必须仍有语法颜色");
    let mut active = active;
    active[0].text.push_str("```\n");
    let committed = app.render_display_messages_keyed_with_mode(
        &active, 80, Some(20), LineLimitMode::Tail, false, None,
    );
    assert_eq!(live, committed);
}

#[test]
fn oversized_code_only_loses_syntax_not_surrounding_markdown() {
    let mut app = ReplApp::default();
    let active = vec![DisplayMessage {
        role: MessageRole::Assistant,
        text: format!("```rust\n{}\n```\n\n> quote\n\n`inline_color`\n", "x".repeat(4097)),
    }];
    let live = app.render_display_messages_keyed_with_mode(
        &active, 80, Some(20), LineLimitMode::Tail, false, Some(0),
    );
    let spans = live.iter().flat_map(|line| &line.spans).collect::<Vec<_>>();
    assert!(spans.iter().any(|span| span.content.contains("quote")
        && span.style.fg == Some(ratatui::style::Color::Green)));
    assert!(spans.iter().any(|span| span.content.contains("inline_color")
        && span.style.fg == Some(ratatui::style::Color::Cyan)));
}

#[test]
fn tight_layout_keeps_all_areas_inside_frame() {
    let area = Rect::new(0, 0, 272, 7);
    let layout = split_repl_layout(
        area,
        [24, 0, 5, STATUS_INDICATOR_MAX_HEIGHT, 0, 1, 0].into(),
    );
    let areas = [
        layout.message,
        layout.bottom_overlay.unwrap_or(Rect::ZERO),
        layout.status.unwrap_or(Rect::ZERO),
        layout.pending_input.unwrap_or(Rect::ZERO),
        layout.input,
        layout.footer,
        layout.todo.unwrap_or(Rect::ZERO),
    ];

    for child in areas {
        assert!(child.right() <= area.right(), "{child:?} exceeds {area:?}");
        assert!(
            child.bottom() <= area.bottom(),
            "{child:?} exceeds {area:?}"
        );
    }
}

#[test]
fn tight_layout_prioritizes_bottom_pane_before_transcript() {
    let area = Rect::new(0, 0, 80, 7);
    let layout = split_repl_layout(
        area,
        [24, 0, 5, STATUS_INDICATOR_MAX_HEIGHT, 0, 1, 0].into(),
    );

    assert_eq!(
        layout.message.height, 0,
        "transcript is the flex area and should yield before the composer/footer stack: {layout:?}"
    );
    assert!(
        layout.status.is_none(),
        "status should yield after composer and top spacer consume the tight bottom pane: {layout:?}"
    );
    assert_eq!(layout.input.height, 5);
    assert_eq!(layout.footer.height, 1);
}

#[test]
fn height_one_layout_prioritizes_composer() {
    let area = Rect::new(0, 0, 80, 1);
    let layout = split_repl_layout(area, [5, 0, 5, STATUS_INDICATOR_MAX_HEIGHT, 3, 1, 0].into());

    assert_eq!(layout.message.height, 0);
    assert!(layout.status.is_none());
    assert!(layout.pending_input.is_none());
    assert_eq!(layout.input.height, 1);
    assert_eq!(layout.footer.height, 0);
}

#[test]
fn live_status_height_matches_current_content_while_running() {
    let mut app = ReplApp::default();
    assert_eq!(status_indicator_height(&app, 32), 0);

    app.push_tool_running(
            "tool-1".to_string(),
            "bash".to_string(),
            r#"{"command":"cargo test -p kcoder_repl status_indicator_height_reserves_wrapped_detail_rows --quiet","description":"Run focused test"}"#.to_string(),
        );

    let wide_height = status_indicator_height(&app, 120);
    let narrow_height = status_indicator_height(&app, 32);

    assert!(wide_height > 1);
    assert!(wide_height <= STATUS_INDICATOR_MAX_HEIGHT);
    assert!(narrow_height >= wide_height);
    assert!(narrow_height <= STATUS_INDICATOR_MAX_HEIGHT);
}

#[test]
fn active_tool_title_diamond_animates_only_while_a_tool_is_running() {
    let mut app = ReplApp::default();
    app.push_tool_running(
        "tool-1".to_string(),
        "bash".to_string(),
        r#"{"command":"sleep 10"}"#.to_string(),
    );

    assert_eq!(
        app.active_tool_summary_indicator_at(Duration::ZERO),
        if cfg!(windows) { "o" } else { "◇" }
    );
    assert_eq!(
        app.active_tool_summary_indicator_at(Duration::from_millis(240)),
        if cfg!(windows) { "O" } else { "◈" }
    );
    assert_eq!(
        app.active_tool_summary_indicator_at(Duration::from_millis(480)),
        if cfg!(windows) { "o" } else { "◆" }
    );

    app.push_tool_done(
        "tool-1".to_string(),
        "bash".to_string(),
        "done".to_string(),
        false,
    );
    assert_eq!(
        app.active_tool_summary_indicator_at(Duration::from_millis(240)),
        "◇"
    );
}

#[test]
fn live_status_height_grows_when_tool_detail_appears() {
    let mut app = ReplApp::default();
    app.append_streaming_text("streaming answer");

    let streaming_height = status_indicator_height(&app, 32);

    app.push_tool_running(
            "tool-1".to_string(),
            "bash".to_string(),
            r#"{"command":"cargo test -p kcoder_repl live_status_height_stays_stable_when_tool_detail_appears --quiet","description":"Run focused status height jitter test"}"#.to_string(),
        );

    let tool_height = status_indicator_height(&app, 32);
    assert_eq!(streaming_height, 0);
    assert!(tool_height > streaming_height);
    assert!(tool_height <= STATUS_INDICATOR_MAX_HEIGHT);
}

#[test]
fn live_status_layout_grows_to_current_detail_rows_above_composer() {
    let mut app = ReplApp::default();
    app.push_tool_running(
            "tool-1".to_string(),
            "bash".to_string(),
            r#"{"command":"cargo test -p kcoder_repl status_indicator_height_reserves_wrapped_detail_rows --quiet","description":"Run focused test"}"#.to_string(),
        );

    let area = Rect::new(0, 0, 32, 24);
    let status_content_height = status_indicator_height(&app, area.width);
    let (status_height, pending_input_height) = app.bottom_pane_stack_heights(area.width);
    let layout = split_repl_layout(
        area,
        [4, 0, 5, status_height, pending_input_height, 1, 0].into(),
    );

    let status = layout.status.expect("status area should be visible");
    assert!(status_content_height > 1);
    assert_eq!(pending_input_height, 0);
    assert_eq!(status.height, status_content_height + 1);
    assert_eq!(status.height, status_height);
    assert_eq!(
        status.top(),
        layout.message.bottom() + BOTTOM_PANE_TOP_SPACER
    );
    assert_eq!(status.bottom(), layout.input.top());
    assert_eq!(layout.input.bottom(), layout.footer.top());
}

#[test]
fn queued_preview_layout_sits_between_status_and_composer() {
    let mut app = ReplApp::default();
    app.push_tool_running(
        "tool-1".to_string(),
        "bash".to_string(),
        r#"{"command":"cargo test -p kcoder_repl --quiet","description":"Run focused test"}"#
            .to_string(),
    );
    assert!(app.enqueue_user_message_for_turn(Message::user_text("follow up after this turn")));

    let area = Rect::new(0, 0, 80, 30);
    let status_height = status_indicator_height(&app, area.width);
    let preview_height = app.pending_input_preview().desired_height(area.width);
    assert_eq!(
        status_indicator_layout_height(status_height, preview_height),
        status_height
    );
    let pending_input_height = app.pending_input_preview_height(area.width, status_height);
    let layout = split_repl_layout(
        area,
        [4, 0, 5, status_height, pending_input_height, 1, 0].into(),
    );

    let status = layout.status.expect("status area should be visible");
    let pending = layout
        .pending_input
        .expect("queued preview area should be visible");
    assert_eq!(pending.height, preview_height + 1);
    assert_eq!(
        status.top(),
        layout.message.bottom() + BOTTOM_PANE_TOP_SPACER
    );
    assert_eq!(status.bottom(), pending.top());
    assert_eq!(pending.bottom(), layout.input.top());
    assert_eq!(layout.input.bottom(), layout.footer.top());
}

#[test]
fn queued_preview_content_area_keeps_tight_single_row_visible() {
    let area = Rect::new(0, 0, 80, 1);

    let content = pending_input_preview_content_area(area, true);

    assert_eq!(content, area);
}

#[test]
fn queued_preview_content_area_keeps_codex_gap_when_space_allows() {
    let area = Rect::new(0, 4, 80, 4);

    let content = pending_input_preview_content_area(area, true);

    assert_eq!(content, Rect::new(0, 5, 80, 3));
}

#[test]
fn footer_shortcuts_overlay_keeps_single_line_footer_layout() {
    let area = Rect::new(0, 0, 80, 24);
    let footer_height = FooterHint::Shortcuts.desired_height();
    let layout = split_repl_layout(area, [0, 0, 5, 0, 0, footer_height, 0].into());

    assert_eq!(layout.footer.height, footer_height);
    assert!(layout.footer.bottom() < area.bottom());
    assert_eq!(layout.input.bottom(), layout.footer.top());
}

#[test]
fn prunes_closed_background_job_hints() {
    let mut app = ReplApp::default();
    app.record_background_job_hint(BackgroundJobHint {
        id: "job-live".to_string(),
        description: "live".to_string(),
        state: BackgroundJobHintState::Completed,
        error: None,
        started_at: None,
    });
    app.record_background_job_hint(BackgroundJobHint {
        id: "job-closed".to_string(),
        description: "closed".to_string(),
        state: BackgroundJobHintState::Failed,
        error: Some("closed".to_string()),
        started_at: None,
    });
    let live = std::collections::HashSet::from(["job-live".to_string()]);

    app.prune_background_job_hints(&live);

    assert_eq!(app.background_job_hints().len(), 1);
    assert_eq!(app.background_job_hints()[0].id, "job-live");
}

#[test]
fn scrollback_prepare_targets_all_messages_before_viewport_shrink() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 24));
    let mut app = ReplApp {
        messages: (0..80)
            .map(|idx| DisplayMessage {
                role: MessageRole::Assistant,
                text: format!("message {idx}"),
            })
            .collect(),
        scrollback_committed_until: 0,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };

    let prepared = prepare_committed_history_for_scrollback(
        &mut app,
        80,
        terminal.viewport_area,
        terminal.size().unwrap().height,
    )
    .expect("history should still be prepared before the viewport is shrunk");

    assert_eq!(prepared.target, app.messages.len());
    let flushed = flush_prepared_history_to_scrollback(&mut terminal, &mut app, prepared).unwrap();
    assert!(!flushed);
    assert_eq!(app.scrollback_committed_until, 0);
}

#[test]
fn scrollback_flush_commits_single_completed_overflowing_message() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 18));
    let long_user_message = (0..80)
        .map(|idx| format!("user line {idx}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut app = ReplApp {
        messages: vec![DisplayMessage {
            role: MessageRole::User,
            text: long_user_message,
        }]
        .into(),
        scrollback_committed_until: 0,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            123,
            0,
            None,
        ),
        ..ReplApp::default()
    };

    let prepared = prepare_committed_history_for_scrollback(
        &mut app,
        80,
        terminal.viewport_area,
        terminal.size().unwrap().height,
    )
    .expect("completed overflowing message should be prepared for terminal scrollback");
    let text = hyperlink_lines_to_text(&prepared.lines);
    assert!(text.contains("user line 0"));
    assert!(text.contains("user line 79"));
    assert_eq!(prepared.target, 1);
    assert_eq!(app.scrollback_committed_until, 0);
    assert_eq!(terminal.backend().output(), "");
    assert_eq!(terminal.backend().clear_region_count, 0);
}

#[test]
fn scrollback_flush_commits_latest_completed_overflowing_response() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 18));
    let long_assistant_message = (0..80)
        .map(|idx| format!("tool line {idx}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut app = ReplApp {
        messages: vec![
            DisplayMessage {
                role: MessageRole::User,
                text: "你有哪些工具".to_string(),
            },
            DisplayMessage {
                role: MessageRole::Assistant,
                text: long_assistant_message,
            },
        ]
        .into(),
        scrollback_committed_until: 0,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };

    let prepared = prepare_committed_history_for_scrollback(
        &mut app,
        80,
        terminal.viewport_area,
        terminal.size().unwrap().height,
    )
    .expect("completed response should be prepared for terminal scrollback");
    let text = hyperlink_lines_to_text(&prepared.lines);
    assert!(text.contains("你有哪些工具"));
    assert!(text.contains("tool line 79"));
    assert_eq!(prepared.target, 2);
    assert_eq!(app.scrollback_committed_until, 0);
    assert_eq!(terminal.backend().output(), "");

    let flushed = flush_prepared_history_to_scrollback(&mut terminal, &mut app, prepared).unwrap();
    assert!(flushed);
    assert_eq!(app.scrollback_committed_until, 2);
    let output = terminal.backend().output();
    assert!(output.contains("你有哪些工具"));
    assert!(output.contains("tool line 79"));
}

#[test]
fn completed_overflowing_response_flushes_to_terminal_scrollback_after_frame() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 18));
    let long_assistant_message = (0..80)
        .map(|idx| format!("tool line {idx}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut app = ReplApp {
        messages: vec![
            DisplayMessage {
                role: MessageRole::User,
                text: "你有哪些工具".to_string(),
            },
            DisplayMessage {
                role: MessageRole::Assistant,
                text: long_assistant_message,
            },
        ]
        .into(),
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    let buffer = terminal.rendered_buffer_for_tests();
    let dump = buffer_dump(buffer);
    assert_eq!(app.scrollback_committed_until, 2);
    let output = terminal.backend().output();
    assert!(output.contains("你有哪些工具"));
    assert!(output.contains("tool line 79"));
    buffer_find_row_containing(buffer, "Ask KCoder")
        .unwrap_or_else(|| panic!("composer should still render below the transcript\n{dump}"));
}

#[test]
fn completed_overflowing_response_from_fullscreen_viewport_keeps_live_tui_visible() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 23 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 24));
    let long_assistant_message = (0..80)
        .map(|idx| format!("tool line {idx}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut app = ReplApp {
        messages: vec![
            DisplayMessage {
                role: MessageRole::User,
                text: "你有哪些工具".to_string(),
            },
            DisplayMessage {
                role: MessageRole::Assistant,
                text: long_assistant_message,
            },
        ]
        .into(),
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    let buffer = terminal.rendered_buffer_for_tests();
    let dump = buffer_dump(buffer);
    assert_eq!(app.scrollback_committed_until, 2);
    assert!(
        terminal.viewport_area.top() > 0,
        "live viewport must move below terminal scrollback, got {:?}",
        terminal.viewport_area
    );
    assert_eq!(
        terminal.viewport_area.bottom(),
        terminal.size().unwrap().height
    );
    let output = terminal.backend().output();
    assert!(output.contains("tool line 79"));
    buffer_find_row_containing(buffer, "Ask KCoder")
        .unwrap_or_else(|| panic!("composer should remain visible after scrollback flush\n{dump}"));
}

#[test]
fn active_tool_status_consumes_bottom_slack_without_scrolling_history() {
    let mut app = ReplApp {
        welcome_scrollback_committed: true,
        ..ReplApp::default()
    };
    app.push_tool_running(
            "tool-1".to_string(),
            "TodoWrite".to_string(),
            r#"{"TodoList":[{"activeForm":"testing read-only filesystem tools","content":"Batch 1: read/glob/grep/bash (read-only)","status":"pending"},{"activeForm":"testing memory tools","content":"Batch 5: memory_search/memory_get","status":"pending"}]}"#.to_string(),
        );
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(120, 32),
        Position { x: 0, y: 31 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 22, 120, 3));

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    let dump = buffer_dump(terminal.rendered_buffer_for_tests());
    assert_eq!(
        terminal.viewport_area.y, 22,
        "active status should grow downward from the existing live viewport top"
    );
    assert!(
        terminal.viewport_area.height > 3,
        "active status should consume bottom slack when available: {:?}\n{dump}",
        terminal.viewport_area
    );
    assert!(terminal.viewport_area.bottom() <= 32);
    assert!(
        terminal.backend().scroll_region_up_calls.is_empty(),
        "active status expansion must not push terminal history"
    );
    assert!(dump.contains("Running TodoWrite"), "{dump}");
    assert!(dump.contains("Ask KCoder to do anything"), "{dump}");
}

#[test]
fn finished_streaming_tool_intro_flushes_history_and_keeps_live_tui_visible() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 23 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 24));
    let long_intro = (0..80)
        .map(|idx| format!("tool capability line {idx}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut app = ReplApp::default();
    app.render_welcome_component();
    app.push_message(MessageRole::User, "介绍你的工具");
    app.recent_turn_transcript_start = Some(app.messages.len());
    app.append_streaming_text(long_intro);

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();
    let streaming_buffer = terminal.rendered_buffer_for_tests();
    let streaming_dump = buffer_dump(streaming_buffer);
    buffer_find_row_containing(streaming_buffer, "Ask KCoder").unwrap_or_else(|| {
        panic!("composer should remain visible while streaming\n{streaming_dump}")
    });

    app.finish_streaming_text_status();
    app.set_loading(false);
    app.flush_active_turn();
    app.consolidate_finished_assistant_stream();
    app.transcript_viewport.invalidate_content_layout();

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    let buffer = terminal.rendered_buffer_for_tests();
    let dump = buffer_dump(buffer);
    assert_eq!(app.scrollback_committed_until, app.messages.len());
    assert_eq!(
        terminal.viewport_area.bottom(),
        terminal.size().unwrap().height
    );
    let output = terminal.backend().output();
    assert!(output.contains("Welcome to KCoder!"));
    assert!(output.contains("介绍你的工具"));
    assert!(output.contains("tool capability line 79"));
    assert!(
        buffer_find_row_containing(buffer, "Welcome to KCoder!").is_none(),
        "welcome should be committed to terminal scrollback, not left in live viewport\n{dump}"
    );
    buffer_find_row_containing(buffer, "Ask KCoder").unwrap_or_else(|| {
        panic!("composer should remain visible after finished stream flush\n{dump}")
    });
}

#[test]
fn first_scrollback_flush_prefixes_startup_welcome_history() {
    let mut app = ReplApp {
        messages: (0..TRANSCRIPT_SCROLLBACK_FLUSH_MAX_MESSAGES + 80)
            .map(|idx| DisplayMessage {
                role: MessageRole::Assistant,
                text: format!("message {idx}"),
            })
            .collect(),
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };
    app.render_welcome_component();

    let prepared =
        prepare_committed_history_for_scrollback(&mut app, 80, Rect::new(0, 5, 80, 10), 24)
            .expect("history should be prepared");
    let text = hyperlink_lines_to_text(&prepared.lines);

    let welcome_pos = text
        .find("Welcome to KCoder!")
        .expect("welcome should be inserted into scrollback history");
    let first_message_pos = text
        .find("message 0")
        .expect("committed transcript should follow welcome");
    assert!(
        welcome_pos < first_message_pos,
        "welcome must precede committed messages:\n{text}"
    );
    assert!(prepared.height > 0);
    assert!(prepared.target > 0);
}

#[test]
fn later_scrollback_flush_does_not_repeat_startup_welcome_history() {
    let mut app = ReplApp {
        messages: (0..TRANSCRIPT_SCROLLBACK_FLUSH_MAX_MESSAGES + 80)
            .map(|idx| DisplayMessage {
                role: MessageRole::Assistant,
                text: format!("message {idx}"),
            })
            .collect(),
        scrollback_committed_until: 1,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };
    app.render_welcome_component();

    let prepared =
        prepare_committed_history_for_scrollback(&mut app, 80, Rect::new(0, 5, 80, 10), 24)
            .expect("history should be prepared");
    let text = hyperlink_lines_to_text(&prepared.lines);

    assert!(!text.contains("Welcome to KCoder!"));
    assert!(text.contains("message 1"));
    assert!(prepared.target > app.scrollback_committed_until);
}

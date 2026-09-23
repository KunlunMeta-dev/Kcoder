#[test]
fn streaming_deltas_accumulate_without_forcing_full_repaint() {
    let mut app = ReplApp::default();

    app.append_streaming_text("first");
    app.append_streaming_text(" second");
    assert!(!app.take_force_viewport_redraw());
    assert!(
        lines_to_text(&app.render_active_turn_lines(80)).contains("first second"),
        "live assistant tail should remain visible before newline commit"
    );
    assert!(!app.status_indicator_visible());

    app.active_turn = None;
    app.append_streaming_thinking("thinking");
    app.append_streaming_thinking(" more");
    assert!(!app.take_force_viewport_redraw());
    assert!(
        app.active_turn
            .as_ref()
            .is_some_and(|active| active.entries.is_empty())
    );
    assert_eq!(app.active_status_detail().as_deref(), Some("Thinking"));
    assert!(app.status_indicator_visible());
    assert!(lines_to_text(&app.render_active_turn_lines(80)).contains("thinking more"));
}

#[tokio::test]
async fn path_preview_events_clear_on_error_cancel_and_finish() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    for terminal in ["error", "cancel", "finish", "history"] {
        let mut app = ReplApp::default();
        let handle = tokio::spawn(std::future::pending::<()>());
        let abort = handle.abort_handle();
        app.begin_turn(handle, CancellationToken::new());
        let generation = app.path_previews.begin();
        let event = || AppEvent::ToolPathPreview {
            generation,
            attempt_id: "attempt".into(),
            id: "tool".into(),
            path: Some("src/path.rs".into()),
        };
        let before = app.messages.len();
        handle_app_event(event(), &mut app, &engine, &tx, &prompt).await;
        assert_eq!(app.activity_presentation().label, "Preparing src/path.rs");
        assert_eq!(app.messages.len(), before);
        match terminal {
            "cancel" => {
                app.interrupt_current_turn();
            }
            "error" => {
                handle_app_event(
                    AppEvent::Error("fixture".into()),
                    &mut app,
                    &engine,
                    &tx,
                    &prompt,
                )
                .await;
            }
            "history" => {
                handle_app_event(AppEvent::HistoryChanged, &mut app, &engine, &tx, &prompt).await;
            }
            _ => {
                handle_app_event(AppEvent::TurnFinished, &mut app, &engine, &tx, &prompt).await;
            }
        }
        handle_app_event(event(), &mut app, &engine, &tx, &prompt).await;
        assert!(app.path_previews.label().is_none(), "{terminal}");
        app.path_previews.begin();
        handle_app_event(event(), &mut app, &engine, &tx, &prompt).await;
        assert!(
            app.path_previews.label().is_none(),
            "next turn after {terminal}"
        );
        abort.abort();
    }
}

#[test]
fn inline_live_transcript_keeps_active_tail_visible_after_history_commit() {
    let mut app = ReplApp::default();
    app.messages.clear();
    app.render_welcome_component();
    app.push_message(MessageRole::User, "previous prompt");
    app.push_message(MessageRole::Assistant, "previous answer");
    app.scrollback_committed_until = app.messages.len();

    app.append_streaming_text("short tail");

    let text = lines_to_text(&app.render_inline_live_transcript_lines(80, 12));
    assert!(!text.contains("Welcome to KCoder!"));
    assert!(!text.contains("previous prompt"));
    assert!(!text.contains("previous answer"));
    assert!(text.contains("short tail"));
}

#[test]
fn draw_keeps_streaming_tail_live_then_archives_it_after_finish() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 40),
        Position { x: 0, y: 8 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 8, 80, 32));
    let mut app = ReplApp::default();
    app.messages.clear();
    app.render_welcome_component();
    app.push_message(MessageRole::User, "previous prompt");
    app.push_message(MessageRole::Assistant, "previous answer");
    app.is_loading = true;

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();
    let before_buffer = terminal.rendered_buffer_for_tests();
    let before_dump = buffer_dump(before_buffer);
    assert!(
        buffer_find_row_containing(before_buffer, "Welcome to KCoder!").is_none(),
        "welcome must be in terminal scrollback, not live viewport\n{before_dump}"
    );
    assert!(
        buffer_find_row_containing(before_buffer, "previous answer").is_none(),
        "committed history must be in terminal scrollback, not live viewport\n{before_dump}"
    );
    assert!(terminal.backend().output().contains("Welcome to KCoder!"));
    assert!(terminal.backend().output().contains("previous answer"));

    app.recent_turn_transcript_start = Some(app.messages.len());
    app.append_streaming_text("first model line\npartial token");
    assert!(app.commit_streaming_text_tick());
    draw_kcoder_frame(&mut terminal, &mut app).unwrap();
    let after_buffer = terminal.rendered_buffer_for_tests();
    let after_dump = buffer_dump(after_buffer);
    assert!(
        buffer_find_row_containing(after_buffer, "previous answer").is_none(),
        "history should stay out of live viewport after first delta\n{after_dump}"
    );
    buffer_find_row_containing(after_buffer, "first model line")
        .unwrap_or_else(|| panic!("stable stream line must stay visible\n{after_dump}"));
    buffer_find_row_containing(after_buffer, "partial token")
        .unwrap_or_else(|| panic!("active assistant partial must stay visible\n{after_dump}"));
    assert_eq!(app.scrollback_committed_until, 2);
    buffer_find_row_containing(after_buffer, "Ask KCoder to do anything")
        .unwrap_or_else(|| panic!("composer should remain visible\n{after_dump}"));

    app.flush_active_turn();
    app.consolidate_finished_assistant_stream();
    app.set_loading(false);
    draw_kcoder_frame(&mut terminal, &mut app).unwrap();
    assert_eq!(app.scrollback_committed_until, app.messages.len());
}

#[test]
fn inline_live_transcript_shows_stable_chunks_and_active_partial() {
    let mut app = ReplApp::default();
    app.messages.clear();
    app.push_message(MessageRole::User, "previous prompt");
    app.push_message(MessageRole::Assistant, "previous answer");
    app.scrollback_committed_until = app.messages.len();

    app.append_streaming_text("one\ntwo\npartial");
    assert!(app.commit_streaming_text_tick());

    let live_text = lines_to_text(&app.render_inline_live_transcript_lines(80, 12));
    assert!(!live_text.contains("previous answer"));
    assert!(live_text.contains("one"));
    assert!(live_text.contains("partial"));
}

#[test]
fn inline_live_transcript_keeps_drained_text_visible_across_tool_boundary() {
    let mut app = ReplApp::default();
    app.messages.clear();
    app.push_message(MessageRole::User, "previous prompt");
    app.push_message(MessageRole::Assistant, "previous answer");
    app.scrollback_committed_until = app.messages.len();
    app.recent_turn_transcript_start = Some(app.messages.len());
    app.is_loading = true;

    app.append_streaming_text("visible preamble");
    app.push_tool_running(
        "tool-1".to_string(),
        "read".to_string(),
        r#"{"file_path":"README.md"}"#.to_string(),
    );

    assert_eq!(
        app.scrollback_commit_target_for_viewport(app.scrollback_committed_until, 80, 12),
        2
    );
    let text = lines_to_text(&app.render_inline_live_transcript_lines(80, 12));
    assert!(text.contains("visible preamble"));
    assert!(text.contains("read"));
    assert!(!text.contains("previous answer"));
}

#[test]
fn frame_tick_does_not_commit_live_thinking_to_transcript_before_finalization() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_thinking("thinking");

    assert!(!app.commit_streaming_text_tick());
    assert!(app.messages.is_empty());
    assert_eq!(app.active_status_detail().as_deref(), Some("Thinking"));
    assert!(lines_to_text(&app.render_active_turn_lines(80)).contains("thinking"));
}

#[test]
fn live_thinking_preview_keeps_fixed_height_and_follows_latest_rows() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_thinking("first");
    let short = app.render_active_turn_lines(32);
    let short_rows = paragraph_line_count(&short, 32);
    let short_text = lines_to_text(&short);

    app.append_streaming_thinking("\nsecond reasoning row\nthird reasoning row\nfourth latest row");
    let long = app.render_active_turn_lines(32);
    let long_rows = paragraph_line_count(&long, 32);
    let long_text = lines_to_text(&long);

    assert_eq!(
        short_rows, long_rows,
        "live preview height must not jump\nshort={short:?}\nlong={long:?}"
    );
    assert!(short_text.contains("first"), "{short_text}");
    assert!(!long_text.contains("first"), "{long_text}");
    assert!(long_text.contains("fourth latest row"), "{long_text}");
}

#[test]
fn long_live_thinking_stays_bounded_when_committed() {
    let mut app = ReplApp::default();
    app.messages.clear();
    app.append_streaming_thinking(
        "first reasoning row\nsecond reasoning row\nthird reasoning row\nfourth reasoning row",
    );
    let live_lines = app.render_active_turn_lines(32);
    let live_rows = paragraph_line_count(&live_lines, 32);

    app.commit_streaming_thinking_summary();
    let thinking = app.messages.last().expect("collapsed thinking message");
    let mut collapsed_lines =
        render_message_with_width(thinking, None, false, false, false, "", Some(32));
    push_separator_after_message(&mut collapsed_lines);
    let collapsed_rows = paragraph_line_count(&collapsed_lines, 32);

    assert_eq!(live_rows, LIVE_THINKING_PREVIEW_ROWS + 1);
    assert_eq!(collapsed_rows, LIVE_THINKING_PREVIEW_ROWS + 2);
    assert!(app.streaming_thinking_status.is_empty());
}

#[test]
fn assistant_message_done_clears_live_thinking_status() {
    let mut app = ReplApp::default();

    app.append_streaming_thinking("thinking");
    assert_eq!(app.active_status_detail().as_deref(), Some("Thinking"));

    assert!(app.finish_streaming_text_status());
    assert!(app.active_status_detail().is_none());
}

#[test]
fn structured_thinking_uses_provider_status_without_markdown_parsing() {
    let mut app = ReplApp::default();

    app.append_streaming_thinking("**Inspecting renderer**\n\nChecking stream state.");

    assert_eq!(app.active_status_detail().as_deref(), Some("Thinking"));
    assert!(app.messages.is_empty());
}

#[test]
fn assistant_text_stream_commits_prior_thinking_summary() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_thinking("**Inspecting renderer**\n\nChecking stream state.");
    app.append_streaming_text("answer\n");

    assert!(app.streaming_thinking_status.is_empty());
    assert!(app.streaming_thinking_buffer.is_empty());
    assert_eq!(
        messages_as_pairs(&app),
        vec![(
            MessageRole::System,
            "[Thinking] **Inspecting renderer**\n\nChecking stream state.".to_string()
        )]
    );
    assert!(lines_to_text(&app.render_active_turn_lines(80)).contains("answer"));
}

#[test]
fn assistant_message_done_commits_structured_thinking_summary_without_answer() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_thinking("**Inspecting renderer**\n\nChecking stream state.");

    assert!(app.commit_streaming_thinking_summary());

    assert_eq!(
        messages_as_pairs(&app),
        vec![(
            MessageRole::System,
            "[Thinking] **Inspecting renderer**\n\nChecking stream state.".to_string()
        )]
    );
    assert!(app.active_status_detail().is_none());
}

#[test]
fn provider_thinking_without_markdown_stays_structured() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_thinking("raw hidden reasoning");

    assert!(app.commit_streaming_thinking_summary());
    assert_eq!(
        messages_as_pairs(&app),
        vec![(
            MessageRole::System,
            "[Thinking] raw hidden reasoning".to_string()
        )]
    );
    assert_eq!(app.active_status_detail().as_deref(), None);
}

#[test]
fn provider_thinking_after_tool_result_stays_structured() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.push_tool_running(
        "tool-1".to_string(),
        "bash".to_string(),
        r#"{"command":"echo ok"}"#.to_string(),
    );
    app.push_tool_done(
        "tool-1".to_string(),
        "bash".to_string(),
        "ok\n".to_string(),
        false,
    );
    app.append_streaming_thinking("tool result is ready");
    app.append_streaming_text("answer");

    let messages = messages_as_pairs(&app);
    assert!(
        messages
            .iter()
            .any(|(_, text)| text == "[Thinking] tool result is ready")
    );
    assert!(lines_to_text(&app.render_active_turn_lines(80)).contains("answer"));
}

#[test]
fn history_replay_preserves_provider_thinking_block() {
    let mut app = ReplApp::default();
    let messages = vec![Message::Assistant {
        content: vec![ContentBlock::Thinking {
            thinking: "raw hidden reasoning".to_string(),
            signature: String::new(),
        }],
        usage: None,
    }];

    app.replace_transcript_from_history(&messages);

    assert_eq!(
        messages_as_pairs(&app),
        vec![(
            MessageRole::System,
            "[Thinking] raw hidden reasoning".to_string()
        )]
    );
}

#[test]
fn history_replay_does_not_parse_thinking_markdown() {
    let mut app = ReplApp::default();
    let messages = vec![Message::Assistant {
        content: vec![ContentBlock::Thinking {
            thinking: "**Inspecting renderer**\n\nChecking stream state.".to_string(),
            signature: String::new(),
        }],
        usage: None,
    }];

    app.replace_transcript_from_history(&messages);

    assert_eq!(
        messages_as_pairs(&app),
        vec![(
            MessageRole::System,
            "[Thinking] **Inspecting renderer**\n\nChecking stream state.".to_string()
        )]
    );
}

#[test]
fn assistant_text_stream_clears_prior_thinking_status() {
    let mut app = ReplApp::default();

    app.append_streaming_thinking("thinking");
    app.append_streaming_text("answer");

    assert!(app.streaming_thinking_status.is_empty());
    assert!(app.active_status_detail().is_none());
}

#[test]
fn streaming_text_hides_status_indicator_at_live_tail() {
    let mut app = ReplApp::default();

    app.append_streaming_text("streaming answer");

    assert!(!app.status_indicator_visible());
}

#[test]
fn running_tool_restores_status_indicator_during_stream() {
    let mut app = ReplApp::default();

    app.append_streaming_text("before tool");
    assert!(!app.status_indicator_visible());

    app.push_tool_running(
        "tool-1".to_string(),
        "bash".to_string(),
        r#"{"command":"cargo test"}"#.to_string(),
    );

    assert!(app.status_indicator_visible());
    assert!(app.active_status_detail().is_some());
}

#[test]
fn tool_start_flushes_unterminated_answer_stream() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_text("before tool");
    assert!(lines_to_text(&app.render_active_turn_lines(80)).contains("before tool"));

    app.push_tool_running(
        "tool-1".to_string(),
        "bash".to_string(),
        r#"{"command":"cargo test"}"#.to_string(),
    );

    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::Assistant, "before tool".to_string())]
    );
    assert!(
        app.active_status_detail()
            .as_deref()
            .is_some_and(|detail| detail.contains("cargo test")),
        "running tool detail should remain visible after answer stream flush"
    );
}

#[test]
fn committed_recent_low_signal_tool_storm_collapses_but_running_tool_stays_visible() {
    let mut app = ReplApp {
        recent_turn_transcript_start: Some(0),
        ..ReplApp::default()
    };

    app.push_tool_running(
        "tool-1".to_string(),
        "read".to_string(),
        r#"{"file":"a.rs"}"#.to_string(),
    );
    app.push_tool_done(
        "tool-1".to_string(),
        "read".to_string(),
        "ok".to_string(),
        false,
    );
    app.push_tool_running(
        "tool-2".to_string(),
        "grep".to_string(),
        r#"{"pattern":"needle"}"#.to_string(),
    );
    app.push_tool_done(
        "tool-2".to_string(),
        "grep".to_string(),
        "found 2 matches".to_string(),
        false,
    );
    app.push_tool_running(
        "tool-3".to_string(),
        "bash".to_string(),
        r#"{"command":"cargo test"}"#.to_string(),
    );

    let rendered = app.render_fullscreen_transcript_lines(80, 40);
    let transcript_text = lines_to_text(&rendered);
    assert!(transcript_text.contains("read x1 · grep x1 · bash x1"));
    assert!(transcript_text.contains("alt + t to expand tools"));
    assert!(transcript_text.contains("latest: bash running"));
    assert!(
        app.active_status_detail()
            .as_deref()
            .is_some_and(|detail| detail.contains("cargo test"))
    );
    assert!(transcript_text.contains("latest: grep done - found 2 matches"));
}

#[test]
fn tool_start_consolidates_frame_tick_stream_chunks_before_tool_status() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_text("one\ntwo\npartial");
    assert!(app.commit_streaming_text_tick());
    assert!(app.commit_streaming_text_tick());
    assert_eq!(app.messages.len(), 2);

    app.push_tool_running(
        "tool-1".to_string(),
        "bash".to_string(),
        r#"{"command":"cargo test"}"#.to_string(),
    );

    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::Assistant, "one\ntwo\npartial".to_string())]
    );
    assert!(app.streaming_transcript_start.is_none());
    assert!(app.active_turn.is_some());
    assert!(app.active_status_detail().is_some());
}

#[test]
fn completed_final_stream_keeps_status_suppressed_without_queued_input() {
    let mut app = ReplApp::default();

    app.append_streaming_text("final answer");
    assert!(!app.status_indicator_visible());

    app.commit_streaming_text();
    assert!(app.finish_streaming_text_status());

    assert!(!app.status_indicator_visible());

    assert!(app.enqueue_user_message_for_turn(Message::user_text(
        "follow-up while turn is still finishing"
    )));
    assert!(app.status_indicator_visible());
}

#[test]
fn frame_tick_commit_keeps_unterminated_line_live_but_uncommitted() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_text("partial");

    assert!(!app.commit_streaming_text_tick());
    assert!(app.messages.is_empty());
    assert!(
        lines_to_text(&app.render_active_turn_lines(80)).contains("partial"),
        "unterminated partial source should stay visible in the active live tail"
    );
    assert!(!app.status_indicator_visible());
}

#[test]
fn frame_tick_commit_only_moves_newline_terminated_prefix() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_text("complete\npartial");

    assert!(app.commit_streaming_text_tick());
    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::Assistant, "complete\n".to_string())]
    );
    assert!(lines_to_text(&app.render_active_turn_lines(80)).contains("partial"));
}

#[test]
fn frame_tick_commit_drains_one_source_line_in_smooth_mode() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_text("one\ntwo\npartial");

    assert_eq!(
        app.streaming_tick_source_line_limit(),
        STREAM_SMOOTH_COMMIT_SOURCE_LINES
    );
    assert!(app.commit_streaming_text_tick());
    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::Assistant, "one\n".to_string())]
    );
    let active_text = lines_to_text(&app.render_active_turn_lines(80));
    assert!(active_text.contains("two"));
    assert!(active_text.contains("partial"));
}

#[test]
fn frame_tick_stream_chunks_do_not_merge_adjacent_assistant_messages() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_text("one\ntwo\npartial");

    assert!(app.commit_streaming_text_tick());
    assert!(app.commit_streaming_text_tick());

    assert_eq!(
        messages_as_pairs(&app),
        vec![
            (MessageRole::Assistant, "one\n".to_string()),
            (MessageRole::Assistant, "two\n".to_string()),
        ]
    );
    assert!(lines_to_text(&app.render_active_turn_lines(80)).contains("partial"));
}

#[test]
fn committed_stream_chunks_render_as_one_assistant_block() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_text("one\ntwo\npartial");

    assert!(app.commit_streaming_text_tick());
    assert!(app.commit_streaming_text_tick());

    let rendered = lines_to_text(&app.render_transcript_range(0, 2, 80));
    assert!(rendered.contains("• one"));
    assert!(rendered.contains("  two"));
    assert_eq!(rendered.matches("• ").count(), 1);
}

#[test]
fn completed_tail_after_committed_stream_prefix_stays_visible() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.push_committed_stream_chunk(MessageRole::Assistant, "## 小结\n");
    app.scrollback_committed_until = app.messages.len();
    app.append_streaming_text(
        "北京是一座古老与现代交融的城市，既有厚重的历史底蕴，又充满现代活力。",
    );

    assert!(app.commit_streaming_text());
    assert_eq!(
        messages_as_pairs(&app),
        vec![
            (MessageRole::Assistant, "## 小结\n".to_string()),
            (
                MessageRole::Assistant,
                "北京是一座古老与现代交融的城市，既有厚重的历史底蕴，又充满现代活力。".to_string()
            )
        ]
    );
    assert_eq!(
        app.scrollback_committed_until, 1,
        "already-written terminal scrollback rows must stay immutable"
    );
    assert!(
        !app.consolidate_finished_assistant_stream(),
        "assistant chunks touching committed terminal scrollback must not be merged"
    );

    let live_text = lines_to_text(&app.render_inline_live_transcript_lines(96, 12));
    assert!(
        live_text.contains("北京是一座古老与现代交融的城市"),
        "{live_text}"
    );
}

#[tokio::test]
async fn assistant_message_done_consolidates_frame_tick_stream_chunks() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    app.messages.clear();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    app.append_streaming_text("one\ntwo\npartial");
    assert!(app.commit_streaming_text_tick());
    assert!(app.commit_streaming_text_tick());
    assert_eq!(app.messages.len(), 2);

    let done = handle_app_event(
        AppEvent::AssistantMessageDone,
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;

    assert!(done.redraw);
    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::Assistant, "one\ntwo\npartial".to_string())]
    );
    assert!(app.active_turn.is_none());
    assert!(
        !app.status_indicator_visible(),
        "plain final-answer completion should not flash Working before TurnFinished"
    );
}

#[tokio::test]
async fn consolidated_long_message_scrolls_to_bottom() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    app.messages.clear();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let line = "word ".repeat(100);
    app.append_streaming_text(&line);

    let _ = handle_app_event(
        AppEvent::AssistantMessageDone,
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    let _ = handle_app_event(AppEvent::TurnFinished, &mut app, &engine, &tx, &prompt).await;

    assert!(app.transcript_viewport.position().is_at_tail());
    assert_eq!(app.transcript_viewport.live_content_rows(), 0);

    let width = 20u16;
    let row_budget = TRANSCRIPT_RENDER_MAX_ROWS;
    let start_idx = app.live_transcript_start_index(width, row_budget);
    let lines = app.render_transcript_range_limited(
        start_idx,
        app.messages.len(),
        width,
        Some(row_budget + TRANSCRIPT_RENDER_OVERSCAN_ROWS),
    );
    let line_count = paragraph_line_count(&lines, width);
    let viewport_height = 10usize;
    let top = app
        .transcript_viewport
        .resolve_top(line_count, viewport_height);

    assert!(
        top + viewport_height >= line_count,
        "viewport should show the bottom of the consolidated message"
    );
}

#[tokio::test]
async fn assistant_message_done_commits_deferred_table_tail_with_stream_chunks() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    app.messages.clear();
    let (raw_tx, mut rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    handle_app_event(
        AppEvent::AssistantDelta("intro\n".to_string()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    let tick = handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;

    assert!(tick.redraw);
    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::Assistant, "intro\n".to_string())]
    );
    assert_eq!(app.streaming_transcript_start, Some(0));

    handle_app_event(
        AppEvent::AssistantDelta("| A | B |\n| --- | --- |\n| 1 | 2 |\n".to_string()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    let done = handle_app_event(
        AppEvent::AssistantMessageDone,
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;

    assert!(done.redraw);
    let tick_after_done =
        handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;

    assert!(tick_after_done.redraw);
    assert_eq!(
        messages_as_pairs(&app),
        vec![(
            MessageRole::Assistant,
            "intro\n| A | B |\n| --- | --- |\n| 1 | 2 |\n".to_string()
        )],
        "completed table tail should enter committed history on message completion"
    );
    assert!(app.active_turn.is_none());
    let rendered_tail = lines_to_text(&app.render_transcript_range(0, app.messages.len(), 80));
    assert!(
        rendered_tail.contains("A") && rendered_tail.contains("1"),
        "completed table tail should be visible before turn finalization"
    );

    let finished = handle_app_event(AppEvent::TurnFinished, &mut app, &engine, &tx, &prompt).await;

    assert!(finished.redraw);
    assert!(finished.action.is_none());
    assert!(matches!(rx.recv().await, Some(AppEvent::TurnWakeRequested)));
    assert_eq!(
        messages_as_pairs(&app),
        vec![(
            MessageRole::Assistant,
            "intro\n| A | B |\n| --- | --- |\n| 1 | 2 |\n".to_string()
        )]
    );
    assert!(app.active_turn.is_none());
    assert!(app.streaming_transcript_start.is_none());
}

#[tokio::test]
async fn markdown_table_tail_split_across_stream_ticks_survives_message_done() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    app.messages.clear();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    handle_app_event(
        AppEvent::AssistantDelta(
            "下面是工具说明。\n\n## 一、文件操作\n| 工具 | 用途 |\n".to_string(),
        ),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    let _ = handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;

    handle_app_event(
            AppEvent::AssistantDelta(
                "|---|---|\n| `read` | 读取文件内容（支持文本/图片/Notebook），可按行偏移读取 |\n\n## 二、命令执行\n后续内容\n"
                    .to_string(),
            ),
            &mut app,
            &engine,
            &tx,
            &prompt,
        )
        .await;
    let _ = handle_app_event(
        AppEvent::AssistantMessageDone,
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    let _ = handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;

    let transcript = messages_as_pairs(&app)
        .into_iter()
        .map(|(_, text)| text)
        .collect::<String>();
    assert!(transcript.contains("`read`"), "{transcript}");
    assert!(transcript.contains("二、命令执行"), "{transcript}");

    let rendered = lines_to_text(&app.render_transcript_range(0, app.messages.len(), 96));
    assert!(rendered.contains("read"), "{rendered}");
    assert!(rendered.contains("二、命令执行"), "{rendered}");

    let _ = handle_app_event(AppEvent::TurnFinished, &mut app, &engine, &tx, &prompt).await;
    assert!(app.active_turn.is_none());
}

#[test]
fn assistant_stream_consolidation_does_not_mutate_committed_scrollback() {
    let mut app = ReplApp::default();
    app.messages.clear();
    app.push_message(MessageRole::Assistant, "one\n");
    app.push_message(MessageRole::Assistant, "two\n");
    app.streaming_transcript_start = Some(0);
    app.scrollback_committed_until = 2;
    app.transcript_viewport
        .set_position(TranscriptScroll::to_bottom());

    assert!(!app.consolidate_finished_assistant_stream());

    assert_eq!(
        messages_as_pairs(&app),
        vec![
            (MessageRole::Assistant, "one\n".to_string()),
            (MessageRole::Assistant, "two\n".to_string()),
        ]
    );
    assert_eq!(app.scrollback_committed_until, 2);
    assert!(app.streaming_transcript_start.is_none());
}

#[test]
fn assistant_stream_consolidation_skips_committed_scrollback_when_scrolled_away() {
    let mut app = ReplApp::default();
    app.messages.clear();
    app.push_message(MessageRole::Assistant, "one\n");
    app.push_message(MessageRole::Assistant, "two\n");
    app.streaming_transcript_start = Some(0);
    app.scrollback_committed_until = 2;
    app.transcript_viewport
        .set_position(TranscriptScroll::at_line(0));

    assert!(!app.consolidate_finished_assistant_stream());

    assert_eq!(
        messages_as_pairs(&app),
        vec![
            (MessageRole::Assistant, "one\n".to_string()),
            (MessageRole::Assistant, "two\n".to_string()),
        ]
    );
}

#[test]
fn assistant_stream_consolidation_requires_current_stream_start() {
    let mut app = ReplApp::default();
    app.messages.clear();
    app.push_message(MessageRole::Assistant, "previous one\n");
    app.push_message(MessageRole::Assistant, "previous two\n");

    assert!(!app.consolidate_finished_assistant_stream());

    assert_eq!(
        messages_as_pairs(&app),
        vec![
            (MessageRole::Assistant, "previous one\n".to_string()),
            (MessageRole::Assistant, "previous two\n".to_string()),
        ]
    );
}

#[test]
fn frame_tick_commit_batches_source_lines_in_catch_up_mode() {
    let mut app = ReplApp::default();
    app.messages.clear();
    let source = (0..10)
        .map(|idx| format!("line {idx}\n"))
        .collect::<String>()
        + "partial";

    app.append_streaming_text(source);

    assert_eq!(
        app.streaming_tick_source_line_limit(),
        STREAM_CATCH_UP_COMMIT_SOURCE_LINES
    );
    assert!(app.commit_streaming_text_tick());

    let committed = (0..STREAM_CATCH_UP_COMMIT_SOURCE_LINES)
        .map(|idx| format!("line {idx}\n"))
        .collect::<String>();
    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::Assistant, committed)]
    );
    let active_text = lines_to_text(&app.render_active_turn_lines(80));
    assert!(active_text.contains("line 8"));
    assert!(active_text.contains("line 9"));
    assert!(active_text.contains("partial"));
}

#[test]
fn scheduled_frame_tick_delay_uses_half_rate_defaults() {
    let mut app = ReplApp {
        is_loading: true,
        ..ReplApp::default()
    };
    assert_eq!(
        app.next_frame_tick_delay(),
        Duration::from_millis(COMMIT_TICK_INTERVAL_MS)
    );

    app.is_loading = false;
    app.spinner.start();
    assert_eq!(
        app.next_frame_tick_delay(),
        Duration::from_millis(SPINNER_INTERVAL_MS)
    );

    app.is_loading = true;
    assert_eq!(
        app.next_frame_tick_delay(),
        Duration::from_millis(SPINNER_INTERVAL_MS.min(COMMIT_TICK_INTERVAL_MS))
    );
}

#[tokio::test]
async fn first_streaming_delta_seeds_only_one_redraw() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let first = handle_app_event(
        AppEvent::AssistantDelta("first".to_string()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    let second = handle_app_event(
        AppEvent::AssistantDelta(" second".to_string()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;

    assert!(first.redraw);
    assert!(!second.redraw);
    assert!(!app.take_force_viewport_redraw());
    assert_eq!(app.streaming_text_pending, "first second");
    assert!(
        !lines_to_text(&app.render_active_turn_lines(80)).contains("first second"),
        "event deltas should queue for the frame tick instead of popping in immediately"
    );
    assert!(!app.status_indicator_visible());
}

#[tokio::test]
async fn frame_tick_redraws_live_partial_after_quiet_delta() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp {
        is_loading: true,
        ..ReplApp::default()
    };
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let first = handle_app_event(
        AppEvent::AssistantDelta("first".to_string()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    let second = handle_app_event(
        AppEvent::AssistantDelta(" second".to_string()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    let tick = handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;

    assert!(first.redraw);
    assert!(!second.redraw);
    assert!(tick.redraw);
    assert!(app.messages.is_empty());
    assert!(lines_to_text(&app.render_active_turn_lines(80)).contains("first second"));
}

#[tokio::test]
async fn frame_tick_presents_large_delta_in_bounded_chunks() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp {
        is_loading: true,
        ..ReplApp::default()
    };
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    let text = "abcd".repeat(80);

    let first = handle_app_event(
        AppEvent::AssistantDelta(text.clone()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    assert!(first.redraw);
    assert_eq!(active_text(&app), "");
    assert_eq!(app.streaming_text_pending, text);

    let tick = handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;

    assert!(tick.redraw);
    assert_eq!(
        active_text(&app).graphemes(true).count(),
        STREAM_TEXT_SMOOTH_GRAPHEMES_PER_TICK
    );
    assert!(!app.streaming_text_pending.is_empty());
}

#[tokio::test]
async fn deferred_stream_finish_blocks_next_turn_until_drained() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    app.messages.clear();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(async {});
    let text = "x".repeat(STREAM_TEXT_CATCH_UP_GRAPHEMES_PER_TICK * 2 + 17);

    app.begin_turn(handle, cancel.clone());
    handle_app_event(
        AppEvent::AssistantDelta(text),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    handle_app_event(
        AppEvent::AssistantMessageDone,
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    handle_app_event(AppEvent::TurnFinished, &mut app, &engine, &tx, &prompt).await;
    assert!(app.deferred_turn_finish_pending);

    assert!(app.enqueue_user_message_for_turn(Message::user_text("next turn")));
    let started = try_start_next_turn(&engine, &mut app, &tx, &prompt)
        .await
        .unwrap()
        .started();

    assert!(!started);
    assert_eq!(app.user_message_queue.len(), 1);
    assert!(engine.state.messages().is_empty());
}

#[tokio::test]
async fn ctrl_c_during_deferred_stream_finish_completes_instead_of_cancelling() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    app.messages.clear();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(async {});

    app.begin_turn(handle, cancel.clone());
    handle_app_event(
        AppEvent::AssistantDelta("final answer".to_string()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    handle_app_event(
        AppEvent::AssistantMessageDone,
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    handle_app_event(AppEvent::TurnFinished, &mut app, &engine, &tx, &prompt).await;
    assert!(app.deferred_turn_finish_pending);

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));

    assert!(matches!(action, Some(UserAction::CompleteDeferredTurn)));
    assert!(!cancel.is_cancelled());
    handle_user_action(action.unwrap(), &engine, &mut app, &tx, &prompt)
        .await
        .unwrap();
    assert!(!app.deferred_turn_finish_pending);
    assert!(!app.is_loading);
    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::Assistant, "final answer".to_string())]
    );
    assert!(
        !messages_as_pairs(&app)
            .iter()
            .any(|(_, text)| text == "Cancelled.")
    );
}

#[tokio::test]
async fn esc_during_deferred_goal_finish_pauses_instead_of_starting_next_turn() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    engine.state.set_goal("finish the goal", Some(50_000));
    let mut app = ReplApp::default();
    app.messages.clear();
    app.refresh_engine_metadata(&engine);
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(async {});

    app.begin_turn(handle, cancel);
    handle_app_event(
        AppEvent::AssistantDelta("final goal answer".to_string()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    handle_app_event(
        AppEvent::AssistantMessageDone,
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    handle_app_event(AppEvent::TurnFinished, &mut app, &engine, &tx, &prompt).await;
    assert!(app.deferred_turn_finish_pending);

    let action = app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert!(matches!(action, Some(UserAction::Interrupt)));
    handle_user_action(action.unwrap(), &engine, &mut app, &tx, &prompt)
        .await
        .unwrap();
    assert_eq!(engine.state.goal().unwrap().status, GoalStatus::Paused);
    assert!(!app.deferred_turn_finish_pending);
}

#[test]
fn footer_context_total_uses_the_sendable_input_limit() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    {
        let mut settings = engine.settings.write().unwrap();
        settings.context_window_tokens = Some(100_000);
        settings.context_output_headroom = Some(20_000);
    }
    let mut app = ReplApp::default();

    app.refresh_engine_metadata(&engine);

    assert_eq!(app.token_total, 80_000);
}

#[tokio::test]
async fn assistant_message_done_refreshes_context_usage_before_long_tools_finish() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp {
        token_count: 0,
        ..ReplApp::default()
    };
    engine.state.add_message(kcoder_types::Message::Assistant {
        content: vec![kcoder_types::ContentBlock::Text {
            text: "done".to_string(),
        }],
        usage: Some(kcoder_types::Usage {
            input_tokens: 20_000,
            output_tokens: 1_000,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            total_tokens: None,
            iterations: None,
        }),
    });
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    handle_app_event(
        AppEvent::AssistantMessageDone,
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;

    assert_eq!(app.token_count, 21_000);
}

#[tokio::test]
async fn thinking_delta_drains_earlier_pending_text_before_status_update() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let first = handle_app_event(
        AppEvent::AssistantDelta("visible before thinking".to_string()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    let thinking = handle_app_event(
        AppEvent::AssistantThinkingDelta("thinking now".to_string()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;

    assert!(first.redraw);
    assert!(thinking.redraw);
    assert!(app.streaming_text_pending.is_empty());
    assert_eq!(active_text(&app), "visible before thinking");
    assert_eq!(app.streaming_thinking_status, "thinking now");
}

#[tokio::test]
async fn tool_input_progress_replaces_stale_thinking_status() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    app.start_loading();
    handle_app_event(
        AppEvent::AssistantThinkingDelta("planning a large write".to_string()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    let started = handle_app_event(
        AppEvent::ToolInputProgress {
            name: "write".to_string(),
            chars: 0,
        },
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;

    assert!(started.redraw);
    assert_eq!(app.spinner.snapshot().phase, ActivityPhase::PreparingTool);
    assert_eq!(app.spinner.preparing_tool_progress(), Some(("write", 0)));
    assert!(app.streaming_thinking_status.is_empty());
    assert_eq!(
        messages_as_pairs(&app),
        vec![(
            MessageRole::System,
            "[Thinking] planning a large write".to_string()
        )]
    );
    assert!(!lines_to_text(&app.render_active_turn_lines(80)).contains("planning a large write"));
    assert_eq!(app.activity_presentation().label, "Preparing write input");

    let progress = handle_app_event(
        AppEvent::ToolInputProgress {
            name: "write".to_string(),
            chars: 20_000,
        },
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    assert!(progress.redraw);
    assert!(
        app.activity_presentation()
            .label
            .contains("Preparing write input · 20K chars")
    );
}

#[tokio::test]
async fn tool_start_drains_pending_text_before_tool_status() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    handle_app_event(
        AppEvent::AssistantDelta("before tool".to_string()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    handle_app_event(
        AppEvent::ToolUseStarted {
            id: "tool-1".to_string(),
            name: "bash".to_string(),
            input: "{\"command\":\"pwd\"}".to_string(),
        },
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;

    assert!(app.streaming_text_pending.is_empty());
    let rendered = lines_to_text(&app.render_active_turn_lines(80));
    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::Assistant, "before tool".to_string())]
    );
    assert!(rendered.contains("bash"), "{rendered}");
}

#[test]
fn replacing_history_clears_pending_stream_presentation() {
    let mut app = ReplApp::default();
    app.messages.clear();
    app.enqueue_streaming_text_delta("queued text");
    assert_eq!(app.streaming_text_pending, "queued text");
    assert!(app.active_turn.is_some());

    app.replace_transcript_from_history(&[Message::assistant_text("loaded answer")]);

    assert!(app.streaming_text_pending.is_empty());
    assert!(!app.streaming_message_done_pending);
    assert!(!app.deferred_turn_finish_pending);
    assert!(app.active_turn.is_none());
    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::Assistant, "loaded answer".to_string())]
    );
}

#[tokio::test]
async fn frame_tick_redraws_while_loading_to_keep_tick_chain_alive() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp {
        is_loading: true,
        ..ReplApp::default()
    };
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let tick = handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;

    assert!(tick.redraw);
}

#[tokio::test]
async fn streaming_commit_does_not_reseed_delta_redraws_in_same_turn() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let first = handle_app_event(
        AppEvent::AssistantDelta("hello".to_string()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    let done = handle_app_event(
        AppEvent::AssistantMessageDone,
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    let second = handle_app_event(
        AppEvent::AssistantDelta(" world".to_string()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;

    assert!(first.redraw);
    assert!(done.redraw);
    assert!(!second.redraw);
    assert!(!app.take_force_viewport_redraw());
}

#[tokio::test]
async fn assistant_message_done_commits_table_tail_and_keeps_status_suppressed() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(tmp.path());
    let mut app = ReplApp::default();
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let first = handle_app_event(
        AppEvent::AssistantDelta("| A | B |\n| --- | --- |\n| 1 | 2 |\n".to_string()),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    let done = handle_app_event(
        AppEvent::AssistantMessageDone,
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;

    assert!(first.redraw);
    assert!(done.redraw);
    let tick_after_done =
        handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;

    assert!(tick_after_done.redraw);
    assert_eq!(
        messages_as_pairs(&app),
        vec![(
            MessageRole::Assistant,
            "| A | B |\n| --- | --- |\n| 1 | 2 |\n".to_string()
        )],
        "completed table tail should enter committed history"
    );
    assert!(app.active_turn.is_none());
    assert!(
        !app.status_indicator_visible(),
        "plain final-answer completion should keep status hidden until TurnFinished"
    );
}

#[test]
fn commit_streaming_text_commits_completed_prefix_before_tools() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_text("before");
    app.commit_streaming_text();
    app.push_tool_running(
        "tool-1".to_string(),
        "read".to_string(),
        "{\"file\":\"a.rs\"}".to_string(),
    );
    app.push_tool_done(
        "tool-1".to_string(),
        "read".to_string(),
        "ok".to_string(),
        false,
    );
    app.append_streaming_text("after");
    app.commit_streaming_text();

    assert_eq!(
        messages_as_pairs(&app),
        vec![
            (MessageRole::Assistant, "before".to_string()),
            (
                MessageRole::System,
                "[Tool use: read] {\"file\":\"a.rs\"}".to_string()
            ),
            (
                MessageRole::System,
                "✓ Tool succeeded: read - ok".to_string()
            ),
            (MessageRole::Assistant, "after".to_string()),
        ]
    );
    assert!(app.active_turn.is_none());
}

#[test]
fn repeated_streaming_commits_merge_adjacent_assistant_text() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_text("hello ");
    app.commit_streaming_text();
    app.append_streaming_text("world");
    app.commit_streaming_text();

    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::Assistant, "hello world".to_string())]
    );
}

#[test]
fn streaming_commit_does_not_force_full_viewport_repaint() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_text("hello");
    assert!(app.commit_streaming_text());

    assert!(!app.take_force_viewport_redraw());
}

#[test]
fn merged_streaming_commit_invalidates_committed_render_cache() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_text("hello ");
    app.commit_streaming_text();
    let first = app.render_transcript_range(0, 1, 80);
    assert!(lines_to_text(&first).contains("hello"));

    app.append_streaming_text("world");
    app.commit_streaming_text();
    let second = app.render_transcript_range(0, 1, 80);

    assert!(lines_to_text(&second).contains("hello world"));
}

#[test]
fn append_only_transcript_push_preserves_existing_render_cache() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.push_message(MessageRole::Assistant, "cached");
    let first = app.render_transcript_range(0, 1, 80);

    assert!(lines_to_text(&first).contains("cached"));
    assert!(app.render_cache.get(0, None, false, false).is_some());

    app.push_message(MessageRole::Assistant, "new tail");

    assert!(app.render_cache.get(0, None, false, false).is_some());
    let second = app.render_transcript_range(0, 2, 80);
    assert!(lines_to_text(&second).contains("new tail"));
}

#[test]
fn active_turn_render_cache_reuses_unchanged_tail() {
    let mut app = ReplApp::default();
    app.append_streaming_text("hello");

    let first = app.render_active_turn_lines(80);
    let first_key = app.active_turn_render_cache.as_ref().unwrap().key.clone();
    let second = app.render_active_turn_lines(80);
    let second_key = app.active_turn_render_cache.as_ref().unwrap().key.clone();

    assert_eq!(lines_to_text(&first), lines_to_text(&second));
    assert_eq!(first_key, second_key);
}

#[test]
fn active_turn_render_cache_invalidates_when_live_partial_tail_changes() {
    let mut app = ReplApp::default();
    app.append_streaming_text("hello");
    app.render_active_turn_lines(80);
    let first_key = app.active_turn_render_cache.as_ref().unwrap().key.clone();

    app.append_streaming_text(" world");
    let rendered = app.render_active_turn_lines(80);
    let second_key = app.active_turn_render_cache.as_ref().unwrap().key.clone();

    assert_ne!(first_key, second_key);
    assert!(lines_to_text(&rendered).contains("hello world"));
}

#[test]
fn active_turn_render_cache_invalidates_when_width_changes() {
    let mut app = ReplApp::default();
    app.append_streaming_text("- first second third fourth\n");

    let narrow = app.render_active_turn_lines(16);
    let narrow_key = app.active_turn_render_cache.as_ref().unwrap().key.clone();
    let wide = app.render_active_turn_lines(80);
    let wide_key = app.active_turn_render_cache.as_ref().unwrap().key.clone();

    assert_ne!(narrow_key, wide_key);
    assert!(lines_to_text(&narrow).contains("  third fourth"));
    assert!(lines_to_text(&wide).contains("  - first second third fourth"));
}

#[test]
fn active_running_bash_tool_status_detail_shows_command_not_json_input() {
    let mut app = ReplApp {
        active_tools_expanded: true,
        ..ReplApp::default()
    };
    app.push_tool_running(
        "tool-1".to_string(),
        "bash".to_string(),
        r#"{"command":"cargo test --workspace","description":"Run tests"}"#.to_string(),
    );

    let detail = app.active_status_detail().unwrap_or_default();

    assert!(detail.contains("cargo test --workspace"));
    assert!(!detail.contains(r#""command""#));
}

#[test]
fn active_status_detail_for_running_bash_shows_command_not_tool_name() {
    let mut app = ReplApp::default();
    app.push_tool_running(
        "tool-1".to_string(),
        "bash".to_string(),
        r#"{"command":"cargo test --workspace","description":"Run tests"}"#.to_string(),
    );

    assert_eq!(
        app.active_status_detail().as_deref(),
        Some("Running cargo test --workspace")
    );
}

#[test]
fn active_turn_collapses_consecutive_tool_storm_but_keeps_edit_visible() {
    let mut app = ReplApp::default();
    app.push_tool_running(
        "tool-1".to_string(),
        "read".to_string(),
        r#"{"file":"src/lib.rs"}"#.to_string(),
    );
    app.push_tool_done(
        "tool-1".to_string(),
        "read".to_string(),
        "read ok".to_string(),
        false,
    );
    app.push_tool_running(
        "tool-2".to_string(),
        "grep".to_string(),
        r#"{"pattern":"TODO"}"#.to_string(),
    );
    app.push_tool_done(
        "tool-2".to_string(),
        "grep".to_string(),
        "found 3".to_string(),
        false,
    );
    app.push_tool_running(
        "tool-3".to_string(),
        "bash".to_string(),
        r#"{"command":"ls crates"}"#.to_string(),
    );
    app.push_tool_done(
        "tool-3".to_string(),
        "bash".to_string(),
        "kcoder_repl".to_string(),
        false,
    );
    app.push_tool_running(
        "tool-4".to_string(),
        "edit".to_string(),
        r#"{"file_path":"src/lib.rs"}"#.to_string(),
    );
    app.push_tool_done(
        "tool-4".to_string(),
        "edit".to_string(),
        "Edited src/lib.rs\n```diff\n@@ -1 +1 @@\n-old\n+new\n```".to_string(),
        false,
    );

    let rendered = lines_to_text(&app.render_fullscreen_transcript_lines(96, 60));

    assert!(
        rendered.contains("read x1 · grep x1 · bash x1"),
        "rendered active transcript:\n{rendered}"
    );
    assert!(!rendered.contains("edit x1"));
    assert!(rendered.contains("alt + t to expand tools"));
    assert!(!rendered.contains("read ok"));
    assert!(rendered.contains("latest: grep done - found 3"));
    assert!(rendered.contains("Edited src/lib.rs"));
    assert!(rendered.contains("-old"));
    assert!(rendered.contains("+new"));

    let overlay = lines_to_text(&app.render_full_transcript_overlay_lines(96));
    assert!(
        overlay.contains("read x1 · grep x1 · bash x1"),
        "rendered transcript overlay:\n{overlay}"
    );
    assert!(!overlay.contains("edit x1"));
    assert!(overlay.contains("Edited src/lib.rs"));
    assert_eq!(overlay.matches("◇ tools").count(), 1, "{overlay}");
}

#[test]
fn write_preview_follows_stream_tail_then_settles_on_completed_head() {
    let mut app = ReplApp::default();
    let source_lines = (1..=30)
        .map(|line| format!("preview-row-{line:03}"))
        .collect::<Vec<_>>();
    app.push_write_input_preview(
        "write-1".to_string(),
        WriteInputPreview {
            path: Some("src/generated.rs".to_string()),
            lines: source_lines[20..].to_vec(),
            first_line_number: 21,
            total_lines: 30,
            complete: false,
        },
    );

    let streaming = lines_to_text(&app.render_active_turn_lines(100));
    assert!(streaming.contains("src/generated.rs"), "{streaming}");
    assert!(streaming.contains("preview-row-021"), "{streaming}");
    assert!(streaming.contains("preview-row-030"), "{streaming}");
    assert!(!streaming.contains("preview-row-020"), "{streaming}");

    let input = serde_json::json!({
        "file_path": "src/generated.rs",
        "content": source_lines.join("\n"),
    })
    .to_string();
    app.push_tool_running("write-1".to_string(), "write".to_string(), input);
    app.push_tool_done(
            "write-1".to_string(),
            "write".to_string(),
            "File created successfully at: src/generated.rs\n```diff\n@@ -0,0 +1,2 @@\n+preview-row-001\n+preview-row-002\n```"
                .to_string(),
            false,
        );

    let completed = lines_to_text(&app.render_active_turn_lines(100));
    assert!(completed.contains("preview-row-001"), "{completed}");
    assert!(completed.contains("preview-row-010"), "{completed}");
    assert!(!completed.contains("preview-row-011"), "{completed}");
    assert!(completed.contains("20 more lines, 30 total"), "{completed}");
    assert!(
        completed.contains("File created successfully"),
        "{completed}"
    );
    assert!(!completed.contains("@@ -0,0"), "{completed}");
    assert!(!completed.contains("+preview-row-001"), "{completed}");
}

#[test]
fn transcript_markdown_render_uses_available_width() {
    let mut app = ReplApp::default();
    app.push_message(MessageRole::Assistant, "- first second third fourth");

    let narrow = lines_to_text(&app.render_transcript_range(0, 1, 16));
    let wide = lines_to_text(&app.render_transcript_range(0, 1, 80));

    assert!(narrow.contains("  third fourth"));
    assert!(wide.contains("  - first second third fourth"));
}

#[test]
fn transcript_markdown_table_after_heading_renders_past_table() {
    let mut app = ReplApp::default();
    app.push_message(
            MessageRole::Assistant,
            "下面是工具说明。\n\n## 一、文件操作\n| 工具 | 用途 |\n|---|---|\n| `read` | 读取文件内容（支持文本/图片/Notebook），可按行偏移读取 |\n\n## 二、命令执行\n后续内容\n",
        );

    let rendered = lines_to_text(&app.render_transcript_range(0, 1, 96));

    assert!(rendered.contains("一、文件操作"), "{rendered}");
    assert!(rendered.contains("read"), "{rendered}");
    assert!(rendered.contains("二、命令执行"), "{rendered}");
}

#[test]
fn raw_output_mode_renders_assistant_markdown_source() {
    let mut app = ReplApp::default();
    app.push_message(
        MessageRole::Assistant,
        "See [docs](https://example.com/docs).",
    );

    let rich = lines_to_text(&app.render_transcript_range(0, 1, 80));
    assert!(rich.contains("See docs (https://example.com/docs)."));
    assert!(!rich.contains("[docs](https://example.com/docs)"));

    app.set_raw_output_mode(true);
    let raw = lines_to_text(&app.render_transcript_range(0, 1, 80));

    assert!(raw.contains("See [docs](https://example.com/docs)."));
}

#[test]
fn raw_output_mode_forces_plain_expanded_rendering_without_changing_setting() {
    let mut app = ReplApp::default();
    assert!(app.render_markdown);
    assert!(app.effective_render_markdown());
    assert!(!app.effective_tool_transcript_expanded());
    assert!(!app.effective_tool_output_expanded());
    assert_eq!(app.raw_output_status_label(), "");

    app.set_raw_output_mode(true);

    assert!(app.raw_output_mode());
    assert!(app.render_markdown);
    assert!(!app.effective_render_markdown());
    assert!(app.effective_tool_transcript_expanded());
    assert!(app.effective_tool_output_expanded());
    assert!(app.effective_active_tools_expanded());
    assert_eq!(app.raw_output_status_label(), "raw output");
}

#[test]
fn raw_output_mode_does_not_clear_or_reflow_terminal_scrollback() {
    let mut app = ReplApp {
        scrollback_committed_until: 1,
        ..ReplApp::default()
    };

    app.set_raw_output_mode(true);

    assert_eq!(app.scrollback_committed_until, 1);
}

#[test]
fn transcript_overlay_lines_include_full_transcript_and_active_tail() {
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "older prompt");
    app.push_message(MessageRole::Assistant, "older response");
    app.append_streaming_text("live response\n");

    let text = lines_to_text(&app.render_full_transcript_overlay_lines(80));

    assert!(text.contains("older prompt"));
    assert!(text.contains("older response"));
    assert!(text.contains("live response"));
}

#[test]
fn transcript_overlay_lines_exclude_queued_preview() {
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "older prompt");
    assert!(app.enqueue_user_message_for_turn(Message::user_text("queued follow-up question")));

    let text = lines_to_text(&app.render_full_transcript_overlay_lines(80));

    assert!(text.contains("older prompt"));
    assert!(!text.contains("Queued follow-up inputs"));
    assert!(!text.contains("queued follow-up question"));
}

#[test]
fn commit_streaming_text_keeps_entries_after_running_tool_active() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_text("before");
    app.push_tool_running(
        "tool-1".to_string(),
        "read".to_string(),
        "{\"file\":\"a.rs\"}".to_string(),
    );
    app.append_streaming_text("tail");
    app.commit_streaming_text();

    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::Assistant, "before".to_string())]
    );
    assert_eq!(
        app.active_turn
            .as_ref()
            .map(|active| active.entries.len())
            .unwrap_or_default(),
        2
    );

    app.flush_active_turn();
    assert_eq!(
        messages_as_pairs(&app),
        vec![
            (MessageRole::Assistant, "before".to_string()),
            (
                MessageRole::System,
                "⟳ Running tool: read - {\"file\":\"a.rs\"}".to_string()
            ),
            (MessageRole::Assistant, "tail".to_string()),
        ]
    );
}

#[test]
fn commit_streaming_text_releases_tail_after_running_tool_finishes() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_text("before");
    app.push_tool_running(
        "tool-1".to_string(),
        "read".to_string(),
        "{\"file\":\"a.rs\"}".to_string(),
    );
    app.append_streaming_text("after");
    app.commit_streaming_text();

    assert_eq!(
        messages_as_pairs(&app),
        vec![(MessageRole::Assistant, "before".to_string())]
    );

    app.push_tool_done(
        "tool-1".to_string(),
        "read".to_string(),
        "ok".to_string(),
        false,
    );
    app.commit_streaming_text();

    assert_eq!(
        messages_as_pairs(&app),
        vec![
            (MessageRole::Assistant, "before".to_string()),
            (
                MessageRole::System,
                "[Tool use: read] {\"file\":\"a.rs\"}".to_string()
            ),
            (
                MessageRole::System,
                "✓ Tool succeeded: read - ok".to_string()
            ),
            (MessageRole::Assistant, "after".to_string()),
        ]
    );
    assert!(app.active_turn.is_none());
}

#[test]
fn flush_preserves_text_tool_text_order() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.append_streaming_text("before");
    app.push_tool_running(
        "tool-1".to_string(),
        "read".to_string(),
        "{\"file\":\"a.rs\"}".to_string(),
    );
    app.push_tool_done(
        "tool-1".to_string(),
        "read".to_string(),
        "ok".to_string(),
        false,
    );
    app.append_streaming_text("after");
    app.flush_active_turn();

    assert_eq!(
        messages_as_pairs(&app),
        vec![
            (MessageRole::Assistant, "before".to_string()),
            (
                MessageRole::System,
                "[Tool use: read] {\"file\":\"a.rs\"}".to_string()
            ),
            (
                MessageRole::System,
                "✓ Tool succeeded: read - ok".to_string()
            ),
            (MessageRole::Assistant, "after".to_string()),
        ]
    );
}

#[test]
fn tool_results_match_by_id_not_latest_name() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.push_tool_running(
        "tool-1".to_string(),
        "read".to_string(),
        "first".to_string(),
    );
    app.push_tool_running(
        "tool-2".to_string(),
        "read".to_string(),
        "second".to_string(),
    );
    app.push_tool_done(
        "tool-1".to_string(),
        "read".to_string(),
        "ok".to_string(),
        false,
    );
    app.flush_active_turn();

    assert_eq!(
        messages_as_pairs(&app),
        vec![
            (MessageRole::System, "[Tool use: read] first".to_string()),
            (
                MessageRole::System,
                "✓ Tool succeeded: read - ok".to_string()
            ),
            (
                MessageRole::System,
                "⟳ Running tool: read - second".to_string()
            ),
        ]
    );
}

#[test]
fn duplicate_tool_result_updates_done_entry_without_adding_extra_line() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.push_tool_running(
        "tool-1".to_string(),
        "read".to_string(),
        "{\"file\":\"a.rs\"}".to_string(),
    );
    app.push_tool_done(
        "tool-1".to_string(),
        "read".to_string(),
        "first".to_string(),
        false,
    );
    app.push_tool_done(
        "tool-1".to_string(),
        "read".to_string(),
        "second".to_string(),
        false,
    );
    app.flush_active_turn();

    assert_eq!(
        messages_as_pairs(&app),
        vec![
            (
                MessageRole::System,
                "[Tool use: read] {\"file\":\"a.rs\"}".to_string()
            ),
            (
                MessageRole::System,
                "✓ Tool succeeded: read - second".to_string()
            ),
        ]
    );
}

#[test]
fn flush_includes_file_edit_diff_card() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.push_tool_running(
        "tool-1".to_string(),
        "edit".to_string(),
        "{\"file_path\":\"src/lib.rs\"}".to_string(),
    );
    app.push_tool_done(
        "tool-1".to_string(),
        "edit".to_string(),
        "Edited src/lib.rs\n```diff\n@@ -1 +1 @@\n-old\n+new\n```".to_string(),
        false,
    );
    app.flush_active_turn();

    let pairs = messages_as_pairs(&app);
    assert!(
        pairs
            .iter()
            .any(|(_, text)| text.starts_with("[Tool use: edit] {\"file_path\":\"src/lib.rs\"}"))
    );
    assert!(
        pairs
            .iter()
            .any(|(_, text)| text.starts_with("✓ Tool succeeded: edit - Edited src/lib.rs"))
    );
    assert!(pairs.iter().any(|(_, text)| {
        text.starts_with("[Tool diff: edit]") && text.contains("-old") && text.contains("+new")
    }));
}

#[test]
fn flush_includes_file_write_diff_card() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.push_tool_running(
        "tool-1".to_string(),
        "write".to_string(),
        "{\"file_path\":\"src/lib.rs\"}".to_string(),
    );
    app.push_tool_done(
        "tool-1".to_string(),
        "write".to_string(),
        "Wrote 12 bytes to src/lib.rs\n```diff\n@@ -1 +1 @@\n-old\n+new\n```".to_string(),
        false,
    );
    app.flush_active_turn();

    let pairs = messages_as_pairs(&app);
    assert!(
        pairs
            .iter()
            .any(|(_, text)| text.starts_with("✓ Tool succeeded: write - Wrote 12 bytes"))
    );
    assert!(pairs.iter().any(|(_, text)| {
        text.starts_with("[Tool diff: write]")
            && text.contains("Edited src/lib.rs (+1 -1)")
            && text.contains("-old")
            && text.contains("+new")
    }));
}

#[test]
fn flush_includes_file_write_lsp_diagnostics_card() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.push_tool_running(
        "tool-1".to_string(),
        "write".to_string(),
        "{\"file_path\":\"src/lsp_case.py\"}".to_string(),
    );
    app.push_tool_done(
        "tool-1".to_string(),
        "write".to_string(),
        "File created successfully at: src/lsp_case.py\n\
             ```diff\n\
             @@ -0,0 +1 @@\n\
             +result: int = takes_int(\"not-an-int\")\n\
             ```\n\n\
             <diagnostics source=\"lsp\" server=\"pyright\" file=\"src/lsp_case.py\">\n\
             ERROR [1:15] bad argument [reportArgumentType] (Pyright)\n\
             </diagnostics>"
            .to_string(),
        false,
    );
    app.flush_active_turn();

    let pairs = messages_as_pairs(&app);
    assert!(pairs.iter().any(|(_, text)| {
        text.starts_with("[Tool diff: write]")
            && text.contains("[Tool diagnostics: lsp]")
            && text.contains("<diagnostics source=\"lsp\" server=\"pyright\"")
            && text.contains("reportArgumentType")
    }));
}

#[test]
fn flush_collapses_todo_write_output() {
    let mut app = ReplApp::default();
    app.messages.clear();

    app.push_tool_running(
        "tool-1".to_string(),
        "TodoWrite".to_string(),
        "{\"todos\":[{\"content\":\"Inspect renderer\"}]}".to_string(),
    );
    app.push_tool_done(
            "tool-1".to_string(),
            "TodoWrite".to_string(),
            "Todos have been modified successfully.\n\nPrevious todo count: 0\nCurrent todo count: 2\n- [pending] Inspect renderer (Inspecting renderer)\n- [in_progress] Patch TUI (Patching TUI)".to_string(),
            false,
        );
    app.flush_active_turn();

    let pairs = messages_as_pairs(&app);
    assert!(pairs.iter().any(|(_, text)| {
        text.starts_with("✓ Tool succeeded: TodoWrite - Todos have been modified successfully")
            && !text.contains("Updated Plan")
            && !text.contains("□ Inspect renderer")
    }));
}

#[test]
fn completed_tool_status_does_not_retain_full_raw_output() {
    let mut app = ReplApp::default();
    let raw_output = format!("{}UNRETAINED_RAW_TAIL", "a".repeat(2_000));

    app.push_tool_running(
        "tool-1".to_string(),
        "bash".to_string(),
        "{\"command\":\"long\"}".to_string(),
    );
    app.push_tool_done("tool-1".to_string(), "bash".to_string(), raw_output, false);

    let debug = format!("{:?}", app.active_turn);
    assert!(!debug.contains("UNRETAINED_RAW_TAIL"));
    assert!(debug.contains("Tool succeeded: bash"));
}

#[test]
fn active_streaming_text_is_capped_for_tui_memory() {
    let mut app = ReplApp::default();
    let raw = format!(
        "{}UNRETAINED_STREAM_TAIL",
        "a".repeat(ACTIVE_TURN_TEXT_MAX_CHARS + 256)
    );

    app.append_streaming_text(raw);

    let text = app
        .active_turn
        .as_ref()
        .unwrap()
        .display_messages(false)
        .into_iter()
        .map(|message| message.text)
        .collect::<String>();
    assert!(text.contains(TUI_TRUNCATION_MARKER));
    assert!(!text.contains("UNRETAINED_STREAM_TAIL"));
}

#[test]
fn active_running_tool_input_is_capped_for_tui_memory() {
    let mut app = ReplApp::default();
    let raw_input = format!(
        "{}UNRETAINED_TOOL_INPUT_TAIL",
        "x".repeat(ACTIVE_TOOL_INPUT_MAX_CHARS + 256)
    );

    app.push_tool_running("tool-1".to_string(), "bash".to_string(), raw_input);

    let debug = format!("{:?}", app.active_turn);
    assert!(debug.contains(TUI_TRUNCATION_MARKER));
    assert!(!debug.contains("UNRETAINED_TOOL_INPUT_TAIL"));
}

#[test]
fn shortenable_waits_are_detected_while_running() {
    use crate::active_turn::{ActiveCell, ActiveEntry, ToolStatus};

    let running = |name: &str| ActiveCell {
        entries: vec![ActiveEntry::Tool(ToolStatus::Running {
            id: "tool-1".to_string(),
            name: name.to_string(),
            input: "{}".to_string(),
            write_preview: None,
        })],
    };

    assert!(running("Sleep").has_running_shortenable_tool());
    assert!(running("wait").has_running_shortenable_tool());
    assert!(!running("bash").has_running_shortenable_tool());
    assert!(!ActiveCell::default().has_running_shortenable_tool());
}

#[test]
fn finished_waits_are_not_shortenable() {
    use crate::active_turn::{ActiveCell, ActiveEntry, ToolStatus};

    let cell = ActiveCell {
        entries: vec![ActiveEntry::Tool(ToolStatus::Done {
            id: "tool-1".to_string(),
            input: "{}".to_string(),
            use_text: String::new(),
            status_text: String::new(),
            diff_text: None,
            write_preview: None,
        })],
    };
    assert!(!cell.has_running_shortenable_tool());
}

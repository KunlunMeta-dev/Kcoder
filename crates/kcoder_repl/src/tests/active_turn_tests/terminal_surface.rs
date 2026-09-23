#[test]
fn exit_cleanup_without_history_leaves_cursor_at_viewport_bottom() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 10 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 18, 80, 6));
    terminal
        .set_cursor_position(Position { x: 12, y: 23 })
        .expect("cursor");
    let mut app = ReplApp::default();

    cleanup_inline_viewport_for_exit(&mut terminal, &mut app).unwrap();

    assert_eq!(terminal.backend().cursor, Position { x: 0, y: 23 });
    assert_eq!(terminal.last_known_cursor_pos, Position { x: 0, y: 23 });
}

#[test]
fn terminal_title_text_prefers_session_title_and_tracks_activity() {
    let mut app = ReplApp {
        display_cwd: "/tmp/kcoder-project".to_string(),
        ..ReplApp::default()
    };

    assert_eq!(app.terminal_title_text(), "[READY] · kcoder-project");

    app.set_session_title("Project Phoenix");
    assert_eq!(app.terminal_title_text(), "[READY] · Project Phoenix");

    app.start_loading();
    assert_eq!(app.terminal_title_text(), "[RUN] · Project Phoenix");
}

#[test]
fn terminal_title_text_truncates_long_session_and_project_parts() {
    let long_title = "This session title is intentionally longer than forty-eight graphemes";
    let mut app = ReplApp {
        display_cwd: "/tmp/kcoder-project".to_string(),
        ..ReplApp::default()
    };
    app.set_session_title(long_title);
    let expected_title = terminal_title::truncate_terminal_title_part(long_title, 48);

    assert_eq!(
        app.terminal_title_text(),
        format!("[READY] · {expected_title}")
    );
    assert!(expected_title.ends_with("..."));

    let project = "kcoder-project-with-a-very-long-display-name";
    let app = ReplApp {
        display_cwd: format!("/tmp/{project}"),
        ..ReplApp::default()
    };
    let expected_project = terminal_title::truncate_terminal_title_part(project, 24);

    assert_eq!(
        app.terminal_title_text(),
        format!("[READY] · {expected_project}")
    );
    assert!(expected_project.ends_with("..."));
}

#[test]
fn terminal_title_sync_deduplicates_and_clears_owned_title() {
    let mut app = ReplApp::default();
    app.set_session_title("Project Phoenix");
    let mut output = Vec::new();

    app.sync_terminal_title(&mut output).unwrap();
    let first = String::from_utf8(output.clone()).unwrap();
    assert_eq!(first, "\x1b]0;[READY] · Project Phoenix\x07");

    app.sync_terminal_title(&mut output).unwrap();
    assert_eq!(String::from_utf8(output.clone()).unwrap(), first);

    app.start_loading();
    app.sync_terminal_title(&mut output).unwrap();
    assert_eq!(
        String::from_utf8(output.clone()).unwrap(),
        format!("{first}\x1b]0;[RUN] · Project Phoenix\x07")
    );

    app.clear_managed_terminal_title(&mut output).unwrap();
    assert_eq!(
        String::from_utf8(output).unwrap(),
        format!("{first}\x1b]0;[RUN] · Project Phoenix\x07\x1b]0;\x07")
    );
}

#[test]
fn draw_kcoder_frame_writes_terminal_title_once_until_it_changes() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 17 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 17, 80, 7));
    let mut app = ReplApp::default();
    app.set_session_title("Project Phoenix");

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();
    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    let output = terminal.backend().output();
    assert_eq!(
        output
            .matches("\x1b]0;[READY] · Project Phoenix\x07")
            .count(),
        1
    );

    app.start_loading();
    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    let output = terminal.backend().output();
    assert!(output.contains("\x1b]0;[RUN] · Project Phoenix\x07"));
}

#[test]
fn inline_viewport_growth_scrolls_prior_terminal_history() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 17 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 17, 80, 7));

    update_inline_viewport(&mut terminal, 24).unwrap();

    assert_eq!(terminal.viewport_area, Rect::new(0, 0, 80, 24));
    assert_eq!(
        terminal.backend().scroll_region_up_calls,
        vec![(0..17, 17)],
        "viewport growth should preserve old terminal rows by scrolling them into native scrollback"
    );
}

#[test]
fn initial_inline_viewport_fullscreen_scrolls_shell_history() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 3 },
    )
    .expect("terminal");

    update_inline_viewport(&mut terminal, 24).unwrap();

    assert_eq!(terminal.viewport_area, Rect::new(0, 0, 80, 24));
    assert_eq!(
        terminal.backend().scroll_region_up_calls,
        vec![(0..3, 3)],
        "first fullscreen inline draw must scroll pre-existing shell rows into terminal scrollback"
    );
    assert_eq!(
        terminal.backend().clear_region_count,
        1,
        "visible TUI area should be cleared after shell rows have been preserved"
    );
}

#[test]
fn inline_viewport_shrink_consumes_excess_bottom_slack() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 23 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 24));

    update_inline_viewport(&mut terminal, 5).unwrap();

    assert_eq!(terminal.viewport_area, Rect::new(0, 19, 80, 5));
    assert!(
        terminal.backend().scroll_region_up_calls.is_empty(),
        "shrinking the live viewport should use blank rows below the frame before touching terminal history"
    );
}

#[test]
fn startup_live_viewport_caps_gap_after_visible_welcome_history() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 35),
        Position { x: 0, y: 11 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 11, 80, 0));
    terminal.note_history_rows_inserted(11);

    update_inline_viewport_for_draw(
        &mut terminal,
        InlineViewportHeights {
            base: 5,
            expanded: 5,
            reserved_bottom_slack: 6,
            max_top: None,
        },
    )
    .unwrap();

    assert_eq!(
        terminal.viewport_area.y, 15,
        "first live viewport after startup welcome should not leave a large blank gap: {:?}",
        terminal.viewport_area
    );
    assert!(
        terminal.viewport_area.bottom() < terminal.size().unwrap().height,
        "idle startup may leave bounded bottom slack after keeping welcome/composer close"
    );
}

#[test]
fn startup_idle_redraw_preserves_gap_cap_after_visible_welcome_history() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(111, 35),
        Position { x: 0, y: 5 },
    )
    .expect("terminal");
    let mut app = ReplApp::default();
    app.render_welcome_component();

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();
    let first_area = terminal.viewport_area;
    let top_limit = app
        .startup_live_viewport_top_limit
        .expect("startup welcome should install a live viewport top limit");

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    assert_eq!(
        terminal.viewport_area, first_area,
        "idle redraw must not move the startup composer farther away from the visible welcome history"
    );
    assert!(
        terminal.viewport_area.y <= top_limit,
        "startup viewport should stay within its visible-history gap cap: viewport={:?}, top_limit={top_limit}",
        terminal.viewport_area
    );
}

#[test]
fn slash_menu_requests_only_downward_inline_height() {
    let mut clean_app = ReplApp::default();
    let clean_height = clean_app.desired_height(100, 30);
    let mut slash_app = ReplApp {
        input: "/".to_string(),
        cursor_grapheme_index: 1,
        ..ReplApp::default()
    };
    slash_app.open_slash_menu();
    let slash_height = slash_app.desired_height(100, 30);

    assert!(
        slash_height > clean_height,
        "slash menu should request editor-local rows when there is bottom slack"
    );

    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(100, 30),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 100, 30));
    let before_area = terminal.viewport_area;
    let mut draw_app = ReplApp {
        input: "/".to_string(),
        cursor_grapheme_index: 1,
        ..ReplApp::default()
    };
    draw_app.open_slash_menu();

    terminal.draw(|frame| draw_app.draw(frame)).unwrap();

    assert_eq!(
        terminal.viewport_area, before_area,
        "direct slash drawing must stay inside the existing frame buffer"
    );
    assert!(
        terminal.backend().scroll_region_up_calls.is_empty(),
        "drawing slash menu must not scroll or rewrite terminal history"
    );
    let dump = buffer_dump(terminal.rendered_buffer_for_tests());
    assert!(
        dump.contains("/quit"),
        "slash menu should render inside the existing inline frame buffer\n{dump}"
    );
}

#[test]
fn slash_menu_open_grows_downward_without_scrolling_history() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(100, 30),
        Position { x: 0, y: 5 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 5, 100, 6));
    let mut app = ReplApp::default();

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();
    let before_area = terminal.viewport_area;
    let before_scroll_calls = terminal.backend().scroll_region_up_calls.len();

    app.input = "/".to_string();
    app.cursor_grapheme_index = 1;
    app.open_slash_menu();
    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    assert_eq!(
        terminal.viewport_area.y, before_area.y,
        "opening / must keep the live viewport top anchored"
    );
    assert!(
        terminal.viewport_area.height > before_area.height,
        "opening / should consume bottom slack instead of rewriting the composer"
    );
    assert!(
        terminal.viewport_area.bottom() <= terminal.size().unwrap().height,
        "downward growth must stay inside the visible terminal"
    );
    assert_eq!(
        terminal.backend().scroll_region_up_calls.len(),
        before_scroll_calls,
        "opening / must not scroll terminal history into native scrollback"
    );
    let dump = buffer_dump(terminal.rendered_buffer_for_tests());
    assert!(
        dump.contains("/quit"),
        "slash menu should render in the transient bottom overlay\n{dump}"
    );
    assert!(
        dump.contains("› /"),
        "composer should keep the current slash input visible\n{dump}"
    );
}

#[test]
fn slash_menu_close_restores_composer_and_leaves_bottom_slack() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(100, 30),
        Position { x: 0, y: 5 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 5, 100, 6));
    let mut app = ReplApp {
        welcome_scrollback_committed: true,
        ..ReplApp::default()
    };

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();
    let base_area = terminal.viewport_area;
    let base_scroll_calls = terminal.backend().scroll_region_up_calls.len();

    app.input = "/".to_string();
    app.cursor_grapheme_index = 1;
    app.open_slash_menu();
    draw_kcoder_frame(&mut terminal, &mut app).unwrap();
    let expanded_area = terminal.viewport_area;
    assert_eq!(expanded_area.y, base_area.y);
    assert!(expanded_area.height > base_area.height);
    assert_eq!(
        terminal.backend().scroll_region_up_calls.len(),
        base_scroll_calls
    );

    app.input.clear();
    app.cursor_grapheme_index = 0;
    app.close_slash_menu();
    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    assert_eq!(
        terminal.viewport_area, base_area,
        "closing / should restore composer/footer to the compact live viewport"
    );
    assert!(
        terminal.viewport_area.bottom() < terminal.size().unwrap().height,
        "released slash rows should become bottom slack below the footer"
    );
    assert_eq!(
        terminal.backend().scroll_region_up_calls.len(),
        base_scroll_calls,
        "opening and closing / must not rewrite terminal scrollback"
    );
}

#[test]
fn compact_slash_menu_remains_visible_after_startup_notice() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(111, 17),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    let mut app = ReplApp::default();
    seed_startup_messages(
        &mut app,
        Some(
            "TUI dev mode is running mock scenario full-turn. Type any message and press Enter."
                .to_string(),
        ),
    );

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();
    let scroll_calls_after_base = terminal.backend().scroll_region_up_calls.len();
    app.input = "/".to_string();
    app.cursor_grapheme_index = 1;
    app.open_slash_menu();
    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    let dump = buffer_dump(terminal.rendered_buffer_for_tests());
    assert!(
        dump.contains("/quit"),
        "compact slash overlay should keep command rows visible after startup notice\nviewport={:?}\n{dump}",
        terminal.viewport_area
    );
    assert!(dump.contains("› /"), "{dump}");
    assert!(
        terminal
            .backend()
            .scroll_region_up_calls
            .iter()
            .skip(scroll_calls_after_base)
            .all(|(range, _)| range.start
                >= terminal
                    .viewport_area
                    .top()
                    .saturating_sub(terminal.visible_history_rows())),
        "opening slash may consume KCoder-owned startup rows, but must not scroll unrelated terminal rows: {:?}",
        terminal.backend().scroll_region_up_calls
    );
}

#[test]
fn startup_content_takes_priority_over_optional_bottom_slack() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(111, 17),
        Position { x: 0, y: 1 },
    )
    .expect("terminal");
    let mut app = ReplApp::default();
    seed_startup_messages(
        &mut app,
        Some(
            "TUI dev mode is running mock scenario full-turn. Type any message and press Enter."
                .to_string(),
        ),
    );

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    assert_eq!(
        terminal.viewport_area.bottom(),
        terminal.size().unwrap().height,
        "startup rows should remain visible instead of being traded for optional bottom slack; viewport={:?}",
        terminal.viewport_area
    );
    assert!(
        terminal
            .backend()
            .scroll_region_up_calls
            .iter()
            .any(|(range, _)| range.start == 0),
        "startup should scroll launch rows before splitting the welcome/startup content block: {:?}",
        terminal.backend().scroll_region_up_calls
    );
    let dump = buffer_dump(terminal.rendered_buffer_for_tests());
    assert!(dump.contains("Ask KCoder"), "{dump}");
    assert!(
        !dump.contains("/quit"),
        "slash menu rows should not be rendered until / is active\n{dump}"
    );
}

#[test]
fn startup_short_screen_does_not_trade_welcome_for_optional_slack() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(111, 13),
        Position { x: 0, y: 1 },
    )
    .expect("terminal");
    let mut app = ReplApp::default();
    app.render_welcome_component();

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    assert_eq!(
        terminal.viewport_area.bottom(),
        terminal.size().unwrap().height,
        "the first live viewport draw should bottom-align in a short terminal instead of scrolling welcome rows to reserve optional slack; viewport={:?}",
        terminal.viewport_area
    );
    assert!(
        terminal
            .backend()
            .scroll_region_up_calls
            .iter()
            .any(|(range, _)| range.start == 0),
        "short startup should move launch rows into native scrollback so the welcome card stays contiguous above the live composer: {:?}",
        terminal.backend().scroll_region_up_calls
    );
    let dump = buffer_dump(terminal.rendered_buffer_for_tests());
    assert!(dump.contains("Ask KCoder"), "{dump}");
}

#[test]
fn slash_menu_open_at_terminal_bottom_does_not_push_scrollback() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(100, 30),
        Position { x: 0, y: 29 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 24, 100, 6));
    terminal.last_known_screen_size = Size::new(100, 30);
    let mut app = ReplApp {
        input: "/".to_string(),
        cursor_grapheme_index: 1,
        ..ReplApp::default()
    };
    app.open_slash_menu();

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    assert_eq!(
        terminal.viewport_area.y, 24,
        "bottom-anchored slash menu must not move the viewport top upward"
    );
    assert_eq!(
        terminal.viewport_area.bottom(),
        terminal.size().unwrap().height,
        "when no bottom slack exists, slash clips inside the available bottom overlay rows"
    );
    assert!(
        terminal.backend().scroll_region_up_calls.is_empty(),
        "slash clipping must not push terminal history"
    );
    let dump = buffer_dump(terminal.rendered_buffer_for_tests());
    assert!(dump.contains("/help"), "{dump}");
    assert!(dump.contains("› /"), "{dump}");
}

#[test]
fn slash_menu_keeps_composer_input_visible() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(100, 30),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 100, 30));
    let mut app = ReplApp {
        input: "/".to_string(),
        cursor_grapheme_index: 1,
        messages: vec![DisplayMessage {
            role: MessageRole::Assistant,
            text: "existing transcript row".to_string(),
        }]
        .into(),
        ..ReplApp::default()
    };
    app.open_slash_menu();

    terminal.draw(|frame| app.draw(frame)).unwrap();

    let dump = buffer_dump(terminal.rendered_buffer_for_tests());
    assert!(
        dump.contains("/quit"),
        "slash menu should be visible\n{dump}"
    );
    assert!(
        dump.contains("› /"),
        "composer input should stay visible while slash menu is open\n{dump}"
    );
}

#[test]
fn slash_menu_keeps_composer_cursor_owned_by_input() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(100, 30),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 100, 30));
    let mut app = ReplApp {
        input: "/".to_string(),
        cursor_grapheme_index: 1,
        ..ReplApp::default()
    };
    app.open_slash_menu();

    terminal.draw(|frame| app.draw(frame)).unwrap();

    assert!(
        terminal.backend().set_cursor_position_count > 0,
        "bottom slash menu should keep the composer cursor active"
    );
}

#[test]
fn picker_overlay_hides_composer_cursor() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(100, 30),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 100, 30));
    let mut app = ReplApp {
        input: "/model".to_string(),
        cursor_grapheme_index: 6,
        ..ReplApp::default()
    };
    app.open_picker_overlay(
        "Select Model",
        vec!["alpha".to_string(), "beta".to_string()],
        PickerAction::SwitchModel,
    );

    terminal.draw(|frame| app.draw(frame)).unwrap();

    assert_eq!(
        terminal.backend().set_cursor_position_count,
        0,
        "centered picker overlay should not leave the composer cursor visible"
    );
    assert!(
        terminal.backend().hide_cursor_count > 0,
        "centered picker overlay should let the terminal hide the cursor"
    );
    assert!(
        !terminal
            .backend()
            .drawn_text
            .contains("Ask KCoder to do anything"),
        "centered picker overlay should clear the inactive composer placeholder"
    );
}

#[test]
fn transient_overlays_request_usable_inline_height() {
    fn assert_height_grows(name: &str, mut app: ReplApp) {
        let mut clean = ReplApp::default();
        let clean_height = clean.desired_height(100, 30);
        let overlay_height = app.desired_height(100, 30);
        assert!(
            overlay_height > clean_height,
            "{name} should request enough inline viewport height: clean={clean_height}, overlay={overlay_height}"
        );
    }

    let mut footer_shortcuts = ReplApp::default();
    footer_shortcuts.toggle_footer_shortcuts_overlay();
    assert_height_grows("footer shortcuts", footer_shortcuts);

    let mut slash = ReplApp {
        input: "/".to_string(),
        cursor_grapheme_index: 1,
        ..ReplApp::default()
    };
    slash.open_slash_menu();
    assert_height_grows("slash menu", slash);

    let mut keys = ReplApp::default();
    keys.open_keys_overlay();
    assert_height_grows("keys overlay", keys);

    let mut transcript = ReplApp::default();
    transcript.open_transcript_overlay();
    assert_height_grows("transcript overlay", transcript);

    let mut context = ReplApp::default();
    context.open_context_inspector(ContextBreakdown {
        total_window: 100_000,
        system: 1_000,
        tools: 2_000,
        reserved_output: 4_000,
        message_budget: 90_000,
        messages_used: 12_000,
        user: 3_000,
        assistant: 7_000,
        tool_use: 1_000,
        tool_result: 800,
        thinking: 200,
    });
    assert_height_grows("context inspector", context);

    let mut settings = ReplApp::default();
    settings.open_settings_inspector(vec!["model = test".to_string()]);
    assert_height_grows("settings inspector", settings);

    let mut picker = ReplApp::default();
    picker.open_picker_overlay(
        "Pick model",
        vec!["alpha".to_string(), "beta".to_string()],
        PickerAction::SwitchModel,
    );
    assert_height_grows("picker overlay", picker);

    let (permission_tx, _permission_rx) = tokio::sync::oneshot::channel();
    let mut permission = ReplApp::default();
    permission.enqueue_permission_dialog(permission_dialog("bash", permission_tx));
    assert_height_grows("permission dialog", permission);

    let (question_tx, _question_rx) = tokio::sync::oneshot::channel();
    let question = ReplApp {
        pending_question: Some(question_dialog(question_tx)),
        active_overlay: Some(OverlayKind::Question),
        ..ReplApp::default()
    };
    assert_height_grows("question dialog", question);
}

#[test]
fn inline_exit_flushes_remaining_viewport_to_terminal_scrollback() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 12),
        Position { x: 0, y: 5 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 5, 80, 7));
    let mut app = ReplApp::default();
    app.push_message(MessageRole::Assistant, "previous answer");

    cleanup_inline_viewport_for_exit(&mut terminal, &mut app).unwrap();

    let output = terminal.backend().output();
    assert!(
        output.contains("previous answer"),
        "exit cleanup should print remaining live transcript to stdout, got {output:?}"
    );
    assert_eq!(app.scrollback_committed_until, app.messages.len());
    let move_to_viewport_top = "\x1b[6;1H";
    let move_pos = output
        .find(move_to_viewport_top)
        .expect("exit cleanup should start writing at the viewport top");
    let text_pos = output
        .find("previous answer")
        .expect("transcript text should be present");
    assert!(
        move_pos < text_pos,
        "cursor may move to viewport top before writing, but not after the transcript text"
    );
    assert!(
        output[text_pos..].find(move_to_viewport_top).is_none(),
        "exit cleanup must not leave the final cursor at the inline viewport top"
    );
}

#[test]
fn inline_exit_flushes_welcome_when_no_turn_history_exists() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 12),
        Position { x: 0, y: 5 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 5, 80, 7));
    let mut app = ReplApp::default();
    app.render_welcome_component();

    cleanup_inline_viewport_for_exit(&mut terminal, &mut app).unwrap();

    let output = terminal.backend().output();
    assert!(
        output.contains("Welcome to KCoder!"),
        "exit cleanup should commit the live welcome surface, got {output:?}"
    );
    assert!(app.welcome_scrollback_committed);
}

#[test]
fn draw_kcoder_frame_starts_below_existing_terminal_rows() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(100, 24),
        Position { x: 0, y: 2 },
    )
    .expect("terminal");
    let mut app = ReplApp::default();
    app.render_welcome_component();

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    assert!(
        terminal.viewport_area.y >= 2,
        "first inline draw must not overwrite shell rows above the launch cursor"
    );
    assert!(
        terminal.viewport_area.bottom() <= 24,
        "first inline draw should keep the live viewport within the visible terminal"
    );
    assert!(
        terminal
            .backend()
            .output()
            .contains("Welcome to KCoder!")
    );
    assert!(
        terminal
            .backend()
            .scroll_region_up_calls
            .iter()
            .all(|(range, _)| range.start >= 2),
        "first inline draw may reserve slack by scrolling KCoder history, but not shell rows: {:?}",
        terminal.backend().scroll_region_up_calls
    );
}

#[test]
fn inline_viewport_resize_keeps_bottom_aligned_when_terminal_shrinks() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 36),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 1, 80, 35));
    terminal.backend_mut().size = Size::new(80, 28);

    update_inline_viewport(&mut terminal, 27).unwrap();

    assert_eq!(terminal.viewport_area, Rect::new(0, 1, 80, 27));
    assert!(
        terminal.backend().scroll_region_up_calls.is_empty(),
        "shrinking an already bottom-aligned viewport should not purge or replay history"
    );
}

#[test]
fn terminal_resize_resets_live_surface_without_erasing_visible_scrollback() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 36),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 1, 80, 35));
    let mut app = ReplApp::default();
    app.observe_terminal_size(Size::new(80, 36));

    terminal.backend_mut().size = Size::new(80, 28);
    app.observe_terminal_resize(Size::new(80, 28));
    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    assert!(
        terminal
            .backend()
            .clear_region_positions
            .iter()
            .all(|position| position.y >= terminal.viewport_area.top()),
        "resize repaint should preserve visible scrollback above the live viewport; clear positions were {:?}, viewport={:?}",
        terminal.backend().clear_region_positions,
        terminal.viewport_area
    );
    assert!(
        terminal
            .backend()
            .clear_region_positions
            .contains(&Position::new(0, terminal.viewport_area.top())),
        "resize repaint should physically reset the live viewport surface; clear positions were {:?}, viewport={:?}",
        terminal.backend().clear_region_positions,
        terminal.viewport_area
    );
    assert!(
        terminal.backend().scroll_region_up_calls.is_empty(),
        "resize repaint should not replay/purge terminal scrollback"
    );
    assert!(
        terminal.viewport_area.bottom() < terminal.backend().size.height,
        "compact resize redraw should keep bounded bottom slack, not a mostly blank screen; viewport={:?}, size={:?}",
        terminal.viewport_area,
        terminal.backend().size
    );
    assert!(
        terminal.backend().size.height - terminal.viewport_area.bottom() <= 6,
        "resize redraw should consume excessive blank space below composer/footer: viewport={:?}, size={:?}",
        terminal.viewport_area,
        terminal.backend().size
    );
}

#[test]
fn terminal_growth_clears_abandoned_old_live_surface() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 23 },
    )
    .expect("terminal");
    let old_viewport = Rect::new(0, 19, 80, 5);
    terminal.set_viewport_area(old_viewport);

    terminal.backend_mut().size = Size::new(80, 40);
    update_inline_viewport_for_draw(
        &mut terminal,
        InlineViewportHeights {
            base: 5,
            expanded: 5,
            reserved_bottom_slack: 0,
            max_top: None,
        },
    )
    .unwrap();

    assert!(
        terminal.viewport_area.y > old_viewport.y,
        "growing the terminal should move the bottom-aligned live viewport down"
    );
    assert!(
        terminal
            .backend()
            .clear_region_positions
            .contains(&Position::new(0, old_viewport.top())),
        "resize must clear the abandoned old composer surface; clear positions were {:?}, old={:?}, new={:?}",
        terminal.backend().clear_region_positions,
        old_viewport,
        terminal.viewport_area
    );
}

#[test]
fn idle_redraw_consumes_excess_bottom_slack() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(100, 40),
        Position { x: 0, y: 8 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 8, 100, 20));
    let mut app = ReplApp {
        welcome_scrollback_committed: true,
        ..ReplApp::default()
    };

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    assert!(
        terminal.viewport_area.bottom() < terminal.size().unwrap().height,
        "composer/footer should not be forced to the terminal bottom; viewport={:?}",
        terminal.viewport_area
    );
    assert!(
        terminal.size().unwrap().height - terminal.viewport_area.bottom() <= 8,
        "idle redraw should keep only bounded bottom slack below composer/footer: {:?}",
        terminal.viewport_area
    );
    assert!(
        terminal.backend().scroll_region_up_calls.is_empty(),
        "idle shrink must not rewrite terminal scrollback"
    );
}

#[test]
fn compact_long_transcript_frame_keeps_composer_visible() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(100, 28),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 1, 100, 27));
    let long_response = (0..80)
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
                text: long_response,
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

    terminal.draw(|frame| app.draw(frame)).unwrap();

    let buffer = terminal.rendered_buffer_for_tests();
    let dump = buffer_dump(buffer);
    buffer_find_row_containing(buffer, "Ask KCoder")
        .unwrap_or_else(|| panic!("composer should stay visible in compact frame\n{dump}"));
    buffer_find_row_containing(buffer, "? for shortcuts")
        .unwrap_or_else(|| panic!("footer should stay visible in compact frame\n{dump}"));
}

#[test]
fn forced_redraw_physically_clears_viewport() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 17 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 17, 80, 7));
    let mut app = ReplApp::default();
    app.force_next_viewport_redraw();

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    // A forced redraw (e.g. after turn-end consolidation) must physically
    // clear the viewport region so wide-char (CJK) tail columns left by the
    // previous frame's wider glyphs are erased, not just diff-overwritten.
    // A pure buffer reset leaves those orphaned cells on screen as duplicate
    // text until the user scrolls.
    assert!(
        terminal.backend().clear_region_count >= 1,
        "forced redraw should physically clear the viewport: count={}",
        terminal.backend().clear_region_count
    );
}

#[test]
fn fullscreen_frame_keeps_welcome_inside_tui_without_scrollback_commit() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    let mut app = ReplApp::default();
    app.render_welcome_component();

    draw_kcoder_frame_with_mode(&mut terminal, &mut app, TerminalSurfaceMode::Fullscreen).unwrap();

    assert_eq!(terminal.viewport_area, Rect::new(0, 0, 80, 24));
    assert_eq!(app.scrollback_committed_until, 0);
    assert!(!app.welcome_scrollback_committed);
    assert_eq!(terminal.visible_history_rows(), 0);
    assert!(
        terminal.backend().scroll_region_up_calls.is_empty(),
        "fullscreen mode must not scroll host terminal history: {:?}",
        terminal.backend().scroll_region_up_calls
    );
    let buffer = terminal.rendered_buffer_for_tests();
    let dump = buffer_dump(buffer);
    buffer_find_row_containing(buffer, "Welcome to KCoder!")
        .unwrap_or_else(|| panic!("welcome should be rendered in TUI buffer\n{dump}"));
    buffer_find_row_containing(buffer, "Ask KCoder")
        .unwrap_or_else(|| panic!("composer should be rendered in TUI buffer\n{dump}"));
}

#[test]
fn fullscreen_forced_redraw_repaints_without_physical_clear_flash() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    terminal.set_viewport_area(Rect::new(0, 0, 80, 24));
    let mut app = ReplApp {
        messages: vec![DisplayMessage {
            role: MessageRole::Assistant,
            text: "final transcript line".to_string(),
        }]
        .into(),
        ..ReplApp::default()
    };
    app.force_next_viewport_redraw();

    draw_kcoder_frame_with_mode(&mut terminal, &mut app, TerminalSurfaceMode::Fullscreen).unwrap();

    assert_eq!(
        terminal.backend().clear_region_count,
        0,
        "fullscreen forced redraw should avoid standalone clear-screen frames"
    );
    let buffer = terminal.rendered_buffer_for_tests();
    let dump = buffer_dump(buffer);
    buffer_find_row_containing(buffer, "final transcript line")
        .unwrap_or_else(|| panic!("fullscreen forced redraw should still repaint content\n{dump}"));
}

#[test]
fn fullscreen_overflowing_transcript_renders_scrollbar() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    let long_response = (0..180)
        .map(|idx| format!("scrollbar transcript line {idx:03}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut app = ReplApp {
        messages: vec![DisplayMessage {
            role: MessageRole::Assistant,
            text: long_response,
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

    draw_kcoder_frame_with_mode(&mut terminal, &mut app, TerminalSurfaceMode::Fullscreen).unwrap();

    let buffer = terminal.rendered_buffer_for_tests();
    let dump = buffer_dump(buffer);
    let scrollbar_area = app
        .transcript_viewport
        .scrollbar_area()
        .expect("overflowing transcript should expose a scrollbar hit area");
    let bottom_thumb = buffer
        .cell((scrollbar_area.x, scrollbar_area.bottom().saturating_sub(1)))
        .expect("scrollbar bottom cell should be inside the buffer");
    let top_track = buffer
        .cell((scrollbar_area.x, scrollbar_area.y))
        .expect("scrollbar top cell should be inside the buffer");
    assert_eq!(
        top_track.symbol(),
        transcript_scrollbar_vertical_symbol(TranscriptScrollbarCellFill::Empty)
    );
    assert_eq!(top_track.fg, KCODER_UI_THEME.text_dim);
    assert!(!top_track.modifier.contains(Modifier::BOLD));
    assert_eq!(
        bottom_thumb.symbol(),
        transcript_scrollbar_vertical_symbol(TranscriptScrollbarCellFill::Full),
        "tail-following transcript should put the scrollbar thumb at the bottom\n{dump}"
    );
    assert_eq!(bottom_thumb.fg, KCODER_UI_THEME.text_muted);
    assert!(bottom_thumb.modifier.is_empty());
    assert!(!bottom_thumb.modifier.contains(Modifier::REVERSED));
}

#[test]
fn default_repl_starts_with_empty_transcript() {
    let app = ReplApp::default();
    assert!(app.messages.is_empty());
}

#[test]
fn startup_messages_begin_with_non_fixed_welcome() {
    let mut app = ReplApp::default();

    seed_startup_messages(&mut app, Some("Previous session available.".to_string()));

    assert!(app.welcome_component_mounted);
    let messages = messages_as_pairs(&app);
    assert_eq!(messages.len(), 1);
    assert_eq!(
        messages[0],
        (
            MessageRole::System,
            "Previous session available.".to_string()
        )
    );
}

#[test]
fn startup_welcome_commits_to_terminal_scrollback_above_composer() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(100, 32),
        Position { x: 0, y: 8 },
    )
    .expect("terminal");
    let mut app = ReplApp {
        display_cwd: "/tmp/kcoder-project".to_string(),
        session_id: "session_test".to_string(),
        model_name: "MiniMax-M3".to_string(),
        ..ReplApp::default()
    };
    app.render_welcome_component();

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();
    let buffer = terminal.rendered_buffer_for_tests();
    let dump = buffer_dump(buffer);
    let output = terminal.backend().output();
    assert!(
        output.contains("╭"),
        "welcome top border should be written to stdout"
    );
    assert!(
        output.contains("╰"),
        "welcome bottom border should be written to stdout"
    );
    assert!(output.contains("Welcome to KCoder!"));
    assert!(output.contains("/tmp/kcoder-project"));
    assert!(
        buffer_find_row_containing(buffer, "Welcome to KCoder!").is_none(),
        "welcome should be committed to terminal scrollback, not repainted in live viewport\n{dump}"
    );

    let composer = buffer_find_row_containing(buffer, "Ask KCoder to do anything")
        .unwrap_or_else(|| panic!("composer should remain in live viewport\n{dump}"));
    let _ = composer;
}

#[test]
fn startup_welcome_full_width_rows_advance_with_explicit_positions() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(100, 18),
        Position { x: 0, y: 0 },
    )
    .expect("terminal");
    let mut app = ReplApp::default();
    app.render_welcome_component();

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    let output = terminal.backend().output();
    let top_border = output
        .find("╭")
        .unwrap_or_else(|| panic!("startup welcome top border missing: {output:?}"));
    let title = output
        .find("Welcome to KCoder!")
        .unwrap_or_else(|| panic!("startup welcome title missing: {output:?}"));
    assert!(
        !output[top_border..title].contains("\r\n"),
        "full-width startup welcome rows must use explicit cursor positioning, not CRLF, so autowrap cannot leave shell rows inside the card: {output:?}"
    );
}

#[test]
fn startup_welcome_near_bottom_appends_before_live_composer() {
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80, 24),
        Position { x: 0, y: 18 },
    )
    .expect("terminal");
    let mut app = ReplApp::default();
    app.render_welcome_component();

    draw_kcoder_frame(&mut terminal, &mut app).unwrap();

    let buffer = terminal.rendered_buffer_for_tests();
    let dump = buffer_dump(buffer);
    let output = terminal.backend().output();
    assert!(
        output.contains("Welcome to KCoder!"),
        "startup welcome should be appended to stdout before live composer draw"
    );
    assert!(
        buffer_find_row_containing(buffer, "Welcome to KCoder!").is_none(),
        "startup welcome must not be redrawn as part of the live viewport\n{dump}"
    );
    buffer_find_row_containing(buffer, "Ask KCoder").unwrap_or_else(|| {
        panic!("composer should remain visible after near-bottom startup\n{dump}")
    });
    assert!(
        terminal.viewport_area.height >= 3,
        "composer/footer live viewport should not collapse to one row: {:?}",
        terminal.viewport_area
    );
    assert!(
        !terminal.backend().scroll_region_up_calls.is_empty(),
        "near-bottom startup should scroll completed welcome/history into terminal scrollback before drawing live composer"
    );
}

#[test]
fn render_welcome_component_is_idempotent() {
    let mut app = ReplApp::default();

    app.render_welcome_component();
    app.render_welcome_component();

    assert!(app.welcome_component_mounted);
    assert!(messages_as_pairs(&app).is_empty());
}

#[test]
fn debug_startup_a_lines_message_formats_repeated_lines() {
    assert_eq!(
        debug_startup_a_lines_message("3").as_deref(),
        Some("a\na\na")
    );
    assert!(debug_startup_a_lines_message("0").is_none());
    assert!(debug_startup_a_lines_message("nope").is_none());
}

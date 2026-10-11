#[test]
fn submitting_input_forces_next_viewport_redraw() {
    let mut app = ReplApp {
        input: "项目优先 + 全局回退".to_string(),
        cursor_grapheme_index: "项目优先 + 全局回退".graphemes(true).count(),
        last_input_width: 80,
        ..ReplApp::default()
    };

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert!(
        matches!(action, Some(UserAction::Submit(submitted)) if submitted.text == "项目优先 + 全局回退")
    );
    assert!(app.input.is_empty());
    assert!(app.messages.is_empty());
    assert!(app.take_force_viewport_redraw());
    assert!(!app.take_force_viewport_redraw());
}

#[test]
fn alt_t_toggles_tool_expansion_without_opening_overlay() {
    let mut app = ReplApp::default();

    assert!(!app.tool_transcript_expanded);
    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Char('t'), KeyModifiers::ALT))
            .is_none()
    );
    assert!(app.active_overlay_kinds().is_empty());
    assert!(app.transcript_overlay.is_none());
    assert!(app.tool_transcript_expanded);
    assert!(app.active_tools_expanded);
    assert!(app.last_tool_output_expanded);
    assert!(app.take_force_viewport_redraw());

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Char('t'), KeyModifiers::ALT))
            .is_none()
    );
    assert!(app.active_overlay_kinds().is_empty());
    assert!(app.transcript_overlay.is_none());
    assert!(!app.tool_transcript_expanded);
    assert!(!app.active_tools_expanded);
    assert!(!app.last_tool_output_expanded);
    assert!(app.take_force_viewport_redraw());

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL))
            .is_none()
    );
    assert_eq!(app.active_overlay_kinds(), vec![OverlayKind::Transcript]);
    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL))
            .is_none()
    );
    assert!(app.transcript_overlay.is_none());
}

#[test]
fn alt_t_expands_collapsed_tool_summary_and_keeps_composer_visible() {
    let mut app = ReplApp {
        input: "draft message".to_string(),
        cursor_grapheme_index: "draft message".graphemes(true).count(),
        last_input_width: 80,
        messages: vec![
            make_msg(MessageRole::System, "[Tool use: read] {\"file\":\"a.rs\"}"),
            make_msg(
                MessageRole::System,
                "✓ Tool succeeded: read - ok\nread output one",
            ),
            make_msg(
                MessageRole::System,
                "[Tool use: TodoWrite] {\"TodoList\":[]}",
            ),
            make_msg(
                MessageRole::System,
                "✓ Tool succeeded: TodoWrite - ok\ntodo output two",
            ),
            make_msg(
                MessageRole::System,
                "[Tool use: bash] {\"command\":\"echo three\"}",
            ),
            make_msg(
                MessageRole::System,
                "✓ Tool succeeded: bash - ok\nbash output three",
            ),
        ]
        .into_iter()
        .collect(),
        ..ReplApp::default()
    };

    let collapsed = lines_to_plain_text(&app.render_fullscreen_transcript_lines(96, 40));
    assert!(
        collapsed.contains("read x1 · TodoWrite x1 · bash x1"),
        "collapsed transcript:\n{collapsed}"
    );
    assert!(collapsed.contains("alt + t to expand tools"));
    assert!(!collapsed.contains("read output one"));
    assert!(!collapsed.contains("todo output two"));
    assert!(!collapsed.contains("bash output three"));

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Char('t'), KeyModifiers::ALT))
            .is_none()
    );

    assert!(app.transcript_overlay.is_none());
    assert!(app.active_overlay_kinds().is_empty());
    assert_eq!(app.input, "draft message");
    assert_eq!(
        app.cursor_grapheme_index,
        "draft message".graphemes(true).count()
    );

    let expanded = lines_to_plain_text(&app.render_fullscreen_transcript_lines(96, 40));
    assert!(!expanded.contains("[Tool summary]"));
    assert!(expanded.contains("read output one"));
    assert!(expanded.contains("todo output two"));
    assert!(expanded.contains("bash output three"));
}

#[test]
fn transcript_overlay_keys_scroll_and_close() {
    let mut app = ReplApp::default();
    app.open_transcript_overlay();
    let overlay = app.transcript_overlay.as_mut().unwrap();
    overlay.last_line_count = 100;
    overlay.last_height = 10;

    app.handle_key(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE));
    assert_eq!(app.transcript_overlay.as_ref().unwrap().scroll_top, 80);

    app.handle_key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
    assert_eq!(app.transcript_overlay.as_ref().unwrap().scroll_top, 0);

    app.handle_key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
    assert_eq!(
        app.transcript_overlay.as_ref().unwrap().scroll_top,
        usize::MAX
    );

    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(app.transcript_overlay.is_none());
    assert!(app.active_overlay_kinds().is_empty());
}

#[cfg(windows)]
#[test]
fn altgr_q_does_not_close_transcript_overlay() {
    let mut app = ReplApp::default();
    app.open_transcript_overlay();

    app.handle_key(KeyEvent::new(
        KeyCode::Char('q'),
        KeyModifiers::CONTROL | KeyModifiers::ALT,
    ));

    assert!(app.transcript_overlay.is_some());
    assert_eq!(app.active_overlay, Some(OverlayKind::Transcript));
}

#[test]
fn up_and_down_scroll_transcript_when_composer_cannot_move_vertically() {
    let mut app = ReplApp {
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            30,
            10,
            None,
        ),
        last_input_width: 80,
        ..ReplApp::default()
    };

    assert!(app.transcript_viewport.position().is_at_tail());

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(
        app.transcript_viewport.position(),
        TranscriptScroll::from_tail(3)
    );
    assert_eq!(app.transcript_viewport.resolve_top(30, 10), 17);

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE))
            .is_none()
    );
    assert!(app.transcript_viewport.position().is_at_tail());
}

#[test]
fn end_snaps_transcript_to_tail_when_composer_is_empty() {
    let mut app = ReplApp {
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(12),
            60,
            10,
            None,
        ),
        last_input_width: 80,
        ..ReplApp::default()
    };

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE))
            .is_none()
    );

    assert!(app.transcript_viewport.position().is_at_tail());
    assert!(app.take_force_viewport_redraw());
}

#[test]
fn end_preserves_composer_cursor_behavior_when_draft_exists() {
    let mut app = ReplApp {
        input: "abc".to_string(),
        cursor_grapheme_index: 0,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(12),
            60,
            10,
            None,
        ),
        last_input_width: 80,
        ..ReplApp::default()
    };

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE))
            .is_none()
    );

    assert_eq!(app.cursor_grapheme_index, 3);
    assert_eq!(
        app.transcript_viewport.position(),
        TranscriptScroll::at_line(12)
    );
}

#[test]
fn page_down_returns_to_tail_after_one_page_up() {
    let mut app = ReplApp {
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            60,
            10,
            None,
        ),
        last_input_width: 80,
        ..ReplApp::default()
    };

    assert!(app.transcript_viewport.position().is_at_tail());

    app.handle_key(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE));
    assert_eq!(
        app.transcript_viewport.position(),
        TranscriptScroll::from_tail(10)
    );
    assert_eq!(app.transcript_viewport.resolve_top(60, 10), 40);

    app.handle_key(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE));
    assert!(app.transcript_viewport.position().is_at_tail());
}

fn reviewing_app() -> ReplApp {
    ReplApp {
        fullscreen_surface: true,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(10),
            100,
            20,
            None,
        ),
        input: "unfinished draft".into(),
        cursor_grapheme_index: 5,
        ..ReplApp::default()
    }
}

#[test]
fn back_to_bottom_click_requires_painted_button_and_resumes_follow() {
    let mut app = reviewing_app();
    let button = Rect::new(30, 20, 24, 1);
    assert!(!app.click_scroll_to_bottom(31, 20));
    app.last_scroll_to_bottom_area = Some(button);
    assert!(!app.click_scroll_to_bottom(29, 20));
    assert!(!app.click_scroll_to_bottom(31, 21));
    assert!(app.click_scroll_to_bottom(31, 20));
    assert!(app.transcript_viewport.is_at_tail());
    assert_eq!(app.transcript_viewport.resolve_top(200, 20), 180);
    assert_eq!(app.input, "unfinished draft");
    assert_eq!(app.cursor_grapheme_index, 5);
    assert!(app.navigation.anchor.is_none());
    assert!(app.last_scroll_to_bottom_area.is_none());
    app.last_scroll_to_bottom_area = Some(button);
    assert!(!app.click_scroll_to_bottom(31, 20));
}

#[test]
fn back_to_bottom_escape_preserves_active_turn_until_second_escape() {
    let mut app = reviewing_app();
    app.set_loading(true);
    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
            .is_none()
    );
    assert!(app.transcript_viewport.is_at_tail());
    assert!(app.has_interruptible_turn());
    assert_eq!(app.input, "unfinished draft");
    assert!(
        !app.messages
            .iter()
            .any(|message| message.text == "Cancelled.")
    );
    assert!(matches!(
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
        Some(UserAction::Interrupt)
    ));
    assert!(!app.has_interruptible_turn());
}

#[test]
fn back_to_bottom_shortcuts_overlay_keeps_escape_priority() {
    let mut app = reviewing_app();
    app.footer_shortcuts_overlay = true;
    assert!(!app.can_return_to_bottom());
    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
            .is_none()
    );
    assert!(!app.footer_shortcuts_overlay);
    assert!(!app.transcript_viewport.is_at_tail());
    assert!(app.can_return_to_bottom());
    app.active_overlay = Some(OverlayKind::Question);
    app.last_scroll_to_bottom_area = Some(Rect::new(30, 20, 24, 1));
    assert!(!app.click_scroll_to_bottom(31, 20));
}

#[test]
fn back_to_bottom_inline_history_can_return_without_dismissing_other_overlays() {
    let mut app = reviewing_app();
    app.fullscreen_surface = false;
    app.navigation.inline = true;
    app.active_overlay = Some(OverlayKind::Transcript);
    assert!(app.can_return_to_bottom());
    app.last_scroll_to_bottom_area = Some(Rect::new(30, 20, 24, 1));
    assert!(app.click_scroll_to_bottom(31, 20));
    assert!(app.transcript_viewport.is_at_tail());
    app = reviewing_app();
    app.active_overlay = Some(OverlayKind::Picker);
    assert!(!app.can_return_to_bottom());
}

#[test]
fn back_to_bottom_draw_fits_narrow_rows_and_disappears_at_tail() {
    for width in [10, 20, 80] {
        let mut terminal = Terminal::with_options_and_cursor_position(
            CaptureBackend::new(width, 3),
            Position { x: 0, y: 0 },
        )
        .unwrap();
        terminal.set_viewport_area(Rect::new(0, 0, width, 3));
        let mut app = reviewing_app();
        let mut rendered = String::new();
        terminal
            .draw(|frame| {
                app.draw_scroll_to_bottom(frame, Rect::new(0, 1, width, 1));
                let buffer = frame.buffer_mut();
                rendered = (0..width).map(|x| buffer[(x, 1)].symbol()).collect();
            })
            .unwrap();
        let button = app
            .last_scroll_to_bottom_area
            .expect("visible navigation button");
        assert!(button.width <= width);
        assert_eq!(button.y, 1);
        assert!(
            rendered.contains("Bottom") || rendered.contains("Back to bottom"),
            "{rendered}"
        );
        app.jump_transcript("latest");
        terminal
            .draw(|frame| app.draw_scroll_to_bottom(frame, Rect::new(0, 1, width, 1)))
            .unwrap();
        assert!(app.last_scroll_to_bottom_area.is_none());
    }
}

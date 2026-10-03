#[test]
fn inline_navigation_keeps_one_viewport_across_frames_and_directory_roundtrip() {
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "old task");
    app.push_message(MessageRole::Assistant, "history paragraph\n\n".repeat(9000));
    app.push_message(MessageRole::User, "current task");
    app.push_message(MessageRole::Assistant, "INLINE_NAVIGATION_STABLE_TARGET");
    let mut terminal = Terminal::with_options_and_cursor_position(
        CaptureBackend::new(80,24), Position::new(0,0)
    ).unwrap();
    terminal.set_viewport_area(Rect::new(0,0,80,24));
    app.jump_transcript("start");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        terminal.draw(|frame|app.draw(frame)).unwrap();
        if !app.navigation.pending() { break; }
        assert!(Instant::now()<deadline,"inline定位超时");
        std::thread::sleep(Duration::from_millis(10));
    }
    for _ in 0..12 {
        terminal.draw(|frame|app.draw(frame)).unwrap();
        let screen = buffer_dump(terminal.rendered_buffer_for_tests());
        assert!(screen.contains("INLINE_NAVIGATION_STABLE_TARGET"),"{screen}");
        assert!(!app.navigation.pending());
    }
    assert!(prepare_committed_history_for_scrollback(&mut app,80,Rect::new(0,0,80,24),24).is_none());
    app.handle_key(KeyEvent::new(KeyCode::F(8),KeyModifiers::NONE));
    terminal.draw(|frame|app.draw(frame)).unwrap();
    assert!(app.outline_open);
    app.handle_key(KeyEvent::new(KeyCode::Esc,KeyModifiers::NONE));
    terminal.draw(|frame|app.draw(frame)).unwrap();
    assert!(buffer_dump(terminal.rendered_buffer_for_tests()).contains("INLINE_NAVIGATION_STABLE_TARGET"));
    app.jump_transcript("latest");
    assert!(app.transcript_overlay.is_none());
    assert!(app.transcript_viewport.is_at_tail());
}

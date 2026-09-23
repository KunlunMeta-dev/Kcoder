#[test]
fn up_and_down_cycle_input_history_when_composer_is_single_line() {
    let mut app = ReplApp {
        input_history: vec!["first prompt".to_string(), "second prompt".to_string()],
        input: "draft".to_string(),
        cursor_grapheme_index: 5,
        last_input_width: 80,
        ..ReplApp::default()
    };

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(app.input, "second prompt");
    assert_eq!(app.input_history_index, Some(1));

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(app.input, "first prompt");
    assert_eq!(app.input_history_index, Some(0));

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(app.input, "second prompt");
    assert_eq!(app.input_history_index, Some(1));

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(app.input, "draft");
    assert_eq!(app.input_history_index, None);
}

#[test]
fn history_navigation_restores_the_complete_composer_draft() {
    let placeholder = "[Pasted Content 1200 chars]".to_string();
    let local = LocalImageAttachment {
        path: PathBuf::from("/tmp/draft.png"),
        placeholder: "[Image #2]".to_string(),
        media_type: "image/png".to_string(),
        clipboard_image: None,
    };
    let mut app = ReplApp {
        input_history: vec!["older prompt".to_string()],
        input: format!("draft {placeholder} {}", local.placeholder),
        cursor_grapheme_index: 3,
        pending_pastes: vec![(placeholder.clone(), "large payload".to_string())],
        local_image_attachments: vec![local.clone()],
        remote_image_urls: vec!["https://example.com/remote.png".to_string()],
        last_input_width: 80,
        ..ReplApp::default()
    };
    let original = app.composer_draft_snapshot();

    app.recall_previous_input();
    assert_eq!(app.input, "older prompt");
    assert!(app.pending_pastes.is_empty());
    assert!(app.local_image_attachments.is_empty());
    assert!(app.remote_image_urls.is_empty());

    app.recall_next_input();
    assert_eq!(app.composer_draft_snapshot(), original);
}

#[test]
fn cursor_visual_position_uses_the_later_row_at_wrap_and_newline_boundaries() {
    assert_eq!(cursor_visual_position_for_text("abcdef", 3, 3), (1, 0));
    assert_eq!(cursor_visual_position_for_text("ab\n", 3, 80), (1, 0));
}

#[test]
fn remote_image_only_draft_can_be_submitted() {
    let mut app = ReplApp {
        remote_image_urls: vec!["https://example.com/remote.png".to_string()],
        ..ReplApp::default()
    };

    let Some(UserAction::Submit(submitted)) = app.submit_composer_input() else {
        panic!("remote image-only draft should submit");
    };
    assert!(submitted.text.is_empty());
    assert_eq!(submitted.remote_image_urls.len(), 1);
}

#[test]
fn input_history_status_label_reports_current_position() {
    let mut app = ReplApp {
        input_history: vec!["first prompt".to_string(), "second prompt".to_string()],
        input: "draft".to_string(),
        cursor_grapheme_index: 5,
        last_input_width: 80,
        ..ReplApp::default()
    };

    assert_eq!(app.input_history_status_label(), "");

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(app.input_history_status_label(), "history 2/2");

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(app.input_history_status_label(), "history 1/2");

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(app.input_history_status_label(), "history 2/2");

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(app.input_history_status_label(), "");
}

#[test]
fn up_moves_cursor_in_multiline_input_before_history_recall() {
    let mut app = ReplApp {
        input_history: vec!["old prompt".to_string()],
        input: "line one\nline two".to_string(),
        cursor_grapheme_index: "line one\nline two".graphemes(true).count(),
        last_input_width: 80,
        ..ReplApp::default()
    };

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(app.input, "line one\nline two");
    assert_eq!(app.input_history_index, None);
    assert!(
        app.cursor_grapheme_index < "line one\nline two".graphemes(true).count(),
        "cursor should move to the previous visual row instead of recalling history"
    );
}

#[test]
fn history_navigation_stays_active_for_multiline_recalled_items() {
    let mut app = ReplApp {
        input_history: vec!["first\nmultiline".to_string(), "second".to_string()],
        input: String::new(),
        cursor_grapheme_index: 0,
        last_input_width: 80,
        ..ReplApp::default()
    };

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(app.input, "second");

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(app.input, "first\nmultiline");
    assert_eq!(app.input_history_index, Some(0));
}

#[test]
fn editing_recalled_history_exits_history_navigation() {
    let mut app = ReplApp {
        input_history: vec!["old prompt".to_string()],
        input: String::new(),
        cursor_grapheme_index: 0,
        last_input_width: 80,
        ..ReplApp::default()
    };

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(app.input_history_index, Some(0));

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Char('!'), KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(app.input, "old prompt!");
    assert_eq!(app.input_history_index, None);
    assert_eq!(app.input_history_draft, None);
}

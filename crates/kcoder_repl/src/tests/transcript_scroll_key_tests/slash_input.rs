#[test]
fn slash_menu_supports_page_and_boundary_navigation() {
    let mut app = ReplApp {
        input: "/".to_string(),
        cursor_grapheme_index: 1,
        ..ReplApp::default()
    };
    app.sync_slash_menu();
    let count = app.slash_menu_matches().len();
    assert!(count > 8);

    app.handle_key(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE));
    assert_eq!(app.slash_menu.as_ref().unwrap().selected, 8);

    app.handle_key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
    assert_eq!(app.slash_menu.as_ref().unwrap().selected, count - 1);

    app.handle_key(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE));
    assert_eq!(
        app.slash_menu.as_ref().unwrap().selected,
        count.saturating_sub(9)
    );

    app.handle_key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
    assert_eq!(app.slash_menu.as_ref().unwrap().selected, 0);
}

#[test]
fn slash_menu_supports_ctrl_p_and_ctrl_n_navigation() {
    let mut app = ReplApp {
        input: "/".to_string(),
        cursor_grapheme_index: 1,
        ..ReplApp::default()
    };
    app.sync_slash_menu();
    assert!(app.slash_menu_matches().len() > 1);

    app.handle_key(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::CONTROL));
    assert_eq!(app.slash_menu.as_ref().unwrap().selected, 1);

    app.handle_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL));
    assert_eq!(app.slash_menu.as_ref().unwrap().selected, 0);

    app.handle_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL));
    assert_eq!(app.slash_menu.as_ref().unwrap().selected, 0);
}

#[test]
fn bare_slash_enter_dispatches_selected_command() {
    let mut app = ReplApp::default();

    let open_action = app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    let selected = app
        .slash_menu_matches()
        .iter()
        .position(|cmd| cmd.name() == "/status")
        .unwrap();
    app.slash_menu.as_mut().unwrap().selected = selected;
    let submit_action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert!(open_action.is_none());
    assert!(
        matches!(submit_action, Some(UserAction::SlashCommand(command)) if command == "/status")
    );
    assert!(app.input.is_empty());
    assert!(app.slash_menu.is_none());
}

#[test]
fn bare_slash_default_enter_opens_help_instead_of_quitting() {
    let mut app = ReplApp::default();
    app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    assert!(
        matches!(app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        Some(UserAction::SlashCommand(command)) if command == "/help")
    );
}

#[test]
fn bare_slash_key_does_not_complete_quit() {
    let mut app = ReplApp::default();

    app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));
    let action = app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));

    assert!(action.is_none());
    assert_eq!(app.input, "/");
    assert!(app.slash_menu.is_some());
}

#[test]
fn slash_menu_closes_after_composer_text_stops_matching() {
    let mut app = ReplApp {
        input: "/model".to_string(),
        cursor_grapheme_index: 6,
        ..ReplApp::default()
    };
    app.sync_slash_menu();
    assert!(app.slash_menu.is_some());

    app.insert_text_at_cursor(" ");
    app.sync_composer_sidecars();

    assert!(app.slash_menu.is_none());
}

#[test]
fn esc_cancels_slash_menu_draft() {
    let mut app = ReplApp {
        input: "/comp".to_string(),
        cursor_grapheme_index: 5,
        ..ReplApp::default()
    };
    app.sync_slash_menu();
    assert!(app.slash_menu.is_some());

    let action = app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    assert!(action.is_none());
    assert!(app.input.is_empty());
    assert_eq!(app.cursor_grapheme_index, 0);
    assert!(app.slash_menu.is_none());
    assert!(!app.edit_previous_primed);
}

#[test]
fn enter_dispatches_selected_slash_menu_command() {
    let mut app = ReplApp {
        input: "/di".to_string(),
        cursor_grapheme_index: 3,
        ..ReplApp::default()
    };
    app.sync_slash_menu();
    assert!(app.slash_menu.is_some());
    let selected = app.slash_menu_matches()[0].name().to_string();

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert!(matches!(
        action,
        Some(UserAction::SlashCommand(command)) if command == selected
    ));
    assert!(app.input.is_empty());
    assert_eq!(app.cursor_grapheme_index, 0);
    assert!(app.slash_menu.is_none());
    assert_eq!(app.input_history.last(), Some(&selected));
}

#[test]
fn enter_submits_exact_slash_command_without_requiring_space() {
    let mut app = ReplApp {
        input: "/goal".to_string(),
        cursor_grapheme_index: 5,
        ..ReplApp::default()
    };
    app.sync_slash_menu();
    assert!(app.slash_menu.is_some());

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert!(matches!(
        action,
        Some(UserAction::SlashCommand(command)) if command == "/goal"
    ));
    assert!(app.input.is_empty());
    assert_eq!(app.cursor_grapheme_index, 0);
    assert!(app.slash_menu.is_none());
    assert_eq!(app.input_history.last(), Some(&"/goal".to_string()));
}

#[test]
fn tab_completes_skills_slash_menu_command_without_execution() {
    let mut app = ReplApp {
        input: "/skills".to_string(),
        cursor_grapheme_index: 7,
        ..ReplApp::default()
    };
    app.sync_slash_menu();
    assert_eq!(app.slash_menu_matches()[0].name(), "/skills");

    let action = app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));

    assert!(action.is_none());
    assert_eq!(app.input, "/skills ");
    assert!(app.slash_menu.is_none());
}

#[test]
fn bare_slash_tab_completes_selection_without_execution() {
    let mut app = ReplApp {
        input: "/".into(),
        cursor_grapheme_index: 1,
        ..ReplApp::default()
    };
    app.sync_slash_menu();
    let selected = app
        .slash_menu_matches()
        .iter()
        .position(|cmd| cmd.name() == "/model")
        .unwrap();
    app.slash_menu.as_mut().unwrap().selected = selected;
    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE))
            .is_none()
    );
    assert_eq!(app.input, "/model ");
}

#[test]
fn enter_prefills_commands_that_need_arguments_without_history_or_execution() {
    for input in [
        "/remem",
        "/remember",
        "/set",
        "/btw",
        "/allow",
        "/import",
        "/jump",
    ] {
        let mut app = ReplApp {
            input: input.into(),
            cursor_grapheme_index: input.len(),
            ..ReplApp::default()
        };
        app.sync_slash_menu();
        let name = app.slash_menu_matches()[0].name().to_string();
        assert!(
            app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
                .is_none(),
            "{input}"
        );
        assert_eq!(app.input, format!("{name} "));
        assert!(app.input_history.is_empty());
        assert!(app.messages.is_empty());
        assert_eq!(app.cursor_grapheme_index, app.input_graphemes().len());
    }
}

#[test]
fn explicit_scroll_to_bottom_reenables_follow_after_pinned_review() {
    let mut app = ReplApp::default();
    app.transcript_viewport.begin_frame(Rect::new(0, 0, 80, 20));
    app.transcript_viewport.begin_navigation(77);
    app.transcript_viewport.commit_render(100, 77);
    app.scroll_transcript_lines(3);
    assert!(app.transcript_viewport.is_at_tail());
    app.push_message(MessageRole::Assistant, "new output");
    assert_eq!(app.transcript_viewport.resolve_top(120, 20), 100);
}

#[test]
fn new_output_does_not_move_user_review_relative_to_growing_tail() {
    for streaming in [false, true] {
        let mut app = ReplApp::default();
        app.transcript_viewport.begin_frame(Rect::new(0, 0, 80, 20));
        app.transcript_viewport.commit_render(100, 80);
        app.transcript_viewport.queue_wheel(ScrollDirection::Up);
        if streaming {
            app.append_streaming_text("new stream output");
        } else {
            app.push_message(MessageRole::Assistant, "new output");
        }
        assert!(!app.transcript_viewport.is_at_tail());
        assert_eq!(app.transcript_viewport.resolve_top(120, 20), 77);
    }
}

#[test]
fn slash_key_completes_selected_slash_menu_command_as_text() {
    let mut app = ReplApp {
        input: "/mo".to_string(),
        cursor_grapheme_index: 3,
        ..ReplApp::default()
    };
    app.sync_slash_menu();
    assert!(app.slash_menu.is_some());
    let first_match = app.slash_menu_matches()[0].name().to_string();

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));

    assert!(action.is_none());
    assert_eq!(app.input, format!("{first_match} "));
    assert_eq!(app.cursor_grapheme_index, app.input_graphemes().len());
    assert!(app.slash_menu.is_none());
}

#[test]
fn slash_key_inside_slash_command_arguments_is_inserted() {
    let mut app = ReplApp {
        input: "/goal openai".to_string(),
        cursor_grapheme_index: 12,
        ..ReplApp::default()
    };
    app.open_slash_menu();
    assert!(app.slash_menu.is_some());

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));

    assert!(action.is_none());
    assert_eq!(app.input, "/goal openai/");
    assert_eq!(app.cursor_grapheme_index, app.input_graphemes().len());
    assert!(app.slash_menu.is_none());
}

#[test]
fn pasted_slash_command_arguments_preserve_slash_on_submit() {
    let mut app = ReplApp::default();

    app.handle_paste_text("/goal 调研openai/codex tui实现逻辑")
        .unwrap();
    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert!(matches!(
        action,
        Some(UserAction::SlashCommand(command))
            if command == "/goal 调研openai/codex tui实现逻辑"
    ));
}

#[test]
fn rapid_slash_command_characters_preserve_argument_slash() {
    let mut app = ReplApp::default();
    let command = "/goal 调研openai/codex tui实现逻辑";

    for ch in command.chars() {
        app.handle_key(KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE));
    }
    assert_eq!(app.input, command);
    assert!(app.slash_menu.is_none());
}

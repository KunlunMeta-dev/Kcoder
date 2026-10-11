#[test]
fn insert_text_at_cursor_handles_multiline_paste() {
    let mut app = ReplApp {
        input: "ab".to_string(),
        cursor_grapheme_index: 1,
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.insert_text_at_cursor("X\nY");

    assert_eq!(app.input, "aX\nYb");
    assert_eq!(app.cursor_grapheme_index, 4);
}

#[test]
fn codex_newline_shortcuts_insert_newline_without_submitting() {
    let mut app = ReplApp {
        input: "ab".to_string(),
        cursor_grapheme_index: 1,
        last_input_width: 80,
        ..ReplApp::default()
    };

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::ALT))
            .is_none()
    );
    assert_eq!(app.input, "a\nb");
    assert_eq!(app.cursor_grapheme_index, 2);

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::CONTROL))
            .is_none()
    );
    assert_eq!(app.input, "a\n\nb");
    assert_eq!(app.cursor_grapheme_index, 3);

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Char('m'), KeyModifiers::CONTROL))
            .is_none()
    );
    assert_eq!(app.input, "a\n\n\nb");
    assert_eq!(app.cursor_grapheme_index, 4);
}

#[test]
fn repeat_key_events_are_handled_but_release_events_are_ignored() {
    let mut app = ReplApp {
        input: "abc".to_string(),
        cursor_grapheme_index: 3,
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new_with_kind(
        KeyCode::Backspace,
        KeyModifiers::NONE,
        KeyEventKind::Repeat,
    ));
    assert_eq!(app.input, "ab");
    assert_eq!(app.cursor_grapheme_index, 2);

    app.handle_key(KeyEvent::new_with_kind(
        KeyCode::Backspace,
        KeyModifiers::NONE,
        KeyEventKind::Release,
    ));
    assert_eq!(app.input, "ab");
    assert_eq!(app.cursor_grapheme_index, 2);
}

#[test]
fn typed_character_is_visible_immediately() {
    let mut app = ReplApp::default();

    assert!(
        app.handle_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE))
            .is_none()
    );

    assert_eq!(app.input, "a");
}

#[test]
fn rapid_characters_are_visible_immediately() {
    let mut app = ReplApp::default();

    app.handle_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::NONE));

    assert_eq!(app.input, "ab");
}

#[test]
fn rapid_characters_then_enter_submits() {
    let mut app = ReplApp::default();

    app.handle_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::NONE));
    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert!(matches!(action, Some(UserAction::Submit(submitted)) if submitted.text == "ab"));
    assert_eq!(app.input, "");
}

#[test]
fn xterm_ime_commit_is_visible_immediately_and_enter_submits() {
    let mut app = ReplApp::default();
    let committed = "输入法快速提交的中文内容应该立即显示";

    for ch in committed.chars() {
        assert!(
            app.handle_key(KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE))
                .is_none()
        );
    }

    assert_eq!(app.input, committed);
    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert!(matches!(action, Some(UserAction::Submit(submitted)) if submitted.text == committed));
}

#[test]
fn slash_opens_menu_immediately() {
    let mut app = ReplApp::default();

    app.handle_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE));

    assert_eq!(app.input, "/");
    assert_eq!(app.cursor_grapheme_index, 1);
    assert!(app.slash_menu.is_some());
}

#[test]
fn question_mark_in_rapid_input_does_not_toggle_overlay() {
    let mut app = ReplApp::default();

    app.handle_key(KeyEvent::new(KeyCode::Char('h'), KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('i'), KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE));

    assert!(app.keys_overlay.is_none());
    assert!(!app.footer_shortcuts_overlay);
    assert_eq!(app.input, "hi?");
    assert!(app.keys_overlay.is_none());
    assert!(!app.footer_shortcuts_overlay);
}

#[test]
fn ctrl_a_and_ctrl_e_move_within_current_line() {
    let mut app = ReplApp {
        input: "ab\ncde".to_string(),
        cursor_grapheme_index: 6,
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL));
    assert_eq!(app.cursor_grapheme_index, 3);

    app.handle_key(KeyEvent::new(KeyCode::Char('e'), KeyModifiers::CONTROL));
    assert_eq!(app.cursor_grapheme_index, 6);
}

#[test]
fn ctrl_a_and_ctrl_e_cross_lines_at_boundaries() {
    let mut app = ReplApp {
        input: "one\ntwo\nthree".to_string(),
        cursor_grapheme_index: "one\nt".graphemes(true).count(),
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL));
    assert_eq!(app.cursor_grapheme_index, "one\n".graphemes(true).count());

    app.handle_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL));
    assert_eq!(app.cursor_grapheme_index, 0);

    app.handle_key(KeyEvent::new(KeyCode::Char('e'), KeyModifiers::CONTROL));
    assert_eq!(app.cursor_grapheme_index, "one".graphemes(true).count());

    app.handle_key(KeyEvent::new(KeyCode::Char('e'), KeyModifiers::CONTROL));
    assert_eq!(
        app.cursor_grapheme_index,
        "one\ntwo".graphemes(true).count()
    );
}

#[test]
fn home_and_end_stay_on_current_line_at_boundaries() {
    let mut app = ReplApp {
        input: "one\ntwo\nthree".to_string(),
        cursor_grapheme_index: "one\n".graphemes(true).count(),
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
    assert_eq!(app.cursor_grapheme_index, "one\n".graphemes(true).count());

    app.cursor_grapheme_index = "one".graphemes(true).count();
    app.handle_key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
    assert_eq!(app.cursor_grapheme_index, "one".graphemes(true).count());
}

#[test]
fn ctrl_b_and_ctrl_f_move_horizontally() {
    let mut app = ReplApp {
        input: "abc".to_string(),
        cursor_grapheme_index: 2,
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL));
    assert_eq!(app.cursor_grapheme_index, 1);

    app.handle_key(KeyEvent::new(KeyCode::Char('f'), KeyModifiers::CONTROL));
    assert_eq!(app.cursor_grapheme_index, 2);
}

#[test]
fn ctrl_p_and_ctrl_n_reuse_history_navigation() {
    let mut app = ReplApp {
        input: "draft".to_string(),
        cursor_grapheme_index: 5,
        input_history: vec!["first prompt".to_string(), "second prompt".to_string()],
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL));
    assert_eq!(app.input, "second prompt");
    assert_eq!(app.input_history_index, Some(1));

    app.handle_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL));
    assert_eq!(app.input, "first prompt");
    assert_eq!(app.input_history_index, Some(0));

    app.handle_key(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::CONTROL));
    assert_eq!(app.input, "second prompt");
    assert_eq!(app.input_history_index, Some(1));
}

#[test]
fn alt_word_movement_respects_path_separators() {
    let mut app = ReplApp {
        input: "path/to/file tail".to_string(),
        cursor_grapheme_index: "path/to/file tail".graphemes(true).count(),
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::ALT));
    assert_eq!(
        app.cursor_grapheme_index,
        "path/to/file ".graphemes(true).count()
    );

    app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::ALT));
    assert_eq!(
        app.cursor_grapheme_index,
        "path/to/".graphemes(true).count()
    );

    app.handle_key(KeyEvent::new(KeyCode::Char('f'), KeyModifiers::ALT));
    assert_eq!(
        app.cursor_grapheme_index,
        "path/to/file".graphemes(true).count()
    );
}

#[test]
fn modified_arrow_keys_move_by_word() {
    let mut app = ReplApp {
        input: "alpha beta gamma".to_string(),
        cursor_grapheme_index: "alpha beta gamma".graphemes(true).count(),
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::CONTROL));
    assert_eq!(
        app.cursor_grapheme_index,
        "alpha beta ".graphemes(true).count()
    );

    app.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::ALT));
    assert_eq!(
        app.cursor_grapheme_index,
        "alpha beta gamma".graphemes(true).count()
    );
}

#[test]
fn modified_delete_keys_delete_by_word() {
    let mut app = ReplApp {
        input: "path/to/file".to_string(),
        cursor_grapheme_index: "path/to/file".graphemes(true).count(),
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::CONTROL));
    assert_eq!(app.input, "path/to/");
    assert_eq!(
        app.cursor_grapheme_index,
        "path/to/".graphemes(true).count()
    );

    app.handle_key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::ALT));
    assert_eq!(app.input, "path/to");
    assert_eq!(app.cursor_grapheme_index, "path/to".graphemes(true).count());

    app.input = "path/to/file".to_string();
    app.cursor_grapheme_index = 0;
    app.handle_key(KeyEvent::new(KeyCode::Delete, KeyModifiers::CONTROL));
    assert_eq!(app.input, "/to/file");
    assert_eq!(app.cursor_grapheme_index, 0);

    app.handle_key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::ALT));
    assert_eq!(app.input, "to/file");
    assert_eq!(app.cursor_grapheme_index, 0);
}

#[test]
fn ctrl_w_deletes_previous_word() {
    let mut app = ReplApp {
        input: "foo bar baz".to_string(),
        cursor_grapheme_index: "foo bar baz".graphemes(true).count(),
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Char('w'), KeyModifiers::CONTROL));
    assert_eq!(app.input, "foo bar ");
    assert_eq!(
        app.cursor_grapheme_index,
        "foo bar ".graphemes(true).count()
    );
}

#[cfg(not(windows))]
#[test]
fn ctrl_alt_h_deletes_previous_word() {
    let mut app = ReplApp {
        input: "foo bar".to_string(),
        cursor_grapheme_index: "foo bar".graphemes(true).count(),
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(
        KeyCode::Char('h'),
        KeyModifiers::CONTROL | KeyModifiers::ALT,
    ));
    assert_eq!(app.input, "foo ");
    assert_eq!(app.cursor_grapheme_index, "foo ".graphemes(true).count());
}

#[cfg(windows)]
#[test]
fn altgr_ctrl_alt_h_inserts_literal_instead_of_deleting_previous_word() {
    let mut app = ReplApp {
        input: "foo bar".to_string(),
        cursor_grapheme_index: "foo bar".graphemes(true).count(),
        last_input_width: 80,
        ..ReplApp::default()
    };
    let altgr = KeyModifiers::CONTROL | KeyModifiers::ALT;

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('h'), altgr));

    assert!(action.is_none());
    assert_eq!(app.input, "foo barh");
    assert_eq!(
        app.cursor_grapheme_index,
        "foo barh".graphemes(true).count()
    );
}

#[test]
fn ctrl_y_restores_last_word_kill() {
    let mut app = ReplApp {
        input: "foo bar baz".to_string(),
        cursor_grapheme_index: "foo bar baz".graphemes(true).count(),
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Char('w'), KeyModifiers::CONTROL));
    assert_eq!(app.input, "foo bar ");
    assert_eq!(app.composer_kill_buffer.text, "baz");

    app.handle_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::CONTROL));
    assert_eq!(app.input, "foo bar baz");
    assert_eq!(
        app.cursor_grapheme_index,
        "foo bar baz".graphemes(true).count()
    );
}

#[test]
fn ctrl_u_and_ctrl_k_use_line_kill_semantics() {
    let mut app = ReplApp {
        input: "ab\ncde".to_string(),
        cursor_grapheme_index: 5,
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
    assert_eq!(app.input, "ab\ne");
    assert_eq!(app.cursor_grapheme_index, 3);
    assert_eq!(app.composer_kill_buffer.text, "cd");

    app.handle_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::CONTROL));
    assert_eq!(app.input, "ab\ncde");
    assert_eq!(app.cursor_grapheme_index, 5);

    app.input = "ab\ncde".to_string();
    app.cursor_grapheme_index = 2;
    app.handle_key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL));

    assert_eq!(app.input, "abcde");
    assert_eq!(app.cursor_grapheme_index, 2);
    assert_eq!(app.composer_kill_buffer.text, "\n");

    app.input = "ab\ncde".to_string();
    app.cursor_grapheme_index = 3;
    app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));

    assert_eq!(app.input, "abcde");
    assert_eq!(app.cursor_grapheme_index, 2);
    assert_eq!(app.composer_kill_buffer.text, "\n");
}

#[test]
fn ctrl_h_deletes_and_other_modified_chars_do_not_insert() {
    let mut app = ReplApp {
        input: "ab".to_string(),
        cursor_grapheme_index: 2,
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Char('h'), KeyModifiers::CONTROL));
    assert_eq!(app.input, "a");
    assert_eq!(app.cursor_grapheme_index, 1);

    app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL));
    app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::ALT));

    assert_eq!(app.input, "a");
    assert_eq!(app.cursor_grapheme_index, 1);
}

#[cfg_attr(not(windows), ignore = "AltGr modifier only applies on Windows")]
#[test]
fn altgr_ctrl_alt_char_inserts_literal_in_composer() {
    let mut app = ReplApp {
        input: "ab".to_string(),
        cursor_grapheme_index: 2,
        last_input_width: 80,
        ..ReplApp::default()
    };
    let altgr = KeyModifiers::CONTROL | KeyModifiers::ALT;

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('d'), altgr));

    assert!(action.is_none());
    assert_eq!(app.input, "abd");
    assert_eq!(app.cursor_grapheme_index, 3);
}

#[cfg_attr(not(windows), ignore = "AltGr modifier only applies on Windows")]
#[test]
fn altgr_ctrl_alt_char_inserts_literal_in_history_search() {
    let mut app = ReplApp::default();
    app.open_history_search();
    let altgr = KeyModifiers::CONTROL | KeyModifiers::ALT;

    app.handle_key(KeyEvent::new(KeyCode::Char('c'), altgr));

    let search = app
        .history_search
        .as_ref()
        .expect("history search stays open");
    assert_eq!(search.query, "c");
}

#[test]
fn ctrl_y_restores_killed_paste_sidecar() {
    let placeholder = "[Pasted Content 12 chars]".to_string();
    let actual = "abcdefghijkl".to_string();
    let mut app = ReplApp {
        input: format!("keep {placeholder} tail"),
        cursor_grapheme_index: "keep ".graphemes(true).count(),
        pending_pastes: vec![(placeholder.clone(), actual.clone())],
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL));
    assert_eq!(app.input, "keep ");
    assert!(app.pending_pastes.is_empty());

    app.handle_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::CONTROL));
    assert_eq!(app.input, format!("keep {placeholder} tail"));
    assert_eq!(
        app.pending_pastes,
        vec![(placeholder.clone(), actual.clone())]
    );
    assert_eq!(
        expand_pending_pastes(&app.input, &app.pending_pastes),
        "keep abcdefghijkl tail"
    );
}

#[test]
fn ctrl_y_restores_killed_image_sidecar() {
    let placeholder = local_image_placeholder(1);
    let mut app = ReplApp {
        input: format!("{placeholder} describe"),
        cursor_grapheme_index: 0,
        local_image_attachments: vec![LocalImageAttachment {
            path: std::path::PathBuf::from("/tmp/example.png"),
            placeholder: placeholder.clone(),
            media_type: "image/png".to_string(),
            clipboard_image: None,
        }],
        last_input_width: 80,
        ..ReplApp::default()
    };

    app.handle_key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL));
    assert_eq!(app.input, "");
    assert!(app.local_image_attachments.is_empty());

    app.handle_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::CONTROL));
    assert_eq!(app.input, format!("{placeholder} describe"));
    assert_eq!(app.local_image_attachments.len(), 1);
    assert_eq!(app.local_image_attachments[0].placeholder, placeholder);
}

#[test]
fn pasted_text_sanitization_strips_ansi_and_controls() {
    let mut app = ReplApp {
        last_input_width: 80,
        ..ReplApp::default()
    };
    let pasted = "ok\x1b[31mred\x1b[0m\x07\r\nnext";

    app.insert_text_at_cursor(&sanitize_tui_text(pasted));

    assert_eq!(app.input, "okred \nnext");
}

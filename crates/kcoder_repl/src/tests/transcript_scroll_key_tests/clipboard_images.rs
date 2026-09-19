fn temp_png_path(label: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "kcoder_repl_image_input_{}_{}_{}.png",
        label,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(&path, [1_u8, 2, 3, 4]).unwrap();
    path
}

#[test]
fn pasted_image_filepath_attaches_and_submits_image_block() {
    let path = temp_png_path("submit");

    let mut app = ReplApp {
        display_cwd: std::env::temp_dir().display().to_string(),
        ..ReplApp::default()
    };

    assert!(
        app.try_attach_pasted_image(&path.to_string_lossy())
            .unwrap()
    );
    assert_eq!(app.input, "[Image #1] ");

    app.insert_text_at_cursor("describe this");
    let submitted = app.take_submitted_message();
    let submitted_text = submitted.text.clone();
    let message = submitted.to_model_message(submitted_text).unwrap();
    let Message::User { content } = message else {
        panic!("expected user message");
    };

    assert_eq!(content.len(), 2);
    assert!(
        matches!(&content[0], ContentBlock::Text { text } if text == "[Image #1] describe this")
    );
    assert!(matches!(
        &content[1],
        ContentBlock::Image { source }
            if source.media_type == "image/png" && source.data == "AQIDBA=="
    ));

    let _ = std::fs::remove_file(path);
}

#[cfg(not(target_os = "windows"))]
#[test]
fn ctrl_v_requests_clipboard_image_without_changing_composer() {
    let mut app = ReplApp {
        input: "existing draft".to_string(),
        cursor_grapheme_index: "existing draft".graphemes(true).count(),
        ..ReplApp::default()
    };

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('v'), KeyModifiers::CONTROL));

    assert!(matches!(action, Some(UserAction::PasteClipboardImage)));
    assert_eq!(app.input, "existing draft");
}

#[test]
fn clipboard_temp_image_uses_existing_local_attachment_pipeline() {
    let image = clipboard_image::persist_processed_png(&[1, 2, 3, 4]).unwrap();
    let path = image.path().to_path_buf();
    let mut app = ReplApp::default();

    app.attach_clipboard_image(image).unwrap();

    assert_eq!(app.input, "[Image #1] ");
    assert_eq!(app.local_image_attachments[0].path, path);
    assert_eq!(app.local_image_attachments[0].media_type, "image/png");
    assert!(app.local_image_attachments[0].clipboard_image.is_some());
    drop(app);
    assert!(!path.exists());
}

#[test]
fn deleting_first_image_placeholder_relabels_remaining_attachment() {
    let first = temp_png_path("first");
    let second = temp_png_path("second");
    let mut app = ReplApp {
        display_cwd: std::env::temp_dir().display().to_string(),
        ..ReplApp::default()
    };

    assert!(
        app.try_attach_pasted_image(&first.to_string_lossy())
            .unwrap()
    );
    assert!(
        app.try_attach_pasted_image(&second.to_string_lossy())
            .unwrap()
    );

    app.input = "[Image #2] describe".to_string();
    app.cursor_grapheme_index = app.input_graphemes().len();
    app.sync_local_image_attachments();

    assert_eq!(app.input, "[Image #1] describe");
    assert_eq!(app.local_image_attachments.len(), 1);
    assert_eq!(app.local_image_attachments[0].path, second);
    assert_eq!(app.local_image_attachments[0].placeholder, "[Image #1]");

    let _ = std::fs::remove_file(first);
    let _ = std::fs::remove_file(second);
}

#[test]
fn editing_inside_image_placeholder_drops_attachment() {
    let path = temp_png_path("broken");
    let mut app = ReplApp {
        display_cwd: std::env::temp_dir().display().to_string(),
        ..ReplApp::default()
    };
    assert!(
        app.try_attach_pasted_image(&path.to_string_lossy())
            .unwrap()
    );

    app.cursor_grapheme_index = 1;
    app.handle_key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE));

    assert!(app.local_image_attachments.is_empty());
    assert!(!app.input.contains("[Image #1]"));

    let _ = std::fs::remove_file(path);
}

#[test]
fn large_paste_uses_placeholder_and_expands_on_submit() {
    let mut app = ReplApp::default();
    let large = "x".repeat(LARGE_PASTE_CHAR_THRESHOLD + 10);

    app.handle_paste_text(&large).unwrap();

    let placeholder = format!("[Pasted Content {} chars]", large.chars().count());
    assert_eq!(app.input, placeholder);
    assert_eq!(app.pending_pastes, vec![(placeholder, large.clone())]);

    let submitted = app.take_submitted_message();

    assert_eq!(submitted.text, large);
    assert!(submitted.images.is_empty());
    assert!(app.pending_pastes.is_empty());
}

#[test]
fn duplicate_large_paste_placeholders_are_unique_and_expand_in_order() {
    let mut app = ReplApp::default();
    let first = "a".repeat(LARGE_PASTE_CHAR_THRESHOLD + 5);
    let second = "b".repeat(LARGE_PASTE_CHAR_THRESHOLD + 5);

    app.handle_paste_text(&first).unwrap();
    app.insert_text_at_cursor(" and ");
    app.handle_paste_text(&second).unwrap();

    let base = format!("[Pasted Content {} chars]", first.chars().count());
    assert!(app.input.contains(&base));
    assert!(app.input.contains(&format!("{base} #2")));
    assert_eq!(app.pending_pastes.len(), 2);

    let submitted = app.take_submitted_message();

    assert_eq!(submitted.text, format!("{first} and {second}"));
}

#[test]
fn deleting_large_paste_placeholder_drops_payload() {
    let mut app = ReplApp::default();
    let large = "x".repeat(LARGE_PASTE_CHAR_THRESHOLD + 1);

    app.handle_paste_text(&large).unwrap();
    app.handle_key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE));

    assert!(app.pending_pastes.is_empty());
    assert_ne!(app.take_submitted_message().text, large);
}

#[test]
fn external_editor_seed_expands_pastes_and_edit_syncs_sidecars() {
    let placeholder = "[Pasted Content 12 chars]".to_string();
    let image = local_image_placeholder(1);
    let mut app = ReplApp {
        input: format!("draft {placeholder} {image}"),
        cursor_grapheme_index: format!("draft {placeholder} {image}")
            .graphemes(true)
            .count(),
        pending_pastes: vec![(placeholder.clone(), "abcdefghijkl".to_string())],
        local_image_attachments: vec![LocalImageAttachment {
            path: std::path::PathBuf::from("/tmp/example.png"),
            placeholder: image.clone(),
            media_type: "image/png".to_string(),
            clipboard_image: None,
        }],
        last_input_width: 80,
        ..ReplApp::default()
    };

    assert_eq!(
        app.composer_text_for_external_editor(),
        format!("draft abcdefghijkl {image}")
    );

    app.apply_external_edit(format!("edited {image}\r\n"));

    assert_eq!(app.input, format!("edited {image}\n"));
    assert!(app.pending_pastes.is_empty());
    assert_eq!(app.local_image_attachments.len(), 1);
    assert_eq!(app.cursor_grapheme_index, app.input_graphemes().len());

    app.apply_external_edit("edited without image");

    assert!(app.local_image_attachments.is_empty());
}

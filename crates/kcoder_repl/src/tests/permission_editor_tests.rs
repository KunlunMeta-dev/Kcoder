use super::*;

#[test]
fn cursor_position_uses_display_width_for_wide_characters() {
    let text = "项目🙂";
    let cursor = text.graphemes(true).count();

    assert_eq!(permission_editor_cursor_position(text, cursor), (0, 6));
}

#[test]
fn cursor_position_counts_visual_column_after_newline() {
    let text = "first\n项目";
    let cursor = text.graphemes(true).count();

    assert_eq!(permission_editor_cursor_position(text, cursor), (1, 4));
}

#[test]
fn paste_inserts_text_at_permission_editor_cursor() {
    let (response_tx, _response_rx) = oneshot::channel();
    let mut app = ReplApp {
        permission_editor: Some(PermissionEditor {
            tool_name: "bash".to_string(),
            text: "ab".to_string(),
            cursor_grapheme_index: 1,
            response_tx,
        }),
        ..ReplApp::default()
    };

    assert!(app.handle_paste_text_for_active_overlay("X\r\nY"));

    let editor = app.permission_editor.as_ref().unwrap();
    assert_eq!(editor.text, "aX\nYb");
    assert_eq!(editor.cursor_grapheme_index, 4);
    assert_eq!(app.input, "");
}

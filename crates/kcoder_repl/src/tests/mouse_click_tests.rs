use super::*;

fn left_click(column: u16, row: u16) -> MouseEvent {
    MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column,
        row,
        modifiers: KeyModifiers::NONE,
    }
}

fn mouse_scroll(kind: MouseEventKind) -> MouseEvent {
    MouseEvent {
        kind,
        column: 0,
        row: 0,
        modifiers: KeyModifiers::NONE,
    }
}

fn mouse_event(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
    MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    }
}

fn transcript_viewport_with_area(
    position: TranscriptScroll,
    content_rows: usize,
    viewport_rows: usize,
    scrollbar_area: Option<Rect>,
) -> TranscriptViewport {
    TranscriptViewport::with_layout(position, content_rows, viewport_rows, scrollbar_area)
}

fn line_text(line: &Line<'_>) -> String {
    line.spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect::<Vec<_>>()
        .join("")
}

fn permission_dialog(
    response_tx: tokio::sync::oneshot::Sender<PermissionDialogResult>,
) -> PermissionDialog {
    PermissionDialog {
        tool_name: "bash".to_string(),
        description: "Run command".to_string(),
        input: serde_json::json!({ "command": "pwd" }),
        risk: PermissionRisk::Low,
        detail_lines: Vec::new(),
        response_tx,
        selected: 0,
    }
}

fn make_msg(role: MessageRole, text: &str) -> DisplayMessage {
    DisplayMessage {
        role,
        text: text.to_string(),
    }
}

#[test]
fn transcript_mouse_selection_waits_for_ctrl_c_before_copying() {
    let mut app = ReplApp {
        last_transcript_visible_rows: vec![
            "zero alpha".to_string(),
            "one beta".to_string(),
            "two gamma".to_string(),
            String::new(),
        ],
        ..ReplApp::default()
    };
    app.transcript_viewport.begin_frame(Rect::new(10, 5, 20, 4));

    assert!(app.begin_transcript_selection(13, 5));
    assert!(app.update_transcript_selection(13, 6));

    assert!(app.finish_transcript_selection(13, 6));
    assert!(app.transcript_selection.is_some());
    assert!(!app.transcript_selection_drag_active);
    assert!(app.messages.is_empty());
    assert_eq!(
        app.transient_status_label(),
        "Text selected; press Ctrl+C to copy"
    );

    let mut copied = String::new();
    assert!(app.copy_transcript_selection_with(|text| {
        copied = text.to_string();
        Ok(clipboard_copy::ClipboardCopyResult::Native(None))
    }));

    assert_eq!(copied, "o alpha\none");
    assert!(app.transcript_selection.is_none());
    assert_eq!(
        app.transient_status_label(),
        "Copied selected text to clipboard"
    );
}

#[test]
fn transcript_mouse_selection_copy_failure_uses_transient_status() {
    let mut app = ReplApp {
        last_transcript_visible_rows: vec!["copy me".to_string()],
        ..ReplApp::default()
    };
    app.transcript_viewport.begin_frame(Rect::new(0, 0, 20, 2));

    assert!(app.begin_transcript_selection(0, 0));
    assert!(app.finish_transcript_selection(4, 0));
    assert!(app.copy_transcript_selection_with(|_| Err("blocked".to_string())));

    assert!(app.messages.is_empty());
    assert!(app.transcript_selection.is_some());
    assert_eq!(app.transient_status_label(), "Copy failed: blocked");
}

#[test]
fn transcript_mouse_selection_osc52_keeps_selection_and_warns_about_terminal_support() {
    let mut app = ReplApp {
        last_transcript_visible_rows: vec!["copy me".to_string()],
        ..ReplApp::default()
    };
    app.transcript_viewport.begin_frame(Rect::new(0, 0, 20, 2));

    assert!(app.begin_transcript_selection(0, 0));
    assert!(app.finish_transcript_selection(4, 0));
    assert!(
        app.copy_transcript_selection_with(|_| { Ok(clipboard_copy::ClipboardCopyResult::Osc52) })
    );

    assert!(app.transcript_selection.is_some());
    assert_eq!(
        app.transient_status_label(),
        clipboard_copy::OSC52_COPY_NOTICE
    );
}

#[test]
fn transcript_selection_does_not_start_in_composer() {
    let mut app = ReplApp {
        last_composer_area: Some(Rect::new(0, 12, 80, 3)),
        last_transcript_visible_rows: vec!["visible".to_string()],
        ..ReplApp::default()
    };
    app.transcript_viewport.begin_frame(Rect::new(0, 0, 80, 10));

    let action = handle_mouse_event(left_click(2, 13), &mut app);

    assert!(action.is_none());
    assert!(app.transcript_selection.is_none());
    assert!(!app.transcript_selection_drag_active);
}

#[test]
fn left_click_permission_button_confirms_response() {
    let frame_area = Rect::new(0, 0, 100, 30);
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    let mut app = ReplApp {
        last_frame_area: Some(frame_area),
        ..ReplApp::default()
    };
    app.enqueue_permission_dialog(permission_dialog(tx));
    let dialog = app.pending_permission.as_ref().unwrap();
    let allow = permission_option_bounds(frame_area, dialog, 0).unwrap();
    let deny = permission_option_bounds(frame_area, dialog, 3).unwrap();
    assert_eq!(deny.y, allow.y.saturating_add(3));
    assert_eq!(deny.x, allow.x);
    assert_eq!(deny.width, allow.width);

    let action = handle_mouse_event(left_click(deny.x.saturating_add(1), deny.y), &mut app);

    assert!(action.is_none());
    assert_eq!(
        rx.try_recv().unwrap().response,
        PermissionResponse::DenyOnce
    );
    assert!(app.pending_permission.is_none());
}

#[test]
fn permission_dialog_geometry_matches_menu_surface_shape() {
    let frame_area = Rect::new(0, 0, 100, 30);
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let dialog = permission_dialog(tx);
    let geometry = permission_dialog_geometry(frame_area, &dialog);

    assert_eq!(
        geometry.inner.x,
        geometry.outer.x.saturating_add(PICKER_SURFACE_INSET_H)
    );
    assert_eq!(
        geometry.inner.y,
        geometry.outer.y.saturating_add(PICKER_SURFACE_INSET_V)
    );
    assert_eq!(
        geometry.inner.width,
        geometry
            .outer
            .width
            .saturating_sub(PICKER_SURFACE_INSET_H.saturating_mul(2))
    );
}

#[test]
fn left_click_slash_menu_item_accepts_command() {
    let frame_area = Rect::new(0, 0, 100, 30);
    let composer_area = Rect::new(2, 24, 80, 3);
    let overlay_area = Rect::new(2, 16, 80, 8);
    let mut app = ReplApp {
        input: "/".to_string(),
        cursor_grapheme_index: 1,
        last_frame_area: Some(frame_area),
        last_bottom_overlay_area: Some(overlay_area),
        last_composer_area: Some(composer_area),
        last_input_width: 76,
        ..ReplApp::default()
    };
    app.sync_slash_menu();
    let first_command = app.slash_menu_matches()[0].name().to_string();
    let geometry = slash_menu_geometry(overlay_area, app.slash_menu_matches().len(), 0).unwrap();

    let action = handle_mouse_event(
        left_click(geometry.inner.x.saturating_add(1), geometry.first_item_y),
        &mut app,
    );

    assert!(action.is_none());
    assert_eq!(app.input, format!("{first_command} "));
    assert!(app.slash_menu.is_none());
}

#[test]
fn slash_menu_mouse_wheel_moves_selection() {
    let mut app = ReplApp {
        input: "/".to_string(),
        cursor_grapheme_index: 1,
        last_frame_area: Some(Rect::new(0, 0, 100, 30)),
        last_composer_area: Some(Rect::new(2, 24, 80, 3)),
        last_input_width: 76,
        ..ReplApp::default()
    };
    app.sync_slash_menu();
    assert_eq!(app.slash_menu.as_ref().unwrap().selected, 0);

    handle_mouse_event(mouse_scroll(MouseEventKind::ScrollDown), &mut app);
    assert_eq!(app.slash_menu.as_ref().unwrap().selected, 1);

    handle_mouse_event(mouse_scroll(MouseEventKind::ScrollUp), &mut app);
    assert_eq!(app.slash_menu.as_ref().unwrap().selected, 0);
}

#[test]
fn mouse_wheel_scrolls_transcript_without_cycling_input_history() {
    let mut app = ReplApp {
        input: "draft".to_string(),
        input_history: vec!["first prompt".to_string(), "second prompt".to_string()],
        last_frame_area: Some(Rect::new(0, 0, 100, 30)),
        last_composer_area: Some(Rect::new(0, 26, 100, 3)),
        transcript_viewport: transcript_viewport_with_area(
            TranscriptScroll::to_bottom(),
            100,
            10,
            None,
        ),
        ..ReplApp::default()
    };
    app.transcript_viewport.begin_frame(Rect::new(1, 0, 98, 10));

    handle_mouse_event(mouse_scroll(MouseEventKind::ScrollUp), &mut app);
    app.apply_pending_scroll();

    assert_eq!(app.input, "draft");
    assert_eq!(app.input_history_index, None);
    assert_eq!(app.input_history_draft, None);
    assert_eq!(
        app.transcript_viewport.position(),
        TranscriptScroll::from_tail(3)
    );
    assert_eq!(app.transcript_viewport.resolve_top(100, 10), 87);
}

#[test]
fn transcript_scrollbar_thumb_height_is_stable_and_easy_to_grab_across_positions() {
    let area = Rect::new(99, 0, 1, 20);
    let tops = [0, 1, 25, 50, 99, 100, usize::MAX];
    let geometries = tops
        .into_iter()
        .map(|top| transcript_scrollbar_geometry(area, 110, 10, top).unwrap())
        .collect::<Vec<_>>();

    assert!(geometries.iter().all(|geometry| geometry.thumb_len == 3));
    assert_eq!(geometries.first().unwrap().thumb_start, 0);
    assert_eq!(geometries.last().unwrap().thumb_start, 17);
}

#[test]
fn transcript_scrollbar_cell_resets_stale_symbol_style_and_skip() {
    let mut cell = Cell::new("界");
    cell.set_style(
        Style::default()
            .fg(Color::Red)
            .add_modifier(Modifier::ITALIC | Modifier::BOLD),
    );
    cell.skip = true;

    let style = Style::default().fg(Color::Gray).bg(Color::Black);
    set_transcript_scrollbar_cell(&mut cell, TranscriptScrollbarCellFill::Full, style);

    assert_eq!(
        cell.symbol(),
        transcript_scrollbar_vertical_symbol(TranscriptScrollbarCellFill::Full)
    );
    assert_eq!(cell.fg, Color::Gray);
    assert_eq!(cell.bg, Color::Black);
    assert_eq!(cell.modifier, Modifier::empty());
    assert!(!cell.skip);
}

#[test]
fn transcript_area_reserves_a_gutter_before_the_scrollbar() {
    let message_area = Rect::new(0, 0, 100, 20);
    let transcript_area = transcript_area_for_message_area(message_area, true);
    let gutter = transcript_gutter_area(message_area, transcript_area).unwrap();
    let scrollbar = transcript_scrollbar_area(message_area, 110, 10).unwrap();

    assert_eq!(transcript_area, Rect::new(1, 0, 97, 20));
    assert_eq!(gutter, Rect::new(98, 0, 2, 20));
    assert_eq!(scrollbar, Rect::new(98, 0, 1, 20));
}

#[test]
fn transcript_scrollbar_drag_updates_transcript_scroll() {
    let mut app = ReplApp {
        input: "draft".to_string(),
        input_history: vec!["first prompt".to_string(), "second prompt".to_string()],
        last_frame_area: Some(Rect::new(0, 0, 100, 30)),
        transcript_viewport: transcript_viewport_with_area(
            TranscriptScroll::to_bottom(),
            110,
            10,
            Some(Rect::new(99, 0, 1, 20)),
        ),
        ..ReplApp::default()
    };
    let emitted_at = Instant::now();
    app.frame_rate_limiter.mark_emitted(emitted_at);
    assert!(
        app.frame_rate_limiter
            .time_until_next_draw(emitted_at + Duration::from_millis(1))
            .is_some()
    );

    handle_mouse_event(
        mouse_event(MouseEventKind::Down(MouseButton::Left), 99, 0),
        &mut app,
    );
    assert!(!app.transcript_viewport.drag_active());
    assert_eq!(
        app.transcript_viewport.position(),
        TranscriptScroll::at_line(0)
    );
    assert!(
        app.frame_rate_limiter
            .time_until_next_draw(emitted_at + Duration::from_millis(1))
            .is_none(),
        "direct scrollbar manipulation should redraw immediately"
    );
    let drag_frame_at = emitted_at + Duration::from_millis(2);
    // The second grab represents a frame actually drawn at the top, not merely an updated throttle timestamp.
    app.transcript_viewport.commit_render(110, 0);
    app.frame_rate_limiter.mark_emitted(drag_frame_at);

    handle_mouse_event(
        mouse_event(MouseEventKind::Down(MouseButton::Left), 99, 0),
        &mut app,
    );
    assert!(app.transcript_viewport.drag_active());

    handle_mouse_event(
        mouse_event(MouseEventKind::Drag(MouseButton::Left), 99, 19),
        &mut app,
    );
    assert!(app.transcript_viewport.position().is_at_tail());
    assert_eq!(
        app.time_until_next_viewport_draw(drag_frame_at + Duration::from_millis(1)),
        Some(
            frame_rate_limiter::INTERACTION_MIN_FRAME_INTERVAL
                .saturating_sub(Duration::from_millis(1))
        ),
        "continuous scrollbar dragging should coalesce at the interaction rate"
    );
    assert!(
        !app.take_force_viewport_redraw(),
        "scrollbar dragging should use the normal redraw path, not force a physical viewport clear"
    );

    handle_mouse_event(
        mouse_event(MouseEventKind::Up(MouseButton::Left), 99, 80),
        &mut app,
    );
    assert!(!app.transcript_viewport.drag_active());
    assert_eq!(app.input, "draft");
    assert_eq!(app.input_history_index, None);
}

#[test]
fn transcript_scrollbar_drag_keeps_thumb_offset_and_frozen_row_count() {
    let mut app = ReplApp {
        last_frame_area: Some(Rect::new(0, 0, 100, 30)),
        transcript_viewport: transcript_viewport_with_area(
            TranscriptScroll::at_line(50),
            110,
            10,
            Some(Rect::new(99, 0, 1, 20)),
        ),
        ..ReplApp::default()
    };

    handle_mouse_event(
        mouse_event(MouseEventKind::Down(MouseButton::Left), 99, 10),
        &mut app,
    );

    assert!(app.transcript_viewport.drag_active());
    assert_eq!(app.transcript_viewport.content_rows(), 110);
    assert_eq!(app.transcript_viewport.resolve_top(110, 10), 50);

    app.transcript_viewport.commit_render(96, 0);
    handle_mouse_event(
        mouse_event(MouseEventKind::Drag(MouseButton::Left), 99, 80),
        &mut app,
    );

    assert!(
        app.transcript_viewport.position().is_at_tail(),
        "dragging to the bottom of the same frozen track should reach the tail"
    );
    assert_eq!(app.transcript_viewport.content_rows(), 110);

    handle_mouse_event(
        mouse_event(MouseEventKind::Up(MouseButton::Left), 99, 19),
        &mut app,
    );
    assert!(!app.transcript_viewport.drag_active());
    assert_eq!(
        app.transcript_viewport.content_rows(),
        96,
        "after release, the scrollbar should stop using the stale frozen drag row count"
    );
    assert_eq!(app.transcript_viewport.content_rows(), 96);
}

#[test]
fn transcript_scrollbar_release_keeps_visible_top_edge_at_top() {
    let mut app = ReplApp {
        last_frame_area: Some(Rect::new(0, 0, 100, 30)),
        transcript_viewport: transcript_viewport_with_area(
            TranscriptScroll::at_line(50),
            110,
            10,
            Some(Rect::new(99, 0, 1, 20)),
        ),
        ..ReplApp::default()
    };

    handle_mouse_event(
        mouse_event(MouseEventKind::Down(MouseButton::Left), 99, 10),
        &mut app,
    );
    handle_mouse_event(
        mouse_event(MouseEventKind::Drag(MouseButton::Left), 99, 0),
        &mut app,
    );
    app.transcript_viewport.commit_render(597, 0);
    handle_mouse_event(
        mouse_event(MouseEventKind::Up(MouseButton::Left), 99, 2),
        &mut app,
    );

    assert_eq!(
        app.transcript_viewport.position(),
        TranscriptScroll::at_line(0)
    );
    assert_eq!(app.transcript_viewport.live_content_rows(), 597);
}

#[test]
fn transcript_scrollbar_active_drag_accepts_moved_events() {
    let mut app = ReplApp {
        last_frame_area: Some(Rect::new(0, 0, 100, 30)),
        transcript_viewport: transcript_viewport_with_area(
            TranscriptScroll::to_bottom(),
            110,
            10,
            Some(Rect::new(99, 0, 1, 20)),
        ),
        ..ReplApp::default()
    };
    let emitted_at = Instant::now();
    app.frame_rate_limiter.mark_emitted(emitted_at);

    handle_mouse_event(
        mouse_event(MouseEventKind::Down(MouseButton::Left), 99, 19),
        &mut app,
    );
    assert!(app.transcript_viewport.drag_active());
    assert!(app.transcript_viewport.position().is_at_tail());

    handle_mouse_event(mouse_event(MouseEventKind::Moved, 99, 0), &mut app);

    assert_eq!(
        app.transcript_viewport.position(),
        TranscriptScroll::at_line(0)
    );
    assert_eq!(
        app.time_until_next_viewport_draw(emitted_at + Duration::from_millis(1)),
        Some(
            frame_rate_limiter::INTERACTION_MIN_FRAME_INTERVAL
                .saturating_sub(Duration::from_millis(1))
        ),
        "drag-compatible moved events should coalesce while the button is still held"
    );
}

#[test]
fn transcript_scrollbar_stale_drag_ends_when_moved_leaves_scrollbar() {
    let mut app = ReplApp {
        last_frame_area: Some(Rect::new(0, 0, 100, 30)),
        transcript_viewport: transcript_viewport_with_area(
            TranscriptScroll::at_line(40),
            110,
            10,
            Some(Rect::new(99, 0, 1, 20)),
        ),
        ..ReplApp::default()
    };
    assert!(app.transcript_viewport.begin_drag(7).is_none());
    assert!(app.transcript_viewport.drag_active());

    let action = handle_mouse_event(mouse_event(MouseEventKind::Moved, 20, 2), &mut app);

    assert!(action.is_none());
    assert_eq!(
        app.transcript_viewport.position(),
        TranscriptScroll::at_line(40)
    );
    assert!(!app.transcript_viewport.drag_active());
}

#[test]
fn transcript_scrollbar_drag_continues_when_pointer_leaves_scrollbar_column() {
    let mut app = ReplApp {
        last_frame_area: Some(Rect::new(0, 0, 100, 30)),
        transcript_viewport: transcript_viewport_with_area(
            TranscriptScroll::at_line(40),
            110,
            10,
            Some(Rect::new(99, 0, 1, 20)),
        ),
        ..ReplApp::default()
    };
    assert!(app.transcript_viewport.begin_drag(7).is_none());

    let action = handle_mouse_event(
        mouse_event(MouseEventKind::Drag(MouseButton::Left), 20, 2),
        &mut app,
    );

    assert!(action.is_none());
    assert!(app.transcript_viewport.drag_active());
    assert!(
        app.transcript_viewport.resolve_top(110, 10) < 40,
        "active scrollbar drags should keep following the pointer after horizontal overshoot"
    );
    assert_eq!(app.transcript_viewport.content_rows(), 110);
}

#[test]
fn transcript_scrollbar_drag_continues_one_column_left_of_track() {
    let mut app = ReplApp {
        last_frame_area: Some(Rect::new(0, 0, 100, 30)),
        transcript_viewport: transcript_viewport_with_area(
            TranscriptScroll::at_line(40),
            110,
            10,
            Some(Rect::new(99, 0, 1, 20)),
        ),
        ..ReplApp::default()
    };
    assert!(app.transcript_viewport.begin_drag(7).is_none());

    handle_mouse_event(
        mouse_event(MouseEventKind::Drag(MouseButton::Left), 98, 2),
        &mut app,
    );

    assert!(
        app.transcript_viewport.resolve_top(110, 10) < 40,
        "one-column horizontal overshoot should still be treated as the same active drag"
    );
    assert!(app.transcript_viewport.drag_active());
}

#[test]
fn transcript_scrollbar_stale_moved_does_not_follow_content_area_motion() {
    let mut app = ReplApp {
        last_frame_area: Some(Rect::new(0, 0, 100, 30)),
        transcript_viewport: transcript_viewport_with_area(
            TranscriptScroll::at_line(40),
            110,
            10,
            Some(Rect::new(99, 0, 1, 20)),
        ),
        ..ReplApp::default()
    };
    assert!(app.transcript_viewport.begin_drag(7).is_none());

    for row in [2, 18, 4, 16, 8] {
        handle_mouse_event(mouse_event(MouseEventKind::Moved, 35, row), &mut app);
    }

    assert_eq!(
        app.transcript_viewport.position(),
        TranscriptScroll::at_line(40),
        "content-area motion after a dropped mouse-up must not move the transcript"
    );
    assert!(!app.transcript_viewport.drag_active());
}

#[test]
fn transcript_scrollbar_drag_allows_vertical_overshoot_in_scrollbar_column() {
    let mut app = ReplApp {
        last_frame_area: Some(Rect::new(0, 0, 100, 30)),
        transcript_viewport: transcript_viewport_with_area(
            TranscriptScroll::at_line(40),
            110,
            10,
            Some(Rect::new(99, 0, 1, 20)),
        ),
        ..ReplApp::default()
    };
    assert!(app.transcript_viewport.begin_drag(7).is_none());

    let action = handle_mouse_event(
        mouse_event(MouseEventKind::Drag(MouseButton::Left), 99, 80),
        &mut app,
    );

    assert!(action.is_none());
    assert!(app.transcript_viewport.drag_active());
    assert!(
        app.transcript_viewport.position().is_at_tail(),
        "dragging below the track in the scrollbar column should clamp to the bottom"
    );
}

#[test]
fn left_click_picker_item_returns_existing_picker_action() {
    let frame_area = Rect::new(0, 0, 100, 30);
    let mut app = ReplApp {
        last_frame_area: Some(frame_area),
        ..ReplApp::default()
    };
    app.open_picker_overlay(
        "Models",
        vec!["MiniMax-M3".to_string(), "GLM-5.2".to_string()],
        PickerAction::SwitchModel,
    );
    let geometry = picker_overlay_geometry(frame_area, 2, 0);

    let action = handle_mouse_event(
        left_click(
            geometry.inner.x.saturating_add(1),
            geometry.first_item_y.saturating_add(1),
        ),
        &mut app,
    );

    assert!(matches!(
        action,
        Some(UserAction::SlashCommand(command)) if command == "/model GLM-5.2"
    ));
    assert!(app.picker_overlay.is_none());
}

#[test]
fn picker_overlay_scrolls_selected_item_into_visible_window() {
    let frame_area = Rect::new(0, 0, 100, 30);
    let mut app = ReplApp {
        last_frame_area: Some(frame_area),
        ..ReplApp::default()
    };
    app.open_picker_overlay(
        "Models",
        (1..=12).map(|idx| format!("Model {idx}")).collect(),
        PickerAction::SwitchModel,
    );
    app.picker_overlay.as_mut().unwrap().selected = 11;

    let geometry = picker_overlay_geometry(frame_area, 12, 11);
    assert_eq!(geometry.first_index, 4);
    assert_eq!(geometry.visible_items, PICKER_MAX_ITEMS);

    let action = handle_mouse_event(
        left_click(geometry.inner.x.saturating_add(1), geometry.first_item_y),
        &mut app,
    );

    assert!(matches!(
        action,
        Some(UserAction::SlashCommand(command)) if command == "/model Model 5"
    ));
    assert!(app.picker_overlay.is_none());
}

#[test]
fn picker_overlay_geometry_matches_menu_surface_shape() {
    let frame_area = Rect::new(0, 0, 100, 30);
    let geometry = picker_overlay_geometry(frame_area, 12, 0);

    assert_eq!(geometry.visible_items, PICKER_MAX_ITEMS);
    assert_eq!(
        geometry.inner.x,
        geometry.outer.x.saturating_add(PICKER_SURFACE_INSET_H)
    );
    assert_eq!(
        geometry.inner.y,
        geometry.outer.y.saturating_add(PICKER_SURFACE_INSET_V)
    );
    assert_eq!(
        geometry.inner.width,
        geometry
            .outer
            .width
            .saturating_sub(PICKER_SURFACE_INSET_H.saturating_mul(2))
    );
    assert_eq!(
        geometry.first_item_y,
        geometry.inner.y.saturating_add(PICKER_HEADER_LINES)
    );
}

#[test]
fn agent_picker_description_row_click_selects_the_same_agent() {
    let mut app = ReplApp::default();
    let area = Rect::new(0, 0, 100, 30);
    app.last_frame_area = Some(area);
    app.open_picker_overlay(
        "Sub-agents",
        vec![
            "job-100 [running]\nArchitecture".into(),
            "job-200 [running]\nConcurrency".into(),
        ],
        PickerAction::ViewAgent,
    );
    app.picker_overlay.as_mut().unwrap().item_values = vec!["job-100".into(), "job-200".into()];
    let picker = app.picker_overlay.as_ref().unwrap();
    let geometry = picker_geometry_for(picker, area, 2, 0);
    assert!(
        picker_hit_index_for(picker, area, 2, geometry.inner.x, geometry.first_item_y - 1)
            .is_none()
    );
    let action = handle_mouse_event(
        left_click(geometry.inner.x + 2, geometry.first_item_y + 3),
        &mut app,
    );
    assert!(
        matches!(action, Some(UserAction::SlashCommand(command)) if command == "/agent view job-200")
    );
}

#[test]
fn picker_overlay_rows_use_codex_selection_marker() {
    let selected = picker_overlay_item_line("Model 1", true, 24);
    let unselected = picker_overlay_item_line("Model 2", false, 24);
    let selected_text = line_text(&selected);
    let unselected_text = line_text(&unselected);

    assert_eq!(selected_text, "› Model 1");
    assert_eq!(unselected_text, "  Model 2");
    assert!(
        selected.spans[0]
            .style
            .add_modifier
            .contains(Modifier::BOLD)
    );
    assert!(
        selected.spans[1]
            .style
            .add_modifier
            .contains(Modifier::BOLD)
    );
    assert!(
        !unselected.spans[1]
            .style
            .add_modifier
            .contains(Modifier::BOLD)
    );
}

#[test]
fn picker_overlay_uses_search_placeholder_shape() {
    let empty = picker_overlay_search_line("", 24);
    let filtered = picker_overlay_search_line("Model 2", 24);

    assert_eq!(line_text(&empty), "Type to search");
    assert_eq!(line_text(&filtered), "Model 2");
    assert_eq!(empty.spans[0].style.fg, Some(KCODER_UI_THEME.text_muted));
    assert_eq!(filtered.spans[0].style.fg, Some(KCODER_UI_THEME.text_body));
    assert!(!line_text(&filtered).contains('>'));
    assert!(!line_text(&filtered).contains('▌'));
}

#[test]
fn picker_overlay_lines_leave_codex_gap_before_footer() {
    let picker = PickerOverlay {
        title: "Models",
        selected: 0,
        filter: String::new(),
        all_items: vec!["Model 1".to_string(), "Model 2".to_string()],
        item_values: Vec::new(),
        item_turns: Vec::new(),
        on_confirm: PickerAction::SwitchModel,
    };
    let matches = picker.matches();
    let lines = picker_overlay_lines(&picker, &matches, 0, 0, 2, 48);
    let texts = lines.iter().map(line_text).collect::<Vec<_>>();

    assert_eq!(
        texts,
        vec![
            "Models",
            "",
            "Type to search",
            "› Model 1",
            "  Model 2",
            "",
            "Press enter to confirm or esc to go back",
        ]
    );
}

#[test]
fn picker_overlay_page_keys_and_wheel_update_selection() {
    let frame_area = Rect::new(0, 0, 100, 30);
    let mut app = ReplApp {
        last_frame_area: Some(frame_area),
        ..ReplApp::default()
    };
    app.open_picker_overlay(
        "Models",
        (1..=12).map(|idx| format!("Model {idx}")).collect(),
        PickerAction::SwitchModel,
    );

    app.handle_picker_key(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE));
    assert_eq!(
        app.picker_overlay.as_ref().unwrap().selected,
        PICKER_MAX_ITEMS
    );

    handle_mouse_event(mouse_scroll(MouseEventKind::ScrollDown), &mut app);
    assert_eq!(
        app.picker_overlay.as_ref().unwrap().selected,
        PICKER_MAX_ITEMS + 1
    );

    handle_mouse_event(mouse_scroll(MouseEventKind::ScrollUp), &mut app);
    assert_eq!(
        app.picker_overlay.as_ref().unwrap().selected,
        PICKER_MAX_ITEMS
    );

    app.handle_picker_key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
    assert_eq!(app.picker_overlay.as_ref().unwrap().selected, 11);

    app.handle_picker_key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
    assert_eq!(app.picker_overlay.as_ref().unwrap().selected, 0);
}

#[test]
fn picker_overlay_supports_ctrl_p_and_ctrl_n_navigation() {
    let mut app = ReplApp::default();
    app.open_picker_overlay(
        "Models",
        vec!["Model 1".to_string(), "Model 2".to_string()],
        PickerAction::SwitchModel,
    );

    app.handle_picker_key(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::CONTROL));
    let picker = app.picker_overlay.as_ref().unwrap();
    assert_eq!(picker.selected, 1);
    assert!(picker.filter.is_empty());

    app.handle_picker_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL));
    let picker = app.picker_overlay.as_ref().unwrap();
    assert_eq!(picker.selected, 0);
    assert!(picker.filter.is_empty());
}

#[test]
fn picker_overlay_ignores_modified_filter_text() {
    let mut app = ReplApp::default();
    app.open_picker_overlay(
        "Models",
        vec!["Model 1".to_string(), "Model 2".to_string()],
        PickerAction::SwitchModel,
    );

    app.handle_picker_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL));
    app.handle_picker_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::ALT));

    let picker = app.picker_overlay.as_ref().unwrap();
    assert!(picker.filter.is_empty());
    assert_eq!(picker.selected, 0);
}

#[test]
fn picker_overlay_ctrl_c_closes_without_quit_flow() {
    let mut app = ReplApp::default();
    app.open_picker_overlay(
        "Models",
        vec!["Model 1".to_string(), "Model 2".to_string()],
        PickerAction::SwitchModel,
    );

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));

    assert!(action.is_none());
    assert!(app.picker_overlay.is_none());
    assert!(app.active_overlay_kinds().is_empty());
    assert!(app.active_quit_shortcut_key().is_none());
}

#[test]
fn picker_paste_updates_filter_without_touching_composer() {
    let mut app = ReplApp::default();
    app.open_picker_overlay(
        "Switch model",
        vec!["Model 3".to_string(), "Other".to_string()],
        PickerAction::SwitchModel,
    );

    assert!(app.handle_paste_text_for_active_overlay("Model\n3"));

    let picker = app.picker_overlay.as_ref().unwrap();
    assert_eq!(picker.filter, "Model 3");
    assert_eq!(picker.matches(), vec!["Model 3".to_string()]);
    assert_eq!(app.input, "");
}

#[test]
fn history_search_opens_without_previewing_latest_entry() {
    let mut app = ReplApp {
        input: "draft".to_string(),
        cursor_grapheme_index: 5,
        messages: (0..10)
            .map(|idx| make_msg(MessageRole::User, &format!("message {idx}")))
            .collect(),
        ..ReplApp::default()
    };
    app.open_history_search();
    let search = app.history_search.as_ref().unwrap();

    assert_eq!(search.status, HistorySearchStatus::Idle);
    assert!(search.matches.is_empty());
    assert_eq!(app.input, "draft");
    assert_eq!(app.cursor_grapheme_index, 5);
}

#[test]
fn history_search_paste_updates_query_and_previews_match() {
    let mut app = ReplApp {
        messages: vec![
            make_msg(MessageRole::User, "alpha beta"),
            make_msg(MessageRole::User, "gamma"),
        ]
        .into_iter()
        .collect(),
        ..ReplApp::default()
    };
    app.open_history_search();

    assert!(app.handle_paste_text_for_active_overlay("  alpha\nbeta  "));

    let search = app.history_search.as_ref().unwrap();
    assert_eq!(search.query, "alpha beta");
    assert_eq!(search.matches, vec![0]);
    assert_eq!(search.status, HistorySearchStatus::Match);
    assert_eq!(app.input, "alpha beta");
    assert_eq!(app.cursor_grapheme_index, app.input_graphemes().len());
}

#[test]
fn history_search_page_keys_and_boundaries_update_selection() {
    let mut app = ReplApp {
        messages: (0..12)
            .map(|idx| make_msg(MessageRole::User, &format!("message {idx}")))
            .collect(),
        ..ReplApp::default()
    };
    app.open_history_search();
    app.handle_key(KeyEvent::new(KeyCode::Char('m'), KeyModifiers::NONE));
    assert_eq!(app.history_search.as_ref().unwrap().selected, 11);
    assert_eq!(app.input, "message 11");

    app.handle_key(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE));
    assert_eq!(app.history_search.as_ref().unwrap().selected, 3);
    assert_eq!(app.input, "message 3");

    app.handle_key(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE));
    assert_eq!(app.history_search.as_ref().unwrap().selected, 11);
    assert_eq!(app.input, "message 11");

    app.handle_key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
    assert_eq!(app.history_search.as_ref().unwrap().selected, 0);
    assert_eq!(app.input, "message 0");

    app.handle_key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
    assert_eq!(app.history_search.as_ref().unwrap().selected, 11);
    assert_eq!(app.input, "message 11");
}

#[test]
fn history_search_ctrl_c_cancels_without_mutating_draft() {
    let mut app = ReplApp {
        input: "draft".to_string(),
        cursor_grapheme_index: 5,
        messages: (0..3)
            .map(|idx| make_msg(MessageRole::User, &format!("message {idx}")))
            .collect(),
        ..ReplApp::default()
    };
    app.open_history_search();

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));

    assert!(action.is_none());
    assert_eq!(app.input, "draft");
    assert_eq!(app.cursor_grapheme_index, 5);
    assert!(app.history_search.is_none());
    assert!(app.active_overlay_kinds().is_empty());
    assert!(app.active_quit_shortcut_key().is_none());
}

#[tokio::test]
async fn history_search_consumes_ctrl_c_before_active_turn_interrupt() {
    let mut app = ReplApp {
        input: "draft".to_string(),
        cursor_grapheme_index: 5,
        messages: vec![make_msg(MessageRole::User, "previous")].into(),
        ..ReplApp::default()
    };
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(async {
        std::future::pending::<()>().await;
    });
    app.begin_turn(handle, cancel.clone());
    app.open_history_search();

    let action = app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));

    assert!(action.is_none());
    assert!(app.history_search.is_none());
    assert_eq!(app.input, "draft");
    assert!(!cancel.is_cancelled());
    assert!(app.is_loading);

    let handle = app.abort_turn_for_shutdown().unwrap();
    let _ = handle.await;
}

#[test]
fn history_search_enter_accepts_matching_preview() {
    let mut app = ReplApp {
        input: "draft".to_string(),
        cursor_grapheme_index: 5,
        messages: vec![
            make_msg(MessageRole::User, "alpha old"),
            make_msg(MessageRole::User, "alpha latest"),
        ]
        .into_iter()
        .collect(),
        ..ReplApp::default()
    };
    app.open_history_search();
    app.handle_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE));
    assert_eq!(app.input, "alpha latest");

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert!(action.is_none());
    assert_eq!(app.input, "alpha latest");
    assert!(app.history_search.is_none());
    assert!(app.active_overlay_kinds().is_empty());
}

#[test]
fn history_search_enter_without_match_keeps_search_active() {
    let mut app = ReplApp {
        input: "draft".to_string(),
        cursor_grapheme_index: 5,
        messages: vec![make_msg(MessageRole::User, "alpha")]
            .into_iter()
            .collect(),
        ..ReplApp::default()
    };
    app.open_history_search();
    app.handle_key(KeyEvent::new(KeyCode::Char('z'), KeyModifiers::NONE));
    assert_eq!(app.input, "draft");
    assert_eq!(
        app.history_search.as_ref().unwrap().status,
        HistorySearchStatus::NoMatch
    );

    let action = app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert!(action.is_none());
    assert_eq!(app.input, "draft");
    assert!(app.history_search.is_some());
    assert_eq!(app.active_overlay_kinds(), vec![OverlayKind::HistorySearch]);
}

#[test]
fn history_search_ctrl_r_and_ctrl_s_move_between_matches() {
    let mut app = ReplApp {
        messages: (0..12)
            .map(|idx| make_msg(MessageRole::User, &format!("message {idx}")))
            .collect(),
        ..ReplApp::default()
    };
    app.open_history_search();
    app.handle_key(KeyEvent::new(KeyCode::Char('m'), KeyModifiers::NONE));
    assert_eq!(app.history_search.as_ref().unwrap().selected, 11);
    assert_eq!(app.input, "message 11");

    app.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL));
    assert_eq!(app.history_search.as_ref().unwrap().selected, 10);
    assert_eq!(app.input, "message 10");

    app.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL));
    assert_eq!(app.history_search.as_ref().unwrap().selected, 9);
    assert_eq!(app.input, "message 9");

    app.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL));
    assert_eq!(app.history_search.as_ref().unwrap().selected, 10);
    assert_eq!(app.input, "message 10");
}

#[test]
fn history_search_ignores_modified_text_and_supports_ctrl_editing() {
    let mut app = ReplApp {
        messages: vec![
            make_msg(MessageRole::User, "message 0"),
            make_msg(MessageRole::User, "alpha"),
        ]
        .into(),
        ..ReplApp::default()
    };
    app.open_history_search();

    app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL));
    app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::ALT));
    assert_eq!(app.history_search.as_ref().unwrap().query, "");

    app.handle_key(KeyEvent::new(KeyCode::Char('m'), KeyModifiers::NONE));
    assert_eq!(app.history_search.as_ref().unwrap().query, "m");

    app.handle_key(KeyEvent::new(KeyCode::Char('h'), KeyModifiers::CONTROL));
    assert_eq!(app.history_search.as_ref().unwrap().query, "");

    app.handle_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('l'), KeyModifiers::NONE));
    assert_eq!(app.history_search.as_ref().unwrap().query, "al");

    app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
    assert_eq!(app.history_search.as_ref().unwrap().query, "");
}

#[test]
fn left_click_while_history_search_active_does_not_accept_preview() {
    let frame_area = Rect::new(0, 0, 100, 14);
    let mut app = ReplApp {
        messages: (0..10)
            .map(|idx| make_msg(MessageRole::User, &format!("message {idx}")))
            .collect(),
        last_frame_area: Some(frame_area),
        ..ReplApp::default()
    };
    app.open_history_search();
    app.handle_key(KeyEvent::new(KeyCode::Char('m'), KeyModifiers::NONE));

    let action = handle_mouse_event(left_click(10, 5), &mut app);

    assert!(action.is_none());
    assert_eq!(app.input, "message 9");
    assert_eq!(app.cursor_grapheme_index, app.input_graphemes().len());
    assert!(app.history_search.is_some());
    assert_eq!(app.active_overlay_kinds(), vec![OverlayKind::HistorySearch]);
}

#[test]
fn history_search_cursor_tracks_footer_query() {
    let mut app = ReplApp {
        messages: vec![make_msg(MessageRole::User, "cargo test")]
            .into_iter()
            .collect(),
        ..ReplApp::default()
    };
    app.open_history_search();
    app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::NONE));

    assert_eq!(
        app.history_search_footer_cursor(Rect::new(0, 18, 80, 1)),
        Some((21, 18))
    );
}

#[test]
fn left_click_composer_focuses_input_and_positions_cursor() {
    let mut app = ReplApp {
        input: "abc\n项目".to_string(),
        cursor_grapheme_index: 0,
        last_frame_area: Some(Rect::new(0, 0, 100, 30)),
        last_composer_area: Some(Rect::new(10, 20, 40, 5)),
        last_composer_content: Some(Rect::new(12, 21, 36, 3)),
        last_input_width: 36,
        ..ReplApp::default()
    };
    app.open_picker_overlay(
        "Models",
        vec!["MiniMax-M3".to_string()],
        PickerAction::SwitchModel,
    );

    let action = handle_mouse_event(left_click(14, 21), &mut app);

    assert!(action.is_none());
    assert_eq!(app.cursor_grapheme_index, 3);
    assert!(app.picker_overlay.is_none());
}

/// Full-screen scrollbar regression harness. Thumb geometry must match the
/// `(total_rows, top)` actually drawn by every frame, including content growth
/// during a drag and mismatches between estimated and frozen rows.
#[test]
fn fullscreen_scrollbar_thumb_tracks_the_painted_render_base() {
    use ratatui::backend::{ClearType, WindowSize};
    use ratatui::buffer::Cell;
    use std::io::Write;

    const WIDTH: u16 = 100;
    const HEIGHT: u16 = 30;

    /// app.draw() requires the repository's Terminal<Backend + Write>; this minimal backend records dimensions only.
    struct ScrollbarCaptureBackend {
        size: Size,
        cursor: Position,
    }

    impl Write for ScrollbarCaptureBackend {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Backend for ScrollbarCaptureBackend {
        fn draw<'a, I>(&mut self, _content: I) -> std::io::Result<()>
        where
            I: Iterator<Item = (u16, u16, &'a Cell)>,
        {
            Ok(())
        }
        fn hide_cursor(&mut self) -> std::io::Result<()> {
            Ok(())
        }
        fn show_cursor(&mut self) -> std::io::Result<()> {
            Ok(())
        }
        fn get_cursor_position(&mut self) -> std::io::Result<Position> {
            Ok(self.cursor)
        }
        fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> std::io::Result<()> {
            self.cursor = position.into();
            Ok(())
        }
        fn clear(&mut self) -> std::io::Result<()> {
            Ok(())
        }
        fn clear_region(&mut self, _clear_type: ClearType) -> std::io::Result<()> {
            Ok(())
        }
        fn append_lines(&mut self, _line_count: u16) -> std::io::Result<()> {
            Ok(())
        }
        fn scroll_region_up(
            &mut self,
            _region: std::ops::Range<u16>,
            _scroll_by: u16,
        ) -> std::io::Result<()> {
            Ok(())
        }
        fn scroll_region_down(
            &mut self,
            _region: std::ops::Range<u16>,
            _scroll_by: u16,
        ) -> std::io::Result<()> {
            Ok(())
        }
        fn size(&self) -> std::io::Result<Size> {
            Ok(self.size)
        }
        fn window_size(&mut self) -> std::io::Result<WindowSize> {
            Ok(WindowSize {
                columns_rows: self.size,
                pixels: self.size,
            })
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn draw_frame(app: &mut ReplApp, terminal: &mut Terminal<ScrollbarCaptureBackend>) {
        terminal.draw(|frame| app.draw(frame)).unwrap();
    }

    /// Track area actually used by the previous frame, derived and installed from the message area during draw.
    fn track_area(app: &ReplApp) -> Rect {
        app.transcript_viewport
            .scrollbar_area()
            .expect("内容超出一屏时滚动条必须可见")
    }

    fn painted_thumb_rows(app: &ReplApp, terminal: &Terminal<ScrollbarCaptureBackend>) -> Vec<u16> {
        let track = track_area(app);
        let buffer = terminal.rendered_buffer_for_tests();
        let thumb = transcript_scrollbar_vertical_symbol(TranscriptScrollbarCellFill::Full);
        (track.y..track.bottom())
            .filter(|y| buffer[(track.x, *y)].symbol() == thumb)
            .collect()
    }

    fn render_base_thumb(app: &mut ReplApp) -> (Rect, TranscriptScrollbarMetrics) {
        // The same parameters as draw() hit the render cache and retrieve the basis drawn in the previous frame.
        let transcript_area = app
            .transcript_viewport
            .transcript_area()
            .expect("全屏绘制后必须记录 transcript 区域");
        let render = app.render_fullscreen_transcript_window(
            transcript_area.width.max(1),
            usize::from(transcript_area.height),
        );
        let track = track_area(app);
        let metrics = TranscriptScrollbarMetrics::new(
            render.total_rows,
            usize::from(transcript_area.height),
            render.top,
            track.height,
        );
        (track, metrics)
    }

    fn assert_thumb_matches_render_base(
        app: &mut ReplApp,
        terminal: &Terminal<ScrollbarCaptureBackend>,
    ) {
        let (track, expected) = render_base_thumb(app);
        let thumbs = painted_thumb_rows(app, terminal);
        assert_eq!(
            thumbs.len(),
            expected.thumb_len,
            "滑块长度必须来自渲染帧基准"
        );
        assert_eq!(
            thumbs.first().copied(),
            Some(track.y + expected.thumb_start as u16),
            "滑块起始行必须与渲染帧 top 逐格对应"
        );
        assert!(
            thumbs.windows(2).all(|pair| pair[1] == pair[0] + 1),
            "滑块必须连续覆盖轨道，不得断档: {thumbs:?}"
        );
        let rail = transcript_scrollbar_vertical_symbol(TranscriptScrollbarCellFill::Empty);
        let thumb = transcript_scrollbar_vertical_symbol(TranscriptScrollbarCellFill::Full);
        let buffer = terminal.rendered_buffer_for_tests();
        for y in track.y..track.bottom() {
            let symbol = buffer[(track.x, y)].symbol();
            assert!(
                symbol == rail || symbol == thumb,
                "轨道列第 {y} 行必须是轨道或滑块符号，实际为 {symbol:?}"
            );
        }
    }

    /// The draw basis during a drag is the frozen coordinate system. Frame total_rows
    /// varies with window estimates and would make thumb size and position jitter under a stationary pointer if used directly.
    fn frozen_drag_thumb(app: &mut ReplApp) -> (Rect, TranscriptScrollbarMetrics) {
        let track = track_area(app);
        let transcript_area = app
            .transcript_viewport
            .transcript_area()
            .expect("全屏绘制后必须记录 transcript 区域");
        let viewport_rows = usize::from(transcript_area.height);
        let frozen_rows = app.transcript_viewport.content_rows();
        let frozen_top = app
            .transcript_viewport
            .resolve_top(frozen_rows, viewport_rows);
        let metrics =
            TranscriptScrollbarMetrics::new(frozen_rows, viewport_rows, frozen_top, track.height);
        (track, metrics)
    }

    fn assert_thumb_matches_frozen_drag_base(
        app: &mut ReplApp,
        terminal: &Terminal<ScrollbarCaptureBackend>,
    ) -> usize {
        let (track, expected) = frozen_drag_thumb(app);
        let thumbs = painted_thumb_rows(app, terminal);
        assert_eq!(
            thumbs.len(),
            expected.thumb_len,
            "拖拽中滑块长度必须来自 frozen 基准（不得随估算波动）"
        );
        assert_eq!(
            thumbs.first().copied(),
            Some(track.y + expected.thumb_start as u16),
            "拖拽中滑块起始行必须来自 frozen 基准"
        );
        expected.thumb_len
    }

    let mut app = ReplApp {
        fullscreen_surface: true,
        ..ReplApp::default()
    };
    for idx in 0..60 {
        app.push_message(
            MessageRole::Assistant,
            format!("transcript history line {idx:03}"),
        );
    }
    let backend = ScrollbarCaptureBackend {
        size: Size::new(WIDTH, HEIGHT),
        cursor: Position { x: 0, y: 0 },
    };
    let mut terminal =
        Terminal::with_options_and_cursor_position(backend, Position { x: 0, y: 0 }).unwrap();
    terminal.set_viewport_area(Rect::new(0, 0, WIDTH, HEIGHT));

    // In a non-dragging FromTail frame, the thumb must also follow the rendered-frame basis.
    draw_frame(&mut app, &mut terminal);
    app.transcript_viewport.scroll_lines(-40);
    draw_frame(&mut app, &mut terminal);
    assert_thumb_matches_render_base(&mut app, &terminal);

    // Press the thumb to begin dragging; the frozen row snapshot is established now.
    let track = track_area(&app);
    let transcript_area = app
        .transcript_viewport
        .transcript_area()
        .expect("全屏绘制后必须记录 transcript 区域");
    let viewport_rows = usize::from(transcript_area.height);
    let committed_rows = app.transcript_viewport.content_rows();
    let committed_top = app
        .transcript_viewport
        .resolve_top(committed_rows, viewport_rows);
    let committed =
        TranscriptScrollbarMetrics::new(committed_rows, viewport_rows, committed_top, track.height);
    let grab_row = track.y + committed.thumb_start as u16 + 1;
    handle_mouse_event(
        mouse_event(MouseEventKind::Down(MouseButton::Left), track.x, grab_row),
        &mut app,
    );
    assert!(app.transcript_viewport.drag_active());
    let grab_cell = painted_thumb_rows(&app, &terminal);

    // Grow content during a drag without moving the pointer. The thumb must retain
    // the frozen basis, constant height, and grab-point position; fluctuating frame estimates cannot move or resize it.
    let mut drag_thumb_lens = Vec::new();
    for round in 0..2 {
        for idx in 0..60 {
            app.push_message(
                MessageRole::Assistant,
                format!("streamed line {round}-{idx:03}"),
            );
        }
        draw_frame(&mut app, &mut terminal);
        assert!(app.transcript_viewport.drag_active());
        drag_thumb_lens.push(assert_thumb_matches_frozen_drag_base(&mut app, &terminal));
        let current_cell = painted_thumb_rows(&app, &terminal);
        let drift = current_cell
            .first()
            .zip(grab_cell.first())
            .map(|(now, at_grab)| now.abs_diff(*at_grab))
            .unwrap_or(u16::MAX);
        assert!(
            drift <= 1,
            "静止指针下流式增长不得推动滑块（漂移 {drift} 格）"
        );
    }
    assert_eq!(
        drag_thumb_lens
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        1,
        "拖拽中滑块高度必须恒定: {drag_thumb_lens:?}"
    );

    handle_mouse_event(
        mouse_event(MouseEventKind::Up(MouseButton::Left), track.x, grab_row),
        &mut app,
    );
    assert!(!app.transcript_viewport.drag_active());
}

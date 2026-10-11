//! Mouse dispatch, scrollbar drag, selection, and click routing.

use super::*;

pub(super) fn handle_mouse_event(mouse: MouseEvent, app: &mut ReplApp) -> Option<UserAction> {
    trace_tui_lab_mouse_event("input", mouse, app);
    app.last_mouse_pos = Some((mouse.column, mouse.row));
    if app.handle_copy_mouse(mouse) {
        return None;
    }
    if app.handle_outline_mouse(mouse) {
        return None;
    }
    if app.active_overlay.is_none()
        && matches!(
            mouse.kind,
            MouseEventKind::ScrollUp
                | MouseEventKind::ScrollDown
                | MouseEventKind::Drag(MouseButton::Left)
        )
    {
        app.cancel_pending_navigation_for_input();
    }

    if handle_transcript_scrollbar_mouse(mouse, app) {
        return None;
    }

    if handle_transcript_selection_mouse(mouse, app) {
        return None;
    }

    if matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) {
        return handle_left_mouse_click(mouse.column, mouse.row, app);
    }

    let is_scroll = matches!(
        mouse.kind,
        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
    );

    if is_scroll {
        if app.navigation.inline && app.transcript_overlay.is_some() {
            app.transcript_viewport
                .queue_wheel(if mouse.kind == MouseEventKind::ScrollUp {
                    ScrollDirection::Up
                } else {
                    ScrollDirection::Down
                });
            return None;
        }
        if let Some(overlay) = app.transcript_overlay.as_mut() {
            match mouse.kind {
                MouseEventKind::ScrollUp => overlay.scroll_by(-3),
                MouseEventKind::ScrollDown => overlay.scroll_by(3),
                _ => {}
            }
            return None;
        }

        // History search uses the wheel for its own selection.
        if let Some(search) = app.history_search.as_mut() {
            match mouse.kind {
                MouseEventKind::ScrollUp if search.selected > 0 => search.selected -= 1,
                MouseEventKind::ScrollDown if search.selected + 1 < search.matches.len() => {
                    search.selected += 1;
                }
                _ => {}
            }
            return None;
        }

        if let Some(picker) = app.resume_session_picker.as_mut() {
            let matches_len = resume_session_picker_matches(picker).len();
            match mouse.kind {
                MouseEventKind::ScrollUp => {
                    picker.selected = picker.selected.saturating_sub(1);
                }
                MouseEventKind::ScrollDown => {
                    picker.selected = picker
                        .selected
                        .saturating_add(1)
                        .min(matches_len.saturating_sub(1));
                }
                _ => {}
            }
            return None;
        }

        let dialog_area = app.dialog_host_area();
        if let Some(dialog) = app.pending_question.as_mut() {
            match mouse.kind {
                MouseEventKind::ScrollUp => {
                    move_question_dialog_cursor_by(dialog, -1, dialog_area, false);
                }
                MouseEventKind::ScrollDown => {
                    move_question_dialog_cursor_by(dialog, 1, dialog_area, false);
                }
                _ => {}
            }
            return None;
        }

        if let Some(picker) = app.picker_overlay.as_mut() {
            let matches_len = picker.matches().len();
            match mouse.kind {
                MouseEventKind::ScrollUp => {
                    picker.selected = picker.selected.saturating_sub(1);
                }
                MouseEventKind::ScrollDown => {
                    picker.selected = picker
                        .selected
                        .saturating_add(1)
                        .min(matches_len.saturating_sub(1));
                }
                _ => {}
            }
            return None;
        }

        if app.slash_menu.is_some() {
            let matches_len = app.slash_menu_matches().len();
            if let Some(menu) = app.slash_menu.as_mut() {
                match mouse.kind {
                    MouseEventKind::ScrollUp => {
                        menu.selected = menu.selected.saturating_sub(1);
                    }
                    MouseEventKind::ScrollDown => {
                        menu.selected = menu
                            .selected
                            .saturating_add(1)
                            .min(matches_len.saturating_sub(1));
                    }
                    _ => {}
                }
            }
            return None;
        }

        // Other overlays should consume wheel events so they don't leak into
        // the transcript behind them.
        if app.pending_permission.is_some()
            || app.permission_editor.is_some()
            || app.pending_goal_replacement.is_some()
            || app.resume_session_picker.is_some()
            || app.slash_menu.is_some()
            || app.context_inspector.is_some()
            || app.settings_inspector.is_some()
            || app.picker_overlay.is_some()
            || app.keys_overlay.is_some()
            || app.transcript_overlay.is_some()
        {
            return None;
        }
    }

    match mouse.kind {
        MouseEventKind::ScrollUp => {
            if app.navigation.anchor.is_none() {
                app.expand_deferred_resumed_transcript();
            }
            app.transcript_viewport.queue_wheel(ScrollDirection::Up);
        }
        MouseEventKind::ScrollDown => {
            app.transcript_viewport.queue_wheel(ScrollDirection::Down);
        }
        _ => {}
    }
    None
}

pub(super) fn trace_tui_lab_mouse_event(phase: &str, mouse: MouseEvent, app: &ReplApp) {
    let Ok(run_dir) = std::env::var("KCODER_TUI_LAB_RUN_DIR") else {
        return;
    };
    if run_dir.is_empty() {
        return;
    }
    let path = Path::new(&run_dir).join("mouse-events.log");
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    let _ = writeln!(
        file,
        "{phase}\t{:?}\trow={}\tcol={}\t{}",
        mouse.kind,
        mouse.row,
        mouse.column,
        app.transcript_viewport.trace_state(),
    );
}

pub(super) fn handle_transcript_scrollbar_mouse(mouse: MouseEvent, app: &mut ReplApp) -> bool {
    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            let Some(area) = app.transcript_viewport.scrollbar_area() else {
                app.transcript_viewport.end_drag();
                return false;
            };
            if !rect_contains(area, mouse.column, mouse.row) {
                app.transcript_viewport.end_drag();
                return false;
            }
            if app.deferred_resumed_transcript.is_some() {
                // The current thumb represents only the loaded tail. Complete the transcript
                // first and prime full geometry from the same row index so this press can begin dragging.
                if !app.expand_deferred_resumed_transcript() {
                    return true;
                }
            }
            if let Some(command) = app.transcript_viewport.begin_drag(mouse.row) {
                app.apply_transcript_scrollbar_command(command, true);
            }
            true
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            if !app.transcript_viewport.drag_active() {
                return false;
            }
            app.scroll_transcript_to_scrollbar_row(mouse.row, false);
            true
        }
        MouseEventKind::Moved => {
            if !app.transcript_viewport.drag_active() {
                return false;
            }
            // `Moved` does not carry button state. Treat it as a drag fallback
            // only while the pointer remains in the scrollbar hit column; if a
            // terminal dropped the matching mouse-up, ordinary transcript hover
            // must not keep moving the scrollbar.
            if !transcript_scrollbar_drag_column_contains(app, mouse.column) {
                app.transcript_viewport.end_drag();
                return false;
            }
            app.scroll_transcript_to_scrollbar_row(mouse.row, false);
            true
        }
        MouseEventKind::Up(MouseButton::Left) => {
            if !app
                .transcript_viewport
                .release_drag(mouse.column, mouse.row)
            {
                return false;
            }
            app.frame_rate_limiter.reset();
            trace_tui_lab_mouse_event("after-up", mouse, app);
            app.finish_manual_scroll_at_tail();
            true
        }
        _ => false,
    }
}

pub(super) fn handle_transcript_selection_mouse(mouse: MouseEvent, app: &mut ReplApp) -> bool {
    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            app.begin_transcript_selection(mouse.column, mouse.row)
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            app.update_transcript_selection(mouse.column, mouse.row)
        }
        MouseEventKind::Up(MouseButton::Left) => {
            app.finish_transcript_selection(mouse.column, mouse.row)
        }
        _ => false,
    }
}

pub(super) fn transcript_scrollbar_drag_column_contains(app: &ReplApp, column: u16) -> bool {
    app.transcript_viewport.drag_column_contains(column)
}

pub(super) fn handle_left_mouse_click(
    column: u16,
    row: u16,
    app: &mut ReplApp,
) -> Option<UserAction> {
    let frame_area = app.last_frame_area?;
    let dialog_area = app.dialog_host_area().unwrap_or(frame_area);

    if let Some(index) = app
        .pending_permission
        .as_ref()
        .and_then(|dialog| permission_option_hit_index(dialog_area, dialog, column, row))
    {
        if let Some(dialog) = app.pending_permission.as_mut() {
            dialog.selected = index;
        }
        app.finish_permission_dialog_with_response(
            PERMISSION_OPTION_RESPONSES[index.min(PERMISSION_OPTION_RESPONSES.len() - 1)],
        );
        return None;
    }

    if app.pending_permission.is_some() || app.permission_editor.is_some() {
        return None;
    }

    if let Some(index) = app
        .pending_question
        .as_ref()
        .and_then(|dialog| question_option_hit_index(dialog_area, dialog, column, row))
    {
        if let Some(dialog) = app.pending_question.as_mut() {
            let multi_select = dialog.request.questions[dialog.focused].multi_select;
            set_question_dialog_cursor(dialog, index, Some(dialog_area), !multi_select);
            if multi_select {
                if dialog.selected.contains(&index) {
                    if dialog.selected.len() > 1 {
                        dialog.selected.retain(|selected| *selected != index);
                    }
                } else {
                    dialog.selected.push(index);
                    dialog.selected.sort_unstable();
                }
                question_dialog_clear_current_answer(dialog);
                question_dialog_save_current_state(dialog);
            }
        }
        return None;
    }

    if app.pending_question.is_some() {
        return None;
    }

    if app.pending_goal_replacement.is_some() {
        return None;
    }

    if app.history_search.is_some() {
        return None;
    }

    if let Some((entry_index, path)) = app.resume_session_picker.as_ref().and_then(|picker| {
        let area = app.transcript_viewport.transcript_area()?;
        if !rect_contains(area, column, row) {
            return None;
        }
        let row_offset = row.saturating_sub(area.y) as usize;
        let entry_index =
            resume_session_picker_hit_index(picker, usize::from(area.height), row_offset)?;
        let path = picker.entries.get(entry_index)?.path.clone();
        Some((entry_index, path))
    }) {
        if let Some(picker) = app.resume_session_picker.as_mut() {
            let matches = resume_session_picker_matches(picker);
            picker.selected = matches
                .iter()
                .position(|index| *index == entry_index)
                .unwrap_or(picker.selected);
        }
        app.close_resume_session_picker();
        return Some(UserAction::ResumeSession(path));
    }

    if app.resume_session_picker.is_some() {
        return None;
    }

    if let (Some(menu), Some(overlay_area)) =
        (app.slash_menu.as_ref(), app.last_bottom_overlay_area)
    {
        let matches_len = app.slash_menu_matches().len();
        if let Some(index) =
            slash_menu_hit_index(overlay_area, matches_len, menu.selected, column, row)
        {
            if let Some(menu) = app.slash_menu.as_mut() {
                menu.selected = index.min(matches_len.saturating_sub(1));
            }
            app.accept_slash_menu_selection(index);
            return None;
        }
    }

    if let Some((index, action)) = app.picker_overlay.as_ref().and_then(|picker| {
        let matches = picker.matches_indexed();
        let index = picker_hit_index_for(picker, frame_area, matches.len(), column, row)?;
        let (item_index, item) = matches.get(index).cloned()?;
        let value = picker.value_for_original_index(item_index, &item);
        let turn = picker.item_turns.get(item_index).copied();
        Some((index, (picker.on_confirm, value, turn)))
    }) {
        if let Some(picker) = app.picker_overlay.as_mut() {
            picker.selected = index;
        }
        app.close_picker_overlay();
        return match action {
            (PickerAction::ViewAgent, id, _) => {
                Some(UserAction::SlashCommand(format!("/agent view {id}")))
            }
            (PickerAction::SwitchModel, item, _) => {
                Some(UserAction::SlashCommand(format!("/model {}", item)))
            }
            (PickerAction::SwitchTheme, item, _) => {
                Some(UserAction::SlashCommand(format!("/theme {}", item)))
            }
            (PickerAction::RewindToTurn, _, turn) => {
                turn.map(|turn| UserAction::SlashCommand(format!("/rewind {turn}")))
            }
        };
    }

    if app.focus_composer_at_mouse(column, row) {
        return None;
    }

    None
}

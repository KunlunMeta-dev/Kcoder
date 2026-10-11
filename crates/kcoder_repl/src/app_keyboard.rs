//! Keyboard dispatch to composer, modals, and navigation.

use super::*;

impl ReplApp {
    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> Option<UserAction> {
        if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
            return None;
        }
        if self.copy_view.is_some() {
            self.handle_copy_key(key);
            return None;
        }
        if key.code == KeyCode::F(9) && key.modifiers.is_empty() {
            self.open_copy_view();
            return None;
        }
        if key.code == KeyCode::Esc
            && self.transcript_selection.is_some()
            && !self.has_active_overlay()
        {
            self.clear_transcript_selection();
            return None;
        }
        if key.code == KeyCode::Esc
            && !self.has_active_modal()
            && !self.outline_open
            && self.navigation.pending()
        {
            self.cancel_pending_navigation_for_input();
            return None;
        }

        if key.kind == KeyEventKind::Press && is_suspend_key(&key) {
            return Some(UserAction::Suspend);
        }
        if !matches!(key.code, KeyCode::Up | KeyCode::Down) {
            self.composer_preferred_col = None;
        }

        let altgr = key_hint::is_altgr(key.modifiers);
        let shortcut_overlay_key_code = key.code == KeyCode::Char('?')
            && matches!(key.modifiers, KeyModifiers::NONE | KeyModifiers::SHIFT);
        let shortcut_overlay_key = key.kind == KeyEventKind::Press && shortcut_overlay_key_code;
        let shortcut_overlay_repeat_key =
            key.kind == KeyEventKind::Repeat && shortcut_overlay_key_code;
        if self.footer_shortcuts_overlay {
            if shortcut_overlay_repeat_key {
                return None;
            }
            if shortcut_overlay_key && self.composer_is_empty_for_shortcuts() {
                self.toggle_footer_shortcuts_overlay();
                return None;
            }
            if key.code == KeyCode::Esc && key.modifiers.is_empty() {
                self.close_footer_shortcuts_overlay();
                self.show_edit_previous_hint();
                return None;
            }
        }

        let ctrl_c_quit = key_hint::ctrl(KeyCode::Char('c'));
        let is_interrupt_key = is_ctrl_c_key(&key);
        if is_interrupt_key && self.active_overlay.is_none() && self.copy_transcript_selection() {
            return None;
        }
        if is_interrupt_key {
            match self.active_overlay {
                Some(OverlayKind::Copy) => {
                    self.handle_copy_key(key);
                    return None;
                }
                Some(OverlayKind::Outline) => {
                    self.close_outline();
                    return None;
                }
                Some(OverlayKind::Permission) => {
                    return self
                        .handle_permission_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
                }
                Some(OverlayKind::PermissionEditor) => {
                    return self.handle_permission_editor_key(KeyEvent::new(
                        KeyCode::Esc,
                        KeyModifiers::NONE,
                    ));
                }
                Some(OverlayKind::Question) => {
                    return self
                        .handle_question_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
                }
                Some(OverlayKind::GoalReplacement) => {
                    return self.handle_goal_replacement_key(KeyEvent::new(
                        KeyCode::Esc,
                        KeyModifiers::NONE,
                    ));
                }
                Some(OverlayKind::HistorySearch) => {
                    self.handle_history_key(key);
                    return None;
                }
                Some(OverlayKind::ResumeSession) => {
                    return self.handle_resume_session_picker_key(key);
                }
                Some(OverlayKind::ContextInspector) => {
                    self.handle_context_inspector_key(key);
                    return None;
                }
                Some(OverlayKind::SettingsInspector) => {
                    self.handle_settings_inspector_key(key);
                    return None;
                }
                Some(OverlayKind::Keys) => {
                    self.handle_keys_overlay_key(key);
                    return None;
                }
                Some(OverlayKind::Transcript) => {
                    self.handle_transcript_overlay_key(key);
                    return None;
                }
                Some(OverlayKind::Picker) => return self.handle_picker_key(key),
                Some(OverlayKind::SideQuestion) => {
                    self.handle_side_question_key(key);
                    return None;
                }
                None => {}
            }
        }
        if is_interrupt_key {
            if !self.has_active_overlay() && self.composer_has_draft() {
                self.clear_composer_for_ctrl_c();
                self.clear_quit_shortcut();
                return None;
            }
            if let Some(action) = self.interrupt_current_turn() {
                if !DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED {
                    self.clear_quit_shortcut();
                }
                return Some(action);
            }
        }
        if key.code == KeyCode::Esc
            && key.modifiers.is_empty()
            && !self.has_active_overlay()
            && self.slash_menu.is_none()
            && self.leave_agent_view()
        {
            self.set_transient_status("Returned to parent conversation");
            return None;
        }
        let is_escape_interrupt =
            key.code == KeyCode::Esc && !self.has_active_overlay() && self.slash_menu.is_none();
        if is_escape_interrupt && let Some(action) = self.interrupt_current_turn() {
            return Some(action);
        }

        let is_quit_shortcut_key = ctrl_c_quit.is_press(key);
        let is_edit_previous_key = key.code == KeyCode::Esc && key.modifiers.is_empty();
        if is_edit_previous_key && self.active_quit_shortcut_key().is_some() {
            self.clear_quit_shortcut();
            self.show_edit_previous_hint();
            return None;
        }
        if !is_quit_shortcut_key {
            self.clear_quit_shortcut();
        }
        if !is_edit_previous_key && !shortcut_overlay_key {
            self.clear_edit_previous_prompt();
        }

        // Permission dialog takes precedence over all other input.
        if self.pending_permission.is_some() {
            return self.handle_permission_key(key);
        }

        // Permission input editor overlay.
        if self.permission_editor.is_some() {
            return self.handle_permission_editor_key(key);
        }

        // User question dialog overlay.
        if self.pending_question.is_some() {
            return self.handle_question_key(key);
        }

        // Local `/goal` replacement confirmation dialog.
        if self.pending_goal_replacement.is_some() {
            return self.handle_goal_replacement_key(key);
        }

        if self.handle_outline_key(key) {
            return None;
        }

        // Full transcript overlay takes precedence over normal input.
        if self.transcript_overlay.is_some() {
            self.handle_transcript_overlay_key(key);
            return None;
        }

        if self.side_question_overlay.is_some() {
            self.handle_side_question_key(key);
            return None;
        }

        // History search overlay takes precedence over normal input.
        if self.history_search.is_some() {
            self.handle_history_key(key);
            return None;
        }

        // Previous-session picker lives in the committed transcript area.
        if self.resume_session_picker.is_some() {
            return self.handle_resume_session_picker_key(key);
        }

        if let Some(menu) = self.mention_menu.as_mut() {
            match key.code {
                KeyCode::Up => {
                    menu.selected = menu.selected.saturating_sub(1);
                    return None;
                }
                KeyCode::Down => {
                    menu.selected = (menu.selected + 1).min(menu.candidates.len() - 1);
                    return None;
                }
                KeyCode::Tab | KeyCode::Enter => {
                    self.accept_mention_selection();
                    return None;
                }
                KeyCode::Esc => {
                    self.mention_menu = None;
                    return None;
                }
                _ => {}
            }
        }

        // Slash command menu takes precedence for navigation/acceptance keys.
        if self.slash_menu.is_some() && key.code == KeyCode::Enter && key.modifiers.is_empty() {
            if !self.slash_menu_can_accept_selection() {
                self.close_slash_menu();
            } else {
                let selected = self
                    .slash_menu
                    .as_ref()
                    .map(|menu| menu.selected)
                    .unwrap_or(0);
                return self.submit_slash_menu_selection(selected);
            }
        }
        if self.slash_menu.is_some() && key.code == KeyCode::Tab {
            if !self.slash_menu_can_accept_selection() {
                self.close_slash_menu();
            } else {
                let selected = self
                    .slash_menu
                    .as_ref()
                    .map(|menu| menu.selected)
                    .unwrap_or(0);
                self.accept_slash_menu_selection(selected);
                return None;
            }
        }
        if self.slash_menu.is_some() && self.handle_slash_menu_key(key) {
            return None;
        }

        // Context inspector overlay.
        if self.context_inspector.is_some() {
            self.handle_context_inspector_key(key);
            return None;
        }

        // Settings inspector overlay.
        if self.settings_inspector.is_some() {
            self.handle_settings_inspector_key(key);
            return None;
        }

        // Keyboard shortcuts overlay.
        if self.keys_overlay.is_some() {
            self.handle_keys_overlay_key(key);
            return None;
        }

        // Generic picker overlay.
        if self.picker_overlay.is_some() {
            return self.handle_picker_key(key);
        }

        if self.handle_remote_image_selection_key(key) {
            return None;
        }
        self.clear_remote_image_selection();

        if is_clipboard_image_paste_key(&key) {
            return Some(UserAction::PasteClipboardImage);
        }

        if shortcut_overlay_key && self.composer_is_empty_for_shortcuts() {
            self.toggle_footer_shortcuts_overlay();
            return None;
        }
        self.close_footer_shortcuts_overlay();

        if self.enter_slash_menu_if_requested(key) {
            return None;
        }
        if self.enter_shell_prompt_mode_if_requested(key) {
            return None;
        }

        let edit_queued_message_key = !altgr
            && ((key.code == KeyCode::Up && key.modifiers == KeyModifiers::ALT)
                || (key.code == KeyCode::Left && key.modifiers == KeyModifiers::SHIFT));
        if edit_queued_message_key && self.restore_latest_queued_message_for_edit() {
            return None;
        }

        if is_tool_transcript_toggle_shortcut(&key) {
            self.toggle_tool_transcript_expanded();
            return None;
        }

        if is_transcript_overlay_shortcut(&key) {
            self.open_transcript_overlay();
            return None;
        }

        if !altgr && key.modifiers.contains(KeyModifiers::ALT) {
            match key.code {
                KeyCode::Char(',') => {
                    return Some(UserAction::AdjustReasoning(
                        ReasoningShortcutDirection::Lower,
                    ));
                }
                KeyCode::Char('.') => {
                    return Some(UserAction::AdjustReasoning(
                        ReasoningShortcutDirection::Raise,
                    ));
                }
                _ => {}
            }
        }

        match key.code {
            _ if is_interrupt_key => {
                return if DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED {
                    self.handle_quit_shortcut(ctrl_c_quit)
                } else {
                    self.clear_quit_shortcut();
                    Some(UserAction::Quit)
                };
            }
            KeyCode::Char('d') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                if self.input.is_empty() {
                    return Some(UserAction::Quit);
                }
                let graphemes = self.input_graphemes();
                let idx = self.cursor_grapheme_index.min(graphemes.len());
                if idx < graphemes.len() {
                    self.reset_input_history_navigation();
                    let start = self.byte_index_for_grapheme(idx);
                    let end = self.byte_index_for_grapheme(idx + 1);
                    self.input.replace_range(start..end, "");
                    self.sync_composer_sidecars();
                }
                return None;
            }
            KeyCode::Char('q') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                return Some(UserAction::Quit);
            }
            KeyCode::Char('r') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                self.open_history_search();
                return None;
            }
            KeyCode::Char('g') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                return Some(UserAction::OpenExternalEditor);
            }
            KeyCode::Char('l') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                if self.has_interruptible_turn() {
                    self.push_message(
                        MessageRole::System,
                        "Ctrl+L is disabled while a task is in progress.",
                    );
                    return None;
                }
                return Some(UserAction::ClearUi);
            }
            KeyCode::Char('o') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                return Some(UserAction::CopyLastResponse);
            }
            KeyCode::Char(c)
                if key.modifiers.contains(KeyModifiers::ALT)
                    && !altgr
                    && c.eq_ignore_ascii_case(&'r') =>
            {
                return Some(UserAction::ToggleRawOutput);
            }
            KeyCode::Char(c)
                if key.modifiers.contains(KeyModifiers::ALT)
                    && !altgr
                    && c.eq_ignore_ascii_case(&'b') =>
            {
                self.cursor_grapheme_index = self.beginning_of_previous_word();
                self.clamp_input_scroll(self.last_input_width);
                return None;
            }
            KeyCode::Char(c)
                if key.modifiers.contains(KeyModifiers::ALT)
                    && !altgr
                    && c.eq_ignore_ascii_case(&'f') =>
            {
                self.cursor_grapheme_index = self.end_of_next_word();
                self.clamp_input_scroll(self.last_input_width);
                return None;
            }
            KeyCode::Char(c)
                if key.modifiers.contains(KeyModifiers::ALT)
                    && !altgr
                    && c.eq_ignore_ascii_case(&'d') =>
            {
                let start = self.cursor_grapheme_index;
                let end = self.end_of_next_word();
                self.kill_input_range(start, end);
                return None;
            }
            KeyCode::Char(c)
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.modifiers.contains(KeyModifiers::ALT)
                    && !altgr
                    && c.eq_ignore_ascii_case(&'h') =>
            {
                let start = self.beginning_of_previous_word();
                let end = self.cursor_grapheme_index;
                self.kill_input_range(start, end);
                return None;
            }
            KeyCode::Char(c)
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && !altgr
                    && c.eq_ignore_ascii_case(&'w') =>
            {
                let start = self.beginning_of_previous_word();
                let end = self.cursor_grapheme_index;
                self.kill_input_range(start, end);
                return None;
            }
            KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                self.move_cursor_to_beginning_of_current_line(true);
                return None;
            }
            KeyCode::Char('e') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                self.move_cursor_to_end_of_current_line(true);
                return None;
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                self.kill_to_beginning_of_current_line();
                return None;
            }
            KeyCode::Char('k') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                self.kill_to_end_of_current_line();
                return None;
            }
            KeyCode::Char('y') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                self.yank_composer_kill_buffer();
                return None;
            }
            KeyCode::Char('h') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                if self.cursor_grapheme_index > 0 {
                    self.reset_input_history_navigation();
                    let start = self.byte_index_for_grapheme(self.cursor_grapheme_index - 1);
                    let end = self.byte_index_for_grapheme(self.cursor_grapheme_index);
                    self.input.replace_range(start..end, "");
                    self.cursor_grapheme_index -= 1;
                    self.sync_composer_sidecars();
                    self.clamp_input_scroll(self.last_input_width);
                }
                return None;
            }
            KeyCode::Char('b') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                if self.cursor_grapheme_index > 0 {
                    self.cursor_grapheme_index -= 1;
                    self.clamp_input_scroll(self.last_input_width);
                }
                return None;
            }
            KeyCode::Char('f') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                let graphemes = self.input_graphemes();
                if self.cursor_grapheme_index < graphemes.len() {
                    self.cursor_grapheme_index += 1;
                    self.clamp_input_scroll(self.last_input_width);
                }
                return None;
            }
            KeyCode::Char('p') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                if self.input_history_index.is_some() {
                    self.recall_previous_input();
                } else if self.can_move_cursor_vertical(self.last_input_width, -1) {
                    self.move_cursor_vertical(self.last_input_width, -1);
                } else if self.recall_previous_input() {
                    // History recall consumed the key.
                } else {
                    self.scroll_transcript_lines(-TRANSCRIPT_SCROLL_LINES);
                }
                return None;
            }
            KeyCode::Char('n') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                if self.input_history_index.is_some() {
                    self.recall_next_input();
                } else if self.can_move_cursor_vertical(self.last_input_width, 1) {
                    self.move_cursor_vertical(self.last_input_width, 1);
                } else if self.recall_next_input() {
                    // History recall consumed the key.
                } else {
                    self.scroll_transcript_lines(TRANSCRIPT_SCROLL_LINES);
                }
                return None;
            }
            KeyCode::Char(c)
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && !altgr
                    && (c.eq_ignore_ascii_case(&'j') || c.eq_ignore_ascii_case(&'m')) =>
            {
                self.insert_newline_at_cursor();
                return None;
            }
            KeyCode::Backspace
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    || key.modifiers.contains(KeyModifiers::ALT) =>
            {
                let start = self.beginning_of_previous_word();
                let end = self.cursor_grapheme_index;
                self.kill_input_range(start, end);
                return None;
            }
            KeyCode::Delete
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    || key.modifiers.contains(KeyModifiers::ALT) =>
            {
                let start = self.cursor_grapheme_index;
                let end = self.end_of_next_word();
                self.kill_input_range(start, end);
                return None;
            }
            KeyCode::Left
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    || key.modifiers.contains(KeyModifiers::ALT) =>
            {
                self.cursor_grapheme_index = self.beginning_of_previous_word();
                self.clamp_input_scroll(self.last_input_width);
                return None;
            }
            KeyCode::Right
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    || key.modifiers.contains(KeyModifiers::ALT) =>
            {
                self.cursor_grapheme_index = self.end_of_next_word();
                self.clamp_input_scroll(self.last_input_width);
                return None;
            }
            KeyCode::Up if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.recall_previous_input();
                return None;
            }
            KeyCode::Down if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.recall_next_input();
                return None;
            }
            KeyCode::Esc => {
                if matches!(shell_prompt_display_text(&self.input), Some("")) {
                    self.reset_input_history_navigation();
                    self.input.clear();
                    self.cursor_grapheme_index = 0;
                    self.input_scroll_row = 0;
                    self.force_next_viewport_redraw();
                    return None;
                }
                return self.handle_edit_previous_escape();
            }
            KeyCode::Enter | KeyCode::Char('\n' | '\r') => {
                if key.modifiers.contains(KeyModifiers::SHIFT)
                    || key.modifiers.contains(KeyModifiers::ALT)
                {
                    self.insert_newline_at_cursor();
                    return None;
                }
                if let Some(action) = self.submit_composer_input() {
                    return Some(action);
                }
            }
            KeyCode::BackTab => {
                let command = if self.plan_mode.is_some() {
                    "/unplan"
                } else {
                    "/plan"
                };
                return Some(UserAction::SlashCommand(command.to_string()));
            }
            KeyCode::Tab => {
                if shell_command_from_prompt(&self.input).is_some()
                    && !self.has_interruptible_turn()
                {
                    return None;
                }
                if let Some(action) = self.submit_composer_input() {
                    return Some(action);
                }
            }
            KeyCode::Char(c)
                if (!key.modifiers.contains(KeyModifiers::CONTROL)
                    && !key.modifiers.contains(KeyModifiers::ALT)
                    || altgr)
                    && !c.is_ascii_control() =>
            {
                let mut text = String::new();
                text.push(c);
                self.insert_text_at_cursor(&text);
                self.sync_composer_sidecars();
            }
            KeyCode::Backspace if self.cursor_grapheme_index > 0 => {
                self.reset_input_history_navigation();
                let start = self.byte_index_for_grapheme(self.cursor_grapheme_index - 1);
                let end = self.byte_index_for_grapheme(self.cursor_grapheme_index);
                self.input.replace_range(start..end, "");
                self.cursor_grapheme_index -= 1;
                self.sync_composer_sidecars();
                self.clamp_input_scroll(self.last_input_width);
            }
            KeyCode::Delete => {
                let graphemes = self.input_graphemes();
                let idx = self.cursor_grapheme_index.min(graphemes.len());
                if idx < graphemes.len() {
                    self.reset_input_history_navigation();
                    let start = self.byte_index_for_grapheme(idx);
                    let end = self.byte_index_for_grapheme(idx + 1);
                    self.input.replace_range(start..end, "");
                    self.sync_composer_sidecars();
                }
            }
            KeyCode::Left if self.cursor_grapheme_index > 0 => {
                self.cursor_grapheme_index -= 1;
                self.clamp_input_scroll(self.last_input_width);
            }
            KeyCode::Right => {
                let graphemes = self.input_graphemes();
                if self.cursor_grapheme_index < graphemes.len() {
                    self.cursor_grapheme_index += 1;
                    self.clamp_input_scroll(self.last_input_width);
                }
            }
            KeyCode::Up => {
                if self.input_history_index.is_some() {
                    self.recall_previous_input();
                } else if self.can_move_cursor_vertical(self.last_input_width, -1) {
                    self.move_cursor_vertical(self.last_input_width, -1);
                } else if self.recall_previous_input() {
                    // History recall consumed the key.
                } else {
                    self.scroll_transcript_lines(-TRANSCRIPT_SCROLL_LINES);
                }
            }
            KeyCode::Down => {
                if self.input_history_index.is_some() {
                    self.recall_next_input();
                } else if self.can_move_cursor_vertical(self.last_input_width, 1) {
                    self.move_cursor_vertical(self.last_input_width, 1);
                } else if self.recall_next_input() {
                    // History recall consumed the key.
                } else {
                    self.scroll_transcript_lines(TRANSCRIPT_SCROLL_LINES);
                }
            }
            KeyCode::Home => {
                self.move_cursor_to_beginning_of_current_line(false);
            }
            KeyCode::End => {
                if self.composer_is_empty_for_shortcuts() && !self.transcript_viewport.is_at_tail()
                {
                    self.snap_to_bottom();
                    self.force_next_viewport_redraw();
                } else {
                    self.move_cursor_to_end_of_current_line(false);
                }
            }
            KeyCode::PageUp => {
                let page = self.transcript_viewport.viewport_rows().max(1) as i32;
                self.scroll_transcript_lines(-page);
            }
            KeyCode::PageDown => {
                let page = self.transcript_viewport.viewport_rows().max(1) as i32;
                self.transcript_viewport.scroll_lines(page);
            }
            _ => {}
        }
        None
    }
}

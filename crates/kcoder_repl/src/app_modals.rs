//! Resume picker, permission/question queues, interruption, and goal replacement.

use super::*;

impl ReplApp {
    pub(super) fn close_resume_session_picker(&mut self) {
        self.resume_session_picker = None;
        self.close_overlay_state(OverlayKind::ResumeSession);
        self.force_next_viewport_redraw();
    }

    pub(super) fn resume_session_picker_selected_path(&self) -> Option<PathBuf> {
        let picker = self.resume_session_picker.as_ref()?;
        let matches = resume_session_picker_matches(picker);
        let selected = picker.selected.min(matches.len().saturating_sub(1));
        let entry_index = *matches.get(selected)?;
        Some(picker.entries[entry_index].path.clone())
    }

    pub(super) fn resume_session_picker_page_step(&self) -> usize {
        self.transcript_viewport
            .viewport_rows()
            .saturating_sub(RESUME_SESSION_PICKER_HEADER_LINES + RESUME_SESSION_PICKER_FOOTER_LINES)
            .max(1)
    }

    pub(super) fn handle_resume_session_picker_key(&mut self, key: KeyEvent) -> Option<UserAction> {
        if is_ctrl_c_key(&key) {
            self.close_resume_session_picker();
            return None;
        }

        let altgr = key_hint::is_altgr(key.modifiers);
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL) && !altgr;
        let alt = key.modifiers.contains(KeyModifiers::ALT) && !altgr;

        match key.code {
            KeyCode::Esc => {
                self.close_resume_session_picker();
                None
            }
            KeyCode::Enter => {
                let path = self.resume_session_picker_selected_path();
                self.close_resume_session_picker();
                path.map(UserAction::ResumeSession)
            }
            KeyCode::Up | KeyCode::Char('p') if matches!(key.code, KeyCode::Up) || ctrl => {
                if let Some(picker) = self.resume_session_picker.as_mut() {
                    picker.selected = picker.selected.saturating_sub(1);
                }
                None
            }
            KeyCode::Down | KeyCode::Char('n') if matches!(key.code, KeyCode::Down) || ctrl => {
                if let Some(picker) = self.resume_session_picker.as_mut() {
                    let matches_len = resume_session_picker_matches(picker).len();
                    picker.selected = picker
                        .selected
                        .saturating_add(1)
                        .min(matches_len.saturating_sub(1));
                }
                None
            }
            KeyCode::Home => {
                if let Some(picker) = self.resume_session_picker.as_mut() {
                    picker.selected = 0;
                }
                None
            }
            KeyCode::End => {
                if let Some(picker) = self.resume_session_picker.as_mut() {
                    picker.selected = resume_session_picker_matches(picker)
                        .len()
                        .saturating_sub(1);
                }
                None
            }
            KeyCode::PageUp => {
                let step = self.resume_session_picker_page_step();
                if let Some(picker) = self.resume_session_picker.as_mut() {
                    picker.selected = picker.selected.saturating_sub(step);
                }
                None
            }
            KeyCode::PageDown => {
                let step = self.resume_session_picker_page_step();
                if let Some(picker) = self.resume_session_picker.as_mut() {
                    let matches_len = resume_session_picker_matches(picker).len();
                    picker.selected = picker
                        .selected
                        .saturating_add(step)
                        .min(matches_len.saturating_sub(1));
                }
                None
            }
            KeyCode::Backspace => {
                if let Some(picker) = self.resume_session_picker.as_mut()
                    && !picker.filter.is_empty()
                {
                    picker.filter.pop();
                    picker.selected = 0;
                }
                None
            }
            KeyCode::Char(c) if (!ctrl && !alt || altgr) && !c.is_ascii_control() => {
                if let Some(picker) = self.resume_session_picker.as_mut() {
                    picker.filter.push(c);
                    picker.selected = 0;
                }
                None
            }
            _ => None,
        }
    }

    pub(super) fn finish_permission_dialog_with_response(&mut self, response: PermissionResponse) {
        let dialog = self.pending_permission.take().unwrap();
        self.close_overlay_state(OverlayKind::Permission);
        if response == PermissionResponse::Edit {
            self.open_permission_editor(dialog);
        } else {
            let _ = dialog.response_tx.send(PermissionDialogResult {
                response,
                modified_input: None,
            });
            self.activate_next_modal_or_resume_spinner();
        }
    }

    pub(super) fn handle_permission_key(&mut self, key: KeyEvent) -> Option<UserAction> {
        match key.code {
            KeyCode::Left | KeyCode::Up if key.modifiers.is_empty() => {
                let dialog = self.pending_permission.as_mut().unwrap();
                dialog.selected = dialog.selected.saturating_sub(1);
            }
            KeyCode::Right | KeyCode::Down if key.modifiers.is_empty() => {
                let dialog = self.pending_permission.as_mut().unwrap();
                if dialog.selected + 1 < PERMISSION_OPTION_RESPONSES.len() {
                    dialog.selected += 1;
                }
            }
            KeyCode::Home if key.modifiers.is_empty() => {
                let dialog = self.pending_permission.as_mut().unwrap();
                dialog.selected = 0;
            }
            KeyCode::End if key.modifiers.is_empty() => {
                let dialog = self.pending_permission.as_mut().unwrap();
                dialog.selected = PERMISSION_OPTION_RESPONSES.len().saturating_sub(1);
            }
            KeyCode::Enter if key.modifiers.is_empty() => {
                let selected = self
                    .pending_permission
                    .as_ref()
                    .map(|dialog| dialog.selected)
                    .unwrap_or(0);
                self.finish_permission_dialog_with_response(
                    PERMISSION_OPTION_RESPONSES
                        [selected.min(PERMISSION_OPTION_RESPONSES.len() - 1)],
                );
            }
            KeyCode::Char(c)
                if matches!(key.modifiers, KeyModifiers::NONE | KeyModifiers::SHIFT) =>
            {
                let c = c.to_ascii_lowercase();
                let response = match c {
                    'y' => Some(PermissionResponse::AllowOnce),
                    'a' => Some(PermissionResponse::AllowAlways),
                    's' => Some(PermissionResponse::AllowForSession),
                    'n' | 'd' => Some(PermissionResponse::DenyOnce),
                    'e' => Some(PermissionResponse::Edit),
                    '1'..='7' => c.to_digit(10).and_then(|digit| {
                        PERMISSION_OPTION_RESPONSES.get(digit as usize - 1).copied()
                    }),
                    _ => None,
                };
                if let Some(response) = response {
                    self.finish_permission_dialog_with_response(response);
                }
            }
            KeyCode::Esc if key.modifiers.is_empty() => {
                let dialog = self.pending_permission.take().unwrap();
                let _ = dialog.response_tx.send(PermissionDialogResult {
                    response: PermissionResponse::DenyOnce,
                    modified_input: None,
                });
                self.close_overlay_state(OverlayKind::Permission);
                self.activate_next_modal_or_resume_spinner();
            }
            _ => {}
        }
        None
    }

    pub(super) fn has_active_modal(&self) -> bool {
        matches!(
            self.active_overlay,
            Some(
                OverlayKind::Permission
                    | OverlayKind::PermissionEditor
                    | OverlayKind::Question
                    | OverlayKind::GoalReplacement
            )
        )
    }

    pub(super) fn overlay_payload_kinds(&self) -> Vec<OverlayKind> {
        let mut kinds = Vec::new();
        if self.pending_permission.is_some() {
            kinds.push(OverlayKind::Permission);
        }
        if self.permission_editor.is_some() {
            kinds.push(OverlayKind::PermissionEditor);
        }
        if self.pending_question.is_some() {
            kinds.push(OverlayKind::Question);
        }
        if self.pending_goal_replacement.is_some() {
            kinds.push(OverlayKind::GoalReplacement);
        }
        if self.history_search.is_some() {
            kinds.push(OverlayKind::HistorySearch);
        }
        if self.resume_session_picker.is_some() {
            kinds.push(OverlayKind::ResumeSession);
        }
        if self.context_inspector.is_some() {
            kinds.push(OverlayKind::ContextInspector);
        }
        if self.settings_inspector.is_some() {
            kinds.push(OverlayKind::SettingsInspector);
        }
        if self.keys_overlay.is_some() {
            kinds.push(OverlayKind::Keys);
        }
        if self.transcript_overlay.is_some() {
            kinds.push(OverlayKind::Transcript);
        }
        if self.copy_view.is_some() {
            kinds.push(OverlayKind::Copy);
        }
        if self.outline_open {
            kinds.push(OverlayKind::Outline);
        }
        if self.picker_overlay.is_some() {
            kinds.push(OverlayKind::Picker);
        }
        if self.side_question_overlay.is_some() {
            kinds.push(OverlayKind::SideQuestion);
        }
        kinds
    }

    pub(super) fn active_overlay_kinds(&self) -> Vec<OverlayKind> {
        self.active_overlay.into_iter().collect()
    }

    pub(super) fn has_active_overlay(&self) -> bool {
        self.active_overlay.is_some()
    }

    pub(super) fn assert_overlay_state_consistent(&self) {
        debug_assert_eq!(self.active_overlay_kinds(), self.overlay_payload_kinds());
    }

    pub(super) fn open_overlay_state(&mut self, kind: OverlayKind) {
        debug_assert!(self.active_overlay.is_none());
        self.active_overlay = Some(kind);
        self.assert_overlay_state_consistent();
    }

    pub(super) fn close_overlay_state(&mut self, kind: OverlayKind) {
        if self.active_overlay == Some(kind) {
            self.active_overlay = None;
        }
        self.assert_overlay_state_consistent();
    }

    pub(super) fn close_nonblocking_overlays(&mut self) {
        self.navigation.cancel_heading_work();
        self.outline_open = false;
        self.outline_geometry = None;
        self.outline_press = None;
        self.history_search = None;
        self.resume_session_picker = None;
        self.context_inspector = None;
        self.settings_inspector = None;
        self.keys_overlay = None;
        self.footer_shortcuts_overlay = false;
        self.transcript_overlay = None;
        self.copy_view = None;
        self.picker_overlay = None;
        if let Some(overlay) = self.side_question_overlay.take() {
            overlay.cancel.cancel();
        }
        if matches!(
            self.active_overlay,
            Some(
                OverlayKind::HistorySearch
                    | OverlayKind::ResumeSession
                    | OverlayKind::ContextInspector
                    | OverlayKind::SettingsInspector
                    | OverlayKind::Keys
                    | OverlayKind::Transcript
                    | OverlayKind::Outline
                    | OverlayKind::Copy
                    | OverlayKind::Picker
                    | OverlayKind::SideQuestion
            )
        ) {
            self.active_overlay = None;
        }
        self.assert_overlay_state_consistent();
    }

    pub(super) fn open_side_question(
        &mut self,
        question: String,
    ) -> Option<(u64, CancellationToken)> {
        if !self.prepare_nonblocking_overlay() {
            return None;
        }
        self.side_question_sequence = self.side_question_sequence.wrapping_add(1).max(1);
        let id = self.side_question_sequence;
        let cancel = CancellationToken::new();
        self.side_question_overlay = Some(SideQuestionOverlay {
            id,
            question,
            status: SideQuestionStatus::Loading,
            scroll: 0,
            cancel: cancel.clone(),
            started_at: Instant::now(),
        });
        self.open_overlay_state(OverlayKind::SideQuestion);
        Some((id, cancel))
    }

    pub(super) fn handle_side_question_key(&mut self, key: KeyEvent) {
        let Some(overlay) = self.side_question_overlay.as_mut() else {
            return;
        };
        match key.code {
            KeyCode::Esc | KeyCode::Enter | KeyCode::Char(' ') if key.modifiers.is_empty() => {
                overlay.cancel.cancel();
                self.side_question_overlay = None;
                self.close_overlay_state(OverlayKind::SideQuestion);
            }
            KeyCode::Up => overlay.scroll = overlay.scroll.saturating_sub(1),
            KeyCode::Down => overlay.scroll = overlay.scroll.saturating_add(1),
            KeyCode::PageUp => overlay.scroll = overlay.scroll.saturating_sub(8),
            KeyCode::PageDown => overlay.scroll = overlay.scroll.saturating_add(8),
            _ => {}
        }
    }

    pub(super) fn prepare_blocking_modal(&mut self) {
        self.close_slash_menu();
        self.close_nonblocking_overlays();
    }

    pub(super) fn prepare_nonblocking_overlay(&mut self) -> bool {
        if self.has_active_modal() {
            return false;
        }
        self.close_slash_menu();
        self.close_nonblocking_overlays();
        true
    }

    pub(super) fn enqueue_permission_dialog(&mut self, dialog: PermissionDialog) {
        self.spinner.pause();
        if self.has_active_modal() {
            self.permission_queue.push_back(dialog);
        } else {
            self.prepare_blocking_modal();
            self.pending_permission = Some(dialog);
            self.open_overlay_state(OverlayKind::Permission);
        }
    }

    pub(super) fn enqueue_question_dialog(&mut self, dialog: QuestionDialog) {
        self.spinner.pause();
        if self.has_active_modal() {
            self.question_queue.push_back(dialog);
        } else {
            self.prepare_blocking_modal();
            self.pending_question = Some(dialog);
            self.open_overlay_state(OverlayKind::Question);
        }
    }

    pub(super) fn activate_next_modal_or_resume_spinner(&mut self) {
        if self.has_active_modal() {
            return;
        }
        if let Some(dialog) = self.permission_queue.pop_front() {
            self.prepare_blocking_modal();
            self.pending_permission = Some(dialog);
            self.open_overlay_state(OverlayKind::Permission);
            self.spinner.pause();
        } else if let Some(dialog) = self.question_queue.pop_front() {
            self.prepare_blocking_modal();
            self.pending_question = Some(dialog);
            self.open_overlay_state(OverlayKind::Question);
            self.spinner.pause();
        } else {
            self.spinner.resume();
        }
    }

    pub(super) fn has_interruptible_turn(&self) -> bool {
        self.turn_state.is_active() || self.is_loading || self.spinner.is_running()
    }

    pub(super) fn has_active_goal(&self) -> bool {
        self.goal
            .as_ref()
            .is_some_and(|goal| goal.status == GoalStatus::Active)
    }

    pub(super) fn deny_permission_dialog(dialog: PermissionDialog) {
        let _ = dialog.response_tx.send(PermissionDialogResult {
            response: PermissionResponse::DenyOnce,
            modified_input: None,
        });
    }

    pub(super) fn cancel_question_dialog(dialog: QuestionDialog) {
        let _ = dialog.response_tx.send(UserQuestionResponse {
            questions: dialog.request.questions,
            answers: dialog.request.answers,
            annotations: dialog.request.annotations,
        });
    }

    pub(super) fn cancel_blocking_modals(&mut self) {
        if let Some(dialog) = self.pending_permission.take() {
            Self::deny_permission_dialog(dialog);
            self.close_overlay_state(OverlayKind::Permission);
        }
        if let Some(editor) = self.permission_editor.take() {
            let _ = editor.response_tx.send(PermissionDialogResult {
                response: PermissionResponse::DenyOnce,
                modified_input: None,
            });
            self.close_overlay_state(OverlayKind::PermissionEditor);
        }
        while let Some(dialog) = self.permission_queue.pop_front() {
            Self::deny_permission_dialog(dialog);
        }
        if let Some(dialog) = self.pending_question.take() {
            Self::cancel_question_dialog(dialog);
            self.close_overlay_state(OverlayKind::Question);
        }
        if self.pending_goal_replacement.take().is_some() {
            self.close_overlay_state(OverlayKind::GoalReplacement);
        }
        while let Some(dialog) = self.question_queue.pop_front() {
            Self::cancel_question_dialog(dialog);
        }
    }

    pub(super) fn interrupt_current_turn(&mut self) -> Option<UserAction> {
        if self.deferred_turn_finish_pending
            && !self.turn_state.is_active()
            && !self.has_active_goal()
        {
            self.clear_quit_shortcut();
            self.cancel_blocking_modals();
            return Some(UserAction::CompleteDeferredTurn);
        }
        let has_interruptible_turn = self.has_interruptible_turn();
        if !has_interruptible_turn && !self.has_active_goal() {
            return None;
        }
        self.clear_quit_shortcut();
        if has_interruptible_turn {
            // Escape while a wait-style tool (Sleep, wait) is running collapses
            // its remaining wait to a short grace period instead of cancelling
            // the turn: the tool still returns normally, so the model can
            // continue with fresh results after a stale time estimate.
            if self
                .active_turn
                .as_ref()
                .is_some_and(|active| active.has_running_shortenable_tool())
            {
                self.set_transient_status("Shortened the wait to 0.5s");
                return Some(UserAction::ShortenToolWait);
            }
            self.path_previews.clear();
            let was_already_cancelled = self
                .turn_state
                .cancel_flag()
                .map(|cancel| {
                    let was_cancelled = cancel.is_cancelled();
                    cancel.cancel();
                    was_cancelled
                })
                .unwrap_or(false);
            self.cancel_blocking_modals();
            self.set_loading(false);
            self.flush_active_turn();
            if let Some(handle) = self.take_deferred_turn_finish_handle() {
                await_turn_task_for_logging(handle);
            }
            if !was_already_cancelled {
                self.push_message(MessageRole::System, "Cancelled.".to_string());
            }
        }
        Some(UserAction::Interrupt)
    }

    pub(super) fn open_permission_editor(&mut self, dialog: PermissionDialog) {
        self.prepare_blocking_modal();
        let text = serde_json::to_string_pretty(&dialog.input)
            .unwrap_or_else(|_| dialog.input.to_string());
        self.permission_editor = Some(PermissionEditor {
            tool_name: dialog.tool_name,
            text,
            cursor_grapheme_index: 0,
            response_tx: dialog.response_tx,
        });
        self.open_overlay_state(OverlayKind::PermissionEditor);
    }

    pub(super) fn close_permission_editor(&mut self, result: PermissionDialogResult) {
        if let Some(editor) = self.permission_editor.take() {
            let _ = editor.response_tx.send(result);
            self.close_overlay_state(OverlayKind::PermissionEditor);
        }
        self.activate_next_modal_or_resume_spinner();
    }

    pub(super) fn handle_permission_editor_key(&mut self, key: KeyEvent) -> Option<UserAction> {
        let editor = self.permission_editor.as_mut()?;
        match key.code {
            KeyCode::Esc => {
                self.close_permission_editor(PermissionDialogResult {
                    response: PermissionResponse::DenyOnce,
                    modified_input: None,
                });
            }
            KeyCode::Enter if key.modifiers == KeyModifiers::CONTROL => {
                let editor = self.permission_editor.take().unwrap();
                let result = match serde_json::from_str::<serde_json::Value>(&editor.text) {
                    Ok(input) => PermissionDialogResult {
                        response: PermissionResponse::AllowOnce,
                        modified_input: Some(input),
                    },
                    Err(e) => {
                        self.push_message(
                            MessageRole::System,
                            format!("Invalid JSON in edited tool input: {}", e),
                        );
                        PermissionDialogResult {
                            response: PermissionResponse::DenyOnce,
                            modified_input: None,
                        }
                    }
                };
                let _ = editor.response_tx.send(result);
                self.close_overlay_state(OverlayKind::PermissionEditor);
                self.activate_next_modal_or_resume_spinner();
            }
            KeyCode::Char(c) if !key_hint::has_ctrl_or_alt(key.modifiers) => {
                let byte_pos = byte_index_for_grapheme(&editor.text, editor.cursor_grapheme_index);
                editor.text.insert(byte_pos, c);
                editor.cursor_grapheme_index += 1;
            }
            KeyCode::Backspace if editor.cursor_grapheme_index > 0 => {
                let start = byte_index_for_grapheme(&editor.text, editor.cursor_grapheme_index - 1);
                let end = byte_index_for_grapheme(&editor.text, editor.cursor_grapheme_index);
                editor.text.replace_range(start..end, "");
                editor.cursor_grapheme_index -= 1;
            }
            KeyCode::Delete => {
                let graphemes = editor.text.graphemes(true).collect::<Vec<_>>();
                let idx = editor.cursor_grapheme_index.min(graphemes.len());
                if idx < graphemes.len() {
                    let start = byte_index_for_grapheme(&editor.text, idx);
                    let end = byte_index_for_grapheme(&editor.text, idx + 1);
                    editor.text.replace_range(start..end, "");
                }
            }
            KeyCode::Left if editor.cursor_grapheme_index > 0 => {
                editor.cursor_grapheme_index -= 1;
            }
            KeyCode::Right => {
                let len = editor.text.graphemes(true).count();
                if editor.cursor_grapheme_index < len {
                    editor.cursor_grapheme_index += 1;
                }
            }
            KeyCode::Home => {
                editor.cursor_grapheme_index = 0;
            }
            KeyCode::End => {
                editor.cursor_grapheme_index = editor.text.graphemes(true).count();
            }
            _ => {}
        }
        None
    }

    pub(super) fn handle_question_key(&mut self, key: KeyEvent) -> Option<UserAction> {
        let area = self.last_frame_area;
        let dialog = self.pending_question.as_mut().unwrap();
        let option_count = question_dialog_option_count(&dialog.request.questions[dialog.focused]);
        let multi_select = dialog.request.questions[dialog.focused].multi_select;

        match key.code {
            KeyCode::Up if key.modifiers.is_empty() => {
                move_question_dialog_cursor_by(dialog, -1, area, true);
            }
            KeyCode::Char('k')
                if matches!(key.modifiers, KeyModifiers::NONE | KeyModifiers::SHIFT) =>
            {
                move_question_dialog_cursor_by(dialog, -1, area, true);
            }
            KeyCode::Down if key.modifiers.is_empty() => {
                move_question_dialog_cursor_by(dialog, 1, area, true);
            }
            KeyCode::Char('j')
                if matches!(key.modifiers, KeyModifiers::NONE | KeyModifiers::SHIFT) =>
            {
                move_question_dialog_cursor_by(dialog, 1, area, true);
            }
            KeyCode::Home if key.modifiers.is_empty() => {
                set_question_dialog_cursor(dialog, 0, area, true);
            }
            KeyCode::End if key.modifiers.is_empty() => {
                set_question_dialog_cursor(dialog, option_count.saturating_sub(1), area, true);
            }
            KeyCode::PageUp if key.modifiers.is_empty() => {
                let visible = question_dialog_visible_options_for_area(dialog, area).max(1);
                move_question_dialog_cursor_by(dialog, -(visible as isize), area, false);
            }
            KeyCode::PageDown if key.modifiers.is_empty() => {
                let visible = question_dialog_visible_options_for_area(dialog, area).max(1);
                move_question_dialog_cursor_by(dialog, visible as isize, area, false);
            }
            KeyCode::Left if dialog.focused > 0 => {
                let next = dialog.focused.saturating_sub(1);
                question_dialog_set_focus(dialog, next, area);
            }
            KeyCode::Right if dialog.focused + 1 < dialog.request.questions.len() => {
                let next = dialog.focused.saturating_add(1);
                question_dialog_set_focus(dialog, next, area);
            }
            KeyCode::Char(' ') if multi_select && key.modifiers.is_empty() => {
                let idx = dialog.cursor;
                if dialog.selected.contains(&idx) {
                    if dialog.selected.len() > 1 {
                        dialog.selected.retain(|&i| i != idx);
                    }
                } else {
                    dialog.selected.push(idx);
                    dialog.selected.sort_unstable();
                }
                question_dialog_clear_current_answer(dialog);
                question_dialog_save_current_state(dialog);
            }
            KeyCode::Enter if key.modifiers.is_empty() => {
                let mut dialog = self.pending_question.take().unwrap();
                question_dialog_commit_current_answer(&mut dialog);
                question_dialog_save_current_state(&mut dialog);
                dialog.focused = dialog.focused.saturating_add(1);
                if dialog.focused < dialog.request.questions.len() {
                    question_dialog_restore_focused_state(&mut dialog, area);
                    self.pending_question = Some(dialog);
                } else {
                    let response = UserQuestionResponse {
                        questions: dialog.request.questions,
                        answers: dialog.request.answers,
                        annotations: dialog.request.annotations,
                    };
                    let _ = dialog.response_tx.send(response);
                    self.close_overlay_state(OverlayKind::Question);
                    self.activate_next_modal_or_resume_spinner();
                }
            }
            KeyCode::Esc if key.modifiers.is_empty() => {
                let dialog = self.pending_question.take().unwrap();
                let response = UserQuestionResponse {
                    questions: dialog.request.questions,
                    answers: dialog.request.answers,
                    annotations: dialog.request.annotations,
                };
                let _ = dialog.response_tx.send(response);
                self.close_overlay_state(OverlayKind::Question);
                self.activate_next_modal_or_resume_spinner();
            }
            _ => {}
        }
        None
    }

    pub(super) fn handle_goal_replacement_key(&mut self, key: KeyEvent) -> Option<UserAction> {
        match key.code {
            KeyCode::Left | KeyCode::Up | KeyCode::Right | KeyCode::Down
                if key.modifiers.is_empty() =>
            {
                let dialog = self.pending_goal_replacement.as_mut().unwrap();
                dialog.selected = 1usize.saturating_sub(dialog.selected.min(1));
            }
            KeyCode::Enter if key.modifiers.is_empty() => {
                let selected = self
                    .pending_goal_replacement
                    .as_ref()
                    .map(|dialog| dialog.selected)
                    .unwrap_or(1);
                if selected == 0 {
                    return self.confirm_goal_replacement();
                }
                self.cancel_goal_replacement();
            }
            KeyCode::Char('y') | KeyCode::Char('Y')
                if matches!(key.modifiers, KeyModifiers::NONE | KeyModifiers::SHIFT) =>
            {
                return self.confirm_goal_replacement();
            }
            KeyCode::Char('n') | KeyCode::Char('N')
                if matches!(key.modifiers, KeyModifiers::NONE | KeyModifiers::SHIFT) =>
            {
                self.cancel_goal_replacement();
            }
            KeyCode::Esc if key.modifiers.is_empty() => self.cancel_goal_replacement(),
            _ => {}
        }
        None
    }

    pub(super) fn confirm_goal_replacement(&mut self) -> Option<UserAction> {
        let dialog = self.pending_goal_replacement.take()?;
        self.close_overlay_state(OverlayKind::GoalReplacement);
        self.activate_next_modal_or_resume_spinner();
        Some(UserAction::ConfirmGoalReplacement {
            objective: dialog.objective,
            token_budget: dialog.token_budget,
            mode: dialog.mode,
            verification_kind: dialog.verification_kind,
        })
    }

    pub(super) fn cancel_goal_replacement(&mut self) {
        if self.pending_goal_replacement.take().is_some() {
            self.close_overlay_state(OverlayKind::GoalReplacement);
            self.push_message(MessageRole::System, "Goal replacement cancelled.");
            self.activate_next_modal_or_resume_spinner();
        }
    }
}

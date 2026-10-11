//! Composer kill/yank, deferred resume expansion, and transcript selection.

use super::*;

impl ReplApp {
    pub(super) fn focus_composer_at_mouse(&mut self, column: u16, row: u16) -> bool {
        let Some(content_area) = self.last_composer_content else {
            return false;
        };
        let Some(composer_area) = self.last_composer_area else {
            return false;
        };

        if !rect_contains(composer_area, column, row) {
            return false;
        }

        self.close_nonblocking_overlays();

        if rect_contains(content_area, column, row) {
            self.composer_preferred_col = None;
            let visual_row = row
                .saturating_sub(content_area.y)
                .saturating_add(self.input_scroll_row as u16) as usize;
            let visual_col = column.saturating_sub(content_area.x) as usize;
            self.cursor_grapheme_index = self.grapheme_index_for_visual_position(
                content_area.width.max(1),
                visual_row,
                visual_col,
            );
            self.clamp_input_scroll(content_area.width.max(1));
        }

        true
    }

    pub(super) fn kill_input_range(&mut self, start: usize, end: usize) {
        self.remove_input_range(start, end, true);
    }

    pub(super) fn remove_input_range(&mut self, start: usize, end: usize, store_kill: bool) {
        let len = self.input.graphemes(true).count();
        let start = start.min(len);
        let end = end.min(len);
        if start >= end {
            return;
        }

        self.reset_input_history_navigation();
        let start_byte = self.byte_index_for_grapheme(start);
        let end_byte = self.byte_index_for_grapheme(end);
        let removed = self.input[start_byte..end_byte].to_string();
        if store_kill && !removed.is_empty() {
            self.composer_kill_buffer = ComposerKillBuffer {
                text: removed.clone(),
                pending_pastes: self
                    .pending_pastes
                    .iter()
                    .filter(|(placeholder, _)| removed.contains(placeholder))
                    .cloned()
                    .collect(),
                local_image_attachments: self
                    .local_image_attachments
                    .iter()
                    .filter(|image| removed.contains(&image.placeholder))
                    .cloned()
                    .collect(),
            };
        }
        self.input.replace_range(start_byte..end_byte, "");
        self.cursor_grapheme_index = start;
        self.sync_composer_sidecars();
        self.clamp_input_scroll(self.last_input_width);
    }

    pub(super) fn kill_to_beginning_of_current_line(&mut self) {
        let (line_start, _) = self.current_line_range();
        let cursor = self.cursor_grapheme_index;
        if cursor == line_start {
            if line_start > 0 {
                self.kill_input_range(line_start - 1, line_start);
            }
        } else {
            self.kill_input_range(line_start, cursor);
        }
    }

    pub(super) fn kill_to_end_of_current_line(&mut self) {
        let (_, line_end) = self.current_line_range();
        let cursor = self.cursor_grapheme_index.min(line_end);
        let input_len = self.input.graphemes(true).count();
        if cursor == line_end {
            if line_end < input_len {
                self.kill_input_range(cursor, line_end + 1);
            }
        } else {
            self.kill_input_range(cursor, line_end);
        }
    }

    pub(super) fn yank_composer_kill_buffer(&mut self) {
        if self.composer_kill_buffer.is_empty() {
            return;
        }

        let kill = self.composer_kill_buffer.clone();
        let mut text = kill.text;
        let mut staged_replacements = Vec::new();

        for (index, (old_placeholder, actual)) in kill.pending_pastes.into_iter().enumerate() {
            if !text.contains(&old_placeholder) {
                continue;
            }
            let token = format!("\x1fkcoder-paste-yank-{index}\x1f");
            text = text.replace(&old_placeholder, &token);
            let placeholder = self.next_large_paste_placeholder(actual.chars().count());
            self.pending_pastes.push((placeholder.clone(), actual));
            staged_replacements.push((token, placeholder));
        }

        for (index, mut image) in kill.local_image_attachments.into_iter().enumerate() {
            if self.local_image_attachments.len() >= MAX_IMAGE_ATTACHMENTS {
                continue;
            }
            if !text.contains(&image.placeholder) {
                continue;
            }
            let token = format!("\x1fkcoder-image-yank-{index}\x1f");
            text = text.replace(&image.placeholder, &token);
            image.placeholder = local_image_placeholder(self.local_image_attachments.len() + 1);
            staged_replacements.push((token, image.placeholder.clone()));
            self.local_image_attachments.push(image);
        }

        for (token, placeholder) in staged_replacements {
            text = text.replace(&token, &placeholder);
        }

        self.insert_text_at_cursor(&text);
        self.sync_composer_sidecars();
    }

    pub(super) fn scroll_transcript_lines(&mut self, delta_lines: i32) {
        self.cancel_pending_navigation_for_input();
        if delta_lines < 0 && self.navigation.anchor.is_none() {
            self.expand_deferred_resumed_transcript();
        }
        self.transcript_viewport.scroll_lines(delta_lines);
        self.finish_manual_scroll_at_tail();
    }

    /// Read full history only on the first explicit review. Keep post-resume messages
    /// as an additional tail and retain the distance-from-tail anchor so inserting old
    /// records before it does not move the viewport.
    pub(super) fn expand_deferred_resumed_transcript(&mut self) -> bool {
        if self.deferred_resumed_transcript.is_none() {
            return false;
        }
        let content_rows = self.transcript_viewport.content_rows();
        let viewport_rows = self.transcript_viewport.viewport_rows().max(1);
        let top = self
            .transcript_viewport
            .resolve_top(content_rows, viewport_rows);
        let distance_from_tail = content_rows
            .saturating_sub(viewport_rows)
            .saturating_sub(top);
        let deferred = self
            .deferred_resumed_transcript
            .take()
            .expect("deferred transcript was checked above");
        let extra_messages =
            self.messages[deferred.loaded_display_len.min(self.messages.len())..].to_vec();
        let full_history = match deferred.history.load_all() {
            Ok(messages) => messages,
            Err(error) => {
                self.push_message(
                    MessageRole::System,
                    format!("Failed to load earlier resumed transcript: {error}"),
                );
                return false;
            }
        };

        self.replace_transcript_from_history(&full_history);
        for message in extra_messages {
            self.messages.push(message);
        }
        self.transcript_viewport
            .set_position(TranscriptScroll::from_tail(distance_from_tail));
        self.prime_deferred_resume_content_rows();
        self.force_next_viewport_redraw();
        true
    }

    /// Complete a deferred transcript before a foreground turn begins, preventing the
    /// first review during an active turn from rebuilding everything and clearing streaming
    /// state. If the caller recorded a transcript start, remap it from tail-fragment plus
    /// new-message coordinates to full-history plus new-message coordinates.
    pub(super) fn expand_deferred_resumed_transcript_before_turn(
        &mut self,
        transcript_start: Option<usize>,
    ) -> Option<usize> {
        let Some(loaded_display_len) = self
            .deferred_resumed_transcript
            .as_ref()
            .map(|deferred| deferred.loaded_display_len)
        else {
            return transcript_start;
        };
        let old_len = self.messages.len();
        if !self.expand_deferred_resumed_transcript() {
            return transcript_start;
        }
        let extra_len = old_len.saturating_sub(loaded_display_len);
        let expanded_display_len = self.messages.len().saturating_sub(extra_len);
        transcript_start.map(|index| {
            if index >= loaded_display_len {
                expanded_display_len.saturating_add(index - loaded_display_len)
            } else {
                index.min(expanded_display_len)
            }
        })
    }

    pub(super) fn prime_deferred_resume_content_rows(&mut self) {
        if !self.fullscreen_surface {
            return;
        }
        let Some(area) = self.transcript_viewport.transcript_area() else {
            return;
        };
        let row_budget =
            usize::from(area.height.max(1)).saturating_add(TRANSCRIPT_RENDER_OVERSCAN_ROWS);
        let total_rows = self
            .render_fullscreen_transcript_window(area.width.max(1), row_budget)
            .total_rows;
        self.transcript_viewport.prime_content_rows(total_rows);
    }

    pub(super) fn clear_transcript_selection(&mut self) {
        self.transcript_selection = None;
        self.transcript_selection_rows = None;
        self.transcript_selection_drag_active = false;
    }

    pub(super) fn transcript_selection_mouse_blocked(&self) -> bool {
        self.centered_overlay_active()
            || self.history_search.is_some()
            || self.resume_session_picker.is_some()
            || self.slash_menu.is_some()
            || self.pending_permission.is_some()
            || self.permission_editor.is_some()
            || self.pending_question.is_some()
            || self.pending_goal_replacement.is_some()
            || self.context_inspector.is_some()
            || self.settings_inspector.is_some()
            || self.picker_overlay.is_some()
            || self.keys_overlay.is_some()
            || self.transcript_overlay.is_some()
    }

    pub(super) fn transcript_selection_point_for_mouse(
        &self,
        column: u16,
        row: u16,
        require_inside: bool,
    ) -> Option<TranscriptSelectionPoint> {
        let area = self.transcript_viewport.transcript_area()?;
        if area.width == 0 || area.height == 0 {
            return None;
        }
        if require_inside && !rect_contains(area, column, row) {
            return None;
        }

        let row = if row < area.y {
            0
        } else if row >= area.bottom() {
            area.height.saturating_sub(1)
        } else {
            row.saturating_sub(area.y)
        };
        let column = if column < area.x {
            0
        } else if column >= area.right() {
            area.width
        } else {
            column.saturating_sub(area.x)
        };

        Some(TranscriptSelectionPoint {
            row: usize::from(row),
            column: usize::from(column),
        })
    }

    pub(super) fn begin_transcript_selection(&mut self, column: u16, row: u16) -> bool {
        if self.transcript_selection_mouse_blocked() || self.last_transcript_visible_rows.is_empty()
        {
            return false;
        }
        let Some(point) = self.transcript_selection_point_for_mouse(column, row, true) else {
            return false;
        };
        self.transcript_selection = Some(TranscriptSelection::new(point));
        self.transcript_selection_rows = Some(self.last_transcript_visible_rows.clone());
        self.transcript_selection_drag_active = true;
        true
    }

    pub(super) fn update_transcript_selection(&mut self, column: u16, row: u16) -> bool {
        if !self.transcript_selection_drag_active {
            return false;
        }
        if self
            .transcript_selection_rows
            .as_ref()
            .is_some_and(|rows| rows != &self.last_transcript_visible_rows)
        {
            self.transcript_selection_drag_active = false;
            self.set_transient_status("The view changed and the old selection was fixed; Ctrl+C copies, F9 selects across screens");
            return true;
        }
        let Some(point) = self.transcript_selection_point_for_mouse(column, row, false) else {
            self.clear_transcript_selection();
            return false;
        };
        if let Some(selection) = self.transcript_selection.as_mut() {
            selection.head = point;
        }
        true
    }

    pub(super) fn finish_transcript_selection(&mut self, column: u16, row: u16) -> bool {
        if !self.transcript_selection_drag_active {
            return false;
        }
        let _ = self.update_transcript_selection(column, row);
        self.transcript_selection_drag_active = false;
        if let Some(selection) = self.transcript_selection
            && selected_text_from_visible_rows(&self.last_transcript_visible_rows, selection)
                .is_some()
        {
            self.set_transient_status("Text selected; press Ctrl+C to copy");
        }
        true
    }

    pub(super) fn copy_transcript_selection(&mut self) -> bool {
        self.copy_transcript_selection_with(clipboard_copy::copy_to_clipboard)
    }

    pub(super) fn copy_transcript_selection_with(
        &mut self,
        copy_fn: impl FnOnce(&str) -> std::result::Result<clipboard_copy::ClipboardCopyResult, String>,
    ) -> bool {
        let Some(selection) = self.transcript_selection else {
            return false;
        };
        let Some(text) = selected_text_from_visible_rows(
            self.transcript_selection_rows
                .as_deref()
                .unwrap_or(&self.last_transcript_visible_rows),
            selection,
        ) else {
            if self
                .transcript_selection_rows
                .as_ref()
                .is_some_and(|rows| rows != &self.last_transcript_visible_rows)
            {
                self.set_transient_status(
                    "The view changed during selection; press F9 to select again or Esc to clear",
                );
                return true;
            }
            return false;
        };

        match copy_fn(&text) {
            Ok(result) => {
                let (lease, copy_kind) = result.into_parts();
                self.clipboard_lease = lease;
                if copy_kind == clipboard_copy::ClipboardCopyKind::Osc52 {
                    self.set_transient_status(clipboard_copy::OSC52_COPY_NOTICE);
                } else {
                    self.set_transient_status("Copied selected text to clipboard");
                    self.clear_transcript_selection();
                }
            }
            Err(error) => self.set_transient_status(format!("Copy failed: {error}")),
        }
        true
    }

    pub(super) fn scroll_transcript_to_scrollbar_row(&mut self, row: u16, immediate_redraw: bool) {
        self.transcript_viewport.drag_to_row(row);
        if immediate_redraw {
            self.frame_rate_limiter.reset();
        }
    }

    pub(super) fn apply_transcript_scrollbar_command(
        &mut self,
        command: TranscriptScrollbarCommand,
        immediate_redraw: bool,
    ) {
        self.transcript_viewport.apply_command(command);
        if immediate_redraw {
            self.frame_rate_limiter.reset();
        }
    }

    pub(crate) fn open_resume_session_picker(&mut self, entries: Vec<ResumeSessionEntry>) {
        if entries.is_empty() {
            self.push_message(MessageRole::System, "No previous session to resume.");
            return;
        }
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        self.resume_session_picker = Some(ResumeSessionPicker {
            entries,
            selected: 0,
            filter: String::new(),
        });
        self.open_overlay_state(OverlayKind::ResumeSession);
        self.transcript_viewport.apply_pending_scroll();
        self.force_next_viewport_redraw();
    }
}

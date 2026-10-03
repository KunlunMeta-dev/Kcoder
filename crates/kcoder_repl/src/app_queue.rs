//! Queued input and steer acknowledgements; queue ownership remains on ReplApp.

use super::*;

impl ReplApp {
    pub(super) fn enqueue_user_message_for_turn(
        &mut self,
        message: impl Into<QueuedUserMessage>,
    ) -> bool {
        if self.pending_input_count() >= USER_MESSAGE_QUEUE_MAX {
            return false;
        }
        self.user_message_queue.push_back(message.into());
        true
    }

    pub(super) fn pop_user_message_for_turn(&mut self) -> Option<QueuedTurnInput> {
        self.rejected_turn_steers
            .pop_front()
            .or_else(|| self.user_message_queue.pop_front())
            .map(QueuedUserMessage::into_turn_input)
    }

    pub(super) fn restore_latest_queued_message_for_edit(&mut self) -> bool {
        let Some(queued) = self
            .user_message_queue
            .pop_back()
            .or_else(|| self.rejected_turn_steers.pop_back())
        else {
            return false;
        };
        self.prefill_input(queued.restore_text);
        self.local_image_attachments = queued.local_image_attachments;
        self.remote_image_urls = queued.remote_image_urls;
        self.selected_remote_image_index = None;
        self.pending_pastes = queued.pending_pastes;
        self.sync_composer_sidecars();
        self.force_next_viewport_redraw();
        true
    }

    pub(super) fn pending_input_count(&self) -> usize {
        self.user_message_queue.len()
            + self.pending_turn_steers.len()
            + self.rejected_turn_steers.len()
    }

    pub(super) fn next_turn_steer_id(&mut self) -> u64 {
        self.next_turn_steer_id = self.next_turn_steer_id.wrapping_add(1).max(1);
        self.next_turn_steer_id
    }

    pub(super) fn track_pending_turn_steer(&mut self, id: u64, message: QueuedUserMessage) {
        debug_assert!(self.pending_input_count() < USER_MESSAGE_QUEUE_MAX);
        self.pending_turn_steers
            .push_back(PendingTurnSteer { id, message });
        self.force_next_viewport_redraw();
    }

    pub(super) fn apply_pending_turn_steer(&mut self, id: u64) -> bool {
        let Some(index) = self
            .pending_turn_steers
            .iter()
            .position(|pending| pending.id == id)
        else {
            return false;
        };
        let Some(pending) = self.pending_turn_steers.remove(index) else {
            return false;
        };

        self.push_scheduled_user_message(&pending.message.display_message);
        self.force_next_viewport_redraw();
        true
    }

    pub(super) fn defer_unapplied_turn_steers(&mut self) -> usize {
        let count = self.pending_turn_steers.len();
        self.rejected_turn_steers.extend(
            self.pending_turn_steers
                .drain(..)
                .map(|pending| pending.message),
        );
        count
    }

    pub(super) fn push_scheduled_user_message(&mut self, message: &Message) -> usize {
        self.flush_active_turn();
        // A live panel holds the old active tail back. Move it into editable
        // transcript storage before the user boundary, not behind the new input.
        // sync_subagent_panel keeps it current; scrollback_commit_target still
        // prevents exporting a live panel into immutable native scrollback.
        let remaining = StreamController::flush(&mut self.active_turn, true);
        if !remaining.is_empty() {
            self.bump_active_turn_render_revision();
            for entry in remaining {
                self.push_message(entry.role, entry.text);
            }
        }
        self.consolidate_finished_assistant_stream();
        self.open_subagent_panel = None;
        let transcript_start = self.messages.len();
        let tool_uses = HashMap::new();
        let tool_results = HashMap::new();
        self.push_history_message(message, &tool_uses, &tool_results);
        transcript_start
    }

    pub(super) fn push_user_shell_help(&mut self) {
        self.push_message(
            MessageRole::System,
            format!("{USER_SHELL_COMMAND_HELP_TITLE}\n{USER_SHELL_COMMAND_HELP_HINT}"),
        );
    }

    pub(super) fn pending_input_preview(&self) -> widgets::PendingInputPreview<'_> {
        widgets::PendingInputPreview::new(
            self.user_message_queue
                .iter()
                .map(|message| queued_user_message_preview(&message.model_message))
                .collect(),
            &KCODER_UI_THEME,
        )
        .with_steers(
            self.pending_turn_steers
                .iter()
                .map(|pending| queued_user_message_preview(&pending.message.display_message))
                .collect(),
            self.rejected_turn_steers
                .iter()
                .map(|message| queued_user_message_preview(&message.display_message))
                .collect(),
        )
    }

    pub(super) fn pending_input_preview_height(&self, width: u16, status_height: u16) -> u16 {
        let preview_height = self.pending_input_preview().desired_height(width.max(1));
        pending_input_preview_layout_height(preview_height, status_height)
    }

    pub(super) fn bottom_pane_stack_heights(&self, width: u16) -> (u16, u16) {
        let status_height = status_indicator_height(self, width);
        let preview_height = self.pending_input_preview().desired_height(width.max(1));
        (
            status_indicator_layout_height(status_height, preview_height),
            self.pending_input_preview_height(width, status_height),
        )
    }

    pub(super) fn history_search_footer_cursor(&self, footer_area: Rect) -> Option<(u16, u16)> {
        let search = self.history_search.as_ref()?;
        if footer_area.is_empty() {
            return None;
        }

        const FOOTER_INDENT_COLS: u16 = 2;
        let prompt_width = unicode_width::UnicodeWidthStr::width("reverse-i-search: ") as u16;
        let query_width = unicode_width::UnicodeWidthStr::width(search.query.as_str()) as u16;
        let desired_x = footer_area
            .x
            .saturating_add(FOOTER_INDENT_COLS.min(footer_area.width))
            .saturating_add(prompt_width)
            .saturating_add(query_width);
        let max_x = footer_area
            .x
            .saturating_add(footer_area.width.saturating_sub(1));
        Some((desired_x.min(max_x), footer_area.y))
    }

    #[cfg(test)]
    pub(super) fn render_queued_user_message_lines(&self, width: u16) -> Vec<Line<'static>> {
        self.pending_input_preview().lines(width)
    }
}

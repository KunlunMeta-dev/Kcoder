//! Turn lifecycle, frame scheduling, terminal title, and transient status.

use super::*;

impl ReplApp {
    /// Jump the transcript view to the very bottom and resume tail-following.
    pub(crate) fn snap_to_bottom(&mut self) {
        self.transcript_viewport.snap_to_bottom();
    }

    /// Apply any accumulated mouse-wheel delta to the transcript scroll state.
    pub(super) fn apply_pending_scroll(&mut self) {
        self.transcript_viewport.apply_pending_scroll();
        self.finish_manual_scroll_at_tail();
    }

    pub(super) fn finish_manual_scroll_at_tail(&mut self) {
        if self.transcript_viewport.is_at_tail() && self.navigation.anchor.is_some() {
            self.jump_transcript("latest");
        }
    }

    pub(super) fn preserve_review_before_content_change(&mut self) {
        // Consume scroll intent from the old frame before new output in the same event batch can resume tail following.
        self.apply_pending_scroll();
        self.transcript_viewport
            .preserve_review_before_content_change();
    }

    pub(super) fn time_until_next_viewport_draw(&self, now: Instant) -> Option<Duration> {
        if self.transcript_viewport.fast_path_active() {
            self.frame_rate_limiter
                .time_until_next_draw_with_interval(now, INTERACTION_MIN_FRAME_INTERVAL)
        } else {
            self.frame_rate_limiter.time_until_next_draw(now)
        }
    }

    pub(super) fn force_next_viewport_redraw(&mut self) {
        self.force_viewport_redraw = true;
    }

    pub(super) fn take_force_viewport_redraw(&mut self) -> bool {
        std::mem::take(&mut self.force_viewport_redraw)
    }

    pub(super) fn request_resize_viewport_reset(&mut self) {
        self.resize_viewport_reset_pending = true;
        self.force_next_viewport_redraw();
        self.transcript_viewport.invalidate_layout();
        if self.transcript_viewport.is_at_tail() {
            self.snap_to_bottom();
        }
    }

    pub(super) fn take_resize_viewport_reset_pending(&mut self) -> bool {
        std::mem::take(&mut self.resize_viewport_reset_pending)
    }

    pub(super) fn quit_shortcut_active_for(&self, key: key_hint::KeyBinding) -> bool {
        self.quit_shortcut_key == Some(key)
            && self
                .quit_shortcut_expires_at
                .is_some_and(|expires_at| Instant::now() <= expires_at)
    }

    pub(super) fn active_quit_shortcut_key(&mut self) -> Option<key_hint::KeyBinding> {
        let key = self.quit_shortcut_key?;
        if self.quit_shortcut_active_for(key) {
            Some(key)
        } else {
            self.clear_quit_shortcut();
            None
        }
    }

    pub(super) fn arm_quit_shortcut(&mut self, key: key_hint::KeyBinding) {
        self.quit_shortcut_key = Some(key);
        self.quit_shortcut_expires_at = Some(Instant::now() + QUIT_SHORTCUT_WINDOW);
    }

    pub(super) fn handle_quit_shortcut(&mut self, key: key_hint::KeyBinding) -> Option<UserAction> {
        if self.quit_shortcut_active_for(key) {
            self.clear_quit_shortcut();
            Some(UserAction::Quit)
        } else {
            self.arm_quit_shortcut(key);
            None
        }
    }

    pub(super) fn clear_quit_shortcut(&mut self) {
        self.quit_shortcut_key = None;
        self.quit_shortcut_expires_at = None;
    }

    pub(super) fn clear_edit_previous_prompt(&mut self) {
        self.edit_previous_hint_visible = false;
        self.edit_previous_primed = false;
    }

    pub(super) fn show_edit_previous_hint(&mut self) {
        if self.input.is_empty() && !self.has_interruptible_turn() {
            self.edit_previous_hint_visible = true;
            self.edit_previous_primed = false;
            self.force_next_viewport_redraw();
        }
    }

    pub(super) fn composer_has_draft(&self) -> bool {
        !self.input.trim().is_empty()
            || !self.local_image_attachments.is_empty()
            || !self.remote_image_urls.is_empty()
            || !self.pending_pastes.is_empty()
    }

    pub(super) fn composer_is_empty_for_shortcuts(&self) -> bool {
        self.input.is_empty()
            && self.local_image_attachments.is_empty()
            && self.remote_image_urls.is_empty()
            && self.pending_pastes.is_empty()
    }

    pub(super) fn footer_height(&self) -> u16 {
        if DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED
            && self
                .quit_shortcut_key
                .is_some_and(|key| self.quit_shortcut_active_for(key))
        {
            return FooterHint::QuitReminder(self.quit_shortcut_key.expect("checked above"))
                .desired_height();
        }
        FooterHint::Shortcuts.desired_height()
    }

    pub(super) fn dialog_host_area(&self) -> Option<Rect> {
        self.last_frame_area
            .map(|area| dialog_host_area_for_todo(area, todo_status_height(&self.todos)))
    }

    pub(super) fn clear_composer_for_ctrl_c(&mut self) {
        if !self.composer_has_draft() {
            return;
        }
        let history_text = self.composer_text_for_external_editor();
        self.reset_input_history_navigation();
        self.input.clear();
        self.pending_pastes.clear();
        self.local_image_attachments.clear();
        self.remote_image_urls.clear();
        self.selected_remote_image_index = None;
        self.cursor_grapheme_index = 0;
        self.input_scroll_row = 0;
        self.close_slash_menu();
        self.push_input_history(history_text);
        self.force_next_viewport_redraw();
    }

    pub(super) fn show_shutdown_in_progress(&mut self) {
        self.shutdown_in_progress = true;
        self.footer_shortcuts_overlay = false;
        self.clear_quit_shortcut();
        self.clear_edit_previous_prompt();
        self.close_slash_menu();
        self.force_next_viewport_redraw();
    }

    pub(super) fn handle_edit_previous_escape(&mut self) -> Option<UserAction> {
        if !self.input.is_empty() || self.has_interruptible_turn() {
            self.clear_edit_previous_prompt();
            return None;
        }
        self.edit_previous_hint_visible = false;
        if self.edit_previous_primed {
            self.clear_edit_previous_prompt();
            Some(UserAction::EditPreviousMessage)
        } else {
            self.edit_previous_primed = true;
            self.force_next_viewport_redraw();
            None
        }
    }

    pub(super) fn needs_scheduled_frame_tick(&self) -> bool {
        self.copy_needs_tick()
            || self.navigation_needs_tick()
            || self.spinner.is_running()
            || self.is_loading
            || self.active_turn.is_some()
            || !self.streaming_text_pending.is_empty()
            || self.streaming_message_done_pending
            || self.deferred_turn_finish_pending
            || self.quit_shortcut_expires_at.is_some()
            || self.transient_status.is_some()
            || self.has_running_background_job()
            || self.agent_view.is_some()
            || self
                .side_question_overlay
                .as_ref()
                .is_some_and(|overlay| matches!(overlay.status, SideQuestionStatus::Loading))
    }

    pub(super) fn next_frame_tick_delay(&self) -> Duration {
        if self.copy_needs_tick() {
            return Duration::from_millis(60);
        }
        if self.navigation_needs_tick() && !self.is_loading && !self.spinner.is_running() {
            return Duration::from_millis(50);
        }
        let now = Instant::now();
        let needs_spinner = self.spinner.is_running();
        let needs_commit = self.is_loading || self.active_turn.is_some();
        let needs_presentation = !self.streaming_text_pending.is_empty()
            || self.streaming_message_done_pending
            || self.deferred_turn_finish_pending;
        let mut delay = match (needs_spinner, needs_commit) {
            (true, true) => Duration::from_millis(SPINNER_INTERVAL_MS.min(COMMIT_TICK_INTERVAL_MS)),
            (true, false) => Duration::from_millis(SPINNER_INTERVAL_MS),
            (false, true) => Duration::from_millis(COMMIT_TICK_INTERVAL_MS),
            (false, false) => Duration::ZERO,
        };
        if needs_presentation {
            let presentation_delay = Duration::from_millis(STREAM_TEXT_PRESENTATION_INTERVAL_MS);
            delay = if delay.is_zero() {
                presentation_delay
            } else {
                delay.min(presentation_delay)
            };
        }
        if let Some(status) = self.transient_status.as_ref() {
            let status_delay = status.remaining_at(now);
            delay = if delay.is_zero() {
                status_delay
            } else {
                delay.min(status_delay)
            };
        }
        if let Some(expires_at) = self.quit_shortcut_expires_at {
            let quit_delay = expires_at.saturating_duration_since(now);
            delay = if delay.is_zero() {
                quit_delay
            } else {
                delay.min(quit_delay)
            };
        }
        if self.has_running_background_job() {
            let background_delay = Duration::from_secs(1);
            delay = if delay.is_zero() {
                background_delay
            } else {
                delay.min(background_delay)
            };
        }
        if self.agent_view.is_some() {
            let agent_view_delay = Duration::from_millis(250);
            delay = if delay.is_zero() {
                agent_view_delay
            } else {
                delay.min(agent_view_delay)
            };
        }
        delay
    }

    pub(super) fn mark_streaming_delta_redraw_seeded(&mut self) -> bool {
        if self.streaming_delta_redraw_seeded {
            false
        } else {
            self.streaming_delta_redraw_seeded = true;
            true
        }
    }

    pub(super) fn clear_streaming_presentation_state(&mut self) {
        self.streaming_text_pending.clear();
        self.streaming_message_done_pending = false;
        self.deferred_turn_finish_pending = false;
        self.deferred_turn_finish_handle = None;
    }

    pub(super) fn begin_turn(&mut self, handle: JoinHandle<()>, cancel: CancellationToken) {
        self.begin_turn_with_transcript_start(handle, cancel, None);
    }

    pub(super) fn begin_turn_with_transcript_start(
        &mut self,
        handle: JoinHandle<()>,
        cancel: CancellationToken,
        transcript_start: Option<usize>,
    ) {
        debug_assert!(!self.turn_state.is_active());
        let transcript_start =
            self.expand_deferred_resumed_transcript_before_turn(transcript_start);
        self.path_previews.begin();
        self.turn_state = TurnState::Starting { handle, cancel };
        self.turn_had_work_activity = false;
        self.streaming_delta_redraw_seeded = false;
        self.streaming_status_suppressed_after_output = false;
        self.recent_turn_transcript_start = Some(
            transcript_start
                .unwrap_or(self.messages.len())
                .min(self.messages.len()),
        );
        self.set_loading(true);
    }

    pub(super) fn mark_turn_started(&mut self) {
        let state = std::mem::take(&mut self.turn_state);
        let mut started = false;
        self.turn_state = match state {
            TurnState::Starting { handle, cancel } => {
                started = true;
                TurnState::Running { handle, cancel }
            }
            TurnState::Running { handle, cancel } => {
                started = true;
                TurnState::Running { handle, cancel }
            }
            other => other,
        };
        if started {
            self.turn_started_at = Some(Instant::now());
            self.recent_turn_transcript_start
                .get_or_insert_with(|| self.messages.len());
            self.set_loading(true);
        }
    }

    pub(super) fn finish_turn_state(&mut self) -> Option<JoinHandle<()>> {
        self.path_previews.clear();
        self.foreground_operation_label = None;
        let state = std::mem::take(&mut self.turn_state);
        let handle = match state {
            TurnState::Starting { handle, .. } | TurnState::Running { handle, .. } => handle,
            TurnState::Finishing { handle } => handle,
            TurnState::Idle => return None,
        };
        self.turn_state = TurnState::Finishing { handle };
        match std::mem::take(&mut self.turn_state) {
            TurnState::Finishing { handle } => Some(handle),
            _ => unreachable!("turn state must be finishing"),
        }
    }

    pub(super) fn abort_turn_for_shutdown(&mut self) -> Option<JoinHandle<()>> {
        if let Some(cancel) = self.turn_state.cancel_flag() {
            cancel.cancel();
        }
        let handle = self.finish_turn_state()?;
        handle.abort();
        self.turn_started_at = None;
        self.turn_had_work_activity = false;
        self.set_loading(false);
        Some(handle)
    }

    /// Reset every transcript-derived structure after `/clear`.
    ///
    /// Engine-side conversation state is cleared by the caller.
    pub(crate) fn reset_transcript_state_after_clear(&mut self) {
        self.path_previews.clear();
        self.messages.clear();
        self.welcome_component_mounted = false;
        self.welcome_scrollback_committed = false;
        self.startup_live_viewport_top_limit = None;
        self.render_cache.clear();
        self.keyed_transcript_block_render_cache.clear();
        self.scrollback_committed_until = 0;
        self.transcript_viewport.replace_content();
        if self.active_turn.take().is_some() {
            self.bump_active_turn_render_revision();
        }
        self.active_turn_render_cache = None;
        self.streaming_delta_redraw_seeded = false;
        self.clear_streaming_presentation_state();
        self.streaming_output_active = false;
        self.streaming_status_suppressed_after_output = false;
        self.streaming_transcript_start = None;
        self.recent_turn_transcript_start = None;
        self.clear_subagent_panel_state();
        self.streaming_thinking_status.clear();
        self.streaming_thinking_buffer.clear();
        self.input_scroll_row = 0;
        self.last_transcript_visible_rows.clear();
        self.clear_transcript_selection();
        self.transcript_reflow.clear();
        self.render_welcome_component();
        self.force_next_viewport_redraw();
    }

    pub(super) fn clear_subagent_panel_state(&mut self) {
        self.subagent_panels.clear();
        self.subagent_panel_by_agent.clear();
        self.pending_subagent_terminal.clear();
        self.pending_subagent_progress.clear();
        self.pending_subagent_steer_applied.clear();
        self.pending_subagent_associations.clear();
        self.agent_view = None;
        self.open_subagent_panel = None;
    }

    pub(super) fn reset_transcript_derived_after_rewrite(&mut self) {
        self.path_previews.clear();
        self.render_cache.clear();
        self.scrollback_committed_until = self.scrollback_committed_until.min(self.messages.len());
        self.transcript_viewport.replace_content();
        self.active_turn_render_cache = None;
        self.clear_streaming_presentation_state();
        self.streaming_thinking_status.clear();
        self.streaming_thinking_buffer.clear();
        self.streaming_transcript_start = None;
        self.recent_turn_transcript_start = None;
        self.last_transcript_visible_rows.clear();
        self.clear_transcript_selection();
        self.transcript_reflow.clear();
        self.force_next_viewport_redraw();
    }

    pub(crate) fn raw_output_mode(&self) -> bool {
        self.raw_output_mode
    }

    pub(super) fn effective_render_markdown(&self) -> bool {
        self.render_markdown && !self.raw_output_mode
    }

    pub(super) fn effective_tool_transcript_expanded(&self) -> bool {
        self.tool_transcript_expanded || self.raw_output_mode
    }

    pub(super) fn effective_tool_output_expanded(&self) -> bool {
        self.last_tool_output_expanded || self.raw_output_mode
    }

    pub(super) fn effective_active_tools_expanded(&self) -> bool {
        self.active_tools_expanded || self.raw_output_mode
    }

    pub(super) fn invalidate_transcript_rendering(&mut self) {
        self.render_cache.clear();
        self.active_turn_render_cache = None;
        self.fullscreen_transcript_render_cache = None;
        self.transcript_row_index = TranscriptRowIndex::default();
        self.transcript_viewport.invalidate_content_layout();
        self.clear_transcript_selection();
        self.force_next_viewport_redraw();
    }

    pub(super) fn bump_active_turn_render_revision(&mut self) {
        self.preserve_review_before_content_change();
        self.active_turn_render_revision = self.active_turn_render_revision.wrapping_add(1);
    }

    pub(super) fn set_tool_transcript_expanded(&mut self, expanded: bool) {
        if self.tool_transcript_expanded == expanded
            && self.last_tool_output_expanded == expanded
            && self.active_tools_expanded == expanded
        {
            return;
        }
        self.tool_transcript_expanded = expanded;
        self.last_tool_output_expanded = expanded;
        self.active_tools_expanded = expanded;
        self.invalidate_transcript_rendering();
    }

    pub(super) fn toggle_tool_transcript_expanded(&mut self) {
        let expanded = !self.tool_transcript_expanded;
        self.set_tool_transcript_expanded(expanded);
    }

    pub(crate) fn set_raw_output_mode(&mut self, enabled: bool) {
        if self.raw_output_mode == enabled {
            return;
        }
        self.raw_output_mode = enabled;
        self.invalidate_transcript_rendering();
    }

    pub(crate) fn set_code_theme(&mut self, code_theme: impl Into<String>) {
        let code_theme = code_theme.into();
        if self.code_theme == code_theme {
            return;
        }
        self.code_theme = code_theme;
        self.render_cache.clear();
        self.active_turn_render_cache = None;
        self.force_next_viewport_redraw();
    }

    pub(crate) fn session_title(&self) -> Option<&str> {
        self.session_title.as_deref()
    }

    pub(crate) fn set_session_title(&mut self, title: impl Into<String>) {
        let title = title.into();
        if self.session_title.as_deref() == Some(title.as_str()) {
            return;
        }
        self.session_title = Some(title);
        self.force_next_viewport_redraw();
    }

    pub(super) fn terminal_title_project_name(&self) -> String {
        if let Some(title) = self
            .session_title
            .as_deref()
            .filter(|title| !title.trim().is_empty())
        {
            return terminal_title::truncate_terminal_title_part(title.trim(), 48);
        }

        let cwd = self.display_cwd.trim();
        if let Some(name) = Path::new(cwd)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.trim().is_empty())
        {
            return terminal_title::truncate_terminal_title_part(name, 24);
        }

        if cwd.is_empty() {
            "kcoder".to_string()
        } else {
            terminal_title::truncate_terminal_title_part(cwd, 24)
        }
    }

    pub(super) fn terminal_title_text(&self) -> String {
        let activity = if self.pending_permission.is_some()
            || self.pending_question.is_some()
            || self.pending_goal_replacement.is_some()
        {
            "[WAIT]"
        } else if self.has_interruptible_turn() {
            "[RUN]"
        } else {
            "[READY]"
        };
        format!("{activity} · {}", self.terminal_title_project_name())
    }

    pub(super) fn sync_terminal_title(&mut self, writer: &mut impl Write) -> Result<()> {
        let title = terminal_title::sanitize_terminal_title(&self.terminal_title_text());
        if title.is_empty() || self.last_terminal_title.as_deref() == Some(title.as_str()) {
            return Ok(());
        }
        if let terminal_title::TerminalTitleWrite::Applied(title) =
            terminal_title::write_terminal_title(writer, &title)
                .context("failed to write terminal title")?
        {
            self.last_terminal_title = Some(title);
        }
        Ok(())
    }

    pub(super) fn clear_managed_terminal_title(&mut self, writer: &mut impl Write) -> Result<()> {
        if self.last_terminal_title.is_some() {
            terminal_title::clear_terminal_title(writer)
                .context("failed to clear managed terminal title")?;
            self.last_terminal_title = None;
        }
        Ok(())
    }

    pub(crate) fn raw_output_mode_notice(enabled: bool) -> &'static str {
        if enabled {
            "Raw output mode on: transcript text is shown for clean terminal selection."
        } else {
            "Raw output mode off: rich transcript rendering restored."
        }
    }

    pub(crate) fn set_raw_output_mode_and_notify(&mut self, enabled: bool) {
        self.set_raw_output_mode(enabled);
        self.push_message(MessageRole::System, Self::raw_output_mode_notice(enabled));
    }

    pub(crate) fn toggle_raw_output_mode_and_notify(&mut self) -> bool {
        let enabled = !self.raw_output_mode;
        self.set_raw_output_mode_and_notify(enabled);
        enabled
    }

    pub(super) fn raw_output_status_label(&self) -> &'static str {
        if self.raw_output_mode {
            "raw output"
        } else {
            ""
        }
    }

    pub(crate) fn queued_user_message_count(&self) -> usize {
        self.user_message_queue.len() + self.rejected_turn_steers.len()
    }

    #[cfg(test)]
    pub(super) fn queue_status_label(&self) -> String {
        let count = self.queued_user_message_count();
        if count == 0 {
            String::new()
        } else {
            format!("queue {count} pending")
        }
    }

    pub(super) fn compact_status_label(&self) -> String {
        self.compact_status_label_with_transient(true)
    }

    pub(super) fn compact_status_label_without_transient(&self) -> String {
        self.compact_status_label_with_transient(false)
    }

    pub(super) fn compact_status_label_with_transient(&self, include_transient: bool) -> String {
        let transient = if include_transient {
            self.transient_status_label()
        } else {
            String::new()
        };
        [
            transient,
            self.background_status_label(),
            self.goal_status_label(),
            self.raw_output_status_label().to_string(),
            self.input_history_status_label(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
    }

    pub(super) fn transient_status_label(&self) -> String {
        let now = Instant::now();
        self.transient_status
            .as_ref()
            .filter(|status| status.is_active_at(now))
            .map(|status| status.text.clone())
            .unwrap_or_default()
    }

    pub(super) fn set_transient_status(&mut self, text: impl Into<String>) {
        self.transient_status = Some(TransientStatus::new(text, Instant::now()));
        self.force_next_viewport_redraw();
    }

    pub(super) fn clear_expired_transient_status_at(&mut self, now: Instant) -> bool {
        let expired = self
            .transient_status
            .as_ref()
            .is_some_and(|status| !status.is_active_at(now));
        if expired {
            self.transient_status = None;
            self.force_next_viewport_redraw();
        }
        expired
    }

    pub(crate) fn clear_user_message_queue(&mut self) -> usize {
        let cleared = self.queued_user_message_count();
        self.user_message_queue.clear();
        self.rejected_turn_steers.clear();
        cleared
    }
}

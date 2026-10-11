use super::*;

impl ReplApp {
    pub fn start_loading(&mut self) {
        self.is_loading = true;
        self.spinner.start();
    }

    pub fn stop_loading(&mut self) {
        self.is_loading = false;
        self.spinner.stop();
        self.streaming_status_suppressed_after_output = false;
    }

    pub(super) fn set_loading(&mut self, loading: bool) {
        if loading {
            self.start_loading();
        } else {
            self.stop_loading();
        }
    }

    /// Ensure there is an active assistant turn cell ready to receive content.
    pub(super) fn start_streaming_message(&mut self) {
        if self.active_turn.is_none() {
            self.active_turn = Some(ActiveCell::default());
            self.bump_active_turn_render_revision();
        }
        self.is_loading = true;
    }

    pub(super) fn pending_streaming_text_graphemes_at_least(&self, threshold: usize) -> bool {
        self.streaming_text_pending
            .graphemes(true)
            .take(threshold)
            .count()
            >= threshold
    }

    pub(super) fn streaming_text_drain_graphemes(&self) -> usize {
        if self.streaming_message_done_pending
            || self
                .pending_streaming_text_graphemes_at_least(STREAM_TEXT_CATCH_UP_PENDING_GRAPHEMES)
        {
            STREAM_TEXT_CATCH_UP_GRAPHEMES_PER_TICK
        } else {
            STREAM_TEXT_SMOOTH_GRAPHEMES_PER_TICK
        }
    }

    pub(super) fn take_pending_streaming_text_prefix(&mut self, max_graphemes: usize) -> String {
        if max_graphemes == 0 || self.streaming_text_pending.is_empty() {
            return String::new();
        }
        let split_at = self
            .streaming_text_pending
            .grapheme_indices(true)
            .nth(max_graphemes)
            .map(|(idx, _)| idx)
            .unwrap_or(self.streaming_text_pending.len());
        self.streaming_text_pending.drain(..split_at).collect()
    }

    pub(super) fn append_streaming_text_visible(&mut self, text: impl AsRef<str>) {
        self.start_streaming_message();
        self.streaming_output_active = true;
        self.streaming_status_suppressed_after_output = false;
        self.streaming_thinking_status.clear();
        let text = sanitize_tui_text(text.as_ref());
        if let Some(active) = self.active_turn.as_mut() {
            if let Some(ActiveEntry::Text(existing)) = active.entries.last_mut() {
                append_capped_tui_text(
                    existing,
                    &text,
                    ACTIVE_TURN_TEXT_MAX_CHARS,
                    "assistant output",
                );
            } else {
                active.entries.push(ActiveEntry::Text(capped_tui_text(
                    &text,
                    ACTIVE_TURN_TEXT_MAX_CHARS,
                    "assistant output",
                )));
            }
        }
        self.bump_active_turn_render_revision();
        if self.transcript_viewport.is_at_tail() {
            self.snap_to_bottom();
        }
    }

    pub(super) fn enqueue_streaming_text_delta(&mut self, text: impl AsRef<str>) {
        self.preserve_review_before_content_change();
        self.commit_streaming_thinking_summary();
        self.start_streaming_message();
        self.streaming_output_active = true;
        self.streaming_status_suppressed_after_output = false;
        self.streaming_thinking_status.clear();
        let text = sanitize_tui_text(text.as_ref());
        append_capped_tui_text(
            &mut self.streaming_text_pending,
            &text,
            ACTIVE_TURN_TEXT_MAX_CHARS,
            "assistant output",
        );
        if self.transcript_viewport.is_at_tail() {
            self.snap_to_bottom();
        }
    }

    pub(super) fn drain_pending_streaming_text_tick(&mut self) -> bool {
        let chunk = self.take_pending_streaming_text_prefix(self.streaming_text_drain_graphemes());
        if chunk.is_empty() {
            return false;
        }
        self.append_streaming_text_visible(chunk);
        true
    }

    pub(super) fn drain_pending_streaming_text_all(&mut self) -> bool {
        let text = std::mem::take(&mut self.streaming_text_pending);
        if text.is_empty() {
            return false;
        }
        self.append_streaming_text_visible(text);
        true
    }

    #[cfg(test)]
    pub(super) fn append_streaming_text(&mut self, text: impl AsRef<str>) {
        self.drain_pending_streaming_text_all();
        self.commit_streaming_thinking_summary();
        self.append_streaming_text_visible(text);
    }

    pub(super) fn append_streaming_thinking(&mut self, text: impl AsRef<str>) {
        self.start_streaming_message();
        self.streaming_status_suppressed_after_output = false;
        let text = sanitize_tui_text(text.as_ref());
        append_capped_tui_text(
            &mut self.streaming_thinking_status,
            &text,
            ACTIVE_TURN_TEXT_MAX_CHARS,
            "thinking output",
        );
        append_capped_tui_text(
            &mut self.streaming_thinking_buffer,
            &text,
            ACTIVE_TURN_TEXT_MAX_CHARS,
            "thinking output",
        );
        self.bump_active_turn_render_revision();
    }

    /// The current assistant message is complete as far as the API is
    /// concerned. Commit every stable active entry before the first still
    /// running tool so completed text does not accumulate until turn finish.
    pub(super) fn commit_streaming_text(&mut self) -> bool {
        let committed_messages =
            StreamController::commit_stable_prefix(&mut self.active_turn, true);
        let committed_any = !committed_messages.is_empty();

        for msg in committed_messages {
            self.push_committed_active_message(msg.role, msg.text);
        }

        if committed_any {
            self.bump_active_turn_render_revision();
        }

        if self.active_turn.is_none() {
            self.active_tools_expanded = false;
        }

        committed_any
    }

    pub(super) fn commit_streaming_text_tick(&mut self) -> bool {
        let max_source_lines = self.streaming_tick_source_line_limit();
        let committed_messages = StreamController::commit_complete_lines_prefix_with_limit(
            &mut self.active_turn,
            true,
            max_source_lines,
        );
        let committed_any = !committed_messages.is_empty();

        for msg in committed_messages {
            self.push_committed_stream_chunk(msg.role, msg.text);
        }

        if committed_any {
            self.bump_active_turn_render_revision();
        }

        if self.active_turn.is_none() {
            self.active_tools_expanded = false;
        }

        committed_any
    }

    pub(super) fn finish_completed_streaming_message(&mut self) -> bool {
        let reasoning_committed = self.commit_streaming_thinking_summary();
        let committed = self.commit_streaming_text();
        let consolidated = self.consolidate_finished_assistant_stream();
        let status_restored = self.finish_streaming_text_status();
        // When consolidation merges trailing assistant chunks into one
        // message, the merged message can be far taller than the previous
        // frame's `last_line_count`. Reset the baseline so the next `draw`
        // recomputes `row_budget` and the scroll offset from the real content.
        if consolidated {
            if self.transcript_viewport.is_at_tail() {
                self.snap_to_bottom();
                self.force_next_viewport_redraw();
            }
            self.transcript_viewport.invalidate_content_layout();
        }
        reasoning_committed || committed || consolidated || status_restored
    }

    pub(super) fn mark_streaming_message_done_pending(&mut self) {
        self.streaming_message_done_pending = true;
    }

    pub(super) fn finish_streaming_message_if_ready(&mut self) -> bool {
        if !self.streaming_message_done_pending || !self.streaming_text_pending.is_empty() {
            return false;
        }
        self.streaming_message_done_pending = false;
        self.finish_completed_streaming_message()
    }

    pub(super) fn should_defer_turn_finish_for_streaming(&self) -> bool {
        !self.streaming_text_pending.is_empty() || self.streaming_message_done_pending
    }

    pub(super) fn turn_lifecycle_in_progress(&self) -> bool {
        self.turn_state.is_active()
            || self.deferred_turn_finish_pending
            || self.should_defer_turn_finish_for_streaming()
    }

    pub(super) fn defer_turn_finish_until_streaming_drained(
        &mut self,
        handle: Option<JoinHandle<()>>,
    ) {
        self.deferred_turn_finish_pending = true;
        self.deferred_turn_finish_handle = handle;
        self.set_loading(true);
    }

    pub(super) fn ready_to_complete_deferred_turn_finish(&self) -> bool {
        self.deferred_turn_finish_pending
            && self.streaming_text_pending.is_empty()
            && !self.streaming_message_done_pending
    }

    pub(super) fn take_deferred_turn_finish_handle(&mut self) -> Option<JoinHandle<()>> {
        self.deferred_turn_finish_pending = false;
        self.deferred_turn_finish_handle.take()
    }

    pub(super) fn streaming_tick_source_line_limit(&self) -> usize {
        let ready_lines = StreamController::complete_source_lines_ready(&self.active_turn);
        if ready_lines >= STREAM_CATCH_UP_QUEUE_DEPTH_LINES {
            STREAM_CATCH_UP_COMMIT_SOURCE_LINES
        } else {
            STREAM_SMOOTH_COMMIT_SOURCE_LINES
        }
    }

    pub(super) fn finish_streaming_text_status(&mut self) -> bool {
        let had_streaming_output = self.streaming_output_active;
        let changed = had_streaming_output || !self.streaming_thinking_status.is_empty();
        self.streaming_output_active = false;
        if had_streaming_output && self.active_status_detail().is_none() {
            self.streaming_status_suppressed_after_output = true;
        }
        if !self.streaming_thinking_status.is_empty() {
            self.streaming_thinking_status.clear();
            self.bump_active_turn_render_revision();
        }
        changed
    }

    pub(super) fn commit_streaming_thinking_summary(&mut self) -> bool {
        let Some(summary) = reasoning_summary_text(&self.streaming_thinking_buffer) else {
            let had_live_preview = !self.streaming_thinking_status.is_empty();
            self.streaming_thinking_buffer.clear();
            self.streaming_thinking_status.clear();
            if had_live_preview {
                self.bump_active_turn_render_revision();
            }
            return false;
        };
        let drained_prior_output = self.drain_pending_streaming_text_all();
        let committed_prior_output = self.commit_streaming_text();
        if drained_prior_output || committed_prior_output {
            self.consolidate_finished_assistant_stream();
        }
        self.streaming_thinking_buffer.clear();
        self.streaming_thinking_status.clear();
        self.bump_active_turn_render_revision();
        self.push_message(MessageRole::System, summary);
        true
    }

    pub(super) fn push_tool_running(&mut self, id: String, name: String, input: String) {
        self.spinner.mark_tool();
        self.drain_pending_streaming_text_all();
        self.streaming_message_done_pending = false;
        self.commit_streaming_thinking_summary();
        self.commit_streaming_text();
        self.consolidate_finished_assistant_stream();
        self.start_streaming_message();
        self.streaming_output_active = false;
        self.streaming_status_suppressed_after_output = false;
        self.turn_had_work_activity = true;
        let write_preview = name
            .eq_ignore_ascii_case("write")
            .then(|| WriteInputPreview::from_complete_json(&input))
            .flatten()
            .map(sanitize_write_input_preview);
        let name = sanitize_tui_text(&name);
        let input = capped_tui_text(
            &sanitize_tui_text(&input),
            ACTIVE_TOOL_INPUT_MAX_CHARS,
            "tool input",
        );
        if let Some(active) = self.active_turn.as_mut() {
            if let Some(entry) = active.entries.iter_mut().rfind(|entry| {
                matches!(entry, ActiveEntry::Tool(ToolStatus::Running { id: running_id, .. }) if running_id == &id)
            }) {
                *entry = ActiveEntry::Tool(ToolStatus::Running {
                    id,
                    name,
                    input,
                    write_preview,
                });
            } else {
                active.entries.push(ActiveEntry::Tool(ToolStatus::Running {
                    id,
                    name,
                    input,
                    write_preview,
                }));
            }
        }
        self.bump_active_turn_render_revision();
        if self.transcript_viewport.is_at_tail() {
            self.snap_to_bottom();
        }
    }

    pub(super) fn push_write_input_preview(&mut self, id: String, preview: WriteInputPreview) {
        self.drain_pending_streaming_text_all();
        self.streaming_message_done_pending = false;
        self.commit_streaming_thinking_summary();
        self.commit_streaming_text();
        self.consolidate_finished_assistant_stream();
        self.start_streaming_message();
        self.streaming_output_active = false;
        self.streaming_status_suppressed_after_output = false;
        self.turn_had_work_activity = true;
        let preview = sanitize_write_input_preview(preview);
        if let Some(active) = self.active_turn.as_mut() {
            if let Some(ActiveEntry::Tool(ToolStatus::Running {
                write_preview, ..
            })) = active.entries.iter_mut().rfind(|entry| {
                matches!(entry, ActiveEntry::Tool(ToolStatus::Running { id: running_id, .. }) if running_id == &id)
            }) {
                *write_preview = Some(preview);
            } else {
                active.entries.push(ActiveEntry::Tool(ToolStatus::Running {
                    id,
                    name: "write".to_string(),
                    input: String::new(),
                    write_preview: Some(preview),
                }));
            }
        }
        self.bump_active_turn_render_revision();
        if self.transcript_viewport.is_at_tail() {
            self.snap_to_bottom();
        }
    }

    pub(super) fn push_tool_done(
        &mut self,
        id: String,
        name: String,
        text: String,
        is_error: bool,
    ) {
        self.start_streaming_message();
        self.turn_had_work_activity = true;
        let name = sanitize_tui_text(&name);
        let text = sanitize_tui_text(&text);
        if let Some(active) = self.active_turn.as_mut() {
            // Match by tool-use id; names are not unique when the model calls
            // the same tool more than once in a turn.
            if let Some(idx) = active.entries.iter_mut().rposition(|e| match e {
                ActiveEntry::Tool(ToolStatus::Running { id: running_id, .. }) => running_id == &id,
                _ => false,
            }) {
                let (input, write_preview) = match &active.entries[idx] {
                    ActiveEntry::Tool(ToolStatus::Running {
                        input,
                        write_preview,
                        ..
                    }) => (input.clone(), write_preview.clone()),
                    _ => (String::new(), None),
                };
                let (use_text, status_text, diff_text) =
                    format_completed_tool_display(&name, &input, &text, is_error);
                active.entries[idx] = ActiveEntry::Tool(ToolStatus::Done {
                    id,
                    input,
                    use_text,
                    status_text,
                    diff_text,
                    write_preview,
                });
            } else if let Some(idx) = active.entries.iter_mut().rposition(|e| match e {
                ActiveEntry::Tool(ToolStatus::Done { id: done_id, .. }) => done_id == &id,
                _ => false,
            }) {
                let (input, write_preview) = match &active.entries[idx] {
                    ActiveEntry::Tool(ToolStatus::Done {
                        input,
                        write_preview,
                        ..
                    }) => (input.clone(), write_preview.clone()),
                    _ => (String::new(), None),
                };
                let (use_text, status_text, diff_text) =
                    format_completed_tool_display(&name, &input, &text, is_error);
                active.entries[idx] = ActiveEntry::Tool(ToolStatus::Done {
                    id,
                    input,
                    use_text,
                    status_text,
                    diff_text,
                    write_preview,
                });
            } else {
                let (use_text, status_text, diff_text) =
                    format_completed_tool_display(&name, "", &text, is_error);
                active.entries.push(ActiveEntry::Tool(ToolStatus::Done {
                    id,
                    input: String::new(),
                    use_text,
                    status_text,
                    diff_text,
                    write_preview: None,
                }));
            }
        }
        self.bump_active_turn_render_revision();
        let still_running = self.active_turn.as_ref().is_some_and(|active| {
            active
                .entries
                .iter()
                .any(|entry| matches!(entry, ActiveEntry::Tool(ToolStatus::Running { .. })))
        });
        if still_running {
            self.spinner.mark_tool();
        } else {
            self.spinner.mark_requesting();
        }
        if self.transcript_viewport.is_at_tail() {
            self.snap_to_bottom();
        }
    }

    /// Commit the stable active-turn prefix. A live delegated-task panel must
    /// remain redrawable until every member reaches a terminal state; native
    /// terminal scrollback cannot be edited after it has been appended.
    ///
    /// Entries are committed in the same order their events arrived from the
    /// engine, preserving assistant text and tool calls in the order the model
    /// produced them. Thinking deltas are summarized separately.
    pub(super) fn flush_active_turn(&mut self) {
        self.drain_pending_streaming_text_all();
        self.streaming_message_done_pending = false;
        self.streaming_output_active = false;
        self.streaming_status_suppressed_after_output = false;
        self.streaming_thinking_status.clear();
        self.streaming_thinking_buffer.clear();
        let has_live_subagent_panel = self.active_turn.as_ref().is_some_and(|active| {
            active.entries.iter().any(
                |entry| matches!(entry, ActiveEntry::SubagentPanel(panel) if !panel.all_terminal()),
            )
        });
        let messages = if has_live_subagent_panel {
            StreamController::commit_stable_prefix(&mut self.active_turn, true)
        } else {
            StreamController::flush(&mut self.active_turn, true)
        };
        if messages.is_empty() {
            return;
        }
        self.bump_active_turn_render_revision();
        self.active_tools_expanded = false;

        for msg in messages {
            self.push_message(msg.role, msg.text);
        }
    }

    pub(super) fn flush_terminal_subagent_panel_if_idle(&mut self) {
        if self.is_loading {
            return;
        }
        let has_live_panel = self.active_turn.as_ref().is_some_and(|active| {
            active.entries.iter().any(
                |entry| matches!(entry, ActiveEntry::SubagentPanel(panel) if !panel.all_terminal()),
            )
        });
        if !has_live_panel {
            self.flush_active_turn();
        }
    }

    pub(super) fn finish_turn_separator_text(&mut self) -> Option<String> {
        let started_at = self.turn_started_at.take();
        let had_work_activity = std::mem::take(&mut self.turn_had_work_activity);
        if !had_work_activity {
            return None;
        }
        let started_at = started_at?;
        let label = format!(
            "Worked for {}",
            format_worked_duration(started_at.elapsed())
        );
        Some(format!("{TURN_DIVIDER_PREFIX}{label}"))
    }
}

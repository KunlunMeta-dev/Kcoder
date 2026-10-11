//! History projection, replay, committed stream chunks, and external editor.

use super::*;

impl ReplApp {
    pub fn push_message(&mut self, role: MessageRole, text: impl Into<String>) {
        let text = sanitize_tui_text(&text.into());
        if display_text_is_hidden_internal_context(&text, role == MessageRole::User) {
            return;
        }
        self.preserve_review_before_content_change();
        self.messages.push(DisplayMessage { role, text });
        if self.transcript_viewport.is_at_tail() {
            self.snap_to_bottom();
        }
    }

    pub(crate) fn clear_conversation_ui(&mut self, engine: &QueryEngine) -> bool {
        if let Err(error) = engine.start_new_session() {
            self.push_message(MessageRole::System, format!("无法新建会话：{error}"));
            return false;
        }
        self.reset_transcript_state_after_clear();
        engine.active_skills.write().unwrap().clear();
        self.refresh_engine_metadata(engine);
        self.push_message(
            MessageRole::System,
            "Conversation cleared. Type /help for available commands.",
        );
        true
    }

    pub(super) fn edit_previous_message(&mut self, engine: &QueryEngine) {
        self.clear_edit_previous_prompt();
        let state_messages = engine.state.messages();
        // Skip hidden internal user messages (goal continuations, sub-agent
        // follow-up nudges): they are user-role in engine state but never
        // appear in the UI transcript. Editing one would leak the internal
        // scaffolding into the composer and desync the two truncation points.
        let Some(state_index) = state_messages.iter().rposition(|message| {
            matches!(message, Message::User { .. }) && !message_is_hidden_internal_context(message)
        }) else {
            self.push_message(MessageRole::System, "No previous message to edit.");
            return;
        };
        let prefill = editable_user_message_text(&state_messages[state_index]);

        let mut truncated_state = state_messages;
        truncated_state.truncate(state_index);
        engine.state.set_messages(truncated_state);

        if let Some(ui_index) = self
            .messages
            .iter()
            .rposition(|message| message.role == MessageRole::User)
        {
            self.messages.truncate(ui_index);
        }
        self.reset_transcript_derived_after_rewrite();
        self.prefill_input(prefill);
    }

    pub(super) fn last_assistant_response_text(&self) -> Option<&str> {
        self.messages
            .iter()
            .rev()
            .find(|message| message.role == MessageRole::Assistant && !message.text.is_empty())
            .map(|message| message.text.as_str())
    }

    pub(crate) fn copy_last_assistant_response(&mut self) {
        self.copy_last_assistant_response_with(clipboard_copy::copy_to_clipboard);
    }

    pub(super) fn copy_last_assistant_response_with(
        &mut self,
        copy_fn: impl FnOnce(&str) -> std::result::Result<clipboard_copy::ClipboardCopyResult, String>,
    ) {
        match self.last_assistant_response_text().map(str::to_string) {
            Some(text) => match copy_fn(&text) {
                Ok(result) => {
                    let (lease, copy_kind) = result.into_parts();
                    self.clipboard_lease = lease;
                    if copy_kind == clipboard_copy::ClipboardCopyKind::Osc52 {
                        self.push_message(MessageRole::System, clipboard_copy::OSC52_COPY_NOTICE)
                    } else {
                        self.push_message(MessageRole::System, "Copied last message to clipboard")
                    }
                }
                Err(error) => {
                    self.push_message(MessageRole::System, format!("Copy failed: {error}"))
                }
            },
            None => self.push_message(MessageRole::System, "No agent response to copy"),
        }
    }

    pub(super) fn composer_text_for_external_editor(&self) -> String {
        expand_pending_pastes(&self.input, &self.pending_pastes)
    }

    pub(super) fn apply_external_edit(&mut self, text: impl AsRef<str>) {
        self.reset_input_history_navigation();
        let normalized = text.as_ref().replace("\r\n", "\n").replace('\r', "\n");
        self.input = sanitize_tui_text(&normalized);
        self.pending_pastes.clear();
        self.cursor_grapheme_index = self.input_graphemes().len();
        self.input_scroll_row = 0;
        self.sync_composer_sidecars();
        self.clamp_input_scroll(self.last_input_width);
        self.force_next_viewport_redraw();
    }

    pub(super) fn resolve_external_editor_command_or_report(&mut self) -> Option<Vec<String>> {
        Some(match external_editor::resolve_editor_command() {
            Ok(cmd) => cmd,
            Err(external_editor::EditorError::MissingEditor) => {
                self.push_message(
                    MessageRole::System,
                    "Cannot open external editor: set $VISUAL or $EDITOR before starting KCoder.",
                );
                return None;
            }
            Err(error) => {
                self.push_message(
                    MessageRole::System,
                    format!("Failed to open editor: {error}"),
                );
                return None;
            }
        })
    }

    pub(super) fn finish_external_editor_result(&mut self, result: Result<String>) {
        match result {
            Ok(edited) => self.apply_external_edit(edited.trim_end()),
            Err(error) => self.push_message(
                MessageRole::System,
                format!("Failed to open editor: {error:#}"),
            ),
        }
    }

    pub(super) async fn open_external_editor(&mut self) {
        let Some(editor_cmd) = self.resolve_external_editor_command_or_report() else {
            return;
        };
        let seed = self.composer_text_for_external_editor();
        let result = external_editor::run_editor(&seed, &editor_cmd).await;
        self.finish_external_editor_result(result);
    }

    pub(super) async fn open_external_editor_with_restored_terminal<B: Backend + Write>(
        &mut self,
        terminal: &mut Terminal<B>,
        terminal_guard: &mut TerminalGuard,
        terminal_events: &TerminalEventController,
        frame_requester: &FrameRequester,
    ) -> Result<()> {
        let Some(editor_cmd) = self.resolve_external_editor_command_or_report() else {
            return Ok(());
        };
        let seed = self.composer_text_for_external_editor();

        terminal_events.pause().await;
        terminal
            .reset_cursor_style()
            .context("failed to reset cursor style before external editor")?;
        let _ = terminal.show_cursor();
        std::io::Write::flush(terminal.backend_mut())
            .context("failed to flush terminal before external editor")?;
        let restored_state = terminal_guard.restore_for_external_program_keep_raw();

        let editor_result = external_editor::run_editor(&seed, &editor_cmd).await;

        let reenter_result = terminal_guard
            .reenter_after_external_program(restored_state)
            .context("failed to re-enter KCoder terminal after external editor");
        flush_terminal_input_buffer();
        terminal_events.resume();
        terminal.invalidate_viewport();
        self.force_next_viewport_redraw();
        frame_requester.schedule_frame();
        self.finish_external_editor_result(editor_result);
        reenter_result
    }

    pub(super) fn push_committed_active_message(
        &mut self,
        role: MessageRole,
        text: impl Into<String>,
    ) {
        self.push_committed_active_message_with_merge(role, text, true);
    }

    pub(super) fn push_committed_stream_chunk(
        &mut self,
        role: MessageRole,
        text: impl Into<String>,
    ) {
        if role == MessageRole::Assistant && self.streaming_transcript_start.is_none() {
            self.streaming_transcript_start = Some(self.messages.len());
        }
        self.push_committed_active_message_with_merge(role, text, false);
    }

    pub(super) fn push_committed_active_message_with_merge(
        &mut self,
        role: MessageRole,
        text: impl Into<String>,
        merge_assistant: bool,
    ) {
        self.preserve_review_before_content_change();
        let text = sanitize_tui_text(&text.into());
        if merge_assistant
            && role == MessageRole::Assistant
            && self.messages.len() > self.scrollback_committed_until
            && self.messages.append_to_last_assistant(&text)
        {
            if self.transcript_viewport.is_at_tail() {
                self.snap_to_bottom();
            }
            return;
        }
        self.push_message(role, text);
    }

    pub(super) fn active_turn_contains_assistant_text(&self) -> bool {
        self.active_turn.as_ref().is_some_and(|active| {
            active
                .entries
                .iter()
                .any(|entry| matches!(entry, ActiveEntry::Text(_)))
        })
    }

    pub(super) fn consolidate_finished_assistant_stream(&mut self) -> bool {
        if self.active_turn_contains_assistant_text() {
            return false;
        }
        let Some(stream_start) = self.streaming_transcript_start else {
            return false;
        };
        let touches_committed_scrollback = stream_start < self.scrollback_committed_until;
        if touches_committed_scrollback {
            self.streaming_transcript_start = None;
            return false;
        }

        let consolidated = self
            .messages
            .consolidate_trailing_assistant_run_from(stream_start)
            .is_some();
        self.streaming_transcript_start = None;
        if !consolidated {
            return false;
        }
        self.render_cache.clear();
        self.active_turn_render_cache = None;

        if touches_committed_scrollback {
            self.transcript_reflow.clear();
        }
        self.scrollback_committed_until = self.scrollback_committed_until.min(self.messages.len());
        if self.transcript_viewport.is_at_tail() {
            self.snap_to_bottom();
        }
        true
    }

    pub(super) fn scrollback_commit_target(&self, committed_until: usize) -> usize {
        let committed_until = committed_until.min(self.messages.len());
        let natural = transcript_scrollback_commit_target(self.messages.len(), committed_until);
        self.messages
            .iter()
            .enumerate()
            .skip(committed_until)
            .take(natural.saturating_sub(committed_until))
            .find_map(|(index, message)| {
                decode_panel_message(&message.text)
                    .is_some_and(|panel| !panel.all_terminal())
                    .then_some(index)
            })
            .unwrap_or(natural)
    }

    pub(super) fn scrollback_commit_target_for_viewport(
        &self,
        committed_until: usize,
        _width: u16,
        visible_rows: usize,
    ) -> usize {
        let committed_until = committed_until.min(self.messages.len());
        let natural = self.scrollback_commit_target(committed_until);
        if self.inline_turn_uses_live_tail()
            && let Some(turn_start) = self.recent_turn_transcript_start
        {
            // Inline mode may move earlier current-turn content into native scrollback, while
            // retaining roughly one viewport of the newest tail so changes remain visible.
            // Release the holdback and archive the complete tail when the turn finishes.
            let retained_messages = visible_rows.clamp(1, TRANSCRIPT_RENDER_MAX_MESSAGES);
            return natural
                .saturating_sub(retained_messages)
                .max(turn_start)
                .max(committed_until)
                .min(natural);
        }
        natural
    }

    pub(crate) fn replace_transcript_from_history(&mut self, messages: &[Message]) {
        self.path_previews.clear();
        self.deferred_resumed_transcript = None;
        let prior_subagent_members = self
            .subagent_panels
            .values()
            .flat_map(|panel| panel.members.iter())
            .map(|member| (member.tool_call_id.clone(), member.clone()))
            .collect::<HashMap<_, _>>();
        self.messages.clear();
        self.scrollback_committed_until = 0;
        self.welcome_scrollback_committed = false;
        self.startup_live_viewport_top_limit = None;
        self.transcript_reflow.clear();
        self.render_cache.clear();
        self.transcript_viewport.replace_content();
        self.active_turn = None;
        self.bump_active_turn_render_revision();
        self.active_turn_render_cache = None;
        self.clear_streaming_presentation_state();
        self.streaming_output_active = false;
        self.streaming_status_suppressed_after_output = false;
        self.streaming_transcript_start = None;
        self.recent_turn_transcript_start = None;
        self.clear_subagent_panel_state();

        let tool_uses = collect_tool_use_lookup(messages);
        let tool_results = messages
            .iter()
            .flat_map(|message| match message {
                Message::User { content, .. } | Message::Assistant { content, .. } => {
                    content.iter()
                }
            })
            .filter_map(|block| match block {
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => Some((
                    tool_use_id.clone(),
                    (content_blocks_text(content), is_error.unwrap_or(false)),
                )),
                _ => None,
            })
            .collect::<HashMap<_, _>>();
        for msg in messages {
            if message_is_hidden_internal_context(msg) {
                continue;
            }
            self.push_history_message(msg, &tool_uses, &tool_results);
        }
        let panel_ids = self.subagent_panels.keys().copied().collect::<Vec<_>>();
        for panel_id in panel_ids {
            if let Some(panel) = self.subagent_panels.get_mut(&panel_id) {
                for member in &mut panel.members {
                    let Some(prior) = prior_subagent_members.get(&member.tool_call_id) else {
                        continue;
                    };
                    if member.phase.is_terminal() || prior.phase.is_terminal() {
                        continue;
                    }
                    member.phase = prior.phase;
                    member.delivery = prior.delivery;
                    member.status_text = prior.status_text.clone();
                    member.latest_model_text = prior.latest_model_text.clone();
                    member.current = prior.current;
                    member.total = prior.total;
                    if member.agent_id.is_none() {
                        member.agent_id = prior.agent_id.clone();
                    }
                }
            }
            self.sync_subagent_panel(panel_id);
        }
        self.snap_to_bottom();
        self.force_next_viewport_redraw();
    }

    pub(super) fn replace_transcript_from_resumed_tail(
        &mut self,
        messages: &[Message],
        history: PreparedTranscriptHistory,
        loaded_start: usize,
    ) {
        self.replace_transcript_from_history(messages);
        if loaded_start > 0 {
            self.deferred_resumed_transcript = Some(DeferredResumedTranscript {
                history,
                loaded_display_len: self.messages.len(),
            });
        }
    }

    pub(super) fn push_history_message(
        &mut self,
        message: &Message,
        tool_uses: &HashMap<String, (String, String)>,
        tool_results: &HashMap<String, (String, bool)>,
    ) {
        match message {
            Message::User { content, .. }
                if Self::user_content_blocks_can_merge_for_display(content) =>
            {
                let text = content_blocks_text(content);
                if !text.is_empty() {
                    self.push_message(MessageRole::User, text);
                }
            }
            Message::User { content, .. } => {
                for block in content {
                    self.push_history_block(MessageRole::User, block, tool_uses);
                }
            }
            Message::Assistant { content, .. } => {
                let mut panel = None;
                for block in content {
                    if let ContentBlock::ToolUse { id, name, input } = block
                        && history_tool_starts_subagent_panel(name, id, tool_results)
                    {
                        let current = panel.get_or_insert_with(|| {
                            let panel_id = self.next_subagent_panel_id;
                            self.next_subagent_panel_id =
                                self.next_subagent_panel_id.wrapping_add(1).max(1);
                            SubagentPanel::new(panel_id)
                        });
                        current.add_pending(
                            id.clone(),
                            subagent_item_text(name, &input.to_string()),
                            subagent_requested_delivery(&input.to_string()),
                        );
                        if let Some((output, is_error)) = tool_results.get(id) {
                            let result = parse_subagent_result(output, *is_error);
                            if let Some(agent_id) = result.agent_id.as_deref() {
                                current.associate(
                                    id,
                                    agent_id,
                                    if result.background {
                                        SubagentDelivery::Background
                                    } else {
                                        SubagentDelivery::Foreground
                                    },
                                );
                                if let Some(detail) = result.detail.as_deref() {
                                    current.update_progress(
                                        agent_id,
                                        "Writing response",
                                        Some(detail),
                                        None,
                                        None,
                                    );
                                }
                                match result.status.as_str() {
                                    "running" | "resuming" => {
                                        if result.background {
                                            current.promote(agent_id);
                                        } else {
                                            current.update_progress(
                                                agent_id, "Running", None, None, None,
                                            );
                                        }
                                    }
                                    "failed" => {
                                        current.finish(agent_id, SubagentPhase::Failed, "Failed");
                                    }
                                    "cancelled" => {
                                        current.finish(
                                            agent_id,
                                            SubagentPhase::Cancelled,
                                            "Cancelled",
                                        );
                                    }
                                    _ => {
                                        current.finish(
                                            agent_id,
                                            SubagentPhase::Completed,
                                            "Completed",
                                        );
                                    }
                                }
                            } else if !matches!(result.status.as_str(), "running" | "resuming") {
                                let (phase, label) = match result.status.as_str() {
                                    "failed" => (SubagentPhase::Failed, "Failed"),
                                    "cancelled" => (SubagentPhase::Cancelled, "Cancelled"),
                                    _ => (SubagentPhase::Completed, "Completed"),
                                };
                                current.finish_tool_call(id, phase, label);
                            }
                        }
                        continue;
                    }
                    self.commit_replayed_subagent_panel(panel.take());
                    self.push_history_block(MessageRole::Assistant, block, tool_uses);
                }
                self.commit_replayed_subagent_panel(panel);
            }
        }
    }

    pub(super) fn commit_replayed_subagent_panel(&mut self, panel: Option<SubagentPanel>) {
        let Some(panel) = panel else {
            return;
        };
        for member in &panel.members {
            if let Some(agent_id) = member.agent_id.as_ref() {
                self.subagent_panel_by_agent
                    .insert(agent_id.clone(), panel.id);
            }
        }
        self.subagent_panels.insert(panel.id, panel.clone());
        self.push_message(MessageRole::System, panel.encode_message());
    }

    pub(super) fn user_content_blocks_can_merge_for_display(content: &[ContentBlock]) -> bool {
        content.iter().all(|block| {
            matches!(
                block,
                ContentBlock::Text { .. }
                    | ContentBlock::Image { .. }
                    | ContentBlock::Thinking { .. }
                    | ContentBlock::RedactedThinking { .. }
            )
        })
    }

    pub(super) fn push_history_block(
        &mut self,
        message_role: MessageRole,
        block: &ContentBlock,
        tool_uses: &HashMap<String, (String, String)>,
    ) {
        match block {
            ContentBlock::Text { text } => {
                if !text.is_empty() {
                    self.push_message(message_role, text.clone());
                }
            }
            ContentBlock::ToolUse { name, input, .. } => {
                self.push_message(
                    MessageRole::System,
                    format_tool_use(name, &input.to_string()),
                );
            }
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                let output = content_blocks_text(content);
                let (name, input) = tool_uses
                    .get(tool_use_id)
                    .cloned()
                    .unwrap_or_else(|| (tool_use_id.clone(), String::new()));
                if is_subagent_tool_name(&name)
                    || (is_send_message_tool_name(&name)
                        && matches!(
                            parse_subagent_result(&output, is_error.unwrap_or(false))
                                .status
                                .as_str(),
                            "running" | "resuming"
                        ))
                {
                    return;
                }
                let (_, status_text, diff_text) = format_completed_tool_display(
                    &name,
                    &input,
                    &output,
                    is_error.unwrap_or(false),
                );
                if !status_text.is_empty() {
                    self.push_message(MessageRole::System, status_text);
                }
                if let Some(diff) = diff_text {
                    self.push_message(MessageRole::System, diff);
                }
            }
            ContentBlock::Image { source } => {
                self.push_message(message_role, format!("[image: {}]", source.media_type));
            }
            ContentBlock::Thinking { thinking, .. } => {
                if let Some(summary) = reasoning_summary_text(thinking) {
                    self.push_message(MessageRole::System, summary);
                }
            }
            ContentBlock::RedactedThinking { .. } => {}
        }
    }
}

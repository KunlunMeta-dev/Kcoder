//! Transcript block rendering and active-turn rendering.

use super::*;

impl ReplApp {
    #[cfg(test)]
    pub(super) fn render_transcript_range(
        &mut self,
        start_idx: usize,
        end_idx: usize,
        width: u16,
    ) -> Vec<Line<'static>> {
        self.render_transcript_range_limited(start_idx, end_idx, width, None)
    }

    pub(super) fn render_transcript_range_hyperlink(
        &mut self,
        start_idx: usize,
        end_idx: usize,
        width: u16,
    ) -> Vec<HyperlinkLine> {
        let end_idx = end_idx.min(self.messages.len());
        if start_idx >= end_idx {
            return Vec::new();
        }

        let visible_messages = &self.messages[start_idx..end_idx];
        let tool_transcript_expanded = self.effective_tool_transcript_expanded();
        let tool_output_expanded = self.effective_tool_output_expanded();
        let render_markdown = self.effective_render_markdown();
        let render_items = collapse_tool_runs_with_recent_expanded(
            visible_messages,
            start_idx,
            !tool_transcript_expanded,
            TOOL_SUMMARY_MIN_RUN_LEN,
            self.recent_turn_transcript_start,
        );
        let mut visible_lines: Vec<HyperlinkLine> = Vec::new();
        for item in render_items {
            match item {
                TranscriptRenderItem::Message {
                    absolute_idx,
                    message,
                } => {
                    let assistant_continuation =
                        assistant_message_is_continuation(&self.messages, absolute_idx);
                    let lines = if let Some(divider) = render_turn_divider_message(message, width) {
                        annotate_web_urls(divider)
                    } else {
                        render_message_hyperlink_continuation(
                            message,
                            MessageRenderOptions {
                                rail: None,
                                is_last_tool: false,
                                expanded: tool_output_expanded,
                                render_markdown,
                                code_theme: &self.code_theme,
                                width: Some(width),
                                assistant_continuation,
                            },
                        )
                    };
                    if !lines.is_empty() {
                        visible_lines.extend(lines);
                        if !assistant_message_continues_next(&self.messages, absolute_idx) {
                            push_hyperlink_separator_after_message(&mut visible_lines);
                        }
                    }
                }
                TranscriptRenderItem::ToolPair { message, .. } => {
                    let lines = render_message_hyperlink(
                        &message,
                        None,
                        false,
                        tool_output_expanded,
                        render_markdown,
                        &self.code_theme,
                        Some(width),
                    );
                    if !lines.is_empty() {
                        visible_lines.extend(lines);
                        push_hyperlink_separator_after_message(&mut visible_lines);
                    }
                }
                TranscriptRenderItem::ToolSummary { message, .. } => {
                    let lines = render_message_hyperlink(
                        &message,
                        None,
                        false,
                        tool_output_expanded,
                        render_markdown,
                        &self.code_theme,
                        Some(width),
                    );
                    if !lines.is_empty() {
                        visible_lines.extend(lines);
                        push_hyperlink_separator_after_message(&mut visible_lines);
                    }
                }
            }
        }
        visible_lines
    }

    pub(super) fn render_transcript_range_limited(
        &mut self,
        start_idx: usize,
        end_idx: usize,
        width: u16,
        max_lines: Option<usize>,
    ) -> Vec<Line<'static>> {
        self.render_transcript_range_limited_with_mode(
            start_idx,
            end_idx,
            width,
            max_lines,
            LineLimitMode::Head,
        )
    }

    pub(super) fn render_transcript_range_limited_with_mode(
        &mut self,
        start_idx: usize,
        end_idx: usize,
        width: u16,
        max_lines: Option<usize>,
        limit_mode: LineLimitMode,
    ) -> Vec<Line<'static>> {
        self.render_transcript_range_measured(
            start_idx, end_idx, width, max_lines, limit_mode, false,
        )
    }

    pub(super) fn render_transcript_range_measured(
        &mut self,
        start_idx: usize,
        end_idx: usize,
        width: u16,
        max_lines: Option<usize>,
        limit_mode: LineLimitMode,
        record_rows: bool,
    ) -> Vec<Line<'static>> {
        let end_idx = end_idx.min(self.messages.len());
        if start_idx >= end_idx {
            return Vec::new();
        }

        let tool_transcript_expanded = self.effective_tool_transcript_expanded();
        let tool_output_expanded = self.effective_tool_output_expanded();
        let render_markdown = self.effective_render_markdown();
        self.render_cache.invalidate_if_stale(
            width,
            self.messages.render_epoch(),
            render_markdown,
            &self.code_theme,
            tool_output_expanded,
        );

        let visible_messages = &self.messages[start_idx..end_idx];
        let render_items = collapse_tool_runs_with_recent_expanded(
            visible_messages,
            start_idx,
            !tool_transcript_expanded,
            TOOL_SUMMARY_MIN_RUN_LEN,
            self.recent_turn_transcript_start,
        );
        let mut visible_lines: Vec<Line<'static>> = Vec::new();
        let mut measured = Vec::new();
        let mut measured_end = start_idx;
        for item in render_items {
            let (source_start, source_end) = match &item {
                TranscriptRenderItem::Message { absolute_idx, .. }
                | TranscriptRenderItem::ToolSummary { absolute_idx, .. } => {
                    (*absolute_idx, *absolute_idx + 1)
                }
                TranscriptRenderItem::ToolPair { absolute_idx, .. } => {
                    (*absolute_idx, *absolute_idx + 2)
                }
            };
            let before = visible_lines.len();
            match item {
                TranscriptRenderItem::Message {
                    absolute_idx,
                    message,
                } => {
                    let assistant_continuation =
                        assistant_message_is_continuation(&self.messages, absolute_idx);
                    let lines = if let Some(divider) = render_turn_divider_message(message, width) {
                        divider
                    } else {
                        match self.render_cache.get(
                            absolute_idx,
                            None,
                            false,
                            assistant_continuation,
                        ) {
                            Some(cached) => cached.clone(),
                            None => {
                                let rendered = render_message_with_width_continuation(
                                    message,
                                    MessageRenderOptions {
                                        rail: None,
                                        is_last_tool: false,
                                        expanded: tool_output_expanded,
                                        render_markdown,
                                        code_theme: &self.code_theme,
                                        width: Some(width),
                                        assistant_continuation,
                                    },
                                );
                                self.render_cache.insert(
                                    absolute_idx,
                                    None,
                                    false,
                                    assistant_continuation,
                                    rendered.clone(),
                                );
                                rendered
                            }
                        }
                    };
                    if !lines.is_empty() {
                        visible_lines.extend(lines);
                        if !assistant_message_continues_next(&self.messages, absolute_idx) {
                            push_separator_after_message(&mut visible_lines);
                        }
                    }
                }
                TranscriptRenderItem::ToolPair { message, .. } => {
                    let lines = render_message_with_width(
                        &message,
                        None,
                        false,
                        tool_output_expanded,
                        render_markdown,
                        &self.code_theme,
                        Some(width),
                    );
                    if !lines.is_empty() {
                        visible_lines.extend(lines);
                        push_separator_after_message(&mut visible_lines);
                    }
                }
                TranscriptRenderItem::ToolSummary { message, .. } => {
                    let lines = render_message_with_width(
                        &message,
                        None,
                        false,
                        tool_output_expanded,
                        render_markdown,
                        &self.code_theme,
                        Some(width),
                    );
                    if !lines.is_empty() {
                        visible_lines.extend(lines);
                        push_separator_after_message(&mut visible_lines);
                    }
                }
            }
            if record_rows {
                measured.push((
                    source_start,
                    source_end,
                    paragraph_line_count(&visible_lines[before..], width),
                ));
                measured_end = source_end;
            }
            if let Some(max_lines) = max_lines
                && visible_lines.len() >= max_lines
            {
                match limit_mode {
                    LineLimitMode::Head => {
                        visible_lines.truncate(max_lines);
                        break;
                    }
                    LineLimitMode::Tail => {
                        let excess = visible_lines.len().saturating_sub(max_lines);
                        if excess > 0 {
                            visible_lines.drain(..excess);
                        }
                    }
                }
            }
        }
        if record_rows {
            // Skipped messages in a collapsed run occupy zero rows. Do not
            // erase estimates for unvisited messages beyond the draw limit.
            if max_lines.is_none() || visible_lines.len() < max_lines.unwrap_or(usize::MAX) {
                measured_end = end_idx;
            }
            self.transcript_row_index
                .correct_rendered_rows(start_idx, measured_end, &measured);
        }
        visible_lines
    }

    pub(super) fn active_turn_display_messages_for_render(&self) -> Vec<DisplayMessage> {
        if self.agent_view.is_some() {
            return Vec::new();
        }
        let mut messages = self
            .active_turn
            .as_ref()
            .map(|active| active.display_messages(self.effective_active_tools_expanded()))
            .unwrap_or_default();
        if !self.streaming_thinking_status.trim().is_empty() {
            messages.push(DisplayMessage {
                role: MessageRole::System,
                text: format!(
                    "{LIVE_THINKING_MESSAGE_PREFIX}{}",
                    self.streaming_thinking_status
                ),
            });
        }
        messages
    }

    pub(super) fn render_display_messages_limited_with_mode(
        &mut self,
        visible_messages: &[DisplayMessage],
        width: u16,
        max_lines: Option<usize>,
        limit_mode: LineLimitMode,
        active_from: Option<usize>,
    ) -> Vec<Line<'static>> {
        self.render_display_messages_keyed_with_mode(
            visible_messages,
            width,
            max_lines,
            limit_mode,
            self.effective_tool_output_expanded(),
            active_from,
        )
    }

    pub(super) fn render_display_messages_keyed_with_mode(
        &mut self,
        visible_messages: &[DisplayMessage],
        width: u16,
        max_lines: Option<usize>,
        limit_mode: LineLimitMode,
        tool_output_expanded: bool,
        active_from: Option<usize>,
    ) -> Vec<Line<'static>> {
        if visible_messages.is_empty() {
            return Vec::new();
        }

        let tool_transcript_expanded = self.effective_tool_transcript_expanded();
        let render_markdown = self.effective_render_markdown();
        let render_items = collapse_tool_runs_with_minimum(
            visible_messages,
            0,
            !tool_transcript_expanded,
            TOOL_SUMMARY_MIN_RUN_LEN,
        );
        let mut visible_lines: Vec<Line<'static>> = Vec::new();
        for item in render_items {
            let block_lines = match item {
                TranscriptRenderItem::Message {
                    absolute_idx,
                    message,
                } => {
                    let is_active = active_from.is_some_and(|start| absolute_idx >= start);
                    if let Some(mut lines) = render_panel_message(
                        &message.text,
                        width,
                        self.subagent_animation_started_at.elapsed(),
                        max_lines,
                    ) {
                        push_separator_after_message(&mut lines);
                        visible_lines.extend(lines);
                        if let Some(max_lines) = max_lines
                            && visible_lines.len() >= max_lines
                        {
                            match limit_mode {
                                LineLimitMode::Head => {
                                    visible_lines.truncate(max_lines);
                                    break;
                                }
                                LineLimitMode::Tail => {
                                    let excess = visible_lines.len().saturating_sub(max_lines);
                                    visible_lines.drain(..excess);
                                }
                            }
                        }
                        continue;
                    }
                    let assistant_continuation =
                        assistant_message_is_continuation(visible_messages, absolute_idx);
                    let assistant_continues_next =
                        assistant_message_continues_next(visible_messages, absolute_idx);
                    // Streaming and completed states share Markdown rules. Code highlighting
                    // reuses incremental state with per-block limits; crossing a message-size
                    // threshold must not remove formatting and color from the whole message.
                    let message_render_markdown = render_markdown;
                    let key = keyed_transcript_block_fingerprint(
                        message,
                        width,
                        tool_output_expanded,
                        message_render_markdown,
                        &self.code_theme,
                        assistant_continuation,
                        assistant_continues_next,
                    );
                    if !is_active
                        && let Some(lines) = self.keyed_transcript_block_render_cache.get(key)
                    {
                        lines
                    } else {
                        let mut lines =
                            if let Some(divider) = render_turn_divider_message(message, width) {
                                divider
                            } else {
                                render_message_with_width_continuation(
                                    message,
                                    MessageRenderOptions {
                                        rail: None,
                                        is_last_tool: false,
                                        expanded: tool_output_expanded,
                                        render_markdown: message_render_markdown,
                                        code_theme: &self.code_theme,
                                        width: Some(width),
                                        assistant_continuation,
                                    },
                                )
                            };
                        if !lines.is_empty() && !assistant_continues_next {
                            push_separator_after_message(&mut lines);
                        }
                        if !is_active {
                            self.keyed_transcript_block_render_cache
                                .insert(key, lines.clone());
                        }
                        lines
                    }
                }
                TranscriptRenderItem::ToolPair { message, .. } => {
                    let key = keyed_transcript_block_fingerprint(
                        &message,
                        width,
                        tool_output_expanded,
                        render_markdown,
                        &self.code_theme,
                        false,
                        false,
                    );
                    if let Some(lines) = self.keyed_transcript_block_render_cache.get(key) {
                        lines
                    } else {
                        let mut lines = render_message_with_width(
                            &message,
                            None,
                            false,
                            tool_output_expanded,
                            render_markdown,
                            &self.code_theme,
                            Some(width),
                        );
                        if !lines.is_empty() {
                            push_separator_after_message(&mut lines);
                        }
                        self.keyed_transcript_block_render_cache
                            .insert(key, lines.clone());
                        lines
                    }
                }
                TranscriptRenderItem::ToolSummary {
                    absolute_idx,
                    message,
                } => {
                    let animate = self.spinner.is_running()
                        && active_from.is_some_and(|start| absolute_idx >= start);
                    if animate {
                        let indicator =
                            motion::tool_summary_frame(self.spinner.snapshot().phase_elapsed);
                        let mut lines =
                            render_tool_summary_message(&message, indicator, &self.code_theme);
                        if !lines.is_empty() {
                            push_separator_after_message(&mut lines);
                        }
                        lines
                    } else {
                        let key = keyed_transcript_block_fingerprint(
                            &message,
                            width,
                            tool_output_expanded,
                            render_markdown,
                            &self.code_theme,
                            false,
                            false,
                        );
                        if let Some(lines) = self.keyed_transcript_block_render_cache.get(key) {
                            lines
                        } else {
                            let mut lines = render_message_with_width(
                                &message,
                                None,
                                false,
                                tool_output_expanded,
                                render_markdown,
                                &self.code_theme,
                                Some(width),
                            );
                            if !lines.is_empty() {
                                push_separator_after_message(&mut lines);
                            }
                            self.keyed_transcript_block_render_cache
                                .insert(key, lines.clone());
                            lines
                        }
                    }
                }
            };
            if !block_lines.is_empty() {
                visible_lines.extend(block_lines);
            }
            if let Some(max_lines) = max_lines
                && visible_lines.len() >= max_lines
            {
                match limit_mode {
                    LineLimitMode::Head => {
                        visible_lines.truncate(max_lines);
                        break;
                    }
                    LineLimitMode::Tail => {
                        let excess = visible_lines.len().saturating_sub(max_lines);
                        if excess > 0 {
                            visible_lines.drain(..excess);
                        }
                    }
                }
            }
        }
        visible_lines
    }

    pub(super) fn render_active_turn_lines(&mut self, width: u16) -> Vec<Line<'static>> {
        if self.agent_view.is_some() {
            self.active_turn_render_cache = None;
            return Vec::new();
        }
        if self.active_turn.is_none() && self.streaming_thinking_status.trim().is_empty() {
            self.active_turn_render_cache = None;
            return Vec::new();
        }

        let active_tools_expanded = self.effective_active_tools_expanded();
        let tool_transcript_expanded = self.effective_tool_transcript_expanded();
        let render_markdown = self.effective_render_markdown();
        let active_messages = self.active_turn_display_messages_for_render();
        let key = ActiveTurnRenderCacheKey {
            active_render_revision: self.active_turn_render_revision,
            active_tools_expanded,
            tool_transcript_expanded,
            render_markdown,
            code_theme: self.code_theme.clone(),
            width,
            tool_summary_indicator: self.active_tool_summary_indicator(),
        };
        if let Some(cache) = self
            .active_turn_render_cache
            .as_ref()
            .filter(|cache| cache.key == key)
        {
            return cache.lines.clone();
        }

        let visible_lines = self.render_display_messages_keyed_with_mode(
            &active_messages,
            width,
            None,
            LineLimitMode::Head,
            active_tools_expanded,
            Some(0),
        );

        self.active_turn_render_cache = Some(ActiveTurnRenderCache {
            key,
            lines: visible_lines.clone(),
        });
        visible_lines
    }
}

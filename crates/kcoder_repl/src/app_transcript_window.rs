//! Transcript tail/window selection and bounded render caches.

use super::*;

impl ReplApp {
    pub(super) fn observe_terminal_size(&mut self, size: Size) {
        let size = Size::new(size.width.max(1), size.height.max(1));
        self.note_terminal_size_for_resize_reset(size);
    }

    pub(super) fn observe_terminal_resize(&mut self, size: Size) {
        let size = Size::new(size.width.max(1), size.height.max(1));
        self.note_terminal_size_for_resize_reset(size);
    }

    pub(super) fn note_terminal_size_for_resize_reset(&mut self, size: Size) {
        let change = self.transcript_reflow.note_size(size);
        if !change.initialized() && (change.width_changed() || change.height_changed()) {
            self.request_resize_viewport_reset();
        }
    }

    pub(super) fn render_welcome_component(&mut self) {
        if self.welcome_component_mounted {
            return;
        }
        self.welcome_component_mounted = true;
        self.force_next_viewport_redraw();
    }

    pub(super) fn startup_idle_surface_active(&self) -> bool {
        self.startup_live_viewport_top_limit.is_some()
            && self.messages.is_empty()
            && !self.is_loading
            && self.active_turn.is_none()
            && self.slash_menu.is_none()
            && !self.footer_shortcuts_overlay
            && !self.centered_overlay_active()
    }

    pub(super) fn should_render_startup_welcome(&self, start_idx: usize) -> bool {
        self.welcome_component_mounted && !self.welcome_scrollback_committed && start_idx == 0
    }

    pub(super) fn prepend_startup_welcome_hyperlink_lines(
        &self,
        lines: &mut Vec<HyperlinkLine>,
        width: u16,
        start_idx: usize,
        has_following_content: bool,
    ) {
        if !self.should_render_startup_welcome(start_idx) {
            return;
        }
        let mut welcome_lines = render_startup_welcome(startup_welcome_info(self), Some(width))
            .into_iter()
            .map(HyperlinkLine::new)
            .collect::<Vec<_>>();
        if has_following_content && !welcome_lines.is_empty() {
            welcome_lines.push(HyperlinkLine::new(Line::from("")));
        }
        welcome_lines.append(lines);
        *lines = welcome_lines;
    }

    pub(super) fn transcript_tail_start_index_for_end(
        &self,
        width: u16,
        row_budget: usize,
        end_idx: usize,
    ) -> usize {
        let end_idx = end_idx.min(self.messages.len());
        let max_messages = if self.transcript_viewport.is_at_tail() {
            TRANSCRIPT_RENDER_MAX_MESSAGES
        } else {
            end_idx.max(1)
        };
        transcript_tail_window_start(
            &self.messages[..end_idx],
            width,
            row_budget,
            max_messages,
            is_tool_run_message,
            is_collapsible_tool_message,
            TURN_DIVIDER_PREFIX,
        )
    }

    #[cfg(test)]
    pub(super) fn live_transcript_start_index_for_end(
        &self,
        width: u16,
        row_budget: usize,
        end_idx: usize,
    ) -> usize {
        let end_idx = end_idx.min(self.messages.len());
        let start = self.transcript_tail_start_index_for_end(width, row_budget, end_idx);
        if self.transcript_viewport.is_at_tail() {
            start.max(self.scrollback_committed_until.min(end_idx))
        } else {
            start
        }
    }

    #[cfg(test)]
    pub(super) fn live_transcript_start_index(&self, width: u16, row_budget: usize) -> usize {
        self.live_transcript_start_index_for_end(width, row_budget, self.messages.len())
    }

    pub(super) fn transcript_render_line_limit(&self, row_budget: usize) -> Option<usize> {
        Some(row_budget.saturating_add(TRANSCRIPT_RENDER_OVERSCAN_ROWS))
    }

    pub(super) fn fullscreen_transcript_render_line_limit(
        &self,
        render_budget: usize,
        viewport_rows: usize,
    ) -> Option<usize> {
        if self.transcript_viewport.fast_path_active() {
            return Some(viewport_rows.max(1).saturating_mul(2));
        }
        self.transcript_render_line_limit(render_budget)
    }

    pub(super) fn fullscreen_scrolled_render_line_limit(
        &self,
        render_budget: usize,
        viewport_rows: usize,
        local_top: usize,
    ) -> Option<usize> {
        let base_limit = self
            .fullscreen_transcript_render_line_limit(render_budget, viewport_rows)
            .unwrap_or(usize::MAX);
        Some(
            base_limit.max(
                local_top
                    .saturating_add(viewport_rows.max(1))
                    .saturating_add(TRANSCRIPT_RENDER_OVERSCAN_ROWS),
            ),
        )
    }

    pub(super) fn fullscreen_transcript_render_row_budget(&self, row_budget: usize) -> usize {
        let row_budget = row_budget.max(1);
        let budget = transcript_render_row_budget(
            self.transcript_viewport.position(),
            self.transcript_viewport.live_content_rows(),
            self.transcript_viewport.viewport_rows(),
            row_budget,
        );
        if self.transcript_viewport.is_at_tail() {
            return budget;
        }

        if self.transcript_viewport.fast_path_active() {
            return row_budget
                .saturating_mul(2)
                .min(FULLSCREEN_SCROLL_RENDER_MAX_ROWS.max(row_budget));
        }

        let smooth_scroll_budget = row_budget
            .saturating_add(
                TRANSCRIPT_RENDER_OVERSCAN_ROWS
                    .saturating_mul(FULLSCREEN_SCROLL_RENDER_OVERSCAN_MULTIPLIER),
            )
            .min(FULLSCREEN_SCROLL_RENDER_MAX_ROWS.max(row_budget));
        budget.min(smooth_scroll_budget)
    }

    pub(super) fn render_inline_live_transcript_lines(
        &mut self,
        width: u16,
        row_budget: usize,
    ) -> Vec<Line<'static>> {
        let start_idx = self.scrollback_committed_until.min(self.messages.len());
        let render_line_limit = self.transcript_render_line_limit(row_budget);
        let active_messages = self.active_turn_display_messages_for_render();
        let mut lines = if active_messages.is_empty() {
            self.render_transcript_range_limited_with_mode(
                start_idx,
                self.messages.len(),
                width,
                render_line_limit,
                LineLimitMode::Tail,
            )
        } else {
            let mut combined_messages = self.messages[start_idx..].to_vec();
            let active_from = combined_messages.len();
            combined_messages.extend(active_messages);
            self.render_display_messages_limited_with_mode(
                &combined_messages,
                width,
                render_line_limit,
                LineLimitMode::Tail,
                Some(active_from),
            )
        };
        if lines.is_empty() && self.startup_idle_surface_active() {
            lines.push(Line::from(Span::styled(
                "Ready",
                Style::default().fg(KCODER_UI_THEME.text_muted),
            )));
        }
        lines
    }

    pub(super) fn inline_turn_uses_live_tail(&self) -> bool {
        self.recent_turn_transcript_start.is_some()
            && (self.is_loading
                || self.active_turn.is_some()
                || self.streaming_output_active
                || self.streaming_message_done_pending
                || self.deferred_turn_finish_pending)
    }

    #[cfg(test)]
    pub(super) fn render_fullscreen_transcript_lines(
        &mut self,
        width: u16,
        row_budget: usize,
    ) -> Vec<Line<'static>> {
        self.render_fullscreen_transcript_window(width, row_budget)
            .lines
    }

    pub(super) fn fullscreen_welcome_lines(
        &self,
        width: u16,
        has_following_content: bool,
    ) -> Vec<Line<'static>> {
        if let Some(view) = self.agent_view.as_ref() {
            let status = view
                .steer_status
                .as_deref()
                .map(|status| format!(" · {status}"))
                .unwrap_or_default();
            let mut lines = vec![Line::from(vec![
                Span::styled(
                    "Agent transcript ",
                    Style::default()
                        .fg(KCODER_UI_THEME.mode_agent)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    truncate_display_text(
                        &format!("{} ({}){status}", view.display_name, view.agent_id),
                        usize::from(width).saturating_sub(17).max(1),
                    ),
                    Style::default().fg(KCODER_UI_THEME.text_muted),
                ),
            ])];
            if let Some(error) = view.load_error.as_deref() {
                lines.push(Line::from(Span::styled(
                    truncate_display_text(
                        &format!("Transcript refresh failed: {error}"),
                        usize::from(width).max(1),
                    ),
                    Style::default().fg(KCODER_UI_THEME.warning),
                )));
            }
            if has_following_content {
                lines.push(Line::from(""));
            }
            return lines;
        }
        if !self.welcome_component_mounted {
            return Vec::new();
        }
        let mut lines = render_startup_welcome(startup_welcome_info(self), Some(width));
        if has_following_content && !lines.is_empty() {
            lines.push(Line::from(""));
        }
        lines
    }

    pub(super) fn render_fullscreen_transcript_window(
        &mut self,
        width: u16,
        row_budget: usize,
    ) -> FullscreenTranscriptRender {
        if let Some(render) = self.render_navigation_window(width, row_budget) {
            return render;
        }
        let key = self.fullscreen_transcript_render_cache_key(width, row_budget);
        if let Some(cache) = self
            .fullscreen_transcript_render_cache
            .as_ref()
            .filter(|cache| cache.key == key)
        {
            return cache.render.clone();
        }

        let render = self.render_fullscreen_transcript_window_uncached(width, row_budget);
        self.fullscreen_transcript_render_cache = Some(FullscreenTranscriptRenderCache {
            key,
            render: render.clone(),
        });
        render
    }

    pub(super) fn fullscreen_transcript_render_cache_key(
        &mut self,
        width: u16,
        row_budget: usize,
    ) -> FullscreenTranscriptRenderCacheKey {
        let active_tools_expanded = self.effective_active_tools_expanded();
        let welcome_info = self
            .welcome_component_mounted
            .then(|| startup_welcome_info(self));
        let render_budget = self.fullscreen_transcript_render_row_budget(row_budget);
        let at_tail = self.transcript_viewport.is_at_tail();
        let active_display_rows = if at_tail {
            0
        } else {
            let active_lines = self.render_active_turn_lines(width);
            paragraph_line_count(&active_lines, width)
        };
        FullscreenTranscriptRenderCacheKey {
            width,
            row_budget,
            render_budget,
            messages_len: self.messages.len(),
            messages_epoch: self.messages.render_epoch(),
            transcript_scroll: self.transcript_viewport.position(),
            active_render_revision: if at_tail {
                self.active_turn_render_revision
            } else {
                0
            },
            active_display_rows,
            active_tools_expanded,
            tool_transcript_expanded: self.effective_tool_transcript_expanded(),
            render_markdown: self.effective_render_markdown(),
            code_theme: self.code_theme.clone(),
            welcome_info,
            startup_idle_surface_active: self.startup_idle_surface_active(),
            scrollbar_fast_path_active: self.transcript_viewport.fast_path_active(),
            scrollbar_drag_active: self.transcript_viewport.drag_active(),
            // Keep the active tool-title diamond moving even while the user
            // has scrolled away from the tail. The active summary can remain
            // visible in that layout, and a frozen title looks like a stalled
            // tool despite the footer heartbeat continuing.
            tool_summary_indicator: self.active_tool_summary_indicator(),
            subagent_animation_frame: if self
                .subagent_panels
                .values()
                .any(|panel| !panel.all_terminal())
            {
                ((self.subagent_animation_started_at.elapsed().as_millis() / 80) % 10) as u8
            } else {
                0
            },
        }
    }

    pub(super) fn active_tool_summary_indicator(&self) -> &'static str {
        self.active_tool_summary_indicator_at(self.spinner.snapshot().phase_elapsed)
    }

    pub(super) fn active_tool_summary_indicator_at(&self, elapsed: Duration) -> &'static str {
        let has_collapsed_running_tools = !self.effective_tool_transcript_expanded()
            && self
                .active_turn
                .as_ref()
                .is_some_and(ActiveCell::has_running_tool_entries);
        if self.spinner.is_running() && has_collapsed_running_tools {
            motion::tool_summary_frame(elapsed)
        } else {
            "◇"
        }
    }

    /// Batched commits within one streaming answer are storage boundaries, not Markdown paragraph boundaries.
    pub(super) fn fullscreen_stream_render_start(&self) -> Option<usize> {
        self.streaming_transcript_start.filter(|start| {
            *start < self.messages.len()
                && self.messages[*start..]
                    .iter()
                    .all(|message| message.role == MessageRole::Assistant)
        })
    }

    pub(super) fn fullscreen_combined_messages(
        &self,
        start: usize,
        end: usize,
        active: Vec<DisplayMessage>,
    ) -> (Vec<DisplayMessage>, usize) {
        let mut combined = self.messages[start..end].to_vec();
        let mut active_from = combined.len();
        combined.extend(active);
        if let Some(stream_start) = self.fullscreen_stream_render_start()
            && start <= stream_start
            && end == self.messages.len()
        {
            let first = stream_start - start;
            let mut next = first + 1;
            while next < combined.len() && combined[next].role == MessageRole::Assistant {
                next += 1;
            }
            let text = combined[first..next]
                .iter()
                .map(|message| message.text.as_str())
                .collect::<String>();
            combined.splice(
                first..next,
                [DisplayMessage {
                    role: MessageRole::Assistant,
                    text,
                }],
            );
            active_from = first;
        }
        (combined, active_from)
    }

    pub(super) fn fullscreen_exact_prefix_rows(
        &mut self,
        start: usize,
        width: u16,
        welcome_rows: usize,
    ) -> Option<usize> {
        if start == 0 {
            return Some(0);
        }
        if start > FULLSCREEN_EXACT_TAIL_PREFIX_MAX_MESSAGES
            || self.messages[..start]
                .iter()
                .map(|message| message.text.len())
                .sum::<usize>()
                > 512 * 1024
        {
            return None;
        }
        let prefix = self.render_transcript_range_limited_with_mode(
            0,
            start,
            width,
            None,
            LineLimitMode::Head,
        );
        Some(welcome_rows.saturating_add(paragraph_line_count(&prefix, width)))
    }

    pub(super) fn render_fullscreen_transcript_window_uncached(
        &mut self,
        width: u16,
        row_budget: usize,
    ) -> FullscreenTranscriptRender {
        let row_budget = row_budget.max(1);
        let render_budget = self.fullscreen_transcript_render_row_budget(row_budget);
        let welcome_lines = self.fullscreen_welcome_lines(width, !self.messages.is_empty());
        let welcome_rows = paragraph_line_count(&welcome_lines, width);
        let active_rows = paragraph_line_count(&self.render_active_turn_lines(width), width);
        self.transcript_row_index.rebuild_if_stale(
            &self.messages,
            width,
            self.messages.render_epoch(),
            is_tool_run_message,
            is_collapsible_tool_message,
            TURN_DIVIDER_PREFIX,
        );
        let mut estimated_total_rows = welcome_rows
            .saturating_add(self.transcript_row_index.total_rows())
            .saturating_add(active_rows);
        let (scroll, mut top) = if self.transcript_viewport.drag_active() {
            let frozen_rows = self.transcript_viewport.content_rows();
            let frozen_top = self
                .transcript_viewport
                .resolve_top(frozen_rows, row_budget);
            (
                self.transcript_viewport.position(),
                remap_scroll_top_proportionally(
                    frozen_top,
                    frozen_rows,
                    estimated_total_rows,
                    row_budget,
                ),
            )
        } else {
            self.transcript_viewport
                .position()
                .resolve_top(estimated_total_rows, row_budget)
        };
        if scroll.is_at_tail() {
            let mut start_idx =
                self.transcript_tail_start_index_for_end(width, render_budget, self.messages.len());
            if let Some(stream_start) = self.fullscreen_stream_render_start() {
                start_idx = start_idx.min(stream_start);
            }
            let render_line_limit =
                self.fullscreen_transcript_render_line_limit(render_budget, row_budget);
            let active_messages = self.active_turn_display_messages_for_render();
            let active_messages_empty = active_messages.is_empty();
            let mut lines = loop {
                let mut lines =
                    if active_messages_empty && self.fullscreen_stream_render_start().is_none() {
                        self.render_transcript_range_limited_with_mode(
                            start_idx,
                            self.messages.len(),
                            width,
                            None,
                            LineLimitMode::Tail,
                        )
                    } else {
                        let (combined_messages, active_from) = self.fullscreen_combined_messages(
                            start_idx,
                            self.messages.len(),
                            active_messages.clone(),
                        );
                        self.render_display_messages_limited_with_mode(
                            &combined_messages,
                            width,
                            None,
                            LineLimitMode::Tail,
                            Some(active_from),
                        )
                    };
                if start_idx == 0 {
                    let mut welcome_lines = self.fullscreen_welcome_lines(width, !lines.is_empty());
                    if !welcome_lines.is_empty() {
                        welcome_lines.append(&mut lines);
                        lines = welcome_lines;
                    }
                }
                if active_messages_empty {
                    lines.extend(self.render_active_turn_lines(width));
                }
                if start_idx == 0 || paragraph_line_count(&lines, width) >= row_budget {
                    break lines;
                }
                // Collapsed content can be much shorter than estimated. Extend an underfilled tail until it fills the viewport or reaches history's start.
                let backfill = self.messages.len().saturating_sub(start_idx).max(1);
                start_idx = start_idx.saturating_sub(backfill);
            };
            if lines.is_empty() && self.startup_idle_surface_active() {
                lines.push(Line::from(Span::styled(
                    "Ready",
                    Style::default().fg(KCODER_UI_THEME.text_muted),
                )));
            }
            // Measure the selected tail before clipping the draw window. The renderer
            // already constructs each Markdown message in full; counting after clipping
            // loses the true height of long messages and shifts coordinates near the tail.
            let full_tail_rows = paragraph_line_count(&lines, width);
            let total_rows = if start_idx == 0 {
                full_tail_rows
            } else {
                self.fullscreen_exact_prefix_rows(start_idx, width, welcome_rows)
                    .unwrap_or_else(|| {
                        welcome_rows
                            .saturating_add(self.transcript_row_index.prefix_rows_at(start_idx))
                    })
                    .saturating_add(full_tail_rows)
            };
            if let Some(limit) = render_line_limit {
                let excess = lines.len().saturating_sub(limit);
                lines.drain(..excess);
            }
            let rendered_rows = paragraph_line_count(&lines, width);
            return FullscreenTranscriptRender {
                lines,
                total_rows,
                top: total_rows.saturating_sub(row_budget),
                local_top: rendered_rows.saturating_sub(row_budget),
            };
        }

        let message_top = top.saturating_sub(welcome_rows);
        let scroll_window = self.transcript_row_index.window_for_top(
            &self.messages,
            message_top,
            row_budget,
            render_budget,
            is_tool_run_message,
        );
        let mut start_idx = scroll_window.start_idx;
        let mut end_idx = scroll_window.end_idx;
        if let Some(stream_start) = self.fullscreen_stream_render_start()
            && end_idx > stream_start
        {
            start_idx = start_idx.min(stream_start);
            end_idx = self.messages.len();
        }
        // Active content merges into history on completion, so the window may begin at
        // the consolidated message. Calibrate the bounded prefix to preserve review position.
        let exact_prefix_rows = self.fullscreen_exact_prefix_rows(start_idx, width, welcome_rows);
        let estimated_prefix = if start_idx == 0 {
            0
        } else {
            welcome_rows.saturating_add(self.transcript_row_index.prefix_rows_at(start_idx))
        };
        if let Some(prefix) = exact_prefix_rows
            && !self.transcript_viewport.drag_active()
        {
            estimated_total_rows = estimated_total_rows
                .saturating_sub(estimated_prefix)
                .saturating_add(prefix);
            top = self
                .transcript_viewport
                .resolve_top(estimated_total_rows, row_budget);
        }
        let local_top = if let Some(prefix) = exact_prefix_rows {
            top.saturating_sub(prefix)
        } else {
            top.saturating_sub(estimated_prefix)
        };
        let render_line_limit =
            self.fullscreen_scrolled_render_line_limit(render_budget, row_budget, local_top);
        let active_messages = if end_idx == self.messages.len() {
            self.active_turn_display_messages_for_render()
        } else {
            Vec::new()
        };
        // A review window reaching the committed tail must render active text, not merely count its rows.
        let mut lines =
            if active_messages.is_empty() && self.fullscreen_stream_render_start().is_none() {
                self.render_transcript_range_limited_with_mode(
                    start_idx,
                    end_idx,
                    width,
                    render_line_limit,
                    LineLimitMode::Head,
                )
            } else {
                let (combined, active_from) =
                    self.fullscreen_combined_messages(start_idx, end_idx, active_messages);
                self.render_display_messages_limited_with_mode(
                    &combined,
                    width,
                    render_line_limit,
                    LineLimitMode::Head,
                    Some(active_from),
                )
            };
        if start_idx == 0 {
            let mut welcome_lines = self.fullscreen_welcome_lines(width, !lines.is_empty());
            if !welcome_lines.is_empty() {
                welcome_lines.append(&mut lines);
                lines = welcome_lines;
            }
        }
        if lines.is_empty() && self.startup_idle_surface_active() {
            lines.push(Line::from(Span::styled(
                "Ready",
                Style::default().fg(KCODER_UI_THEME.text_muted),
            )));
        }
        let rendered_rows = paragraph_line_count(&lines, width);
        let render_limit_hit = render_line_limit.is_some_and(|max_lines| lines.len() >= max_lines);
        let estimated_distance_from_tail = estimated_total_rows
            .saturating_sub(row_budget)
            .saturating_sub(top);
        let exact_tail_prefix_rows = if !render_limit_hit && end_idx == self.messages.len() {
            Some(exact_prefix_rows.unwrap_or(estimated_prefix))
        } else {
            None
        };
        if let Some(exact_prefix_rows) = exact_tail_prefix_rows {
            let total_rows = exact_prefix_rows.saturating_add(rendered_rows);
            // Row-index estimates intentionally trade precision for speed. If
            // an upward wheel event leaves the tail, carrying the estimated
            // absolute `top` into this exact window can clamp it straight back
            // to the bottom. Several wheel events are then swallowed before
            // the accumulated delta exceeds the estimate error. Preserve the
            // user's distance from the tail instead, so the first wheel event
            // always moves the visible transcript.
            let (_, exact_top) = if self.transcript_viewport.drag_active() {
                let frozen_rows = self.transcript_viewport.content_rows();
                let frozen_top = self
                    .transcript_viewport
                    .resolve_top(frozen_rows, row_budget);
                let exact_top = remap_scroll_top_proportionally(
                    frozen_top,
                    frozen_rows,
                    total_rows,
                    row_budget,
                );
                (self.transcript_viewport.position(), exact_top)
            } else if self.transcript_viewport.is_tail_relative() {
                TranscriptScroll::from_tail(estimated_distance_from_tail)
                    .resolve_top(total_rows, row_budget)
            } else {
                self.transcript_viewport
                    .position()
                    .resolve_top(total_rows, row_budget)
            };
            let local_top = clamp_render_top_to_content(
                exact_top.saturating_sub(exact_prefix_rows),
                rendered_rows,
                row_budget,
            );
            return FullscreenTranscriptRender {
                lines,
                total_rows,
                top: exact_top,
                local_top,
            };
        }
        let local_top =
            if end_idx == self.messages.len() && self.transcript_viewport.is_tail_relative() {
                // Keep a partially rendered tail window bottom-anchored as well.
                // Otherwise an overestimated prefix can leave `local_top` clamped
                // at its maximum for multiple wheel ticks and then jump suddenly.
                rendered_rows
                    .saturating_sub(row_budget)
                    .saturating_sub(estimated_distance_from_tail)
            } else {
                clamp_render_top_to_content(local_top, rendered_rows, row_budget)
            };
        FullscreenTranscriptRender {
            lines,
            // `local_top` is an offset within the local render window and must not be
            // counted again in global rows; otherwise a small scroll near a long-message
            // tail makes the scrollbar report sudden content growth.
            total_rows: estimated_total_rows
                .max(top.saturating_add(row_budget))
                .max(rendered_rows),
            top,
            local_top,
        }
    }

    pub(super) fn transcript_desired_rows(
        &mut self,
        terminal_width: u16,
        transcript_row_budget: usize,
    ) -> u16 {
        if transcript_row_budget == 0 {
            return 0;
        }
        let transcript_width = terminal_width.saturating_sub(2).max(1);
        let start_idx = self.scrollback_committed_until.min(self.messages.len());
        let render_line_limit = self.transcript_render_line_limit(transcript_row_budget);
        let visible_lines = self.render_transcript_range_limited_with_mode(
            start_idx,
            self.messages.len(),
            transcript_width,
            render_line_limit,
            LineLimitMode::Tail,
        );
        let active_text_visible = !self.streaming_thinking_status.trim().is_empty()
            || self.active_turn.as_ref().is_some_and(|active| {
                active
                    .entries
                    .iter()
                    .any(|entry| matches!(entry, ActiveEntry::Text(_)))
            });
        let mut desired_rows = paragraph_line_count(&visible_lines, transcript_width);
        if active_text_visible {
            // Incomplete text is tail-aligned in the current viewport, but a long partial
            // must not instantly fill the inline area. Expand naturally after complete lines commit.
            desired_rows = desired_rows.saturating_add(1);
        } else if desired_rows == 0 && self.startup_idle_surface_active() {
            desired_rows = 1;
        }
        if self.inline_turn_uses_live_tail() {
            desired_rows = desired_rows.min(INLINE_ACTIVE_TRANSCRIPT_MAX_ROWS);
        }
        desired_rows
            .min(transcript_row_budget)
            .min(usize::from(u16::MAX)) as u16
    }

    pub(super) fn bottom_overlay_reserved_rows(&self) -> u16 {
        let mut rows = 0u16;
        if self.slash_menu.is_some() && !self.shutdown_in_progress {
            rows = rows.max(
                self.slash_menu_matches()
                    .len()
                    .min(SLASH_MENU_MAX_ITEMS)
                    .min(usize::from(u16::MAX)) as u16,
            );
        }
        if let Some(menu) = &self.mention_menu
            && !self.shutdown_in_progress
        {
            rows = rows.max(menu.candidates.len().min(8) as u16);
        }
        if self.footer_shortcuts_overlay && !self.shutdown_in_progress {
            rows = rows.max(
                shortcut_overlay_lines_with_mode_switch(
                    self.spinner.is_running(),
                    self.plan_mode.is_some(),
                    self.edit_previous_primed,
                )
                .len()
                .min(usize::from(u16::MAX)) as u16,
            );
        }
        rows
    }

    pub(super) fn centered_overlay_min_height(&self, terminal_width: u16) -> u16 {
        let mut height = 0u16;
        if self.outline_open {
            height = height.max(18);
        }
        if self.keys_overlay.is_some() {
            height = height.max(
                shortcut_overlay_lines_with_mode_switch(false, self.plan_mode.is_some(), false)
                    .len()
                    .min(usize::from(u16::MAX)) as u16
                    + 2,
            );
        }
        if self.transcript_overlay.is_some() {
            height = height.max(18);
        }
        if self.side_question_overlay.is_some() {
            height = height.max(16);
        }
        if let Some(picker) = &self.picker_overlay {
            let rows = picker.matches().len();
            height = height.max(
                picker_overlay_natural_height(rows).saturating_add(
                    (rows.min(PICKER_MAX_ITEMS) as u16)
                        .saturating_mul(picker.item_height().saturating_sub(1)),
                ),
            );
        }
        if self.context_inspector.is_some() {
            height = height.max(CONTEXT_INSPECTOR_HEIGHT);
        }
        if let Some(inspector) = &self.settings_inspector {
            height = height.max(settings_inspector_natural_height(inspector.lines.len()));
        }
        if let Some(dialog) = &self.pending_permission {
            height = height.max(permission_dialog_natural_height(dialog));
        }
        if let Some(dialog) = &self.pending_question {
            height = height.max(question_dialog_natural_height(terminal_width, dialog));
        }
        if self.pending_goal_replacement.is_some() || self.permission_editor.is_some() {
            height = height.max(12);
        }
        height
    }

    pub(super) fn inline_viewport_heights(
        &mut self,
        terminal_width: u16,
        terminal_height: u16,
    ) -> InlineViewportHeights {
        if self.copy_view.is_some() {
            return InlineViewportHeights {
                base: terminal_height.max(1),
                expanded: terminal_height.max(1),
                reserved_bottom_slack: 0,
                max_top: Some(0),
            };
        }
        let (status_height, pending_input_height) = self.bottom_pane_stack_heights(terminal_width);
        let footer_height = self.footer_height();
        let todo_height = todo_status_height(&self.todos);
        let composer_height = composer_height_for_width_with_limit(
            self,
            terminal_width,
            Some(composer_height_limit_for_terminal(
                terminal_height,
                status_height,
                pending_input_height,
                footer_height,
                todo_height,
            )),
        )
        .max(3);
        let fixed_height = composer_height
            .saturating_add(status_height)
            .saturating_add(pending_input_height)
            .saturating_add(todo_height)
            .saturating_add(footer_height)
            .saturating_add(BOTTOM_PANE_TOP_SPACER);
        let transcript_row_budget = terminal_height.saturating_sub(fixed_height) as usize;
        let transcript_rows = self.transcript_desired_rows(terminal_width, transcript_row_budget);
        let bottom_overlay_rows = self.bottom_overlay_reserved_rows();
        let startup_idle_surface = self.startup_idle_surface_active()
            && transcript_rows > 0
            && status_height == 0
            && pending_input_height == 0
            && bottom_overlay_rows == 0;
        let startup_live_viewport_top_limit = if startup_idle_surface
            || transcript_rows == 0
                && status_height == 0
                && pending_input_height == 0
                && bottom_overlay_rows == 0
        {
            self.startup_live_viewport_top_limit
        } else {
            None
        };
        let base = fixed_height
            .saturating_add(transcript_rows)
            .max(self.centered_overlay_min_height(terminal_width))
            .min(terminal_height.max(1));
        let default_bottom_slack =
            fullscreen_bottom_slack_rows(terminal_height).min(terminal_height.saturating_sub(base));
        let expanded = base
            .saturating_add(bottom_overlay_rows)
            .saturating_add(if startup_idle_surface {
                default_bottom_slack.saturating_mul(2)
            } else {
                0
            })
            .min(terminal_height.max(1));
        InlineViewportHeights {
            base,
            expanded,
            reserved_bottom_slack: default_bottom_slack,
            max_top: startup_live_viewport_top_limit,
        }
    }

    pub(super) fn centered_overlay_active(&self) -> bool {
        self.copy_view.is_some()
            || self.pending_permission.is_some()
            || self.pending_question.is_some()
            || self.pending_goal_replacement.is_some()
            || self.permission_editor.is_some()
            || self.context_inspector.is_some()
            || self.settings_inspector.is_some()
            || self.keys_overlay.is_some()
            || self.picker_overlay.is_some()
            || self.transcript_overlay.is_some()
            || self.side_question_overlay.is_some()
    }

    #[cfg(test)]
    pub(super) fn desired_height(&mut self, terminal_width: u16, terminal_height: u16) -> u16 {
        self.inline_viewport_heights(terminal_width, terminal_height)
            .expanded
    }
}

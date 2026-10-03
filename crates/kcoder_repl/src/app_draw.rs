//! Frame composition and overlay drawing.

use super::*;

impl ReplApp {
    pub(super) fn render_full_transcript_overlay_lines(
        &mut self,
        width: u16,
    ) -> Vec<Line<'static>> {
        let width = width.max(1);
        let active_messages = self.active_turn_display_messages_for_render();
        let mut lines = if active_messages.is_empty() {
            self.render_transcript_range_limited(0, self.messages.len(), width, None)
        } else {
            let mut combined_messages = self.messages.iter().cloned().collect::<Vec<_>>();
            let active_from = combined_messages.len();
            combined_messages.extend(active_messages);
            self.render_display_messages_limited_with_mode(
                &combined_messages,
                width,
                None,
                LineLimitMode::Head,
                Some(active_from),
            )
        };
        if lines.is_empty() {
            lines.push(Line::from(Span::styled(
                "No transcript yet.",
                Style::default().fg(KCODER_UI_THEME.text_muted),
            )));
        }
        lines
    }

    pub(super) fn draw_transcript_overlay(&mut self, frame: &mut Frame) {
        if self.navigation.inline && self.navigation.anchor.is_some() {
            self.draw_navigation_overlay(frame);
            return;
        }
        use ratatui::widgets::{Clear, Widget};

        let area = frame.area();
        if area.width == 0 || area.height == 0 {
            return;
        }

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(KCODER_UI_THEME.accent_primary))
            .title(Span::styled(
                " T R A N S C R I P T ",
                Style::default()
                    .fg(KCODER_UI_THEME.accent_primary)
                    .add_modifier(Modifier::BOLD),
            ))
            .title_bottom(Span::styled(
                " Esc/q close · ↑/↓ scroll · PgUp/PgDn page ",
                Style::default().fg(KCODER_UI_THEME.text_muted),
            ));
        let inner = block.inner(area);
        let inner_width = inner.width.max(1);
        let inner_height = inner.height;
        let lines = self.render_full_transcript_overlay_lines(inner_width);
        let total_rows = paragraph_line_count(&lines, inner_width);
        let top = if let Some(overlay) = self.transcript_overlay.as_mut() {
            overlay.last_line_count = total_rows;
            overlay.last_height = inner_height;
            let top = overlay.resolved_top();
            if overlay.scroll_top != usize::MAX {
                overlay.scroll_top = top;
            }
            top
        } else {
            0
        };

        Clear.render(area, frame.buffer_mut());
        frame.render_widget(block, area);
        let paragraph = Paragraph::new(Text::from(lines))
            .wrap(Wrap { trim: false })
            .scroll((top as u16, 0))
            .style(Style::default().bg(KCODER_UI_THEME.panel_bg));
        frame.render_widget(paragraph, inner);
    }

    pub fn draw(&mut self, frame: &mut Frame) {
        self.refresh_outline();
        let Some(mut agent_transcript) = self
            .agent_view
            .as_mut()
            .map(|view| std::mem::take(&mut view.transcript))
        else {
            self.draw_current_surface(frame);
            return;
        };
        std::mem::swap(&mut self.messages, &mut agent_transcript);
        self.draw_current_surface(frame);
        std::mem::swap(&mut self.messages, &mut agent_transcript);
        if let Some(view) = self.agent_view.as_mut() {
            view.transcript = agent_transcript;
        }
    }

    pub(super) fn draw_current_surface(&mut self, frame: &mut Frame) {
        let area = frame.area();
        self.last_frame_area = Some(area);
        if self.copy_view.is_some() {
            self.navigation_footer.clear();
            self.draw_copy_view(frame);
            return;
        }
        // The inline history layer owns a complete independent surface; the underlying live surface must not submit fewer rows and clamp its anchor.
        if self.navigation.inline && self.navigation.anchor.is_some() && !self.has_active_modal() {
            self.navigation_footer.clear();
            self.draw_navigation_overlay(frame);
            self.draw_outline(frame);
            return;
        }
        let parked_navigation_viewport = (self.navigation.inline
            && self.navigation.anchor.is_some())
        .then(|| std::mem::take(&mut self.transcript_viewport));
        frame.render_widget(
            Block::default().style(Style::default().bg(KCODER_UI_THEME.surface_bg)),
            area,
        );

        let (mut status_height, mut pending_input_height) =
            self.bottom_pane_stack_heights(area.width);
        let fullscreen_status_in_footer =
            self.fullscreen_surface && self.resume_session_picker.is_none();
        if fullscreen_status_in_footer {
            status_height = 0;
            pending_input_height = self.pending_input_preview_height(area.width, 0);
        }
        let tiny_subagent_status = self.tiny_terminal_subagent_status(area.width, area.height);
        if tiny_subagent_status.is_some() {
            status_height = status_height.max(1);
        }
        let footer_height = self.footer_height();
        let desired_todo_height = todo_status_height(&self.todos);
        let composer_height = composer_height_for_width_with_limit(
            self,
            area.width,
            Some(composer_height_limit_for_terminal(
                area.height,
                status_height,
                pending_input_height,
                footer_height,
                desired_todo_height,
            )),
        );
        let fixed_height = composer_height
            .saturating_add(status_height)
            .saturating_add(pending_input_height)
            .saturating_add(desired_todo_height)
            .saturating_add(footer_height)
            .saturating_add(BOTTOM_PANE_TOP_SPACER);
        let transcript_row_budget = area.height.saturating_sub(fixed_height) as usize;
        let message_height = if self.fullscreen_surface {
            area.height
        } else {
            self.transcript_desired_rows(area.width, transcript_row_budget)
        };
        let bottom_overlay_height = self.bottom_overlay_reserved_rows();
        let layout = split_repl_layout(
            area,
            ReplLayoutHeights {
                message: message_height,
                bottom_overlay: bottom_overlay_height,
                composer: composer_height,
                status: status_height,
                pending_input: pending_input_height,
                footer: footer_height,
                todo: desired_todo_height,
            },
        );
        let message_area = layout.message;
        let bottom_overlay_area = layout.bottom_overlay;
        let status_area = layout.status;
        let pending_input_area = layout.pending_input;
        let input_area = layout.input;
        let footer_area = layout.footer;
        let tail_area = layout.tail;
        let todo_area = layout.todo;
        let dialog_host_area =
            dialog_host_area_for_todo(area, todo_area.map_or(0, |todo| todo.height));
        self.last_bottom_overlay_area = bottom_overlay_area;

        let reserve_scrollbar_gutter =
            self.fullscreen_surface && self.resume_session_picker.is_none();
        let transcript_area =
            transcript_area_for_message_area(message_area, reserve_scrollbar_gutter);
        let inner_area = transcript_area;
        self.transcript_viewport.begin_frame(inner_area);
        let inner_width = inner_area.width.max(1);

        let row_budget = usize::from(inner_area.height);
        let mut deferred_transcript_scrollbar = None;

        let fullscreen_render = if self.fullscreen_surface && self.resume_session_picker.is_none() {
            Some(self.render_fullscreen_transcript_window(inner_width, row_budget))
        } else {
            None
        };
        let visible_lines = if let Some(picker) = &self.resume_session_picker {
            resume_session_picker_lines(picker, inner_width, row_budget)
        } else if let Some(render) = fullscreen_render.as_ref() {
            render.lines.clone()
        } else {
            self.render_inline_live_transcript_lines(inner_width, row_budget)
        };
        if self.resume_session_picker.is_none() {
            let rendered_line_count = fullscreen_render.as_ref().map_or_else(
                || paragraph_line_count(&visible_lines, inner_area.width.max(1)),
                |render| render.total_rows,
            );
            let visible_top = fullscreen_render.as_ref().map_or(0, |render| render.top);
            self.transcript_viewport
                .commit_render(rendered_line_count, visible_top);
        }
        if inner_area.height > 0 {
            let (visible_lines, render_top) = if self.resume_session_picker.is_some() {
                (visible_lines, 0)
            } else if let Some(render) = fullscreen_render.as_ref() {
                if self.agent_view.is_some()
                    && !self.navigation.displaying
                    && self.transcript_viewport.is_at_tail()
                    && render.total_rows <= usize::from(inner_area.height)
                {
                    // Keep short child output near the composer without counting top padding as transcript rows.
                    bottom_aligned_paragraph(visible_lines, inner_width, inner_area.height)
                } else {
                    (visible_lines, render.local_top)
                }
            } else {
                bottom_aligned_paragraph(visible_lines, inner_width, inner_area.height)
            };
            let (visible_lines, render_top) = if self.fullscreen_surface
                && !self.navigation.displaying
                && self.resume_session_picker.is_none()
                && !visible_lines.is_empty()
            {
                scroll_render_window_lines(
                    visible_lines,
                    inner_width,
                    render_top,
                    usize::from(inner_area.height.max(1)),
                    usize::from(inner_area.height.max(1)),
                )
            } else {
                (visible_lines, render_top)
            };
            self.last_transcript_visible_rows = if self.navigation.displaying {
                transcript_selection::navigation_visible_rows_for_selection(
                    &visible_lines,
                    inner_width,
                    inner_area.height,
                    render_top,
                )
            } else {
                transcript_visible_rows_for_selection(
                    &visible_lines,
                    inner_width,
                    inner_area.height,
                    render_top,
                )
            };
            frame.render_widget(ratatui::widgets::Clear, inner_area);
            // Navigation output already contains visual rows; replay its cells directly without wrapping or truncating again.
            if self.navigation.displaying {
                frame.render_widget(
                    navigation_render::NavigationLines {
                        lines: &visible_lines,
                        local_top: render_top,
                    },
                    inner_area,
                );
            } else {
                frame.render_widget(
                    Paragraph::new(Text::from(visible_lines))
                        .wrap(Wrap { trim: false })
                        .scroll((render_top as u16, 0))
                        .style(Style::default().bg(KCODER_UI_THEME.surface_bg)),
                    inner_area,
                );
            }
            render_transcript_selection_highlight(
                frame,
                inner_area,
                &self.last_transcript_visible_rows,
                self.transcript_selection.filter(|_| {
                    self.transcript_selection_rows
                        .as_ref()
                        .is_none_or(|rows| rows == &self.last_transcript_visible_rows)
                }),
            );
            if let Some(gutter_area) = transcript_gutter_area(message_area, inner_area) {
                frame.render_widget(
                    Paragraph::new("").style(Style::default().bg(KCODER_UI_THEME.surface_bg)),
                    gutter_area,
                );
            }
            if let Some(render) = fullscreen_render.as_ref() {
                // Select one scrollbar geometry source of truth based on drag state:
                // - Not dragging: use (total_rows, top) actually drawn this frame. Rendering
                //   locates by estimated rows and commits actual rows; resolving coordinates
                //   again would offset the thumb from visible content on estimation-error frames.
                // - Dragging: use the frozen coordinate system. Estimated total_rows varies
                //   between frames and would make thumb height jitter under the pointer. The
                //   frozen basis is stable while proportional remapping aligns content and thumb.
                let viewport_rows = usize::from(inner_area.height.max(1));
                let (scrollbar_content_rows, scrollbar_top_for_render) =
                    if self.transcript_viewport.drag_active() {
                        let frozen_rows = self.transcript_viewport.content_rows();
                        (
                            frozen_rows,
                            self.transcript_viewport
                                .resolve_top(frozen_rows, viewport_rows),
                        )
                    } else {
                        (render.total_rows, render.top)
                    };
                self.transcript_viewport.update_painted_drag_edges(
                    scrollbar_content_rows,
                    scrollbar_top_for_render,
                    message_area.height,
                );
                self.transcript_viewport
                    .set_scrollbar_area(transcript_scrollbar_area(
                        message_area,
                        scrollbar_content_rows,
                        viewport_rows,
                    ));
                deferred_transcript_scrollbar = Some((
                    message_area,
                    scrollbar_content_rows,
                    viewport_rows,
                    scrollbar_top_for_render,
                ));
            }
        } else {
            self.last_transcript_visible_rows.clear();
            self.clear_transcript_selection();
        }
        if self.transcript_viewport.scrollbar_area().is_none() {
            self.transcript_viewport.set_scrollbar_area(None);
        }
        if let Some(todo_area) = todo_area {
            draw_todo_status(frame, &self.todos, todo_area);
        }

        let compact_status = self.compact_status_label();
        let activity = self.activity_presentation();
        let fullscreen_footer_status_detail =
            if fullscreen_status_in_footer && self.status_indicator_visible() {
                activity.detail.clone()
            } else {
                None
            };

        if let Some(status_area) = status_area {
            if let Some(tiny_status) = tiny_subagent_status.as_ref() {
                Paragraph::new(Line::from(Span::styled(
                    tiny_status.clone(),
                    Style::default()
                        .fg(KCODER_UI_THEME.mode_agent)
                        .add_modifier(Modifier::BOLD),
                )))
                .style(Style::default().bg(KCODER_UI_THEME.surface_bg))
                .render(status_area, frame.buffer_mut());
            } else {
                let mut status_data = StatusIndicatorData::new(
                    &activity.label,
                    activity.detail.as_deref(),
                    &compact_status,
                    self.status_elapsed(),
                    StatusIndicatorControls {
                        show_interrupt_hint: self.has_interruptible_turn(),
                        interrupt_hint: "esc",
                        is_running: self.spinner.is_running(),
                    },
                    &KCODER_UI_THEME,
                )
                .with_activity_indicator(activity.indicator, activity.snapshot.needs_attention);
                status_data.started_at = self.turn_started_at;
                status_data.details_capitalization = StatusDetailsCapitalization::Preserve;
                StatusIndicatorWidget::new(status_data).render(status_area, frame.buffer_mut());
            }
        }

        if let Some(pending_input_area) = pending_input_area {
            let preview_area =
                pending_input_preview_content_area(pending_input_area, status_area.is_some());
            if !preview_area.is_empty() {
                self.pending_input_preview()
                    .render(preview_area, frame.buffer_mut());
            }
        }

        // Input pane (multi-line composer).
        let [_remote_images_area, inner] =
            composer_content_areas(input_area, self.remote_image_urls.len());
        self.last_composer_area = Some(input_area);
        self.last_composer_content = Some(inner);
        self.last_input_width = inner.width;
        let content_width = inner.width.max(1);
        let rows = self.wrap_composer_display_rows(content_width);
        let total_rows = rows.len();
        let visible_row_count = usize::from(inner.height.max(MIN_COMPOSER_ROWS));
        self.input_scroll_row = self
            .input_scroll_row
            .min(total_rows.saturating_sub(visible_row_count));

        let image_placeholders = self
            .local_image_attachments
            .iter()
            .map(|image| image.placeholder.as_str())
            .collect::<Vec<_>>();
        let paste_placeholders = self
            .pending_pastes
            .iter()
            .map(|(placeholder, _)| placeholder.as_str())
            .collect::<Vec<_>>();
        let shell_prompt = !self.shutdown_in_progress
            && self.agent_view.is_none()
            && shell_prompt_display_text(&self.input).is_some();
        let agent_composer_placeholder = self.agent_view.as_ref().map(|view| {
            let status = view
                .steer_status
                .as_deref()
                .map(|status| format!(" · {status}"))
                .unwrap_or_default();
            format!(
                "Message {}{status} · Esc returns to parent",
                view.display_name
            )
        });
        let composer_placeholder = if self.shutdown_in_progress {
            "Shutting down..."
        } else if shell_prompt {
            ""
        } else {
            agent_composer_placeholder
                .as_deref()
                .unwrap_or("Ask KCoder to do anything")
        };
        let composer_text = if self.shutdown_in_progress {
            ""
        } else {
            self.composer_display_text()
        };
        let composer_data = widgets::ComposerData::new(
            composer_text,
            composer_placeholder,
            true,
            false,
            "",
            &KCODER_UI_THEME,
            self.input_scroll_row,
        )
        .with_shell_prompt(shell_prompt)
        .with_image_placeholders(image_placeholders)
        .with_paste_placeholders(paste_placeholders)
        .with_remote_images(
            self.remote_image_urls.len(),
            self.selected_remote_image_index,
        );
        if self.picker_overlay.is_some() {
            // Clear the composer band when a centered picker takes focus so compact
            // windows do not retain an old placeholder that suggests two active inputs.
            widgets::clear_area(input_area, frame.buffer_mut(), KCODER_UI_THEME.surface_bg);
        } else {
            ComposerWidget::new(composer_data).render(input_area, frame.buffer_mut());
        }

        // Keep session metadata below the live conversation instead of pinning
        // a top bar.
        let has_draft = self.composer_has_draft();
        let transient_status_label = self.transient_status_label();
        let show_transient_in_footer =
            !transient_status_label.is_empty() && !self.status_indicator_visible();
        let footer_hint = if self.shutdown_in_progress {
            FooterHint::None
        } else if DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED
            && let Some(key) = self.active_quit_shortcut_key()
        {
            FooterHint::QuitReminder(key)
        } else if let Some(search) = &self.history_search {
            FooterHint::HistorySearch {
                query: &search.query,
                has_match: search.status == HistorySearchStatus::Match,
            }
        } else if self.edit_previous_primed {
            FooterHint::EditPreviousPrimed
        } else if self.edit_previous_hint_visible {
            FooterHint::EditPrevious
        } else if show_transient_in_footer {
            FooterHint::TransientStatus {
                text: &transient_status_label,
            }
        } else if fullscreen_status_in_footer && self.has_interruptible_turn() {
            FooterHint::Interrupt
        } else if fullscreen_status_in_footer && self.spinner.is_running() {
            FooterHint::Activity
        } else if self.spinner.is_running() && has_draft {
            FooterHint::QueueMessage
        } else if shell_prompt_display_text(&self.input).is_some() {
            FooterHint::ShellMode
        } else if has_draft {
            FooterHint::None
        } else {
            FooterHint::Shortcuts
        };
        let footer_compact_status = if show_transient_in_footer {
            self.compact_status_label_without_transient()
        } else {
            compact_status.clone()
        };
        let footer_compact_status = fullscreen_footer_status(
            fullscreen_footer_status_detail.as_deref(),
            &footer_compact_status,
        );
        let model_footer_label =
            model_footer_label(&self.model_name, self.reasoning_effort.as_ref());
        let mode_switch_enabled = self.plan_mode.is_some();
        let mode_label = match (self.session_mode.is_orchestrate(), mode_switch_enabled) {
            (true, true) => self
                .orchestrate_progress_label
                .as_deref()
                .map(|progress| format!("Orchestrate · Plan mode · {progress}"))
                .unwrap_or_else(|| "Orchestrate · Plan mode".to_string()),
            (true, false) => self
                .orchestrate_progress_label
                .as_deref()
                .map(|progress| format!("Orchestrate · {progress}"))
                .unwrap_or_else(|| "Orchestrate".to_string()),
            (false, true) => "Plan mode".to_string(),
            (false, false) => String::new(),
        };
        let footer_activity_visible = self.spinner.is_running() && fullscreen_status_in_footer;
        let footer_activity_label = if footer_activity_visible {
            activity.label.as_str()
        } else {
            ""
        };
        let footer_data = FooterData::new(
            footer_hint,
            &self.display_cwd,
            self.session_title.as_deref().unwrap_or(""),
            &model_footer_label,
            &self.provider_name,
            &footer_compact_status,
            footer_activity_visible,
            self.token_count,
            self.token_total,
            &KCODER_UI_THEME,
        )
        .with_mode_label(&mode_label)
        .with_mode_switch_enabled(mode_switch_enabled)
        .with_esc_backtrack_hint(self.edit_previous_primed)
        .with_activity_elapsed(self.status_elapsed())
        .with_activity_status(
            activity.indicator,
            footer_activity_label,
            activity.snapshot.needs_attention,
        );
        let navigation_width = if !self.messages.is_empty() && footer_area.width >= 80 {
            32
        } else {
            0
        };
        let main_footer = Rect {
            width: footer_area.width.saturating_sub(navigation_width),
            ..footer_area
        };
        FooterWidget::new(footer_data).render(main_footer, frame.buffer_mut());
        self.draw_navigation_footer(
            frame,
            Rect {
                x: main_footer.right(),
                width: navigation_width,
                ..footer_area
            },
        );

        if !self.fullscreen_surface
            && self.startup_idle_surface_active()
            && tail_area.height >= 3
            && tail_area.width > 0
        {
            let mut divider_offsets = if tail_area.height >= 8 {
                vec![tail_area.height / 3, tail_area.height.saturating_mul(2) / 3]
            } else {
                vec![tail_area.height / 2]
            };
            divider_offsets.sort_unstable();
            divider_offsets.dedup();
            let divider = "─".repeat(usize::from(tail_area.width));
            for offset in divider_offsets {
                let divider_y = tail_area.y.saturating_add(offset);
                if divider_y >= tail_area.bottom() {
                    continue;
                }
                let divider_area = Rect::new(tail_area.x, divider_y, tail_area.width, 1);
                let divider_widget = Paragraph::new(Line::from(Span::styled(
                    divider.clone(),
                    Style::default().fg(KCODER_UI_THEME.text_dim),
                )))
                .style(Style::default().bg(KCODER_UI_THEME.surface_bg));
                frame.render_widget(divider_widget, divider_area);
            }
        }

        if self.footer_shortcuts_overlay
            && !self.shutdown_in_progress
            && let Some(overlay_area) = bottom_overlay_area
        {
            draw_footer_shortcuts_overlay(frame, self, overlay_area);
        }

        // Paint the transcript rail after bottom panes. Those widgets can
        // touch right-edge cells while wrapping wide text; drawing the rail
        // last keeps its reserved message-area column from inheriting a stale
        // continuation marker or being visually overwritten.
        if let Some((area, content_rows, viewport_rows, top)) = deferred_transcript_scrollbar {
            render_transcript_scrollbar(frame, area, content_rows, viewport_rows, top);
        }

        if !self.centered_overlay_active() {
            if let Some((cursor_x, cursor_y)) = self.history_search_footer_cursor(footer_area) {
                frame.set_cursor_position((cursor_x, cursor_y));
            } else if self.selected_remote_image_index.is_none() {
                // Place cursor inside input box using visual row/column.
                let (cursor_row, cursor_col) =
                    self.composer_display_cursor_visual_position(content_width);
                let visible_cursor_row = cursor_row.saturating_sub(self.input_scroll_row) as u16;
                let cursor_x = inner.x + (cursor_col as u16).min(inner.width.saturating_sub(1));
                let cursor_y = inner.y + visible_cursor_row.min(inner.height.saturating_sub(1));
                frame.set_cursor_position((cursor_x, cursor_y));
            }
        }

        // Slash command picker overlay.
        self.sync_slash_menu();
        if self.slash_menu.is_some()
            && !self.shutdown_in_progress
            && let Some(overlay_area) = bottom_overlay_area
        {
            draw_slash_menu(frame, self, overlay_area);
        }
        if self.mention_menu.is_some()
            && !self.shutdown_in_progress
            && let Some(overlay_area) = bottom_overlay_area
        {
            draw_mention_menu(frame, self, overlay_area);
        }

        // Permission dialog overlay
        if let Some(dialog) = &self.pending_permission {
            draw_permission_dialog(frame, dialog_host_area, dialog, &self.code_theme);
        }

        // User question dialog overlay
        if let Some(dialog) = &self.pending_question {
            draw_question_dialog(frame, dialog_host_area, dialog);
        }

        // Local goal replacement confirmation overlay
        if let Some(dialog) = &self.pending_goal_replacement {
            draw_goal_replacement_dialog(frame, dialog_host_area, dialog);
        }

        if let Some(overlay) = &self.side_question_overlay {
            draw_side_question_overlay(frame, dialog_host_area, overlay, &self.code_theme);
        }

        // Permission input editor overlay
        if let Some(editor) = &self.permission_editor {
            draw_permission_editor(frame, dialog_host_area, editor);
        }

        // Context inspector overlay
        if let Some(inspector) = &self.context_inspector {
            draw_context_inspector(frame, inspector);
        }

        // Settings inspector overlay
        if let Some(inspector) = &self.settings_inspector {
            draw_settings_inspector(frame, inspector);
        }

        // Keyboard shortcuts overlay
        if self.keys_overlay.is_some() {
            draw_keys_overlay(frame, self.plan_mode.is_some());
        }

        // Generic picker overlay
        if let Some(picker) = &self.picker_overlay {
            draw_picker_overlay(frame, picker);
        }

        // Full transcript overlay.
        if self.transcript_overlay.is_some() {
            self.draw_transcript_overlay(frame);
        }
        self.draw_outline(frame);
        if let Some(viewport) = parked_navigation_viewport {
            self.transcript_viewport = viewport;
        }
    }
}

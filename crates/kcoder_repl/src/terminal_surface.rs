//! Terminal cleanup, inline viewport resizing, and frame dispatch.

use super::*;

pub(super) fn cleanup_alternate_screen_for_exit<B: Backend + Write>(
    terminal: &mut Terminal<B>,
) -> Result<()> {
    terminal
        .reset_cursor_style()
        .context("failed to reset cursor style before terminal restore")?;
    std::io::Write::flush(terminal.backend_mut())
        .context("failed to flush alternate screen cleanup")?;
    Ok(())
}

pub(super) struct ExitScrollbackFlush {
    pub(super) target: usize,
    pub(super) lines: Vec<HyperlinkLine>,
    pub(super) commit_welcome: bool,
}

pub(super) fn prepare_remaining_history_for_exit(
    app: &mut ReplApp,
    width: u16,
) -> Option<ExitScrollbackFlush> {
    app.flush_active_turn();
    let committed_until = app.scrollback_committed_until.min(app.messages.len());
    app.scrollback_committed_until = committed_until;

    let target = app.messages.len();
    let mut lines = if target > committed_until {
        app.render_transcript_range_hyperlink(committed_until, target, width)
    } else {
        Vec::new()
    };
    let has_following_content = !lines.is_empty();
    let commit_welcome = app.should_render_startup_welcome(committed_until);
    app.prepend_startup_welcome_hyperlink_lines(
        &mut lines,
        width,
        committed_until,
        has_following_content,
    );

    if lines.is_empty() {
        return None;
    }

    Some(ExitScrollbackFlush {
        target,
        lines,
        commit_welcome,
    })
}

pub(super) fn write_remaining_history_for_exit<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
) -> Result<bool> {
    let size = terminal
        .size()
        .context("failed to read terminal size before inline exit cleanup")?;
    let width = size.width.max(1);
    let Some(prepared) = prepare_remaining_history_for_exit(app, width) else {
        return Ok(false);
    };

    let viewport_top = terminal.viewport_area.top();
    terminal
        .clear_after_position(Position::new(0, viewport_top))
        .context("failed to clear inline viewport before exit scrollback flush")?;

    let wrap_width = usize::from(width.max(1));
    let writer = terminal.backend_mut();
    crossterm::queue!(writer, MoveTo(0, viewport_top))
        .context("failed to position cursor for inline exit scrollback flush")?;
    for (index, line) in prepared.lines.iter().enumerate() {
        if index > 0 {
            crossterm::queue!(writer, Print("\r\n"))
                .context("failed to advance inline exit scrollback line")?;
        }
        insert_history::write_history_line(writer, line, wrap_width)
            .context("failed to write inline exit scrollback line")?;
    }
    crossterm::queue!(writer, Print("\r\n"))
        .context("failed to move cursor after inline exit scrollback flush")?;

    app.scrollback_committed_until = prepared.target;
    if prepared.commit_welcome {
        app.welcome_scrollback_committed = true;
    }
    terminal.invalidate_viewport();
    Ok(true)
}

pub(super) fn cleanup_inline_viewport_for_exit<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
) -> Result<()> {
    if terminal.viewport_area.is_empty() {
        return Ok(());
    }
    let wrote_history = write_remaining_history_for_exit(terminal, app)?;
    if !wrote_history {
        let prompt_position = Position::new(0, terminal.viewport_area.y);
        terminal
            .clear_after_position(prompt_position)
            .context("failed to clear inline viewport before terminal restore")?;
        let bottom_position = Position::new(0, terminal.viewport_area.bottom().saturating_sub(1));
        terminal
            .set_cursor_position(bottom_position)
            .context("failed to move cursor after clearing inline viewport")?;
    }
    terminal
        .reset_cursor_style()
        .context("failed to reset cursor style before terminal restore")?;
    std::io::Write::flush(terminal.backend_mut())
        .context("failed to flush inline viewport cleanup")?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct InlineViewportHeights {
    pub(super) base: u16,
    pub(super) expanded: u16,
    pub(super) reserved_bottom_slack: u16,
    pub(super) max_top: Option<u16>,
}

pub(super) const STARTUP_MAX_BLANK_GAP_BEFORE_LIVE_VIEWPORT: u16 = 8;

pub(super) fn startup_live_viewport_top_offset() -> u16 {
    STARTUP_MAX_BLANK_GAP_BEFORE_LIVE_VIEWPORT / 2
}

#[cfg(test)]
pub(super) fn update_inline_viewport<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    height: u16,
) -> Result<bool> {
    update_inline_viewport_for_draw(
        terminal,
        InlineViewportHeights {
            base: height,
            expanded: height,
            reserved_bottom_slack: 0,
            max_top: None,
        },
    )
}

pub(super) fn scroll_rows_above_inline_viewport<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    viewport_top: u16,
    rows: u16,
    allow_shell_history: bool,
    context: &'static str,
) -> Result<u16> {
    let rows = rows.min(viewport_top);
    if rows == 0 {
        return Ok(0);
    }

    let visible_history_rows = terminal.visible_history_rows().min(viewport_top);
    let mut scrolled = 0u16;
    if visible_history_rows > 0 {
        let visible_scroll = rows.min(visible_history_rows);
        let history_start = viewport_top.saturating_sub(visible_history_rows);
        terminal
            .backend_mut()
            .scroll_region_up(history_start..viewport_top, visible_scroll)
            .context(context)?;
        terminal.note_visible_history_rows_scrolled_out(visible_scroll);
        scrolled = scrolled.saturating_add(visible_scroll);
    }

    let remaining = rows.saturating_sub(scrolled);
    if remaining == 0 || !allow_shell_history {
        return Ok(scrolled);
    }

    let shell_region_end = viewport_top.saturating_sub(scrolled);
    let shell_scroll = remaining.min(shell_region_end);
    if shell_scroll == 0 {
        return Ok(scrolled);
    }
    terminal
        .backend_mut()
        .scroll_region_up(0..shell_region_end, shell_scroll)
        .context(context)?;
    Ok(scrolled.saturating_add(shell_scroll))
}

pub(super) fn update_inline_viewport_for_draw<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    heights: InlineViewportHeights,
) -> Result<bool> {
    let size = terminal.size().context("failed to read terminal size")?;
    let screen_height = size.height.max(1);
    let screen_width = size.width.max(1);
    let terminal_height_shrank = screen_height < terminal.last_known_screen_size.height.max(1);
    let previous_area = terminal.viewport_area;
    let first_live_viewport_draw = previous_area.height == 0;
    let mut area = terminal.viewport_area;
    area.width = screen_width;
    area.y = area.y.min(screen_height.saturating_sub(1));

    area.height = heights.base.min(screen_height).max(1);
    if area.bottom() > screen_height {
        let scroll_by = area.bottom() - screen_height;
        let mut scrolled = 0;
        if !terminal_height_shrank {
            if first_live_viewport_draw && terminal.visible_history_rows() > 0 {
                let scroll = scroll_by.min(area.top());
                if scroll > 0 {
                    let visible_history_rows = terminal.visible_history_rows().min(area.top());
                    let visible_history_top = area.top().saturating_sub(visible_history_rows);
                    terminal
                        .backend_mut()
                        .scroll_region_up(0..area.top(), scroll)
                        .context("failed to scroll prior terminal rows above startup viewport")?;
                    let visible_rows_scrolled = scroll.saturating_sub(visible_history_top);
                    if visible_rows_scrolled > 0 {
                        terminal.note_visible_history_rows_scrolled_out(visible_rows_scrolled);
                    }
                    scrolled = scroll;
                }
            } else {
                scrolled = scroll_rows_above_inline_viewport(
                    terminal,
                    area.top(),
                    scroll_by,
                    true,
                    "failed to scroll prior terminal history above inline viewport",
                )?;
            }
        }
        area.y = area.y.saturating_sub(scrolled);
        if area.bottom() > screen_height {
            area.y = screen_height.saturating_sub(area.height);
        }
    }

    let mut current_bottom_slack = screen_height.saturating_sub(area.bottom());
    let max_bottom_slack = screen_height.saturating_sub(area.height);
    let target_bottom_slack = if first_live_viewport_draw {
        current_bottom_slack.min(heights.reserved_bottom_slack.min(max_bottom_slack))
    } else {
        heights.reserved_bottom_slack.min(max_bottom_slack)
    };
    let consume_rows = current_bottom_slack
        .saturating_sub(target_bottom_slack)
        .min(max_bottom_slack);
    if consume_rows > 0 {
        area.y = area
            .y
            .saturating_add(consume_rows)
            .min(screen_height.saturating_sub(area.height));
        current_bottom_slack = screen_height.saturating_sub(area.bottom());
    }
    let max_top = heights.max_top.or_else(|| {
        (first_live_viewport_draw && terminal.visible_history_rows() > 0).then(|| {
            previous_area
                .y
                .saturating_add(startup_live_viewport_top_offset())
        })
    });
    if let Some(max_top) = max_top {
        let max_startup_top = max_top.min(screen_height.saturating_sub(area.height));
        if area.y > max_startup_top {
            area.y = max_startup_top;
            current_bottom_slack = screen_height.saturating_sub(area.bottom());
        }
    }
    let visible_history_rows = terminal.visible_history_rows().min(area.y);
    let reserve_rows = target_bottom_slack
        .saturating_sub(current_bottom_slack)
        .min(visible_history_rows)
        .min(area.y);
    if reserve_rows > 0 && !terminal_height_shrank {
        let scrolled = scroll_rows_above_inline_viewport(
            terminal,
            area.top(),
            reserve_rows,
            false,
            "failed to reserve bottom slack above inline viewport",
        )?;
        area.y = area.y.saturating_sub(scrolled);
    }

    let available_below_top = screen_height.saturating_sub(area.y).max(1);
    area.height = heights
        .expanded
        .max(heights.base)
        .min(available_below_top)
        .max(1);

    let mut needs_full_repaint = false;
    if area != terminal.viewport_area {
        // A shorter terminal clips the abandoned part of the old live surface, so
        // preserve committed rows above the new one. On growth, those old composer
        // rows remain visible and must be cleared before repainting at the new top.
        let clear_top = if terminal_height_shrank {
            area.y
        } else {
            previous_area.y.min(area.y)
        };
        let clear_position = Position::new(0, clear_top);
        terminal.set_viewport_area(area);
        terminal
            .clear_after_position(clear_position)
            .context("failed to clear viewport transition")?;
        needs_full_repaint = true;
    }
    Ok(needs_full_repaint)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TerminalSurfaceMode {
    Inline,
    Fullscreen,
}

#[cfg(test)]
pub(super) fn draw_kcoder_frame<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
) -> Result<bool> {
    draw_kcoder_frame_with_mode(terminal, app, TerminalSurfaceMode::Inline)
}

pub(super) fn draw_kcoder_frame_with_mode<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
    mode: TerminalSurfaceMode,
) -> Result<bool> {
    match mode {
        TerminalSurfaceMode::Inline => draw_kcoder_inline_frame(terminal, app),
        TerminalSurfaceMode::Fullscreen => draw_kcoder_fullscreen_frame(terminal, app),
    }
}

pub(super) fn draw_kcoder_fullscreen_frame<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
) -> Result<bool> {
    terminal
        .synchronized_update(|terminal| -> Result<bool> {
            let size = terminal.size().context("failed to read terminal size")?;
            let area = Rect::new(0, 0, size.width.max(1), size.height.max(1));
            app.observe_terminal_size(size);
            app.scrollback_committed_until = 0;
            app.welcome_scrollback_committed = false;
            app.fullscreen_surface = true;
            app.sync_slash_menu();

            let resize_viewport_reset = app.take_resize_viewport_reset_pending();
            let force_viewport_redraw = app.take_force_viewport_redraw();
            let viewport_changed = terminal.viewport_area != area;
            if viewport_changed {
                terminal.set_viewport_area(area);
            }
            if cfg!(windows) && (viewport_changed || resize_viewport_reset) {
                // The native Windows console host can retain stale cells after
                // its visible window and screen buffer are resized. Row-level
                // Erase in Line repainting is insufficient there and produces
                // blank surfaces or old rectangles until another full redraw.
                // Clear the owned alternate-screen surface inside the same
                // synchronized update, then rebuild the frame from an empty
                // comparison buffer.
                terminal
                    .clear_visible_screen()
                    .context("failed to clear resized Windows fullscreen surface")?;
                terminal.reset_current_viewport_buffer();
            } else if viewport_changed || resize_viewport_reset || force_viewport_redraw {
                // In fullscreen mode the whole terminal surface is owned by
                // ratatui. Mark the previous buffer dirty so the next draw
                // emits row-level clears plus the new content in the same
                // synchronized update. A plain buffer reset would make the
                // diff think the screen was already blank, leaving stale
                // xterm.js canvas pixels behind; a physical full-screen clear
                // can be captured as a black flash between clear and repaint.
                terminal.reset_current_viewport_buffer();
                terminal.invalidate_viewport_for_repaint();
            }

            app.sync_terminal_title(terminal.backend_mut())?;
            terminal
                .draw(|f| app.draw(f))
                .context("failed to draw KCoder fullscreen TUI frame")?;
            Ok(false)
        })
        .context("failed to run synchronized fullscreen terminal update")?
}

pub(super) fn draw_kcoder_inline_frame<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
) -> Result<bool> {
    app.fullscreen_surface = false;
    terminal
        .synchronized_update(|terminal| -> Result<bool> {
            let size = terminal.size().context("failed to read terminal size")?;
            app.observe_terminal_size(size);
            let resize_viewport_reset = app.take_resize_viewport_reset_pending();
            if resize_viewport_reset {
                terminal.invalidate_viewport();
            }
            append_initial_welcome_to_terminal_scrollback(terminal, app, size.width.max(1))?;
            let mut prepared_scrollback = prepare_committed_history_for_scrollback(
                app,
                size.width.max(1),
                terminal.viewport_area,
                size.height.max(1),
            );
            let reflow_ran = false;
            let height_budget = size.height.max(1);
            app.sync_slash_menu();
            let pending_scrollback_target = prepared_scrollback
                .as_ref()
                .map(|prepared| prepared.target)
                .filter(|target| *target > app.scrollback_committed_until);
            let original_scrollback_committed_until = app.scrollback_committed_until;
            if let Some(target) = pending_scrollback_target {
                app.scrollback_committed_until = target.min(app.messages.len());
            }
            let mut viewport_heights =
                app.inline_viewport_heights(size.width.max(1), height_budget);
            viewport_heights.base = viewport_heights
                .base
                .min(max_inline_viewport_height(height_budget));
            viewport_heights.expanded = viewport_heights
                .expanded
                .min(max_inline_viewport_height(height_budget));
            app.scrollback_committed_until = original_scrollback_committed_until;
            let viewport_needs_full_repaint =
                update_inline_viewport_for_draw(terminal, viewport_heights)?;
            let mut more_scrollback_to_flush =
                if !reflow_ran && let Some(prepared) = prepared_scrollback.take() {
                    flush_prepared_history_to_scrollback(terminal, app, prepared)?
                } else {
                    false
                };
            if !reflow_ran
                && !more_scrollback_to_flush
                && viewport_needs_full_repaint
                && let Some(prepared) = prepare_committed_history_for_scrollback(
                    app,
                    size.width.max(1),
                    terminal.viewport_area,
                    size.height.max(1),
                )
            {
                more_scrollback_to_flush =
                    flush_prepared_history_to_scrollback(terminal, app, prepared)?;
            }
            let force_viewport_redraw = app.take_force_viewport_redraw();
            if viewport_needs_full_repaint || resize_viewport_reset {
                terminal.invalidate_viewport();
            }
            if viewport_needs_full_repaint || force_viewport_redraw || resize_viewport_reset {
                // Physically clear the stale live surface and reset the
                // previous buffer. Ordinary forced redraws only need the
                // current viewport. A terminal resize invalidates the screen
                // coordinate system, but clearing from the top would erase the
                // transcript rows the terminal is still visibly showing above
                // the live composer. Clear only the live surface so resize
                // redraws remove stale composer/footer cells without turning
                // the readable scrollback area into a blank pane.
                //
                // A pure buffer-reset
                // (`invalidate_viewport`) makes the diff repaint every cell the
                // paragraph renders, but wide-char (CJK) tail columns left by a
                // previous frame's wider glyph are not always overwritten by a
                // Put at the same coordinate — the terminal keeps the stale
                // second column until it is explicitly cleared. Clearing the
                // physical region first guarantees those orphaned cells are
                // gone. The cost is a brief blank frame on terminals that do
                // not hide synchronized updates, but stale duplicate text is
                // the worse user-visible failure.
                let clear_top = terminal.viewport_area.top();
                terminal
                    .clear_after_position(Position::new(0, clear_top))
                    .context("failed to clear viewport before forced redraw")?;
            }
            if resize_viewport_reset {
                repaint_visible_scrollback_tail_after_resize(terminal, app, size.width.max(1))?;
            }
            app.sync_terminal_title(terminal.backend_mut())?;
            terminal
                .draw(|f| app.draw(f))
                .context("failed to draw KCoder TUI frame")?;
            Ok(reflow_ran || more_scrollback_to_flush || viewport_needs_full_repaint)
        })
        .context("failed to run synchronized terminal update")?
}

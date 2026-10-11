//! Committed history preparation and scrollback flushes.

use super::*;

pub(super) struct PreparedScrollbackFlush {
    pub(super) target: usize,
    pub(super) lines: Vec<HyperlinkLine>,
    pub(super) height: usize,
    pub(super) wrap_policy: insert_history::HistoryLineWrapPolicy,
    pub(super) commit_welcome: bool,
}

pub(super) fn append_initial_welcome_to_terminal_scrollback<B>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
    width: u16,
) -> Result<bool>
where
    B: Backend + Write,
{
    if terminal.viewport_area.height > 0 || !app.should_render_startup_welcome(0) {
        return Ok(false);
    }

    let width = width.max(1);
    let mut lines = render_startup_welcome(startup_welcome_info(app), Some(width))
        .into_iter()
        .map(HyperlinkLine::new)
        .collect::<Vec<_>>();
    let commit_startup_notices = app
        .messages
        .iter()
        .all(|message| message.role == MessageRole::System);
    let startup_notice_target = if commit_startup_notices {
        app.messages.len()
    } else {
        0
    };
    if startup_notice_target > 0 {
        let mut notice_lines =
            app.render_transcript_range_hyperlink(0, startup_notice_target, width);
        if !notice_lines.is_empty() {
            lines.push(HyperlinkLine::new(Line::from("")));
            lines.append(&mut notice_lines);
        }
    }
    if lines.is_empty() {
        app.welcome_scrollback_committed = true;
        app.scrollback_committed_until = startup_notice_target;
        return Ok(true);
    }

    let wrap_policy = if app.raw_output_mode() {
        insert_history::HistoryLineWrapPolicy::Terminal
    } else {
        insert_history::HistoryLineWrapPolicy::PreWrap
    };
    let height =
        insert_history::history_lines_display_rows(&lines, usize::from(width), wrap_policy);
    if height > usize::from(u16::MAX) {
        warn!(
            height,
            "skipping oversized startup welcome append to terminal scrollback"
        );
        return Ok(false);
    }

    let mut start_y = terminal.viewport_area.top();
    let screen_height = terminal
        .size()
        .context("failed to read terminal size before startup welcome append")?
        .height
        .max(1);
    let rows_written = height as u16;
    let min_live_rows_after_welcome = 4u16.min(screen_height.saturating_sub(1));
    let required_rows = rows_written.saturating_add(min_live_rows_after_welcome);
    let overflow = start_y
        .saturating_add(required_rows)
        .saturating_sub(screen_height);
    if overflow > 0 && start_y > 0 {
        let scroll = overflow.min(start_y);
        terminal
            .backend_mut()
            .scroll_region_up(0..start_y, scroll)
            .context("failed to make room for startup welcome")?;
        start_y = start_y.saturating_sub(scroll);
        terminal.last_known_cursor_pos.y = terminal.last_known_cursor_pos.y.saturating_sub(scroll);
    }
    let wrap_width = usize::from(width);
    let writer = terminal.backend_mut();
    let mut write_y = start_y;
    for line in &lines {
        crossterm::queue!(writer, MoveTo(0, write_y))
            .context("failed to position cursor for startup welcome append")?;
        insert_history::write_history_line(writer, line, wrap_width)
            .context("failed to write startup welcome append line")?;
        let physical_rows = line.width().max(1).div_ceil(wrap_width.max(1));
        write_y = write_y
            .saturating_add(physical_rows.min(usize::from(u16::MAX)) as u16)
            .min(screen_height.saturating_sub(1));
    }
    crossterm::queue!(writer, MoveTo(0, write_y))
        .context("failed to move cursor after startup welcome append")?;

    let new_y = start_y
        .saturating_add(rows_written)
        .min(screen_height.saturating_sub(1));
    let mut area = terminal.viewport_area;
    area.y = new_y;
    area.width = width;
    terminal.set_viewport_area(area);
    terminal.last_known_cursor_pos = Position::new(0, new_y);
    terminal.note_history_rows_inserted(rows_written);
    terminal.invalidate_viewport();
    app.welcome_scrollback_committed = true;
    app.scrollback_committed_until = startup_notice_target;
    app.startup_live_viewport_top_limit =
        Some(new_y.saturating_add(startup_live_viewport_top_offset()));
    Ok(true)
}

pub(super) fn prepare_committed_history_for_scrollback(
    app: &mut ReplApp,
    width: u16,
    _viewport_area: Rect,
    _screen_height: u16,
) -> Option<PreparedScrollbackFlush> {
    if app.copy_view.is_some() || app.outline_open || app.navigation.inline {
        return None;
    }
    let committed_until = app.scrollback_committed_until.min(app.messages.len());
    app.scrollback_committed_until = committed_until;
    let live_transcript_rows = app.transcript_viewport.viewport_rows().max(1);
    let target =
        app.scrollback_commit_target_for_viewport(committed_until, width, live_transcript_rows);
    let commit_welcome = app.should_render_startup_welcome(committed_until);
    if target <= committed_until && !commit_welcome {
        return None;
    }

    let mut lines = if target > committed_until {
        app.render_transcript_range_hyperlink(committed_until, target, width)
    } else {
        Vec::new()
    };
    let has_following_content = !lines.is_empty();
    app.prepend_startup_welcome_hyperlink_lines(
        &mut lines,
        width,
        committed_until,
        has_following_content,
    );
    let wrap_policy = if app.raw_output_mode() {
        insert_history::HistoryLineWrapPolicy::Terminal
    } else {
        insert_history::HistoryLineWrapPolicy::PreWrap
    };
    let height =
        insert_history::history_lines_display_rows(&lines, usize::from(width.max(1)), wrap_policy);
    Some(PreparedScrollbackFlush {
        target,
        lines,
        height,
        wrap_policy,
        commit_welcome,
    })
}

pub(super) fn flush_prepared_history_to_scrollback<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
    prepared: PreparedScrollbackFlush,
) -> Result<bool> {
    let size = terminal
        .size()
        .context("failed to read terminal size before scrollback flush")?;
    if terminal.viewport_area.top() == 0 && terminal.viewport_area.bottom() >= size.height.max(1) {
        return Ok(false);
    }
    let mark_committed = |app: &mut ReplApp, target: usize, commit_welcome: bool| {
        app.scrollback_committed_until = target;
        if commit_welcome {
            app.welcome_scrollback_committed = true;
        }
        // The current frame computed its viewport height from the pre-flush
        // transcript window. Once rows move into terminal scrollback, the live
        // window can be much shorter; force a follow-up frame to recompute
        // desired_height from source instead of leaving a stale blank band.
        app.transcript_viewport.invalidate_content_layout();
        if app.transcript_viewport.is_at_tail() {
            app.snap_to_bottom();
        }
        app.force_next_viewport_redraw();
    };
    if prepared.height == 0 {
        mark_committed(app, prepared.target, prepared.commit_welcome);
        return Ok(true);
    }
    if prepared.height > u16::MAX as usize {
        warn!(
            height = prepared.height,
            target = prepared.target,
            "skipping oversized transcript scrollback insert"
        );
        return Ok(false);
    }

    // ConPTY owns only a fixed-size console buffer and does not forward the
    // scroll-region operations used by the standard inline history path to
    // the host terminal. Emit physical lines there so Windows Terminal (and
    // other ConPTY clients) can retain the same native scrollback as a Unix
    // PTY. Zellij raw-output mode needs the same strategy for a different
    // transport limitation.
    let insert_mode = if cfg!(windows)
        || (zellij_multiplexer_detected()
            && prepared.wrap_policy == insert_history::HistoryLineWrapPolicy::Terminal)
    {
        insert_history::InsertHistoryMode::ZellijRaw
    } else {
        insert_history::InsertHistoryMode::Standard
    };
    insert_history::insert_history_hyperlink_lines_with_mode_and_wrap_policy(
        terminal,
        prepared.lines,
        insert_mode,
        prepared.wrap_policy,
    )
    .context("failed to insert transcript history into terminal scrollback")?;
    mark_committed(app, prepared.target, prepared.commit_welcome);
    Ok(true)
}

pub(super) fn repaint_visible_scrollback_tail_after_resize<B>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
    width: u16,
) -> Result<()>
where
    B: Backend + Write,
{
    let rows_above_live_viewport = terminal.viewport_area.top();
    if rows_above_live_viewport == 0 || app.scrollback_committed_until == 0 {
        return Ok(());
    }

    let target = app.scrollback_committed_until.min(app.messages.len());
    let lines = app.render_transcript_range_hyperlink(0, target, width.max(1));
    if lines.is_empty() {
        return Ok(());
    }

    let wrap_width = usize::from(width.max(1));
    let row_budget = usize::from(rows_above_live_viewport);
    let mut selected = Vec::new();
    let mut selected_rows = 0usize;
    for line in lines.into_iter().rev() {
        let rows = line.width().max(1).div_ceil(wrap_width.max(1));
        if rows > row_budget {
            continue;
        }
        if selected_rows.saturating_add(rows) > row_budget {
            break;
        }
        selected_rows = selected_rows.saturating_add(rows);
        selected.push((line, rows));
    }
    if selected.is_empty() {
        return Ok(());
    }

    let mut write_y = rows_above_live_viewport.saturating_sub(selected_rows as u16);
    let writer = terminal.backend_mut();
    for (line, rows) in selected.into_iter().rev() {
        crossterm::queue!(writer, MoveTo(0, write_y))
            .context("failed to position cursor for resize scrollback tail repaint")?;
        insert_history::write_history_line(writer, &line, wrap_width)
            .context("failed to repaint resize scrollback tail line")?;
        write_y = write_y
            .saturating_add(rows.min(usize::from(u16::MAX)) as u16)
            .min(rows_above_live_viewport);
    }

    Ok(())
}

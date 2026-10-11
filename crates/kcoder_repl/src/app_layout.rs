//! Composer and transcript geometry, scroll windows, and scrollbar rendering.

use super::*;

#[cfg(test)]
pub(super) fn composer_height_for_width(app: &ReplApp, width: u16) -> u16 {
    composer_height_for_width_with_limit(app, width, None)
}

pub(super) fn composer_height_for_width_with_limit(
    app: &ReplApp,
    width: u16,
    max_composer_height: Option<u16>,
) -> u16 {
    let input_content_width = composer_text_width(width);
    let wrapped_rows = app.wrap_composer_display_rows(input_content_width);
    let desired_visible_rows = wrapped_rows
        .len()
        .max(MIN_COMPOSER_ROWS as usize)
        .min(usize::from(u16::MAX)) as u16;
    let mut remote_rows = app
        .remote_image_urls
        .len()
        .min(usize::from(u16::MAX))
        .try_into()
        .unwrap_or(u16::MAX);
    if let Some(height) = max_composer_height
        && remote_rows > 0
    {
        remote_rows = remote_rows.min(height.saturating_sub(4));
    }
    let fixed_rows = remote_rows
        .saturating_add(u16::from(remote_rows > 0))
        .saturating_add(2);
    let max_visible_rows = max_composer_height
        .map(|height| height.saturating_sub(fixed_rows).max(MIN_COMPOSER_ROWS))
        .unwrap_or(u16::MAX);
    desired_visible_rows
        .min(max_visible_rows)
        .saturating_add(fixed_rows)
}

pub(super) fn composer_height_limit_for_terminal(
    terminal_height: u16,
    status_height: u16,
    pending_input_height: u16,
    footer_height: u16,
    todo_height: u16,
) -> u16 {
    let available = terminal_height
        .saturating_sub(status_height)
        .saturating_sub(pending_input_height)
        .saturating_sub(footer_height)
        .saturating_sub(todo_height)
        .saturating_sub(BOTTOM_PANE_TOP_SPACER);
    let half_screen_cap = terminal_height.saturating_div(2).max(3);
    available.max(3).min(half_screen_cap)
}

pub(super) struct ActivityPresentation {
    pub(super) snapshot: ActivitySnapshot,
    pub(super) indicator: &'static str,
    pub(super) label: String,
    pub(super) detail: Option<String>,
}

pub(super) fn status_indicator_height(app: &ReplApp, width: u16) -> u16 {
    if !app.status_indicator_visible() {
        return 0;
    }

    let activity = app.activity_presentation();
    let mut data = StatusIndicatorData::new(
        &activity.label,
        activity.detail.as_deref(),
        "",
        app.status_elapsed(),
        StatusIndicatorControls {
            show_interrupt_hint: app.has_interruptible_turn(),
            interrupt_hint: "esc",
            is_running: app.spinner.is_running(),
        },
        &KCODER_UI_THEME,
    )
    .with_activity_indicator(activity.indicator, activity.snapshot.needs_attention);
    data.started_at = app.turn_started_at;
    data.details_capitalization = StatusDetailsCapitalization::Preserve;
    StatusIndicatorWidget::new(data)
        .desired_height(width.max(1))
        .min(STATUS_INDICATOR_MAX_HEIGHT)
}

pub(super) fn fullscreen_footer_status(detail: Option<&str>, ambient_status: &str) -> String {
    let detail = detail.map(str::trim).filter(|text| !text.is_empty());
    let ambient_status = ambient_status.trim();
    match (detail, ambient_status.is_empty()) {
        (Some(detail), false) => format!("{detail} · {ambient_status}"),
        (Some(detail), true) => detail.to_string(),
        (None, false) => ambient_status.to_string(),
        (None, true) => String::new(),
    }
}

pub(super) fn pending_input_preview_layout_height(preview_height: u16, status_height: u16) -> u16 {
    if preview_height == 0 {
        0
    } else {
        preview_height.saturating_add(u16::from(status_height > 0))
    }
}

pub(super) fn status_indicator_layout_height(status_height: u16, preview_height: u16) -> u16 {
    if status_height == 0 {
        0
    } else {
        status_height.saturating_add(u16::from(preview_height == 0))
    }
}

pub(super) fn pending_input_preview_content_area(
    pending_input_area: Rect,
    has_status_area: bool,
) -> Rect {
    let gap = u16::from(has_status_area && pending_input_area.height > 1);
    Rect::new(
        pending_input_area.x,
        pending_input_area.y.saturating_add(gap),
        pending_input_area.width,
        pending_input_area.height.saturating_sub(gap),
    )
}

#[allow(dead_code)]
pub(super) fn wrapped_display_line_count(lines: &[Line<'_>], width: u16) -> usize {
    let width = usize::from(width.max(1));
    lines
        .iter()
        .map(|line| line.width().max(1).div_ceil(width))
        .sum()
}

/// Return the number of wrapped display rows ratatui will actually render for
/// the given lines at the given width. This must use the same Paragraph
/// configuration (Wrap, trim, style) as the live viewport so the count matches
/// what the user sees.
pub(super) fn paragraph_line_count(lines: &[Line<'_>], width: u16) -> usize {
    if lines.is_empty() {
        return 0;
    }
    let width = width.max(1);
    let paragraph = Paragraph::new(Text::from(lines.to_vec())).wrap(Wrap { trim: false });
    paragraph.line_count(width)
}

pub(super) fn bottom_aligned_paragraph(
    mut lines: Vec<Line<'static>>,
    width: u16,
    height: u16,
) -> (Vec<Line<'static>>, usize) {
    let rows = paragraph_line_count(&lines, width);
    if height == 0 {
        return (Vec::new(), rows);
    }
    let height = usize::from(height);
    if rows < height {
        let mut padded = Vec::with_capacity(lines.len() + height - rows);
        padded.extend((0..height - rows).map(|_| Line::from("")));
        padded.append(&mut lines);
        (padded, 0)
    } else {
        (lines, rows.saturating_sub(height))
    }
}

pub(super) fn wrapped_line_rows(line: &Line<'_>, width: u16) -> usize {
    paragraph_line_count(std::slice::from_ref(line), width).max(1)
}

pub(super) fn scroll_render_window_lines(
    lines: Vec<Line<'static>>,
    width: u16,
    top: usize,
    viewport_rows: usize,
    overscan_rows: usize,
) -> (Vec<Line<'static>>, usize) {
    if lines.is_empty() || viewport_rows == 0 {
        return (lines, 0);
    }

    let start_row = top.saturating_sub(overscan_rows);
    let end_row = top
        .saturating_add(viewport_rows)
        .saturating_add(overscan_rows);
    let mut row = 0usize;
    let mut start_idx = 0usize;
    let mut start_row_for_idx = 0usize;
    let mut found_start = false;

    for (idx, line) in lines.iter().enumerate() {
        let rows = wrapped_line_rows(line, width);
        if row.saturating_add(rows) > start_row {
            start_idx = idx;
            start_row_for_idx = row;
            found_start = true;
            break;
        }
        row = row.saturating_add(rows);
    }

    if !found_start {
        return (Vec::new(), 0);
    }

    let mut end_idx = start_idx;
    let mut end_row_cursor = start_row_for_idx;
    while end_idx < lines.len() && end_row_cursor < end_row {
        end_row_cursor = end_row_cursor.saturating_add(wrapped_line_rows(&lines[end_idx], width));
        end_idx += 1;
    }

    let adjusted_top = top.saturating_sub(start_row_for_idx);
    let window = lines
        .into_iter()
        .skip(start_idx)
        .take(end_idx.saturating_sub(start_idx))
        .collect();
    (window, adjusted_top)
}

#[cfg(test)]
pub(super) fn clamp_render_top_to_content(
    render_top: usize,
    rendered_rows: usize,
    viewport_rows: usize,
) -> usize {
    render_top.min(rendered_rows.saturating_sub(viewport_rows.max(1)))
}

pub(super) fn remap_scroll_top_proportionally(
    top: usize,
    source_rows: usize,
    target_rows: usize,
    viewport_rows: usize,
) -> usize {
    let source_max = source_rows.saturating_sub(viewport_rows);
    let target_max = target_rows.saturating_sub(viewport_rows);
    if source_max == 0 {
        return 0;
    }
    target_max
        .saturating_mul(top.min(source_max))
        .saturating_add(source_max / 2)
        / source_max
}

pub(super) fn render_transcript_scrollbar(
    frame: &mut Frame,
    area: Rect,
    content_rows: usize,
    viewport_rows: usize,
    top: usize,
) {
    let Some(scrollbar_area) = transcript_scrollbar_area(area, content_rows, viewport_rows) else {
        return;
    };
    let metrics =
        TranscriptScrollbarMetrics::new(content_rows, viewport_rows, top, scrollbar_area.height);

    let theme = &KCODER_UI_THEME;
    let track_style = Style::default().fg(theme.text_dim).bg(theme.surface_bg);
    let thumb_style = Style::default().fg(theme.text_muted).bg(theme.surface_bg);
    let x = scrollbar_area.x;
    for offset in 0..scrollbar_area.height {
        let y = scrollbar_area.y.saturating_add(offset);
        let fill = metrics.cell_fill(usize::from(offset));
        let in_thumb = !matches!(fill, TranscriptScrollbarCellFill::Empty);
        set_transcript_scrollbar_cell(
            &mut frame.buffer_mut()[(x, y)],
            fill,
            if in_thumb { thumb_style } else { track_style },
        );
    }
}

pub(super) fn set_transcript_scrollbar_cell(
    cell: &mut Cell,
    fill: TranscriptScrollbarCellFill,
    style: Style,
) {
    // The rail owns this reserved cell. Reset first because Cell::set_style
    // merges modifiers; stale wide-cell and reverse-video state can otherwise
    // leave a neighboring-column remnant while the thumb moves.
    cell.reset();
    cell.set_symbol(transcript_scrollbar_vertical_symbol(fill))
        .set_style(style);
}

pub(super) fn transcript_area_for_message_area(area: Rect, reserve_scrollbar_gutter: bool) -> Rect {
    // Leave one scrollbar cell plus the normal trailing margin. Windows uses
    // ASCII rail symbols, so a broad defensive gutter is no longer necessary.
    let right_padding = if reserve_scrollbar_gutter { 3 } else { 2 };
    Rect::new(
        area.x.saturating_add(1),
        area.y,
        area.width.saturating_sub(right_padding),
        area.height,
    )
}

pub(super) fn transcript_gutter_area(message_area: Rect, transcript_area: Rect) -> Option<Rect> {
    let x = transcript_area.right();
    let width = message_area.right().saturating_sub(x);
    if width == 0 || message_area.height == 0 {
        return None;
    }
    Some(Rect::new(x, message_area.y, width, message_area.height))
}

pub(super) fn keyed_transcript_block_fingerprint(
    message: &DisplayMessage,
    width: u16,
    tool_output_expanded: bool,
    render_markdown: bool,
    code_theme: &str,
    assistant_continuation: bool,
    assistant_continues_next: bool,
) -> u64 {
    let mut hasher = DefaultHasher::new();
    match message.role {
        MessageRole::User => 0u8,
        MessageRole::Assistant => 1,
        MessageRole::System => 2,
    }
    .hash(&mut hasher);
    message.text.hash(&mut hasher);
    width.hash(&mut hasher);
    tool_output_expanded.hash(&mut hasher);
    render_markdown.hash(&mut hasher);
    code_theme.hash(&mut hasher);
    assistant_continuation.hash(&mut hasher);
    assistant_continues_next.hash(&mut hasher);
    hasher.finish()
}

pub(super) fn assistant_message_is_continuation(messages: &[DisplayMessage], index: usize) -> bool {
    messages
        .get(index)
        .is_some_and(|message| message.role == MessageRole::Assistant)
        && index > 0
        && messages
            .get(index - 1)
            .is_some_and(|message| message.role == MessageRole::Assistant)
}

pub(super) fn assistant_message_continues_next(messages: &[DisplayMessage], index: usize) -> bool {
    messages
        .get(index)
        .is_some_and(|message| message.role == MessageRole::Assistant)
        && messages
            .get(index + 1)
            .is_some_and(|message| message.role == MessageRole::Assistant)
}

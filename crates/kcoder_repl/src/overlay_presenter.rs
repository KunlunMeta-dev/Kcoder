//! Pure overlay geometry, hit testing, and drawing.
//!
//! This module may borrow `ReplApp` read-only but does not own selection state, action creation, or overlay lifecycle.

use super::{
    Block, Borders, Color, ContextBreakdown, ContextInspector, Frame, KCODER_UI_THEME, KeyCode,
    Line, Modifier, Paragraph, PickerOverlay, Rect, ReplApp, ResumeSessionEntry,
    ResumeSessionPicker, SettingsInspector, Span, Style, Text, Widget, key_hint, line_truncation,
    shortcut_overlay_lines_with_mode_switch, slash, widgets,
};

pub(super) fn centered_rect(
    area: ratatui::layout::Rect,
    width: u16,
    height: u16,
) -> ratatui::layout::Rect {
    let x = area.x + (area.width.saturating_sub(width)) / 2;
    let y = area.y + (area.height.saturating_sub(height)) / 2;
    ratatui::layout::Rect::new(x, y, width.min(area.width), height.min(area.height))
}

#[derive(Debug, Clone, Copy)]
pub(super) struct OverlayListGeometry {
    pub(super) outer: Rect,
    pub(super) inner: Rect,
    pub(super) first_item_y: u16,
    pub(super) first_index: usize,
    pub(super) visible_items: usize,
}

pub(super) const SLASH_MENU_MAX_ITEMS: usize = 8;

pub(super) const FULLSCREEN_BOTTOM_SLACK_MIN_ROWS: u16 = 2;

pub(super) const FULLSCREEN_BOTTOM_SLACK_MAX_ROWS: u16 = SLASH_MENU_MAX_ITEMS as u16;

pub(super) const SLASH_MENU_MIN_WIDTH: u16 = 20;

pub(super) const SLASH_MENU_LEFT_INSET: u16 = 2;

pub(super) const PICKER_MAX_ITEMS: usize = 8;

pub(super) const PICKER_SURFACE_INSET_V: u16 = 1;

pub(super) const PICKER_SURFACE_INSET_H: u16 = 2;

pub(super) const PICKER_HEADER_LINES: u16 = 3;

pub(super) const PICKER_FOOTER_LINES: u16 = 2;

pub(super) const RESUME_SESSION_PICKER_HEADER_LINES: usize = 4;

pub(super) const RESUME_SESSION_PICKER_FOOTER_LINES: usize = 2;

pub(super) const CONTEXT_INSPECTOR_HEIGHT: u16 = 18;

pub(super) fn fullscreen_bottom_slack_rows(terminal_height: u16) -> u16 {
    if terminal_height < 12 {
        return 0;
    }
    (terminal_height / 5).clamp(
        FULLSCREEN_BOTTOM_SLACK_MIN_ROWS,
        FULLSCREEN_BOTTOM_SLACK_MAX_ROWS,
    )
}

pub(super) fn border_inner(area: Rect) -> Rect {
    Rect::new(
        area.x.saturating_add(1),
        area.y.saturating_add(1),
        area.width.saturating_sub(2),
        area.height.saturating_sub(2),
    )
}

pub(super) fn rect_contains(rect: Rect, column: u16, row: u16) -> bool {
    column >= rect.x
        && column < rect.x.saturating_add(rect.width)
        && row >= rect.y
        && row < rect.y.saturating_add(rect.height)
}

pub(super) fn slash_menu_geometry(
    overlay_area: Rect,
    matches_len: usize,
    selected: usize,
) -> Option<OverlayListGeometry> {
    if matches_len == 0 || overlay_area.is_empty() {
        return None;
    }
    let visible_items = matches_len
        .min(SLASH_MENU_MAX_ITEMS)
        .min(usize::from(overlay_area.height));
    if visible_items == 0 {
        return None;
    }
    let selected = selected.min(matches_len.saturating_sub(1));
    let first_index = selected.saturating_add(1).saturating_sub(visible_items);
    let outer = Rect::new(
        overlay_area.x,
        overlay_area.y,
        overlay_area
            .width
            .max(SLASH_MENU_MIN_WIDTH.min(overlay_area.width)),
        visible_items as u16,
    );
    let left_inset = SLASH_MENU_LEFT_INSET.min(outer.width);
    let inner = Rect::new(
        outer.x.saturating_add(left_inset),
        outer.y,
        outer.width.saturating_sub(left_inset),
        outer.height,
    );
    Some(OverlayListGeometry {
        outer,
        inner,
        first_item_y: inner.y,
        first_index,
        visible_items,
    })
}

pub(super) fn clear_overlay_band(
    frame: &mut Frame,
    host_area: Rect,
    overlay_area: Rect,
    bg: Color,
) {
    use ratatui::widgets::{Clear, Widget};

    let band = Rect::new(
        host_area.x,
        overlay_area.y,
        host_area.width,
        overlay_area.height,
    );
    Clear.render(band, frame.buffer_mut());
    widgets::clear_area(band, frame.buffer_mut(), bg);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SlashMenuMatchKind {
    Exact,
    Prefix,
    None,
}

pub(super) fn slash_menu_match_kind(
    cmd: &dyn slash::SlashCommand,
    query: &str,
) -> SlashMenuMatchKind {
    let mut saw_prefix = false;
    for candidate in std::iter::once(cmd.name()).chain(cmd.aliases().iter().copied()) {
        let candidate = candidate
            .strip_prefix('/')
            .unwrap_or(candidate)
            .to_lowercase();
        if candidate == query {
            return SlashMenuMatchKind::Exact;
        }
        if candidate.starts_with(query) {
            saw_prefix = true;
        }
    }
    if saw_prefix {
        SlashMenuMatchKind::Prefix
    } else {
        SlashMenuMatchKind::None
    }
}

pub(super) fn slash_menu_hit_index(
    overlay_area: Rect,
    matches_len: usize,
    selected: usize,
    column: u16,
    row: u16,
) -> Option<usize> {
    let geometry = slash_menu_geometry(overlay_area, matches_len, selected)?;
    if !rect_contains(geometry.inner, column, row) {
        return None;
    }
    let row_offset = row.saturating_sub(geometry.first_item_y) as usize;
    if row_offset < geometry.visible_items {
        Some(geometry.first_index + row_offset)
    } else {
        None
    }
}

pub(super) fn slash_menu_description_column(
    matches: &[&dyn slash::SlashCommand],
    width: u16,
) -> usize {
    let width = usize::from(width);
    if width <= 1 {
        return 0;
    }
    let max_desc_col = width.saturating_sub(1);
    let max_auto_desc_col = max_desc_col.min(((width * 7) / 10).max(1));
    let max_name_width = matches
        .iter()
        .map(|cmd| unicode_width::UnicodeWidthStr::width(cmd.name()))
        .max()
        .unwrap_or(0);

    max_name_width.saturating_add(2).min(max_auto_desc_col)
}

pub(super) fn slash_menu_row_line(
    command_name: &str,
    description: &str,
    selected: bool,
    desc_col: usize,
    width: u16,
) -> Line<'static> {
    let theme = &KCODER_UI_THEME;
    let selected_style = if selected {
        Style::default()
            .fg(theme.accent_primary)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default()
    };

    let mut spans = vec![Span::styled(command_name.to_string(), selected_style)];
    let name_width = unicode_width::UnicodeWidthStr::width(command_name);
    let description = description.trim();
    if !description.is_empty() {
        let gap = desc_col.saturating_sub(name_width);
        if gap > 0 {
            spans.push(Span::styled(" ".repeat(gap), selected_style));
        }
        let description_style = if selected {
            selected_style
        } else {
            Style::default().add_modifier(Modifier::DIM)
        };
        spans.push(Span::styled(description.to_string(), description_style));
    }

    line_truncation::truncate_line_with_ellipsis_if_overflow(Line::from(spans), usize::from(width))
}

pub(super) fn picker_overlay_geometry(
    area: Rect,
    matches_len: usize,
    selected: usize,
) -> OverlayListGeometry {
    let width = (area.width as f32 * 0.6).clamp(40.0, 70.0) as u16;
    picker_list_geometry(area, matches_len, selected, width, 1)
}

pub(super) fn picker_geometry_for(
    picker: &PickerOverlay,
    area: Rect,
    matches_len: usize,
    selected: usize,
) -> OverlayListGeometry {
    if picker.on_confirm == super::PickerAction::ViewAgent {
        picker_list_geometry(
            area,
            matches_len,
            selected,
            area.width.saturating_sub(4).clamp(1, 140),
            2,
        )
    } else {
        picker_overlay_geometry(area, matches_len, selected)
    }
}

fn picker_list_geometry(
    area: Rect,
    matches_len: usize,
    selected: usize,
    width: u16,
    item_height: u16,
) -> OverlayListGeometry {
    let fixed_rows = picker_overlay_fixed_rows();
    let max_visible_items = (area.height.saturating_sub(fixed_rows) / item_height).max(1) as usize;
    let visible_items = if matches_len == 0 {
        0
    } else {
        matches_len.min(PICKER_MAX_ITEMS).min(max_visible_items)
    };
    let list_rows = if matches_len == 0 {
        1
    } else {
        visible_items.max(1) * item_height as usize
    };
    let height = fixed_rows.saturating_add(list_rows as u16);
    let outer = centered_rect(area, width, height.min(area.height));
    let inner = Rect::new(
        outer.x.saturating_add(PICKER_SURFACE_INSET_H),
        outer.y.saturating_add(PICKER_SURFACE_INSET_V),
        outer
            .width
            .saturating_sub(PICKER_SURFACE_INSET_H.saturating_mul(2)),
        outer
            .height
            .saturating_sub(PICKER_SURFACE_INSET_V.saturating_mul(2)),
    );
    let selected = selected.min(matches_len.saturating_sub(1));
    let first_index = if visible_items == 0 {
        0
    } else {
        selected.saturating_add(1).saturating_sub(visible_items)
    };
    OverlayListGeometry {
        outer,
        inner,
        first_item_y: inner.y.saturating_add(PICKER_HEADER_LINES),
        first_index,
        visible_items,
    }
}

pub(super) fn picker_overlay_fixed_rows() -> u16 {
    PICKER_SURFACE_INSET_V
        .saturating_mul(2)
        .saturating_add(PICKER_HEADER_LINES)
        .saturating_add(PICKER_FOOTER_LINES)
}

pub(super) fn picker_overlay_natural_height(matches_len: usize) -> u16 {
    let list_rows = if matches_len == 0 {
        1
    } else {
        matches_len.clamp(1, PICKER_MAX_ITEMS)
    };
    picker_overlay_fixed_rows().saturating_add(list_rows as u16)
}

pub(super) fn picker_overlay_hit_index(
    area: Rect,
    matches_len: usize,
    selected: usize,
    column: u16,
    row: u16,
) -> Option<usize> {
    let geometry = picker_overlay_geometry(area, matches_len, selected);
    if !rect_contains(geometry.inner, column, row) {
        return None;
    }
    let row_offset = row.saturating_sub(geometry.first_item_y) as usize;
    (row_offset < geometry.visible_items).then_some(geometry.first_index + row_offset)
}

pub(super) fn picker_hit_index_for(
    picker: &PickerOverlay,
    area: Rect,
    matches_len: usize,
    column: u16,
    row: u16,
) -> Option<usize> {
    if picker.on_confirm != super::PickerAction::ViewAgent {
        return picker_overlay_hit_index(area, matches_len, picker.selected, column, row);
    }
    let geometry = picker_geometry_for(picker, area, matches_len, picker.selected);
    if !rect_contains(geometry.inner, column, row) || row < geometry.first_item_y {
        return None;
    }
    let offset = usize::from((row - geometry.first_item_y) / picker.item_height());
    (offset < geometry.visible_items).then_some(geometry.first_index + offset)
}

pub(super) fn picker_overlay_item_line(item: &str, is_selected: bool, width: u16) -> Line<'static> {
    let marker_style = if is_selected {
        Style::default()
            .fg(KCODER_UI_THEME.accent_primary)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(KCODER_UI_THEME.text_dim)
    };
    let item_style = if is_selected {
        Style::default()
            .fg(KCODER_UI_THEME.accent_primary)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(KCODER_UI_THEME.text_body)
    };
    let marker = if is_selected { "› " } else { "  " };
    line_truncation::truncate_line_with_ellipsis_if_overflow(
        Line::from(vec![
            Span::styled(marker.to_string(), marker_style),
            Span::styled(item.to_string(), item_style),
        ]),
        usize::from(width),
    )
}

pub(super) fn picker_overlay_search_line(filter: &str, width: u16) -> Line<'static> {
    let line = if filter.is_empty() {
        Line::from(Span::styled(
            "Type to search",
            Style::default().fg(KCODER_UI_THEME.text_muted),
        ))
    } else {
        Line::from(Span::styled(
            filter.to_string(),
            Style::default().fg(KCODER_UI_THEME.text_body),
        ))
    };
    line_truncation::truncate_line_with_ellipsis_if_overflow(line, usize::from(width))
}

pub(super) fn picker_overlay_footer_line() -> Line<'static> {
    Line::from(vec![
        Span::raw("Press "),
        key_hint::plain(KeyCode::Enter).into(),
        Span::raw(" to confirm or "),
        key_hint::plain(KeyCode::Esc).into(),
        Span::raw(" to go back"),
    ])
    .style(Style::default().fg(KCODER_UI_THEME.text_muted))
}

pub(super) fn picker_overlay_lines(
    picker: &PickerOverlay,
    matches: &[String],
    selected: usize,
    first_index: usize,
    visible_items: usize,
    width: u16,
) -> Vec<Line<'static>> {
    let mut lines: Vec<Line> = vec![
        line_truncation::truncate_line_with_ellipsis_if_overflow(
            Line::from(Span::styled(
                picker.title.to_string(),
                Style::default()
                    .fg(KCODER_UI_THEME.text_body)
                    .add_modifier(Modifier::BOLD),
            )),
            usize::from(width),
        ),
        Line::from(""),
        picker_overlay_search_line(&picker.filter, width),
    ];

    if matches.is_empty() {
        lines.push(
            Line::from(
                if picker.on_confirm == super::PickerAction::ViewAgent
                    && picker.all_items.is_empty()
                {
                    "No sub-agents in this session"
                } else {
                    "no matches"
                },
            )
            .style(
                Style::default()
                    .fg(KCODER_UI_THEME.text_muted)
                    .add_modifier(Modifier::ITALIC),
            ),
        );
    } else {
        for (i, item) in matches
            .iter()
            .skip(first_index)
            .take(visible_items)
            .enumerate()
        {
            let is_selected = first_index + i == selected;
            if picker.on_confirm == super::PickerAction::ViewAgent {
                let (identity, description) = item.split_once('\n').unwrap_or((item, ""));
                lines.push(picker_overlay_item_line(identity, is_selected, width));
                lines.push(line_truncation::truncate_line_with_ellipsis_if_overflow(
                    Line::from(format!("  {description}")).style(Style::default().fg(
                        if is_selected {
                            KCODER_UI_THEME.text_body
                        } else {
                            KCODER_UI_THEME.text_muted
                        },
                    )),
                    usize::from(width),
                ));
            } else {
                lines.push(picker_overlay_item_line(item, is_selected, width));
            }
        }
    }

    lines.push(Line::from(""));
    lines.push(line_truncation::truncate_line_with_ellipsis_if_overflow(
        picker_overlay_footer_line(),
        usize::from(width),
    ));
    lines
}

pub(super) fn resume_session_entry_matches(entry: &ResumeSessionEntry, filter: &str) -> bool {
    let filter = filter.trim();
    if filter.is_empty() {
        return true;
    }
    let filter = filter.to_lowercase();
    entry.session_id.to_lowercase().contains(&filter)
        || entry
            .path
            .to_string_lossy()
            .to_lowercase()
            .contains(&filter)
        || entry
            .preview
            .as_deref()
            .unwrap_or_default()
            .to_lowercase()
            .contains(&filter)
}

pub(super) fn resume_session_picker_matches(picker: &ResumeSessionPicker) -> Vec<usize> {
    picker
        .entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            resume_session_entry_matches(entry, &picker.filter).then_some(index)
        })
        .collect()
}

pub(super) fn resume_session_picker_visible_window(
    matches_len: usize,
    selected: usize,
    height: usize,
) -> (usize, usize) {
    let visible_items = height
        .saturating_sub(RESUME_SESSION_PICKER_HEADER_LINES + RESUME_SESSION_PICKER_FOOTER_LINES)
        .max(1)
        .min(matches_len.max(1));
    if matches_len == 0 {
        return (0, 0);
    }
    let selected = selected.min(matches_len.saturating_sub(1));
    let first = selected.saturating_add(1).saturating_sub(visible_items);
    (first, visible_items)
}

pub(super) fn resume_session_picker_search_line(filter: &str, width: u16) -> Line<'static> {
    let line = if filter.is_empty() {
        Line::from(Span::styled(
            "Type to search",
            Style::default().fg(KCODER_UI_THEME.text_muted),
        ))
    } else {
        Line::from(Span::styled(
            filter.to_string(),
            Style::default().fg(KCODER_UI_THEME.text_body),
        ))
    };
    line_truncation::truncate_line_with_ellipsis_if_overflow(line, usize::from(width.max(1)))
}

pub(super) fn resume_session_picker_entry_line(
    entry: &ResumeSessionEntry,
    is_selected: bool,
    width: u16,
) -> Line<'static> {
    let marker_style = if is_selected {
        Style::default()
            .fg(KCODER_UI_THEME.accent_primary)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(KCODER_UI_THEME.text_dim)
    };
    let id_style = if is_selected {
        Style::default()
            .fg(KCODER_UI_THEME.accent_primary)
            .bg(crate::theme::selection_surface_bg())
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(KCODER_UI_THEME.text_body)
    };
    let detail_style = if is_selected {
        Style::default()
            .fg(KCODER_UI_THEME.text_body)
            .bg(crate::theme::selection_surface_bg())
    } else {
        Style::default().fg(KCODER_UI_THEME.text_muted)
    };
    let marker = if is_selected { "› " } else { "  " };
    // Entry label: `<session-id>:<first user prompt>` — the prompt preview is
    // capped at 36 chars with a trailing ellipsis by session_first_prompt.
    let preview = entry.preview.as_deref().unwrap_or("");
    let line = Line::from(vec![
        Span::styled(marker.to_string(), marker_style),
        Span::styled(format!("{}:", entry.session_id), id_style),
        Span::styled(preview.to_string(), detail_style),
    ]);
    line_truncation::truncate_line_with_ellipsis_if_overflow(line, usize::from(width.max(1)))
}

pub(super) fn resume_session_picker_footer_lines(width: u16) -> [Line<'static>; 2] {
    let width = usize::from(width.max(1));
    [
        line_truncation::truncate_line_with_ellipsis_if_overflow(Line::from(""), width),
        line_truncation::truncate_line_with_ellipsis_if_overflow(
            Line::from(vec![
                key_hint::plain(KeyCode::Enter).into(),
                Span::raw(" resume   "),
                key_hint::plain(KeyCode::Esc).into(),
                Span::raw(" exit   ↑/↓ browse   type filter"),
            ])
            .style(Style::default().fg(KCODER_UI_THEME.text_muted)),
            width,
        ),
    ]
}

pub(super) fn resume_session_picker_lines(
    picker: &ResumeSessionPicker,
    width: u16,
    height: usize,
) -> Vec<Line<'static>> {
    let width_usize = usize::from(width.max(1));
    let mut lines = vec![
        line_truncation::truncate_line_with_ellipsis_if_overflow(
            Line::from(Span::styled(
                "Resume a previous session",
                Style::default()
                    .fg(KCODER_UI_THEME.success)
                    .add_modifier(Modifier::BOLD),
            )),
            width_usize,
        ),
        Line::from(""),
        resume_session_picker_search_line(&picker.filter, width),
        Line::from(""),
    ];
    let matches = resume_session_picker_matches(picker);
    let selected = picker.selected.min(matches.len().saturating_sub(1));
    let (first, visible_items) =
        resume_session_picker_visible_window(matches.len(), selected, height);
    if matches.is_empty() {
        lines.push(
            Line::from("No matching sessions").style(
                Style::default()
                    .fg(KCODER_UI_THEME.text_muted)
                    .add_modifier(Modifier::ITALIC),
            ),
        );
    } else {
        for (visible_index, entry_index) in matches
            .iter()
            .skip(first)
            .take(visible_items)
            .copied()
            .enumerate()
        {
            let is_selected = first + visible_index == selected;
            lines.push(resume_session_picker_entry_line(
                &picker.entries[entry_index],
                is_selected,
                width,
            ));
        }
    }

    let footer = resume_session_picker_footer_lines(width);
    if height > lines.len() + footer.len() {
        let spacer_rows = height - lines.len() - footer.len();
        for _ in 0..spacer_rows {
            lines.push(Line::from(""));
        }
    }
    lines.extend(footer);
    lines.truncate(height.max(1));
    lines
}

pub(super) fn resume_session_picker_hit_index(
    picker: &ResumeSessionPicker,
    height: usize,
    row_offset: usize,
) -> Option<usize> {
    let matches = resume_session_picker_matches(picker);
    if matches.is_empty() || row_offset < RESUME_SESSION_PICKER_HEADER_LINES {
        return None;
    }
    let selected = picker.selected.min(matches.len().saturating_sub(1));
    let (first, visible_items) =
        resume_session_picker_visible_window(matches.len(), selected, height);
    let item_offset = row_offset - RESUME_SESSION_PICKER_HEADER_LINES;
    if item_offset >= visible_items {
        return None;
    }
    matches.get(first + item_offset).copied()
}

pub(super) fn draw_slash_menu(
    frame: &mut Frame,
    app: &ReplApp,
    overlay_area: ratatui::layout::Rect,
) {
    use ratatui::widgets::{Clear, Widget};

    let Some(menu) = app.slash_menu.as_ref() else {
        return;
    };

    let matches = app.slash_menu_matches();
    if matches.is_empty() {
        return;
    }

    let area = frame.area();
    let selected = menu.selected.min(matches.len().saturating_sub(1));
    let Some(geometry) = slash_menu_geometry(overlay_area, matches.len(), selected) else {
        return;
    };
    let clear_area = Rect::new(area.x, overlay_area.y, area.width, overlay_area.height);
    Clear.render(clear_area, frame.buffer_mut());
    widgets::clear_area(clear_area, frame.buffer_mut(), KCODER_UI_THEME.panel_bg);

    let inner = geometry.inner;
    let desc_col = slash_menu_description_column(&matches, inner.width);
    let lines: Vec<Line> = matches
        .iter()
        .skip(geometry.first_index)
        .take(geometry.visible_items)
        .enumerate()
        .map(|(i, cmd)| {
            let is_selected = geometry.first_index + i == selected;
            slash_menu_row_line(
                cmd.name(),
                cmd.description(),
                is_selected,
                desc_col,
                inner.width,
            )
        })
        .collect();

    let paragraph =
        Paragraph::new(Text::from(lines)).style(Style::default().bg(KCODER_UI_THEME.panel_bg));
    frame.render_widget(paragraph, inner);
}

pub(super) fn draw_mention_menu(frame: &mut Frame, app: &ReplApp, overlay_area: Rect) {
    let Some(menu) = app.mention_menu.as_ref() else {
        return;
    };
    let visible = menu
        .candidates
        .len()
        .min(8)
        .min(usize::from(overlay_area.height));
    if visible == 0 {
        return;
    }
    let first = menu.selected.saturating_add(1).saturating_sub(visible);
    let lines = menu
        .candidates
        .iter()
        .enumerate()
        .skip(first)
        .take(visible)
        .map(|(index, path)| {
            let selected = index == menu.selected;
            Line::from(vec![
                Span::styled(
                    if selected { "› " } else { "  " },
                    Style::default().fg(KCODER_UI_THEME.accent_primary),
                ),
                Span::styled(
                    path.clone(),
                    if selected {
                        Style::default()
                            .fg(KCODER_UI_THEME.text_body)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(KCODER_UI_THEME.text_soft)
                    },
                ),
            ])
        })
        .collect::<Vec<_>>();
    let area = Rect::new(
        overlay_area.x,
        overlay_area.y,
        overlay_area.width,
        visible as u16,
    );
    ratatui::widgets::Clear.render(area, frame.buffer_mut());
    frame.render_widget(
        Paragraph::new(Text::from(lines)).style(Style::default().bg(KCODER_UI_THEME.panel_bg)),
        area,
    );
}

pub(super) fn draw_footer_shortcuts_overlay(
    frame: &mut Frame,
    app: &ReplApp,
    overlay_area: ratatui::layout::Rect,
) {
    use ratatui::widgets::{Clear, Widget};

    let lines = shortcut_overlay_lines_with_mode_switch(
        app.spinner.is_running(),
        app.plan_mode.is_some(),
        app.edit_previous_primed,
    );
    Clear.render(overlay_area, frame.buffer_mut());
    widgets::clear_area(overlay_area, frame.buffer_mut(), KCODER_UI_THEME.panel_bg);

    let inner = Rect::new(
        overlay_area.x.saturating_add(1),
        overlay_area.y,
        overlay_area.width.saturating_sub(2),
        overlay_area.height,
    );
    if inner.is_empty() {
        return;
    }
    let visible_lines = lines
        .into_iter()
        .take(usize::from(inner.height))
        .map(|line| {
            line_truncation::truncate_line_with_ellipsis_if_overflow(line, inner.width as usize)
        })
        .collect::<Vec<_>>();
    let paragraph = Paragraph::new(Text::from(visible_lines))
        .style(Style::default().bg(KCODER_UI_THEME.panel_bg));
    frame.render_widget(paragraph, inner);
}

pub(super) fn draw_context_inspector(frame: &mut Frame, inspector: &ContextInspector) {
    let area = frame.area();
    let width = (area.width as f32 * 0.75).clamp(50.0, 90.0) as u16;
    let height = CONTEXT_INSPECTOR_HEIGHT;
    let dialog_area = centered_rect(area, width, height);

    clear_overlay_band(frame, area, dialog_area, KCODER_UI_THEME.panel_bg);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(KCODER_UI_THEME.accent_primary))
        .title(Span::styled(
            " Context Inspector ",
            Style::default()
                .fg(KCODER_UI_THEME.accent_primary)
                .add_modifier(Modifier::BOLD),
        ));

    let inner = block.inner(dialog_area);
    frame.render_widget(block, dialog_area);

    let b = &inspector.breakdown;
    let free = b.message_budget.saturating_sub(b.messages_used);
    let tool_total = b.tool_use.saturating_add(b.tool_result);

    let mut lines: Vec<Line> = vec![
        Line::from(vec![Span::styled(
            "Budget allocation",
            Style::default()
                .fg(KCODER_UI_THEME.accent_primary)
                .add_modifier(Modifier::BOLD),
        )]),
        Line::from(vec![
            Span::styled(
                "Total window: ",
                Style::default().fg(KCODER_UI_THEME.text_muted),
            ),
            Span::styled(
                format!("{}", b.total_window),
                Style::default().fg(Color::White),
            ),
            Span::styled(
                "  System: ",
                Style::default().fg(KCODER_UI_THEME.text_muted),
            ),
            Span::styled(
                format!("{}", b.system),
                Style::default().fg(KCODER_UI_THEME.text_muted),
            ),
            Span::styled("  Tools: ", Style::default().fg(KCODER_UI_THEME.text_muted)),
            Span::styled(
                format!("{}", b.tools),
                Style::default().fg(KCODER_UI_THEME.accent_secondary),
            ),
            Span::styled(
                "  Output: ",
                Style::default().fg(KCODER_UI_THEME.text_muted),
            ),
            Span::styled(
                format!("{}", b.reserved_output),
                Style::default().fg(Color::Yellow),
            ),
        ]),
        Line::from(vec![
            Span::styled(
                "Messages: ",
                Style::default().fg(KCODER_UI_THEME.text_muted),
            ),
            Span::styled(
                format!("{} / {}", b.messages_used, b.message_budget),
                Style::default().fg(Color::White),
            ),
            Span::styled("  Free: ", Style::default().fg(KCODER_UI_THEME.text_muted)),
            Span::styled(format!("{}", free), Style::default().fg(Color::Green)),
        ]),
    ];

    let bar_width = inner.width.saturating_sub(2) as usize;
    lines.push(Line::from(render_context_bar(b, bar_width)));
    lines.push(Line::from(""));

    lines.push(Line::from(vec![Span::styled(
        "Message breakdown",
        Style::default()
            .fg(KCODER_UI_THEME.accent_primary)
            .add_modifier(Modifier::BOLD),
    )]));
    lines.push(Line::from(vec![
        Span::styled("User: ", Style::default().fg(KCODER_UI_THEME.text_muted)),
        Span::styled(format!("{}", b.user), Style::default().fg(Color::White)),
        Span::styled(
            "  Assistant: ",
            Style::default().fg(KCODER_UI_THEME.text_muted),
        ),
        Span::styled(
            format!("{}", b.assistant),
            Style::default().fg(Color::White),
        ),
        Span::styled(
            "  Tool use: ",
            Style::default().fg(KCODER_UI_THEME.text_muted),
        ),
        Span::styled(
            format!("{}", b.tool_use),
            Style::default().fg(Color::Yellow),
        ),
        Span::styled(
            "  Tool result: ",
            Style::default().fg(KCODER_UI_THEME.text_muted),
        ),
        Span::styled(
            format!("{}", b.tool_result),
            Style::default().fg(Color::Yellow),
        ),
    ]));
    lines.push(Line::from(vec![
        Span::styled(
            "Thinking: ",
            Style::default().fg(KCODER_UI_THEME.text_muted),
        ),
        Span::styled(format!("{}", b.thinking), Style::default().fg(Color::Cyan)),
        Span::styled(
            "  Tool traffic total: ",
            Style::default().fg(KCODER_UI_THEME.text_muted),
        ),
        Span::styled(format!("{}", tool_total), Style::default().fg(Color::White)),
    ]));
    lines.push(Line::from(""));
    lines.push(
        Line::from("Esc or q to close").style(Style::default().fg(KCODER_UI_THEME.text_muted)),
    );

    let paragraph =
        Paragraph::new(Text::from(lines)).style(Style::default().bg(KCODER_UI_THEME.panel_bg));
    frame.render_widget(paragraph, inner);
}

pub(super) fn render_context_bar(breakdown: &ContextBreakdown, width: usize) -> Vec<Span<'static>> {
    let total = breakdown.total_window.max(1);
    let categories: [(&str, usize, Color); 5] = [
        ("sys", breakdown.system, KCODER_UI_THEME.text_muted),
        ("tools", breakdown.tools, KCODER_UI_THEME.accent_secondary),
        ("out", breakdown.reserved_output, Color::Yellow),
        (
            "msg",
            breakdown.messages_used,
            KCODER_UI_THEME.accent_primary,
        ),
        (
            "free",
            breakdown
                .message_budget
                .saturating_sub(breakdown.messages_used),
            Color::DarkGray,
        ),
    ];

    let mut scaled: Vec<usize> = categories
        .iter()
        .map(|(_, v, _)| (*v as f64 / total as f64 * width as f64).round() as usize)
        .collect();
    // Ensure the bar exactly fills the available width.
    let sum: usize = scaled.iter().sum();
    if sum < width {
        if let Some(last) = scaled.iter_mut().rfind(|n| **n > 0) {
            *last += width - sum;
        }
    } else if sum > width
        && let Some(last) = scaled.iter_mut().rfind(|n| **n > 0)
    {
        *last = last.saturating_sub(sum - width);
    }

    let mut spans = Vec::new();
    for ((_, _, color), blocks) in categories.iter().zip(scaled.iter()) {
        if *blocks == 0 {
            continue;
        }
        spans.push(Span::styled(
            "█".repeat(*blocks),
            Style::default().fg(*color),
        ));
    }
    spans
}

pub(super) fn settings_inspector_natural_height(line_count: usize) -> u16 {
    (line_count.min(usize::from(u16::MAX.saturating_sub(6))) as u16).saturating_add(6)
}

pub(super) fn draw_settings_inspector(frame: &mut Frame, inspector: &SettingsInspector) {
    let area = frame.area();
    let width = (area.width as f32 * 0.7).clamp(50.0, 90.0) as u16;
    let height =
        settings_inspector_natural_height(inspector.lines.len()).min(area.height.saturating_sub(4));
    let dialog_area = centered_rect(area, width, height);

    clear_overlay_band(frame, area, dialog_area, KCODER_UI_THEME.panel_bg);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(KCODER_UI_THEME.accent_primary))
        .title(Span::styled(
            " Settings ",
            Style::default()
                .fg(KCODER_UI_THEME.accent_primary)
                .add_modifier(Modifier::BOLD),
        ));

    let inner = block.inner(dialog_area);
    frame.render_widget(block, dialog_area);

    let mut lines: Vec<Line> = inspector
        .lines
        .iter()
        .map(|l| Line::from(Span::styled(l.clone(), Style::default().fg(Color::White))))
        .collect();
    lines.push(Line::from(""));
    lines.push(
        Line::from("Use /set <key> <value> to change a setting. Esc or q to close.")
            .style(Style::default().fg(KCODER_UI_THEME.text_muted)),
    );

    let paragraph =
        Paragraph::new(Text::from(lines)).style(Style::default().bg(KCODER_UI_THEME.panel_bg));
    frame.render_widget(paragraph, inner);
}

pub(super) fn draw_keys_overlay(frame: &mut Frame, mode_switch_enabled: bool) {
    let area = frame.area();
    let lines = widgets::shortcut_overlay_lines_with_mode_switch(false, mode_switch_enabled, false);
    if area.is_empty() || lines.is_empty() {
        return;
    }

    let content_width = lines
        .iter()
        .map(line_truncation::line_width)
        .max()
        .unwrap_or(0);
    let width = (content_width as u16)
        .saturating_add(4)
        .min(area.width.saturating_sub(4).max(1))
        .max(48.min(area.width));
    let height = (lines.len() as u16)
        .saturating_add(2)
        .min(area.height.saturating_sub(4).max(1));
    let overlay_area = centered_rect(area, width, height);

    clear_overlay_band(frame, area, overlay_area, crate::theme::user_surface_bg());

    let inner = Rect::new(
        overlay_area.x.saturating_add(2),
        overlay_area.y.saturating_add(1),
        overlay_area.width.saturating_sub(4),
        overlay_area.height.saturating_sub(2),
    );
    let lines = lines
        .into_iter()
        .take(usize::from(inner.height))
        .map(|line| {
            line_truncation::truncate_line_with_ellipsis_if_overflow(line, inner.width as usize)
        })
        .collect::<Vec<_>>();
    let paragraph = Paragraph::new(Text::from(lines)).style(crate::theme::user_surface_style());
    frame.render_widget(paragraph, inner);
}

pub(super) fn draw_picker_overlay(frame: &mut Frame, picker: &PickerOverlay) {
    let area = frame.area();
    let matches = picker.matches();
    let selected = picker.selected.min(matches.len().saturating_sub(1));
    let geometry = picker_geometry_for(picker, area, matches.len(), selected);
    let dialog_area = geometry.outer;

    clear_overlay_band(frame, area, dialog_area, crate::theme::user_surface_bg());

    let inner = geometry.inner;
    let lines = picker_overlay_lines(
        picker,
        &matches,
        selected,
        geometry.first_index,
        geometry.visible_items,
        inner.width,
    );

    let paragraph = Paragraph::new(Text::from(lines)).style(crate::theme::user_surface_style());
    frame.render_widget(paragraph, inner);
}

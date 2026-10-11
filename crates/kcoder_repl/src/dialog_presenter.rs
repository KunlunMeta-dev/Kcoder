use super::composer_navigation::byte_index_for_grapheme;
use super::markdown::render_markdown_with_theme;
use super::message_render::truncate_display_text;
use super::overlay_presenter::{
    PICKER_SURFACE_INSET_H, PICKER_SURFACE_INSET_V, border_inner, centered_rect,
    clear_overlay_band, rect_contains,
};
use super::theme::KCODER_UI_THEME;
use super::tool_transcript::{
    ToolFamily, shell_tool_highlight_lang, tool_family_for_name, tool_preview_spans,
};
use super::{
    Frame, GoalReplacementDialog, PermissionDialog, PermissionEditor,
    QUESTION_DIALOG_DEFAULT_VISIBLE_OPTIONS, QuestionDialog, QuestionDialogState,
    SideQuestionOverlay, SideQuestionStatus, key_hint, line_truncation, render, text_formatting,
};
use crossterm::event::KeyCode;
use kcoder_tools::UserQuestionRequest;
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph, Wrap},
};

pub(super) fn permission_editor_cursor_position(
    text: &str,
    cursor_grapheme_index: usize,
) -> (usize, u16) {
    let cursor_byte = byte_index_for_grapheme(text, cursor_grapheme_index);
    let before = &text[..cursor_byte];
    let cursor_line = before.chars().filter(|ch| *ch == '\n').count();
    let current_line = before.rsplit('\n').next().unwrap_or("");
    let cursor_col = unicode_width::UnicodeWidthStr::width(current_line).min(u16::MAX as usize);
    (cursor_line, cursor_col as u16)
}

pub(super) const PERMISSION_OPTION_LABELS: [&str; 7] = [
    "Yes, proceed",
    "Yes, and don't ask again",
    "Yes, and allow for this session",
    "No, continue without it",
    "No, and don't ask again",
    "No, and deny for this session",
    "Edit input before deciding",
];
const PERMISSION_OPTION_SHORTCUTS: [&str; 7] = ["y", "a", "s", "n/d", "5", "6", "e"];

pub(super) fn dialog_host_area_for_todo(area: Rect, todo_height: u16) -> Rect {
    if todo_height == 0 {
        return area;
    }
    let reserved = todo_height.min(area.height.saturating_sub(7));
    Rect::new(
        area.x,
        area.y,
        area.width,
        area.height.saturating_sub(reserved),
    )
}

#[derive(Debug, Clone, Copy)]
pub(super) struct PermissionDialogGeometry {
    pub(super) outer: Rect,
    pub(super) inner: Rect,
    option_y: u16,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct QuestionDialogGeometry {
    pub(super) outer: Rect,
    pub(super) inner: Rect,
    pub(super) option_start_y: u16,
    pub(super) first_option: usize,
    pub(super) visible_options: usize,
    pub(super) option_rows: usize,
    pub(super) footer_lines: usize,
}

pub(super) struct QuestionDialogRender {
    pub(super) lines: Vec<Line<'static>>,
    pub(super) option_start: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct QuestionDialogFooterTip {
    pub(super) text: String,
    pub(super) highlight: bool,
}

impl QuestionDialogFooterTip {
    fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            highlight: false,
        }
    }

    fn highlighted(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            highlight: true,
        }
    }
}

pub(super) const QUESTION_DIALOG_FOOTER_SEPARATOR: &str = " | ";
const QUESTION_DIALOG_FOOTER_SPACER_LINES: usize = 1;
pub(super) const QUESTION_DIALOG_OTHER_OPTION_LABEL: &str = "None of the above";
const QUESTION_DIALOG_OTHER_OPTION_DESCRIPTION: &str =
    "Optionally, describe the better answer in your next message.";
fn permission_detail_line_count(dialog: &PermissionDialog) -> usize {
    if dialog.detail_lines.is_empty() {
        return 1;
    }
    dialog
        .detail_lines
        .iter()
        .map(|line| line.lines().count())
        .sum()
}

fn permission_description_extra_lines(dialog: &PermissionDialog) -> u16 {
    if dialog.description.is_empty() { 0 } else { 2 }
}

pub(super) fn permission_dialog_natural_height(dialog: &PermissionDialog) -> u16 {
    let detail_line_count = permission_detail_line_count(dialog) as u16;
    let description_extra = permission_description_extra_lines(dialog);
    detail_line_count
        .saturating_add(description_extra)
        .saturating_add(14)
        .max(12)
}

fn overlay_height_for_area(content_height: u16, min_height: u16, area: Rect) -> u16 {
    let max_height = area.height.saturating_sub(4).max(1);
    let min_height = min_height.min(max_height);
    content_height.clamp(min_height, max_height)
}

pub(super) fn permission_dialog_geometry(
    area: Rect,
    dialog: &PermissionDialog,
) -> PermissionDialogGeometry {
    let width = (area.width as f32 * 0.7).clamp(40.0, 80.0) as u16;
    let detail_line_count = permission_detail_line_count(dialog) as u16;
    let description_extra = permission_description_extra_lines(dialog);
    let content_height = permission_dialog_natural_height(dialog);
    let height = overlay_height_for_area(content_height, 12, area);
    let outer = centered_rect(area, width, height);
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
    PermissionDialogGeometry {
        outer,
        inner,
        option_y: inner
            .y
            .saturating_add(3)
            .saturating_add(description_extra)
            .saturating_add(detail_line_count),
    }
}

fn question_dialog_width(area: Rect) -> u16 {
    (area.width as f32 * 0.7).clamp(40.0, 80.0) as u16
}

pub(super) fn question_dialog_natural_height(terminal_width: u16, dialog: &QuestionDialog) -> u16 {
    let width = (terminal_width as f32 * 0.7).clamp(40.0, 80.0) as u16;
    let inner_width = width.saturating_sub(2).max(1);
    let question = &dialog.request.questions[dialog.focused];
    let option_start = question_dialog_option_start(question, inner_width);
    let footer_lines = question_dialog_footer_reserved_lines(dialog, usize::from(inner_width));
    let total_option_rows = question_option_total_rows(question, usize::from(inner_width));
    let content_lines = option_start
        .saturating_add(total_option_rows)
        .saturating_add(footer_lines)
        .min(usize::from(u16::MAX.saturating_sub(2))) as u16;
    content_lines.saturating_add(2).max(7)
}

pub(super) fn question_dialog_geometry(
    area: Rect,
    dialog: &QuestionDialog,
) -> QuestionDialogGeometry {
    let width = question_dialog_width(area);
    let inner_width = width.saturating_sub(2).max(1);
    let question = &dialog.request.questions[dialog.focused];
    let option_start = question_dialog_option_start(question, inner_width);
    let footer_lines = question_dialog_footer_reserved_lines(dialog, usize::from(inner_width));
    let total_option_rows = question_option_total_rows(question, usize::from(inner_width));
    let content_lines = option_start
        .saturating_add(total_option_rows)
        .saturating_add(footer_lines);
    let content_height = content_lines.min(usize::from(u16::MAX.saturating_sub(2))) as u16 + 2;
    let height = overlay_height_for_area(content_height, 7, area);
    let outer = centered_rect(area, width, height);
    let inner = border_inner(outer);
    let option_rows = question_dialog_option_rows(inner.height, option_start, footer_lines);
    let first_option = question_effective_scroll_top(
        question,
        usize::from(inner_width),
        dialog.cursor,
        dialog.scroll_top,
        option_rows,
    );
    let visible_options = question_dialog_visible_options(
        question,
        usize::from(inner_width),
        option_rows,
        first_option,
    );
    QuestionDialogGeometry {
        outer,
        inner,
        option_start_y: inner.y.saturating_add(option_start as u16),
        first_option,
        visible_options,
        option_rows,
        footer_lines,
    }
}

#[cfg(test)]
pub(super) fn question_dialog_render(dialog: &QuestionDialog, width: u16) -> QuestionDialogRender {
    let question = &dialog.request.questions[dialog.focused];
    let footer_lines = question_dialog_footer_reserved_lines(dialog, usize::from(width.max(1)));
    question_dialog_render_window(
        dialog,
        width,
        0,
        question_dialog_option_count(question),
        usize::MAX,
        footer_lines,
    )
}

pub(super) fn question_dialog_render_window(
    dialog: &QuestionDialog,
    width: u16,
    first_option: usize,
    visible_options: usize,
    option_rows: usize,
    footer_lines: usize,
) -> QuestionDialogRender {
    let question = &dialog.request.questions[dialog.focused];
    let width = usize::from(width.max(1));
    let mut lines = Vec::new();

    let progress = format!(
        "Question {}/{}",
        dialog.focused + 1,
        dialog.request.questions.len()
    );
    let mode = if question.multi_select {
        "multi-select"
    } else {
        "single choice"
    };
    lines.push(Line::from(vec![
        Span::styled(progress, Style::default().fg(KCODER_UI_THEME.text_dim)),
        Span::styled(" · ", Style::default().fg(KCODER_UI_THEME.text_dim)),
        Span::styled(mode, Style::default().fg(KCODER_UI_THEME.text_dim)),
    ]));
    push_question_prompt_lines(&mut lines, question, width);
    lines.push(Line::from(""));
    let option_start = lines.len();

    let option_count = question_dialog_option_count(question);
    let cursor = dialog.cursor.min(option_count.saturating_sub(1));
    let first_option =
        question_effective_scroll_top(question, width, cursor, first_option, option_rows);
    let visible_options = visible_options.min(option_count.saturating_sub(first_option));
    let mut used_option_rows = 0usize;
    for index in first_option..first_option.saturating_add(visible_options) {
        let option_lines = question_option_lines(question, index, cursor, &dialog.selected, width);
        for line in option_lines {
            if used_option_rows >= option_rows {
                break;
            }
            lines.push(line);
            used_option_rows = used_option_rows.saturating_add(1);
        }
        if used_option_rows >= option_rows {
            break;
        }
    }

    let has_hidden_above = first_option > 0;
    let has_hidden_below = first_option.saturating_add(visible_options) < option_count;
    lines.push(Line::from(""));
    let footer_tip_rows = footer_lines.saturating_sub(QUESTION_DIALOG_FOOTER_SPACER_LINES);
    for line in question_dialog_footer_lines(dialog, width, has_hidden_above, has_hidden_below)
        .into_iter()
        .take(footer_tip_rows)
    {
        lines.push(line);
    }

    QuestionDialogRender {
        lines,
        option_start,
    }
}

fn question_dialog_has_other_option(question: &kcoder_tools::Question) -> bool {
    !question.multi_select
        && !question.options.is_empty()
        && !question.options.iter().any(|option| {
            option
                .label
                .trim()
                .eq_ignore_ascii_case(QUESTION_DIALOG_OTHER_OPTION_LABEL)
        })
}

pub(super) fn question_dialog_option_count(question: &kcoder_tools::Question) -> usize {
    question
        .options
        .len()
        .saturating_add(usize::from(question_dialog_has_other_option(question)))
}

fn question_dialog_option_label(question: &kcoder_tools::Question, index: usize) -> Option<String> {
    if let Some(option) = question.options.get(index) {
        return Some(option.label.clone());
    }
    (index == question.options.len() && question_dialog_has_other_option(question))
        .then(|| QUESTION_DIALOG_OTHER_OPTION_LABEL.to_string())
}

fn question_dialog_option_description(
    question: &kcoder_tools::Question,
    index: usize,
) -> Option<String> {
    if let Some(option) = question.options.get(index) {
        return Some(option.description.clone());
    }
    (index == question.options.len() && question_dialog_has_other_option(question))
        .then(|| QUESTION_DIALOG_OTHER_OPTION_DESCRIPTION.to_string())
}

fn question_dialog_initial_state(
    question: &kcoder_tools::Question,
    answer: Option<&String>,
) -> QuestionDialogState {
    let option_count = question_dialog_option_count(question);
    if option_count == 0 {
        QuestionDialogState::default()
    } else {
        let mut selected = Vec::new();
        if let Some(answer) = answer {
            if question.multi_select {
                let labels = answer.split(", ").collect::<Vec<_>>();
                selected.extend((0..option_count).filter_map(|index| {
                    let option_label = question_dialog_option_label(question, index)?;
                    labels.contains(&option_label.as_str()).then_some(index)
                }));
            } else if let Some(index) = (0..option_count).position(|index| {
                question_dialog_option_label(question, index)
                    .is_some_and(|label| label.as_str() == answer.as_str())
            }) {
                selected.push(index);
            }
        }
        if selected.is_empty() {
            selected.push(0);
        }
        QuestionDialogState {
            cursor: selected[0],
            selected,
            scroll_top: 0,
        }
    }
}

pub(super) fn question_dialog_initial_states(
    request: &UserQuestionRequest,
) -> Vec<QuestionDialogState> {
    request
        .questions
        .iter()
        .map(|question| {
            question_dialog_initial_state(question, request.answers.get(&question.question))
        })
        .collect()
}

fn question_option_total_rows(question: &kcoder_tools::Question, width: usize) -> usize {
    (0..question_dialog_option_count(question))
        .map(|index| question_option_height(question, index, width))
        .sum()
}

pub(super) fn question_option_height(
    question: &kcoder_tools::Question,
    index: usize,
    width: usize,
) -> usize {
    question_option_lines(question, index, usize::MAX, &[], width)
        .len()
        .max(1)
}

fn question_option_lines(
    question: &kcoder_tools::Question,
    index: usize,
    cursor: usize,
    selected: &[usize],
    width: usize,
) -> Vec<Line<'static>> {
    let Some(label) = question_dialog_option_label(question, index) else {
        return Vec::new();
    };
    let description = question_dialog_option_description(question, index).unwrap_or_default();
    let width = width.max(1);
    let focused = index == cursor;
    let is_selected = selected.contains(&index);
    let marker = if question.multi_select {
        if is_selected { "[x]" } else { "[ ]" }
    } else if is_selected {
        "●"
    } else {
        "○"
    };
    let prefix = if focused { "› " } else { "  " };
    let label_style = if is_selected || focused {
        Style::default()
            .fg(KCODER_UI_THEME.accent_primary)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(KCODER_UI_THEME.text_body)
    };
    let description_style = if focused {
        Style::default().fg(KCODER_UI_THEME.text_soft)
    } else {
        Style::default().fg(KCODER_UI_THEME.text_dim)
    };
    let mut line = Line::from(vec![
        Span::styled(prefix, Style::default().fg(KCODER_UI_THEME.text_dim)),
        Span::styled(format!("{marker} "), label_style),
        Span::styled(label, label_style),
    ]);

    let description = description.trim();
    if description.is_empty() {
        return vec![line];
    }

    line.spans.push(Span::styled(" - ", description_style));
    let description_indent = line_truncation::line_width(&line).min(width.saturating_sub(1));
    let first_width = width
        .saturating_sub(line_truncation::line_width(&line))
        .max(1);
    let continuation_width = width.saturating_sub(description_indent).max(1);
    let wrapped_description =
        render::wrapping::adaptive_word_wrap_plain_line(description, first_width);
    let mut description_parts = Vec::new();
    for (idx, part) in wrapped_description.into_iter().enumerate() {
        if idx == 0 {
            description_parts.push(part);
        } else {
            description_parts.extend(render::wrapping::adaptive_word_wrap_plain_line(
                &part,
                continuation_width,
            ));
        }
    }
    let first = description_parts.first().cloned().unwrap_or_default();
    line.spans.push(Span::styled(first, description_style));
    let mut lines = vec![line];
    for continuation in description_parts.into_iter().skip(1) {
        lines.push(Line::from(vec![
            Span::raw(" ".repeat(description_indent)),
            Span::styled(continuation, description_style),
        ]));
    }
    lines
}

fn question_dialog_option_start(question: &kcoder_tools::Question, width: u16) -> usize {
    1usize
        .saturating_add(question_prompt_line_count(
            question,
            usize::from(width.max(1)),
        ))
        .saturating_add(1)
}

fn question_prompt_line_count(question: &kcoder_tools::Question, width: usize) -> usize {
    let header = format!("[{}] ", question.header);
    let header_width = unicode_width::UnicodeWidthStr::width(header.as_str());
    let question_width = width.saturating_sub(header_width).max(1);
    render::wrapping::adaptive_word_wrap_plain_line(question.question.trim(), question_width)
        .len()
        .max(1)
}

fn question_dialog_visible_options(
    question: &kcoder_tools::Question,
    width: usize,
    option_rows: usize,
    first_option: usize,
) -> usize {
    let option_count = question_dialog_option_count(question);
    if option_count == 0 {
        return 0;
    }
    if option_rows == 0 || first_option >= option_count {
        return 0;
    }

    let mut used_rows = 0usize;
    let mut visible = 0usize;
    for index in first_option..option_count {
        let height = question_option_height(question, index, width);
        if visible > 0 && used_rows.saturating_add(height) > option_rows {
            break;
        }
        visible = visible.saturating_add(1);
        used_rows = used_rows.saturating_add(height);
        if used_rows >= option_rows {
            break;
        }
    }
    visible
}

fn question_effective_scroll_top(
    question: &kcoder_tools::Question,
    width: usize,
    cursor: usize,
    scroll_top: usize,
    option_rows: usize,
) -> usize {
    let option_count = question_dialog_option_count(question);
    if option_count == 0 || option_rows == 0 {
        return 0;
    }
    let cursor = cursor.min(option_count - 1);
    let mut top = scroll_top.min(cursor);
    if cursor < top {
        return cursor;
    }
    while top < cursor
        && !question_option_visible_from_top(question, width, top, cursor, option_rows)
    {
        top = top.saturating_add(1);
    }
    if question_option_visible_from_top(question, width, top, cursor, option_rows) {
        top
    } else {
        cursor
    }
}

pub(super) fn question_option_visible_from_top(
    question: &kcoder_tools::Question,
    width: usize,
    top: usize,
    cursor: usize,
    option_rows: usize,
) -> bool {
    let option_count = question_dialog_option_count(question);
    if cursor < top || top >= option_count || option_rows == 0 {
        return false;
    }
    let mut used_rows = 0usize;
    for index in top..=cursor.min(option_count.saturating_sub(1)) {
        let height = question_option_height(question, index, width);
        used_rows = used_rows.saturating_add(height);
        if used_rows > option_rows {
            return top == cursor;
        }
    }
    true
}

fn question_dialog_option_rows(
    inner_height: u16,
    option_start: usize,
    footer_lines: usize,
) -> usize {
    usize::from(inner_height).saturating_sub(option_start.saturating_add(footer_lines))
}

fn question_dialog_footer_reserved_lines(dialog: &QuestionDialog, width: usize) -> usize {
    QUESTION_DIALOG_FOOTER_SPACER_LINES
        .saturating_add(question_dialog_footer_tip_lines(dialog, width, false, false).len())
}

fn question_dialog_footer_tips(
    dialog: &QuestionDialog,
    has_hidden_above: bool,
    has_hidden_below: bool,
) -> Vec<QuestionDialogFooterTip> {
    let question = &dialog.request.questions[dialog.focused];
    let question_count = dialog.request.questions.len();
    let is_last_question = dialog.focused.saturating_add(1) >= question_count;
    let mut tips = Vec::new();

    if has_hidden_above || has_hidden_below {
        let tip = match (has_hidden_above, has_hidden_below) {
            (true, true) => "↑/↓ more options",
            (true, false) => "↑ more options",
            (false, true) => "↓ more options",
            (false, false) => "",
        };
        if !tip.is_empty() {
            tips.push(QuestionDialogFooterTip::new(tip));
        }
    }

    tips.push(QuestionDialogFooterTip::new("↑/↓ to move"));
    if question.multi_select {
        tips.push(QuestionDialogFooterTip::new("space to toggle"));
    }

    let submit_tip = if question_count == 1 {
        "enter to submit answer"
    } else if is_last_question {
        "enter to submit all"
    } else {
        "enter to submit answer"
    };
    tips.push(QuestionDialogFooterTip::highlighted(submit_tip));

    if question_count > 1 {
        tips.push(QuestionDialogFooterTip::new("←/→ to navigate questions"));
    }
    tips.push(QuestionDialogFooterTip::new("esc to cancel"));

    tips
}

pub(super) fn question_dialog_footer_tip_lines(
    dialog: &QuestionDialog,
    width: usize,
    has_hidden_above: bool,
    has_hidden_below: bool,
) -> Vec<Vec<QuestionDialogFooterTip>> {
    let max_width = width.max(1);
    let separator_width = unicode_width::UnicodeWidthStr::width(QUESTION_DIALOG_FOOTER_SEPARATOR);
    let tips = question_dialog_footer_tips(dialog, has_hidden_above, has_hidden_below);
    if tips.is_empty() {
        return vec![Vec::new()];
    }

    let mut lines = Vec::new();
    let mut current = Vec::new();
    let mut used = 0usize;

    for tip in tips {
        let tip_width = unicode_width::UnicodeWidthStr::width(tip.text.as_str()).min(max_width);
        let extra = if current.is_empty() {
            tip_width
        } else {
            separator_width.saturating_add(tip_width)
        };
        if !current.is_empty() && used.saturating_add(extra) > max_width {
            lines.push(current);
            current = Vec::new();
            used = 0;
        }
        used = if current.is_empty() {
            tip_width
        } else {
            used.saturating_add(separator_width)
                .saturating_add(tip_width)
        };
        current.push(tip);
    }

    if current.is_empty() {
        lines.push(Vec::new());
    } else {
        lines.push(current);
    }
    lines
}

fn question_dialog_footer_lines(
    dialog: &QuestionDialog,
    width: usize,
    has_hidden_above: bool,
    has_hidden_below: bool,
) -> Vec<Line<'static>> {
    question_dialog_footer_tip_lines(dialog, width, has_hidden_above, has_hidden_below)
        .into_iter()
        .map(|tips| {
            let mut spans = Vec::new();
            for (index, tip) in tips.into_iter().enumerate() {
                if index > 0 {
                    spans.push(Span::styled(
                        QUESTION_DIALOG_FOOTER_SEPARATOR,
                        Style::default().fg(KCODER_UI_THEME.text_dim),
                    ));
                }
                let style = if tip.highlight {
                    Style::default()
                        .fg(KCODER_UI_THEME.accent_primary)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(KCODER_UI_THEME.text_dim)
                };
                spans.push(Span::styled(tip.text, style));
            }
            line_truncation::truncate_line_with_ellipsis_if_overflow(Line::from(spans), width)
        })
        .collect()
}

pub(super) fn question_dialog_visible_options_for_area(
    dialog: &QuestionDialog,
    area: Option<Rect>,
) -> usize {
    let option_count = dialog
        .request
        .questions
        .get(dialog.focused)
        .map(question_dialog_option_count)
        .unwrap_or(0);
    if option_count == 0 {
        return 0;
    }
    area.map(|area| question_dialog_geometry(area, dialog).visible_options)
        .unwrap_or_else(|| option_count.min(QUESTION_DIALOG_DEFAULT_VISIBLE_OPTIONS))
        .clamp(1, option_count)
}

fn sync_question_dialog_scroll(dialog: &mut QuestionDialog, area: Option<Rect>) {
    let Some(question) = dialog.request.questions.get(dialog.focused) else {
        return;
    };
    let option_rows = area
        .map(|area| question_dialog_geometry(area, dialog).option_rows)
        .unwrap_or(QUESTION_DIALOG_DEFAULT_VISIBLE_OPTIONS);
    dialog.scroll_top = question_effective_scroll_top(
        question,
        area.map(question_dialog_width)
            .map(|width| usize::from(width.saturating_sub(2).max(1)))
            .unwrap_or(usize::MAX),
        dialog.cursor,
        dialog.scroll_top,
        option_rows,
    );
}

fn question_dialog_current_answer(dialog: &QuestionDialog) -> Option<(String, String)> {
    let question = dialog.request.questions.get(dialog.focused)?;
    let answer = dialog
        .selected
        .iter()
        .filter_map(|&index| question_dialog_option_label(question, index))
        .collect::<Vec<_>>()
        .join(", ");
    Some((question.question.clone(), answer))
}

pub(super) fn question_dialog_commit_current_answer(dialog: &mut QuestionDialog) {
    if let Some((question, answer)) = question_dialog_current_answer(dialog) {
        dialog.request.answers.insert(question, answer);
    }
}

pub(super) fn question_dialog_clear_current_answer(dialog: &mut QuestionDialog) {
    let Some(question) = dialog.request.questions.get(dialog.focused) else {
        return;
    };
    dialog.request.answers.remove(&question.question);
}

fn question_dialog_ensure_states(dialog: &mut QuestionDialog) {
    let current_len = dialog.states.len();
    let question_len = dialog.request.questions.len();
    if current_len < question_len {
        let additional = dialog.request.questions[current_len..]
            .iter()
            .map(|question| {
                question_dialog_initial_state(
                    question,
                    dialog.request.answers.get(&question.question),
                )
            })
            .collect::<Vec<_>>();
        dialog.states.extend(additional);
    } else if current_len > question_len {
        dialog.states.truncate(question_len);
    }
}

pub(super) fn question_dialog_save_current_state(dialog: &mut QuestionDialog) {
    question_dialog_ensure_states(dialog);
    if let Some(state) = dialog.states.get_mut(dialog.focused) {
        state.selected = dialog.selected.clone();
        state.cursor = dialog.cursor;
        state.scroll_top = dialog.scroll_top;
    }
}

pub(super) fn question_dialog_restore_focused_state(
    dialog: &mut QuestionDialog,
    area: Option<Rect>,
) {
    question_dialog_ensure_states(dialog);
    let Some(state) = dialog.states.get(dialog.focused).cloned() else {
        dialog.selected.clear();
        dialog.cursor = 0;
        dialog.scroll_top = 0;
        return;
    };
    dialog.selected = state.selected;
    dialog.cursor = state.cursor;
    dialog.scroll_top = state.scroll_top;
    let Some(question) = dialog.request.questions.get(dialog.focused) else {
        return;
    };
    let option_count = question_dialog_option_count(question);
    if option_count == 0 {
        dialog.selected.clear();
        dialog.cursor = 0;
        dialog.scroll_top = 0;
        return;
    }
    dialog.cursor = dialog.cursor.min(option_count.saturating_sub(1));
    dialog.selected.retain(|&index| index < option_count);
    if dialog.selected.is_empty() {
        dialog.selected.push(dialog.cursor);
    }
    sync_question_dialog_scroll(dialog, area);
    question_dialog_save_current_state(dialog);
}

pub(super) fn question_dialog_set_focus(
    dialog: &mut QuestionDialog,
    next: usize,
    area: Option<Rect>,
) {
    if next >= dialog.request.questions.len() || next == dialog.focused {
        return;
    }
    question_dialog_save_current_state(dialog);
    dialog.focused = next;
    question_dialog_restore_focused_state(dialog, area);
}

pub(super) fn set_question_dialog_cursor(
    dialog: &mut QuestionDialog,
    cursor: usize,
    area: Option<Rect>,
    sync_single_selection: bool,
) {
    let Some(question) = dialog.request.questions.get(dialog.focused) else {
        return;
    };
    let option_count = question_dialog_option_count(question);
    if option_count == 0 {
        dialog.cursor = 0;
        dialog.scroll_top = 0;
        dialog.selected.clear();
        return;
    }
    let multi_select = question.multi_select;
    let old_selected = dialog.selected.clone();
    dialog.cursor = cursor.min(option_count - 1);
    if sync_single_selection && !multi_select {
        dialog.selected = vec![dialog.cursor];
    }
    if dialog.selected != old_selected {
        question_dialog_clear_current_answer(dialog);
    }
    sync_question_dialog_scroll(dialog, area);
    question_dialog_save_current_state(dialog);
}

pub(super) fn move_question_dialog_cursor_by(
    dialog: &mut QuestionDialog,
    delta: isize,
    area: Option<Rect>,
    wrap: bool,
) {
    let option_count = dialog
        .request
        .questions
        .get(dialog.focused)
        .map(question_dialog_option_count)
        .unwrap_or(0);
    if option_count == 0 {
        return;
    }
    let current = dialog.cursor.min(option_count - 1);
    let next = if delta < 0 {
        let step = delta.unsigned_abs();
        if wrap && step == 1 && current == 0 {
            option_count - 1
        } else {
            current.saturating_sub(step)
        }
    } else {
        let step = delta as usize;
        if wrap && step == 1 && current + 1 >= option_count {
            0
        } else {
            current.saturating_add(step).min(option_count - 1)
        }
    };
    set_question_dialog_cursor(dialog, next, area, true);
}

fn push_question_prompt_lines(
    lines: &mut Vec<Line<'static>>,
    question: &kcoder_tools::Question,
    width: usize,
) {
    let header = format!("[{}] ", question.header);
    let header_width = unicode_width::UnicodeWidthStr::width(header.as_str());
    let question_width = width.saturating_sub(header_width).max(1);
    let wrapped =
        render::wrapping::adaptive_word_wrap_plain_line(question.question.trim(), question_width);
    let first = wrapped.first().cloned().unwrap_or_default();
    lines.push(Line::from(vec![
        Span::styled("[", Style::default().fg(KCODER_UI_THEME.text_muted)),
        Span::styled(
            question.header.clone(),
            Style::default()
                .fg(KCODER_UI_THEME.accent_primary)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("] ", Style::default().fg(KCODER_UI_THEME.text_muted)),
        Span::styled(first, Style::default().fg(Color::White)),
    ]));
    for continuation in wrapped.into_iter().skip(1) {
        lines.push(Line::from(vec![
            Span::raw(" ".repeat(header_width)),
            Span::styled(continuation, Style::default().fg(Color::White)),
        ]));
    }
}

pub(super) fn permission_option_bounds(
    area: Rect,
    dialog: &PermissionDialog,
    index: usize,
) -> Option<Rect> {
    if index >= PERMISSION_OPTION_LABELS.len() {
        return None;
    }
    let geometry = permission_dialog_geometry(area, dialog);
    let row = geometry.option_y.saturating_add(index as u16);
    if !rect_contains(
        geometry.inner,
        geometry.inner.x,
        row.min(geometry.inner.y.saturating_add(geometry.inner.height)),
    ) {
        return None;
    }

    Some(Rect::new(geometry.inner.x, row, geometry.inner.width, 1))
}

pub(super) fn permission_option_hit_index(
    area: Rect,
    dialog: &PermissionDialog,
    column: u16,
    row: u16,
) -> Option<usize> {
    PERMISSION_OPTION_LABELS
        .iter()
        .enumerate()
        .find_map(|(idx, _)| {
            let rect = permission_option_bounds(area, dialog, idx)?;
            if rect_contains(rect, column, row) {
                Some(idx)
            } else {
                None
            }
        })
}

pub(super) fn question_option_hit_index(
    area: Rect,
    dialog: &QuestionDialog,
    column: u16,
    row: u16,
) -> Option<usize> {
    let question = dialog.request.questions.get(dialog.focused)?;
    let geometry = question_dialog_geometry(area, dialog);
    let inner = geometry.inner;
    if !rect_contains(inner, column, row) {
        return None;
    }
    let row_offset = row.saturating_sub(geometry.option_start_y) as usize;
    if row_offset >= geometry.option_rows {
        return None;
    }
    let mut used_rows = 0usize;
    for index in geometry.first_option
        ..geometry
            .first_option
            .saturating_add(geometry.visible_options)
            .min(question_dialog_option_count(question))
    {
        let height = question_option_height(question, index, usize::from(geometry.inner.width));
        let visible_height = height.min(geometry.option_rows.saturating_sub(used_rows));
        if row_offset < used_rows.saturating_add(visible_height) {
            return Some(index);
        }
        used_rows = used_rows.saturating_add(visible_height);
        if used_rows >= geometry.option_rows {
            break;
        }
    }
    None
}

pub(super) fn permission_detail_spans(
    tool_name: &str,
    line: &str,
    base_style: Style,
    code_theme: &str,
) -> Vec<Span<'static>> {
    let Some(command) = line.strip_prefix("Command: ") else {
        return vec![Span::styled(line.to_string(), base_style)];
    };
    if shell_tool_highlight_lang(tool_name).is_none() {
        return vec![Span::styled(line.to_string(), base_style)];
    }

    let mut spans = vec![Span::styled("Command: ", base_style)];
    spans.extend(tool_preview_spans(
        tool_name, command, base_style, code_theme,
    ));
    spans
}

pub(super) fn permission_input_spans(
    dialog: &PermissionDialog,
    base_style: Style,
    code_theme: &str,
) -> Vec<Span<'static>> {
    if let Some(command) = dialog.input.get("command").and_then(|value| value.as_str())
        && shell_tool_highlight_lang(&dialog.tool_name).is_some()
    {
        let mut spans = vec![Span::styled("$ ", base_style)];
        spans.extend(tool_preview_spans(
            &dialog.tool_name,
            command,
            base_style,
            code_theme,
        ));
        return spans;
    }

    let input_text = dialog.input.to_string();
    let formatted_input = text_formatting::format_json_compact(&input_text).unwrap_or(input_text);
    vec![Span::styled(
        format!("Input: {formatted_input}"),
        base_style,
    )]
}

pub(super) fn permission_dialog_title(dialog: &PermissionDialog) -> String {
    if shell_tool_highlight_lang(&dialog.tool_name).is_some() {
        "Would you like to run the following command?".to_string()
    } else if tool_family_for_name(&dialog.tool_name) == ToolFamily::Patch {
        "Would you like to make the following edits?".to_string()
    } else {
        format!("Would you like to allow {}?", dialog.tool_name)
    }
}

pub(super) fn permission_dialog_footer_line() -> Line<'static> {
    Line::from(vec![
        Span::raw("Press "),
        key_hint::plain(KeyCode::Enter).into(),
        Span::raw(" to confirm or "),
        key_hint::plain(KeyCode::Esc).into(),
        Span::raw(" to cancel"),
    ])
}

fn permission_option_line(index: usize, label: &str, selected: bool) -> Line<'static> {
    let marker_style = if selected {
        Style::default()
            .fg(KCODER_UI_THEME.accent_primary)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(KCODER_UI_THEME.text_dim)
    };
    let label_style = if selected {
        Style::default()
            .fg(KCODER_UI_THEME.accent_primary)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::White)
    };

    Line::from(vec![
        Span::styled(if selected { "› " } else { "  " }, marker_style),
        Span::styled(format!("{}. ", index + 1), marker_style),
        Span::styled(label.to_string(), label_style),
        Span::styled(
            format!(" ({})", PERMISSION_OPTION_SHORTCUTS[index]),
            Style::default().fg(KCODER_UI_THEME.text_dim),
        ),
    ])
}

pub(super) fn permission_dialog_lines(
    dialog: &PermissionDialog,
    code_theme: &str,
) -> Vec<Line<'static>> {
    let tool_styles = KCODER_UI_THEME.tool_styles();
    let mut lines: Vec<Line> = vec![
        Line::from(Span::styled(
            permission_dialog_title(dialog),
            Style::default()
                .fg(KCODER_UI_THEME.text_body)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];

    if !dialog.description.is_empty() {
        lines.push(Line::from(vec![
            Span::styled("Reason: ", Style::default().fg(KCODER_UI_THEME.text_body)),
            Span::styled(
                dialog.description.clone(),
                Style::default()
                    .fg(KCODER_UI_THEME.text_body)
                    .add_modifier(Modifier::ITALIC),
            ),
        ]));
        lines.push(Line::from(""));
    }

    if dialog.detail_lines.is_empty() {
        lines.push(Line::from(permission_input_spans(
            dialog,
            tool_styles.output,
            code_theme,
        )));
    } else {
        for line in &dialog.detail_lines {
            for wrapped in line.lines() {
                lines.push(Line::from(permission_detail_spans(
                    &dialog.tool_name,
                    wrapped,
                    tool_styles.output,
                    code_theme,
                )));
            }
        }
    }

    lines.push(Line::from(""));

    for (i, label) in PERMISSION_OPTION_LABELS.iter().enumerate() {
        lines.push(permission_option_line(i, label, i == dialog.selected));
    }
    lines.push(Line::from(""));
    lines.push(
        permission_dialog_footer_line().style(Style::default().fg(KCODER_UI_THEME.text_muted)),
    );
    lines
}

pub(super) fn draw_permission_dialog(
    frame: &mut Frame,
    area: Rect,
    dialog: &PermissionDialog,
    code_theme: &str,
) {
    let lines = permission_dialog_lines(dialog, code_theme);

    let geometry = permission_dialog_geometry(area, dialog);
    let dialog_area = geometry.outer;

    clear_overlay_band(frame, area, dialog_area, crate::theme::user_surface_bg());

    let paragraph = Paragraph::new(Text::from(lines)).style(crate::theme::user_surface_style());
    frame.render_widget(paragraph, geometry.inner);
}

pub(super) fn draw_question_dialog(frame: &mut Frame, area: Rect, dialog: &QuestionDialog) {
    let geometry = question_dialog_geometry(area, dialog);
    let rendered = question_dialog_render_window(
        dialog,
        geometry.inner.width,
        geometry.first_option,
        geometry.visible_options,
        geometry.option_rows,
        geometry.footer_lines,
    );
    debug_assert_eq!(
        rendered.option_start,
        usize::from(geometry.option_start_y.saturating_sub(geometry.inner.y))
    );
    let dialog_area = geometry.outer;

    clear_overlay_band(frame, area, dialog_area, KCODER_UI_THEME.panel_bg);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(KCODER_UI_THEME.accent_primary))
        .title(Span::styled(
            " Question ",
            Style::default()
                .fg(KCODER_UI_THEME.accent_primary)
                .add_modifier(Modifier::BOLD),
        ));

    let inner = block.inner(dialog_area);
    frame.render_widget(block, dialog_area);

    let paragraph = Paragraph::new(Text::from(rendered.lines))
        .style(Style::default().bg(KCODER_UI_THEME.panel_bg));
    frame.render_widget(paragraph, inner);
}

pub(super) fn draw_side_question_overlay(
    frame: &mut Frame,
    area: Rect,
    overlay: &SideQuestionOverlay,
    code_theme: &str,
) {
    let width = (area.width as f32 * 0.78).clamp(46.0, 100.0) as u16;
    let height = (area.height as f32 * 0.62).clamp(12.0, 30.0) as u16;
    let dialog_area = centered_rect(area, width, height);
    clear_overlay_band(frame, area, dialog_area, KCODER_UI_THEME.panel_bg);

    let loading = matches!(overlay.status, SideQuestionStatus::Loading);
    let pulse = (overlay.started_at.elapsed().as_millis() / 400).is_multiple_of(2);
    let glyph = if loading && pulse { "◆" } else { "◇" };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(KCODER_UI_THEME.accent_primary))
        .title(Span::styled(
            format!(" {glyph} /btw "),
            Style::default()
                .fg(KCODER_UI_THEME.accent_primary)
                .add_modifier(Modifier::BOLD),
        ));
    let inner = block.inner(dialog_area);
    frame.render_widget(block, dialog_area);

    let mut lines = vec![
        Line::from(Span::styled(
            format!("Q: {}", overlay.question),
            Style::default().fg(KCODER_UI_THEME.text_muted),
        )),
        Line::from(""),
    ];
    match &overlay.status {
        SideQuestionStatus::Loading => lines.push(Line::from(Span::styled(
            "Answering while the main task continues…",
            Style::default().fg(KCODER_UI_THEME.text_soft),
        ))),
        SideQuestionStatus::Answered(answer) => {
            lines.extend(render_markdown_with_theme(answer, code_theme));
        }
        SideQuestionStatus::Failed(error) => lines.push(Line::from(Span::styled(
            format!("Side question failed: {error}"),
            Style::default().fg(KCODER_UI_THEME.error_text),
        ))),
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "↑/↓ scroll · Enter/Esc/Space close",
        Style::default().fg(KCODER_UI_THEME.text_muted),
    )));
    frame.render_widget(
        Paragraph::new(Text::from(lines))
            .wrap(Wrap { trim: false })
            .scroll((overlay.scroll, 0)),
        inner,
    );
}

pub(super) fn draw_goal_replacement_dialog(
    frame: &mut Frame,
    area: Rect,
    dialog: &GoalReplacementDialog,
) {
    let width = (area.width as f32 * 0.7).clamp(44.0, 84.0) as u16;
    let height = 12u16.min(area.height.saturating_sub(4)).max(8);
    let dialog_area = centered_rect(area, width, height);

    clear_overlay_band(frame, area, dialog_area, KCODER_UI_THEME.panel_bg);

    let display_name = if dialog.mode.is_arrangement() {
        "UltGoal"
    } else if dialog.mode.is_strict() {
        "Goal Pro"
    } else {
        "Goal"
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(KCODER_UI_THEME.warning))
        .title(Span::styled(
            format!(" Replace {display_name} "),
            Style::default()
                .fg(KCODER_UI_THEME.warning)
                .add_modifier(Modifier::BOLD),
        ));

    let inner = block.inner(dialog_area);
    frame.render_widget(block, dialog_area);

    let budget = dialog
        .token_budget
        .map(|budget| format!("{budget} tokens"))
        .unwrap_or_else(|| "none".to_string());
    let options = ["Replace", "Cancel"];
    let option_line = Line::from(
        options
            .iter()
            .enumerate()
            .map(|(idx, label)| {
                let style = if idx == dialog.selected {
                    Style::default()
                        .fg(Color::Black)
                        .bg(KCODER_UI_THEME.warning)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::White)
                };
                Span::styled(format!("  {}  ", label), style)
            })
            .collect::<Vec<_>>(),
    );

    let max_text_width = inner.width.saturating_sub(9) as usize;
    let lines = vec![
        Line::from(format!("An unfinished {display_name} already exists.")),
        Line::from(vec![
            Span::styled("Current: ", Style::default().fg(KCODER_UI_THEME.text_muted)),
            Span::styled(
                truncate_display_text(&dialog.existing_summary, max_text_width),
                Style::default().fg(Color::White),
            ),
        ]),
        Line::from(vec![
            Span::styled("New: ", Style::default().fg(KCODER_UI_THEME.text_muted)),
            Span::styled(
                truncate_display_text(&dialog.objective, max_text_width),
                Style::default().fg(Color::White),
            ),
        ]),
        Line::from(vec![
            Span::styled("Budget: ", Style::default().fg(KCODER_UI_THEME.text_muted)),
            Span::styled(budget, Style::default().fg(KCODER_UI_THEME.text_soft)),
        ]),
        Line::from(vec![
            Span::styled(
                "Verification: ",
                Style::default().fg(KCODER_UI_THEME.text_muted),
            ),
            Span::styled(
                dialog.verification_kind.as_str(),
                Style::default().fg(KCODER_UI_THEME.text_soft),
            ),
        ]),
        Line::from(""),
        option_line,
        Line::from(""),
        Line::from("Enter/y to replace, n/Esc to cancel")
            .style(Style::default().fg(KCODER_UI_THEME.text_muted)),
    ];

    let paragraph =
        Paragraph::new(Text::from(lines)).style(Style::default().bg(KCODER_UI_THEME.panel_bg));
    frame.render_widget(paragraph, inner);
}

pub(super) fn draw_permission_editor(frame: &mut Frame, area: Rect, editor: &PermissionEditor) {
    let width = (area.width as f32 * 0.75).clamp(50.0, 90.0) as u16;
    let height = (area.height as f32 * 0.6).clamp(12.0, 40.0) as u16;
    let dialog_area = centered_rect(area, width, height);

    clear_overlay_band(frame, area, dialog_area, KCODER_UI_THEME.panel_bg);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(KCODER_UI_THEME.accent_primary))
        .title(Span::styled(
            format!(" Edit {} input ", editor.tool_name),
            Style::default()
                .fg(KCODER_UI_THEME.accent_primary)
                .add_modifier(Modifier::BOLD),
        ));

    let inner = block.inner(dialog_area);
    frame.render_widget(block, dialog_area);

    let mut lines: Vec<Line> = vec![
        Line::from("Edit the JSON input below, then press Ctrl+Enter to confirm or Esc to cancel.")
            .style(Style::default().fg(KCODER_UI_THEME.text_muted)),
        Line::from(""),
    ];
    for line in editor.text.lines() {
        lines.push(Line::from(Span::styled(
            line.to_string(),
            Style::default().fg(Color::White),
        )));
    }

    let paragraph =
        Paragraph::new(Text::from(lines)).style(Style::default().bg(KCODER_UI_THEME.panel_bg));
    frame.render_widget(paragraph, inner);

    // Draw a simple block cursor at the current grapheme position.
    let (cursor_line, cursor_col) =
        permission_editor_cursor_position(&editor.text, editor.cursor_grapheme_index);
    let cursor_area = ratatui::layout::Rect::new(
        inner.x + 1 + cursor_col,
        inner.y + 2 + cursor_line as u16,
        1,
        1,
    );
    frame.buffer_mut().set_style(
        cursor_area,
        Style::default()
            .bg(KCODER_UI_THEME.accent_primary)
            .fg(Color::Black),
    );
}

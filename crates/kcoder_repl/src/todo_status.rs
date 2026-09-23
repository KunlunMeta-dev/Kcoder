use crate::custom_terminal::Frame;
use crate::theme::KCODER_UI_THEME;
use crate::tool_format::sanitize_tui_text;
use crate::widgets;
use kcoder_state::{TodoItem, TodoStatus};
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::Paragraph,
};

const TODO_STATUS_MAX_VISIBLE_ITEMS: usize = 4;

pub(crate) fn todo_status_height(todos: &[TodoItem]) -> u16 {
    if todos.is_empty() {
        return 0;
    }
    let visible_items = todos.len().min(TODO_STATUS_MAX_VISIBLE_ITEMS) as u16;
    let overflow = u16::from(todos.len() > TODO_STATUS_MAX_VISIBLE_ITEMS);
    1 + visible_items + overflow
}

fn todo_status_parts(status: TodoStatus) -> (&'static str, &'static str, Color) {
    match status {
        TodoStatus::Pending => ("○", "pending", KCODER_UI_THEME.text_muted),
        TodoStatus::InProgress => ("●", "active", KCODER_UI_THEME.accent_primary),
        TodoStatus::Completed => ("✓", "done", KCODER_UI_THEME.success),
        TodoStatus::Cancelled => ("×", "cancelled", KCODER_UI_THEME.error_fg),
    }
}

fn todo_content_preview(content: &str, max_width: usize) -> String {
    let compact = sanitize_tui_text(content)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    widgets::truncate_to_width(&compact, max_width)
}

pub(crate) fn render_todo_status_lines(todos: &[TodoItem], width: u16) -> Vec<Line<'static>> {
    if todos.is_empty() || width == 0 {
        return Vec::new();
    }

    let total = todos.len();
    let completed = todos
        .iter()
        .filter(|todo| todo.status == TodoStatus::Completed)
        .count();
    let active = todos
        .iter()
        .filter(|todo| todo.status == TodoStatus::InProgress)
        .count();
    let pending = todos
        .iter()
        .filter(|todo| todo.status == TodoStatus::Pending)
        .count();

    let mut header = vec![
        Span::styled(
            "TodoList",
            Style::default()
                .fg(KCODER_UI_THEME.accent_primary)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(" {completed}/{total} done"),
            Style::default().fg(KCODER_UI_THEME.text_dim),
        ),
    ];
    if active > 0 {
        header.push(Span::styled(
            format!(" · {active} active"),
            Style::default().fg(KCODER_UI_THEME.accent_primary),
        ));
    }
    if pending > 0 {
        header.push(Span::styled(
            format!(" · {pending} pending"),
            Style::default().fg(KCODER_UI_THEME.text_muted),
        ));
    }

    let mut lines = vec![Line::from(header)];
    for todo in todos.iter().take(TODO_STATUS_MAX_VISIBLE_ITEMS) {
        let (glyph, label, color) = todo_status_parts(todo.status);
        let suffix = format!(" ({label})");
        let suffix_width = unicode_width::UnicodeWidthStr::width(suffix.as_str());
        let content_width = (width as usize).saturating_sub(4 + suffix_width);
        let content = todo_content_preview(&todo.content, content_width);
        lines.push(Line::from(vec![
            Span::styled(format!("  {glyph} "), Style::default().fg(color)),
            Span::styled(
                content,
                Style::default().fg(if todo.status == TodoStatus::Completed {
                    KCODER_UI_THEME.text_dim
                } else {
                    KCODER_UI_THEME.text_body
                }),
            ),
            Span::styled(suffix, Style::default().fg(KCODER_UI_THEME.text_dim)),
        ]));
    }
    if todos.len() > TODO_STATUS_MAX_VISIBLE_ITEMS {
        lines.push(Line::from(Span::styled(
            format!(
                "  +{} more",
                todos.len().saturating_sub(TODO_STATUS_MAX_VISIBLE_ITEMS)
            ),
            Style::default().fg(KCODER_UI_THEME.text_dim),
        )));
    }
    lines
}

pub(crate) fn draw_todo_status(frame: &mut Frame, todos: &[TodoItem], area: Rect) {
    if area.height == 0 || area.width == 0 || todos.is_empty() {
        return;
    }

    widgets::clear_area(area, frame.buffer_mut(), KCODER_UI_THEME.panel_bg);
    let inner = Rect::new(
        area.x.saturating_add(1),
        area.y,
        area.width.saturating_sub(2),
        area.height,
    );
    if inner.height == 0 || inner.width == 0 {
        return;
    }

    let lines = render_todo_status_lines(todos, inner.width);
    frame.render_widget(
        Paragraph::new(Text::from(lines)).style(Style::default().bg(KCODER_UI_THEME.panel_bg)),
        inner,
    );
}

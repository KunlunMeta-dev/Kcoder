//! Footer and status-line widget for the KCoder REPL.

use std::time::Duration;

use crossterm::event::KeyCode;
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Style, Stylize},
    text::{Line, Span},
    widgets::{Paragraph, Widget},
};

use crate::key_hint;
use crate::key_hint::KeyBinding;
use crate::line_truncation::{
    line_width, truncate_line_to_width, truncate_line_with_ellipsis_if_overflow,
};
use crate::text_formatting::center_truncate_path;
use crate::theme::UiTheme;
use crate::widgets::status_indicator::fmt_elapsed_compact;
use crate::widgets::{clear_area, span_width, truncate_to_width};
use crate::windows_compat::{UI_SEPARATOR, status_text};

const CONTEXT_WARNING_THRESHOLD_PERCENT: f64 = 85.0;
const CONTEXT_CRITICAL_THRESHOLD_PERCENT: f64 = 95.0;
// Display physical context remaining by default; keep one entry point for explicitly distinguishing other measures later.
const CONTEXT_BASELINE_TOKENS: usize = 0;
const FOOTER_INDENT_COLS: u16 = 2;

pub(crate) fn context_window_remaining_percent(
    context_used: usize,
    context_total: usize,
) -> Option<f64> {
    if context_total == 0 {
        return None;
    }
    let (used, total) = if context_total > CONTEXT_BASELINE_TOKENS {
        (
            context_used.saturating_sub(CONTEXT_BASELINE_TOKENS),
            context_total - CONTEXT_BASELINE_TOKENS,
        )
    } else {
        (context_used, context_total)
    };
    let used_percent = used as f64 / total as f64 * 100.0;
    Some((100.0 - used_percent).clamp(0.0, 100.0))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FooterHint<'a> {
    None,
    Shortcuts,
    TransientStatus { text: &'a str },
    EditPrevious,
    EditPreviousPrimed,
    HistorySearch { query: &'a str, has_match: bool },
    Activity,
    Interrupt,
    QueueMessage,
    ShellMode,
    QuitReminder(KeyBinding),
}

impl FooterHint<'_> {
    pub(crate) fn desired_height(self) -> u16 {
        self.desired_height_with_mode_switch(false)
    }

    pub(crate) fn desired_height_with_mode_switch(self, _mode_switch_enabled: bool) -> u16 {
        match self {
            Self::None
            | Self::Shortcuts
            | Self::TransientStatus { .. }
            | Self::EditPrevious
            | Self::EditPreviousPrimed
            | Self::HistorySearch { .. }
            | Self::Activity
            | Self::Interrupt
            | Self::QueueMessage
            | Self::ShellMode
            | Self::QuitReminder(_) => 1,
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct FooterData<'a> {
    pub(crate) hint: FooterHint<'a>,
    pub(crate) mode_label: &'a str,
    pub(crate) mode_switch_enabled: bool,
    pub(crate) esc_backtrack_hint: bool,
    pub(crate) cwd: &'a str,
    pub(crate) session_title: &'a str,
    pub(crate) model: &'a str,
    pub(crate) provider: &'a str,
    pub(crate) ambient_status: &'a str,
    pub(crate) is_streaming: bool,
    pub(crate) activity_elapsed: Duration,
    pub(crate) activity_indicator: &'a str,
    pub(crate) activity_label: &'a str,
    pub(crate) activity_attention: bool,
    pub(crate) context_used: usize,
    pub(crate) context_total: usize,
    pub(crate) ui_theme: &'a UiTheme,
}

impl<'a> FooterData<'a> {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        hint: FooterHint<'a>,
        cwd: &'a str,
        session_title: &'a str,
        model: &'a str,
        provider: &'a str,
        ambient_status: &'a str,
        is_streaming: bool,
        context_used: usize,
        context_total: usize,
        ui_theme: &'a UiTheme,
    ) -> Self {
        Self {
            hint,
            mode_label: "",
            mode_switch_enabled: false,
            esc_backtrack_hint: false,
            cwd,
            session_title,
            model,
            provider,
            ambient_status,
            is_streaming,
            activity_elapsed: Duration::ZERO,
            activity_indicator: "",
            activity_label: "",
            activity_attention: false,
            context_used,
            context_total,
            ui_theme,
        }
    }

    pub(crate) fn with_mode_label(mut self, mode_label: &'a str) -> Self {
        self.mode_label = mode_label;
        self
    }

    pub(crate) fn with_mode_switch_enabled(mut self, enabled: bool) -> Self {
        self.mode_switch_enabled = enabled;
        self
    }

    pub(crate) fn with_esc_backtrack_hint(mut self, enabled: bool) -> Self {
        self.esc_backtrack_hint = enabled;
        self
    }

    pub(crate) fn with_activity_elapsed(mut self, elapsed: Duration) -> Self {
        self.activity_elapsed = elapsed;
        self
    }

    pub(crate) fn with_activity_status(
        mut self,
        indicator: &'a str,
        label: &'a str,
        needs_attention: bool,
    ) -> Self {
        self.activity_indicator = indicator;
        self.activity_label = label;
        self.activity_attention = needs_attention;
        self
    }
}

pub(crate) struct FooterWidget<'a> {
    data: FooterData<'a>,
}

impl<'a> FooterWidget<'a> {
    pub(crate) fn new(data: FooterData<'a>) -> Self {
        Self { data }
    }

    fn context_percent(&self) -> Option<f64> {
        context_window_remaining_percent(self.data.context_used, self.data.context_total)
            .map(|remaining| 100.0 - remaining)
    }

    fn context_left_spans(&self) -> Vec<Span<'static>> {
        if self.data.context_total == 0 {
            return if self.data.context_used == 0 {
                vec![Span::styled(
                    "100% context left",
                    Style::default().fg(Color::Green),
                )]
            } else {
                vec![Span::styled(
                    format!(
                        "{} used",
                        format_tokens_compact(self.data.context_used as u64)
                    ),
                    Style::default().fg(Color::Green),
                )]
            };
        }

        let Some(used_percent) = self.context_percent() else {
            return Vec::new();
        };
        let left_percent = (100.0 - used_percent).clamp(0.0, 100.0);
        let color = if used_percent >= CONTEXT_CRITICAL_THRESHOLD_PERCENT {
            self.data.ui_theme.error_fg
        } else if used_percent >= CONTEXT_WARNING_THRESHOLD_PERCENT {
            self.data.ui_theme.warning
        } else {
            Color::Green
        };

        vec![Span::styled(
            format!("{left_percent:.0}% context left"),
            Style::default().fg(color),
        )]
    }

    fn hint_line(&self, hint: FooterHint<'_>, queue_short: bool) -> Option<Line<'static>> {
        let spans: Vec<Span<'static>> = match hint {
            FooterHint::None => return None,
            FooterHint::Shortcuts => vec![
                key_hint::plain(KeyCode::Char('?')).into(),
                " for shortcuts".dim(),
            ],
            FooterHint::TransientStatus { text } => vec![Span::styled(
                text.to_string(),
                Style::default().fg(self.data.ui_theme.text_muted),
            )],
            FooterHint::EditPrevious => {
                let esc = key_hint::plain(KeyCode::Esc);
                vec![
                    esc.into(),
                    " ".dim(),
                    esc.into(),
                    " to edit previous message".dim(),
                ]
            }
            FooterHint::EditPreviousPrimed => vec![
                key_hint::plain(KeyCode::Esc).into(),
                " again to edit previous message".dim(),
            ],
            FooterHint::HistorySearch { query, has_match } => {
                let mut spans = vec![
                    "reverse-i-search: ".dim(),
                    Span::styled(query.to_string(), Style::default().fg(Color::Cyan)),
                ];
                if !query.is_empty() {
                    if has_match {
                        spans.push("  ".dim());
                        spans.push(history_search_action_key_span(KeyCode::Enter));
                        spans.push(" accept".dim());
                        spans.push(UI_SEPARATOR.dim());
                        spans.push(history_search_action_key_span(KeyCode::Esc));
                        spans.push(" cancel".dim());
                    } else {
                        spans.push("  no match".red());
                    }
                }
                spans
            }
            FooterHint::Activity | FooterHint::Interrupt => {
                let mut spans = Vec::new();
                if !self.data.activity_label.is_empty() {
                    let color = if self.data.activity_attention {
                        self.data.ui_theme.warning
                    } else {
                        self.data.ui_theme.accent_primary
                    };
                    spans.push(Span::styled(
                        format!(
                            "{} {}",
                            self.data.activity_indicator,
                            status_text(self.data.activity_label)
                        ),
                        Style::default().fg(color),
                    ));
                    spans.push(UI_SEPARATOR.dim());
                    spans.push(Span::styled(
                        fmt_elapsed_compact(self.data.activity_elapsed.as_secs()),
                        Style::default().fg(self.data.ui_theme.text_dim),
                    ));
                    spans.push(UI_SEPARATOR.dim());
                }
                if matches!(hint, FooterHint::Interrupt) {
                    spans.push(key_hint::plain(KeyCode::Esc).into());
                    spans.push(" interrupt".dim());
                }
                spans
            }
            FooterHint::QueueMessage => {
                let label = if queue_short {
                    " to queue"
                } else {
                    " to queue message"
                };
                vec![key_hint::plain(KeyCode::Tab).into(), label.dim()]
            }
            FooterHint::ShellMode => vec![Span::styled(
                "Shell mode",
                Style::default().fg(self.data.ui_theme.error_fg),
            )],
            FooterHint::QuitReminder(key) => {
                vec![key.into(), " again to quit".dim()]
            }
        };

        Some(Line::from(spans))
    }

    fn mode_label_line(&self, show_cycle_hint: bool) -> Option<Line<'static>> {
        if self.data.mode_label.is_empty() {
            None
        } else {
            let label = if self.data.mode_switch_enabled && show_cycle_hint {
                format!("{} (shift+tab to cycle)", self.data.mode_label)
            } else {
                self.data.mode_label.to_string()
            };
            Some(Line::from(Span::styled(
                label,
                Style::default().fg(Color::Cyan),
            )))
        }
    }

    fn append_mode_label(&self, line: Line<'static>, show_cycle_hint: bool) -> Line<'static> {
        let Some(mode_line) = self.mode_label_line(show_cycle_hint) else {
            return line;
        };

        if line_width(&line) == 0 {
            return mode_line;
        }

        let mut spans = line.spans;
        spans.push(UI_SEPARATOR.dim());
        spans.extend(mode_line.spans);
        Line::from(spans)
    }

    fn hint_combines_with_mode_label(hint: FooterHint<'_>) -> bool {
        matches!(
            hint,
            FooterHint::None
                | FooterHint::Shortcuts
                | FooterHint::TransientStatus { .. }
                | FooterHint::QueueMessage
                | FooterHint::Activity
                | FooterHint::Interrupt
        )
    }

    fn push_mode_label_candidate(
        &self,
        candidates: &mut Vec<(Line<'static>, bool)>,
        show_cycle_hint: bool,
        allow_context: bool,
    ) {
        if let Some(mode_line) = self.mode_label_line(show_cycle_hint) {
            candidates.push((mode_line, allow_context));
        }
    }

    fn render_lines(&self, available: usize) -> Vec<Line<'static>> {
        vec![self.render_line(available)]
    }

    fn right_line(&self, max_width: usize) -> Line<'static> {
        if max_width == 0 {
            return Line::from(Vec::<Span<'static>>::new());
        }

        let context_line = Line::from(self.context_left_spans());
        let context_width = line_width(&context_line);
        if context_width > max_width {
            return Line::from(Vec::<Span<'static>>::new());
        }
        let mut spans = Vec::new();
        let mut push_segment = |text: &str, style: Style, center_path: bool| {
            let text = status_text(text);
            if text.is_empty() || span_width(&spans) >= max_width {
                return;
            }
            let separator_width = if spans.is_empty() { 0 } else { 3 };
            let reserve_for_context = if context_width == 0 {
                0
            } else {
                context_width.saturating_add(3)
            };
            let used_before_content = span_width(&spans).saturating_add(separator_width);
            if used_before_content.saturating_add(reserve_for_context) >= max_width {
                return;
            }
            if separator_width > 0 {
                spans.push(UI_SEPARATOR.dim());
            }
            let remaining = max_width
                .saturating_sub(span_width(&spans))
                .saturating_sub(reserve_for_context);
            if remaining > 0 {
                let content = if center_path {
                    center_truncate_path(text.as_ref(), remaining)
                } else {
                    truncate_to_width(text.as_ref(), remaining)
                };
                spans.push(Span::styled(content, style));
            }
        };

        let model_context = match (self.data.provider.is_empty(), self.data.model.is_empty()) {
            (false, false) => format!("{}/{}", self.data.provider, self.data.model),
            (false, true) => self.data.provider.to_string(),
            (true, false) => self.data.model.to_string(),
            (true, true) => String::new(),
        };
        push_segment(&model_context, Style::default().fg(Color::Cyan), false);
        if self.data.is_streaming
            && !matches!(self.data.hint, FooterHint::Activity | FooterHint::Interrupt)
        {
            let working = if self.data.activity_label.is_empty() {
                "Working".to_string()
            } else {
                format!(
                    "{} {}",
                    self.data.activity_indicator,
                    status_text(self.data.activity_label)
                )
            };
            let color = if self.data.activity_attention {
                self.data.ui_theme.warning
            } else {
                self.data.ui_theme.accent_primary
            };
            push_segment(&working, Style::default().fg(color), false);
        }
        push_segment(
            self.data.ambient_status,
            Style::default().fg(Color::Cyan),
            false,
        );
        push_segment(
            self.data.session_title,
            Style::default().fg(Color::Cyan),
            false,
        );
        push_segment(self.data.cwd, Style::default().fg(Color::Green), true);

        if context_width > 0 {
            let separator_width = if spans.is_empty() { 0 } else { 3 };
            if span_width(&spans)
                .saturating_add(separator_width)
                .saturating_add(context_width)
                <= max_width
            {
                if separator_width > 0 {
                    spans.push(UI_SEPARATOR.dim());
                }
                spans.extend(context_line.spans);
            }
        }

        truncate_line_with_ellipsis_if_overflow(Line::from(spans), max_width)
    }

    fn combine_lines(
        &self,
        left: Option<Line<'static>>,
        right: Line<'static>,
        available: usize,
    ) -> Option<Line<'static>> {
        let right_width = line_width(&right);
        let left_width = left.as_ref().map(line_width).unwrap_or(0);
        if left_width == 0 && right_width == 0 {
            return None;
        }
        if left_width.saturating_add(right_width) > available {
            return None;
        }

        let mut spans = Vec::new();
        if let Some(left) = left {
            spans.extend(left.spans);
        }

        if right_width > 0 {
            let spacer_width = available.saturating_sub(left_width + right_width);
            if spacer_width > 0 {
                spans.push(Span::raw(" ".repeat(spacer_width)));
            }
            spans.extend(right.spans);
        }

        Some(truncate_line_with_ellipsis_if_overflow(
            Line::from(spans),
            available,
        ))
    }

    fn try_with_context(&self, left: Line<'static>, available: usize) -> Option<Line<'static>> {
        let left_width = line_width(&left);
        if left_width >= available {
            return None;
        }
        let right = self.right_line(available.saturating_sub(left_width).saturating_sub(1));
        let right_width = line_width(&right);
        if right_width == 0 || left_width.saturating_add(1 + right_width) > available {
            return None;
        }
        self.combine_lines(Some(left), right, available)
    }

    fn left_only(&self, left: Line<'static>, available: usize) -> Option<Line<'static>> {
        (line_width(&left) <= available).then(|| truncate_line_to_width(left, available))
    }

    fn render_line(&self, available: usize) -> Line<'static> {
        let mut candidates = Vec::new();
        let context_requires_cycle_hint =
            self.data.mode_switch_enabled && !matches!(self.data.hint, FooterHint::QueueMessage);
        if let Some(full) = self.hint_line(self.data.hint, false) {
            if Self::hint_combines_with_mode_label(self.data.hint) {
                let show_cycle_hint = !matches!(self.data.hint, FooterHint::QueueMessage);
                candidates.push((self.append_mode_label(full, show_cycle_hint), true));
                if matches!(self.data.hint, FooterHint::Shortcuts) {
                    self.push_mode_label_candidate(&mut candidates, true, true);
                    self.push_mode_label_candidate(
                        &mut candidates,
                        false,
                        !context_requires_cycle_hint,
                    );
                }
            } else {
                candidates.push((full, true));
            }
        } else if Self::hint_combines_with_mode_label(self.data.hint) {
            self.push_mode_label_candidate(&mut candidates, true, true);
            self.push_mode_label_candidate(&mut candidates, false, !context_requires_cycle_hint);
        }
        if matches!(
            self.data.hint,
            FooterHint::QuitReminder(_)
                | FooterHint::HistorySearch { .. }
                | FooterHint::TransientStatus { .. }
        ) && let Some((candidate, _)) = candidates.first().cloned()
        {
            return truncate_line_to_width(candidate, available);
        }
        if matches!(self.data.hint, FooterHint::QueueMessage)
            && let Some(short) = self.hint_line(self.data.hint, true)
        {
            candidates.push((self.append_mode_label(short, false), true));
            self.push_mode_label_candidate(&mut candidates, false, false);
        }

        for (candidate, allow_context) in &candidates {
            if *allow_context
                && let Some(line) = self.try_with_context(candidate.clone(), available)
            {
                return line;
            }
        }
        for (candidate, _) in candidates {
            if let Some(line) = self.left_only(candidate, available) {
                return line;
            }
        }

        let right = self.right_line(available);
        self.combine_lines(None, right, available)
            .unwrap_or_else(|| Line::from(""))
    }
}

impl crate::widgets::Renderable for FooterWidget<'_> {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }
        clear_area(area, buf, self.data.ui_theme.footer_bg);
        let content_area = footer_content_area(area);
        if content_area.width == 0 || content_area.height == 0 {
            return;
        }
        let lines = self.render_lines(content_area.width as usize);
        Paragraph::new(lines)
            .style(Style::default().bg(self.data.ui_theme.footer_bg))
            .render(content_area, buf);
    }

    fn desired_height(&self, _width: u16) -> u16 {
        self.data
            .hint
            .desired_height_with_mode_switch(self.data.mode_switch_enabled)
    }
}

fn footer_content_area(area: Rect) -> Rect {
    let left = FOOTER_INDENT_COLS.min(area.width);
    let right = FOOTER_INDENT_COLS.min(area.width.saturating_sub(left));
    Rect {
        x: area.x.saturating_add(left),
        y: area.y,
        width: area.width.saturating_sub(left).saturating_sub(right),
        height: area.height,
    }
}

fn format_tokens_compact(value: u64) -> String {
    if value < 1_000 {
        return value.to_string();
    }

    let value_f64 = value as f64;
    let (scaled, suffix) = if value >= 1_000_000_000_000 {
        (value_f64 / 1_000_000_000_000.0, "T")
    } else if value >= 1_000_000_000 {
        (value_f64 / 1_000_000_000.0, "B")
    } else if value >= 1_000_000 {
        (value_f64 / 1_000_000.0, "M")
    } else {
        (value_f64 / 1_000.0, "K")
    };

    let decimals = if scaled < 10.0 {
        2
    } else if scaled < 100.0 {
        1
    } else {
        0
    };

    let mut formatted = format!("{scaled:.decimals$}");
    if formatted.contains('.') {
        while formatted.ends_with('0') {
            formatted.pop();
        }
        if formatted.ends_with('.') {
            formatted.pop();
        }
    }

    format!("{formatted}{suffix}")
}

fn shortcut_overlay_entry_spans(key: KeyBinding, label: &'static str) -> Vec<Span<'static>> {
    vec![key.into(), Span::raw(label).dim()]
}

fn shortcut_overlay_entry(key: KeyBinding, label: &'static str) -> Line<'static> {
    Line::from(shortcut_overlay_entry_spans(key, label))
}

fn history_search_action_key_span(key: KeyCode) -> Span<'static> {
    Span::from(key_hint::plain(key)).cyan().bold().not_dim()
}

fn shortcut_overlay_columns(mut entries: Vec<Line<'static>>) -> Vec<Line<'static>> {
    const COLUMNS: usize = 2;
    const COLUMN_PADDING: [usize; COLUMNS] = [4, 4];
    const COLUMN_GAP: usize = 4;

    if entries.is_empty() {
        return Vec::new();
    }

    let rows = entries.len().div_ceil(COLUMNS);
    let target_len = rows * COLUMNS;
    entries.resize_with(target_len, || Line::from(""));

    let mut column_widths = [0usize; COLUMNS];
    for (idx, entry) in entries.iter().enumerate() {
        let column = idx % COLUMNS;
        column_widths[column] = column_widths[column].max(line_width(entry));
    }
    for (idx, width) in column_widths.iter_mut().enumerate() {
        *width = width.saturating_add(COLUMN_PADDING[idx]);
    }

    entries
        .chunks(COLUMNS)
        .map(|chunk| {
            let mut spans = Vec::new();
            for (column, entry) in chunk.iter().enumerate() {
                spans.extend(entry.spans.clone());
                if column + 1 < COLUMNS {
                    let padding = column_widths[column]
                        .saturating_sub(line_width(entry))
                        .saturating_add(COLUMN_GAP);
                    spans.push(Span::raw(" ".repeat(padding)));
                }
            }
            Line::from(spans)
        })
        .collect()
}

pub(crate) fn shortcut_overlay_lines_with_mode_switch(
    is_streaming: bool,
    mode_switch_enabled: bool,
    esc_backtrack_hint: bool,
) -> Vec<Line<'static>> {
    shortcut_overlay_lines(
        is_streaming,
        mode_switch_enabled,
        key_hint::shift(KeyCode::Enter),
        esc_backtrack_hint,
    )
}

fn shortcut_overlay_lines(
    is_streaming: bool,
    mode_switch_enabled: bool,
    newline_key: KeyBinding,
    esc_backtrack_hint: bool,
) -> Vec<Line<'static>> {
    let mut edit_previous = shortcut_overlay_entry_spans(key_hint::plain(KeyCode::Esc), "");
    if esc_backtrack_hint {
        edit_previous.push(Span::raw(" again to edit previous message").dim());
    } else {
        edit_previous.push(Span::raw(" ").dim());
        edit_previous.push(key_hint::plain(KeyCode::Esc).into());
        edit_previous.push(Span::raw(" to edit previous message").dim());
    }
    let tab_label = if is_streaming {
        " to queue message"
    } else {
        " to submit message"
    };
    let ctrl_c_label = if is_streaming {
        " to interrupt"
    } else {
        " to exit"
    };
    let image_paste_key = if cfg!(target_os = "windows") {
        key_hint::alt(KeyCode::Char('v'))
    } else {
        key_hint::ctrl(KeyCode::Char('v'))
    };

    let mut entries = vec![
        shortcut_overlay_entry(key_hint::plain(KeyCode::Char('/')), " for commands"),
        shortcut_overlay_entry(key_hint::plain(KeyCode::Char('!')), " for shell commands"),
        shortcut_overlay_entry(newline_key, " for newline"),
        shortcut_overlay_entry(key_hint::plain(KeyCode::Tab), tab_label),
        shortcut_overlay_entry(image_paste_key, " to paste images"),
        shortcut_overlay_entry(
            key_hint::ctrl(KeyCode::Char('g')),
            " to edit in external editor",
        ),
        Line::from(edit_previous),
        shortcut_overlay_entry(key_hint::ctrl(KeyCode::Char('r')), " search history"),
        shortcut_overlay_entry(key_hint::ctrl(KeyCode::Char('c')), ctrl_c_label),
        shortcut_overlay_entry(key_hint::alt(KeyCode::Char(',')), " reasoning down"),
        shortcut_overlay_entry(key_hint::alt(KeyCode::Char('.')), " reasoning up"),
    ];
    if mode_switch_enabled {
        entries.push(shortcut_overlay_entry(
            key_hint::shift(KeyCode::Tab),
            " to change mode",
        ));
    }
    entries.push(shortcut_overlay_entry(
        key_hint::alt(KeyCode::Char('t')),
        " to expand tools",
    ));

    let mut lines = shortcut_overlay_columns(entries);
    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::raw("customize shortcuts with ").dim(),
        Span::styled(
            "/keymap",
            Style::default().fg(crate::theme::KCODER_UI_THEME.accent_primary),
        ),
    ]));
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::KCODER_UI_THEME;
    use crate::widgets::Renderable;
    use unicode_width::UnicodeWidthStr;

    fn render_footer(width: u16, data: FooterData<'_>) -> Buffer {
        let height = FooterWidget::new(data).desired_height(width);
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));
        FooterWidget::new(data).render(buf.area, &mut buf);
        buf
    }

    fn text(buf: &Buffer) -> String {
        buf.content
            .chunks(buf.area.width as usize)
            .next()
            .unwrap()
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }

    fn line_text(line: &Line<'_>) -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    }

    fn line_span_texts(line: &Line<'_>) -> Vec<String> {
        line.spans
            .iter()
            .map(|span| span.content.to_string())
            .collect()
    }

    #[test]
    fn footer_uses_codex_side_insets() {
        let data = FooterData::new(
            FooterHint::Shortcuts,
            "",
            "",
            "",
            "",
            "",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        );

        let rendered = text(&render_footer(24, data));

        assert!(rendered.starts_with("  ? for shortcuts"));
        assert!(rendered.ends_with("  "));
    }

    #[test]
    fn footer_keeps_context_inside_codex_right_inset() {
        let data = FooterData::new(
            FooterHint::Shortcuts,
            "",
            "",
            "",
            "",
            "",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        );

        let rendered = text(&render_footer(80, data));

        assert!(rendered.contains("? for shortcuts"));
        assert!(rendered.contains("100% context left"));
        assert!(
            rendered.ends_with("  "),
            "Codex keeps the right-side context off the terminal edge: {rendered:?}"
        );
    }

    #[test]
    fn footer_preserves_context_when_cwd_is_long() {
        let sep = std::path::MAIN_SEPARATOR;
        let cwd = format!(
            "{sep}home{sep}alex{sep}projects{sep}kcoder{sep}crates{sep}kcoder_repl{sep}src"
        );
        let data = FooterData::new(
            FooterHint::Shortcuts,
            &cwd,
            "",
            "MiniMax-M3",
            "MiniMax",
            "",
            false,
            2_000,
            200_000,
            &KCODER_UI_THEME,
        );

        let rendered = text(&render_footer(80, data));

        assert!(rendered.contains("? for shortcuts"));
        assert!(
            rendered.contains("99% context left"),
            "right context should survive path truncation: {rendered:?}"
        );
    }

    #[test]
    fn footer_renders_shortcuts_and_context() {
        let data = FooterData::new(
            FooterHint::Shortcuts,
            "/repo",
            "",
            "MiniMax-M3",
            "MiniMax",
            "",
            false,
            2_000,
            200_000,
            &KCODER_UI_THEME,
        );

        let rendered = text(&render_footer(160, data));

        assert!(rendered.contains("? for shortcuts"));
        assert!(!rendered.contains("ctrl + g to edit in external editor"));
        assert!(!rendered.contains("⌥ + t to view transcript"));
        assert!(!rendered.contains("esc esc to edit previous message"));
        assert!(rendered.contains("MiniMax/MiniMax-M3"));
        assert!(rendered.contains("/repo"));
        assert!(rendered.contains("99% context left"));
    }

    #[test]
    fn footer_uses_codex_semantic_status_colors() {
        let data = FooterData::new(
            FooterHint::None,
            "/repo",
            "Ready",
            "model",
            "provider",
            "session",
            false,
            2_000,
            200_000,
            &KCODER_UI_THEME,
        );
        let widget = FooterWidget::new(data);
        let line = widget.right_line(160);
        let style_for = |content: &str| {
            line.spans
                .iter()
                .find(|span| span.content.contains(content))
                .map(|span| span.style)
                .unwrap_or_else(|| panic!("缺少状态栏字段：{content}"))
        };

        assert_eq!(style_for("provider/model").fg, Some(Color::Cyan));
        assert_eq!(style_for("Ready").fg, Some(Color::Cyan));
        assert_eq!(style_for("session").fg, Some(Color::Cyan));
        assert_eq!(style_for("/repo").fg, Some(Color::Green));
        assert_eq!(style_for("99% context left").fg, Some(Color::Green));
    }

    #[test]
    fn footer_prioritizes_context_over_long_cwd_when_space_is_tight() {
        let sep = std::path::MAIN_SEPARATOR;
        let cwd = format!("{sep}home{sep}alex{sep}projects{sep}kcoder{sep}crates{sep}kcoder_repl");
        let data = FooterData::new(
            FooterHint::None,
            &cwd,
            "",
            "",
            "",
            "",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        );

        let rendered = text(&render_footer(34, data));

        assert!(rendered.contains("100% context left"));
        assert!(
            UnicodeWidthStr::width(rendered.trim_end()) <= 32,
            "footer content should stay inside the Codex side insets: {rendered:?}"
        );
    }

    #[test]
    fn footer_renders_plan_mode_with_shortcut_hint() {
        let data = FooterData::new(
            FooterHint::Shortcuts,
            "",
            "",
            "",
            "",
            "",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        )
        .with_mode_label("Plan mode")
        .with_mode_switch_enabled(true);

        let rendered = text(&render_footer(80, data));

        assert!(rendered.contains(&format!(
            "? for shortcuts{UI_SEPARATOR}Plan mode (shift+tab to cycle)"
        )));
    }

    #[test]
    fn footer_renders_plan_mode_without_instruction_hint() {
        let data = FooterData::new(
            FooterHint::None,
            "",
            "",
            "",
            "",
            "",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        )
        .with_mode_label("Plan mode")
        .with_mode_switch_enabled(true);

        let rendered = text(&render_footer(80, data));

        assert!(rendered.contains("Plan mode (shift+tab to cycle)"));
        assert!(!rendered.contains("? for shortcuts"));
    }

    #[test]
    fn footer_renders_plan_mode_with_queue_hint() {
        let data = FooterData::new(
            FooterHint::QueueMessage,
            "",
            "",
            "",
            "",
            "",
            true,
            0,
            0,
            &KCODER_UI_THEME,
        )
        .with_mode_label("Plan mode")
        .with_mode_switch_enabled(true);

        let rendered = text(&render_footer(120, data));

        assert!(rendered.contains(&format!("tab to queue message{UI_SEPARATOR}Plan mode")));
        assert!(!rendered.contains("shift+tab to cycle"));
    }

    #[test]
    fn footer_plan_mode_drops_shortcut_before_cycle_hint() {
        let data = FooterData::new(
            FooterHint::Shortcuts,
            "",
            "",
            "",
            "",
            "",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        )
        .with_mode_label("Plan mode")
        .with_mode_switch_enabled(true);

        let rendered = text(&render_footer(60, data));

        assert!(!rendered.contains("? for shortcuts"));
        assert!(rendered.contains("Plan mode (shift+tab to cycle)"));
        assert!(rendered.contains("100% context left"));
    }

    #[test]
    fn footer_plan_mode_keeps_cycle_hint_before_context() {
        let data = FooterData::new(
            FooterHint::Shortcuts,
            "",
            "",
            "",
            "",
            "",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        )
        .with_mode_label("Plan mode")
        .with_mode_switch_enabled(true);

        let rendered = text(&render_footer(44, data));

        assert!(!rendered.contains("? for shortcuts"));
        assert!(rendered.contains("Plan mode (shift+tab to cycle)"));
        assert!(!rendered.contains("100% context left"));
    }

    #[test]
    fn footer_plan_mode_drops_cycle_hint_when_narrow() {
        let data = FooterData::new(
            FooterHint::Shortcuts,
            "",
            "",
            "",
            "",
            "",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        )
        .with_mode_label("Plan mode")
        .with_mode_switch_enabled(true);

        let rendered = text(&render_footer(26, data));

        assert!(rendered.contains("Plan mode"));
        assert!(!rendered.contains("shift+tab to cycle"));
        assert!(!rendered.contains("100% context left"));
    }

    #[test]
    fn footer_plan_queue_hint_collapses() {
        let data = FooterData::new(
            FooterHint::QueueMessage,
            "",
            "",
            "",
            "",
            "",
            false,
            100,
            5000,
            &KCODER_UI_THEME,
        )
        .with_mode_label("Plan mode")
        .with_mode_switch_enabled(true);

        let short_with_context = text(&render_footer(50, data));
        assert!(short_with_context.contains(&format!("tab to queue{UI_SEPARATOR}Plan mode")));
        assert!(short_with_context.contains("98% context left"));
        assert!(!short_with_context.contains("queue message"));

        let message_without_context = text(&render_footer(40, data));
        assert!(
            message_without_context
                .contains(&format!("tab to queue message{UI_SEPARATOR}Plan mode")),
            "{message_without_context:?}"
        );
        assert!(!message_without_context.contains("98% context left"));

        let short_without_context = text(&render_footer(30, data));
        assert!(short_without_context.contains(&format!("tab to queue{UI_SEPARATOR}Plan mode")));
        assert!(!short_without_context.contains("queue message"));
        assert!(!short_without_context.contains("98% context left"));

        let mode_only = text(&render_footer(20, data));
        assert!(mode_only.contains("Plan mode"));
        assert!(!mode_only.contains("tab to queue"));
    }

    #[test]
    fn footer_context_line_reports_remaining_context() {
        let data = FooterData::new(
            FooterHint::None,
            "",
            "",
            "",
            "",
            "",
            false,
            1700,
            2000,
            &KCODER_UI_THEME,
        );

        let rendered = text(&render_footer(40, data));

        assert!(rendered.contains("15% context left"));
        assert!(!rendered.contains("85%"));
    }

    #[test]
    fn footer_context_line_uses_physical_remaining_percentage() {
        let twelve_percent_used = FooterData::new(
            FooterHint::None,
            "",
            "",
            "",
            "",
            "",
            false,
            12_000,
            100_000,
            &KCODER_UI_THEME,
        );
        let fifty_six_percent_used = FooterData::new(
            FooterHint::None,
            "",
            "",
            "",
            "",
            "",
            false,
            56_000,
            100_000,
            &KCODER_UI_THEME,
        );

        assert!(text(&render_footer(40, twelve_percent_used)).contains("88% context left"));
        assert!(text(&render_footer(40, fifty_six_percent_used)).contains("44% context left"));
    }

    #[test]
    fn footer_defaults_to_full_context_when_usage_is_unknown() {
        let data = FooterData::new(
            FooterHint::Shortcuts,
            "",
            "",
            "",
            "",
            "",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        );

        let rendered = text(&render_footer(80, data));

        assert!(rendered.contains("? for shortcuts"));
        assert!(rendered.contains("100% context left"));
    }

    #[test]
    fn footer_reports_used_tokens_when_context_total_is_unknown() {
        let data = FooterData::new(
            FooterHint::None,
            "",
            "",
            "",
            "",
            "",
            false,
            123_456,
            0,
            &KCODER_UI_THEME,
        );

        let rendered = text(&render_footer(40, data));

        assert!(rendered.contains("123K used"));
        assert!(!rendered.contains("context left"));
    }

    #[test]
    fn footer_token_counts_match_codex_compact_format() {
        assert_eq!(format_tokens_compact(999), "999");
        assert_eq!(format_tokens_compact(1_250), "1.25K");
        assert_eq!(format_tokens_compact(12_500), "12.5K");
        assert_eq!(format_tokens_compact(123_456), "123K");
        assert_eq!(format_tokens_compact(1_200_000), "1.2M");
    }

    #[test]
    fn footer_renders_session_title_when_present() {
        let data = FooterData::new(
            FooterHint::None,
            "/repo",
            "Project Phoenix",
            "model",
            "provider",
            "",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        );

        let rendered = text(&render_footer(120, data));

        assert!(rendered.contains("Project Phoenix"));
        assert!(rendered.contains("/repo"));
    }

    #[test]
    fn footer_queue_hint_shortens_before_hiding_context() {
        let data = FooterData::new(
            FooterHint::QueueMessage,
            "",
            "",
            "model",
            "provider",
            "",
            true,
            0,
            0,
            &KCODER_UI_THEME,
        );

        let rendered = text(&render_footer(41, data));

        assert!(rendered.contains("tab to queue"));
        assert!(rendered.contains("100% context left"));
        assert!(!rendered.contains("queue message"));
    }

    #[test]
    fn footer_renders_quit_reminder() {
        let data = FooterData::new(
            FooterHint::QuitReminder(key_hint::ctrl(KeyCode::Char('c'))),
            "/repo",
            "",
            "model",
            "provider",
            "",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        );

        let rendered = text(&render_footer(80, data));

        assert!(rendered.contains("ctrl + c again to quit"));
        assert!(!rendered.contains("provider/model"));
    }

    #[test]
    fn footer_renders_edit_previous_hint() {
        let data = FooterData::new(
            FooterHint::EditPrevious,
            "/repo",
            "",
            "model",
            "provider",
            "",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        );

        let rendered = text(&render_footer(80, data));

        assert!(rendered.contains("esc esc to edit previous message"));
    }

    #[test]
    fn footer_renders_edit_previous_primed_hint() {
        let data = FooterData::new(
            FooterHint::EditPreviousPrimed,
            "/repo",
            "",
            "model",
            "provider",
            "",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        );

        let rendered = text(&render_footer(80, data));

        assert!(rendered.contains("esc again to edit previous message"));
    }

    #[test]
    fn footer_history_search_action_hints_use_expected_style() {
        let data = FooterData::new(
            FooterHint::HistorySearch {
                query: "c",
                has_match: true,
            },
            "/repo",
            "",
            "model",
            "provider",
            "",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        );
        let hint = data.hint;
        let widget = FooterWidget::new(data);
        let line = widget.hint_line(hint, false).unwrap();

        assert_eq!(
            line_span_texts(&line),
            vec![
                "reverse-i-search: ".to_string(),
                "c".to_string(),
                "  ".to_string(),
                "enter".to_string(),
                " accept".to_string(),
                UI_SEPARATOR.to_string(),
                "esc".to_string(),
                " cancel".to_string()
            ]
        );
        assert_eq!(line.spans[1].style.fg, Some(Color::Cyan));
        for idx in [3, 6] {
            let style = line.spans[idx].style;
            assert_eq!(style.fg, Some(Color::Cyan));
            assert!(style.add_modifier.contains(ratatui::style::Modifier::BOLD));
            assert!(style.sub_modifier.contains(ratatui::style::Modifier::DIM));
        }
    }

    #[test]
    fn footer_history_search_reports_no_match() {
        let data = FooterData::new(
            FooterHint::HistorySearch {
                query: "zzz",
                has_match: false,
            },
            "",
            "",
            "",
            "",
            "",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        );
        let rendered = text(&render_footer(80, data));

        assert!(rendered.contains("reverse-i-search: zzz  no match"));
        assert!(!rendered.contains("enter accept"));
    }

    #[test]
    fn footer_shell_mode_uses_error_accent() {
        let data = FooterData::new(
            FooterHint::ShellMode,
            "",
            "",
            "",
            "",
            "",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        );
        let buf = render_footer(80, data);
        let rendered = text(&buf);
        let x = rendered.find("Shell mode").expect("shell mode label");

        assert_eq!(buf[(x as u16, 0)].fg, KCODER_UI_THEME.error_fg);
    }

    #[test]
    fn shortcut_overlay_lines_render_multiline_help() {
        let rendered = shortcut_overlay_lines_with_mode_switch(false, false, false)
            .iter()
            .map(line_text)
            .collect::<Vec<_>>()
            .join("\n");

        assert!(rendered.contains("/ for commands"));
        assert!(rendered.contains("shift + enter for newline"));
        assert!(!rendered.contains("ctrl + j for newline"));
        assert!(rendered.contains("tab to submit message"));
        assert!(!rendered.contains("@ for file paths"));
        assert!(rendered.contains("ctrl + c to exit"));
        assert!(!rendered.contains("ctrl + c to interrupt"));
        let image_paste_key = if cfg!(windows) {
            key_hint::alt(KeyCode::Char('v'))
        } else {
            key_hint::ctrl(KeyCode::Char('v'))
        };
        assert!(rendered.contains(&format!(
            "{} to paste images",
            image_paste_key.display_label()
        )));
        assert!(rendered.contains("ctrl + g to edit in external editor"));
        assert!(rendered.contains("⌥ + t to expand tools"));
        assert!(rendered.contains("customize shortcuts with /keymap"));
    }

    #[test]
    fn footer_shortcut_overlay_shows_mode_switch_when_enabled() {
        let rendered = shortcut_overlay_lines_with_mode_switch(false, true, false)
            .iter()
            .map(line_text)
            .collect::<Vec<_>>()
            .join("\n");

        assert!(rendered.contains("shift + tab to change mode"));
        assert!(rendered.contains("⌥ + t to expand tools"));
    }

    #[test]
    fn footer_shortcut_overlay_can_render_ctrl_j_newline_fallback() {
        let rendered =
            shortcut_overlay_lines(false, false, key_hint::ctrl(KeyCode::Char('j')), false)
                .iter()
                .map(line_text)
                .collect::<Vec<_>>()
                .join("\n");

        assert!(rendered.contains("ctrl + j for newline"));
        assert!(!rendered.contains("shift + enter for newline"));
    }

    #[test]
    fn footer_shortcut_overlay_uses_esc_again_when_backtrack_hint_is_active() {
        let rendered = shortcut_overlay_lines_with_mode_switch(false, false, true)
            .iter()
            .map(line_text)
            .collect::<Vec<_>>()
            .join("\n");

        assert!(rendered.contains("esc again to edit previous message"));
        assert!(!rendered.contains("esc esc to edit previous message"));
    }

    #[test]
    fn footer_shortcut_overlay_columns_use_codex_padding() {
        let lines = shortcut_overlay_columns(vec![Line::from("a"), Line::from("b")]);

        assert_eq!(line_text(&lines[0]), "a        b");
    }

    #[test]
    fn footer_shortcut_overlay_shows_queue_hint_while_streaming() {
        let rendered = shortcut_overlay_lines_with_mode_switch(true, false, false)
            .iter()
            .map(line_text)
            .collect::<Vec<_>>()
            .join("\n");

        assert!(rendered.contains("tab to queue message"));
        assert!(!rendered.contains("tab to submit message"));
        assert!(rendered.contains("ctrl + c to interrupt"));
        assert!(!rendered.contains("ctrl + c to exit"));
    }

    #[test]
    fn footer_status_line_does_not_overflow() {
        let data = FooterData::new(
            FooterHint::None,
            "/a/very/long/repository/path",
            "",
            "very-long-model-name",
            "provider",
            "queued 12",
            false,
            1900,
            2000,
            &KCODER_UI_THEME,
        );

        let rendered = text(&render_footer(24, data));

        assert!(UnicodeWidthStr::width(rendered.trim_end()) <= 22);
        assert!(rendered.contains("context left"));
    }

    #[test]
    fn footer_shows_the_current_spinner_frame_while_working() {
        let data = FooterData::new(
            FooterHint::Interrupt,
            "/repo",
            "",
            "MiniMax-M3",
            "MiniMax",
            "Running bash: sleep 10",
            true,
            0,
            200000,
            &KCODER_UI_THEME,
        )
        .with_activity_elapsed(Duration::from_millis(160))
        .with_activity_status("▁▃▆█", "Running bash", false);

        let rendered = text(&render_footer(160, data));

        assert!(rendered.contains("▁▃▆█ Running bash"), "{rendered}");
        assert!(rendered.contains("0s"), "{rendered}");
        assert!(rendered.contains("Running bash: sleep 10"), "{rendered}");
        assert!(rendered.contains("esc interrupt"), "{rendered}");
    }

    #[test]
    fn footer_prioritizes_non_interruptible_activity_over_metadata() {
        let data = FooterData::new(
            FooterHint::Activity,
            "/repo",
            "",
            "MiniMax-M3",
            "MiniMax",
            "agents 1 running",
            true,
            0,
            200000,
            &KCODER_UI_THEME,
        )
        .with_activity_elapsed(Duration::from_secs(12))
        .with_activity_status(
            "◈",
            "Turn 2/max 60 · Running read · Inspect scheduler",
            false,
        );

        let rendered = text(&render_footer(100, data));

        let expected = if cfg!(windows) {
            "◈ Turn 2/max 60 - Running read"
        } else {
            "◈ Turn 2/max 60 · Running read"
        };
        assert!(rendered.contains(expected), "{rendered}");
        assert!(rendered.contains("12s"), "{rendered}");
        assert!(!rendered.contains("esc interrupt"), "{rendered}");
    }

    #[test]
    fn footer_transient_status_is_visible_on_left_even_when_metadata_is_crowded() {
        let data = FooterData::new(
            FooterHint::TransientStatus {
                text: "Copied selected text to clipboard",
            },
            "/a/very/long/repository/path",
            "very long session title",
            "very-long-model-name",
            "provider",
            "",
            false,
            1900,
            2000,
            &KCODER_UI_THEME,
        );

        let rendered = text(&render_footer(36, data));

        assert!(UnicodeWidthStr::width(rendered.trim_end()) <= 34);
        assert!(rendered.contains("Copied selected text"), "{rendered}");
    }
}

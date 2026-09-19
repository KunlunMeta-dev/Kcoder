//! Preview for queued follow-up inputs.

use crossterm::event::KeyCode;
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style, Stylize},
    text::{Line, Span, Text},
    widgets::{Paragraph, Widget},
};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::key_hint;
use crate::render::wrapping::adaptive_word_wrap_plain_line;
use crate::theme::UiTheme;

const PREVIEW_LINE_LIMIT: usize = 3;
const PREVIEW_MAX_VISIBLE_MESSAGES_PER_SECTION: usize = 3;

pub(crate) struct PendingInputPreview<'a> {
    pending_steers: Vec<String>,
    rejected_steers: Vec<String>,
    queued_messages: Vec<String>,
    edit_binding: Option<key_hint::KeyBinding>,
    interrupt_binding: Option<key_hint::KeyBinding>,
    ui_theme: &'a UiTheme,
}

impl<'a> PendingInputPreview<'a> {
    pub(crate) fn new(queued_messages: Vec<String>, ui_theme: &'a UiTheme) -> Self {
        Self {
            pending_steers: Vec::new(),
            rejected_steers: Vec::new(),
            queued_messages,
            edit_binding: Some(key_hint::alt(KeyCode::Up)),
            interrupt_binding: Some(key_hint::plain(KeyCode::Esc)),
            ui_theme,
        }
    }

    pub(crate) fn with_steers(
        mut self,
        pending_steers: Vec<String>,
        rejected_steers: Vec<String>,
    ) -> Self {
        self.pending_steers = pending_steers;
        self.rejected_steers = rejected_steers;
        self
    }

    #[cfg(test)]
    pub(crate) fn set_edit_binding(&mut self, binding: Option<key_hint::KeyBinding>) {
        self.edit_binding = binding;
    }

    #[cfg(test)]
    pub(crate) fn set_interrupt_binding(&mut self, binding: Option<key_hint::KeyBinding>) {
        self.interrupt_binding = binding;
    }

    pub(crate) fn lines(&self, width: u16) -> Vec<Line<'static>> {
        if (self.pending_steers.is_empty()
            && self.rejected_steers.is_empty()
            && self.queued_messages.is_empty())
            || width < 4
        {
            return Vec::new();
        }

        let theme = self.ui_theme;
        let mut lines = Vec::new();

        if !self.pending_steers.is_empty() {
            let mut header = vec![Span::raw("Messages to be submitted after next tool call")];
            if let Some(interrupt_binding) = self.interrupt_binding {
                header.extend([
                    Span::styled(" (press ", Style::default().fg(theme.text_dim)),
                    interrupt_binding.into(),
                    Span::styled(
                        " to interrupt and send immediately)",
                        Style::default().fg(theme.text_dim),
                    ),
                ]);
            }
            push_section(
                &mut lines,
                width,
                header,
                &self.pending_steers,
                false,
                "pending",
                theme,
            );
        }

        if !self.rejected_steers.is_empty() {
            push_section_gap(&mut lines);
            push_section(
                &mut lines,
                width,
                vec![Span::styled(
                    "Messages to be submitted at end of turn",
                    Style::default(),
                )],
                &self.rejected_steers,
                false,
                "deferred",
                theme,
            );
        }

        if !self.queued_messages.is_empty() {
            push_section_gap(&mut lines);
            push_section(
                &mut lines,
                width,
                vec![Span::styled("Queued follow-up inputs", Style::default())],
                &self.queued_messages,
                true,
                "queued",
                theme,
            );
        }

        if !self.queued_messages.is_empty()
            && let Some(edit_binding) = self.edit_binding
        {
            lines.push(
                Line::from(vec![
                    Span::raw("    "),
                    edit_binding.into(),
                    Span::styled(
                        " edit last queued message",
                        Style::default().fg(theme.text_dim),
                    ),
                ])
                .dim(),
            );
        }

        lines
    }
}

impl crate::widgets::Renderable for PendingInputPreview<'_> {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        Paragraph::new(Text::from(self.lines(area.width))).render(area, buf);
    }

    fn desired_height(&self, width: u16) -> u16 {
        self.lines(width).len() as u16
    }
}

fn section_header_lines(
    width: u16,
    header_spans: Vec<Span<'static>>,
    theme: &UiTheme,
) -> Vec<Line<'static>> {
    wrap_section_header(header_spans, width as usize, theme)
}

fn push_section_gap(lines: &mut Vec<Line<'static>>) {
    if !lines.is_empty() {
        lines.push(Line::from(""));
    }
}

fn push_section(
    lines: &mut Vec<Line<'static>>,
    width: u16,
    header_spans: Vec<Span<'static>>,
    messages: &[String],
    italic: bool,
    overflow_kind: &'static str,
    theme: &UiTheme,
) {
    lines.extend(section_header_lines(width, header_spans, theme));
    let mut content_style = Style::default().fg(theme.text_muted);
    if italic {
        content_style = content_style.add_modifier(Modifier::ITALIC);
    }
    let mut overflow_style = Style::default().fg(theme.text_dim);
    if italic {
        overflow_style = overflow_style.add_modifier(Modifier::ITALIC);
    }
    for message in messages
        .iter()
        .take(PREVIEW_MAX_VISIBLE_MESSAGES_PER_SECTION)
    {
        let wrapped = wrap_text_with_indents(
            message,
            width as usize,
            "  ↳ ",
            "    ",
            content_style,
            Style::default().fg(theme.text_dim),
        );
        push_truncated_preview_lines(lines, wrapped, overflow_style);
    }
    let hidden = messages
        .len()
        .saturating_sub(PREVIEW_MAX_VISIBLE_MESSAGES_PER_SECTION);
    if hidden > 0 {
        lines.push(Line::from(vec![
            Span::raw("    "),
            Span::styled(
                format!("+{hidden} more {overflow_kind}"),
                Style::default().fg(theme.text_dim),
            ),
        ]));
    }
}

fn push_truncated_preview_lines(
    lines: &mut Vec<Line<'static>>,
    wrapped: Vec<Line<'static>>,
    overflow_style: Style,
) {
    let wrapped_len = wrapped.len();
    lines.extend(wrapped.into_iter().take(PREVIEW_LINE_LIMIT));
    if wrapped_len > PREVIEW_LINE_LIMIT {
        lines.push(Line::from(vec![
            Span::raw("    "),
            Span::styled("…", overflow_style),
        ]));
    }
}

fn wrap_text_with_indents(
    text: &str,
    width: usize,
    initial_indent: &str,
    subsequent_indent: &str,
    content_style: Style,
    indent_style: Style,
) -> Vec<Line<'static>> {
    let width = width.max(1);
    let mut lines = Vec::new();
    let mut first = true;
    for raw_line in text.lines().chain((text.is_empty()).then_some("")) {
        let indent = if first {
            initial_indent
        } else {
            subsequent_indent
        };
        let content_width = width.saturating_sub(UnicodeWidthStr::width(indent)).max(1);
        let wrapped_lines = if should_preserve_source_spacing(raw_line) {
            wrap_preserving_display_width(raw_line, content_width)
        } else {
            adaptive_word_wrap_plain_line(raw_line, content_width)
        };
        for (idx, wrapped) in wrapped_lines.into_iter().enumerate() {
            let indent = if first && idx == 0 {
                initial_indent
            } else {
                subsequent_indent
            };
            lines.push(Line::from(vec![
                Span::styled(indent.to_string(), indent_style),
                Span::styled(wrapped, content_style),
            ]));
        }
        first = false;
    }
    lines
}

fn should_preserve_source_spacing(line: &str) -> bool {
    line.chars().next().is_some_and(char::is_whitespace)
        || line.contains('\t')
        || line.contains("  ")
}

fn wrap_preserving_display_width(line: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    if line.is_empty() {
        return vec![String::new()];
    }

    let mut out = Vec::new();
    let mut current = String::new();
    let mut used = 0usize;
    for ch in line.chars() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if !current.is_empty() && used.saturating_add(ch_width) > width {
            out.push(std::mem::take(&mut current));
            used = 0;
        }
        current.push(ch);
        used = used.saturating_add(ch_width);
    }
    if !current.is_empty() || out.is_empty() {
        out.push(current);
    }
    out
}

#[derive(Clone)]
struct HeaderToken {
    text: String,
    style: Style,
}

fn wrap_section_header(
    header_spans: Vec<Span<'static>>,
    width: usize,
    theme: &UiTheme,
) -> Vec<Line<'static>> {
    let width = width.max(1);
    let mut lines = Vec::new();
    let tokens = header_tokens(header_spans);
    let mut first_line = true;
    let (mut row, mut used) = header_prefix(first_line, theme);
    let mut has_body = false;

    for token in tokens {
        let mut remaining = token.text;
        while !remaining.is_empty() {
            let remaining_width = UnicodeWidthStr::width(remaining.as_str());
            let separator_width = usize::from(has_body);
            if used
                .saturating_add(separator_width)
                .saturating_add(remaining_width)
                <= width
            {
                if has_body {
                    row.push(Span::styled(" ", token.style));
                    used = used.saturating_add(1);
                }
                row.push(Span::styled(remaining, token.style));
                has_body = true;
                used = used.saturating_add(remaining_width);
                break;
            }

            if has_body {
                lines.push(Line::from(std::mem::take(&mut row)));
                first_line = false;
                (row, used) = header_prefix(first_line, theme);
                has_body = false;
                continue;
            }

            let available = width.saturating_sub(used).max(1);
            let (head, tail) = split_display_prefix(&remaining, available);
            if !head.is_empty() {
                used = used.saturating_add(UnicodeWidthStr::width(head.as_str()));
                row.push(Span::styled(head, token.style));
                has_body = true;
            }

            if tail.is_empty() {
                break;
            }

            lines.push(Line::from(std::mem::take(&mut row)));
            first_line = false;
            (row, used) = header_prefix(first_line, theme);
            has_body = false;
            remaining = tail;
        }
    }

    lines.push(Line::from(row));
    lines
}

fn header_prefix(first_line: bool, theme: &UiTheme) -> (Vec<Span<'static>>, usize) {
    let prefix = if first_line { "• " } else { "  " };
    (
        vec![Span::styled(prefix, Style::default().fg(theme.text_dim))],
        UnicodeWidthStr::width(prefix),
    )
}

fn header_tokens(spans: Vec<Span<'static>>) -> Vec<HeaderToken> {
    spans
        .into_iter()
        .flat_map(|span| {
            let style = span.style;
            span.content
                .split_whitespace()
                .map(|word| HeaderToken {
                    text: word.to_string(),
                    style,
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn split_display_prefix(text: &str, max_width: usize) -> (String, String) {
    let mut used = 0usize;
    let mut cut = 0usize;

    for (idx, ch) in text.char_indices() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if cut > 0 && used.saturating_add(ch_width) > max_width {
            break;
        }

        if cut == 0 && ch_width > max_width {
            cut = idx + ch.len_utf8();
            break;
        }

        used = used.saturating_add(ch_width);
        cut = idx + ch.len_utf8();
    }

    (text[..cut].to_string(), text[cut..].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::KCODER_UI_THEME;
    use crate::widgets::Renderable;

    fn render_preview(width: u16, preview: &PendingInputPreview<'_>) -> String {
        let height = preview.desired_height(width);
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));
        preview.render(buf.area, &mut buf);
        buf.content
            .chunks(width as usize)
            .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn preview_is_empty_without_queued_messages() {
        let preview = PendingInputPreview::new(Vec::new(), &KCODER_UI_THEME);
        assert_eq!(preview.desired_height(80), 0);
        assert!(preview.lines(80).is_empty());
    }

    #[test]
    fn preview_renders_queued_messages_and_edit_hint() {
        let preview = PendingInputPreview::new(
            vec!["follow up after this turn".to_string()],
            &KCODER_UI_THEME,
        );
        let rendered = render_preview(80, &preview);

        assert!(rendered.contains("Queued follow-up inputs"));
        assert!(!rendered.contains("1 pending"));
        assert!(rendered.contains("↳ follow up after this turn"));
        assert!(rendered.contains("⌥ + ↑ edit last queued message"));
    }

    #[test]
    fn preview_header_uses_codex_plain_weight() {
        let preview = PendingInputPreview::new(vec!["follow up".to_string()], &KCODER_UI_THEME);

        let lines = preview.lines(80);
        let header = lines.first().expect("header line");

        assert_eq!(
            header.spans.first().unwrap().style.fg,
            Some(KCODER_UI_THEME.text_dim)
        );
        assert!(
            header
                .spans
                .iter()
                .skip(1)
                .any(|span| span.content.contains("Queued"))
        );
        for span in header.spans.iter().skip(1) {
            assert_eq!(span.style.fg, None);
            assert!(!span.style.add_modifier.contains(Modifier::BOLD));
        }
    }

    #[test]
    fn preview_wraps_and_caps_each_message() {
        let preview = PendingInputPreview::new(
            vec!["one two three four five six seven eight nine ten eleven twelve".to_string()],
            &KCODER_UI_THEME,
        );
        let lines = preview.lines(18);

        assert!(lines.len() <= 2 + PREVIEW_LINE_LIMIT + 1 + 1);
        let rendered = render_preview(18, &preview);
        assert!(rendered.contains("↳"));
        assert!(rendered.contains("…"));
    }

    #[test]
    fn preview_caps_visible_message_count_per_section() {
        let preview = PendingInputPreview::new(
            (0..8)
                .map(|idx| format!("queued follow-up {idx}"))
                .collect(),
            &KCODER_UI_THEME,
        );
        let rendered = render_preview(80, &preview);

        assert!(rendered.contains("queued follow-up 0"));
        assert!(rendered.contains("queued follow-up 1"));
        assert!(rendered.contains("queued follow-up 2"));
        assert!(!rendered.contains("queued follow-up 3"));
        assert!(rendered.contains("+5 more queued"));
        assert!(rendered.contains("edit last queued message"));
        assert!(preview.desired_height(80) <= 6);
    }

    #[test]
    fn preview_preserves_queued_message_leading_spaces() {
        let preview =
            PendingInputPreview::new(vec!["  indented code".to_string()], &KCODER_UI_THEME);

        let rendered = render_preview(80, &preview);

        assert!(rendered.contains("↳   indented code"), "{rendered}");
        assert!(!rendered.contains("↳ indented code"), "{rendered}");
    }

    #[test]
    fn preview_preserves_queued_message_repeated_spaces() {
        let preview = PendingInputPreview::new(vec!["alpha  beta".to_string()], &KCODER_UI_THEME);

        let rendered = render_preview(80, &preview);

        assert!(rendered.contains("alpha  beta"), "{rendered}");
        assert!(!rendered.contains("alpha beta"), "{rendered}");
    }

    #[test]
    fn queued_overflow_ellipsis_is_italic() {
        let preview = PendingInputPreview::new(
            vec!["one two three four five six seven eight nine ten eleven twelve".to_string()],
            &KCODER_UI_THEME,
        );

        let ellipsis_span = preview
            .lines(18)
            .into_iter()
            .flat_map(|line| line.spans)
            .find(|span| span.content == "…")
            .expect("overflow ellipsis");

        assert!(
            ellipsis_span.style.add_modifier.contains(Modifier::ITALIC),
            "queued-message overflow ellipsis should match italic queued text"
        );
    }

    #[test]
    fn pending_overflow_ellipsis_is_not_italic() {
        let mut preview = PendingInputPreview::new(Vec::new(), &KCODER_UI_THEME);
        preview
            .pending_steers
            .push("one two three four five six seven eight nine ten eleven twelve".to_string());

        let ellipsis_span = preview
            .lines(18)
            .into_iter()
            .flat_map(|line| line.spans)
            .find(|span| span.content == "…")
            .expect("overflow ellipsis");

        assert!(
            !ellipsis_span.style.add_modifier.contains(Modifier::ITALIC),
            "pending-steer overflow ellipsis should stay non-italic"
        );
    }

    #[test]
    fn preview_keeps_url_like_tokens_on_one_row() {
        let preview = PendingInputPreview::new(
            vec![
                "example.test/api/v1/projects/alpha/releases/2026-02-17/builds/1234567890"
                    .to_string(),
            ],
            &KCODER_UI_THEME,
        );

        assert_eq!(preview.desired_height(36), 3);
        let rendered = render_preview(36, &preview);

        assert!(!rendered.contains('…'));
    }

    #[test]
    fn preview_pending_steer_uses_interrupt_hint_without_edit_hint() {
        let mut preview = PendingInputPreview::new(Vec::new(), &KCODER_UI_THEME);
        preview.pending_steers.push("Please continue.".to_string());

        let rendered = render_preview(96, &preview);

        assert!(rendered.contains("Messages to be submitted after next tool call"));
        assert!(rendered.contains("esc to interrupt and send immediately"));
        assert!(rendered.contains("↳ Please continue."));
        assert!(!rendered.contains("edit last queued message"));
    }

    #[test]
    fn preview_wraps_pending_steer_header_without_truncating_hint() {
        let mut preview = PendingInputPreview::new(Vec::new(), &KCODER_UI_THEME);
        preview.pending_steers.push("Please continue.".to_string());

        let rendered = render_preview(32, &preview);

        assert!(rendered.contains("Messages to be submitted after"));
        assert!(rendered.contains("next tool call (press esc to"));
        assert!(rendered.contains("interrupt and send"));
        assert!(rendered.contains("immediately)"));
        assert!(!rendered.contains('…'));
    }

    #[test]
    fn preview_can_remap_pending_steer_interrupt_hint() {
        let mut preview = PendingInputPreview::new(Vec::new(), &KCODER_UI_THEME);
        preview.pending_steers.push("Please continue.".to_string());
        preview.set_interrupt_binding(Some(key_hint::plain(KeyCode::F(12))));

        let rendered = render_preview(96, &preview);

        assert!(rendered.contains("f12 to interrupt and send immediately"));
    }

    #[test]
    fn preview_renders_pending_and_rejected_steers_before_queued_messages() {
        let mut preview = PendingInputPreview::new(
            vec!["Queued follow-up question".to_string()],
            &KCODER_UI_THEME,
        );
        preview.pending_steers.push("Please continue.".to_string());
        preview
            .rejected_steers
            .push("Retry this at turn end.".to_string());

        let rendered = render_preview(96, &preview);
        let pending_idx = rendered
            .find("Messages to be submitted after next tool call")
            .expect("pending header");
        let rejected_idx = rendered
            .find("Messages to be submitted at end of turn")
            .expect("rejected header");
        let queued_idx = rendered
            .find("Queued follow-up inputs")
            .expect("queued header");

        assert!(pending_idx < rejected_idx);
        assert!(rejected_idx < queued_idx);
        assert!(rendered.contains("↳ Please continue."));
        assert!(rendered.contains("↳ Retry this at turn end."));
        assert!(rendered.contains("↳ Queued follow-up question"));
        assert!(rendered.contains("⌥ + ↑ edit last queued message"));
    }

    #[test]
    fn preview_can_hide_edit_hint() {
        let mut preview = PendingInputPreview::new(vec!["queued".to_string()], &KCODER_UI_THEME);
        preview.set_edit_binding(None);

        let rendered = render_preview(40, &preview);

        assert!(!rendered.contains("edit last queued message"));
    }
}

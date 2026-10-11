#![allow(dead_code)]

//! Compact footer/status-line widget for KCoder.
//!
//! The type names are kept for compatibility with the existing app wiring. The
//! renderer places a short instructional hint on the left and ambient context
//! on the right.

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Widget},
};
use unicode_width::UnicodeWidthStr;

use crate::line_truncation::truncate_line_with_ellipsis_if_overflow;
use crate::text_formatting::center_truncate_path;
use crate::theme::UiTheme;
use crate::widgets::{span_width, truncate_to_width};

const CONTEXT_WARNING_THRESHOLD_PERCENT: f64 = 85.0;
const CONTEXT_CRITICAL_THRESHOLD_PERCENT: f64 = 95.0;
const CONTEXT_SIGNAL_WIDTH: usize = 4;

/// Data required to render the header bar.
pub struct HeaderData<'a> {
    pub brand: &'a str,
    pub subtitle: &'a str,
    pub cwd: &'a str,
    pub model: &'a str,
    pub provider: &'a str,
    pub background_status: &'a str,
    pub is_streaming: bool,
    pub context_used: usize,
    pub context_total: usize,
    pub ui_theme: &'a UiTheme,
}

impl<'a> HeaderData<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        brand: &'a str,
        subtitle: &'a str,
        cwd: &'a str,
        model: &'a str,
        provider: &'a str,
        background_status: &'a str,
        is_streaming: bool,
        context_used: usize,
        context_total: usize,
        ui_theme: &'a UiTheme,
    ) -> Self {
        Self {
            brand,
            subtitle,
            cwd,
            model,
            provider,
            background_status,
            is_streaming,
            context_used,
            context_total,
            ui_theme,
        }
    }
}

/// Footer/status-line widget (1 line height).
pub struct HeaderWidget<'a> {
    data: HeaderData<'a>,
}

impl<'a> HeaderWidget<'a> {
    pub fn new(data: HeaderData<'a>) -> Self {
        Self { data }
    }

    fn context_percent(&self) -> Option<f64> {
        if self.data.context_total == 0 {
            return None;
        }
        let used = self.data.context_used as f64;
        let total = self.data.context_total as f64;
        Some((used / total * 100.0).clamp(0.0, 100.0))
    }

    fn context_color(&self, percent: f64) -> Color {
        if percent >= CONTEXT_CRITICAL_THRESHOLD_PERCENT {
            self.data.ui_theme.error_fg
        } else if percent >= CONTEXT_WARNING_THRESHOLD_PERCENT {
            self.data.ui_theme.warning
        } else {
            self.data.ui_theme.accent_secondary
        }
    }

    fn context_signal_spans(&self) -> Vec<Span<'static>> {
        let Some(percent) = self.context_percent() else {
            return Vec::new();
        };
        let color = self.context_color(percent);
        let filled = ((percent / 100.0) * CONTEXT_SIGNAL_WIDTH as f64)
            .ceil()
            .clamp(0.0, CONTEXT_SIGNAL_WIDTH as f64) as usize;
        let empty = CONTEXT_SIGNAL_WIDTH.saturating_sub(filled);

        vec![
            Span::styled(format!("{percent:.0}%"), Style::default().fg(color)),
            Span::raw(" "),
            Span::styled("▰".repeat(filled), Style::default().fg(color)),
            Span::styled(
                "▱".repeat(empty),
                Style::default().fg(self.data.ui_theme.border),
            ),
        ]
    }

    fn left_spans(&self, max_width: usize) -> Vec<Span<'static>> {
        if max_width == 0 {
            return Vec::new();
        }

        let mut spans = Vec::new();
        let push_segment = |spans: &mut Vec<Span<'static>>, text: &str, style: Style| {
            if text.is_empty() {
                return;
            }
            let separator_width = if spans.is_empty() { 0 } else { 3 };
            if span_width(spans).saturating_add(separator_width) >= max_width {
                return;
            }
            if separator_width > 0 {
                spans.push(Span::styled(
                    " · ",
                    Style::default().fg(self.data.ui_theme.text_dim),
                ));
            }
            let remaining = max_width.saturating_sub(span_width(spans));
            if remaining > 0 {
                spans.push(Span::styled(truncate_to_width(text, remaining), style));
            }
        };

        if !self.data.brand.is_empty() {
            let mut hint = self.data.brand.to_string();
            if !self.data.subtitle.is_empty() {
                hint.push(' ');
                hint.push_str(self.data.subtitle);
            }
            push_segment(
                &mut spans,
                &hint,
                Style::default().fg(self.data.ui_theme.text_muted),
            );
            if let Some(first) = spans.first_mut() {
                first.style = first
                    .style
                    .fg(self.data.ui_theme.text_soft)
                    .add_modifier(Modifier::BOLD);
            }
        }

        if !self.data.background_status.is_empty() {
            push_segment(
                &mut spans,
                self.data.background_status,
                Style::default().fg(self.data.ui_theme.text_dim),
            );
        }

        spans
    }

    fn right_spans(&self, max_width: usize) -> Vec<Span<'static>> {
        let mut spans = Vec::new();
        let push_segment =
            |spans: &mut Vec<Span<'static>>, text: &str, style: Style, center_path: bool| {
                if text.is_empty() {
                    return;
                }
                let separator_width = if spans.is_empty() { 0 } else { 3 };
                if span_width(spans).saturating_add(separator_width) >= max_width {
                    return;
                }
                if separator_width > 0 {
                    spans.push(Span::styled(
                        " · ",
                        Style::default().fg(self.data.ui_theme.text_dim),
                    ));
                }
                let remaining = max_width.saturating_sub(span_width(spans));
                if remaining > 0 {
                    let content = if center_path {
                        center_truncate_path(text, remaining)
                    } else {
                        truncate_to_width(text, remaining)
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
        push_segment(
            &mut spans,
            &model_context,
            Style::default().fg(self.data.ui_theme.text_hint),
            false,
        );

        if self.data.is_streaming {
            push_segment(
                &mut spans,
                "working",
                Style::default().fg(self.data.ui_theme.accent_primary),
                false,
            );
        }

        if !self.data.cwd.is_empty() {
            push_segment(
                &mut spans,
                self.data.cwd,
                Style::default().fg(self.data.ui_theme.text_dim),
                true,
            );
        }

        let context_spans = self.context_signal_spans();
        if !context_spans.is_empty() {
            let separator_width = if spans.is_empty() { 0 } else { 3 };
            if span_width(&spans).saturating_add(separator_width) < max_width {
                if separator_width > 0 {
                    spans.push(Span::styled(
                        " · ",
                        Style::default().fg(self.data.ui_theme.text_dim),
                    ));
                }
                for span in context_spans {
                    if span_width(&spans) >= max_width {
                        break;
                    }
                    let span_w = span.content.width();
                    let remaining = max_width.saturating_sub(span_width(&spans));
                    if span_w <= remaining {
                        spans.push(span);
                    }
                }
            }
        }

        spans
    }
}

impl crate::widgets::Renderable for HeaderWidget<'_> {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let available = area.width as usize;
        let right_budget = available.saturating_sub(6);
        let right_spans = self.right_spans(right_budget);
        let right_width = span_width(&right_spans);
        let spacer_min = usize::from(right_width > 0);
        let left_budget = available.saturating_sub(right_width + spacer_min);
        let left_spans = self.left_spans(left_budget);
        let left_width = span_width(&left_spans);
        let spacer_width = available.saturating_sub(left_width + right_width);

        let mut spans = left_spans;
        if spacer_width > 0 {
            spans.push(Span::raw(" ".repeat(spacer_width)));
        }
        spans.extend(right_spans);

        let line = truncate_line_with_ellipsis_if_overflow(Line::from(spans), available);
        Paragraph::new(line)
            .style(Style::default().bg(self.data.ui_theme.header_bg))
            .render(area, buf);
    }

    fn desired_height(&self, _width: u16) -> u16 {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::KCODER_UI_THEME;
    use crate::widgets::Renderable;
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;

    fn render_header(width: u16, data: HeaderData<'_>) -> Buffer {
        let mut buf = Buffer::empty(Rect::new(0, 0, width, 1));
        HeaderWidget::new(data).render(buf.area, &mut buf);
        buf
    }

    #[test]
    fn header_renders_footer_hint_and_context() {
        let data = HeaderData::new(
            "?",
            "for shortcuts",
            "/repo",
            "MiniMax-M3",
            "MiniMax",
            "",
            false,
            1000,
            200000,
            &KCODER_UI_THEME,
        );
        let buf = render_header(80, data);
        let line = buf.content.chunks(buf.area.width as usize).next().unwrap();
        let text: String = line.iter().map(|c| c.symbol()).collect();
        assert!(text.contains("? for shortcuts"));
        assert!(text.contains("MiniMax/MiniMax-M3"));
        assert!(text.contains("/repo"));
    }

    #[test]
    fn header_shows_working_indicator_when_streaming() {
        let data = HeaderData::new(
            "esc",
            "to interrupt",
            "",
            "model",
            "provider",
            "",
            true,
            0,
            0,
            &KCODER_UI_THEME,
        );
        let buf = render_header(60, data);
        let line = buf.content.chunks(buf.area.width as usize).next().unwrap();
        let text: String = line.iter().map(|c| c.symbol()).collect();
        assert!(text.contains("esc to interrupt"));
        assert!(text.contains("working"));
    }

    #[test]
    fn header_reports_context_percent() {
        let data = HeaderData::new(
            "?",
            "for shortcuts",
            "",
            "model",
            "provider",
            "",
            false,
            1000,
            2000,
            &KCODER_UI_THEME,
        );
        let buf = render_header(60, data);
        let line = buf.content.chunks(buf.area.width as usize).next().unwrap();
        let text: String = line.iter().map(|c| c.symbol()).collect();
        assert!(text.contains("50%"));
    }

    #[test]
    fn header_is_one_line_tall() {
        let data = HeaderData::new("K", "", "", "", "", "", false, 0, 0, &KCODER_UI_THEME);
        assert_eq!(HeaderWidget::new(data).desired_height(100), 1);
    }

    #[test]
    fn header_shows_background_status_when_present() {
        let data = HeaderData::new(
            "KCoder",
            "",
            "",
            "",
            "provider",
            "agents 2 running",
            false,
            0,
            0,
            &KCODER_UI_THEME,
        );
        let buf = render_header(80, data);
        let line = buf.content.chunks(buf.area.width as usize).next().unwrap();
        let text: String = line.iter().map(|c| c.symbol()).collect();
        assert!(text.contains("agents 2 running"));
    }

    #[test]
    fn header_center_truncates_cwd_when_space_is_tight() {
        let sep = std::path::MAIN_SEPARATOR;
        let cwd = format!("{sep}home{sep}alex{sep}projects{sep}kcoder{sep}crates{sep}kcoder_repl");
        let data = HeaderData::new("", "", &cwd, "", "", "", false, 0, 0, &KCODER_UI_THEME);

        let buf = render_header(38, data);
        let line = buf.content.chunks(buf.area.width as usize).next().unwrap();
        let text: String = line.iter().map(|c| c.symbol()).collect();

        assert_eq!(
            text.trim(),
            center_truncate_path(&cwd, 32),
            "header should preserve the important cwd suffix"
        );
        assert!(text.contains("kcoder_repl"));
    }
}

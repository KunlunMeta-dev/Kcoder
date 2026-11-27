//! Live status indicator shown above the composer while KCoder is busy.
//!
//! It contains an activity marker, a short header, elapsed time, an interrupt
//! affordance, optional inline context, and optional wrapped detail lines.

use std::time::{Duration, Instant};

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Paragraph, Widget},
};
use unicode_width::UnicodeWidthStr;

use crate::line_truncation::truncate_line_with_ellipsis_if_overflow;
use crate::motion::{MotionMode, ReducedMotionIndicator, activity_indicator, shimmer_text};
use crate::render::wrapping::{truncate_to_display_width, word_wrap_plain_line};
use crate::text_formatting::capitalize_first;
use crate::theme::UiTheme;
use crate::widgets::clear_area;
use crate::windows_compat::{UI_ELLIPSIS, UI_SEPARATOR, status_text};

pub(crate) const STATUS_DETAILS_DEFAULT_MAX_LINES: usize = 3;
pub(crate) const STATUS_INDICATOR_MAX_HEIGHT: u16 = 1 + STATUS_DETAILS_DEFAULT_MAX_LINES as u16;
#[cfg(not(windows))]
const DETAILS_PREFIX: &str = "  └ ";
#[cfg(windows)]
const DETAILS_PREFIX: &str = "  > ";
const DETAILS_CONTINUATION_PREFIX: &str = "    ";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StatusDetailsCapitalization {
    CapitalizeFirst,
    Preserve,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct StatusIndicatorData<'a> {
    pub(crate) header: &'a str,
    pub(crate) details: Option<&'a str>,
    pub(crate) inline_message: &'a str,
    pub(crate) elapsed: Duration,
    pub(crate) started_at: Option<Instant>,
    pub(crate) activity_indicator: Option<&'a str>,
    pub(crate) needs_attention: bool,
    pub(crate) show_interrupt_hint: bool,
    pub(crate) interrupt_hint: &'a str,
    pub(crate) is_running: bool,
    pub(crate) details_max_lines: usize,
    pub(crate) details_capitalization: StatusDetailsCapitalization,
    pub(crate) ui_theme: &'a UiTheme,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct StatusIndicatorControls<'a> {
    pub(crate) show_interrupt_hint: bool,
    pub(crate) interrupt_hint: &'a str,
    pub(crate) is_running: bool,
}

impl<'a> StatusIndicatorData<'a> {
    pub(crate) fn new(
        header: &'a str,
        details: Option<&'a str>,
        inline_message: &'a str,
        elapsed: Duration,
        controls: StatusIndicatorControls<'a>,
        ui_theme: &'a UiTheme,
    ) -> Self {
        Self {
            header,
            details,
            inline_message,
            elapsed,
            started_at: None,
            activity_indicator: None,
            needs_attention: false,
            show_interrupt_hint: controls.show_interrupt_hint,
            interrupt_hint: controls.interrupt_hint,
            is_running: controls.is_running,
            details_max_lines: STATUS_DETAILS_DEFAULT_MAX_LINES,
            details_capitalization: StatusDetailsCapitalization::CapitalizeFirst,
            ui_theme,
        }
    }

    pub(crate) fn with_activity_indicator(
        mut self,
        indicator: &'a str,
        needs_attention: bool,
    ) -> Self {
        self.activity_indicator = Some(indicator);
        self.needs_attention = needs_attention;
        self
    }
}

pub(crate) struct StatusIndicatorWidget<'a> {
    data: StatusIndicatorData<'a>,
}

impl<'a> StatusIndicatorWidget<'a> {
    pub(crate) fn new(data: StatusIndicatorData<'a>) -> Self {
        Self { data }
    }

    fn motion_mode(&self) -> MotionMode {
        MotionMode::from_animations_enabled(self.data.is_running)
    }

    fn activity_span(&self) -> Option<Span<'static>> {
        if !self.data.is_running {
            return None;
        }
        let mut span = if let Some(indicator) = self.data.activity_indicator {
            Span::raw(indicator.to_string())
        } else {
            activity_indicator(
                self.data.started_at,
                self.motion_mode(),
                ReducedMotionIndicator::Hidden,
            )?
        };
        let color = if self.data.needs_attention {
            self.data.ui_theme.warning
        } else {
            self.data.ui_theme.accent_primary
        };
        span.style = span
            .style
            .patch(Style::default().fg(color).add_modifier(Modifier::BOLD));
        Some(span)
    }

    fn header_spans(&self) -> Vec<Span<'static>> {
        let color = if self.data.needs_attention {
            self.data.ui_theme.warning
        } else {
            self.data.ui_theme.status_working
        };
        let header_style = Style::default().fg(color).add_modifier(Modifier::BOLD);
        let header = status_text(self.data.header);
        let mut spans = shimmer_text(header.as_ref(), self.motion_mode());
        for span in &mut spans {
            span.style = span.style.patch(header_style);
        }
        spans
    }

    fn header_line(&self) -> Line<'static> {
        let theme = self.data.ui_theme;
        let mut spans = Vec::new();
        if let Some(activity_span) = self.activity_span() {
            spans.push(activity_span);
            spans.push(Span::raw(" "));
        }
        spans.extend(self.header_spans());

        let elapsed = fmt_elapsed_compact(self.data.elapsed.as_secs());
        if self.data.show_interrupt_hint && !self.data.interrupt_hint.is_empty() {
            spans.extend([
                Span::styled(
                    format!(" ({elapsed}{}", if cfg!(windows) { " | " } else { " • " }),
                    Style::default().add_modifier(Modifier::DIM),
                ),
                Span::styled(
                    self.data.interrupt_hint.to_string(),
                    Style::default()
                        .fg(theme.text_muted)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    " to interrupt)",
                    Style::default().add_modifier(Modifier::DIM),
                ),
            ]);
        } else {
            spans.push(Span::styled(
                format!(" ({elapsed})"),
                Style::default().add_modifier(Modifier::DIM),
            ));
        }

        let inline = self.data.inline_message.trim();
        if !inline.is_empty() {
            spans.extend([
                Span::styled(UI_SEPARATOR, Style::default().add_modifier(Modifier::DIM)),
                Span::styled(
                    status_text(inline).into_owned(),
                    Style::default().fg(theme.text_muted),
                ),
            ]);
        }

        Line::from(spans)
    }

    fn wrapped_details_lines(&self, width: u16) -> Vec<Line<'static>> {
        let Some(details) = self
            .data
            .details
            .map(str::trim_start)
            .filter(|s| !s.is_empty())
        else {
            return Vec::new();
        };
        let details = match self.data.details_capitalization {
            StatusDetailsCapitalization::CapitalizeFirst => capitalize_first(details),
            StatusDetailsCapitalization::Preserve => details.to_string(),
        };
        let details = status_text(&details);
        let width = usize::from(width);
        let prefix_width = UnicodeWidthStr::width(DETAILS_PREFIX);
        if width <= prefix_width {
            return Vec::new();
        }

        let content_width = width.saturating_sub(prefix_width).max(1);
        let mut lines = Vec::new();
        for detail_line in details.lines() {
            for (idx, wrapped) in word_wrap_plain_line(detail_line, content_width)
                .into_iter()
                .enumerate()
            {
                lines.push(detail_line_from_text(wrapped, self.data.ui_theme, idx > 0));
            }
        }

        let max_lines = self.data.details_max_lines.max(1);
        if lines.len() > max_lines {
            lines.truncate(max_lines);
            if let Some(last) = lines.last_mut()
                && let Some(span) = last.spans.last_mut()
            {
                let max_base_len = content_width.saturating_sub(1);
                let trimmed = truncate_to_display_width(span.content.as_ref(), max_base_len);
                *span = Span::styled(format!("{trimmed}{UI_ELLIPSIS}"), span.style);
            }
        }
        lines
    }
}

impl crate::widgets::Renderable for StatusIndicatorWidget<'_> {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }

        clear_area(area, buf, self.data.ui_theme.footer_bg);
        let mut lines = vec![truncate_line_with_ellipsis_if_overflow(
            self.header_line(),
            usize::from(area.width),
        )];
        if area.height > 1 {
            lines.extend(
                self.wrapped_details_lines(area.width)
                    .into_iter()
                    .take(usize::from(area.height.saturating_sub(1))),
            );
        }

        Paragraph::new(Text::from(lines))
            .style(Style::default().bg(self.data.ui_theme.footer_bg))
            .render(area, buf);
    }

    fn desired_height(&self, width: u16) -> u16 {
        1 + self.wrapped_details_lines(width).len() as u16
    }
}

pub(crate) fn fmt_elapsed_compact(elapsed_secs: u64) -> String {
    if elapsed_secs < 60 {
        return format!("{elapsed_secs}s");
    }
    if elapsed_secs < 3600 {
        let minutes = elapsed_secs / 60;
        let seconds = elapsed_secs % 60;
        return format!("{minutes}m {seconds:02}s");
    }
    let hours = elapsed_secs / 3600;
    let minutes = (elapsed_secs % 3600) / 60;
    let seconds = elapsed_secs % 60;
    format!("{hours}h {minutes:02}m {seconds:02}s")
}

fn detail_line_from_text(text: String, theme: &UiTheme, continuation: bool) -> Line<'static> {
    let prefix = if continuation {
        DETAILS_CONTINUATION_PREFIX
    } else {
        DETAILS_PREFIX
    };
    Line::from(vec![
        Span::styled(prefix, Style::default().fg(theme.text_dim)),
        Span::styled(text, Style::default().fg(theme.text_dim)),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::KCODER_UI_THEME;
    use crate::widgets::Renderable;
    use ratatui::buffer::Buffer;

    macro_rules! status_data {
        (
            $header:expr,
            $details:expr,
            $inline:expr,
            $elapsed:expr,
            $show_hint:expr,
            $hint:expr,
            $running:expr,
            $theme:expr $(,)?
        ) => {
            StatusIndicatorData::new(
                $header,
                $details,
                $inline,
                $elapsed,
                StatusIndicatorControls {
                    show_interrupt_hint: $show_hint,
                    interrupt_hint: $hint,
                    is_running: $running,
                },
                $theme,
            )
        };
    }

    fn render_status(width: u16, height: u16, data: StatusIndicatorData<'_>) -> String {
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));
        StatusIndicatorWidget::new(data).render(buf.area, &mut buf);
        buf.content
            .chunks(width as usize)
            .flat_map(|row| row.iter().map(|cell| cell.symbol()))
            .collect::<String>()
    }

    #[test]
    fn elapsed_format_uses_expected_shape() {
        assert_eq!(fmt_elapsed_compact(0), "0s");
        assert_eq!(fmt_elapsed_compact(61), "1m 01s");
        assert_eq!(fmt_elapsed_compact(3661), "1h 01m 01s");
    }

    #[test]
    fn status_renders_interrupt_and_inline_context() {
        let data = status_data!(
            "Working",
            None,
            "agents 1 running",
            Duration::from_secs(2),
            true,
            "esc",
            true,
            &KCODER_UI_THEME,
        );

        let rendered = render_status(80, 1, data);

        assert!(rendered.contains("Working"));
        assert!(rendered.starts_with(&format!(
            "{} Working",
            crate::motion::spinner_frame(Duration::ZERO)
        )));
        assert!(rendered.contains("2s"));
        assert!(rendered.contains(if cfg!(windows) {
            "2s | esc to interrupt"
        } else {
            "2s • esc to interrupt"
        }));
        assert!(rendered.contains("esc to interrupt"));
        assert!(rendered.contains("agents 1 running"));
    }

    #[test]
    fn running_header_uses_motion_spans_with_theme_style() {
        let data = status_data!(
            "Working",
            None,
            "",
            Duration::ZERO,
            false,
            "",
            true,
            &KCODER_UI_THEME,
        );
        let line = StatusIndicatorWidget::new(data).header_line();
        let header_spans = line.spans.iter().skip(2).take("Working".len());
        let header_text = header_spans
            .clone()
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert_eq!(
            line.spans[0].content.as_ref(),
            crate::motion::spinner_frame(Duration::ZERO)
        );
        assert_eq!(header_text, "Working");
        for span in header_spans {
            assert_eq!(span.style.fg, Some(KCODER_UI_THEME.status_working));
            assert!(span.style.add_modifier.contains(Modifier::BOLD));
        }
    }

    #[test]
    fn running_activity_marker_uses_started_at_for_animation_phase() {
        let mut data = status_data!(
            "Working",
            None,
            "",
            Duration::ZERO,
            false,
            "",
            true,
            &KCODER_UI_THEME,
        );
        data.started_at = Instant::now().checked_sub(Duration::from_millis(700));
        let line = StatusIndicatorWidget::new(data).header_line();

        let marker = &line.spans[0];
        let valid = if cfg!(windows) {
            ["|", "/", "-", "\\", "|", "/", "-", "\\", "|", "/"]
        } else {
            ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
        };
        assert!(
            valid.contains(&marker.content.as_ref()),
            "unexpected activity marker {:?}",
            marker.content
        );
        assert!(marker.style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn status_without_activity_marker_starts_at_header() {
        let data = status_data!(
            "Starting",
            None,
            "",
            Duration::ZERO,
            false,
            "",
            false,
            &KCODER_UI_THEME,
        );

        let rendered = render_status(40, 1, data);

        assert!(rendered.starts_with("Starting (0s)"));
        assert!(!rendered.starts_with(' '));
    }

    #[test]
    fn status_truncates_to_available_width() {
        let data = status_data!(
            "Working",
            None,
            "very long inline context that cannot fit",
            Duration::ZERO,
            true,
            "esc",
            true,
            &KCODER_UI_THEME,
        );

        let rendered = render_status(18, 1, data);

        assert_eq!(UnicodeWidthStr::width(rendered.trim_end()), 18);
        assert!(rendered.contains(UI_ELLIPSIS));
    }

    #[test]
    fn details_wrap_and_cap_with_ellipsis() {
        let mut data = status_data!(
            "Working",
            Some("running cargo test for a very long crate name"),
            "",
            Duration::ZERO,
            false,
            "",
            false,
            &KCODER_UI_THEME,
        );
        data.details_max_lines = 1;
        let widget = StatusIndicatorWidget::new(data);
        let lines = widget.wrapped_details_lines(18);

        assert_eq!(lines.len(), 1);
        assert!(lines[0].spans[1].content.ends_with(UI_ELLIPSIS));
    }

    #[test]
    fn details_default_to_capitalizing_first_letter() {
        let data = status_data!(
            "Working",
            Some("running cargo test"),
            "",
            Duration::ZERO,
            false,
            "",
            false,
            &KCODER_UI_THEME,
        );
        let widget = StatusIndicatorWidget::new(data);
        let lines = widget.wrapped_details_lines(80);

        assert_eq!(lines[0].spans[1].content.as_ref(), "Running cargo test");
    }

    #[test]
    fn details_can_preserve_original_capitalization() {
        let mut data = status_data!(
            "Working",
            Some("running cargo test"),
            "",
            Duration::ZERO,
            false,
            "",
            false,
            &KCODER_UI_THEME,
        );
        data.details_capitalization = StatusDetailsCapitalization::Preserve;
        let widget = StatusIndicatorWidget::new(data);
        let lines = widget.wrapped_details_lines(80);

        assert_eq!(lines[0].spans[1].content.as_ref(), "running cargo test");
    }

    #[test]
    fn details_trim_start_preserves_trailing_blank_lines() {
        let mut data = status_data!(
            "Working",
            Some("  first line\n\n"),
            "",
            Duration::ZERO,
            false,
            "",
            false,
            &KCODER_UI_THEME,
        );
        data.details_capitalization = StatusDetailsCapitalization::Preserve;
        let widget = StatusIndicatorWidget::new(data);
        let lines = widget.wrapped_details_lines(80);

        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].spans[1].content.as_ref(), "first line");
        assert_eq!(lines[1].spans[0].content.as_ref(), DETAILS_PREFIX);
        assert_eq!(lines[1].spans[1].content.as_ref(), "");
    }

    #[test]
    fn wrapped_detail_continuation_uses_codex_indent() {
        let data = status_data!(
            "Working",
            Some("A man a plan a canal panama"),
            "",
            Duration::ZERO,
            false,
            "",
            false,
            &KCODER_UI_THEME,
        );
        let widget = StatusIndicatorWidget::new(data);
        let lines = widget.wrapped_details_lines(30);

        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].spans[0].content, DETAILS_PREFIX);
        assert_eq!(lines[1].spans[0].content, DETAILS_CONTINUATION_PREFIX);
        assert!(!lines[1].spans[0].content.contains('└'));
    }

    #[test]
    fn status_details_break_url_tokens() {
        let mut data = status_data!(
            "Working",
            Some("https://example"),
            "",
            Duration::ZERO,
            false,
            "",
            false,
            &KCODER_UI_THEME,
        );
        data.details_capitalization = StatusDetailsCapitalization::Preserve;
        let widget = StatusIndicatorWidget::new(data);
        let lines = widget.wrapped_details_lines(12);

        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].spans[0].content, DETAILS_PREFIX);
        assert_eq!(lines[0].spans[1].content.as_ref(), "https://");
        assert_eq!(lines[1].spans[0].content, DETAILS_CONTINUATION_PREFIX);
        assert_eq!(lines[1].spans[1].content.as_ref(), "example");
    }

    #[test]
    fn default_details_cap_is_three_lines() {
        let data = status_data!(
            "Working",
            Some("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda"),
            "",
            Duration::ZERO,
            false,
            "",
            false,
            &KCODER_UI_THEME,
        );
        let widget = StatusIndicatorWidget::new(data);
        let lines = widget.wrapped_details_lines(16);

        assert_eq!(STATUS_DETAILS_DEFAULT_MAX_LINES, 3);
        assert_eq!(lines.len(), 3);
        assert!(lines[2].spans[1].content.ends_with(UI_ELLIPSIS));
    }
}

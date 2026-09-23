//! Navigation workers use real Markdown and Paragraph layout while retaining only visual rows near the target.

use crate::message_render::{
    MessageRenderOptions, display_text_is_hidden_internal_context, message_body_prefix,
    message_uses_markdown_body,
};
use crate::theme::{self, KCODER_UI_THEME};
use kcoder_types::{DisplayMessage, MessageRole};
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    text::{Line, Span},
    widgets::{Paragraph, Widget, Wrap},
};
use std::collections::VecDeque;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use unicode_width::UnicodeWidthStr;

/// Replay already laid-out visual rows directly, avoiding another wrap pass or clipping of boundary glyphs from the original Paragraph.
pub(super) struct NavigationLines<'a> {
    pub(super) lines: &'a [Line<'static>],
    pub(super) local_top: usize,
}

impl Widget for NavigationLines<'_> {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        for y in area.top()..area.bottom() {
            for x in area.left()..area.right() {
                buffer[(x, y)].reset();
            }
        }
        for (row, line) in self
            .lines
            .iter()
            .skip(self.local_top)
            .take(usize::from(area.height))
            .enumerate()
        {
            let y = area.y + row as u16;
            let mut x = area.x;
            for grapheme in line.styled_graphemes(ratatui::style::Style::default()) {
                let width = grapheme.symbol.width();
                if width == 0 {
                    continue;
                }
                if x >= area.right() {
                    break;
                }
                buffer[(x, y)]
                    .set_symbol(grapheme.symbol)
                    .set_style(grapheme.style);
                x = x.saturating_add(width as u16);
            }
        }
    }
}

pub(super) const MAX_NAVIGATION_LINE_BYTES: usize = 64 * 1024;

pub(super) struct NavigationBudget<'a> {
    cancelled: &'a AtomicBool,
    deadline: Instant,
    events: usize,
}

impl<'a> NavigationBudget<'a> {
    pub(super) fn new(
        text: &str,
        cancelled: &'a AtomicBool,
    ) -> Result<Self, NavigationRenderError> {
        if cancelled.load(Ordering::Relaxed) {
            return Err(NavigationRenderError::Cancelled);
        }
        if text.len() > 16 * 1024 * 1024 {
            return Err(NavigationRenderError::BudgetExceeded("source bytes"));
        }
        Ok(Self {
            cancelled,
            deadline: Instant::now() + Duration::from_secs(10),
            events: 0,
        })
    }

    pub(super) fn check(&mut self) -> Result<(), NavigationRenderError> {
        self.events += 1;
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(NavigationRenderError::Cancelled);
        }
        if self.events > 2_000_000 || Instant::now() >= self.deadline {
            return Err(NavigationRenderError::BudgetExceeded("parser work"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum MessageSourceTarget {
    MessageStart,
    Byte(usize),
    VisualRow(usize),
}

#[derive(Debug)]
pub(super) struct NavigationMessageWindow {
    /// Visual rows after Paragraph wrapping; consumers replay them unchanged through NavigationLines.
    pub(super) lines: Vec<Line<'static>>,
    pub(super) window_start_row: usize,
    pub(super) target_row: usize,
    pub(super) total_rows: usize,
    pub(super) source_byte: usize,
    pub(super) source_row_offset: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum NavigationRenderError {
    Cancelled,
    InvalidSource,
    UnsupportedMessage,
    BudgetExceeded(&'static str),
}

impl std::fmt::Display for NavigationRenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => f.write_str("navigation cancelled"),
            Self::InvalidSource => f.write_str(
                "the navigation target is stale or cannot be displayed at the current width",
            ),
            Self::UnsupportedMessage => f.write_str("this message has no navigable body"),
            Self::BudgetExceeded(kind) => {
                write!(f, "navigation reached the resource limit ({kind})")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct NavigationHeading {
    pub(super) source_byte: usize,
    pub(super) level: u8,
    pub(super) label: String,
}

pub(super) fn extract_navigation_headings(
    text: &str,
    agent_markdown: bool,
    cancelled: &AtomicBool,
) -> Result<Vec<NavigationHeading>, NavigationRenderError> {
    let mut budget = NavigationBudget::new(text, cancelled)?;
    crate::markdown::navigation_headings(text, agent_markdown, &mut budget)
}

pub(super) fn render_message_navigation_window(
    msg: &DisplayMessage,
    options: MessageRenderOptions<'_>,
    target: MessageSourceTarget,
    viewport_rows: usize,
    overscan_rows: usize,
    cancelled: &AtomicBool,
) -> Result<NavigationMessageWindow, NavigationRenderError> {
    let mut budget = NavigationBudget::new(&msg.text, cancelled)?;
    let width = options.width.unwrap_or(80).max(1);
    if width > 4096
        || viewport_rows == 0
        || viewport_rows.saturating_add(overscan_rows.saturating_mul(2)) > 2048
        || viewport_rows
            .saturating_add(overscan_rows.saturating_mul(2))
            .saturating_mul(usize::from(width))
            > 262_144
    {
        return Err(NavigationRenderError::BudgetExceeded("viewport"));
    }
    if let MessageSourceTarget::Byte(byte) = target
        && (byte >= msg.text.len() || !msg.text.is_char_boundary(byte))
    {
        return Err(NavigationRenderError::InvalidSource);
    }
    if display_text_is_hidden_internal_context(&msg.text, msg.role == MessageRole::User) {
        if msg.role == MessageRole::System && !matches!(target, MessageSourceTarget::Byte(_)) {
            return Ok(empty_navigation_window());
        }
        return Err(NavigationRenderError::UnsupportedMessage);
    }

    let mut sink = NavigationWindowSink::new(width, viewport_rows, overscan_rows, target);
    if msg.role == MessageRole::System {
        if matches!(target, MessageSourceTarget::Byte(_)) {
            return Err(NavigationRenderError::InvalidSource);
        }
        if crate::message_render::message_is_hidden_tool_output(msg) {
            return Ok(empty_navigation_window());
        }
        if msg.text.len() > 64 * 1024 {
            return Err(NavigationRenderError::BudgetExceeded("system message"));
        }
        // Render every neighboring System message through the regular renderer to retain live-thinking and status-card branches.
        for line in crate::message_render::render_message_with_width_continuation(msg, options) {
            budget.check()?;
            sink.push(line, 0, false)?;
        }
        return if sink.total_rows == 0 {
            Ok(empty_navigation_window())
        } else {
            sink.finish()
        };
    }
    if msg.role == MessageRole::Assistant && options.width.is_some_and(|width| width <= 2) {
        if matches!(target, MessageSourceTarget::Byte(_)) {
            return Err(NavigationRenderError::InvalidSource);
        }
        sink.push(
            Line::from(Span::styled(
                if options.assistant_continuation {
                    "  "
                } else {
                    "• "
                },
                KCODER_UI_THEME.text_styles().muted,
            )),
            0,
            false,
        )?;
    } else if options.render_markdown && message_uses_markdown_body(msg) {
        let mut line_index = 0;
        let target_byte = match target {
            MessageSourceTarget::Byte(byte) => Some(byte),
            _ => None,
        };
        crate::markdown::stream_navigation_markdown(
            &msg.text,
            options.code_theme,
            options
                .width
                .map(|width| usize::from(width.saturating_sub(2).max(1))),
            msg.role == MessageRole::Assistant,
            target_byte,
            &mut budget,
            |line, source, selected| {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(NavigationRenderError::Cancelled);
                }
                let mut line = line.line;
                let prefix = message_body_prefix(
                    msg.role,
                    line_index,
                    options.assistant_continuation,
                    &line,
                );
                line.spans.insert(0, prefix);
                line_index += 1;
                sink.push(line, source, selected)
            },
        )?;
    } else {
        stream_plain_message(msg, options, target, &mut budget, &mut sink)?;
    }
    budget.check()?;
    sink.finish()
}

fn empty_navigation_window() -> NavigationMessageWindow {
    NavigationMessageWindow {
        lines: Vec::new(),
        window_start_row: 0,
        target_row: 0,
        total_rows: 0,
        source_byte: 0,
        source_row_offset: 0,
    }
}

fn stream_plain_message(
    msg: &DisplayMessage,
    options: MessageRenderOptions<'_>,
    target: MessageSourceTarget,
    budget: &mut NavigationBudget<'_>,
    sink: &mut NavigationWindowSink,
) -> Result<(), NavigationRenderError> {
    let styles = KCODER_UI_THEME.text_styles();
    let user = msg.role == MessageRole::User;
    if user {
        sink.push(Line::from("").style(theme::user_surface_style()), 0, false)?;
    }
    let source = if user {
        msg.text.trim_end_matches(['\r', '\n'])
    } else {
        &msg.text
    };
    let mut offset = 0;
    let mut last_source = 0;
    let mut line_index = 0;
    let mut selected_source = !matches!(target, MessageSourceTarget::Byte(_));
    for raw in source.split_inclusive('\n') {
        budget.check()?;
        last_source = offset;
        let raw = raw.strip_suffix('\n').unwrap_or(raw);
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        if raw.len() > MAX_NAVIGATION_LINE_BYTES {
            return Err(NavigationRenderError::BudgetExceeded("logical line"));
        }
        let selected = target == MessageSourceTarget::Byte(offset);
        selected_source |= selected;
        let wrapped = if user {
            options.width.map_or_else(
                || vec![raw.to_string()],
                |width| {
                    crate::render::wrapping::adaptive_word_wrap_plain_line(
                        raw,
                        usize::from(width.saturating_sub(2).max(1)),
                    )
                },
            )
        } else {
            vec![raw.to_string()]
        };
        for (part, content) in wrapped.into_iter().enumerate() {
            let mut line = Line::from(Span::styled(
                content,
                if user { styles.body } else { styles.soft },
            ));
            let prefix = if user {
                if line_index == 0 {
                    Span::styled("› ", styles.muted)
                } else {
                    Span::raw("  ")
                }
            } else {
                message_body_prefix(msg.role, line_index, options.assistant_continuation, &line)
            };
            line.spans.insert(0, prefix);
            if user {
                line.style = theme::user_surface_style();
            }
            sink.push(line, offset, selected && part == 0)?;
            line_index += 1;
        }
        // Preserve original CRLF byte counts; do not infer the next source position from text with newlines removed.
        offset = msg.text[offset..]
            .find('\n')
            .map_or(msg.text.len(), |end| offset + end + 1);
    }
    if user {
        sink.push(
            Line::from("").style(theme::user_surface_style()),
            last_source,
            false,
        )?;
        // The decorative blank row before a user bubble is not the body start at Byte(0).
        sink.source_origin_row = sink.total_rows;
    }
    if !selected_source {
        return Err(NavigationRenderError::InvalidSource);
    }
    Ok(())
}

struct PendingVisualLine {
    line: Line<'static>,
    skip: usize,
    rows: usize,
}

struct NavigationWindowSink {
    width: u16,
    target: MessageSourceTarget,
    before: usize,
    after: usize,
    prefix: VecDeque<PendingVisualLine>,
    prefix_rows: usize,
    lines: Vec<Line<'static>>,
    target_absolute: Option<usize>,
    target_row: usize,
    total_rows: usize,
    source_byte: usize,
    source_row_offset: usize,
    source_origin_row: usize,
    last_source: Option<usize>,
}

impl NavigationWindowSink {
    fn new(width: u16, viewport: usize, overscan: usize, target: MessageSourceTarget) -> Self {
        Self {
            width,
            target,
            before: if target == MessageSourceTarget::VisualRow(usize::MAX) {
                viewport + overscan
            } else {
                overscan
            },
            after: viewport + overscan,
            prefix: VecDeque::new(),
            prefix_rows: 0,
            lines: Vec::new(),
            target_absolute: None,
            target_row: 0,
            total_rows: 0,
            source_byte: 0,
            source_row_offset: 0,
            source_origin_row: 0,
            last_source: None,
        }
    }

    fn keep_prefix(&mut self, line: Line<'static>, rows: usize) {
        if rows == 0 || self.before == 0 {
            return;
        }
        self.prefix.push_back(PendingVisualLine {
            line,
            skip: 0,
            rows,
        });
        self.prefix_rows += rows;
        while self.prefix_rows > self.before {
            let excess = self.prefix_rows - self.before;
            let front = self
                .prefix
                .front_mut()
                .expect("prefix row count is nonzero");
            let discarded = excess.min(front.rows);
            front.skip += discarded;
            front.rows -= discarded;
            self.prefix_rows -= discarded;
            if front.rows == 0 {
                self.prefix.pop_front();
            }
        }
    }

    fn push(
        &mut self,
        line: Line<'static>,
        source: usize,
        selected: bool,
    ) -> Result<(), NavigationRenderError> {
        let paragraph = Paragraph::new(line.clone()).wrap(Wrap { trim: false });
        let rows = paragraph.line_count(self.width).max(1);
        if rows > usize::from(u16::MAX) {
            return Err(NavigationRenderError::BudgetExceeded("logical visual rows"));
        }
        let start = self.total_rows;
        if self.last_source != Some(source) {
            self.last_source = Some(source);
            self.source_origin_row = start;
        }
        self.total_rows += rows;
        if self.target == MessageSourceTarget::VisualRow(usize::MAX) {
            self.source_byte = source;
        }
        if self.target_absolute.is_some() {
            let wanted = (self.target_row + self.after)
                .saturating_sub(self.lines.len())
                .min(rows);
            self.lines
                .extend(render_visual_rows(line, self.width, 0, wanted));
            return Ok(());
        }
        let target = match self.target {
            MessageSourceTarget::MessageStart => Some(0),
            MessageSourceTarget::VisualRow(row) => Some(row),
            MessageSourceTarget::Byte(_) => selected.then_some(start),
        };
        if let Some(target) = target.filter(|row| *row >= start && *row < self.total_rows) {
            let local = target - start;
            self.keep_prefix(line.clone(), local);
            self.target_absolute = Some(target);
            self.target_row = self.prefix_rows;
            self.source_byte = match self.target {
                MessageSourceTarget::MessageStart => 0,
                MessageSourceTarget::Byte(byte) => byte,
                _ => source,
            };
            self.source_row_offset = match self.target {
                MessageSourceTarget::VisualRow(_) => target.saturating_sub(self.source_origin_row),
                _ => 0,
            };
            for previous in self.prefix.drain(..) {
                self.lines.extend(render_visual_rows(
                    previous.line,
                    self.width,
                    previous.skip,
                    previous.rows,
                ));
            }
            self.lines.extend(render_visual_rows(
                line,
                self.width,
                local,
                (rows - local).min(self.after),
            ));
        } else {
            self.keep_prefix(line, rows);
        }
        Ok(())
    }

    fn finish(mut self) -> Result<NavigationMessageWindow, NavigationRenderError> {
        if self.target == MessageSourceTarget::VisualRow(usize::MAX) && self.total_rows > 0 {
            for previous in self.prefix.drain(..) {
                self.lines.extend(render_visual_rows(
                    previous.line,
                    self.width,
                    previous.skip,
                    previous.rows,
                ));
            }
            self.target_absolute = Some(self.total_rows - 1);
            self.target_row = self.lines.len().saturating_sub(1);
            self.source_row_offset = (self.total_rows - 1).saturating_sub(self.source_origin_row);
        }
        let target = self
            .target_absolute
            .ok_or(NavigationRenderError::InvalidSource)?;
        Ok(NavigationMessageWindow {
            lines: self.lines,
            window_start_row: target - self.target_row,
            target_row: self.target_row,
            total_rows: self.total_rows,
            source_byte: self.source_byte,
            source_row_offset: self.source_row_offset,
        })
    }
}

fn render_visual_rows(
    line: Line<'static>,
    width: u16,
    skip: usize,
    rows: usize,
) -> Vec<Line<'static>> {
    if rows == 0 {
        return Vec::new();
    }
    let area = Rect::new(0, 0, width, rows as u16);
    let mut buffer = Buffer::empty(area);
    Paragraph::new(line)
        .wrap(Wrap { trim: false })
        .scroll((skip as u16, 0))
        .render(area, &mut buffer);
    (0..area.height)
        .map(|y| {
            let mut spans: Vec<Span<'static>> = Vec::new();
            let mut x = 0;
            while x < width {
                let cell = &buffer[(x, y)];
                let mut style = cell.style();
                // Keep the default background transparent so navigation replay can apply temporary full-row highlighting to its target.
                if style.bg == Some(ratatui::style::Color::Reset) {
                    style.bg = None;
                }
                let symbol = cell.symbol();
                if let Some(previous) = spans.last_mut()
                    && previous.style == style
                {
                    previous.content.to_mut().push_str(symbol);
                } else {
                    spans.push(Span::styled(symbol.to_string(), style));
                }
                x = x.saturating_add(symbol.width().max(1) as u16);
            }
            Line::from(spans)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::MessageRole;

    fn options(width: u16, markdown: bool) -> MessageRenderOptions<'static> {
        MessageRenderOptions {
            rail: None,
            is_last_tool: false,
            expanded: false,
            render_markdown: markdown,
            code_theme: "auto",
            width: Some(width),
            assistant_continuation: false,
        }
    }

    fn message(text: impl Into<String>) -> DisplayMessage {
        DisplayMessage {
            role: MessageRole::Assistant,
            text: text.into(),
        }
    }

    fn text(line: &Line<'_>) -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    }

    #[test]
    fn navigation_second_duplicate_heading_uses_source_not_label() {
        let msg = message(
            "# 重复标题\n\nfirst sentinel\n\n- 前置列表 中文😀 longword\n  后续\n\n| 字段 | 值 |\n|---|---|\n| one | two |\n\n# 重复标题\n\nSECOND_SENTINEL\n",
        );
        let source = msg.text.rfind("# 重复标题").unwrap();
        let window = render_message_navigation_window(
            &msg,
            options(28, true),
            MessageSourceTarget::Byte(source),
            8,
            2,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(text(&window.lines[window.target_row]).contains("重复标题"));
        assert!(
            window
                .lines
                .iter()
                .any(|line| text(line).contains("SECOND_SENTINEL"))
        );
        assert_eq!(window.source_byte, source);
    }

    #[test]
    fn navigation_heading_normalization_preserves_original_offsets() {
        let input = "```rust\n# fake\n```\n\n> # quoted\n\n```markdown\n# code-only\n```\n\n```markdown\n# displayed\n\n| A | B |\n|---|---|\n| a | b |\n```\n\nSetext 中文😀\n------\n";
        let headings = extract_navigation_headings(input, true, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            headings
                .iter()
                .map(|heading| heading.label.as_str())
                .collect::<Vec<_>>(),
            ["displayed", "Setext 中文😀"]
        );
        assert_eq!(headings[0].source_byte, input.find("# displayed").unwrap());
        assert_eq!(headings[1].level, 2);
        assert_eq!(headings[1].source_byte, input.find("Setext").unwrap());
    }

    #[test]
    fn navigation_merged_plain_answer_start_uses_source_block_boundary() {
        let msg = message("First answer segment.\n\nSECOND_PLAIN_SEGMENT\ncontinued text");
        let source = msg.text.find("SECOND_PLAIN_SEGMENT").unwrap();
        let window = render_message_navigation_window(
            &msg,
            options(40, true),
            MessageSourceTarget::Byte(source),
            8,
            2,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(text(&window.lines[window.target_row]).contains("SECOND_PLAIN_SEGMENT"));
        assert_same_as_original(&msg, options(40, true), MessageSourceTarget::Byte(source));
    }

    #[test]
    fn navigation_special_fence_rendering_matches_original() {
        let msg = message(
            "````markdown\n# Visible title\n\n| Header | Value |\n|---|---|\n| a | b |\n````\n\n~~~rust\n# Fake heading\n~~~\n\nAfter fence\n====\n\nAFTER_SENTINEL",
        );
        let headings =
            extract_navigation_headings(&msg.text, true, &AtomicBool::new(false)).unwrap();
        assert_eq!(headings.len(), 2);
        for heading in headings {
            for width in [8, 40] {
                assert_same_as_original(
                    &msg,
                    options(width, true),
                    MessageSourceTarget::Byte(heading.source_byte),
                );
            }
        }
    }

    #[test]
    fn navigation_system_neighbors_preserve_existing_hidden_and_collapsed_output() {
        let msg = DisplayMessage {
            role: MessageRole::System,
            text: "✓ Tool succeeded: Bash (0.1s)".into(),
        };
        assert_same_as_original(&msg, options(28, true), MessageSourceTarget::MessageStart);
        let hidden = DisplayMessage {
            role: MessageRole::System,
            text: "[Tool result: Bash] hidden output".into(),
        };
        let window = render_message_navigation_window(
            &hidden,
            options(28, true),
            MessageSourceTarget::MessageStart,
            8,
            2,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(window.lines.is_empty());
        assert_eq!(window.total_rows, 0);
        let thinking = DisplayMessage {
            role: MessageRole::System,
            text: "[Thinking live] first\nsecond\nthird\nfourth".into(),
        };
        assert_same_as_original(
            &thinking,
            options(28, true),
            MessageSourceTarget::MessageStart,
        );
        let hidden = DisplayMessage {
            role: MessageRole::System,
            text: format!("[Tool result: Bash] {}", "x".repeat(65 * 1024)),
        };
        assert!(
            render_message_navigation_window(
                &hidden,
                options(28, true),
                MessageSourceTarget::MessageStart,
                8,
                2,
                &AtomicBool::new(false)
            )
            .unwrap()
            .lines
            .is_empty()
        );
    }

    #[test]
    fn navigation_tail_sentinel_retains_bounded_previous_message_context() {
        let msg = message("first\nsecond\nLAST_ROW");
        let window = render_message_navigation_window(
            &msg,
            options(20, false),
            MessageSourceTarget::VisualRow(usize::MAX),
            2,
            0,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(window.total_rows, 3);
        assert_eq!(window.lines.len(), 2);
        assert_eq!(window.window_start_row, 1);
        assert!(text(&window.lines[window.target_row]).contains("LAST_ROW"));
        assert_eq!(window.source_byte, msg.text.find("LAST_ROW").unwrap());
    }

    #[test]
    fn navigation_visual_row_preserves_nearest_body_source_and_affinity() {
        let msg = message(
            "# Earlier heading\n\nfirst paragraph\n\nSECOND paragraph with enough words to wrap over multiple visual rows at this width\n",
        );
        let source = msg.text.find("SECOND").unwrap();
        let start = render_message_navigation_window(
            &msg,
            options(20, true),
            MessageSourceTarget::Byte(source),
            8,
            2,
            &AtomicBool::new(false),
        )
        .unwrap();
        let row = start.window_start_row + start.target_row + 1;
        let target = render_message_navigation_window(
            &msg,
            options(20, true),
            MessageSourceTarget::VisualRow(row),
            8,
            2,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(target.source_byte, source);
        assert_eq!(target.source_row_offset, 1);
    }

    #[test]
    fn navigation_hundred_thousand_lines_keeps_only_target_window() {
        let mut source = "line\n".repeat(100_000);
        source.push_str("\n# LAST_HEADING\n\nLAST_SENTINEL\n");
        let target = source.find("# LAST_HEADING").unwrap();
        let window = render_message_navigation_window(
            &message(source),
            options(80, true),
            MessageSourceTarget::Byte(target),
            12,
            3,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(window.total_rows > 100_000);
        assert!(window.lines.len() <= 18);
        assert!(text(&window.lines[window.target_row]).contains("LAST_HEADING"));
        assert!(
            window
                .lines
                .iter()
                .any(|line| text(line).contains("LAST_SENTINEL"))
        );
    }

    fn assert_same_as_original(
        msg: &DisplayMessage,
        options: MessageRenderOptions<'_>,
        target: MessageSourceTarget,
    ) {
        let width = options.width.unwrap();
        let original = crate::message_render::render_message_with_width_continuation(msg, options);
        let paragraph = Paragraph::new(original).wrap(Wrap { trim: false });
        let total = paragraph.line_count(width);
        let area = Rect::new(0, 0, width, total as u16);
        let mut expected = Buffer::empty(area);
        paragraph.render(area, &mut expected);
        let actual =
            render_message_navigation_window(msg, options, target, 8, 3, &AtomicBool::new(false))
                .unwrap();
        assert_eq!(
            actual.total_rows, total,
            "width={width}, markdown={}",
            options.render_markdown
        );
        assert!(actual.lines.len() <= 14);
        let area = Rect::new(0, 0, width, actual.lines.len() as u16);
        let mut visible = Buffer::empty(area);
        NavigationLines {
            lines: &actual.lines,
            local_top: 0,
        }
        .render(area, &mut visible);
        for y in 0..area.height {
            for x in 0..width {
                assert_eq!(
                    visible[(x, y)],
                    expected[(x, actual.window_start_row as u16 + y)],
                    "cell {x},{y}, width={width}, markdown={}",
                    options.render_markdown
                );
            }
        }
    }

    #[test]
    fn navigation_matches_original_layout_styles_and_visual_row_windows() {
        let source = "- 中文😀 列表 longlonglonglongword\n- second item words words words\n\n| First | Second |\n|---|---|\n| alpha | beta |\n\n[long url](https://example.com/a/very/long/path/to/resource?q=keyword)\n\nSetext 中文😀\n---\n\n```rust\nlet value = 42;\n```\n\n# Last heading\nSentinel";
        let msg = message(source);
        let source_byte = source.find("# Last heading").unwrap();
        for width in [1, 2, 3, 8, 21, 80] {
            for markdown in [false, true] {
                for continuation in [false, true] {
                    let mut options = options(width, markdown);
                    options.assistant_continuation = continuation;
                    assert_same_as_original(&msg, options, MessageSourceTarget::MessageStart);
                    if width > 2 {
                        assert_same_as_original(&msg, options, MessageSourceTarget::VisualRow(6));
                        assert_same_as_original(
                            &msg,
                            options,
                            MessageSourceTarget::Byte(source_byte),
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn navigation_user_crlf_raw_source_and_decoration_match() {
        let msg = DisplayMessage {
            role: MessageRole::User,
            text: "用户😀 lines\r\nsecond task with long wordssssssss\r\n".into(),
        };
        for width in [1, 2, 8, 40] {
            assert_same_as_original(
                &msg,
                options(width, false),
                MessageSourceTarget::MessageStart,
            );
            assert_same_as_original(
                &msg,
                options(width, false),
                MessageSourceTarget::Byte(msg.text.find("second").unwrap()),
            );
        }
    }

    #[test]
    fn navigation_cancellation_after_real_parser_progress_stops_emission() {
        let cancelled = AtomicBool::new(false);
        let source = "first\nsecond\nthird\nfourth";
        let mut budget = NavigationBudget::new(source, &cancelled).unwrap();
        let mut emitted = 0;
        let result = crate::markdown::stream_navigation_markdown(
            source,
            "auto",
            Some(40),
            true,
            None,
            &mut budget,
            |_, _, _| {
                emitted += 1;
                if emitted == 2 {
                    cancelled.store(true, Ordering::Relaxed);
                }
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err(), NavigationRenderError::Cancelled);
        assert_eq!(emitted, 2);
    }

    #[test]
    fn navigation_rejects_cancelled_invalid_hidden_and_oversized_blocks() {
        let msg = message("# 标题😀\nbody");
        assert_eq!(
            render_message_navigation_window(
                &msg,
                options(80, true),
                MessageSourceTarget::MessageStart,
                8,
                2,
                &AtomicBool::new(true)
            )
            .unwrap_err(),
            NavigationRenderError::Cancelled
        );
        for byte in [3, msg.text.len(), usize::MAX] {
            assert_eq!(
                render_message_navigation_window(
                    &msg,
                    options(80, true),
                    MessageSourceTarget::Byte(byte),
                    8,
                    2,
                    &AtomicBool::new(false)
                )
                .unwrap_err(),
                NavigationRenderError::InvalidSource
            );
        }
        assert_eq!(
            render_message_navigation_window(
                &msg,
                options(2, true),
                MessageSourceTarget::Byte(0),
                8,
                2,
                &AtomicBool::new(false)
            )
            .unwrap_err(),
            NavigationRenderError::InvalidSource
        );
        let hidden = DisplayMessage {
            role: MessageRole::User,
            text: "[system] All tracked background sub-agents have finished.".into(),
        };
        assert_eq!(
            render_message_navigation_window(
                &hidden,
                options(80, true),
                MessageSourceTarget::MessageStart,
                8,
                2,
                &AtomicBool::new(false)
            )
            .unwrap_err(),
            NavigationRenderError::UnsupportedMessage
        );
        let code = message(format!(
            "```rust\n{}\n```\n\n# target",
            "let a = 1;\n".repeat(2050)
        ));
        assert!(matches!(
            render_message_navigation_window(
                &code,
                options(80, true),
                MessageSourceTarget::MessageStart,
                8,
                2,
                &AtomicBool::new(false)
            ),
            Err(NavigationRenderError::BudgetExceeded("code/table block"))
        ));
        assert_eq!(
            extract_navigation_headings(&msg.text, true, &AtomicBool::new(true)).unwrap_err(),
            NavigationRenderError::Cancelled
        );
    }
}

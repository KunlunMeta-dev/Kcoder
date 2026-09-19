//! Inserts finalized transcript rows into terminal scrollback.
//!
//! Finalized history is written with terminal scroll-region escape sequences,
//! while the live viewport remains a bounded ratatui-style buffer.

use std::borrow::Cow;
use std::fmt;
use std::io;
use std::io::Write;

use crossterm::Command;
use crossterm::cursor::MoveDown;
use crossterm::cursor::MoveTo;
use crossterm::cursor::MoveToColumn;
use crossterm::cursor::RestorePosition;
use crossterm::cursor::SavePosition;
use crossterm::queue;
use crossterm::style::Color as CColor;
use crossterm::style::Colors;
use crossterm::style::Print;
use crossterm::style::SetAttribute;
use crossterm::style::SetBackgroundColor;
use crossterm::style::SetColors;
use crossterm::style::SetForegroundColor;
use crossterm::terminal::Clear;
use crossterm::terminal::ClearType;
use ratatui::backend::Backend;
use ratatui::layout::Size;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::text::Line;
use ratatui::text::Span;
use unicode_segmentation::UnicodeSegmentation;

#[cfg(test)]
use crate::terminal_hyperlinks::annotate_web_urls;
use crate::terminal_hyperlinks::{
    HyperlinkLine, TerminalHyperlink, decorate_spans, safe_print_text_preserving_osc8,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HistoryLineWrapPolicy {
    PreWrap,
    Terminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InsertHistoryMode {
    Standard,
    ZellijRaw,
}

fn safe_print_text(text: &str) -> Cow<'_, str> {
    if !text.chars().any(char::is_control) {
        return Cow::Borrowed(text);
    }
    Cow::Owned(
        text.chars()
            .map(|ch| if ch.is_control() { ' ' } else { ch })
            .collect(),
    )
}

#[cfg(test)]
pub fn insert_history_lines<B>(
    terminal: &mut crate::custom_terminal::Terminal<B>,
    lines: Vec<Line<'static>>,
) -> io::Result<()>
where
    B: Backend + Write,
{
    insert_history_lines_with_wrap_policy(terminal, lines, HistoryLineWrapPolicy::PreWrap)
}

#[cfg(test)]
pub(crate) fn insert_history_lines_with_wrap_policy<B>(
    terminal: &mut crate::custom_terminal::Terminal<B>,
    lines: Vec<Line<'static>>,
    wrap_policy: HistoryLineWrapPolicy,
) -> io::Result<()>
where
    B: Backend + Write,
{
    insert_history_lines_with_mode_and_wrap_policy(
        terminal,
        lines,
        InsertHistoryMode::Standard,
        wrap_policy,
    )
}

#[cfg(test)]
pub(crate) fn insert_history_lines_with_mode<B>(
    terminal: &mut crate::custom_terminal::Terminal<B>,
    lines: Vec<Line<'static>>,
    mode: InsertHistoryMode,
) -> io::Result<()>
where
    B: Backend + Write,
{
    insert_history_lines_with_mode_and_wrap_policy(
        terminal,
        lines,
        mode,
        HistoryLineWrapPolicy::PreWrap,
    )
}

#[cfg(test)]
pub(crate) fn insert_history_lines_with_mode_and_wrap_policy<B>(
    terminal: &mut crate::custom_terminal::Terminal<B>,
    lines: Vec<Line<'static>>,
    mode: InsertHistoryMode,
    wrap_policy: HistoryLineWrapPolicy,
) -> io::Result<()>
where
    B: Backend + Write,
{
    insert_history_hyperlink_lines_with_mode_and_wrap_policy(
        terminal,
        annotate_web_urls(lines),
        mode,
        wrap_policy,
    )
}

pub(crate) fn insert_history_hyperlink_lines_with_mode_and_wrap_policy<B>(
    terminal: &mut crate::custom_terminal::Terminal<B>,
    lines: Vec<HyperlinkLine>,
    mode: InsertHistoryMode,
    wrap_policy: HistoryLineWrapPolicy,
) -> io::Result<()>
where
    B: Backend + Write,
{
    if lines.is_empty() || terminal.viewport_area.is_empty() {
        return Ok(());
    }

    let screen_size = terminal.backend().size().unwrap_or(Size::new(0, 0));
    let area = terminal.viewport_area;
    let wrap_width = area.width.max(1) as usize;
    let lines = prepare_history_lines_for_insert(lines, wrap_width, wrap_policy);
    let wrapped_rows = history_lines_display_rows_for_width(&lines, wrap_width) as u16;

    match mode {
        InsertHistoryMode::Standard => {
            insert_history_lines_standard(terminal, lines, screen_size, area, wrapped_rows)
        }
        InsertHistoryMode::ZellijRaw => {
            insert_history_lines_zellij_raw(terminal, lines, screen_size, area, wrapped_rows)
        }
    }
}

pub(crate) fn history_lines_display_rows(
    lines: &[HyperlinkLine],
    wrap_width: usize,
    wrap_policy: HistoryLineWrapPolicy,
) -> usize {
    let prepared = prepare_history_lines_for_insert(lines.to_vec(), wrap_width.max(1), wrap_policy);
    history_lines_display_rows_for_width(&prepared, wrap_width.max(1))
}

fn history_lines_display_rows_for_width(lines: &[HyperlinkLine], wrap_width: usize) -> usize {
    lines
        .iter()
        .map(|line| line.width().max(1).div_ceil(wrap_width.max(1)))
        .sum()
}

fn prepare_history_lines_for_insert(
    lines: Vec<HyperlinkLine>,
    wrap_width: usize,
    wrap_policy: HistoryLineWrapPolicy,
) -> Vec<HyperlinkLine> {
    if wrap_policy == HistoryLineWrapPolicy::Terminal {
        return lines;
    }

    let wrap_width = wrap_width.max(1);
    let mut out = Vec::new();
    for line in lines {
        if should_keep_history_line_terminal_wrapped(&line) || line.width() <= wrap_width {
            out.push(line);
        } else {
            out.extend(hard_wrap_hyperlink_line(&line, wrap_width));
        }
    }
    out
}

fn should_keep_history_line_terminal_wrapped(line: &HyperlinkLine) -> bool {
    let text = line_visible_text(&line.line);
    crate::render::wrapping::text_contains_url_like(&text)
        && !crate::render::wrapping::text_has_mixed_url_and_non_url_tokens(&text)
}

fn line_visible_text(line: &Line<'_>) -> String {
    line.spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect::<String>()
}

fn hard_wrap_hyperlink_line(line: &HyperlinkLine, wrap_width: usize) -> Vec<HyperlinkLine> {
    let wrap_width = wrap_width.max(1);
    let mut rows = Vec::new();
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut source_col = 0usize;
    let mut row_start = 0usize;
    let mut row_width = 0usize;

    for span in &line.line.spans {
        for grapheme in span.content.graphemes(true) {
            let grapheme_width = crate::render::wrapping::display_width(grapheme);
            if row_width > 0
                && hyperlink_starting_at(line, source_col).is_some_and(|link| {
                    row_width + (link.columns.end - link.columns.start) > wrap_width
                })
            {
                rows.push(build_wrapped_history_row(
                    line,
                    std::mem::take(&mut spans),
                    row_start,
                    source_col,
                ));
                row_start = source_col;
                row_width = 0;
            }

            if row_width > 0
                && row_width.saturating_add(grapheme_width) > wrap_width
                && !hyperlink_covers_column(line, source_col)
            {
                rows.push(build_wrapped_history_row(
                    line,
                    std::mem::take(&mut spans),
                    row_start,
                    source_col,
                ));
                row_start = source_col;
                row_width = 0;
            }

            push_wrapped_span_text(&mut spans, span.style, grapheme);
            row_width = row_width.saturating_add(grapheme_width);
            source_col = source_col.saturating_add(grapheme_width);
        }
    }

    if !spans.is_empty() || rows.is_empty() {
        rows.push(build_wrapped_history_row(
            line, spans, row_start, source_col,
        ));
    }
    rows
}

fn build_wrapped_history_row(
    source: &HyperlinkLine,
    spans: Vec<Span<'static>>,
    start: usize,
    end: usize,
) -> HyperlinkLine {
    let hyperlinks = source
        .hyperlinks
        .iter()
        .filter_map(|link| {
            let overlap_start = link.columns.start.max(start);
            let overlap_end = link.columns.end.min(end);
            (overlap_start < overlap_end).then(|| TerminalHyperlink {
                columns: overlap_start - start..overlap_end - start,
                destination: link.destination.clone(),
            })
        })
        .collect();

    HyperlinkLine {
        line: Line::from(spans).style(source.line.style),
        hyperlinks,
        preformatted: source.preformatted,
    }
}

fn push_wrapped_span_text(
    spans: &mut Vec<Span<'static>>,
    style: ratatui::style::Style,
    text: &str,
) {
    if text.is_empty() {
        return;
    }
    if let Some(last) = spans.last_mut()
        && last.style == style
    {
        last.content.to_mut().push_str(text);
        return;
    }
    spans.push(Span::styled(text.to_string(), style));
}

fn hyperlink_starting_at(line: &HyperlinkLine, column: usize) -> Option<&TerminalHyperlink> {
    line.hyperlinks
        .iter()
        .find(|link| link.columns.start == column && link.columns.start < link.columns.end)
}

fn hyperlink_covers_column(line: &HyperlinkLine, column: usize) -> bool {
    line.hyperlinks
        .iter()
        .any(|link| link.columns.start <= column && column < link.columns.end)
}

fn insert_history_lines_standard<B>(
    terminal: &mut crate::custom_terminal::Terminal<B>,
    lines: Vec<HyperlinkLine>,
    screen_size: Size,
    mut area: ratatui::layout::Rect,
    wrapped_rows: u16,
) -> io::Result<()>
where
    B: Backend + Write,
{
    let mut should_update_area = false;
    let wrap_width = area.width.max(1) as usize;
    let last_cursor_pos = terminal.last_known_cursor_pos;

    let cursor_top = if area.bottom() < screen_size.height {
        let scroll_amount = wrapped_rows.min(screen_size.height - area.bottom());
        let writer = terminal.backend_mut();
        let top_1based = area.top() + 1;
        queue!(writer, SetScrollRegion(top_1based..screen_size.height))?;
        queue!(writer, MoveTo(0, area.top()))?;
        for _ in 0..scroll_amount {
            queue!(writer, Print("\x1bM"))?;
        }
        queue!(writer, ResetScrollRegion)?;

        // Capture the cursor row before moving the viewport down. The next
        // scroll region ends at the new viewport top, but the cursor must
        // remain inside the old history region for the first CRLF write.
        let cursor_top = area.top().saturating_sub(1);
        area.y += scroll_amount;
        should_update_area = true;
        cursor_top
    } else {
        area.top().saturating_sub(1)
    };

    let writer = terminal.backend_mut();
    queue!(writer, SetScrollRegion(1..area.top()))?;
    queue!(writer, MoveTo(0, cursor_top))?;
    for line in &lines {
        queue!(writer, Print("\r\n"))?;
        write_history_line(writer, line, wrap_width)?;
    }
    queue!(writer, ResetScrollRegion)?;
    queue!(writer, MoveTo(last_cursor_pos.x, last_cursor_pos.y))?;

    if should_update_area {
        terminal.set_viewport_area(area);
    }
    terminal.last_known_cursor_pos = last_cursor_pos;
    if wrapped_rows > 0 {
        terminal.note_history_rows_inserted(wrapped_rows);
    }
    // We wrote raw scroll-region ANSI outside the normal ratatui diff path.
    // Force the next live viewport draw to repaint from source so terminal
    // quirks or resize races cannot leave the diff cache believing stale
    // screen contents are current.
    terminal.invalidate_viewport();
    Ok(())
}

fn insert_history_lines_zellij_raw<B>(
    terminal: &mut crate::custom_terminal::Terminal<B>,
    lines: Vec<HyperlinkLine>,
    screen_size: Size,
    mut area: ratatui::layout::Rect,
    wrapped_rows: u16,
) -> io::Result<()>
where
    B: Backend + Write,
{
    let wrap_width = area.width.max(1) as usize;
    let last_cursor_pos = terminal.last_known_cursor_pos;
    terminal.clear_after_position(area.as_position())?;

    let writer = terminal.backend_mut();
    queue!(writer, MoveTo(0, area.top()))?;
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            queue!(writer, Print("\r\n"))?;
        }
        write_history_line(writer, line, wrap_width)?;
    }
    for _ in 0..area.height {
        queue!(writer, Print("\r\n"), Clear(ClearType::UntilNewLine))?;
    }
    queue!(writer, MoveTo(last_cursor_pos.x, last_cursor_pos.y))?;

    let viewport_top = area
        .top()
        .saturating_add(wrapped_rows)
        .min(screen_size.height.saturating_sub(area.height));
    if area.y != viewport_top {
        area.y = viewport_top;
        terminal.set_viewport_area(area);
    }
    terminal.last_known_cursor_pos = last_cursor_pos;
    if wrapped_rows > 0 {
        terminal.note_history_rows_inserted(wrapped_rows);
    }
    terminal.invalidate_viewport();
    Ok(())
}

#[cfg(test)]
mod scroll_region_tests {
    use super::*;
    use ratatui::layout::{Position, Rect, Size};
    use ratatui::style::Style;
    use ratatui::text::{Line, Span};

    struct VecBackend {
        buf: Vec<u8>,
        size: Size,
        flush_count: usize,
    }

    impl VecBackend {
        fn new(size: Size) -> Self {
            Self {
                buf: Vec::new(),
                size,
                flush_count: 0,
            }
        }

        fn written(&self) -> &[u8] {
            &self.buf
        }

        fn flush_count(&self) -> usize {
            self.flush_count
        }
    }

    impl std::io::Write for VecBackend {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.buf.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.flush_count += 1;
            Ok(())
        }
    }

    impl ratatui::backend::Backend for VecBackend {
        fn draw<'a, I>(&mut self, _content: I) -> std::io::Result<()>
        where
            I: Iterator<Item = (u16, u16, &'a ratatui::buffer::Cell)>,
        {
            Ok(())
        }

        fn hide_cursor(&mut self) -> std::io::Result<()> {
            Ok(())
        }

        fn show_cursor(&mut self) -> std::io::Result<()> {
            Ok(())
        }

        fn get_cursor_position(&mut self) -> std::io::Result<Position> {
            Ok(Position::new(0, 0))
        }

        fn set_cursor_position<P: Into<Position>>(&mut self, _position: P) -> std::io::Result<()> {
            Ok(())
        }

        fn clear(&mut self) -> std::io::Result<()> {
            Ok(())
        }

        fn clear_region(
            &mut self,
            _clear_type: ratatui::backend::ClearType,
        ) -> std::io::Result<()> {
            Ok(())
        }

        fn scroll_region_up(
            &mut self,
            _region: std::ops::Range<u16>,
            _scroll_by: u16,
        ) -> std::io::Result<()> {
            Ok(())
        }

        fn scroll_region_down(
            &mut self,
            _region: std::ops::Range<u16>,
            _scroll_by: u16,
        ) -> std::io::Result<()> {
            Ok(())
        }

        fn size(&self) -> std::io::Result<Size> {
            Ok(self.size)
        }

        fn window_size(&mut self) -> std::io::Result<ratatui::backend::WindowSize> {
            Ok(ratatui::backend::WindowSize {
                columns_rows: self.size,
                pixels: Size::new(0, 0),
            })
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn history_insert_scrolls_region_not_viewport() {
        let size = Size::new(80, 24);
        let backend = VecBackend::new(size);
        let mut terminal = crate::custom_terminal::Terminal::with_options_and_cursor_position(
            backend,
            Position::new(7, 22),
        )
        .unwrap();
        terminal.set_viewport_area(Rect::new(0, 20, 80, 3));

        let lines = vec![Line::from(Span::styled("hello", Style::default()))];
        insert_history_lines(&mut terminal, lines).unwrap();

        let output = String::from_utf8_lossy(terminal.backend().written());
        assert!(
            output.contains("\u{1b}[1;21r"),
            "expected scroll region to end at old viewport top, got:\n{output}"
        );
        assert_eq!(terminal.viewport_area.top(), 21);
        assert_eq!(terminal.last_known_cursor_pos, Position::new(7, 22));
        assert_eq!(
            terminal.backend().flush_count(),
            0,
            "history insertion must stay inside the outer frame flush"
        );
    }

    #[test]
    fn zellij_raw_insert_avoids_scroll_regions_and_preserves_cursor() {
        let size = Size::new(20, 10);
        let backend = VecBackend::new(size);
        let mut terminal = crate::custom_terminal::Terminal::with_options_and_cursor_position(
            backend,
            Position::new(3, 6),
        )
        .unwrap();
        terminal.set_viewport_area(Rect::new(0, 6, 20, 3));

        let lines = vec![Line::from(Span::styled("hello", Style::default()))];
        insert_history_lines_with_mode(&mut terminal, lines, InsertHistoryMode::ZellijRaw).unwrap();

        let output = String::from_utf8_lossy(terminal.backend().written());
        assert!(
            !output.contains("\u{1b}[1;"),
            "zellij raw mode should avoid scroll regions, got:\n{output}"
        );
        assert_eq!(terminal.viewport_area.top(), 7);
        assert_eq!(terminal.last_known_cursor_pos, Position::new(3, 6));
        assert_eq!(
            terminal.backend().flush_count(),
            0,
            "zellij history insertion must stay inside the outer frame flush"
        );
    }
}

pub(crate) fn write_history_line<W: Write>(
    writer: &mut W,
    line: &HyperlinkLine,
    wrap_width: usize,
) -> io::Result<()> {
    let physical_rows = line.width().max(1).div_ceil(wrap_width) as u16;
    if physical_rows > 1 {
        queue!(writer, SavePosition)?;
        for _ in 1..physical_rows {
            queue!(writer, MoveDown(1), MoveToColumn(0))?;
            queue!(writer, Clear(ClearType::UntilNewLine))?;
        }
        queue!(writer, RestorePosition)?;
    }
    queue!(
        writer,
        SetColors(Colors::new(
            line.line.style.fg.map(Into::into).unwrap_or(CColor::Reset),
            line.line.style.bg.map(Into::into).unwrap_or(CColor::Reset),
        ))
    )?;
    queue!(writer, Clear(ClearType::UntilNewLine))?;
    let merged_spans: Vec<Span<'static>> = line
        .line
        .spans
        .iter()
        .map(|span| Span {
            style: span.style.patch(line.line.style),
            content: span.content.clone(),
        })
        .collect();
    let merged_line = HyperlinkLine {
        line: Line::from(merged_spans),
        hyperlinks: line.hyperlinks.clone(),
        preformatted: false,
    };
    let spans = decorate_spans(&merged_line);
    write_spans(writer, spans.iter(), !merged_line.hyperlinks.is_empty())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetScrollRegion(pub std::ops::Range<u16>);

impl Command for SetScrollRegion {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        write!(f, "\x1b[{};{}r", self.0.start, self.0.end)
    }

    #[cfg(windows)]
    fn execute_winapi(&self) -> std::io::Result<()> {
        Err(std::io::Error::other(
            "SetScrollRegion requires ANSI support",
        ))
    }

    #[cfg(windows)]
    fn is_ansi_code_supported(&self) -> bool {
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResetScrollRegion;

impl Command for ResetScrollRegion {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        write!(f, "\x1b[r")
    }

    #[cfg(windows)]
    fn execute_winapi(&self) -> std::io::Result<()> {
        Err(std::io::Error::other(
            "ResetScrollRegion requires ANSI support",
        ))
    }

    #[cfg(windows)]
    fn is_ansi_code_supported(&self) -> bool {
        true
    }
}

struct ModifierDiff {
    from: Modifier,
    to: Modifier,
}

impl ModifierDiff {
    fn queue<W: io::Write>(self, w: &mut W) -> io::Result<()> {
        use crossterm::style::Attribute as CAttribute;
        let removed = self.from - self.to;
        if removed.contains(Modifier::REVERSED) {
            queue!(w, SetAttribute(CAttribute::NoReverse))?;
        }
        if removed.contains(Modifier::BOLD) {
            queue!(w, SetAttribute(CAttribute::NormalIntensity))?;
            if self.to.contains(Modifier::DIM) {
                queue!(w, SetAttribute(CAttribute::Dim))?;
            }
        }
        if removed.contains(Modifier::ITALIC) {
            queue!(w, SetAttribute(CAttribute::NoItalic))?;
        }
        if removed.contains(Modifier::UNDERLINED) {
            queue!(w, SetAttribute(CAttribute::NoUnderline))?;
        }
        if removed.contains(Modifier::DIM) {
            queue!(w, SetAttribute(CAttribute::NormalIntensity))?;
        }
        if removed.contains(Modifier::CROSSED_OUT) {
            queue!(w, SetAttribute(CAttribute::NotCrossedOut))?;
        }
        if removed.contains(Modifier::SLOW_BLINK) || removed.contains(Modifier::RAPID_BLINK) {
            queue!(w, SetAttribute(CAttribute::NoBlink))?;
        }

        let added = self.to - self.from;
        if added.contains(Modifier::REVERSED) {
            queue!(w, SetAttribute(CAttribute::Reverse))?;
        }
        if added.contains(Modifier::BOLD) {
            queue!(w, SetAttribute(CAttribute::Bold))?;
        }
        if added.contains(Modifier::ITALIC) {
            queue!(w, SetAttribute(CAttribute::Italic))?;
        }
        if added.contains(Modifier::UNDERLINED) {
            queue!(w, SetAttribute(CAttribute::Underlined))?;
        }
        if added.contains(Modifier::DIM) {
            queue!(w, SetAttribute(CAttribute::Dim))?;
        }
        if added.contains(Modifier::CROSSED_OUT) {
            queue!(w, SetAttribute(CAttribute::CrossedOut))?;
        }
        if added.contains(Modifier::SLOW_BLINK) {
            queue!(w, SetAttribute(CAttribute::SlowBlink))?;
        }
        if added.contains(Modifier::RAPID_BLINK) {
            queue!(w, SetAttribute(CAttribute::RapidBlink))?;
        }
        Ok(())
    }
}

fn write_spans<'a, I>(
    writer: &mut impl Write,
    content: I,
    preserve_generated_osc8: bool,
) -> io::Result<()>
where
    I: IntoIterator<Item = &'a Span<'a>>,
{
    let mut fg = Color::Reset;
    let mut bg = Color::Reset;
    let mut last_modifier = Modifier::empty();
    for span in content {
        let mut modifier = Modifier::empty();
        modifier.insert(span.style.add_modifier);
        modifier.remove(span.style.sub_modifier);
        if modifier != last_modifier {
            ModifierDiff {
                from: last_modifier,
                to: modifier,
            }
            .queue(writer)?;
            last_modifier = modifier;
        }
        let next_fg = span.style.fg.unwrap_or(Color::Reset);
        let next_bg = span.style.bg.unwrap_or(Color::Reset);
        if next_fg != fg || next_bg != bg {
            queue!(
                writer,
                SetColors(Colors::new(next_fg.into(), next_bg.into()))
            )?;
            fg = next_fg;
            bg = next_bg;
        }
        let text = if preserve_generated_osc8 {
            safe_print_text_preserving_osc8(&span.content)
        } else {
            safe_print_text(&span.content)
        };
        queue!(writer, Print(text))?;
    }

    queue!(
        writer,
        SetForegroundColor(CColor::Reset),
        SetBackgroundColor(CColor::Reset),
        SetAttribute(crossterm::style::Attribute::Reset),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_hyperlinks::{
        HyperlinkLine, TerminalHyperlink, annotate_web_urls_in_line, strip_osc8,
    };
    use ratatui::style::Stylize;

    #[test]
    fn writes_bold_then_regular_spans() {
        let spans = ["A".bold(), "B".into()];
        let mut actual: Vec<u8> = Vec::new();
        write_spans(&mut actual, spans.iter(), false).unwrap();

        let output = String::from_utf8(actual).unwrap();
        assert!(output.contains('A'));
        assert!(output.contains('B'));
        assert!(output.contains("\x1b[1m"));
    }

    #[test]
    fn writes_semantic_web_link_without_changing_visible_text() {
        let destination = "https://example.com/long/path";
        let line = annotate_web_urls_in_line(Line::from(destination));
        let mut actual = Vec::new();

        write_history_line(&mut actual, &line, 80).expect("write history line");

        let output = String::from_utf8(actual).expect("UTF-8 terminal output");
        assert!(output.contains("\x1b]8;;https://example.com/long/path\x07"));
        assert!(output.contains("\x1b]8;;\x07"));
        assert!(strip_osc8(&output).contains(destination));
    }

    #[test]
    fn writes_semantic_link_label_that_is_not_a_url() {
        let line = HyperlinkLine {
            line: Line::from("docs"),
            hyperlinks: vec![TerminalHyperlink {
                columns: 0..4,
                destination: "https://example.com/docs".to_string(),
            }],
            preformatted: false,
        };
        let mut actual = Vec::new();

        write_history_line(&mut actual, &line, 80).expect("write history line");

        let output = String::from_utf8(actual).expect("UTF-8 terminal output");
        assert!(output.contains("\x1b]8;;https://example.com/docs\x07docs\x1b]8;;\x07"));
        assert!(strip_osc8(&output).contains("docs"));
    }

    #[test]
    fn generated_osc8_mode_still_sanitizes_non_hyperlink_controls() {
        let line = annotate_web_urls_in_line(Line::from(vec![Span::raw(
            "pre\x1b]2;bad\x07 https://example.com".to_string(),
        )]));
        let mut actual = Vec::new();

        write_history_line(&mut actual, &line, 80).expect("write history line");

        let output = String::from_utf8(actual).expect("UTF-8 terminal output");
        assert!(!output.contains("\x1b]2;bad"));
        assert!(output.contains("\x1b]8;;https://example.com\x07"));
    }

    fn visible_text(line: &HyperlinkLine) -> String {
        line.line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>()
    }

    #[test]
    fn prewrap_splits_long_non_url_history_line_before_insert() {
        let line = HyperlinkLine::new(Line::from("abcdefghijklmn"));

        let wrapped =
            prepare_history_lines_for_insert(vec![line.clone()], 5, HistoryLineWrapPolicy::PreWrap);

        assert_eq!(
            wrapped.iter().map(visible_text).collect::<Vec<_>>(),
            vec!["abcde", "fghij", "klmn"]
        );
        assert_eq!(
            history_lines_display_rows(&[line], 5, HistoryLineWrapPolicy::PreWrap),
            3
        );
    }

    #[test]
    fn prewrap_keeps_url_only_history_line_terminal_wrapped() {
        let url = "https://example.com/abcdefghijk";
        let line = annotate_web_urls_in_line(Line::from(url));

        let wrapped =
            prepare_history_lines_for_insert(vec![line.clone()], 8, HistoryLineWrapPolicy::PreWrap);

        assert_eq!(wrapped.len(), 1);
        assert_eq!(visible_text(&wrapped[0]), url);
        assert!(history_lines_display_rows(&[line], 8, HistoryLineWrapPolicy::PreWrap) > 1);
    }

    #[test]
    fn prewrap_does_not_split_mixed_hyperlink_ranges() {
        let line = HyperlinkLine {
            line: Line::from("prefix docs"),
            hyperlinks: vec![TerminalHyperlink {
                columns: 7..11,
                destination: "https://example.com/docs".to_string(),
            }],
            preformatted: false,
        };

        let wrapped =
            prepare_history_lines_for_insert(vec![line], 8, HistoryLineWrapPolicy::PreWrap);

        assert_eq!(
            wrapped.iter().map(visible_text).collect::<Vec<_>>(),
            vec!["prefix ", "docs"]
        );
        assert_eq!(wrapped[1].hyperlinks[0].columns, 0..4);

        let mut actual = Vec::new();
        write_history_line(&mut actual, &wrapped[1], 8).expect("write wrapped hyperlink row");
        let output = String::from_utf8(actual).expect("UTF-8 terminal output");
        assert!(output.contains("\x1b]8;;https://example.com/docs\x07docs\x1b]8;;\x07"));
    }

    #[test]
    fn terminal_policy_preserves_source_line_for_soft_wrap() {
        let line = HyperlinkLine::new(Line::from("abcdefghijklmn"));

        let wrapped = prepare_history_lines_for_insert(
            vec![line.clone()],
            5,
            HistoryLineWrapPolicy::Terminal,
        );

        assert_eq!(wrapped.len(), 1);
        assert_eq!(visible_text(&wrapped[0]), "abcdefghijklmn");
        assert_eq!(
            history_lines_display_rows(&[line], 5, HistoryLineWrapPolicy::Terminal),
            3
        );
    }
}

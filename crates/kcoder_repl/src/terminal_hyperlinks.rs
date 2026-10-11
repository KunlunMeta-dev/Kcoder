//! Semantic terminal hyperlinks carried separately from visible TUI text.
//!
//! OSC-8 bytes are applied only when text reaches terminal scrollback, so they
//! do not affect ratatui layout, wrapping, or display-width calculations.

use std::borrow::Cow;
use std::ops::Range;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};
use url::Url;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TerminalHyperlink {
    pub(crate) columns: Range<usize>,
    pub(crate) destination: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct HyperlinkLine {
    pub(crate) line: Line<'static>,
    pub(crate) hyperlinks: Vec<TerminalHyperlink>,
    pub(crate) preformatted: bool,
}

impl HyperlinkLine {
    pub(crate) fn new(line: Line<'static>) -> Self {
        Self {
            line,
            hyperlinks: Vec::new(),
            preformatted: false,
        }
    }

    pub(crate) fn preformatted(line: Line<'static>) -> Self {
        Self {
            line,
            hyperlinks: Vec::new(),
            preformatted: true,
        }
    }

    pub(crate) fn width(&self) -> usize {
        self.line.width()
    }
}

impl From<Line<'static>> for HyperlinkLine {
    fn from(line: Line<'static>) -> Self {
        Self::new(line)
    }
}

pub(crate) fn annotate_web_urls(lines: Vec<Line<'static>>) -> Vec<HyperlinkLine> {
    lines.into_iter().map(annotate_web_urls_in_line).collect()
}

pub(crate) fn visible_lines(lines: Vec<HyperlinkLine>) -> Vec<Line<'static>> {
    lines.into_iter().map(|line| line.line).collect()
}

pub(crate) fn prefix_hyperlink_line(
    mut line: HyperlinkLine,
    prefix: Span<'static>,
) -> HyperlinkLine {
    let shift = prefix.content.width();
    let mut spans = Vec::with_capacity(line.line.spans.len() + 1);
    spans.push(prefix);
    spans.extend(line.line.spans);
    line.line = Line::from(spans).style(line.line.style);
    for hyperlink in &mut line.hyperlinks {
        hyperlink.columns = hyperlink.columns.start + shift..hyperlink.columns.end + shift;
    }
    line
}

pub(crate) fn annotate_web_urls_in_line(line: Line<'static>) -> HyperlinkLine {
    let text = line
        .spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect::<String>();
    let mut out = HyperlinkLine::new(line);
    out.hyperlinks = web_links_in_text(&text);
    out
}

pub(crate) fn web_links_in_text(text: &str) -> Vec<TerminalHyperlink> {
    let mut links = Vec::new();
    let mut search_from = 0usize;
    for raw_token in text.split_ascii_whitespace() {
        let Some(relative_start) = text[search_from..].find(raw_token) else {
            continue;
        };
        let raw_start = search_from + relative_start;
        search_from = raw_start + raw_token.len();

        let trimmed_start = raw_token
            .find(|ch: char| !is_leading_punctuation(ch))
            .unwrap_or(raw_token.len());
        let trimmed_end = trailing_url_end(&raw_token[trimmed_start..]) + trimmed_start;
        if trimmed_start >= trimmed_end {
            continue;
        }

        let candidate = &raw_token[trimmed_start..trimmed_end];
        let Some(destination) = web_destination(candidate) else {
            continue;
        };
        let start = text[..raw_start + trimmed_start].width();
        let end = start + candidate.width();
        links.push(TerminalHyperlink {
            columns: start..end,
            destination,
        });
    }
    links
}

fn is_leading_punctuation(ch: char) -> bool {
    matches!(
        ch,
        '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | ',' | '.' | ';' | '!' | '\'' | '"'
    )
}

fn trailing_url_end(candidate: &str) -> usize {
    let mut end = candidate.len();
    while end > 0 {
        let remaining = &candidate[..end];
        let Some(ch) = remaining.chars().next_back() else {
            break;
        };
        let trim = matches!(ch, ',' | '.' | ';' | '!' | '\'' | '"')
            || matches!(ch, ')' | ']' | '}' | '>')
                && has_unmatched_closing_delimiter(remaining, ch);
        if !trim {
            break;
        }
        end -= ch.len_utf8();
    }
    end
}

fn has_unmatched_closing_delimiter(candidate: &str, closing: char) -> bool {
    let opening = match closing {
        ')' => '(',
        ']' => '[',
        '}' => '{',
        '>' => '<',
        _ => return false,
    };
    candidate.chars().filter(|ch| *ch == closing).count()
        > candidate.chars().filter(|ch| *ch == opening).count()
}

pub(crate) fn web_destination(destination: &str) -> Option<String> {
    let safe_destination = destination
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>();
    let parsed = Url::parse(&safe_destination).ok()?;
    matches!(parsed.scheme(), "http" | "https")
        .then(|| parsed.host_str())
        .flatten()?;
    Some(safe_destination)
}

pub(crate) fn decorate_spans(line: &HyperlinkLine) -> Vec<Span<'static>> {
    if line.hyperlinks.is_empty() {
        return line.line.spans.clone();
    }

    let mut out = Vec::new();
    let mut column = 0usize;
    let mut link_index = 0usize;
    let mut active_link_index = None;
    let mut active_destination: Option<String> = None;

    for span in &line.line.spans {
        for ch in span.content.chars() {
            let width = ch.width().unwrap_or(0);
            while line
                .hyperlinks
                .get(link_index)
                .is_some_and(|link| link.columns.end <= column)
            {
                link_index += 1;
            }
            let selected_link_index = line
                .hyperlinks
                .get(link_index)
                .and_then(|link| link.columns.contains(&column).then_some(link_index));

            if active_link_index != selected_link_index {
                if active_destination.is_some() {
                    append_to_last_span(&mut out, "\x1b]8;;\x07");
                }
                active_destination = selected_link_index
                    .and_then(|index| web_destination(&line.hyperlinks[index].destination));
                if let Some(destination) = active_destination.as_ref() {
                    push_styled_content(
                        &mut out,
                        &format!("\x1b]8;;{destination}\x07"),
                        span.style,
                    );
                }
                active_link_index = selected_link_index;
            }

            let content = if ch.is_control() {
                " ".to_string()
            } else {
                ch.to_string()
            };
            push_styled_content(&mut out, &content, span.style);
            column += width;
        }
    }

    if active_destination.is_some() {
        append_to_last_span(&mut out, "\x1b]8;;\x07");
    }
    out
}

pub(crate) fn mark_buffer_web_urls(buf: &mut Buffer, area: Rect) {
    if area.width == 0 || area.height == 0 {
        return;
    }

    for y in area.y..area.bottom() {
        let mut row_text = String::new();
        let mut cells = Vec::new();

        for x in area.x..area.right() {
            let cell = &buf[(x, y)];
            if cell.skip {
                continue;
            }

            let start = row_text.width();
            let symbol = cell.symbol();
            row_text.push_str(symbol);
            let width = symbol.width().max(1);
            cells.push((x, start..start + width));
        }

        for hyperlink in web_links_in_text(&row_text) {
            for (x, columns) in &cells {
                if columns.end <= hyperlink.columns.start || columns.start >= hyperlink.columns.end
                {
                    continue;
                }
                let cell = &mut buf[(*x, y)];
                if cell.skip || cell.symbol().trim().is_empty() {
                    continue;
                }
                let symbol = osc8_hyperlink(&hyperlink.destination, cell.symbol());
                cell.set_symbol(&symbol);
            }
        }
    }
}

pub(crate) fn osc8_hyperlink(destination: &str, text: &str) -> String {
    let Some(safe_destination) = web_destination(destination) else {
        return text.to_string();
    };
    format!("\x1b]8;;{safe_destination}\x07{text}\x1b]8;;\x07")
}

pub(crate) fn safe_print_text_preserving_osc8(text: &str) -> Cow<'_, str> {
    if !text.chars().any(char::is_control) {
        return Cow::Borrowed(text);
    }

    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut idx = 0usize;
    while idx < bytes.len() {
        if bytes[idx..].starts_with(b"\x1b]8;;")
            && let Some((payload, consumed)) = parse_osc8_payload(&text[idx + 5..])
        {
            if payload.is_empty() {
                out.push_str("\x1b]8;;\x07");
            } else if let Some(destination) = web_destination(payload) {
                out.push_str("\x1b]8;;");
                out.push_str(&destination);
                out.push('\x07');
            }
            idx += 5 + consumed;
            continue;
        }

        let ch = text[idx..]
            .chars()
            .next()
            .expect("byte index starts at a character");
        out.push(if ch.is_control() { ' ' } else { ch });
        idx += ch.len_utf8();
    }
    Cow::Owned(out)
}

fn parse_osc8_payload(text: &str) -> Option<(&str, usize)> {
    let bytes = text.as_bytes();
    let mut idx = 0usize;
    while idx < bytes.len() {
        if bytes[idx] == b'\x07' {
            return Some((&text[..idx], idx + 1));
        }
        if idx + 1 < bytes.len() && bytes[idx] == b'\x1b' && bytes[idx + 1] == b'\\' {
            return Some((&text[..idx], idx + 2));
        }
        let ch = text[idx..].chars().next()?;
        idx += ch.len_utf8();
    }
    None
}

fn push_styled_content(out: &mut Vec<Span<'static>>, content: &str, style: ratatui::style::Style) {
    if let Some(last) = out.last_mut()
        && last.style == style
    {
        last.content.to_mut().push_str(content);
        return;
    }
    out.push(Span::styled(content.to_string(), style));
}

fn append_to_last_span(out: &mut [Span<'static>], content: &str) {
    if let Some(last) = out.last_mut() {
        last.content.to_mut().push_str(content);
    }
}

#[cfg(test)]
pub(crate) fn strip_osc8(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut stripped = String::with_capacity(text.len());
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index..].starts_with(b"\x1b]8;;") {
            index += 5;
            while index < bytes.len() {
                if bytes[index] == b'\x07' {
                    index += 1;
                    break;
                }
                if index + 1 < bytes.len() && bytes[index] == b'\x1b' && bytes[index + 1] == b'\\' {
                    index += 2;
                    break;
                }
                index += 1;
            }
            continue;
        }
        let ch = text[index..]
            .chars()
            .next()
            .expect("current byte index starts a character");
        stripped.push(ch);
        index += ch.len_utf8();
    }

    stripped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annotates_bare_url_without_trailing_punctuation() {
        let line = annotate_web_urls_in_line(Line::from("See (https://example.com/path)."));

        assert_eq!(
            line.hyperlinks,
            vec![TerminalHyperlink {
                columns: 5..29,
                destination: "https://example.com/path".to_string(),
            }]
        );
    }

    #[test]
    fn rejects_non_web_destinations_and_control_chars() {
        assert_eq!(web_destination("mailto:test@example.com"), None);
        assert_eq!(
            web_destination("https://example.com/\u{1b}]8;;bad"),
            Some("https://example.com/]8;;bad".to_string())
        );
    }

    #[test]
    fn decorates_visible_range_only() {
        let line = annotate_web_urls_in_line(Line::from("See https://example.com."));
        let decorated = decorate_spans(&line);
        let text = decorated
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert!(text.contains("\x1b]8;;https://example.com\x07"));
        assert_eq!(strip_osc8(&text), "See https://example.com.");
    }

    #[test]
    fn marks_buffer_url_cells_without_changing_visible_text() {
        let area = Rect::new(0, 0, 32, 1);
        let mut buffer = Buffer::empty(area);
        buffer.set_string(
            0,
            0,
            "See https://example.com.",
            ratatui::style::Style::default(),
        );

        mark_buffer_web_urls(&mut buffer, area);

        let row = (0..area.width)
            .map(|x| buffer[(x, 0)].symbol().to_string())
            .collect::<String>();
        assert!(row.contains("\x1b]8;;https://example.com\x07"));
        let visible = strip_osc8(&row);
        assert!(visible.starts_with("See https://example.com."));
        assert_eq!(visible.width(), usize::from(area.width));
    }

    #[test]
    fn safe_print_preserves_valid_osc8_and_sanitizes_other_controls() {
        let text = "pre\x1b]2;bad\x07 \x1b]8;;https://example.com\x07x\x1b]8;;\x07";
        let safe = safe_print_text_preserving_osc8(text);

        assert!(!safe.contains("\x1b]2;bad"));
        assert!(safe.contains("\x1b]8;;https://example.com\x07x\x1b]8;;\x07"));
    }
}

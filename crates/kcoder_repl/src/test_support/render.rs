use crate::terminal_hyperlinks::HyperlinkLine;
use ratatui::{buffer::Buffer, text::Line};

pub(crate) fn lines_to_text(lines: &[Line<'_>]) -> String {
    lines
        .iter()
        .map(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn buffer_row_text(buffer: &Buffer, y: u16) -> String {
    (buffer.area.left()..buffer.area.right())
        .map(|x| buffer[(x, y)].symbol())
        .collect::<String>()
}

pub(crate) fn buffer_find_row_containing(buffer: &Buffer, needle: &str) -> Option<u16> {
    (buffer.area.top()..buffer.area.bottom()).find(|&y| buffer_row_text(buffer, y).contains(needle))
}

pub(crate) fn buffer_dump(buffer: &Buffer) -> String {
    (buffer.area.top()..buffer.area.bottom())
        .map(|y| format!("{y:02}: {}", buffer_row_text(buffer, y)))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn hyperlink_line_text(line: &HyperlinkLine) -> String {
    line.line
        .spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect()
}

pub(crate) fn hyperlink_lines_to_text(lines: &[HyperlinkLine]) -> String {
    lines
        .iter()
        .map(hyperlink_line_text)
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn text_column_range(text: &str, needle: &str) -> std::ops::Range<usize> {
    let start_byte = text.find(needle).expect("needle should be present");
    let start = unicode_width::UnicodeWidthStr::width(&text[..start_byte]);
    start..start + unicode_width::UnicodeWidthStr::width(needle)
}

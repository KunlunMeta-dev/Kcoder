//! Width-aware inline wrapping preserving styles and hyperlinks.

use super::*;

#[derive(Clone, Debug)]
pub(super) struct StyledCell {
    pub(super) ch: char,
    pub(super) width: usize,
    pub(super) style: Style,
    pub(super) source_columns: Range<usize>,
}

#[derive(Clone, Debug)]
pub(super) struct BodyWord {
    pub(super) cells: Vec<StyledCell>,
    pub(super) width: usize,
    pub(super) url_like: bool,
}

pub(super) fn wrap_markdown_hyperlink_lines(
    lines: Vec<HyperlinkLine>,
    width: usize,
) -> Vec<HyperlinkLine> {
    let mut wrapped = Vec::new();
    let mut wrapper = MarkdownLineWrapper::default();
    for line in lines {
        wrapped.extend(wrapper.wrap_line(line, width).0);
    }
    wrapped
}

#[derive(Default)]
pub(super) struct MarkdownLineWrapper {
    pub(super) pending_wrapped_list_indent: Option<usize>,
    pub(super) last_navigation_source: Option<usize>,
}

impl MarkdownLineWrapper {
    pub(super) fn wrap_line(
        &mut self,
        line: HyperlinkLine,
        width: usize,
    ) -> (Vec<HyperlinkLine>, usize) {
        let width = width.max(1);
        let mut wrapped = Vec::new();
        let mut original_start = 0;
        let text = hyperlink_line_text(&line);
        if let Some(indent) = self.pending_wrapped_list_indent.take()
            && markdown_list_marker_indent(&text) == Some(indent)
        {
            wrapped.push(HyperlinkLine::new(Line::from("")));
            original_start = 1;
        }
        let list_marker_indent = markdown_list_marker_indent(&text);
        if line.preformatted || line.width() <= width || should_skip_markdown_width_wrap(&text) {
            wrapped.push(line);
            return (wrapped, original_start);
        }
        let wrapped_lines = wrap_hyperlink_line_preserving_indent(line, width, true);
        if wrapped_lines.len() > 1 {
            self.pending_wrapped_list_indent = list_marker_indent;
        }
        wrapped.extend(wrapped_lines);
        (wrapped, original_start)
    }
}

pub(super) fn markdown_list_marker_indent(text: &str) -> Option<usize> {
    let indent = text.bytes().take_while(|byte| *byte == b' ').count();
    let rest = &text[indent..];
    if rest.starts_with("- ") {
        return Some(indent);
    }

    let digit_count = rest
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digit_count > 0 && rest[digit_count..].starts_with(". ") {
        Some(indent)
    } else {
        None
    }
}

pub(super) fn should_skip_markdown_width_wrap(text: &str) -> bool {
    let trimmed = text.trim_start();
    matches!(trimmed.chars().next(), Some('├' | '┌' | '└' | '┼'))
        || trimmed
            .chars()
            .all(|ch| matches!(ch, '=' | '-' | '━' | '─' | ' '))
}

pub(super) fn wrap_hyperlink_line_preserving_indent(
    line: HyperlinkLine,
    width: usize,
    preserve_url_like_tokens: bool,
) -> Vec<HyperlinkLine> {
    let cells = styled_cells(&line);
    if cells.is_empty() {
        return vec![line];
    }
    let text = cells.iter().map(|cell| cell.ch).collect::<String>();
    let prefix_cols = markdown_body_prefix_width(&text);
    let prefix_cells = take_prefix_cells(&cells, prefix_cols);
    let body_cells = cells
        .iter()
        .filter(|cell| cell.source_columns.start >= prefix_cols)
        .cloned()
        .collect::<Vec<_>>();
    if body_cells.is_empty() {
        return vec![line];
    }

    let words = body_words(body_cells);
    if words.is_empty() {
        return vec![line];
    }

    let continuation_prefix = markdown_continuation_prefix(&text, prefix_cols);
    let continuation_width = unicode_width::UnicodeWidthStr::width(continuation_prefix.as_str());
    let mut rows: Vec<Vec<StyledCell>> = Vec::new();
    let mut current = Vec::new();
    let mut current_width = 0usize;
    let mut row_index = 0usize;

    for word in words {
        let prefix_width = if row_index == 0 {
            prefix_cols
        } else {
            continuation_width
        };
        let available = width.saturating_sub(prefix_width).max(1);
        let separator_width = usize::from(!current.is_empty());

        if !current.is_empty()
            && current_width
                .saturating_add(separator_width)
                .saturating_add(word.width)
                <= available
        {
            current.push(space_cell());
            current_width = current_width.saturating_add(1);
            current_width = current_width.saturating_add(word.width);
            current.extend(word.cells);
            continue;
        }

        if !current.is_empty() {
            rows.push(std::mem::take(&mut current));
            row_index = row_index.saturating_add(1);
        }

        let prefix_width = if row_index == 0 {
            prefix_cols
        } else {
            continuation_width
        };
        let available = width.saturating_sub(prefix_width).max(1);
        if word.width <= available || (preserve_url_like_tokens && word.url_like) {
            current_width = word.width;
            current.extend(word.cells);
            continue;
        }

        let mut chunks = split_long_body_word(word.cells, available).into_iter();
        if let Some(first_chunk) = chunks.next() {
            current_width = cells_width(&first_chunk);
            current = first_chunk;
        }
        for chunk in chunks {
            rows.push(std::mem::take(&mut current));
            row_index = row_index.saturating_add(1);
            current_width = cells_width(&chunk);
            current = chunk;
        }
    }

    if !current.is_empty() {
        rows.push(current);
    }

    rows.into_iter()
        .enumerate()
        .map(|(idx, row)| {
            let prefix = if idx == 0 {
                cells_to_spans(&prefix_cells)
            } else {
                vec![Span::styled(
                    continuation_prefix.clone(),
                    KCODER_UI_THEME.text_styles().muted,
                )]
            };
            build_wrapped_hyperlink_line(prefix, row, &line)
        })
        .collect()
}

pub(super) fn split_long_body_word(cells: Vec<StyledCell>, width: usize) -> Vec<Vec<StyledCell>> {
    let width = width.max(1);
    let mut chunks = Vec::new();
    let mut current = Vec::new();
    let mut current_width = 0usize;

    for cell in cells {
        if current_width > 0 && current_width.saturating_add(cell.width) > width {
            if let Some(split_index) = preferred_path_split_index(&current) {
                let remainder = current.split_off(split_index);
                chunks.push(std::mem::take(&mut current));
                current = remainder;
                current_width = cells_width(&current);
            }
            if current_width > 0 && current_width.saturating_add(cell.width) > width {
                chunks.push(std::mem::take(&mut current));
                current_width = 0;
            }
        }
        current_width = current_width.saturating_add(cell.width);
        current.push(cell);
    }

    if !current.is_empty() {
        chunks.push(current);
    }

    chunks
}

pub(super) fn preferred_path_split_index(cells: &[StyledCell]) -> Option<usize> {
    cells.iter().enumerate().rev().find_map(|(idx, cell)| {
        is_path_split_boundary(cell.ch)
            .then_some(idx + 1)
            .filter(|split| *split < cells.len())
    })
}

pub(super) fn is_path_split_boundary(ch: char) -> bool {
    matches!(ch, '/' | '\\')
}

pub(super) fn cells_width(cells: &[StyledCell]) -> usize {
    cells.iter().map(|cell| cell.width).sum()
}

pub(super) fn styled_cells(line: &HyperlinkLine) -> Vec<StyledCell> {
    let mut cells = Vec::new();
    let mut column = 0usize;
    for span in &line.line.spans {
        for ch in span.content.chars() {
            let width = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
            cells.push(StyledCell {
                ch,
                width,
                style: span.style,
                source_columns: column..column + width,
            });
            column = column.saturating_add(width);
        }
    }
    cells
}

pub(super) fn take_prefix_cells(cells: &[StyledCell], prefix_cols: usize) -> Vec<StyledCell> {
    cells
        .iter()
        .filter(|cell| cell.source_columns.end <= prefix_cols)
        .cloned()
        .collect()
}

pub(super) fn body_words(cells: Vec<StyledCell>) -> Vec<BodyWord> {
    let mut words = Vec::new();
    let mut current = Vec::new();
    for cell in cells {
        if cell.ch.is_whitespace() {
            push_body_word(&mut words, &mut current);
        } else {
            current.push(cell);
        }
    }
    push_body_word(&mut words, &mut current);
    words
}

pub(super) fn push_body_word(words: &mut Vec<BodyWord>, current: &mut Vec<StyledCell>) {
    if current.is_empty() {
        return;
    }
    let cells = std::mem::take(current);
    let width = cells.iter().map(|cell| cell.width).sum();
    let text = cells.iter().map(|cell| cell.ch).collect::<String>();
    words.push(BodyWord {
        cells,
        width,
        url_like: text_contains_url_like(&text),
    });
}

pub(super) fn markdown_body_prefix_width(text: &str) -> usize {
    let mut prefix = 0usize;
    let mut rest = text;

    let leading_spaces = rest.chars().take_while(|ch| *ch == ' ').count();
    prefix = prefix.saturating_add(leading_spaces);
    rest = &rest[leading_spaces..];

    while let Some(after_quote) = rest.strip_prefix("> ") {
        prefix = prefix.saturating_add(2);
        rest = after_quote;
    }

    if rest.starts_with("• ") || rest.starts_with("- ") || rest.starts_with("* ") {
        return prefix.saturating_add(2);
    }

    let mut marker_width = 0usize;
    let mut chars = rest.chars().peekable();
    while chars.peek().is_some_and(|ch| ch.is_ascii_digit()) {
        chars.next();
        marker_width = marker_width.saturating_add(1);
    }
    if marker_width > 0 && chars.next() == Some('.') {
        marker_width = marker_width.saturating_add(1);
        if chars.peek() == Some(&' ') {
            marker_width = marker_width.saturating_add(1);
        }
        return prefix.saturating_add(marker_width);
    }

    if prefix > 0 && text.trim_start().starts_with("> ") {
        return prefix;
    }

    0
}

pub(super) fn markdown_continuation_prefix(text: &str, prefix_cols: usize) -> String {
    if prefix_cols == 0 {
        return String::new();
    }

    let prefix = text
        .chars()
        .scan(0usize, |used, ch| {
            let width = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
            if used.saturating_add(width) > prefix_cols {
                None
            } else {
                *used = used.saturating_add(width);
                Some(ch)
            }
        })
        .collect::<String>();

    if prefix.contains('>') {
        prefix
            .chars()
            .map(|ch| if ch == '>' { '>' } else { ' ' })
            .collect()
    } else {
        " ".repeat(prefix_cols)
    }
}

pub(super) fn build_wrapped_hyperlink_line(
    prefix: Vec<Span<'static>>,
    body: Vec<StyledCell>,
    source: &HyperlinkLine,
) -> HyperlinkLine {
    let mut spans = prefix;
    let mut hyperlinks = Vec::new();
    let mut column = spans
        .iter()
        .map(|span| unicode_width::UnicodeWidthStr::width(span.content.as_ref()))
        .sum::<usize>();
    let mut active_link: Option<(String, usize)> = None;

    for cell in body {
        let link_destination = source
            .hyperlinks
            .iter()
            .find(|link| {
                link.columns.start < cell.source_columns.end
                    && link.columns.end > cell.source_columns.start
            })
            .map(|link| link.destination.clone());

        if active_link.as_ref().map(|(dest, _)| dest) != link_destination.as_ref() {
            if let Some((destination, start)) = active_link.take()
                && start < column
            {
                hyperlinks.push(TerminalHyperlink {
                    columns: start..column,
                    destination,
                });
            }
            if let Some(destination) = link_destination {
                active_link = Some((destination, column));
            }
        }

        push_styled_span_char(&mut spans, cell.ch, cell.style);
        column = column.saturating_add(cell.width);
    }

    if let Some((destination, start)) = active_link
        && start < column
    {
        hyperlinks.push(TerminalHyperlink {
            columns: start..column,
            destination,
        });
    }

    HyperlinkLine {
        line: Line::from(spans).style(source.line.style),
        hyperlinks,
        preformatted: false,
    }
}

pub(super) fn cells_to_spans(cells: &[StyledCell]) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    for cell in cells {
        push_styled_span_char(&mut spans, cell.ch, cell.style);
    }
    spans
}

pub(super) fn push_styled_span_char(spans: &mut Vec<Span<'static>>, ch: char, style: Style) {
    if let Some(last) = spans.last_mut()
        && last.style == style
    {
        last.content.to_mut().push(ch);
        return;
    }
    spans.push(Span::styled(ch.to_string(), style));
}

pub(super) fn space_cell() -> StyledCell {
    StyledCell {
        ch: ' ',
        width: 1,
        style: Style::default(),
        source_columns: usize::MAX..usize::MAX,
    }
}

pub(super) fn hyperlink_line_text(line: &HyperlinkLine) -> String {
    line.line
        .spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect()
}

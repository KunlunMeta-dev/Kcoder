//! Table sizing, alignment, adaptive record rendering, and pipe fallback.

use super::*;

pub(super) fn table_column_count(table_state: &TableState) -> usize {
    let header_cols = table_state.header.as_ref().map_or(0, Vec::len);
    let row_cols = table_state
        .rows
        .iter()
        .map(|row| row.cells.len())
        .max()
        .unwrap_or(0);
    table_state.alignments.len().max(header_cols).max(row_cols)
}

pub(super) fn normalize_table_row(row: &mut Vec<TableCell>, column_count: usize) {
    row.resize_with(column_count, TableCell::default);
    row.truncate(column_count);
}

pub(super) fn table_column_widths(
    header: &[TableCell],
    rows: &[Vec<TableCell>],
    column_count: usize,
) -> Vec<usize> {
    (0..column_count)
        .map(|idx| {
            let header_width = header.get(idx).map_or(0, table_cell_width);
            let body_width = rows
                .iter()
                .filter_map(|row| row.get(idx))
                .map(table_cell_width)
                .max()
                .unwrap_or(0);
            header_width.max(body_width).max(3)
        })
        .collect()
}

pub(super) fn table_rendered_width(widths: &[usize]) -> usize {
    if widths.is_empty() {
        return 0;
    }
    widths.iter().sum::<usize>()
        + (widths.len().saturating_sub(1) * TABLE_COLUMN_GAP)
        + (widths.len() * TABLE_CELL_PADDING * 2)
}

pub(super) fn constrained_table_column_widths(
    natural_widths: &[usize],
    metrics: &[TableColumnMetrics],
    width: Option<usize>,
) -> Option<Vec<usize>> {
    let Some(max_width) = width else {
        return Some(natural_widths.to_vec());
    };
    if table_rendered_width(natural_widths) <= max_width {
        return Some(natural_widths.to_vec());
    }

    let min_total = table_rendered_width(&vec![TABLE_MIN_COLUMN_WIDTH; natural_widths.len()]);
    if max_width < min_total {
        return None;
    }

    let mut floors = metrics
        .iter()
        .map(|metrics| preferred_column_floor(metrics, TABLE_MIN_COLUMN_WIDTH))
        .collect::<Vec<_>>();
    while table_rendered_width(&floors) > max_width {
        let Some((idx, _)) = floors
            .iter()
            .enumerate()
            .filter(|(_, floor)| **floor > TABLE_MIN_COLUMN_WIDTH)
            .min_by_key(|(idx, floor)| {
                (
                    column_shrink_priority(metrics[*idx].kind),
                    usize::MAX.saturating_sub(**floor),
                )
            })
        else {
            break;
        };
        floors[idx] -= 1;
    }

    let mut widths = natural_widths.to_vec();
    while table_rendered_width(&widths) > max_width {
        let Some(idx) = next_column_to_shrink(&widths, &floors, metrics) else {
            break;
        };
        widths[idx] -= 1;
    }

    if table_rendered_width(&widths) <= max_width {
        Some(widths)
    } else {
        None
    }
}

pub(super) fn collect_table_column_metrics(
    header: &[TableCell],
    rows: &[Vec<TableCell>],
    column_count: usize,
) -> Vec<TableColumnMetrics> {
    let mut metrics = Vec::with_capacity(column_count);
    for column in 0..column_count {
        let header_cell = &header[column];
        let header_plain = header_cell.text();
        let header_token_width = longest_token_width(&header_plain);
        let mut max_width = table_cell_width(header_cell);
        let mut body_token_width = 0usize;
        let mut body_token_count = 0usize;
        let mut long_body_token_count = 0usize;
        let mut total_words = 0usize;
        let mut total_cells = 0usize;
        let mut total_cell_width = 0usize;

        for row in rows {
            let cell = &row[column];
            max_width = max_width.max(table_cell_width(cell));
            let plain = cell.text();
            body_token_width = body_token_width.max(longest_token_width(&plain));
            let word_count = plain.split_whitespace().count();
            if word_count > 0 {
                body_token_count += word_count;
                long_body_token_count += plain
                    .split_whitespace()
                    .filter(|token| unicode_width::UnicodeWidthStr::width(*token) >= 20)
                    .count();
                total_words += word_count;
                total_cells += 1;
                total_cell_width += unicode_width::UnicodeWidthStr::width(plain.as_str());
            }
        }

        let avg_words_per_cell = if total_cells == 0 {
            header_plain.split_whitespace().count() as f64
        } else {
            total_words as f64 / total_cells as f64
        };
        let avg_cell_width = if total_cells == 0 {
            unicode_width::UnicodeWidthStr::width(header_plain.as_str()) as f64
        } else {
            total_cell_width as f64 / total_cells as f64
        };
        let kind = if long_body_token_count > 0
            && long_body_token_count >= body_token_count.saturating_sub(long_body_token_count)
        {
            TableColumnKind::TokenHeavy
        } else if avg_words_per_cell >= 4.0 || avg_cell_width >= 28.0 {
            TableColumnKind::Narrative
        } else {
            TableColumnKind::Compact
        };

        metrics.push(TableColumnMetrics {
            max_width,
            header_token_width,
            body_token_width,
            kind,
        });
    }
    metrics
}

pub(super) fn preferred_column_floor(
    metrics: &TableColumnMetrics,
    min_column_width: usize,
) -> usize {
    let token_target = match metrics.kind {
        TableColumnKind::Narrative | TableColumnKind::TokenHeavy => 16,
        TableColumnKind::Compact => metrics
            .header_token_width
            .max(metrics.body_token_width.min(16)),
    };
    token_target
        .max(min_column_width)
        .min(metrics.max_width.max(min_column_width))
}

pub(super) fn next_column_to_shrink(
    widths: &[usize],
    floors: &[usize],
    metrics: &[TableColumnMetrics],
) -> Option<usize> {
    widths
        .iter()
        .enumerate()
        .filter(|(idx, width)| **width > floors[*idx])
        .min_by_key(|(idx, width)| {
            let slack = width.saturating_sub(floors[*idx]);
            (
                column_shrink_priority(metrics[*idx].kind),
                usize::MAX.saturating_sub(slack),
            )
        })
        .map(|(idx, _)| idx)
}

pub(super) fn column_shrink_priority(kind: TableColumnKind) -> usize {
    match kind {
        TableColumnKind::TokenHeavy => 0,
        TableColumnKind::Narrative => 1,
        TableColumnKind::Compact => 2,
    }
}

pub(super) fn longest_token_width(text: &str) -> usize {
    text.split_whitespace()
        .map(unicode_width::UnicodeWidthStr::width)
        .max()
        .unwrap_or(0)
}

pub(super) fn table_should_render_records(
    rows: &[Vec<TableCell>],
    column_widths: &[usize],
    metrics: &[TableColumnMetrics],
) -> bool {
    if rows.is_empty() {
        return false;
    }

    let affected_rows = rows
        .iter()
        .filter(|row| {
            let contains_fragmented_value =
                row.iter()
                    .zip(column_widths)
                    .zip(metrics)
                    .any(|((cell, width), metrics)| {
                        let has_fragmented_token = cell
                            .text()
                            .split_whitespace()
                            .any(|token| unicode_width::UnicodeWidthStr::width(token) > *width);
                        match metrics.kind {
                            TableColumnKind::Compact => has_fragmented_token,
                            TableColumnKind::TokenHeavy => {
                                *width < MIN_SCANNABLE_TOKEN_HEAVY_WIDTH && has_fragmented_token
                            }
                            TableColumnKind::Narrative => false,
                        }
                    });

            contains_fragmented_value || expansive_cells_are_starved(row, column_widths, metrics)
        })
        .count();
    let threshold = if rows.len() == 1 {
        1
    } else {
        2.max(rows.len().div_ceil(3))
    };

    affected_rows >= threshold
}

pub(super) fn expansive_cells_are_starved(
    row: &[TableCell],
    column_widths: &[usize],
    metrics: &[TableColumnMetrics],
) -> bool {
    let body_style = KCODER_UI_THEME.text_styles().body;
    let expansive_cells = row
        .iter()
        .zip(column_widths)
        .zip(metrics)
        .filter(|&((_cell, _width), metrics)| metrics.kind != TableColumnKind::Compact)
        .map(|((cell, width), metrics)| {
            (
                metrics.kind,
                *width,
                wrap_table_cell(cell, *width, body_style).len(),
            )
        })
        .collect::<Vec<_>>();

    expansive_cells
        .iter()
        .filter(|(_, _, height)| *height >= CRAMPED_EXPANSIVE_CELL_LINES)
        .count()
        >= 2
        || expansive_cells.iter().any(|(kind, width, height)| {
            *kind == TableColumnKind::Narrative
                && *width < MIN_SCANNABLE_NARRATIVE_WIDTH
                && *height >= CATASTROPHIC_NARRATIVE_CELL_LINES
        })
}

pub(super) fn is_table_spillover_row(row: &TableBodyRow, next_row: Option<&TableBodyRow>) -> bool {
    let Some(first_text) = first_non_empty_only_cell_text(&row.cells) else {
        return false;
    };

    if !row.has_table_pipe_syntax {
        return true;
    }

    if looks_like_html_content(&first_text) {
        return true;
    }

    if first_text.trim_end().ends_with(':') {
        if next_row
            .and_then(|row| first_non_empty_only_cell_text(&row.cells))
            .is_some_and(|text| looks_like_html_content(&text))
        {
            return true;
        }

        if next_row.is_none() && looks_like_html_label_line(&first_text) {
            return true;
        }
    }

    false
}

pub(super) fn first_non_empty_only_cell_text(row: &[TableCell]) -> Option<String> {
    let first = row.first()?.text();
    if first.trim().is_empty() {
        return None;
    }
    row[1..]
        .iter()
        .all(|cell| cell.text().trim().is_empty())
        .then_some(first)
}

pub(super) fn looks_like_html_content(text: &str) -> bool {
    let bytes = text.as_bytes();
    for (idx, &byte) in bytes.iter().enumerate() {
        if byte != b'<' {
            continue;
        }

        let mut tag_start = idx + 1;
        if bytes
            .get(tag_start)
            .is_some_and(|byte| matches!(byte, b'/' | b'!'))
        {
            tag_start += 1;
        }

        if bytes.get(tag_start).is_some_and(u8::is_ascii_alphabetic)
            && bytes
                .get(tag_start + 1..)
                .is_some_and(|suffix| suffix.contains(&b'>'))
        {
            return true;
        }
    }
    false
}

pub(super) fn looks_like_html_label_line(text: &str) -> bool {
    let trimmed = text.trim();
    if !trimmed.ends_with(':') {
        return false;
    }
    trimmed
        .trim_end_matches(':')
        .split_whitespace()
        .any(|word| word.eq_ignore_ascii_case("html"))
}

pub(super) fn table_cell_to_hyperlink_line(cell: TableCell) -> HyperlinkLine {
    HyperlinkLine {
        line: Line::from(cell.spans),
        hyperlinks: cell.hyperlinks,
        preformatted: false,
    }
}

pub(super) fn table_cell_width(cell: &TableCell) -> usize {
    unicode_width::UnicodeWidthStr::width(cell.text().as_str())
}

pub(super) fn render_table_row(
    row: &[TableCell],
    alignments: &[Alignment],
    widths: &[usize],
    is_header: bool,
    styles: UiTextStyles,
) -> Vec<HyperlinkLine> {
    let base_style = if is_header {
        styles.table_header
    } else {
        styles.table_body
    };
    let wrapped_cells = row
        .iter()
        .zip(widths.iter())
        .map(|(cell, width)| wrap_table_cell(cell, *width, base_style))
        .collect::<Vec<_>>();
    let row_height = wrapped_cells.iter().map(Vec::len).max().unwrap_or(1);
    let mut rows = Vec::with_capacity(row_height);

    for row_idx in 0..row_height {
        let Some(last_visible_column) = wrapped_cells
            .iter()
            .rposition(|lines| lines.get(row_idx).is_some_and(|line| line.width() > 0))
        else {
            rows.push(HyperlinkLine::new(Line::from("").style(base_style)));
            continue;
        };

        let mut spans = Vec::new();
        let mut hyperlinks = Vec::new();
        let mut column = 0usize;

        for (idx, width) in widths
            .iter()
            .enumerate()
            .take(last_visible_column.saturating_add(1))
        {
            push_table_padding(&mut spans, TABLE_CELL_PADDING);
            column += TABLE_CELL_PADDING;

            let alignment = alignments.get(idx).copied().unwrap_or(Alignment::None);
            let cell_line = wrapped_cells
                .get(idx)
                .and_then(|lines| lines.get(row_idx))
                .cloned()
                .unwrap_or_default();
            let cell_width = cell_line.width();
            let remaining = width.saturating_sub(cell_width);
            let (left_pad, right_pad) = match alignment {
                Alignment::Right => (remaining, 0),
                Alignment::Center => (remaining / 2, remaining - (remaining / 2)),
                Alignment::Left | Alignment::None => (0, remaining),
            };
            if left_pad > 0 {
                spans.push(Span::raw(" ".repeat(left_pad)));
                column += left_pad;
            }

            hyperlinks.extend(cell_line.hyperlinks.into_iter().map(|mut link| {
                link.columns = link.columns.start + column..link.columns.end + column;
                link
            }));
            column += cell_width;
            spans.extend(cell_line.line.spans);

            let is_last_column = idx == last_visible_column;
            if right_pad > 0 && !is_last_column {
                spans.push(Span::raw(" ".repeat(right_pad)));
                column += right_pad;
            }
            if !is_last_column {
                push_table_padding(&mut spans, TABLE_CELL_PADDING);
                column += TABLE_CELL_PADDING;
                spans.push(Span::raw(" ".repeat(TABLE_COLUMN_GAP)));
                column += TABLE_COLUMN_GAP;
            }
        }

        rows.push(HyperlinkLine {
            line: Line::from(spans).style(base_style),
            hyperlinks,
            preformatted: false,
        });
    }

    rows
}

pub(super) fn push_table_padding(spans: &mut Vec<Span<'static>>, width: usize) {
    if width > 0 {
        spans.push(Span::raw(" ".repeat(width)));
    }
}

pub(super) fn wrap_table_cell(
    cell: &TableCell,
    width: usize,
    base_style: Style,
) -> Vec<HyperlinkLine> {
    let mut line = HyperlinkLine {
        line: Line::from(
            cell.spans
                .iter()
                .cloned()
                .map(|mut span| {
                    span.style = base_style.patch(span.style);
                    span
                })
                .collect::<Vec<_>>(),
        ),
        hyperlinks: cell.hyperlinks.clone(),
        preformatted: false,
    };
    if line.line.spans.is_empty() {
        line.line.spans.push(Span::styled("", base_style));
    }

    if line.width() <= width {
        vec![line]
    } else {
        wrap_hyperlink_line_preserving_indent(line, width.max(1), false)
    }
}

pub(super) fn render_table_records(
    header: &[TableCell],
    rows: &[Vec<TableCell>],
    metrics: &[TableColumnMetrics],
    width: Option<usize>,
    styles: UiTextStyles,
) -> Vec<HyperlinkLine> {
    let label_style = styles.table_header;
    let value_style = styles.table_body;
    let label_width = header
        .iter()
        .map(table_cell_width)
        .max()
        .unwrap_or(0)
        .max(1);
    let minimum_value_width = if metrics
        .iter()
        .any(|metrics| metrics.kind != TableColumnKind::Compact)
    {
        MIN_ALIGNED_EXPANSIVE_VALUE_WIDTH
    } else {
        MIN_ALIGNED_COMPACT_VALUE_WIDTH
    };
    let aligned = width.is_none_or(|width| {
        FIELD_LEADING_PADDING + label_width + FIELD_GAP + minimum_value_width <= width
    });
    let mut output = Vec::new();

    for (row_idx, row) in rows.iter().enumerate() {
        for (idx, value) in row.iter().enumerate() {
            let label = header
                .get(idx)
                .map(TableCell::text)
                .filter(|text| !text.trim().is_empty())
                .unwrap_or_else(|| format!("Column {}", idx + 1));
            if aligned {
                let indent = FIELD_LEADING_PADDING + label_width + FIELD_GAP;
                let value_width = width
                    .map(|width| width.saturating_sub(indent).max(MIN_RECORD_VALUE_WIDTH))
                    .unwrap_or_else(|| table_cell_width(value).max(MIN_RECORD_VALUE_WIDTH));
                let wrapped = wrap_table_cell(value, value_width, value_style);
                for (line_idx, value_line) in wrapped.into_iter().enumerate() {
                    let mut prefix = if line_idx == 0 {
                        let right_pad = label_width
                            .saturating_sub(unicode_width::UnicodeWidthStr::width(label.as_str()));
                        vec![
                            Span::raw(" ".repeat(FIELD_LEADING_PADDING)),
                            Span::styled(label.clone(), label_style),
                            Span::raw(" ".repeat(right_pad + FIELD_GAP)),
                        ]
                    } else {
                        vec![Span::raw(" ".repeat(indent))]
                    };
                    output.push(prefix_hyperlink_line(&mut prefix, value_line));
                }
            } else {
                let label_width = width
                    .map(|width| width.saturating_sub(FIELD_LEADING_PADDING).max(1))
                    .unwrap_or_else(|| {
                        unicode_width::UnicodeWidthStr::width(label.as_str()).max(1)
                    });
                let label_line = HyperlinkLine::new(Line::from(Span::styled(label, label_style)));
                for label_line in
                    wrap_hyperlink_line_preserving_indent(label_line, label_width, false)
                {
                    let mut prefix = vec![Span::raw(" ".repeat(FIELD_LEADING_PADDING))];
                    output.push(prefix_hyperlink_line(&mut prefix, label_line));
                }

                let value_width =
                    width.map(|width| width.saturating_sub(STACKED_RECORD_VALUE_INDENT).max(1));
                for value_line in wrap_table_cell(value, value_width.unwrap_or(1), value_style) {
                    let mut prefix = vec![Span::raw(" ".repeat(STACKED_RECORD_VALUE_INDENT))];
                    output.push(prefix_hyperlink_line(&mut prefix, value_line));
                }
            }
        }

        if row_idx + 1 < rows.len() {
            let separator_width =
                width.unwrap_or_else(|| widest_hyperlink_line_width(&output).max(label_width));
            output.push(HyperlinkLine::new(Line::from(Span::styled(
                TABLE_BODY_SEPARATOR
                    .to_string()
                    .repeat(separator_width.max(1)),
                styles.table_separator,
            ))));
        }
    }

    output
}

pub(super) fn widest_hyperlink_line_width(lines: &[HyperlinkLine]) -> usize {
    lines.iter().map(HyperlinkLine::width).max().unwrap_or(0)
}

pub(super) fn render_table_pipe_fallback(
    header: &[TableCell],
    rows: &[Vec<TableCell>],
    alignments: &[Alignment],
    styles: UiTextStyles,
) -> Vec<HyperlinkLine> {
    let mut output = Vec::with_capacity(rows.len() + 2);
    output.push(row_to_pipe_line(header, styles.table_header));
    output.push(HyperlinkLine::new(
        Line::from(alignments_to_pipe_delimiter(alignments)).style(styles.table_separator),
    ));
    output.extend(
        rows.iter()
            .map(|row| row_to_pipe_line(row, styles.table_body)),
    );
    output
}

pub(super) fn row_to_pipe_line(row: &[TableCell], body_style: Style) -> HyperlinkLine {
    let mut spans = Vec::new();
    let mut hyperlinks = Vec::new();
    let mut column = 0usize;
    push_pipe_line_text(&mut spans, &mut column, "|", body_style);
    for cell in row {
        push_pipe_line_text(&mut spans, &mut column, " ", body_style);
        append_table_cell_to_pipe_line(cell, &mut spans, &mut hyperlinks, &mut column);
        push_pipe_line_text(&mut spans, &mut column, " |", body_style);
    }

    HyperlinkLine {
        line: Line::from(spans),
        hyperlinks,
        preformatted: false,
    }
}

pub(super) fn append_table_cell_to_pipe_line(
    cell: &TableCell,
    spans: &mut Vec<Span<'static>>,
    hyperlinks: &mut Vec<TerminalHyperlink>,
    column: &mut usize,
) {
    let mut source_column = 0usize;
    for span in &cell.spans {
        let mut segment = String::new();
        let mut active_link: Option<(String, usize)> = None;

        for ch in span.content.chars() {
            let source_width = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
            let link_destination = cell
                .hyperlinks
                .iter()
                .find(|link| link.columns.contains(&source_column))
                .map(|link| link.destination.clone());

            if active_link.as_ref().map(|(dest, _)| dest) != link_destination.as_ref() {
                push_pipe_line_segment(spans, &mut segment, span.style);
                if let Some((destination, start)) = active_link.take()
                    && start < *column
                {
                    hyperlinks.push(TerminalHyperlink {
                        columns: start..*column,
                        destination,
                    });
                }
                if let Some(destination) = link_destination {
                    active_link = Some((destination, *column));
                }
            }

            let rendered = if ch == '|' { "\\|" } else { "" };
            if ch == '|' {
                segment.push_str(rendered);
                *column = column.saturating_add(2);
            } else {
                segment.push(ch);
                *column = column.saturating_add(source_width);
            }
            source_column = source_column.saturating_add(source_width);
        }

        push_pipe_line_segment(spans, &mut segment, span.style);
        if let Some((destination, start)) = active_link
            && start < *column
        {
            hyperlinks.push(TerminalHyperlink {
                columns: start..*column,
                destination,
            });
        }
    }
}

pub(super) fn push_pipe_line_segment(
    spans: &mut Vec<Span<'static>>,
    segment: &mut String,
    style: Style,
) {
    if !segment.is_empty() {
        spans.push(Span::styled(std::mem::take(segment), style));
    }
}

pub(super) fn push_pipe_line_text(
    spans: &mut Vec<Span<'static>>,
    column: &mut usize,
    text: &str,
    style: Style,
) {
    spans.push(Span::styled(text.to_string(), style));
    *column = column.saturating_add(unicode_width::UnicodeWidthStr::width(text));
}

pub(super) fn alignments_to_pipe_delimiter(alignments: &[Alignment]) -> String {
    let mut output = String::new();
    output.push('|');
    for alignment in alignments {
        let segment = match alignment {
            Alignment::Left => ":---",
            Alignment::Center => ":---:",
            Alignment::Right => "---:",
            Alignment::None => "---",
        };
        output.push_str(segment);
        output.push('|');
    }
    output
}

pub(super) fn prefix_hyperlink_line(
    prefix: &mut Vec<Span<'static>>,
    mut line: HyperlinkLine,
) -> HyperlinkLine {
    let shift = prefix
        .iter()
        .map(|span| unicode_width::UnicodeWidthStr::width(span.content.as_ref()))
        .sum::<usize>();
    prefix.append(&mut line.line.spans);
    HyperlinkLine {
        line: Line::from(std::mem::take(prefix)),
        hyperlinks: line
            .hyperlinks
            .into_iter()
            .map(|mut link| {
                link.columns = link.columns.start + shift..link.columns.end + shift;
                link
            })
            .collect(),
        preformatted: false,
    }
}

#[allow(dead_code)]
pub(super) fn aligned_table_cell_spans(
    cell: &TableCell,
    alignment: Alignment,
    width: usize,
    is_header: bool,
) -> (Vec<Span<'static>>, Vec<TerminalHyperlink>) {
    let content_width = table_cell_width(cell);
    let remaining = width.saturating_sub(content_width);
    let (left_pad, right_pad) = match alignment {
        Alignment::Right => (remaining, 0),
        Alignment::Center => (remaining / 2, remaining - (remaining / 2)),
        Alignment::Left | Alignment::None => (0, remaining),
    };

    let mut spans = Vec::new();
    let mut hyperlinks = Vec::new();
    if left_pad > 0 {
        spans.push(Span::raw(" ".repeat(left_pad)));
    }
    let styles = KCODER_UI_THEME.text_styles();
    let header_style = styles.table_header;
    let body_style = styles.table_body;
    let base_style = if is_header { header_style } else { body_style };
    if cell.spans.is_empty() {
        spans.push(Span::styled("", base_style));
    } else {
        spans.extend(cell.spans.iter().map(|span| {
            let mut span = span.clone();
            span.style = base_style.patch(span.style);
            span
        }));
        hyperlinks.extend(cell.hyperlinks.iter().cloned().map(|mut link| {
            link.columns = link.columns.start + left_pad..link.columns.end + left_pad;
            link
        }));
    }
    if right_pad > 0 {
        spans.push(Span::raw(" ".repeat(right_pad)));
    }
    (spans, hyperlinks)
}

pub(super) fn render_table_separator(
    widths: &[usize],
    separator_char: char,
    style: Style,
) -> HyperlinkLine {
    let segment = separator_char.to_string();
    let gap = " ".repeat(TABLE_COLUMN_GAP);
    let text = widths
        .iter()
        .map(|width| segment.repeat(width + (TABLE_CELL_PADDING * 2)))
        .collect::<Vec<_>>()
        .join(&gap);
    HyperlinkLine::new(Line::from(Span::styled(text, style)))
}

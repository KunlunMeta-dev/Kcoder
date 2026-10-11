use crate::custom_terminal::Frame;
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::Style,
    text::{Line, Text},
    widgets::{Paragraph, Widget, Wrap},
};
use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct TranscriptSelectionPoint {
    pub(super) row: usize,
    pub(super) column: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct TranscriptSelection {
    pub(super) anchor: TranscriptSelectionPoint,
    pub(super) head: TranscriptSelectionPoint,
}

impl TranscriptSelection {
    pub(super) fn new(point: TranscriptSelectionPoint) -> Self {
        Self {
            anchor: point,
            head: point,
        }
    }

    fn is_empty(&self) -> bool {
        self.anchor == self.head
    }

    fn normalized(&self) -> (TranscriptSelectionPoint, TranscriptSelectionPoint) {
        let before = self.anchor.row < self.head.row
            || (self.anchor.row == self.head.row && self.anchor.column <= self.head.column);
        if before {
            (self.anchor, self.head)
        } else {
            (self.head, self.anchor)
        }
    }

    fn columns_for_row(&self, row: usize, line_width: usize) -> Option<(usize, usize)> {
        if self.is_empty() {
            return None;
        }
        let (start, end) = self.normalized();
        if row < start.row || row > end.row {
            return None;
        }

        let start_column = if row == start.row { start.column } else { 0 };
        let end_column = if row == end.row {
            end.column
        } else {
            line_width
        };
        let start_column = start_column.min(line_width);
        let end_column = end_column.min(line_width);
        (start_column < end_column).then_some((start_column, end_column))
    }
}

pub(super) fn transcript_visible_rows_for_selection(
    lines: &[Line<'static>],
    width: u16,
    height: u16,
    scroll_top: usize,
) -> Vec<String> {
    selection_rows_with_layout(lines, width, height, scroll_top, false)
}

pub(super) fn navigation_visible_rows_for_selection(
    lines: &[Line<'static>],
    width: u16,
    height: u16,
    scroll_top: usize,
) -> Vec<String> {
    selection_rows_with_layout(lines, width, height, scroll_top, true)
}

fn selection_rows_with_layout(
    lines: &[Line<'static>],
    width: u16,
    height: u16,
    scroll_top: usize,
    prewrapped: bool,
) -> Vec<String> {
    if height == 0 {
        return Vec::new();
    }
    let width = width.max(1);
    let area = Rect::new(0, 0, width, height);
    let mut buffer = Buffer::empty(area);
    if prewrapped {
        Widget::render(
            crate::navigation_render::NavigationLines {
                lines,
                local_top: scroll_top,
            },
            area,
            &mut buffer,
        );
    } else {
        let paragraph = Paragraph::new(Text::from(lines.to_vec()))
            .wrap(Wrap { trim: false })
            .scroll((scroll_top as u16, 0));
        Widget::render(paragraph, area, &mut buffer);
    }

    (0..height)
        .map(|y| {
            let mut row = String::new();
            for x in 0..width {
                row.push_str(buffer[(x, y)].symbol());
            }
            row.trim_end_matches(' ').to_string()
        })
        .collect()
}

fn text_slice_by_display_columns(text: &str, start_column: usize, end_column: usize) -> String {
    if start_column >= end_column {
        return String::new();
    }

    let mut out = String::new();
    let mut column = 0usize;
    for grapheme in text.graphemes(true) {
        let width = unicode_width::UnicodeWidthStr::width(grapheme);
        let next_column = column.saturating_add(width);
        if next_column > start_column && column < end_column {
            out.push_str(grapheme);
        }
        column = next_column;
        if column >= end_column {
            break;
        }
    }
    out
}

pub(super) fn selected_text_from_visible_rows(
    rows: &[String],
    selection: TranscriptSelection,
) -> Option<String> {
    if rows.is_empty() || selection.is_empty() {
        return None;
    }

    let (start, end) = selection.normalized();
    if start.row >= rows.len() {
        return None;
    }
    let end_row = end.row.min(rows.len().saturating_sub(1));
    if start.row > end_row {
        return None;
    }

    let mut out = Vec::new();
    for row_index in start.row..=end_row {
        let row = rows.get(row_index).map(String::as_str).unwrap_or("");
        let width = crate::render::wrapping::display_width(row);
        let start_column = if row_index == start.row {
            start.column
        } else {
            0
        };
        let end_column = if row_index == end.row {
            end.column
        } else {
            width
        };
        out.push(text_slice_by_display_columns(
            row,
            start_column.min(width),
            end_column.min(width),
        ));
    }

    let text = out.join("\n");
    (!text.is_empty()).then_some(text)
}

pub(super) fn render_transcript_selection_highlight(
    frame: &mut Frame,
    area: Rect,
    visible_rows: &[String],
    selection: Option<TranscriptSelection>,
) {
    let Some(selection) = selection else {
        return;
    };
    let selection_style = Style::default().bg(crate::theme::selection_surface_bg());
    let max_rows = usize::from(area.height).min(visible_rows.len());
    for (row_index, row) in visible_rows.iter().enumerate().take(max_rows) {
        let line_width = crate::render::wrapping::display_width(row);
        let Some((start_column, end_column)) = selection.columns_for_row(row_index, line_width)
        else {
            continue;
        };
        let y = area.y.saturating_add(row_index as u16);
        for column in start_column..end_column {
            if column >= usize::from(area.width) {
                break;
            }
            let x = area.x.saturating_add(column as u16);
            let cell = &mut frame.buffer_mut()[(x, y)];
            cell.set_style(cell.style().patch(selection_style));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_selection_uses_the_painted_visual_rows_without_rewrapping() {
        let lines = vec![
            Line::from("     "),
            Line::from("world"),
            Line::from("tail "),
        ];
        assert_eq!(
            navigation_visible_rows_for_selection(&lines, 5, 2, 0),
            vec!["", "world"]
        );
        assert_eq!(
            navigation_visible_rows_for_selection(&lines, 5, 2, 1),
            vec!["world", "tail"]
        );
    }
}

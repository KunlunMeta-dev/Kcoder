use super::ReplApp;
use unicode_segmentation::UnicodeSegmentation;

/// Minimum visible content rows for the composer. Keep the idle composer
/// compact; it expands as soon as the input wraps or becomes multi-line.
pub(super) const MIN_COMPOSER_ROWS: u16 = 1;

const COMPOSER_WORD_SEPARATORS: &str = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";

/// Convert a grapheme index into the corresponding byte position in the
/// underlying UTF-8 string.
pub(super) fn byte_index_for_grapheme(text: &str, grapheme_index: usize) -> usize {
    text.graphemes(true)
        .take(grapheme_index)
        .map(|g| g.len())
        .sum()
}

pub(super) fn shell_prompt_display_text(text: &str) -> Option<&str> {
    text.strip_prefix('!')
}

pub(super) fn wrap_text_rows(text: &str, width: u16) -> Vec<(usize, usize)> {
    let width = width.max(1) as usize;
    let graphemes: Vec<&str> = text.graphemes(true).collect();
    let mut rows = Vec::new();
    let mut row_start = 0;
    let mut row_width = 0;

    for (i, g) in graphemes.iter().enumerate() {
        if *g == "\n" {
            rows.push((row_start, i));
            row_start = i + 1;
            row_width = 0;
            continue;
        }
        let w = unicode_width::UnicodeWidthStr::width(*g);
        if row_width + w > width && row_start < i {
            rows.push((row_start, i));
            row_start = i;
            row_width = 0;
        }
        row_width += w;
    }

    if row_start <= graphemes.len() {
        rows.push((row_start, graphemes.len()));
    }
    rows
}

pub(super) fn cursor_visual_position_for_text(
    text: &str,
    cursor_grapheme_index: usize,
    width: u16,
) -> (usize, usize) {
    let rows = wrap_text_rows(text, width);
    let row = rows
        .iter()
        .rposition(|(start, _)| cursor_grapheme_index >= *start)
        .unwrap_or(rows.len().saturating_sub(1));
    let (start, _) = rows.get(row).copied().unwrap_or((0, 0));
    let graphemes: Vec<&str> = text.graphemes(true).collect();
    let col = graphemes[start..cursor_grapheme_index.min(graphemes.len())]
        .iter()
        .map(|g| unicode_width::UnicodeWidthStr::width(*g))
        .sum();
    (row, col)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ComposerWordKind {
    Whitespace,
    Separator,
    Word,
}

fn composer_word_kind(grapheme: &str) -> ComposerWordKind {
    if grapheme.chars().all(char::is_whitespace) {
        ComposerWordKind::Whitespace
    } else if grapheme
        .chars()
        .all(|ch| COMPOSER_WORD_SEPARATORS.contains(ch))
    {
        ComposerWordKind::Separator
    } else {
        ComposerWordKind::Word
    }
}

impl ReplApp {
    pub(super) fn input_graphemes(&self) -> Vec<&str> {
        self.input.graphemes(true).collect()
    }

    /// Convert a grapheme index into the corresponding byte position in the
    /// underlying UTF-8 string.
    pub(super) fn byte_index_for_grapheme(&self, grapheme_index: usize) -> usize {
        let graphemes = self.input_graphemes();
        let idx = grapheme_index.min(graphemes.len());
        graphemes[..idx].iter().map(|g| g.len()).sum()
    }

    pub(super) fn wrap_composer_display_rows(&self, width: u16) -> Vec<(usize, usize)> {
        wrap_text_rows(self.composer_display_text(), width)
    }

    pub(super) fn composer_display_text(&self) -> &str {
        shell_prompt_display_text(&self.input).unwrap_or(&self.input)
    }

    fn composer_display_cursor_grapheme_index(&self) -> usize {
        if shell_prompt_display_text(&self.input).is_some() {
            self.cursor_grapheme_index.saturating_sub(1)
        } else {
            self.cursor_grapheme_index
        }
    }

    /// Visual (row, column) position of the cursor for the given width.
    fn cursor_visual_position(&self, width: u16) -> (usize, usize) {
        cursor_visual_position_for_text(&self.input, self.cursor_grapheme_index, width)
    }

    pub(super) fn composer_display_cursor_visual_position(&self, width: u16) -> (usize, usize) {
        cursor_visual_position_for_text(
            self.composer_display_text(),
            self.composer_display_cursor_grapheme_index(),
            width,
        )
    }

    pub(super) fn grapheme_index_for_visual_position(
        &self,
        width: u16,
        visual_row: usize,
        visual_col: usize,
    ) -> usize {
        let display_text = self.composer_display_text();
        let rows = wrap_text_rows(display_text, width);
        let Some((start, end)) = rows
            .get(visual_row.min(rows.len().saturating_sub(1)))
            .copied()
        else {
            return 0;
        };
        let graphemes = display_text.graphemes(true).collect::<Vec<_>>();
        let shell_prefix = usize::from(shell_prompt_display_text(&self.input).is_some());
        let mut col = 0usize;
        for (idx, grapheme) in graphemes.iter().enumerate().take(end).skip(start) {
            let width = unicode_width::UnicodeWidthStr::width(*grapheme).max(1);
            let next = col.saturating_add(width);
            if visual_col < next {
                let halfway = col.saturating_add(width / 2);
                return (if visual_col >= halfway { idx + 1 } else { idx }) + shell_prefix;
            }
            col = next;
        }
        end + shell_prefix
    }

    /// Move the cursor to the visual row above/below the current one,
    /// preserving the target display column when possible.
    pub(super) fn move_cursor_vertical(&mut self, width: u16, direction: isize) {
        let (row, current_col) = self.composer_display_cursor_visual_position(width);
        let col = *self.composer_preferred_col.get_or_insert(current_col);
        let rows = self.wrap_composer_display_rows(width);
        let new_row = if direction < 0 {
            row.saturating_sub(1)
        } else {
            (row + 1).min(rows.len().saturating_sub(1))
        };
        if new_row == row {
            return;
        }
        let (target_start, target_end) = rows[new_row];
        let graphemes = self
            .composer_display_text()
            .graphemes(true)
            .collect::<Vec<_>>();
        let mut used = 0;
        let mut idx = target_start;
        while idx < target_end {
            let w = unicode_width::UnicodeWidthStr::width(graphemes[idx]);
            if used + w > col {
                break;
            }
            used += w;
            idx += 1;
        }
        self.cursor_grapheme_index =
            idx + usize::from(shell_prompt_display_text(&self.input).is_some());
        self.clamp_input_scroll(width);
    }

    pub(super) fn can_move_cursor_vertical(&self, width: u16, direction: isize) -> bool {
        let (row, _) = self.composer_display_cursor_visual_position(width);
        let rows = self.wrap_composer_display_rows(width);
        if direction < 0 {
            row > 0
        } else {
            row + 1 < rows.len()
        }
    }

    pub(super) fn beginning_of_previous_word(&self) -> usize {
        let graphemes = self.input_graphemes();
        let mut idx = self.cursor_grapheme_index.min(graphemes.len());

        while idx > 0 && composer_word_kind(graphemes[idx - 1]) == ComposerWordKind::Whitespace {
            idx -= 1;
        }
        if idx == 0 {
            return 0;
        }

        let kind = composer_word_kind(graphemes[idx - 1]);
        while idx > 0 && composer_word_kind(graphemes[idx - 1]) == kind {
            idx -= 1;
        }
        idx
    }

    pub(super) fn end_of_next_word(&self) -> usize {
        let graphemes = self.input_graphemes();
        let mut idx = self.cursor_grapheme_index.min(graphemes.len());

        while idx < graphemes.len()
            && composer_word_kind(graphemes[idx]) == ComposerWordKind::Whitespace
        {
            idx += 1;
        }
        if idx >= graphemes.len() {
            return graphemes.len();
        }

        let kind = composer_word_kind(graphemes[idx]);
        while idx < graphemes.len() && composer_word_kind(graphemes[idx]) == kind {
            idx += 1;
        }
        idx
    }

    /// Keep the cursor row inside the visible composer window.
    pub(super) fn clamp_input_scroll(&mut self, width: u16) {
        let (row, _) = self.cursor_visual_position(width);
        let visible_rows = self
            .last_composer_content
            .map(|area| usize::from(area.height.max(MIN_COMPOSER_ROWS)))
            .unwrap_or(usize::from(MIN_COMPOSER_ROWS));
        if row < self.input_scroll_row {
            self.input_scroll_row = row;
        } else if row >= self.input_scroll_row + visible_rows {
            self.input_scroll_row = row.saturating_sub(visible_rows - 1);
        }
    }

    /// Grapheme index range of the logical line the cursor is currently on.
    pub(super) fn current_line_range(&self) -> (usize, usize) {
        self.line_range_at(self.cursor_grapheme_index)
    }

    fn line_range_at(&self, cursor_grapheme_index: usize) -> (usize, usize) {
        let graphemes = self.input_graphemes();
        let cursor = cursor_grapheme_index.min(graphemes.len());
        let mut start = 0;
        for (i, g) in graphemes.iter().enumerate() {
            if i >= cursor {
                break;
            }
            if *g == "\n" {
                start = i + 1;
            }
        }
        let mut end = graphemes.len();
        for (i, g) in graphemes.iter().enumerate().skip(start) {
            if *g == "\n" {
                end = i;
                break;
            }
        }
        (start, end)
    }

    pub(super) fn move_cursor_to_beginning_of_current_line(&mut self, move_up_at_bol: bool) {
        let (start, _) = self.current_line_range();
        if move_up_at_bol && self.cursor_grapheme_index == start && start > 0 {
            let (previous_start, _) = self.line_range_at(start.saturating_sub(1));
            self.cursor_grapheme_index = previous_start;
        } else {
            self.cursor_grapheme_index = start;
        }
        self.clamp_input_scroll(self.last_input_width);
    }

    pub(super) fn move_cursor_to_end_of_current_line(&mut self, move_down_at_eol: bool) {
        let (_, end) = self.current_line_range();
        let input_len = self.input.graphemes(true).count();
        if move_down_at_eol && self.cursor_grapheme_index == end && end < input_len {
            let (_, next_end) = self.line_range_at(end.saturating_add(1));
            self.cursor_grapheme_index = next_end;
        } else {
            self.cursor_grapheme_index = end;
        }
        self.clamp_input_scroll(self.last_input_width);
    }
}

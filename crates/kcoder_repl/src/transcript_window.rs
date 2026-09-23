use crate::scrolling::TranscriptScroll;
use kcoder_types::{DisplayMessage, MessageRole};
use unicode_width::UnicodeWidthStr;

/// Maximum messages in the initial live-tail candidate.
///
/// Normal frames render a bounded tail. Fullscreen rendering backfills earlier
/// content when tool collapse leaves less than a viewport, then caches the result.
pub(crate) const TRANSCRIPT_RENDER_MAX_MESSAGES: usize = 120;
const TRANSCRIPT_RENDER_MIN_MESSAGES: usize = 24;
pub(crate) const TRANSCRIPT_RENDER_OVERSCAN_ROWS: usize = 120;
pub(crate) const TRANSCRIPT_RENDER_MAX_ROWS: usize = 800;
/// Larger row budget used only when the user scrolls away from the live tail.
/// Tail-following redraws stay cheap, but explicit review must still be
/// bounded so a 10k+ line session cannot rebuild an entire transcript in one
/// ratatui frame.
pub(crate) const TRANSCRIPT_REVIEW_MAX_ROWS: usize = 4_000;
const TRANSCRIPT_TOOL_RUN_BACKTRACK_LIMIT: usize = 200;
const TRANSCRIPT_TOOL_SUMMARY_MIN_RUN_LEN: usize = 1;
const TRANSCRIPT_TOOL_SUMMARY_ESTIMATED_ROWS: usize = 4;
const THINKING_MESSAGE_PREFIX_FOR_ESTIMATE: &str = "[Thinking] ";
const THINKING_PREVIEW_LINES_FOR_ESTIMATE: usize = 2;
/// Legacy tests still use this constant to build large transcripts. Scrollback
/// insertion catches up to the current stable transcript in one synchronized
/// draw.
#[cfg(test)]
pub(crate) const TRANSCRIPT_SCROLLBACK_FLUSH_MAX_MESSAGES: usize = 48;

/// Estimate how many display rows `text` will occupy when rendered by ratatui's
/// `Paragraph::wrap(Wrap { trim: false })` at the given width.
///
/// This mirrors ratatui's word-aware wrapping: words (whitespace-separated
/// runs) are kept intact when they fit, and a word longer than the width is
/// hard-broken by character. Display width uses `unicode-width` (CJK = 2),
/// matching ratatui's column accounting. The estimate is capped at `max_rows`.
///
/// This must stay close to the real rendered row count so that
/// `transcript_tail_window_start` does not back up too far (which would push
/// the latest turn out of the viewport) when content contains CJK text or
/// long URLs.
pub(crate) fn estimate_wrapped_text_rows_capped(text: &str, width: u16, max_rows: usize) -> usize {
    if max_rows == 0 {
        return 0;
    }
    let width = usize::from(width.max(1));
    let mut rows = 0usize;
    let mut saw_line = false;

    for line in text.lines() {
        saw_line = true;
        rows = rows.saturating_add(word_wrap_line_rows(line, width));
        if rows >= max_rows {
            return max_rows;
        }
    }

    if saw_line {
        rows.max(1).min(max_rows)
    } else {
        1.min(max_rows)
    }
}

/// Count the wrapped display rows for a single logical line (no embedded `\n`)
/// at the given column width, using word-aware wrapping that matches ratatui's
/// `Wrap { trim: false }`.
fn word_wrap_line_rows(line: &str, width: usize) -> usize {
    if line.is_empty() {
        return 1;
    }
    if line.width() <= width {
        return 1;
    }
    // Walk the line splitting on whitespace, accumulating column usage. A word
    // that fits on the current row is appended; one that does not triggers a
    // new row. A word longer than `width` is hard-broken across rows.
    let mut rows = 1usize;
    let mut col = 0usize;
    for word in line.split_whitespace() {
        let word_w = word.width();
        if word_w == 0 {
            continue;
        }
        if word_w <= width {
            // Normal word: needs 1 col for a separating space when col > 0.
            let needed = if col == 0 { word_w } else { word_w + 1 };
            if needed <= width.saturating_sub(col) {
                col += needed;
            } else {
                rows += 1;
                col = word_w;
            }
        } else {
            // Word longer than the whole row: hard-break by char. It occupies
            // `word_w.div_ceil(width)` rows and lands at the column where it
            // ends; if it exactly fills a row, the next word starts fresh.
            if col > 0 {
                rows += 1;
            }
            rows += word_w.div_ceil(width).saturating_sub(1);
            let remainder = word_w % width;
            col = if remainder == 0 { 0 } else { remainder };
        }
    }
    rows.max(1)
}

fn is_turn_divider_message(message: &DisplayMessage, turn_divider_prefix: &str) -> bool {
    message.role == MessageRole::System && message.text.starts_with(turn_divider_prefix)
}

pub(crate) fn estimate_message_display_rows_capped<F>(
    message: &DisplayMessage,
    width: u16,
    max_rows: usize,
    is_collapsible_tool_message: F,
    turn_divider_prefix: &str,
) -> usize
where
    F: Fn(&DisplayMessage) -> bool,
{
    if max_rows == 0 {
        return 0;
    }
    if is_collapsible_tool_message(message) {
        return TRANSCRIPT_TOOL_SUMMARY_ESTIMATED_ROWS.min(max_rows);
    }
    if is_turn_divider_message(message, turn_divider_prefix) {
        return 1.min(max_rows);
    }
    if message.role == MessageRole::System
        && let Some(thinking) = message
            .text
            .strip_prefix(THINKING_MESSAGE_PREFIX_FOR_ESTIMATE)
    {
        return estimate_thinking_preview_rows_capped(thinking, width, max_rows);
    }
    // Header + body + blank separator. This deliberately overestimates a
    // little; the goal is to choose a small live tail before paying the real
    // markdown/rendering cost.
    estimate_wrapped_text_rows_capped(&message.text, width, max_rows.saturating_sub(2))
        .saturating_add(2)
        .min(max_rows)
}

fn estimate_thinking_preview_rows_capped(text: &str, width: u16, max_rows: usize) -> usize {
    if max_rows == 0 {
        return 0;
    }
    let source_lines = if text.is_empty() {
        vec![""]
    } else {
        text.lines().collect::<Vec<_>>()
    };
    let visible = source_lines.len().min(THINKING_PREVIEW_LINES_FOR_ESTIMATE);
    let content_width = usize::from(width.saturating_sub(2).max(1));
    let hidden_line = usize::from(
        source_lines.len() > visible
            || source_lines
                .iter()
                .take(visible)
                .any(|line| line.width() > content_width),
    );
    visible.saturating_add(hidden_line).min(max_rows).max(1)
}

fn estimated_transcript_prefix_rows<F, G>(
    messages: &[DisplayMessage],
    width: u16,
    is_tool_run_message: F,
    is_collapsible_tool_message: G,
    turn_divider_prefix: &str,
) -> Vec<usize>
where
    F: Fn(&DisplayMessage) -> bool + Copy,
    G: Fn(&DisplayMessage) -> bool + Copy,
{
    let mut prefix_rows = Vec::with_capacity(messages.len().saturating_add(1));
    prefix_rows.push(0);
    let mut rows = 0usize;
    let mut idx = 0usize;
    while idx < messages.len() {
        if is_tool_run_message(&messages[idx]) {
            let run_start = idx;
            while idx < messages.len() && is_tool_run_message(&messages[idx]) {
                idx += 1;
            }
            let collapsible_count = messages[run_start..idx]
                .iter()
                .filter(|message| is_collapsible_tool_message(message))
                .count();
            let mut summary_counted = false;
            for message in &messages[run_start..idx] {
                if is_collapsible_tool_message(message)
                    && collapsible_count >= TRANSCRIPT_TOOL_SUMMARY_MIN_RUN_LEN
                {
                    if !summary_counted {
                        rows = rows.saturating_add(TRANSCRIPT_TOOL_SUMMARY_ESTIMATED_ROWS);
                        summary_counted = true;
                    }
                } else {
                    rows = rows.saturating_add(estimate_message_display_rows_capped(
                        message,
                        width,
                        usize::MAX,
                        is_collapsible_tool_message,
                        turn_divider_prefix,
                    ));
                }
                prefix_rows.push(rows);
            }
            continue;
        }

        rows = rows.saturating_add(estimate_message_display_rows_capped(
            &messages[idx],
            width,
            usize::MAX,
            is_collapsible_tool_message,
            turn_divider_prefix,
        ));
        prefix_rows.push(rows);
        idx += 1;
    }
    prefix_rows
}

fn extend_estimated_transcript_prefix_rows<F, G>(
    prefix_rows: &mut Vec<usize>,
    messages: &[DisplayMessage],
    previously_indexed_messages: usize,
    width: u16,
    is_tool_run_message: F,
    is_collapsible_tool_message: G,
    turn_divider_prefix: &str,
) where
    F: Fn(&DisplayMessage) -> bool + Copy,
    G: Fn(&DisplayMessage) -> bool + Copy,
{
    debug_assert_eq!(prefix_rows.len(), previously_indexed_messages + 1);
    debug_assert!(previously_indexed_messages < messages.len());

    let mut rebuild_start = previously_indexed_messages;
    if rebuild_start > 0
        && is_tool_run_message(&messages[rebuild_start])
        && is_tool_run_message(&messages[rebuild_start - 1])
    {
        while rebuild_start > 0 && is_tool_run_message(&messages[rebuild_start - 1]) {
            rebuild_start -= 1;
        }
    }

    let base_rows = prefix_rows[rebuild_start];
    prefix_rows.truncate(rebuild_start + 1);
    let appended_rows = estimated_transcript_prefix_rows(
        &messages[rebuild_start..],
        width,
        is_tool_run_message,
        is_collapsible_tool_message,
        turn_divider_prefix,
    );
    prefix_rows.reserve(appended_rows.len().saturating_sub(1));
    prefix_rows.extend(
        appended_rows
            .into_iter()
            .skip(1)
            .map(|rows| base_rows.saturating_add(rows)),
    );
}

fn transcript_distance_from_tail(
    scroll: TranscriptScroll,
    total_lines: usize,
    visible_lines: usize,
) -> usize {
    if scroll.is_at_tail() || total_lines <= visible_lines {
        return 0;
    }
    let (_, top) = scroll.resolve_top(total_lines, visible_lines);
    total_lines
        .saturating_sub(visible_lines)
        .saturating_sub(top)
}

pub(crate) fn transcript_render_row_budget(
    scroll: TranscriptScroll,
    previous_total_lines: usize,
    previous_visible_lines: usize,
    current_visible_lines: usize,
) -> usize {
    let distance_from_tail =
        transcript_distance_from_tail(scroll, previous_total_lines, previous_visible_lines);
    let max_rows = if scroll.is_at_tail() {
        TRANSCRIPT_RENDER_MAX_ROWS
    } else {
        TRANSCRIPT_REVIEW_MAX_ROWS
    };
    current_visible_lines
        .saturating_add(TRANSCRIPT_RENDER_OVERSCAN_ROWS)
        .saturating_add(distance_from_tail)
        .clamp(current_visible_lines.max(1), max_rows)
}

pub(crate) fn transcript_tail_window_start<F, G>(
    messages: &[DisplayMessage],
    width: u16,
    row_budget: usize,
    max_messages: usize,
    is_tool_run_message: F,
    is_collapsible_tool_message: G,
    turn_divider_prefix: &str,
) -> usize
where
    F: Fn(&DisplayMessage) -> bool + Copy,
    G: Fn(&DisplayMessage) -> bool + Copy,
{
    if messages.len() <= TRANSCRIPT_RENDER_MIN_MESSAGES {
        return 0;
    }

    let max_start = messages.len().saturating_sub(max_messages.max(1));
    let min_start = messages
        .len()
        .saturating_sub(TRANSCRIPT_RENDER_MIN_MESSAGES);
    let mut rows = 0usize;
    let mut start = messages.len();

    while start > max_start && (start > min_start || rows < row_budget) {
        start -= 1;
        let remaining_rows = row_budget.saturating_sub(rows).max(1);
        rows = rows.saturating_add(estimate_message_display_rows_capped(
            &messages[start],
            width,
            remaining_rows,
            is_collapsible_tool_message,
            turn_divider_prefix,
        ));
    }

    // If the window starts in the middle of a collapsed tool run, back up a
    // bounded amount so the summary count remains coherent without allowing a
    // pathological tool storm to re-enter the hot render path.
    let mut backtracked = 0usize;
    while start > 0
        && backtracked < TRANSCRIPT_TOOL_RUN_BACKTRACK_LIMIT
        && is_tool_run_message(&messages[start])
        && is_tool_run_message(&messages[start - 1])
    {
        start -= 1;
        backtracked += 1;
    }

    start
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TranscriptScrollWindow {
    pub start_idx: usize,
    pub end_idx: usize,
    pub start_row: usize,
    pub estimated_total_rows: usize,
}

#[derive(Debug, Default)]
pub(crate) struct TranscriptRowIndex {
    width: u16,
    transcript_epoch: u64,
    prefix_rows: Vec<usize>,
    #[cfg(test)]
    full_rebuild_count: usize,
    #[cfg(test)]
    incremental_extend_count: usize,
}

impl TranscriptRowIndex {
    pub(crate) fn rebuild_if_stale<F, G>(
        &mut self,
        messages: &[DisplayMessage],
        width: u16,
        transcript_epoch: u64,
        is_tool_run_message: F,
        is_collapsible_tool_message: G,
        turn_divider_prefix: &str,
    ) where
        F: Fn(&DisplayMessage) -> bool + Copy,
        G: Fn(&DisplayMessage) -> bool + Copy,
    {
        let width = width.max(1);
        if self.width == width && self.transcript_epoch == transcript_epoch {
            let expected_prefix_len = messages.len().saturating_add(1);
            if self.prefix_rows.len() == expected_prefix_len {
                return;
            }
            if !self.prefix_rows.is_empty() && self.prefix_rows.len() < expected_prefix_len {
                let previously_indexed_messages = self.prefix_rows.len() - 1;
                extend_estimated_transcript_prefix_rows(
                    &mut self.prefix_rows,
                    messages,
                    previously_indexed_messages,
                    width,
                    is_tool_run_message,
                    is_collapsible_tool_message,
                    turn_divider_prefix,
                );
                #[cfg(test)]
                {
                    self.incremental_extend_count = self.incremental_extend_count.saturating_add(1);
                }
                return;
            }
        }

        self.width = width;
        self.transcript_epoch = transcript_epoch;
        #[cfg(test)]
        {
            self.full_rebuild_count = self.full_rebuild_count.saturating_add(1);
        }
        self.prefix_rows = estimated_transcript_prefix_rows(
            messages,
            width,
            is_tool_run_message,
            is_collapsible_tool_message,
            turn_divider_prefix,
        );
    }

    pub(crate) fn total_rows(&self) -> usize {
        self.prefix_rows.last().copied().unwrap_or(0)
    }

    pub(crate) fn prefix_rows_at(&self, index: usize) -> usize {
        self.prefix_rows
            .get(index)
            .copied()
            .unwrap_or_else(|| self.total_rows())
    }

    /// Calibrate only messages actually laid out; retain bounded estimates for the rest of history.
    pub(crate) fn correct_message_rows(&mut self, index: usize, rows: usize) {
        let Some(&end) = self.prefix_rows.get(index + 1) else {
            return;
        };
        let old = end.saturating_sub(self.prefix_rows[index]);
        if old == rows {
            return;
        }
        for prefix in &mut self.prefix_rows[index + 1..] {
            *prefix = prefix.saturating_sub(old).saturating_add(rows);
        }
    }

    pub(crate) fn message_at_row(&self, row: usize) -> usize {
        self.prefix_rows
            .partition_point(|prefix| *prefix <= row)
            .saturating_sub(1)
            .min(self.prefix_rows.len().saturating_sub(2))
    }

    pub(crate) fn window_for_top<F>(
        &self,
        messages: &[DisplayMessage],
        top: usize,
        viewport_rows: usize,
        render_rows: usize,
        is_tool_run_message: F,
    ) -> TranscriptScrollWindow
    where
        F: Fn(&DisplayMessage) -> bool + Copy,
    {
        if messages.is_empty() || self.prefix_rows.len() != messages.len().saturating_add(1) {
            return TranscriptScrollWindow {
                start_idx: 0,
                end_idx: 0,
                start_row: 0,
                estimated_total_rows: self.total_rows(),
            };
        }

        let viewport_rows = viewport_rows.max(1);
        let render_rows = render_rows.max(viewport_rows);
        let target_row = top.saturating_sub(viewport_rows);
        let target_end_row = top.saturating_add(render_rows);
        let mut start_idx = self
            .prefix_rows
            .partition_point(|row| *row <= target_row)
            .saturating_sub(1)
            .min(messages.len().saturating_sub(1));
        let mut start_row = self.prefix_rows[start_idx];

        let mut backtracked = 0usize;
        while start_idx > 0
            && backtracked < TRANSCRIPT_TOOL_RUN_BACKTRACK_LIMIT
            && is_tool_run_message(&messages[start_idx])
            && is_tool_run_message(&messages[start_idx - 1])
        {
            start_idx -= 1;
            start_row = self.prefix_rows[start_idx];
            backtracked += 1;
        }

        let mut end_idx = self
            .prefix_rows
            .partition_point(|row| *row < target_end_row)
            .min(messages.len())
            .max(start_idx.saturating_add(1));
        let mut extended = 0usize;
        while end_idx < messages.len()
            && extended < TRANSCRIPT_TOOL_RUN_BACKTRACK_LIMIT
            && end_idx > 0
            && is_tool_run_message(&messages[end_idx - 1])
            && is_tool_run_message(&messages[end_idx])
        {
            end_idx += 1;
            extended += 1;
        }

        TranscriptScrollWindow {
            start_idx,
            end_idx,
            start_row,
            estimated_total_rows: self.total_rows(),
        }
    }
}

/// Pick a message window for an absolute display-row scroll position.
///
/// The fullscreen transcript uses a virtual row offset over the whole session,
/// but rendering every historical message on every wheel/drag frame is too
/// expensive. This helper estimates rows from the source transcript, finds the
/// first message needed for the requested viewport plus overscan, and reports
/// both the start index and the estimated absolute row where that message
/// begins.
#[cfg(test)]
pub(crate) struct TranscriptWindowRequest<'a> {
    pub(crate) width: u16,
    pub(crate) top: usize,
    pub(crate) viewport_rows: usize,
    pub(crate) render_rows: usize,
    pub(crate) turn_divider_prefix: &'a str,
}

#[cfg(test)]
pub(crate) fn transcript_scroll_window_for_top<F, G>(
    messages: &[DisplayMessage],
    request: TranscriptWindowRequest<'_>,
    is_tool_run_message: F,
    is_collapsible_tool_message: G,
) -> TranscriptScrollWindow
where
    F: Fn(&DisplayMessage) -> bool + Copy,
    G: Fn(&DisplayMessage) -> bool + Copy,
{
    let TranscriptWindowRequest {
        width,
        top,
        viewport_rows,
        render_rows,
        turn_divider_prefix,
    } = request;
    if messages.is_empty() {
        return TranscriptScrollWindow {
            start_idx: 0,
            end_idx: 0,
            start_row: 0,
            estimated_total_rows: 0,
        };
    }

    let viewport_rows = viewport_rows.max(1);
    let render_rows = render_rows.max(viewport_rows);
    let target_row = top.saturating_sub(viewport_rows);
    let target_end_row = top.saturating_add(render_rows);
    let prefix_rows = estimated_transcript_prefix_rows(
        messages,
        width.max(1),
        is_tool_run_message,
        is_collapsible_tool_message,
        turn_divider_prefix,
    );
    let total_rows = prefix_rows.last().copied().unwrap_or(0);
    let mut start_idx = prefix_rows
        .partition_point(|row| *row <= target_row)
        .saturating_sub(1)
        .min(messages.len().saturating_sub(1));
    let mut start_row = prefix_rows[start_idx];

    let mut backtracked = 0usize;
    while start_idx > 0
        && backtracked < TRANSCRIPT_TOOL_RUN_BACKTRACK_LIMIT
        && is_tool_run_message(&messages[start_idx])
        && is_tool_run_message(&messages[start_idx - 1])
    {
        start_idx -= 1;
        start_row = prefix_rows[start_idx];
        backtracked += 1;
    }

    let mut end_idx = prefix_rows
        .partition_point(|row| *row < target_end_row)
        .min(messages.len())
        .max(start_idx.saturating_add(1));
    let mut extended = 0usize;
    while end_idx < messages.len()
        && extended < TRANSCRIPT_TOOL_RUN_BACKTRACK_LIMIT
        && end_idx > 0
        && is_tool_run_message(&messages[end_idx - 1])
        && is_tool_run_message(&messages[end_idx])
    {
        end_idx += 1;
        extended += 1;
    }

    TranscriptScrollWindow {
        start_idx,
        end_idx,
        start_row,
        estimated_total_rows: total_rows,
    }
}

pub(crate) fn transcript_scrollback_commit_target(
    total_messages: usize,
    _committed_until: usize,
) -> usize {
    total_messages
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_wrap_estimate_never_underestimates_cjk_and_urls() {
        // A representative mix: CJK (width-2 chars), a long URL, and ASCII
        // prose. The estimator must not return fewer rows than ratatui
        // actually renders, otherwise transcript_tail_window_start backs up
        // too far and pushes the latest turn out of the viewport.
        let cases = [
            "这是一个比较长的中文句子用于测试换行行为是否与ratatui一致",
            "https://example.com/a/very/long/url/that/should/hard/break/by/char",
            "The quick brown fox jumps over the lazy dog and keeps running on",
            "短句",
            "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10",
        ];
        for (i, text) in cases.iter().enumerate() {
            for &width in &[8u16, 16, 20, 40, 60] {
                let estimated = estimate_wrapped_text_rows_capped(text, width, 10_000);
                let rendered = count_ratatui_rendered_rows(text, width);
                assert!(
                    estimated >= rendered,
                    "case {i} ({text:?}) width {width}: estimate {estimated} < rendered {rendered} (must not underestimate)"
                );
            }
        }
    }

    #[test]
    fn word_wrap_estimate_caps_at_max_rows() {
        let text = "a".repeat(10_000);
        assert_eq!(estimate_wrapped_text_rows_capped(&text, 1, 7), 7);
        // A single unbreakable long word at width 1 -> one row per char.
        assert_eq!(estimate_wrapped_text_rows_capped(&text, 8, 3), 3);
    }

    #[test]
    fn row_index_matches_linear_scroll_window() {
        let messages = (0..500)
            .map(|idx| DisplayMessage {
                role: if idx % 7 == 0 {
                    MessageRole::System
                } else {
                    MessageRole::Assistant
                },
                text: if idx % 7 == 0 {
                    format!("[Tool use: read] line {idx}")
                } else {
                    format!("message {idx} {}", "x ".repeat(idx % 11 + 1))
                },
            })
            .collect::<Vec<_>>();
        let collapsible = |message: &DisplayMessage| message.text.starts_with("[Tool use:");
        let mut index = TranscriptRowIndex::default();
        index.rebuild_if_stale(&messages, 37, 1, collapsible, collapsible, "---");

        for top in [0usize, 1, 9, 40, 177, 599, 2_000, 10_000] {
            let indexed = index.window_for_top(&messages, top, 12, 48, collapsible);
            let linear = transcript_scroll_window_for_top(
                &messages,
                TranscriptWindowRequest {
                    width: 37,
                    top,
                    viewport_rows: 12,
                    render_rows: 48,
                    turn_divider_prefix: "---",
                },
                collapsible,
                collapsible,
            );
            assert_eq!(indexed.start_idx, linear.start_idx, "top={top}");
            assert_eq!(indexed.end_idx, linear.end_idx, "top={top}");
            assert_eq!(indexed.start_row, linear.start_row, "top={top}");
            assert_eq!(indexed.estimated_total_rows, linear.estimated_total_rows);
        }
    }

    #[test]
    fn row_index_rebuilds_only_when_epoch_or_width_changes() {
        let messages = vec![DisplayMessage {
            role: MessageRole::Assistant,
            text: "hello world".to_string(),
        }];
        let collapsible = |_message: &DisplayMessage| false;
        let mut index = TranscriptRowIndex::default();

        index.rebuild_if_stale(&messages, 80, 1, collapsible, collapsible, "---");
        let first_rows = index.prefix_rows.clone();
        assert_eq!(index.full_rebuild_count, 1);
        index.rebuild_if_stale(&messages, 80, 1, collapsible, collapsible, "---");
        assert_eq!(index.prefix_rows, first_rows);
        assert_eq!(index.full_rebuild_count, 1);

        index.rebuild_if_stale(&messages, 40, 1, collapsible, collapsible, "---");
        assert_eq!(index.width, 40);
        assert_eq!(index.full_rebuild_count, 2);

        let mut changed = messages.clone();
        changed.push(DisplayMessage {
            role: MessageRole::User,
            text: "new".to_string(),
        });
        index.rebuild_if_stale(&changed, 40, 1, collapsible, collapsible, "---");
        assert_eq!(index.prefix_rows.len(), changed.len() + 1);
        assert_eq!(index.full_rebuild_count, 2);
        assert_eq!(index.incremental_extend_count, 1);

        changed[0].text.push_str(" changed");
        index.rebuild_if_stale(&changed, 40, 2, collapsible, collapsible, "---");
        assert_eq!(index.full_rebuild_count, 3);
    }

    #[test]
    fn row_index_counts_collapsed_thinking_and_tool_runs_as_visible_rows() {
        let messages = vec![
            DisplayMessage {
                role: MessageRole::System,
                text: format!(
                    "{THINKING_MESSAGE_PREFIX_FOR_ESTIMATE}{}",
                    "long hidden thinking ".repeat(80)
                ),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool use: read] a".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool result: read]\nlarge output".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool use: bash] b".to_string(),
            },
            DisplayMessage {
                role: MessageRole::Assistant,
                text: "done".to_string(),
            },
        ];
        let collapsible = |message: &DisplayMessage| {
            message.text.starts_with("[Tool use:") || message.text.starts_with("[Tool result:")
        };
        let mut index = TranscriptRowIndex::default();
        index.rebuild_if_stale(&messages, 80, 1, collapsible, collapsible, "---");

        let tool_summary_rows = TRANSCRIPT_TOOL_SUMMARY_ESTIMATED_ROWS;
        assert_eq!(
            index.prefix_rows,
            vec![
                0,
                2,
                2 + tool_summary_rows,
                2 + tool_summary_rows,
                2 + tool_summary_rows,
                5 + tool_summary_rows,
            ],
            "long hidden thinking should count as its preview, and a tool run as one summary estimate"
        );
        assert_eq!(index.total_rows(), 5 + tool_summary_rows);
    }

    #[test]
    fn row_index_incremental_append_matches_full_rebuild_for_continued_tool_run() {
        let mut messages = vec![
            DisplayMessage {
                role: MessageRole::Assistant,
                text: "before".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool use: read] a".to_string(),
            },
        ];
        let is_tool = |message: &DisplayMessage| message.text.starts_with("[Tool ");
        let collapsible = |message: &DisplayMessage| {
            message.text.starts_with("[Tool ") && !message.text.contains(": edit]")
        };
        let mut incremental = TranscriptRowIndex::default();
        incremental.rebuild_if_stale(&messages, 80, 1, is_tool, collapsible, "---");

        messages.extend([
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool result: read] content".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool use: edit] file.py".to_string(),
            },
            DisplayMessage {
                role: MessageRole::Assistant,
                text: "after".to_string(),
            },
        ]);
        incremental.rebuild_if_stale(&messages, 80, 1, is_tool, collapsible, "---");

        let mut rebuilt = TranscriptRowIndex::default();
        rebuilt.rebuild_if_stale(&messages, 80, 1, is_tool, collapsible, "---");
        assert_eq!(incremental.prefix_rows, rebuilt.prefix_rows);
        assert_eq!(incremental.full_rebuild_count, 1);
        assert_eq!(incremental.incremental_extend_count, 1);
    }

    #[test]
    fn row_index_incremental_append_matches_full_rebuild_at_every_boundary() {
        let messages = vec![
            DisplayMessage {
                role: MessageRole::Assistant,
                text: "before".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool use: read] a".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool result: read] content".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool use: edit] file.py".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool diff: edit] -old +new".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: format!("{THINKING_MESSAGE_PREFIX_FOR_ESTIMATE}hidden"),
            },
            DisplayMessage {
                role: MessageRole::Assistant,
                text: "after".to_string(),
            },
        ];
        let is_tool = |message: &DisplayMessage| message.text.starts_with("[Tool ");
        let collapsible = |message: &DisplayMessage| {
            message.text.starts_with("[Tool ")
                && !message.text.contains(": edit]")
                && !message.text.starts_with("[Tool diff:")
        };

        let mut rebuilt = TranscriptRowIndex::default();
        rebuilt.rebuild_if_stale(&messages, 37, 1, is_tool, collapsible, "---");
        for split in 0..messages.len() {
            let mut incremental = TranscriptRowIndex::default();
            incremental.rebuild_if_stale(&messages[..split], 37, 1, is_tool, collapsible, "---");
            incremental.rebuild_if_stale(&messages, 37, 1, is_tool, collapsible, "---");
            assert_eq!(
                incremental.prefix_rows, rebuilt.prefix_rows,
                "split={split}"
            );
        }
    }

    #[test]
    fn row_index_keeps_standalone_edit_inside_one_surrounding_tool_run() {
        let messages = vec![
            DisplayMessage {
                role: MessageRole::Assistant,
                text: "before".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool use: read] a".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool result: read]\ncontent".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool use: edit] file.py".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool result: edit]\nDone".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool diff: edit]\n-old\n+new".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool use: grep] needle".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Tool result: grep]\nmatch".to_string(),
            },
            DisplayMessage {
                role: MessageRole::Assistant,
                text: "after".to_string(),
            },
        ];
        let is_tool = |message: &DisplayMessage| message.text.starts_with("[Tool ");
        let collapsible = |message: &DisplayMessage| {
            message.text.starts_with("[Tool ")
                && !message.text.contains(": edit]")
                && !message.text.starts_with("[Tool diff:")
        };
        let mut index = TranscriptRowIndex::default();
        index.rebuild_if_stale(&messages, 80, 1, is_tool, collapsible, "---");

        assert_eq!(
            index.prefix_rows[2],
            index.prefix_rows[1] + TRANSCRIPT_TOOL_SUMMARY_ESTIMATED_ROWS
        );
        assert_eq!(
            index.prefix_rows[7], index.prefix_rows[6],
            "grep must reuse the summary counted before the standalone edit"
        );
        let window = index.window_for_top(&messages, index.prefix_rows[4], 1, 1, is_tool);
        assert_eq!(window.start_idx, 1);
        assert_eq!(window.end_idx, 8);
    }

    /// Render `text` via ratatui `Paragraph::wrap(Wrap{trim:false})` on a
    /// `TestBackend` and count the non-empty display rows. Used to validate
    /// the estimator against the real renderer.
    fn count_ratatui_rendered_rows(text: &str, width: u16) -> usize {
        use ratatui::Terminal as RatatuiTerminal;
        use ratatui::backend::TestBackend;
        use ratatui::text::Text;
        use ratatui::widgets::{Paragraph, Wrap};

        // Build a tall enough buffer; height = text length is a safe upper bound.
        let height = (text.len() + 1).min(u16::MAX as usize - 1) as u16;
        let backend = TestBackend::new(width.max(1), height);
        let mut terminal = RatatuiTerminal::new(backend).unwrap();
        terminal
            .draw(|f| {
                let area = f.area();
                let paragraph = Paragraph::new(Text::from(text)).wrap(Wrap { trim: false });
                f.render_widget(paragraph, area);
            })
            .unwrap();
        let buffer = terminal.backend().buffer().clone();
        let mut rows = 0usize;
        for y in 0..buffer.area.height {
            let row_nonempty = (0..buffer.area.width).any(|x| buffer[(x, y)].symbol() != " ");
            if row_nonempty {
                rows += 1;
            }
        }
        rows
    }
}

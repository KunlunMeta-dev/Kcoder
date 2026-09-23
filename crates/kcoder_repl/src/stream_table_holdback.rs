//! Table holdback boundary detection for lightweight active text streaming.

use crate::table_detect::{
    FenceKind, FenceTracker, is_table_delimiter_line, is_table_header_line, parse_table_segments,
    strip_blockquote_prefix,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TableHoldbackState {
    None,
    PendingHeader { header_start: usize },
    Confirmed { table_start: usize },
}

#[derive(Clone, Copy)]
struct PreviousLineState {
    source_start: usize,
    fence_kind: FenceKind,
    is_header: bool,
}

pub(crate) fn markdown_table_holdback_start(source: &str) -> Option<usize> {
    match table_holdback_state(source) {
        TableHoldbackState::PendingHeader { header_start } => Some(header_start),
        TableHoldbackState::Confirmed { table_start } => Some(table_start),
        TableHoldbackState::None => None,
    }
}

fn table_holdback_state(source: &str) -> TableHoldbackState {
    let mut tracker = FenceTracker::new();
    let mut previous_line: Option<PreviousLineState> = None;
    let mut pending_header_start: Option<usize> = None;
    let mut confirmed_table_start: Option<usize> = None;
    let mut source_offset = 0usize;

    for source_line in source.split_inclusive('\n') {
        let line = source_line.strip_suffix('\n').unwrap_or(source_line);
        let source_start = source_offset;
        let fence_kind = tracker.kind();

        let candidate_text = if fence_kind == FenceKind::Other {
            None
        } else {
            table_candidate_text(line)
        };
        let is_header = candidate_text.is_some_and(is_table_header_line);
        let is_delimiter = candidate_text.is_some_and(is_table_delimiter_line);

        if confirmed_table_start.is_none()
            && let Some(previous_line) = previous_line
            && previous_line.fence_kind != FenceKind::Other
            && fence_kind != FenceKind::Other
            && previous_line.is_header
            && is_delimiter
        {
            confirmed_table_start = Some(previous_line.source_start);
            pending_header_start = None;
        }

        if confirmed_table_start.is_none() && !line.trim().is_empty() {
            if fence_kind != FenceKind::Other && is_header {
                pending_header_start = Some(source_start);
            } else {
                pending_header_start = None;
            }
        }

        previous_line = Some(PreviousLineState {
            source_start,
            fence_kind,
            is_header,
        });

        tracker.advance(line);
        source_offset = source_offset.saturating_add(source_line.len());
    }

    if let Some(table_start) = confirmed_table_start {
        TableHoldbackState::Confirmed { table_start }
    } else if let Some(header_start) = pending_header_start {
        TableHoldbackState::PendingHeader { header_start }
    } else {
        TableHoldbackState::None
    }
}

fn table_candidate_text(line: &str) -> Option<&str> {
    let stripped = strip_blockquote_prefix(line).trim();
    parse_table_segments(stripped).map(|_| stripped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_header_plus_delimiter() {
        assert_eq!(
            markdown_table_holdback_start("intro\n| A | B |\n| --- | --- |\n| 1 | 2 |\n"),
            Some("intro\n".len())
        );
    }

    #[test]
    fn detects_single_column_header_plus_delimiter() {
        assert_eq!(
            markdown_table_holdback_start("intro\n| Only |\n| --- |\n"),
            Some("intro\n".len())
        );
    }

    #[test]
    fn detects_blockquoted_header_plus_delimiter() {
        assert_eq!(
            markdown_table_holdback_start("intro\n> | A | B |\n> | --- | --- |\n> | 1 | 2 |\n"),
            Some("intro\n".len())
        );
    }

    #[test]
    fn detects_pending_header() {
        assert_eq!(
            markdown_table_holdback_start("intro\nA | B\n"),
            Some("intro\n".len())
        );
    }

    #[test]
    fn ignores_table_like_lines_inside_other_fence() {
        assert_eq!(
            markdown_table_holdback_start("```rust\n| A | B |\n| --- | --- |\n```\n"),
            None
        );
    }

    #[test]
    fn ignores_table_like_lines_inside_unclosed_long_fence() {
        assert_eq!(
            markdown_table_holdback_start("````sh\n```cmd\n| A | B |\n| --- | --- |\n````\n"),
            None
        );
    }

    #[test]
    fn treats_indented_fence_text_as_plain_content() {
        assert_eq!(
            markdown_table_holdback_start("    ```sh\n| A | B |\n| --- | --- |\n"),
            Some("    ```sh\n".len())
        );
    }

    #[test]
    fn ignores_table_like_lines_inside_blockquoted_other_fence() {
        assert_eq!(
            markdown_table_holdback_start("> ```sh\n> | A | B |\n> | --- | --- |\n> ```\n"),
            None
        );
    }

    #[test]
    fn scans_markdown_fences_for_tables() {
        assert_eq!(
            markdown_table_holdback_start("```markdown\n| A | B |\n| --- | --- |\n```\n"),
            Some("```markdown\n".len())
        );
    }
}

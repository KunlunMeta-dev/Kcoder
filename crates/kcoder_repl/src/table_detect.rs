//! Pipe-table structure detection and fenced-code tracking for raw markdown.

pub(crate) fn parse_table_segments(line: &str) -> Option<Vec<&str>> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let has_outer_pipe = trimmed.starts_with('|') || trimmed.ends_with('|');
    let content = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let content = content.strip_suffix('|').unwrap_or(content);
    let raw_segments = split_unescaped_pipe(content);
    if !has_outer_pipe && raw_segments.len() <= 1 {
        return None;
    }

    let segments: Vec<&str> = raw_segments.into_iter().map(str::trim).collect();
    (!segments.is_empty()).then_some(segments)
}

fn split_unescaped_pipe(content: &str) -> Vec<&str> {
    let mut segments = Vec::with_capacity(8);
    let mut start = 0usize;
    let bytes = content.as_bytes();
    let mut idx = 0usize;
    while idx < bytes.len() {
        if bytes[idx] == b'\\' {
            idx += 2;
        } else if bytes[idx] == b'|' {
            segments.push(&content[start..idx]);
            start = idx + 1;
            idx += 1;
        } else {
            idx += 1;
        }
    }
    segments.push(&content[start..]);
    segments
}

pub(crate) fn is_table_header_line(line: &str) -> bool {
    parse_table_segments(line).is_some_and(|segments| segments.iter().any(|s| !s.is_empty()))
}

fn is_table_delimiter_segment(segment: &str) -> bool {
    let trimmed = segment.trim();
    if trimmed.is_empty() {
        return false;
    }
    let without_leading = trimmed.strip_prefix(':').unwrap_or(trimmed);
    let without_ends = without_leading.strip_suffix(':').unwrap_or(without_leading);
    without_ends.len() >= 3 && without_ends.chars().all(|ch| ch == '-')
}

pub(crate) fn is_table_delimiter_line(line: &str) -> bool {
    parse_table_segments(line)
        .is_some_and(|segments| segments.into_iter().all(is_table_delimiter_segment))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FenceKind {
    Outside,
    Markdown,
    Other,
}

pub(crate) struct FenceTracker {
    state: Option<(char, usize, FenceKind)>,
}

impl FenceTracker {
    pub(crate) fn new() -> Self {
        Self { state: None }
    }

    pub(crate) fn advance(&mut self, raw_line: &str) {
        let leading_spaces = raw_line
            .as_bytes()
            .iter()
            .take_while(|byte| **byte == b' ')
            .count();
        if leading_spaces > 3 {
            return;
        }

        let trimmed = &raw_line[leading_spaces..];
        let fence_scan_text = strip_blockquote_prefix(trimmed);
        if let Some((marker, len)) = parse_fence_marker(fence_scan_text) {
            if let Some((open_char, open_len, _)) = self.state {
                if marker == open_char
                    && len >= open_len
                    && fence_scan_text[len..].trim().is_empty()
                {
                    self.state = None;
                }
            } else {
                let kind = if is_markdown_fence_info(fence_scan_text, len) {
                    FenceKind::Markdown
                } else {
                    FenceKind::Other
                };
                self.state = Some((marker, len, kind));
            }
        }
    }

    pub(crate) fn kind(&self) -> FenceKind {
        self.state.map_or(FenceKind::Outside, |(_, _, kind)| kind)
    }
}

pub(crate) fn parse_fence_marker(line: &str) -> Option<(char, usize)> {
    let first = line.as_bytes().first().copied()?;
    if first != b'`' && first != b'~' {
        return None;
    }
    let len = line.bytes().take_while(|byte| *byte == first).count();
    if len < 3 {
        return None;
    }
    Some((first as char, len))
}

pub(crate) fn is_markdown_fence_info(trimmed_line: &str, marker_len: usize) -> bool {
    let info = trimmed_line[marker_len..]
        .split_whitespace()
        .next()
        .unwrap_or_default();
    info.eq_ignore_ascii_case("md") || info.eq_ignore_ascii_case("markdown")
}

pub(crate) fn strip_blockquote_prefix(line: &str) -> &str {
    let mut rest = line.trim_start();
    loop {
        let Some(stripped) = rest.strip_prefix('>') else {
            return rest;
        };
        rest = stripped.strip_prefix(' ').unwrap_or(stripped).trim_start();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_table_segments_accepts_inner_pipes() {
        assert_eq!(parse_table_segments("A | B | C"), Some(vec!["A", "B", "C"]));
        assert_eq!(
            parse_table_segments("| A | B \\| literal |"),
            Some(vec!["A", "B \\| literal"])
        );
    }

    #[test]
    fn delimiter_requires_three_dashes_per_column() {
        assert!(is_table_delimiter_line("| --- | :---: | ---: |"));
        assert!(!is_table_delimiter_line("| -- | --- |"));
    }

    #[test]
    fn fence_tracker_distinguishes_markdown_from_other_fences() {
        let mut tracker = FenceTracker::new();
        assert_eq!(tracker.kind(), FenceKind::Outside);

        tracker.advance("```markdown");
        assert_eq!(tracker.kind(), FenceKind::Markdown);

        tracker.advance("```");
        assert_eq!(tracker.kind(), FenceKind::Outside);

        tracker.advance("```rust");
        assert_eq!(tracker.kind(), FenceKind::Other);
    }
}

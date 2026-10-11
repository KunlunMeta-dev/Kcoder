//! Parser event text coalescing and agent Markdown normalization.

use super::*;

/// Merge adjacent parser text events without reconstructing them from source markdown.
///
/// Some pulldown-cmark extensions split visually contiguous text around delimiter characters. The
/// renderer detects URLs and local paths from decoded text, so keeping adjacent decoded text
/// together preserves those tokens while still carrying a useful source range for offset-aware
/// table parsing.
pub(super) struct DecodedTextMerge<I: Iterator> {
    pub(super) iter: Peekable<I>,
}

impl<I: Iterator> DecodedTextMerge<I> {
    pub(super) fn new(iter: I) -> Self {
        Self {
            iter: iter.peekable(),
        }
    }
}

impl<'a, I> Iterator for DecodedTextMerge<I>
where
    I: Iterator<Item = (Event<'a>, Range<usize>)>,
{
    type Item = (Event<'a>, Range<usize>);

    fn next(&mut self) -> Option<Self::Item> {
        let (event, mut range) = self.iter.next()?;
        let Event::Text(text) = event else {
            return Some((event, range));
        };
        if !matches!(self.iter.peek(), Some((Event::Text(_), _))) {
            return Some((Event::Text(text), range));
        }

        let mut merged = text.into_string();
        while matches!(self.iter.peek(), Some((Event::Text(_), _))) {
            let Some((Event::Text(text), next_range)) = self.iter.next() else {
                break;
            };
            merged.push_str(&text);
            range.end = next_range.end;
        }
        Some((Event::Text(merged.into()), range))
    }
}

/// Strip markdown fences that wrap pipe tables so assistant responses render
/// those tables structurally instead of as code blocks.
pub(super) fn unwrap_markdown_fences<'a>(markdown_source: &'a str) -> Cow<'a, str> {
    normalize_agent_markdown(markdown_source, None)
        .expect("normal rendering does not impose navigation budgets")
        .text
}

pub(super) struct NormalizedMarkdown<'a> {
    pub(super) text: Cow<'a, str>,
    pub(super) source_ranges: Vec<(usize, Range<usize>)>,
}

impl NormalizedMarkdown<'_> {
    pub(super) fn original_offset(&self, offset: usize) -> usize {
        let index = self
            .source_ranges
            .partition_point(|(start, _)| *start <= offset);
        if index == 0 {
            return offset;
        }
        let (start, range) = &self.source_ranges[index - 1];
        range.start + offset.saturating_sub(*start).min(range.len())
    }
}

pub(super) fn normalize_agent_markdown<'a>(
    markdown_source: &'a str,
    mut budget: Option<&mut NavigationBudget<'_>>,
) -> Result<NormalizedMarkdown<'a>, NavigationRenderError> {
    if !markdown_source.contains("```") && !markdown_source.contains("~~~") {
        return Ok(NormalizedMarkdown {
            text: Cow::Borrowed(markdown_source),
            source_ranges: Vec::new(),
        });
    }

    #[derive(Clone, Copy)]
    struct Fence {
        marker: u8,
        len: usize,
        is_blockquoted: bool,
    }

    fn strip_line_indent(line: &str) -> Option<&str> {
        let without_newline = line.strip_suffix('\n').unwrap_or(line);
        let mut byte_idx = 0usize;
        let mut column = 0usize;
        for byte in without_newline.as_bytes() {
            match byte {
                b' ' => {
                    byte_idx += 1;
                    column += 1;
                }
                b'\t' => {
                    byte_idx += 1;
                    column += 4;
                }
                _ => break,
            }
            if column >= 4 {
                return None;
            }
        }
        Some(&without_newline[byte_idx..])
    }

    fn parse_open_fence(line: &str) -> Option<(Fence, bool)> {
        let trimmed = strip_line_indent(line)?;
        let is_blockquoted = trimmed.trim_start().starts_with('>');
        let fence_scan_text = strip_blockquote_prefix(trimmed);
        let (marker, len) = parse_fence_marker(fence_scan_text)?;
        let is_markdown = is_markdown_fence_info(fence_scan_text, len);
        Some((
            Fence {
                marker: marker as u8,
                len,
                is_blockquoted,
            },
            is_markdown,
        ))
    }

    fn is_close_fence(line: &str, fence: Fence) -> bool {
        let Some(trimmed) = strip_line_indent(line) else {
            return false;
        };
        let fence_scan_text = if fence.is_blockquoted {
            if !trimmed.trim_start().starts_with('>') {
                return false;
            }
            strip_blockquote_prefix(trimmed)
        } else {
            trimmed
        };
        if let Some((marker, len)) = parse_fence_marker(fence_scan_text) {
            marker as u8 == fence.marker
                && len >= fence.len
                && fence_scan_text[len..].trim().is_empty()
        } else {
            false
        }
    }

    fn markdown_fence_contains_table(content: &str, is_blockquoted_fence: bool) -> bool {
        let mut previous_line: Option<&str> = None;
        for line in content.lines() {
            let text = if is_blockquoted_fence {
                strip_blockquote_prefix(line)
            } else {
                line
            };
            let trimmed = text.trim();
            if trimmed.is_empty() {
                previous_line = None;
                continue;
            }

            if let Some(previous) = previous_line
                && is_table_header_line(previous)
                && !is_table_delimiter_line(previous)
                && is_table_delimiter_line(trimmed)
            {
                return true;
            }

            previous_line = Some(trimmed);
        }
        false
    }

    fn content_from_ranges(source: &str, ranges: &[Range<usize>]) -> String {
        let total_len: usize = ranges.iter().map(ExactSizeIterator::len).sum();
        let mut content = String::with_capacity(total_len);
        for range in ranges {
            content.push_str(&source[range.start..range.end]);
        }
        content
    }

    struct MarkdownCandidateData {
        fence: Fence,
        opening_range: Range<usize>,
        content_ranges: Vec<Range<usize>>,
    }

    enum ActiveFence {
        Passthrough(Fence),
        MarkdownCandidate(Box<MarkdownCandidateData>),
    }

    let mut out = String::with_capacity(markdown_source.len());
    let mut source_ranges: Vec<(usize, Range<usize>)> = Vec::new();
    let mut active_fence: Option<ActiveFence> = None;
    let mut source_offset = 0usize;

    let mut push_source_range = |range: Range<usize>| {
        if !range.is_empty() {
            // Merge adjacent retained segments so regular long bodies do not create per-line mappings as they grow.
            if let Some((_, previous)) = source_ranges.last_mut()
                && previous.end == range.start
            {
                previous.end = range.end;
            } else {
                source_ranges.push((out.len(), range.clone()));
            }
            out.push_str(&markdown_source[range]);
        }
    };

    for line in markdown_source.split_inclusive('\n') {
        if let Some(budget) = budget.as_mut() {
            budget.check()?;
        }
        let line_start = source_offset;
        source_offset += line.len();
        let line_range = line_start..source_offset;

        if let Some(active) = active_fence.take() {
            match active {
                ActiveFence::Passthrough(fence) => {
                    push_source_range(line_range);
                    if !is_close_fence(line, fence) {
                        active_fence = Some(ActiveFence::Passthrough(fence));
                    }
                }
                ActiveFence::MarkdownCandidate(mut data) => {
                    if is_close_fence(line, data.fence) {
                        if markdown_fence_contains_table(
                            &content_from_ranges(markdown_source, &data.content_ranges),
                            data.fence.is_blockquoted,
                        ) {
                            for range in data.content_ranges {
                                push_source_range(range);
                            }
                        } else {
                            push_source_range(data.opening_range);
                            for range in data.content_ranges {
                                push_source_range(range);
                            }
                            push_source_range(line_range);
                        }
                    } else {
                        data.content_ranges.push(line_range);
                        active_fence = Some(ActiveFence::MarkdownCandidate(data));
                    }
                }
            }
            continue;
        }

        if let Some((fence, is_markdown)) = parse_open_fence(line) {
            if is_markdown {
                active_fence = Some(ActiveFence::MarkdownCandidate(Box::new(
                    MarkdownCandidateData {
                        fence,
                        opening_range: line_range,
                        content_ranges: Vec::new(),
                    },
                )));
            } else {
                push_source_range(line_range);
                active_fence = Some(ActiveFence::Passthrough(fence));
            }
            continue;
        }

        push_source_range(line_range);
    }

    if let Some(active) = active_fence {
        match active {
            ActiveFence::Passthrough(_) => {}
            ActiveFence::MarkdownCandidate(data) => {
                push_source_range(data.opening_range);
                for range in data.content_ranges {
                    push_source_range(range);
                }
            }
        }
    }

    Ok(NormalizedMarkdown {
        text: Cow::Owned(out),
        source_ranges,
    })
}

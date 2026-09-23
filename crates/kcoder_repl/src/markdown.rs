use crate::navigation_render::{
    MAX_NAVIGATION_LINE_BYTES, NavigationBudget, NavigationHeading, NavigationRenderError,
};
use crate::render::highlight::{
    foreground_style_for_scopes_with_theme, highlight_code_to_lines_with_theme,
};
use crate::render::wrapping::text_contains_url_like;
use crate::table_detect::{
    is_markdown_fence_info, is_table_delimiter_line, is_table_header_line, parse_fence_marker,
    strip_blockquote_prefix,
};
use crate::terminal_glyphs::{TABLE_BODY_SEPARATOR, TABLE_HEADER_SEPARATOR};
use crate::terminal_hyperlinks::{
    HyperlinkLine, TerminalHyperlink, visible_lines, web_destination, web_links_in_text,
};
use crate::theme::{KCODER_UI_THEME, UiTextStyles};
use pulldown_cmark::{Alignment, Event, Options, Parser, Tag, TagEnd};
use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
};
use std::borrow::Cow;
use std::iter::Peekable;
use std::ops::Range;
use std::path::{Path, PathBuf};
use url::Url;

mod web_links;

const TABLE_COLUMN_GAP: usize = 2;
const TABLE_CELL_PADDING: usize = 1;
const TABLE_MIN_COLUMN_WIDTH: usize = 3;
const FIELD_LEADING_PADDING: usize = 1;
const FIELD_GAP: usize = 2;
const MIN_RECORD_VALUE_WIDTH: usize = 3;
const MIN_ALIGNED_COMPACT_VALUE_WIDTH: usize = 12;
const MIN_ALIGNED_EXPANSIVE_VALUE_WIDTH: usize = 24;
const STACKED_RECORD_VALUE_INDENT: usize = 2;
const MIN_SCANNABLE_NARRATIVE_WIDTH: usize = 12;
const MIN_SCANNABLE_TOKEN_HEAVY_WIDTH: usize = 12;
const CRAMPED_EXPANSIVE_CELL_LINES: usize = 4;
const CATASTROPHIC_NARRATIVE_CELL_LINES: usize = 7;

/// Render Markdown text into styled `Line`s for ratatui using the default theme.
#[allow(dead_code)]
pub fn render_markdown(text: &str) -> Vec<Line<'static>> {
    render_markdown_with_theme(text, "auto")
}

/// Render Markdown with a specific syntect code theme.
pub fn render_markdown_with_theme(text: &str, code_theme: &str) -> Vec<Line<'static>> {
    let cwd = std::env::current_dir().ok();
    visible_lines(render_markdown_hyperlink_lines_with_theme_and_cwd(
        text,
        code_theme,
        cwd.as_deref(),
        None,
    ))
}

#[cfg(test)]
fn render_markdown_with_theme_and_cwd(
    text: &str,
    code_theme: &str,
    cwd: Option<&Path>,
) -> Vec<Line<'static>> {
    visible_lines(render_markdown_hyperlink_lines_with_theme_and_cwd(
        text, code_theme, cwd, None,
    ))
}

pub(crate) fn render_markdown_hyperlink_lines_with_theme(
    text: &str,
    code_theme: &str,
) -> Vec<HyperlinkLine> {
    let cwd = std::env::current_dir().ok();
    render_markdown_hyperlink_lines_with_theme_and_cwd(text, code_theme, cwd.as_deref(), None)
}

pub(crate) fn render_markdown_hyperlink_lines_with_theme_and_width(
    text: &str,
    code_theme: &str,
    width: Option<usize>,
) -> Vec<HyperlinkLine> {
    let cwd = std::env::current_dir().ok();
    render_markdown_hyperlink_lines_with_theme_and_cwd(text, code_theme, cwd.as_deref(), width)
}

pub(crate) fn render_agent_markdown_hyperlink_lines_with_theme(
    text: &str,
    code_theme: &str,
) -> Vec<HyperlinkLine> {
    let cwd = std::env::current_dir().ok();
    let normalized = unwrap_markdown_fences(text);
    render_markdown_hyperlink_lines_with_theme_and_cwd(
        &normalized,
        code_theme,
        cwd.as_deref(),
        None,
    )
}

pub(crate) fn render_agent_markdown_hyperlink_lines_with_theme_and_width(
    text: &str,
    code_theme: &str,
    width: Option<usize>,
) -> Vec<HyperlinkLine> {
    let cwd = std::env::current_dir().ok();
    let normalized = unwrap_markdown_fences(text);
    render_markdown_hyperlink_lines_with_theme_and_cwd(
        &normalized,
        code_theme,
        cwd.as_deref(),
        width,
    )
}

fn render_markdown_hyperlink_lines_with_theme_and_cwd(
    text: &str,
    code_theme: &str,
    cwd: Option<&Path>,
    width: Option<usize>,
) -> Vec<HyperlinkLine> {
    render_markdown_hyperlink_lines_with_theme_and_cwd_policy(
        text,
        code_theme,
        cwd,
        width,
        web_links::hide_web_link_destinations(),
    )
}

fn render_markdown_hyperlink_lines_with_theme_and_cwd_policy(
    text: &str,
    code_theme: &str,
    cwd: Option<&Path>,
    width: Option<usize>,
    hide_web_link_destinations: bool,
) -> Vec<HyperlinkLine> {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    let parser = DecodedTextMerge::new(Parser::new_ext(text, options).into_offset_iter());
    let mut renderer =
        MarkdownRenderer::new(text, code_theme, cwd, width, hide_web_link_destinations);
    for (event, range) in parser {
        renderer.handle(event, range);
    }
    let lines = renderer.finish();
    if let Some(width) = width {
        wrap_markdown_hyperlink_lines(lines, width)
    } else {
        lines
    }
}

pub(super) fn navigation_headings(
    source: &str,
    agent_markdown: bool,
    budget: &mut NavigationBudget<'_>,
) -> Result<Vec<NavigationHeading>, NavigationRenderError> {
    let normalized = if agent_markdown {
        normalize_agent_markdown(source, Some(budget))?
    } else {
        NormalizedMarkdown {
            text: Cow::Borrowed(source),
            source_ranges: Vec::new(),
        }
    };
    let mut quote_depth = 0usize;
    let mut heading: Option<NavigationHeading> = None;
    let mut headings = Vec::new();
    let parser = Parser::new_ext(&normalized.text, navigation_parser_options()).into_offset_iter();
    for (event, range) in parser {
        budget.check()?;
        match event {
            Event::Start(Tag::BlockQuote(_)) => quote_depth += 1,
            Event::End(TagEnd::BlockQuote(_)) => quote_depth = quote_depth.saturating_sub(1),
            Event::Start(Tag::Heading { level, .. }) if quote_depth == 0 => {
                heading = Some(NavigationHeading {
                    source_byte: normalized.original_offset(range.start),
                    level: level as u8,
                    label: String::new(),
                });
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some(heading) = heading.as_mut() {
                    for ch in text.chars() {
                        if heading.label.len() + ch.len_utf8() > 256 {
                            break;
                        }
                        heading.label.push(ch);
                    }
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some(heading) = heading.as_mut()
                    && heading.label.len() < 256
                {
                    heading.label.push(' ');
                }
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some(mut heading) = heading.take() {
                    heading.label = heading.label.trim().to_string();
                    if !heading.label.is_empty() {
                        if headings.len() >= 16_384 {
                            return Err(NavigationRenderError::BudgetExceeded("heading details"));
                        }
                        headings.push(heading);
                    }
                }
            }
            _ => {}
        }
    }
    Ok(headings)
}

fn navigation_parser_options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS
}

pub(super) fn stream_navigation_markdown(
    source: &str,
    code_theme: &str,
    width: Option<usize>,
    agent_markdown: bool,
    target_byte: Option<usize>,
    budget: &mut NavigationBudget<'_>,
    mut emit: impl FnMut(HyperlinkLine, usize, bool) -> Result<(), NavigationRenderError>,
) -> Result<(), NavigationRenderError> {
    let normalized = if agent_markdown {
        normalize_agent_markdown(source, Some(budget))?
    } else {
        NormalizedMarkdown {
            text: Cow::Borrowed(source),
            source_ranges: Vec::new(),
        }
    };
    let cwd = std::env::current_dir().ok();
    let mut renderer = MarkdownRenderer::new(
        &normalized.text,
        code_theme,
        cwd.as_deref(),
        width,
        web_links::hide_web_link_destinations(),
    );
    let mut wrapper = MarkdownLineWrapper::default();
    let mut target_line = None;
    let mut body_source = 0;
    let parser = DecodedTextMerge::new(
        Parser::new_ext(&normalized.text, navigation_parser_options()).into_offset_iter(),
    );
    for (event, range) in parser {
        budget.check()?;
        if renderer.context_stack.len() > 128 {
            return Err(NavigationRenderError::BudgetExceeded("markdown nesting"));
        }
        // Emit a deferred link line break before recording the heading row that follows it.
        renderer.prepare_for_event(&event);
        drain_navigation_markdown(
            &mut renderer,
            &mut wrapper,
            target_line,
            body_source,
            budget,
            &mut emit,
        )?;
        let source_selected = target_byte == Some(normalized.original_offset(range.start));
        let next_body_source = matches!(
            &event,
            Event::Start(
                Tag::Heading { .. }
                    | Tag::Paragraph
                    | Tag::Item
                    | Tag::BlockQuote(_)
                    | Tag::CodeBlock(_)
                    | Tag::Table(_)
            )
        )
        .then(|| normalized.original_offset(range.start));
        let block_selected = source_selected
            && matches!(
                &event,
                Event::Start(
                    Tag::Paragraph
                        | Tag::Item
                        | Tag::BlockQuote(_)
                        | Tag::CodeBlock(_)
                        | Tag::Table(_)
                )
            );
        let rule_selected = source_selected && matches!(&event, Event::Rule);
        if source_selected
            && matches!(&event, Event::Text(_))
            && renderer.current.is_empty()
            && renderer.code_block.is_none()
            && renderer.table.is_none()
        {
            target_line = Some(renderer.emitted_line_count);
        }
        match &event {
            Event::Start(Tag::CodeBlock(_)) | Event::Start(Tag::Table(_)) => {
                let block = &normalized.text[range.clone()];
                if block.len() > 64 * 1024 || block.lines().take(2049).count() > 2048 {
                    return Err(NavigationRenderError::BudgetExceeded("code/table block"));
                }
                if let Event::Start(Tag::Table(columns)) = &event
                    && columns.len().saturating_mul(block.lines().count()) > 1024
                {
                    return Err(NavigationRenderError::BudgetExceeded("table cells"));
                }
            }
            Event::Start(Tag::Heading { .. }) if source_selected => {
                target_line = Some(renderer.emitted_line_count);
            }
            Event::Text(text) | Event::Code(text) if text.len() > MAX_NAVIGATION_LINE_BYTES => {
                return Err(NavigationRenderError::BudgetExceeded("logical line"));
            }
            _ => {}
        }
        renderer.handle(event, range);
        // A regular answer segment may anchor at paragraph start; count the blank row produced by the start tag first.
        if block_selected {
            target_line = Some(renderer.emitted_line_count);
        }
        if rule_selected {
            target_line = Some(renderer.emitted_line_count.saturating_sub(1));
        }
        if renderer
            .current
            .spans
            .iter()
            .map(|span| span.content.len())
            .sum::<usize>()
            > MAX_NAVIGATION_LINE_BYTES
        {
            return Err(NavigationRenderError::BudgetExceeded("logical line"));
        }
        drain_navigation_markdown(
            &mut renderer,
            &mut wrapper,
            target_line,
            body_source,
            budget,
            &mut emit,
        )?;
        if let Some(source) = next_body_source {
            body_source = source;
        }
    }
    if !renderer.current.is_empty() {
        renderer.flush_line();
    }
    drain_navigation_markdown(
        &mut renderer,
        &mut wrapper,
        target_line,
        body_source,
        budget,
        &mut emit,
    )?;
    if target_byte.is_some() && target_line.is_none() {
        return Err(NavigationRenderError::InvalidSource);
    }
    Ok(())
}

fn drain_navigation_markdown(
    renderer: &mut MarkdownRenderer<'_>,
    wrapper: &mut MarkdownLineWrapper,
    target_line: Option<usize>,
    body_source: usize,
    budget: &mut NavigationBudget<'_>,
    emit: &mut impl FnMut(HyperlinkLine, usize, bool) -> Result<(), NavigationRenderError>,
) -> Result<(), NavigationRenderError> {
    if renderer.lines.len() > 4096 {
        return Err(NavigationRenderError::BudgetExceeded("block output rows"));
    }
    let start = renderer.emitted_line_count - renderer.lines.len();
    for (index, line) in renderer.lines.drain(..).enumerate() {
        budget.check()?;
        if line
            .line
            .spans
            .iter()
            .map(|span| span.content.len())
            .sum::<usize>()
            > MAX_NAVIGATION_LINE_BYTES
        {
            return Err(NavigationRenderError::BudgetExceeded("logical line"));
        }
        let (lines, original_start) = if let Some(width) = renderer.width {
            wrapper.wrap_line(line, width)
        } else {
            (vec![line], 0)
        };
        for (wrapped_index, line) in lines.into_iter().enumerate() {
            // A separator blank row inserted by list wrapping still belongs to the preceding source block.
            let source = if wrapped_index < original_start {
                wrapper.last_navigation_source.unwrap_or(body_source)
            } else {
                body_source
            };
            emit(
                line,
                source,
                target_line == Some(start + index) && wrapped_index == original_start,
            )?;
            wrapper.last_navigation_source = Some(source);
        }
    }
    Ok(())
}

/// Merge adjacent parser text events without reconstructing them from source markdown.
///
/// Some pulldown-cmark extensions split visually contiguous text around delimiter characters. The
/// renderer detects URLs and local paths from decoded text, so keeping adjacent decoded text
/// together preserves those tokens while still carrying a useful source range for offset-aware
/// table parsing.
struct DecodedTextMerge<I: Iterator> {
    iter: Peekable<I>,
}

impl<I: Iterator> DecodedTextMerge<I> {
    fn new(iter: I) -> Self {
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

/// Pre-load Markdown rendering resources so the first TUI frame does not
/// pay the cost of initializing syntect and pulldown-cmark on the hot path.
pub fn warm_up(code_theme: &str) {
    const SAMPLE: &str = r#"
# Warm-up
Some **bold** text and `inline code`.

```rust
fn main() {
    println!("hello");
}
```
"#;
    let _ = render_markdown_with_theme(SAMPLE, code_theme);
}

/// Strip markdown fences that wrap pipe tables so assistant responses render
/// those tables structurally instead of as code blocks.
fn unwrap_markdown_fences<'a>(markdown_source: &'a str) -> Cow<'a, str> {
    normalize_agent_markdown(markdown_source, None)
        .expect("normal rendering does not impose navigation budgets")
        .text
}

struct NormalizedMarkdown<'a> {
    text: Cow<'a, str>,
    source_ranges: Vec<(usize, Range<usize>)>,
}

impl NormalizedMarkdown<'_> {
    fn original_offset(&self, offset: usize) -> usize {
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

fn normalize_agent_markdown<'a>(
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

#[derive(Debug, Clone, Default)]
struct SpanAccumulator {
    spans: Vec<Span<'static>>,
    hyperlinks: Vec<TerminalHyperlink>,
}

impl SpanAccumulator {
    fn width(&self) -> usize {
        self.spans
            .iter()
            .map(|span| unicode_width::UnicodeWidthStr::width(span.content.as_ref()))
            .sum()
    }

    fn push(
        &mut self,
        content: impl Into<String>,
        style: Style,
        destination: Option<&str>,
        annotate_bare_urls: bool,
    ) {
        let content = content.into();
        let start = self.width();
        let width = unicode_width::UnicodeWidthStr::width(content.as_str());
        self.spans.push(Span::styled(content.clone(), style));
        if width == 0 {
            return;
        }
        if let Some(destination) = destination.and_then(web_destination) {
            self.hyperlinks.push(TerminalHyperlink {
                columns: start..start + width,
                destination,
            });
        } else if annotate_bare_urls {
            self.hyperlinks
                .extend(web_links_in_text(&content).into_iter().map(|mut link| {
                    link.columns = link.columns.start + start..link.columns.end + start;
                    link
                }));
        }
    }

    fn is_empty(&self) -> bool {
        self.spans.is_empty()
            || self
                .spans
                .iter()
                .all(|s| s.content.is_empty() && s.style == Style::default())
    }

    fn take_line(&mut self) -> HyperlinkLine {
        HyperlinkLine {
            line: Line::from(std::mem::take(&mut self.spans)),
            hyperlinks: std::mem::take(&mut self.hyperlinks),
            preformatted: false,
        }
    }
}

struct MarkdownRenderer<'a> {
    source: &'a str,
    lines: Vec<HyperlinkLine>,
    emitted_line_count: usize,
    current: SpanAccumulator,
    styles: UiTextStyles,
    style_stack: Vec<Style>,
    list_stack: Vec<ListState>,
    list_item_start_line_counts: Vec<usize>,
    list_needs_blank_before_next_item: Vec<bool>,
    context_stack: Vec<MarkdownContext>,
    blockquote_depth: usize,
    code_block: Option<CodeBlockState>,
    table: Option<TableState>,
    link: Option<LinkState>,
    code_theme: String,
    cwd: Option<PathBuf>,
    width: Option<usize>,
    pending_line_break: bool,
    line_ends_with_local_link_target: bool,
    pending_local_link_soft_break: bool,
    current_line_has_list_marker: bool,
    current_line_marker_width: Option<usize>,
    current_line_prefix_suppressed: bool,
    last_code_block_item_depth: Option<usize>,
    hide_web_link_destinations: bool,
}

#[derive(Debug, Clone)]
struct ListState {
    kind: ListKind,
    index: u64,
}

#[derive(Debug, Clone, Copy)]
enum ListKind {
    Bullet,
    Ordered,
}

#[derive(Debug, Clone, Copy)]
enum MarkdownContext {
    BlockQuote,
    List(ListKind),
}

#[derive(Debug, Clone)]
struct CodeBlockState {
    lang: String,
    content: String,
    indent: String,
}

#[derive(Debug, Clone)]
struct LinkState {
    destination: String,
    show_destination: bool,
    is_web: bool,
    has_visible_label: bool,
    local_target_display: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct TableCell {
    spans: Vec<Span<'static>>,
    hyperlinks: Vec<TerminalHyperlink>,
}

impl TableCell {
    fn width(&self) -> usize {
        self.spans
            .iter()
            .map(|span| unicode_width::UnicodeWidthStr::width(span.content.as_ref()))
            .sum()
    }

    fn push(
        &mut self,
        content: impl Into<String>,
        style: Style,
        destination: Option<&str>,
        annotate_bare_urls: bool,
    ) {
        let content = content.into();
        let start = self.width();
        let width = unicode_width::UnicodeWidthStr::width(content.as_str());
        self.spans.push(Span::styled(content.clone(), style));
        if width == 0 {
            return;
        }
        if let Some(destination) = destination.and_then(web_destination) {
            self.hyperlinks.push(TerminalHyperlink {
                columns: start..start + width,
                destination,
            });
        } else if annotate_bare_urls {
            self.hyperlinks
                .extend(web_links_in_text(&content).into_iter().map(|mut link| {
                    link.columns = link.columns.start + start..link.columns.end + start;
                    link
                }));
        }
    }

    fn text(&self) -> String {
        self.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    }
}

#[derive(Debug, Clone)]
struct TableState {
    alignments: Vec<Alignment>,
    header: Option<Vec<TableCell>>,
    rows: Vec<TableBodyRow>,
    current_row: Option<Vec<TableCell>>,
    current_cell: Option<TableCell>,
    in_header: bool,
    current_row_has_table_pipe_syntax: bool,
}

#[derive(Debug, Clone)]
struct TableBodyRow {
    cells: Vec<TableCell>,
    has_table_pipe_syntax: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TableColumnKind {
    Narrative,
    TokenHeavy,
    Compact,
}

#[derive(Clone, Debug)]
struct TableColumnMetrics {
    max_width: usize,
    header_token_width: usize,
    body_token_width: usize,
    kind: TableColumnKind,
}

impl TableState {
    fn new(alignments: Vec<Alignment>) -> Self {
        Self {
            alignments,
            header: None,
            rows: Vec::new(),
            current_row: None,
            current_cell: None,
            in_header: false,
            current_row_has_table_pipe_syntax: false,
        }
    }
}

impl<'a> MarkdownRenderer<'a> {
    fn new(
        source: &'a str,
        code_theme_name: &str,
        cwd: Option<&Path>,
        width: Option<usize>,
        hide_web_link_destinations: bool,
    ) -> Self {
        let mut styles = KCODER_UI_THEME.text_styles();
        styles.table_header = foreground_style_for_scopes_with_theme(
            code_theme_name,
            &["entity.name.type", "support.type", "variable"],
        )
        .unwrap_or(styles.table_header)
        .add_modifier(Modifier::BOLD);
        Self {
            source,
            lines: Vec::new(),
            emitted_line_count: 0,
            current: SpanAccumulator::default(),
            styles,
            style_stack: vec![styles.body],
            list_stack: Vec::new(),
            list_item_start_line_counts: Vec::new(),
            list_needs_blank_before_next_item: Vec::new(),
            context_stack: Vec::new(),
            blockquote_depth: 0,
            code_block: None,
            table: None,
            link: None,
            code_theme: code_theme_name.to_string(),
            cwd: cwd.map(Path::to_path_buf),
            width,
            pending_line_break: false,
            line_ends_with_local_link_target: false,
            pending_local_link_soft_break: false,
            current_line_has_list_marker: false,
            current_line_marker_width: None,
            current_line_prefix_suppressed: false,
            last_code_block_item_depth: None,
            hide_web_link_destinations,
        }
    }

    fn current_style(&self) -> Style {
        *self.style_stack.last().unwrap()
    }

    fn push_style(&mut self, modifier: Modifier) {
        let style = self.current_style().add_modifier(modifier);
        self.style_stack.push(style);
    }

    fn pop_style(&mut self) {
        if self.style_stack.len() > 1 {
            self.style_stack.pop();
        }
    }

    fn handle(&mut self, event: Event<'_>, range: Range<usize>) {
        self.prepare_for_event(&event);
        match event {
            Event::Start(tag) => self.start_tag(tag, range),
            Event::End(tag_end) => self.end_tag(tag_end),
            Event::Text(text) => self.push_text(&text),
            Event::Code(code) => {
                self.push_code_text(code.into_string());
            }
            Event::Html(html) | Event::InlineHtml(html) => self.push_html(&html),
            Event::SoftBreak => {
                if self.suppressing_local_link_label() {
                    return;
                }
                if self.in_table_cell() {
                    self.push_text(" ");
                } else if self.line_ends_with_local_link_target {
                    self.pending_local_link_soft_break = true;
                    self.line_ends_with_local_link_target = false;
                } else {
                    self.line_ends_with_local_link_target = false;
                    self.flush_line();
                }
            }
            Event::HardBreak => {
                if self.suppressing_local_link_label() {
                    return;
                }
                if self.in_table_cell() {
                    self.push_text(" ");
                } else {
                    self.line_ends_with_local_link_target = false;
                    self.flush_line();
                }
            }
            Event::Rule => {
                self.flush_line();
                self.emit_line(HyperlinkLine::new(
                    Line::from("———").style(self.styles.rule),
                ));
            }
            Event::TaskListMarker(checked) => {
                let marker = if checked { "[x] " } else { "[ ] " };
                let style = if checked {
                    self.styles.task_checked
                } else {
                    self.styles.task_unchecked
                };
                self.current.push(marker, style, None, false);
            }
            _ => {}
        }
    }

    fn prepare_for_event(&mut self, event: &Event<'_>) {
        if !self.pending_local_link_soft_break {
            return;
        }
        if matches!(event, Event::Text(text) if text.trim_start().starts_with(':')) {
            self.pending_local_link_soft_break = false;
            return;
        }
        self.pending_local_link_soft_break = false;
        self.flush_line();
    }

    fn start_tag(&mut self, tag: Tag<'_>, range: Range<usize>) {
        match tag {
            Tag::Paragraph => {
                if self.pending_line_break {
                    self.flush_line();
                }
                self.pending_line_break = false;
            }
            Tag::Heading { level, .. } => {
                let style = match level {
                    pulldown_cmark::HeadingLevel::H1 => self.styles.heading_h1,
                    pulldown_cmark::HeadingLevel::H2 => self.styles.heading_h2,
                    pulldown_cmark::HeadingLevel::H3 => self.styles.heading_h3,
                    pulldown_cmark::HeadingLevel::H4 => self.styles.heading_h4,
                    pulldown_cmark::HeadingLevel::H5 => self.styles.heading_h5,
                    pulldown_cmark::HeadingLevel::H6 => self.styles.heading_h6,
                };
                self.style_stack.push(style);
            }
            Tag::BlockQuote(_) => {
                if !self.current.is_empty() {
                    if self.current_line_has_list_marker
                        && self.current_line_marker_width == Some(self.current.width())
                    {
                        self.current
                            .push("> ", self.styles.blockquote_prefix, None, false);
                        self.current_line_prefix_suppressed = true;
                    } else {
                        self.flush_line();
                    }
                }
                self.blockquote_depth += 1;
                self.context_stack.push(MarkdownContext::BlockQuote);
            }
            Tag::CodeBlock(lang) => {
                if self.pending_line_break {
                    self.flush_line();
                    self.pending_line_break = false;
                }
                let (lang_str, indent) = match lang {
                    pulldown_cmark::CodeBlockKind::Fenced(lang) => {
                        (lang.to_string(), String::new())
                    }
                    pulldown_cmark::CodeBlockKind::Indented => (String::new(), "    ".to_string()),
                };
                self.code_block = Some(CodeBlockState {
                    lang: lang_str,
                    content: String::new(),
                    indent,
                });
            }
            Tag::Emphasis => self.push_style(Modifier::ITALIC),
            Tag::Strong => self.push_style(Modifier::BOLD),
            Tag::Strikethrough => self.push_style(Modifier::CROSSED_OUT),
            Tag::Link { dest_url, .. } => self.start_link(dest_url.to_string()),
            Tag::List(start) => {
                if !self.current.is_empty() {
                    self.flush_line();
                }
                let kind = if start.is_some() {
                    ListKind::Ordered
                } else {
                    ListKind::Bullet
                };
                self.list_stack.push(ListState {
                    kind,
                    index: start.unwrap_or(1),
                });
                self.list_needs_blank_before_next_item.push(false);
                self.context_stack.push(MarkdownContext::List(kind));
            }
            Tag::Item => {
                let depth = self.list_stack.len().max(1);
                let needs_blank = self
                    .list_needs_blank_before_next_item
                    .last_mut()
                    .map(std::mem::take)
                    .unwrap_or(false)
                    || self
                        .last_code_block_item_depth
                        .is_some_and(|code_depth| depth <= code_depth);
                if needs_blank {
                    self.flush_line();
                }
                if self
                    .last_code_block_item_depth
                    .is_some_and(|code_depth| depth <= code_depth)
                {
                    self.last_code_block_item_depth = None;
                }
                self.pending_line_break = false;
                self.list_item_start_line_counts
                    .push(self.emitted_line_count);
                let marker_width = depth.saturating_mul(4).saturating_sub(3).max(1);
                let (marker, marker_style) = if let Some(state) = self.list_stack.last_mut() {
                    match state.kind {
                        ListKind::Bullet => (
                            format!("{}- ", " ".repeat(marker_width.saturating_sub(1))),
                            self.styles.unordered_list_marker,
                        ),
                        ListKind::Ordered => {
                            let idx = state.index;
                            state.index += 1;
                            (
                                format!("{idx:marker_width$}. "),
                                self.styles.ordered_list_marker,
                            )
                        }
                    }
                } else {
                    ("- ".to_string(), self.styles.unordered_list_marker)
                };
                let marker_width = unicode_width::UnicodeWidthStr::width(marker.as_str());
                self.current.push(marker, marker_style, None, false);
                self.current_line_has_list_marker = true;
                self.current_line_marker_width = Some(marker_width);
            }
            Tag::Table(alignments) => self.start_table(alignments),
            Tag::TableHead => self.start_table_head(),
            Tag::TableRow => self.start_table_row(range),
            Tag::TableCell => self.start_table_cell(),
            _ => {}
        }
    }

    fn end_tag(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Heading(_) => {
                self.style_stack.pop();
                self.flush_line();
            }
            TagEnd::Paragraph => {
                self.flush_line();
                self.pending_line_break = true;
            }
            TagEnd::BlockQuote(_) => {
                self.blockquote_depth = self.blockquote_depth.saturating_sub(1);
                self.pop_context(|context| matches!(context, MarkdownContext::BlockQuote));
            }
            TagEnd::CodeBlock => {
                if let Some(block) = self.code_block.take() {
                    self.render_code_block(&block.lang, &block.content, &block.indent);
                    self.pending_line_break = true;
                    if !self.list_stack.is_empty() {
                        self.last_code_block_item_depth = Some(self.list_stack.len());
                    }
                }
            }
            TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough => {
                self.pop_style();
            }
            TagEnd::Link => self.end_link(),
            TagEnd::List(_) => {
                self.list_stack.pop();
                self.list_needs_blank_before_next_item.pop();
                self.pop_context(|context| matches!(context, MarkdownContext::List(_)));
                self.pending_line_break = false;
                if self.list_stack.is_empty() {
                    self.last_code_block_item_depth = None;
                }
                if !self.current.is_empty() {
                    self.flush_line();
                }
            }
            TagEnd::Item => {
                self.pending_line_break = false;
                if !self.current.is_empty() {
                    self.flush_line();
                }
                let start_line_count = self.list_item_start_line_counts.pop().unwrap_or_default();
                if self.emitted_line_count.saturating_sub(start_line_count) > 1
                    && let Some(needs_blank) = self.list_needs_blank_before_next_item.last_mut()
                {
                    *needs_blank = true;
                }
            }
            TagEnd::Table => self.end_table(),
            TagEnd::TableHead => self.end_table_head(),
            TagEnd::TableRow => self.end_table_row(),
            TagEnd::TableCell => self.end_table_cell(),
            _ => {}
        }
    }

    fn push_text(&mut self, text: &str) {
        if let Some(block) = self.code_block.as_mut() {
            block.content.push_str(text);
            return;
        }
        self.line_ends_with_local_link_target = false;
        self.push_styled_text(text.to_string(), self.current_style());
    }

    fn push_html(&mut self, html: &str) {
        if let Some(block) = self.code_block.as_mut() {
            block.content.push_str(html);
            return;
        }
        if self.in_table_cell() {
            self.line_ends_with_local_link_target = false;
            for (index, line) in html.lines().enumerate() {
                if index > 0 {
                    self.push_text(" ");
                }
                self.push_styled_text(line.to_string(), self.current_style());
            }
            return;
        }

        for segment in html.split_inclusive('\n') {
            let has_line_break = segment.ends_with('\n');
            let line = segment.strip_suffix('\n').unwrap_or(segment);
            if !line.is_empty() {
                self.line_ends_with_local_link_target = false;
                self.push_styled_text(line.to_string(), self.current_style());
            }
            if has_line_break {
                self.flush_line();
            }
        }
    }

    fn push_styled_text(&mut self, text: String, style: Style) {
        if self.suppressing_local_link_label() {
            return;
        }
        let style = self.style_link_label(&text, style);
        let destination = self.link_web_destination();
        let annotate_bare_urls = self.link.is_none();
        self.append_styled_text_with_links(text, style, destination.as_deref(), annotate_bare_urls);
    }

    fn push_code_text(&mut self, text: String) {
        if self.suppressing_local_link_label() {
            return;
        }
        self.line_ends_with_local_link_target = false;
        let style = self.style_link_label(&text, self.styles.inline_code);
        let destination = self.link_web_destination();
        self.append_styled_text_with_links(text, style, destination.as_deref(), false);
    }

    fn append_styled_text(&mut self, text: String, style: Style) {
        self.append_styled_text_with_links(text, style, None, false);
    }

    fn append_styled_text_with_links(
        &mut self,
        text: String,
        style: Style,
        destination: Option<&str>,
        annotate_bare_urls: bool,
    ) {
        if let Some(cell) = self
            .table
            .as_mut()
            .and_then(|table_state| table_state.current_cell.as_mut())
        {
            cell.push(text, style, destination, annotate_bare_urls);
            return;
        }
        if self.pending_line_break && !self.current.is_empty() {
            self.flush_line();
        }
        self.current
            .push(text, style, destination, annotate_bare_urls);
    }

    fn link_web_destination(&self) -> Option<String> {
        self.link
            .as_ref()
            .and_then(|link| web_destination(&link.destination))
    }

    fn start_link(&mut self, destination: String) {
        let local_target_display = if is_local_path_like_link(&destination) {
            render_local_link_target(&destination, self.cwd.as_deref())
        } else {
            None
        };
        let is_web = web_destination(&destination).is_some();
        let show_destination =
            !is_local_path_like_link(&destination) && (!is_web || !self.hide_web_link_destinations);
        self.link = Some(LinkState {
            destination,
            show_destination,
            is_web,
            has_visible_label: false,
            local_target_display,
        });
    }

    fn style_link_label(&mut self, text: &str, style: Style) -> Style {
        let Some(link) = self.link.as_mut() else {
            return style;
        };
        if !link.is_web {
            return style;
        }
        if !text.trim().is_empty() && unicode_width::UnicodeWidthStr::width(text) > 0 {
            link.has_visible_label = true;
        }
        style.patch(self.styles.link)
    }

    fn end_link(&mut self) {
        if let Some(link) = self.link.take() {
            if let Some(local_target_display) = link.local_target_display {
                let style = self.current_style().patch(self.styles.inline_code);
                self.append_styled_text(local_target_display, style);
                self.line_ends_with_local_link_target = true;
            } else if link.show_destination || (link.is_web && !link.has_visible_label) {
                self.line_ends_with_local_link_target = false;
                let style = self.styles.link;
                let destination = web_destination(&link.destination);
                self.append_styled_text(" (".to_string(), self.styles.body);
                self.append_styled_text_with_links(
                    link.destination,
                    style,
                    destination.as_deref(),
                    false,
                );
                self.append_styled_text(")".to_string(), self.styles.body);
            }
        }
    }

    fn suppressing_local_link_label(&self) -> bool {
        self.link
            .as_ref()
            .and_then(|link| link.local_target_display.as_ref())
            .is_some()
    }

    fn in_table_cell(&self) -> bool {
        self.table
            .as_ref()
            .and_then(|table_state| table_state.current_cell.as_ref())
            .is_some()
    }

    fn render_code_block(&mut self, lang: &str, content: &str, indent: &str) {
        let lang = code_fence_language_token(lang);
        for line in highlight_code_to_lines_with_theme(content, lang, &self.code_theme) {
            let mut spans = Vec::new();
            if !indent.is_empty() {
                spans.push(Span::raw(indent.to_string()));
            }
            spans.extend(line.spans);
            self.push_preformatted_line(HyperlinkLine::preformatted(Line::from(spans)));
        }
    }

    fn start_table(&mut self, alignments: Vec<Alignment>) {
        if !self.current.is_empty() {
            self.flush_line();
        }
        self.table = Some(TableState::new(alignments));
    }

    fn start_table_head(&mut self) {
        if let Some(table_state) = self.table.as_mut() {
            table_state.in_header = true;
            table_state.current_row = Some(Vec::new());
        }
    }

    fn end_table_head(&mut self) {
        if let Some(table_state) = self.table.as_mut() {
            if let Some(row) = table_state.current_row.take() {
                table_state.header = Some(row);
            }
            table_state.in_header = false;
        }
    }

    fn start_table_row(&mut self, source_range: Range<usize>) {
        let has_table_pipe_syntax = self.has_table_row_boundary_pipe(source_range);
        if let Some(table_state) = self.table.as_mut() {
            if table_state.in_header && table_state.current_row.is_some() {
                return;
            }
            table_state.current_row = Some(Vec::new());
            table_state.current_row_has_table_pipe_syntax = has_table_pipe_syntax;
        }
    }

    fn has_table_row_boundary_pipe(&self, source_range: Range<usize>) -> bool {
        let Some(source) = self.source.get(source_range) else {
            return false;
        };
        let source = source.trim();
        source.starts_with('|') || source.ends_with('|')
    }

    fn end_table_row(&mut self) {
        if let Some(table_state) = self.table.as_mut()
            && let Some(row) = table_state.current_row.take()
        {
            if table_state.in_header {
                table_state.header = Some(row);
            } else {
                table_state.rows.push(TableBodyRow {
                    cells: row,
                    has_table_pipe_syntax: table_state.current_row_has_table_pipe_syntax,
                });
            }
            table_state.current_row_has_table_pipe_syntax = false;
        }
    }

    fn start_table_cell(&mut self) {
        if let Some(table_state) = self.table.as_mut() {
            table_state.current_cell = Some(TableCell::default());
        }
    }

    fn end_table_cell(&mut self) {
        if let Some(table_state) = self.table.as_mut()
            && let Some(cell) = table_state.current_cell.take()
            && let Some(row) = table_state.current_row.as_mut()
        {
            row.push(cell);
        }
    }

    fn end_table(&mut self) {
        let Some(table_state) = self.table.take() else {
            return;
        };
        self.render_table(table_state);
    }

    fn render_table(&mut self, table_state: TableState) {
        let column_count = table_column_count(&table_state);
        if column_count == 0 {
            return;
        }

        let mut header = table_state.header.unwrap_or_default();
        normalize_table_row(&mut header, column_count);
        let mut spillover_rows = Vec::new();
        let mut rows = Vec::with_capacity(table_state.rows.len());
        for (row_idx, row) in table_state.rows.iter().enumerate() {
            let next_row = table_state.rows.get(row_idx + 1);
            if column_count > 1 && is_table_spillover_row(row, next_row) {
                if let Some(cell) = row.cells.first().cloned() {
                    spillover_rows.push(cell);
                }
            } else {
                rows.push(row.cells.clone());
            }
        }
        for row in &mut rows {
            normalize_table_row(row, column_count);
        }
        let spillover_lines = spillover_rows
            .into_iter()
            .map(table_cell_to_hyperlink_line)
            .collect::<Vec<_>>();

        let table_width = self.table_content_width();
        let natural_widths = table_column_widths(&header, &rows, column_count);
        let metrics = collect_table_column_metrics(&header, &rows, column_count);
        let widths = constrained_table_column_widths(&natural_widths, &metrics, table_width);
        let should_render_records = table_width.is_some_and(|width| {
            let Some(widths) = widths.as_ref() else {
                return true;
            };
            table_rendered_width(&natural_widths) > width
                && table_should_render_records(&rows, widths, &metrics)
        });

        if widths.is_none() && rows.is_empty() {
            self.push_table_lines(render_table_pipe_fallback(
                &header,
                &rows,
                &table_state.alignments,
                self.styles,
            ));
            self.push_table_lines(spillover_lines);
            self.push_table_line(HyperlinkLine::new(Line::from("")));
            return;
        }

        if should_render_records && !rows.is_empty() {
            self.push_table_lines(render_table_records(
                &header,
                &rows,
                &metrics,
                table_width,
                self.styles,
            ));
            self.push_table_lines(spillover_lines);
            self.push_table_line(HyperlinkLine::new(Line::from("")));
            return;
        }

        let widths = widths.unwrap_or(natural_widths);
        if !header.iter().all(|cell| cell.text().is_empty()) {
            self.push_table_lines(render_table_row(
                &header,
                &table_state.alignments,
                &widths,
                true,
                self.styles,
            ));
            self.push_table_line(render_table_separator(
                &widths,
                TABLE_HEADER_SEPARATOR,
                self.styles.table_separator,
            ));
        }

        let row_count = rows.len();
        for (row_idx, row) in rows.into_iter().enumerate() {
            self.push_table_lines(render_table_row(
                &row,
                &table_state.alignments,
                &widths,
                false,
                self.styles,
            ));
            if row_idx + 1 < row_count {
                self.push_table_line(render_table_separator(
                    &widths,
                    TABLE_BODY_SEPARATOR,
                    self.styles.table_separator,
                ));
            }
        }
        self.push_table_lines(spillover_lines);
        self.push_table_line(HyperlinkLine::new(Line::from("")));
    }

    fn preformatted_context_prefix(&self) -> String {
        self.line_context_prefix(true)
    }

    fn table_content_width(&self) -> Option<usize> {
        let prefix = self.preformatted_context_prefix();
        let prefix_width = unicode_width::UnicodeWidthStr::width(prefix.as_str());
        self.width
            .map(|width| width.saturating_sub(prefix_width).max(1))
    }

    fn push_table_lines(&mut self, lines: Vec<HyperlinkLine>) {
        for line in lines {
            self.push_table_line(line);
        }
    }

    fn push_table_line(&mut self, line: HyperlinkLine) {
        self.push_preformatted_line(line);
    }

    fn push_preformatted_line(&mut self, mut line: HyperlinkLine) {
        self.apply_blockquote_style(&mut line);
        let prefix = self.preformatted_context_prefix();
        if prefix.is_empty() {
            self.emit_line(line);
            return;
        }

        let shift = unicode_width::UnicodeWidthStr::width(prefix.as_str());
        line.line
            .spans
            .insert(0, Span::styled(prefix, self.context_prefix_style()));
        for hyperlink in &mut line.hyperlinks {
            hyperlink.columns = hyperlink.columns.start + shift..hyperlink.columns.end + shift;
        }
        self.emit_line(line);
    }

    fn flush_line(&mut self) {
        if self.table.is_some() {
            return;
        }
        if !self.current.is_empty() {
            let mut line = self.current.take_line();
            self.apply_blockquote_style(&mut line);
            let prefix = if self.current_line_prefix_suppressed {
                String::new()
            } else {
                self.line_context_prefix(!self.current_line_has_list_marker)
            };
            self.line_ends_with_local_link_target = false;
            self.pending_local_link_soft_break = false;
            self.current_line_has_list_marker = false;
            self.current_line_marker_width = None;
            self.current_line_prefix_suppressed = false;
            if !prefix.is_empty() {
                let shift = unicode_width::UnicodeWidthStr::width(prefix.as_str());
                line.line
                    .spans
                    .insert(0, Span::styled(prefix, self.context_prefix_style()));
                for hyperlink in &mut line.hyperlinks {
                    hyperlink.columns =
                        hyperlink.columns.start + shift..hyperlink.columns.end + shift;
                }
            }
            self.emit_line(line);
        } else {
            self.line_ends_with_local_link_target = false;
            self.pending_local_link_soft_break = false;
            self.current_line_has_list_marker = false;
            self.current_line_marker_width = None;
            self.current_line_prefix_suppressed = false;
            if self.blockquote_depth > 0 {
                self.push_preformatted_line(HyperlinkLine::new(Line::from("")));
            } else {
                self.emit_line(HyperlinkLine::new(Line::from("")));
            }
        }
    }

    fn pop_context(&mut self, matches_context: impl Fn(MarkdownContext) -> bool) {
        if let Some(index) = self
            .context_stack
            .iter()
            .rposition(|context| matches_context(*context))
        {
            self.context_stack.remove(index);
        }
    }

    fn context_prefix_style(&self) -> Style {
        if self.blockquote_depth > 0 {
            self.styles.blockquote_prefix
        } else {
            self.styles.muted
        }
    }

    /// Blockquotes use a full-row semantic color; explicit accents for code, links, headings, and table headers still override it.
    fn apply_blockquote_style(&self, line: &mut HyperlinkLine) {
        if self.blockquote_depth == 0 {
            return;
        }
        line.line.style = line.line.style.patch(self.styles.blockquote);
        for span in &mut line.line.spans {
            if span.style.fg == self.styles.body.fg {
                span.style = span.style.patch(self.styles.blockquote);
            }
        }
    }

    fn line_context_prefix(&self, include_list_prefix: bool) -> String {
        let last_list_context = include_list_prefix
            .then(|| {
                self.context_stack
                    .iter()
                    .rposition(|context| matches!(context, MarkdownContext::List(_)))
            })
            .flatten();
        let mut prefix = String::new();
        let mut list_depth = 0usize;
        for (index, context) in self.context_stack.iter().copied().enumerate() {
            match context {
                MarkdownContext::BlockQuote => prefix.push_str("> "),
                MarkdownContext::List(kind) => {
                    list_depth += 1;
                    if Some(index) == last_list_context {
                        prefix.push_str(&list_continuation_prefix_for(kind, list_depth));
                    }
                }
            }
        }
        prefix
    }

    fn emit_line(&mut self, line: HyperlinkLine) {
        self.emitted_line_count += 1;
        self.lines.push(line);
    }

    fn finish(mut self) -> Vec<HyperlinkLine> {
        if !self.current.is_empty() {
            self.flush_line();
        }
        self.lines
    }
}

fn list_continuation_prefix_for(kind: ListKind, depth: usize) -> String {
    let marker_width = depth.saturating_mul(4).saturating_sub(3).max(1);
    let indent = match kind {
        ListKind::Bullet => marker_width.saturating_add(1),
        ListKind::Ordered => marker_width.saturating_add(2),
    };
    " ".repeat(indent)
}

fn code_fence_language_token(info: &str) -> &str {
    info.split([',', ' ', '\t'])
        .next()
        .filter(|token| !token.is_empty())
        .unwrap_or("")
}

#[derive(Clone, Debug)]
struct StyledCell {
    ch: char,
    width: usize,
    style: Style,
    source_columns: Range<usize>,
}

#[derive(Clone, Debug)]
struct BodyWord {
    cells: Vec<StyledCell>,
    width: usize,
    url_like: bool,
}

fn wrap_markdown_hyperlink_lines(lines: Vec<HyperlinkLine>, width: usize) -> Vec<HyperlinkLine> {
    let mut wrapped = Vec::new();
    let mut wrapper = MarkdownLineWrapper::default();
    for line in lines {
        wrapped.extend(wrapper.wrap_line(line, width).0);
    }
    wrapped
}

#[derive(Default)]
struct MarkdownLineWrapper {
    pending_wrapped_list_indent: Option<usize>,
    last_navigation_source: Option<usize>,
}

impl MarkdownLineWrapper {
    fn wrap_line(&mut self, line: HyperlinkLine, width: usize) -> (Vec<HyperlinkLine>, usize) {
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

fn markdown_list_marker_indent(text: &str) -> Option<usize> {
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

fn should_skip_markdown_width_wrap(text: &str) -> bool {
    let trimmed = text.trim_start();
    matches!(trimmed.chars().next(), Some('├' | '┌' | '└' | '┼'))
        || trimmed
            .chars()
            .all(|ch| matches!(ch, '=' | '-' | '━' | '─' | ' '))
}

fn wrap_hyperlink_line_preserving_indent(
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

fn split_long_body_word(cells: Vec<StyledCell>, width: usize) -> Vec<Vec<StyledCell>> {
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

fn preferred_path_split_index(cells: &[StyledCell]) -> Option<usize> {
    cells.iter().enumerate().rev().find_map(|(idx, cell)| {
        is_path_split_boundary(cell.ch)
            .then_some(idx + 1)
            .filter(|split| *split < cells.len())
    })
}

fn is_path_split_boundary(ch: char) -> bool {
    matches!(ch, '/' | '\\')
}

fn cells_width(cells: &[StyledCell]) -> usize {
    cells.iter().map(|cell| cell.width).sum()
}

fn styled_cells(line: &HyperlinkLine) -> Vec<StyledCell> {
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

fn take_prefix_cells(cells: &[StyledCell], prefix_cols: usize) -> Vec<StyledCell> {
    cells
        .iter()
        .filter(|cell| cell.source_columns.end <= prefix_cols)
        .cloned()
        .collect()
}

fn body_words(cells: Vec<StyledCell>) -> Vec<BodyWord> {
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

fn push_body_word(words: &mut Vec<BodyWord>, current: &mut Vec<StyledCell>) {
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

fn markdown_body_prefix_width(text: &str) -> usize {
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

fn markdown_continuation_prefix(text: &str, prefix_cols: usize) -> String {
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

fn build_wrapped_hyperlink_line(
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

fn cells_to_spans(cells: &[StyledCell]) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    for cell in cells {
        push_styled_span_char(&mut spans, cell.ch, cell.style);
    }
    spans
}

fn push_styled_span_char(spans: &mut Vec<Span<'static>>, ch: char, style: Style) {
    if let Some(last) = spans.last_mut()
        && last.style == style
    {
        last.content.to_mut().push(ch);
        return;
    }
    spans.push(Span::styled(ch.to_string(), style));
}

fn space_cell() -> StyledCell {
    StyledCell {
        ch: ' ',
        width: 1,
        style: Style::default(),
        source_columns: usize::MAX..usize::MAX,
    }
}

fn hyperlink_line_text(line: &HyperlinkLine) -> String {
    line.line
        .spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect()
}

fn table_column_count(table_state: &TableState) -> usize {
    let header_cols = table_state.header.as_ref().map_or(0, Vec::len);
    let row_cols = table_state
        .rows
        .iter()
        .map(|row| row.cells.len())
        .max()
        .unwrap_or(0);
    table_state.alignments.len().max(header_cols).max(row_cols)
}

fn normalize_table_row(row: &mut Vec<TableCell>, column_count: usize) {
    row.resize_with(column_count, TableCell::default);
    row.truncate(column_count);
}

fn table_column_widths(
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

fn table_rendered_width(widths: &[usize]) -> usize {
    if widths.is_empty() {
        return 0;
    }
    widths.iter().sum::<usize>()
        + (widths.len().saturating_sub(1) * TABLE_COLUMN_GAP)
        + (widths.len() * TABLE_CELL_PADDING * 2)
}

fn constrained_table_column_widths(
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

fn collect_table_column_metrics(
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

fn preferred_column_floor(metrics: &TableColumnMetrics, min_column_width: usize) -> usize {
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

fn next_column_to_shrink(
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

fn column_shrink_priority(kind: TableColumnKind) -> usize {
    match kind {
        TableColumnKind::TokenHeavy => 0,
        TableColumnKind::Narrative => 1,
        TableColumnKind::Compact => 2,
    }
}

fn longest_token_width(text: &str) -> usize {
    text.split_whitespace()
        .map(unicode_width::UnicodeWidthStr::width)
        .max()
        .unwrap_or(0)
}

fn table_should_render_records(
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

fn expansive_cells_are_starved(
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

fn is_table_spillover_row(row: &TableBodyRow, next_row: Option<&TableBodyRow>) -> bool {
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

fn first_non_empty_only_cell_text(row: &[TableCell]) -> Option<String> {
    let first = row.first()?.text();
    if first.trim().is_empty() {
        return None;
    }
    row[1..]
        .iter()
        .all(|cell| cell.text().trim().is_empty())
        .then_some(first)
}

fn looks_like_html_content(text: &str) -> bool {
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

fn looks_like_html_label_line(text: &str) -> bool {
    let trimmed = text.trim();
    if !trimmed.ends_with(':') {
        return false;
    }
    trimmed
        .trim_end_matches(':')
        .split_whitespace()
        .any(|word| word.eq_ignore_ascii_case("html"))
}

fn table_cell_to_hyperlink_line(cell: TableCell) -> HyperlinkLine {
    HyperlinkLine {
        line: Line::from(cell.spans),
        hyperlinks: cell.hyperlinks,
        preformatted: false,
    }
}

fn table_cell_width(cell: &TableCell) -> usize {
    unicode_width::UnicodeWidthStr::width(cell.text().as_str())
}

fn render_table_row(
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

fn push_table_padding(spans: &mut Vec<Span<'static>>, width: usize) {
    if width > 0 {
        spans.push(Span::raw(" ".repeat(width)));
    }
}

fn wrap_table_cell(cell: &TableCell, width: usize, base_style: Style) -> Vec<HyperlinkLine> {
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

fn render_table_records(
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

fn widest_hyperlink_line_width(lines: &[HyperlinkLine]) -> usize {
    lines.iter().map(HyperlinkLine::width).max().unwrap_or(0)
}

fn render_table_pipe_fallback(
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

fn row_to_pipe_line(row: &[TableCell], body_style: Style) -> HyperlinkLine {
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

fn append_table_cell_to_pipe_line(
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

fn push_pipe_line_segment(spans: &mut Vec<Span<'static>>, segment: &mut String, style: Style) {
    if !segment.is_empty() {
        spans.push(Span::styled(std::mem::take(segment), style));
    }
}

fn push_pipe_line_text(
    spans: &mut Vec<Span<'static>>,
    column: &mut usize,
    text: &str,
    style: Style,
) {
    spans.push(Span::styled(text.to_string(), style));
    *column = column.saturating_add(unicode_width::UnicodeWidthStr::width(text));
}

fn alignments_to_pipe_delimiter(alignments: &[Alignment]) -> String {
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

fn prefix_hyperlink_line(
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
fn aligned_table_cell_spans(
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

fn render_table_separator(widths: &[usize], separator_char: char, style: Style) -> HyperlinkLine {
    let segment = separator_char.to_string();
    let gap = " ".repeat(TABLE_COLUMN_GAP);
    let text = widths
        .iter()
        .map(|width| segment.repeat(width + (TABLE_CELL_PADDING * 2)))
        .collect::<Vec<_>>()
        .join(&gap);
    HyperlinkLine::new(Line::from(Span::styled(text, style)))
}

fn is_local_path_like_link(destination: &str) -> bool {
    destination.starts_with("file://")
        || destination.starts_with('/')
        || destination.starts_with("~/")
        || destination.starts_with("./")
        || destination.starts_with("../")
        || destination.starts_with("\\\\")
        || matches!(
            destination.as_bytes(),
            [drive, b':', separator, ..]
                if drive.is_ascii_alphabetic() && matches!(separator, b'/' | b'\\')
        )
}

fn render_local_link_target(destination: &str, cwd: Option<&Path>) -> Option<String> {
    let (path_text, suffix) = parse_local_link_target(destination)?;
    let mut rendered = display_local_link_path(&path_text, cwd);
    if let Some(suffix) = suffix {
        rendered.push_str(&suffix);
    }
    Some(rendered)
}

fn parse_local_link_target(destination: &str) -> Option<(String, Option<String>)> {
    if destination.starts_with("file://") {
        let url = Url::parse(destination).ok()?;
        let path_text = file_url_to_local_path_text(&url)?;
        let suffix = url
            .fragment()
            .and_then(normalize_hash_location_suffix_fragment);
        return Some((path_text, suffix));
    }

    let mut path_text = destination;
    let mut suffix = None;
    if let Some((candidate_path, fragment)) = destination.rsplit_once('#')
        && let Some(normalized) = normalize_hash_location_suffix_fragment(fragment)
    {
        path_text = candidate_path;
        suffix = Some(normalized);
    }
    if suffix.is_none()
        && let Some(colon_suffix) = extract_colon_location_suffix(path_text)
    {
        path_text = &path_text[..path_text.len().saturating_sub(colon_suffix.len())];
        suffix = Some(colon_suffix.to_string());
    }

    Some((
        expand_local_link_path(&percent_decode_lossy(path_text)),
        suffix,
    ))
}

fn normalize_hash_location_suffix_fragment(fragment: &str) -> Option<String> {
    if fragment.is_empty() {
        return None;
    }
    let (start, end) = fragment
        .split_once(['-', '–'])
        .map_or((fragment, None), |(a, b)| (a, Some(b)));
    let start = parse_hash_location_part(start)?;
    if let Some(end) = end {
        let end = parse_hash_location_part(end)?;
        Some(format!("{start}-{}", end.trim_start_matches(':')))
    } else {
        Some(start)
    }
}

fn parse_hash_location_part(part: &str) -> Option<String> {
    let rest = part.strip_prefix('L')?;
    let (line, column) = rest
        .split_once('C')
        .map_or((rest, None), |(line, column)| (line, Some(column)));
    if line.is_empty() || !line.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    if let Some(column) = column {
        if column.is_empty() || !column.chars().all(|ch| ch.is_ascii_digit()) {
            return None;
        }
        Some(format!(":{line}:{column}"))
    } else {
        Some(format!(":{line}"))
    }
}

fn extract_colon_location_suffix(path_text: &str) -> Option<&str> {
    path_text
        .char_indices()
        .rev()
        .filter(|(_, ch)| *ch == ':')
        .map(|(idx, _)| &path_text[idx..])
        .find(|suffix| is_colon_location_suffix(suffix))
}

fn is_colon_location_suffix(suffix: &str) -> bool {
    let Some(rest) = suffix.strip_prefix(':') else {
        return false;
    };
    let (start, end) = rest
        .split_once(['-', '–'])
        .map_or((rest, None), |(a, b)| (a, Some(b)));
    parse_line_col_suffix_part(start) && end.map(parse_line_col_suffix_part).unwrap_or(true)
}

fn parse_line_col_suffix_part(part: &str) -> bool {
    let mut pieces = part.split(':');
    let Some(line) = pieces.next() else {
        return false;
    };
    if line.is_empty() || !line.chars().all(|ch| ch.is_ascii_digit()) {
        return false;
    }
    if let Some(column) = pieces.next()
        && (column.is_empty() || !column.chars().all(|ch| ch.is_ascii_digit()))
    {
        return false;
    }
    pieces.next().is_none()
}

fn expand_local_link_path(path_text: &str) -> String {
    if let Some(rest) = path_text.strip_prefix("~/")
        && let Some(home) = std::env::var_os("HOME")
    {
        let expanded = Path::new(&home).join(rest);
        return normalize_local_link_path_text(&expanded.to_string_lossy());
    }
    normalize_local_link_path_text(path_text)
}

fn file_url_to_local_path_text(url: &Url) -> Option<String> {
    // `url::Url::to_file_path` can panic on Windows for an authority-only
    // file URL (`file://server`). Build the UNC form directly first.
    if let Some(host) = url.host_str()
        && !host.is_empty()
        && host != "localhost"
    {
        let path = if url.path().is_empty() {
            "/"
        } else {
            url.path()
        };
        return Some(normalize_local_link_path_text(&format!("//{host}{path}")));
    }
    if let Ok(path) = url.to_file_path() {
        return Some(normalize_local_link_path_text(&path.to_string_lossy()));
    }

    let mut path_text = url.path().to_string();
    if matches!(
        path_text.as_bytes(),
        [b'/', drive, b':', b'/', ..] if drive.is_ascii_alphabetic()
    ) {
        path_text.remove(0);
    }

    Some(normalize_local_link_path_text(&path_text))
}

fn normalize_local_link_path_text(path_text: &str) -> String {
    if let Some(rest) = path_text.strip_prefix("\\\\") {
        format!("//{}", rest.replace('\\', "/").trim_start_matches('/'))
    } else {
        path_text.replace('\\', "/")
    }
}

fn is_absolute_local_link_path(path_text: &str) -> bool {
    path_text.starts_with('/')
        || path_text.starts_with("//")
        || matches!(
            path_text.as_bytes(),
            [drive, b':', b'/', ..] if drive.is_ascii_alphabetic()
        )
}

fn display_local_link_path(path_text: &str, cwd: Option<&Path>) -> String {
    let path_text = normalize_local_link_path_text(path_text);
    if !is_absolute_local_link_path(&path_text) {
        return path_text;
    }

    if let Some(cwd) = cwd {
        let cwd_text = normalize_local_link_path_text(&cwd.to_string_lossy());
        if let Some(stripped) = strip_local_path_prefix(&path_text, &cwd_text) {
            return stripped.to_string();
        }
    }

    path_text
}

fn strip_local_path_prefix<'a>(path_text: &'a str, cwd_text: &str) -> Option<&'a str> {
    let path_text = trim_trailing_local_path_separator(path_text);
    let cwd_text = trim_trailing_local_path_separator(cwd_text);
    if path_text == cwd_text {
        return None;
    }
    if cwd_text == "/" || cwd_text == "//" {
        return path_text.strip_prefix('/');
    }
    path_text
        .strip_prefix(cwd_text)
        .and_then(|rest| rest.strip_prefix('/'))
}

fn trim_trailing_local_path_separator(path_text: &str) -> &str {
    if path_text == "/" || path_text == "//" {
        return path_text;
    }
    if matches!(path_text.as_bytes(), [drive, b':', b'/'] if drive.is_ascii_alphabetic()) {
        return path_text;
    }
    path_text.trim_end_matches('/')
}

fn percent_decode_lossy(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut idx = 0usize;
    while idx < bytes.len() {
        if bytes[idx] == b'%'
            && idx + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex_value(bytes[idx + 1]), hex_value(bytes[idx + 2]))
        {
            decoded.push((hi << 4) | lo);
            idx += 3;
            continue;
        }
        decoded.push(bytes[idx]);
        idx += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
#[rustfmt::skip]
#[path = "markdown/tests.rs"]
mod tests;

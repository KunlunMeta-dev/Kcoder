//! Markdown renderer state, styled spans, and table/list/link state.

use super::*;

#[derive(Debug, Clone, Default)]
pub struct SpanAccumulator {
    pub spans: Vec<Span<'static>>,
    pub hyperlinks: Vec<TerminalHyperlink>,
}

impl SpanAccumulator {
    pub fn width(&self) -> usize {
        self.spans
            .iter()
            .map(|span| unicode_width::UnicodeWidthStr::width(span.content.as_ref()))
            .sum()
    }

    pub fn push(
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

    pub fn is_empty(&self) -> bool {
        self.spans.is_empty()
            || self
                .spans
                .iter()
                .all(|s| s.content.is_empty() && s.style == Style::default())
    }

    pub fn take_line(&mut self) -> HyperlinkLine {
        HyperlinkLine {
            line: Line::from(std::mem::take(&mut self.spans)),
            hyperlinks: std::mem::take(&mut self.hyperlinks),
            preformatted: false,
        }
    }
}

pub struct MarkdownRenderer<'a> {
    pub source: &'a str,
    pub lines: Vec<HyperlinkLine>,
    pub emitted_line_count: usize,
    pub current: SpanAccumulator,
    pub styles: UiTextStyles,
    pub style_stack: Vec<Style>,
    pub list_stack: Vec<ListState>,
    pub list_item_start_line_counts: Vec<usize>,
    pub list_needs_blank_before_next_item: Vec<bool>,
    pub context_stack: Vec<MarkdownContext>,
    pub blockquote_depth: usize,
    pub code_block: Option<CodeBlockState>,
    pub table: Option<TableState>,
    pub link: Option<LinkState>,
    pub code_theme: String,
    pub cwd: Option<PathBuf>,
    pub width: Option<usize>,
    pub pending_line_break: bool,
    pub line_ends_with_local_link_target: bool,
    pub pending_local_link_soft_break: bool,
    pub current_line_has_list_marker: bool,
    pub current_line_marker_width: Option<usize>,
    pub current_line_prefix_suppressed: bool,
    pub last_code_block_item_depth: Option<usize>,
    pub hide_web_link_destinations: bool,
}

#[derive(Debug, Clone)]
pub struct ListState {
    pub kind: ListKind,
    pub index: u64,
}

#[derive(Debug, Clone, Copy)]
pub enum ListKind {
    Bullet,
    Ordered,
}

#[derive(Debug, Clone, Copy)]
pub enum MarkdownContext {
    BlockQuote,
    List(ListKind),
}

#[derive(Debug, Clone)]
pub struct CodeBlockState {
    pub lang: String,
    pub content: String,
    pub indent: String,
}

#[derive(Debug, Clone)]
pub struct LinkState {
    pub destination: String,
    pub show_destination: bool,
    pub is_web: bool,
    pub has_visible_label: bool,
    pub local_target_display: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct TableCell {
    pub spans: Vec<Span<'static>>,
    pub hyperlinks: Vec<TerminalHyperlink>,
}

impl TableCell {
    pub fn width(&self) -> usize {
        self.spans
            .iter()
            .map(|span| unicode_width::UnicodeWidthStr::width(span.content.as_ref()))
            .sum()
    }

    pub fn push(
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

    pub fn text(&self) -> String {
        self.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    }
}

#[derive(Debug, Clone)]
pub struct TableState {
    pub alignments: Vec<Alignment>,
    pub header: Option<Vec<TableCell>>,
    pub rows: Vec<TableBodyRow>,
    pub current_row: Option<Vec<TableCell>>,
    pub current_cell: Option<TableCell>,
    pub in_header: bool,
    pub current_row_has_table_pipe_syntax: bool,
}

#[derive(Debug, Clone)]
pub struct TableBodyRow {
    pub cells: Vec<TableCell>,
    pub has_table_pipe_syntax: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TableColumnKind {
    Narrative,
    TokenHeavy,
    Compact,
}

#[derive(Clone, Debug)]
pub struct TableColumnMetrics {
    pub max_width: usize,
    pub header_token_width: usize,
    pub body_token_width: usize,
    pub kind: TableColumnKind,
}

impl TableState {
    pub fn new(alignments: Vec<Alignment>) -> Self {
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

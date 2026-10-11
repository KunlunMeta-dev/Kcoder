//! Markdown renderer state, styled spans, and table/list/link state.

use super::*;

#[derive(Debug, Clone, Default)]
pub(super) struct SpanAccumulator {
    pub(super) spans: Vec<Span<'static>>,
    pub(super) hyperlinks: Vec<TerminalHyperlink>,
}

impl SpanAccumulator {
    pub(super) fn width(&self) -> usize {
        self.spans
            .iter()
            .map(|span| unicode_width::UnicodeWidthStr::width(span.content.as_ref()))
            .sum()
    }

    pub(super) fn push(
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

    pub(super) fn is_empty(&self) -> bool {
        self.spans.is_empty()
            || self
                .spans
                .iter()
                .all(|s| s.content.is_empty() && s.style == Style::default())
    }

    pub(super) fn take_line(&mut self) -> HyperlinkLine {
        HyperlinkLine {
            line: Line::from(std::mem::take(&mut self.spans)),
            hyperlinks: std::mem::take(&mut self.hyperlinks),
            preformatted: false,
        }
    }
}

pub(super) struct MarkdownRenderer<'a> {
    pub(super) source: &'a str,
    pub(super) lines: Vec<HyperlinkLine>,
    pub(super) emitted_line_count: usize,
    pub(super) current: SpanAccumulator,
    pub(super) styles: UiTextStyles,
    pub(super) style_stack: Vec<Style>,
    pub(super) list_stack: Vec<ListState>,
    pub(super) list_item_start_line_counts: Vec<usize>,
    pub(super) list_needs_blank_before_next_item: Vec<bool>,
    pub(super) context_stack: Vec<MarkdownContext>,
    pub(super) blockquote_depth: usize,
    pub(super) code_block: Option<CodeBlockState>,
    pub(super) table: Option<TableState>,
    pub(super) link: Option<LinkState>,
    pub(super) code_theme: String,
    pub(super) cwd: Option<PathBuf>,
    pub(super) width: Option<usize>,
    pub(super) pending_line_break: bool,
    pub(super) line_ends_with_local_link_target: bool,
    pub(super) pending_local_link_soft_break: bool,
    pub(super) current_line_has_list_marker: bool,
    pub(super) current_line_marker_width: Option<usize>,
    pub(super) current_line_prefix_suppressed: bool,
    pub(super) last_code_block_item_depth: Option<usize>,
    pub(super) hide_web_link_destinations: bool,
}

#[derive(Debug, Clone)]
pub(super) struct ListState {
    pub(super) kind: ListKind,
    pub(super) index: u64,
}

#[derive(Debug, Clone, Copy)]
pub(super) enum ListKind {
    Bullet,
    Ordered,
}

#[derive(Debug, Clone, Copy)]
pub(super) enum MarkdownContext {
    BlockQuote,
    List(ListKind),
}

#[derive(Debug, Clone)]
pub(super) struct CodeBlockState {
    pub(super) lang: String,
    pub(super) content: String,
    pub(super) indent: String,
}

#[derive(Debug, Clone)]
pub(super) struct LinkState {
    pub(super) destination: String,
    pub(super) show_destination: bool,
    pub(super) is_web: bool,
    pub(super) has_visible_label: bool,
    pub(super) local_target_display: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub(super) struct TableCell {
    pub(super) spans: Vec<Span<'static>>,
    pub(super) hyperlinks: Vec<TerminalHyperlink>,
}

impl TableCell {
    pub(super) fn width(&self) -> usize {
        self.spans
            .iter()
            .map(|span| unicode_width::UnicodeWidthStr::width(span.content.as_ref()))
            .sum()
    }

    pub(super) fn push(
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

    pub(super) fn text(&self) -> String {
        self.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    }
}

#[derive(Debug, Clone)]
pub(super) struct TableState {
    pub(super) alignments: Vec<Alignment>,
    pub(super) header: Option<Vec<TableCell>>,
    pub(super) rows: Vec<TableBodyRow>,
    pub(super) current_row: Option<Vec<TableCell>>,
    pub(super) current_cell: Option<TableCell>,
    pub(super) in_header: bool,
    pub(super) current_row_has_table_pipe_syntax: bool,
}

#[derive(Debug, Clone)]
pub(super) struct TableBodyRow {
    pub(super) cells: Vec<TableCell>,
    pub(super) has_table_pipe_syntax: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TableColumnKind {
    Narrative,
    TokenHeavy,
    Compact,
}

#[derive(Clone, Debug)]
pub(super) struct TableColumnMetrics {
    pub(super) max_width: usize,
    pub(super) header_token_width: usize,
    pub(super) body_token_width: usize,
    pub(super) kind: TableColumnKind,
}

impl TableState {
    pub(super) fn new(alignments: Vec<Alignment>) -> Self {
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

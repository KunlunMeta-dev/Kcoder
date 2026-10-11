//! Event-driven Markdown block and inline rendering.

use super::*;

impl<'a> MarkdownRenderer<'a> {
    pub(super) fn new(
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

    pub(super) fn current_style(&self) -> Style {
        *self.style_stack.last().unwrap()
    }

    pub(super) fn push_style(&mut self, modifier: Modifier) {
        let style = self.current_style().add_modifier(modifier);
        self.style_stack.push(style);
    }

    pub(super) fn pop_style(&mut self) {
        if self.style_stack.len() > 1 {
            self.style_stack.pop();
        }
    }

    pub(super) fn handle(&mut self, event: Event<'_>, range: Range<usize>) {
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

    pub(super) fn prepare_for_event(&mut self, event: &Event<'_>) {
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

    pub(super) fn start_tag(&mut self, tag: Tag<'_>, range: Range<usize>) {
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

    pub(super) fn end_tag(&mut self, tag: TagEnd) {
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

    pub(super) fn push_text(&mut self, text: &str) {
        if let Some(block) = self.code_block.as_mut() {
            block.content.push_str(text);
            return;
        }
        self.line_ends_with_local_link_target = false;
        self.push_styled_text(text.to_string(), self.current_style());
    }

    pub(super) fn push_html(&mut self, html: &str) {
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

    pub(super) fn push_styled_text(&mut self, text: String, style: Style) {
        if self.suppressing_local_link_label() {
            return;
        }
        let style = self.style_link_label(&text, style);
        let destination = self.link_web_destination();
        let annotate_bare_urls = self.link.is_none();
        self.append_styled_text_with_links(text, style, destination.as_deref(), annotate_bare_urls);
    }

    pub(super) fn push_code_text(&mut self, text: String) {
        if self.suppressing_local_link_label() {
            return;
        }
        self.line_ends_with_local_link_target = false;
        let style = self.style_link_label(&text, self.styles.inline_code);
        let destination = self.link_web_destination();
        self.append_styled_text_with_links(text, style, destination.as_deref(), false);
    }

    pub(super) fn append_styled_text(&mut self, text: String, style: Style) {
        self.append_styled_text_with_links(text, style, None, false);
    }

    pub(super) fn append_styled_text_with_links(
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

    pub(super) fn link_web_destination(&self) -> Option<String> {
        self.link
            .as_ref()
            .and_then(|link| web_destination(&link.destination))
    }

    pub(super) fn start_link(&mut self, destination: String) {
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

    pub(super) fn style_link_label(&mut self, text: &str, style: Style) -> Style {
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

    pub(super) fn end_link(&mut self) {
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

    pub(super) fn suppressing_local_link_label(&self) -> bool {
        self.link
            .as_ref()
            .and_then(|link| link.local_target_display.as_ref())
            .is_some()
    }

    pub(super) fn in_table_cell(&self) -> bool {
        self.table
            .as_ref()
            .and_then(|table_state| table_state.current_cell.as_ref())
            .is_some()
    }

    pub(super) fn render_code_block(&mut self, lang: &str, content: &str, indent: &str) {
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

    pub(super) fn start_table(&mut self, alignments: Vec<Alignment>) {
        if !self.current.is_empty() {
            self.flush_line();
        }
        self.table = Some(TableState::new(alignments));
    }

    pub(super) fn start_table_head(&mut self) {
        if let Some(table_state) = self.table.as_mut() {
            table_state.in_header = true;
            table_state.current_row = Some(Vec::new());
        }
    }

    pub(super) fn end_table_head(&mut self) {
        if let Some(table_state) = self.table.as_mut() {
            if let Some(row) = table_state.current_row.take() {
                table_state.header = Some(row);
            }
            table_state.in_header = false;
        }
    }

    pub(super) fn start_table_row(&mut self, source_range: Range<usize>) {
        let has_table_pipe_syntax = self.has_table_row_boundary_pipe(source_range);
        if let Some(table_state) = self.table.as_mut() {
            if table_state.in_header && table_state.current_row.is_some() {
                return;
            }
            table_state.current_row = Some(Vec::new());
            table_state.current_row_has_table_pipe_syntax = has_table_pipe_syntax;
        }
    }

    pub(super) fn has_table_row_boundary_pipe(&self, source_range: Range<usize>) -> bool {
        let Some(source) = self.source.get(source_range) else {
            return false;
        };
        let source = source.trim();
        source.starts_with('|') || source.ends_with('|')
    }

    pub(super) fn end_table_row(&mut self) {
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

    pub(super) fn start_table_cell(&mut self) {
        if let Some(table_state) = self.table.as_mut() {
            table_state.current_cell = Some(TableCell::default());
        }
    }

    pub(super) fn end_table_cell(&mut self) {
        if let Some(table_state) = self.table.as_mut()
            && let Some(cell) = table_state.current_cell.take()
            && let Some(row) = table_state.current_row.as_mut()
        {
            row.push(cell);
        }
    }

    pub(super) fn end_table(&mut self) {
        let Some(table_state) = self.table.take() else {
            return;
        };
        self.render_table(table_state);
    }

    pub(super) fn render_table(&mut self, table_state: TableState) {
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

    pub(super) fn preformatted_context_prefix(&self) -> String {
        self.line_context_prefix(true)
    }

    pub(super) fn table_content_width(&self) -> Option<usize> {
        let prefix = self.preformatted_context_prefix();
        let prefix_width = unicode_width::UnicodeWidthStr::width(prefix.as_str());
        self.width
            .map(|width| width.saturating_sub(prefix_width).max(1))
    }

    pub(super) fn push_table_lines(&mut self, lines: Vec<HyperlinkLine>) {
        for line in lines {
            self.push_table_line(line);
        }
    }

    pub(super) fn push_table_line(&mut self, line: HyperlinkLine) {
        self.push_preformatted_line(line);
    }

    pub(super) fn push_preformatted_line(&mut self, mut line: HyperlinkLine) {
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

    pub(super) fn flush_line(&mut self) {
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

    pub(super) fn pop_context(&mut self, matches_context: impl Fn(MarkdownContext) -> bool) {
        if let Some(index) = self
            .context_stack
            .iter()
            .rposition(|context| matches_context(*context))
        {
            self.context_stack.remove(index);
        }
    }

    pub(super) fn context_prefix_style(&self) -> Style {
        if self.blockquote_depth > 0 {
            self.styles.blockquote_prefix
        } else {
            self.styles.muted
        }
    }

    /// Blockquotes use a full-row semantic color; explicit accents for code, links, headings, and table headers still override it.
    pub(super) fn apply_blockquote_style(&self, line: &mut HyperlinkLine) {
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

    pub(super) fn line_context_prefix(&self, include_list_prefix: bool) -> String {
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

    pub(super) fn emit_line(&mut self, line: HyperlinkLine) {
        self.emitted_line_count += 1;
        self.lines.push(line);
    }

    pub(super) fn finish(mut self) -> Vec<HyperlinkLine> {
        if !self.current.is_empty() {
            self.flush_line();
        }
        self.lines
    }
}

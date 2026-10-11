//! Budgeted streaming navigation and heading extraction.

use super::*;

pub(crate) fn navigation_headings(
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

pub(super) fn navigation_parser_options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS
}

pub(crate) fn stream_navigation_markdown(
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

pub(super) fn drain_navigation_markdown(
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

use crate::markdown::{
    render_agent_markdown_hyperlink_lines_with_theme,
    render_agent_markdown_hyperlink_lines_with_theme_and_width,
    render_markdown_hyperlink_lines_with_theme,
    render_markdown_hyperlink_lines_with_theme_and_width, render_markdown_with_theme,
};
use crate::render;
use crate::render::highlight::highlight_code_to_styled_spans_with_theme;
use crate::render_cache::ToolRailPos;
use crate::subagent_panel::{self, render_panel_message};
use crate::terminal_hyperlinks::{self, HyperlinkLine, annotate_web_urls, prefix_hyperlink_line};
use crate::theme::{self, KCODER_UI_THEME, UiToolStyles};
use crate::tool_format::preview_tool_text;
use crate::tool_transcript::*;
use crate::widgets;
use crate::write_preview::parse_write_preview_message;
use kcoder_state::Goal;
use kcoder_types::{DisplayMessage, Message, MessageRole};
use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
};
use std::path::Path;
use std::time::Duration;
use unicode_segmentation::UnicodeSegmentation;

pub(super) const THINKING_MESSAGE_PREFIX: &str = "[Thinking] ";
pub(super) const LIVE_THINKING_MESSAGE_PREFIX: &str = "[Thinking live] ";
const THINKING_PREVIEW_LINES: usize = 2;
pub(super) const LIVE_THINKING_PREVIEW_ROWS: usize = 2;
pub(super) const TURN_DIVIDER_PREFIX: &str = "[Turn divider] ";

pub(super) fn render_turn_divider_message(
    msg: &DisplayMessage,
    width: u16,
) -> Option<Vec<Line<'static>>> {
    if msg.role != MessageRole::System {
        return None;
    }
    let label = msg.text.strip_prefix(TURN_DIVIDER_PREFIX)?;
    Some(vec![render_turn_divider(label, width)])
}

pub(super) fn render_turn_divider(label: &str, width: u16) -> Line<'static> {
    let width = width as usize;
    let text_styles = KCODER_UI_THEME.text_styles();
    if width == 0 {
        return Line::from("");
    }

    let label = turn_divider_visible_label(label);
    if label.is_empty() {
        return Line::from(Span::styled("─".repeat(width), text_styles.dim));
    }

    let text = format!("─ {label} ─");
    let text_width = unicode_width::UnicodeWidthStr::width(text.as_str());
    let fill = width.saturating_sub(text_width);
    let rendered = format!("{text}{}", "─".repeat(fill));
    Line::from(Span::styled(rendered, text_styles.dim))
}

fn turn_divider_visible_label(label: &str) -> &str {
    let label = label.trim();
    let Some(duration) = label.strip_prefix("Worked for ") else {
        return label;
    };

    match parse_worked_duration_label(duration) {
        Some(seconds) if seconds <= 60 => "",
        _ => label,
    }
}

fn parse_worked_duration_label(duration: &str) -> Option<u64> {
    let parts = duration.split_whitespace().collect::<Vec<_>>();
    match parts.as_slice() {
        [seconds] => parse_suffix_number(seconds, 's'),
        [minutes, seconds] => Some(
            parse_suffix_number(minutes, 'm')?
                .saturating_mul(60)
                .saturating_add(parse_suffix_number(seconds, 's')?),
        ),
        [hours, minutes, seconds] => Some(
            parse_suffix_number(hours, 'h')?
                .saturating_mul(3600)
                .saturating_add(parse_suffix_number(minutes, 'm')?.saturating_mul(60))
                .saturating_add(parse_suffix_number(seconds, 's')?),
        ),
        _ => None,
    }
}

fn parse_suffix_number(text: &str, suffix: char) -> Option<u64> {
    text.strip_suffix(suffix)?.parse().ok()
}

pub(super) fn format_worked_duration(elapsed: Duration) -> String {
    let total_secs = elapsed.as_secs();
    if total_secs < 60 {
        format!("{}s", total_secs)
    } else if total_secs < 3600 {
        format!("{}m {:02}s", total_secs / 60, total_secs % 60)
    } else {
        format!(
            "{}h {:02}m {:02}s",
            total_secs / 3600,
            (total_secs / 60) % 60,
            total_secs % 60
        )
    }
}

pub(super) fn format_progress_count(value: usize) -> String {
    if value < 1_000 {
        return value.to_string();
    }

    let scaled = value as f64 / 1_000.0;
    let decimals = if value < 10_000 { 1 } else { 0 };
    let mut formatted = format!("{scaled:.decimals$}");
    if formatted.ends_with(".0") {
        formatted.truncate(formatted.len().saturating_sub(2));
    }
    format!("{formatted}K")
}

pub(super) fn compact_goal_summary(goal: &Goal) -> String {
    let prefix = if goal.mode.is_arrangement() {
        "Arrangement: "
    } else if goal.mode.is_strict() {
        "Strict: "
    } else {
        ""
    };
    format!(
        "{prefix}{}",
        truncate_display_text(
            &goal
                .objective
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            120,
        )
    )
}

pub(super) fn message_is_hidden_internal_context(message: &Message) -> bool {
    matches!(message, Message::User { origin: kcoder_types::MessageOrigin::Runtime | kcoder_types::MessageOrigin::Compaction, content } if !content.iter().any(|block| matches!(block, kcoder_types::ContentBlock::ToolResult { .. })))
}

/// DisplayMessage contains visible text only; it has no provenance. Runtime
/// context must be filtered at the structured Message boundary above. Neither
/// human input nor assistant explanations can be hidden by their text spelling.
pub(super) fn display_text_is_hidden_internal_context(_text: &str, _is_user: bool) -> bool {
    false
}

pub(super) fn truncate_display_text(text: &str, max_width: usize) -> String {
    widgets::truncate_to_width(text, max_width)
}

#[cfg(test)]
pub(super) fn render_message(
    msg: &DisplayMessage,
    rail: Option<ToolRailPos>,
    is_last_tool: bool,
    expanded: bool,
    render_markdown: bool,
    code_theme: &str,
) -> Vec<Line<'static>> {
    render_message_with_width(
        msg,
        rail,
        is_last_tool,
        expanded,
        render_markdown,
        code_theme,
        None,
    )
}

fn line_is_visually_blank(line: &Line<'_>) -> bool {
    line.spans
        .iter()
        .all(|span| span.content.as_ref().is_empty())
}

pub(super) fn push_separator_after_message(lines: &mut Vec<Line<'static>>) {
    if !lines.last().is_some_and(line_is_visually_blank) {
        lines.push(Line::from(""));
    }
}

pub(super) fn push_hyperlink_separator_after_message(lines: &mut Vec<HyperlinkLine>) {
    if !lines
        .last()
        .is_some_and(|line| line_is_visually_blank(&line.line))
    {
        lines.push(HyperlinkLine::new(Line::from("")));
    }
}

fn render_thinking_message(text: &str, _expanded: bool, width: Option<u16>) -> Vec<Line<'static>> {
    let theme = &KCODER_UI_THEME;
    let text_styles = theme.text_styles();
    let content = text.trim_end_matches(['\r', '\n']);
    let content_width = width.map(|width| usize::from(width.saturating_sub(2).max(1)));
    let source_lines: Vec<&str> = if content.is_empty() {
        vec![""]
    } else {
        content.split('\n').collect()
    };

    let visible_source_count = source_lines.len().min(THINKING_PREVIEW_LINES);
    let mut hidden_chars = source_lines
        .iter()
        .skip(visible_source_count)
        .copied()
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .count();
    let thinking_style = text_styles.dim.add_modifier(Modifier::ITALIC);
    let mut lines = Vec::new();
    for (idx, line) in source_lines.iter().take(visible_source_count).enumerate() {
        let line = if let Some(content_width) = content_width {
            let (line, truncated_chars) = truncate_thinking_preview_line(line, content_width);
            hidden_chars = hidden_chars.saturating_add(truncated_chars);
            line
        } else {
            (*line).to_string()
        };
        let prefix = if idx == 0 {
            Span::styled("• ", text_styles.muted)
        } else {
            Span::raw("  ")
        };
        lines.push(Line::from(vec![prefix, Span::styled(line, thinking_style)]));
    }
    if hidden_chars > 0 {
        let mut hidden_marker = format!("... ({hidden_chars} more chars)");
        let mut hidden_marker_style = text_styles.muted;
        if let Some(content_width) = content_width {
            hidden_marker = truncate_display_text(&hidden_marker, content_width);
            let marker_width = render::wrapping::display_width(&hidden_marker);
            hidden_marker.push_str(&" ".repeat(content_width.saturating_sub(marker_width)));
            // Styled trailing blanks make the terminal diff overwrite the
            // longer live-preview row when reasoning becomes collapsed.
            hidden_marker_style = hidden_marker_style.add_modifier(Modifier::DIM);
        }
        lines.push(Line::from(vec![
            Span::raw("  "),
            Span::styled(hidden_marker, hidden_marker_style),
        ]));
    }

    lines
}

fn render_live_thinking_message(text: &str, width: Option<u16>) -> Vec<Line<'static>> {
    let width = usize::from(width.unwrap_or(80).max(1));
    let prefix_width = usize::from(width > 2) * 2;
    let content_width = width.saturating_sub(prefix_width).max(1);
    let mut rows = text
        .trim_end_matches(['\r', '\n'])
        .split('\n')
        .flat_map(|line| render::wrapping::adaptive_word_wrap_plain_line(line, content_width))
        .collect::<Vec<_>>();
    if rows.len() > LIVE_THINKING_PREVIEW_ROWS {
        rows.drain(..rows.len() - LIVE_THINKING_PREVIEW_ROWS);
    }
    rows.resize(LIVE_THINKING_PREVIEW_ROWS, String::new());

    let text_styles = KCODER_UI_THEME.text_styles();
    let thinking_style = text_styles.dim.add_modifier(Modifier::ITALIC);
    let mut lines = rows
        .into_iter()
        .enumerate()
        .map(|(index, row)| {
            if row.is_empty() {
                return Line::default();
            }
            let prefix = if prefix_width == 0 {
                Span::raw("")
            } else if index == 0 {
                Span::styled("• ", text_styles.muted)
            } else {
                Span::raw("  ")
            };
            Line::from(vec![prefix, Span::styled(row, thinking_style)])
        })
        .collect::<Vec<_>>();
    // Keep the live cell at a fixed height, including its message separator.
    // The generic transcript renderer sees the trailing blank and will not add
    // another separator.
    lines.push(Line::default());
    lines
}

fn truncate_thinking_preview_line(line: &str, content_width: usize) -> (String, usize) {
    let mut out = String::new();
    let mut used = 0usize;
    for (byte_idx, grapheme) in line.grapheme_indices(true) {
        let grapheme_width = render::wrapping::display_width(grapheme);
        if used.saturating_add(grapheme_width) > content_width {
            return (out, line[byte_idx..].chars().count());
        }
        out.push_str(grapheme);
        used = used.saturating_add(grapheme_width);
    }
    (out, 0)
}

pub(super) fn render_tool_summary_message(
    msg: &DisplayMessage,
    indicator: &str,
    code_theme: &str,
) -> Vec<Line<'static>> {
    let Some(summary) = msg.text.strip_prefix("[Tool summary] ") else {
        return Vec::new();
    };
    let theme = &KCODER_UI_THEME;
    let text_styles = theme.text_styles();
    let tool_styles = theme.tool_styles();
    let mut summary_lines = summary.lines();
    let counts = summary_lines.next().unwrap_or_default();
    let latest_lines = summary_lines
        .filter_map(|line| line.strip_prefix("[Tool latest] ").or(Some(line)))
        .filter(|line| !line.trim().is_empty())
        .take(2)
        .collect::<Vec<_>>();
    let mut header_spans = vec![Span::styled(
        format!("{indicator} tools "),
        tool_styles.summary_header,
    )];
    header_spans.extend(tool_summary_count_spans(counts, tool_styles));
    let mut lines = vec![Line::from(header_spans)];
    for latest in latest_lines {
        lines.push(render_tool_summary_latest_line(
            latest,
            tool_styles,
            code_theme,
        ));
    }
    lines.push(Line::from(vec![
        Span::styled("  (", tool_styles.summary_hint),
        Span::styled("alt + t", text_styles.link),
        Span::styled(" to expand tools)", tool_styles.summary_hint),
    ]));
    lines
}

fn tool_summary_count_spans(counts: &str, tool_styles: UiToolStyles) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    for (index, count) in counts.split(" · ").enumerate() {
        if index > 0 {
            spans.push(Span::styled(" · ", tool_styles.summary_count));
        }
        if let Some((name, multiplicity)) = count.rsplit_once(" x") {
            let family = tool_family_for_name(name);
            spans.push(Span::styled(
                name.to_string(),
                family_style(family).add_modifier(Modifier::BOLD),
            ));
            spans.push(Span::styled(
                format!(" x{multiplicity}"),
                tool_styles.summary_count,
            ));
        } else {
            spans.push(Span::styled(count.to_string(), tool_styles.summary_count));
        }
    }
    spans
}

fn render_tool_summary_latest_line(
    latest: &str,
    tool_styles: UiToolStyles,
    code_theme: &str,
) -> Line<'static> {
    let Some(detail) = latest.strip_prefix("latest: ") else {
        return Line::from(vec![
            Span::raw("  "),
            Span::styled(latest.to_string(), tool_styles.output_preview),
        ]);
    };
    let mut parts = detail.splitn(3, ' ');
    let Some(name) = parts.next().filter(|name| !name.is_empty()) else {
        return Line::from(vec![
            Span::raw("  "),
            Span::styled(latest.to_string(), tool_styles.output_preview),
        ]);
    };
    let Some(status) = parts.next().filter(|status| !status.is_empty()) else {
        return Line::from(vec![
            Span::raw("  "),
            Span::styled(latest.to_string(), tool_styles.output_preview),
        ]);
    };
    let remainder = parts.next().unwrap_or_default();
    let status_style = match status {
        "done" => tool_styles.success,
        "running" | "started" => tool_styles.running,
        "failed" | "error" => tool_styles.failure,
        _ => tool_styles.output_preview,
    };
    let mut spans = vec![
        Span::styled("  latest: ", tool_styles.output_preview),
        Span::styled(
            name.to_string(),
            family_style(tool_family_for_name(name)).add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!(" {status}"), status_style),
    ];
    if !remainder.is_empty() {
        if let Some(command) = remainder.strip_prefix("- ") {
            spans.push(Span::styled(" - ", tool_styles.output_preview));
            spans.extend(tool_preview_spans(
                name,
                command,
                tool_styles.output_preview,
                code_theme,
            ));
        } else {
            spans.push(Span::styled(" ", tool_styles.output_preview));
            spans.extend(tool_preview_spans(
                name,
                remainder,
                tool_styles.output_preview,
                code_theme,
            ));
        }
    }
    Line::from(spans)
}

pub(super) fn render_message_with_width(
    msg: &DisplayMessage,
    rail: Option<ToolRailPos>,
    is_last_tool: bool,
    expanded: bool,
    render_markdown: bool,
    code_theme: &str,
    width: Option<u16>,
) -> Vec<Line<'static>> {
    render_message_with_width_continuation(
        msg,
        MessageRenderOptions {
            rail,
            is_last_tool,
            expanded,
            render_markdown,
            code_theme,
            width,
            assistant_continuation: false,
        },
    )
}

#[derive(Clone, Copy)]
pub(super) struct MessageRenderOptions<'a> {
    pub(super) rail: Option<ToolRailPos>,
    pub(super) is_last_tool: bool,
    pub(super) expanded: bool,
    pub(super) render_markdown: bool,
    pub(super) code_theme: &'a str,
    pub(super) width: Option<u16>,
    pub(super) assistant_continuation: bool,
}

pub(super) fn render_message_with_width_continuation(
    msg: &DisplayMessage,
    options: MessageRenderOptions<'_>,
) -> Vec<Line<'static>> {
    let MessageRenderOptions {
        rail,
        is_last_tool,
        expanded,
        render_markdown,
        code_theme,
        width,
        assistant_continuation,
    } = options;
    let _ = rail;
    let _ = is_last_tool;
    let theme = &KCODER_UI_THEME;
    let text_styles = theme.text_styles();
    let tool_styles = theme.tool_styles();

    // Suppress verbose tool *output* messages from the transcript. Tool
    // invocation lines ("[Tool use:") and one-line status lines
    // ("✓ Tool succeeded:" / "✗ Tool failed:") are kept visible so the
    // user can follow what the model did and whether it succeeded.
    if message_is_hidden_tool_output(msg) {
        return Vec::new();
    }

    if msg.role == MessageRole::System {
        if let Some(lines) =
            render_panel_message(&msg.text, width.unwrap_or(80), Duration::ZERO, None)
        {
            return lines;
        }
        if msg.text.starts_with("[Tool summary] ") {
            return render_tool_summary_message(msg, "◇", code_theme);
        }
        if let Some(thinking) = msg.text.strip_prefix(LIVE_THINKING_MESSAGE_PREFIX) {
            return render_live_thinking_message(thinking, width);
        }
        if let Some(thinking) = msg.text.strip_prefix(THINKING_MESSAGE_PREFIX) {
            return render_thinking_message(thinking, expanded, width);
        }
    }

    // Detect tool-related system messages for distinct styling.
    let tool_status = if msg.role == MessageRole::System {
        if msg.text.starts_with("⟳ Running tool:") || msg.text.starts_with("[Tool use:") {
            Some(("running", tool_styles.running))
        } else if msg.text.starts_with("[Tool diff:") {
            Some(("diff", tool_styles.diff))
        } else if msg.text.starts_with("✓ Tool succeeded:") || msg.text.starts_with("[Tool result:")
        {
            Some(("success", tool_styles.success))
        } else if msg.text.starts_with("✗ Tool failed:") || msg.text.starts_with("[Tool error:") {
            Some(("error", tool_styles.failure))
        } else {
            None
        }
    } else {
        None
    };

    let gutter = Span::raw("  ");
    let mut lines = Vec::new();

    if let Some((status, status_color)) = tool_status {
        let is_running =
            msg.text.starts_with("⟳ Running tool:") || msg.text.starts_with("[Tool use:");
        let is_result = msg.text.starts_with("✓ Tool succeeded:")
            || msg.text.starts_with("✗ Tool failed:")
            || msg.text.starts_with("[Tool result:")
            || msg.text.starts_with("[Tool error:");
        let is_diff = msg.text.starts_with("[Tool diff:");
        // Collapse tool input/output previews aggressively. The transcript is
        // for following execution order; full tool payloads live in the model
        // context and persisted tool-result files.
        let body_text = msg.text.split_once('\n').map(|(_, body)| body);

        let tool_name = extract_tool_name(&msg.text).unwrap_or("");
        let collapse = is_result && body_text.is_some() && !expanded;
        let family = tool_family_for_name(tool_name);
        let family_text_style = family_style(family);
        let mut diff_lang = if is_diff {
            msg.text.lines().nth(1).and_then(diff_lang_from_summary)
        } else {
            None
        };
        let diff_context = theme::DiffStyleContext::current();
        let mut diff_continuation_styles: Option<DiffLineStyleSet> = None;

        // Write already renders a bounded source preview from its input. Its
        // generated diff repeats the entire new file and can otherwise add up
        // to 80 noisy rows after completion. Keep edit diffs unchanged.
        if is_diff && tool_name.eq_ignore_ascii_case("write") {
            if let Some((_, diagnostics)) = msg.text.split_once("[Tool diagnostics: lsp]") {
                lines.push(Line::from(vec![
                    gutter.clone(),
                    Span::styled(
                        "LSP diagnostics",
                        Style::default()
                            .fg(theme.accent_primary)
                            .add_modifier(Modifier::BOLD),
                    ),
                ]));
                lines.extend(diagnostics.trim().lines().map(|line| {
                    Line::from(vec![
                        gutter.clone(),
                        Span::styled(line.to_string(), text_styles.dim),
                    ])
                }));
            }
            return lines;
        }

        if let Some(preview) = parse_write_preview_message(&msg.text) {
            lines.push(Line::from(vec![
                gutter.clone(),
                tool_status_icon_span(status, status_color),
                Span::styled(
                    format!(" {} {}", family_glyph(family), family_label(family)),
                    tool_styles.title,
                ),
                Span::styled(" ", Style::default()),
                Span::styled(tool_name.to_string(), family_text_style),
            ]));

            if let Some(path) = preview.path.as_deref() {
                lines.push(Line::from(vec![
                    gutter.clone(),
                    Span::styled(path.to_string(), tool_styles.path),
                ]));
            }

            let language = preview
                .path
                .as_deref()
                .and_then(|path| Path::new(path).extension())
                .and_then(|extension| extension.to_str())
                .unwrap_or("text");
            let code = preview.lines.join("\n");
            let highlighted =
                highlight_code_to_styled_spans_with_theme(&code, language, code_theme);
            let line_number_width = preview.total_lines.max(1).to_string().len().max(4);
            for (index, source) in preview.lines.iter().enumerate() {
                let mut spans = vec![
                    gutter.clone(),
                    Span::styled(
                        format!(
                            "{:>width$}  ",
                            preview.first_line_number + index,
                            width = line_number_width
                        ),
                        tool_styles.line_number,
                    ),
                ];
                if let Some(styled_lines) = highlighted.as_ref()
                    && let Some(styled) = styled_lines.get(index)
                {
                    spans.extend(styled.iter().cloned());
                } else {
                    spans.push(Span::styled(source.clone(), tool_styles.output));
                }
                lines.push(Line::from(spans));
            }

            if preview.complete && preview.total_lines > preview.lines.len() {
                let remaining = preview.total_lines - preview.lines.len();
                lines.push(Line::from(vec![
                    gutter,
                    Span::styled(
                        format!(
                            "... ({remaining} more lines, {} total)",
                            preview.total_lines
                        ),
                        tool_styles.output_preview,
                    ),
                ]));
            }
            return lines;
        }

        if is_diff {
            for (idx, line) in reflow_tool_diff_visible_lines(&msg.text, width)
                .iter()
                .enumerate()
            {
                let line_index = idx + 1;
                let (styles, parts) = diff_line_style_for(line, line_index, theme, diff_context);
                if should_update_diff_lang_from_rendered_line(line, line_index, parts) {
                    update_diff_lang_from_rendered_line(line, &mut diff_lang);
                }
                let spans = if let Some(parts) = parts {
                    diff_continuation_styles = Some(styles);
                    styled_diff_line_spans(
                        line,
                        styles,
                        Some(parts),
                        diff_lang.as_deref(),
                        code_theme,
                    )
                } else if let Some(continuation_styles) = diff_continuation_styles {
                    match styled_diff_continuation_spans(
                        line,
                        continuation_styles,
                        diff_lang.as_deref(),
                        code_theme,
                    ) {
                        Some(spans) => spans,
                        None => {
                            diff_continuation_styles = None;
                            styled_diff_line_spans(
                                line,
                                styles,
                                None,
                                diff_lang.as_deref(),
                                code_theme,
                            )
                        }
                    }
                } else {
                    styled_diff_line_spans(line, styles, None, diff_lang.as_deref(), code_theme)
                };
                lines.push(diff_line_from_spans(spans, styles.line, width));
            }
            return lines;
        }

        for (i, line) in msg.text.lines().enumerate() {
            if i == 0 && is_diff {
                continue;
            }

            if i == 0 && (is_running || is_result) {
                lines.push(Line::from(vec![
                    gutter.clone(),
                    tool_status_icon_span(status, status_color),
                    Span::styled(
                        format!(" {} {}", family_glyph(family), family_label(family)),
                        tool_styles.title,
                    ),
                    Span::styled(" ", Style::default()),
                    Span::styled(tool_name.to_string(), family_text_style),
                ]));
                if !is_diff && let Some(preview) = extract_tool_inline_preview(&msg.text) {
                    let mut spans = vec![gutter.clone()];
                    spans.extend(tool_preview_spans(
                        tool_name,
                        &preview,
                        tool_styles.output,
                        code_theme,
                    ));
                    lines.push(Line::from(spans));
                }

                if collapse {
                    let body_preview = body_text.map(preview_tool_text).unwrap_or_default();
                    if body_preview.is_empty() {
                        break;
                    }
                    lines.push(Line::from(vec![
                        gutter.clone(),
                        Span::styled(body_preview, tool_styles.output_preview),
                    ]));
                    break;
                }
            } else if is_diff {
                let (styles, parts) = diff_line_style_for(line, i, theme, diff_context);
                if should_update_diff_lang_from_rendered_line(line, i, parts) {
                    update_diff_lang_from_rendered_line(line, &mut diff_lang);
                }
                let spans = if let Some(parts) = parts {
                    diff_continuation_styles = Some(styles);
                    styled_diff_line_spans(
                        line,
                        styles,
                        Some(parts),
                        diff_lang.as_deref(),
                        code_theme,
                    )
                } else if let Some(continuation_styles) = diff_continuation_styles {
                    match styled_diff_continuation_spans(
                        line,
                        continuation_styles,
                        diff_lang.as_deref(),
                        code_theme,
                    ) {
                        Some(spans) => spans,
                        None => {
                            diff_continuation_styles = None;
                            styled_diff_line_spans(
                                line,
                                styles,
                                None,
                                diff_lang.as_deref(),
                                code_theme,
                            )
                        }
                    }
                } else {
                    styled_diff_line_spans(line, styles, None, diff_lang.as_deref(), code_theme)
                };
                lines.push(diff_line_from_spans(spans, styles.line, width));
            } else if is_result && collapse {
                let preview = body_text.map(preview_tool_text).unwrap_or_default();
                if !preview.is_empty() {
                    lines.push(Line::from(vec![
                        gutter.clone(),
                        Span::styled(preview, tool_styles.output),
                    ]));
                }
                break;
            } else {
                let line = if is_running && i > 0 {
                    preview_tool_text(line)
                } else {
                    line.to_string()
                };
                lines.push(Line::from(vec![
                    gutter.clone(),
                    Span::styled(line, tool_styles.output),
                ]));
            }
        }
    } else {
        match msg.role {
            MessageRole::User => {
                let user_style = theme::user_surface_style();
                lines.push(Line::from("").style(user_style));
                let content_width = width.map(|width| usize::from(width.saturating_sub(2).max(1)));
                let message_text = msg.text.trim_end_matches(['\r', '\n']);
                let mut first_visual_line = true;
                if !message_text.is_empty() {
                    for raw_line in message_text.split('\n') {
                        let wrapped_lines = content_width.map_or_else(
                            || vec![raw_line.to_string()],
                            |content_width| {
                                render::wrapping::adaptive_word_wrap_plain_line(
                                    raw_line,
                                    content_width,
                                )
                            },
                        );
                        for line in wrapped_lines {
                            let prefix = if first_visual_line {
                                first_visual_line = false;
                                Span::styled("› ", text_styles.muted)
                            } else {
                                Span::raw("  ")
                            };
                            lines.push(
                                Line::from(vec![prefix, Span::styled(line, text_styles.body)])
                                    .style(user_style),
                            );
                        }
                    }
                }
                lines.push(Line::from("").style(user_style));
            }
            MessageRole::Assistant | MessageRole::System => {
                if msg.role == MessageRole::Assistant && width.is_some_and(|width| width <= 2) {
                    return vec![Line::from(vec![Span::styled(
                        if assistant_continuation { "  " } else { "• " },
                        text_styles.muted,
                    )])];
                }
                let rendered = if render_markdown {
                    let use_agent_markdown = msg.role == MessageRole::Assistant;
                    if let Some(width) = width {
                        terminal_hyperlinks::visible_lines(if use_agent_markdown {
                            render_agent_markdown_hyperlink_lines_with_theme_and_width(
                                &msg.text,
                                code_theme,
                                Some(usize::from(width.saturating_sub(2).max(1))),
                            )
                        } else {
                            render_markdown_hyperlink_lines_with_theme_and_width(
                                &msg.text,
                                code_theme,
                                Some(usize::from(width.saturating_sub(2).max(1))),
                            )
                        })
                    } else if use_agent_markdown {
                        terminal_hyperlinks::visible_lines(
                            render_agent_markdown_hyperlink_lines_with_theme(&msg.text, code_theme),
                        )
                    } else {
                        render_markdown_with_theme(&msg.text, code_theme)
                    }
                } else {
                    msg.text
                        .lines()
                        .map(|l| Line::from(Span::styled(l.to_string(), text_styles.soft)))
                        .collect()
                };
                for (idx, md_line) in rendered.into_iter().enumerate() {
                    let prefix =
                        message_body_prefix(msg.role, idx, assistant_continuation, &md_line);
                    let mut spans = vec![prefix];
                    spans.extend(md_line.spans);
                    lines.push(Line::from(spans).style(md_line.style));
                }
            }
        }
    }

    lines
}

pub(super) fn render_message_hyperlink(
    msg: &DisplayMessage,
    rail: Option<ToolRailPos>,
    is_last_tool: bool,
    expanded: bool,
    render_markdown: bool,
    code_theme: &str,
    width: Option<u16>,
) -> Vec<HyperlinkLine> {
    render_message_hyperlink_continuation(
        msg,
        MessageRenderOptions {
            rail,
            is_last_tool,
            expanded,
            render_markdown,
            code_theme,
            width,
            assistant_continuation: false,
        },
    )
}

pub(super) fn render_message_hyperlink_continuation(
    msg: &DisplayMessage,
    options: MessageRenderOptions<'_>,
) -> Vec<HyperlinkLine> {
    let MessageRenderOptions {
        rail: _,
        is_last_tool: _,
        expanded: _,
        render_markdown,
        code_theme,
        width,
        assistant_continuation,
    } = options;
    if render_markdown && message_uses_markdown_body(msg) {
        let theme = &KCODER_UI_THEME;
        let text_styles = theme.text_styles();
        if msg.role == MessageRole::Assistant && width.is_some_and(|width| width <= 2) {
            return vec![HyperlinkLine::new(Line::from(vec![Span::styled(
                if assistant_continuation { "  " } else { "• " },
                text_styles.muted,
            )]))];
        }
        let markdown_width = width.map(|width| usize::from(width.saturating_sub(2).max(1)));
        let rendered = if msg.role == MessageRole::Assistant {
            render_agent_markdown_hyperlink_lines_with_theme_and_width(
                &msg.text,
                code_theme,
                markdown_width,
            )
        } else if markdown_width.is_some() {
            render_markdown_hyperlink_lines_with_theme_and_width(
                &msg.text,
                code_theme,
                markdown_width,
            )
        } else {
            render_markdown_hyperlink_lines_with_theme(&msg.text, code_theme)
        };
        return rendered
            .into_iter()
            .enumerate()
            .map(|(idx, md_line)| {
                let prefix =
                    message_body_prefix(msg.role, idx, assistant_continuation, &md_line.line);
                prefix_hyperlink_line(md_line, prefix)
            })
            .collect();
    }

    annotate_web_urls(render_message_with_width_continuation(msg, options))
}

pub(super) fn message_is_hidden_tool_output(msg: &DisplayMessage) -> bool {
    msg.role == MessageRole::System
        && (msg.text.starts_with("[Tool result:") || msg.text.starts_with("[Tool error:"))
}

pub(super) fn message_uses_markdown_body(msg: &DisplayMessage) -> bool {
    if !matches!(msg.role, MessageRole::Assistant | MessageRole::System) {
        return false;
    }
    if msg.role == MessageRole::System
        && (msg.text.starts_with("[Tool result:")
            || msg.text.starts_with("[Tool error:")
            || msg.text.starts_with("[Tool summary] ")
            || msg.text.starts_with(subagent_panel::SUBAGENT_PANEL_PREFIX)
            || msg.text.starts_with(THINKING_MESSAGE_PREFIX)
            || msg.text.starts_with("⟳ Running tool:")
            || msg.text.starts_with("[Tool use:")
            || msg.text.starts_with("[Tool diff:")
            || msg.text.starts_with("✓ Tool succeeded:")
            || msg.text.starts_with("✗ Tool failed:"))
    {
        return false;
    }
    true
}

pub(super) fn message_body_prefix(
    role: MessageRole,
    line_index: usize,
    assistant_continuation: bool,
    line: &Line<'_>,
) -> Span<'static> {
    if line_index == 0
        && role == MessageRole::Assistant
        && !assistant_continuation
        && !assistant_markdown_line_starts_with_list_marker(line)
    {
        Span::styled("• ", KCODER_UI_THEME.text_styles().muted)
    } else {
        Span::raw("  ")
    }
}

fn assistant_markdown_line_starts_with_list_marker(line: &Line<'_>) -> bool {
    let mut text = String::new();
    for span in &line.spans {
        text.push_str(span.content.as_ref());
        if text.len() > 32 {
            break;
        }
    }

    let trimmed = text.trim_start();
    if trimmed.starts_with("- ") || trimmed.starts_with("* ") || trimmed.starts_with("+ ") {
        return true;
    }

    let Some(marker_end) = trimmed.find(['.', ')']) else {
        return false;
    };
    if marker_end == 0 || marker_end > 9 {
        return false;
    }
    if !trimmed[..marker_end].chars().all(|ch| ch.is_ascii_digit()) {
        return false;
    }
    trimmed[marker_end + 1..]
        .chars()
        .next()
        .is_some_and(char::is_whitespace)
}

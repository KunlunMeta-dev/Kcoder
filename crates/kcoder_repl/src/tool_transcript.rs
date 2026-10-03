use crate::motion::{MotionMode, ReducedMotionIndicator, activity_indicator};
use crate::render;
use crate::render::highlight::highlight_code_to_styled_spans_with_theme;
use crate::render_cache::ToolRailPos;
use crate::subagent_panel::SubagentDelivery;
use crate::theme;
use crate::theme::KCODER_UI_THEME;
use crate::tool_format::preview_tool_text;
use crate::widgets::truncate_to_width;
use kcoder_types::{DisplayMessage, MessageRole};
use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
};
use std::collections::HashMap;
use std::path::Path;
use unicode_segmentation::UnicodeSegmentation;

/// Semantic family for a tool, driving its glyph and verb label.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ToolFamily {
    Read,
    Patch,
    Run,
    Find,
    Mcp,
    Delegate,
    Generic,
}

pub(super) fn tool_family_for_name(name: &str) -> ToolFamily {
    let normalized = name.to_ascii_lowercase();
    if normalized.starts_with("mcp__") {
        return ToolFamily::Mcp;
    }
    match normalized.as_str() {
        "read"
        | "glob"
        | "ctx_inspect"
        | "local_memory_recall"
        | "remember"
        | "get_goal"
        | "filereadtool"
        | "globtool"
        | "ctxinspecttool"
        | "localmemoryrecalltool"
        | "memorytool" => ToolFamily::Read,
        "edit" | "write" | "notebook_edit" | "config" | "create_goal" | "update_goal"
        | "cron_create" | "cron_update" | "cron_delete" | "skill_manage" | "fileedittool"
        | "filewritetool" => ToolFamily::Patch,
        "bash" | "powershell" | "repl" | "web_browser" | "bashtool" | "powershelltool"
        | "repltool" | "webbrowsertool" => ToolFamily::Run,
        "grep" | "web_search" | "webfetch" | "web_fetch" | "discoverskills" | "ocr"
        | "greptool" | "websearchtool" | "webfetchtool" | "discoverskillstool" | "skill_hub"
        | "skill_guard" | "skill_curator" => ToolFamily::Find,
        "spawn_agent" | "explore_agent" | "planagent" | "agent" | "task_create" | "task_update"
        | "task_list" | "task_get" | "task_output" | "task_stop" | "sendmessage"
        | "send_message" | "agenttool" | "taskcreatetool" | "taskupdatetool" | "tasklisttool"
        | "taskgettool" => ToolFamily::Delegate,
        _ => ToolFamily::Generic,
    }
}

pub(super) fn is_subagent_tool_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "spawn_agent" | "explore_agent" | "planagent" | "agent"
    )
}

pub(super) fn is_send_message_tool_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "sendmessage" | "send_message"
    )
}

pub(super) fn history_tool_starts_subagent_panel(
    name: &str,
    tool_call_id: &str,
    tool_results: &HashMap<String, (String, bool)>,
) -> bool {
    if is_subagent_tool_name(name) {
        return true;
    }
    is_send_message_tool_name(name)
        && tool_results.get(tool_call_id).is_some_and(|(text, _)| {
            matches!(
                parse_subagent_result(text, false).status.as_str(),
                "running" | "resuming"
            )
        })
}

pub(super) fn subagent_requested_delivery(input: &str) -> SubagentDelivery {
    let background = serde_json::from_str::<serde_json::Value>(input)
        .ok()
        .and_then(|value| {
            value
                .get("run_in_background")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false);
    if background {
        SubagentDelivery::Background
    } else {
        SubagentDelivery::Foreground
    }
}

pub(super) fn subagent_item_text(name: &str, input: &str) -> String {
    let parsed = serde_json::from_str::<serde_json::Value>(input).ok();
    let text = parsed
        .as_ref()
        .and_then(|value| value.get("message"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            parsed
                .as_ref()
                .and_then(|value| value.get("description"))
                .and_then(serde_json::Value::as_str)
        })
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(name);
    truncate_to_width(text, 160)
}

fn subagent_agent_id_from_result(text: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()?
        .get("agent_id")?
        .as_str()
        .map(str::to_string)
}

pub(super) struct ParsedSubagentResult {
    pub(super) agent_id: Option<String>,
    pub(super) message_id: Option<String>,
    pub(super) status: String,
    pub(super) queued: bool,
    pub(super) queue_position: Option<usize>,
    pub(super) background: bool,
    pub(super) detail: Option<String>,
}

pub(super) fn parse_subagent_result(text: &str, is_error: bool) -> ParsedSubagentResult {
    let parsed = serde_json::from_str::<serde_json::Value>(text).ok();
    let status = parsed
        .as_ref()
        .and_then(|value| value.get("status"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or(if is_error { "failed" } else { "completed" })
        .to_ascii_lowercase();
    let background = parsed.as_ref().is_some_and(|value| {
        value
            .get("run_in_background")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
            || value
                .get("auto_backgrounded")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
    });
    let detail = parsed
        .as_ref()
        .and_then(|value| value.get("result"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| truncate_to_width(text, 2_000));
    let message_id = parsed
        .as_ref()
        .and_then(|value| value.get("message_id"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let queued = parsed.as_ref().is_some_and(|value| {
        value
            .get("queued")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    });
    let queue_position = parsed
        .as_ref()
        .and_then(|value| value.get("queue_position"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| usize::try_from(value).ok());
    ParsedSubagentResult {
        agent_id: subagent_agent_id_from_result(text),
        message_id,
        queued,
        queue_position,
        background: background || matches!(status.as_str(), "running" | "resuming"),
        status,
        detail,
    }
}

pub(super) fn family_glyph(family: ToolFamily) -> &'static str {
    match family {
        ToolFamily::Read => "▷",
        ToolFamily::Patch => "◆",
        ToolFamily::Run => "▶",
        ToolFamily::Find => "⌕",
        ToolFamily::Mcp => "◇",
        ToolFamily::Delegate => "◐",
        ToolFamily::Generic => "•",
    }
}

pub(super) fn family_label(family: ToolFamily) -> &'static str {
    match family {
        ToolFamily::Read => "read",
        ToolFamily::Patch => "patch",
        ToolFamily::Run => "run",
        ToolFamily::Find => "find",
        ToolFamily::Mcp => "mcp",
        ToolFamily::Delegate => "delegate",
        ToolFamily::Generic => "tool",
    }
}

pub(super) fn family_style(family: ToolFamily) -> Style {
    let styles = KCODER_UI_THEME.tool_styles();
    match family {
        ToolFamily::Read => styles.read,
        ToolFamily::Patch => styles.patch,
        ToolFamily::Run => styles.run,
        ToolFamily::Find => styles.find,
        ToolFamily::Mcp => styles.mcp,
        ToolFamily::Delegate => styles.delegate,
        ToolFamily::Generic => styles.generic,
    }
}

pub(super) fn tool_status_icon_span(status: &str, status_style: Style) -> Span<'static> {
    let style = status_style;

    if status == "running" {
        let mut span = activity_indicator(
            None,
            MotionMode::Reduced,
            ReducedMotionIndicator::StaticBullet,
        )
        .unwrap_or_else(|| Span::raw("•"));
        span.style = span.style.patch(style);
        return span;
    }

    let icon = match status {
        "error" => "✗",
        "diff" => "Δ",
        _ => "✓",
    };
    Span::styled(icon, style)
}

pub(super) fn extract_tool_name(text: &str) -> Option<&str> {
    let first = text.lines().next()?;
    if let Some(rest) = first.strip_prefix("[Tool use: ") {
        return rest.split_once(']').map(|(name, _)| name.trim());
    }
    if let Some(rest) = first.strip_prefix("[Tool diff: ") {
        return rest.split_once(']').map(|(name, _)| name.trim());
    }
    // Formats: "✓ Tool succeeded: Name" or "⟳ Running tool: Name".
    first
        .split_once(' ')
        .and_then(|(_, rest)| rest.split_once(':'))
        .map(|(_, name)| {
            name.trim()
                .split_once(" - ")
                .map_or(name.trim(), |(name, _)| name)
        })
}

pub(super) fn extract_tool_inline_preview(text: &str) -> Option<String> {
    let first = text.lines().next()?;
    if let Some(rest) = first.strip_prefix("[Tool use: ") {
        return rest
            .split_once(']')
            .map(|(_, preview)| preview_tool_text(preview.trim()))
            .filter(|preview| !preview.is_empty());
    }
    first
        .split_once(" - ")
        .map(|(_, preview)| preview_tool_text(preview.trim()))
        .filter(|preview| !preview.is_empty())
}

pub(super) fn shell_tool_highlight_lang(tool_name: &str) -> Option<&'static str> {
    if tool_name.eq_ignore_ascii_case("bash")
        || tool_name.eq_ignore_ascii_case("sh")
        || tool_name.eq_ignore_ascii_case("shell")
    {
        return Some("bash");
    }
    if tool_name.eq_ignore_ascii_case("powershell") || tool_name.eq_ignore_ascii_case("pwsh") {
        return Some("powershell");
    }
    None
}

fn patch_tool_preview_syntax_style(mut syntax_style: Style, base_style: Style) -> Style {
    if syntax_style.fg.is_none() {
        syntax_style.fg = base_style.fg;
    }
    if syntax_style.bg.is_none() {
        syntax_style.bg = base_style.bg;
    }
    syntax_style.add_modifier |= base_style.add_modifier;
    syntax_style.sub_modifier |= base_style.sub_modifier;
    syntax_style
}

pub(super) fn tool_preview_spans(
    tool_name: &str,
    preview: &str,
    base_style: Style,
    code_theme: &str,
) -> Vec<Span<'static>> {
    let Some(lang) = shell_tool_highlight_lang(tool_name) else {
        return vec![Span::styled(preview.to_string(), base_style)];
    };
    let syntax_line = highlight_code_to_styled_spans_with_theme(preview, lang, code_theme)
        .and_then(|mut lines| {
            if lines.len() == 1 {
                Some(lines.remove(0))
            } else {
                None
            }
        });
    let Some(syntax_line) = syntax_line else {
        return vec![Span::styled(preview.to_string(), base_style)];
    };
    if syntax_line.is_empty() {
        return vec![Span::styled(preview.to_string(), base_style)];
    }
    syntax_line
        .into_iter()
        .map(|span| {
            Span::styled(
                span.content.to_string(),
                patch_tool_preview_syntax_style(span.style, base_style),
            )
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RenderedDiffLineParts<'a> {
    pub(super) prefix: &'a str,
    pub(super) sign: char,
    pub(super) content: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct DiffLineStyleSet {
    pub(super) content: Style,
    pub(super) line: Style,
    pub(super) gutter: Style,
}

fn rendered_diff_line_parts(line: &str) -> Option<RenderedDiffLineParts<'_>> {
    let trimmed = line.trim_start();
    if trimmed.starts_with("+++") || trimmed.starts_with("---") {
        return None;
    }
    if matches!(trimmed.as_bytes().first(), Some(b'+' | b'-')) {
        let leading = line.len().saturating_sub(trimmed.len());
        let sign = trimmed.chars().next()?;
        let sign_end = leading.saturating_add(sign.len_utf8());
        return Some(RenderedDiffLineParts {
            prefix: &line[..sign_end],
            sign,
            content: &line[sign_end..],
        });
    }

    let leading = line.len().saturating_sub(trimmed.len());
    let mut idx = leading;
    let digit_start = idx;
    while matches!(line.as_bytes().get(idx), Some(byte) if byte.is_ascii_digit()) {
        idx = idx.saturating_add(1);
    }
    if idx == digit_start || !matches!(line.as_bytes().get(idx), Some(b' ')) {
        return None;
    }
    idx = idx.saturating_add(1);
    let sign = line[idx..].chars().next()?;
    if !matches!(sign, '+' | '-' | ' ') {
        return None;
    }
    let sign_end = idx.saturating_add(sign.len_utf8());
    Some(RenderedDiffLineParts {
        prefix: &line[..sign_end],
        sign,
        content: &line[sign_end..],
    })
}

pub(super) fn diff_lang_from_summary(summary: &str) -> Option<String> {
    let summary = summary.strip_prefix("• ").unwrap_or(summary);
    let rest = summary
        .strip_prefix("Edited ")
        .or_else(|| summary.strip_prefix("Added "))
        .or_else(|| summary.strip_prefix("Deleted "))?;
    let path = rest.split_once(" (+").map_or(rest, |(path, _)| path).trim();
    diff_lang_from_path_text(path)
}

fn diff_lang_from_path_text(path: &str) -> Option<String> {
    let path = path.trim();
    if path.is_empty()
        || path.contains('\n')
        || path.starts_with("...")
        || path.contains(" diff truncated ")
    {
        return None;
    }
    let path = path
        .split_once(" -> ")
        .map_or(path, |(_, destination)| destination);
    let path = path
        .split_once(" → ")
        .map_or(path, |(_, destination)| destination);
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_string)
}

pub(super) fn diff_line_style_for<'a>(
    line: &'a str,
    index: usize,
    ui_theme: &theme::UiTheme,
    diff_context: theme::DiffStyleContext,
) -> (DiffLineStyleSet, Option<RenderedDiffLineParts<'a>>) {
    let diff_line = line.trim_start();
    let parts = rendered_diff_line_parts(line);
    let text_styles = ui_theme.text_styles();
    let styles = match parts
        .map(|parts| parts.sign)
        .and_then(diff_line_kind_for_sign)
    {
        Some(kind) => DiffLineStyleSet {
            content: match kind {
                theme::DiffLineKind::Insert => theme::diff_added_style(diff_context),
                theme::DiffLineKind::Delete => theme::diff_deleted_style(diff_context),
                theme::DiffLineKind::Context => Style::default(),
            },
            line: theme::diff_line_background_style(kind, diff_context.backgrounds),
            gutter: theme::diff_gutter_style(kind, diff_context.theme, diff_context.color_level),
        },
        None if diff_line.starts_with("@@") => DiffLineStyleSet {
            content: Style::default()
                .fg(ui_theme.accent_secondary)
                .add_modifier(Modifier::BOLD),
            line: Style::default(),
            gutter: Style::default(),
        },
        None if index == 1 => DiffLineStyleSet {
            content: text_styles.muted,
            line: Style::default(),
            gutter: Style::default(),
        },
        None => DiffLineStyleSet {
            content: text_styles.dim,
            line: Style::default(),
            gutter: Style::default(),
        },
    };
    (styles, parts)
}

fn diff_line_kind_for_sign(sign: char) -> Option<theme::DiffLineKind> {
    match sign {
        '+' => Some(theme::DiffLineKind::Insert),
        '-' => Some(theme::DiffLineKind::Delete),
        ' ' => Some(theme::DiffLineKind::Context),
        _ => None,
    }
}

fn patch_diff_syntax_style(mut syntax_style: Style, diff_style: Style) -> Style {
    if syntax_style.fg.is_none() {
        syntax_style.fg = diff_style.fg;
    }
    if let Some(bg) = diff_style.bg {
        syntax_style.bg = Some(bg);
    }
    syntax_style.add_modifier |= diff_style.add_modifier;
    syntax_style.sub_modifier |= diff_style.sub_modifier;
    syntax_style
}

fn patch_diff_line_bg(mut span_style: Style, line_style: Style) -> Style {
    if span_style.bg.is_none() {
        span_style.bg = line_style.bg;
    }
    span_style
}

fn styled_diff_prefix_spans(
    prefix: &str,
    sign: char,
    styles: DiffLineStyleSet,
) -> Vec<Span<'static>> {
    let sign_len = sign.len_utf8();
    let sign_start = prefix.len().saturating_sub(sign_len);
    let before_sign = &prefix[..sign_start];
    let sign_text = &prefix[sign_start..];

    let digit_start = before_sign
        .bytes()
        .position(|byte| byte.is_ascii_digit())
        .unwrap_or(before_sign.len());
    let (leading, gutter) = before_sign.split_at(digit_start);

    let mut spans = Vec::with_capacity(3);
    if !leading.is_empty() {
        spans.push(Span::styled(
            leading.to_string(),
            patch_diff_line_bg(Style::default(), styles.line),
        ));
    }
    if !gutter.is_empty() {
        spans.push(Span::styled(
            gutter.to_string(),
            patch_diff_line_bg(styles.gutter, styles.line),
        ));
    }
    spans.push(Span::styled(
        sign_text.to_string(),
        patch_diff_line_bg(styles.content, styles.line),
    ));
    spans
}

pub(super) fn styled_diff_line_spans(
    line: &str,
    styles: DiffLineStyleSet,
    parts: Option<RenderedDiffLineParts<'_>>,
    lang: Option<&str>,
    code_theme: &str,
) -> Vec<Span<'static>> {
    let Some(parts) = parts else {
        return vec![Span::styled(line.to_string(), styles.content)];
    };
    let Some(lang) = lang else {
        let mut spans = styled_diff_prefix_spans(parts.prefix, parts.sign, styles);
        if !parts.content.is_empty() {
            spans.push(Span::styled(
                parts.content.to_string(),
                patch_diff_line_bg(styles.content, styles.line),
            ));
        }
        return spans;
    };
    if parts.content.is_empty() {
        return styled_diff_prefix_spans(parts.prefix, parts.sign, styles);
    }

    let syntax_spans = highlight_code_to_styled_spans_with_theme(parts.content, lang, code_theme)
        .and_then(|mut lines| {
            if lines.len() == 1 {
                Some(lines.remove(0))
            } else {
                None
            }
        });

    let Some(syntax_spans) = syntax_spans else {
        let mut spans = styled_diff_prefix_spans(parts.prefix, parts.sign, styles);
        spans.push(Span::styled(
            parts.content.to_string(),
            patch_diff_line_bg(styles.content, styles.line),
        ));
        return spans;
    };

    let mut spans = Vec::with_capacity(syntax_spans.len().saturating_add(1));
    spans.extend(styled_diff_prefix_spans(parts.prefix, parts.sign, styles));
    spans.extend(syntax_spans.into_iter().map(|span| {
        Span::styled(
            span.content.to_string(),
            patch_diff_syntax_style(span.style, styles.content),
        )
    }));
    spans
}

pub(super) fn styled_diff_continuation_spans(
    line: &str,
    styles: DiffLineStyleSet,
    lang: Option<&str>,
    code_theme: &str,
) -> Option<Vec<Span<'static>>> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('⋮') || line.starts_with("...") {
        return None;
    }

    let leading = line.len().saturating_sub(trimmed.len());
    if leading == 0 {
        return None;
    }

    let prefix = &line[..leading];
    let content = &line[leading..];
    let Some(lang) = lang else {
        return Some(vec![
            Span::styled(
                prefix.to_string(),
                patch_diff_line_bg(styles.gutter, styles.line),
            ),
            Span::styled(
                content.to_string(),
                patch_diff_line_bg(styles.content, styles.line),
            ),
        ]);
    };

    let syntax_spans = highlight_code_to_styled_spans_with_theme(content, lang, code_theme)
        .and_then(|mut lines| {
            if lines.len() == 1 {
                Some(lines.remove(0))
            } else {
                None
            }
        });

    let Some(syntax_spans) = syntax_spans else {
        return Some(vec![
            Span::styled(
                prefix.to_string(),
                patch_diff_line_bg(styles.gutter, styles.line),
            ),
            Span::styled(
                content.to_string(),
                patch_diff_line_bg(styles.content, styles.line),
            ),
        ]);
    };

    let mut spans = Vec::with_capacity(syntax_spans.len().saturating_add(1));
    spans.push(Span::styled(
        prefix.to_string(),
        patch_diff_line_bg(styles.gutter, styles.line),
    ));
    spans.extend(syntax_spans.into_iter().map(|span| {
        Span::styled(
            span.content.to_string(),
            patch_diff_syntax_style(span.style, styles.content),
        )
    }));
    Some(spans)
}

pub(super) fn diff_line_from_spans(
    mut spans: Vec<Span<'static>>,
    line_style: Style,
    width: Option<u16>,
) -> Line<'static> {
    if let Some(width) = width.map(usize::from).filter(|width| *width > 0) {
        let used_width = spans
            .iter()
            .map(|span| render::wrapping::display_width(span.content.as_ref()))
            .sum::<usize>();
        if used_width < width && line_style.bg.is_some() {
            spans.push(Span::styled(
                " ".repeat(width - used_width),
                patch_diff_line_bg(Style::default(), line_style),
            ));
        }
    }
    Line::from(spans).style(line_style)
}

pub(super) fn reflow_tool_diff_visible_lines(text: &str, width: Option<u16>) -> Vec<String> {
    let Some(width) = width.map(usize::from).filter(|width| *width > 0) else {
        return text.lines().skip(1).map(ToOwned::to_owned).collect();
    };

    text.lines()
        .skip(1)
        .flat_map(|line| reflow_rendered_diff_line(line, width))
        .collect()
}

fn reflow_rendered_diff_line(line: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    if render::wrapping::display_width(line) <= width {
        return vec![line.to_string()];
    }

    let Some(parts) = rendered_diff_line_parts(line) else {
        return hard_wrap_display_width_for_diff(line, width);
    };

    let prefix_width = render::wrapping::display_width(parts.prefix);
    let content_width = width.saturating_sub(prefix_width).max(1);
    let chunks = hard_wrap_display_width_for_diff(parts.content, content_width);
    let continuation_prefix = " ".repeat(prefix_width);
    chunks
        .into_iter()
        .enumerate()
        .map(|(idx, chunk)| {
            if idx == 0 {
                format!("{}{}", parts.prefix, chunk)
            } else {
                format!("{continuation_prefix}{chunk}")
            }
        })
        .collect()
}

fn hard_wrap_display_width_for_diff(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    if text.is_empty() {
        return vec![String::new()];
    }

    let mut lines = Vec::new();
    let mut current = String::new();
    let mut used = 0usize;
    for grapheme in text.graphemes(true) {
        let grapheme_width = unicode_width::UnicodeWidthStr::width(grapheme);
        if used > 0 && used.saturating_add(grapheme_width) > width {
            trim_ascii_spaces(&mut current);
            lines.push(std::mem::take(&mut current));
            used = 0;
        }
        current.push_str(grapheme);
        used = used.saturating_add(grapheme_width);
    }

    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

fn trim_ascii_spaces(text: &mut String) {
    while text.ends_with(' ') {
        text.pop();
    }
}

pub(super) fn should_update_diff_lang_from_rendered_line(
    line: &str,
    index: usize,
    parts: Option<RenderedDiffLineParts<'_>>,
) -> bool {
    index > 1
        && parts.is_none()
        && !line.trim_start().starts_with('⋮')
        && !line.starts_with("...")
        && diff_lang_from_path_text(line).is_some()
}

pub(super) fn update_diff_lang_from_rendered_line(line: &str, lang: &mut Option<String>) {
    if let Some(next_lang) = diff_lang_from_path_text(line) {
        *lang = Some(next_lang);
    }
}

pub(super) enum TranscriptRenderItem<'a> {
    Message {
        absolute_idx: usize,
        message: &'a DisplayMessage,
    },
    ToolPair(DisplayMessage),
    ToolSummary {
        absolute_idx: usize,
        message: DisplayMessage,
    },
}

pub(super) const TOOL_SUMMARY_MIN_RUN_LEN: usize = 1;

pub(super) fn is_tool_run_message(msg: &DisplayMessage) -> bool {
    msg.role == MessageRole::System
        && (msg.text.starts_with("⟳ Running tool:")
            || msg.text.starts_with("✓ Tool succeeded:")
            || msg.text.starts_with("✗ Tool failed:")
            || msg.text.starts_with("[Tool use:")
            || msg.text.starts_with("[Tool result:")
            || msg.text.starts_with("[Tool error:")
            || msg.text.starts_with("[Tool diff:"))
}

pub(super) fn is_collapsible_tool_message(msg: &DisplayMessage) -> bool {
    is_tool_run_message(msg)
        && !tool_message_is_important(msg)
        && !tool_message_is_merge_excluded(msg)
}

fn tool_message_is_important(msg: &DisplayMessage) -> bool {
    tool_message_is_failure(&msg.text)
        || tool_status_text_looks_important(&msg.text)
        || (msg.text.starts_with("[Tool diff:") && tool_message_is_merge_excluded(msg))
}

fn tool_message_is_merge_excluded(msg: &DisplayMessage) -> bool {
    extract_tool_name(&msg.text)
        .map(tool_name_is_merge_excluded)
        .unwrap_or(false)
}

fn tool_name_is_merge_excluded(name: &str) -> bool {
    let name = name.trim();
    name.eq_ignore_ascii_case("edit")
        || name.eq_ignore_ascii_case("write")
        || name.eq_ignore_ascii_case("AskUserQuestion")
        || name.eq_ignore_ascii_case("EnterPlanMode")
        || name.eq_ignore_ascii_case("ExitPlanMode")
}

fn is_tool_invocation_message(msg: &DisplayMessage) -> bool {
    msg.role == MessageRole::System
        && (msg.text.starts_with("⟳ Running tool:") || msg.text.starts_with("[Tool use:"))
}

fn is_tool_completion_message(msg: &DisplayMessage) -> bool {
    msg.role == MessageRole::System
        && (msg.text.starts_with("✓ Tool succeeded:") || msg.text.starts_with("✗ Tool failed:"))
}

fn tool_names_match(left: &DisplayMessage, right: &DisplayMessage) -> bool {
    match (
        extract_tool_name(&left.text),
        extract_tool_name(&right.text),
    ) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn merged_tool_pair_message(
    invocation: &DisplayMessage,
    completion: &DisplayMessage,
) -> Option<DisplayMessage> {
    if !is_tool_invocation_message(invocation)
        || !is_tool_completion_message(completion)
        || !tool_names_match(invocation, completion)
    {
        return None;
    }
    let name = extract_tool_name(completion.text.as_str())?;
    if tool_name_is_merge_excluded(name) {
        return None;
    }
    let status_prefix = if completion.text.starts_with("✗ Tool failed:") {
        "✗ Tool failed:"
    } else {
        "✓ Tool succeeded:"
    };
    let invocation_preview = extract_tool_inline_preview(invocation.text.as_str());
    let mut text = if let Some(preview) = invocation_preview.filter(|preview| !preview.is_empty()) {
        format!("{status_prefix} {name} - {preview}")
    } else {
        format!("{status_prefix} {name}")
    };
    let completion_preview = merged_tool_completion_preview(completion.text.as_str());
    if !completion_preview.is_empty() {
        text.push('\n');
        text.push_str(&completion_preview);
    }
    Some(DisplayMessage {
        role: MessageRole::System,
        text,
    })
}

fn merged_tool_completion_preview(text: &str) -> String {
    let inline = extract_tool_inline_preview(text).unwrap_or_default();
    let body = text
        .split_once('\n')
        .map(|(_, body)| preview_tool_text(body))
        .unwrap_or_default();
    if inline.is_empty() {
        body
    } else if body.is_empty() || body == inline {
        inline
    } else {
        preview_tool_text(&format!("{inline} {body}"))
    }
}

fn should_preserve_invocation_before_completion(
    invocation: &DisplayMessage,
    completion: &DisplayMessage,
) -> bool {
    is_tool_invocation_message(invocation)
        && is_tool_completion_message(completion)
        && tool_names_match(invocation, completion)
        && (tool_message_is_failure(&completion.text)
            || tool_status_text_looks_important(&completion.text))
}

fn tool_message_is_failure(text: &str) -> bool {
    text.starts_with("✗ Tool failed:") || text.starts_with("[Tool error:")
}

fn tool_status_text_looks_important(text: &str) -> bool {
    if !text.starts_with("✓ Tool succeeded:") {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    [
        "error",
        "failed",
        "failure",
        "fatal",
        "traceback",
        "panic",
        "assertionerror",
        "exit code",
        "non-zero",
        "permission denied",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn increment_tool_count(counts: &mut Vec<(String, usize)>, name: &str) {
    let name = name.trim();
    if name.is_empty() {
        return;
    }
    if let Some((_, count)) = counts.iter_mut().find(|(existing, _)| existing == name) {
        *count += 1;
    } else {
        counts.push((name.to_string(), 1));
    }
}

fn tool_summary_recent_line(msg: &DisplayMessage) -> Option<(String, String)> {
    let name = extract_tool_name(&msg.text)?.trim();
    if name.is_empty() {
        return None;
    }

    let status = if msg.text.starts_with("⟳ Running tool:") {
        "running"
    } else if msg.text.starts_with("✓ Tool succeeded:") {
        "done"
    } else if msg.text.starts_with("[Tool use:") {
        "started"
    } else if msg.text.starts_with("[Tool result:") {
        "result"
    } else {
        return None;
    };
    let preview = extract_tool_inline_preview(&msg.text).unwrap_or_default();
    let line = if preview.is_empty() {
        format!("{name} {status}")
    } else {
        format!("{name} {status} - {preview}")
    };
    Some((name.to_string(), line))
}

fn tool_summary_recent_lines(run: &[DisplayMessage]) -> Vec<String> {
    let mut recent: Vec<(String, String)> = Vec::new();
    for msg in run {
        let Some((name, line)) = tool_summary_recent_line(msg) else {
            continue;
        };
        if (msg.text.starts_with("✓ Tool succeeded:") || msg.text.starts_with("[Tool result:"))
            && let Some((_, existing)) = recent
                .iter_mut()
                .rev()
                .find(|(existing, _)| existing == &name)
        {
            // Use the executed shell command as the primary row and place detailed stdout
            // afterward. The summary also retains the command, while expansion exposes the complete result.
            if shell_tool_highlight_lang(&name).is_some()
                && let Some(command) = summary_line_preview(existing)
            {
                *existing = format!("{name} {} - {command}", line_status(&line));
            } else {
                *existing = line;
            }
            continue;
        }
        recent.push((name, line));
    }
    recent
        .into_iter()
        .rev()
        .take(2)
        .map(|(_, line)| line)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn summary_line_preview(line: &str) -> Option<&str> {
    line.split_once(" - ")
        .map(|(_, preview)| preview.trim())
        .filter(|preview| !preview.is_empty())
}

fn line_status(line: &str) -> &str {
    line.split_whitespace().nth(1).unwrap_or("done")
}

fn format_tool_run_summary(run: &[DisplayMessage]) -> Option<String> {
    let mut counts = Vec::new();

    for msg in run.iter().filter(|msg| is_tool_invocation_message(msg)) {
        if let Some(name) = extract_tool_name(&msg.text) {
            increment_tool_count(&mut counts, name);
        }
    }

    // Older transcripts may only have completion/error cards. Fall back to
    // counting those so consecutive legacy tool messages still collapse.
    if counts.is_empty() {
        for msg in run.iter().filter(|msg| is_tool_completion_message(msg)) {
            if let Some(name) = extract_tool_name(&msg.text) {
                increment_tool_count(&mut counts, name);
            }
        }
    }

    if counts.is_empty() {
        return None;
    }

    let parts = counts
        .into_iter()
        .map(|(name, count)| format!("{name} x{count}"))
        .collect::<Vec<_>>()
        .join(" · ");
    let mut lines = vec![format!("[Tool summary] {parts}")];
    lines.extend(
        tool_summary_recent_lines(run)
            .into_iter()
            .map(|line| format!("[Tool latest] latest: {line}")),
    );
    Some(lines.join("\n"))
}

#[cfg(test)]
pub(super) fn collapse_tool_runs<'a>(
    msgs: &'a [DisplayMessage],
    start_idx: usize,
    collapse_tools: bool,
) -> Vec<TranscriptRenderItem<'a>> {
    collapse_tool_runs_with_minimum(msgs, start_idx, collapse_tools, TOOL_SUMMARY_MIN_RUN_LEN)
}

pub(super) fn collapse_tool_runs_with_recent_expanded<'a>(
    msgs: &'a [DisplayMessage],
    start_idx: usize,
    collapse_tools: bool,
    min_run_len: usize,
    expanded_from: Option<usize>,
) -> Vec<TranscriptRenderItem<'a>> {
    let _ = expanded_from;
    collapse_tool_runs_with_minimum(msgs, start_idx, collapse_tools, min_run_len)
}

pub(super) fn collapse_tool_runs_with_minimum<'a>(
    msgs: &'a [DisplayMessage],
    start_idx: usize,
    collapse_tools: bool,
    min_run_len: usize,
) -> Vec<TranscriptRenderItem<'a>> {
    if !collapse_tools {
        return msgs
            .iter()
            .enumerate()
            .map(|(idx, message)| TranscriptRenderItem::Message {
                absolute_idx: start_idx + idx,
                message,
            })
            .collect();
    }

    let mut items = Vec::new();
    let mut i = 0;
    while i < msgs.len() {
        if !is_tool_run_message(&msgs[i]) {
            items.push(TranscriptRenderItem::Message {
                absolute_idx: start_idx + i,
                message: &msgs[i],
            });
            i += 1;
            continue;
        }

        // A user/assistant message ends a tool run. User-interaction tools and
        // visible failures pass through this run without splitting the
        // surrounding low-signal tools into multiple summaries.
        let run_start = i;
        while i < msgs.len() && is_tool_run_message(&msgs[i]) {
            i += 1;
        }
        let run_end = i;

        let mut summary_mask = vec![false; run_end - run_start];
        let mut summary_messages = Vec::new();
        let mut cursor = run_start;
        while cursor < run_end {
            if let Some(next) = msgs.get(cursor + 1).filter(|_| cursor + 1 < run_end)
                && should_preserve_invocation_before_completion(&msgs[cursor], next)
            {
                cursor += 2;
                continue;
            }
            if is_collapsible_tool_message(&msgs[cursor]) {
                summary_mask[cursor - run_start] = true;
                summary_messages.push(msgs[cursor].clone());
            }
            cursor += 1;
        }

        let summary = (summary_messages.len() >= min_run_len)
            .then(|| format_tool_run_summary(&summary_messages))
            .flatten();
        let Some(summary) = summary else {
            push_tool_messages_with_pairs(&mut items, msgs, run_start, run_end, start_idx);
            continue;
        };
        let first_summary = summary_mask
            .iter()
            .position(|summarized| *summarized)
            .map(|offset| run_start + offset)
            .expect("non-empty summary has a source message");
        let mut summary = Some(summary);
        cursor = run_start;
        while cursor < run_end {
            if cursor == first_summary {
                items.push(TranscriptRenderItem::ToolSummary {
                    absolute_idx: start_idx + first_summary,
                    message: DisplayMessage {
                        role: MessageRole::System,
                        text: summary.take().expect("tool summary inserted once"),
                    },
                });
            }
            if summary_mask[cursor - run_start] {
                cursor += 1;
                continue;
            }
            if let Some(next) = msgs.get(cursor + 1).filter(|_| cursor + 1 < run_end)
                && should_preserve_invocation_before_completion(&msgs[cursor], next)
                && let Some(merged) = merged_tool_pair_message(&msgs[cursor], next)
            {
                items.push(TranscriptRenderItem::ToolPair(merged));
                cursor += 2;
                continue;
            }
            items.push(TranscriptRenderItem::Message {
                absolute_idx: start_idx + cursor,
                message: &msgs[cursor],
            });
            cursor += 1;
        }
    }
    items
}

fn push_tool_messages_with_pairs<'a>(
    items: &mut Vec<TranscriptRenderItem<'a>>,
    msgs: &'a [DisplayMessage],
    start: usize,
    end: usize,
    start_idx: usize,
) {
    let mut idx = start;
    while idx < end {
        if idx + 1 < end
            && let Some(merged) = merged_tool_pair_message(&msgs[idx], &msgs[idx + 1])
        {
            items.push(TranscriptRenderItem::ToolPair(merged));
            idx += 2;
            continue;
        }
        items.push(TranscriptRenderItem::Message {
            absolute_idx: start_idx + idx,
            message: &msgs[idx],
        });
        idx += 1;
    }
}

/// Compute the rail position for each visible message. Only tool status
/// messages that **belong to the same assistant turn with no model output
/// in between** are grouped for stable ordering. Tool calls from different
/// turns (or separated by assistant text) are rendered independently because
/// the user expects each tool
/// invocation to be its own visual unit. The previous implementation
/// collapsed every consecutive tool status into one group, which made
/// unrelated tools from different turns look like a single fan-out.
#[allow(dead_code)]
pub(super) fn tool_rail_positions(msgs: &[DisplayMessage]) -> Vec<Option<ToolRailPos>> {
    let is_tool = |m: &DisplayMessage| {
        m.role == MessageRole::System
            && (m.text.starts_with("⟳ Running tool:")
                || m.text.starts_with("✓ Tool succeeded:")
                || m.text.starts_with("✗ Tool failed:")
                || m.text.starts_with("[Tool use:")
                || m.text.starts_with("[Tool result:")
                || m.text.starts_with("[Tool error:"))
    };

    let mut positions: Vec<Option<ToolRailPos>> = vec![None; msgs.len()];
    let mut i = 0;
    while i < msgs.len() {
        if !is_tool(&msgs[i]) {
            i += 1;
            continue;
        }
        // Walk the candidate run of consecutive tool messages. Inside
        // the run, an `Assistant` text message breaks the grouping so
        // tool cards from different turns are kept distinct.
        let run_start = i;
        let mut run_end = i + 1;
        while run_end < msgs.len() && is_tool(&msgs[run_end]) {
            run_end += 1;
        }
        // Two or fewer consecutive tool messages render as independent
        // cards; only three or more justify a rail.
        let run_len = run_end - run_start;
        if run_len < 3 {
            for pos in positions.iter_mut().take(run_end).skip(run_start) {
                *pos = Some(ToolRailPos::Single);
            }
            i = run_end;
            continue;
        }
        // Split the run on any assistant message that may have leaked
        // through. The streaming pipeline never produces this in
        // practice (an assistant message is followed by its own tool
        // block on a later message), but the check is cheap and keeps
        // the rail grouping correct if the layout ever changes.
        let mut sub_start = run_start;
        while sub_start < run_end {
            let mut sub_end = sub_start + 1;
            while sub_end < run_end && msgs[sub_end].role == MessageRole::System {
                sub_end += 1;
            }
            let sub_len = sub_end - sub_start;
            if sub_len == 1 {
                positions[sub_start] = Some(ToolRailPos::Single);
            } else {
                for (offset, idx) in (sub_start..sub_end).enumerate() {
                    positions[idx] = Some(match offset {
                        0 => ToolRailPos::Top,
                        _ if offset + 1 == sub_len => ToolRailPos::Bottom,
                        _ => ToolRailPos::Middle,
                    });
                }
            }
            sub_start = sub_end;
        }
        i = run_end;
    }
    positions
}

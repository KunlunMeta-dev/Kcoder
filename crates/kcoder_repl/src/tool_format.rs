pub(crate) const TOOL_PREVIEW_CHARS: usize = 120;
const MAX_TOOL_DIFF_LINES: usize = 80;
const MAX_TOOL_DIFF_LINE_CHARS: usize = 160;
const TOOL_DIFF_WRAP_COLS: usize = 96;

use crate::diff_render::{
    RenderDiffOptions, calculate_add_remove_from_diff, render_tool_diff_body,
};
use crate::text_formatting::truncate_text;
use std::borrow::Cow;

pub(crate) fn sanitize_tui_text(text: &str) -> String {
    if !text
        .chars()
        .any(|ch| ch == '\x1b' || (ch.is_control() && ch != '\n' && ch != '\t'))
    {
        return text.to_string();
    }

    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut idx = 0usize;
    while idx < bytes.len() {
        if bytes[idx] == 0x1b {
            idx += 1;
            if idx >= bytes.len() {
                break;
            }
            match bytes[idx] {
                b'[' => {
                    idx += 1;
                    while idx < bytes.len() {
                        let byte = bytes[idx];
                        idx += 1;
                        if (0x40..=0x7e).contains(&byte) {
                            break;
                        }
                    }
                }
                b']' | b'P' | b'^' | b'_' => {
                    idx += 1;
                    while idx < bytes.len() {
                        if bytes[idx] == 0x07 {
                            idx += 1;
                            break;
                        }
                        if bytes[idx] == 0x1b && idx + 1 < bytes.len() && bytes[idx + 1] == b'\\' {
                            idx += 2;
                            break;
                        }
                        idx += 1;
                    }
                }
                _ => {
                    // Unknown ESC sequences retain the established behavior of dropping ESC and the
                    // following character, but advancement must follow complete Unicode scalars.
                    // Tool output may contain U+FFFD after `from_utf8_lossy`; advancing one byte could
                    // place the next string slice inside a UTF-8 character and panic.
                    let Some(ch) = text[idx..].chars().next() else {
                        break;
                    };
                    idx += ch.len_utf8();
                }
            }
            continue;
        }

        let Some(ch) = text[idx..].chars().next() else {
            break;
        };
        idx += ch.len_utf8();
        match ch {
            '\n' | '\t' => out.push(ch),
            '\r' => {}
            ch if ch.is_control() => out.push(' '),
            ch => out.push(ch),
        }
    }
    out
}

pub(crate) fn preview_tool_text(text: &str) -> String {
    let text = sanitize_tui_text(text);
    let mut compact = String::new();
    for word in text.split_whitespace() {
        if !compact.is_empty() {
            compact.push(' ');
        }
        compact.push_str(word);
    }

    truncate_text(&compact, TOOL_PREVIEW_CHARS)
}

pub(crate) fn format_tool_use(name: &str, input: &str) -> String {
    let preview_source = tool_preview_source(name, input);
    let preview = preview_tool_text(preview_source.as_ref());
    if preview.is_empty() {
        format!("[Tool use: {name}]")
    } else {
        format!("[Tool use: {name}] {preview}")
    }
}

pub(crate) fn format_running_tool(name: &str, input: &str, expanded: bool) -> String {
    if let Some(summary) = ocr_input_summary(name, input, true) {
        return format!("⟳ Running tool: {name} - {summary}");
    }

    let preview_source = tool_preview_source(name, input);
    let preview = preview_tool_text(preview_source.as_ref());
    if (expanded || is_agent_tool_name(name)) && !preview.is_empty() {
        format!("⟳ Running tool: {name} - {preview}")
    } else {
        format!("⟳ Running tool: {name}")
    }
}

pub(crate) fn format_running_tool_detail(name: &str, input: &str) -> String {
    if let Some(summary) = ocr_input_summary(name, input, true) {
        return format!("Running {summary}");
    }

    if !is_shell_tool_name(name) && !is_agent_tool_name(name) {
        return format!("Running {name}");
    }

    let preview_source = tool_preview_source(name, input);
    let preview = preview_tool_text(preview_source.as_ref());
    if preview.is_empty() {
        format!("Running {name}")
    } else {
        format!("Running {preview}")
    }
}

pub(crate) fn format_running_tool_activity(name: &str, input: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(input)
        && let Some(description) = value
            .get("description")
            .or_else(|| value.get("message"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|description| !description.is_empty())
    {
        return preview_tool_text(description);
    }

    format!("Running {name}")
}

fn tool_preview_source<'a>(name: &str, input: &'a str) -> Cow<'a, str> {
    if let Some(summary) = ocr_input_summary(name, input, false) {
        return Cow::Owned(summary);
    }
    if let Some(summary) = task_tool_input_summary(name, input) {
        return Cow::Owned(summary);
    }
    if let Some(summary) = agent_tool_input_summary(name, input) {
        return Cow::Owned(summary);
    }

    if !is_shell_tool_name(name) {
        return Cow::Borrowed(input);
    }

    serde_json::from_str::<serde_json::Value>(input)
        .ok()
        .and_then(|value| {
            value
                .get("command")
                .and_then(serde_json::Value::as_str)
                .filter(|command| !command.trim().is_empty())
                .map(ToOwned::to_owned)
        })
        .map(Cow::Owned)
        .unwrap_or(Cow::Borrowed(input))
}

fn ocr_input_summary(name: &str, input: &str, include_background_hint: bool) -> Option<String> {
    if !is_ocr_tool_name(name) {
        return None;
    }
    let value = serde_json::from_str::<serde_json::Value>(input).ok()?;
    let command = value
        .get("command")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("review");
    let preview = value
        .get("preview")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let mut summary = if preview {
        match command {
            "scan" => "OCR scan preview".to_string(),
            _ => "OCR review preview".to_string(),
        }
    } else {
        match command {
            "scan" => "OCR full scan".to_string(),
            _ => "OCR full review".to_string(),
        }
    };

    if let Some(target) = ocr_target_summary(&value) {
        summary.push_str(" for ");
        summary.push_str(&target);
    }
    if preview {
        summary.push_str(" (scope only)");
    } else if include_background_hint {
        let foreground_seconds = value
            .get("foregroundTimeoutSeconds")
            .or_else(|| value.get("foreground_timeout_seconds"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(60);
        summary.push_str(&format!(
            "; moves to background after {foreground_seconds}s if still running"
        ));
    }
    Some(summary)
}

fn ocr_target_summary(value: &serde_json::Value) -> Option<String> {
    if let Some(path) = value
        .get("path")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        return Some(path.to_string());
    }
    if let Some(commit) = value
        .get("commit")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|commit| !commit.is_empty())
    {
        return Some(format!("commit {commit}"));
    }
    let from = value
        .get("from")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|from| !from.is_empty());
    let to = value
        .get("to")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|to| !to.is_empty());
    match (from, to) {
        (Some(from), Some(to)) => Some(format!("{from}..{to}")),
        (Some(from), None) => Some(format!("from {from}")),
        (None, Some(to)) => Some(format!("to {to}")),
        (None, None) => None,
    }
}

fn is_shell_tool_name(name: &str) -> bool {
    matches!(
        name,
        "bash" | "BashTool" | "powershell" | "PowerShell" | "PowerShellTool"
    )
}

fn is_ocr_tool_name(name: &str) -> bool {
    matches!(name, "ocr" | "OcrReviewTool")
}

pub(crate) fn is_agent_tool_name(name: &str) -> bool {
    matches!(
        name,
        "spawn_agent" | "Agent" | "explore_agent" | "ExploreAgent" | "PlanAgent"
    )
}

fn agent_tool_input_summary(name: &str, input: &str) -> Option<String> {
    if !is_agent_tool_name(name) {
        return None;
    }
    let value = serde_json::from_str::<serde_json::Value>(input).ok()?;
    let message = value
        .get("message")
        .or_else(|| value.get("prompt"))
        .and_then(serde_json::Value::as_str)?;
    Some(agent_task_label(message))
}

fn agent_task_label(message: &str) -> String {
    for marker in ["唯一任务：", "唯一任务:", "Task:", "任务：", "任务:"] {
        if let Some((_, task)) = message.rsplit_once(marker) {
            let task = task.trim();
            if !task.is_empty() {
                return preview_tool_text(task);
            }
        }
    }
    preview_tool_text(message)
}

fn tool_diff_should_display_separately(name: &str) -> bool {
    matches!(
        name,
        "edit"
            | "apply_patch"
            | "write"
            | "notebook_edit"
            | "FileEditTool"
            | "FileWriteTool"
            | "ApplyPatchTool"
    )
}

fn tool_status_preview_source(name: &str, output: &str) -> String {
    if let Some(summary) = ocr_output_summary(name, output) {
        return summary;
    }
    if let Some(summary) = task_tool_output_summary(name, output) {
        return summary;
    }
    if let Some(summary) = agent_tool_output_summary(name, output) {
        return summary;
    }
    if tool_diff_should_display_separately(name) && extract_diff_block(output).is_some() {
        return output
            .split_once("```diff")
            .map(|(summary, _)| summary.trim_end().to_string())
            .unwrap_or_else(|| output.to_string());
    }
    output.to_string()
}

fn agent_tool_output_summary(name: &str, output: &str) -> Option<String> {
    if !is_agent_tool_name(name) {
        return None;
    }
    let value = serde_json::from_str::<serde_json::Value>(output).ok()?;
    let status = value
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("completed");
    let task = value
        .get("description")
        .and_then(serde_json::Value::as_str)
        .map(agent_task_label)
        .filter(|task| !task.is_empty());
    let result = value
        .get("result")
        .and_then(serde_json::Value::as_str)
        .map(preview_tool_text)
        .filter(|result| !result.is_empty());

    Some(match (task, result) {
        (Some(task), Some(result)) => format!("{status}: {task} - {result}"),
        (Some(task), None) => format!("{status}: {task}"),
        (None, Some(result)) => format!("{status}: {result}"),
        (None, None) => status.to_string(),
    })
}

fn ocr_output_summary(name: &str, output: &str) -> Option<String> {
    if !is_ocr_tool_name(name) {
        return None;
    }
    let value = serde_json::from_str::<serde_json::Value>(output).ok()?;
    if value.get("tool").and_then(serde_json::Value::as_str) != Some("ocr") {
        return None;
    }
    let task_id = value
        .get("task_id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())?;
    let status = value
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("running");
    if status == "running" {
        Some(format!(
            "OpenCodeReview moved to background as {task_id}; use TaskOutput to inspect it"
        ))
    } else {
        Some(format!("OpenCodeReview task {task_id} status: {status}"))
    }
}

fn task_tool_input_summary(name: &str, input: &str) -> Option<String> {
    if !is_background_task_tool_name(name) {
        return None;
    }
    let value = serde_json::from_str::<serde_json::Value>(input).ok()?;
    let task_id = value
        .get("task_id")
        .or_else(|| value.get("taskId"))
        .or_else(|| value.get("shell_id"))
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())?;
    match name {
        "TaskOutput" => Some(format!("check background task {task_id}")),
        "TaskStop" => Some(format!("stop background task {task_id}")),
        _ => None,
    }
}

fn task_tool_output_summary(name: &str, output: &str) -> Option<String> {
    if !is_background_task_tool_name(name) {
        return None;
    }
    let value = serde_json::from_str::<serde_json::Value>(output).ok()?;
    match name {
        "TaskOutput" => task_output_summary(&value),
        "TaskStop" => task_stop_summary(&value),
        _ => None,
    }
}

fn task_output_summary(value: &serde_json::Value) -> Option<String> {
    let retrieval = value
        .get("retrieval_status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("status");
    let task = value.get("task")?;
    let task_id = task
        .get("task_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("task");
    let status = task
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    match retrieval {
        "not_ready" => Some(format!("{task_id} is still running; poll later or stop it")),
        "timeout" => Some(format!("{task_id} is still running after the wait timeout")),
        "success" => {
            let output = task
                .get("output")
                .and_then(serde_json::Value::as_str)
                .map(preview_tool_text)
                .filter(|text| !text.is_empty());
            Some(match output {
                Some(output) => format!("{task_id} is {status}: {output}"),
                None => format!("{task_id} is {status}"),
            })
        }
        _ => Some(format!("{task_id} status: {status}")),
    }
}

fn task_stop_summary(value: &serde_json::Value) -> Option<String> {
    let task_id = value
        .get("task_id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())?;
    let message = value
        .get("message")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty());
    Some(match message {
        Some(message) => format!("{message}; {task_id} is no longer running"),
        None => format!("Stopped background task {task_id}"),
    })
}

fn is_background_task_tool_name(name: &str) -> bool {
    matches!(name, "TaskOutput" | "TaskStop")
}

pub(crate) fn format_tool_status(name: &str, output: &str, is_error: bool) -> String {
    let status = if is_error {
        format!("✗ Tool failed: {name}")
    } else {
        format!("✓ Tool succeeded: {name}")
    };

    let output = sanitize_tui_text(output);
    let preview = preview_tool_text(&tool_status_preview_source(name, &output));
    if preview.is_empty() {
        status
    } else {
        format!("{status} - {preview}")
    }
}

pub(crate) fn format_completed_tool_display(
    name: &str,
    input: &str,
    output: &str,
    is_error: bool,
) -> (String, String, Option<String>) {
    if name.is_empty() {
        return (String::new(), String::new(), None);
    }
    (
        format_tool_use(name, input),
        format_tool_status(name, output, is_error),
        format_tool_diff(name, output),
    )
}

fn extract_diff_block(output: &str) -> Option<String> {
    let (_, rest) = output.split_once("```diff")?;
    let rest = rest.strip_prefix('\n').unwrap_or(rest);
    let (diff, _) = rest.split_once("```").unwrap_or((rest, ""));
    let diff = diff.trim_matches('\n');
    if diff.is_empty() {
        None
    } else {
        Some(diff.to_string())
    }
}

fn diff_line_counts(diff: &str) -> (usize, usize) {
    calculate_add_remove_from_diff(diff)
}

fn diff_target_from_summary(summary: &str) -> Option<&str> {
    for prefix in ["Edited ", "Added ", "Deleted "] {
        if let Some(path) = summary.strip_prefix(prefix) {
            return Some(path.trim()).filter(|path| !path.is_empty());
        }
    }
    if summary.starts_with("Wrote ") {
        return summary
            .rsplit_once(" to ")
            .map(|(_, path)| path.trim())
            .filter(|path| !path.is_empty());
    }
    None
}

fn format_diff_summary_line(_name: &str, summary: &str, added: usize, removed: usize) -> String {
    let target = diff_target_from_summary(summary);
    let verb = match (added, removed) {
        (added, 0) if added > 0 => "Added",
        (0, removed) if removed > 0 => "Deleted",
        _ => "Edited",
    };

    let summary = if let Some(path) = target {
        format!("{verb} {path} (+{added} -{removed})")
    } else if summary.is_empty() {
        format!("{verb} (+{added} -{removed})")
    } else {
        format!(
            "{} (+{} -{})",
            truncate_chars(summary, MAX_TOOL_DIFF_LINE_CHARS),
            added,
            removed
        )
    };
    format!("• {summary}")
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    truncate_text(text, max_chars)
}

pub(crate) fn format_tool_diff(name: &str, output: &str) -> Option<String> {
    let output = sanitize_tui_text(output);
    let diff = extract_diff_block(&output);
    let diagnostics = extract_lsp_diagnostics_block(&output);
    if diff.is_none() && diagnostics.is_none() {
        return None;
    }

    let mut lines = if diff.is_some() {
        vec![format!("[Tool diff: {name}]")]
    } else {
        vec![format!("[Tool diagnostics: {name}]")]
    };

    if let Some(diff) = diff {
        let summary = output.lines().next().unwrap_or("").trim();
        let (added, removed) = diff_line_counts(&diff);
        lines.push(format_diff_summary_line(name, summary, added, removed));

        let rendered = render_tool_diff_body(
            &diff,
            RenderDiffOptions::new(TOOL_DIFF_WRAP_COLS, MAX_TOOL_DIFF_LINES),
        );
        lines.extend(rendered.lines);
        if rendered.truncated {
            lines.push(format!(
                "... diff truncated after {MAX_TOOL_DIFF_LINES} rendered rows ..."
            ));
        }
    }

    if let Some(diagnostics) = diagnostics {
        if lines.len() > 1 {
            lines.push(String::new());
        }
        lines.push("[Tool diagnostics: lsp]".to_string());
        lines.extend(diagnostics.lines().map(ToOwned::to_owned));
    }
    Some(lines.join("\n"))
}

fn extract_lsp_diagnostics_block(output: &str) -> Option<String> {
    let start = output.find("<diagnostics source=\"lsp\"")?;
    let rest = &output[start..];
    let end = rest.find("</diagnostics>")? + "</diagnostics>".len();
    Some(rest[..end].trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_unknown_escape_consumes_a_complete_unicode_scalar() {
        for (input, expected) in [
            ("before\u{1b}�after", "beforeafter"),
            ("before\u{1b}中after", "beforeafter"),
            ("before\u{1b}🙂after", "beforeafter"),
        ] {
            assert_eq!(sanitize_tui_text(input), expected, "input: {input:?}");
        }
    }

    #[test]
    fn shell_tool_use_preview_shows_command_not_json_input() {
        let input = r#"{"command":"cargo test --workspace","description":"Run tests"}"#;

        assert_eq!(
            format_tool_use("bash", input),
            "[Tool use: bash] cargo test --workspace"
        );
        assert_eq!(
            format_running_tool("bash", input, true),
            "⟳ Running tool: bash - cargo test --workspace"
        );
        assert_eq!(
            format_running_tool_detail("bash", input),
            "Running cargo test --workspace"
        );
    }

    #[test]
    fn powershell_tool_use_preview_shows_command_not_json_input() {
        let input = r#"{"command":"Get-ChildItem .","description":"List files"}"#;

        assert_eq!(
            format_tool_use("PowerShell", input),
            "[Tool use: PowerShell] Get-ChildItem ."
        );
    }

    #[test]
    fn non_shell_tool_use_preview_keeps_json_input() {
        let input = r#"{"command":"cargo test"}"#;

        assert_eq!(
            format_tool_use("read", input),
            "[Tool use: read] {\"command\":\"cargo test\"}"
        );
        assert_eq!(format_running_tool_detail("read", input), "Running read");
    }

    #[test]
    fn running_activity_prefers_the_tool_description() {
        let input = r#"{"description":"Checking workspace health","command":"cargo check"}"#;

        assert_eq!(
            format_running_tool_activity("bash", input),
            "Checking workspace health"
        );
        assert_eq!(format_running_tool_activity("read", "{}"), "Running read");
    }

    #[test]
    fn agent_tool_previews_distinguish_parallel_tasks() {
        let input = r#"{"message":"共同规则。唯一任务：读取 Cargo.toml 并报告 workspace members"}"#;
        assert_eq!(
            format_running_tool("spawn_agent", input, false),
            "⟳ Running tool: spawn_agent - 读取 Cargo.toml 并报告 workspace members"
        );
        assert_eq!(
            format_running_tool_detail("spawn_agent", input),
            "Running 读取 Cargo.toml 并报告 workspace members"
        );
    }

    #[test]
    fn agent_tool_completion_uses_readable_task_and_result() {
        let output = r#"{"status":"completed","description":"General agent: 唯一任务：读取 README.md 标题","result":"标题是 KCoder"}"#;
        assert_eq!(
            format_tool_status("spawn_agent", output, false),
            "✓ Tool succeeded: spawn_agent - completed: 读取 README.md 标题 - 标题是 KCoder"
        );
    }

    #[test]
    fn shell_tool_use_preview_falls_back_for_non_json_input() {
        assert_eq!(
            format_tool_use("bash", "cargo test"),
            "[Tool use: bash] cargo test"
        );
    }

    #[test]
    fn ocr_running_tool_explains_preview_and_background_transition() {
        let preview_input = r#"{"command":"review","preview":true}"#;
        assert_eq!(
            format_tool_use("ocr", preview_input),
            "[Tool use: ocr] OCR review preview (scope only)"
        );
        assert_eq!(
            format_running_tool_detail("ocr", preview_input),
            "Running OCR review preview (scope only)"
        );

        let full_input = r#"{"command":"review","preview":false,"foregroundTimeoutSeconds":12}"#;
        assert_eq!(
            format_running_tool("ocr", full_input, false),
            "⟳ Running tool: ocr - OCR full review; moves to background after 12s if still running"
        );
        assert_eq!(
            format_running_tool_detail("ocr", full_input),
            "Running OCR full review; moves to background after 12s if still running"
        );
    }

    #[test]
    fn ocr_background_started_output_has_user_readable_status() {
        let output = r#"{"task_id":"job-ocr","task_type":"background_command","tool":"ocr","status":"running","next_action":"Use TaskOutput"}"#;

        assert_eq!(
            format_tool_status("ocr", output, false),
            "✓ Tool succeeded: ocr - OpenCodeReview moved to background as job-ocr; use TaskOutput to inspect it"
        );
    }

    #[test]
    fn background_task_tools_have_user_readable_status() {
        let output_input = r#"{"task_id":"job-123","block":false}"#;
        assert_eq!(
            format_tool_use("TaskOutput", output_input),
            "[Tool use: TaskOutput] check background task job-123"
        );

        let output = r#"{"retrieval_status":"not_ready","task":{"task_id":"job-123","task_type":"task","status":"in_progress","description":"ocr review","output":""}}"#;
        assert_eq!(
            format_tool_status("TaskOutput", output, false),
            "✓ Tool succeeded: TaskOutput - job-123 is still running; poll later or stop it"
        );

        let stop = r#"{"message":"Successfully stopped task: job-123","task_id":"job-123","task_type":"task","aborted_background_job":true}"#;
        assert_eq!(
            format_tool_status("TaskStop", stop, false),
            "✓ Tool succeeded: TaskStop - Successfully stopped task: job-123; job-123 is no longer running"
        );
    }

    #[test]
    fn tool_preview_truncates_without_splitting_graphemes() {
        let family = "👨‍👩‍👧‍👦";
        let text = format!("{}tail", family.repeat(TOOL_PREVIEW_CHARS));
        let preview = preview_tool_text(&text);

        assert_eq!(
            preview,
            format!("{}...", family.repeat(TOOL_PREVIEW_CHARS - 3))
        );
    }

    #[test]
    fn diff_summary_truncates_without_splitting_graphemes() {
        let family = "👨‍👩‍👧‍👦";
        let text = format!("{}tail", family.repeat(MAX_TOOL_DIFF_LINE_CHARS));
        let preview = truncate_chars(&text, MAX_TOOL_DIFF_LINE_CHARS);

        assert_eq!(
            preview,
            format!("{}...", family.repeat(MAX_TOOL_DIFF_LINE_CHARS - 3))
        );
    }

    #[test]
    fn tool_diff_uses_summary_and_indented_body() {
        let diff = format_tool_diff(
            "edit",
            "Edited src/lib.rs\n```diff\n@@ -1 +1 @@\n-old\n+new\n```",
        )
        .expect("diff should be extracted");

        assert_eq!(
            diff.lines().collect::<Vec<_>>(),
            vec![
                "[Tool diff: edit]",
                "• Edited src/lib.rs (+1 -1)",
                "    1 -old",
                "    1 +new"
            ]
        );
    }

    #[test]
    fn tool_diff_uses_add_block() {
        let diff = format_tool_diff(
            "write",
            "Wrote 11 bytes to new_file.txt\n```diff\n@@ -0,0 +1,2 @@\n+alpha\n+beta\n```",
        )
        .expect("diff should be extracted");

        assert_eq!(
            diff.lines().collect::<Vec<_>>(),
            vec![
                "[Tool diff: write]",
                "• Added new_file.txt (+2 -0)",
                "    1 +alpha",
                "    2 +beta"
            ]
        );
    }

    #[test]
    fn tool_diff_preserves_lsp_diagnostics_after_diff() {
        let diff = format_tool_diff(
            "write",
            "File created successfully at: src/lsp_case.py\n\
             ```diff\n\
             @@ -0,0 +1 @@\n\
             +result: int = takes_int(\"not-an-int\")\n\
             ```\n\n\
             <diagnostics source=\"lsp\" server=\"pyright\" file=\"src/lsp_case.py\">\n\
             ERROR [1:15] bad argument [reportArgumentType] (Pyright)\n\
             </diagnostics>",
        )
        .expect("diff and diagnostics should be extracted");

        assert!(diff.contains("[Tool diff: write]"));
        assert!(diff.contains("[Tool diagnostics: lsp]"));
        assert!(diff.contains("<diagnostics source=\"lsp\" server=\"pyright\""));
        assert!(diff.contains("reportArgumentType"));
    }

    #[test]
    fn tool_diff_uses_delete_block() {
        let diff = format_tool_diff(
            "edit",
            "Edited tmp_delete_example.txt\n```diff\n@@ -1,3 +0,0 @@\n-first\n-second\n-third\n```",
        )
        .expect("diff should be extracted");

        assert_eq!(
            diff.lines().collect::<Vec<_>>(),
            vec![
                "[Tool diff: edit]",
                "• Deleted tmp_delete_example.txt (+0 -3)",
                "    1 -first",
                "    2 -second",
                "    3 -third"
            ]
        );
    }

    #[test]
    fn tool_diff_uses_multiple_file_groups() {
        let diff = format_tool_diff(
            "edit",
            concat!(
                "Edited 2 files\n",
                "```diff\n",
                "diff --git a/a.txt b/a.txt\n",
                "index 1111111..2222222 100644\n",
                "--- a/a.txt\n",
                "+++ b/a.txt\n",
                "@@ -1 +1 @@\n",
                "-one\n",
                "+one changed\n",
                "diff --git a/b.txt b/b.txt\n",
                "new file mode 100644\n",
                "index 0000000..3333333\n",
                "--- /dev/null\n",
                "+++ b/b.txt\n",
                "@@ -0,0 +1 @@\n",
                "+new\n",
                "```",
            ),
        )
        .expect("diff should be extracted");

        assert_eq!(
            diff.lines().collect::<Vec<_>>(),
            vec![
                "[Tool diff: edit]",
                "• Edited 2 files (+2 -1)",
                "  └ a.txt (+1 -1)",
                "    1 -one",
                "    1 +one changed",
                "",
                "  └ b.txt (+1 -0)",
                "    1 +new",
            ]
        );
    }
}

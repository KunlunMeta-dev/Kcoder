use super::*;

pub(super) fn recent_completion_failure_evidence(ctx: &ToolContext) -> Option<String> {
    let mut inspected = 0usize;
    let messages = ctx.state.messages();
    let tool_names = collect_tool_use_names(&messages);
    let shell_commands = collect_shell_tool_use_commands(&messages);
    let verification_tool_uses = collect_verification_tool_use_ids(&messages);
    for message in messages.iter().rev() {
        let Message::User { content, .. } = message else {
            continue;
        };
        for block in content.iter().rev() {
            let ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
                ..
            } = block
            else {
                continue;
            };
            let tool_name = tool_names.get(tool_use_id).map(String::as_str);
            if tool_name == Some("update_goal") {
                continue;
            }
            inspected += 1;
            let text = content_blocks_text(content);
            let direct_shell_succeeded = successful_shell_tool_result(tool_name, *is_error, &text);
            let background_shell = successful_background_shell_result(tool_name, *is_error, &text);
            let shell_succeeded = direct_shell_succeeded || background_shell.is_some();
            let verification_succeeded = (direct_shell_succeeded
                && verification_tool_uses.contains(tool_use_id))
                || background_shell == Some(true);
            if verification_succeeded {
                return None;
            }
            let patterns = if shell_succeeded {
                Vec::new()
            } else {
                let search_no_match = tool_name == Some("bash")
                    && is_error == &Some(true)
                    && shell_commands.get(tool_use_id).is_some_and(|command| {
                        crate::bash::read_only_search_no_match_command(command)
                    })
                    && shell_result_is_empty_no_match(&text);
                goal_completion_failure_patterns(&text, search_no_match)
            };
            if !patterns.is_empty() {
                let mut reason = patterns.join(", ");
                if is_error.unwrap_or(false) {
                    reason.push_str("; tool_result.is_error=true");
                }
                return Some(format!("{reason}; preview: {}", preview(&text, 240)));
            }
            if inspected >= RECENT_COMPLETION_GATE_TOOL_RESULTS {
                return None;
            }
        }
    }
    None
}

pub(super) fn successful_shell_tool_result(
    tool_name: Option<&str>,
    is_error: Option<bool>,
    text: &str,
) -> bool {
    if is_error != Some(false) {
        return false;
    }

    match tool_name {
        Some("bash") => text.lines().any(|line| line.trim() == "exit_code: 0"),
        Some("PowerShell") => true,
        _ => false,
    }
}

pub(super) fn successful_background_shell_result(
    tool_name: Option<&str>,
    is_error: Option<bool>,
    text: &str,
) -> Option<bool> {
    if tool_name != Some("TaskOutput") || is_error != Some(false) {
        return None;
    }

    let value: Value = serde_json::from_str(text).ok()?;
    if value.get("retrieval_status")?.as_str()? != "success" {
        return None;
    }
    let task = value.get("task")?;
    if task.get("status")?.as_str()? != "completed" {
        return None;
    }
    let task_type = task.get("task_type")?.as_str()?;
    if !matches!(task_type, "bash" | "powershell") {
        return None;
    }
    let output = task.get("output")?.as_str()?;
    if task_type == "bash" && !output.lines().any(|line| line.trim() == "exit_code: 0") {
        return None;
    }

    let description = task
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let lowered_output = output.to_ascii_lowercase();
    let is_verification = crate::bash::verification_like_command(description)
        || description.to_ascii_lowercase().contains("test")
        || lowered_output.contains("expected failure")
        || lowered_output.contains("xfail")
        || lowered_output.contains("test result:");
    Some(is_verification)
}

pub(super) fn collect_tool_use_names(messages: &[Message]) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for message in messages {
        let Message::Assistant { content, .. } = message else {
            continue;
        };
        for block in content {
            if let ContentBlock::ToolUse { id, name, .. } = block {
                names.insert(id.clone(), name.clone());
            }
        }
    }
    names
}

pub(super) fn collect_verification_tool_use_ids(messages: &[Message]) -> HashSet<String> {
    let mut ids = HashSet::new();
    for message in messages {
        let Message::Assistant { content, .. } = message else {
            continue;
        };
        for block in content {
            let ContentBlock::ToolUse {
                id, name, input, ..
            } = block
            else {
                continue;
            };
            if !matches!(name.as_str(), "bash" | "PowerShell") {
                continue;
            }
            if input
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(crate::bash::verification_like_command)
            {
                ids.insert(id.clone());
            }
        }
    }
    ids
}

pub(super) fn collect_shell_tool_use_commands(messages: &[Message]) -> HashMap<String, String> {
    let mut commands = HashMap::new();
    for message in messages {
        let Message::Assistant { content, .. } = message else {
            continue;
        };
        for block in content {
            let ContentBlock::ToolUse {
                id, name, input, ..
            } = block
            else {
                continue;
            };
            if matches!(name.as_str(), "bash" | "PowerShell")
                && let Some(command) = input.get("command").and_then(Value::as_str)
            {
                commands.insert(id.clone(), command.to_string());
            }
        }
    }
    commands
}

pub(super) fn content_blocks_text(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

pub(super) fn goal_completion_failure_patterns(
    text: &str,
    ignore_nonzero_exit_code: bool,
) -> Vec<&'static str> {
    let mut patterns = Vec::new();
    let strong_patterns = [
        "Traceback (most recent call last)",
        "AssertionError",
        "thread 'main' panicked",
        "panicked at ",
        "failure_evidence:",
    ];
    for pattern in strong_patterns {
        if text.contains(pattern) {
            patterns.push(pattern);
        }
    }
    if !ignore_nonzero_exit_code && has_nonzero_exit_code(text) {
        patterns.push("nonzero exit_code");
    }
    patterns
}

pub(super) fn shell_result_is_empty_no_match(text: &str) -> bool {
    let exit_codes = text
        .lines()
        .filter_map(|line| line.trim().strip_prefix("exit_code:"))
        .map(str::trim)
        .collect::<Vec<_>>();
    exit_codes == ["1"]
        && text.contains("(no output)")
        && !text.contains("stdout:\n")
        && !text.contains("stderr:\n")
        && !text.contains("failure_evidence:")
        && !text.contains("Traceback (most recent call last)")
        && !text.contains("AssertionError")
        && !text.contains("panicked at ")
}

pub(super) fn has_nonzero_exit_code(text: &str) -> bool {
    text.lines().any(|line| {
        let Some(value) = line.trim().strip_prefix("exit_code:") else {
            return false;
        };
        let value = value.trim();
        !matches!(value, "0" | "null")
    })
}

pub(super) fn preview(text: &str, max_chars: usize) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= max_chars {
        normalized
    } else {
        format!(
            "{}...",
            normalized.chars().take(max_chars).collect::<String>()
        )
    }
}

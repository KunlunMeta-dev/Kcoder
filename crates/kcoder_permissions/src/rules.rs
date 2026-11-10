//! Rule evaluation and prompt details for one permission request.

use crate::{PermissionAudit, bash_command_matches};
use kcoder_config::{PermissionAction, PermissionMode, PermissionRule};
use serde_json::Value;
use tracing::warn;

/// Risk level surfaced in tool permission prompts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionRisk {
    None,
    Low,
    Medium,
    High,
}

impl PermissionRisk {
    /// Short user-facing label for the risk level.
    pub fn label(self) -> &'static str {
        match self {
            PermissionRisk::None => "safe",
            PermissionRisk::Low => "low risk",
            PermissionRisk::Medium => "medium risk",
            PermissionRisk::High => "high risk",
        }
    }
}

/// Enriched context for a tool permission prompt.
#[derive(Debug, Clone)]
pub struct PermissionRequestContext {
    pub tool_name: String,
    pub description: String,
    pub input: Value,
    pub risk: PermissionRisk,
    pub detail_lines: Vec<String>,
}

/// Decision produced by the permission engine for a single tool use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionDecision {
    Allow,
    Ask,
    Deny,
}

/// Tool metadata read lazily by the rule and prompt evaluators.
pub trait PermissionTool {
    fn name(&self) -> String;
    fn description(&self) -> String;
    fn is_builtin(&self) -> bool;
    fn is_read_only(&self) -> bool;
}

/// Borrowed policy for an evaluation. The caller owns all persistent and session state.
pub struct RuleEvaluation<'a> {
    pub mode: PermissionMode,
    pub allowed_tools: &'a [String],
    pub denied_tools: &'a [String],
    pub rules: &'a [PermissionRule],
    pub session_allowed: &'a [String],
    pub session_denied: &'a [String],
    pub session_rules: &'a [PermissionRule],
    pub session_allowed_shell_prefixes: &'a [String],
    pub audit: Option<&'a PermissionAudit>,
}

impl RuleEvaluation<'_> {
    /// Evaluate whether `tool` may be invoked with `input`.
    ///
    /// This does **not** interact with the user; it only applies rules and mode
    /// heuristics. Callers should prompt when [`PermissionDecision::Ask`] is
    /// returned.
    pub fn decide(&self, tool: &dyn PermissionTool, input: &Value) -> PermissionDecision {
        let name = tool.name();

        // 1. Session explicit denials take highest precedence.
        if self
            .session_denied
            .iter()
            .any(|d| matches_pattern(&name, d))
        {
            self.audit(&name, input, "session_deny_list");
            return PermissionDecision::Deny;
        }

        // 2. Persisted explicit denials cannot be bypassed by session allows.
        if self.denied_tools.iter().any(|d| matches_pattern(&name, d)) {
            self.audit(&name, input, "deny_list");
            return PermissionDecision::Deny;
        }

        // 3. Structured deny rules take precedence over all allow rules.
        if self.evaluate_rules_for_action(self.session_rules, &name, input, PermissionAction::Deny)
        {
            self.audit(&name, input, "session_rule_deny");
            return PermissionDecision::Deny;
        }
        if self.evaluate_rules_for_action(self.rules, &name, input, PermissionAction::Deny) {
            self.audit(&name, input, "rule_deny");
            return PermissionDecision::Deny;
        }

        // 4. Session explicit allows.
        if self
            .session_allowed
            .iter()
            .any(|a| matches_pattern(&name, a))
        {
            self.audit(&name, input, "session_allow_list");
            return PermissionDecision::Allow;
        }

        // 5. Persisted explicit allows.
        if self.allowed_tools.iter().any(|a| matches_pattern(&name, a)) {
            self.audit(&name, input, "allow_list");
            return PermissionDecision::Allow;
        }

        // 6. Structured allow rules.
        if self.evaluate_rules_for_action(self.session_rules, &name, input, PermissionAction::Allow)
        {
            self.audit(&name, input, "session_rule_allow");
            return PermissionDecision::Allow;
        }
        if self.evaluate_rules_for_action(self.rules, &name, input, PermissionAction::Allow) {
            self.audit(&name, input, "rule_allow");
            return PermissionDecision::Allow;
        }

        // 7. High-risk shell commands require confirmation in interactive
        // modes, but yolo/bypass must remain non-interactive and dont-ask
        // must deny through the mode heuristic below.
        if !self.mode.bypasses_prompts()
            && self.mode != PermissionMode::DontAsk
            && is_high_risk_tool_input(&name, input)
        {
            self.audit(&name, input, "high_risk_ask");
            return PermissionDecision::Ask;
        }

        // 8. Mode heuristic.
        let decision = match self.mode {
            PermissionMode::Bypass | PermissionMode::Yolo => PermissionDecision::Allow,
            PermissionMode::DontAsk => PermissionDecision::Deny,
            PermissionMode::Auto => {
                if self.is_effectively_read_only(tool, input) {
                    PermissionDecision::Allow
                } else {
                    PermissionDecision::Ask
                }
            }
            PermissionMode::AcceptEdits => {
                if self.is_effectively_read_only(tool, input)
                    || matches!(name.as_str(), "write" | "edit" | "apply_patch")
                {
                    PermissionDecision::Allow
                } else {
                    PermissionDecision::Ask
                }
            }
            PermissionMode::Ask => PermissionDecision::Ask,
        };

        self.audit(
            &name,
            input,
            match decision {
                PermissionDecision::Allow => "mode_allow",
                PermissionDecision::Deny => "mode_deny",
                PermissionDecision::Ask => "mode_ask",
            },
        );
        decision
    }

    /// Check envelope denials without granting execution or writing a synthetic decision audit.
    pub fn is_explicitly_denied(&self, name: &str, input: &Value) -> bool {
        self.session_denied
            .iter()
            .chain(self.denied_tools)
            .any(|pattern| matches_pattern(name, pattern))
            || self.evaluate_rules_for_action(
                self.session_rules,
                name,
                input,
                PermissionAction::Deny,
            )
            || self.evaluate_rules_for_action(self.rules, name, input, PermissionAction::Deny)
    }

    fn is_effectively_read_only(&self, tool: &dyn PermissionTool, input: &Value) -> bool {
        // Skill discovery/activation mutates only synchronized conversation
        // metadata and local usage telemetry. It is intentionally auto-
        // approvable so mandatory workflow skills remain usable in Auto mode,
        // while Tool::is_read_only still reports the state mutation accurately.
        if matches!(tool.name().as_str(), "skill" | "DiscoverSkills") {
            return true;
        }
        // Discovery changes only model exposure; it cannot invoke the found tools.
        if tool.name() == "tool_search" && tool.is_builtin() {
            return true;
        }
        if tool.is_read_only() {
            return true;
        }
        // Shell tools are classified from the complete command. A role-level
        // validation grant is accepted only when every chained/pipeline
        // segment is either globally inspection-only or matches one of the
        // caller-supplied prefixes.
        if matches!(tool.name().as_str(), "bash" | "BashTool") {
            return input
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(|command| {
                    classify_bash_read_only(command)
                        || classify_shell_with_allowed_prefixes(
                            command,
                            self.session_allowed_shell_prefixes,
                            false,
                        )
                });
        }
        if matches!(
            tool.name().as_str(),
            "PowerShell" | "powershell" | "PowerShellTool"
        ) {
            return input
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(|command| {
                    classify_powershell_read_only(command)
                        || classify_shell_with_allowed_prefixes(
                            command,
                            self.session_allowed_shell_prefixes,
                            true,
                        )
                });
        }
        // OpenCodeReview preview only lists the files/scope that would be
        // reviewed. A full review may transmit content to another provider.
        tool.name() == "ocr"
            && input
                .get("preview")
                .and_then(Value::as_bool)
                .unwrap_or(false)
    }

    fn evaluate_rules_for_action(
        &self,
        rules: &[PermissionRule],
        name: &str,
        input: &Value,
        action: PermissionAction,
    ) -> bool {
        for rule in rules {
            if rule.action != action {
                continue;
            }
            if !matches_pattern(name, &rule.tool) {
                continue;
            }
            if let Some(ref pat) = rule.input_pattern
                && !rule_input_pattern_matches(name, input, pat, action)
            {
                continue;
            }
            return true;
        }
        false
    }

    fn audit(&self, tool_name: &str, input: &Value, reason: &str) {
        if let Some(audit) = self.audit
            && let Err(e) = audit.record(tool_name, input, reason)
        {
            warn!("failed to queue permission audit: {}", e);
        }
    }
}

fn is_high_risk_tool_input(name: &str, input: &Value) -> bool {
    matches!(name, "bash" | "BashTool")
        && input
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|command| bash_risk(command) == PermissionRisk::High)
}

fn rule_input_pattern_matches(
    tool_name: &str,
    input: &Value,
    pattern: &str,
    action: PermissionAction,
) -> bool {
    if matches!(
        tool_name,
        "bash" | "BashTool" | "PowerShell" | "powershell" | "PowerShellTool"
    ) {
        let command = input.get("command").and_then(Value::as_str).map(str::trim);
        let expected = split_field_pattern(pattern)
            .and_then(|(field, expected)| (field == "command").then_some(expected))
            .unwrap_or(pattern)
            .trim();
        // Shell rules are evaluated per constituent command (tree-sitter
        // split): an allow rule is an authority grant and must cover every
        // constituent — or the full compound string exactly; a deny rule
        // fires on any matching constituent.
        return command.is_some_and(|command| {
            command == expected
                || bash_command_matches(expected, command, action == PermissionAction::Allow)
        });
    }
    input_pattern_matches(input, pattern)
}

fn input_pattern_matches(input: &Value, pattern: &str) -> bool {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return true;
    }

    if let Some((field, expected)) = split_field_pattern(pattern) {
        return value_at_path(input, field)
            .is_some_and(|value| scalar_value_contains(value, expected));
    }

    value_tree_contains(input, pattern)
}

fn split_field_pattern(pattern: &str) -> Option<(&str, &str)> {
    for separator in ['=', ':'] {
        let Some((field, expected)) = pattern.split_once(separator) else {
            continue;
        };
        let field = field.trim();
        let expected = expected.trim();
        if !field.is_empty()
            && !expected.is_empty()
            && field
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
        {
            return Some((field, expected));
        }
    }
    None
}

fn value_at_path<'a>(input: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = input;
    for part in path.split('.') {
        current = current.get(part)?;
    }
    Some(current)
}

fn value_tree_contains(value: &Value, pattern: &str) -> bool {
    match value {
        Value::String(_) | Value::Number(_) | Value::Bool(_) => {
            scalar_value_contains(value, pattern)
        }
        Value::Array(items) => items.iter().any(|item| value_tree_contains(item, pattern)),
        Value::Object(map) => map.values().any(|item| value_tree_contains(item, pattern)),
        Value::Null => false,
    }
}

fn scalar_value_contains(value: &Value, pattern: &str) -> bool {
    match value {
        Value::String(text) => text.contains(pattern),
        Value::Number(number) => number.to_string().contains(pattern),
        Value::Bool(boolean) => boolean.to_string().contains(pattern),
        _ => false,
    }
}

/// Build enriched permission-request context for a tool and its input.
///
/// This is used by interactive prompts to show tool-specific detail such as
/// the exact Bash command, a file-edit diff preview, or a write summary.
pub fn request_context_for(tool: &dyn PermissionTool, input: &Value) -> PermissionRequestContext {
    let name = tool.name();
    let risk = risk_for_tool_input(&name, input);
    let detail_lines = detail_lines_for_tool_input(&name, input);
    PermissionRequestContext {
        tool_name: name,
        description: tool.description(),
        input: input.clone(),
        risk,
        detail_lines,
    }
}

fn risk_for_tool_input(name: &str, input: &Value) -> PermissionRisk {
    match name {
        "bash" | "BashTool" => {
            if let Some(cmd) = input.get("command").and_then(|v| v.as_str()) {
                if classify_bash_read_only(cmd) {
                    return PermissionRisk::None;
                }
                return bash_risk(cmd);
            }
            PermissionRisk::Medium
        }
        "write" | "FileWriteTool" => PermissionRisk::Medium,
        "edit" | "FileEditTool" => PermissionRisk::High,
        "apply_patch" | "ApplyPatchTool" => PermissionRisk::High,
        "PowerShell" | "powershell" | "PowerShellTool" | "repl" | "REPLTool" => {
            if input
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(classify_powershell_read_only)
            {
                PermissionRisk::None
            } else {
                PermissionRisk::High
            }
        }
        "ocr" if input.get("preview").and_then(Value::as_bool) == Some(true) => {
            PermissionRisk::None
        }
        "ocr" => PermissionRisk::Medium,
        _ if name.starts_with("mcp:") || name.contains(':') => PermissionRisk::Medium,
        _ => PermissionRisk::Low,
    }
}

fn bash_risk(command: &str) -> PermissionRisk {
    let lowered = command.to_lowercase();
    let high = [
        "rm ",
        "rm -",
        "rm -rf",
        "sudo ",
        "mkfs",
        "fdisk",
        "dd ",
        "format",
        "> ",
        ">>",
        "| sh",
        "| bash",
        "curl",
        "wget",
        "docker system prune",
        "drop",
        "delete",
        "truncate",
        "destroy",
        "chmod -R",
        "chown -R",
    ];
    let medium = [
        "git push",
        "git reset",
        "git rebase",
        "git checkout",
        "git clean",
        "npm install",
        "yarn",
        "pnpm",
        "pip install",
        "cargo install",
        "make",
        "cmake",
        "docker build",
        "docker run",
        "kubectl",
    ];
    if high.iter().any(|h| lowered.contains(h)) {
        PermissionRisk::High
    } else if medium.iter().any(|m| lowered.contains(m)) {
        PermissionRisk::Medium
    } else {
        PermissionRisk::Low
    }
}

fn detail_lines_for_tool_input(name: &str, input: &Value) -> Vec<String> {
    match name {
        "bash" | "BashTool" => {
            if let Some(cmd) = input.get("command").and_then(|v| v.as_str()) {
                let mut lines = vec![format!("Command: {}", cmd)];
                if let Some(timeout) = input.get("timeout").and_then(|v| v.as_u64()) {
                    lines.push(format!("Timeout: {}s", timeout));
                }
                if classify_bash_read_only(cmd) {
                    lines.push("This command appears read-only.".to_string());
                } else if bash_risk(cmd) == PermissionRisk::High {
                    lines.push("This command may modify or destroy data.".to_string());
                }
                lines
            } else {
                vec!["No command provided.".to_string()]
            }
        }
        "edit" | "FileEditTool" => {
            let mut lines = Vec::new();
            if let Some(path) = input.get("file_path").and_then(|v| v.as_str()) {
                lines.push(format!("File: {}", path));
            }
            if let Some(old) = input.get("old_string").and_then(|v| v.as_str()) {
                let preview: String = old.lines().take(3).collect::<Vec<_>>().join("\n");
                lines.push(format!("Old:\n{}", preview));
            }
            if let Some(new) = input.get("new_string").and_then(|v| v.as_str()) {
                let preview: String = new.lines().take(3).collect::<Vec<_>>().join("\n");
                lines.push(format!("New:\n{}", preview));
            }
            if lines.len() <= 1 {
                lines.push("This edit will change file contents.".to_string());
            }
            lines
        }
        "apply_patch" | "ApplyPatchTool" => {
            let mut lines = Vec::new();
            if let Some(patch) = input.get("patch").and_then(|v| v.as_str()) {
                let paths = kcoder_tool_input::syntax::patch::patch_affected_paths(patch);
                if paths.is_empty() {
                    lines.push(
                        "Patch could not be parsed; review the raw patch text below.".to_string(),
                    );
                } else {
                    lines.push(format!("Files: {}", paths.join(", ")));
                }
                let preview: String = patch.lines().take(12).collect::<Vec<_>>().join("\n");
                lines.push(format!("Patch:\n{preview}"));
            } else {
                lines.push("No patch text provided.".to_string());
            }
            lines
        }
        "write" | "FileWriteTool" => {
            let mut lines = Vec::new();
            if let Some(path) = input.get("file_path").and_then(|v| v.as_str()) {
                lines.push(format!("File: {}", path));
            }
            if let Some(content) = input.get("content").and_then(|v| v.as_str()) {
                let len = content.len();
                let lines_count = content.lines().count();
                lines.push(format!("Will write {} bytes ({} lines).", len, lines_count));
            }
            if lines.is_empty() {
                lines.push("This will create or overwrite a file.".to_string());
            }
            lines
        }
        "powershell" | "PowerShellTool" => {
            if let Some(cmd) = input.get("command").and_then(|v| v.as_str()) {
                vec![format!("PowerShell: {}", cmd)]
            } else {
                vec!["PowerShell command pending.".to_string()]
            }
        }
        "repl" | "REPLTool" => {
            if let Some(code) = input.get("code").and_then(|v| v.as_str()) {
                vec![format!("REPL code: {}", code)]
            } else {
                vec!["REPL code pending.".to_string()]
            }
        }
        _ => {
            let pretty = serde_json::to_string_pretty(input).unwrap_or_default();
            let preview: String = pretty.lines().take(6).collect::<Vec<_>>().join("\n");
            if preview.is_empty() {
                vec!["No input provided.".to_string()]
            } else {
                vec![preview]
            }
        }
    }
}

fn matches_pattern(name: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        name.starts_with(prefix)
    } else {
        name == pattern
    }
}

/// Classify literal Bash arguments through the same inspection policy as restricted tools.
/// Unknown programs, options with auxiliary execution, and dynamic expressions require authorization.
pub fn classify_bash_read_only(command: &str) -> bool {
    kcoder_tool_input::syntax::shell::shell_command_is_read_only(command)
}

fn shell_segments(command: &str) -> Option<Vec<String>> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Some(Vec::new());
    }
    // This is deliberately not a shell parser. Any construct that can hide a
    // write or nested process is denied instead of being guessed safe.
    if trimmed.contains('>')
        || trimmed.contains("$(")
        || trimmed.contains("${")
        || trimmed.contains('`')
        || trimmed.contains("&>")
        || trimmed.contains("<(")
        || trimmed.contains(">(")
        || trimmed.replace("&&", "").contains('&')
    {
        return None;
    }
    let normalized = trimmed.replace("&&", ";").replace("||", ";");
    Some(
        normalized
            .split([';', '\n', '|'])
            .map(str::trim)
            .filter(|segment| !segment.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

fn classify_bash_read_only_segment(command: &str) -> bool {
    classify_bash_read_only(command)
}

/// Conservative classifier for read-only PowerShell inspection and validation
/// commands. Every pipeline/chained segment must be independently safe.
pub fn classify_powershell_read_only(command: &str) -> bool {
    // PowerShell evaluates parenthesized expressions, script blocks, the call
    // operator, and static .NET expressions inside otherwise harmless cmdlet
    // arguments. Reject those constructs rather than allowing wrappers such
    // as `Write-Output (Remove-Item victim)` to smuggle a mutation.
    if powershell_has_unsafe_nested_expression(command) {
        return false;
    }
    shell_segments(command).is_some_and(|segments| {
        segments.iter().all(|segment| {
            classify_bash_read_only_segment(segment)
                || [
                    "Get-Content",
                    "Get-ChildItem",
                    "Get-Location",
                    "Get-Item",
                    "Get-ItemProperty",
                    "Get-Command",
                    "Get-Date",
                    "Get-Process",
                    "Get-Service",
                    "Get-CimInstance",
                    "Test-Path",
                    "Measure-Object",
                    "Select-Object",
                    "Where-Object",
                    "Sort-Object",
                    "Group-Object",
                    "Format-Table",
                    "Format-List",
                    "Format-Wide",
                    "Format-Custom",
                    "Compare-Object",
                    "Resolve-Path",
                    "Split-Path",
                    "Join-Path",
                    "Write-Output",
                    "Write-Host",
                    "Out-String",
                    "dir",
                    "type",
                ]
                .iter()
                .any(|prefix| command_has_prefix(segment, prefix, true))
        })
    })
}

fn classify_shell_with_allowed_prefixes(
    command: &str,
    allowed_prefixes: &[String],
    case_insensitive: bool,
) -> bool {
    if !case_insensitive {
        return kcoder_tool_input::syntax::shell::scoped_shell_command_matches_allowed_prefixes(
            command,
            allowed_prefixes,
        );
    }
    !(allowed_prefixes.is_empty()
        || case_insensitive && powershell_has_unsafe_nested_expression(command))
        && shell_segments(command).is_some_and(|segments| {
            segments.iter().all(|segment| {
                classify_bash_read_only_segment(segment)
                    || allowed_prefixes
                        .iter()
                        .any(|prefix| command_has_prefix(segment, prefix, case_insensitive))
            })
        })
}

fn powershell_has_unsafe_nested_expression(command: &str) -> bool {
    command
        .chars()
        .any(|ch| matches!(ch, '(' | ')' | '{' | '}' | '[' | ']' | '&'))
        || command.contains("::")
}

fn command_has_prefix(command: &str, prefix: &str, case_insensitive: bool) -> bool {
    let (command, prefix) = if case_insensitive {
        (command.to_ascii_lowercase(), prefix.to_ascii_lowercase())
    } else {
        (command.to_string(), prefix.to_string())
    };
    command == prefix
        || command
            .strip_prefix(&prefix)
            .is_some_and(|rest| rest.chars().next().is_some_and(char::is_whitespace))
}

#[cfg(test)]
mod apply_patch_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn apply_patch_input_is_classified_high_risk() {
        assert_eq!(
            risk_for_tool_input("apply_patch", &json!({ "patch": "x" })),
            PermissionRisk::High
        );
    }

    #[test]
    fn apply_patch_approval_context_lists_affected_files() {
        let patch = "*** Begin Patch\n*** Add File: src/a.rs\n+fn a() {}\n*** End Patch\n";
        let lines = detail_lines_for_tool_input("apply_patch", &json!({ "patch": patch }));
        assert!(
            lines.iter().any(|line| line.contains("src/a.rs")),
            "lines: {lines:?}"
        );
        assert!(
            lines.iter().any(|line| line.contains("Begin Patch")),
            "lines: {lines:?}"
        );
    }
}

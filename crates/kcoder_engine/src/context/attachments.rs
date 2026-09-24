use kcoder_types::{ContentBlock, Message};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

const MAX_FILE_ATTACHMENT_CHARS: usize = 4_000;

/// Context that should be re-injected after a full compaction so the model
/// does not lose its bearings.
#[derive(Debug, Clone, Default)]
pub struct PostCompactAttachments {
    /// Text built from relevant memories.
    pub memory_text: String,
    /// Names of skills currently active in the session.
    pub active_skills: Vec<String>,
    /// Digest of project instruction files loaded at session start.
    pub project_md_digest: String,
    /// Optional instructions when operating in plan mode.
    pub plan_mode_instructions: Option<String>,
    /// Optional instructions injected by PostCompact hooks.
    pub post_compact_instructions: Option<String>,
    /// Trusted orchestration plan identity plus a bounded untrusted notepad tail.
    pub orchestrate_context: Option<String>,
}

impl PostCompactAttachments {
    /// Convert the attachments into user messages that will be prepended to the
    /// preserved recent history.
    pub fn into_messages(self) -> Vec<Message> {
        let mut messages = Vec::new();

        if !self.project_md_digest.is_empty() {
            messages.push(Message::runtime_text(format!(
                "Project instructions (KCODER.md):\n{}",
                self.project_md_digest
            )));
        }

        if let Some(instructions) = &self.post_compact_instructions {
            messages.push(Message::runtime_text(format!(
                "Additional instructions after compaction:\n{}",
                instructions
            )));
        }

        if let Some(context) = &self.orchestrate_context {
            messages.push(Message::runtime_text(format!(
                "Orchestrate resume point after compaction:\n{}",
                context
            )));
        }

        if !self.memory_text.is_empty() {
            messages.push(Message::runtime_text(format!(
                "Relevant memories:\n{}",
                self.memory_text
            )));
        }

        if !self.active_skills.is_empty() {
            let skills = self.active_skills.join(", ");
            messages.push(Message::runtime_text(format!(
                "Active skills: {}. Their loaded instructions remain context; additional activation is possible only if a corresponding tool is attached to the current request.",
                skills
            )));
        }

        if let Some(plan) = self.plan_mode_instructions {
            messages.push(Message::runtime_text(format!(
                "You are currently in plan mode. This is a runtime restriction, not a grant of model-callable mode controls; use only controls attached to the current request, otherwise mode changes belong to the user or host:\n{}",
                plan
            )));
        }

        messages
    }

    /// Generate a simple system-context message from memory and skills.
    pub fn summary_message(&self) -> Option<Message> {
        let mut parts = Vec::new();
        if !self.memory_text.is_empty() {
            parts.push(format!("Relevant memories:\n{}", self.memory_text));
        }
        if !self.active_skills.is_empty() {
            parts.push(format!("Active skills: {}", self.active_skills.join(", ")));
        }
        if !self.project_md_digest.is_empty() {
            parts.push(format!("Project instructions:\n{}", self.project_md_digest));
        }
        if let Some(instructions) = &self.post_compact_instructions {
            parts.push(format!("Additional instructions:\n{}", instructions));
        }
        if let Some(context) = &self.orchestrate_context {
            parts.push(format!("Orchestrate resume point:\n{context}"));
        }
        if parts.is_empty() {
            return None;
        }
        Some(Message::runtime_text(parts.join("\n\n")))
    }
}

/// Collect recent file-read content that should be restored after compaction.
///
/// This intentionally keeps a very small surface: only successful `read`
/// tool results are eligible, duplicate file paths collapse to the newest
/// result, and each attachment is capped. It restores the context users most
/// often expect after compaction without re-inflating the whole transcript.
pub fn collect_recent_file_attachments(
    messages: &[Message],
    max_files: usize,
    cwd: &Path,
) -> Vec<Message> {
    if max_files == 0 {
        return Vec::new();
    }

    let tool_uses = collect_tool_uses(messages);
    let mut seen_paths = HashSet::new();
    let mut attachments = Vec::new();

    for message in messages.iter().rev() {
        let Message::User { content, .. } = message else {
            continue;
        };

        for block in content.iter().rev() {
            let ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } = block
            else {
                continue;
            };
            if is_error.unwrap_or(false) {
                continue;
            }
            let Some(tool_use) = tool_uses.get(tool_use_id) else {
                continue;
            };
            if !is_file_read_tool(&tool_use.name) {
                continue;
            }

            let path = extract_file_path(&tool_use.input).unwrap_or_else(|| tool_use_id.clone());
            let identity = normalize_attachment_path(&path, cwd);
            let text = text_content(content).trim().to_string();
            if text == super::tool_storage::TOOL_RESULT_CLEARED_MESSAGE {
                // cleared means the latest real result was deliberately discarded and must hide older body text.
                seen_paths.insert(identity);
                continue;
            }
            if text.starts_with("File unchanged since last read.") {
                // unchanged is only a reference placeholder and may fall back to earlier real body text at the same path.
                continue;
            }
            if text.is_empty() || !seen_paths.insert(identity) {
                continue;
            }

            attachments.push(Message::runtime_text(format!(
                "Recent file read retained after compaction ({path}):\n{}",
                truncate_attachment(&text)
            )));
            if attachments.len() >= max_files {
                return attachments;
            }
        }
    }

    attachments
}

fn normalize_attachment_path(path: &str, cwd: &Path) -> PathBuf {
    let path = Path::new(path);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                }
            }
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

/// Build a message describing the set of tools available post-compact.
pub fn build_tools_delta_attachment(tool_names: &[String], _call_site: &str) -> Option<Message> {
    if tool_names.is_empty() {
        return None;
    }
    Some(Message::runtime_text(format!(
        "Available tools after compaction: {}",
        tool_names.join(", ")
    )))
}

#[derive(Debug, Clone)]
struct ToolUseInfo {
    name: String,
    input: serde_json::Value,
}

fn collect_tool_uses(messages: &[Message]) -> HashMap<String, ToolUseInfo> {
    let mut tool_uses = HashMap::new();
    for message in messages {
        let Message::Assistant { content, .. } = message else {
            continue;
        };
        for block in content {
            if let ContentBlock::ToolUse { id, name, input } = block {
                tool_uses.insert(
                    id.clone(),
                    ToolUseInfo {
                        name: name.clone(),
                        input: input.clone(),
                    },
                );
            }
        }
    }
    tool_uses
}

fn is_file_read_tool(name: &str) -> bool {
    matches!(name, "read" | "FileReadTool" | "file_read")
}

fn extract_file_path(input: &serde_json::Value) -> Option<String> {
    input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

fn text_content(content: &[ContentBlock]) -> String {
    let mut out = String::new();
    for block in content {
        let ContentBlock::Text { text } = block else {
            continue;
        };
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(text);
    }
    out
}

fn truncate_attachment(text: &str) -> String {
    let mut out = String::new();
    let mut chars = 0usize;
    let keep_chars = MAX_FILE_ATTACHMENT_CHARS.saturating_sub(3);

    for ch in text.chars() {
        if chars == MAX_FILE_ATTACHMENT_CHARS {
            out.truncate(
                out.char_indices()
                    .nth(keep_chars)
                    .map(|(idx, _)| idx)
                    .unwrap_or(out.len()),
            );
            out.push_str("...");
            return out;
        }
        out.push(ch);
        chars = chars.saturating_add(1);
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn compaction_restores_state_without_inventing_model_controls() {
        let attachments = super::PostCompactAttachments {
            active_skills: vec!["known-skill".into()],
            plan_mode_instructions: Some("Inspect only".into()),
            post_compact_instructions: Some("User text mentioning a custom_tool remains intact".into()),
            ..Default::default()
        };
        let messages = attachments.into_messages();
        let text = serde_json::to_string(&messages).unwrap();
        assert!(text.contains("known-skill"));
        assert!(text.contains("only if a corresponding tool is attached"));
        assert!(!text.contains("via the skill tool"));
        assert!(text.contains("mode changes belong to the user or host"));
        assert!(text.contains("custom_tool remains intact"));
    }

    use super::*;

    fn read_tool_use(id: &str, path: &str) -> Message {
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: id.to_string(),
                name: "read".to_string(),
                input: serde_json::json!({ "file_path": path }),
            }],
            usage: None,
        }
    }

    fn tool_result(id: &str, text: &str) -> Message {
        Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: id.to_string(),
                content: vec![ContentBlock::Text {
                    text: text.to_string(),
                }],
                is_error: Some(false),
            }],
        }
    }

    #[test]
    fn collects_recent_file_read_attachments() {
        let messages = vec![
            read_tool_use("call_1", "src/old.rs"),
            tool_result("call_1", "old content"),
            read_tool_use("call_2", "src/new.rs"),
            tool_result("call_2", "new content"),
        ];

        let attachments = collect_recent_file_attachments(&messages, 1, Path::new("/workspace"));

        assert_eq!(attachments.len(), 1);
        assert!(attachments[0].preview(200).contains("src/new.rs"));
        assert!(attachments[0].preview(200).contains("new content"));
    }

    #[test]
    fn skips_duplicate_paths_and_non_read_tools() {
        let messages = vec![
            read_tool_use("call_1", "src/lib.rs"),
            tool_result("call_1", "old content"),
            Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "call_2".to_string(),
                    name: "bash".to_string(),
                    input: serde_json::json!({ "command": "cat src/lib.rs" }),
                }],
                usage: None,
            },
            tool_result("call_2", "bash content"),
            read_tool_use("call_3", "src/lib.rs"),
            tool_result("call_3", "new content"),
        ];

        let attachments = collect_recent_file_attachments(&messages, 4, Path::new("/workspace"));

        assert_eq!(attachments.len(), 1);
        let preview = attachments[0].preview(400);
        assert!(preview.contains("new content"));
        assert!(!preview.contains("old content"));
        assert!(!preview.contains("bash content"));
    }

    #[test]
    fn unchanged_falls_back_but_cleared_hides_earlier_real_file_content() {
        let messages = vec![
            read_tool_use("call_1", "src/lib.rs"),
            tool_result("call_1", "actual source body"),
            read_tool_use("call_2", "src/lib.rs"),
            tool_result(
                "call_2",
                "File unchanged since last read. The earlier result is current.",
            ),
            read_tool_use("call_3", "src/cleared.rs"),
            tool_result("call_3", "stale cleared source body"),
            read_tool_use("call_4", "src/./cleared.rs"),
            tool_result(
                "call_4",
                super::super::tool_storage::TOOL_RESULT_CLEARED_MESSAGE,
            ),
        ];

        let attachments = collect_recent_file_attachments(&messages, 4, Path::new("/workspace"));

        assert_eq!(attachments.len(), 1);
        let preview = attachments[0].preview(400);
        assert!(preview.contains("src/lib.rs"));
        assert!(preview.contains("actual source body"));
        assert!(!preview.contains("src/cleared.rs"));
        assert!(!preview.contains("stale cleared source body"));
    }

    #[test]
    fn text_content_joins_text_blocks_without_intermediate_vec() {
        let content = vec![
            ContentBlock::Text {
                text: "alpha".to_string(),
            },
            ContentBlock::Thinking {
                thinking: "ignored".to_string(),
                signature: "sig".to_string(),
            },
            ContentBlock::Text {
                text: "beta".to_string(),
            },
        ];

        assert_eq!(text_content(&content), "alpha\nbeta");
    }

    #[test]
    fn truncate_attachment_keeps_exact_limit_unchanged() {
        let text = "x".repeat(MAX_FILE_ATTACHMENT_CHARS);

        assert_eq!(truncate_attachment(&text), text);
    }
}

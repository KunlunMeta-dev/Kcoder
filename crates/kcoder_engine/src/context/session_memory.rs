use super::TokenCounter;
use kcoder_config::SessionMemorySettings;
use kcoder_types::{ContentBlock, Message};
use std::collections::HashSet;

const COMPACT_SUMMARY_PREFIX: &str = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";
const LEGACY_COMPACT_SUMMARY_PREFIX: &str = "Earlier conversation summary:";

pub const DEFAULT_SESSION_MEMORY_TEMPLATE: &str = r#"# Session Title

_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State

_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task specification

_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions

_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow

_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections

_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation

_What are the important system components? How do they work/fit together?_

# Learnings

_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key results

_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog

_Step by step, what was attempted, done? Very terse summary for each step_
"#;

/// Build the model prompt used to refresh the per-session memory markdown.
///
/// The model sees the current notes plus a recent transcript slice and must
/// emit a complete replacement Markdown document. Raw thinking blocks and
/// inline image bytes are intentionally omitted from the transcript view.
pub fn build_session_memory_update_prompt(
    current_notes: Option<&str>,
    messages: &[Message],
) -> String {
    let notes = current_notes
        .map(str::trim)
        .filter(|notes| !notes.is_empty())
        .unwrap_or(DEFAULT_SESSION_MEMORY_TEMPLATE);
    let transcript = messages
        .iter()
        .map(message_to_session_memory_transcript)
        .collect::<Vec<_>>()
        .join("\n\n");

    format!(
        "CRITICAL: This is an internal session-memory maintenance task, not a user conversation.\n\
         Do NOT mention note-taking to the user. Do NOT call tools. Respond with TEXT ONLY.\n\n\
         Update the session memory markdown so a future model can safely resume after older chat \
         history is dropped. Preserve every existing section heading and italic description line. \
         Keep each section concise, but make the Current State explicit and actionable. Do not \
         include raw assistant thinking; summarize only visible outcomes, tool intent/results, \
         user constraints, files, commands, errors, decisions, and next steps.\n\n\
         Return the complete markdown document inside <session_memory>...</session_memory>.\n\n\
         <current_notes_content>\n{}\n</current_notes_content>\n\n\
         <recent_transcript>\n{}\n</recent_transcript>",
        notes, transcript
    )
}

pub fn extract_session_memory_markdown(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(memory) = extract_tagged_section(trimmed, "session_memory") {
        return memory.trim().to_string();
    }
    strip_tagged_section(trimmed, "analysis").trim().to_string()
}

pub fn session_memory_has_required_sections(markdown: &str) -> bool {
    const REQUIRED: &[&str] = &[
        "# Session Title",
        "# Current State",
        "# Task specification",
        "# Files and Functions",
        "# Workflow",
        "# Errors & Corrections",
        "# Codebase and System Documentation",
        "# Learnings",
        "# Key results",
        "# Worklog",
    ];

    let mut required = REQUIRED.iter();
    let Some(mut expected) = required.next() else {
        return true;
    };
    let mut in_fence = false;

    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if trimmed == *expected {
            match required.next() {
                Some(next) => expected = next,
                None => return true,
            }
        }
    }

    false
}

#[derive(Debug, Clone)]
pub struct SessionMemoryCompactionPlan {
    pub messages: Vec<Message>,
    pub suffix_start: usize,
    pub preserved_start: usize,
}

pub fn build_session_memory_compacted_messages(
    summary: &str,
    messages: &[Message],
    settings: &SessionMemorySettings,
    summarized_message_count: Option<usize>,
) -> Option<Vec<Message>> {
    build_session_memory_compaction_plan(summary, messages, settings, summarized_message_count)
        .map(|plan| plan.messages)
}

pub fn build_session_memory_compaction_plan(
    summary: &str,
    messages: &[Message],
    settings: &SessionMemorySettings,
    summarized_message_count: Option<usize>,
) -> Option<SessionMemoryCompactionPlan> {
    let summary = summary.trim();
    if summary.chars().count() < settings.compact_min_chars {
        return None;
    }

    let suffix_start = latest_summary_suffix_start(messages);
    let suffix = &messages[suffix_start..];
    if suffix.is_empty() {
        return None;
    }

    let mut recent_start = select_recent_window_start(suffix, settings);
    if let Some(summarized_message_count) = summarized_message_count {
        let must_preserve_from = summarized_message_count
            .saturating_sub(suffix_start)
            .min(suffix.len());
        recent_start = recent_start.min(must_preserve_from);
    }
    recent_start = normalize_recent_window_start(suffix, recent_start);
    if recent_start == 0 {
        return None;
    }

    let mut compacted = Vec::with_capacity(suffix.len() - recent_start + 1);
    compacted.push(Message::user_text(format_session_memory_compact_summary(
        summary,
    )));
    compacted.extend(strip_assistant_usage(&suffix[recent_start..]));
    Some(SessionMemoryCompactionPlan {
        messages: compacted,
        suffix_start,
        preserved_start: recent_start,
    })
}

pub fn select_recent_window_start(messages: &[Message], settings: &SessionMemorySettings) -> usize {
    if messages.is_empty() {
        return 0;
    }

    let min_tokens = settings.compact_min_recent_tokens;
    let max_tokens = settings
        .compact_max_recent_tokens
        .max(settings.compact_min_recent_tokens);
    let min_text_messages = settings.compact_min_recent_messages;

    let mut start = messages.len();
    let mut tokens = 0usize;
    let mut text_messages = 0usize;

    for index in (0..messages.len()).rev() {
        // Usage-bearing assistant messages must not be measured through
        // `TokenCounter::count`: its anchor logic would count the whole
        // historical prompt for this one message.
        let message_tokens = TokenCounter::estimate_single_message(&messages[index]);
        if tokens >= min_tokens && text_messages >= min_text_messages {
            break;
        }

        start = index;
        tokens = tokens.saturating_add(message_tokens);
        if message_has_visible_text(&messages[index]) {
            text_messages = text_messages.saturating_add(1);
        }
        if tokens >= min_tokens && text_messages >= min_text_messages && tokens >= max_tokens {
            break;
        }
    }

    normalize_recent_window_start(messages, start)
}

fn latest_summary_suffix_start(messages: &[Message]) -> usize {
    messages
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, message)| {
            let Message::User { content } = message else {
                return None;
            };
            let ContentBlock::Text { text } = content.first()? else {
                return None;
            };
            text.strip_prefix(COMPACT_SUMMARY_PREFIX)
                .or_else(|| text.strip_prefix(LEGACY_COMPACT_SUMMARY_PREFIX))?;
            Some(index + 1)
        })
        .unwrap_or(0)
}

fn format_session_memory_compact_summary(summary: &str) -> String {
    format!(
        "{}\n\nSession memory compact:\n{}\n\nRecent messages are preserved verbatim.\nContinue the conversation from where it left off without asking the user any further questions. Resume directly - do not acknowledge the summary, do not recap what was happening, do not preface with \"I'll continue\" or similar. Pick up the last task as if the break never happened.",
        COMPACT_SUMMARY_PREFIX,
        summary.trim()
    )
}

fn expand_start_for_tool_pairs(messages: &[Message], mut start: usize) -> usize {
    if start >= messages.len() {
        return start;
    }

    loop {
        let missing_tool_use_ids = tool_results_requiring_prior_uses(&messages[start..]);
        if missing_tool_use_ids.is_empty() {
            return start;
        }

        let mut expanded = start;
        for index in (0..start).rev() {
            if message_defines_any_tool_use(&messages[index], &missing_tool_use_ids) {
                expanded = expanded.min(index);
            }
        }

        if expanded == start {
            return start;
        }
        start = expanded;
    }
}

fn normalize_recent_window_start(messages: &[Message], start: usize) -> usize {
    let start = expand_start_to_user_turn_boundary(messages, start);
    expand_start_for_tool_pairs(messages, start)
}

fn expand_start_to_user_turn_boundary(messages: &[Message], start: usize) -> usize {
    if start == 0 || start >= messages.len() {
        return start;
    }
    if is_real_user_request_message(&messages[start]) {
        return start;
    }

    for index in (0..start).rev() {
        if is_real_user_request_message(&messages[index]) {
            return index;
        }
    }
    start
}

fn is_real_user_request_message(message: &Message) -> bool {
    let Message::User { content } = message else {
        return false;
    };
    if content
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolResult { .. }))
    {
        return false;
    }

    content.iter().any(|block| match block {
        ContentBlock::Text { text } => {
            let text = text.trim_start();
            !text.trim().is_empty() && !is_internal_context_text(text)
        }
        ContentBlock::Image { .. } => true,
        _ => false,
    })
}

fn is_internal_context_text(text: &str) -> bool {
    const INTERNAL_PREFIXES: &[&str] = &[
        COMPACT_SUMMARY_PREFIX,
        LEGACY_COMPACT_SUMMARY_PREFIX,
        "Project instructions (",
        "Project instructions:",
        "Additional instructions after compaction:",
        "Additional instructions:",
        "Relevant memories:",
        "Active skills:",
        "You are currently in plan mode:",
        "Recent file read retained after compaction (",
        "Available tools after compaction:",
    ];

    INTERNAL_PREFIXES
        .iter()
        .any(|prefix| text.starts_with(prefix))
}

fn tool_results_requiring_prior_uses(messages: &[Message]) -> HashSet<String> {
    let mut seen_uses = HashSet::new();
    let mut missing = HashSet::new();

    for message in messages {
        match message {
            Message::Assistant { content, .. } => {
                for block in content {
                    if let ContentBlock::ToolUse { id, .. } = block {
                        seen_uses.insert(id.clone());
                    }
                }
            }
            Message::User { content } => {
                for block in content {
                    if let ContentBlock::ToolResult { tool_use_id, .. } = block
                        && !seen_uses.contains(tool_use_id)
                    {
                        missing.insert(tool_use_id.clone());
                    }
                }
            }
        }
    }

    missing
}

fn message_defines_any_tool_use(message: &Message, ids: &HashSet<String>) -> bool {
    let Message::Assistant { content, .. } = message else {
        return false;
    };
    content
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolUse { id, .. } if ids.contains(id)))
}

pub(crate) fn strip_assistant_usage(messages: &[Message]) -> Vec<Message> {
    messages
        .iter()
        .cloned()
        .map(|message| match message {
            Message::Assistant { content, .. } => Message::Assistant {
                content,
                usage: None,
            },
            other => other,
        })
        .collect()
}

fn message_has_visible_text(message: &Message) -> bool {
    let blocks = match message {
        Message::User { content } => content,
        Message::Assistant { content, .. } => content,
    };
    blocks
        .iter()
        .any(|block| matches!(block, ContentBlock::Text { text } if !text.trim().is_empty()))
}

fn message_to_session_memory_transcript(message: &Message) -> String {
    match message {
        Message::User { content } => format!("User: {}", content_blocks_for_memory(content)),
        Message::Assistant { content, .. } => {
            format!("Assistant: {}", content_blocks_for_memory(content))
        }
    }
}

fn content_blocks_for_memory(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .map(|block| match block {
            ContentBlock::Text { text } => text.clone(),
            ContentBlock::ToolUse { id, name, input } => {
                format!("[Tool use {id}: {name} with {input}]")
            }
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                let text = content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<String>();
                let status = if is_error.unwrap_or(false) {
                    "error"
                } else {
                    "ok"
                };
                format!("[Tool result {tool_use_id}: {status}] {text}")
            }
            ContentBlock::Image { source } => format!("[Image: {}]", source.media_type),
            ContentBlock::Thinking { .. } => "[assistant thinking omitted]".to_string(),
            ContentBlock::RedactedThinking { .. } => "[redacted thinking]".to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_tagged_section<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let rest = &text[start..];
    let end = rest.find(&close)?;
    Some(&rest[..end])
}

fn strip_tagged_section(text: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let Some(start) = text.find(&open) else {
        return text.to_string();
    };
    let Some(close_rel) = text[start..].find(&close) else {
        return text.to_string();
    };
    let end = start + close_rel + close.len();
    let mut out = String::new();
    out.push_str(text[..start].trim_end());
    if !out.is_empty() && !text[end..].trim_start().is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(text[end..].trim_start());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::Usage;
    use serde_json::json;

    #[test]
    fn update_prompt_omits_raw_thinking_and_image_bytes() {
        let image = ContentBlock::Image {
            source: kcoder_types::ImageSource::base64("image/png", "SECRET_BYTES"),
        };
        let messages = vec![Message::Assistant {
            content: vec![
                ContentBlock::Thinking {
                    thinking: "private chain of thought".to_string(),
                    signature: "sig".to_string(),
                },
                image,
                ContentBlock::Text {
                    text: "visible answer".to_string(),
                },
            ],
            usage: None,
        }];

        let prompt = build_session_memory_update_prompt(None, &messages);

        assert!(prompt.contains("[assistant thinking omitted]"));
        assert!(prompt.contains("[Image: image/png]"));
        assert!(prompt.contains("visible answer"));
        assert!(!prompt.contains("private chain of thought"));
        assert!(!prompt.contains("SECRET_BYTES"));
    }

    #[test]
    fn extracts_tagged_session_memory() {
        let raw = "<analysis>scratch</analysis><session_memory># Session Title\n\nUpdated</session_memory>";
        assert_eq!(
            extract_session_memory_markdown(raw),
            "# Session Title\n\nUpdated"
        );
    }

    #[test]
    fn session_memory_compact_uses_summary_and_preserves_recent_tail() {
        let settings = SessionMemorySettings {
            compact_min_chars: 3,
            compact_min_recent_tokens: 1,
            compact_max_recent_tokens: 100,
            compact_min_recent_messages: 2,
            ..SessionMemorySettings::default()
        };
        let messages = vec![
            Message::user_text("old user"),
            Message::assistant_text("old assistant"),
            Message::user_text("recent user"),
            Message::Assistant {
                content: vec![ContentBlock::Text {
                    text: "recent assistant".to_string(),
                }],
                usage: Some(Usage {
                    input_tokens: 10,
                    output_tokens: 20,
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: None,
                    total_tokens: None,
                    iterations: None,
                }),
            },
        ];

        let compacted =
            build_session_memory_compacted_messages("remember this", &messages, &settings, None)
                .expect("should compact");

        assert_eq!(compacted.len(), 3);
        assert!(compacted[0].preview(200).contains("Session memory compact"));
        assert!(
            !compacted
                .iter()
                .any(|message| message.preview(200) == "old user")
        );
        match &compacted[2] {
            Message::Assistant { usage, .. } => assert!(usage.is_none()),
            _ => panic!("expected assistant"),
        }
    }

    #[test]
    fn recent_window_expands_to_include_missing_tool_use() {
        let settings = SessionMemorySettings {
            compact_min_recent_tokens: 1,
            compact_max_recent_tokens: 10,
            compact_min_recent_messages: 0,
            ..SessionMemorySettings::default()
        };
        let messages = vec![
            Message::user_text("old user"),
            Message::assistant_text("old assistant"),
            Message::user_text("recent user requesting a file read"),
            Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "tool-1".to_string(),
                    name: "read".to_string(),
                    input: json!({"file": "a"}),
                }],
                usage: None,
            },
            Message::User {
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "tool-1".to_string(),
                    content: vec![ContentBlock::Text {
                        text: "result".to_string(),
                    }],
                    is_error: None,
                }],
            },
        ];

        let start = select_recent_window_start(&messages, &settings);

        assert_eq!(start, 2);
    }

    #[test]
    fn recent_window_starts_at_user_turn_boundary_before_assistant_tail() {
        let settings = SessionMemorySettings {
            compact_min_recent_tokens: 1,
            compact_max_recent_tokens: 100,
            compact_min_recent_messages: 1,
            ..SessionMemorySettings::default()
        };
        let messages = vec![
            Message::user_text("older alpha"),
            Message::assistant_text("older alpha ack"),
            Message::user_text("recent delta user"),
            Message::assistant_text("recent delta assistant"),
        ];

        let start = select_recent_window_start(&messages, &settings);

        assert_eq!(start, 2);
    }

    #[test]
    fn recent_window_treats_runtime_injections_as_part_of_prior_user_turn() {
        let settings = SessionMemorySettings {
            compact_min_recent_tokens: 1,
            compact_max_recent_tokens: 100,
            compact_min_recent_messages: 1,
            ..SessionMemorySettings::default()
        };
        let messages = vec![
            Message::user_text("real user request"),
            Message::assistant_text("assistant response"),
            Message::user_text("Project instructions (KCODER.md):\n# Project Instructions"),
        ];

        let start = select_recent_window_start(&messages, &settings);

        assert_eq!(start, 0);
    }

    #[test]
    fn recent_window_skips_internal_context_attachments_as_turn_boundaries() {
        let settings = SessionMemorySettings {
            compact_min_recent_tokens: 1,
            compact_max_recent_tokens: 100,
            compact_min_recent_messages: 1,
            ..SessionMemorySettings::default()
        };
        let attachments = [
            "Additional instructions after compaction:\nkeep going",
            "Relevant memories:\nremember alpha",
            "Active skills: using-superpowers. You may continue to use them via the skill tool.",
            "You are currently in plan mode:\nthink first",
            "Recent file read retained after compaction (/tmp/a):\ncontents",
            "Available tools after compaction: read, bash",
        ];

        for attachment in attachments {
            let messages = vec![
                Message::user_text("real user request"),
                Message::assistant_text("assistant response"),
                Message::user_text(attachment),
            ];

            let start = select_recent_window_start(&messages, &settings);

            assert_eq!(
                start, 0,
                "attachment was treated as user turn: {attachment}"
            );
        }
    }

    #[test]
    fn session_memory_markdown_requires_all_claude_sections() {
        assert!(session_memory_has_required_sections(
            DEFAULT_SESSION_MEMORY_TEMPLATE
        ));
        assert!(!session_memory_has_required_sections(
            "# Session Title\n\n# Current State"
        ));
        assert!(!session_memory_has_required_sections(
            "```md\n# Session Title\n# Current State\n# Task specification\n# Files and Functions\n# Workflow\n# Errors & Corrections\n# Codebase and System Documentation\n# Learnings\n# Key results\n# Worklog\n```"
        ));
    }

    #[test]
    fn compact_preserves_messages_newer_than_session_memory_snapshot() {
        let settings = SessionMemorySettings {
            compact_min_chars: 3,
            compact_min_recent_tokens: 1,
            compact_max_recent_tokens: 100,
            compact_min_recent_messages: 1,
            ..SessionMemorySettings::default()
        };
        let messages = vec![
            Message::user_text("summarized old user"),
            Message::assistant_text("summarized old assistant"),
            Message::user_text("not yet summarized user"),
            Message::assistant_text("not yet summarized assistant"),
            Message::user_text("latest user"),
            Message::assistant_text("latest assistant"),
        ];

        let compacted =
            build_session_memory_compacted_messages("remember this", &messages, &settings, Some(2))
                .expect("should compact");
        let text = compacted
            .iter()
            .map(|message| message.preview(200))
            .collect::<Vec<_>>()
            .join("\n");

        assert!(!text.contains("summarized old user"));
        assert!(text.contains("not yet summarized user"));
        assert!(text.contains("latest assistant"));
    }
}

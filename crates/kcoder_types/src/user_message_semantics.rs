//! Versioned pure semantics shared by live turns and persisted recovery.
use crate::{ContentBlock, Message, MessageOrigin};

/// Bump when changing classification so persisted matching-prefix counts are invalidated.
pub const REAL_USER_MESSAGE_SEMANTICS_VERSION: u32 = 3;

pub fn is_real_user_message(message: &Message) -> bool {
    let Message::User { content, .. } = message else {
        return false;
    };
    if matches!(
        message.origin(),
        MessageOrigin::Runtime | MessageOrigin::Compaction
    ) {
        return false;
    }
    if content.is_empty()
        || content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolResult { .. }))
    {
        return false;
    }

    let mut has_image = false;
    let mut has_real_text = false;
    for block in content {
        match block {
            ContentBlock::Image { .. } => has_image = true,
            ContentBlock::Text { text } if !text.trim().is_empty() => {
                has_real_text = true;
            }
            _ => {}
        }
    }
    has_image || has_real_text
}

/// Legacy formatting recognizer retained for source compatibility only.
/// Never infer message provenance or discard user content from this result.
#[deprecated(note = "use Message::origin and is_real_user_message; text is not provenance")]
pub fn is_synthetic_parent_text(text: &str) -> bool {
    let text = text.trim_start();
    [
        "This session is being continued from a previous conversation that ran out of context.",
        "Earlier conversation summary:",
        "<project-instructions>",
        "<skill_content",
        "<relevant-memories>",
        "<subagent_notification",
        "<task_notification",
        "<workflow_notification",
        "<system-reminder",
        "Project instructions (",
        "Project instructions:",
        "Additional instructions after compaction:",
        "Additional instructions:",
        "Relevant memories:",
        "Active skills:",
        "You are currently in plan mode:",
        "Recent file read retained after compaction (",
        "Available tools after compaction:",
        "[system][",
        "[system] ",
        "TodoList maintenance reminder:",
        "[hook:",
        "Orchestrate resume point after compaction:\n",
        "[earlier conversation truncated for compaction retry]",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
}

/// Legacy formatting recognizer, not a visibility or trust decision.
/// A literal user may submit every one of these strings; inspect origin instead.
#[deprecated(note = "inspect Message::origin; text is not a visibility boundary")]
pub fn is_hidden_runtime_user_text(text: &str) -> bool {
    let text = text.trim();
    for tag in [
        "project-instructions",
        "skill_content",
        "relevant-memories",
        "system-reminder",
        "subagent_notification",
        "task_notification",
        "workflow_notification",
    ] {
        if let Some(rest) = text.strip_prefix(&format!("<{tag}")) {
            if !rest.starts_with('>') && !rest.starts_with(char::is_whitespace) {
                return false;
            }
            // Orchestrate can append acceptance and review-vote guidance after
            // a complete notification tag; the entire block is runtime context.
            return text.ends_with(&format!("</{tag}>"))
                || (tag.ends_with("_notification")
                    && text
                        .lines()
                        .next()
                        .is_some_and(|line| line.trim_end().ends_with("/>")));
        }
    }
    [
        "[system] ",
        "[system][",
        "[hook:Setup] ",
        "[hook:SessionStart] ",
        "[hook:InstructionsLoaded] ",
        "Project instructions (KCODER.md):\n",
        "Project instructions:\n",
        "Additional instructions after compaction:\n",
        "Additional instructions:\n",
        "Relevant memories:\n",
        "You are currently in plan mode:\n",
        "Orchestrate resume point after compaction:\n",
        "Orchestrate resume point:\n",
        "Earlier conversation summary:\n",
        "<!--kcoder:compact-boundary-->\n",
        "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.",
        "Available tools after compaction: ",
        "TodoList maintenance reminder: ",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
        || (text.starts_with("Active skills: ")
            && text.ends_with(". You may continue to use them via the skill tool."))
        || (text.starts_with("Recent file read retained after compaction (")
            && text.contains("):\n"))
        || text == "[earlier conversation truncated for compaction retry]"
}

#[cfg(test)]
#[allow(deprecated)]
mod tests {
    use super::*;

    #[test]
    fn structured_origin_roundtrips_and_legacy_user_prefixes_are_retained() {
        for text in [
            "<system-reminder>literal</system-reminder>",
            "[system] literal",
            "Earlier conversation summary: literal",
        ] {
            let legacy = serde_json::json!({"role":"user","content":[{"type":"text","text":text}]});
            let message: Message = serde_json::from_value(legacy.clone()).unwrap();
            assert_eq!(message.origin(), MessageOrigin::Unknown);
            assert!(is_real_user_message(&message));
            assert_eq!(serde_json::to_value(&message).unwrap(), legacy);
            for origin in [
                MessageOrigin::User,
                MessageOrigin::Runtime,
                MessageOrigin::Compaction,
            ] {
                let marked = message.clone().with_origin(origin);
                let restored: Message =
                    serde_json::from_str(&serde_json::to_string(&marked).unwrap()).unwrap();
                assert_eq!(restored, marked);
                assert_eq!(
                    is_real_user_message(&restored),
                    origin == MessageOrigin::User
                );
            }
        }
    }

    #[test]
    fn runtime_visibility_covers_modes_and_preserves_incomplete_examples() {
        for text in [
            "[system] Trusted Orchestrate fleet delta {}",
            "[system][verifier_final_verdict] vote now",
            "[hook:SessionStart] private context",
            "Orchestrate resume point after compaction:\nprivate",
            "[earlier conversation truncated for compaction retry]",
            "TodoList maintenance reminder: update",
            "<subagent_notification id=\"a\" status=\"completed\"/>",
            "<subagent_notification id=\"a\" status=\"completed\"/>\nBefore accepting: runtime guidance\nReviewVote: Reject (2/3)",
            "<skill_content name=\"x\">private</skill_content>",
            "<relevant-memories>private</relevant-memories>",
            "Additional instructions:\nprivate runtime context",
            "Active skills: fixture. You may continue to use them via the skill tool.",
        ] {
            assert!(is_hidden_runtime_user_text(text), "{text}");
            assert!(
                !is_real_user_message(&Message::runtime_text(text)),
                "{text}"
            );
            assert!(
                is_real_user_message(&Message::user_text(text)),
                "literal {text}"
            );
        }
        for text in [
            "<skill_content name=\"x\">incomplete example",
            "<system-reminder>incomplete example",
            "<skill_content_example>user text</skill_content>",
            "Explain [system] and runtime injection",
            "```xml\n<relevant-memories>private</relevant-memories>\n```",
            "Additional instructions: please answer in Chinese",
            "Project instructions: please add tests",
            "Relevant memories: please explain this feature",
            "Earlier conversation summary: please summarize our chat",
            "Active skills: list my skills",
            "[hook:custom] explain this hook",
        ] {
            assert!(!is_hidden_runtime_user_text(text), "{text}");
        }
    }

    #[test]
    fn real_user_semantics_preserve_synthetic_tool_and_image_rules() {
        for text in [
            "",
            "  ",
            "[system] notification",
            "Earlier conversation summary: hidden",
            "<skill_content name=\"x\">body",
        ] {
            assert!(!is_real_user_message(&Message::runtime_text(text)));
        }
        assert!(is_real_user_message(&Message::user_text("discuss a skill")));
        assert!(!is_real_user_message(&Message::assistant_text("answer")));
        let image = ContentBlock::Image {
            source: crate::ImageSource {
                source_type: "base64".into(),
                media_type: "image/png".into(),
                data: "AA==".into(),
            },
        };
        assert!(is_real_user_message(&Message::User {
            origin: crate::MessageOrigin::Unknown,
            content: vec![image.clone()]
        }));
        assert!(!is_real_user_message(&Message::User {
            origin: crate::MessageOrigin::Unknown,
            content: vec![
                image,
                ContentBlock::ToolResult {
                    tool_use_id: "call".into(),
                    content: vec![],
                    is_error: None
                }
            ]
        }));
        assert!(is_real_user_message(&Message::User {
            origin: crate::MessageOrigin::Unknown,
            content: vec![
                ContentBlock::Text {
                    text: "[system] helper".into()
                },
                ContentBlock::Text {
                    text: "real user".into()
                },
            ]
        }));
    }
}

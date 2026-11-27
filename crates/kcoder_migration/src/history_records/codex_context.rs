//! Match the pinned producer's framing rules, without treating them as current authority.
use super::*;
use crate::history_json::Text;
use serde::Deserialize;
use sha2::{Digest, Sha256};

const MARKERS: [(&str, &str); 7] = [
    ("# AGENTS.md instructions", "</INSTRUCTIONS>"),
    ("<environment_context>", "</environment_context>"),
    (
        "<agent_message_board_notification>",
        "</agent_message_board_notification>",
    ),
    ("<skills_instructions>", "</skills_instructions>"),
    ("<user_shell_command>", "</user_shell_command>"),
    ("<turn_aborted>", "</turn_aborted>"),
    ("<subagent_notification>", "</subagent_notification>"),
];

fn framed(text: &Text, open: &str, close: &str) -> bool {
    text.trimmed_head
        .get(..open.len())
        .is_some_and(|value| value.eq_ignore_ascii_case(open))
        && text
            .trimmed_tail
            .get(text.trimmed_tail.len().saturating_sub(close.len())..)
            .is_some_and(|value| value.eq_ignore_ascii_case(close))
}

#[derive(Deserialize)]
#[serde(rename = "hook_prompt")]
struct Hook {
    #[serde(rename = "@hook_run_id")]
    id: String,
    #[serde(rename = "$text")]
    _text: String,
}

fn contextual(text: &Text) -> Option<bool> {
    if MARKERS
        .into_iter()
        .any(|(open, close)| framed(text, open, close))
        || framed(text, "<recommended_plugins>", "</recommended_plugins>")
    {
        return Some(true);
    }
    let head = &text.trimmed_head;
    let tail = &text.trimmed_tail;
    if head
        .starts_with("Warning: The maximum number of unified exec processes you can keep open is")
        || head.starts_with(
            "Warning: Your account was flagged for potentially high-risk cyber activity",
        )
        || head.starts_with("Warning: apply_patch was requested via ")
            && tail.ends_with("Use the apply_patch tool instead of exec_command.")
    {
        return Some(true);
    }
    if head.starts_with("<goal_context>") && tail.ends_with("</goal_context>") {
        return Some(true);
    }
    if let Some(rest) = head.strip_prefix("<external_") {
        if let Some((key, _)) = rest.split_once('>') {
            return Some(tail.ends_with(&format!("</external_{key}>")));
        }
        return None;
    }
    if let Some(rest) = head.strip_prefix("<codex_internal_context source=\"") {
        if let Some((source, _)) = rest.split_once("\">") {
            let mut chars = source.chars();
            return Some(
                chars.next().is_some_and(|ch| ch.is_ascii_lowercase())
                    && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
                    && tail.ends_with("</codex_internal_context>"),
            );
        }
        return None;
    }
    if text.bytes == text.preview.len() as u64 {
        return Some(
            quick_xml::de::from_str::<Hook>(text.preview.trim())
                .ok()
                .is_some_and(|hook| !hook.id.trim().is_empty()),
        );
    }
    if head.starts_with('<') {
        // A truncated XML root with a hook attribute needs full validation. Do not
        // guess that a large source hook was a real human request.
        let mut reader = quick_xml::Reader::from_str(head);
        return match reader.read_event() {
            Ok(quick_xml::events::Event::Start(start) | quick_xml::events::Event::Empty(start)) => {
                if start.attributes().any(|value| {
                    value.is_ok_and(|attribute| attribute.key.as_ref() == b"hook_run_id")
                }) {
                    None
                } else {
                    Some(false)
                }
            }
            _ => None,
        };
    }
    Some(false)
}

fn summary(text: &Text) -> bool {
    // The pinned producer's 399-byte summary prefix followed by its required newline.
    // Keep the digest rather than embedding source prompt prose in runtime guidance.
    text.preview.as_bytes().get(..400).is_some_and(|bytes| {
        format!("{:x}", Sha256::digest(bytes))
            == "371aca20f23d546135443e5c289f62b304aea1a9ce21cfa0e80e17d4c6020fd0"
    })
}

fn agent_path(value: &str) -> bool {
    if value == "/morpheus" {
        return true;
    }
    let Some(rest) = value.strip_prefix("/root") else {
        return false;
    };
    if rest.is_empty() {
        return true;
    }
    let Some(rest) = rest.strip_prefix('/') else {
        return false;
    };
    rest.split('/').all(|part| {
        !part.is_empty()
            && part != "root"
            && part
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
    })
}

fn agent_message(text: &Text) -> Option<bool> {
    if text.bytes != text.preview.len() as u64 {
        return if text.trimmed_head.starts_with('{') {
            None
        } else {
            Some(false)
        };
    }
    let value: serde_json::Value = match serde_json::from_str(&text.preview) {
        Ok(value) => value,
        Err(_) => return Some(false),
    };
    let optional_string = |object: &serde_json::Value, key: &str| {
        object
            .get(key)
            .is_none_or(|value| value.is_null() || value.is_string())
    };
    let metadata_valid = value
        .get("internal_chat_message_metadata_passthrough")
        .is_none_or(|metadata| {
            metadata.is_null()
                || metadata.is_object()
                    && optional_string(metadata, "turn_id")
                    && metadata
                        .get("create_time")
                        .is_none_or(|value| value.is_null() || value.is_number())
        });
    let valid = optional_string(&value, "id")
        && optional_string(&value, "encrypted_content")
        && metadata_valid
        && value
            .get("author")
            .and_then(serde_json::Value::as_str)
            .is_some_and(agent_path)
        && value
            .get("recipient")
            .and_then(serde_json::Value::as_str)
            .is_some_and(agent_path)
        && value
            .get("content")
            .is_some_and(serde_json::Value::is_string)
        && value
            .get("trigger_turn")
            .is_some_and(serde_json::Value::is_boolean)
        && value.get("other_recipients").is_none_or(|array| {
            array.as_array().is_some_and(|array| {
                array
                    .iter()
                    .all(|item| item.as_str().is_some_and(agent_path))
            })
        });
    Some(valid)
}

const DEVELOPER_PREFIXES: [&str; 20] = [
    "<permissions instructions>",
    "Approved command prefix saved:",
    "<model_switch>",
    "<managed_developer_instructions>",
    "<persistent_mode>",
    "<apps_instructions>",
    "<collaboration_mode>",
    "<multi_agent_role>",
    "<multi_agent_mode>",
    "<environments_instructions>",
    "<git_attribution>",
    "<plugins_instructions>",
    "<realtime_conversation>",
    "<skills_instructions>",
    "<tools>",
    "<personality_spec>",
    "<token_budget>",
    "<context_window>",
    "<context_window_guidance>",
    "<rollout_budget>",
];

fn starts(text: &Text, prefix: &str) -> bool {
    text.trimmed_head
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

pub(super) fn message_contextual(fields: &Fields, base: &[Segment]) -> Option<bool> {
    if fields.text(base, "type").as_deref() != Some("message") {
        return Some(false);
    }
    let role = fields.text(base, "role");
    if !matches!(role.as_deref(), Some("user" | "developer")) {
        return Some(false);
    }
    let content = child(base, "content");
    if !matches!(
        fields.nodes.get(&content).map(|node| &node.value),
        Some(Value::Array)
    ) {
        return None;
    }
    let mut unknown = false;
    for index in fields.indices(&content) {
        let mut at = content.clone();
        at.push(Segment::Index(index));
        if fields.text(&at, "type").as_deref() != Some("input_text") {
            continue;
        }
        let Some(Value::String(text)) = fields
            .nodes
            .get(&child(&at, "text"))
            .map(|node| &node.value)
        else {
            return None;
        };
        match if role.as_deref() == Some("developer") {
            Some(DEVELOPER_PREFIXES.iter().any(|prefix| starts(text, prefix)))
        } else {
            contextual(text)
        } {
            Some(true) => return Some(true),
            None => unknown = true,
            _ => {}
        }
    }
    if unknown { None } else { Some(false) }
}

pub(super) fn rollback_blocks(fields: &Fields, base: &[Segment]) -> Vec<u32> {
    if fields.text(base, "type").as_deref() != Some("message")
        || fields.text(base, "role").as_deref() != Some("developer")
    {
        return Vec::new();
    }
    let content = child(base, "content");
    fields
        .indices(&content)
        .into_iter()
        .filter_map(|index| {
            let mut at = content.clone();
            at.push(Segment::Index(index));
            if fields.text(&at, "type").as_deref() != Some("input_text") {
                return None;
            }
            let Value::String(text) = &fields.nodes.get(&child(&at, "text"))?.value else {
                return None;
            };
            (starts(text, "<model_switch>") || starts(text, "<persistent_mode>"))
                .then_some(index as u32)
        })
        .collect()
}

pub(super) fn user_boundary(fields: &Fields, base: &[Segment]) -> Option<bool> {
    if fields.text(base, "type").as_deref() == Some("agent_message") {
        return Some(true);
    }
    if fields.text(base, "type").as_deref() != Some("message") {
        return Some(false);
    }
    let content = child(base, "content");
    if !matches!(
        fields.nodes.get(&content).map(|node| &node.value),
        Some(Value::Array)
    ) {
        return None;
    }
    let indices = fields.indices(&content);
    match fields.text(base, "role").as_deref() {
        Some("user") => {
            let mut unknown = false;
            for index in indices {
                let mut at = content.clone();
                at.push(Segment::Index(index));
                if fields.text(&at, "type").as_deref() != Some("input_text") {
                    continue;
                }
                let Some(Value::String(text)) = fields
                    .nodes
                    .get(&child(&at, "text"))
                    .map(|node| &node.value)
                else {
                    return None;
                };
                if summary(text) {
                    return Some(false);
                }
                match contextual(text) {
                    Some(true) => return Some(false),
                    None => unknown = true,
                    _ => {}
                }
            }
            if unknown { None } else { Some(true) }
        }
        Some("assistant") if indices.len() == 1 => {
            let mut at = content;
            at.push(Segment::Index(indices[0]));
            if !matches!(
                fields.text(&at, "type").as_deref(),
                Some("input_text" | "output_text")
            ) {
                return Some(false);
            }
            match fields
                .nodes
                .get(&child(&at, "text"))
                .map(|node| &node.value)
            {
                Some(Value::String(text)) => agent_message(text),
                _ => None,
            }
        }
        Some(_) => Some(false),
        None => None,
    }
}

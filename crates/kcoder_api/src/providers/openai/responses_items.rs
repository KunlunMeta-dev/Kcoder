//! OpenAI Responses output items that must survive a tool loop: reasoning
//! replay, terminal stop reasons and usage presence.
//!
//! A reasoning output item is kept verbatim (minus transient fields) in the
//! `signature` of the `Thinking` block that displays its summary. The marker
//! prefix keeps the payload private to this protocol: any other signature,
//! including an Anthropic signature or an empty one, is never sent as a
//! Responses input item.
use super::*;

const REASONING_SIGNATURE_PREFIX: &str = "kcoder.openai_responses.reasoning.v1:";

/// Input fields of a reasoning item; transient fields such as `status` are dropped.
const REASONING_REPLAY_FIELDS: [&str; 5] =
    ["type", "id", "summary", "content", "encrypted_content"];

/// Serialize a completed `reasoning` output item into a Thinking signature.
/// Returns `None` when the item has neither an id nor encrypted content,
/// because such an item can never be resolved on a later request.
pub(super) fn reasoning_signature(item: &Value) -> Option<String> {
    let source = item.as_object()?;
    if source.get("type").and_then(Value::as_str) != Some("reasoning") {
        return None;
    }
    let mut replay = Map::new();
    for field in REASONING_REPLAY_FIELDS {
        if let Some(value) = source.get(field).filter(|value| !value.is_null()) {
            replay.insert(field.to_string(), value.clone());
        }
    }
    if !replay.contains_key("summary") {
        // `summary` is a required input field even when the model produced none.
        replay.insert("summary".into(), Value::Array(Vec::new()));
    }
    let has_id = non_empty_str(replay.get("id"));
    let has_encrypted = non_empty_str(replay.get("encrypted_content"));
    if !has_id && !has_encrypted {
        return None;
    }
    Some(format!(
        "{REASONING_SIGNATURE_PREFIX}{}",
        Value::Object(replay)
    ))
}

/// Summary text of a reasoning item, for items that arrive without deltas.
pub(super) fn reasoning_summary_text(item: &Value) -> String {
    item.get("summary")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default()
}

/// The reasoning input item to replay, if this block carries one that the
/// server can still resolve. Without encrypted content the server must hold
/// the item itself, which `store: false` explicitly rules out.
fn reasoning_replay(block: &ContentBlock, store_disabled: bool) -> Option<Value> {
    let ContentBlock::Thinking { signature, .. } = block else {
        return None;
    };
    let item: Value =
        serde_json::from_str(signature.strip_prefix(REASONING_SIGNATURE_PREFIX)?).ok()?;
    if item.get("type").and_then(Value::as_str) != Some("reasoning") {
        return None;
    }
    let resolvable = non_empty_str(item.get("encrypted_content"))
        || (!store_disabled && non_empty_str(item.get("id")));
    resolvable.then_some(item)
}

fn non_empty_str(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
}

/// Append one assistant message as Responses input items.
///
/// Without a replayable reasoning item the historical layout is kept byte for
/// byte (function calls first, then one assistant message), so requests and
/// prompt-cache prefixes of existing sessions do not change. With reasoning,
/// items follow the original output order, because the API requires every
/// reasoning item to be followed by the item it produced. A reasoning item
/// with no following output item is not replayed.
pub(super) fn push_assistant_items(
    input: &mut Vec<Value>,
    content: Vec<ContentBlock>,
    store_disabled: bool,
) {
    let replays: Vec<Option<Value>> = content
        .iter()
        .map(|block| reasoning_replay(block, store_disabled))
        .collect();
    let has_output_after = |position: usize| {
        content[position + 1..].iter().any(|block| {
            matches!(
                block,
                ContentBlock::Text { .. } | ContentBlock::ToolUse { .. }
            )
        })
    };
    let ordered = replays
        .iter()
        .enumerate()
        .any(|(position, replay)| replay.is_some() && has_output_after(position));
    if !ordered {
        let mut parts = Vec::new();
        for block in content {
            match block {
                ContentBlock::Text { text } => parts.push(output_text(text)),
                ContentBlock::ToolUse {
                    id,
                    name,
                    input: arguments,
                } => input.push(function_call(id, name, &arguments)),
                _ => {}
            }
        }
        if !parts.is_empty() {
            input.push(serde_json::json!({"role": "assistant", "content": parts}));
        }
        return;
    }

    let mut parts = Vec::new();
    let mut pending_reasoning = Vec::new();
    let flush_parts = |input: &mut Vec<Value>, parts: &mut Vec<Value>| {
        if !parts.is_empty() {
            input.push(serde_json::json!({"role": "assistant", "content": std::mem::take(parts)}));
        }
    };
    for (block, replay) in content.into_iter().zip(replays) {
        if let Some(item) = replay {
            flush_parts(input, &mut parts);
            pending_reasoning.push(item);
            continue;
        }
        match block {
            ContentBlock::Text { text } => {
                input.append(&mut pending_reasoning);
                parts.push(output_text(text));
            }
            ContentBlock::ToolUse {
                id,
                name,
                input: arguments,
            } => {
                flush_parts(input, &mut parts);
                input.append(&mut pending_reasoning);
                input.push(function_call(id, name, &arguments));
            }
            _ => {}
        }
    }
    flush_parts(input, &mut parts);
}

fn output_text(text: String) -> Value {
    serde_json::json!({"type": "output_text", "text": text})
}

fn function_call(id: String, name: String, arguments: &Value) -> Value {
    serde_json::json!({
        "type": "function_call",
        "call_id": id,
        "name": name,
        "arguments": arguments.to_string(),
    })
}

/// Normalized stop reason of a terminal Responses event, in the same
/// vocabulary as the Chat Completions adapter.
pub(super) fn terminal_stop_reason(event: &str, response: &Value, saw_tool_call: bool) -> String {
    let incomplete = event == "response.incomplete"
        || response.get("status").and_then(Value::as_str) == Some("incomplete");
    if incomplete {
        return match response
            .pointer("/incomplete_details/reason")
            .and_then(Value::as_str)
        {
            Some("max_output_tokens") => "max_tokens".into(),
            Some(reason) if !reason.is_empty() => reason.into(),
            _ => "incomplete".into(),
        };
    }
    if saw_tool_call {
        "tool_use"
    } else {
        "end_turn"
    }
    .into()
}

/// Usage reported by a terminal Responses event. Missing, `null` or
/// counter-less usage stays unknown instead of being recorded as zero.
pub(super) fn terminal_usage(usage: Option<&Value>) -> Option<Usage> {
    let usage = usage?.as_object()?;
    let counter = |name: &str| {
        usage
            .get(name)
            .and_then(Value::as_u64)
            .map(|value| u32::try_from(value).unwrap_or(u32::MAX))
    };
    let input_tokens = counter("input_tokens");
    let output_tokens = counter("output_tokens");
    if input_tokens.is_none() && output_tokens.is_none() {
        return None;
    }
    Some(Usage {
        input_tokens: input_tokens.unwrap_or(0),
        output_tokens: output_tokens.unwrap_or(0),
        total_tokens: counter("total_tokens").or(match (input_tokens, output_tokens) {
            (Some(input), Some(output)) => Some(input.saturating_add(output)),
            _ => None,
        }),
        cache_creation_input_tokens: None,
        cache_read_input_tokens: usage
            .get("input_tokens_details")
            .and_then(|details| details.get("cached_tokens"))
            .and_then(Value::as_u64)
            .map(|value| u32::try_from(value).unwrap_or(u32::MAX)),
        iterations: None,
    })
}

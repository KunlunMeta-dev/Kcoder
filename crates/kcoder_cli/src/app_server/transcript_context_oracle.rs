//! Original JSON-based association scan retained only as an independent test oracle.
use super::*;

pub(super) fn extend(
    contexts: &mut TranscriptToolContexts,
    entries: &[kcoder_state::HistoryEntry],
    offset: usize,
) {
    for (entry_index, entry) in entries.iter().enumerate() {
        let entry_index = offset + entry_index;
        let Ok(serialized) = serde_json::to_value(&entry.message) else {
            continue;
        };
        let Some(blocks) = serialized.get("content").and_then(Value::as_array) else {
            continue;
        };
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("tool_use") => {
                    let Some(id) = block.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    contexts
                        .entry(id.into())
                        .or_default()
                        .push(TranscriptToolContext {
                            entry_index,
                            last_reference_index: entry_index,
                            name: block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("tool")
                                .to_string(),
                            input: block.get("input").cloned().unwrap_or_else(|| json!({})),
                            has_tool_use: true,
                            output: None,
                            is_error: false,
                            started_at_ms: entry.timestamp_ms,
                            completed_at_ms: None,
                        });
                }
                Some("tool_result") => {
                    if let Some(id) = block.get("tool_use_id").and_then(Value::as_str) {
                        let calls = contexts.entry(id.into()).or_default();
                        if calls.is_empty() {
                            calls.push(TranscriptToolContext {
                                entry_index,
                                last_reference_index: entry_index,
                                name: "tool".to_string(),
                                input: json!({}),
                                has_tool_use: false,
                                output: None,
                                is_error: false,
                                started_at_ms: entry.timestamp_ms,
                                completed_at_ms: Some(entry.timestamp_ms),
                            });
                        }
                        if let Some(context) = calls.last_mut() {
                            context.last_reference_index = entry_index;
                            context.completed_at_ms = Some(entry.timestamp_ms);
                            context.output = Some(nested_text_content(block.get("content")));
                            context.is_error = block
                                .get("is_error")
                                .and_then(Value::as_bool)
                                .unwrap_or(false);
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

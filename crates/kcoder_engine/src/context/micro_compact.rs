use super::tool_storage::TOOL_RESULT_CLEARED_MESSAGE;
use kcoder_types::{ContentBlock, Message};
use std::collections::{HashMap, HashSet};

/// Tools whose old results are eligible for micro-compaction.
const DEFAULT_COMPACTABLE_TOOLS: &[&str] = &[
    "read",
    "bash",
    "grep",
    "glob",
    "write",
    "edit",
    "web_search",
    "web_fetch",
];

/// Minimum size in characters for a tool result to be considered for clearing.
const MIN_CLEAR_CHARS: usize = 1_000;
const DEFAULT_TIME_GAP_MINUTES: u64 = 60;
const DEFAULT_TIME_GAP_KEEP_RECENT: usize = 5;

/// Configuration for micro-compaction.
#[derive(Debug, Clone)]
pub struct MicroCompactConfig {
    pub enabled: bool,
    pub compactable_tools: HashSet<String>,
    pub min_clear_chars: usize,
}

impl Default for MicroCompactConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            compactable_tools: DEFAULT_COMPACTABLE_TOOLS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            min_clear_chars: MIN_CLEAR_CHARS,
        }
    }
}

/// Configuration for the cold-cache, time-based micro-compaction pass.
///
/// A long idle gap means a provider's prompt cache has expired, so clearing
/// old tool payloads before the next request reduces the cold prefix that must
/// be uploaded and processed. At least one recent result is always retained.
#[derive(Debug, Clone)]
pub struct TimeBasedMicroCompactConfig {
    pub enabled: bool,
    pub gap_threshold_minutes: u64,
    pub keep_recent: usize,
    pub compactable_tools: HashSet<String>,
}

impl Default for TimeBasedMicroCompactConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            gap_threshold_minutes: DEFAULT_TIME_GAP_MINUTES,
            keep_recent: DEFAULT_TIME_GAP_KEEP_RECENT,
            compactable_tools: DEFAULT_COMPACTABLE_TOOLS
                .iter()
                .map(|tool| (*tool).to_string())
                .collect(),
        }
    }
}

/// Result of a micro-compaction pass.
#[derive(Debug, Clone, Default)]
pub struct MicroCompactResult {
    pub cleared_tool_use_ids: Vec<String>,
}

/// Apply micro-compaction to a slice of messages in-place.
///
/// Micro-compaction clears the content of stale tool results from a whitelist
/// of tools, replacing them with a short placeholder. This is the cheapest
/// form of context reduction and runs before any summarization.
pub fn apply_micro_compact(
    messages: &mut [Message],
    config: &MicroCompactConfig,
) -> MicroCompactResult {
    if !config.enabled || messages.is_empty() {
        return MicroCompactResult::default();
    }

    // Build a map from tool_use_id to tool name by scanning assistant messages.
    let mut tool_use_to_name: HashMap<String, String> = HashMap::new();
    for msg in messages.iter() {
        if let Message::Assistant { content, .. } = msg {
            for block in content {
                if let ContentBlock::ToolUse { id, name, .. } = block {
                    tool_use_to_name.insert(id.clone(), name.clone());
                }
            }
        }
    }

    // The most recent assistant message (and any user message that follows it)
    // is considered "current" and should not be cleared.
    let last_assistant_index = messages
        .iter()
        .rposition(|m| matches!(m, Message::Assistant { .. }))
        .unwrap_or(0);

    let mut result = MicroCompactResult::default();

    for (idx, msg) in messages.iter_mut().enumerate() {
        // Never clear results in the most recent assistant turn or anything
        // after it (e.g. the latest user request).
        if idx >= last_assistant_index {
            continue;
        }

        let content = match msg {
            Message::User { content, .. } => content,
            Message::Assistant { content, .. } => content,
        };

        for block in content.iter_mut() {
            let ContentBlock::ToolResult {
                tool_use_id,
                content: inner,
                ..
            } = block
            else {
                continue;
            };

            let Some(tool_name) = tool_use_to_name.get(tool_use_id) else {
                continue;
            };
            if !config.compactable_tools.contains(tool_name) {
                continue;
            }

            let text_len: usize = inner
                .iter()
                .map(|b| match b {
                    ContentBlock::Text { text } => text.len(),
                    _ => 0,
                })
                .sum();
            if text_len < config.min_clear_chars {
                continue;
            }

            *inner = vec![ContentBlock::Text {
                text: TOOL_RESULT_CLEARED_MESSAGE.to_string(),
            }];
            result.cleared_tool_use_ids.push(tool_use_id.clone());
        }
    }

    result
}

/// Clear old compactable tool results after a sufficiently long idle gap.
///
/// This pass deliberately ignores the normal minimum-result-size threshold:
/// once the prompt cache is cold, even small stale results add avoidable
/// request bytes. Tool-use blocks are retained and only their paired result
/// payloads are replaced, preserving provider protocol validity.
pub fn apply_time_based_micro_compact(
    messages: &mut [Message],
    config: &TimeBasedMicroCompactConfig,
    last_assistant_timestamp_ms: Option<u64>,
    now_ms: u64,
) -> MicroCompactResult {
    if !config.enabled || messages.is_empty() {
        return MicroCompactResult::default();
    }

    let Some(last_assistant_timestamp_ms) = last_assistant_timestamp_ms else {
        return MicroCompactResult::default();
    };
    let threshold_ms = config
        .gap_threshold_minutes
        .saturating_mul(60)
        .saturating_mul(1_000);
    if now_ms.saturating_sub(last_assistant_timestamp_ms) < threshold_ms {
        return MicroCompactResult::default();
    }

    let mut compactable_ids = Vec::new();
    for message in messages.iter() {
        let Message::Assistant { content, .. } = message else {
            continue;
        };
        for block in content {
            if let ContentBlock::ToolUse { id, name, .. } = block
                && config.compactable_tools.contains(name)
            {
                compactable_ids.push(id.clone());
            }
        }
    }

    let keep_recent = config.keep_recent.max(1);
    if compactable_ids.len() <= keep_recent {
        return MicroCompactResult::default();
    }
    let clear_count = compactable_ids.len().saturating_sub(keep_recent);
    let clear_ids = compactable_ids
        .into_iter()
        .take(clear_count)
        .collect::<HashSet<_>>();

    let mut result = MicroCompactResult::default();
    for message in messages.iter_mut() {
        let Message::User { content, .. } = message else {
            continue;
        };
        for block in content.iter_mut() {
            let ContentBlock::ToolResult {
                tool_use_id,
                content: result_content,
                ..
            } = block
            else {
                continue;
            };
            if !clear_ids.contains(tool_use_id)
                || matches!(
                    result_content.as_slice(),
                    [ContentBlock::Text { text }] if text == TOOL_RESULT_CLEARED_MESSAGE
                )
            {
                continue;
            }
            *result_content = vec![ContentBlock::Text {
                text: TOOL_RESULT_CLEARED_MESSAGE.to_string(),
            }];
            result.cleared_tool_use_ids.push(tool_use_id.clone());
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::{ContentBlock, Message};

    fn make_assistant_with_tool(id: &str, name: &str) -> Message {
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: id.into(),
                name: name.into(),
                input: serde_json::json!({}),
            }],
            usage: None,
        }
    }

    fn make_tool_result(id: &str, text: &str) -> Message {
        Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: id.into(),
                content: vec![ContentBlock::Text { text: text.into() }],
                is_error: Some(false),
            }],
        }
    }

    #[test]
    fn clears_old_compactable_result() {
        let mut messages = vec![
            make_assistant_with_tool("call_1", "bash"),
            make_tool_result("call_1", &"x".repeat(2_000)),
            Message::assistant_text("summary"),
            Message::user_text("next"),
        ];

        let result = apply_micro_compact(&mut messages, &MicroCompactConfig::default());
        assert_eq!(result.cleared_tool_use_ids, vec!["call_1"]);

        match &messages[1] {
            Message::User { content, .. } => match &content[0] {
                ContentBlock::ToolResult { content: inner, .. } => match &inner[0] {
                    ContentBlock::Text { text } => {
                        assert_eq!(text, TOOL_RESULT_CLEARED_MESSAGE);
                    }
                    _ => panic!("expected text"),
                },
                _ => panic!("expected tool result"),
            },
            _ => panic!("expected user"),
        }
    }

    #[test]
    fn preserves_current_turn() {
        let mut messages = vec![
            make_assistant_with_tool("call_1", "bash"),
            make_tool_result("call_1", &"x".repeat(2_000)),
        ];

        let result = apply_micro_compact(&mut messages, &MicroCompactConfig::default());
        assert!(result.cleared_tool_use_ids.is_empty());
    }

    #[test]
    fn ignores_non_compactable_tools() {
        let mut messages = vec![
            make_assistant_with_tool("call_1", "memory"),
            make_tool_result("call_1", &"x".repeat(2_000)),
            Message::assistant_text("done"),
        ];

        let result = apply_micro_compact(&mut messages, &MicroCompactConfig::default());
        assert!(result.cleared_tool_use_ids.is_empty());
    }

    #[test]
    fn time_based_compaction_waits_for_sixty_minute_gap() {
        let mut messages = vec![
            make_assistant_with_tool("call_1", "bash"),
            make_tool_result("call_1", &"x".repeat(2_000)),
            make_assistant_with_tool("call_2", "read"),
            make_tool_result("call_2", &"y".repeat(2_000)),
            Message::assistant_text("done"),
            Message::user_text("continue"),
        ];
        let config = TimeBasedMicroCompactConfig {
            gap_threshold_minutes: 60,
            keep_recent: 1,
            ..TimeBasedMicroCompactConfig::default()
        };

        let result = apply_time_based_micro_compact(
            &mut messages,
            &config,
            Some(1_000_000),
            1_000_000 + 60 * 60 * 1_000 - 1,
        );

        assert!(result.cleared_tool_use_ids.is_empty());
    }

    #[test]
    fn time_based_compaction_clears_old_results_and_keeps_recent_working_set() {
        let mut messages = vec![
            make_assistant_with_tool("call_1", "bash"),
            make_tool_result("call_1", "small old output"),
            make_assistant_with_tool("call_2", "read"),
            make_tool_result("call_2", &"y".repeat(2_000)),
            make_assistant_with_tool("call_3", "grep"),
            make_tool_result("call_3", &"z".repeat(2_000)),
            Message::assistant_text("done"),
            Message::user_text("continue after lunch"),
        ];
        let config = TimeBasedMicroCompactConfig {
            gap_threshold_minutes: 60,
            keep_recent: 2,
            ..TimeBasedMicroCompactConfig::default()
        };

        let result = apply_time_based_micro_compact(
            &mut messages,
            &config,
            Some(1_000_000),
            1_000_000 + 60 * 60 * 1_000,
        );

        assert_eq!(result.cleared_tool_use_ids, vec!["call_1"]);
        assert!(
            messages[1]
                .preview(200)
                .contains(TOOL_RESULT_CLEARED_MESSAGE)
        );
        assert!(messages[3].preview(3_000).contains(&"y".repeat(2_000)));
        assert!(messages[5].preview(3_000).contains(&"z".repeat(2_000)));
    }

    #[test]
    fn time_based_compaction_requires_main_thread_timestamp_and_enabled_setting() {
        let original = vec![
            make_assistant_with_tool("call_1", "bash"),
            make_tool_result("call_1", &"x".repeat(2_000)),
            make_assistant_with_tool("call_2", "bash"),
            make_tool_result("call_2", &"y".repeat(2_000)),
            Message::assistant_text("done"),
        ];

        let mut without_timestamp = original.clone();
        let missing = apply_time_based_micro_compact(
            &mut without_timestamp,
            &TimeBasedMicroCompactConfig::default(),
            None,
            u64::MAX,
        );
        assert!(missing.cleared_tool_use_ids.is_empty());

        let mut disabled_messages = original;
        let disabled = apply_time_based_micro_compact(
            &mut disabled_messages,
            &TimeBasedMicroCompactConfig {
                enabled: false,
                keep_recent: 1,
                ..TimeBasedMicroCompactConfig::default()
            },
            Some(1),
            u64::MAX,
        );
        assert!(disabled.cleared_tool_use_ids.is_empty());
    }

    #[test]
    #[ignore = "manual performance benchmark"]
    fn micro_compaction_benchmark() {
        let mut messages = Vec::with_capacity(12_001);
        for idx in 0..6_000 {
            let id = format!("call_{idx}");
            messages.push(make_assistant_with_tool(&id, "bash"));
            messages.push(make_tool_result(&id, &"tool output line\n".repeat(128)));
        }
        messages.push(Message::assistant_text("latest turn must stay intact"));

        let started = std::time::Instant::now();
        let result = apply_micro_compact(&mut messages, &MicroCompactConfig::default());
        let elapsed = started.elapsed();

        eprintln!(
            "micro_compaction_benchmark: {} messages, {} results cleared, elapsed={elapsed:?}",
            messages.len(),
            result.cleared_tool_use_ids.len()
        );
        assert_eq!(result.cleared_tool_use_ids.len(), 6_000);
    }
}

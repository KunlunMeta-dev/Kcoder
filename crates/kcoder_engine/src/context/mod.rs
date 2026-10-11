pub mod attachments;
pub mod budget;
pub mod compact;
pub mod micro_compact;
pub mod session_memory;
pub mod tokens;
pub mod tool_storage;

pub use attachments::{PostCompactAttachments, collect_recent_file_attachments};
pub use budget::{ContextBudget, ContextManager};
pub use compact::{
    CompactBoundary, CompactionFailureDetails, CompactionRequest, CompactionResult,
    ConversationCompactor, PrefireNote, latest_compact_boundary,
    messages_after_latest_compact_boundary,
};
pub use micro_compact::{
    MicroCompactConfig, MicroCompactResult, TimeBasedMicroCompactConfig, apply_micro_compact,
    apply_time_based_micro_compact,
};
pub use session_memory::{
    DEFAULT_SESSION_MEMORY_TEMPLATE, SessionMemoryCompactionPlan,
    build_session_memory_compacted_messages, build_session_memory_compaction_plan,
    build_session_memory_update_prompt, extract_session_memory_markdown,
    session_memory_has_required_sections,
};
pub use tokens::{TokenCount, TokenCountSource, TokenCounter};
pub use tool_storage::{TOOL_RESULT_CLEARED_MESSAGE, ToolResultStorage};

pub(crate) fn truncate_chars_with_dropped_bytes(
    text: &str,
    max_chars: usize,
) -> Option<(String, usize)> {
    let mut chars = 0usize;
    for (idx, _) in text.char_indices() {
        if chars == max_chars {
            return Some((text[..idx].to_string(), text.len().saturating_sub(idx)));
        }
        chars = chars.saturating_add(1);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::truncate_chars_with_dropped_bytes;

    #[test]
    fn char_truncation_preserves_utf8_boundaries() {
        let (prefix, dropped) = truncate_chars_with_dropped_bytes("你好世界", 3).unwrap();

        assert_eq!(prefix, "你好世");
        assert_eq!(dropped, "界".len());
    }

    #[test]
    fn char_truncation_leaves_exact_limit_unchanged() {
        assert!(truncate_chars_with_dropped_bytes("abcd", 4).is_none());
    }
}

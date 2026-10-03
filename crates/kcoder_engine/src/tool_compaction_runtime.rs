use super::*;

const MAX_TOOL_RESULT_COMPACTIONS: usize = 3;

impl QueryEngine {
    pub(super) fn tool_result_compaction_available(&self) -> bool {
        recover_read_lock(&self.auto_compact_state, "auto_compact_state").tool_result_compactions
            < MAX_TOOL_RESULT_COMPACTIONS
    }

    pub(super) fn record_tool_result_compaction(&self) {
        let mut state = recover_write_lock(&self.auto_compact_state, "auto_compact_state");
        state.tool_result_compactions = state.tool_result_compactions.saturating_add(1);
    }

    pub(super) fn reset_tool_result_compactions(&self) {
        recover_write_lock(&self.auto_compact_state, "auto_compact_state")
            .tool_result_compactions = 0;
    }

    /// Reduce old tool payloads without invoking a summary model or changing
    /// any other compaction threshold. Only a committed reduction consumes a pass.
    pub(super) async fn try_early_tool_result_compaction(&self) -> bool {
        if !self.tool_result_compaction_available() {
            return false;
        }
        let mut messages = self.state.messages();
        let boundary = latest_compact_boundary(&messages)
            .map(|boundary| boundary.suffix_start)
            .unwrap_or(0);
        let suffix = &mut messages[boundary..];
        let before = TokenCounter::count(&*suffix);
        let storage = ToolResultStorage::new(self.session_dir());
        let stored = match storage.enforce_on_messages(suffix).await {
            Ok(count) => count,
            Err(error) => {
                warn!("early tool result storage enforcement failed: {error}");
                return false;
            }
        };
        let result = apply_micro_compact(suffix, &MicroCompactConfig::default());
        let after = TokenCounter::count(&*suffix);
        if stored == 0 && result.cleared_tool_use_ids.is_empty() {
            return false;
        }
        self.state
            .mark_read_tool_results_compacted(&messages, &result.cleared_tool_use_ids);
        self.state.set_messages_preserving_history_ids(messages);
        self.record_tool_result_compaction();
        // Any pending summary used the previous message bodies; avoid reusing
        // that stale prefix after tool-only cleanup commits.
        self.prefire_owner.cancel();
        debug!(
            pre_tokens = before,
            post_tokens = after,
            "early tool result compaction committed"
        );
        true
    }
}

//! Unattended turns use existing task permissions and never wait for approval.
use super::*;

impl QueryEngine {
    /// Restricts a turn candidate; the original task configuration is retained.
    pub fn with_unattended_input(mut self) -> Self {
        self.unattended_input = true;
        self
    }

    /// Whether the current Engine round may wait for or deliver user input.
    /// This is round-local and never consults persisted task source metadata.
    pub fn user_interaction_round_is_attended(&self) -> bool {
        !self.unattended_input
    }

    /// Apply one effective configuration snapshot without rebuilding tool schemas.
    pub fn with_channel_tool_restrictions(
        mut self,
        policy: kcoder_types::channel_tool_restrictions::ChannelToolRestrictions,
    ) -> Self {
        self.channel_tool_restrictions = policy;
        self
    }

    pub(super) fn channel_tool_is_disabled(&self, name: &str) -> bool {
        self.unattended_input
            && self.channel_tool_restrictions.enabled
            && self
                .channel_tool_restrictions
                .disabled_tools
                .iter()
                .any(|item| item == name)
    }

    pub(super) fn channel_turn_prompt(&self) -> Option<String> {
        self.unattended_input.then(|| {
            let disabled = if self.channel_tool_restrictions.enabled {
                &self.channel_tool_restrictions.disabled_tools[..]
            } else { &[] };
            format!("\n\nThis turn originates from a channel. Use the original session's permissions, rules, Hooks and sandbox policy. Human approval is unavailable on this input route: operations requiring fresh approval will be denied; do not wait or treat this as a grant. Channel-disabled tools (exact names): {}. These restrictions apply only to this turn and do not change the session tool list. Continue independent work and explain any blocked operation.\n", serde_json::to_string(disabled).expect("tool names serialize"))
        })
    }
}

#[cfg(test)]
mod tests;

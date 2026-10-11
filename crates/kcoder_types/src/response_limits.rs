//! Local memory limits for one decoded model response, independent of token quotas.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ProviderResponseLimits {
    pub total_decoded_bytes: usize,
    pub tool_arguments_bytes: usize,
    pub content_blocks: usize,
    pub active_tool_calls: usize,
}

impl Default for ProviderResponseLimits {
    fn default() -> Self {
        Self {
            total_decoded_bytes: 64 * 1024 * 1024,
            tool_arguments_bytes: 16 * 1024 * 1024,
            content_blocks: 1024,
            active_tool_calls: 64,
        }
    }
}

impl ProviderResponseLimits {
    pub fn valid(&self) -> bool {
        self.total_decoded_bytes > 0
            && self.tool_arguments_bytes > 0
            && self.tool_arguments_bytes <= self.total_decoded_bytes
            && self.content_blocks > 0
            && self.active_tool_calls > 0
            && self.active_tool_calls <= self.content_blocks
    }
}

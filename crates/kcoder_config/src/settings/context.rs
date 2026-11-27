//! Context configuration types and their defaults.

use crate::*;

/// Token-pressure compaction settings. Explicit absolute token thresholds keep
/// precedence; these percentages only apply when no absolute threshold exists.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ContextCompactionSettings {
    #[serde(default)]
    pub auto_threshold: AutoCompactThresholdSettings,
}

/// Percentage of the hard input budget used by each context-window tier.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutoCompactThresholdSettings {
    #[serde(default = "default_auto_compact_small_window_percent")]
    pub small_window_percent: usize,
    #[serde(default = "default_auto_compact_medium_window_percent")]
    pub medium_window_percent: usize,
    #[serde(default = "default_auto_compact_large_window_percent")]
    pub large_window_percent: usize,
}

impl AutoCompactThresholdSettings {
    pub fn percentage_for(self, context_window_tokens: usize) -> usize {
        if context_window_tokens <= 256_000 {
            self.small_window_percent
        } else if context_window_tokens <= 512_000 {
            self.medium_window_percent
        } else {
            self.large_window_percent
        }
    }
}

impl Default for AutoCompactThresholdSettings {
    fn default() -> Self {
        Self {
            small_window_percent: default_auto_compact_small_window_percent(),
            medium_window_percent: default_auto_compact_medium_window_percent(),
            large_window_percent: default_auto_compact_large_window_percent(),
        }
    }
}

/// Cold-cache context reduction applied before the first request after a long
/// idle gap. This is separate from token-pressure auto-compaction: it only
/// replaces old compactable tool-result payloads and never calls a model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TimeBasedMicroCompactSettings {
    /// Master switch for idle-gap micro-compaction on the main conversation.
    #[serde(default = "default_time_based_micro_compact_enabled")]
    pub enabled: bool,
    /// Minimum time since the latest assistant message before the pass runs.
    #[serde(default = "default_time_based_micro_compact_gap_minutes")]
    pub gap_threshold_minutes: u64,
    /// Number of most recent compactable tool results preserved verbatim.
    #[serde(default = "default_time_based_micro_compact_keep_recent")]
    pub keep_recent: usize,
}

impl Default for TimeBasedMicroCompactSettings {
    fn default() -> Self {
        Self {
            enabled: default_time_based_micro_compact_enabled(),
            gap_threshold_minutes: default_time_based_micro_compact_gap_minutes(),
            keep_recent: default_time_based_micro_compact_keep_recent(),
        }
    }
}

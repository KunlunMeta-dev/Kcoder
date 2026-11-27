//! Provider-reported usage shared by live events and restored transcripts.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageBreakdown {
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ThreadContextUsage {
    pub total: TokenUsageBreakdown,
    pub last: TokenUsageBreakdown,
    /// Older history retains usage but not the request's context-window limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_context_window: Option<usize>,
}

impl ThreadContextUsage {
    pub fn from_usage(usage: &kcoder_types::Usage, model_context_window: Option<usize>) -> Self {
        let (mut input, mut output) = (
            u64::from(usage.input_tokens),
            u64::from(usage.output_tokens),
        );
        for iteration in usage.iterations.iter().flatten() {
            input = input.saturating_add(u64::from(iteration.input_tokens));
            output = output.saturating_add(u64::from(iteration.output_tokens));
        }
        let cached = u64::from(usage.cache_creation_input_tokens.unwrap_or_default())
            .saturating_add(u64::from(usage.cache_read_input_tokens.unwrap_or_default()));
        let breakdown = TokenUsageBreakdown {
            total_tokens: usage
                .total_tokens
                .map(u64::from)
                .unwrap_or_else(|| input.saturating_add(output).saturating_add(cached)),
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            reasoning_output_tokens: 0,
        };
        Self {
            total: breakdown.clone(),
            last: breakdown,
            model_context_window,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restored_usage_preserves_provider_total_without_adding_cached_tokens_twice() {
        let usage = serde_json::from_value(serde_json::json!({
            "input_tokens":609,"output_tokens":559,"total_tokens":40336,
            "cache_read_input_tokens":39168
        }))
        .unwrap();
        let restored = ThreadContextUsage::from_usage(&usage, None);
        assert_eq!(restored.last.total_tokens, 40336);
        assert_eq!(restored.last.cached_input_tokens, 39168);
        assert_eq!(restored.last, restored.total);
        assert!(restored.model_context_window.is_none());
        assert!(
            serde_json::to_value(restored)
                .unwrap()
                .get("modelContextWindow")
                .is_none()
        );
        assert_eq!(
            ThreadContextUsage::from_usage(&usage, Some(1_000_000)).model_context_window,
            Some(1_000_000)
        );
    }
}

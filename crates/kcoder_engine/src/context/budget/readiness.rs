//! Fallible budget construction; unconfigured metadata has no numeric budget.
use super::ContextBudget;
use kcoder_config::{ModelExecutionConfigurationError, Settings, validate_explicit_model_limits};

pub fn try_context_budget(
    settings: &Settings,
) -> Result<ContextBudget, ModelExecutionConfigurationError> {
    let limits = validate_explicit_model_limits(settings)?;
    let total = limits.context_window_tokens;
    let reserved_output = limits.output_headroom_tokens;
    let auto_compact_threshold = settings.auto_compact_threshold_tokens.or_else(|| {
        Some(
            limits.hard_input_limit.saturating_mul(
                settings
                    .context_compaction
                    .auto_threshold
                    .percentage_for(total),
            ) / 100,
        )
    });
    Ok(ContextBudget {
        total,
        reserved_output,
        system: settings.context_system_tokens.unwrap_or(2_000),
        tools: settings.context_tools_tokens.unwrap_or(4_000),
        messages: total - reserved_output,
        auto_compact_threshold,
        hard_input_limit: settings.context_hard_input_tokens,
        prefire_threshold: settings.prefire_threshold_tokens,
        estimated_tool_growth: settings.estimated_tool_growth_tokens.unwrap_or(15_000),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unconfigured_budget_returns_an_error_without_panicking_or_inventing_a_window() {
        assert_eq!(
            try_context_budget(&Settings::default()).unwrap_err().code(),
            "model_limits_missing"
        );
    }
    #[test]
    fn configured_budget_preserves_the_explicit_context_and_input_boundaries() {
        let settings = Settings {
            context_window_tokens: Some(131072),
            context_output_headroom: Some(8192),
            max_tokens: Some(2048),
            context_hard_input_tokens: Some(120000),
            auto_compact_threshold_tokens: Some(110000),
            prefire_threshold_tokens: Some(100000),
            ..Settings::default()
        };
        let budget = try_context_budget(&settings).unwrap();
        assert_eq!(budget.total, 131072);
        assert_eq!(budget.hard_input_limit(), 120000);
        assert_eq!(budget.auto_compact_threshold(), 110000);
        assert_eq!(budget.prefire_threshold(), 100000);
    }
}

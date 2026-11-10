//! Explicit subscription configuration. These data values are never native policy authority.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationPeriodBudget {
    pub window_seconds: u64,
    pub maximum_tokens: u64,
    pub maximum_model_calls: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationBudgetWindow {
    pub starts_at_ms: u64,
    pub ends_at_ms: u64,
}
impl AutomationPeriodBudget {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(1..=31_536_000).contains(&self.window_seconds)
            || !(1..=9_007_199_254_740_991).contains(&self.maximum_tokens)
            || !(1..=9_007_199_254_740_991).contains(&self.maximum_model_calls)
        {
            return Err("AUTOMATION_PERIOD_BUDGET_INVALID");
        }
        Ok(())
    }
    /// UTC epoch alignment is fixed; callers cannot choose an anchor to reset a cycle.
    pub fn window(&self, now_ms: u64) -> Result<AutomationBudgetWindow, &'static str> {
        self.validate()?;
        let width = self
            .window_seconds
            .checked_mul(1000)
            .ok_or("AUTOMATION_PERIOD_BUDGET_INVALID")?;
        let start = now_ms / width * width;
        let end = start
            .checked_add(width)
            .ok_or("AUTOMATION_PERIOD_BUDGET_INVALID")?;
        if end == u64::MAX {
            return Err("AUTOMATION_PERIOD_BUDGET_INVALID");
        }
        Ok(AutomationBudgetWindow {
            starts_at_ms: start,
            ends_at_ms: end,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_are_finite_epoch_aligned_and_configuration_cannot_choose_an_anchor() {
        let value = AutomationPeriodBudget {
            window_seconds: 60,
            maximum_tokens: 100,
            maximum_model_calls: 4,
        };
        assert_eq!(
            value.window(60_001).unwrap(),
            AutomationBudgetWindow {
                starts_at_ms: 60_000,
                ends_at_ms: 120_000
            }
        );
        assert_eq!(value.window(119_999).unwrap().starts_at_ms, 60_000);
        assert_eq!(value.window(120_000).unwrap().starts_at_ms, 120_000);
        assert!(value.window(u64::MAX).is_err());
        assert!(serde_json::from_value::<AutomationPeriodBudget>(serde_json::json!({"windowSeconds":60,"maximumTokens":100,"maximumModelCalls":4,"anchor":10})).is_err());
    }
}

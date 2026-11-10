//! Explicit target-owned task limits; configuration never grants tool authority.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfiguredChannelTaskBudget {
    pub tokens: u64,
    #[serde(default = "default_model_calls")]
    pub model_calls: u32,
    #[serde(default = "default_run_millis")]
    pub run_millis: u64,
}

fn default_model_calls() -> u32 {
    8
}
fn default_run_millis() -> u64 {
    240_000
}

impl ConfiguredChannelTaskBudget {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            (1..=1_000_000).contains(&self.tokens)
                && (1..=8).contains(&self.model_calls)
                && (1_000..=240_000).contains(&self.run_millis),
            "CHANNEL_TASK_BUDGET_INVALID"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::core::CoreIntegrationSettings;
    use serde_json::json;

    #[test]
    fn channel_task_budget_preserves_absent_configuration_and_explicit_limits() {
        let old: CoreIntegrationSettings = serde_json::from_value(json!({})).unwrap();
        assert!(old.channel_task_budget.is_none());
        assert_eq!(
            serde_json::to_value(old).unwrap(),
            json!({"modelPolicies":[]})
        );
        let cleared: CoreIntegrationSettings =
            serde_json::from_value(json!({"channelTaskBudget":null})).unwrap();
        assert_eq!(
            serde_json::to_value(cleared).unwrap(),
            json!({"modelPolicies":[]})
        );
        crate::schema::validate_settings_schema(
            &json!({"integrations":{"core":{"channelTaskBudget":null}}}),
        )
        .unwrap();
        let configured: CoreIntegrationSettings = serde_json::from_value(json!({
            "channelTaskBudget":{"tokens":65536}
        }))
        .unwrap();
        configured.validate().unwrap();
        let budget = configured.channel_task_budget.unwrap();
        assert_eq!(budget.model_calls, 8);
        assert_eq!(budget.run_millis, 240_000);
        assert_eq!(budget.tokens, 65_536);
    }

    #[test]
    fn channel_task_budget_schema_and_typed_validation_agree_on_boundaries() {
        for budget in [
            json!({"tokens":1,"modelCalls":1,"runMillis":1000}),
            json!({"tokens":1000000,"modelCalls":8,"runMillis":240000}),
        ] {
            let document = json!({"integrations":{"core":{"channelTaskBudget":budget}}});
            crate::schema::validate_settings_schema(&document).unwrap();
            let typed: ConfiguredChannelTaskBudget = serde_json::from_value(budget).unwrap();
            typed.validate().unwrap();
        }
        for budget in [
            json!({"tokens":0}),
            json!({"tokens":1000001}),
            json!({"tokens":65536,"modelCalls":0}),
            json!({"tokens":65536,"modelCalls":9}),
            json!({"tokens":65536,"runMillis":999}),
            json!({"tokens":65536,"runMillis":240001}),
        ] {
            let document = json!({"integrations":{"core":{"channelTaskBudget":budget}}});
            assert!(crate::schema::validate_settings_schema(&document).is_err());
            let typed: ConfiguredChannelTaskBudget = serde_json::from_value(budget).unwrap();
            assert!(typed.validate().is_err());
        }
        for budget in [
            json!({}),
            json!({"tokens":"65536"}),
            json!({"tokens":65536,"allowTools":true}),
        ] {
            let document = json!({"integrations":{"core":{"channelTaskBudget":budget}}});
            assert!(crate::schema::validate_settings_schema(&document).is_err());
            assert!(serde_json::from_value::<ConfiguredChannelTaskBudget>(budget).is_err());
        }
    }
}

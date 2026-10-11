//! Provider/model overlays for local response-memory limits, not token quotas.
use anyhow::{Result, ensure};
use kcoder_types::ProviderResponseLimits;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ResponseLimitsOverrides {
    pub total_decoded_bytes: Option<usize>,
    pub tool_arguments_bytes: Option<usize>,
    pub content_blocks: Option<usize>,
    pub active_tool_calls: Option<usize>,
}

impl ResponseLimitsOverrides {
    pub fn from_limits(limits: ProviderResponseLimits) -> Self {
        Self {
            total_decoded_bytes: Some(limits.total_decoded_bytes),
            tool_arguments_bytes: Some(limits.tool_arguments_bytes),
            content_blocks: Some(limits.content_blocks),
            active_tool_calls: Some(limits.active_tool_calls),
        }
    }

    pub fn merged_with(&self, model: &Self) -> Self {
        Self {
            total_decoded_bytes: model.total_decoded_bytes.or(self.total_decoded_bytes),
            tool_arguments_bytes: model.tool_arguments_bytes.or(self.tool_arguments_bytes),
            content_blocks: model.content_blocks.or(self.content_blocks),
            active_tool_calls: model.active_tool_calls.or(self.active_tool_calls),
        }
    }

    pub fn resolved(&self) -> Result<ProviderResponseLimits> {
        let limits = self.overlay(ProviderResponseLimits::default())?;
        ensure!(
            limits.valid(),
            "response_limits per-tool/active limits exceed their total limits"
        );
        Ok(limits)
    }
    pub fn is_empty(&self) -> bool {
        self.total_decoded_bytes.is_none()
            && self.tool_arguments_bytes.is_none()
            && self.content_blocks.is_none()
            && self.active_tool_calls.is_none()
    }

    pub fn validate(&self) -> Result<()> {
        ensure!(
            [
                self.total_decoded_bytes,
                self.tool_arguments_bytes,
                self.content_blocks,
                self.active_tool_calls
            ]
            .into_iter()
            .flatten()
            .all(|value| value > 0),
            "response_limits values must be positive"
        );
        Ok(())
    }

    pub fn overlay(&self, mut limits: ProviderResponseLimits) -> Result<ProviderResponseLimits> {
        self.validate()?;
        if let Some(value) = self.total_decoded_bytes {
            limits.total_decoded_bytes = value;
        }
        if let Some(value) = self.tool_arguments_bytes {
            limits.tool_arguments_bytes = value;
        }
        if let Some(value) = self.content_blocks {
            limits.content_blocks = value;
        }
        if let Some(value) = self.active_tool_calls {
            limits.active_tool_calls = value;
        }
        Ok(limits)
    }
}

impl crate::Settings {
    pub fn response_limits(&self) -> Result<ProviderResponseLimits> {
        self.response_limits_for_model(&self.model)
    }

    pub fn response_limits_for_model(&self, model: &str) -> Result<ProviderResponseLimits> {
        let mut limits = ProviderResponseLimits::default();
        if let Some(provider) = self
            .active_provider
            .as_ref()
            .and_then(|id| self.providers.get(id))
        {
            limits = provider.response_limits.overlay(limits)?;
            if let Some(model) = provider.models.get(model) {
                limits = model.response_limits.overlay(limits)?;
            }
        }
        ensure!(
            limits.valid(),
            "response_limits per-tool/active limits exceed their total limits"
        );
        Ok(limits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_settings() -> crate::Settings {
        let mut settings = crate::Settings::default();
        let provider: crate::ProviderConfig = serde_json::from_value(serde_json::json!({
            "endpoint":"http://127.0.0.1:1/v1", "api_format":"openai_chat_completions",
            "default_model":"large", "context_window_tokens":1000000,
            "output_headroom_tokens":262144, "max_output_tokens":262144,
            "response_limits":{"total_decoded_bytes":100,"tool_arguments_bytes":64,"content_blocks":8,"active_tool_calls":2},
            "models":{
                "large":{"context_window_tokens":1000000,"output_headroom_tokens":262144,"max_output_tokens":262144,
                    "response_limits":{"tool_arguments_bytes":32}},
                "other":{"context_window_tokens":1000000,"output_headroom_tokens":262144,"max_output_tokens":262144}
            }
        })).unwrap();
        settings.providers.insert("test".into(), provider);
        settings.apply_provider(Some("test")).unwrap();
        settings
    }

    #[test]
    fn response_limits_follow_selected_model_without_changing_token_quota() {
        let mut settings = model_settings();
        assert_eq!(
            settings.response_limits().unwrap(),
            ProviderResponseLimits {
                total_decoded_bytes: 100,
                tool_arguments_bytes: 32,
                content_blocks: 8,
                active_tool_calls: 2,
            }
        );
        assert_eq!(settings.max_tokens, Some(262144));
        let effective = settings.providers["test"]
            .effective_for_model("large")
            .unwrap();
        assert_eq!(
            effective.response_limits.resolved().unwrap(),
            settings.response_limits().unwrap()
        );
        settings.model = "other".into();
        assert_eq!(settings.response_limits().unwrap().tool_arguments_bytes, 64);
        assert_eq!(settings.response_limits().unwrap().content_blocks, 8);
        let saved: crate::ProviderConfig =
            serde_json::from_value(serde_json::to_value(&effective).unwrap()).unwrap();
        assert_eq!(
            saved
                .response_limits
                .resolved()
                .unwrap()
                .tool_arguments_bytes,
            32
        );
    }

    #[test]
    fn response_limits_validate_every_effective_model_and_allow_partial_overlays() {
        let mut settings = model_settings();
        let provider = settings.providers.get_mut("test").unwrap();
        provider
            .models
            .get_mut("other")
            .unwrap()
            .response_limits
            .active_tool_calls = Some(9);
        assert!(
            provider.validate_models().is_err(),
            "unselected invalid model must be caught on save"
        );
        provider
            .models
            .get_mut("other")
            .unwrap()
            .response_limits
            .active_tool_calls = Some(8);
        provider.validate_models().unwrap();
        provider.response_limits.total_decoded_bytes = Some(16);
        assert!(
            provider.validate_models().is_err(),
            "inherited per-tool cannot exceed total"
        );
        for model in provider.models.values_mut() {
            model.response_limits.tool_arguments_bytes = Some(16);
        }
        provider.validate_models().unwrap();
        provider.response_limits.total_decoded_bytes = Some(0);
        assert!(provider.validate_models().is_err());
    }

    #[test]
    fn limits_overlay_preserves_unspecified_fields_and_rejects_invalid_values() {
        let override_: ResponseLimitsOverrides =
            serde_json::from_value(serde_json::json!({"tool_arguments_bytes":128})).unwrap();
        let actual = override_
            .overlay(ProviderResponseLimits::default())
            .unwrap();
        assert_eq!(actual.tool_arguments_bytes, 128);
        assert_eq!(actual.total_decoded_bytes, 64 * 1024 * 1024);
        assert!(
            serde_json::from_value::<ResponseLimitsOverrides>(serde_json::json!({"bogus":1}))
                .is_err()
        );
        assert!(
            ResponseLimitsOverrides {
                content_blocks: Some(0),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }
}

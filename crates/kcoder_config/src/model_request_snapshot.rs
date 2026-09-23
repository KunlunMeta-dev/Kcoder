//! Allowlisted effective request parameters for a durable model snapshot.
//! Transport identity and credential-source binding are supplied separately by the host.
use crate::{ModelCapabilities, Settings};
use anyhow::{Result, ensure};
use kcoder_types::ReasoningEffort;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelRequestSnapshot {
    pub model: String,
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_policy: Option<kcoder_types::ModelReasoningPolicy>,
    pub capabilities: ModelCapabilities,
    pub extra_body: serde_json::Map<String, serde_json::Value>,
    pub context_window_tokens: Option<usize>,
    pub context_output_headroom: Option<usize>,
    pub auto_compact_threshold_tokens: Option<usize>,
    pub max_tokens: Option<u32>,
    pub max_retries: usize,
    pub retry_base_delay_ms: u64,
}

impl ModelRequestSnapshot {
    /// Does not serialize Settings: its unrelated executable configuration and
    /// credentials must never enter a model request snapshot.
    pub fn capture(settings: &Settings) -> Result<Self> {
        let snapshot = Self {
            model: settings.model.clone(),
            reasoning_effort: settings.model_reasoning_effort.clone(),
            reasoning_policy: settings.model_reasoning_policy.clone(),
            capabilities: settings.model_capabilities.clone(),
            extra_body: settings.provider_extra_body.clone(),
            context_window_tokens: settings.context_window_tokens,
            context_output_headroom: settings.context_output_headroom,
            auto_compact_threshold_tokens: settings.auto_compact_threshold_tokens,
            max_tokens: settings.max_tokens,
            max_retries: settings.max_retries,
            retry_base_delay_ms: settings.retry_base_delay_ms,
        };
        let value = serde_json::to_value(&snapshot)?;
        // Catch a configured secret copied into an arbitrary extra-body value as
        // well as a credential-looking property. Never include the value in errors.
        let secrets = settings
            .stored_provider_credentials
            .values()
            .chain(settings.credential_overrides.values())
            .map(String::as_str)
            .chain(
                [
                    settings.api_key.as_deref(),
                    settings.anthropic_api_key.as_deref(),
                    settings.kunlunmeta_api_key.as_deref(),
                    settings.openai_api_key.as_deref(),
                    settings.local_api_key.as_deref(),
                    settings.gemini_api_key.as_deref(),
                    settings.grok_api_key.as_deref(),
                ]
                .into_iter()
                .flatten(),
            )
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        ensure!(
            !contains_secret(&value, &secrets),
            "Model request snapshot contains credential material"
        );
        Ok(snapshot)
    }

    /// Only request parameters change. The caller must restore and authorize the
    /// transport separately before activating the resulting runtime settings.
    pub fn apply_to(&self, settings: &mut Settings) {
        settings.model = self.model.clone();
        settings.model_reasoning_effort = self.reasoning_effort.clone();
        settings.model_reasoning_policy = self.reasoning_policy.clone();
        settings.model_capabilities = self.capabilities.clone();
        settings.provider_extra_body = self.extra_body.clone();
        settings.context_window_tokens = self.context_window_tokens;
        settings.context_output_headroom = self.context_output_headroom;
        settings.auto_compact_threshold_tokens = self.auto_compact_threshold_tokens;
        settings.max_tokens = self.max_tokens;
        settings.max_retries = self.max_retries;
        settings.retry_base_delay_ms = self.retry_base_delay_ms;
    }
}

fn contains_secret(value: &serde_json::Value, secrets: &[&str]) -> bool {
    match value {
        serde_json::Value::String(text) => secrets.iter().any(|secret| text.contains(secret)),
        serde_json::Value::Array(items) => items.iter().any(|item| contains_secret(item, secrets)),
        serde_json::Value::Object(fields) => fields.iter().any(|(key, value)| {
            let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
            matches!(
                normalized.as_str(),
                "apikey" | "authorization" | "password" | "accesstoken" | "refreshtoken"
            ) || secrets.iter().any(|secret| key.contains(secret))
                || contains_secret(value, secrets)
        }),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_effective_parameters_without_copying_credentials_or_transport() {
        let mut original = Settings::default();
        original.model = "original-model".into();
        original
            .provider_extra_body
            .insert("temperature".into(), serde_json::json!(0.2));
        original.openai_api_key = Some("private-original-key".into());
        let snapshot = ModelRequestSnapshot::capture(&original).unwrap();
        let bytes = serde_json::to_vec(&snapshot).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("private-original-key"));
        let restored: ModelRequestSnapshot = serde_json::from_slice(&bytes).unwrap();
        let mut current = Settings::default();
        current.model = "new-default".into();
        current.openai_api_key = Some("rotated-current-key".into());
        current.base_url = Some("https://current.invalid".into());
        restored.apply_to(&mut current);
        assert_eq!(current.model, "original-model");
        assert_eq!(current.provider_extra_body["temperature"], 0.2);
        assert!(current.openai_api_key.as_deref() == Some("rotated-current-key"));
        assert_eq!(current.base_url.as_deref(), Some("https://current.invalid"));
    }

    #[test]
    fn refuses_embedded_keys_without_echoing_them() {
        for body in [
            serde_json::json!({"metadata":{"api_key":"fixture-private-key"}}),
            serde_json::json!({"metadata":{"label":"prefix-fixture-private-key-suffix"}}),
        ] {
            let mut settings = Settings::default();
            settings.api_key = Some("fixture-private-key".into());
            settings.provider_extra_body = body.as_object().unwrap().clone();
            let error = ModelRequestSnapshot::capture(&settings).err().unwrap();
            assert!(!error.to_string().contains("fixture-private-key"));
        }
    }
}

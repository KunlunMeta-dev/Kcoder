use std::collections::BTreeMap;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::{ModelCapabilities, ProviderConfig, ReasoningEffort};

/// Model-specific runtime parameters, independent of deployment credentials and transport.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderModelConfig {
    pub context_window_tokens: usize,
    pub output_headroom_tokens: usize,
    pub max_output_tokens: u32,
    #[serde(default)]
    pub capabilities: ModelCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_compact_threshold_tokens: Option<usize>,
}

impl ProviderModelConfig {
    pub fn validate(&self, model: &str) -> Result<()> {
        if model.trim().is_empty() || model != model.trim() || model.chars().any(char::is_control) {
            bail!("model id must be nonempty without surrounding whitespace or control characters");
        }
        if self.context_window_tokens == 0
            || self.output_headroom_tokens == 0
            || self.max_output_tokens == 0
        {
            bail!("model '{model}' token limits must be greater than zero");
        }
        if self.output_headroom_tokens > self.context_window_tokens
            || self.max_output_tokens as usize > self.context_window_tokens
        {
            bail!("model '{model}' output limits exceed its context window");
        }
        if self
            .auto_compact_threshold_tokens
            .is_some_and(|value| value == 0 || value >= self.context_window_tokens)
        {
            bail!(
                "model '{model}' auto_compact_threshold_tokens must be greater than zero and below its context window"
            );
        }
        Ok(())
    }
}

impl ProviderConfig {
    fn legacy_model_profile(&self) -> ProviderModelConfig {
        ProviderModelConfig {
            context_window_tokens: self.context_window_tokens,
            output_headroom_tokens: self.output_headroom_tokens,
            max_output_tokens: self.max_output_tokens,
            capabilities: self.capabilities.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
            auto_compact_threshold_tokens: self.auto_compact_threshold_tokens,
        }
    }

    pub fn has_model(&self, model: &str) -> bool {
        if self.models.is_empty() {
            self.default_model == model
        } else {
            self.models.contains_key(model)
        }
    }

    pub fn model_profiles(&self) -> BTreeMap<String, ProviderModelConfig> {
        if !self.models.is_empty() {
            return self.models.clone();
        }
        BTreeMap::from([(self.default_model.clone(), self.legacy_model_profile())])
    }

    pub fn validate_models(&self) -> Result<()> {
        if self.models.len() > 1024 {
            bail!("a provider supports at most 1024 configured models");
        }
        if !self.models.is_empty() && !self.models.contains_key(&self.default_model) {
            bail!(
                "default_model '{}' must be present in models",
                self.default_model
            );
        }
        if self.models.is_empty() {
            self.legacy_model_profile().validate(&self.default_model)?;
        }
        for (model, profile) in &self.models {
            profile.validate(model)?;
        }
        Ok(())
    }

    /// Resolve an explicitly configured model while retaining one credential namespace.
    pub fn effective_for_model(&self, model: &str) -> Result<Self> {
        self.validate_models()?;
        let profile = if self.models.is_empty() && self.default_model == model {
            Some(self.legacy_model_profile())
        } else {
            self.models.get(model).cloned()
        }
        .ok_or_else(|| anyhow::anyhow!("model '{model}' is not configured for this provider"))?;
        let mut effective = self.clone();
        effective.default_model = model.to_string();
        effective.context_window_tokens = profile.context_window_tokens;
        effective.output_headroom_tokens = profile.output_headroom_tokens;
        effective.max_output_tokens = profile.max_output_tokens;
        effective.capabilities = profile.capabilities;
        effective.reasoning_effort = profile.reasoning_effort;
        effective.auto_compact_threshold_tokens = profile.auto_compact_threshold_tokens;
        Ok(effective)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Settings;

    fn multiple() -> ProviderConfig {
        serde_json::from_value(serde_json::json!({
            "api_format":"openai_chat_completions", "endpoint":"https://example.invalid/v1",
            "default_model":"small", "credential_env":["SHARED_PROVIDER_KEY"],
            "context_window_tokens":999999,"output_headroom_tokens":99,"max_output_tokens":99,
            "models": {
                "small":{"context_window_tokens":32000,"output_headroom_tokens":4000,"max_output_tokens":3000,
                    "capabilities":{"vision":false},"reasoning_effort":"low"},
                "large":{"context_window_tokens":200000,"output_headroom_tokens":20000,"max_output_tokens":12000,
                    "auto_compact_threshold_tokens":100000,"capabilities":{"vision":true},"reasoning_effort":"high"}
            }
        })).unwrap()
    }

    #[test]
    fn explicit_models_are_independent_and_keep_transport_identity() {
        let profile = multiple();
        let small = profile.effective_for_model("small").unwrap();
        let large = profile.effective_for_model("large").unwrap();
        assert_eq!(small.context_window_tokens, 32000);
        assert!(!small.capabilities.vision);
        assert_eq!(large.context_window_tokens, 200000);
        assert_eq!(large.max_output_tokens, 12000);
        assert_eq!(large.auto_compact_threshold_tokens, Some(100000));
        assert_eq!(large.endpoint, small.endpoint);
        assert_eq!(large.credential_env, small.credential_env);
        assert!(profile.effective_for_model("missing").is_err());
        assert_eq!(profile.model_profiles().len(), 2);
    }

    #[test]
    fn legacy_model_and_explicit_catalog_switch_share_one_provider() {
        let legacy = crate::default_active_provider_config();
        assert_eq!(legacy.model_profiles().len(), 1);
        assert_eq!(
            legacy.effective_for_model(&legacy.default_model).unwrap(),
            legacy
        );
        let mut settings = Settings::default();
        settings.providers.insert("shared".into(), multiple());
        settings.apply_provider(Some("shared")).unwrap();
        assert_eq!(settings.model, "small");
        assert_eq!(settings.context_window_tokens, Some(32000));
        settings.apply_discovered_model("shared", "large").unwrap();
        assert_eq!(settings.provider.as_deref(), Some("shared"));
        assert_eq!(settings.context_window_tokens, Some(200000));
        assert!(settings.model_capabilities.vision);
        settings.reapply_active_model_selection().unwrap();
        assert_eq!(settings.max_tokens, Some(12000));
    }

    #[test]
    fn invalid_explicit_models_are_rejected_before_selection() {
        let mut profile = multiple();
        profile.default_model = "missing".into();
        assert!(profile.validate_models().is_err());
        profile.default_model = "small".into();
        profile.models.get_mut("large").unwrap().max_output_tokens = 200001;
        assert!(profile.effective_for_model("small").is_err());
    }

    #[test]
    fn model_tables_replace_lower_layers_and_empty_restores_legacy() {
        let mut lower = serde_json::json!({"providers":{"shared": multiple()}});
        let small = lower["providers"]["shared"]["models"]["small"].clone();
        crate::loader::merge_settings_documents(
            &mut lower,
            serde_json::json!({"providers":{"shared":{"models":{"small":small}}}}),
        );
        let profile: ProviderConfig =
            serde_json::from_value(lower["providers"]["shared"].clone()).unwrap();
        assert_eq!(profile.model_profiles().len(), 1);
        assert!(!profile.models.contains_key("large"));
        crate::loader::merge_settings_documents(
            &mut lower,
            serde_json::json!({"providers":{"shared":{"models":{}}}}),
        );
        let profile: ProviderConfig =
            serde_json::from_value(lower["providers"]["shared"].clone()).unwrap();
        assert!(profile.models.is_empty());
        assert_eq!(
            serde_json::to_value(&profile).unwrap()["models"],
            serde_json::json!({})
        );
        assert_eq!(
            profile.model_profiles()["small"].context_window_tokens,
            999999
        );
    }

    #[test]
    fn explicit_model_catalog_size_is_bounded() {
        let mut profile = multiple();
        let item = profile.models["small"].clone();
        for index in 0..1024 {
            profile
                .models
                .insert(format!("extra-{index}"), item.clone());
        }
        assert!(profile.validate_models().is_err());
    }

    #[test]
    fn loader_accepts_models_without_duplicate_top_level_limits() {
        let mut profile = serde_json::to_value(multiple()).unwrap();
        for key in [
            "context_window_tokens",
            "output_headroom_tokens",
            "max_output_tokens",
        ] {
            profile.as_object_mut().unwrap().remove(key);
        }
        let doc = serde_json::json!({"active_provider":"shared","providers":{"shared":profile}});
        let settings = crate::loader::validate_and_resolve_settings_document(&doc).unwrap();
        assert_eq!(settings.model, "small");
        assert_eq!(settings.context_window_tokens, Some(32000));
        assert_eq!(settings.max_tokens, Some(3000));
        let mut bad = doc;
        bad["providers"]["shared"]["models"]["large"]["endpoint"] =
            serde_json::json!("https://not-allowed.invalid");
        assert!(crate::loader::validate_and_resolve_settings_document(&bad).is_err());
    }
}

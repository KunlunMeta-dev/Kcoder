use crate::{ProviderConfig, Settings};
use anyhow::{Result, bail};

/// Data-driven credential metadata for one provider deployment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderCredential {
    pub id: String,
    pub env: Vec<String>,
}

pub fn validate_provider_id(value: &str) -> Result<String> {
    let id = value.trim();
    if id == "minimax" {
        bail!("provider id 'minimax' has been retired; use 'kunlunmeta'");
    }
    let valid = !id.is_empty()
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'));
    if !valid {
        bail!("provider id may contain only ASCII letters, digits, '-', '_' and '.'");
    }
    Ok(id.to_string())
}

pub fn builtin_credential_env(provider: &str) -> Vec<String> {
    let names: &[&str] = match provider.trim() {
        "kunlunmeta" => &["KUNLUNMETA_BASE_API_KEY"],
        _ => &[],
    };
    names.iter().map(|name| (*name).to_string()).collect()
}

pub fn builtin_provider_credentials() -> Vec<ProviderCredential> {
    ["kunlunmeta"]
        .into_iter()
        .map(|id| ProviderCredential {
            id: id.to_string(),
            env: builtin_credential_env(id),
        })
        .collect()
}

impl ProviderConfig {
    pub fn credential(&self, provider_id: &str) -> ProviderCredential {
        let id = provider_id.trim().to_string();
        let env = if self.credential_env.is_empty() {
            builtin_credential_env(&id)
        } else {
            self.credential_env.clone()
        };
        ProviderCredential { id, env }
    }
}

impl Settings {
    pub fn provider_credential(&self, selector: Option<&str>) -> Option<ProviderCredential> {
        let selector = selector.or(self.active_provider.as_deref());
        if let Some(selector) = selector {
            if let Some(provider) = self.providers.get(selector) {
                return Some(provider.credential(selector));
            }
            let id = validate_provider_id(selector).ok()?;
            return Some(ProviderCredential {
                env: builtin_credential_env(&id),
                id,
            });
        }
        let id = validate_provider_id(self.provider.as_deref()?).ok()?;
        Some(ProviderCredential {
            env: builtin_credential_env(&id),
            id,
        })
    }

    /// Resolve one API key with a provider-independent precedence order:
    /// explicit CLI value, explicit credential dotenv, stored auth, legacy
    /// fixed fields, then process environment.
    pub fn resolve_provider_api_key(
        &self,
        selector: Option<&str>,
        explicit: Option<String>,
    ) -> Option<String> {
        if selector
            .or(self.active_provider.as_deref())
            .and_then(|id| self.providers.get(id))
            .is_some_and(|profile| !profile.authentication.is_api_key())
        {
            return None;
        }
        let credential = self.provider_credential(selector)?;
        first_non_empty(
            explicit
                .into_iter()
                .chain(self.credential_overrides.get(&credential.id).cloned())
                .chain(
                    self.stored_provider_credentials
                        .get(&credential.id)
                        .cloned(),
                )
                .chain(self.legacy_provider_api_key(&credential.id))
                .chain(self.api_key.clone())
                .chain(
                    credential
                        .env
                        .iter()
                        .filter_map(|name| std::env::var(name).ok()),
                ),
        )
    }

    fn legacy_provider_api_key(&self, id: &str) -> Option<String> {
        match id {
            "anthropic" => self.anthropic_api_key.clone(),
            "kunlunmeta" => self.kunlunmeta_api_key.clone(),
            "openai" => self.openai_api_key.clone(),
            "local" => self.local_api_key.clone(),
            "gemini" => self.gemini_api_key.clone(),
            "grok" => self.grok_api_key.clone(),
            _ => None,
        }
    }
}

fn first_non_empty(values: impl IntoIterator<Item = String>) -> Option<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retired_minimax_provider_id_is_rejected_for_new_configuration() {
        let error = validate_provider_id("minimax").unwrap_err();
        assert!(error.to_string().contains("use 'kunlunmeta'"));
    }

    #[test]
    fn custom_profile_resolves_custom_stored_credential() {
        let mut settings = Settings::default();
        settings.providers.insert(
            "deepseek".to_string(),
            ProviderConfig {
                authentication: Default::default(),
                api_format: crate::ApiFormat::OpenaiChatCompletions,
                endpoint: "https://api.deepseek.com/v1".to_string(),
                default_model: "deepseek-chat".to_string(),
                models: Default::default(),
                credential_env: vec!["DEEPSEEK_API_KEY".to_string()],
                discover_models: None,
                capabilities: crate::ModelCapabilities::default(),
                reasoning_effort: None,
                context_window_tokens: 128_000,
                auto_compact_threshold_tokens: None,
                output_headroom_tokens: 8_192,
                max_output_tokens: 8_192,
                request_timeout_secs: None,
                user_agent: None,
                max_retries: None,
                retry_base_delay_ms: None,
                no_proxy: false,
                extra_body: Default::default(),
            },
        );
        settings
            .stored_provider_credentials
            .insert("deepseek".to_string(), "stored-key".to_string());
        settings
            .credential_overrides
            .insert("deepseek".to_string(), "dotenv-key".to_string());

        assert_eq!(
            settings.resolve_provider_api_key(Some("deepseek"), None),
            Some("dotenv-key".to_string())
        );
        assert_eq!(
            settings.resolve_provider_api_key(Some("deepseek"), Some("cli-key".to_string())),
            Some("cli-key".to_string())
        );
    }

    #[test]
    fn providers_serving_the_same_model_keep_distinct_credentials() {
        let mut settings = Settings::default();
        for (provider, env) in [
            ("VendorA", "VENDOR_A_API_KEY"),
            ("VendorB", "VENDOR_B_API_KEY"),
        ] {
            let mut profile = settings.providers["kunlunmeta"].clone();
            profile.default_model = "shared-model-name".to_string();
            profile.credential_env = vec![env.to_string()];
            settings.providers.insert(provider.to_string(), profile);
        }
        settings
            .stored_provider_credentials
            .insert("VendorA".to_string(), "vendor-a-key".to_string());
        settings
            .stored_provider_credentials
            .insert("VendorB".to_string(), "vendor-b-key".to_string());

        assert_eq!(
            settings.resolve_provider_api_key(Some("VendorA"), None),
            Some("vendor-a-key".to_string())
        );
        assert_eq!(
            settings.resolve_provider_api_key(Some("VendorB"), None),
            Some("vendor-b-key".to_string())
        );
        assert_eq!(
            settings.resolve_provider_api_key(Some("vendora"), None),
            None
        );
    }
}

use crate::{ProviderConfig, Settings};
use anyhow::{Result, bail};

/// Data-driven credential metadata for one provider deployment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderCredential {
    pub id: String,
    pub env: Vec<String>,
}

/// The winning credential layer, without any secret material.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "variable", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProviderApiKeySource {
    Explicit,
    CredentialFile,
    Stored,
    LegacyProvider,
    LegacyGlobal,
    Environment(String),
}

/// A resolved secret and its provenance. Debug output must never expose the key.
#[derive(Clone, PartialEq, Eq)]
pub struct ResolvedProviderApiKey {
    pub source: ProviderApiKeySource,
    key: String,
}

impl ResolvedProviderApiKey {
    pub fn into_key(self) -> String {
        self.key
    }
}

impl std::fmt::Debug for ResolvedProviderApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedProviderApiKey")
            .field("source", &self.source)
            .field("key", &"[REDACTED]")
            .finish()
    }
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
        self.resolve_provider_api_key_with_source(selector, explicit)
            .map(ResolvedProviderApiKey::into_key)
    }

    /// Preserve provenance so a request-boundary refresh cannot resurrect a
    /// removed credential by silently falling back to a lower-priority layer.
    pub fn resolve_provider_api_key_with_source(
        &self,
        selector: Option<&str>,
        explicit: Option<String>,
    ) -> Option<ResolvedProviderApiKey> {
        if selector
            .or(self.active_provider.as_deref())
            .and_then(|id| self.providers.get(id))
            .is_some_and(|profile| !profile.authentication.is_api_key())
        {
            return None;
        }
        let credential = self.provider_credential(selector)?;
        if self.revoked_provider_credentials.contains(&credential.id)
            && explicit.as_deref().is_none_or(|value| value.trim().is_empty())
            && self.credential_overrides.get(&credential.id).is_none_or(|value| value.trim().is_empty())
        {
            return None;
        }
        let candidates = [
            (ProviderApiKeySource::Explicit, explicit),
            (
                ProviderApiKeySource::CredentialFile,
                self.credential_overrides.get(&credential.id).cloned(),
            ),
            (
                ProviderApiKeySource::Stored,
                self.stored_provider_credentials
                    .get(&credential.id)
                    .cloned(),
            ),
            (
                ProviderApiKeySource::LegacyProvider,
                self.legacy_provider_api_key(&credential.id),
            ),
            (ProviderApiKeySource::LegacyGlobal, self.api_key.clone()),
        ];
        candidates
            .into_iter()
            .chain(credential.env.iter().map(|name| {
                (
                    ProviderApiKeySource::Environment(name.clone()),
                    std::env::var(name).ok(),
                )
            }))
            .find_map(|(source, value)| {
                let key = value?.trim().to_string();
                (!key.is_empty()).then_some(ResolvedProviderApiKey { source, key })
            })
    }

    /// Re-resolve an in-flight credential without changing its authority layer.
    /// A removed source is revocation, even when a lower layer has the same key.
    /// New turns may bind another source through the ordinary resolver.
    pub fn resolve_bound_provider_api_key(
        &self,
        selector: Option<&str>,
        explicit: Option<String>,
        source: &ProviderApiKeySource,
    ) -> Result<ResolvedProviderApiKey> {
        let current = self
            .resolve_provider_api_key_with_source(selector, explicit)
            .filter(|credential| &credential.source == source);
        current.ok_or_else(|| anyhow::anyhow!(
            "Provider credential was removed or its source changed; configure credentials and start a new turn"
        ))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durable_credential_source_contains_authority_metadata_only() {
        for source in [
            ProviderApiKeySource::Explicit,
            ProviderApiKeySource::CredentialFile,
            ProviderApiKeySource::Stored,
            ProviderApiKeySource::LegacyProvider,
            ProviderApiKeySource::LegacyGlobal,
            ProviderApiKeySource::Environment("FIXTURE_API_KEY".into()),
        ] {
            let wire = serde_json::to_value(&source).unwrap();
            assert_eq!(serde_json::from_value::<ProviderApiKeySource>(wire.clone()).unwrap(), source);
            assert!(wire.get("key").is_none());
            assert!(wire.get("password").is_none());
            assert!(wire.get("kind").is_some());
        }
        assert!(serde_json::from_str::<ProviderApiKeySource>(r#"{"kind":"stored","key":"fixture-secret"}"#).is_err());
        assert!(serde_json::from_str::<ProviderApiKeySource>(r#"{"kind":"unknown"}"#).is_err());
    }

    #[test]
    fn restored_binding_does_not_fall_back_when_its_authority_disappears() {
        let source: ProviderApiKeySource = serde_json::from_str(r#"{"kind":"stored"}"#).unwrap();
        let mut settings = Settings::default();
        settings.openai_api_key = Some("legacy-fixture".into());
        settings.stored_provider_credentials.insert("openai".into(), "stored-fixture".into());
        assert!(settings.resolve_bound_provider_api_key(Some("openai"), None, &source).is_ok());
        settings.stored_provider_credentials.clear();
        assert!(settings.resolve_bound_provider_api_key(Some("openai"), None, &source).is_err());
    }

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
                reasoning_policy: None,
                chat_protocol: Default::default(),
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
    #[test]
    fn credential_resolution_reports_the_winning_layer_without_changing_precedence() {
        let mut settings = Settings::default();
        settings.api_key = Some("global-fixture".into());
        settings.openai_api_key = Some("legacy-fixture".into());
        settings
            .stored_provider_credentials
            .insert("openai".into(), "stored-fixture".into());
        settings
            .credential_overrides
            .insert("openai".into(), "file-fixture".into());
        let resolve = |settings: &Settings, explicit| {
            settings
                .resolve_provider_api_key_with_source(Some("openai"), explicit)
                .unwrap()
        };
        assert_eq!(
            resolve(&settings, Some("cli-fixture".into())).source,
            ProviderApiKeySource::Explicit
        );
        assert_eq!(
            resolve(&settings, Some("  ".into())).source,
            ProviderApiKeySource::CredentialFile
        );
        settings.credential_overrides.clear();
        assert_eq!(
            resolve(&settings, None).source,
            ProviderApiKeySource::Stored
        );
        settings.stored_provider_credentials.clear();
        assert_eq!(
            resolve(&settings, None).source,
            ProviderApiKeySource::LegacyProvider
        );
        settings.openai_api_key = None;
        assert_eq!(
            resolve(&settings, None).source,
            ProviderApiKeySource::LegacyGlobal
        );
        assert_eq!(resolve(&settings, None).into_key(), "global-fixture");
    }

    #[test]
    fn credential_provenance_debug_redacts_the_secret() {
        let mut settings = Settings::default();
        settings.api_key = Some("synthetic-private-value".into());
        let resolved = settings
            .resolve_provider_api_key_with_source(Some("openai"), None)
            .unwrap();
        let debug = format!("{resolved:?}");
        assert!(debug.contains("LegacyGlobal"));
        assert!(!debug.contains("synthetic-private-value"));
    }
    #[test]
    fn bound_stored_key_rotates_but_never_falls_back_after_removal() {
        let mut settings = Settings::default();
        settings.openai_api_key = Some("old-fixture".into());
        settings
            .stored_provider_credentials
            .insert("openai".into(), "old-fixture".into());
        let original = settings
            .resolve_provider_api_key_with_source(Some("openai"), None)
            .unwrap();
        settings
            .stored_provider_credentials
            .insert("openai".into(), "new-fixture".into());
        assert_eq!(
            settings
                .resolve_bound_provider_api_key(Some("openai"), None, &original.source)
                .unwrap()
                .into_key(),
            "new-fixture"
        );
        settings.stored_provider_credentials.clear();
        let error = settings
            .resolve_bound_provider_api_key(Some("openai"), None, &original.source)
            .unwrap_err();
        assert!(!error.to_string().contains("old-fixture"));
        assert!(error.to_string().contains("removed"));
        // Ordinary binding for a new turn remains a separate policy decision.
        assert_eq!(
            settings
                .resolve_provider_api_key_with_source(Some("openai"), None)
                .unwrap()
                .source,
            ProviderApiKeySource::LegacyProvider
        );
    }

    #[test]
    fn bound_explicit_key_is_unaffected_by_unrelated_store_changes() {
        let mut settings = Settings::default();
        settings
            .stored_provider_credentials
            .insert("openai".into(), "store-fixture".into());
        let source = ProviderApiKeySource::Explicit;
        settings.stored_provider_credentials.clear();
        assert_eq!(
            settings
                .resolve_bound_provider_api_key(Some("openai"), Some("cli-fixture".into()), &source)
                .unwrap()
                .into_key(),
            "cli-fixture"
        );
        settings
            .credential_overrides
            .insert("openai".into(), "file-fixture".into());
        assert!(
            settings
                .resolve_bound_provider_api_key(Some("openai"), None, &source)
                .is_err()
        );
    }
}

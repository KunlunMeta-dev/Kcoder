use super::*;
use kcoder_api::ModelDiscoveryOptions;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredModelGroup {
    pub profile_name: String,
    pub provider: String,
    pub endpoint: String,
    pub configured_model: String,
    pub models: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfiguredModelProfile {
    pub profile_name: String,
    pub provider: String,
    pub model: String,
    pub current: bool,
    pub vision: bool,
    pub reasoning: bool,
    pub reasoning_effort: Option<String>,
    pub configuration: Option<kcoder_types::ModelConfigurationSummary>,
    pub available: bool,
    pub error: Option<String>,
}

pub(super) fn schedule_provider_prewarm(provider: Arc<dyn Provider>) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    runtime.spawn(async move {
        // Give immediate/headless first turns priority. Single-connection local
        // OpenAI-compatible servers and deterministic test harnesses must not
        // have their only accept slot consumed by a speculative HEAD request.
        // Interactive startup still has ample time to warm while the user is
        // reading the welcome screen or composing the first prompt.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let _ = timeout(PROVIDER_PREWARM_TIMEOUT, provider.prewarm()).await;
    });
}

impl QueryEngine {
    /// Human-readable provider name for UI status surfaces.
    pub fn provider_name(&self) -> String {
        self.current_provider().name().to_string()
    }

    /// Effective provider endpoint after CLI, environment, profile, and
    /// provider-default resolution.
    pub fn provider_endpoint(&self) -> Option<String> {
        self.current_provider().endpoint().map(ToString::to_string)
    }

    /// Whether the active provider instance contains an API key. The key itself
    /// is never exposed.
    pub fn provider_api_key_configured(&self) -> Option<bool> {
        self.current_provider().api_key_configured()
    }

    /// Effective provider connection timeout after all fallbacks.
    pub fn provider_request_timeout_secs(&self) -> Option<u64> {
        self.current_provider().request_timeout_secs()
    }

    pub fn current_provider(&self) -> Arc<dyn Provider> {
        recover_read_lock(&self.provider, "provider").clone()
    }

    /// Build and activate a complete provider profile for subsequent turns.
    pub fn switch_provider_profile(&self, profile_name: &str) -> Result<Settings> {
        let mut next_settings = recover_read_lock(&self.settings, "settings").clone();
        next_settings.apply_provider(Some(profile_name))?;
        let current = self.current_provider();
        let reconfigurable = current.supports_client_runtime_reconfiguration();
        let next_provider = if reconfigurable {
            if let Some(source) = &self.client_model_configuration {
                source.provider(&next_settings)?
            } else {
                ProviderFactory::new(&next_settings)
                    .build_profile(profile_name)
                    .with_context(|| format!("failed to build provider profile '{profile_name}'"))?
                    .1
            }
        } else {
            current
        };

        if reconfigurable && !next_settings.training_mode {
            schedule_provider_prewarm(next_provider.clone());
        }
        *recover_write_lock(&self.provider, "provider") = next_provider;
        *recover_write_lock(&self.settings, "settings") = next_settings.clone();
        Ok(next_settings)
    }

    /// Build and atomically activate an automatically discovered model using the
    /// source provider's complete configuration. Preserve the current runtime on build failure.
    pub fn switch_discovered_model(&self, profile_name: &str, model: &str) -> Result<Settings> {
        let mut next_settings = recover_read_lock(&self.settings, "settings").clone();
        next_settings.apply_discovered_model(profile_name, model)?;
        let current = self.current_provider();
        let reconfigurable = current.supports_client_runtime_reconfiguration();
        let next_provider = if reconfigurable {
            let kind = ProviderKind::from_settings(&next_settings)?
                .ok_or_else(|| anyhow::anyhow!("profile '{profile_name}' has no provider"))?;
            if let Some(source) = &self.client_model_configuration {
                source.provider(&next_settings)?
            } else {
                ProviderFactory::new(&next_settings)
                    .build(kind, model)
                    .with_context(|| {
                        format!("failed to build discovered model '{profile_name}::{model}'")
                    })?
            }
        } else {
            current
        };
        if reconfigurable && !next_settings.training_mode {
            schedule_provider_prewarm(next_provider.clone());
        }
        *recover_write_lock(&self.provider, "provider") = next_provider;
        *recover_write_lock(&self.settings, "settings") = next_settings.clone();
        Ok(next_settings)
    }

    /// Goal Pro primary-agent model escalation. When cumulative semantic verifier
    /// rejections reach a threshold multiple, switch provider/model by configured rung
    /// while preserving message history through the manual `/model` mechanism. Return
    /// notice text for transcript and UI. Return None when conditions are unmet, the
    /// ladder is exhausted, or switching fails; failures do not advance the rung and are reevaluated at the next request boundary.
    pub(crate) fn maybe_escalate_goal_model(&self) -> Option<String> {
        let goal = self.state.goal()?;
        if !goal.mode.is_strict() || !goal.status.is_active() {
            return None;
        }
        let escalation = recover_read_lock(&self.settings, "settings")
            .goal_pro
            .model_escalation
            .clone();
        if !escalation.enabled || escalation.models.is_empty() || escalation.threshold == 0 {
            return None;
        }
        let rung = goal.model_escalation_rung as usize;
        if rung >= escalation.models.len() {
            return None;
        }
        let required = escalation.threshold.saturating_mul(rung + 1);
        if goal.semantic_completion_rejected_count < required {
            return None;
        }
        let slot = &escalation.models[rung];
        let from = format!("{}/{}", self.provider_name(), self.model_name());
        let switched = if let Some(profile) = slot.profile.as_deref() {
            self.switch_provider_profile(profile)
                .map(|_| profile.to_string())
        } else {
            let provider = slot
                .provider
                .clone()
                .unwrap_or_else(|| self.provider_name());
            let model = slot.model.clone().unwrap_or_else(|| self.model_name());
            self.switch_discovered_model(&provider, &model)
                .map(|_| format!("{provider}:{model}"))
        };
        let label = match switched {
            Ok(label) => label,
            Err(error) => {
                warn!("goal model escalation switch failed: {error:#}");
                return None;
            }
        };
        let advanced = self
            .state
            .advance_goal_model_escalation(goal.model_escalation_rung)?;
        Some(format!(
            "Goal Pro model escalation: after {} verifier rejection(s), the main agent model was switched from `{}` to `{}` (rung {}/{}). The conversation context is fully preserved; continue the goal with the same history.",
            goal.semantic_completion_rejected_count,
            from,
            label,
            advanced.model_escalation_rung,
            escalation.models.len(),
        ))
    }

    /// Lazily probe every configured deployment that allows model discovery.
    /// Failures are isolated to their group so `/model` remains usable.
    pub async fn discover_provider_models(&self) -> Vec<DiscoveredModelGroup> {
        let settings = recover_read_lock(&self.settings, "settings").clone();
        if !settings.model_discovery.enabled {
            return Vec::new();
        }
        let options = ModelDiscoveryOptions {
            timeout: Duration::from_secs(settings.model_discovery.request_timeout_secs),
            max_models: settings.model_discovery.max_models_per_provider,
        };
        let current_profile = settings.active_provider.clone();
        let mut pending = FuturesUnordered::new();

        for (profile_name, profile) in &settings.providers {
            if !profile
                .discover_models
                .unwrap_or(settings.model_discovery.enabled)
            {
                continue;
            }
            let profile_name = profile_name.clone();
            let provider_id = profile_name.clone();
            let profile = profile.clone();
            let provider = if let Some(source) = &self.client_model_configuration {
                let mut selected = settings.clone();
                selected.apply_provider(Some(&profile_name))
                    .and_then(|_| source.provider(&selected))
            } else {
                ProviderFactory::new(&settings)
                    .build_profile(&profile_name)
                    .map(|(_, provider)| provider)
            };
            pending.push(async move {
                let result = match provider {
                    Ok(provider) => provider.discover_models(options).await,
                    Err(error) => Err(kcoder_api::ApiErrorKind::Api {
                        error_type: "model_discovery_provider".to_string(),
                        message: error.to_string(),
                    }),
                };
                DiscoveredModelGroup {
                    profile_name,
                    provider: provider_id,
                    endpoint: profile.endpoint,
                    configured_model: profile.default_model,
                    models: result.as_ref().cloned().unwrap_or_default(),
                    error: result.err().map(|error| error.to_string()),
                }
            });
        }

        let mut groups = Vec::new();
        while let Some(group) = pending.next().await {
            groups.push(group);
        }
        groups.sort_by_key(|group| {
            (
                current_profile.as_deref() != Some(group.profile_name.as_str()),
                group.provider.to_ascii_lowercase(),
                group.endpoint.to_ascii_lowercase(),
                group.profile_name.to_ascii_lowercase(),
            )
        });
        groups
    }

    /// Current model identifier (from settings).
    pub fn model_name(&self) -> String {
        recover_read_lock(&self.settings, "settings").model.clone()
    }

    pub fn client_model_selector(&self) -> String {
        let settings = recover_read_lock(&self.settings, "settings");
        settings
            .active_provider
            .as_ref()
            .map(|provider| format!("{provider}::{}", settings.model))
            .unwrap_or_else(|| settings.model.clone())
    }

    /// Sanitized configured model catalog for GUI clients. Endpoints and credentials are
    /// intentionally omitted from this boundary.
    pub fn configured_model_profiles(&self) -> Vec<ConfiguredModelProfile> {
        let settings = recover_read_lock(&self.settings, "settings").clone();
        Self::configured_model_profiles_for_settings(&settings)
    }

    /// List current configuration through this conversation's pinned source.
    pub fn current_configured_model_profiles(&self) -> Result<Vec<ConfiguredModelProfile>> {
        if let Some(source) = &self.client_model_configuration {
            if let Some(settings) = source.catalog_settings()? {
                return Self::configured_model_profiles_with_source(&settings, source.as_ref());
            }
        }
        Ok(self.configured_model_profiles())
    }

    pub fn configured_model_profiles_with_source(settings: &Settings, source: &dyn ClientModelConfiguration) -> Result<Vec<ConfiguredModelProfile>> {
                let mut profiles = Self::configured_model_profiles_for_settings(&settings);
                for profile in &mut profiles {
                    // Use exactly the resolver used by the next explicit turn, including
                    // the host's pinned templates and non-selection CLI overrides.
                    let (selected, fields) = source.settings_with_sources(&format!("{}::{}", profile.profile_name, profile.model))?;
                    let mut summary = model_configuration_summary(&selected, kcoder_types::ModelConfigurationBoundary::NextTurn)?;
                    summary.sources = fields;
                    profile.vision = summary.vision;
                    profile.reasoning = summary.reasoning;
                    profile.reasoning_effort = summary.reasoning_effort.clone();
                    // Credential overrides belong to the host resolver too; a
                    // settings-only factory may reject a revoked stored key even
                    // when the user explicitly supplied an independent CLI key.
                    let validation = source.provider(&selected).and_then(|provider| {
                        let requires_key = selected.active_provider.as_deref().and_then(|id| selected.providers.get(id))
                            .is_none_or(|profile| profile.authentication.is_api_key());
                        anyhow::ensure!(!requires_key || provider.api_key_configured() != Some(false), "Selected model credential is unavailable");
                        Ok(())
                    });
                    profile.available = validation.is_ok();
                    profile.error = validation.err().map(|error| error.to_string());
                    profile.configuration = Some(summary);
                }
                Ok(profiles)
    }

    /// Project a freshly loaded configuration without modifying any resident session.
    pub fn configured_model_profiles_for_settings(
        settings: &Settings,
    ) -> Vec<ConfiguredModelProfile> {
        settings
            .providers
            .iter()
            .flat_map(|(profile_name, profile)| {
                profile
                    .model_profiles()
                    .into_iter()
                    .map(|(model, parameters)| {
                        let build_error = (|| -> Result<()> {
                            let mut selected = settings.clone();
                            selected.apply_discovered_model(profile_name, &model)?;
                            let kind = ProviderKind::from_settings(&selected)?
                                .context("missing provider transport")?;
                            ProviderFactory::new(&selected).build(kind, &model)?;
                            Ok(())
                        })()
                        .err()
                        .map(|error| error.to_string());
                        ConfiguredModelProfile {
                            profile_name: profile_name.clone(),
                            provider: profile_name.clone(),
                            // The catalog describes configured choices, not a session's
                            // transient model override. Existing sessions report their model separately.
                            current: settings.active_provider.as_deref()
                                == Some(profile_name.as_str())
                                && settings.model == model,
                            model: model.clone(),
                            vision: parameters.capabilities.vision,
                            reasoning: parameters.capabilities.reasoning,
                            reasoning_effort: parameters.reasoning_effort.as_ref().map(ToString::to_string),
                            configuration: {
                                let mut selected = settings.clone();
                                selected.apply_discovered_model(profile_name, &model).ok()
                                    .and_then(|_| model_configuration_summary(&selected, kcoder_types::ModelConfigurationBoundary::NextTurn).ok())
                            },
                            available: build_error.is_none(),
                            error: build_error,
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    /// Resolve a client model selection to a configured profile, or to a discovered model on
    /// the active profile's transport. This keeps credentials inside the engine.
    pub fn select_client_model(&self, requested: &str) -> Result<()> {
        let requested = requested.trim();
        if requested.is_empty() {
            anyhow::bail!("model selection is empty")
        }
        let settings = recover_read_lock(&self.settings, "settings").clone();
        if let Some((profile_name, model)) = requested.split_once("::") {
            let profile = settings
                .providers
                .get(profile_name)
                .context("unknown provider in model selection")?;
            if !profile.has_model(model)
                && !profile
                    .discover_models
                    .unwrap_or(settings.model_discovery.enabled)
            {
                anyhow::bail!(
                    "model '{model}' is not configured for provider '{profile_name}' and discovery is disabled"
                );
            }
            self.switch_discovered_model(profile_name, model)?;
            return Ok(());
        }
        if settings.providers.contains_key(requested) {
            self.switch_provider_profile(requested)?;
            return Ok(());
        }
        if let Some(active) = settings.active_provider.as_deref()
            && settings
                .providers
                .get(active)
                .is_some_and(|profile| profile.has_model(requested))
        {
            self.switch_discovered_model(active, requested)?;
            return Ok(());
        }
        if settings.model == requested {
            return Ok(());
        }
        if let Some((profile_name, _)) = settings
            .providers
            .iter()
            .find(|(_, profile)| profile.has_model(requested))
        {
            self.switch_discovered_model(profile_name, requested)?;
            return Ok(());
        }
        let active_profile = settings
            .active_provider
            .as_deref()
            .context("no active provider profile is available for this model")?;
        self.switch_discovered_model(active_profile, requested)?;
        Ok(())
    }

    pub fn model_supports_vision(&self) -> bool {
        recover_read_lock(&self.settings, "settings")
            .model_capabilities
            .vision
    }

    /// Apply a client-selected reasoning effort to subsequent provider requests.
    pub fn set_client_reasoning_effort(&self, effort: &str) -> Result<()> {
        let current_settings = recover_read_lock(&self.settings, "settings").clone();
        let mut options =
            recover_read_lock(&self.client_model_options, "client model options").clone();
        options.bind_model(&current_settings);
        let follows_default = effort.trim() == "default";
        let parsed = if follows_default {
            if self.client_model_configuration.is_some() {
                options.default_reasoning.clone()
            } else {
                let settings = recover_read_lock(&self.settings, "settings");
                settings
                    .active_provider
                    .as_ref()
                    .and_then(|id| settings.providers.get(id))
                    .and_then(|profile| profile.effective_for_model(&settings.model).ok())
                    .and_then(|profile| profile.reasoning_effort)
            }
        } else {
            Some(
                effort
                    .parse::<kcoder_types::ReasoningEffort>()
                    .context("invalid client reasoning effort")?,
            )
        };
        kcoder_config::validate_reasoning_policy(current_settings.model_reasoning_policy.as_ref(), parsed.as_ref(), &current_settings.provider_extra_body)?;
        recover_write_lock(&self.settings, "settings").model_reasoning_effort = parsed.clone();
        options.reasoning = if follows_default { None } else { parsed };
        *recover_write_lock(&self.client_model_options, "client model options") = options;
        Ok(())
    }

    /// Apply ephemeral desktop transport/request options and atomically rebuild the active
    /// provider. Proxy credentials remain process-memory only through `Settings`' serde guards.
    pub fn set_client_runtime_options(
        &self,
        proxy_url: Option<&str>,
        service_tier: Option<&str>,
    ) -> Result<()> {
        let settings = recover_read_lock(&self.settings, "settings");
        let mut next_settings = settings.clone();
        apply_client_runtime_options(&mut next_settings, proxy_url, service_tier)?;
        let mut client_options = recover_read_lock(&self.client_model_options, "client model options").clone();
        client_options.bind_model(&next_settings);
        if proxy_url.is_some() { client_options.proxy = Some(next_settings.provider_proxy_url.clone()); }
        if service_tier.is_some() {
            client_options.service_tier = next_settings.provider_extra_body.get("service_tier").and_then(|value|value.as_str()).map(str::to_owned);
        }
        if next_settings.provider_proxy_url == settings.provider_proxy_url
            && next_settings.provider_extra_body.get("service_tier")
                == settings.provider_extra_body.get("service_tier")
        {
            *recover_write_lock(&self.client_model_options, "client model options") = client_options;
            return Ok(());
        }
        drop(settings);
        if !recover_read_lock(&self.provider, "provider").supports_client_runtime_reconfiguration()
        {
            *recover_write_lock(&self.settings, "settings") = next_settings;
            *recover_write_lock(&self.client_model_options, "client model options") = client_options;
            return Ok(());
        }
        let kind = ProviderKind::from_settings(&next_settings)?
            .context("active client provider is not configured")?;
        let next_provider = if let Some(source) = &self.client_model_configuration {
            if let Some(frozen) = &client_options.frozen_host {
                let updated = source.refreeze_model(frozen, &next_settings)?;
                let (_, provider) = source.thaw_model(&updated, next_settings.provider_proxy_url.clone())?;
                client_options.frozen_host = Some(updated);
                provider
            } else {
                source.provider(&next_settings)?
            }
        } else {
            ProviderFactory::new(&next_settings)
                .build(kind, &next_settings.model)
                .context("failed to apply client runtime options")?
        };
        *recover_write_lock(&self.provider, "provider") = next_provider;
        *recover_write_lock(&self.settings, "settings") = next_settings;
        *recover_write_lock(&self.client_model_options, "client model options") = client_options;
        Ok(())
    }
}


pub(super) fn apply_client_runtime_options(next_settings: &mut Settings, proxy_url: Option<&str>, service_tier: Option<&str>) -> Result<()> {
        if let Some(proxy_url) = proxy_url {
            let proxy_url = proxy_url.trim();
            if proxy_url.len() > 4096 {
                anyhow::bail!("client proxy URL exceeds 4096 bytes");
            }
            if proxy_url.chars().any(char::is_whitespace) {
                anyhow::bail!("client proxy URL must not contain whitespace");
            }
            if !proxy_url.is_empty()
                && !["http://", "https://", "socks5://"]
                    .iter()
                    .any(|scheme| proxy_url.starts_with(scheme))
            {
                anyhow::bail!("client proxy URL must use http, https, or socks5");
            }
            next_settings.provider_proxy_url =
                (!proxy_url.is_empty()).then(|| proxy_url.to_string());
        }
        if let Some(service_tier) = service_tier {
            let normalized = match service_tier.trim().to_ascii_lowercase().as_str() {
                "fast" | "priority" | "快速" | "运行快速" => Some("priority"),
                "standard" | "default" | "普通" | "标准" | "运行标准" => Some("default"),
                _ => None,
            };
            if let Some(normalized) = normalized {
                next_settings.provider_extra_body.insert(
                    "service_tier".to_string(),
                    serde_json::Value::String(normalized.to_string()),
                );
            } else {
                anyhow::bail!("unsupported client service tier");
            }
        }
    Ok(())
}

/// Safe read model built from the resolved settings used by the Engine. Body
/// contents affect only the opaque revision; they never enter this projection.
pub fn model_configuration_summary(settings: &Settings, boundary: kcoder_types::ModelConfigurationBoundary) -> Result<kcoder_types::ModelConfigurationSummary> {
    use sha2::{Digest, Sha256};
    let mut request_output_limits = std::collections::BTreeMap::new();
    let output_field = match settings.api_format.as_ref().map(|format| format.as_str()) {
        Some("openai_responses") => Some("max_output_tokens"),
        Some("anthropic_messages" | "openai_chat_completions") => Some("max_tokens"),
        _ => None,
    };
    if let Some(field) = output_field { request_output_limits.insert(field.into(), settings.max_tokens); }
    for field in ["max_tokens", "max_completion_tokens", "max_output_tokens"] {
        if let Some(value) = settings.provider_extra_body.get(field) {
            request_output_limits.insert(field.into(), value.as_u64().and_then(|value| u32::try_from(value).ok()));
        }
    }
    let mut summary = kcoder_types::ModelConfigurationSummary {
        provider_id: settings.active_provider.clone(), model_id: settings.model.clone(),
        api_format: settings.api_format.as_ref().map(|format| format.as_str().to_owned()),
        chat_protocol: serde_json::to_value(settings.provider_chat_protocol)?.as_str().unwrap_or("auto").to_owned(),
        context_window_tokens: settings.context_window_tokens, max_output_tokens: settings.max_tokens, request_output_limits,
        output_headroom_tokens: settings.context_output_headroom,
        text: settings.model_capabilities.text, tools: settings.model_capabilities.tools,
        vision: settings.model_capabilities.vision, reasoning: settings.model_capabilities.reasoning,
        structured_output: settings.model_capabilities.structured_output,
        reasoning_effort: settings.model_reasoning_effort.as_ref().map(ToString::to_string),
        reasoning_policy: settings.model_reasoning_policy.clone(),
        extra_body_configured: !settings.provider_extra_body.is_empty(),
        request_override_fields: ["max_tokens", "max_completion_tokens", "max_output_tokens", "temperature", "thinking", "reasoning", "reasoning_effort"]
            .into_iter().filter(|field| settings.provider_extra_body.contains_key(*field)).map(str::to_owned).collect(),
        revision: String::new(),
        boundary, sources: Default::default(),
    };
    let mut revision_summary = summary.clone();
    revision_summary.boundary = kcoder_types::ModelConfigurationBoundary::NextTurn;
    let bytes = serde_json::to_vec(&( &revision_summary, &settings.provider_extra_body, &settings.base_url, &settings.openai_base_url, &settings.anthropic_base_url, &settings.provider_chat_protocol ))?;
    summary.revision = format!("{:x}", Sha256::digest(bytes));
    Ok(summary)
}

#[cfg(test)]
mod configuration_summary_tests {
    use super::*;
    #[test]
    fn client_effort_rejects_declared_fixed_policy_without_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        settings.model_reasoning_effort = Some(kcoder_types::ReasoningEffort::High);
        settings.model_reasoning_policy = Some(kcoder_types::ModelReasoningPolicy { mode: kcoder_types::ReasoningControlMode::AlwaysOn, efforts: vec![] });
        let engine = crate::test_support::engine_builder::TestEngineBuilder::new(directory.path()).settings(settings).build();
        assert!(engine.set_client_reasoning_effort("none").is_err());
        assert_eq!(engine.settings.read().unwrap().model_reasoning_effort, Some(kcoder_types::ReasoningEffort::High));
    }
    #[test]
    fn summary_preserves_effective_limits_and_hides_vendor_fields() {
        let mut settings = Settings::default();
        settings.model = "fixture-model".into();
        settings.max_tokens = Some(3210);
        settings.context_window_tokens = Some(65432);
        settings.provider_extra_body.insert("vendor_secret".into(), serde_json::json!("PRIVATE_BODY_VALUE"));
        settings.provider_extra_body.insert("temperature".into(), serde_json::json!(0.2));
        let first = model_configuration_summary(&settings, kcoder_types::ModelConfigurationBoundary::NextTurn).unwrap();
        assert_eq!(first.max_output_tokens, Some(3210));
        assert_eq!(first.context_window_tokens, Some(65432));
        assert_eq!(first.request_override_fields, vec!["temperature"]);
        let public = serde_json::to_string(&first).unwrap();
        assert!(!public.contains("vendor_secret"));
        assert!(!public.contains("PRIVATE_BODY_VALUE"));
        settings.provider_extra_body.insert("temperature".into(), serde_json::json!(0.7));
        let second = model_configuration_summary(&settings, kcoder_types::ModelConfigurationBoundary::NextTurn).unwrap();
        assert_ne!(first.revision, second.revision);
    }
}

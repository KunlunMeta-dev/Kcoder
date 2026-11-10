//! Model configuration supplied by an owning host.

use crate::Provider;
use anyhow::Result;
use kcoder_config::Settings;
use std::sync::Arc;

/// A session owns this source. Hosts preserve its template/CLI overlay identity.
pub trait ClientModelConfiguration: Send + Sync {
    /// Public Web policy from the session-bound source. None preserves older host snapshots.
    fn web_settings(&self) -> Result<Option<kcoder_config::WebSettings>> {
        Ok(None)
    }

    fn settings(&self, selection: &str) -> Result<Settings>;
    fn provider(&self, settings: &Settings) -> Result<Arc<dyn Provider>>;
    /// Resolve values and provenance from one host configuration read. Older hosts
    /// report no provenance rather than joining labels from a later file version.
    fn settings_with_sources(
        &self,
        selection: &str,
    ) -> Result<(
        Settings,
        std::collections::BTreeMap<String, std::collections::BTreeSet<String>>,
    )> {
        Ok((self.settings(selection)?, Default::default()))
    }
    /// Resolve the current target default with this session's pinned overlays.
    /// None means the host does not support an explicit follow-default selection.
    fn default_settings(&self) -> Result<Option<Settings>> {
        Ok(None)
    }
    /// Capability declaration must not perform configuration IO during initialize.
    fn supports_default_selection(&self) -> bool {
        false
    }
    /// Read the session-bound catalog without changing its running model snapshot.
    fn catalog_settings(&self) -> Result<Option<Settings>> {
        Ok(None)
    }
    /// File-layer provenance without configuration values; None is an older host.
    fn configuration_file_sources(
        &self,
    ) -> Result<Option<Vec<kcoder_config::ModelConfigurationFieldSources>>> {
        Ok(None)
    }

    /// Authority labels for already-resolved model fields; no environment values.
    fn configuration_runtime_sources(
        &self,
        _settings: &Settings,
    ) -> Result<std::collections::BTreeMap<String, std::collections::BTreeSet<String>>> {
        Ok(Default::default())
    }

    /// Host-defined credential-free model semantics; None denotes unsupported providers.
    fn snapshot_api_format(&self, _snapshot: &[u8]) -> Result<Option<kcoder_config::ApiFormat>> {
        Ok(None)
    }
    fn freeze_model(
        &self,
        _settings: &Settings,
        _provider: &dyn Provider,
    ) -> Result<Option<Vec<u8>>> {
        Ok(None)
    }
    fn thaw_model(
        &self,
        _snapshot: &[u8],
        _proxy_credentials: Option<String>,
    ) -> Result<(Settings, Arc<dyn Provider>)> {
        anyhow::bail!("This model source cannot restore durable snapshots")
    }
    fn refreeze_model(&self, _snapshot: &[u8], _settings: &Settings) -> Result<Vec<u8>> {
        anyhow::bail!("This model source cannot update a durable snapshot")
    }
    fn thaw_model_with_proxy_override(
        &self,
        _snapshot: &[u8],
        _proxy_url: &str,
    ) -> Result<(Settings, Arc<dyn Provider>)> {
        anyhow::bail!("This model source cannot override a snapshot proxy")
    }
}

/// Safe read model built from the resolved settings used for the Provider request. Body
/// contents affect only the opaque revision; they never enter this projection.
pub fn model_configuration_summary(
    settings: &Settings,
    boundary: kcoder_types::ModelConfigurationBoundary,
) -> Result<kcoder_types::ModelConfigurationSummary> {
    use sha2::{Digest, Sha256};
    let mut request_output_limits = std::collections::BTreeMap::new();
    let output_field = match settings.api_format.as_ref().map(|format| format.as_str()) {
        Some("openai_responses") => Some("max_output_tokens"),
        Some("anthropic_messages" | "openai_chat_completions") => Some("max_tokens"),
        _ => None,
    };
    if let Some(field) = output_field {
        request_output_limits.insert(field.into(), settings.max_tokens);
    }
    for field in ["max_tokens", "max_completion_tokens", "max_output_tokens"] {
        if let Some(value) = settings.provider_extra_body.get(field) {
            request_output_limits.insert(
                field.into(),
                value.as_u64().and_then(|value| u32::try_from(value).ok()),
            );
        }
    }
    let mut summary = kcoder_types::ModelConfigurationSummary {
        provider_id: settings.active_provider.clone(),
        model_id: settings.model.clone(),
        api_format: settings
            .api_format
            .as_ref()
            .map(|format| format.as_str().to_owned()),
        chat_protocol: serde_json::to_value(settings.provider_chat_protocol)?
            .as_str()
            .unwrap_or("auto")
            .to_owned(),
        context_window_tokens: settings.context_window_tokens,
        max_output_tokens: settings.max_tokens,
        request_output_limits,
        output_headroom_tokens: settings.context_output_headroom,
        text: settings.model_capabilities.text,
        tools: settings.model_capabilities.tools,
        tool_set: Some(kcoder_types::ModelToolSetSummary {
            profile: Some(settings.tools.profile.as_str().into()),
            registry_scope: kcoder_types::ModelToolRegistryScope::ProfileConfiguration,
            registered_tool_count: None,
            exposed_tool_count: None,
        }),
        vision: settings.model_capabilities.vision,
        reasoning: settings.model_capabilities.reasoning,
        structured_output: settings.model_capabilities.structured_output,
        reasoning_effort: settings
            .model_reasoning_effort
            .as_ref()
            .map(ToString::to_string),
        reasoning_policy: settings.model_reasoning_policy.clone(),
        extra_body_configured: !settings.provider_extra_body.is_empty(),
        request_override_fields: [
            "max_tokens",
            "max_completion_tokens",
            "max_output_tokens",
            "temperature",
            "thinking",
            "reasoning",
            "reasoning_effort",
        ]
        .into_iter()
        .filter(|field| settings.provider_extra_body.contains_key(*field))
        .map(str::to_owned)
        .collect(),
        revision: String::new(),
        boundary,
        sources: Default::default(),
    };
    let mut revision_summary = summary.clone();
    revision_summary.boundary = kcoder_types::ModelConfigurationBoundary::NextTurn;
    let bytes = serde_json::to_vec(&(
        &revision_summary,
        &settings.provider_extra_body,
        &settings.base_url,
        &settings.openai_base_url,
        &settings.anthropic_base_url,
        &settings.provider_chat_protocol,
    ))?;
    summary.revision = format!("{:x}", Sha256::digest(bytes));
    Ok(summary)
}

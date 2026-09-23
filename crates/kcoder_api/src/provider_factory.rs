use crate::providers::{
    AnthropicProvider, GeminiProvider, GenAiProvider, GrokProvider, OpenAiProvider, Provider,
};
use anyhow::{Context, Result};
use kcoder_config::{ApiFormat, DEFAULT_LOCAL_ENDPOINT, Settings, default_provider_endpoint};
use std::sync::Arc;
use tracing::warn;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Anthropic,
    Openai,
    Local,
    Gemini,
    Grok,
    Kunlunmeta,
}

impl ProviderKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "anthropic" | "claude" => Some(Self::Anthropic),
            "openai" => Some(Self::Openai),
            "local" | "vllm" | "sglang" | "openai-compatible" | "openai_compatible" => {
                Some(Self::Local)
            }
            "gemini" | "google" => Some(Self::Gemini),
            "grok" | "xai" | "x.ai" => Some(Self::Grok),
            "kunlunmeta" | "kunlun-meta" | "kunlun_meta" => Some(Self::Kunlunmeta),
            _ => None,
        }
    }

    pub fn from_env() -> Option<Self> {
        if std::env::var("KCODER_USE_ANTHROPIC").is_ok_and(|v| v == "1") {
            Some(Self::Anthropic)
        } else if std::env::var("KCODER_USE_OPENAI").is_ok_and(|v| v == "1") {
            Some(Self::Openai)
        } else if std::env::var("KCODER_USE_LOCAL").is_ok_and(|v| v == "1")
            || std::env::var("KCODER_USE_VLLM").is_ok_and(|v| v == "1")
            || std::env::var("KCODER_USE_SGLANG").is_ok_and(|v| v == "1")
        {
            Some(Self::Local)
        } else if std::env::var("KCODER_USE_GEMINI").is_ok_and(|v| v == "1") {
            Some(Self::Gemini)
        } else if std::env::var("KCODER_USE_GROK").is_ok_and(|v| v == "1") {
            Some(Self::Grok)
        } else if std::env::var("KCODER_USE_KUNLUNMETA").is_ok_and(|v| v == "1") {
            Some(Self::Kunlunmeta)
        } else {
            None
        }
    }

    pub fn from_settings(settings: &Settings) -> Result<Option<Self>> {
        let Some(value) = settings.provider.as_deref() else {
            return Ok(None);
        };
        if value.trim().is_empty() {
            return Ok(None);
        }
        if let Some(kind) = Self::parse(value) {
            return Ok(Some(kind));
        }
        Ok(settings.api_format.map(|format| match format {
            ApiFormat::AnthropicMessages => Self::Anthropic,
            ApiFormat::OpenaiChatCompletions | ApiFormat::OpenaiResponses => Self::Openai,
            ApiFormat::GeminiGenerateContent => Self::Gemini,
        }))
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::Openai => "openai",
            Self::Local => "local",
            Self::Gemini => "gemini",
            Self::Grok => "grok",
            Self::Kunlunmeta => "kunlunmeta",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ProviderBuildOverrides {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub openai_api_key: Option<String>,
    pub openai_base_url: Option<String>,
    pub openai_user_agent: Option<String>,
    pub local_base_url: Option<String>,
    pub local_api_key: Option<String>,
    pub gemini_api_key: Option<String>,
    pub grok_api_key: Option<String>,
}

/// A provider cannot be constructed until credentials are configured.
///
/// This remains a normal build error for headless callers, while interactive
/// frontends can recognize it and open in a signed-out state.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct MissingApiKeyError {
    message: String,
}

impl MissingApiKeyError {
    fn new(message: String) -> Self {
        Self { message }
    }
}

pub struct ProviderFactory<'a> {
    settings: &'a Settings,
    overrides: ProviderBuildOverrides,
}

impl<'a> ProviderFactory<'a> {
    pub fn new(settings: &'a Settings) -> Self {
        Self {
            settings,
            overrides: ProviderBuildOverrides::default(),
        }
    }

    pub fn with_overrides(mut self, overrides: ProviderBuildOverrides) -> Self {
        self.overrides = overrides;
        self
    }

    pub fn resolve_kind(
        cli_provider: Option<ProviderKind>,
        env_provider: Option<ProviderKind>,
        settings: &Settings,
    ) -> Result<ProviderKind> {
        if let Some(provider) = cli_provider {
            return Ok(provider);
        }
        if let Some(provider) = env_provider {
            return Ok(provider);
        }
        Ok(ProviderKind::from_settings(settings)?.unwrap_or(ProviderKind::Anthropic))
    }

    pub fn build_default(&self, model: &str) -> Result<(ProviderKind, Arc<dyn Provider>)> {
        let kind = Self::resolve_kind(None, ProviderKind::from_env(), self.settings)?;
        let provider = self.build(kind, model)?;
        Ok((kind, provider))
    }

    pub fn build_named(&self, provider: &str, model: &str) -> Result<Arc<dyn Provider>> {
        if let Some((profile_name, _)) = self.settings.providers.get_key_value(provider) {
            let mut settings = self.settings.clone();
            settings.apply_discovered_model(profile_name, model)?;
            let kind =
                ProviderKind::from_settings(&settings)?.context("missing provider transport")?;
            return ProviderFactory::new(&settings).build(kind, model);
        }
        if let Some(kind) = ProviderKind::parse(provider) {
            return self.build(kind, model);
        }
        anyhow::bail!(
            "unknown provider or profile '{provider}'; configured Provider IDs are case-sensitive"
        )
    }

    /// Build a provider from an isolated named profile, without inheriting the
    /// main profile's endpoint, protocol, or model.
    pub fn build_profile(&self, profile_name: &str) -> Result<(String, Arc<dyn Provider>)> {
        let mut settings = self.settings.clone();
        settings.apply_provider(Some(profile_name))?;
        let model = settings.model.clone();
        let kind = ProviderKind::from_settings(&settings)?
            .ok_or_else(|| anyhow::anyhow!("profile '{profile_name}' has no provider"))?;
        let provider = ProviderFactory::new(&settings).build(kind, &model)?;
        Ok((model, provider))
    }

    /// Build a legacy provider/model pair without leaking the active main
    /// profile. A matching profile supplies its protocol and endpoint.
    pub fn build_named_isolated(
        &self,
        provider_name: &str,
        model: &str,
    ) -> Result<Arc<dyn Provider>> {
        let settings = self.settings_for_named_isolated(provider_name, model)?;
        ProviderFactory::new(&settings).build_named(provider_name, model)
    }

    /// Resolve an auxiliary deployment without constructing a transport, allowing
    /// the host to retain its credential refresh wrapper around that transport.
    pub fn settings_for_named_isolated(&self, provider_name: &str, model: &str) -> Result<Settings> {
        let mut settings = self.settings.clone();
        if settings.providers.contains_key(provider_name) {
            settings.apply_discovered_model(provider_name, model)?;
            return Ok(settings);
        }
        let kind = ProviderKind::parse(provider_name)
            .with_context(|| format!("unknown provider or profile '{provider_name}'"))?;
        settings.active_provider = None;
        settings.provider = Some(kind.as_str().into());
        settings.model = model.into();
        settings.api_format = None;
        settings.base_url = None;
        settings.request_timeout_secs = None;
        settings.provider_no_proxy = false;
        settings.provider_extra_body.clear();
        Ok(settings)
    }

    pub fn build(&self, kind: ProviderKind, model: &str) -> Result<Arc<dyn Provider>> {
        kcoder_config::validate_extra_body(&self.settings.provider_extra_body)?;
        self.settings.validate_model_reasoning_policy()?;
        if self
            .settings
            .active_provider
            .as_deref()
            .and_then(|id| self.settings.providers.get(id))
            .is_some_and(|profile| !profile.authentication.is_api_key())
        {
            anyhow::ensure!(
                self.settings.api_format == Some(ApiFormat::OpenaiChatCompletions),
                "Unauthenticated deployments require openai_chat_completions"
            );
            return self.build_unauthenticated_openai();
        }
        if let Some(format) = self.settings.api_format {
            match format {
                ApiFormat::AnthropicMessages
                    if !matches!(kind, ProviderKind::Anthropic | ProviderKind::Kunlunmeta) =>
                {
                    anyhow::bail!("api_format=anthropic_messages requires anthropic or kunlunmeta")
                }
                ApiFormat::OpenaiChatCompletions | ApiFormat::OpenaiResponses
                    if !matches!(
                        kind,
                        ProviderKind::Openai | ProviderKind::Local | ProviderKind::Grok
                    ) =>
                {
                    anyhow::bail!("OpenAI api_format requires openai, local, or grok")
                }
                ApiFormat::GeminiGenerateContent if kind != ProviderKind::Gemini => {
                    anyhow::bail!("api_format=gemini_generate_content requires gemini")
                }
                _ => {}
            }
        }
        match kind {
            ProviderKind::Anthropic => self.build_anthropic(),
            ProviderKind::Openai => self.build_openai(model),
            ProviderKind::Local => self.build_local(),
            ProviderKind::Gemini => self.build_gemini(model),
            ProviderKind::Grok => self.build_grok(model),
            ProviderKind::Kunlunmeta => self.build_kunlunmeta(),
        }
    }

    pub fn local_base_url(&self) -> String {
        self.local_endpoint_resolution(std::env::var("VLLM_BASE_URL").ok(), std::env::var("SGLANG_BASE_URL").ok()).0
    }

    fn local_endpoint_resolution(&self, vllm: Option<String>, sglang: Option<String>) -> (String, &'static str) {
        endpoint_candidate([
            (self.overrides.local_base_url.clone(), "cli_environment"),
            (vllm, "environment"), (sglang, "environment"),
            (self.overrides.openai_base_url.clone(), "cli_environment"),
            (self.configured_endpoint(first_non_empty([self.settings.local_base_url.clone(), self.settings.openai_base_url.clone()])), "configuration"),
        ]).unwrap_or_else(|| (DEFAULT_LOCAL_ENDPOINT.to_owned(), "default"))
    }

    pub fn local_api_key(&self) -> Option<String> {
        self.resolve_api_key(
            ProviderKind::Local,
            first_non_empty([
                self.overrides.local_api_key.clone(),
                self.overrides.openai_api_key.clone(),
                self.overrides.api_key.clone(),
            ]),
        )
    }

    fn build_anthropic(&self) -> Result<Arc<dyn Provider>> {
        let api_key = self
            .resolve_api_key(ProviderKind::Anthropic, self.overrides.api_key.clone())
            .ok_or_else(|| {
                self.missing_credential_error(
                    ProviderKind::Anthropic,
                    "ANTHROPIC_API_KEY",
                    "--api-key",
                )
            })?;
        let mut provider =
            AnthropicProvider::new(api_key).context("failed to create Anthropic provider")?;
        if let Some(url) = self.endpoint_override(ProviderKind::Anthropic) {
            provider = provider.with_base_url(url);
        }
        provider = self.configure_anthropic(provider)?;
        Ok(Arc::new(provider))
    }

    fn build_openai(&self, model: &str) -> Result<Arc<dyn Provider>> {
        let api_key = self
            .resolve_api_key(ProviderKind::Openai, self.overrides.openai_api_key.clone())
            .ok_or_else(|| {
                self.missing_credential_error(
                    ProviderKind::Openai,
                    "OPENAI_API_KEY",
                    "--openai-api-key",
                )
            })?;
        let api_format = self
            .settings
            .api_format
            .unwrap_or(ApiFormat::OpenaiChatCompletions);
        let endpoint = self.endpoint_override(ProviderKind::Openai);
        let minimax = api_format == ApiFormat::OpenaiChatCompletions
            && match self.settings.provider_chat_protocol {
                kcoder_types::ChatProtocol::Minimax => true,
                kcoder_types::ChatProtocol::Standard => false,
                kcoder_types::ChatProtocol::Auto => endpoint.as_deref().is_some_and(is_minimax_endpoint),
            };
        if api_format == ApiFormat::OpenaiChatCompletions && !minimax {
            return self.build_genai_openai(api_key);
        }
        let mut provider = OpenAiProvider::new(api_key, model)
            .context("failed to create OpenAI provider")?
            .with_api_format(api_format);
        if minimax {
            provider = provider.with_minimax_protocol();
        }
        if let Some(url) = self.endpoint_override(ProviderKind::Openai) {
            provider = provider.with_base_url(url);
        }
        if let Some(user_agent) = first_non_empty([
            self.overrides.openai_user_agent.clone(),
            self.settings.openai_user_agent.clone(),
        ]) {
            provider = provider.with_user_agent(user_agent);
        }
        for (key, value) in self.settings.provider_extra_body.clone() {
            provider = provider.with_extra_body_field(key, value);
        }
        provider = provider.with_no_proxy(self.settings.provider_no_proxy)?;
        provider = provider.with_proxy_url(self.settings.provider_proxy_url.clone())?;
        if let Some(timeout_secs) = self
            .settings
            .request_timeout_secs
            .or_else(openai_timeout_secs)
        {
            provider = provider
                .with_timeout_secs(timeout_secs)
                .context("failed to configure OpenAI provider timeout")?;
        }
        Ok(Arc::new(provider))
    }

    fn build_unauthenticated_openai(&self) -> Result<Arc<dyn Provider>> {
        let endpoint = self
            .endpoint_override(ProviderKind::Openai)
            .context("Unauthenticated deployment endpoint is missing")?;
        let minimax = match self.settings.provider_chat_protocol {
            kcoder_types::ChatProtocol::Minimax => true,
            kcoder_types::ChatProtocol::Standard => false,
            kcoder_types::ChatProtocol::Auto => is_minimax_endpoint(&endpoint),
        };
        // Do not resolve credentials or inherit local-provider environment body fields.
        let mut provider = OpenAiProvider::local_compatible()?
            .with_base_url(endpoint)
            .with_provider_name("openai")
            .with_api_format(ApiFormat::OpenaiChatCompletions)
            .with_no_proxy(self.settings.provider_no_proxy)?
            .with_proxy_url(self.settings.provider_proxy_url.clone())?;
        if minimax { provider = provider.with_minimax_protocol(); }
        for (key, value) in self.settings.provider_extra_body.clone() {
            provider = provider.with_extra_body_field(key, value);
        }
        if let Some(user_agent) = first_non_empty([
            self.overrides.openai_user_agent.clone(),
            self.settings.openai_user_agent.clone(),
        ]) {
            provider = provider.with_user_agent(user_agent);
        }
        if let Some(timeout) = self
            .settings
            .request_timeout_secs
            .or_else(openai_timeout_secs)
        {
            provider = provider.with_timeout_secs(timeout)?;
        }
        Ok(Arc::new(provider))
    }

    fn build_genai_openai(&self, api_key: String) -> Result<Arc<dyn Provider>> {
        let mut provider =
            GenAiProvider::new(api_key).context("failed to create genai OpenAI provider")?;
        if let Some(url) = self.endpoint_override(ProviderKind::Openai) {
            provider = provider.with_base_url(url);
        }
        if let Some(user_agent) = first_non_empty([
            self.overrides.openai_user_agent.clone(),
            self.settings.openai_user_agent.clone(),
        ]) {
            provider = provider
                .with_user_agent(user_agent)
                .context("failed to configure genai OpenAI user agent")?;
        }
        for (key, value) in self.settings.provider_extra_body.clone() {
            provider = provider.with_extra_body_field(key, value);
        }
        provider = provider.with_no_proxy(self.settings.provider_no_proxy)?;
        provider = provider.with_proxy_url(self.settings.provider_proxy_url.clone())?;
        if let Some(timeout_secs) = self
            .settings
            .request_timeout_secs
            .or_else(openai_timeout_secs)
        {
            provider = provider
                .with_timeout_secs(timeout_secs)
                .context("failed to configure genai OpenAI provider timeout")?;
        }
        Ok(Arc::new(provider))
    }

    fn build_local(&self) -> Result<Arc<dyn Provider>> {
        let mut provider = OpenAiProvider::local_compatible()
            .context("failed to create local OpenAI-compatible provider")?
            .with_base_url(self.local_base_url())
            .with_optional_api_key(self.local_api_key())
            .with_stream_options(false)
            .with_provider_name("local");
        provider = provider.with_api_format(
            self.settings
                .api_format
                .unwrap_or(ApiFormat::OpenaiChatCompletions),
        );
        for (key, value) in self.settings.provider_extra_body.clone() {
            provider = provider.with_extra_body_field(key, value);
        }
        for (key, value) in local_extra_body_fields() {
            provider = provider.with_extra_body_field(key, value);
        }
        provider = provider.with_no_proxy(self.settings.provider_no_proxy)?;
        provider = provider.with_proxy_url(self.settings.provider_proxy_url.clone())?;
        if let Some(user_agent) = first_non_empty([
            self.overrides.openai_user_agent.clone(),
            self.settings.openai_user_agent.clone(),
        ]) {
            provider = provider.with_user_agent(user_agent);
        }
        if let Some(timeout_secs) = self
            .settings
            .request_timeout_secs
            .or_else(openai_timeout_secs)
        {
            provider = provider
                .with_timeout_secs(timeout_secs)
                .context("failed to configure local OpenAI-compatible provider timeout")?;
        }
        Ok(Arc::new(provider))
    }

    fn build_gemini(&self, model: &str) -> Result<Arc<dyn Provider>> {
        let api_key = self
            .resolve_api_key(ProviderKind::Gemini, self.overrides.gemini_api_key.clone())
            .ok_or_else(|| {
                self.missing_credential_error(
                    ProviderKind::Gemini,
                    "GEMINI_API_KEY",
                    "--gemini-api-key",
                )
            })?;
        let mut provider =
            GeminiProvider::new(api_key, model).context("failed to create Gemini provider")?;
        if let Some(url) = self.endpoint_override(ProviderKind::Gemini) {
            provider = provider.with_base_url(url);
        }
        provider = provider.with_extra_body(self.settings.provider_extra_body.clone());
        provider = provider.with_no_proxy(self.settings.provider_no_proxy)?;
        provider = provider.with_proxy_url(self.settings.provider_proxy_url.clone())?;
        if let Some(timeout_secs) = self.settings.request_timeout_secs {
            provider = provider.with_timeout_secs(timeout_secs)?;
        }
        Ok(Arc::new(provider))
    }

    fn build_grok(&self, model: &str) -> Result<Arc<dyn Provider>> {
        let api_key = self
            .resolve_api_key(ProviderKind::Grok, self.overrides.grok_api_key.clone())
            .ok_or_else(|| {
                self.missing_credential_error(ProviderKind::Grok, "GROK_API_KEY", "--grok-api-key")
            })?;
        let mut provider = GrokProvider::new(api_key, model).with_api_format(
            self.settings
                .api_format
                .unwrap_or(ApiFormat::OpenaiChatCompletions),
        );
        if let Some(url) = self.endpoint_override(ProviderKind::Grok) {
            provider = provider.with_base_url(url);
        }
        provider = provider.with_extra_body(self.settings.provider_extra_body.clone());
        provider = provider.with_no_proxy(self.settings.provider_no_proxy)?;
        provider = provider.with_proxy_url(self.settings.provider_proxy_url.clone())?;
        if let Some(timeout_secs) = self
            .settings
            .request_timeout_secs
            .or_else(openai_timeout_secs)
        {
            provider = provider.with_timeout_secs(timeout_secs)?;
        }
        Ok(Arc::new(provider))
    }

    fn build_kunlunmeta(&self) -> Result<Arc<dyn Provider>> {
        let api_key = self
            .resolve_api_key(ProviderKind::Kunlunmeta, self.overrides.api_key.clone())
            .ok_or_else(|| {
                self.missing_credential_error(
                    ProviderKind::Kunlunmeta,
                    "KUNLUNMETA_BASE_API_KEY",
                    "--api-key",
                )
            })?;
        let base_url = self
            .endpoint_override(ProviderKind::Kunlunmeta)
        .or_else(|| default_provider_endpoint("kunlunmeta"))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "KunlunMeta deployment endpoint is not configured; add providers.kunlunmeta.endpoint to settings.json"
            )
        })?;
        let provider = AnthropicProvider::new(api_key)
            .context("failed to create KunlunMeta provider")?
            .with_base_url(base_url)
            .with_provider_name("kunlunmeta");
        Ok(Arc::new(self.configure_anthropic(provider)?))
    }

    fn configure_anthropic(&self, mut provider: AnthropicProvider) -> Result<AnthropicProvider> {
        provider = provider.with_extra_body(self.settings.provider_extra_body.clone());
        provider = provider.with_no_proxy(self.settings.provider_no_proxy)?;
        provider = provider.with_proxy_url(self.settings.provider_proxy_url.clone())?;
        if let Some(timeout_secs) = self.settings.request_timeout_secs {
            provider = provider
                .with_timeout_secs(timeout_secs)
                .context("failed to configure Anthropic-compatible provider timeout")?;
        }
        Ok(provider)
    }

    /// Resolve the configured transport address without creating a client or making a request.
    /// Snapshot restoration uses the same precedence to read current URL credential slots.
    pub fn endpoint_override(&self, kind: ProviderKind) -> Option<String> {
        self.endpoint_resolution(kind).map(|(endpoint, _)| endpoint)
    }

    /// The same selected candidate as transport construction, without its URL.
    pub fn endpoint_source(&self, kind: ProviderKind) -> Option<&'static str> {
        self.endpoint_resolution(kind).map(|(_, source)| source)
    }

    fn endpoint_resolution(&self, kind: ProviderKind) -> Option<(String, &'static str)> {
        if self.settings.active_provider.as_deref().and_then(|id| self.settings.providers.get(id))
            .is_some_and(|profile| !profile.authentication.is_api_key()) {
            return endpoint_candidate([
                (self.overrides.local_base_url.clone(), "cli_environment"),
                (self.overrides.openai_base_url.clone(), "cli_environment"),
                (self.overrides.base_url.clone(), "cli_environment"),
                (self.configured_endpoint(self.settings.openai_base_url.clone()), "configuration"),
            ]);
        }
        match kind {
            ProviderKind::Anthropic => endpoint_candidate([
                (self.overrides.base_url.clone(), "cli_environment"),
                (std::env::var("ANTHROPIC_BASE_URL").ok(), "environment"),
                (self.configured_endpoint(self.settings.anthropic_base_url.clone()), "configuration"),
            ]),
            ProviderKind::Openai => endpoint_candidate([
                (self.overrides.openai_base_url.clone(), "cli_environment"),
                (self.configured_endpoint(self.settings.openai_base_url.clone()), "configuration"),
            ]),
            ProviderKind::Gemini => endpoint_candidate([(self.configured_endpoint(self.settings.gemini_base_url.clone()), "configuration")]),
            ProviderKind::Grok => endpoint_candidate([(self.configured_endpoint(self.settings.grok_base_url.clone()), "configuration")]),
            ProviderKind::Kunlunmeta => endpoint_candidate([
                (self.overrides.base_url.clone(), "cli_environment"),
                (std::env::var("KUNLUNMETA_BASE_URL").ok(), "environment"),
                (self.configured_endpoint(self.settings.kunlunmeta_base_url.clone()), "configuration"),
            ]),
            ProviderKind::Local => Some(self.local_endpoint_resolution(std::env::var("VLLM_BASE_URL").ok(), std::env::var("SGLANG_BASE_URL").ok())),
        }
    }

    fn configured_endpoint(&self, provider_specific: Option<String>) -> Option<String> {
        if self.settings.active_provider.is_some() {
            first_non_empty([self.settings.base_url.clone(), provider_specific])
        } else {
            first_non_empty([provider_specific, self.settings.base_url.clone()])
        }
    }

    /// Return the credential used by this transport and its authority layer.
    /// The selector follows the same deployment rules as transport construction.
    pub fn credential_resolution(
        &self,
        kind: ProviderKind,
    ) -> Option<(String, kcoder_config::ResolvedProviderApiKey)> {
        let explicit = match kind {
            ProviderKind::Anthropic | ProviderKind::Kunlunmeta => self.overrides.api_key.clone(),
            ProviderKind::Openai => self.overrides.openai_api_key.clone(),
            ProviderKind::Local => first_non_empty([
                self.overrides.local_api_key.clone(),
                self.overrides.openai_api_key.clone(),
                self.overrides.api_key.clone(),
            ]),
            ProviderKind::Gemini => self.overrides.gemini_api_key.clone(),
            ProviderKind::Grok => self.overrides.grok_api_key.clone(),
        };
        let selector = self.credential_selector(kind);
        self.settings.resolve_provider_api_key_with_source(Some(selector), explicit)
            .map(|credential| (selector.to_owned(), credential))
    }

    fn credential_selector(&self, kind: ProviderKind) -> &str {
        if let Some(active_provider) = self.settings.active_provider.as_deref()
            && let Some(profile) = self.settings.providers.get(active_provider)
        {
            let profile_kind =
                ProviderKind::parse(active_provider).unwrap_or(match profile.api_format {
                    ApiFormat::AnthropicMessages => ProviderKind::Anthropic,
                    ApiFormat::OpenaiChatCompletions | ApiFormat::OpenaiResponses => {
                        ProviderKind::Openai
                    }
                    ApiFormat::GeminiGenerateContent => ProviderKind::Gemini,
                });
            if profile_kind == kind {
                return active_provider;
            }
        }
        if let Some(provider) = self.settings.provider.as_deref()
            && ProviderKind::from_settings(self.settings).ok().flatten() == Some(kind)
        {
            return provider;
        }
        kind.as_str()
    }

    fn resolve_api_key(&self, kind: ProviderKind, explicit: Option<String>) -> Option<String> {
        self.settings
            .resolve_provider_api_key(Some(self.credential_selector(kind)), explicit)
    }

    fn missing_credential_error(
        &self,
        kind: ProviderKind,
        fallback_env: &str,
        cli_hint: &str,
    ) -> anyhow::Error {
        let credential = self
            .settings
            .provider_credential(Some(self.credential_selector(kind)));
        let env_hint = credential
            .as_ref()
            .filter(|credential| !credential.env.is_empty())
            .map(|credential| credential.env.join(" or "))
            .unwrap_or_else(|| fallback_env.to_string());
        let provider = credential
            .map(|credential| credential.id)
            .unwrap_or_else(|| "<provider>".to_string());
        MissingApiKeyError::new(format!(
            "{env_hint} must be set or passed via {cli_hint}. Run `kcoder auth login --provider {provider}` to store it securely. Do not store API keys in settings.json."
        ))
        .into()
    }
}

fn endpoint_candidate(values: impl IntoIterator<Item = (Option<String>, &'static str)>) -> Option<(String, &'static str)> {
    values.into_iter().find_map(|(value, source)| first_non_empty([value]).map(|value| (value, source)))
}

pub fn first_non_empty(values: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
}

pub fn missing_api_key_message(env_hint: &str, cli_hint: &str) -> String {
    let provider = if env_hint.contains("KUNLUNMETA") {
        "kunlunmeta"
    } else if env_hint.contains("ANTHROPIC") {
        "anthropic"
    } else if env_hint.contains("OPENAI") {
        "openai"
    } else if env_hint.contains("GEMINI") {
        "gemini"
    } else if env_hint.contains("GROK") {
        "grok"
    } else {
        "<provider>"
    };
    format!(
        "{env_hint} must be set or passed via {cli_hint}. Run `kcoder auth login --provider {provider}` to store it securely. Do not store API keys in settings.json."
    )
}

#[cfg(test)]
fn missing_api_key_error(env_hint: &str, cli_hint: &str) -> anyhow::Error {
    MissingApiKeyError::new(missing_api_key_message(env_hint, cli_hint)).into()
}

fn local_extra_body_fields() -> Vec<(String, serde_json::Value)> {
    let mut fields = Vec::new();
    if env_bool("KCODER_LOCAL_DISABLE_THINKING").unwrap_or(false) {
        fields.push((
            "chat_template_kwargs".to_string(),
            serde_json::json!({ "enable_thinking": false }),
        ));
    }
    if let Some(value) = env_u64("KCODER_LOCAL_TOP_K") {
        fields.push(("top_k".to_string(), serde_json::json!(value)));
    }
    if let Some(value) = env_f64("KCODER_LOCAL_TOP_P") {
        fields.push(("top_p".to_string(), serde_json::json!(value)));
    }
    if let Some(value) = env_f64("KCODER_LOCAL_TEMPERATURE") {
        fields.push(("temperature".to_string(), serde_json::json!(value)));
    }
    fields
}

fn openai_timeout_secs() -> Option<u64> {
    for name in ["KCODER_OPENAI_TIMEOUT_S", "OPENAI_TIMEOUT_S"] {
        if let Some(value) = env_u64(name) {
            if value == 0 {
                warn!("ignoring {name}=0; expected positive timeout seconds");
                return None;
            }
            return Some(value);
        }
    }
    None
}

fn env_bool(name: &str) -> Option<bool> {
    std::env::var(name).ok().map(|value| {
        matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn env_u64(name: &str) -> Option<u64> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => match value.trim().parse::<u64>() {
            Ok(parsed) => Some(parsed),
            Err(error) => {
                warn!("ignoring invalid {name}={value:?}: {error}");
                None
            }
        },
        _ => None,
    }
}

fn env_f64(name: &str) -> Option<f64> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => match value.trim().parse::<f64>() {
            Ok(parsed) => Some(parsed),
            Err(error) => {
                warn!("ignoring invalid {name}={value:?}: {error}");
                None
            }
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_config::ProviderConfig;

    #[test]
    fn provider_kind_parses_aliases() {
        assert_eq!(ProviderKind::parse("openai"), Some(ProviderKind::Openai));
        assert_eq!(
            ProviderKind::parse("openai-compatible"),
            Some(ProviderKind::Local)
        );
        assert_eq!(ProviderKind::parse("vllm"), Some(ProviderKind::Local));
        assert_eq!(ProviderKind::parse("minimax"), None);
        assert_eq!(
            ProviderKind::parse("kunlunmeta"),
            Some(ProviderKind::Kunlunmeta)
        );
        assert_eq!(ProviderKind::parse("unknown"), None);
    }

    #[test]
    fn resolve_provider_kind_prefers_cli_then_env_then_settings() {
        let settings = Settings {
            provider: Some("grok".to_string()),
            ..Settings::default()
        };

        assert_eq!(
            ProviderFactory::resolve_kind(
                Some(ProviderKind::Openai),
                Some(ProviderKind::Local),
                &settings,
            )
            .unwrap(),
            ProviderKind::Openai
        );
        assert_eq!(
            ProviderFactory::resolve_kind(None, Some(ProviderKind::Local), &settings).unwrap(),
            ProviderKind::Local
        );
        assert_eq!(
            ProviderFactory::resolve_kind(None, None, &settings).unwrap(),
            ProviderKind::Grok
        );
        assert_eq!(
            ProviderFactory::resolve_kind(None, None, &Settings::default()).unwrap(),
            ProviderKind::Kunlunmeta
        );
    }

    #[test]
    fn local_base_url_prefers_overrides_over_settings() {
        let settings = Settings {
            local_base_url: Some("https://settings-local.example/v1".to_string()),
            openai_base_url: Some("https://settings-openai.example/v1".to_string()),
            base_url: Some("https://settings-generic.example/v1".to_string()),
            ..Settings::default()
        };
        let factory = ProviderFactory::new(&settings).with_overrides(ProviderBuildOverrides {
            local_base_url: Some("https://cli.example/v1".to_string()),
            ..ProviderBuildOverrides::default()
        });

        assert_eq!(factory.local_base_url(), "https://cli.example/v1");
    }

    #[test]
    fn built_provider_reports_effective_endpoint_key_and_timeout_metadata() {
        let settings = Settings {
            active_provider: None,
            api_format: Some(ApiFormat::OpenaiChatCompletions),
            ..Settings::default()
        };
        let provider = ProviderFactory::new(&settings)
            .with_overrides(ProviderBuildOverrides {
                local_base_url: Some("https://cli.example/v1".to_string()),
                local_api_key: Some("runtime-secret".to_string()),
                ..ProviderBuildOverrides::default()
            })
            .build(ProviderKind::Local, "local-model")
            .unwrap();

        assert_eq!(provider.endpoint(), Some("https://cli.example/v1"));
        assert_eq!(provider.api_key_configured(), Some(true));
        assert!(provider.request_timeout_secs().is_some());
    }

    #[test]
    fn explicit_minimax_dialect_works_through_an_unauthenticated_reverse_proxy() {
        let mut settings = Settings::default();
        let mut profile = kcoder_config::default_active_provider_config();
        profile.api_format = ApiFormat::OpenaiChatCompletions;
        profile.authentication = kcoder_types::ProviderAuthentication::None;
        profile.chat_protocol = kcoder_types::ChatProtocol::Minimax;
        profile.endpoint = "http://127.0.0.1:8123/v1".into();
        settings.providers.insert("proxy".into(), profile);
        settings.apply_provider(Some("proxy")).unwrap();
        let provider = ProviderFactory::new(&settings).build(ProviderKind::Openai, "MiniMax-M3").unwrap();
        assert_eq!(provider.name(), "minimax");
        assert_eq!(provider.api_key_configured(), Some(false));
    }

    #[test]
    fn explicit_unauthenticated_profile_builds_without_resolving_keys() {
        let mut settings = Settings::default();
        let mut profile = kcoder_config::default_active_provider_config();
        profile.api_format = ApiFormat::OpenaiChatCompletions;
        profile.authentication = kcoder_types::ProviderAuthentication::None;
        profile.endpoint = "http://127.0.0.1:8123/v1".into();
        settings.providers.insert("private-local".into(), profile);
        settings.apply_provider(Some("private-local")).unwrap();
        settings
            .stored_provider_credentials
            .insert("private-local".into(), "unused-fixture-key".into());
        let provider = ProviderFactory::new(&settings)
            .build(ProviderKind::Openai, "local-model")
            .unwrap();
        assert_eq!(provider.api_key_configured(), Some(false));
        assert_eq!(provider.endpoint(), Some("http://127.0.0.1:8123/v1"));
    }

    #[test]
    fn named_multi_model_profiles_preserve_case_sensitive_ids_and_builtin_overrides() {
        let mut settings = Settings::default();
        settings.providers.clear();
        for (id, endpoint) in [
            ("Foo", "http://127.0.0.1:8123/v1"),
            ("foo", "http://127.0.0.1:8124/v1"),
            ("openai", "http://127.0.0.1:8125/v1"),
        ] {
            let profile: ProviderConfig = serde_json::from_value(serde_json::json!({
                "authentication":{"mode":"none"},
                "api_format":"openai_chat_completions", "endpoint":endpoint,
                "default_model":"shared-model",
                "models":{"shared-model":{
                    "context_window_tokens":32000,"output_headroom_tokens":4000,"max_output_tokens":3000
                }}
            })).unwrap();
            settings.providers.insert(id.into(), profile);
        }
        settings.apply_provider(Some("Foo")).unwrap();
        for (id, endpoint) in [
            ("Foo", "http://127.0.0.1:8123/v1"),
            ("foo", "http://127.0.0.1:8124/v1"),
            ("openai", "http://127.0.0.1:8125/v1"),
        ] {
            let factory = ProviderFactory::new(&settings);
            assert_eq!(
                factory.build_named(id, "shared-model").unwrap().endpoint(),
                Some(endpoint)
            );
            assert_eq!(
                factory
                    .build_named_isolated(id, "shared-model")
                    .unwrap()
                    .endpoint(),
                Some(endpoint)
            );
        }
        assert!(
            ProviderFactory::new(&settings)
                .build_named("FOO", "shared-model")
                .is_err()
        );
        assert!(
            ProviderFactory::new(&settings)
                .build_named_isolated("FOO", "shared-model")
                .is_err()
        );
    }

    #[test]
    fn local_endpoint_source_tracks_the_selected_candidate_not_override_presence() {
        let settings = Settings::default();
        let factory = ProviderFactory::new(&settings).with_overrides(ProviderBuildOverrides {
            openai_base_url: Some("http://cli.example/v1".into()), ..Default::default()
        });
        assert_eq!(factory.local_endpoint_resolution(Some(" http://vllm.example/v1 ".into()), None),
            ("http://vllm.example/v1".into(), "environment"));
        assert_eq!(factory.local_endpoint_resolution(Some(" ".into()), Some("http://sglang.example/v1".into())),
            ("http://sglang.example/v1".into(), "environment"));
        assert_eq!(factory.local_endpoint_resolution(None, None), ("http://cli.example/v1".into(), "cli_environment"));
        let explicit = ProviderFactory::new(&settings).with_overrides(ProviderBuildOverrides {
            local_base_url: Some("http://explicit.example/v1".into()), ..Default::default()
        });
        assert_eq!(explicit.local_endpoint_resolution(Some("http://env.example/v1".into()), None),
            ("http://explicit.example/v1".into(), "cli_environment"));
    }

    #[test]
    fn first_non_empty_trims_and_skips_empty_values() {
        assert_eq!(
            first_non_empty([None, Some("  ".to_string()), Some(" key ".to_string())]),
            Some("key".to_string())
        );
    }

    #[test]
    fn missing_api_key_message_does_not_recommend_settings_storage() {
        let message = missing_api_key_message("OPENAI_API_KEY", "--openai-api-key");
        assert!(message.contains("OPENAI_API_KEY"));
        assert!(message.contains("kcoder auth login --provider openai"));
        assert!(!message.contains("openai_api_key/api_key"));
    }

    #[test]
    fn kunlunmeta_missing_api_key_message_names_the_correct_login_provider() {
        let message = missing_api_key_message("KUNLUNMETA_BASE_API_KEY", "--api-key");

        assert!(message.contains("kcoder auth login --provider kunlunmeta"));
    }

    #[test]
    fn missing_api_key_errors_are_typed_for_interactive_frontends() {
        let error = missing_api_key_error("KUNLUNMETA_BASE_API_KEY", "--api-key");

        assert!(error.downcast_ref::<MissingApiKeyError>().is_some());
    }

    #[test]
    fn kunlunmeta_provider_uses_its_default_profile() {
        // KUNLUNMETA_BASE_URL overrides the default endpoint in build_kunlunmeta.
        // This test asserts the default profile, so isolate the variable and restore it afterward.
        let saved_base_url = std::env::var("KUNLUNMETA_BASE_URL").ok();
        unsafe {
            std::env::remove_var("KUNLUNMETA_BASE_URL");
        }
        let settings = Settings {
            active_provider: None,
            api_format: Some(ApiFormat::AnthropicMessages),
            provider_no_proxy: true,
            kunlunmeta_api_key: Some("test-key".to_string()),
            ..Settings::default()
        };
        let provider = ProviderFactory::new(&settings)
            .build(ProviderKind::Kunlunmeta, "MiniMax-M3")
            .unwrap();

        assert_eq!(provider.name(), "kunlunmeta");
        assert_eq!(provider.endpoint(), Some("http://127.0.0.1:8000"));
        assert_eq!(provider.api_key_configured(), Some(true));
        if let Some(saved_base_url) = saved_base_url {
            unsafe {
                std::env::set_var("KUNLUNMETA_BASE_URL", saved_base_url);
            }
        }
    }

    #[test]
    fn named_provider_is_built_without_inheriting_main_protocol() {
        let mut settings = Settings {
            api_format: Some(ApiFormat::OpenaiResponses),
            ..Settings::default()
        };
        settings
            .stored_provider_credentials
            .insert("summary".to_string(), "test-key".to_string());
        settings.providers.insert(
            "summary".to_string(),
            serde_json::from_value::<ProviderConfig>(serde_json::json!({
                "api_format": "anthropic_messages",
                "endpoint": "https://summary.example/anthropic",
                "default_model": "summary-model",
                "context_window_tokens": 100000,
                "output_headroom_tokens": 10000,
                "max_output_tokens": 5000
            }))
            .unwrap(),
        );

        let (model, provider) = ProviderFactory::new(&settings)
            .build_profile("summary")
            .unwrap();

        assert_eq!(model, "summary-model");
        // Provider::name() identifies the transport adapter; the `summary` mapping
        // still determines provider identity and credential selection.
        assert_eq!(provider.name(), "anthropic");
    }

    #[test]
    fn custom_openai_compatible_profile_uses_generic_stored_credential() {
        let mut settings = Settings::default();
        settings.providers.insert(
            "deepseek".to_string(),
            serde_json::from_value::<ProviderConfig>(serde_json::json!({
                "credential_env": ["DEEPSEEK_API_KEY"],
                "api_format": "openai_chat_completions",
                "endpoint": "https://api.deepseek.com/v1",
                "default_model": "deepseek-chat",
                "context_window_tokens": 128000,
                "output_headroom_tokens": 8192,
                "max_output_tokens": 8192
            }))
            .unwrap(),
        );
        settings
            .stored_provider_credentials
            .insert("deepseek".to_string(), "stored-deepseek-key".to_string());
        settings.apply_provider(Some("deepseek")).unwrap();

        assert_eq!(
            ProviderKind::from_settings(&settings).unwrap(),
            Some(ProviderKind::Openai)
        );
        let provider = ProviderFactory::new(&settings)
            .build_named("deepseek", "deepseek-chat")
            .unwrap();
        assert_eq!(provider.endpoint(), Some("https://api.deepseek.com/v1"));
        assert_eq!(provider.api_key_configured(), Some(true));
    }

    #[test]
    fn grok_accepts_openai_compatible_api_formats() {
        let settings = Settings {
            api_format: Some(ApiFormat::OpenaiResponses),
            grok_api_key: Some("test-key".to_string()),
            ..Settings::default()
        };

        let provider = ProviderFactory::new(&settings)
            .build(ProviderKind::Grok, "grok-test")
            .unwrap();
        assert_eq!(provider.name(), "grok");
    }
}


fn is_minimax_endpoint(endpoint: &str) -> bool {
    reqwest::Url::parse(endpoint).ok().is_some_and(|url| {
        matches!(url.host_str(), Some("api.minimax.cn" | "api.minimaxi.com" | "api.minimax.io"))
    })
}

#[test]
fn minimax_endpoint_selection_is_exact() {
    for host in ["api.minimax.cn", "api.minimaxi.com", "api.minimax.io"] {
        assert!(is_minimax_endpoint(&format!("https://{host}/v1")));
    }
    for url in ["https://api.minimax.cn.example.com/v1", "https://example.com/minimax", "not a url"] {
        assert!(!is_minimax_endpoint(url));
    }
}

#[cfg(test)]
mod request_body_contract_tests {
    use super::*;

    #[test]
    fn direct_runtime_settings_cannot_override_structural_fields() {
        for kind in [
            ProviderKind::Anthropic,
            ProviderKind::Openai,
            ProviderKind::Local,
            ProviderKind::Gemini,
            ProviderKind::Grok,
            ProviderKind::Kunlunmeta,
        ] {
            let mut settings = Settings::default();
            settings
                .provider_extra_body
                .insert("tools".into(), serde_json::json!(["PRIVATE_SENTINEL"]));
            let error = ProviderFactory::new(&settings)
                .build(kind, "test-model")
                .err()
                .expect("must reject before provider construction")
                .to_string();
            assert!(error.contains("runtime-owned field 'tools'"));
            assert!(!error.contains("PRIVATE_SENTINEL"));
        }
    }
    #[test]
    fn isolated_legacy_selection_does_not_keep_the_main_credential_identity() {
        let mut settings = Settings::default();
        settings.providers.clear();
        settings.active_provider = None;
        settings.provider = Some("main-deployment".into());
        settings.api_format = Some(ApiFormat::OpenaiChatCompletions);
        settings.base_url = Some("http://main.invalid/v1".into());
        settings.provider_extra_body.insert("temperature".into(), serde_json::json!(0.9));
        settings.stored_provider_credentials.insert("main-deployment".into(), "main-fixture".into());
        settings.stored_provider_credentials.insert("openai".into(), "summary-fixture".into());
        let isolated = ProviderFactory::new(&settings)
            .settings_for_named_isolated("openai", "summary-model").unwrap();
        let (selector, credential) = ProviderFactory::new(&isolated)
            .credential_resolution(ProviderKind::Openai).unwrap();
        assert_eq!(selector, "openai");
        assert_eq!(credential.into_key(), "summary-fixture");
        assert_eq!(isolated.model, "summary-model");
        assert!(isolated.base_url.is_none());
        assert!(isolated.provider_extra_body.is_empty());
    }

}

use crate::providers::{
    ModelDiscoveryOptions, Provider, ProviderModelDiscovery, ProviderStream, openai::OpenAiProvider,
};
use kcoder_config::{ApiFormat, DEFAULT_GROK_ENDPOINT};
use kcoder_types::MessagesRequest;
use serde_json::{Map, Value};

/// xAI Grok provider — uses the OpenAI-compatible chat completions endpoint.
#[derive(Debug, Clone)]
pub struct GrokProvider {
    inner: OpenAiProvider,
}

impl GrokProvider {
    pub fn new(api_key: String, model: &str) -> Self {
        let inner = OpenAiProvider::new(api_key, model)
            .expect("reqwest client should build")
            .with_base_url(DEFAULT_GROK_ENDPOINT);
        Self { inner }
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.inner = self.inner.with_base_url(base_url);
        self
    }

    pub fn with_api_format(mut self, format: ApiFormat) -> Self {
        self.inner = self.inner.with_api_format(format);
        self
    }

    pub fn with_timeout_secs(mut self, timeout_secs: u64) -> Result<Self, crate::ApiErrorKind> {
        self.inner = self.inner.with_timeout_secs(timeout_secs)?;
        Ok(self)
    }

    pub fn with_no_proxy(mut self, no_proxy: bool) -> Result<Self, crate::ApiErrorKind> {
        self.inner = self.inner.with_no_proxy(no_proxy)?;
        Ok(self)
    }

    pub fn with_proxy_url(
        mut self,
        proxy_url: Option<String>,
    ) -> Result<Self, crate::ApiErrorKind> {
        self.inner = self.inner.with_proxy_url(proxy_url)?;
        Ok(self)
    }

    pub fn with_extra_body(mut self, extra_body: Map<String, Value>) -> Self {
        for (key, value) in extra_body {
            self.inner = self.inner.with_extra_body_field(key, value);
        }
        self
    }
}

impl Provider for GrokProvider {
    fn supports_reasoning_suppression(&self, parameter: crate::RejectedReasoningParameter) -> bool {
        self.inner.supports_reasoning_suppression(parameter)
    }

    fn name(&self) -> &'static str {
        "grok"
    }

    fn endpoint(&self) -> Option<&str> {
        self.inner.endpoint()
    }

    fn api_key_configured(&self) -> Option<bool> {
        self.inner.api_key_configured()
    }

    fn request_timeout_secs(&self) -> Option<u64> {
        self.inner.request_timeout_secs()
    }

    fn prewarm(&self) -> crate::providers::ProviderPrewarm {
        self.inner.prewarm()
    }

    fn discover_models(&self, options: ModelDiscoveryOptions) -> ProviderModelDiscovery {
        self.inner.discover_models(options)
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<ProviderStream, crate::ApiErrorKind> {
        self.inner.stream_messages(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grok_provider_name_is_grok() {
        let provider = GrokProvider::new("test-key".to_string(), "grok-beta");
        assert_eq!(provider.name(), "grok");
    }

    #[test]
    fn grok_provider_with_base_url_overrides_openai_compatible_endpoint() {
        let provider = GrokProvider::new("test-key".to_string(), "grok-beta")
            .with_base_url("https://proxy.example/v1");

        assert_eq!(
            provider.inner.base_url_for_test(),
            "https://proxy.example/v1"
        );
    }
}

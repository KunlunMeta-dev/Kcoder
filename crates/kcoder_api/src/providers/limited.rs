//! Factory-owned memory policy applies to every request, including auxiliary
//! Wiki/summary requests, without leaking local limits into provider JSON.
use super::*;
use kcoder_types::ProviderResponseLimits;
use std::sync::Arc;

pub(crate) struct LimitedProvider {
    pub inner: Arc<dyn Provider>,
    pub limits: ProviderResponseLimits,
}
impl Provider for LimitedProvider {
    fn name(&self) -> &'static str {
        self.inner.name()
    }
    fn response_limits(&self) -> ProviderResponseLimits {
        self.limits
    }
    fn supports_reasoning_suppression(&self, parameter: crate::RejectedReasoningParameter) -> bool {
        self.inner.supports_reasoning_suppression(parameter)
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        self.inner.supports_client_runtime_reconfiguration()
    }
    fn supports_response_json_schema(&self) -> bool {
        self.inner.supports_response_json_schema()
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
    fn prewarm(&self) -> ProviderPrewarm {
        self.inner.prewarm()
    }
    fn discover_models(&self, options: ModelDiscoveryOptions) -> ProviderModelDiscovery {
        self.inner.discover_models(options)
    }
    fn count_tokens(&self, request: MessagesRequest) -> ProviderTokenCount {
        self.inner.count_tokens(request)
    }
    fn stream_messages(
        &self,
        mut request: MessagesRequest,
    ) -> Result<ProviderStream, ApiErrorKind> {
        request.response_limits = self.limits;
        self.inner.stream_messages(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct RecordingProvider(Arc<Mutex<Option<MessagesRequest>>>);
    impl Provider for RecordingProvider {
        fn name(&self) -> &'static str {
            "recording"
        }
        fn endpoint(&self) -> Option<&str> {
            Some("http://fixture.invalid")
        }
        fn api_key_configured(&self) -> Option<bool> {
            Some(true)
        }
        fn supports_response_json_schema(&self) -> bool {
            true
        }
        fn stream_messages(
            &self,
            request: MessagesRequest,
        ) -> Result<ProviderStream, ApiErrorKind> {
            *self.0.lock().unwrap() = Some(request);
            Ok(Box::pin(futures::stream::empty()))
        }
    }

    #[test]
    fn local_limits_reach_auxiliary_requests_without_changing_wire_or_metadata() {
        let recorded = Arc::new(Mutex::new(None));
        let limits = ProviderResponseLimits {
            total_decoded_bytes: 128,
            tool_arguments_bytes: 32,
            content_blocks: 8,
            active_tool_calls: 2,
        };
        let provider = LimitedProvider {
            inner: Arc::new(RecordingProvider(recorded.clone())),
            limits,
        };
        drop(
            provider
                .stream_messages(MessagesRequest::new("model", vec![]).with_max_tokens(262144))
                .unwrap(),
        );
        let request = recorded.lock().unwrap().take().unwrap();
        assert_eq!(request.response_limits, limits);
        let wire = serde_json::to_value(request).unwrap();
        assert_eq!(wire["max_tokens"], 262144);
        assert!(wire.get("response_limits").is_none());
        assert_eq!(provider.name(), "recording");
        assert_eq!(provider.endpoint(), Some("http://fixture.invalid"));
        assert_eq!(provider.api_key_configured(), Some(true));
        assert!(provider.supports_response_json_schema());
    }
}

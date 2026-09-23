//! Resolve credentials immediately before polling each model operation.
use futures::StreamExt;
use kcoder_api::providers::ProviderPrewarm;
use kcoder_api::{
    ApiErrorKind, ModelDiscoveryOptions, Provider, ProviderModelDiscovery, ProviderStream,
    ProviderTokenCount, RejectedReasoningParameter,
};
use kcoder_types::MessagesRequest;
use std::sync::Arc;

type Resolver = Arc<dyn Fn() -> Result<Arc<dyn Provider>, ApiErrorKind> + Send + Sync>;

pub(super) struct CredentialProvider {
    metadata: Arc<dyn Provider>,
    resolve: Resolver,
}

impl CredentialProvider {
    pub(super) fn new(metadata: Arc<dyn Provider>, resolve: Resolver) -> Self {
        Self { metadata, resolve }
    }
}

pub(super) fn unavailable() -> ApiErrorKind {
    ApiErrorKind::Api {
        error_type: "authentication_error".into(),
        message: "Provider credential is unavailable or its source changed; configure credentials and start a new turn".into(),
    }
}

async fn resolve(resolver: Resolver) -> Result<Arc<dyn Provider>, ApiErrorKind> {
    tokio::task::spawn_blocking(move || resolver())
        .await
        .map_err(|_| unavailable())?
}

impl Provider for CredentialProvider {
    fn name(&self) -> &'static str {
        self.metadata.name()
    }
    fn endpoint(&self) -> Option<&str> {
        self.metadata.endpoint()
    }
    fn api_key_configured(&self) -> Option<bool> {
        self.metadata.api_key_configured()
    }
    fn request_timeout_secs(&self) -> Option<u64> {
        self.metadata.request_timeout_secs()
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        self.metadata.supports_client_runtime_reconfiguration()
    }
    fn supports_response_json_schema(&self) -> bool {
        self.metadata.supports_response_json_schema()
    }
    fn supports_reasoning_suppression(&self, parameter: RejectedReasoningParameter) -> bool {
        self.metadata.supports_reasoning_suppression(parameter)
    }
    fn prewarm(&self) -> ProviderPrewarm {
        let resolver = self.resolve.clone();
        Box::pin(async move {
            if let Ok(provider) = resolve(resolver).await {
                provider.prewarm().await;
            }
        })
    }
    fn discover_models(&self, options: ModelDiscoveryOptions) -> ProviderModelDiscovery {
        let resolver = self.resolve.clone();
        Box::pin(async move { resolve(resolver).await?.discover_models(options).await })
    }
    fn count_tokens(&self, request: MessagesRequest) -> ProviderTokenCount {
        let resolver = self.resolve.clone();
        Box::pin(async move { resolve(resolver).await?.count_tokens(request).await })
    }
    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        let resolver = self.resolve.clone();
        Ok(Box::pin(async_stream::stream! {
            let provider = match resolve(resolver).await {
                Ok(provider) => provider,
                Err(error) => { yield Err(error); return; }
            };
            let mut stream = match provider.stream_messages(request) {
                Ok(stream) => stream,
                Err(error) => { yield Err(error); return; }
            };
            while let Some(event) = stream.next().await { yield event; }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct Fixture(Arc<AtomicUsize>);
    impl Provider for Fixture {
        fn name(&self) -> &'static str {
            "fixture"
        }
        fn supports_response_json_schema(&self) -> bool {
            true
        }
        fn endpoint(&self) -> Option<&str> {
            Some("http://fixture.invalid")
        }
        fn stream_messages(&self, _: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Box::pin(futures::stream::empty()))
        }
    }

    #[tokio::test]
    async fn revocation_is_checked_when_polled_and_before_every_operation() {
        let calls = Arc::new(AtomicUsize::new(0));
        let revoked = Arc::new(AtomicBool::new(false));
        let transport: Arc<dyn Provider> = Arc::new(Fixture(calls.clone()));
        let resolver_transport = transport.clone();
        let resolver_revoked = revoked.clone();
        let provider = CredentialProvider::new(
            transport,
            Arc::new(move || {
                if resolver_revoked.load(Ordering::SeqCst) {
                    Err(unavailable())
                } else {
                    Ok(resolver_transport.clone())
                }
            }),
        );
        assert!(provider.supports_response_json_schema());
        assert_eq!(provider.endpoint(), Some("http://fixture.invalid"));
        let request = MessagesRequest::new("fixture-model", vec![]);
        assert!(
            provider
                .stream_messages(request.clone())
                .unwrap()
                .next()
                .await
                .is_none()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let mut pending = provider.stream_messages(request.clone()).unwrap();
        revoked.store(true, Ordering::SeqCst);
        assert!(pending.next().await.unwrap().is_err());
        assert!(provider.count_tokens(request).await.is_err());
        assert!(
            provider
                .discover_models(ModelDiscoveryOptions {
                    timeout: std::time::Duration::from_secs(1),
                    max_models: 1,
                })
                .await
                .is_err()
        );
        provider.prewarm().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

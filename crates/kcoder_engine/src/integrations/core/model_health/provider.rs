//! Observe actual provider streams without rewriting requests, events or native reservations.
use super::*;
use futures::Stream;
use kcoder_api::{
    ModelDiscoveryOptions, ProviderModelDiscovery, ProviderStream, ProviderTokenCount,
    providers::ProviderPrewarm,
};
use kcoder_types::{MessagesRequest, StreamEvent};
use std::{
    pin::Pin,
    sync::{OnceLock, Weak},
    task::{Context, Poll},
};
struct Alias {
    wrapped: Weak<dyn Provider>,
    inner: Weak<dyn Provider>,
}
static LIVE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
fn aliases() -> &'static Mutex<Vec<Alias>> {
    static REGISTRY: OnceLock<Mutex<Vec<Alias>>> = OnceLock::new();
    REGISTRY.get_or_init(Mutex::default)
}
pub(crate) fn admission_identity(provider: &Arc<dyn Provider>) -> Arc<dyn Provider> {
    if LIVE.load(std::sync::atomic::Ordering::Acquire) == 0 {
        return provider.clone();
    }
    let Ok(mut aliases) = aliases().lock() else {
        return provider.clone();
    };
    aliases.retain(|alias| alias.wrapped.strong_count() > 0 && alias.inner.strong_count() > 0);
    aliases
        .iter()
        .find(|alias| alias.wrapped.ptr_eq(&Arc::downgrade(provider)))
        .and_then(|alias| alias.inner.upgrade())
        .unwrap_or_else(|| provider.clone())
}
pub(super) fn tracked(
    tracker: Arc<ModelHealthTracker>,
    inner: Arc<dyn Provider>,
    model: ModelConfigurationSummary,
    gated: bool,
    request_guard: Option<super::request_guard::AutoRequestGuard>,
) -> Arc<dyn Provider> {
    let original = Arc::downgrade(&inner);
    let wrapped: Arc<dyn Provider> = Arc::new(Tracked {
        tracker,
        inner,
        model,
        gated,
        request_guard,
    });
    LIVE.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    if let Ok(mut aliases) = aliases().lock() {
        aliases.retain(|alias| alias.wrapped.strong_count() > 0 && alias.inner.strong_count() > 0);
        aliases.push(Alias {
            wrapped: Arc::downgrade(&wrapped),
            inner: original,
        })
    }
    wrapped
}
struct Tracked {
    tracker: Arc<ModelHealthTracker>,
    inner: Arc<dyn Provider>,
    model: ModelConfigurationSummary,
    gated: bool,
    request_guard: Option<super::request_guard::AutoRequestGuard>,
}
impl Drop for Tracked {
    fn drop(&mut self) {
        LIVE.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}
impl Provider for Tracked {
    fn name(&self) -> &'static str {
        self.inner.name()
    }
    fn response_limits(&self) -> kcoder_types::ProviderResponseLimits {
        self.inner.response_limits()
    }
    fn supports_reasoning_suppression(&self, p: kcoder_api::RejectedReasoningParameter) -> bool {
        self.inner.supports_reasoning_suppression(p)
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
        if let Some(guard) = &self.request_guard
            && guard.validate(&request).is_err()
        {
            return Box::pin(async {
                Err(ApiErrorKind::Api {
                    error_type: "model_auto_input_incompatible".into(),
                    message: "The bound AUTO policy or final count request is incompatible".into(),
                })
            });
        }
        self.inner.count_tokens(request)
    }
    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        if let Some(guard) = &self.request_guard {
            guard.validate(&request).map_err(|_| ApiErrorKind::Api {
                error_type: "model_auto_input_incompatible".into(),
                message: "The bound AUTO policy or final request is no longer compatible".into(),
            })?;
        }
        let observed =
            self.tracker
                .begin(&self.model, self.gated)
                .map_err(|_| ApiErrorKind::Api {
                    error_type: "model_auto_cooling_down".into(),
                    message:
                        "The selected AUTO model is cooling down or its single probe is in use"
                            .into(),
                })?;
        match self.inner.stream_messages(request) {
            Ok(inner) => Ok(Box::pin(ObservedStream { inner, observed })),
            Err(error) => {
                let mut observed = observed;
                if native_admission_error(&error) {
                    observed.not_dispatched();
                } else {
                    observed.error(&error);
                }
                Err(error)
            }
        }
    }
}
struct ObservedStream {
    inner: ProviderStream,
    observed: Observation,
}
impl Stream for ObservedStream {
    type Item = Result<StreamEvent, ApiErrorKind>;
    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        match this.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(event))) => {
                this.observed.usage.record(&event);
                match &event {
                    StreamEvent::Ping => {}
                    StreamEvent::MessageStop => {
                        if !this.observed.settled {
                            this.observed.success()
                        }
                    }
                    StreamEvent::Error { error } => this.observed.error(&ApiErrorKind::Api {
                        error_type: error.error_type.clone(),
                        message: String::new(),
                    }),
                    _ => this.observed.started = true,
                }
                Poll::Ready(Some(Ok(event)))
            }
            Poll::Ready(Some(Err(error))) => {
                this.observed.error(&error);
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                this.observed.eof();
                Poll::Ready(None)
            }
            other => other,
        }
    }
}

//! Transparent per-peer-turn dispatch guard; aliases are identity facts only.
use super::*;
use futures::StreamExt;
use kcoder_api::{
    ApiErrorKind, ModelDiscoveryOptions, Provider, ProviderModelDiscovery, ProviderStream,
    ProviderTokenCount, providers::ProviderPrewarm,
};
use kcoder_types::MessagesRequest;
use std::sync::{Mutex, OnceLock, Weak};

struct Alias {
    wrapped: Weak<dyn Provider>,
    inner: Weak<dyn Provider>,
    scope: Weak<PeerProviderScope>,
}
fn aliases() -> &'static Mutex<Vec<Alias>> {
    static ALIASES: OnceLock<Mutex<Vec<Alias>>> = OnceLock::new();
    ALIASES.get_or_init(Mutex::default)
}

/// Admission identity never grants permission; every actual invocation still
/// goes through its retained guard and fresh host check.
pub(crate) fn admission_identity(provider: &Arc<dyn Provider>) -> Arc<dyn Provider> {
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

/// A new independent/User engine inherits model observers separately, never
/// another peer turn's ephemeral wrapper and original start permit.
pub(crate) fn strip_inherited_provider(provider: Arc<dyn Provider>) -> Arc<dyn Provider> {
    let mut current = provider.clone();
    let mut found = false;
    for _ in 0..8 {
        let observed = crate::integrations::core::model_health::admission_identity(&current);
        let inner = admission_identity(&observed);
        found |= !Arc::ptr_eq(&inner, &observed);
        if Arc::ptr_eq(&inner, &current) {
            break;
        }
        current = inner;
    }
    if found { current } else { provider }
}

impl QueryEngine {
    pub(crate) fn observe_peer_provider(&self, inner: Arc<dyn Provider>) -> Arc<dyn Provider> {
        if !self.is_peer_driven_turn() {
            return inner;
        }
        let Some(scope) = self.peer_provider_scope.as_ref() else {
            return inner;
        };
        // Health observation may interpose around this scope's existing guard.
        // Keep that complete observer graph, without taking its invocation slot twice.
        let health_inner = crate::integrations::core::model_health::admission_identity(&inner);
        if let Ok(mut aliases) = aliases().lock() {
            aliases
                .retain(|alias| alias.wrapped.strong_count() > 0 && alias.inner.strong_count() > 0);
            if aliases.iter().any(|alias| {
                (alias.wrapped.ptr_eq(&Arc::downgrade(&inner))
                    || alias.wrapped.ptr_eq(&Arc::downgrade(&health_inner)))
                    && alias
                        .scope
                        .upgrade()
                        .is_some_and(|owner| Arc::ptr_eq(&owner, scope))
            }) {
                return inner;
            }
        }
        let wrapped: Arc<dyn Provider> = Arc::new(GuardedProvider {
            inner: inner.clone(),
            actor: self.clone(),
        });
        if let Ok(mut aliases) = aliases().lock() {
            aliases.push(Alias {
                wrapped: Arc::downgrade(&wrapped),
                inner: Arc::downgrade(&inner),
                scope: Arc::downgrade(scope),
            });
        }
        wrapped
    }
}

struct GuardedProvider {
    inner: Arc<dyn Provider>,
    actor: QueryEngine,
}
impl Provider for GuardedProvider {
    fn name(&self) -> &'static str {
        self.inner.name()
    }
    fn response_limits(&self) -> kcoder_types::ProviderResponseLimits {
        self.inner.response_limits()
    }
    fn supports_reasoning_suppression(
        &self,
        parameter: kcoder_api::RejectedReasoningParameter,
    ) -> bool {
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
    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        let actor = self.actor.clone();
        let inner = self.inner.clone();
        Ok(Box::pin(async_stream::stream! {
            let mut invocation = match actor.peer_provider_scope.as_ref()
                .ok_or("peer_provider_start_actual_stream_required")
                .and_then(|scope| scope.invocations.provider()) {
                Ok(invocation) => Some(invocation),
                Err(code) => {
                    yield Err(ApiErrorKind::peer_turn_authorization(code));
                    return;
                }
            };
            let checked = tokio::select! {
                biased;
                _ = actor.cancel_token().cancelled_owned() => Err("peer_provider_start_cancelled".to_owned()),
                checked = actor.authorize_peer_provider_start() => checked,
            };
            if let Err(code) = checked {
                drop(invocation.take());
                yield Err(ApiErrorKind::peer_turn_authorization(&code));
                return;
            }
            let mut stream = match inner.stream_messages(request) {
                Ok(stream) => stream,
                Err(error) => {drop(invocation.take());yield Err(error);return;}
            };
            loop {
                let event = tokio::select! {
                    biased;
                    _ = actor.cancel_token().cancelled_owned() => {
                        drop(stream);
                        drop(invocation.take());
                        yield Err(ApiErrorKind::peer_turn_cancelled_after_dispatch());
                        return;
                    }
                    event = stream.next() => event,
                };
                let Some(event) = event else { break; };
                if matches!(&event, Err(_) | Ok(kcoder_types::StreamEvent::Error { .. })) {
                    drop(stream);
                    drop(invocation.take());
                    yield event;
                    return;
                }
                if let Ok(event) = &event
                    && let Some(scope) = actor.peer_provider_scope.as_ref()
                    && let Some(permit) = actor.peer_auto_wake_start.as_ref()
                {
                    scope.observe_model_response(permit, event);
                }
                yield event;
            }
        }))
    }
}

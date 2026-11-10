use super::*;
use crate::QueryEngine;
use futures::Stream;
use kcoder_api::providers::ProviderPrewarm;
use kcoder_api::{
    ApiErrorKind, ModelDiscoveryOptions, Provider, ProviderModelDiscovery, ProviderStream,
    ProviderTokenCount,
};
use kcoder_types::{MessagesRequest, ModelConfigurationSummary, StreamEvent, Usage};
use std::collections::VecDeque;
use std::future::Future;
use std::{
    pin::Pin,
    sync::{Arc, Mutex, OnceLock, Weak},
    task::{Context, Poll},
    time::{Duration, Instant},
};

struct Alias {
    wrapped: Weak<dyn Provider>,
    inner: Weak<dyn Provider>,
    observer: Weak<dyn NativeModelRequestObserver>,
    mandatory: Vec<Weak<dyn NativeModelRequestObserver>>,
    origin: kcoder_state::AppStateIdentity,
}
static LIVE_WRAPPERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
fn aliases() -> &'static Mutex<Vec<Alias>> {
    static REGISTRY: OnceLock<Mutex<Vec<Alias>>> = OnceLock::new();
    REGISTRY.get_or_init(Mutex::default)
}
/// Only unwraps budget wrappers registered by the Engine. This preserves the
/// original provider admission queue; it never reuses actor authorization.
pub fn admission_identity(provider: &Arc<dyn Provider>) -> Arc<dyn Provider> {
    let provider = &crate::integrations::core::model_health::admission_identity(provider);
    if LIVE_WRAPPERS.load(std::sync::atomic::Ordering::Acquire) == 0 {
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

pub(crate) struct InheritedModelObserver {
    pub(crate) observer: Arc<dyn NativeModelRequestObserver>,
    pub(crate) origin: kcoder_state::AppStateIdentity,
    pub(crate) mandatory: Vec<Arc<dyn NativeModelRequestObserver>>,
}
pub(crate) fn inherited_observer(provider: &Arc<dyn Provider>) -> Option<InheritedModelObserver> {
    if LIVE_WRAPPERS.load(std::sync::atomic::Ordering::Acquire) == 0 {
        return None;
    }
    let entries = aliases().lock().ok()?;
    let entry = entries
        .iter()
        .find(|entry| entry.wrapped.ptr_eq(&Arc::downgrade(provider)))?;
    Some(InheritedModelObserver {
        observer: entry.observer.upgrade()?,
        origin: entry.origin.clone(),
        mandatory: entry
            .mandatory
            .iter()
            .map(Weak::upgrade)
            .collect::<Option<Vec<_>>>()?,
    })
}

pub(super) struct ObservedProvider {
    pub(super) inner: Arc<dyn Provider>,
    pub(super) observer: Arc<dyn NativeModelRequestObserver>,
    pub(super) actor: Arc<QueryEngine>,
    pub(super) purpose: NativeModelRequestPurpose,
    pub(super) configuration: Option<ModelConfigurationSummary>,
    pub(super) valid_owner: bool,
    pub(super) attempts: Arc<super::transition::AttemptTracker>,
    pub(super) mandatory: Vec<Arc<dyn NativeModelRequestObserver>>,
}
impl ObservedProvider {
    pub(super) fn install(self) -> Arc<dyn Provider> {
        let inner = self.inner.clone();
        let observer = Arc::downgrade(&self.observer);
        let origin = self.actor.state.inspection_identity();
        let mandatory = self.mandatory.iter().map(Arc::downgrade).collect();
        LIVE_WRAPPERS.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        let wrapped: Arc<dyn Provider> = Arc::new(self);
        if let Ok(mut entries) = aliases().lock() {
            entries.retain(|entry| entry.wrapped.strong_count() > 0);
            entries.push(Alias {
                wrapped: Arc::downgrade(&wrapped),
                inner: Arc::downgrade(&inner),
                observer,
                mandatory,
                origin,
            });
        }
        wrapped
    }
}
impl Drop for ObservedProvider {
    fn drop(&mut self) {
        LIVE_WRAPPERS.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}
impl Provider for ObservedProvider {
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
        // A pending stream needs the owned Tokio timer for revocation and hard
        // deadline wakeups; do not dispatch outside that runtime.
        if tokio::runtime::Handle::try_current().is_err() {
            return Err(local_error(NativeModelRequestError::Unavailable));
        }
        if !self.valid_owner {
            return Err(local_error(NativeModelRequestError::Denied));
        }
        let execution = self.actor.native_tool_execution_witness();
        let parent_state = self
            .actor
            .subagent_runtime_control
            .as_ref()
            .as_ref()
            .map(|parent| parent.parent_state.clone());
        let context = Arc::new(NativeModelRequestContext {
            call_id: format!("native-model-{}", uuid::Uuid::new_v4()),
            execution,
            state: self.actor.state.clone(),
            parent_state,
            purpose: self.purpose,
            retry_attempt: super::retry_observation::current_retry_attempt(),
            provider: self.inner.clone(),
            configuration: self.configuration.clone(),
            session_directory: self.actor.session_storage_dir_for(&self.actor.session_id()),
        });
        let attempt = self
            .attempts
            .begin(context.clone(), &request)
            .map_err(local_error)?;
        let started = Instant::now();
        let lease = self.observer.reserve(&context, &request);
        trace_cost("reserve", started);
        let lease = lease.map_err(local_error)?;
        let mut observed = ObservedStream {
            inner: None,
            lease: Some(lease),
            usage: None,
            usage_from_delta: false,
            dispatched: false,
            saw_stop: false,
            saw_error: false,
            ended: false,
            first_poll: true,
            next_check: Instant::now(),
            wake: None,
            terminal_tail: VecDeque::new(),
            tail_bytes: 0,
            drain_deadline: None,
            attempt,
        };
        if let Err(error) = observed.check() {
            observed.finish(if error == NativeModelRequestError::Deadline {
                NativeModelRequestEnd::Deadline
            } else {
                NativeModelRequestEnd::AdmissionChanged
            });
            return Err(local_error(error));
        }
        observed.dispatched = true;
        match self.inner.stream_messages(request) {
            Ok(stream) => {
                observed.inner = Some(stream);
                Ok(Box::pin(observed))
            }
            Err(error) => {
                observed.finish(NativeModelRequestEnd::ProviderError);
                if let Some(attempt) = &observed.attempt {
                    attempt.failed(&error);
                }
                Err(error)
            }
        }
    }
}
fn trace_cost(phase: &'static str, started: Instant) {
    tracing::debug!(
        phase,
        elapsed_micros = started.elapsed().as_micros() as u64,
        "native model budget callback"
    );
}
fn local_error(error: NativeModelRequestError) -> ApiErrorKind {
    ApiErrorKind::Api {
        error_type: match error {
            NativeModelRequestError::Denied => "native_model_budget_denied",
            NativeModelRequestError::Unavailable => "native_model_budget_unavailable",
            NativeModelRequestError::Deadline => "native_model_budget_deadline",
        }
        .into(),
        message: "Native model reservation or current authority is unavailable".into(),
    }
}
struct ObservedStream {
    inner: Option<ProviderStream>,
    lease: Option<Box<dyn NativeModelRequestLease>>,
    usage: Option<Usage>,
    usage_from_delta: bool,
    dispatched: bool,
    saw_stop: bool,
    saw_error: bool,
    ended: bool,
    first_poll: bool,
    next_check: Instant,
    wake: Option<Pin<Box<tokio::time::Sleep>>>,
    terminal_tail: VecDeque<Result<StreamEvent, ApiErrorKind>>,
    tail_bytes: usize,
    drain_deadline: Option<Instant>,
    attempt: Option<super::transition::AttemptOrigin>,
}
impl Unpin for ObservedStream {}
impl ObservedStream {
    fn check(&mut self) -> Result<(), NativeModelRequestError> {
        let Some(lease) = self.lease.as_ref() else {
            return Ok(());
        };
        if lease
            .deadline()
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(NativeModelRequestError::Deadline);
        }
        let started = Instant::now();
        let result = lease.check_current();
        trace_cost("check_current", started);
        result?;
        if lease
            .deadline()
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(NativeModelRequestError::Deadline);
        }
        self.next_check = Instant::now() + Duration::from_millis(250);
        self.wake = None;
        Ok(())
    }
    fn finish(&mut self, end: NativeModelRequestEnd) {
        if let Some(lease) = self.lease.take() {
            let started = Instant::now();
            let result = lease.finish(NativeModelRequestSettlement {
                end,
                usage: self.usage.clone(),
                usage_from_delta: self.usage_from_delta,
                request_dispatched: self.dispatched,
            });
            trace_cost("finish", started);
            if result.is_err() {
                tracing::warn!(
                    "Native model settlement is unconfirmed; original reservation retained"
                );
            }
        }
        if let Some(attempt) = &self.attempt {
            attempt.closed();
        }
    }
    fn record(&mut self, event: &StreamEvent) -> Result<(), NativeModelRequestError> {
        let usage = match event {
            StreamEvent::MessageStart { message } => message.usage.as_ref(),
            StreamEvent::MessageDelta { delta } => {
                if delta.usage.is_some() {
                    self.usage_from_delta = true;
                }
                delta.usage.as_ref()
            }
            _ => None,
        };
        if let Some(usage) = usage {
            if let Some(current) = &mut self.usage {
                current.merge_stream_update(usage)
            } else {
                self.usage = Some(usage.clone());
            }
            if let (Some(lease), Some(usage)) = (&mut self.lease, &self.usage) {
                let started = Instant::now();
                let result = lease.record_usage(usage);
                trace_cost("record_usage", started);
                result?;
            }
        }
        Ok(())
    }
}
impl ObservedStream {
    fn effective_deadline(&self) -> Option<Instant> {
        match (
            self.lease.as_ref().and_then(|lease| lease.deadline()),
            self.drain_deadline,
        ) {
            (Some(left), Some(right)) => Some(left.min(right)),
            (left, right) => left.or(right),
        }
    }
    fn fail_closed(
        &mut self,
        error: NativeModelRequestError,
        end: NativeModelRequestEnd,
    ) -> Poll<Option<Result<StreamEvent, ApiErrorKind>>> {
        self.ended = true;
        self.inner.take();
        self.terminal_tail.clear();
        self.finish(end);
        Poll::Ready(Some(Err(local_error(error))))
    }
    fn buffer_tail(
        &mut self,
        event: Result<StreamEvent, ApiErrorKind>,
    ) -> Result<(), NativeModelRequestError> {
        // Terminal tails normally contain only small usage updates. A malformed
        // provider cannot turn delayed completion into an unbounded allocation.
        let bytes = match &event {
            Ok(event) => serde_json::to_vec(event)
                .map_err(|_| NativeModelRequestError::Unavailable)?
                .len(),
            Err(_) => 1024,
        };
        self.tail_bytes = self
            .tail_bytes
            .checked_add(bytes)
            .ok_or(NativeModelRequestError::Unavailable)?;
        if self.terminal_tail.len() >= 64 || self.tail_bytes > 128 * 1024 {
            return Err(NativeModelRequestError::Unavailable);
        }
        self.terminal_tail.push_back(event);
        Ok(())
    }
}
impl Stream for ObservedStream {
    type Item = Result<StreamEvent, ApiErrorKind>;
    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if this.ended {
            return Poll::Ready(this.terminal_tail.pop_front());
        }
        if this.first_poll {
            this.first_poll = false;
            this.next_check = Instant::now();
        }
        let deadline = this.effective_deadline();
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return this.fail_closed(
                NativeModelRequestError::Deadline,
                NativeModelRequestEnd::Deadline,
            );
        }
        if Instant::now() >= this.next_check
            && let Err(error) = this.check()
        {
            return this.fail_closed(
                error,
                if error == NativeModelRequestError::Deadline {
                    NativeModelRequestEnd::Deadline
                } else {
                    NativeModelRequestEnd::AdmissionChanged
                },
            );
        }
        if this.wake.is_none() {
            let when = deadline
                .map(|deadline| deadline.min(this.next_check))
                .unwrap_or(this.next_check);
            this.wake = Some(Box::pin(tokio::time::sleep_until(
                tokio::time::Instant::from_std(when),
            )));
        }
        if let Some(wake) = &mut this.wake
            && wake.as_mut().poll(cx).is_ready()
        {
            this.wake = None;
            cx.waker().wake_by_ref();
        }
        // Keep MessageStop private until the actual stream is drained. This
        // settles the real lease even for auxiliary consumers that break at
        // their first terminal frame, while preserving the original event order.
        for _ in 0..64 {
            if this
                .effective_deadline()
                .is_some_and(|deadline| Instant::now() >= deadline)
            {
                return this.fail_closed(
                    NativeModelRequestError::Deadline,
                    NativeModelRequestEnd::Deadline,
                );
            }
            let Some(inner) = &mut this.inner else {
                this.ended = true;
                return Poll::Ready(None);
            };
            match inner.as_mut().poll_next(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Ok(event))) => {
                    if let Some(attempt) = &mut this.attempt {
                        match &event {
                            StreamEvent::Error { error } => attempt.failed(&ApiErrorKind::Api {
                                error_type: error.error_type.clone(),
                                message: String::new(),
                            }),
                            _ => attempt.event(&event),
                        }
                    }
                    if let Err(error) = this.record(&event) {
                        return this
                            .fail_closed(error, NativeModelRequestEnd::UsageAccountingFailed);
                    }
                    if matches!(event, StreamEvent::Error { .. }) {
                        this.saw_error = true;
                    }
                    if matches!(event, StreamEvent::MessageStop) && !this.saw_stop {
                        this.saw_stop = true;
                        this.drain_deadline =
                            Some(Instant::now() + crate::stream::DEFAULT_STREAM_IDLE_TIMEOUT);
                    }
                    if !this.saw_stop {
                        return Poll::Ready(Some(Ok(event)));
                    }
                    if let Err(error) = this.buffer_tail(Ok(event)) {
                        return this.fail_closed(error, NativeModelRequestEnd::StreamError);
                    }
                }
                Poll::Ready(Some(Err(error))) => {
                    if let Some(attempt) = &this.attempt {
                        attempt.failed(&error);
                    }
                    this.saw_error = true;
                    if !this.saw_stop {
                        return Poll::Ready(Some(Err(error)));
                    }
                    if let Err(error) = this.buffer_tail(Err(error)) {
                        return this.fail_closed(error, NativeModelRequestEnd::StreamError);
                    }
                }
                Poll::Ready(None) => {
                    this.ended = true;
                    this.inner.take();
                    this.finish(if this.saw_error {
                        NativeModelRequestEnd::StreamError
                    } else if this.saw_stop {
                        NativeModelRequestEnd::MessageStop
                    } else {
                        NativeModelRequestEnd::Eof
                    });
                    return Poll::Ready(this.terminal_tail.pop_front());
                }
            }
        }
        cx.waker().wake_by_ref();
        Poll::Pending
    }
}
impl Drop for ObservedStream {
    fn drop(&mut self) {
        // MessageStop can precede final usage. Only drained EOF above proves
        // this wrapper observed every trailing event; dropping here is unknown.
        self.finish(if self.saw_error {
            NativeModelRequestEnd::StreamError
        } else {
            NativeModelRequestEnd::Dropped
        });
    }
}

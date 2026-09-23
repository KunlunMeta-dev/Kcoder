//! Per-provider-instance admission for internal maintenance attempts.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::engine_builder::TestEngineBuilder;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn diagnostic_owned_snapshot_is_created_once_outside_retry_loop() {
        let request = kcoder_types::MessagesRequest::new(
            "model",
            vec![kcoder_types::Message::user_text("history")],
        )
        .with_reasoning_effort(Some(kcoder_types::ReasoningEffort::High));
        let mut requests =
            crate::attempt_diagnostic_requests::AttemptDiagnosticRequests::new(request);
        for disabled in [false, true] {
            let first = requests.select(disabled);
            let retry = requests.select(disabled);
            assert!(std::ptr::eq(first.request(), retry.request()));
            assert_eq!(first.request().recovery_disable_reasoning, disabled);
            assert_eq!(first.request().reasoning_effort.is_none(), disabled);
        }
        let source = include_str!("lib.rs");
        let body = &source[source.find("'api_attempt: loop {").unwrap()..];
        let admitted = body.find("request_admission::acquire").unwrap();
        let selected = body
            .find("diagnostic_requests.select(recovery_disable_reasoning)")
            .unwrap();
        assert!(admitted < selected, "derive snapshots only after admission");
    }

    #[tokio::test]
    async fn message_stop_releases_permit_without_swallowing_trailing_events() {
        let gate = Arc::new(Gate::default());
        let permit = gate.acquire(RequestClass::Foreground).await.unwrap();
        let trailing_usage = StreamEvent::MessageDelta {
            delta: kcoder_types::MessageDeltaFields {
                stop_reason: None,
                stop_sequence: None,
                usage: Some(kcoder_types::Usage {
                    input_tokens: 7,
                    output_tokens: 3,
                    total_tokens: None,
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: None,
                    iterations: None,
                }),
            },
        };
        let mut stream = permit.wrap(Box::pin(futures::stream::iter([
            Ok(StreamEvent::MessageStop),
            Ok(trailing_usage),
            Err(kcoder_api::ApiErrorKind::Api {
                error_type: "trailing".into(),
                message: "must remain observable".into(),
            }),
        ])));
        assert!(matches!(
            stream.next().await,
            Some(Ok(StreamEvent::MessageStop))
        ));
        assert_eq!(gate.state.lock().unwrap().foreground, 0);
        assert!(
            matches!(stream.next().await, Some(Ok(StreamEvent::MessageDelta { delta })) if delta.usage.as_ref().unwrap().input_tokens == 7)
        );
        assert!(matches!(stream.next().await, Some(Err(_))));
    }

    #[tokio::test]
    async fn main_keeps_observing_usage_and_error_after_message_stop() {
        let tmp = tempfile::tempdir().unwrap();
        let mut events = crate::test_support::events::simple_text_events("done");
        events.push(StreamEvent::MessageDelta {
            delta: kcoder_types::MessageDeltaFields {
                stop_reason: None,
                stop_sequence: None,
                usage: Some(kcoder_types::Usage {
                    input_tokens: 7,
                    output_tokens: 3,
                    total_tokens: None,
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: None,
                    iterations: None,
                }),
            },
        });
        events.push(StreamEvent::Error {
            error: kcoder_types::ApiError {
                error_type: "invalid_request_error".into(),
                message: "trailing protocol error".into(),
            },
        });
        let (provider, _) =
            crate::test_support::providers::SequentialEventsProvider::new(vec![events]);
        let engine = TestEngineBuilder::new(tmp.path())
            .provider(Arc::new(provider))
            .build();
        engine
            .state
            .set_usage_history_root(Some(&tmp.path().join("usage")));
        engine
            .state
            .add_message(kcoder_types::Message::user_text("hello"));
        let output = engine
            .run_turn_stream(&kcoder_permissions::AutoDenyPrompt)
            .collect::<Vec<_>>()
            .await;
        assert!(output.iter().any(|event| matches!(event, crate::EngineEvent::Error(error) | crate::EngineEvent::ProviderFailed { message: error, .. } if error.contains("invalid_request"))));
        let history = kcoder_state::usage_history::read_usage(&tmp.path().join("usage"))
            .unwrap()
            .unwrap();
        let usage = history
            .days
            .values()
            .next()
            .unwrap()
            .values()
            .next()
            .unwrap();
        assert_eq!(
            (usage.requests, usage.input_tokens, usage.output_tokens),
            (1, 7, 3)
        );
    }

    struct CountingPendingProvider(Arc<AtomicUsize>);
    impl Provider for CountingPendingProvider {
        fn name(&self) -> &'static str {
            "admission-counting"
        }
        fn stream_messages(
            &self,
            _: kcoder_types::MessagesRequest,
        ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Box::pin(futures::stream::pending()))
        }
    }

    #[tokio::test]
    async fn admission_main_attempt_registers_foreground_until_cancelled() {
        let tmp = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let provider: Arc<dyn Provider> = Arc::new(CountingPendingProvider(calls.clone()));
        let engine = TestEngineBuilder::new(tmp.path())
            .provider(provider.clone())
            .build();
        engine
            .state
            .add_message(kcoder_types::Message::user_text("hello"));
        let turn = engine.run_turn_stream(&kcoder_permissions::AutoDenyPrompt);
        let handle = tokio::spawn(async move { turn.collect::<Vec<_>>().await });
        tokio::time::timeout(Duration::from_secs(5), async {
            while calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let mut background = Box::pin(acquire(&provider, RequestClass::SessionMemory));
        assert!(futures::poll!(background.as_mut()).is_pending());
        engine.cancel_token().cancel();
        let events = handle.await.unwrap();
        assert!(
            events
                .iter()
                .any(|event| matches!(event, crate::EngineEvent::StreamAborted { .. }))
        );
        assert!(background.await.is_ok());
    }

    #[tokio::test]
    async fn admission_review_fork_waits_without_changing_parent_class() {
        let tmp = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let provider: Arc<dyn Provider> = Arc::new(CountingPendingProvider(calls.clone()));
        let engine = TestEngineBuilder::new(tmp.path())
            .provider(provider.clone())
            .build();
        let foreground = acquire(&provider, RequestClass::Foreground).await.unwrap();
        let cache_safe = crate::agent::CacheSafeParams {
            fork_context_messages: vec![kcoder_types::Message::user_text("prior message")].into(),
            active_skills: vec![],
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        };
        let worker = engine.clone();
        let ordinary_cache = cache_safe.clone();
        let handle = tokio::spawn(async move {
            worker
                .run_background_skill_review(cache_safe, "review".into(), "admission-test".into())
                .await
        });
        let gate = gate_for(&provider);
        tokio::time::timeout(Duration::from_secs(5), async {
            while calls.load(Ordering::SeqCst) == 0 && gate.state.lock().unwrap().queue.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(engine.request_class, RequestClass::Foreground);
        // Recovery owns one bounded diagnostic scope before provider admission.
        assert_eq!(engine.state.diagnostic_writer().stats().pending_attempts, 1);
        assert_eq!(
            gate.state.lock().unwrap().queue[0].class,
            RequestClass::SkillReview
        );
        drop(foreground);
        tokio::time::timeout(Duration::from_secs(5), async {
            while calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // A user-requested fork of the original parent remains foreground,
        // even while the internal review using the same provider is in flight.
        let ordinary_parent = engine.clone();
        let ordinary = tokio::spawn(async move {
            crate::agent::run_forked_agent_with_tools(
                &ordinary_parent,
                &ordinary_cache,
                vec![kcoder_types::Message::user_text("ordinary agent")],
                crate::agent::SubagentContextOverrides::default(),
                1,
                kcoder_tools::ToolRegistry::new(),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while calls.load(Ordering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        ordinary.abort();
        assert!(ordinary.await.unwrap_err().is_cancelled());
        handle.abort();
        assert!(handle.await.unwrap_err().is_cancelled());
        assert!(
            engine
                .state
                .flush_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
                .await
        );
        assert_eq!(engine.state.diagnostic_writer().stats().pending_attempts, 0);
        assert!(gate.state.lock().unwrap().queue.is_empty());
    }

    #[tokio::test]
    async fn foreground_blocks_only_unstarted_background() {
        let gate = std::sync::Arc::new(Gate::default());
        let foreground = gate.acquire(RequestClass::Foreground).await.unwrap();
        let mut background = Box::pin(gate.acquire(RequestClass::Prefire));
        assert!(futures::poll!(background.as_mut()).is_pending());
        drop(foreground);
        assert!(background.await.is_ok());
    }

    #[tokio::test]
    async fn identity_is_shared_only_for_the_same_provider_arc() {
        let calls = Arc::new(AtomicUsize::new(0));
        let first: Arc<dyn Provider> = Arc::new(CountingPendingProvider(calls.clone()));
        let second: Arc<dyn Provider> = Arc::new(CountingPendingProvider(calls));
        assert!(Arc::ptr_eq(&gate_for(&first), &gate_for(&first.clone())));
        assert!(!Arc::ptr_eq(&gate_for(&first), &gate_for(&second)));
        let foreground = acquire(&first, RequestClass::Foreground).await.unwrap();
        assert!(acquire(&second, RequestClass::SkillReview).await.is_ok());
        let weak = Arc::downgrade(&first);
        drop(first);
        assert!(
            weak.upgrade().is_none(),
            "gate must not retain provider credentials"
        );
        drop(foreground);
    }

    #[tokio::test]
    async fn foreground_does_not_wait_or_preempt_started_background() {
        let gate = Arc::new(Gate::default());
        let background = gate.acquire(RequestClass::SkillReview).await.unwrap();
        let mut foreground = Box::pin(gate.acquire(RequestClass::Foreground));
        let foreground = match futures::poll!(foreground.as_mut()) {
            std::task::Poll::Ready(Ok(permit)) => permit,
            _ => panic!("foreground must never wait for background"),
        };
        drop(foreground);
        let mut next = Box::pin(gate.acquire(RequestClass::Prefire));
        assert!(futures::poll!(next.as_mut()).is_pending());
        assert!(gate.state.lock().unwrap().background);
        drop(background);
        assert!(next.await.is_ok());
    }

    #[tokio::test]
    async fn bounded_queue_fifo_and_cancelled_ticket_cleanup() {
        let gate = Arc::new(Gate::default());
        let foreground = gate.acquire(RequestClass::Foreground).await.unwrap();
        let mut queued = Vec::new();
        for _ in 0..MAX_QUEUED {
            let mut future = Box::pin(gate.acquire(RequestClass::SessionMemory));
            assert!(futures::poll!(future.as_mut()).is_pending());
            queued.push(future);
        }
        assert!(
            gate.acquire(RequestClass::Prefire)
                .await
                .err()
                .unwrap()
                .to_string()
                .contains("full")
        );
        drop(queued.remove(0));
        assert_eq!(gate.state.lock().unwrap().queue.len(), MAX_QUEUED - 1);
        drop(foreground);
        assert!(
            futures::poll!(queued[1].as_mut()).is_pending(),
            "same-class FIFO"
        );
        let first = queued.remove(0).await.unwrap();
        assert!(
            futures::poll!(queued[0].as_mut()).is_pending(),
            "only one background attempt"
        );
        drop(first);
        drop(queued.remove(0).await.unwrap());
        drop(queued);
        assert!(gate.state.lock().unwrap().queue.is_empty());
        assert!(!gate.state.lock().unwrap().background);
    }

    #[tokio::test]
    async fn mixed_background_churn_preserves_foreground_priority_and_reclaims_all_tickets() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let gate = Arc::new(Gate::default());
            for cycle in 0..64 {
                let foreground = gate.acquire(RequestClass::Foreground).await.unwrap();
                let mut review = Box::pin(gate.acquire(RequestClass::SkillReview));
                let mut memory = Box::pin(gate.acquire(RequestClass::SessionMemory));
                let mut prefire = Box::pin(gate.acquire(RequestClass::Prefire));
                assert!(futures::poll!(review.as_mut()).is_pending());
                assert!(futures::poll!(memory.as_mut()).is_pending());
                assert!(futures::poll!(prefire.as_mut()).is_pending());
                if cycle % 2 == 0 {
                    // Model an aged review without sleeping through the production promotion window.
                    gate.state.lock().unwrap().queue[0].created = Instant::now() - AGE_PROMOTION;
                }
                drop(foreground);
                let background = if cycle % 2 == 0 {
                    assert!(futures::poll!(prefire.as_mut()).is_pending());
                    review.await.unwrap()
                } else {
                    drop(review);
                    prefire.as_mut().await.unwrap()
                };
                let foreground = gate.acquire(RequestClass::Foreground).await.unwrap();
                assert!(futures::poll!(memory.as_mut()).is_pending());
                drop(background);
                assert!(
                    futures::poll!(memory.as_mut()).is_pending(),
                    "foreground still owns admission"
                );
                drop(prefire);
                drop(foreground);
                drop(memory.await.unwrap());
                let state = gate.state.lock().unwrap();
                assert_eq!(state.foreground, 0);
                assert!(!state.background);
                assert!(state.queue.is_empty());
            }
        })
        .await
        .expect("mixed admission churn exceeded deadline");
    }

    #[tokio::test]
    async fn aged_review_precedes_new_prefire_without_breaking_fifo() {
        let gate = Arc::new(Gate::default());
        let foreground = gate.acquire(RequestClass::Foreground).await.unwrap();
        let mut review = Box::pin(gate.acquire(RequestClass::SkillReview));
        let mut prefire = Box::pin(gate.acquire(RequestClass::Prefire));
        assert!(futures::poll!(review.as_mut()).is_pending());
        assert!(futures::poll!(prefire.as_mut()).is_pending());
        {
            let mut state = gate.state.lock().unwrap();
            assert!(
                state.queue[1].priority(Instant::now()) < state.queue[0].priority(Instant::now())
            );
            state.queue[0].created = Instant::now() - AGE_PROMOTION;
        }
        drop(foreground);
        assert!(futures::poll!(prefire.as_mut()).is_pending());
        drop(review.await.unwrap());
        assert!(prefire.await.is_ok());
    }

    #[tokio::test]
    async fn absolute_deadline_survives_notifications_and_reclaims_ticket() {
        let gate = Arc::new(Gate::default());
        let _foreground = gate.acquire(RequestClass::Foreground).await.unwrap();
        let deadline = Instant::now() + Duration::from_millis(20);
        let mut queued = Box::pin(gate.acquire_until(RequestClass::SkillReview, deadline));
        assert!(futures::poll!(queued.as_mut()).is_pending());
        for _ in 0..5 {
            gate.changed.notify_waiters();
            assert!(futures::poll!(queued.as_mut()).is_pending());
        }
        tokio::time::sleep_until(deadline).await;
        assert!(matches!(
            futures::poll!(queued.as_mut()),
            std::task::Poll::Ready(Err(_))
        ));
        assert!(gate.state.lock().unwrap().queue.is_empty());
    }

    #[tokio::test]
    async fn terminal_stream_event_releases_before_consumer_retry_work() {
        for event in [
            Ok(StreamEvent::MessageStop),
            Err(kcoder_api::ApiErrorKind::Api {
                error_type: "test".into(),
                message: "test".into(),
            }),
        ] {
            let gate = Arc::new(Gate::default());
            let permit = gate.acquire(RequestClass::Foreground).await.unwrap();
            let mut stream = permit.wrap(Box::pin(futures::stream::iter([event])));
            assert!(stream.next().await.is_some());
            assert_eq!(gate.state.lock().unwrap().foreground, 0);
            assert!(gate.acquire(RequestClass::Prefire).await.is_ok());
        }
    }

    #[tokio::test]
    async fn idle_watchdog_and_stream_drop_release_admission() {
        let gate = Arc::new(Gate::default());
        let permit = gate.acquire(RequestClass::SkillReview).await.unwrap();
        let mut stream = permit.wrap(crate::stream::timed_stream(
            futures::stream::pending(),
            Duration::ZERO,
        ));
        assert!(stream.next().await.unwrap().is_err());
        assert!(!gate.state.lock().unwrap().background);
        let permit = gate.acquire(RequestClass::Foreground).await.unwrap();
        let stream = permit.wrap(Box::pin(futures::stream::pending()));
        drop(stream);
        assert_eq!(gate.state.lock().unwrap().foreground, 0);
    }

    #[tokio::test]
    async fn ordinary_compaction_stays_foreground_while_background_is_in_flight() {
        let tmp = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let provider: Arc<dyn Provider> = Arc::new(CountingPendingProvider(calls.clone()));
        let engine = TestEngineBuilder::new(tmp.path())
            .provider(provider.clone())
            .build();
        let _background = acquire(&provider, RequestClass::SkillReview).await.unwrap();
        let compactor =
            crate::ConversationCompactor::new(provider.clone(), engine.context_budget());
        let messages = [kcoder_types::Message::user_text("old request")];
        let mut compact =
            Box::pin(compactor.summarize_old_messages(&messages, "test", 128, None, None));
        assert!(futures::poll!(compact.as_mut()).is_pending());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(gate_for(&provider).state.lock().unwrap().foreground, 1);
        drop(compact);
        assert_eq!(gate_for(&provider).state.lock().unwrap().foreground, 0);
    }
}

use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use futures::{Stream, StreamExt};
use kcoder_api::{Provider, ProviderStream};
use kcoder_types::StreamEvent;
use tokio::sync::Notify;
use tokio::time::Instant;

const MAX_QUEUED: usize = 32;
const MAX_WAIT: Duration = Duration::from_secs(30);
const AGE_PROMOTION: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum RequestClass {
    #[default]
    Foreground,
    Prefire,
    SessionMemory,
    SkillReview,
}

#[derive(Default)]
struct Gate {
    state: Mutex<State>,
    changed: Notify,
}

#[derive(Default)]
struct State {
    foreground: usize,
    background: bool,
    next_ticket: u64,
    queue: Vec<Ticket>,
}

struct Ticket {
    id: u64,
    class: RequestClass,
    created: Instant,
}

impl Ticket {
    fn priority(&self, now: Instant) -> (u8, u64) {
        let rank = if now.duration_since(self.created) >= AGE_PROMOTION {
            0
        } else {
            match self.class {
                RequestClass::Foreground | RequestClass::Prefire => 0,
                RequestClass::SessionMemory => 1,
                RequestClass::SkillReview => 2,
            }
        };
        (rank, self.id)
    }
}

// Only weak provider identities are retained; neither names nor credentials are keys.
struct RegistryEntry {
    provider: Weak<dyn Provider>,
    gate: Arc<Gate>,
}

fn gate_for(provider: &Arc<dyn Provider>) -> Arc<Gate> {
    static REGISTRY: OnceLock<Mutex<Vec<RegistryEntry>>> = OnceLock::new();
    let mut registry = REGISTRY.get_or_init(Mutex::default).lock().unwrap();
    registry.retain(|entry| entry.provider.strong_count() != 0);
    let identity = Arc::downgrade(provider);
    if let Some(entry) = registry
        .iter()
        .find(|entry| entry.provider.ptr_eq(&identity))
    {
        return entry.gate.clone();
    }
    let gate = Arc::new(Gate::default());
    registry.push(RegistryEntry {
        provider: identity,
        gate: gate.clone(),
    });
    gate
}

pub(crate) async fn acquire(
    provider: &Arc<dyn Provider>,
    class: RequestClass,
) -> anyhow::Result<Permit> {
    gate_for(provider).acquire(class).await
}

#[cfg(test)]
pub(crate) fn queued_requests_for_test(provider: &Arc<dyn Provider>, class: RequestClass) -> usize {
    gate_for(provider)
        .state
        .lock()
        .unwrap()
        .queue
        .iter()
        .filter(|ticket| ticket.class == class)
        .count()
}

impl Gate {
    async fn acquire(self: &Arc<Self>, class: RequestClass) -> anyhow::Result<Permit> {
        self.acquire_until(class, Instant::now() + MAX_WAIT).await
    }

    async fn acquire_until(
        self: &Arc<Self>,
        class: RequestClass,
        deadline: Instant,
    ) -> anyhow::Result<Permit> {
        let id = {
            let mut state = self.state.lock().unwrap();
            if class == RequestClass::Foreground {
                state.foreground += 1;
                return Ok(Permit {
                    gate: self.clone(),
                    class,
                });
            }
            if state.queue.len() >= MAX_QUEUED {
                anyhow::bail!("background admission queue is full");
            }
            let id = state.next_ticket;
            state.next_ticket += 1;
            state.queue.push(Ticket {
                id,
                class,
                created: Instant::now(),
            });
            id
        };
        let mut queued = Queued {
            gate: self.clone(),
            id: Some(id),
        };
        loop {
            // Register before checking state so a permit release cannot be lost.
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let now = Instant::now();
                let mut state = self.state.lock().unwrap();
                if now >= deadline {
                    anyhow::bail!("background admission timed out");
                }
                let next = state
                    .queue
                    .iter()
                    .min_by_key(|ticket| ticket.priority(now))
                    .map(|ticket| ticket.id);
                if state.foreground == 0 && !state.background && next == Some(id) {
                    state.queue.retain(|ticket| ticket.id != id);
                    state.background = true;
                    queued.id = None;
                    return Ok(Permit {
                        gate: self.clone(),
                        class,
                    });
                }
            }
            tokio::select! {
                _ = notified => {},
                _ = tokio::time::sleep_until(deadline) => {},
            }
        }
    }
}

struct Queued {
    gate: Arc<Gate>,
    id: Option<u64>,
}

impl Drop for Queued {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            self.gate
                .state
                .lock()
                .unwrap()
                .queue
                .retain(|ticket| ticket.id != id);
            self.gate.changed.notify_waiters();
        }
    }
}

pub(crate) struct Permit {
    gate: Arc<Gate>,
    class: RequestClass,
}

impl Drop for Permit {
    fn drop(&mut self) {
        {
            let mut state = self.gate.state.lock().unwrap();
            if self.class == RequestClass::Foreground {
                state.foreground -= 1;
            } else {
                state.background = false;
            }
        }
        self.gate.changed.notify_waiters();
    }
}

impl Permit {
    /// Release at the protocol terminal event, not after retry/compaction work.
    pub(crate) fn wrap(self, stream: ProviderStream) -> ProviderStream {
        Box::pin(AdmittedStream {
            stream: Some(stream),
            permit: Some(self),
        })
    }
}

struct AdmittedStream {
    stream: Option<ProviderStream>,
    permit: Option<Permit>,
}

impl Stream for AdmittedStream {
    type Item = Result<StreamEvent, kcoder_api::ApiErrorKind>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        let Some(stream) = self.stream.as_mut() else {
            return std::task::Poll::Ready(None);
        };
        let result = stream.poll_next_unpin(cx);
        let failed_or_closed = matches!(
            &result,
            std::task::Poll::Ready(None | Some(Err(_) | Ok(StreamEvent::Error { .. })))
        );
        if failed_or_closed {
            self.stream.take();
        }
        // MessageStop ends admission, but consumers retain their original
        // policy for trailing usage or protocol events on the same stream.
        if failed_or_closed
            || matches!(
                &result,
                std::task::Poll::Ready(Some(Ok(StreamEvent::MessageStop)))
            )
        {
            self.permit.take();
        }
        result
    }
}

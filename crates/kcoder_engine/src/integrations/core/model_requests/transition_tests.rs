//! Deterministic Engine/Provider protocol consumers. The native callback fixture
//! is not a production policy or a real NativeBudgetStore reservation.
use super::*;
use crate::{
    ClientModelConfiguration, QueryEngine,
    test_support::{engine_builder::TestEngineBuilder, events::simple_text_events},
};
use futures::StreamExt;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_types::{Message, MessagesRequest, StreamEvent};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};
#[derive(Default)]
struct Stats {
    calls: Mutex<Vec<(String, serde_json::Value)>>,
    reserves: Mutex<Vec<String>>,
    ends: Mutex<Vec<NativeModelRequestEnd>>,
    authorizations: AtomicUsize,
}
struct Inner {
    id: &'static str,
    mode: usize,
    stats: Arc<Stats>,
}
impl Provider for Inner {
    fn name(&self) -> &'static str {
        "native-transition-protocol"
    }
    fn api_key_configured(&self) -> Option<bool> {
        Some(false)
    }
    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        self.stats
            .calls
            .lock()
            .unwrap()
            .push((self.id.into(), serde_json::to_value(request).unwrap()));
        if self.mode == 1 {
            return Err(ApiErrorKind::Api {
                error_type: "overloaded_error".into(),
                message: String::new(),
            });
        }
        if self.mode == 3 {
            return Ok(Box::pin(futures::stream::iter([Err(ApiErrorKind::Api {
                error_type: "overloaded_error".into(),
                message: String::new(),
            })])));
        }
        if self.mode == 4 {
            return Ok(Box::pin(futures::stream::iter([Ok(StreamEvent::Error {
                error: kcoder_types::ApiError {
                    error_type: "overloaded_error".into(),
                    message: String::new(),
                },
            })])));
        }
        if self.mode == 2 {
            return Ok(Box::pin(futures::stream::iter(vec![
                Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: kcoder_types::ContentDelta::TextDelta {
                        text: "partial already published".into(),
                    },
                }),
                Err(ApiErrorKind::Api {
                    error_type: "overloaded_error".into(),
                    message: String::new(),
                }),
            ])));
        }
        Ok(Box::pin(futures::stream::iter(
            simple_text_events("actual fallback response")
                .into_iter()
                .map(Ok),
        )))
    }
}
struct Source {
    settings: kcoder_config::Settings,
    a: Arc<dyn Provider>,
    b: Arc<dyn Provider>,
}
impl ClientModelConfiguration for Source {
    fn settings(&self, selection: &str) -> anyhow::Result<kcoder_config::Settings> {
        let mut settings = self.settings.clone();
        let (provider, model) = selection
            .split_once("::")
            .ok_or_else(|| anyhow::anyhow!("exact selection required"))?;
        settings.apply_discovered_model(provider, model)?;
        Ok(settings)
    }
    fn provider(&self, settings: &kcoder_config::Settings) -> anyhow::Result<Arc<dyn Provider>> {
        match settings.active_provider.as_deref() {
            Some("A") => Ok(self.a.clone()),
            Some("B") => Ok(self.b.clone()),
            _ => anyhow::bail!("not configured"),
        }
    }
    fn catalog_settings(&self) -> anyhow::Result<Option<kcoder_config::Settings>> {
        Ok(Some(self.settings.clone()))
    }
}
struct Observer {
    stats: Arc<Stats>,
    allow: bool,
}
struct Lease(Arc<Stats>);
impl NativeModelRequestLease for Lease {
    fn deadline(&self) -> Option<Instant> {
        None
    }
    fn finish(
        self: Box<Self>,
        settlement: NativeModelRequestSettlement,
    ) -> Result<(), NativeModelRequestError> {
        self.0.ends.lock().unwrap().push(settlement.end);
        Ok(())
    }
}
impl NativeModelRequestObserver for Observer {
    fn reserve(
        &self,
        ctx: &NativeModelRequestContext,
        _: &MessagesRequest,
    ) -> Result<Box<dyn NativeModelRequestLease>, NativeModelRequestError> {
        assert!(ctx.execution().matches_state(ctx.state()));
        self.stats
            .reserves
            .lock()
            .unwrap()
            .push(ctx.call_id().into());
        Ok(Box::new(Lease(self.stats.clone())))
    }
    fn authorize_transition(
        &self,
        request: &NativeModelTransitionRequest<'_>,
    ) -> Result<Arc<dyn NativeModelRequestObserver>, NativeModelRequestError> {
        self.stats.authorizations.fetch_add(1, Ordering::SeqCst);
        assert!(
            request
                .context()
                .execution()
                .matches_state(request.context().state())
        );
        assert_eq!(request.policy().id, "owned");
        assert_eq!(request.previous().model_id, "one");
        assert_eq!(request.candidate().model_id, "two");
        assert!(request.failure().retryable && request.failure().resume_safe);
        assert_ne!(
            request.original_request_sha256(),
            request.candidate_request_sha256()
        );
        if !self.allow {
            return Err(NativeModelRequestError::Denied);
        }
        Ok(Arc::new(Self {
            stats: self.stats.clone(),
            allow: self.allow,
        }))
    }
}
fn engine(
    root: &std::path::Path,
    allow: bool,
    mode: usize,
    auto: bool,
) -> (QueryEngine, Arc<Stats>) {
    let profile = kcoder_config::PrivateDirectory::open_existing(root)
        .unwrap()
        .create_private_child(std::ffi::OsStr::new("test-config"))
        .unwrap();
    profile
        .atomic_replace(std::ffi::OsStr::new("settings.json"), b"{}")
        .unwrap();
    let stats = Arc::new(Stats::default());
    let a: Arc<dyn Provider> = Arc::new(Inner {
        id: "A",
        mode,
        stats: stats.clone(),
    });
    let b: Arc<dyn Provider> = Arc::new(Inner {
        id: "B",
        mode: 0,
        stats: stats.clone(),
    });
    let mut settings = crate::integrations::core::model_health::tests::settings();
    settings.training_mode = false;
    settings.session_memory.enabled = false;
    settings.memory.structured_enabled = false;
    settings.max_retries = 1;
    settings.retry_base_delay_ms = 1;
    let requested = crate::integrations::core::model_health::tests::selection(&settings);
    let source = Arc::new(Source {
        settings: settings.clone(),
        a: a.clone(),
        b,
    });
    let engine = TestEngineBuilder::new(root)
        .settings(settings)
        .provider(a)
        .build_with_profile_directory()
        .with_client_model_configuration(source)
        .with_native_model_request_observer(Arc::new(Observer {
            stats: stats.clone(),
            allow,
        }))
        .unwrap();
    if auto {
        let resolved =
            crate::integrations::core::resolve_integration_model_selection(&engine, &requested)
                .unwrap();
        (
            engine.with_native_auto_model_health(&resolved).unwrap(),
            stats,
        )
    } else {
        (engine, stats)
    }
}
fn request() -> MessagesRequest {
    MessagesRequest::new("one", vec![Message::user_text("same actual input")])
        .with_system("fixed exact prefix")
        .with_max_tokens(128)
}
#[tokio::test]
async fn additive_transition_rechecks_both_observers_and_either_denial_keeps_the_candidate_undispatched()
 {
    for (allow_original, allow_additional) in [(false, true), (true, false)] {
        let root = tempfile::tempdir().unwrap();
        let (engine, original_stats) = engine(root.path(), allow_original, 1, true);
        let additional_stats = Arc::new(Stats::default());
        let engine = engine
            .with_additional_native_model_request_observer(Arc::new(Observer {
                stats: additional_stats.clone(),
                allow: allow_additional,
            }))
            .unwrap();
        let original = request();
        assert!(
            engine
                .current_provider()
                .stream_messages(original.clone())
                .is_err()
        );
        assert!(matches!(
            engine.try_native_auto_model_transition(&original),
            Err(NativeModelRequestError::Denied)
        ));
        assert_eq!(original_stats.authorizations.load(Ordering::SeqCst), 1);
        assert_eq!(additional_stats.authorizations.load(Ordering::SeqCst), 1);
        assert_eq!(
            original_stats
                .calls
                .lock()
                .unwrap()
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            vec!["A"]
        );
        assert_eq!(engine.model_name(), "one");
    }
}
#[tokio::test]
async fn additive_transition_preserves_both_meters_on_the_actual_next_provider() {
    let root = tempfile::tempdir().unwrap();
    let (engine, original_stats) = engine(root.path(), true, 1, true);
    let additional_stats = Arc::new(Stats::default());
    let engine = engine
        .with_additional_native_model_request_observer(Arc::new(Observer {
            stats: additional_stats.clone(),
            allow: true,
        }))
        .unwrap();
    engine
        .state
        .add_message(Message::user_text("same actual source input"));
    let _ = engine
        .run_turn_stream(&kcoder_permissions::AutoDenyPrompt)
        .collect::<Vec<_>>()
        .await;
    assert_eq!(original_stats.authorizations.load(Ordering::SeqCst), 1);
    assert_eq!(additional_stats.authorizations.load(Ordering::SeqCst), 1);
    assert_eq!(original_stats.reserves.lock().unwrap().len(), 2);
    assert_eq!(additional_stats.reserves.lock().unwrap().len(), 2);
    assert_eq!(
        original_stats
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        vec!["A", "B"]
    );
}
#[tokio::test]
async fn adding_a_guard_after_a_sealed_failure_retains_the_original_native_attempt_for_both_rechecks()
 {
    let root = tempfile::tempdir().unwrap();
    let (engine, original_stats) = engine(root.path(), true, 1, true);
    let original = request();
    assert!(
        engine
            .current_provider()
            .stream_messages(original.clone())
            .is_err()
    );
    let additional_stats = Arc::new(Stats::default());
    let engine = engine
        .with_additional_native_model_request_observer(Arc::new(Observer {
            stats: additional_stats.clone(),
            allow: true,
        }))
        .unwrap();
    let candidate = engine
        .try_native_auto_model_transition(&original)
        .unwrap()
        .unwrap();
    let _ = candidate;
    assert_eq!(original_stats.authorizations.load(Ordering::SeqCst), 1);
    assert_eq!(additional_stats.authorizations.load(Ordering::SeqCst), 1);
}
async fn assert_actual_transition_mode(mode: usize) {
    let root = tempfile::tempdir().unwrap();
    let (engine, stats) = engine(root.path(), true, mode, true);
    let original = engine.session_id();
    engine
        .state
        .add_message(Message::user_text("one original native task"));
    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoDenyPrompt)
        .collect::<Vec<_>>()
        .await;
    let calls = stats.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .map(|(provider, _)| provider.as_str())
            .collect::<Vec<_>>(),
        vec!["A", "B"],
        "events={events:?}"
    );
    assert_eq!(calls[0].1["messages"], calls[1].1["messages"]);
    assert_eq!(calls[0].1["system"], calls[1].1["system"]);
    assert_eq!(calls[0].1["tools"], calls[1].1["tools"]);
    assert_eq!(calls[0].1["max_tokens"], calls[1].1["max_tokens"]);
    assert_eq!(stats.authorizations.load(Ordering::SeqCst), 1);
    assert_eq!(stats.reserves.lock().unwrap().len(), 2);
    {
        let reserves = stats.reserves.lock().unwrap();
        assert_ne!(reserves[0], reserves[1]);
    }
    assert_eq!(engine.session_id(), original);
    assert_eq!(engine.model_name(), "one");
}
#[tokio::test]
async fn actual_same_state_sync_async_and_native_error_frame_retry_preserve_original_input_and_turn()
 {
    for mode in [1, 3, 4] {
        assert_actual_transition_mode(mode).await;
    }
}

#[tokio::test]
async fn denied_callback_never_dispatches_the_candidate_or_changes_the_original_engine() {
    let root = tempfile::tempdir().unwrap();
    let (engine, stats) = engine(root.path(), false, 1, true);
    let original = request();
    assert!(
        engine
            .current_provider()
            .stream_messages(original.clone())
            .is_err()
    );
    assert!(matches!(
        engine.try_native_auto_model_transition(&original),
        Err(NativeModelRequestError::Denied)
    ));
    assert_eq!(stats.calls.lock().unwrap().len(), 1);
    assert_eq!(engine.model_name(), "one");
    assert_eq!(stats.authorizations.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn changed_request_or_non_auto_intent_cannot_mint_a_transition_from_an_old_failure() {
    for auto in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let (engine, stats) = engine(root.path(), true, 1, auto);
        let original = request();
        assert!(
            engine
                .current_provider()
                .stream_messages(original.clone())
                .is_err()
        );
        let mut changed = original;
        changed
            .messages
            .push(Message::user_text("different request"));
        assert!(
            engine
                .try_native_auto_model_transition(&changed)
                .unwrap()
                .is_none()
        );
        assert_eq!(stats.authorizations.load(Ordering::SeqCst), 0);
        assert_eq!(stats.calls.lock().unwrap().len(), 1);
    }
}
#[tokio::test]
async fn actual_partial_stream_has_no_eligible_proof_and_no_candidate_callback() {
    let root = tempfile::tempdir().unwrap();
    let (engine, stats) = engine(root.path(), true, 2, true);
    let original = request();
    let events = engine
        .current_provider()
        .stream_messages(original.clone())
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    assert!(events.last().unwrap().is_err());
    assert!(
        engine
            .try_native_auto_model_transition(&original)
            .unwrap()
            .is_none()
    );
    assert_eq!(stats.authorizations.load(Ordering::SeqCst), 0);
    assert_eq!(stats.calls.lock().unwrap().len(), 1);
}

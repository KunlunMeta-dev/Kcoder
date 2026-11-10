//! Deterministic real Provider/Engine boundaries; test leases are not Native reservations.
use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use crate::test_support::events::simple_text_events;
use futures::StreamExt;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_types::{Message, MessageDeltaFields, MessagesRequest, StreamEvent, Usage};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

#[path = "accounting_tests.rs"]
mod accounting_tests;

#[derive(Default)]
struct Stats {
    reserves: AtomicUsize,
    checks: AtomicUsize,
    finishes: Mutex<Vec<NativeModelRequestSettlement>>,
    updates: Mutex<Vec<Usage>>,
    ids: Mutex<Vec<String>>,
    purposes: Mutex<Vec<NativeModelRequestPurpose>>,
    retry_attempts: Mutex<Vec<usize>>,
    configurations: Mutex<Vec<Option<kcoder_types::ModelConfigurationSummary>>>,
    parents: Mutex<Vec<Option<String>>>,
}
struct Observer {
    stats: Arc<Stats>,
    deny: bool,
    current: Arc<AtomicBool>,
    deadline: Option<Instant>,
    root: Option<kcoder_state::AppStateIdentity>,
    usage_error: bool,
    finish_error: bool,
}
struct Lease {
    stats: Arc<Stats>,
    usage_error: bool,
    finish_error: bool,
    current: Arc<AtomicBool>,
    deadline: Option<Instant>,
}
impl NativeModelRequestLease for Lease {
    fn check_current(&self) -> Result<(), NativeModelRequestError> {
        self.stats.checks.fetch_add(1, Ordering::SeqCst);
        if self.current.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(NativeModelRequestError::Denied)
        }
    }
    fn deadline(&self) -> Option<Instant> {
        self.deadline
    }
    fn record_usage(&mut self, usage: &Usage) -> Result<(), NativeModelRequestError> {
        self.stats.updates.lock().unwrap().push(usage.clone());
        if self.usage_error {
            Err(NativeModelRequestError::Unavailable)
        } else {
            Ok(())
        }
    }
    fn finish(
        self: Box<Self>,
        result: NativeModelRequestSettlement,
    ) -> Result<(), NativeModelRequestError> {
        self.stats.finishes.lock().unwrap().push(result);
        if self.finish_error {
            Err(NativeModelRequestError::Unavailable)
        } else {
            Ok(())
        }
    }
}
impl NativeModelRequestObserver for Observer {
    fn reserve(
        &self,
        context: &NativeModelRequestContext,
        _: &MessagesRequest,
    ) -> Result<Box<dyn NativeModelRequestLease>, NativeModelRequestError> {
        self.stats.reserves.fetch_add(1, Ordering::SeqCst);
        assert!(context.execution().matches_state(context.state()));
        if let Some(parent) = context.parent_state() {
            assert!(context.execution().parent().unwrap().matches_state(parent));
        }
        self.stats.purposes.lock().unwrap().push(context.purpose());
        self.stats
            .retry_attempts
            .lock()
            .unwrap()
            .push(context.retry_attempt());
        self.stats
            .configurations
            .lock()
            .unwrap()
            .push(context.configuration().cloned());
        self.stats
            .parents
            .lock()
            .unwrap()
            .push(context.parent_state().map(|parent| parent.session_id()));
        if self.deny
            || self
                .root
                .as_ref()
                .is_some_and(|root| !root.matches(context.state()))
        {
            return Err(NativeModelRequestError::Denied);
        }
        self.stats
            .ids
            .lock()
            .unwrap()
            .push(context.call_id().into());
        Ok(Box::new(Lease {
            stats: self.stats.clone(),
            usage_error: self.usage_error,
            finish_error: self.finish_error,
            current: self.current.clone(),
            deadline: self.deadline,
        }))
    }
}
struct Inner {
    calls: Arc<AtomicUsize>,
    events: Vec<StreamEvent>,
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
    pending: bool,
    fail: bool,
}
impl Provider for Inner {
    fn name(&self) -> &'static str {
        "native-budget-test"
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn endpoint(&self) -> Option<&str> {
        Some("http://owned.example.invalid")
    }
    fn api_key_configured(&self) -> Option<bool> {
        Some(false)
    }
    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.requests
            .lock()
            .unwrap()
            .push(serde_json::to_value(request).unwrap());
        if self.fail {
            return Err(ApiErrorKind::Api {
                error_type: "known-test-provider-failure".into(),
                message: "provider failure".into(),
            });
        }
        if self.pending {
            return Ok(Box::pin(futures::stream::pending()));
        }
        Ok(Box::pin(futures::stream::iter(
            self.events.clone().into_iter().map(Ok),
        )))
    }
}
type InnerFixture = (
    Arc<dyn Provider>,
    Arc<AtomicUsize>,
    Arc<Mutex<Vec<serde_json::Value>>>,
);
fn inner(events: Vec<StreamEvent>, pending: bool, fail: bool) -> InnerFixture {
    let calls = Arc::new(AtomicUsize::new(0));
    let requests = Arc::new(Mutex::new(vec![]));
    (
        Arc::new(Inner {
            calls: calls.clone(),
            events,
            requests: requests.clone(),
            pending,
            fail,
        }),
        calls,
        requests,
    )
}
fn make_observer(
    deny: bool,
    deadline: Option<Instant>,
) -> (
    Arc<dyn NativeModelRequestObserver>,
    Arc<Stats>,
    Arc<AtomicBool>,
) {
    let stats = Arc::new(Stats::default());
    let current = Arc::new(AtomicBool::new(true));
    (
        Arc::new(Observer {
            stats: stats.clone(),
            deny,
            current: current.clone(),
            deadline,
            root: None,
            usage_error: false,
            finish_error: false,
        }),
        stats,
        current,
    )
}
fn request() -> MessagesRequest {
    MessagesRequest::new(
        "test-model",
        vec![Message::user_text("Original prefix and literal request")],
    )
    .with_system("Unchanged system prefix")
    .with_max_tokens(100)
}
fn make_engine(root: &std::path::Path, provider: Arc<dyn Provider>) -> crate::QueryEngine {
    let parent = kcoder_config::PrivateDirectory::open_existing(root).unwrap();
    let config = match parent.open_child(std::ffi::OsStr::new("test-config"), false) {
        Ok(config) => config,
        Err(_) => parent
            .create_private_child(std::ffi::OsStr::new("test-config"))
            .unwrap(),
    };
    config
        .atomic_replace(std::ffi::OsStr::new("settings.json"), b"{}")
        .unwrap();
    let settings = kcoder_config::Settings {
        training_mode: true,
        session_memory: kcoder_config::SessionMemorySettings {
            enabled: false,
            ..Default::default()
        },
        ..Default::default()
    };
    TestEngineBuilder::new(root)
        .provider(provider)
        .settings(settings)
        .build_with_profile_directory()
}
fn usage(input: u32, output: u32) -> Usage {
    Usage {
        input_tokens: input,
        output_tokens: output,
        total_tokens: Some(input + output),
        cache_creation_input_tokens: None,
        cache_read_input_tokens: None,
        iterations: None,
    }
}
#[tokio::test]
async fn denied_inner_call_is_zero_and_local_error_is_permanent_without_retry() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, calls, _) = inner(simple_text_events("done"), false, false);
    let (observer, stats, _) = make_observer(true, None);
    let engine = make_engine(temp.path(), provider)
        .with_native_model_request_observer(observer)
        .unwrap();
    let error = engine
        .current_provider()
        .stream_messages(request())
        .err()
        .unwrap();
    assert!(!crate::retry_policy::is_retryable_api_error(&error));
    assert_eq!(
        error.non_http_error_class(),
        Some(kcoder_api::NonHttpErrorClass::Permanent)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(stats.reserves.load(Ordering::SeqCst), 1);
    assert!(stats.finishes.lock().unwrap().is_empty());
    engine.state.add_message(Message::user_text(
        "Real Engine must not retry local budget denial",
    ));
    let mut stream = engine.run_turn_stream(&kcoder_permissions::AutoDenyPrompt);
    let mut observed_events = vec![];
    while let Some(event) = stream.next().await {
        observed_events.push(format!("{event:?}"));
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        stats.reserves.load(Ordering::SeqCst),
        2,
        "{observed_events:?}"
    );
}
#[tokio::test]
async fn real_usage_is_cumulative_and_trailing_usage_after_stop_is_preserved() {
    let temp = tempfile::tempdir().unwrap();
    let mut events = simple_text_events("done");
    events.push(StreamEvent::MessageDelta {
        delta: MessageDeltaFields {
            stop_reason: None,
            stop_sequence: None,
            usage: Some(usage(11, 7)),
        },
    });
    let (provider, calls, requests) = inner(events, false, false);
    let (observer, stats, _) = make_observer(false, None);
    let engine = make_engine(temp.path(), provider.clone())
        .with_native_model_request_observer(observer)
        .unwrap();
    let first = engine.current_provider();
    assert!(Arc::ptr_eq(&first, &engine.current_provider()));
    assert!(Arc::ptr_eq(&admission_identity(&first), &provider));
    let original = request();
    let value = serde_json::to_value(&original).unwrap();
    let events = first
        .stream_messages(original)
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    assert!(events.iter().any(|event|matches!(event,Ok(StreamEvent::MessageDelta{delta})if delta.usage.as_ref().is_some_and(|usage|usage.output_tokens==7))));
    assert_eq!(requests.lock().unwrap()[0], value);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let finishes = stats.finishes.lock().unwrap();
    assert_eq!(finishes.len(), 1);
    assert_eq!(finishes[0].end, NativeModelRequestEnd::MessageStop);
    assert!(finishes[0].usage_from_delta);
    assert_eq!(finishes[0].usage.as_ref().unwrap().output_tokens, 7);
}
#[tokio::test]
async fn missing_usage_and_dropped_or_failed_stream_do_not_claim_zero_cost() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, _, _) = inner(simple_text_events("done"), false, false);
    let (observer, stats, _) = make_observer(false, None);
    let engine = make_engine(temp.path(), provider)
        .with_native_model_request_observer(observer)
        .unwrap();
    engine
        .current_provider()
        .stream_messages(request())
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    let final_state = stats.finishes.lock().unwrap();
    assert_eq!(final_state.len(), 1);
    assert!(!final_state[0].usage_from_delta);
    drop(final_state);
    for fail in [false, true] {
        let (provider, _, _) = inner(vec![], !fail, fail);
        let (observer, stats, _) = make_observer(false, None);
        let engine = make_engine(temp.path(), provider)
            .with_native_model_request_observer(observer)
            .unwrap();
        match engine.current_provider().stream_messages(request()) {
            Ok(stream) => drop(stream),
            Err(_) => assert!(fail),
        }
        let finishes = stats.finishes.lock().unwrap();
        assert_eq!(finishes.len(), 1);
        assert!(finishes[0].usage.is_none());
        assert!(finishes[0].request_dispatched);
        assert_eq!(
            finishes[0].end,
            if fail {
                NativeModelRequestEnd::ProviderError
            } else {
                NativeModelRequestEnd::Dropped
            }
        );
    }
}
#[tokio::test]
async fn deadline_pending_stream_and_revoked_lease_stop_without_new_request() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, calls, _) = inner(vec![], true, false);
    let engine = make_engine(temp.path(), provider);
    let (observer, stats, _) =
        make_observer(false, Some(Instant::now() + Duration::from_millis(30)));
    let engine = engine.with_native_model_request_observer(observer).unwrap();
    let mut stream = engine
        .current_provider()
        .stream_messages(request())
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(1), stream.next())
        .await
        .unwrap()
        .unwrap();
    assert!(result.is_err());
    drop(stream);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        stats.finishes.lock().unwrap()[0].end,
        NativeModelRequestEnd::Deadline
    );
    let (provider, calls, _) = inner(vec![], true, false);
    let (observer, stats, current) = make_observer(false, None);
    let engine = make_engine(temp.path(), provider)
        .with_native_model_request_observer(observer)
        .unwrap();
    let mut stream = engine
        .current_provider()
        .stream_messages(request())
        .unwrap();
    current.store(false, Ordering::SeqCst);
    assert!(
        tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    drop(stream);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        stats.finishes.lock().unwrap()[0].end,
        NativeModelRequestEnd::AdmissionChanged
    );
}
#[tokio::test]
async fn rebind_clone_and_foreign_state_do_not_double_wrap_or_charge_another_actor() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, calls, _) = inner(simple_text_events("done"), false, false);
    let (observer, stats, _) = make_observer(false, None);
    let engine = make_engine(temp.path(), provider.clone());
    assert!(Arc::ptr_eq(&engine.current_provider(), &provider));
    let engine = engine
        .with_native_model_request_observer(observer.clone())
        .unwrap();
    let first = engine.current_provider();
    let engine = engine.with_native_model_request_observer(observer).unwrap();
    assert!(Arc::ptr_eq(&first, &engine.current_provider()));
    engine
        .current_provider()
        .stream_messages(request())
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    let mut foreign = engine.clone();
    foreign.state = kcoder_state::AppState::new(temp.path());
    assert!(
        foreign
            .current_provider()
            .stream_messages(request())
            .is_err()
    );
    assert_eq!(stats.reserves.load(Ordering::SeqCst), 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let (new, other, _) = make_observer(false, None);
    let rebound = engine.with_native_model_request_observer(new).unwrap();
    rebound
        .current_provider()
        .stream_messages(request())
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    assert_eq!(other.reserves.load(Ordering::SeqCst), 1);
    assert_eq!(stats.reserves.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn provider_constructor_requires_real_parent_before_inheriting_observer() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, calls, _) = inner(simple_text_events("child result"), false, false);
    let (observer, stats, _) = make_observer(false, None);
    let parent = make_engine(temp.path(), provider)
        .with_native_model_request_observer(observer)
        .unwrap();
    let child = make_engine(temp.path(), parent.current_provider());
    assert!(child.current_provider().stream_messages(request()).is_err());
    assert_eq!(stats.reserves.load(Ordering::SeqCst), 0);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let mut task = kcoder_state::Task::new("budget-child", "actual native parent run");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.managed = true;
    task.parent_session_id = Some(parent.state.session_id());
    let run = parent.state.start_background_task_run(task).unwrap();
    let child = child
        .with_subagent_runtime_control(
            parent.state.clone(),
            "budget-child".into(),
            temp.path().join("child.jsonl"),
        )
        .inherit_native_model_requests_from(&parent)
        .unwrap();
    assert_eq!(
        child
            .native_tool_execution_witness()
            .parent()
            .unwrap()
            .background_run(),
        Some(&run)
    );
    child
        .current_provider()
        .stream_messages(request())
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    assert_eq!(stats.reserves.load(Ordering::SeqCst), 1);
    assert_eq!(
        stats.parents.lock().unwrap().as_slice(),
        &[Some(parent.state.session_id())]
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let sibling = make_engine(temp.path(), child.current_provider());
    assert!(
        sibling
            .current_provider()
            .stream_messages(request())
            .is_err()
    );
    assert_eq!(stats.reserves.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn real_engine_continuations_get_distinct_call_ids_and_profile_switch_not_double_wrapped() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, calls, _) = inner(simple_text_events("complete"), false, false);
    let (observer, stats, _) = make_observer(false, None);
    let engine = make_engine(temp.path(), provider.clone())
        .with_native_model_request_observer(observer)
        .unwrap();
    for input in ["first actual turn", "second actual turn"] {
        engine.state.add_message(Message::user_text(input));
        engine
            .run_turn_stream(&kcoder_permissions::AutoDenyPrompt)
            .collect::<Vec<_>>()
            .await;
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(stats.reserves.load(Ordering::SeqCst), 2);
    let before = engine.current_provider();
    {
        let mut settings = engine.settings.write().unwrap();
        let mut profile = kcoder_config::default_active_provider_config();
        profile.default_model = "model-after-switch".into();
        profile.models.clear();
        settings.providers.insert("budget-switch".into(), profile);
    }
    let selected = engine.switch_provider_profile("budget-switch").unwrap();
    let after = engine.current_provider();
    assert!(!Arc::ptr_eq(&before, &after));
    assert!(Arc::ptr_eq(&admission_identity(&after), &provider));
    assert!(Arc::ptr_eq(&after, &engine.current_provider()));
    after
        .stream_messages(MessagesRequest::new(
            selected.model,
            vec![Message::user_text("switched")],
        ))
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    assert_eq!(stats.reserves.load(Ordering::SeqCst), 3);
    let ids = stats.ids.lock().unwrap();
    assert_eq!(
        ids.iter().collect::<std::collections::BTreeSet<_>>().len(),
        3
    );
    let configs = stats.configurations.lock().unwrap();
    assert_eq!(
        configs[2].as_ref().unwrap().provider_id.as_deref(),
        Some("budget-switch")
    );
    assert_eq!(configs[2].as_ref().unwrap().model_id, "model-after-switch");
}

struct FixedSource(Arc<dyn Provider>);
impl crate::ClientModelConfiguration for FixedSource {
    fn settings(&self, _: &str) -> anyhow::Result<kcoder_config::Settings> {
        anyhow::bail!("owned source cannot resolve arbitrary settings")
    }
    fn provider(&self, _: &kcoder_config::Settings) -> anyhow::Result<Arc<dyn Provider>> {
        Ok(self.0.clone())
    }
}

#[tokio::test]
async fn actual_summary_and_moa_factories_observe_selected_model_once_and_preserve_body() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, calls, requests) = inner(simple_text_events("auxiliary result"), false, false);
    let (observer, stats, _) = make_observer(false, None);
    let engine = make_engine(temp.path(), provider.clone())
        .with_client_model_configuration(Arc::new(FixedSource(provider)))
        .with_native_model_request_observer(observer)
        .unwrap();
    {
        let mut settings = engine.settings.write().unwrap();
        let mut profile = kcoder_config::default_active_provider_config();
        profile.default_model = "aux-model".into();
        profile.models.clear();
        settings.providers.insert("budget-aux".into(), profile);
        settings.summary_profile = Some("budget-aux".into());
    }
    let (_, model, max_tokens, summary) = engine.summary_runtime().unwrap();
    let expected = MessagesRequest::new(model, vec![Message::user_text("summary payload")])
        .with_max_tokens(max_tokens);
    let original = serde_json::to_value(&expected).unwrap();
    summary
        .stream_messages(expected)
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    assert_eq!(requests.lock().unwrap()[0], original);
    let settings = engine.settings.read().unwrap().clone();
    let moa_model = kcoder_config::MoaModelConfig {
        profile: Some("budget-aux".into()),
        provider: String::new(),
        model: String::new(),
    };
    let result = crate::moa_runtime::run_single_moa_reference_observed(
        settings.clone(),
        moa_model.clone(),
        0,
        vec![Message::user_text("original reference text")].into(),
        engine.state.session_id(),
        engine.cancel_token(),
        100,
        engine.client_model_configuration.clone(),
        engine.validated_model_request_binding().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(result.text, "auxiliary result");
    let aggregator = engine
        .build_moa_provider_observed(
            &settings,
            &moa_model,
            engine.client_model_configuration.as_deref(),
            NativeModelRequestPurpose::MoaAggregator,
        )
        .unwrap();
    aggregator
        .stream_messages(request())
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert_eq!(stats.reserves.load(Ordering::SeqCst), 3);
    assert_eq!(
        stats.purposes.lock().unwrap().as_slice(),
        &[
            NativeModelRequestPurpose::Summary,
            NativeModelRequestPurpose::MoaReference,
            NativeModelRequestPurpose::MoaAggregator
        ]
    );
    assert!(
        stats
            .configurations
            .lock()
            .unwrap()
            .iter()
            .all(|cfg| cfg.as_ref().is_some_and(|cfg| cfg.model_id == "aux-model"))
    );
}

#[test]
fn observed_provider_rejects_without_owned_timer_before_reservation() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, calls, _) = inner(vec![], true, false);
    let (observer, stats, _) = make_observer(false, None);
    let engine = make_engine(temp.path(), provider)
        .with_native_model_request_observer(observer)
        .unwrap();
    assert!(
        engine
            .current_provider()
            .stream_messages(request())
            .is_err()
    );
    assert_eq!(stats.reserves.load(Ordering::SeqCst), 0);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn callback_failures_keep_original_lease_and_stream_observations_without_replay() {
    let temp = tempfile::tempdir().unwrap();
    for fail_record in [true, false] {
        let events = vec![
            StreamEvent::MessageDelta {
                delta: MessageDeltaFields {
                    stop_reason: None,
                    stop_sequence: None,
                    usage: Some(usage(20, 4)),
                },
            },
            StreamEvent::MessageStop,
        ];
        let (provider, calls, _) = inner(events, false, false);
        let stats = Arc::new(Stats::default());
        let observer = Arc::new(Observer {
            stats: stats.clone(),
            deny: false,
            current: Arc::new(AtomicBool::new(true)),
            deadline: None,
            root: None,
            usage_error: fail_record,
            finish_error: !fail_record,
        });
        let engine = make_engine(temp.path(), provider)
            .with_native_model_request_observer(observer)
            .unwrap();
        let events = engine
            .current_provider()
            .stream_messages(request())
            .unwrap()
            .collect::<Vec<_>>()
            .await;
        assert_eq!(events.iter().any(Result::is_err), fail_record);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(stats.reserves.load(Ordering::SeqCst), 1);
        let finishes = stats.finishes.lock().unwrap();
        assert_eq!(finishes.len(), 1);
        assert_eq!(finishes[0].usage.as_ref().unwrap().output_tokens, 4);
        assert!(finishes[0].request_dispatched);
        assert_eq!(
            finishes[0].end,
            if fail_record {
                NativeModelRequestEnd::UsageAccountingFailed
            } else {
                NativeModelRequestEnd::MessageStop
            }
        );
    }
}

#[tokio::test]
async fn expired_lease_before_send_is_not_dispatched_and_policy_not_checked_per_token() {
    let temp = tempfile::tempdir().unwrap();
    let mut events = vec![StreamEvent::Ping; 2000];
    events.push(StreamEvent::MessageStop);
    let (provider, calls, _) = inner(events, false, false);
    let base = make_engine(temp.path(), provider);
    let (observer, stats, _) = make_observer(false, Some(Instant::now() - Duration::from_secs(1)));
    let denied = base
        .clone()
        .with_native_model_request_observer(observer)
        .unwrap();
    assert!(
        denied
            .current_provider()
            .stream_messages(request())
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        stats.finishes.lock().unwrap()[0].end,
        NativeModelRequestEnd::Deadline
    );
    assert!(!stats.finishes.lock().unwrap()[0].request_dispatched);
    let (observer, stats, _) = make_observer(false, None);
    let engine = base.with_native_model_request_observer(observer).unwrap();
    engine
        .current_provider()
        .stream_messages(request())
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        stats.checks.load(Ordering::SeqCst) < 10,
        "checks are bounded heartbeats, not per token"
    );
}

struct MetadataProvider(Arc<AtomicUsize>);
impl Provider for MetadataProvider {
    fn name(&self) -> &'static str {
        "metadata-test"
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn supports_response_json_schema(&self) -> bool {
        true
    }
    fn endpoint(&self) -> Option<&str> {
        Some("http://metadata.example.invalid")
    }
    fn api_key_configured(&self) -> Option<bool> {
        Some(true)
    }
    fn request_timeout_secs(&self) -> Option<u64> {
        Some(19)
    }
    fn prewarm(&self) -> kcoder_api::providers::ProviderPrewarm {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {})
    }
    fn discover_models(
        &self,
        _: kcoder_api::ModelDiscoveryOptions,
    ) -> kcoder_api::ProviderModelDiscovery {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(vec!["actual-metadata-model".into()]) })
    }
    fn count_tokens(&self, _: MessagesRequest) -> kcoder_api::ProviderTokenCount {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(Some(37)) })
    }
    fn stream_messages(&self, _: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        panic!("metadata calls cannot generate model output")
    }
}

#[tokio::test]
async fn metadata_count_discovery_and_prewarm_delegate_without_model_reservation() {
    let temp = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let provider: Arc<dyn Provider> = Arc::new(MetadataProvider(calls.clone()));
    let base = make_engine(temp.path(), provider.clone());
    assert!(Arc::ptr_eq(&provider, &base.current_provider()));
    let (observer, stats, _) = make_observer(false, None);
    let engine = base.with_native_model_request_observer(observer).unwrap();
    let wrapped = engine.current_provider();
    assert_eq!(wrapped.name(), "metadata-test");
    assert!(wrapped.supports_response_json_schema());
    assert!(!wrapped.supports_client_runtime_reconfiguration());
    assert_eq!(wrapped.endpoint(), provider.endpoint());
    assert_eq!(wrapped.api_key_configured(), Some(true));
    assert_eq!(wrapped.request_timeout_secs(), Some(19));
    wrapped.prewarm().await;
    assert_eq!(
        wrapped
            .discover_models(kcoder_api::ModelDiscoveryOptions {
                timeout: Duration::from_secs(1),
                max_models: 5
            })
            .await
            .unwrap(),
        ["actual-metadata-model"]
    );
    assert_eq!(wrapped.count_tokens(request()).await.unwrap(), Some(37));
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert_eq!(stats.reserves.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn actual_shared_admission_queue_is_not_split_by_actor_or_auxiliary_wrappers() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, _, _) = inner(simple_text_events("complete"), false, false);
    let (observer, stats, _) = make_observer(false, None);
    let engine = make_engine(temp.path(), provider.clone())
        .with_native_model_request_observer(observer)
        .unwrap();
    let auxiliary = engine.observe_model_provider(
        provider.clone(),
        NativeModelRequestPurpose::Summary,
        engine.observer_main_configuration(),
    );
    let foreground = crate::request_admission::acquire(
        &engine.current_provider(),
        crate::request_admission::RequestClass::Foreground,
    )
    .await
    .unwrap();
    let mut internal = Box::pin(crate::request_admission::acquire(
        &auxiliary,
        crate::request_admission::RequestClass::SkillReview,
    ));
    assert!(futures::poll!(internal.as_mut()).is_pending());
    assert_eq!(
        stats.reserves.load(Ordering::SeqCst),
        0,
        "waiting does not reserve or dispatch"
    );
    drop(foreground);
    assert!(internal.await.is_ok());
}

#[tokio::test]
async fn real_forked_agent_constructor_inherits_actual_parent_actor_and_observer() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, calls, _) = inner(simple_text_events("actual fork result"), false, false);
    let (observer, stats, _) = make_observer(false, None);
    let parent = make_engine(temp.path(), provider)
        .with_native_model_request_observer(observer)
        .unwrap();
    let cache = crate::agent::CacheSafeParams {
        fork_context_messages: vec![Message::user_text("owned fork context")].into(),
        active_skills: vec![],
        snapshot_provider: parent.provider_name(),
        snapshot_model: parent.model_name(),
        context_history_anchor: None,
        full_context_compatible: true,
    };
    let result = crate::agent::run_forked_agent_with_tools(
        &parent,
        &cache,
        vec![Message::user_text("owned child request")],
        crate::agent::SubagentContextOverrides::default(),
        2,
        kcoder_tools::ToolRegistry::new(),
    )
    .await
    .unwrap();
    assert!(result.output_text.contains("actual fork result"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(stats.reserves.load(Ordering::SeqCst), 1);
    assert_eq!(
        stats.parents.lock().unwrap().as_slice(),
        &[Some(parent.state.session_id())]
    );
}

#[tokio::test]
async fn actual_background_memory_job_cannot_bypass_model_admission() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, calls, _) = inner(simple_text_events("not sent"), false, false);
    let (observer, stats, _) = make_observer(true, None);
    let engine = make_engine(temp.path(), provider)
        .with_native_model_request_observer(observer)
        .unwrap();
    {
        let mut settings = engine.settings.write().unwrap();
        settings.training_mode = false;
        settings.summary_profile = None;
        settings.summary_provider = None;
        settings.summary_model = None;
        settings.session_memory.enabled = true;
        settings.session_memory.update_enabled = true;
        settings.session_memory.init_min_tokens = 1;
        settings.session_memory.update_interval_turns = 1;
    }
    let original = vec![
        Message::user_text("Actual background memory source".repeat(30)),
        Message::assistant_text("done"),
    ];
    engine.state.set_messages(original.clone());
    engine.maybe_spawn_session_memory_update(1, &[]);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if stats.reserves.load(Ordering::SeqCst) > 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    engine.wait_for_session_memory_update_before_compact().await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(stats.reserves.load(Ordering::SeqCst), 1);
    assert_eq!(
        stats.purposes.lock().unwrap().as_slice(),
        &[NativeModelRequestPurpose::Summary]
    );
    assert_eq!(engine.state.messages(), original);
}

#[tokio::test]
async fn actual_compaction_and_session_end_summary_cannot_bypass_model_admission() {
    for session_end in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let (provider, calls, _) = inner(simple_text_events("not sent"), false, false);
        let (observer, stats, _) = make_observer(true, None);
        let engine = make_engine(temp.path(), provider)
            .with_native_model_request_observer(observer)
            .unwrap();
        {
            let mut settings = engine.settings.write().unwrap();
            settings.training_mode = false;
            settings.summary_profile = None;
            settings.summary_provider = None;
            settings.summary_model = None;
        }
        engine.state.set_messages(
            (0..40)
                .flat_map(|index| {
                    [
                        Message::user_text(format!(
                            "Original source {index} {}",
                            "preserve facts ".repeat(100)
                        )),
                        Message::assistant_text("known reply"),
                    ]
                })
                .collect(),
        );
        if session_end {
            engine.run_session_end_hooks("owned test end").await;
        } else {
            assert!(engine.compact_conversation().await.is_err());
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            stats.reserves.load(Ordering::SeqCst),
            1,
            "auxiliary local denial must not retry"
        );
        assert_eq!(
            stats.purposes.lock().unwrap().as_slice(),
            &[NativeModelRequestPurpose::Summary]
        );
    }
}

#[tokio::test]
async fn actual_background_skill_review_child_cannot_bypass_model_admission() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, calls, _) = inner(simple_text_events("not sent"), false, false);
    let (observer, stats, _) = make_observer(true, None);
    let parent = make_engine(temp.path(), provider)
        .with_native_model_request_observer(observer)
        .unwrap();
    let cache = crate::agent::CacheSafeParams {
        fork_context_messages: vec![Message::user_text("owned skill context")].into(),
        active_skills: vec![],
        snapshot_provider: parent.provider_name(),
        snapshot_model: parent.model_name(),
        context_history_anchor: None,
        full_context_compatible: true,
    };
    assert!(
        parent
            .run_background_skill_review(
                cache,
                "inspect owned evidence".into(),
                "owned-review-job".into()
            )
            .await
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(stats.reserves.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn terminal_frame_waits_for_actual_tail_settlement_before_auxiliary_break() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, _, _) = inner(
        vec![
            StreamEvent::MessageStop,
            StreamEvent::MessageDelta {
                delta: MessageDeltaFields {
                    stop_reason: None,
                    stop_sequence: None,
                    usage: Some(usage(90, 80)),
                },
            },
        ],
        false,
        false,
    );
    let (observer, stats, _) = make_observer(false, None);
    let engine = make_engine(temp.path(), provider)
        .with_native_model_request_observer(observer)
        .unwrap();
    let mut stream = engine
        .current_provider()
        .stream_messages(request())
        .unwrap();
    assert!(matches!(
        stream.next().await,
        Some(Ok(StreamEvent::MessageStop))
    ));
    drop(stream);
    let settlements = stats.finishes.lock().unwrap();
    assert_eq!(settlements.len(), 1);
    assert_eq!(settlements[0].end, NativeModelRequestEnd::MessageStop);
    assert!(settlements[0].usage_from_delta);
    assert_eq!(settlements[0].usage.as_ref().unwrap().output_tokens, 80);
}

struct UnfinishedTail;
impl Provider for UnfinishedTail {
    fn name(&self) -> &'static str {
        "owned-unfinished-tail"
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn stream_messages(&self, _: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        Ok(Box::pin(
            futures::stream::iter([Ok(StreamEvent::MessageStop)]).chain(futures::stream::pending()),
        ))
    }
}
#[tokio::test]
async fn unfinished_terminal_tail_drop_and_deadline_remain_unknown() {
    for timed_out in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let base = make_engine(temp.path(), Arc::new(UnfinishedTail));
        let (observer, stats, _) = make_observer(
            false,
            timed_out.then(|| Instant::now() + Duration::from_millis(25)),
        );
        let engine = base.with_native_model_request_observer(observer).unwrap();
        let mut stream = engine
            .current_provider()
            .stream_messages(request())
            .unwrap();
        if timed_out {
            assert!(
                tokio::time::timeout(Duration::from_secs(1), stream.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .is_err()
            );
        } else {
            assert!(
                tokio::time::timeout(Duration::from_millis(5), stream.next())
                    .await
                    .is_err()
            );
        }
        drop(stream);
        let finishes = stats.finishes.lock().unwrap();
        assert_eq!(finishes.len(), 1);
        assert_eq!(
            finishes[0].end,
            if timed_out {
                NativeModelRequestEnd::Deadline
            } else {
                NativeModelRequestEnd::Dropped
            }
        );
        assert!(finishes[0].usage.is_none());
    }
}

#[tokio::test]
async fn four_actual_auxiliary_consumers_settle_full_trailing_usage_before_breaking_at_stop() {
    for mode in ["memory", "compact", "session_end", "skill_review"] {
        let temp = tempfile::tempdir().unwrap();
        let text = match mode {
            "memory" => format!("<session_memory>{}</session_memory>", crate::context::DEFAULT_SESSION_MEMORY_TEMPLATE),
            "compact" => "<analysis>checked</analysis><summary>Retained original task, completed facts and next steps.</summary>".into(),
            _ => "Owned summary is complete; no skill changes required.".into(),
        };
        let mut events = simple_text_events(&text);
        events.push(StreamEvent::MessageDelta {
            delta: MessageDeltaFields {
                stop_reason: None,
                stop_sequence: None,
                usage: Some(usage(90, 80)),
            },
        });
        let (provider, calls, _) = inner(events, false, false);
        let (observer, stats, _) = make_observer(false, None);
        let engine = make_engine(temp.path(), provider)
            .with_native_model_request_observer(observer)
            .unwrap();
        {
            let mut settings = engine.settings.write().unwrap();
            settings.training_mode = false;
            settings.summary_profile = None;
            settings.summary_provider = None;
            settings.summary_model = None;
            settings.session_memory.enabled = mode == "memory";
            settings.session_memory.update_enabled = true;
            settings.session_memory.init_min_tokens = 1;
            settings.session_memory.update_interval_turns = 1;
        }
        engine.state.set_messages(
            (0..40)
                .flat_map(|index| {
                    [
                        Message::user_text(format!(
                            "Original retained source {index} {}",
                            "preserve facts ".repeat(100)
                        )),
                        Message::assistant_text("known reply"),
                    ]
                })
                .collect(),
        );
        match mode {
            "memory" => {
                engine.maybe_spawn_session_memory_update(1, &[]);
                tokio::time::timeout(Duration::from_secs(5), async {
                    while stats.finishes.lock().unwrap().is_empty() {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
                engine.wait_for_session_memory_update_before_compact().await;
                assert!(engine.state.session_memory().is_some());
            }
            "compact" => {
                assert!(engine.compact_conversation().await.unwrap().did_compact);
            }
            "session_end" => {
                engine.run_session_end_hooks("owned close").await;
            }
            _ => {
                let cache = crate::agent::CacheSafeParams {
                    fork_context_messages: vec![Message::user_text("owned skill context")].into(),
                    active_skills: vec![],
                    snapshot_provider: engine.provider_name(),
                    snapshot_model: engine.model_name(),
                    context_history_anchor: None,
                    full_context_compatible: true,
                };
                engine
                    .run_background_skill_review(
                        cache,
                        "inspect owned evidence".into(),
                        "owned-complete-review".into(),
                    )
                    .await
                    .unwrap();
            }
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1, "{mode}");
        let finishes = stats.finishes.lock().unwrap();
        assert_eq!(finishes.len(), 1, "{mode}");
        assert_eq!(
            finishes[0].end,
            NativeModelRequestEnd::MessageStop,
            "{mode}"
        );
        assert!(finishes[0].usage_from_delta, "{mode}");
        assert_eq!(
            finishes[0].usage.as_ref().unwrap().output_tokens,
            80,
            "{mode}"
        );
    }
}

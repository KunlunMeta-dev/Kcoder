//! Actual Engine/Provider boundary consumers; deterministic faults do not prove live-model quality.
use super::*;
use crate::{
    integrations::core::resolve_integration_model_selection,
    test_support::engine_builder::TestEngineBuilder,
};
use futures::StreamExt;
use kcoder_types::{ContentDelta, Message, MessagesRequest, StreamEvent};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

pub(super) struct Inner {
    mode: AtomicUsize,
    pub(super) calls: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
}
impl Provider for Inner {
    fn name(&self) -> &'static str {
        "deterministic-health"
    }
    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, ApiErrorKind> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.requests
            .lock()
            .unwrap()
            .push(serde_json::to_value(request).unwrap());
        match self.mode.load(Ordering::SeqCst) {
            1 => Err(ApiErrorKind::Api {
                error_type: "overloaded_error".into(),
                message: "not retained in health".into(),
            }),
            2 => Err(ApiErrorKind::Http {
                error_type: "authentication_error".into(),
                message: "secret-diagnostic-is-not-public".into(),
                metadata: kcoder_api::HttpErrorMetadata {
                    status: 401,
                    provider_code: None,
                    provider_type: None,
                    rejected_reasoning_parameter: None,
                    retry_after: None,
                },
            }),
            3 => Ok(Box::pin(futures::stream::iter(vec![
                Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta {
                        text: "partial".into(),
                    },
                }),
                Err(ApiErrorKind::Api {
                    error_type: "overloaded_error".into(),
                    message: String::new(),
                }),
            ]))),
            4 => Ok(Box::pin(futures::stream::pending())),
            _ => Ok(Box::pin(futures::stream::iter(vec![Ok(
                StreamEvent::MessageStop,
            )]))),
        }
    }
}
pub(crate) fn settings() -> kcoder_config::Settings {
    let mut settings:kcoder_config::Settings=serde_json::from_value(json!({"active_provider":"A","model":"one","training_mode":true,"providers":{
        "A":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":"http://127.0.0.1:9/v1","default_model":"one","context_window_tokens":128000,"max_output_tokens":128,"output_headroom_tokens":128},
        "B":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":"http://127.0.0.1:9/v1","default_model":"two","context_window_tokens":128000,"max_output_tokens":128,"output_headroom_tokens":128}
    },"integrations":{"core":{"modelPolicies":[{"id":"owned","candidates":[{"provider":"A","model":"one"},{"provider":"B","model":"two"}]}]}}})).unwrap();
    settings.apply_discovered_model("A", "one").unwrap();
    settings
}
pub(crate) fn selection(settings: &kcoder_config::Settings) -> IntegrationModelResolutionRequest {
    IntegrationModelResolutionRequest {
        selection: IntegrationModelSelectionIntent::AutoPolicy {
            id: "owned".into(),
            version: settings.integrations.core.model_policies[0]
                .version()
                .unwrap(),
        },
        requirements: Default::default(),
    }
}
pub(super) fn inner(mode: usize) -> Arc<Inner> {
    Arc::new(Inner {
        mode: AtomicUsize::new(mode),
        calls: Arc::default(),
        requests: Arc::default(),
    })
}
pub(super) fn request() -> MessagesRequest {
    MessagesRequest::new("one", vec![Message::user_text("Literal request")])
        .with_system("Unmodified stable prefix")
        .with_max_tokens(128)
}
#[tokio::test]
async fn actual_provider_health_keeps_request_bytes_and_original_admission_identity() {
    let root = tempfile::tempdir().unwrap();
    let inner = inner(0);
    let engine = TestEngineBuilder::new(root.path())
        .settings(settings())
        .provider(inner.clone())
        .build_with_profile_directory();
    let model = engine.active_model_configuration_summary().unwrap();
    assert_eq!(
        engine.integration_model_health(&model).state,
        IntegrationModelHealthState::Unknown
    );
    let provider = engine.current_provider();
    let raw: Arc<dyn Provider> = inner.clone();
    assert!(Arc::ptr_eq(
        &crate::native_model_requests::admission_identity(&provider),
        &raw
    ));
    let expected = serde_json::to_value(request()).unwrap();
    assert_eq!(
        provider
            .stream_messages(request())
            .unwrap()
            .collect::<Vec<_>>()
            .await
            .len(),
        1
    );
    assert_eq!(inner.calls.load(Ordering::SeqCst), 1);
    assert_eq!(inner.requests.lock().unwrap()[0], expected);
    assert_eq!(
        engine.integration_model_health(&model).state,
        IntegrationModelHealthState::Healthy
    );
    assert!(engine.integration_model_health(&model).failure.is_none());
}
#[tokio::test]
async fn transient_failure_excludes_only_its_configuration_at_the_next_fresh_auto_boundary() {
    let root = tempfile::tempdir().unwrap();
    let inner = inner(1);
    let settings = settings();
    let selection = selection(&settings);
    let engine = TestEngineBuilder::new(root.path())
        .settings(settings)
        .provider(inner.clone())
        .build_with_profile_directory();
    let model = engine.active_model_configuration_summary().unwrap();
    assert!(
        engine
            .current_provider()
            .stream_messages(request())
            .is_err()
    );
    let observed = engine.integration_model_health(&model);
    assert_eq!(observed.state, IntegrationModelHealthState::CoolingDown);
    assert!(observed.failure.unwrap().retryable);
    let next = resolve_integration_model_selection(&engine, &selection).unwrap();
    assert_eq!(next.model.provider_id.as_deref(), Some("B"));
    assert_eq!(
        engine
            .active_model_configuration_summary()
            .unwrap()
            .provider_id
            .as_deref(),
        Some("A")
    );
    assert_eq!(inner.calls.load(Ordering::SeqCst), 1);
    engine
        .settings
        .write()
        .unwrap()
        .providers
        .get_mut("A")
        .unwrap()
        .endpoint = "http://127.0.0.1:10/v1".into();
    let next = resolve_integration_model_selection(&engine, &selection).unwrap();
    assert_eq!(next.model.provider_id.as_deref(), Some("A"));
    assert_eq!(
        engine.integration_model_health(&next.model).state,
        IntegrationModelHealthState::Unknown
    );
}
#[tokio::test]
async fn authentication_does_not_rotate_to_another_model_or_leak_raw_diagnostics() {
    let root = tempfile::tempdir().unwrap();
    let inner = inner(2);
    let settings = settings();
    let selected = selection(&settings);
    let engine = TestEngineBuilder::new(root.path())
        .settings(settings)
        .provider(inner.clone())
        .build_with_profile_directory();
    assert!(
        engine
            .current_provider()
            .stream_messages(request())
            .is_err()
    );
    assert_eq!(
        resolve_integration_model_selection(&engine, &selected)
            .unwrap_err()
            .to_string(),
        "MODEL_AUTO_CONFIGURATION_BLOCKED"
    );
    let model = engine.active_model_configuration_summary().unwrap();
    let observation = engine.integration_model_health(&model);
    assert_eq!(
        observation.failure.as_ref().unwrap().category,
        ProviderFailureCategory::AuthenticationError
    );
    assert!(
        !serde_json::to_string(&observation)
            .unwrap()
            .contains("secret-diagnostic")
    );
    assert_eq!(inner.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn partial_stream_and_drop_are_not_replayed_or_reported_as_healthy() {
    let root = tempfile::tempdir().unwrap();
    let inner = inner(3);
    let engine = TestEngineBuilder::new(root.path())
        .settings(settings())
        .provider(inner.clone())
        .build_with_profile_directory();
    let model = engine.active_model_configuration_summary().unwrap();
    let events = engine
        .current_provider()
        .stream_messages(request())
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    assert_eq!(events.len(), 2);
    assert!(events[1].is_err());
    let observed = engine.integration_model_health(&model);
    assert!(observed.response_started);
    assert!(!observed.failure.unwrap().resume_safe);
    assert_eq!(inner.calls.load(Ordering::SeqCst), 1);
    inner.mode.store(4, Ordering::SeqCst);
    drop(
        engine
            .current_provider()
            .stream_messages(request())
            .unwrap(),
    );
    assert_eq!(
        engine.integration_model_health(&model).state,
        IntegrationModelHealthState::Interrupted
    );
    assert_eq!(inner.calls.load(Ordering::SeqCst), 2);
}
#[test]
fn expired_cooldown_has_one_owned_probe_and_a_dropped_probe_has_no_success() {
    let tracker = Arc::new(ModelHealthTracker::default());
    let settings = settings();
    let model = crate::model_configuration_summary(
        &settings,
        kcoder_types::ModelConfigurationBoundary::NextTurn,
    )
    .unwrap();
    let mut observation = tracker.begin(&model, false).unwrap();
    observation.error(&ApiErrorKind::Api {
        error_type: "overloaded_error".into(),
        message: String::new(),
    });
    assert!(tracker.begin(&model, true).is_err());
    tracker
        .data
        .lock()
        .unwrap()
        .entries
        .get_mut(&Key::from_model(&model))
        .unwrap()
        .until = Some(Instant::now() - Duration::from_secs(1));
    let probe = tracker.begin(&model, true).unwrap();
    assert!(tracker.begin(&model, true).is_err());
    let manual = tracker.begin(&model, false).unwrap();
    drop(probe);
    drop(manual);
    assert_eq!(
        tracker.observe(&model).state,
        IntegrationModelHealthState::Interrupted
    );
    assert!(tracker.begin(&model, true).is_err());
}
#[test]
fn health_is_bounded_and_an_unrelated_workspace_starts_unknown() {
    let tracker = Arc::new(ModelHealthTracker::default());
    let settings = settings();
    let mut model = crate::model_configuration_summary(
        &settings,
        kcoder_types::ModelConfigurationBoundary::NextTurn,
    )
    .unwrap();
    for index in 0..300 {
        model.revision = format!("actual-owned-observation-{index}");
        tracker.begin(&model, false).unwrap().success();
    }
    assert!(tracker.data.lock().unwrap().entries.len() <= MAX_RECORDS);
    assert_eq!(
        ModelHealthTracker::default().observe(&model).state,
        IntegrationModelHealthState::Unknown
    );
}

#[tokio::test]
async fn installed_auto_gate_blocks_before_the_inner_native_observer_and_manual_selection_stays_available()
 {
    use crate::native_model_requests::*;
    struct Counter(Arc<AtomicUsize>);
    struct Lease;
    impl NativeModelRequestLease for Lease {
        fn check_current(&self) -> Result<(), NativeModelRequestError> {
            Ok(())
        }
        fn deadline(&self) -> Option<Instant> {
            None
        }
        fn record_usage(&mut self, _: &kcoder_types::Usage) -> Result<(), NativeModelRequestError> {
            Ok(())
        }
        fn finish(
            self: Box<Self>,
            _: NativeModelRequestSettlement,
        ) -> Result<(), NativeModelRequestError> {
            Ok(())
        }
    }
    impl NativeModelRequestObserver for Counter {
        fn reserve(
            &self,
            _: &NativeModelRequestContext,
            _: &MessagesRequest,
        ) -> Result<Box<dyn NativeModelRequestLease>, NativeModelRequestError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(Lease))
        }
    }
    let root = tempfile::tempdir().unwrap();
    let parent = kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap();
    parent
        .create_private_child(std::ffi::OsStr::new("test-config"))
        .unwrap()
        .atomic_replace(std::ffi::OsStr::new("settings.json"), b"{}")
        .unwrap();
    let provider = inner(1);
    let settings = settings();
    let request_selection = selection(&settings);
    let engine = TestEngineBuilder::new(root.path())
        .settings(settings)
        .provider(provider.clone())
        .build_with_profile_directory();
    let resolved = resolve_integration_model_selection(&engine, &request_selection).unwrap();
    assert!(
        engine
            .current_provider()
            .stream_messages(request())
            .is_err()
    );
    let counts = Arc::new(AtomicUsize::new(0));
    let gated = engine
        .clone()
        .with_native_model_request_observer(Arc::new(Counter(counts.clone())))
        .unwrap()
        .with_native_auto_model_health(&resolved)
        .unwrap();
    let denied = gated
        .current_provider()
        .stream_messages(request())
        .err()
        .unwrap();
    assert!(
        matches!(denied, ApiErrorKind::Api { error_type, .. } if error_type == "model_auto_cooling_down")
    );
    assert_eq!(counts.load(Ordering::SeqCst), 0);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    provider.mode.store(0, Ordering::SeqCst);
    let mut stream = engine
        .current_provider()
        .stream_messages(request())
        .unwrap();
    assert!(matches!(
        stream.next().await,
        Some(Ok(StreamEvent::MessageStop))
    ));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
}

fn configuration_error(status: u16) -> ApiErrorKind {
    ApiErrorKind::Http {
        error_type: "typed-fixture-error".into(),
        message: "private diagnostic must not be retained".into(),
        metadata: kcoder_api::HttpErrorMetadata {
            status,
            provider_code: (status == 429).then(|| "insufficient_quota".into()),
            provider_type: None,
            rejected_reasoning_parameter: None,
            retry_after: None,
        },
    }
}

fn expire_cooldown(tracker: &ModelHealthTracker, model: &ModelConfigurationSummary) {
    let mut data = tracker.data.lock().unwrap();
    let entry = data.entries.get_mut(&Key::from_model(model)).unwrap();
    if entry.until.is_some() {
        entry.until = Some(Instant::now() - Duration::from_secs(1));
    }
}

#[test]
fn configuration_failures_remain_blocked_after_cooldown_and_explicit_success_recovers() {
    let settings = settings();
    let model = crate::model_configuration_summary(
        &settings,
        kcoder_types::ModelConfigurationBoundary::NextTurn,
    )
    .unwrap();
    for status in [401, 403, 404, 429] {
        let tracker = Arc::new(ModelHealthTracker::default());
        tracker
            .begin(&model, false)
            .unwrap()
            .error(&configuration_error(status));
        expire_cooldown(&tracker, &model);
        let observed = tracker.observe(&model);
        assert_eq!(
            observed.state,
            IntegrationModelHealthState::NeedsConfiguration
        );
        assert!(observed.cooldown_until.is_none());
        assert_eq!(
            tracker.routing(&model).unwrap_err().to_string(),
            "MODEL_AUTO_CONFIGURATION_BLOCKED"
        );
        assert_eq!(
            tracker.begin(&model, true).err().unwrap().to_string(),
            "MODEL_AUTO_CONFIGURATION_BLOCKED"
        );
        // An explicit failed/cancelled check is not proof of repaired configuration.
        drop(tracker.begin(&model, false).unwrap());
        assert_eq!(
            tracker.routing(&model).unwrap_err().to_string(),
            "MODEL_AUTO_CONFIGURATION_BLOCKED"
        );
        tracker.begin(&model, false).unwrap().success();
        assert_eq!(
            tracker.observe(&model).state,
            IntegrationModelHealthState::Healthy
        );
        assert!(tracker.routing(&model).is_ok());
        assert!(tracker.begin(&model, true).is_ok());
    }
}

#[test]
fn older_success_or_probe_drop_cannot_clear_a_new_configuration_failure() {
    let settings = settings();
    let model = crate::model_configuration_summary(
        &settings,
        kcoder_types::ModelConfigurationBoundary::NextTurn,
    )
    .unwrap();
    let tracker = Arc::new(ModelHealthTracker::default());
    tracker
        .begin(&model, false)
        .unwrap()
        .error(&ApiErrorKind::Api {
            error_type: "overloaded_error".into(),
            message: String::new(),
        });
    expire_cooldown(&tracker, &model);
    let mut old_probe = tracker.begin(&model, true).unwrap();
    let mut old_manual = tracker.begin(&model, false).unwrap();
    tracker
        .begin(&model, false)
        .unwrap()
        .error(&configuration_error(401));
    old_manual.success();
    assert_eq!(
        tracker.observe(&model).state,
        IntegrationModelHealthState::NeedsConfiguration
    );
    old_probe.success();
    assert_eq!(
        tracker.observe(&model).state,
        IntegrationModelHealthState::NeedsConfiguration
    );
    assert_eq!(
        tracker.routing(&model).unwrap_err().to_string(),
        "MODEL_AUTO_CONFIGURATION_BLOCKED"
    );
    assert!(
        tracker
            .data
            .lock()
            .unwrap()
            .entries
            .get(&Key::from_model(&model))
            .unwrap()
            .probe
            .is_none()
    );
    let mut changed = model.clone();
    changed.revision = "different-real-configuration-revision".into();
    assert_eq!(
        tracker.observe(&changed).state,
        IntegrationModelHealthState::Unknown
    );
    assert!(tracker.begin(&changed, true).is_ok());
}

#[test]
fn request_specific_errors_do_not_permanently_block_an_unchanged_model() {
    let settings = settings();
    let model = crate::model_configuration_summary(
        &settings,
        kcoder_types::ModelConfigurationBoundary::NextTurn,
    )
    .unwrap();
    for error_type in ["invalid_request_error", "context_length_exceeded"] {
        let tracker = Arc::new(ModelHealthTracker::default());
        tracker
            .begin(&model, false)
            .unwrap()
            .error(&ApiErrorKind::Api {
                error_type: error_type.into(),
                message: String::new(),
            });
        expire_cooldown(&tracker, &model);
        assert_eq!(
            tracker.observe(&model).state,
            IntegrationModelHealthState::Unknown
        );
        assert!(tracker.routing(&model).is_ok());
        let probe = tracker.begin(&model, true).unwrap();
        assert!(tracker.begin(&model, true).is_err());
        drop(probe);
    }
}

#[tokio::test]
async fn installed_auto_binding_cannot_probe_a_blocked_configuration_but_explicit_success_recovers()
{
    let root = tempfile::tempdir().unwrap();
    let raw = inner(2);
    let settings = settings();
    let selected = selection(&settings);
    let engine = TestEngineBuilder::new(root.path())
        .settings(settings)
        .provider(raw.clone())
        .build_with_profile_directory();
    let resolution = resolve_integration_model_selection(&engine, &selected).unwrap();
    let bound = engine
        .clone()
        .with_native_auto_model_health(&resolution)
        .unwrap();
    assert!(
        engine
            .current_provider()
            .stream_messages(request())
            .is_err()
    );
    expire_cooldown(&engine.model_health, &resolution.model);
    assert_eq!(
        resolve_integration_model_selection(&engine, &selected)
            .unwrap_err()
            .to_string(),
        "MODEL_AUTO_CONFIGURATION_BLOCKED"
    );
    let blocked = bound
        .current_provider()
        .stream_messages(request())
        .err()
        .unwrap();
    assert!(
        matches!(&blocked, ApiErrorKind::Api { error_type, .. } if error_type == "model_auto_configuration_blocked")
    );
    assert!(!crate::retry_policy::is_retryable_api_error(&blocked));
    assert_eq!(raw.calls.load(Ordering::SeqCst), 1);
    raw.mode.store(0, Ordering::SeqCst);
    engine
        .current_provider()
        .stream_messages(request())
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    assert!(resolve_integration_model_selection(&engine, &selected).is_ok());
    bound
        .current_provider()
        .stream_messages(request())
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    assert_eq!(raw.calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn a_real_configuration_revision_change_does_not_inherit_the_original_authentication_block() {
    let root = tempfile::tempdir().unwrap();
    let raw = inner(2);
    let settings = settings();
    let selected = selection(&settings);
    let engine = TestEngineBuilder::new(root.path())
        .settings(settings)
        .provider(raw.clone())
        .build_with_profile_directory();
    let original = engine.active_model_configuration_summary().unwrap();
    assert!(
        engine
            .current_provider()
            .stream_messages(request())
            .is_err()
    );
    assert!(resolve_integration_model_selection(&engine, &selected).is_err());
    engine
        .settings
        .write()
        .unwrap()
        .providers
        .get_mut("A")
        .unwrap()
        .endpoint = "http://127.0.0.1:10/v1".into();
    let next = resolve_integration_model_selection(&engine, &selected).unwrap();
    assert_eq!(next.model.provider_id.as_deref(), Some("A"));
    assert_ne!(next.model.revision, original.revision);
    assert_eq!(
        engine.integration_model_health(&next.model).state,
        IntegrationModelHealthState::Unknown
    );
    assert_eq!(
        engine.integration_model_health(&original).state,
        IntegrationModelHealthState::NeedsConfiguration
    );
    assert_eq!(raw.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn cancelled_old_probe_releases_its_slot_without_erasing_configuration_failure() {
    let settings = settings();
    let model = crate::model_configuration_summary(
        &settings,
        kcoder_types::ModelConfigurationBoundary::NextTurn,
    )
    .unwrap();
    let tracker = Arc::new(ModelHealthTracker::default());
    tracker
        .begin(&model, false)
        .unwrap()
        .error(&ApiErrorKind::Api {
            error_type: "overloaded_error".into(),
            message: String::new(),
        });
    expire_cooldown(&tracker, &model);
    let old_probe = tracker.begin(&model, true).unwrap();
    tracker
        .begin(&model, false)
        .unwrap()
        .error(&configuration_error(401));
    drop(old_probe);
    tracker
        .begin(&model, false)
        .unwrap()
        .error(&ApiErrorKind::Api {
            error_type: "invalid_request_error".into(),
            message: String::new(),
        });
    let observed = tracker.observe(&model);
    assert_eq!(
        observed.state,
        IntegrationModelHealthState::NeedsConfiguration
    );
    assert_eq!(
        observed.failure.unwrap().category,
        ProviderFailureCategory::AuthenticationError
    );
    assert!(
        tracker
            .data
            .lock()
            .unwrap()
            .entries
            .get(&Key::from_model(&model))
            .unwrap()
            .probe
            .is_none()
    );
    assert_eq!(
        tracker.routing(&model).unwrap_err().to_string(),
        "MODEL_AUTO_CONFIGURATION_BLOCKED"
    );
}

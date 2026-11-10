//! Exercise the original Engine dispatch and observer, not a reconstructed receipt.
use super::*;

#[tokio::test]
async fn actual_observer_uses_canonical_model_snapshot_without_presentation_overlays() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, _, _) = inner(simple_text_events("done"), false, false);
    let (observer, stats, _) = make_observer(false, None);
    let engine = make_engine(temp.path(), provider)
        .with_native_model_request_observer(observer)
        .unwrap();
    let canonical = crate::model_configuration_summary(
        &crate::recover_read_lock(&engine.settings, "settings"),
        kcoder_types::ModelConfigurationBoundary::SessionSnapshot,
    )
    .unwrap();
    let displayed = engine.active_model_configuration_summary().unwrap();
    assert_eq!(canonical.revision, displayed.revision);
    assert_ne!(
        canonical, displayed,
        "Tool counts and source presentation must not become provider identity"
    );
    let mut stream = engine
        .current_provider()
        .stream_messages(request())
        .unwrap();
    while stream.next().await.is_some() {}
    assert_eq!(
        stats.configurations.lock().unwrap().as_slice(),
        [Some(canonical)]
    );
}

struct RetryOnce(AtomicUsize);
impl Provider for RetryOnce {
    fn name(&self) -> &'static str {
        "native-accounting-retry-once"
    }
    fn stream_messages(&self, _: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err(ApiErrorKind::Api {
                error_type: "overloaded_error".into(),
                message: "owned transient fixture".into(),
            });
        }
        Ok(Box::pin(futures::stream::iter(
            simple_text_events("done").into_iter().map(Ok),
        )))
    }
}

#[tokio::test]
async fn actual_retry_loop_marks_only_retries_and_resets_for_the_next_turn() {
    let temp = tempfile::tempdir().unwrap();
    let provider = Arc::new(RetryOnce(AtomicUsize::new(0)));
    let (observer, stats, _) = make_observer(false, None);
    let engine = make_engine(temp.path(), provider.clone())
        .with_native_model_request_observer(observer)
        .unwrap();
    for prompt in ["First owned request", "Second independent request"] {
        engine.state.add_message(Message::user_text(prompt));
        let mut stream = engine.run_turn_stream(&kcoder_permissions::AutoDenyPrompt);
        while let Some(event) = stream.next().await {
            assert!(!matches!(event, crate::EngineEvent::Error(_)), "{event:?}");
        }
    }
    assert_eq!(provider.0.load(Ordering::SeqCst), 3);
    assert_eq!(*stats.retry_attempts.lock().unwrap(), [0, 1, 0]);
    assert_eq!(stats.finishes.lock().unwrap().len(), 3);
    let ids = stats.ids.lock().unwrap();
    assert_eq!(
        ids.iter().collect::<std::collections::HashSet<_>>().len(),
        3
    );
}

#[tokio::test]
async fn verifier_and_memory_observer_keep_distinct_native_purposes_and_model_ids() {
    let temp = tempfile::tempdir().unwrap();
    let (provider, _, requests) = inner(simple_text_events("done"), false, false);
    let (observer, stats, _) = make_observer(false, None);
    let engine = make_engine(temp.path(), provider)
        .with_native_model_request_observer(observer)
        .unwrap();
    crate::recover_write_lock(&engine.settings, "settings")
        .memory
        .observer_model = Some("owned-observer-model".into());
    let observed = engine.current_provider_for_purpose(NativeModelRequestPurpose::MemoryObserver);
    let mut input = request();
    input.model = "owned-observer-model".into();
    let mut stream = observed.stream_messages(input).unwrap();
    while stream.next().await.is_some() {}
    let verifier =
        engine.with_verifier_vote_channel(Some(kcoder_tools::VerifierVoteChannel::default()));
    let mut stream = verifier
        .current_provider()
        .stream_messages(request())
        .unwrap();
    while stream.next().await.is_some() {}
    assert_eq!(
        *stats.purposes.lock().unwrap(),
        [
            NativeModelRequestPurpose::MemoryObserver,
            NativeModelRequestPurpose::Verifier
        ]
    );
    let configurations = stats.configurations.lock().unwrap();
    assert_eq!(
        configurations[0].as_ref().unwrap().model_id,
        "owned-observer-model"
    );
    assert_ne!(
        configurations[0].as_ref().unwrap().revision,
        configurations[1].as_ref().unwrap().revision
    );
    assert!(
        requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.get("retry_attempt").is_none())
    );
}

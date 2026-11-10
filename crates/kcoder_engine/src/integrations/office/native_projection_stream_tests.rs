//! Exercise the actual Engine assembly with a recording Provider, not a live model.
use super::*;
use crate::{EngineEvent, QueryEngine, test_support::engine_builder::TestEngineBuilder};
use futures::StreamExt;
use kcoder_config::Settings;
use kcoder_tools::ToolRegistry;
use tokio_util::sync::CancellationToken;

fn engine(root: &std::path::Path) -> (QueryEngine, Arc<Mutex<Vec<MessagesRequest>>>) {
    let _profile = kcoder_config::PrivateDirectory::open_existing(root)
        .unwrap()
        .open_child(std::ffi::OsStr::new("test-config"), true)
        .unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = TestEngineBuilder::new(root)
        .provider(Arc::new(
            crate::test_support::providers::RequestRecordingProvider {
                requests: requests.clone(),
            },
        ))
        .settings(Settings {
            context_window_tokens: Some(1_000_000),
            context_output_headroom: Some(10_000),
            max_tokens: Some(1024),
            ..Settings::default()
        })
        .tool_registry(ToolRegistry::new())
        .build_with_profile_directory();
    (engine, requests)
}

fn office_input(messages: &SharedMessages) -> Value {
    messages
        .iter()
        .find_map(|message| match message {
            Message::Assistant { content, .. } => content.iter().find_map(|block| match block {
                ContentBlock::ToolUse { name, input, .. } if name == "OfficeDocument" => {
                    Some(input.clone())
                }
                _ => None,
            }),
            _ => None,
        })
        .expect("the original Office call remains present")
}

struct SummaryCapture {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
    delegate: crate::test_support::providers::SummaryCountingProvider,
}
impl kcoder_api::Provider for SummaryCapture {
    fn name(&self) -> &'static str {
        "native-office-summary-fixture"
    }
    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.lock().unwrap().push(request.clone());
        self.delegate.stream_messages(request)
    }
}
fn use_summary_capture(engine: &QueryEngine, requests: Arc<Mutex<Vec<MessagesRequest>>>) {
    *engine.provider.write().unwrap() = Arc::new(SummaryCapture {
        requests,
        delegate: crate::test_support::providers::SummaryCountingProvider {
            requests: Arc::default(),
        },
    });
    let mut settings = engine.settings.write().unwrap();
    settings.summary_profile = None;
    settings.summary_provider = None;
    settings.summary_model = None;
    settings.session_memory.enabled = false;
    settings.session_memory.update_enabled = false;
}
fn later_turns(mut messages: Vec<Message>) -> Vec<Message> {
    for index in 0..5 {
        messages.push(Message::user_text(format!("Later user request {index}")));
        messages.push(Message::assistant_text(format!("Later result {index}")));
    }
    messages
}

#[tokio::test]
async fn full_compaction_projects_summary_requests_and_keeps_original_append_only_transcript() {
    let root = tempfile::tempdir().unwrap();
    let (base, requests) = engine(root.path());
    use_summary_capture(&base, requests.clone());
    let fixture = Fixture::for_session(&base.session_id());
    let history = root.path().join(format!("{}.jsonl", base.session_id()));
    base.state.with_history_path(&history);
    for message in later_turns(fixture.history.to_vec()) {
        base.state.add_message(message);
    }
    base.state.flush_history().await.unwrap();
    let engine = base
        .with_native_office_projection_authority(Arc::new(fixture.authority))
        .unwrap();
    let result = engine.compact_conversation().await.unwrap();
    assert!(result.did_compact);
    let captured = requests.lock().unwrap();
    assert!(!captured.is_empty());
    for request in captured.iter() {
        let encoded = serde_json::to_string(request).unwrap();
        assert!(encoded.contains("_storedOfficeGenerationSource"));
        assert!(!encoded.contains("Full canonical paragraph"));
    }
    assert!(
        std::fs::read_to_string(history)
            .unwrap()
            .contains("Full canonical paragraph")
    );
}

#[tokio::test]
async fn prefire_projects_only_its_model_view_and_matches_the_original_raw_prefix() {
    let root = tempfile::tempdir().unwrap();
    let (base, requests) = engine(root.path());
    use_summary_capture(&base, requests.clone());
    {
        let mut settings = base.settings.write().unwrap();
        settings.prefire_threshold_tokens = Some(1);
    }
    let fixture = Fixture::for_session(&base.session_id());
    let original = later_turns(fixture.history.to_vec());
    base.state.set_messages(original.clone());
    let engine = base
        .with_native_office_projection_authority(Arc::new(fixture.authority))
        .unwrap();
    assert!(!engine.maybe_compact_conversation(1).await);
    tokio::time::timeout(std::time::Duration::from_secs(8), async {
        loop {
            if engine.prefire_resource_registered() == Some(false) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(engine.state.messages(), original);
    let compacted = engine.compact_conversation().await.unwrap();
    assert!(
        compacted.used_prefire,
        "the note must still match the original raw prefix"
    );
    let captured = requests.lock().unwrap();
    assert_eq!(captured.len(), 1);
    let encoded = serde_json::to_string(&captured[0]).unwrap();
    assert!(encoded.contains("_storedOfficeGenerationSource"));
    assert!(!encoded.contains("Full canonical paragraph"));
}

#[tokio::test]
async fn archived_large_office_arguments_do_not_trigger_compaction_when_the_request_view_fits() {
    let root = tempfile::tempdir().unwrap();
    let (base, requests) = engine(root.path());
    use_summary_capture(&base, requests.clone());
    {
        let mut settings = base.settings.write().unwrap();
        settings.context_window_tokens = Some(10_000);
        settings.context_output_headroom = Some(1_000);
        settings.context_system_tokens = Some(0);
        settings.context_tools_tokens = Some(0);
    }
    let fixture = Fixture::for_session(&base.session_id());
    base.state.set_messages(fixture.history.to_vec());
    let engine = base
        .with_native_office_projection_authority(Arc::new(fixture.authority))
        .unwrap();
    assert!(serde_json::to_vec(&fixture.input).unwrap().len() > 40_000);
    assert!(!engine.maybe_compact_conversation(1).await);
    assert!(requests.lock().unwrap().is_empty());
    assert_eq!(
        office_input(&engine.state.shared_messages_with_revision().0),
        fixture.input
    );
}

#[tokio::test]
async fn actual_engine_projects_only_request_payload_and_keeps_state_and_prefix_on_repeat() {
    let root = tempfile::tempdir().unwrap();
    let (base, requests) = engine(root.path());
    let fixture = Fixture::for_session(&base.session_id());
    base.state.set_messages(fixture.history.to_vec());
    let engine = base
        .with_native_office_projection_authority(Arc::new(fixture.authority))
        .unwrap();
    for _ in 0..2 {
        let events = engine
            .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
            .collect::<Vec<_>>()
            .await;
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, EngineEvent::Error(_))),
            "{events:?}"
        );
        assert_eq!(
            office_input(&engine.state.shared_messages_with_revision().0),
            fixture.input
        );
    }
    let captured = requests.lock().unwrap();
    assert_eq!(captured.len(), 2);
    for request in captured.iter() {
        let input = office_input(&request.messages);
        assert!(serde_json::to_vec(&input).unwrap().len() < 4096);
        assert!(input.get("_storedOfficeGenerationSource").is_some());
        assert!(
            !serde_json::to_string(request)
                .unwrap()
                .contains("Full canonical paragraph")
        );
    }
    assert_eq!(captured[0].system, captured[1].system);
    assert_eq!(
        serde_json::to_value(&captured[0].tools).unwrap(),
        serde_json::to_value(&captured[1].tools).unwrap()
    );
}

#[tokio::test]
async fn actual_engine_without_native_authority_preserves_the_original_input() {
    let root = tempfile::tempdir().unwrap();
    let (engine, requests) = engine(root.path());
    let fixture = Fixture::for_session(&engine.session_id());
    engine.state.set_messages(fixture.history.to_vec());
    let events = engine
        .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
        .collect::<Vec<_>>()
        .await;
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::Error(_))),
        "{events:?}"
    );
    let captured = requests.lock().unwrap();
    assert_eq!(captured.len(), 1);
    assert_eq!(office_input(&captured[0].messages), fixture.input);
}

#[tokio::test]
async fn actual_engine_denied_projection_dispatches_no_provider_request() {
    let root = tempfile::tempdir().unwrap();
    let (base, requests) = engine(root.path());
    let fixture = Fixture::for_session(&base.session_id());
    fixture.authority.denied.store(true, Ordering::SeqCst);
    base.state.set_messages(fixture.history.to_vec());
    let engine = base
        .with_native_office_projection_authority(Arc::new(fixture.authority))
        .unwrap();
    let events = engine
        .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
        .collect::<Vec<_>>()
        .await;
    assert!(events.iter().any(|event| matches!(event, EngineEvent::Error(code) if code == "NATIVE_OFFICE_PROJECTION_UNAVAILABLE")));
    assert!(requests.lock().unwrap().is_empty());
    assert_eq!(
        office_input(&engine.state.shared_messages_with_revision().0),
        fixture.input
    );
}

#[tokio::test]
async fn session_memory_maintenance_projects_office_history_before_serializing_the_summary_prompt()
{
    let root = tempfile::tempdir().unwrap();
    let (base, requests) = engine(root.path());
    let fixture = Fixture::for_session(&base.session_id());
    base.state.set_messages(fixture.history.to_vec());
    {
        let mut settings = base.settings.write().unwrap();
        settings.summary_profile = None;
        settings.summary_provider = None;
        settings.summary_model = None;
        settings.session_memory.init_min_tokens = 0;
        settings.session_memory.update_min_token_delta = 0;
    }
    let engine = base
        .with_native_office_projection_authority(Arc::new(fixture.authority))
        .unwrap();
    let original = engine.state.shared_messages_with_revision().0;
    // The controlled recorder returns plain "ok", not a validated memory note.
    // Its failure after dispatch does not weaken the request-boundary assertions.
    engine.maybe_spawn_session_memory_update(1, &[]);
    tokio::time::timeout(
        std::time::Duration::from_secs(8),
        engine.wait_for_session_memory_update_before_compact(),
    )
    .await
    .unwrap();
    let handle = engine.session_memory_update_handle.lock().unwrap().take();
    if let Some(handle) = handle {
        handle.await.unwrap();
    }
    let captured = requests.lock().unwrap();
    assert_eq!(captured.len(), 1);
    let serialized = serde_json::to_string(&captured[0]).unwrap();
    assert!(serialized.contains("_storedOfficeGenerationSource"));
    assert!(!serialized.contains("Full canonical paragraph"));
    assert!(serialized.len() < 16 * 1024);
    assert_eq!(engine.state.shared_messages_with_revision().0, original);
}

struct PendingAuthority(Arc<tokio::sync::Notify>);
#[async_trait]
impl NativeOfficeToolProjectionAuthority for PendingAuthority {
    async fn resolve(
        &self,
        _: &NativeOfficeToolProjectionRequest<'_>,
    ) -> Result<Option<NativeOfficeToolProjection>> {
        self.0.notify_one();
        std::future::pending().await
    }
}

#[tokio::test]
async fn cancellation_during_native_projection_stops_without_provider_or_history_rewrite() {
    let root = tempfile::tempdir().unwrap();
    let (base, requests) = engine(root.path());
    let fixture = Fixture::for_session(&base.session_id());
    base.state.set_messages(fixture.history.to_vec());
    let entered = Arc::new(tokio::sync::Notify::new());
    let engine = base
        .with_native_office_projection_authority(Arc::new(PendingAuthority(entered.clone())))
        .unwrap();
    let cancel = CancellationToken::new();
    let task_engine = engine.clone();
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        task_engine
            .run_turn_stream_with_cancel(&kcoder_permissions::AutoAllowPrompt, task_cancel)
            .collect::<Vec<_>>()
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), entered.notified())
        .await
        .unwrap();
    cancel.cancel();
    let events = tokio::time::timeout(std::time::Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap();
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::StreamAborted { .. }))
    );
    assert!(requests.lock().unwrap().is_empty());
    assert_eq!(
        office_input(&engine.state.shared_messages_with_revision().0),
        fixture.input
    );
}

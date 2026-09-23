use super::*;
use crate::test_support::engine_builder::{TestEngineBuilder, settings_using_main_summary_runtime};
use crate::test_support::providers::{EmptyProvider, SummaryCountingProvider};
use kcoder_config::Settings;
use kcoder_memory::{MemoryManager, MemoryStore};
use std::path::Path;
use std::sync::atomic::AtomicUsize;

#[path = "../tests/internal_provider_failure_fixture.rs"]
mod internal_failure_fixture;

#[tokio::test]
async fn internal_provider_failure_session_end_retains_source_and_falls_back() {
    for boundary in 0..3 {
        let tmp = tempfile::tempdir().unwrap();
        let provider = Arc::new(internal_failure_fixture::FailureProvider::new(boundary));
        let memory = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
            kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
            "project-a",
        );
        let engine = test_engine_with_memory_manager(
            provider.clone(),
            tmp.path(),
            settings_using_main_summary_runtime(Settings::default()),
            memory,
        );
        let messages = vec![
            Message::user_text("retain this request"),
            Message::assistant_text("retain this response"),
        ];
        engine.state.set_messages(messages.clone());
        let error = engine
            .generate_session_end_summary("success", &messages, "test", 100, provider.clone())
            .await
            .unwrap_err();
        internal_failure_fixture::assert_source(&error, boundary);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        engine.run_session_end_hooks("success").await;
        assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
        let summaries = engine
            .memory_manager
            .structured_summaries_for_session(&engine.session_id(), 10)
            .unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0].learned.as_deref(),
            Some(deterministic_session_end_summary("success", &messages).as_str())
        );
    }
}

fn test_engine_with_memory_manager(
    provider: Arc<dyn Provider>,
    cwd: &Path,
    settings: Settings,
    memory_manager: MemoryManager,
) -> QueryEngine {
    TestEngineBuilder::new(cwd)
        .provider(provider)
        .settings(settings)
        .memory_manager(memory_manager)
        .build()
}

#[tokio::test]
async fn session_end_records_structured_summary_and_marks_session_ended() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let engine = test_engine_with_memory_manager(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
        memory_manager,
    );
    engine.state.set_messages(vec![
        Message::user_text("finish the memory system"),
        Message::assistant_text("implemented session-end summary"),
    ]);

    engine.run_session_end_hooks("success").await;
    engine.run_session_end_hooks("success").await;

    assert_eq!(requests.load(Ordering::SeqCst), 1);
    let summaries = engine
        .memory_manager
        .structured_summaries_for_session(&engine.session_id(), 10)
        .unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].project_key, "project-a");
    assert_eq!(summaries[0].request.as_deref(), Some("session end"));
    assert_eq!(
        summaries[0].learned.as_deref(),
        Some("auto compact summary")
    );
    assert!(
        summaries[0]
            .completed
            .as_deref()
            .unwrap_or_default()
            .contains("success")
    );
    let sources = engine
        .memory_manager
        .structured_sources_for_memory("summary", summaries[0].id)
        .unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].source_type, "session_end");
    assert_eq!(
        sources[0].source_ref.as_deref(),
        Some(engine.session_id().as_str())
    );
    assert!(
        sources[0]
            .metadata_json
            .contains("\"exit_reason\":\"success\"")
    );
    assert!(sources[0].metadata_json.contains("\"summary_model\""));

    let session = engine
        .memory_manager
        .get_structured_session(&engine.session_id())
        .unwrap()
        .unwrap();
    assert_eq!(session.status, "ended");
    assert!(session.ended_at_epoch.is_some());
}

#[tokio::test]
async fn training_mode_ends_session_without_a_summary_model_request() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.training_mode = true;
    let engine = test_engine_with_memory_manager(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
        memory_manager,
    );
    engine.state.set_messages(vec![
        Message::user_text("finish the training sample"),
        Message::assistant_text("done"),
    ]);

    engine.run_session_end_hooks("success").await;

    assert_eq!(requests.load(Ordering::SeqCst), 0);
    assert!(
        engine
            .memory_manager
            .structured_summaries_for_session(&engine.session_id(), 10)
            .unwrap()
            .is_empty()
    );
    let session = engine
        .memory_manager
        .get_structured_session(&engine.session_id())
        .unwrap()
        .unwrap();
    assert_eq!(session.status, "ended");
}

#[tokio::test]
async fn session_end_summary_falls_back_when_model_returns_empty_text() {
    let tmp = tempfile::tempdir().unwrap();
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let engine = test_engine_with_memory_manager(
        Arc::new(EmptyProvider),
        tmp.path(),
        Settings::default(),
        memory_manager,
    );
    engine.state.set_messages(vec![
        Message::user_text("capture a final summary"),
        Message::assistant_text("done"),
    ]);

    engine.run_session_end_hooks("ctrl-c").await;

    let summaries = engine
        .memory_manager
        .structured_summaries_for_session(&engine.session_id(), 10)
        .unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].request.as_deref(), Some("session end"));
    assert!(
        summaries[0]
            .learned
            .as_deref()
            .unwrap_or_default()
            .contains("Last user request: capture a final summary")
    );
    let sources = engine
        .memory_manager
        .structured_sources_for_memory("summary", summaries[0].id)
        .unwrap();
    assert_eq!(sources[0].source_type, "session_end");
    assert!(sources[0].metadata_json.contains("fallback_reason"));
}

#[tokio::test]
async fn failed_session_end_uses_failed_structured_status() {
    let tmp = tempfile::tempdir().unwrap();
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let engine = test_engine_with_memory_manager(
        Arc::new(EmptyProvider),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
        memory_manager,
    );
    engine
        .state
        .set_messages(vec![Message::user_text("failed request")]);

    engine
        .run_session_end_hooks("error: stream incomplete")
        .await;

    let session = engine
        .memory_manager
        .get_structured_session(&engine.session_id())
        .unwrap()
        .unwrap();
    assert_eq!(session.status, "failed");
    let summaries = engine
        .memory_manager
        .structured_summaries_for_session(&engine.session_id(), 10)
        .unwrap();
    let sources = engine
        .memory_manager
        .structured_sources_for_memory("summary", summaries[0].id)
        .unwrap();
    assert!(
        sources[0]
            .metadata_json
            .contains(r#""exit_reason":"error: stream incomplete""#)
    );
}

#[tokio::test]
async fn cancelled_session_end_uses_cancelled_structured_status() {
    let tmp = tempfile::tempdir().unwrap();
    let memory_manager = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory().unwrap(),
        "project-a",
    );
    let engine = test_engine_with_memory_manager(
        Arc::new(EmptyProvider),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
        memory_manager,
    );

    engine.run_session_end_hooks("cancelled by user").await;

    let session = engine
        .memory_manager
        .get_structured_session(&engine.session_id())
        .unwrap()
        .unwrap();
    assert_eq!(session.status, "cancelled");
}

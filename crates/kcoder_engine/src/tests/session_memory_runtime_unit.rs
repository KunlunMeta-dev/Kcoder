use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

use super::*;
use crate::test_support::engine_builder::{TestEngineBuilder, settings_using_main_summary_runtime};
use kcoder_api::Provider;
use kcoder_config::Settings;

#[path = "internal_provider_failure_fixture.rs"]
mod internal_failure_fixture;

#[tokio::test]
async fn internal_provider_failure_session_memory_retains_source_without_retry() {
    for boundary in 0..3 {
        let tmp = tempfile::tempdir().unwrap();
        let provider = Arc::new(internal_failure_fixture::FailureProvider::new(boundary));
        let mut settings = settings_using_main_summary_runtime(Settings::default());
        settings.session_memory.init_min_tokens = 1;
        let engine = test_engine_with_settings(provider.clone(), tmp.path(), settings);
        engine.state.set_messages(vec![
            Message::user_text("remember this"),
            Message::assistant_text("done"),
        ]);
        let job = engine.prepare_session_memory_update(1, &[]).unwrap();
        let error = engine.run_session_memory_update_job(job).await.unwrap_err();
        internal_failure_fixture::assert_source(&error, boundary);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    }
}

fn test_engine_with_settings(
    provider: Arc<dyn Provider>,
    cwd: &Path,
    settings: Settings,
) -> QueryEngine {
    TestEngineBuilder::new(cwd)
        .provider(provider)
        .settings(settings)
        .build()
}

#[test]
fn training_mode_blocks_session_memory_even_if_nested_settings_are_enabled() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = Settings {
        training_mode: true,
        ..Settings::default()
    };
    settings.session_memory.enabled = true;
    settings.session_memory.update_enabled = true;
    settings.session_memory.init_min_tokens = 1;
    let engine = test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), settings);
    engine.state.set_messages(vec![
        Message::user_text("train without maintenance calls"),
        Message::assistant_text("done"),
    ]);

    assert!(engine.prepare_session_memory_update(1, &[]).is_none());
}

use crate::test_support::providers::{EmptyProvider, StaticTextProvider, SummaryCountingProvider};

#[tokio::test]
async fn admission_queued_memory_does_not_start_provider_or_capture() {
    let tmp = tempfile::tempdir().unwrap();
    let started = Arc::new(AtomicBool::new(false));
    let provider: Arc<dyn Provider> = Arc::new(SessionMemoryHangingProvider {
        session_memory_started: started.clone(),
        session_memory_dropped: Arc::new(AtomicBool::new(false)),
    });
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.session_memory.init_min_tokens = 1;
    let engine = test_engine_with_settings(provider.clone(), tmp.path(), settings);
    engine
        .state
        .set_usage_history_root(Some(&tmp.path().join("usage")));
    engine.state.set_messages(vec![
        Message::user_text("remember this"),
        Message::assistant_text("done"),
    ]);
    let job = engine.prepare_session_memory_update(1, &[]).unwrap();
    assert!(Arc::ptr_eq(&provider, &job.summary_provider));
    let foreground = crate::request_admission::acquire(
        &provider,
        crate::request_admission::RequestClass::Foreground,
    )
    .await
    .unwrap();
    let mut update = Box::pin(engine.run_session_memory_update_job(job));
    assert!(futures::poll!(update.as_mut()).is_pending());
    assert!(
        !started.load(Ordering::SeqCst),
        "queued maintenance must not call Provider"
    );
    assert_eq!(engine.state.diagnostic_writer().stats().pending_attempts, 0);
    drop(update);
    assert!(
        kcoder_state::usage_history::read_usage(&tmp.path().join("usage"))
            .unwrap()
            .is_none(),
        "queue cancellation must not create an attempt"
    );
    drop(foreground);
    let job = engine.prepare_session_memory_update(1, &[]).unwrap();
    let mut update = Box::pin(engine.run_session_memory_update_job(job));
    assert!(futures::poll!(update.as_mut()).is_pending());
    assert!(started.load(Ordering::SeqCst));
}

#[tokio::test]
async fn admission_full_queue_skips_memory_without_capture() {
    use crate::request_admission::{RequestClass, acquire};
    let tmp = tempfile::tempdir().unwrap();
    let provider: Arc<dyn Provider> = Arc::new(EmptyProvider);
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.session_memory.init_min_tokens = 1;
    let engine = test_engine_with_settings(provider.clone(), tmp.path(), settings);
    engine.state.set_messages(vec![
        Message::user_text("remember this"),
        Message::assistant_text("done"),
    ]);
    let _foreground = acquire(&provider, RequestClass::Foreground).await.unwrap();
    let mut queued = Vec::new();
    for _ in 0..32 {
        let mut future = Box::pin(acquire(&provider, RequestClass::SkillReview));
        assert!(futures::poll!(future.as_mut()).is_pending());
        queued.push(future);
    }
    let job = engine.prepare_session_memory_update(1, &[]).unwrap();
    assert!(
        matches!(engine.run_session_memory_update_job(job).await.unwrap(), SessionMemoryUpdateOutcome::Skipped(reason) if reason.contains("full"))
    );
    assert_eq!(engine.state.diagnostic_writer().stats().pending_attempts, 0);
}

#[derive(Debug)]
struct SessionMemoryHangingProvider {
    session_memory_started: Arc<AtomicBool>,
    session_memory_dropped: Arc<AtomicBool>,
}

struct SessionMemoryDropFlag(Arc<AtomicBool>);

impl Drop for SessionMemoryDropFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

impl Provider for SessionMemoryHangingProvider {
    fn name(&self) -> &'static str {
        "session-memory-hanging"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let is_session_memory_update = request
            .messages
            .first()
            .map(|message| {
                message
                    .preview(20_000)
                    .contains("internal session-memory maintenance task")
            })
            .unwrap_or(false);
        if is_session_memory_update {
            self.session_memory_started.store(true, Ordering::SeqCst);
            let dropped = SessionMemoryDropFlag(Arc::clone(&self.session_memory_dropped));
            let stream = async_stream::stream! {
                let _dropped = dropped;
                yield Ok(StreamEvent::MessageDelta {
                    delta: kcoder_types::MessageDeltaFields {
                        stop_reason: None,
                        stop_sequence: None,
                        usage: Some(Usage {
                            input_tokens: 29,
                            output_tokens: 7,
                            cache_creation_input_tokens: None,
                            cache_read_input_tokens: None,
                            total_tokens: None,
                            iterations: None,
                        }),
                    },
                });
                std::future::pending::<()>().await;
                yield Ok(StreamEvent::MessageStop);
            };
            return Ok(Box::pin(stream));
        }

        let stream = async_stream::stream! {
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: "main response complete".to_string(),
                },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[tokio::test]
async fn diagnostic_session_memory_outer_abort_preserves_observed_usage_once() {
    let tmp = tempfile::tempdir().unwrap();
    let started = Arc::new(AtomicBool::new(false));
    let dropped = Arc::new(AtomicBool::new(false));
    let provider = Arc::new(SessionMemoryHangingProvider {
        session_memory_started: started.clone(),
        session_memory_dropped: dropped.clone(),
    });
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.session_memory.init_min_tokens = 1;
    let engine = test_engine_with_settings(provider, tmp.path(), settings);
    engine
        .state
        .set_usage_history_root(Some(&tmp.path().join("usage")));
    engine
        .state
        .with_history_path(tmp.path().join("session.jsonl"));
    engine.state.set_messages(vec![
        Message::user_text("remember this"),
        Message::assistant_text("done"),
    ]);
    let job = engine.prepare_session_memory_update(1, &[]).unwrap();
    let worker_engine = engine.clone();
    let handle =
        tokio::spawn(async move { worker_engine.run_session_memory_update_job(job).await });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !started.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
        tokio::task::yield_now().await;
    })
    .await
    .unwrap();
    handle.abort();
    assert!(handle.await.unwrap_err().is_cancelled());
    assert!(dropped.load(Ordering::SeqCst));
    let usage = kcoder_state::usage_history::read_usage(&tmp.path().join("usage"))
        .unwrap()
        .expect("aborted session memory must preserve usage");
    let counters = usage.days.values().next().unwrap().values().next().unwrap();
    assert_eq!(counters.requests, 1);
    assert_eq!(counters.input_tokens, 29);
    assert_eq!(counters.output_tokens, 7);
    assert!(
        engine
            .state
            .flush_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
            .await
    );
}

#[derive(Debug)]
struct SessionMemoryBlockingProvider {
    session_memory_started: Arc<AtomicBool>,
    release_session_memory: Arc<Notify>,
    session_memory_requests: Arc<AtomicUsize>,
    fallback_requests: Arc<AtomicUsize>,
    session_memory_text: String,
}

async fn maybe_update_session_memory(
    engine: &QueryEngine,
    turn_count: usize,
    recent_tools: &[String],
) {
    let Some(job) = engine.prepare_session_memory_update(turn_count, recent_tools) else {
        return;
    };
    match engine.run_session_memory_update_job(job).await {
        Ok(SessionMemoryUpdateOutcome::Updated) | Ok(SessionMemoryUpdateOutcome::Skipped(_)) => {}
        Err(error) => warn!("session-memory update failed: {}", error),
    }
}

impl Provider for SessionMemoryBlockingProvider {
    fn name(&self) -> &'static str {
        "session-memory-blocking"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let is_session_memory_update = request
            .messages
            .first()
            .map(|message| {
                message
                    .preview(20_000)
                    .contains("internal session-memory maintenance task")
            })
            .unwrap_or(false);
        if is_session_memory_update {
            self.session_memory_requests.fetch_add(1, Ordering::SeqCst);
            self.session_memory_started.store(true, Ordering::SeqCst);
            let release_session_memory = Arc::clone(&self.release_session_memory);
            let session_memory_text = self.session_memory_text.clone();
            let stream = async_stream::stream! {
                release_session_memory.notified().await;
                yield Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta {
                        text: session_memory_text,
                    },
                });
                yield Ok(StreamEvent::MessageStop);
            };
            return Ok(Box::pin(stream));
        }

        self.fallback_requests.fetch_add(1, Ordering::SeqCst);
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: "<summary>fallback compact summary</summary>".to_string(),
                },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[tokio::test]
async fn session_memory_update_writes_markdown_summary_file() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let updated_memory = DEFAULT_SESSION_MEMORY_TEMPLATE
        .replace("# Current State", "# Current State\n\nUpdated memory");
    let provider = Arc::new(StaticTextProvider {
        requests: Arc::clone(&requests),
        text: format!(
            "<analysis>scratch</analysis><session_memory>{updated_memory}</session_memory>"
        ),
    });
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.session_memory.update_max_tokens = 777;
    settings.summary_max_tokens = 500;
    settings.session_memory.init_min_tokens = 1;
    let engine = test_engine_with_settings(provider, tmp.path(), settings);
    let history_path = tmp.path().join("session.jsonl");
    engine.state.with_history_path(&history_path);
    engine
        .state
        .add_message(Message::user_text("please remember alpha"));
    engine
        .state
        .add_message(Message::assistant_text("alpha completed"));

    maybe_update_session_memory(&engine, 1, &[]).await;

    let snapshot = engine
        .state
        .session_memory()
        .expect("session memory metadata should be stored");
    let content = std::fs::read_to_string(&snapshot.summary_path).unwrap();
    assert!(content.contains("Updated memory"));
    assert_eq!(snapshot.update_count, 1);
    assert_eq!(snapshot.source, format!("model:{}", engine.model_name()));
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].max_tokens, 500);
    assert!(
        requests[0].messages[0]
            .preview(20_000)
            .contains("<current_notes_content>")
    );
    drop(requests);

    assert!(
        engine
            .state
            .flush_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
            .await
    );
    let llm_dir = engine
        .state
        .session_memory_llm_request_history_dir()
        .expect("session-memory LLM history dir should be configured");
    assert_eq!(
        llm_dir,
        tmp.path()
            .join("session")
            .join("llm-requests")
            .join("session-memory")
    );
    let mut files = std::fs::read_dir(&llm_dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    files.sort();
    assert_eq!(
        files.len(),
        1,
        "session-memory raw exchange should be isolated in {:?}",
        llm_dir
    );
    let record: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&files[0]).unwrap()).unwrap();
    let model_name = engine.model_name();
    let debug_session_id = engine.state.session_id();
    assert_eq!(record["schema"], "kcoder.llm_exchange.v2");
    assert_eq!(record["session_id"], "session");
    assert_eq!(
        record["request"]["model"].as_str(),
        Some(model_name.as_str())
    );
    assert_eq!(record["request"]["max_tokens"].as_u64(), Some(500));
    assert_eq!(
        record["request_metadata"]["debug_session_id"].as_str(),
        Some(debug_session_id.as_str())
    );
    assert!(
        record["request"]["messages"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("<current_notes_content>")
    );
    assert_eq!(
        record["response"]["events"][0]["type"].as_str(),
        Some("content_block_delta")
    );
    let expected_response_text =
        format!("<analysis>scratch</analysis><session_memory>{updated_memory}</session_memory>");
    assert_eq!(
        record["response"]["events"][0]["delta"]["text"].as_str(),
        Some(expected_response_text.as_str())
    );
    assert_eq!(
        record["response"]["events"][1]["type"].as_str(),
        Some("message_stop")
    );
    assert!(record["response"].get("error").is_none());
}

#[tokio::test]
async fn session_memory_update_does_not_block_turn_completion() {
    let tmp = tempfile::tempdir().unwrap();
    let session_memory_started = Arc::new(AtomicBool::new(false));
    let session_memory_dropped = Arc::new(AtomicBool::new(false));
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.auto_memory_enabled = false;
    settings.auto_tool_memory_enabled = false;
    settings.session_memory.init_min_tokens = 1;
    settings.session_memory.update_min_token_delta = 1;
    let engine = test_engine_with_settings(
        Arc::new(SessionMemoryHangingProvider {
            session_memory_started: Arc::clone(&session_memory_started),
            session_memory_dropped: Arc::clone(&session_memory_dropped),
        }),
        tmp.path(),
        settings,
    );
    engine
        .state
        .add_message(Message::user_text("please remember this without blocking"));

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream(&prompt);
    timeout(Duration::from_secs(1), async {
        while stream.next().await.is_some() {}
    })
    .await
    .expect("turn should finish without waiting for session-memory update");

    timeout(Duration::from_secs(1), async {
        while !session_memory_started.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("background session-memory update should have been scheduled");
    assert!(
        engine.state.session_memory().is_none(),
        "hanging background update must not have synchronously written a snapshot"
    );
    engine.start_new_session().unwrap();
    timeout(Duration::from_secs(1), async {
        while !session_memory_dropped.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("session replacement should abort the old memory request");
    assert!(!engine.session_memory_update_running.load(Ordering::SeqCst));
}

#[tokio::test]
async fn session_memory_compaction_waits_for_running_update() {
    let tmp = tempfile::tempdir().unwrap();
    let session_memory_started = Arc::new(AtomicBool::new(false));
    let release_session_memory = Arc::new(Notify::new());
    let session_memory_requests = Arc::new(AtomicUsize::new(0));
    let fallback_requests = Arc::new(AtomicUsize::new(0));
    let memory_marker = "WAITED_FOR_BACKGROUND_SESSION_MEMORY";
    let old_marker = "RUNNING_UPDATE_OLD_RAW_MARKER";
    let updated_memory = DEFAULT_SESSION_MEMORY_TEMPLATE.replace(
        "# Current State",
        &format!("# Current State\n\n{memory_marker}: old work is captured."),
    );
    let provider = Arc::new(SessionMemoryBlockingProvider {
        session_memory_started: Arc::clone(&session_memory_started),
        release_session_memory: Arc::clone(&release_session_memory),
        session_memory_requests: Arc::clone(&session_memory_requests),
        fallback_requests: Arc::clone(&fallback_requests),
        session_memory_text: format!("<session_memory>{updated_memory}</session_memory>"),
    });
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.context_window_tokens = Some(12_000);
    settings.context_system_tokens = Some(0);
    settings.context_tools_tokens = Some(0);
    settings.context_output_headroom = Some(0);
    settings.session_memory.init_min_tokens = 1;
    settings.session_memory.update_min_token_delta = 1;
    settings.session_memory.compact_min_chars = 5;
    settings.session_memory.compact_min_recent_tokens = 1;
    settings.session_memory.compact_max_recent_tokens = 200;
    settings.session_memory.compact_min_recent_messages = 2;
    let engine = test_engine_with_settings(provider, tmp.path(), settings);
    engine.state.set_messages(vec![
        Message::user_text(format!(
            "{old_marker} user request {}",
            "old context ".repeat(3000)
        )),
        Message::assistant_text(format!(
            "{old_marker} assistant response {}",
            "old response ".repeat(3000)
        )),
        Message::user_text("recent beta request"),
        Message::assistant_text("recent beta response"),
    ]);

    engine.maybe_spawn_session_memory_update(1, &[]);
    timeout(Duration::from_secs(1), async {
        while !session_memory_started.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("background session-memory update should start");

    let compact_engine = engine.clone();
    let compact_task = tokio::spawn(async move { compact_engine.perform_compaction(true).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !compact_task.is_finished(),
        "compact should wait briefly for the running session-memory update"
    );

    release_session_memory.notify_waiters();
    let result = timeout(Duration::from_secs(2), compact_task)
        .await
        .expect("compact should finish after session-memory update completes")
        .expect("compact task should not panic")
        .expect("compact should succeed");

    assert!(result.did_compact);
    assert_eq!(
        session_memory_requests.load(Ordering::SeqCst),
        1,
        "only the running background session-memory update should be issued"
    );
    assert_eq!(
        fallback_requests.load(Ordering::SeqCst),
        0,
        "compact should consume the refreshed session-memory file instead of fallback summary model"
    );
    let model_visible = messages_after_latest_compact_boundary(&engine.state.messages());
    let visible_text = model_visible
        .iter()
        .map(|message| message.preview(20_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(visible_text.contains(memory_marker));
    assert!(!visible_text.contains(old_marker));
}

#[tokio::test]
async fn session_memory_compact_wait_times_out_without_blocking_forever() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(
        Arc::new(EmptyProvider),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );
    engine
        .session_memory_update_running
        .store(true, Ordering::SeqCst);
    engine.mark_session_memory_update_started();

    let outcome = engine
        .wait_for_session_memory_update_before_compact_with_limits(
            Duration::from_millis(20),
            Duration::from_secs(60),
        )
        .await;
    engine.mark_session_memory_update_finished();

    assert_eq!(outcome, SessionMemoryWaitOutcome::TimedOut);
}

#[tokio::test]
async fn session_memory_compact_skips_waiting_for_stale_update() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine_with_settings(
        Arc::new(EmptyProvider),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );
    engine
        .session_memory_update_running
        .store(true, Ordering::SeqCst);
    {
        let mut started_at = engine
            .session_memory_update_started_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *started_at = Some(Instant::now() - Duration::from_millis(50));
    }

    let outcome = engine
        .wait_for_session_memory_update_before_compact_with_limits(
            Duration::from_secs(60),
            Duration::from_millis(10),
        )
        .await;
    engine.mark_session_memory_update_finished();

    assert_eq!(outcome, SessionMemoryWaitOutcome::Stale);
}

#[tokio::test]
async fn session_memory_update_rejects_overlapping_refreshes() {
    let tmp = tempfile::tempdir().unwrap();
    let session_memory_started = Arc::new(AtomicBool::new(false));
    let release_session_memory = Arc::new(Notify::new());
    let session_memory_requests = Arc::new(AtomicUsize::new(0));
    let fallback_requests = Arc::new(AtomicUsize::new(0));
    let updated_memory = DEFAULT_SESSION_MEMORY_TEMPLATE.replace(
        "# Current State",
        "# Current State\n\nOverlapping update should be ignored.",
    );
    let provider = Arc::new(SessionMemoryBlockingProvider {
        session_memory_started: Arc::clone(&session_memory_started),
        release_session_memory: Arc::clone(&release_session_memory),
        session_memory_requests: Arc::clone(&session_memory_requests),
        fallback_requests,
        session_memory_text: format!("<session_memory>{updated_memory}</session_memory>"),
    });
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.session_memory.init_min_tokens = 1;
    settings.session_memory.update_min_token_delta = 1;
    let engine = test_engine_with_settings(provider, tmp.path(), settings);
    engine
        .state
        .add_message(Message::user_text("trigger session memory update"));

    engine.maybe_spawn_session_memory_update(1, &[]);
    timeout(Duration::from_secs(1), async {
        while !session_memory_started.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("first session-memory update should start");

    engine.maybe_spawn_session_memory_update(1, &[]);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        session_memory_requests.load(Ordering::SeqCst),
        1,
        "overlapping session-memory refresh should be rejected while one is running"
    );

    release_session_memory.notify_waiters();
    timeout(Duration::from_secs(1), async {
        while engine.session_memory_update_running.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("first session-memory update should finish");
    assert_eq!(session_memory_requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn session_memory_update_only_advances_sent_message_boundary() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let updated_memory = DEFAULT_SESSION_MEMORY_TEMPLATE
        .replace("# Current State", "# Current State\n\nBatch updated memory");
    let provider = Arc::new(StaticTextProvider {
        requests: Arc::clone(&requests),
        text: format!("<session_memory>{updated_memory}</session_memory>"),
    });
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.session_memory.init_min_tokens = 1;
    settings.session_memory.max_update_messages = 2;
    let engine = test_engine_with_settings(provider, tmp.path(), settings);
    engine.state.set_messages(vec![
        Message::user_text("message 0"),
        Message::assistant_text("message 1"),
        Message::user_text("message 2"),
        Message::assistant_text("message 3"),
    ]);

    maybe_update_session_memory(&engine, 1, &[]).await;
    assert_eq!(
        engine.state.session_memory().unwrap().updated_message_count,
        2
    );
    assert!(
        requests.lock().unwrap()[0].messages[0]
            .preview(20_000)
            .contains("message 0")
    );
    assert!(
        !requests.lock().unwrap()[0].messages[0]
            .preview(20_000)
            .contains("message 2")
    );

    maybe_update_session_memory(&engine, 2, &[]).await;
    let caught_up = engine.state.session_memory().unwrap();
    assert_eq!(caught_up.updated_message_count, 4);
    assert!(!caught_up.pending_update_backlog);
    assert_eq!(requests.lock().unwrap().len(), 2);
    assert!(
        requests.lock().unwrap()[1].messages[0]
            .preview(20_000)
            .contains("message 2")
    );

    engine
        .state
        .add_message(Message::user_text("small new message"));
    maybe_update_session_memory(&engine, 3, &[]).await;
    assert_eq!(requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn session_memory_compaction_prefers_summary_file_without_model_call() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.session_memory.compact_min_chars = 5;
    settings.session_memory.compact_min_recent_tokens = 1;
    settings.session_memory.compact_max_recent_tokens = 200;
    settings.session_memory.compact_min_recent_messages = 2;
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    let summary_path =
        kcoder_state::session_memory_summary_path(tmp.path(), &engine.state.session_id());
    std::fs::create_dir_all(summary_path.parent().unwrap()).unwrap();
    let summary = DEFAULT_SESSION_MEMORY_TEMPLATE.replace(
        "# Current State",
        "# Current State\n\nMemory says old alpha is complete and beta is next.",
    );
    std::fs::write(&summary_path, summary).unwrap();
    engine.state.set_session_memory(SessionMemorySnapshot::new(
        &summary_path,
        6,
        100,
        1,
        "model:test",
    ));
    engine.state.set_messages(vec![
        Message::user_text("old alpha request"),
        Message::assistant_text("old alpha response"),
        Message::user_text("old gamma request"),
        Message::assistant_text("old gamma response"),
        Message::user_text("old delta request"),
        Message::assistant_text("old delta response"),
        Message::user_text("recent beta request"),
        Message::assistant_text("recent beta response"),
    ]);

    let result = engine.perform_compaction(true).await.unwrap();

    assert!(result.did_compact);
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    assert!(result.summary.contains("Session memory compact"));
    let model_visible = messages_after_latest_compact_boundary(&engine.state.messages());
    assert!(
        model_visible[0]
            .preview(2000)
            .contains("Memory says old alpha")
    );
    assert!(
        !model_visible
            .iter()
            .any(|message| message.preview(2000) == "old alpha request")
    );
    assert!(
        model_visible
            .iter()
            .any(|message| message.preview(2000).contains("recent beta request"))
    );
    let rebased = engine.state.session_memory().unwrap();
    assert_eq!(rebased.updated_message_count, 1);
    assert_eq!(rebased.updated_model_tokens, result.post_compact_tokens);
}

#[tokio::test]
async fn auto_compact_uses_automatically_updated_session_memory() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let memory_marker = "AUTO_SESSION_MEMORY_MARKER";
    let old_marker = "AUTO_SESSION_MEMORY_OLD_RAW_MARKER";
    let updated_memory = DEFAULT_SESSION_MEMORY_TEMPLATE.replace(
        "# Current State",
        &format!(
            "# Current State\n\n{memory_marker}: old alpha work is summarized and beta is next."
        ),
    );
    let provider = Arc::new(StaticTextProvider {
        requests: Arc::clone(&requests),
        text: format!("<session_memory>{updated_memory}</session_memory>"),
    });
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.context_window_tokens = Some(12_000);
    settings.context_system_tokens = Some(0);
    settings.context_tools_tokens = Some(0);
    settings.context_output_headroom = Some(0);
    settings.session_memory.init_min_tokens = 1;
    settings.session_memory.update_min_token_delta = 1;
    settings.session_memory.compact_min_chars = 5;
    settings.session_memory.compact_min_recent_tokens = 1;
    settings.session_memory.compact_max_recent_tokens = 200;
    settings.session_memory.compact_min_recent_messages = 2;
    let engine = test_engine_with_settings(provider, tmp.path(), settings);
    let history_path = tmp.path().join("auto-session-memory.jsonl");
    engine.state.with_history_path(&history_path);
    engine.state.set_messages(vec![
        Message::user_text(format!(
            "{old_marker} user request {}",
            "old context ".repeat(3000)
        )),
        Message::assistant_text(format!(
            "{old_marker} assistant response {}",
            "old response ".repeat(3000)
        )),
        Message::user_text("recent beta request"),
        Message::assistant_text("recent beta response"),
    ]);

    maybe_update_session_memory(&engine, 1, &[]).await;

    let snapshot = engine
        .state
        .session_memory()
        .expect("session memory should be updated automatically");
    let summary_content = std::fs::read_to_string(&snapshot.summary_path).unwrap();
    assert!(summary_content.contains(memory_marker));
    assert_eq!(requests.lock().unwrap().len(), 1);

    assert!(
        engine
            .maybe_compact_conversation(AUTOCOMPACT_COOLDOWN_TURNS + 1)
            .await
    );

    let requests_after_compact = requests.lock().unwrap();
    assert_eq!(
        requests_after_compact.len(),
        1,
        "auto compact should consume the refreshed session-memory file instead of calling the fallback summarizer"
    );
    drop(requests_after_compact);

    let model_visible = messages_after_latest_compact_boundary(&engine.state.messages());
    let visible_text = model_visible
        .iter()
        .map(|message| message.preview(20_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(visible_text.contains("Session memory compact"));
    assert!(visible_text.contains(memory_marker));
    assert!(visible_text.contains("recent beta request"));
    assert!(visible_text.contains("recent beta response"));
    assert!(!visible_text.contains(old_marker));

    let state_path = engine
        .state
        .session_state_path()
        .expect("history sidecar should be configured");
    let state_text = std::fs::read_to_string(state_path).unwrap();
    assert!(!state_text.contains("compacted_messages"));
    let transcript_text = std::fs::read_to_string(&history_path).unwrap();
    assert!(transcript_text.contains("\"subtype\":\"compact_boundary\""));
    assert!(transcript_text.contains("This session is being continued"));
    assert!(transcript_text.contains("Session memory compact"));
    assert!(transcript_text.contains(memory_marker));
}

#[tokio::test]
async fn oversized_session_memory_compaction_falls_back_to_summary_model() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.context_window_tokens = Some(10_000);
    settings.context_system_tokens = Some(0);
    settings.context_tools_tokens = Some(0);
    settings.context_output_headroom = Some(0);
    settings.session_memory.compact_min_chars = 5;
    settings.session_memory.compact_min_recent_tokens = 1;
    settings.session_memory.compact_max_recent_tokens = 50_000;
    settings.session_memory.compact_min_recent_messages = 1;
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    let summary_path =
        kcoder_state::session_memory_summary_path(tmp.path(), &engine.state.session_id());
    std::fs::create_dir_all(summary_path.parent().unwrap()).unwrap();
    let summary = DEFAULT_SESSION_MEMORY_TEMPLATE.replace(
        "# Current State",
        &format!("# Current State\n\n{}", "large memory ".repeat(3000)),
    );
    std::fs::write(&summary_path, summary).unwrap();
    engine.state.set_session_memory(SessionMemorySnapshot::new(
        &summary_path,
        6,
        100,
        1,
        "model:test",
    ));
    engine.state.set_messages(vec![
        Message::user_text("old alpha request ".repeat(400)),
        Message::assistant_text("old alpha response ".repeat(400)),
        Message::user_text("old gamma request ".repeat(400)),
        Message::assistant_text("old gamma response ".repeat(400)),
        Message::user_text("old delta request"),
        Message::assistant_text("old delta response"),
        Message::user_text("recent beta request"),
        Message::assistant_text("recent beta response"),
    ]);

    let result = engine.perform_compaction(true).await.unwrap();

    assert!(result.did_compact);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert_eq!(result.summary, "auto compact summary");
}

#[tokio::test]
async fn session_memory_plan_below_message_soft_but_above_full_soft_falls_back() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.context_window_tokens = Some(20_000);
    settings.context_output_headroom = Some(2_000);
    settings.auto_compact_threshold_tokens = Some(15_000);
    settings.estimated_tool_growth_tokens = Some(1);
    settings.max_tokens = Some(1);
    settings.session_memory.compact_min_chars = 5;
    settings.session_memory.compact_min_recent_tokens = 1;
    settings.session_memory.compact_max_recent_tokens = 10_000;
    settings.session_memory.compact_min_recent_messages = 3;
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    let static_request =
        MessagesRequest::new("test", Vec::new()).with_system("STATIC_PREFIX ".repeat(3_000));
    engine.note_static_prefix(&static_request);

    let summary_path =
        kcoder_state::session_memory_summary_path(tmp.path(), &engine.state.session_id());
    std::fs::create_dir_all(summary_path.parent().unwrap()).unwrap();
    let summary = DEFAULT_SESSION_MEMORY_TEMPLATE.replace(
        "# Current State",
        "# Current State\n\nOld work is captured by session memory.",
    );
    std::fs::write(&summary_path, summary).unwrap();
    engine.state.set_session_memory(SessionMemorySnapshot::new(
        &summary_path,
        6,
        100,
        1,
        "model:test",
    ));
    engine.state.set_messages(vec![
        Message::user_text("old alpha request ".repeat(600)),
        Message::assistant_text("old alpha response ".repeat(600)),
        Message::user_text("old gamma request ".repeat(600)),
        Message::assistant_text("old gamma response ".repeat(600)),
        Message::user_text("old delta request ".repeat(600)),
        Message::assistant_text("old delta response ".repeat(600)),
        Message::user_text("recent beta request"),
        Message::assistant_text("recent beta response"),
    ]);

    let result = engine.perform_compaction(true).await.unwrap();

    assert!(result.did_compact);
    assert_eq!(
        requests.load(Ordering::SeqCst),
        1,
        "完整请求超过 soft 时必须拒绝 Session Memory plan 并调用 summary model"
    );
    assert_eq!(result.summary, "auto compact summary");
}

#[tokio::test]
async fn session_memory_compaction_skips_oversized_attachments_without_summary_fallback() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("AGENTS.md"),
        format!(
            "# Project Instructions\n\n{}",
            "PROJECT_RULE_TOO_LARGE ".repeat(2000)
        ),
    )
    .unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.context_window_tokens = Some(10_000);
    settings.context_system_tokens = Some(0);
    settings.context_tools_tokens = Some(0);
    settings.context_output_headroom = Some(0);
    settings.session_memory.compact_min_chars = 5;
    settings.session_memory.compact_min_recent_tokens = 1;
    settings.session_memory.compact_max_recent_tokens = 200;
    settings.session_memory.compact_min_recent_messages = 2;
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    let summary_path =
        kcoder_state::session_memory_summary_path(tmp.path(), &engine.state.session_id());
    std::fs::create_dir_all(summary_path.parent().unwrap()).unwrap();
    let summary = DEFAULT_SESSION_MEMORY_TEMPLATE.replace(
        "# Current State",
        "# Current State\n\nOld work is captured by session memory.",
    );
    std::fs::write(&summary_path, summary).unwrap();
    engine.state.set_session_memory(SessionMemorySnapshot::new(
        &summary_path,
        6,
        100,
        1,
        "model:test",
    ));
    engine.state.set_messages(vec![
        Message::user_text("old alpha request ".repeat(600)),
        Message::assistant_text("old alpha response ".repeat(600)),
        Message::user_text("old gamma request ".repeat(600)),
        Message::assistant_text("old gamma response ".repeat(600)),
        Message::user_text("old delta request ".repeat(600)),
        Message::assistant_text("old delta response ".repeat(600)),
        Message::user_text("recent beta request"),
        Message::assistant_text("recent beta response"),
    ]);

    let result = engine.perform_compaction(true).await.unwrap();

    assert!(result.did_compact);
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    assert!(result.summary.contains("Session memory compact"));
    let state_text = engine
        .state
        .messages()
        .into_iter()
        .map(|message| message.preview(20_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(state_text.contains("Session memory compact"));
    assert!(state_text.contains("Old work is captured by session memory"));
    assert!(!state_text.contains("PROJECT_RULE_TOO_LARGE"));
}

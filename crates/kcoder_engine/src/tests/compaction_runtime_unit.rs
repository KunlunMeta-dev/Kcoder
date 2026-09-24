use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

use kcoder_api::Provider;
use kcoder_config::Settings;
use kcoder_memory::{MemoryManager, MemoryStore};

use super::*;
use crate::test_support::engine_builder::{TestEngineBuilder, settings_using_main_summary_runtime};

fn lifecycle_test_engine(cwd: &Path) -> QueryEngine {
    TestEngineBuilder::new(cwd).build()
}

#[tokio::test]
async fn idle_reservation_blocks_prefire_and_rolls_back_partial_job_reservation() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let provider: Arc<dyn Provider> = Arc::new(HangingPrefireProvider {
        requests: Arc::clone(&requests),
        dropped: Arc::new(AtomicUsize::new(0)),
    });
    let engine = prefire_scope_engine(tmp.path(), provider);
    let held = engine.auto_compact_state.write().unwrap();
    assert!(engine.try_reserve_background_work_idle().is_none());
    assert!(
        engine.background_jobs.try_reserve_idle().is_some(),
        "partial reservation must roll back"
    );
    drop(held);
    let reservation = engine.try_reserve_background_work_idle().unwrap();
    engine
        .maybe_prefire_compaction(&engine.context_budget(), 1_000)
        .await;
    assert_eq!(engine.prefire_resource_registered(), Some(false));
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    assert!(engine.clone().try_reserve_background_work_idle().is_none());
    drop(reservation);
    engine
        .maybe_prefire_compaction(&engine.context_budget(), 1_000)
        .await;
    assert_eq!(engine.prefire_resource_registered(), Some(true));
    assert!(engine.try_reserve_background_work_idle().is_none());
    engine.prepare_session_replacement();
    settle_prefire().await;
    engine.try_reserve_background_work_idle().unwrap().commit();
    engine
        .maybe_prefire_compaction(&engine.context_budget(), 1_000)
        .await;
    assert_eq!(engine.prefire_resource_registered(), Some(false));
}

#[test]
fn prefire_resource_observation_reports_reservation_and_contention() {
    let root = tempfile::tempdir().unwrap();
    let engine = lifecycle_test_engine(root.path());
    assert_eq!(engine.try_background_activity_counts(), Some((0, 0, 0)));
    assert!(engine.shares_background_activity_with(&engine.clone()));
    assert!(!engine.shares_background_activity_with(&lifecycle_test_engine(root.path())));
    let mut state = engine.auto_compact_state.write().unwrap();
    assert_eq!(engine.try_background_activity_counts(), None);
    state.prefire_in_flight = true;
    drop(state);
    assert_eq!(engine.try_background_activity_counts(), Some((0, 0, 1)));
    engine.auto_compact_state.write().unwrap().prefire_in_flight = false;
}

#[tokio::test]
async fn admission_prefire_scope_exit_cancels_queued_request() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let provider: Arc<dyn Provider> = Arc::new(HangingPrefireProvider {
        requests: requests.clone(),
        dropped: Arc::new(AtomicUsize::new(0)),
    });
    let engine = prefire_scope_engine(tmp.path(), provider.clone());
    let foreground = crate::request_admission::acquire(
        &provider,
        crate::request_admission::RequestClass::Foreground,
    )
    .await
    .unwrap();
    engine
        .maybe_prefire_compaction(&engine.context_budget(), 1_000)
        .await;
    settle_prefire().await;
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    engine.prepare_session_replacement();
    settle_prefire().await;
    drop(foreground);
    settle_prefire().await;
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    assert!(!recover_read_lock(&engine.auto_compact_state, "auto_compact_state").prefire_in_flight);
}

#[derive(Debug)]
struct RepairAdmissionPrefireProvider {
    requests: Arc<AtomicUsize>,
    release_first_response: Arc<tokio::sync::Notify>,
    first_stream_dropped: Arc<AtomicUsize>,
}

impl Provider for RepairAdmissionPrefireProvider {
    fn name(&self) -> &'static str {
        "repair-admission-prefire"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let attempt = self.requests.fetch_add(1, Ordering::SeqCst);
        let release = self.release_first_response.clone();
        let dropped = PrefireStreamDrop(self.first_stream_dropped.clone());
        Ok(Box::pin(async_stream::stream! {
            let _dropped = dropped;
            let response = if attempt == 0 {
                "<analysis>checked</analysis><summary>invalid one</summary><summary>invalid two</summary>"
            } else {
                "<analysis>checked</analysis><summary>must not publish</summary>"
            };
            for mut event in crate::test_support::events::simple_text_events(response) {
                if let StreamEvent::MessageStart { message } = &mut event {
                    message.usage = Some(kcoder_types::Usage {
                        input_tokens: 17,
                        output_tokens: 9,
                        total_tokens: Some(26),
                        cache_creation_input_tokens: None,
                        cache_read_input_tokens: None,
                        iterations: None,
                    });
                }
                if attempt == 0 && matches!(event, StreamEvent::MessageStop) {
                    release.notified().await;
                }
                yield Ok(event);
            }
        }))
    }
}

#[tokio::test]
async fn admission_prefire_repair_queue_cancellation_preserves_usage_without_publication() {
    use crate::request_admission::{RequestClass, acquire, queued_requests_for_test};

    let temp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(tokio::sync::Notify::new());
    let provider: Arc<dyn Provider> = Arc::new(RepairAdmissionPrefireProvider {
        requests: requests.clone(),
        release_first_response: release.clone(),
        first_stream_dropped: dropped.clone(),
    });
    let engine = prefire_scope_engine(temp.path(), provider.clone());
    engine.state.set_usage_history_root(Some(temp.path()));
    let original = serde_json::to_value(engine.state.messages()).unwrap();
    engine
        .maybe_prefire_compaction(&engine.context_budget(), 1_000)
        .await;
    wait_for_prefire_condition(|| requests.load(Ordering::SeqCst) == 1).await;

    // Foreground work can enter while the first background stream is still active.
    // Holding it makes the protocol repair wait for a second admission permit.
    let foreground = acquire(&provider, RequestClass::Foreground).await.unwrap();
    release.notify_one();
    wait_for_prefire_condition(|| dropped.load(Ordering::SeqCst) == 1).await;
    wait_for_prefire_condition(|| queued_requests_for_test(&provider, RequestClass::Prefire) == 1)
        .await;
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert!(recover_read_lock(&engine.auto_compact_state, "auto_compact_state").prefire_in_flight);
    let usage = kcoder_state::usage_history::read_usage(temp.path())
        .unwrap()
        .unwrap();
    let counters = usage
        .days
        .values()
        .flat_map(|day| day.values())
        .collect::<Vec<_>>();
    assert_eq!(counters.iter().map(|count| count.requests).sum::<u64>(), 1);
    assert_eq!(
        counters.iter().map(|count| count.input_tokens).sum::<u64>(),
        17
    );
    assert_eq!(
        counters
            .iter()
            .map(|count| count.output_tokens)
            .sum::<u64>(),
        9
    );

    engine.prepare_session_replacement();
    wait_for_prefire_condition(|| queued_requests_for_test(&provider, RequestClass::Prefire) == 0)
        .await;
    drop(foreground);
    // A stale repair ticket or leaked background permit would block this admission.
    let next = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        acquire(&provider, RequestClass::Prefire),
    )
    .await
    .unwrap()
    .unwrap();
    drop(next);
    assert_eq!(
        queued_requests_for_test(&provider, RequestClass::Prefire),
        0
    );
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    let state = recover_read_lock(&engine.auto_compact_state, "auto_compact_state");
    assert!(!state.prefire_in_flight);
    assert!(state.prefire_job.is_none());
    assert!(state.prefire_note.is_none());
    drop(state);
    assert_eq!(
        serde_json::to_value(engine.state.messages()).unwrap(),
        original
    );
    let usage_after = kcoder_state::usage_history::read_usage(temp.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(usage_after).unwrap(),
        serde_json::to_value(usage).unwrap()
    );
}

#[derive(Debug)]
struct HangingPrefireProvider {
    requests: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
}

struct PrefireStreamDrop(Arc<AtomicUsize>);

impl Drop for PrefireStreamDrop {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

impl Provider for HangingPrefireProvider {
    fn name(&self) -> &'static str {
        "hanging-prefire"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.fetch_add(1, Ordering::SeqCst);
        let guard = PrefireStreamDrop(Arc::clone(&self.dropped));
        Ok(Box::pin(async_stream::stream! {
            let _guard = guard;
            std::future::pending::<()>().await;
            yield Ok(StreamEvent::MessageStop);
        }))
    }
}

fn prefire_scope_engine(cwd: &Path, provider: Arc<dyn Provider>) -> QueryEngine {
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.context_window_tokens = Some(100_000);
    settings.context_output_headroom = Some(12_000);
    settings.max_tokens = Some(1);
    settings.estimated_tool_growth_tokens = Some(1);
    settings.auto_compact_threshold_tokens = Some(76_000);
    settings.prefire_threshold_tokens = Some(100);
    settings.session_memory.enabled = false;
    let engine = test_engine_with_settings(provider, cwd, settings);
    engine.state.set_messages(vec![
        Message::user_text("old request ".repeat(500)),
        Message::assistant_text("old response ".repeat(500)),
        Message::user_text("middle request ".repeat(500)),
        Message::assistant_text("middle response ".repeat(500)),
        Message::user_text("recent request"),
        Message::assistant_text("recent response"),
    ]);
    engine
}

async fn settle_prefire() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

async fn wait_for_prefire_condition(condition: impl Fn() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !condition() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("prefire lifecycle condition did not complete");
}

#[test]
fn prefire_scope_closed_runtime_does_not_deadlock() {
    const CHILD_FLAG: &str = "KCODER_PREFIRE_CLOSED_RUNTIME_CHILD";
    if std::env::var_os(CHILD_FLAG).is_some() {
        let tmp = tempfile::tempdir().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let handle = runtime.handle().clone();
        let engine = {
            let _entered = handle.enter();
            prefire_scope_engine(
                tmp.path(),
                Arc::new(SummaryCountingProvider {
                    requests: requests.clone(),
                }),
            )
        };
        drop(runtime);
        let _entered = handle.enter();
        futures::executor::block_on(
            engine.maybe_prefire_compaction(&engine.context_budget(), 1_000),
        );
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        let state = recover_read_lock(&engine.auto_compact_state, "auto_compact_state");
        assert!(!state.prefire_in_flight);
        assert!(state.prefire_job.is_none());
        return;
    }
    // Isolate the deadlock regression and kill only this owned child if it stalls.
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "compaction_runtime::tests::prefire_scope_closed_runtime_does_not_deadlock",
            "--nocapture",
        ])
        .env(CHILD_FLAG, "1")
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "closed-runtime child failed: {status}");
            break;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("prefire spawn deadlocked on a closed runtime");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[derive(Debug)]
struct PanickingPrefireProvider;

impl Provider for PanickingPrefireProvider {
    fn name(&self) -> &'static str {
        "panicking-prefire"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        panic!("intentional prefire provider panic");
    }
}

#[tokio::test]
async fn prefire_scope_provider_panic_releases_singleflight() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = prefire_scope_engine(tmp.path(), Arc::new(PanickingPrefireProvider));
    engine
        .maybe_prefire_compaction(&engine.context_budget(), 1_000)
        .await;
    let abort = recover_read_lock(&engine.auto_compact_state, "auto_compact_state")
        .prefire_job
        .as_ref()
        .unwrap()
        .abort
        .as_ref()
        .unwrap()
        .clone();
    wait_for_prefire_condition(|| abort.is_finished()).await;
    let state = recover_read_lock(&engine.auto_compact_state, "auto_compact_state");
    assert!(!state.prefire_in_flight);
    assert!(state.prefire_job.is_none());
    assert!(state.prefire_note.is_none());
}

#[tokio::test]
async fn prefire_scope_replacement_aborts_running_stream() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    let engine = prefire_scope_engine(
        tmp.path(),
        Arc::new(HangingPrefireProvider {
            requests: requests.clone(),
            dropped: dropped.clone(),
        }),
    );
    engine
        .maybe_prefire_compaction(&engine.context_budget(), 1_000)
        .await;
    settle_prefire().await;
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    engine.prepare_session_replacement();
    settle_prefire().await;
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    let state = recover_read_lock(&engine.auto_compact_state, "auto_compact_state");
    assert!(!state.prefire_in_flight);
    assert!(state.prefire_note.is_none());
}

#[tokio::test]
async fn prefire_scope_replacement_before_first_poll_skips_provider() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let engine = prefire_scope_engine(
        tmp.path(),
        Arc::new(SummaryCountingProvider {
            requests: requests.clone(),
        }),
    );
    engine
        .maybe_prefire_compaction(&engine.context_budget(), 1_000)
        .await;
    engine.prepare_session_replacement();
    settle_prefire().await;
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    assert!(!recover_read_lock(&engine.auto_compact_state, "auto_compact_state").prefire_in_flight);
}

#[tokio::test]
async fn prefire_scope_last_engine_owner_drop_aborts_stream() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    let engine = prefire_scope_engine(
        tmp.path(),
        Arc::new(HangingPrefireProvider {
            requests: requests.clone(),
            dropped: dropped.clone(),
        }),
    );
    let other_owner = engine.clone();
    let state = engine.auto_compact_state.clone();
    engine
        .maybe_prefire_compaction(&engine.context_budget(), 1_000)
        .await;
    settle_prefire().await;
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    drop(engine);
    settle_prefire().await;
    assert_eq!(dropped.load(Ordering::SeqCst), 0);
    drop(other_owner);
    settle_prefire().await;
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(!recover_read_lock(&state, "auto_compact_state").prefire_in_flight);
}

#[tokio::test]
async fn prefire_scope_old_cleanup_preserves_new_singleflight() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    let engine = prefire_scope_engine(
        tmp.path(),
        Arc::new(HangingPrefireProvider {
            requests: requests.clone(),
            dropped: dropped.clone(),
        }),
    );
    engine
        .maybe_prefire_compaction(&engine.context_budget(), 1_000)
        .await;
    wait_for_prefire_condition(|| requests.load(Ordering::SeqCst) == 1).await;
    let old_abort = recover_read_lock(&engine.auto_compact_state, "auto_compact_state")
        .prefire_job
        .as_ref()
        .unwrap()
        .abort
        .as_ref()
        .unwrap()
        .clone();
    engine.prepare_session_replacement();
    engine
        .maybe_prefire_compaction(&engine.context_budget(), 1_000)
        .await;
    wait_for_prefire_condition(|| old_abort.is_finished()).await;
    wait_for_prefire_condition(|| requests.load(Ordering::SeqCst) == 2).await;
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(recover_read_lock(&engine.auto_compact_state, "auto_compact_state").prefire_in_flight);
    engine
        .maybe_prefire_compaction(&engine.context_budget(), 1_000)
        .await;
    assert_eq!(requests.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn prefire_scope_normal_completion_keeps_note() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let engine = prefire_scope_engine(
        tmp.path(),
        Arc::new(SummaryCountingProvider {
            requests: requests.clone(),
        }),
    );
    engine
        .maybe_prefire_compaction(&engine.context_budget(), 1_000)
        .await;
    settle_prefire().await;
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    let state = recover_read_lock(&engine.auto_compact_state, "auto_compact_state");
    assert!(!state.prefire_in_flight);
    assert!(state.prefire_note.is_some());
}

#[tokio::test]
async fn prefire_complete_reuse_commits_history_without_second_request() {
    // The provider fixture verifies lifecycle and request counts, not summary quality.
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let engine = prefire_scope_engine(
        tmp.path(),
        Arc::new(SummaryCountingProvider {
            requests: requests.clone(),
        }),
    );
    let original = engine.state.messages();
    engine.state.set_messages(Vec::new());
    let history = tmp.path().join("prefire-history.jsonl");
    engine.state.with_history_path(&history);
    for message in original.clone() {
        engine.state.add_message(message);
    }
    engine.state.flush_history().await.unwrap();
    let before: Vec<serde_json::Value> = std::fs::read_to_string(&history)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(before.len(), original.len());
    engine
        .maybe_prefire_compaction(&engine.context_budget(), 1_000)
        .await;
    wait_for_prefire_condition(|| {
        recover_read_lock(&engine.auto_compact_state, "auto_compact_state")
            .prefire_note
            .is_some()
    })
    .await;
    assert_eq!(requests.load(Ordering::SeqCst), 1);

    let result = engine.perform_compaction(true).await.unwrap();
    assert!(result.did_compact && result.used_prefire);
    assert_eq!(
        requests.load(Ordering::SeqCst),
        1,
        "foreground must not repeat the summary request"
    );
    assert!(result.post_compact_tokens < result.pre_compact_tokens);
    assert!(latest_compact_boundary(&engine.state.messages()).is_some());
    assert!(
        recover_read_lock(&engine.auto_compact_state, "auto_compact_state")
            .prefire_note
            .is_none()
    );
    let entries: Vec<serde_json::Value> = std::fs::read_to_string(&history)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry["subtype"] == "compact_boundary")
            .count(),
        1
    );
    assert!(
        entries
            .iter()
            .any(|entry| entry["isCompactSummary"] == true)
    );
    assert_eq!(
        entries.len(),
        before.len() + 2,
        "only boundary and summary are appended"
    );
    assert_eq!(
        &entries[..before.len()],
        before.as_slice(),
        "original history, including role, order, IDs and duplicates, must remain unchanged"
    );
}

#[test]
fn static_prefix_preflight_serializes_misses_once_and_hits_zero_times() {
    use crate::context::tokens::STATIC_TOOL_SERIALIZATIONS;
    let temp = tempfile::tempdir().unwrap();
    let engine = lifecycle_test_engine(temp.path());
    let mut request = MessagesRequest::new("model", vec![Message::user_text("你好")]);
    for name in ["read", "write"] {
        request.tools.push(kcoder_types::ToolDefinition {
            name: name.into(),
            description: "Unicode 工具".into(),
            input_schema: serde_json::json!({"type": "object"}),
        });
        STATIC_TOOL_SERIALIZATIONS.with(|count| count.set(0));
        let (changed, measurement) = engine.note_static_prefix(&request);
        assert!(changed);
        let _count =
            TokenCounter::count_request_with_static_prefix(&request, changed, &measurement);
        assert_eq!(
            STATIC_TOOL_SERIALIZATIONS.with(|count| count.get()),
            request.tools.len()
        );
        assert_eq!(
            recover_read_lock(&engine.auto_compact_state, "auto_compact_state")
                .last_static_prefix_tokens,
            Some(measurement.padded_tokens())
        );
        STATIC_TOOL_SERIALIZATIONS.with(|count| count.set(0));
        let (changed, measurement) = engine.note_static_prefix(&request);
        assert!(!changed);
        TokenCounter::count_request_with_static_prefix(&request, changed, &measurement);
        assert_eq!(STATIC_TOOL_SERIALIZATIONS.with(|count| count.get()), 0);
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
use crate::test_support::providers::{EmptyProvider, SummaryCountingProvider};

#[derive(Debug, Default)]
struct StreamHttpCompactionProvider {
    main_requests: std::sync::Mutex<Vec<MessagesRequest>>,
    summary_requests: Arc<AtomicUsize>,
    repeat_error: bool,
    sse_error: bool,
    partial: Vec<StreamEvent>,
    fail_summary: bool,
    hang_summary: bool,
    summary_started: tokio::sync::Notify,
    summary_dropped: Arc<AtomicUsize>,
    failed_stream_dropped: Arc<AtomicUsize>,
}

impl Provider for StreamHttpCompactionProvider {
    fn name(&self) -> &'static str {
        "stream-http-compaction"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        if request.messages.iter().any(|message| {
            message
                .preview(20_000)
                .contains("Conversation history to summarize")
        }) {
            assert_eq!(self.failed_stream_dropped.load(Ordering::SeqCst), 1);
            if self.fail_summary || self.hang_summary {
                self.summary_requests.fetch_add(1, Ordering::SeqCst);
                self.summary_started.notify_one();
                if self.hang_summary {
                    let guard = PrefireStreamDrop(self.summary_dropped.clone());
                    return Ok(Box::pin(async_stream::stream! {
                        let _guard = guard;
                        std::future::pending::<()>().await;
                        yield Ok(StreamEvent::MessageStop);
                    }));
                }
                return Err(kcoder_api::ApiErrorKind::Api {
                    error_type: "invalid_request_error".into(),
                    message: "summary fixture failure".into(),
                });
            }
            return SummaryCountingProvider {
                requests: self.summary_requests.clone(),
            }
            .stream_messages(request);
        }
        let mut requests = self.main_requests.lock().unwrap();
        requests.push(request.clone());
        if requests.len() == 1 || self.repeat_error {
            let failure = if self.sse_error {
                Ok(StreamEvent::Error {
                    error: kcoder_types::ApiError {
                        error_type: "context_length_exceeded".into(),
                        message: "context rejected".into(),
                    },
                })
            } else {
                Err(kcoder_api::ApiErrorKind::Http {
                    error_type: "invalid_request_error".into(),
                    message: "context rejected".into(),
                    metadata: kcoder_api::HttpErrorMetadata {
                        status: 400,
                        provider_code: Some("context_length_exceeded".into()),
                        provider_type: None,
                        rejected_reasoning_parameter: None,
                        retry_after: None,
                    },
                })
            };
            let events = self
                .partial
                .iter()
                .cloned()
                .map(Ok)
                .chain([failure])
                .collect::<Vec<_>>();
            let guard = PrefireStreamDrop(self.failed_stream_dropped.clone());
            return Ok(Box::pin(async_stream::stream! {
                let _guard = guard;
                for event in events {
                    yield event;
                }
                std::future::pending::<()>().await;
            }));
        }
        SummaryCountingProvider {
            requests: Arc::new(AtomicUsize::new(0)),
        }
        .stream_messages(request)
    }
}

fn stream_http_compaction_engine(cwd: &Path, provider: Arc<dyn Provider>) -> QueryEngine {
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.context_window_tokens = Some(100_000);
    settings.auto_compact_threshold_tokens = Some(90_000);
    settings.prefire_threshold_tokens = Some(90_000);
    settings.context_output_headroom = Some(2_000);
    settings.max_tokens = Some(1_000);
    settings.estimated_tool_growth_tokens = Some(1);
    settings.session_memory.enabled = false;
    let engine = test_engine_with_settings(provider, cwd, settings);
    engine.state.set_messages(vec![
        Message::user_text("old request ".repeat(1_000)),
        Message::assistant_text("old response ".repeat(1_000)),
        Message::user_text("middle request ".repeat(1_000)),
        Message::assistant_text("middle response ".repeat(1_000)),
        Message::user_text("recent request"),
        Message::assistant_text("recent response"),
        Message::user_text("current request must remain verbatim"),
    ]);
    engine
}

async fn recovery_records(engine: &QueryEngine, root: &Path) -> Vec<serde_json::Value> {
    assert!(
        engine
            .state
            .flush_diagnostics_until(std::time::Instant::now() + std::time::Duration::from_secs(3))
            .await
    );
    std::fs::read_dir(root.join("recovery"))
        .unwrap()
        .map(|entry| {
            let bytes = std::fs::read(entry.unwrap().path()).unwrap();
            assert!(bytes.len() <= 16 * 1024);
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value.as_object().unwrap().len(), 4);
            assert!(
                value["request_id"]
                    .as_str()
                    .is_some_and(|id| id.len() == 36)
            );
            for record in value["records"].as_array().unwrap() {
                assert_eq!(record.as_object().unwrap().len(), 3);
                assert!(record["invocation"].is_u64());
                assert!(record["decision"].is_string());
                assert!(record["outcome"].is_string());
            }
            value
        })
        .collect()
}

#[tokio::test]
async fn recovery_record_cancel_or_drop_during_retry_wait() {
    use futures::StreamExt;
    for abandon in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let provider = Arc::new(DeadlineProvider {
            inner: Default::default(),
            mode: "backoff",
            calls: AtomicUsize::new(0),
        });
        let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
        engine
            .state
            .with_llm_request_history_dir(tmp.path(), "wait-fixture");
        let prompt = kcoder_permissions::AutoAllowPrompt;
        let cancel = CancellationToken::new();
        let mut stream = engine.run_turn_stream_with_cancel(&prompt, cancel.clone());
        while let Some(event) = stream.next().await {
            if matches!(event, crate::EngineEvent::ProviderRetry(_)) {
                if abandon {
                    break;
                }
                cancel.cancel();
            }
        }
        drop(stream);
        let records = recovery_records(&engine, tmp.path()).await;
        assert_eq!(records.len(), 1);
        let outcome = if abandon { "abandoned" } else { "cancelled" };
        assert!(
            records[0]["records"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["decision"] == "retry_wait" && r["outcome"] == outcome),
            "{records:?}"
        );
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn recovery_record_hard_gate_stop_is_known_not_abandoned() {
    for training in [true, false] {
        let tmp = tempfile::tempdir().unwrap();
        let provider = Arc::new(SummaryCountingProvider {
            requests: Arc::new(AtomicUsize::new(0)),
        });
        let engine = stream_http_compaction_engine(tmp.path(), provider)
            .with_subagent_system_prompt(Some("fixed system instruction ".repeat(30_000)));
        engine
            .state
            .with_llm_request_history_dir(tmp.path(), "hard-gate-fixture");
        {
            let mut settings = engine.settings.write().unwrap();
            settings.training_mode = training;
            settings.context_hard_input_tokens = Some(20_000);
        }
        let events = collect_stream_http_events(&engine).await;
        let records = recovery_records(&engine, tmp.path()).await;
        let outcome = if training {
            "policy_rejected"
        } else {
            "budget_rejected"
        };
        assert!(
            records[0]["records"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["decision"] == "stop"
                    && r["outcome"] == outcome
                    && r["invocation"] == 0),
            "{records:?} {events:?}"
        );
    }
}

#[tokio::test]
async fn stream_http_context_compacts_and_rebuilds_main_request_once() {
    use futures::StreamExt;
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider::default());
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let events: Vec<_> = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        engine.run_turn_stream(&prompt).collect(),
    )
    .await
    .expect("reactive compaction must not retain the failed request admission");
    assert!(!tmp.path().join("recovery").exists());
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 1);
    let requests = provider.main_requests.lock().unwrap();
    assert_eq!(requests.len(), 2, "{events:?}");
    assert!(
        TokenCounter::count(&requests[1].messages) < TokenCounter::count(&requests[0].messages)
    );
    assert!(
        TokenCounter::count_request(&requests[1], true).tokens
            < TokenCounter::count_request(&requests[0], true).tokens
    );
    assert!(requests[1].messages.iter().any(|message| {
        message
            .preview(1_000)
            .contains("current request must remain verbatim")
    }));
    assert!(latest_compact_boundary(&engine.state.messages()).is_some());
    assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::SystemNotice(text) if text.contains("reactive compact completed"))));
    assert!(!events.iter().any(|event| matches!(
        event,
        crate::EngineEvent::Error(_)
            | crate::EngineEvent::ProviderFailed { .. }
            | crate::EngineEvent::ProviderRetry(_)
    )));
}

async fn collect_stream_http_events(engine: &QueryEngine) -> Vec<crate::EngineEvent> {
    use futures::StreamExt;
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        engine
            .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
            .collect(),
    )
    .await
    .expect("stream recovery must terminate promptly")
}

#[tokio::test]
async fn recovery_total_deadline_interrupts_summary_without_user_cancellation() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider {
        hang_summary: true,
        ..Default::default()
    });
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    let mut document = serde_json::to_value(engine.settings.read().unwrap().clone()).unwrap();
    document["recovery"] = serde_json::json!({"provider":{"total_timeout_ms":50}});
    *engine.settings.write().unwrap() = serde_json::from_value(document).unwrap();
    let events = collect_stream_http_events(&engine).await;
    assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::Error(text) if text.contains("recovery deadline"))), "{events:?}");
    assert!(!engine.is_cancelled());
    assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
    assert_eq!(provider.summary_dropped.load(Ordering::SeqCst), 1);
    assert!(latest_compact_boundary(&engine.state.messages()).is_none());
}

#[derive(Debug)]
struct DeadlineProvider {
    inner: StreamHttpCompactionProvider,
    mode: &'static str,
    calls: AtomicUsize,
}

#[tokio::test]
async fn recovery_total_deadline_interrupts_session_memory_prepare_wait() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider::default());
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    {
        let mut settings = engine.settings.write().unwrap();
        settings.recovery.provider.total_timeout_ms = Some(50);
        settings.session_memory.enabled = true;
        settings.session_memory.compact_enabled = true;
    }
    engine
        .session_memory_update_running
        .store(true, Ordering::SeqCst);
    *engine.session_memory_update_started_at.lock().unwrap() = Some(std::time::Instant::now());
    let before = engine.state.messages();
    let events = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        collect_stream_http_events(&engine),
    )
    .await
    .expect("deadline must interrupt the pre-commit session-memory wait");
    assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::Error(text) if text.contains("recovery deadline"))), "{events:?}");
    assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 0);
    assert_eq!(engine.state.messages(), before);
    assert!(!engine.is_cancelled());
    assert!(engine.session_memory_update_running.load(Ordering::SeqCst));
}

#[tokio::test]
async fn recovery_total_deadline_hard_preflight_passes_user_cancel_to_summary() {
    let source = include_str!("../lib.rs");
    let hard_gate = source
        .split("hard_gate_compactions += 1;")
        .nth(1)
        .unwrap()
        .split(".await;")
        .next()
        .unwrap();
    assert!(
        hard_gate.contains("recovery_deadline.is_active().then(|| engine.cancel_token())"),
        "active hard preflight must forward user cancellation without changing None"
    );
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    let engine = stream_http_compaction_engine(
        tmp.path(),
        Arc::new(HangingPrefireProvider {
            requests: requests.clone(),
            dropped: dropped.clone(),
        }),
    );
    let before = engine.state.messages();
    let cancel = CancellationToken::new();
    let mut deadline = crate::recovery_deadline::RecoveryDeadline::default();
    deadline.start(Some(500));
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), async {
        let (result, ()) = tokio::join!(
            engine.perform_compaction_with_recovery_deadline(
                true,
                false,
                true,
                deadline.is_active().then(|| cancel.clone()),
                deadline
            ),
            async {
                while requests.load(Ordering::SeqCst) == 0 {
                    tokio::task::yield_now().await;
                }
                cancel.cancel();
            },
        );
        result
    })
    .await
    .unwrap();
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("cancelled by user")
    );
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert_eq!(engine.state.messages(), before);
}

#[tokio::test]
async fn recovery_total_deadline_drops_moa_rebuild_workers_and_queued_references() {
    use futures::StreamExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let tmp = tempfile::tempdir().unwrap();
    let summaries = Arc::new(AtomicUsize::new(0));
    let engine = stream_http_compaction_engine(
        tmp.path(),
        Arc::new(SummaryCountingProvider {
            requests: summaries.clone(),
        }),
    );
    {
        let mut settings = engine.settings.write().unwrap();
        settings.recovery.provider.total_timeout_ms = Some(500);
        settings.kunlunmeta_api_key = Some("fixture-key".into());
        settings.api_key = Some("fixture-key".into());
        settings.providers.get_mut("kunlunmeta").unwrap().endpoint = endpoint;
        settings.moa.enabled = true;
        settings.moa.max_reference_workers = 1;
        settings.moa.default_preset = "deadline".into();
        settings.moa.presets.insert(
            "deadline".into(),
            kcoder_config::MoaPresetConfig {
                reference_models: vec![
                    kcoder_config::MoaModelConfig::new("kunlunmeta", "reference-one"),
                    kcoder_config::MoaModelConfig::new("kunlunmeta", "reference-two"),
                ],
                aggregator: kcoder_config::MoaModelConfig::new("kunlunmeta", "aggregator"),
                ..Default::default()
            },
        );
    }
    engine.enable_moa_for_next_turn(Some("deadline".into()));
    let requests = Arc::new(AtomicUsize::new(0));
    let observed = requests.clone();
    let server = async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(socket.read_u8().await.unwrap());
            }
            let header = String::from_utf8(header).unwrap();
            let length: usize = header
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse().unwrap())
                })
                .unwrap();
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let call = observed.fetch_add(1, Ordering::SeqCst);
            if call == 3 {
                assert_eq!(request["model"], "reference-one");
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n").await.unwrap();
                let mut byte = [0];
                assert_eq!(
                    socket.read(&mut byte).await.unwrap(),
                    0,
                    "dropping MoA must close its owned in-flight stream"
                );
                assert!(
                    tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
                        .await
                        .is_err(),
                    "queued reference must not start after deadline"
                );
                break;
            }
            let (status, content_type, body) = if request["model"] == "aggregator" {
                ("400 Bad Request", "application/json", serde_json::json!({"error":{"type":"invalid_request_error","message":"context_length_exceeded"}}).to_string())
            } else {
                let events = [
                    serde_json::json!({"type":"message_start","message":{"id":"fixture","type":"message","role":"assistant","model":"fixture","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}),
                    serde_json::json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"advice"}}),
                    serde_json::json!({"type":"content_block_stop","index":0}),
                    serde_json::json!({"type":"message_stop"}),
                ];
                (
                    "200 OK",
                    "text/event-stream",
                    events
                        .iter()
                        .map(|event| {
                            format!(
                                "event: {}\ndata: {event}\n\n",
                                event["type"].as_str().unwrap()
                            )
                        })
                        .collect::<String>(),
                )
            };
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    };
    // Generous wall-clock backstop: the fixture asserts its own deadline
    // semantics (requests/summaries below); a 3 s budget proved flaky on
    // loaded machines where the first request had not been issued yet.
    let events = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let (events, ()) = tokio::join!(engine.run_turn_stream(&kcoder_permissions::AutoAllowPrompt).collect::<Vec<_>>(), server);
        events
    }).await.unwrap_or_else(|_| panic!("active recovery deadline must stop MoA reference collection; requests={}, summaries={}", requests.load(Ordering::SeqCst), summaries.load(Ordering::SeqCst)));
    assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::Error(text) if text.contains("recovery deadline"))), "{events:?}");
    assert_eq!(requests.load(Ordering::SeqCst), 4);
    assert_eq!(summaries.load(Ordering::SeqCst), 1);
    assert!(!engine.is_cancelled());
}

impl Provider for DeadlineProvider {
    fn name(&self) -> &'static str {
        "deadline-fixture"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        use futures::StreamExt;
        let summary = request.messages.iter().any(|message| {
            message
                .preview(20_000)
                .contains("Conversation history to summarize")
        });
        let call = if summary {
            0
        } else {
            self.calls.fetch_add(1, Ordering::SeqCst) + 1
        };
        if self.mode == "backoff" {
            return Err(kcoder_api::ApiErrorKind::Http {
                error_type: "server_error".into(),
                message: "retry fixture".into(),
                metadata: kcoder_api::HttpErrorMetadata {
                    status: 503,
                    provider_code: None,
                    provider_type: None,
                    rejected_reasoning_parameter: None,
                    retry_after: Some(std::time::Duration::from_secs(10)),
                },
            });
        }
        let mut stream = if self.mode == "compact" {
            self.inner.stream_messages(request)?
        } else if self.mode == "tool" && call == 1 {
            Box::pin(futures::stream::iter([
                Ok(StreamEvent::ContentBlockStart { index: 0, content_block: ContentBlock::ToolUse { id: "deadline-tool".into(), name: "read".into(), input: serde_json::json!({}) } }),
                Ok(StreamEvent::ContentBlockDelta { index: 0, delta: ContentDelta::InputJsonDelta { partial_json: serde_json::json!({"file_path": std::path::PathBuf::from(std::env::var_os("KCODER_WORKSPACE_ROOT").expect("workspace root")).join("crates/kcoder_engine/Cargo.toml")}).to_string() } }),
                Ok(StreamEvent::ContentBlockStop { index: 0 }), Ok(StreamEvent::MessageStop),
            ])) as kcoder_api::ProviderStream
        } else {
            SummaryCountingProvider {
                requests: Arc::new(AtomicUsize::new(0)),
            }
            .stream_messages(request)?
        };
        let delay = if self.mode == "hang" { 10_000 } else { 80 };
        let tail = self.mode == "tail";
        let delayed = Box::pin(async_stream::stream! {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            while let Some(event) = stream.next().await { yield event; }
            if tail {
                // Deliver accounting after the 200ms recovery deadline, but
                // before the completed-stream idle watchdog expires.
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                yield Ok(StreamEvent::MessageDelta { delta: kcoder_types::MessageDeltaFields {
                    stop_reason: None, stop_sequence: None,
                    usage: Some(kcoder_types::Usage { input_tokens: 177, output_tokens: 23, total_tokens: None, cache_creation_input_tokens: None, cache_read_input_tokens: None, iterations: None }),
                }});
                std::future::pending::<()>().await;
            }
        });
        if tail {
            Ok(crate::stream::timed_stream(
                delayed,
                std::time::Duration::from_millis(400),
            ))
        } else {
            Ok(delayed)
        }
    }
}

#[tokio::test]
async fn recovery_total_deadline_finishes_completed_tail_and_preserves_usage() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(DeadlineProvider {
        inner: Default::default(),
        mode: "tail",
        calls: AtomicUsize::new(0),
    });
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    engine
        .settings
        .write()
        .unwrap()
        .recovery
        .provider
        .total_timeout_ms = Some(200);
    let events = collect_stream_http_events(&engine).await;
    assert!(
        !events.iter().any(|event| matches!(
            event,
            crate::EngineEvent::Error(_)
                | crate::EngineEvent::ProviderFailed { .. }
                | crate::EngineEvent::ProviderRetry(_)
        )),
        "{events:?}"
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(engine.cumulative_usage.read().unwrap().input_tokens, 177);
    assert_eq!(engine.cumulative_usage.read().unwrap().output_tokens, 23);
}

#[tokio::test]
async fn recovery_total_deadline_bounds_stream_backoff_and_compaction_rebuild() {
    for (mode, timeout, expected_calls) in
        [("hang", 40, 1), ("backoff", 40, 1), ("compact", 210, 2)]
    {
        let tmp = tempfile::tempdir().unwrap();
        let provider = Arc::new(DeadlineProvider {
            inner: Default::default(),
            mode,
            calls: AtomicUsize::new(0),
        });
        let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
        engine
            .state
            .with_llm_request_history_dir(tmp.path(), "deadline-fixture");
        let mut document = serde_json::to_value(engine.settings.read().unwrap().clone()).unwrap();
        document["recovery"] = serde_json::json!({"provider":{"total_timeout_ms":timeout}});
        *engine.settings.write().unwrap() = serde_json::from_value(document).unwrap();
        let started = std::time::Instant::now();
        let events = collect_stream_http_events(&engine).await;
        let records = recovery_records(&engine, tmp.path()).await;
        assert_eq!(records.len(), 1);
        assert!(
            records[0]["records"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["outcome"] == "deadline_exceeded")
        );
        if mode == "backoff" {
            assert!(
                records[0]["records"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["decision"] == "retry_wait" && r["outcome"] == "deadline_exceeded")
            );
        }
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "{mode}: {events:?}"
        );
        assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::Error(text) if text.contains("recovery deadline"))), "{mode}: {events:?}");
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, crate::EngineEvent::StreamAborted { .. })),
            "{events:?}"
        );
        assert!(!engine.is_cancelled());
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            expected_calls,
            "{mode}: {events:?}"
        );
        if mode == "compact" {
            assert!(latest_compact_boundary(&engine.state.messages()).is_some());
            assert_eq!(provider.inner.summary_requests.load(Ordering::SeqCst), 1);
        }
    }
}

#[tokio::test]
async fn recovery_total_deadline_resets_after_tool_response_and_none_is_compatible() {
    for timeout in [None, Some(130)] {
        let tmp = tempfile::tempdir().unwrap();
        let provider = Arc::new(DeadlineProvider {
            inner: Default::default(),
            mode: "tool",
            calls: AtomicUsize::new(0),
        });
        let mut engine = stream_http_compaction_engine(tmp.path(), provider.clone());
        engine.tools = ToolRegistry::new().register(kcoder_tools::FileReadTool);
        let mut document = serde_json::to_value(engine.settings.read().unwrap().clone()).unwrap();
        document["recovery"] = serde_json::json!({"provider":{"total_timeout_ms":timeout}});
        *engine.settings.write().unwrap() = serde_json::from_value(document).unwrap();
        let events = collect_stream_http_events(&engine).await;
        assert_eq!(provider.calls.load(Ordering::SeqCst), 2, "{events:?}");
        assert!(
            !events.iter().any(|event| matches!(
                event,
                crate::EngineEvent::Error(_)
                    | crate::EngineEvent::ProviderFailed { .. }
                    | crate::EngineEvent::StreamAborted { .. }
            )),
            "{events:?}"
        );
        assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::ToolResult { output, .. } if !output.is_error)), "{events:?}");
    }
}

#[tokio::test]
async fn recovery_total_deadline_bounds_admission_without_starting_provider() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(DeadlineProvider {
        inner: Default::default(),
        mode: "hang",
        calls: AtomicUsize::new(0),
    });
    let provider_dyn: Arc<dyn Provider> = provider.clone();
    let held = crate::request_admission::acquire(
        &provider_dyn,
        crate::request_admission::RequestClass::Foreground,
    )
    .await
    .unwrap();
    let mut engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    engine.request_class = crate::request_admission::RequestClass::SkillReview;
    engine
        .settings
        .write()
        .unwrap()
        .recovery
        .provider
        .total_timeout_ms = Some(40);
    let events = collect_stream_http_events(&engine).await;
    assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::Error(text) if text.contains("recovery deadline"))), "{events:?}");
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    drop(held);
    assert!(
        crate::request_admission::acquire(
            &provider_dyn,
            crate::request_admission::RequestClass::SkillReview
        )
        .await
        .is_ok()
    );
}

#[derive(Debug, Default)]
struct CompactionRetryBudgetProvider {
    inner: StreamHttpCompactionProvider,
    main_calls: AtomicUsize,
    tool_round: bool,
}

impl Provider for CompactionRetryBudgetProvider {
    fn name(&self) -> &'static str {
        "compaction-retry-budget"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        if request.messages.iter().any(|message| {
            message
                .preview(20_000)
                .contains("Conversation history to summarize")
        }) {
            return self.inner.stream_messages(request);
        }
        let call = self.main_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if call == 1 || call == 3 || (self.tool_round && call == 5) {
            return Err(kcoder_api::ApiErrorKind::Http {
                error_type: "server_error".into(),
                message: "transient budget fixture".into(),
                metadata: kcoder_api::HttpErrorMetadata {
                    status: 503,
                    provider_code: None,
                    provider_type: None,
                    rejected_reasoning_parameter: None,
                    retry_after: None,
                },
            });
        }
        if self.tool_round && call == 4 {
            return Ok(Box::pin(futures::stream::iter([
                Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::ToolUse {
                        id: "budget-tool".into(),
                        name: "read".into(),
                        input: serde_json::json!({}),
                    },
                }),
                Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::InputJsonDelta {
                        partial_json: serde_json::json!({"file_path": std::path::PathBuf::from(std::env::var_os("KCODER_WORKSPACE_ROOT").expect("workspace root")).join("crates/kcoder_engine/Cargo.toml")}).to_string(),
                    },
                }),
                Ok(StreamEvent::ContentBlockStop { index: 0 }),
                Ok(StreamEvent::MessageStop),
            ])));
        }
        self.inner.stream_messages(request)
    }
}

#[tokio::test]
async fn reactive_compaction_preserves_logical_request_retry_budget() {
    for (max_retries, tool_round, expected_calls, expected_attempts) in [
        (1, false, 3, vec![1]),
        (2, false, 4, vec![1, 2]),
        (2, true, 6, vec![1, 2, 1]),
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let provider = Arc::new(CompactionRetryBudgetProvider {
            tool_round,
            ..Default::default()
        });
        let mut engine = stream_http_compaction_engine(tmp.path(), provider.clone());
        engine
            .state
            .with_llm_request_history_dir(tmp.path(), "recovery-fixture");
        engine.tools = ToolRegistry::new().register(kcoder_tools::FileReadTool);
        {
            let mut settings = engine.settings.write().unwrap();
            settings.max_retries = max_retries;
            settings.retry_base_delay_ms = 0;
        }
        let events = collect_stream_http_events(&engine).await;
        assert!(
            engine
                .state
                .flush_diagnostics_until(
                    std::time::Instant::now() + std::time::Duration::from_secs(2)
                )
                .await
        );
        let records: Vec<serde_json::Value> = std::fs::read_dir(tmp.path().join("recovery"))
            .unwrap()
            .map(|entry| {
                serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap()
            })
            .collect();
        assert_eq!(records.len(), if tool_round { 2 } else { 1 });
        let first = records
            .iter()
            .find(|record| {
                record["records"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["decision"] == "compact")
            })
            .unwrap();
        let invocations: Vec<_> = first["records"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["decision"] == "invoke")
            .map(|r| r["invocation"].as_u64().unwrap())
            .collect();
        assert_eq!(
            invocations,
            if max_retries == 1 {
                vec![1, 2, 3]
            } else {
                vec![1, 2, 3, 4]
            }
        );
        assert!(
            first["records"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["decision"] == "compact"
                    && r["outcome"] == "compact_succeeded"
                    && r["invocation"] == 2)
        );
        assert!(
            first["records"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["decision"] == "retry_wait" && r["outcome"] == "wait_completed")
        );
        if max_retries == 1 {
            assert!(
                first["records"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["outcome"] == "budget_rejected")
            );
        } else {
            assert!(
                first["records"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["decision"] == "invoke" && r["outcome"] == "success")
            );
        }
        if tool_round {
            assert_ne!(records[0]["request_id"], records[1]["request_id"]);
        }
        let attempts: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                crate::EngineEvent::ProviderRetry(details) => Some(details.attempt),
                _ => None,
            })
            .collect();
        assert_eq!(attempts, expected_attempts, "{events:?}");
        assert_eq!(
            provider.main_calls.load(Ordering::SeqCst),
            expected_calls,
            "{events:?}"
        );
        assert_eq!(provider.inner.summary_requests.load(Ordering::SeqCst), 1);
        assert_eq!(
            events.iter().any(|event| matches!(
                event,
                crate::EngineEvent::Error(_) | crate::EngineEvent::ProviderFailed { .. }
            )),
            max_retries == 1,
            "{events:?}"
        );
        if tool_round {
            assert!(
                events
                    .iter()
                    .any(|event| matches!(event, crate::EngineEvent::ToolResult { name, output, .. } if name == "read" && !output.is_error)),
                "{events:?}"
            );
        }
    }
}

fn assert_original_stream_http_error(events: &[crate::EngineEvent]) {
    assert!(
        events.iter().any(
            |event| matches!(event, crate::EngineEvent::ProviderFailed { details, .. }
        if details.http_status == Some(400)
            && details.category == kcoder_types::ProviderFailureCategory::ContextLengthExceeded
            && !details.retryable)
        ),
        "{events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, crate::EngineEvent::ProviderRetry(_)))
    );
}

#[tokio::test]
async fn stream_http_context_repeated_rejection_does_not_compact_again() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider {
        repeat_error: true,
        ..Default::default()
    });
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    engine
        .state
        .with_llm_request_history_dir(tmp.path(), "policy-fixture");
    let events = collect_stream_http_events(&engine).await;
    let records = recovery_records(&engine, tmp.path()).await;
    assert!(
        records[0]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["decision"] == "compact" && r["outcome"] == "policy_rejected")
    );
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 1);
    assert_eq!(provider.main_requests.lock().unwrap().len(), 2);
    assert_original_stream_http_error(&events);
}

#[tokio::test]
async fn stream_http_context_partial_response_never_compacts() {
    for partial in [
        StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: "partial".into(),
                role: "assistant".into(),
                content: Vec::new(),
                model: "test".into(),
                stop_reason: None,
                stop_sequence: None,
                usage: None,
            },
        },
        StreamEvent::ContentBlockStart {
            index: 0,
            content_block: ContentBlock::Text {
                text: "partial answer".into(),
            },
        },
        StreamEvent::ContentBlockStart {
            index: 0,
            content_block: ContentBlock::ToolUse {
                id: "partial-tool".into(),
                name: "read".into(),
                input: serde_json::json!({"file_path": "not-executed"}),
            },
        },
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let provider = Arc::new(StreamHttpCompactionProvider {
            partial: vec![partial],
            ..Default::default()
        });
        let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
        let events = collect_stream_http_events(&engine).await;
        assert!(
            events
                .iter()
                .any(|event| matches!(event, crate::EngineEvent::AssistantMessageStarted))
        );
        assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 0);
        assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
        assert!(latest_compact_boundary(&engine.state.messages()).is_none());
        assert_original_stream_http_error(&events);
    }
}

#[tokio::test]
async fn partial_final_context_response_prevents_compaction_replay() {
    for normal_start in [false, true] {
        for sse_error in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            let delta = StreamEvent::ContentBlockDelta {
                index: 0,
                delta: kcoder_types::ContentDelta::TextDelta {
                    text: "partial answer".into(),
                },
            };
            let partial = if normal_start {
                vec![
                    StreamEvent::ContentBlockStart {
                        index: 0,
                        content_block: ContentBlock::Text {
                            text: String::new(),
                        },
                    },
                    delta,
                ]
            } else {
                vec![delta]
            };
            let provider = Arc::new(StreamHttpCompactionProvider {
                partial,
                sse_error,
                ..Default::default()
            });
            let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
            recover_write_lock(&engine.settings, "settings").max_retries = 1;
            let events = collect_stream_http_events(&engine).await;
            assert_eq!(
                provider.summary_requests.load(Ordering::SeqCst),
                0,
                "normal={normal_start}, sse={sse_error}: {events:?}"
            );
            assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
            assert!(latest_compact_boundary(&engine.state.messages()).is_none());
            assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::AssistantTextDelta(text) if text == "partial answer")));
            let failures: Vec<_> = events
                .iter()
                .filter_map(|event| match event {
                    crate::EngineEvent::ProviderFailed { details, .. } => Some(details),
                    _ => None,
                })
                .collect();
            assert_eq!(failures.len(), 1, "{events:?}");
            assert_eq!(
                failures[0].category,
                kcoder_types::ProviderFailureCategory::ContextLengthExceeded
            );
            assert_eq!(
                failures[0].http_status,
                if sse_error { None } else { Some(400) }
            );
            assert!(!failures[0].resume_safe);
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, crate::EngineEvent::ProviderRetry(_)))
            );
        }
    }
}

#[tokio::test]
async fn stream_http_context_training_never_compacts() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider::default());
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    recover_write_lock(&engine.settings, "settings").training_mode = true;
    let events = collect_stream_http_events(&engine).await;
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 0);
    assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
    assert!(latest_compact_boundary(&engine.state.messages()).is_none());
    assert_original_stream_http_error(&events);
}

#[tokio::test]
async fn stream_http_context_failed_compaction_preserves_original_error() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider {
        fail_summary: true,
        ..Default::default()
    });
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    let before = engine.state.messages();
    let events = collect_stream_http_events(&engine).await;
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 1);
    assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
    assert!(latest_compact_boundary(&engine.state.messages()).is_none());
    assert_eq!(engine.state.messages(), before);
    assert_original_stream_http_error(&events);
}

#[tokio::test]
async fn stream_http_context_cancel_during_compaction_does_not_retry_main() {
    use futures::StreamExt;
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider {
        hang_summary: true,
        ..Default::default()
    });
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    engine
        .state
        .with_llm_request_history_dir(tmp.path(), "cancel-fixture");
    let cancel = CancellationToken::new();
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let events = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let (events, ()) = tokio::join!(
            engine
                .run_turn_stream_with_cancel(&prompt, cancel.clone())
                .collect::<Vec<_>>(),
            async {
                provider.summary_started.notified().await;
                cancel.cancel();
            },
        );
        events
    })
    .await
    .expect("cancellation must interrupt a pending summary stream");
    let records = recovery_records(&engine, tmp.path()).await;
    assert_eq!(records.len(), 1);
    assert!(
        records[0]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["decision"] == "compact" && r["outcome"] == "compact_failed")
    );
    assert!(
        records[0]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["decision"] == "stop" && r["outcome"] == "cancelled")
    );
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 1);
    assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
    assert_eq!(provider.summary_dropped.load(Ordering::SeqCst), 1);
    assert!(!recover_read_lock(&engine.auto_compact_state, "auto_compact_state").prefire_in_flight);
    assert!(latest_compact_boundary(&engine.state.messages()).is_none());
    assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::StreamAborted { reason } if reason == "cancelled by user")));
    let provider: Arc<dyn Provider> = provider;
    let permit = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        crate::request_admission::acquire(
            &provider,
            crate::request_admission::RequestClass::SkillReview,
        ),
    )
    .await
    .expect("cancelled summary must release provider admission")
    .unwrap();
    drop(permit);
}

#[tokio::test]
async fn stream_http_context_cancel_after_compaction_does_not_retry_main() {
    use futures::StreamExt;
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider::default());
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    let cancel = CancellationToken::new();
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream_with_cancel(&prompt, cancel.clone());
    let events = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut events = Vec::new();
        while let Some(event) = stream.next().await {
            if matches!(&event, crate::EngineEvent::SystemNotice(text) if text.contains("reactive compact completed")) {
                cancel.cancel();
            }
            events.push(event);
        }
        events
    }).await.unwrap();
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 1);
    assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
    assert!(latest_compact_boundary(&engine.state.messages()).is_some());
    assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::StreamAborted { reason } if reason == "cancelled by user")));
}

#[tokio::test]
async fn stream_http_context_noop_compaction_preserves_original_error() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(StreamHttpCompactionProvider::default());
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    engine
        .state
        .with_llm_request_history_dir(tmp.path(), "noop-fixture");
    engine
        .state
        .set_messages(vec![Message::user_text("current request")]);
    let events = collect_stream_http_events(&engine).await;
    let records = recovery_records(&engine, tmp.path()).await;
    assert!(
        records[0]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["decision"] == "compact" && r["outcome"] == "compact_noop")
    );
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 0);
    assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
    assert!(latest_compact_boundary(&engine.state.messages()).is_none());
    assert_original_stream_http_error(&events);
}

#[tokio::test(flavor = "current_thread")]
async fn stream_http_context_cancel_during_commit_finishes_history_and_sidecar() {
    assert_recovery_stop_during_commit(false, true).await;
}

#[tokio::test(flavor = "current_thread")]
async fn recovery_total_deadline_during_commit_finishes_history_and_sidecar() {
    assert_recovery_stop_during_commit(true, false).await;
}

#[tokio::test(flavor = "current_thread")]
async fn recovery_total_deadline_user_cancel_has_priority_during_commit() {
    assert_recovery_stop_during_commit(true, true).await;
}

async fn assert_recovery_stop_during_commit(deadline: bool, user_cancel: bool) {
    use futures::StreamExt;
    use std::task::Poll;

    let tmp = tempfile::tempdir().unwrap();
    let history = tmp.path().join("commit-cancel.jsonl");
    let provider = Arc::new(StreamHttpCompactionProvider::default());
    let engine = stream_http_compaction_engine(tmp.path(), provider.clone());
    engine
        .state
        .with_llm_request_history_dir(tmp.path(), "commit-fixture");
    if deadline {
        engine
            .settings
            .write()
            .unwrap()
            .recovery
            .provider
            .total_timeout_ms = Some(500);
    }
    let initial_messages = engine.state.messages();
    engine.state.set_messages(Vec::new());
    engine.state.with_history_path(&history);
    for message in initial_messages {
        engine.state.add_message(message);
    }
    engine.state.flush_history().await.unwrap();
    let sidecar = engine.state.session_state_path().unwrap();
    let cancel = CancellationToken::new();
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream_with_cancel(&prompt, cancel.clone());
    let events = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut events = Vec::new();
        loop {
            match futures::poll!(stream.next()) {
                Poll::Ready(Some(event)) => events.push(event),
                Poll::Ready(None) => panic!("turn ended before reaching the commit wait"),
                Poll::Pending => {
                    if latest_compact_boundary(&engine.state.messages()).is_some() {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            }
        }
        // On this single-thread runtime the writer cannot acknowledge the newly
        // enqueued boundary until we yield. Remove only the temporary sidecar so
        // its recreation proves the post-acknowledgement finalizer actually ran.
        std::fs::remove_file(&sidecar).unwrap();
        if deadline {
            // The stream remains suspended at its commit wait while the absolute
            // deadline passes; this does not depend on a scheduler race.
            tokio::time::sleep(std::time::Duration::from_millis(550)).await;
        }
        if user_cancel {
            cancel.cancel();
        }
        events.extend(stream.collect::<Vec<_>>().await);
        events
    })
    .await
    .expect("commit must finish before cancellation terminates the turn");
    let records = recovery_records(&engine, tmp.path()).await;
    assert!(
        records[0]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["decision"] == "compact" && r["outcome"] == "compact_succeeded")
    );
    let stop = if user_cancel {
        "cancelled"
    } else {
        "deadline_exceeded"
    };
    assert!(
        records[0]["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["decision"] == "stop" && r["outcome"] == stop)
    );

    assert!(
        sidecar.exists(),
        "cancellation skipped the post-commit sidecar write"
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&sidecar).unwrap()).unwrap();
    assert_eq!(persisted["conversation_started"], true);
    assert_eq!(
        persisted["updated_at_ms"],
        engine.state.session_timestamps_ms().1
    );
    engine.state.flush_history().await.unwrap();
    let restored = kcoder_state::AppState::new(tmp.path());
    restored.resume_from_history(&history).unwrap();
    // Replay strips the internal compact marker from the summary's visible text.
    let visible = |messages: Vec<Message>| {
        messages
            .into_iter()
            .map(|message| {
                message
                    .preview(100_000)
                    .replace(crate::context::compact::COMPACT_BOUNDARY_MARKER, "")
                    .trim()
                    .to_string()
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        visible(restored.messages()),
        visible(engine.state.messages())
    );
    assert_eq!(provider.summary_requests.load(Ordering::SeqCst), 1);
    assert_eq!(provider.main_requests.lock().unwrap().len(), 1);
    if user_cancel {
        assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::StreamAborted { reason } if reason == "cancelled by user")));
        assert!(!events.iter().any(|event| matches!(
            event,
            crate::EngineEvent::Error(_) | crate::EngineEvent::ProviderFailed { .. }
        )));
    } else {
        assert!(events.iter().any(|event| matches!(event, crate::EngineEvent::Error(text) if text.contains("recovery deadline"))), "{events:?}");
        assert!(!engine.is_cancelled());
    }
    assert!(!events.iter().any(|event| matches!(event, crate::EngineEvent::SystemNotice(text) if text.contains("reactive compact completed"))));
}

#[derive(Debug)]
struct ExpandingCompactionProvider;

impl Provider for ExpandingCompactionProvider {
    fn name(&self) -> &'static str {
        "expanding-compaction"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let text = format!(
            "<analysis>checked</analysis><summary>{}</summary>",
            "summary expansion ".repeat(2_000)
        );
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-expanding-compaction".to_string(),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: "test".to_string(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta { text },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: Some("end_turn".to_string()),
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
struct MalformedCompactionProvider;

impl Provider for MalformedCompactionProvider {
    fn name(&self) -> &'static str {
        "malformed-compaction"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-malformed-compaction".to_string(),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: "test".to_string(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: "<analysis>missing summary</analysis>".to_string(),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: Some("end_turn".to_string()),
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
struct RepairingCompactionProvider {
    requests: Arc<AtomicUsize>,
}

impl Provider for RepairingCompactionProvider {
    fn name(&self) -> &'static str {
        "repairing-compaction"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let request = self.requests.fetch_add(1, Ordering::SeqCst);
        let text = match request {
            0 => "<analysis>checked</analysis><summary>duplicate <summary>tag</summary>",
            1 => "<analysis>repaired</analysis><summary>compact summary</summary>",
            _ => "main response",
        }
        .to_string();
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: format!("msg-repairing-{request}"),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: "test".to_string(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta { text },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: Some("end_turn".to_string()),
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
struct InvalidTerminalCompactionProvider {
    leave_text_block_open: bool,
}

#[derive(Debug)]
struct SummaryInputRecordingProvider {
    prompts: Arc<std::sync::Mutex<Vec<String>>>,
}

impl Provider for SummaryInputRecordingProvider {
    fn name(&self) -> &'static str {
        "summary-input-recording"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.prompts.lock().unwrap().push(
            request
                .messages
                .iter()
                .map(|message| message.preview(100_000))
                .collect::<Vec<_>>()
                .join("\n"),
        );
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-summary-input-recording".to_string(),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: "test".to_string(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: "<analysis>checked</analysis><summary>evidence-preserving summary</summary>".to_string(),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: Some("end_turn".to_string()),
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

impl Provider for InvalidTerminalCompactionProvider {
    fn name(&self) -> &'static str {
        "invalid-terminal-compaction"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let leave_text_block_open = self.leave_text_block_open;
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "msg-invalid-terminal".to_string(),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: "test".to_string(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: "<analysis>checked</analysis><summary>valid text</summary>".to_string(),
                },
            });
            if !leave_text_block_open {
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            }
            yield Ok(StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: Some(if leave_text_block_open {
                        "end_turn".to_string()
                    } else {
                        "max_tokens".to_string()
                    }),
                    stop_sequence: None,
                    usage: None,
                },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

fn assistant_tool_use(id: &str, name: &str) -> Message {
    Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: id.to_string(),
            name: name.to_string(),
            input: serde_json::json!({"file_path": format!("{id}.txt")}),
        }],
        usage: None,
    }
}

fn user_tool_result(id: &str, text: String) -> Message {
    Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: id.to_string(),
            content: vec![ContentBlock::Text { text }],
            is_error: Some(false),
        }],
    }
}

fn tool_result_text(message: &Message) -> &str {
    let Message::User { content, .. } = message else {
        panic!("expected user tool result");
    };
    let Some(ContentBlock::ToolResult { content, .. }) = content.first() else {
        panic!("expected tool result block");
    };
    let Some(ContentBlock::Text { text }) = content.first() else {
        panic!("expected text tool result");
    };
    text
}

#[tokio::test]
async fn summary_boundary_is_preserved_while_suffix_tool_results_are_recompressed() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = lifecycle_test_engine(tmp.path());
    let new_result = "new suffix result ".repeat(80);

    engine.state.set_messages(vec![
        Message::user_text("Earlier conversation summary: previous compact summary"),
        assistant_tool_use("new-read", "read"),
        user_tool_result("new-read", new_result),
        Message::assistant_text("latest assistant response"),
    ]);

    let result = engine.perform_compaction(false).await.unwrap();

    assert_eq!(result.summary, "");
    let messages = engine.state.messages();
    assert!(
        messages[0]
            .preview(1000)
            .starts_with("Earlier conversation summary:")
    );
    assert_eq!(
        tool_result_text(&messages[2]),
        crate::context::TOOL_RESULT_CLEARED_MESSAGE
    );
}

#[tokio::test]
async fn threshold_micro_compact_revokes_duplicate_read_suppression_but_keeps_stale_write_snapshot()
{
    let tmp = tempfile::tempdir().unwrap();
    let engine = lifecycle_test_engine(tmp.path());
    let path = tmp.path().join("old-read.txt");
    let modified = std::time::UNIX_EPOCH + std::time::Duration::from_secs(42);
    engine.state.record_read_tool_snapshot(
        path.clone(),
        Some("snapshot content".to_string()),
        Some(modified),
        None,
        None,
    );
    engine
        .state
        .record_read_tool_call_key("old-read", path.clone(), None, None);
    engine.state.set_messages(vec![
        assistant_tool_use("old-read", "read"),
        user_tool_result("old-read", "small read result".to_string()),
        Message::assistant_text("latest assistant response"),
    ]);

    let no_op = engine.perform_compaction(false).await.unwrap();

    assert!(!no_op.did_compact);
    assert!(
        engine
            .state
            .file_read_snapshot(&path)
            .unwrap()
            .from_read_tool
    );

    engine.state.set_messages(vec![
        assistant_tool_use("old-read", "read"),
        user_tool_result("old-read", "large read result ".repeat(80)),
        Message::assistant_text("latest assistant response"),
    ]);

    let result = engine.perform_compaction(false).await.unwrap();

    assert!(!result.did_compact);
    assert_eq!(
        tool_result_text(&engine.state.messages()[1]),
        crate::context::TOOL_RESULT_CLEARED_MESSAGE
    );
    let snapshot = engine.state.file_read_snapshot(&path).unwrap();
    assert!(!snapshot.from_read_tool);
    assert_eq!(snapshot.content.as_deref(), Some("snapshot content"));
    assert_eq!(snapshot.modified, Some(modified));
}

#[tokio::test]
async fn post_compact_attachments_remain_after_summary_boundary() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );

    engine.state.set_messages(vec![
        Message::user_text("large older request ".repeat(300)),
        Message::assistant_text("large older response ".repeat(300)),
        Message::user_text("large middle request ".repeat(300)),
        Message::assistant_text("large middle response ".repeat(300)),
        assistant_tool_use("old-read", "read"),
        user_tool_result("old-read", "old file content ".repeat(80)),
        Message::user_text("recent user request"),
        Message::assistant_text("recent assistant response"),
    ]);

    let result = engine.perform_compaction(true).await.unwrap();

    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert!(
        result.messages[0]
            .preview(20_000)
            .starts_with(crate::context::compact::COMPACT_BOUNDARY_MARKER)
    );
    assert!(result.messages.iter().skip(1).any(|message| {
        message
            .preview(20_000)
            .contains("Recent file read retained after compaction")
    }));
    assert_eq!(
        latest_compact_boundary(&result.messages)
            .unwrap()
            .suffix_start,
        1
    );
}

#[tokio::test]
async fn full_summary_reads_old_tool_evidence_before_it_is_compacted() {
    let tmp = tempfile::tempdir().unwrap();
    let history_path = tmp.path().join("evidence-order.jsonl");
    let prompts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let engine = test_engine_with_settings(
        Arc::new(SummaryInputRecordingProvider {
            prompts: Arc::clone(&prompts),
        }),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );
    engine.state.with_history_path(&history_path);
    let read_path = tmp.path().join("old-read.txt");
    let evidence = format!("UNIQUE_OLD_TOOL_EVIDENCE {}", "detail ".repeat(180));
    engine.state.record_read_tool_snapshot(
        read_path.clone(),
        Some(evidence.clone()),
        None,
        None,
        None,
    );
    engine
        .state
        .record_read_tool_call_key("old-read", read_path.clone(), None, None);
    for message in [
        Message::user_text("old request"),
        assistant_tool_use("old-read", "read"),
        user_tool_result("old-read", evidence),
        Message::assistant_text("old result inspected"),
        Message::user_text("middle request"),
        Message::assistant_text("middle response"),
        Message::user_text("current request"),
    ] {
        engine.state.add_message(message);
    }

    let result = engine.perform_compaction(true).await.unwrap();

    assert!(result.did_compact);
    let prompts = prompts.lock().unwrap();
    assert_eq!(prompts.len(), 1);
    assert!(prompts[0].contains("UNIQUE_OLD_TOOL_EVIDENCE"));
    assert!(!prompts[0].contains(crate::context::TOOL_RESULT_CLEARED_MESSAGE));
    drop(prompts);
    let snapshot = engine.state.file_read_snapshot(&read_path).unwrap();
    assert!(!snapshot.from_read_tool);
    assert!(snapshot.anchor_pending);
    assert!(snapshot.full_body_compacted);
    assert!(
        snapshot
            .content
            .as_deref()
            .is_some_and(|content| content.contains("UNIQUE_OLD_TOOL_EVIDENCE"))
    );
    assert!(latest_compact_boundary(&engine.state.messages()).is_some());

    let persisted = std::fs::read_to_string(&history_path).unwrap();
    let evidence_index = persisted.find("UNIQUE_OLD_TOOL_EVIDENCE").unwrap();
    let boundary_index = persisted.find("compact_boundary").unwrap();
    assert!(evidence_index < boundary_index);

    let restored = kcoder_state::AppState::new(tmp.path());
    restored.with_history_path(tmp.path().join("restored-evidence-order.jsonl"));
    restored.resume_from_history(&history_path).unwrap();
    let restored_visible = restored
        .messages()
        .iter()
        .map(|message| message.preview(100_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(restored_visible.contains("evidence-preserving summary"));
    assert!(!restored_visible.contains("UNIQUE_OLD_TOOL_EVIDENCE"));
}

#[tokio::test]
async fn cold_turn_runs_full_summary_before_time_based_tool_cleanup() {
    let tmp = tempfile::tempdir().unwrap();
    let prompts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut settings = Settings {
        context_window_tokens: Some(100_000),
        context_system_tokens: Some(0),
        context_tools_tokens: Some(0),
        context_output_headroom: Some(0),
        auto_compact_threshold_tokens: Some(10),
        estimated_tool_growth_tokens: Some(1),
        max_tokens: Some(1),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    settings.time_based_micro_compact.gap_threshold_minutes = 0;
    settings.time_based_micro_compact.keep_recent = 1;
    let engine = test_engine_with_settings(
        Arc::new(SummaryInputRecordingProvider {
            prompts: Arc::clone(&prompts),
        }),
        tmp.path(),
        settings,
    );
    let evidence = format!("COLD_TURN_RAW_TOOL_EVIDENCE {}", "detail ".repeat(180));
    for message in [
        Message::user_text("large old request ".repeat(100)),
        assistant_tool_use("cold-old-read", "read"),
        user_tool_result("cold-old-read", evidence),
        Message::assistant_text("large old response ".repeat(100)),
        assistant_tool_use("cold-recent-read", "read"),
        user_tool_result("cold-recent-read", "recent tool output".to_string()),
        Message::user_text("current request"),
    ] {
        engine.state.add_message(message);
    }

    let _events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    let prompts = prompts.lock().unwrap();
    assert!(prompts.len() >= 2, "应先完成摘要，再发起主请求");
    assert!(prompts[0].contains("COLD_TURN_RAW_TOOL_EVIDENCE"));
    assert!(!prompts[0].contains(crate::context::TOOL_RESULT_CLEARED_MESSAGE));
}

#[tokio::test]
async fn actual_oversized_tool_result_is_reduced_before_the_next_request() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(10_000),
        context_output_headroom: Some(2_000),
        estimated_tool_growth_tokens: Some(1_000),
        max_tokens: Some(2_000),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    engine.state.set_messages(vec![
        Message::user_text("run the command"),
        assistant_tool_use("huge-bash", "bash"),
        user_tool_result("huge-bash", "ACTUAL_TOOL_RESULT ".repeat(8_000)),
    ]);
    let budget = engine.context_budget();
    assert!(TokenCounter::count(&engine.state.messages()) > budget.hard_input_limit());

    assert!(!engine.maybe_compact_conversation(1).await);

    let visible = engine
        .state
        .messages()
        .iter()
        .map(|message| message.preview(20_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(visible.contains("<persisted-output>"));
    assert!(TokenCounter::count(&engine.state.messages()) < budget.hard_input_limit());
    assert_eq!(
        requests.load(Ordering::SeqCst),
        0,
        "工具存储层已恢复安全预算时不应再消耗一次 summary 请求"
    );
}

#[tokio::test]
async fn actual_large_assistant_usage_is_compacted_before_the_next_request() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(256_000),
        context_output_headroom: Some(100_000),
        estimated_tool_growth_tokens: Some(15_000),
        max_tokens: Some(100_000),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    engine.state.set_messages(vec![
        Message::user_text("old request"),
        Message::Assistant {
            content: vec![ContentBlock::Text {
                text: "large assistant response".to_string(),
            }],
            usage: Some(kcoder_types::Usage {
                input_tokens: 80_000,
                output_tokens: 90_000,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                total_tokens: None,
                iterations: None,
            }),
        },
        Message::user_text("current request must remain verbatim"),
    ]);
    let budget = engine.context_budget();
    assert!(TokenCounter::count(&engine.state.messages()) > budget.hard_input_limit());

    assert!(engine.maybe_compact_conversation(1).await);

    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert!(TokenCounter::count(&engine.state.messages()) < budget.hard_input_limit());
    let visible = engine
        .state
        .messages()
        .iter()
        .map(|message| message.preview(20_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(visible.contains("current request must remain verbatim"));
    assert!(latest_compact_boundary(&engine.state.messages()).is_some());
}

#[tokio::test]
async fn training_mode_never_starts_automatic_model_compaction() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.training_mode = true;
    settings.context_window_tokens = Some(10_000);
    settings.context_output_headroom = Some(2_000);
    settings.estimated_tool_growth_tokens = Some(1_000);
    settings.max_tokens = Some(2_000);
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    engine.state.set_messages(vec![
        Message::user_text(format!("old request {}", "history ".repeat(8_000))),
        Message::assistant_text(format!("old response {}", "evidence ".repeat(8_000))),
        Message::user_text("current request"),
    ]);

    assert!(!engine.maybe_compact_conversation(1).await);
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    assert!(latest_compact_boundary(&engine.state.messages()).is_none());
}

#[tokio::test]
async fn non_reducing_compaction_does_not_persist_boundary_or_summary() {
    let tmp = tempfile::tempdir().unwrap();
    let history_path = tmp.path().join("non-reducing-compaction.jsonl");
    let engine = test_engine_with_settings(
        Arc::new(ExpandingCompactionProvider),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );
    engine.state.with_history_path(&history_path);
    let original_messages = vec![
        Message::user_text("old user one"),
        Message::assistant_text("old assistant one"),
        Message::user_text("old user two"),
        Message::assistant_text("old assistant two"),
        Message::user_text("old user three"),
        Message::assistant_text("old assistant three"),
        Message::user_text("recent user"),
        Message::assistant_text("recent assistant"),
    ];
    engine.state.set_messages(original_messages.clone());

    let error = engine
        .perform_compaction(true)
        .await
        .expect_err("an expanding summary must fail before persistence");

    assert!(error.to_string().contains("did not reduce context"));
    assert_eq!(engine.state.messages(), original_messages);
    let transcript = std::fs::read_to_string(&history_path).unwrap_or_default();
    assert!(!transcript.contains("\"subtype\":\"compact_boundary\""));
    assert!(!transcript.contains("\"isCompactSummary\":true"));
}

#[tokio::test]
async fn malformed_compaction_does_not_persist_boundary_or_summary() {
    let tmp = tempfile::tempdir().unwrap();
    let history_path = tmp.path().join("malformed-compaction.jsonl");
    let engine = test_engine_with_settings(
        Arc::new(MalformedCompactionProvider),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );
    engine.state.with_history_path(&history_path);
    let original_messages = vec![
        Message::user_text("old user one"),
        Message::assistant_text("old assistant one"),
        Message::user_text("old user two"),
        Message::assistant_text("old assistant two"),
        Message::user_text("old user three"),
        Message::assistant_text("old assistant three"),
        Message::user_text("recent user"),
        Message::assistant_text("recent assistant"),
    ];
    engine.state.set_messages(original_messages.clone());

    let error = engine
        .perform_compaction(true)
        .await
        .expect_err("malformed compaction output must fail before persistence");

    assert!(error.to_string().contains("summary"));
    assert_eq!(engine.state.messages(), original_messages);
    let transcript = std::fs::read_to_string(&history_path).unwrap_or_default();
    assert!(!transcript.contains("\"subtype\":\"compact_boundary\""));
    assert!(!transcript.contains("\"isCompactSummary\":true"));
}

#[tokio::test]
async fn repaired_auto_compaction_emits_recovered_without_failed_event() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(100_000),
        context_system_tokens: Some(0),
        context_tools_tokens: Some(0),
        context_output_headroom: Some(0),
        auto_compact_threshold_tokens: Some(10),
        estimated_tool_growth_tokens: Some(1),
        max_tokens: Some(1),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(RepairingCompactionProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    engine.state.set_messages(vec![
        Message::user_text("old user one ".repeat(100)),
        Message::assistant_text("old assistant one ".repeat(100)),
        Message::user_text("old user two ".repeat(100)),
        Message::assistant_text("old assistant two ".repeat(100)),
        Message::user_text("recent user three ".repeat(100)),
    ]);

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    let recovered = events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::CompactionRecovered { details } => Some(details),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].phase, "auto_full");
    assert_eq!(recovered[0].reason, "protocol_tag_count");
    assert_eq!(recovered[0].attempt, 1);
    assert!(recovered[0].will_retry);
    assert!(!recovered[0].state_mutated);
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::CompactionFailed { .. }))
    );
    assert_eq!(requests.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn exhausted_auto_compaction_repair_still_emits_failed_event() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        context_window_tokens: Some(100_000),
        context_system_tokens: Some(0),
        context_tools_tokens: Some(0),
        context_output_headroom: Some(0),
        auto_compact_threshold_tokens: Some(10),
        estimated_tool_growth_tokens: Some(1),
        max_tokens: Some(1),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine =
        test_engine_with_settings(Arc::new(MalformedCompactionProvider), tmp.path(), settings);
    engine.state.set_messages(vec![
        Message::user_text("old user one ".repeat(100)),
        Message::assistant_text("old assistant one ".repeat(100)),
        Message::user_text("old user two ".repeat(100)),
        Message::assistant_text("old assistant two ".repeat(100)),
        Message::user_text("recent user three ".repeat(100)),
    ]);

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    assert!(events.iter().any(|event| matches!(
        event,
        EngineEvent::CompactionFailed { error, details: Some(details) }
            if error.contains("repair budget exhausted")
                && details.reason == "protocol_tag_count"
                && !details.will_retry
    )));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::CompactionRecovered { .. }))
    );
}

#[tokio::test]
async fn invalid_terminal_compactions_never_mutate_state_or_persist() {
    for (case, leave_text_block_open) in [("max-tokens", false), ("unclosed-content-block", true)] {
        let tmp = tempfile::tempdir().unwrap();
        let history_path = tmp.path().join(format!("invalid-{case}.jsonl"));
        let engine = test_engine_with_settings(
            Arc::new(InvalidTerminalCompactionProvider {
                leave_text_block_open,
            }),
            tmp.path(),
            settings_using_main_summary_runtime(Settings::default()),
        );
        engine.state.with_history_path(&history_path);
        let original_messages = vec![
            Message::user_text("old user one"),
            Message::assistant_text("old assistant one"),
            Message::user_text("old user two"),
            Message::assistant_text("old assistant two"),
            Message::user_text("old user three"),
            Message::assistant_text("old assistant three"),
            Message::user_text("recent user"),
            Message::assistant_text("recent assistant"),
        ];
        engine.state.set_messages(original_messages.clone());

        assert!(
            engine.perform_compaction(true).await.is_err(),
            "{case} must fail before persistence"
        );
        assert_eq!(engine.state.messages(), original_messages);
        let transcript = std::fs::read_to_string(&history_path).unwrap_or_default();
        assert!(!transcript.contains("\"subtype\":\"compact_boundary\""));
        assert!(!transcript.contains("\"isCompactSummary\":true"));
    }
}

#[tokio::test]
async fn no_op_manual_compaction_does_not_append_post_compact_attachments() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("AGENTS.md"), "NOOP_INTERNAL_PROJECT_RULE").unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );

    engine.state.set_messages(vec![
        Message::user_text("recent user request"),
        Message::assistant_text("recent assistant response"),
    ]);

    let result = engine.perform_compaction(true).await.unwrap();

    assert!(!result.did_compact);
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    assert_eq!(result.pre_compact_tokens, result.post_compact_tokens);
    let state_text = engine
        .state
        .messages()
        .into_iter()
        .map(|message| message.preview(20_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(state_text.contains("recent user request"));
    assert!(!state_text.contains("Project instructions (KCODER.md):"));
    assert!(!state_text.contains("NOOP_INTERNAL_PROJECT_RULE"));
}

#[tokio::test]
async fn compaction_does_not_record_structured_summary_when_memory_store_is_available() {
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
        Message::user_text("large older request ".repeat(300)),
        Message::assistant_text("large older response ".repeat(300)),
        Message::user_text("large middle request ".repeat(300)),
        Message::assistant_text("large middle response ".repeat(300)),
        assistant_tool_use("old-read", "read"),
        user_tool_result("old-read", "old file content ".repeat(80)),
        Message::user_text("recent user request"),
        Message::assistant_text("recent assistant response"),
    ]);

    let result = engine.perform_compaction(true).await.unwrap();

    assert_eq!(result.summary, "auto compact summary");
    let summaries = engine
        .memory_manager
        .structured_summaries_for_session(&engine.session_id(), 10)
        .unwrap();
    assert!(
        summaries.is_empty(),
        "session compaction must not store compacted context as structured SQLite memory"
    );
}

#[test]
fn engine_applies_time_based_micro_compact_before_cold_main_turn() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default();
    settings.time_based_micro_compact.gap_threshold_minutes = 0;
    settings.time_based_micro_compact.keep_recent = 1;
    let engine = test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), settings);
    engine.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "old-call".to_string(),
            name: "bash".to_string(),
            input: serde_json::json!({"command":"old"}),
        }],
        usage: None,
    });
    engine.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "old-call".to_string(),
            content: vec![ContentBlock::Text {
                text: "old output".to_string(),
            }],
            is_error: Some(false),
        }],
    });
    engine.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "recent-call".to_string(),
            name: "read".to_string(),
            input: serde_json::json!({"file_path":"recent.rs"}),
        }],
        usage: None,
    });
    engine.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "recent-call".to_string(),
            content: vec![ContentBlock::Text {
                text: "recent output".to_string(),
            }],
            is_error: Some(false),
        }],
    });
    engine.state.add_message(Message::assistant_text("ready"));
    engine.state.add_message(Message::user_text("continue"));

    assert_eq!(engine.maybe_apply_time_based_micro_compact(), 1);

    let rendered = engine
        .state
        .messages()
        .iter()
        .map(|message| message.preview(2_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(rendered.contains(crate::context::tool_storage::TOOL_RESULT_CLEARED_MESSAGE));
    assert!(rendered.contains("recent output"));
}

#[test]
fn time_based_micro_compact_revokes_duplicate_read_suppression_but_keeps_stale_write_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default();
    settings.time_based_micro_compact.gap_threshold_minutes = 0;
    settings.time_based_micro_compact.keep_recent = 1;
    let engine = test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), settings);
    let path = tmp.path().join("old-read.txt");
    let modified = std::time::UNIX_EPOCH + std::time::Duration::from_secs(42);
    engine.state.record_read_tool_snapshot(
        path.clone(),
        Some("snapshot content".to_string()),
        Some(modified),
        None,
        None,
    );
    engine
        .state
        .record_read_tool_call_key("old-read", path.clone(), None, None);
    for message in [
        assistant_tool_use("old-read", "read"),
        user_tool_result("old-read", "old read output".to_string()),
        Message::assistant_text("ready"),
        Message::user_text("continue"),
    ] {
        engine.state.add_message(message);
    }

    assert_eq!(engine.maybe_apply_time_based_micro_compact(), 0);
    assert!(
        engine
            .state
            .file_read_snapshot(&path)
            .unwrap()
            .from_read_tool
    );

    let recent_path = tmp.path().join("recent-call.txt");
    engine.state.record_read_tool_snapshot(
        recent_path.clone(),
        Some("recent snapshot".to_string()),
        Some(modified),
        None,
        None,
    );
    engine
        .state
        .record_read_tool_call_key("recent-call", recent_path.clone(), None, None);

    for message in [
        assistant_tool_use("recent-call", "read"),
        user_tool_result("recent-call", "recent read output".to_string()),
        Message::assistant_text("ready again"),
        Message::user_text("continue again"),
    ] {
        engine.state.add_message(message);
    }

    assert_eq!(engine.maybe_apply_time_based_micro_compact(), 1);

    assert_eq!(
        tool_result_text(&engine.state.messages()[1]),
        crate::context::TOOL_RESULT_CLEARED_MESSAGE
    );
    let snapshot = engine.state.file_read_snapshot(&path).unwrap();
    assert!(!snapshot.from_read_tool);
    assert!(snapshot.anchor_pending);
    assert_eq!(snapshot.content.as_deref(), Some("snapshot content"));
    assert_eq!(snapshot.modified, Some(modified));
    let recent_snapshot = engine.state.file_read_snapshot(&recent_path).unwrap();
    assert!(recent_snapshot.from_read_tool);
    assert!(!recent_snapshot.anchor_pending);
}

#[tokio::test]
async fn hard_compact_does_not_trust_later_boundary_marker() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(20_000),
        context_system_tokens: Some(0),
        context_tools_tokens: Some(0),
        context_output_headroom: Some(0),
        ..Settings::default()
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );

    engine.state.set_messages(vec![
        Message::user_text("stale pre-boundary user ".repeat(12_000)),
        Message::assistant_text("stale pre-boundary assistant ".repeat(12_000)),
        Message::user_text("Earlier conversation summary: compacted old work"),
        Message::user_text("recent user request"),
    ]);

    assert!(engine.maybe_compact_conversation(1).await);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    let visible = messages_after_latest_compact_boundary(&engine.state.messages())
        .iter()
        .map(|message| message.preview(20_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(visible.contains("recent user request"));
    assert!(!visible.contains("stale pre-boundary user"));
}

#[tokio::test]
async fn auto_compact_skips_immediate_follow_up_after_success() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(100_000),
        context_system_tokens: Some(0),
        context_tools_tokens: Some(0),
        context_output_headroom: Some(0),
        auto_compact_threshold_tokens: Some(10),
        estimated_tool_growth_tokens: Some(1),
        max_tokens: Some(1),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );

    engine.state.set_messages(vec![
        Message::user_text("old user one ".repeat(100)),
        Message::assistant_text("old assistant one ".repeat(100)),
        Message::user_text("old user two ".repeat(100)),
        Message::assistant_text("old assistant two ".repeat(100)),
        Message::user_text("recent user three ".repeat(100)),
        Message::assistant_text("recent assistant three ".repeat(100)),
    ]);

    assert!(engine.maybe_compact_conversation(1).await);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    let (pre, post) = engine.last_auto_compact_tokens();
    assert!(
        pre > post,
        "a successful compaction must record shrinking token counts, got {pre} -> {post}"
    );

    assert!(!engine.maybe_compact_conversation(2).await);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn auto_compact_cooldown_survives_restarted_turn_counter() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(100_000),
        context_system_tokens: Some(0),
        context_tools_tokens: Some(0),
        context_output_headroom: Some(0),
        auto_compact_threshold_tokens: Some(10),
        estimated_tool_growth_tokens: Some(1),
        max_tokens: Some(1),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    let oversized = || {
        vec![
            Message::user_text("old user one ".repeat(100)),
            Message::assistant_text("old assistant one ".repeat(100)),
            Message::user_text("old user two ".repeat(100)),
            Message::assistant_text("old assistant two ".repeat(100)),
            Message::user_text("recent user three ".repeat(100)),
            Message::assistant_text("recent assistant three ".repeat(100)),
        ]
    };

    engine.state.set_messages(oversized());
    assert!(engine.maybe_compact_conversation(1).await);

    engine.state.set_messages(oversized());
    assert!(
        !engine.maybe_compact_conversation(1).await,
        "新顶层消息把 turn_count 重置为 1 时，第一轮检查仍应处于 cooldown"
    );
    assert!(
        engine.maybe_compact_conversation(1).await,
        "第二轮检查应结束 cooldown，不能因 turn_count 重置而永久跳过压缩"
    );
    assert_eq!(requests.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn hard_limit_bypasses_cooldown() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(10_000),
        context_output_headroom: Some(0),
        auto_compact_threshold_tokens: Some(10),
        estimated_tool_growth_tokens: Some(1),
        max_tokens: Some(1),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    let oversized = || {
        vec![
            Message::user_text("old user ".repeat(1_000)),
            Message::assistant_text("old assistant ".repeat(1_000)),
            Message::user_text("middle user ".repeat(1_000)),
            Message::assistant_text("middle assistant ".repeat(1_000)),
            Message::user_text("current request ".repeat(1_000)),
        ]
    };

    engine.state.set_messages(oversized());
    assert!(engine.maybe_compact_conversation(1).await);
    engine.state.set_messages(oversized());
    assert!(
        engine.maybe_compact_conversation(1).await,
        "超过 hard limit 时不能被 cooldown 放行"
    );
    assert_eq!(requests.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn prefire_waits_while_session_memory_update_is_running() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(100_000),
        context_output_headroom: Some(12_000),
        auto_compact_threshold_tokens: Some(76_000),
        prefire_threshold_tokens: Some(100),
        estimated_tool_growth_tokens: Some(1),
        max_tokens: Some(1),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    engine.state.set_messages(vec![
        Message::user_text("old request ".repeat(500)),
        Message::assistant_text("old response ".repeat(500)),
        Message::user_text("recent request"),
    ]);
    engine
        .session_memory_update_running
        .store(true, Ordering::SeqCst);

    assert!(!engine.maybe_compact_conversation(1).await);
    tokio::task::yield_now().await;
    assert_eq!(
        requests.load(Ordering::SeqCst),
        0,
        "Session Memory 更新运行时不能启动竞争的 prefire"
    );
}

#[tokio::test]
async fn prefire_starts_when_memory_messages_fit_but_full_request_does_not() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let mut settings = settings_using_main_summary_runtime(Settings::default());
    settings.context_window_tokens = Some(100_000);
    settings.context_output_headroom = Some(12_000);
    settings.auto_compact_threshold_tokens = Some(80_000);
    settings.prefire_threshold_tokens = Some(100);
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
    engine.note_static_prefix(
        &MessagesRequest::new("test", Vec::new()).with_system("S".repeat(240_000)),
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
        Message::user_text("old alpha request ".repeat(200)),
        Message::assistant_text("old alpha response ".repeat(200)),
        Message::user_text("old gamma request ".repeat(200)),
        Message::assistant_text("old gamma response ".repeat(200)),
        Message::user_text("recent beta request"),
        Message::assistant_text("recent beta response"),
    ]);

    assert!(!engine.maybe_compact_conversation(1).await);
    for _ in 0..50 {
        if requests.load(Ordering::SeqCst) > 0 {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(
        requests.load(Ordering::SeqCst),
        1,
        "完整请求无法压到 soft 时，Session Memory 不应抑制 prefire"
    );
}

#[tokio::test]
async fn configured_max_output_does_not_force_compaction_below_soft_limit() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(256_000),
        context_output_headroom: Some(100_000),
        estimated_tool_growth_tokens: Some(15_000),
        max_tokens: Some(100_000),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    engine.state.set_messages(vec![
        Message::user_text("old user"),
        Message::assistant_text("old assistant"),
        Message::user_text("middle user"),
        Message::Assistant {
            content: vec![ContentBlock::Text {
                text: "middle assistant".to_string(),
            }],
            usage: Some(kcoder_types::Usage {
                input_tokens: 41_500,
                output_tokens: 500,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                total_tokens: None,
                iterations: None,
            }),
        },
        Message::user_text("current request"),
    ]);
    let current = TokenCounter::count(&engine.state.messages());
    assert!(
        (41_000..50_000).contains(&current),
        "测试前提：复现 Kimi 静态前缀后的 41–48k 完整上下文，实际 {current}"
    );

    assert!(!engine.maybe_compact_conversation(1).await);
    tokio::task::yield_now().await;
    assert_eq!(requests.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn hard_limit_with_three_messages_compacts_previous_complete_round() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(5_000),
        context_output_headroom: Some(0),
        auto_compact_threshold_tokens: Some(4_000),
        estimated_tool_growth_tokens: Some(1),
        max_tokens: Some(1),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    engine.state.set_messages(vec![
        Message::user_text(format!("OLD_ROUND {}", "old request ".repeat(1_000))),
        Message::assistant_text("OLD_ROUND answer"),
        Message::user_text(format!(
            "CURRENT_REQUEST {}",
            "current request ".repeat(1_000)
        )),
    ]);

    assert!(engine.maybe_compact_conversation(1).await);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    let visible = messages_after_latest_compact_boundary(&engine.state.messages())
        .iter()
        .map(|message| message.preview(50_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(visible.contains("CURRENT_REQUEST"));
    assert!(!visible.contains("OLD_ROUND old request"));
}

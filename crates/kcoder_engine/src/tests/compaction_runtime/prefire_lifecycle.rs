use super::*;

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
            "compaction_runtime::tests::prefire_lifecycle::prefire_scope_closed_runtime_does_not_deadlock",
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

use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use crate::test_support::providers::StaticTextProvider;
#[cfg(unix)]
use futures::StreamExt;
use kcoder_config::Settings;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn engine_with_requests(root: &std::path::Path) -> (QueryEngine, Arc<Mutex<Vec<MessagesRequest>>>) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(StaticTextProvider {
        requests: Arc::clone(&requests),
        text: "answer".into(),
    });
    (
        TestEngineBuilder::new(root)
            .owned_test_fixture()
            .provider(provider)
            .settings(Settings::default())
            .build_with_profile_directory(),
        requests,
    )
}

fn cache(engine: &QueryEngine, text: &str) -> Arc<crate::agent::CacheSafeParams> {
    Arc::new(crate::agent::CacheSafeParams {
        fork_context_messages: vec![Message::user_text(text)].into(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        context_history_anchor: None,
        full_context_compatible: true,
    })
}

async fn side_question_reuses_only_cache_with_the_same_arc_and_lifecycle_impl() {
    let root = crate::test_support::owned_case::owned_tempdir();
    let (engine, requests) = engine_with_requests(root.path());
    engine
        .state
        .set_messages(vec![Message::user_text("current context")]);
    let owner = engine.state.inspection_lifecycle_identity();
    let saved = cache(&engine, "original cached context");
    *engine.last_cache_safe_params.write().unwrap() = Some(Arc::clone(&saved));
    engine
        .run_side_question_for_lifecycle("question", &owner, CancellationToken::new())
        .await
        .unwrap();
    let unbound =
        serde_json::to_string(&requests.lock().unwrap().last().unwrap().messages).unwrap();
    assert!(unbound.contains("current context"));
    assert!(!unbound.contains("original cached context"));
    *engine.side_question_cache_binding.write().unwrap() =
        Some(crate::forking::SideQuestionCacheBinding {
            owner: owner.clone(),
            snapshot: Arc::downgrade(&saved),
        });
    assert_eq!(
        engine
            .run_side_question_for_lifecycle("question", &owner, CancellationToken::new())
            .await
            .unwrap(),
        "answer"
    );
    let request = requests.lock().unwrap().last().unwrap().clone();
    let body = serde_json::to_string(&request.messages).unwrap();
    assert!(body.contains("original cached context"));
    assert!(!body.contains("current context"));
    assert!(request.tools.is_empty());

    // A cache replacement cannot borrow the earlier object's lifecycle.
    let replacement = cache(&engine, "unbound replacement");
    *engine.last_cache_safe_params.write().unwrap() = Some(replacement);
    engine
        .run_side_question_for_lifecycle("question", &owner, CancellationToken::new())
        .await
        .unwrap();
    let body = serde_json::to_string(&requests.lock().unwrap().last().unwrap().messages).unwrap();
    assert!(body.contains("current context"));
    assert!(!body.contains("unbound replacement"));
}

async fn actual_main_request_binds_cache_to_its_original_lifecycle_impl() {
    let root = crate::test_support::owned_case::owned_tempdir();
    let (engine, requests) = engine_with_requests(root.path());
    let owner = engine.state.inspection_lifecycle_identity();
    let events = engine
        .submit_message("confirmed main", &kcoder_permissions::AutoAllowPrompt)
        .await;
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::UserMessageAdded))
    );
    assert!(engine.side_question_cache_snapshot(&owner).is_some());
    engine
        .state
        .add_message(Message::runtime_text("later state only"));
    engine
        .run_side_question_for_lifecycle("question", &owner, CancellationToken::new())
        .await
        .unwrap();
    let request = requests.lock().unwrap().last().unwrap().clone();
    let body = serde_json::to_string(&request.messages).unwrap();
    assert!(body.contains("confirmed main"));
    assert!(!body.contains("later state only"));
}

async fn foreign_or_cancelled_side_question_never_calls_provider_impl() {
    let root = crate::test_support::owned_case::owned_tempdir();
    let other = crate::test_support::owned_case::owned_tempdir();
    let (engine, requests) = engine_with_requests(root.path());
    let foreign = kcoder_state::AppState::new(other.path()).inspection_lifecycle_identity();
    assert!(
        engine
            .run_side_question_for_lifecycle("question", &foreign, CancellationToken::new())
            .await
            .is_err()
    );
    let cancel = CancellationToken::new();
    cancel.cancel();
    let owner = engine.state.inspection_lifecycle_identity();
    assert!(
        engine
            .run_side_question_for_lifecycle("question", &owner, cancel)
            .await
            .is_err()
    );
    assert!(requests.lock().unwrap().is_empty());
}

async fn same_session_restoration_cannot_reuse_old_cache_witness_impl() {
    let root = crate::test_support::owned_case::owned_tempdir();
    let (engine, requests) = engine_with_requests(root.path());
    let session_id = engine.state.session_id();
    let history = root.path().join(format!("{session_id}.jsonl"));
    engine.state.with_history_path(&history);
    engine
        .state
        .add_message(Message::user_text("restored current context"));
    engine.state.save_history().unwrap();
    let old_owner = engine.state.inspection_lifecycle_identity();
    let saved = cache(&engine, "old lifecycle cache only");
    *engine.last_cache_safe_params.write().unwrap() = Some(Arc::clone(&saved));
    *engine.side_question_cache_binding.write().unwrap() =
        Some(crate::forking::SideQuestionCacheBinding {
            owner: old_owner.clone(),
            snapshot: Arc::downgrade(&saved),
        });
    engine.state.resume_from_history(&history).unwrap();
    assert_eq!(engine.state.session_id(), session_id);
    assert!(
        engine
            .run_side_question_for_lifecycle("question", &old_owner, CancellationToken::new())
            .await
            .is_err()
    );
    assert!(requests.lock().unwrap().is_empty());
    engine
        .run_side_question("question", CancellationToken::new())
        .await
        .unwrap();
    let body = serde_json::to_string(&requests.lock().unwrap().last().unwrap().messages).unwrap();
    assert!(body.contains("restored current context"));
    assert!(!body.contains("old lifecycle cache only"));
}

async fn foreign_task_scope_cannot_rebind_side_question_impl() {
    let first = crate::test_support::owned_case::owned_tempdir();
    let second = crate::test_support::owned_case::owned_tempdir();
    let original = kcoder_state::AppState::new(first.path());
    let attempt = kcoder_types::TurnAttemptIdentity {
        thread_id: original.session_id(),
        turn_id: "old-turn".into(),
        attempt_id: "old-attempt".into(),
    };
    let scope = original.history_attempt_scope(attempt).unwrap();
    let (engine, requests) = engine_with_requests(second.path());
    let result = scope
        .run(async {
            engine
                .run_side_question("question", CancellationToken::new())
                .await
        })
        .await;
    assert!(result.is_err());
    assert!(requests.lock().unwrap().is_empty());
}

struct PendingProvider {
    calls: Arc<AtomicUsize>,
}
impl kcoder_api::Provider for PendingProvider {
    fn name(&self) -> &'static str {
        "side-pending"
    }
    fn stream_messages(
        &self,
        _: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(Box::pin(futures::stream::pending()))
    }
}

async fn side_question_releases_input_gate_before_provider_wait_and_cancels_impl() {
    let root = crate::test_support::owned_case::owned_tempdir();
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .provider(Arc::new(PendingProvider {
            calls: Arc::clone(&calls),
        }))
        .build_with_profile_directory();
    let cancel = CancellationToken::new();
    let task_engine = engine.clone();
    let task_cancel = cancel.clone();
    let task =
        tokio::spawn(async move { task_engine.run_side_question("question", task_cancel).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        Arc::clone(&engine.input_session_end_gate)
            .try_read_owned()
            .is_ok()
    );
    cancel.cancel();
    assert!(
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

struct MutatingNameProvider {
    state: Mutex<Option<kcoder_state::AppState>>,
    trigger: AtomicBool,
    calls: AtomicUsize,
}
impl kcoder_api::Provider for MutatingNameProvider {
    fn name(&self) -> &'static str {
        if self.trigger.swap(false, Ordering::SeqCst) {
            self.state
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .add_message(Message::user_text("changed after snapshot"));
        }
        "side-mutating"
    }
    fn stream_messages(
        &self,
        _: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(Box::pin(futures::stream::pending()))
    }
}

async fn side_question_rejects_state_change_during_request_construction_impl() {
    let root = crate::test_support::owned_case::owned_tempdir();
    let provider = Arc::new(MutatingNameProvider {
        state: Mutex::new(None),
        trigger: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
    });
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .provider(provider.clone())
        .build_with_profile_directory();
    *provider.state.lock().unwrap() = Some(engine.state.clone());
    engine
        .state
        .add_message(Message::user_text("before snapshot"));
    provider.trigger.store(true, Ordering::SeqCst);
    assert!(
        engine
            .run_side_question("question", CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
}

#[cfg(unix)]
async fn pending_then_unknown_original_input_blocks_side_question_without_provider_impl() {
    use std::os::fd::AsRawFd;
    let root = crate::test_support::owned_case::owned_tempdir();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let cancel = CancellationToken::new();
    let provider = Arc::new(StaticTextProvider {
        requests: Arc::clone(&requests),
        text: "answer".into(),
    });
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .provider(provider)
        .build_with_profile_directory()
        .with_cancel_token(cancel.clone());
    let history = root.path().join("side-pending.jsonl");
    engine.state.with_history_path(&history);
    engine.state.materialize_history().unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join(".kcoder-history.lock"))
        .unwrap();
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
    let mut stream =
        engine.submit_message_stream("not yet confirmed", &kcoder_permissions::AutoAllowPrompt);
    let notice = tokio::time::timeout(Duration::from_secs(4), stream.next())
        .await
        .unwrap();
    assert!(matches!(notice, Some(EngineEvent::SystemNotice(text)) if text.contains("Saving")));
    assert!(
        tokio::time::timeout(
            Duration::from_millis(250),
            engine.run_side_question("question", CancellationToken::new())
        )
        .await
        .unwrap()
        .is_err()
    );
    assert!(requests.lock().unwrap().is_empty());
    cancel.cancel();
    let events = tokio::time::timeout(Duration::from_secs(2), stream.collect::<Vec<_>>())
        .await
        .unwrap();
    assert!(
        events
            .iter()
            .any(|event| matches!(event, EngineEvent::StreamAborted { .. }))
    );
    assert!(
        engine
            .run_side_question("question", CancellationToken::new())
            .await
            .is_err()
    );
    assert!(requests.lock().unwrap().is_empty());
    drop(lock);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if std::fs::read_to_string(&history)
                .is_ok_and(|body| body.contains("not yet confirmed"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(history)
            .unwrap()
            .matches("not yet confirmed")
            .count(),
        1
    );
}

#[cfg(unix)]
async fn busy_state_snapshot_rejects_side_question_without_freezing_runtime_impl() {
    use std::os::fd::AsRawFd;
    let root = crate::test_support::owned_case::owned_tempdir();
    let (engine, requests) = engine_with_requests(root.path());
    let history = root.path().join("side-busy.jsonl");
    engine.state.with_history_path(&history);
    engine.state.materialize_history().unwrap();
    let owner = engine.state.inspection_lifecycle_identity();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join(".kcoder-history.lock"))
        .unwrap();
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
    let state = engine.state.clone();
    let snapshot = std::thread::spawn(move || state.save_history());
    tokio::time::timeout(Duration::from_secs(3), async {
        while engine
            .state
            .try_check_lifecycle_identity(&owner)
            .unwrap()
            .is_some()
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        tokio::time::timeout(
            Duration::from_millis(250),
            engine.run_side_question_for_lifecycle("question", &owner, CancellationToken::new())
        )
        .await
        .unwrap()
        .is_err()
    );
    assert!(requests.lock().unwrap().is_empty());
    drop(lock);
    snapshot.join().unwrap().unwrap();
}

macro_rules! owned_side_case {
    ($name:ident) => {
        #[test]
        fn $name() {
            crate::test_support::owned_case::run_owned_case(
                concat!(module_path!(), "::side_question_owned_dispatcher"),
                stringify!($name),
            );
        }
    };
}
owned_side_case!(side_question_reuses_only_cache_with_the_same_arc_and_lifecycle);
owned_side_case!(actual_main_request_binds_cache_to_its_original_lifecycle);
owned_side_case!(foreign_or_cancelled_side_question_never_calls_provider);
owned_side_case!(same_session_restoration_cannot_reuse_old_cache_witness);
owned_side_case!(foreign_task_scope_cannot_rebind_side_question);
owned_side_case!(side_question_releases_input_gate_before_provider_wait_and_cancels);
owned_side_case!(side_question_rejects_state_change_during_request_construction);
#[cfg(unix)]
owned_side_case!(pending_then_unknown_original_input_blocks_side_question_without_provider);
#[cfg(unix)]
owned_side_case!(busy_state_snapshot_rejects_side_question_without_freezing_runtime);

#[test]
#[ignore = "private dispatcher, launched and checked by each owned parent test"]
fn side_question_owned_dispatcher() {
    let case = crate::test_support::owned_case::owned_case();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    match case.as_str() {
        "side_question_reuses_only_cache_with_the_same_arc_and_lifecycle" => {
            runtime.block_on(side_question_reuses_only_cache_with_the_same_arc_and_lifecycle_impl())
        }
        "actual_main_request_binds_cache_to_its_original_lifecycle" => {
            runtime.block_on(actual_main_request_binds_cache_to_its_original_lifecycle_impl())
        }
        "foreign_or_cancelled_side_question_never_calls_provider" => {
            runtime.block_on(foreign_or_cancelled_side_question_never_calls_provider_impl())
        }
        "same_session_restoration_cannot_reuse_old_cache_witness" => {
            runtime.block_on(same_session_restoration_cannot_reuse_old_cache_witness_impl())
        }
        "foreign_task_scope_cannot_rebind_side_question" => {
            runtime.block_on(foreign_task_scope_cannot_rebind_side_question_impl())
        }
        "side_question_releases_input_gate_before_provider_wait_and_cancels" => runtime
            .block_on(side_question_releases_input_gate_before_provider_wait_and_cancels_impl()),
        "side_question_rejects_state_change_during_request_construction" => {
            runtime.block_on(side_question_rejects_state_change_during_request_construction_impl())
        }
        #[cfg(unix)]
        "pending_then_unknown_original_input_blocks_side_question_without_provider" => runtime
            .block_on(
                pending_then_unknown_original_input_blocks_side_question_without_provider_impl(),
            ),
        #[cfg(unix)]
        "busy_state_snapshot_rejects_side_question_without_freezing_runtime" => runtime
            .block_on(busy_state_snapshot_rejects_side_question_without_freezing_runtime_impl()),
        _ => panic!("unknown owned test case: {case}"),
    }
}

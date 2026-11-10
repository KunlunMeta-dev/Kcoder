use super::*;
use crate::integrations::knowledge::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use kcoder_config::PrivateDirectory;
use kcoder_memory::integrations::knowledge::MemoryReviewStore;
use kcoder_types::integrations::core::IntegrationScope;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

struct Authority {
    scope: IntegrationScope,
    allowed: Arc<AtomicBool>,
    receipts: Mutex<Vec<ObserverExtractionReceipt>>,
    maximum_total: AtomicU64,
}
impl CuratedMemoryObserverAuthority for Authority {
    fn authorize(
        &self,
        bundle: &MemoryObserverEventBundle,
        request: &ObserverExtractionRequest,
    ) -> anyhow::Result<ObserverExtractionPermit> {
        anyhow::ensure!(self.allowed.load(Ordering::SeqCst), "FIXTURE_DENIED");
        Ok(ObserverExtractionPermit {
            origin: ObserverNativeOrigin {
                scope: self.scope.clone(),
                thread_id: bundle.session_id.clone(),
                turn_id: Some("fixture-origin-turn".into()),
                task_id: Some("fixture-origin-task".into()),
                operation_id: format!("fixture-{:?}", request.kind),
                project_key: bundle.project_key.clone(),
                policy_revision: "fixture-policy".into(),
                configuration_revision: "fixture-config".into(),
            },
            kind: request.kind,
            selected_model_id: request.requested_model_id.clone(),
            maximum_total_tokens: self.maximum_total.load(Ordering::SeqCst),
            maximum_output_tokens: 128,
            maximum_input_bytes: 65536,
            maximum_candidates: 8,
            maximum_runtime_ms: 2000,
        })
    }
    fn revalidate(
        &self,
        _: &ObserverExtractionPermit,
        _: &MemoryObserverEventBundle,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(self.allowed.load(Ordering::SeqCst), "FIXTURE_REVOKED");
        Ok(())
    }
    fn record_attempt(
        &self,
        _: &ObserverExtractionPermit,
        receipt: &ObserverExtractionReceipt,
    ) -> anyhow::Result<()> {
        self.receipts.lock().unwrap().push(receipt.clone());
        Ok(())
    }
}
struct Provider {
    events: Vec<StreamEvent>,
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
    quiet_after_first: bool,
}
impl kcoder_api::Provider for Provider {
    fn name(&self) -> &'static str {
        "observer-review-fixture"
    }
    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let events = self.events.clone();
        let quiet = self.quiet_after_first;
        Ok(Box::pin(
            async_stream::stream! {for (index,event) in events.into_iter().enumerate(){if quiet&&index==1{tokio::time::sleep(Duration::from_secs(5)).await;}yield Ok(event);}},
        ))
    }
}
struct Fixture {
    engine: QueryEngine,
    store: Arc<MemoryReviewStore>,
    authority: Arc<Authority>,
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
    bundle: MemoryObserverEventBundle,
    _root: tempfile::TempDir,
}
fn fixture(with_usage: bool, parse_failure: bool, quiet: bool) -> anyhow::Result<Fixture> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let scope = serde_json::from_value(
        serde_json::json!({"accountId":"fixture","targetId":"local","workspaceId":null,"identityGeneration":"1","targetRevision":"1"}),
    )?;
    let store = Arc::new(MemoryReviewStore::create(
        &root.path().join("review"),
        &scope,
    )?);
    let authority = Arc::new(Authority {
        scope,
        allowed: Arc::new(AtomicBool::new(true)),
        receipts: Mutex::new(vec![]),
        maximum_total: AtomicU64::new(1000),
    });
    let requests = Arc::new(Mutex::new(vec![]));
    let settings = Settings {
        memory: kcoder_config::MemorySettings {
            observer_model: Some("observer-test".into()),
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bundle = MemoryObserverEventBundle::new(
        "fixture-session",
        "project-a",
        Some(1),
        None,
        Default::default(),
    );
    bundle.add_verification_passed_event("verification", "bash", "Synthetic tests passed", None);
    let mut draft = deterministic_memory_observer_draft(&bundle);
    draft.audit.model = Some("observer-test".into());
    let text = if parse_failure {
        "invalid-json".into()
    } else {
        serde_json::to_string(&draft)?
    };
    let mut events = crate::test_support::events::simple_text_events(&text);
    if with_usage {
        if let StreamEvent::MessageStart { message } = &mut events[0] {
            message.usage = Some(Usage {
                input_tokens: 11,
                output_tokens: 0,
                total_tokens: Some(16),
                cache_creation_input_tokens: None,
                cache_read_input_tokens: Some(5),
                iterations: None,
            });
        }
        // Native gateways may report their final usage after message_stop.
        events.push(StreamEvent::MessageDelta {
            delta: kcoder_types::MessageDeltaFields {
                stop_reason: None,
                stop_sequence: None,
                usage: Some(Usage {
                    input_tokens: 11,
                    output_tokens: 7,
                    total_tokens: Some(23),
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: Some(5),
                    iterations: None,
                }),
            },
        });
    }
    let provider = Arc::new(Provider {
        events,
        requests: requests.clone(),
        quiet_after_first: quiet,
    });
    let memory = MemoryManager::global_only(MemoryStore::empty()).with_structured_store(
        kcoder_memory::StructuredMemoryStore::in_memory()?,
        "project-a",
    );
    let engine = TestEngineBuilder::new(root.path())
        .settings(settings)
        .provider(provider)
        .memory_manager(memory)
        .build_with_profile_directory()
        .with_curated_memory_observer_sink(Arc::new(CuratedMemoryReviewBridge::new(
            store.clone(),
            authority.clone(),
        )));
    bundle.session_id = engine.state.session_id();
    engine
        .state
        .set_usage_history_root(Some(&root.path().join("usage")));
    Ok(Fixture {
        engine,
        store,
        authority,
        requests,
        bundle,
        _root: root,
    })
}
fn counters(f: &Fixture) -> kcoder_types::usage_history::UsageCounters {
    let history = kcoder_state::usage_history::read_usage(&f._root.path().join("usage"))
        .unwrap()
        .unwrap();
    history
        .days
        .values()
        .find_map(|day| day.get("observer-test"))
        .unwrap()
        .clone()
}
#[tokio::test]
async fn actual_observer_stream_stages_disabled_candidates_and_accounts_trailing_usage_once()
-> anyhow::Result<()> {
    let f = fixture(true, false, false)?;
    f.engine
        .process_memory_observer_bundle_with_model(f.bundle.clone())
        .await;
    let candidates = f.store.list(None, true)?;
    assert!(!candidates.items.is_empty());
    assert!(
        candidates
            .items
            .iter()
            .all(|memory| !memory.enabled && !memory.source_verified)
    );
    assert_eq!(
        f.engine
            .memory_manager
            .structured_memory_stats()?
            .observations_visible,
        0
    );
    assert_eq!(f.requests.lock().unwrap().len(), 1);
    assert_eq!(f.requests.lock().unwrap()[0].max_tokens, 128);
    let usage = counters(&f);
    assert_eq!(usage.requests, 1);
    assert_eq!(usage.total_tokens, 23);
    assert_eq!(usage.cache_read_tokens, 5);
    assert_eq!(f.engine.cumulative_usage().total(), 23);
    assert_eq!(
        f.authority.receipts.lock().unwrap()[0]
            .usage
            .as_ref()
            .unwrap()
            .output_tokens,
        7
    );
    Ok(())
}
#[tokio::test]
async fn unreported_usage_is_unknown_and_does_not_bypass_review_into_legacy_recall()
-> anyhow::Result<()> {
    let f = fixture(false, false, false)?;
    f.engine
        .process_memory_observer_bundle_with_model(f.bundle.clone())
        .await;
    assert!(f.store.list(None, true)?.items.is_empty());
    assert_eq!(
        f.engine
            .memory_manager
            .structured_memory_stats()?
            .observations_visible,
        0
    );
    let usage = counters(&f);
    assert_eq!(usage.requests, 1);
    assert_eq!(usage.unreported_requests, 1);
    assert!(f.authority.receipts.lock().unwrap()[0].usage.is_none());
    assert_eq!(f.requests.lock().unwrap().len(), 1);
    Ok(())
}
#[tokio::test]
async fn denied_native_source_never_calls_provider_or_legacy_writer() -> anyhow::Result<()> {
    let f = fixture(true, false, false)?;
    f.authority.allowed.store(false, Ordering::SeqCst);
    f.engine
        .process_memory_observer_bundle_with_model(f.bundle.clone())
        .await;
    assert!(f.requests.lock().unwrap().is_empty());
    assert!(f.store.list(None, true)?.items.is_empty());
    assert_eq!(
        f.engine
            .memory_manager
            .structured_memory_stats()?
            .observations_visible,
        0
    );
    assert!(kcoder_state::usage_history::read_usage(&f._root.path().join("usage"))?.is_none());
    Ok(())
}
#[tokio::test]
async fn parse_failure_charges_observed_tokens_and_only_falls_back_to_review_candidates()
-> anyhow::Result<()> {
    let f = fixture(true, true, false)?;
    f.engine
        .process_memory_observer_bundle_with_model(f.bundle.clone())
        .await;
    assert!(!f.store.list(None, true)?.items.is_empty());
    assert_eq!(
        f.engine
            .memory_manager
            .structured_memory_stats()?
            .observations_visible,
        0
    );
    assert_eq!(counters(&f).requests, 1);
    assert_eq!(counters(&f).total_tokens, 23);
    let receipts = f.authority.receipts.lock().unwrap();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].outcome, ObserverExtractionOutcome::ParseFailed);
    assert!(!receipts[1].provider_started);
    Ok(())
}
#[tokio::test]
async fn abort_after_usage_preserves_original_attempt_without_a_second_model_call()
-> anyhow::Result<()> {
    let f = fixture(true, false, true)?;
    let engine = f.engine.clone();
    let bundle = f.bundle.clone();
    let task = tokio::spawn(async move {
        engine
            .process_memory_observer_bundle_with_model(bundle)
            .await;
    });
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if !f.requests.lock().unwrap().is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await?;
    tokio::time::sleep(Duration::from_millis(30)).await;
    task.abort();
    let _ = task.await;
    assert!(f.store.list(None, true)?.items.is_empty());
    assert_eq!(counters(&f).requests, 1);
    assert_eq!(counters(&f).total_tokens, 16);
    let receipts = f.authority.receipts.lock().unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].outcome, ObserverExtractionOutcome::Abandoned);
    Ok(())
}
#[tokio::test]
async fn source_revocation_interrupts_a_quiet_owned_stream_and_keeps_partial_usage()
-> anyhow::Result<()> {
    let f = fixture(true, false, true)?;
    let engine = f.engine.clone();
    let bundle = f.bundle.clone();
    let task = tokio::spawn(async move {
        engine
            .process_memory_observer_bundle_with_model(bundle)
            .await;
    });
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if !f.requests.lock().unwrap().is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await?;
    tokio::time::sleep(Duration::from_millis(30)).await;
    f.authority.allowed.store(false, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(2), task).await??;
    assert!(f.store.list(None, true)?.items.is_empty());
    assert_eq!(f.requests.lock().unwrap().len(), 1);
    let receipts = f.authority.receipts.lock().unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].usage_evidence, ObserverUsageEvidence::Partial);
    assert_eq!(counters(&f).total_tokens, 16);
    Ok(())
}
#[tokio::test]
async fn observed_budget_overrun_stops_the_attempt_without_free_fallback_or_zero_accounting()
-> anyhow::Result<()> {
    let f = fixture(true, false, false)?;
    f.authority.maximum_total.store(1, Ordering::SeqCst);
    f.engine
        .process_memory_observer_bundle_with_model(f.bundle.clone())
        .await;
    assert!(f.store.list(None, true)?.items.is_empty());
    assert_eq!(
        f.engine
            .memory_manager
            .structured_memory_stats()?
            .observations_visible,
        0
    );
    assert_eq!(f.requests.lock().unwrap().len(), 1);
    assert_eq!(counters(&f).total_tokens, 16);
    let receipts = f.authority.receipts.lock().unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(
        receipts[0].outcome,
        ObserverExtractionOutcome::BudgetExceeded
    );
    assert_eq!(receipts[0].usage_evidence, ObserverUsageEvidence::Partial);
    Ok(())
}

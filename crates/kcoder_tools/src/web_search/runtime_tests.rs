use super::*;
use crate::web_search::{BundledSearchBackend, SearchDispatchGuard, SearchFailure};
use kcoder_state::AppState;
use kcoder_types::web_search::{WebSearchHitV1, WebSearchPageV1};
use serde_json::json;
use std::sync::{Arc, RwLock};

struct Source {
    calls: AtomicUsize,
    fail_next_network: std::sync::atomic::AtomicBool,
    block: bool,
    entered: tokio::sync::Notify,
    release: tokio::sync::Semaphore,
}
impl Source {
    fn new(block: bool) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            fail_next_network: std::sync::atomic::AtomicBool::new(false),
            block,
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Semaphore::new(0),
        }
    }
}
#[async_trait::async_trait]
impl BundledSearchBackend for Source {
    async fn search(
        &self,
        _input: &WebSearchInput,
        guard: &SearchDispatchGuard,
    ) -> Result<WebSearchPageV1, SearchFailure> {
        guard.check(WebSearchProvider::Searxng)?;
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        if self.block {
            self.release.acquire().await.unwrap().forget();
        }
        if self.fail_next_network.swap(false, Ordering::AcqRel) {
            return Err(SearchFailure::new(
                WebSearchErrorKind::Network,
                "Owned source connection failed",
                true,
            ));
        }
        Ok(WebSearchPageV1 {
            results: vec![WebSearchHitV1 {
                title: "Owned fixture source".into(),
                url: "https://example.com/source".into(),
                snippet: "Fixture excerpt".into(),
                ..Default::default()
            }],
            ..Default::default()
        })
    }
}
struct Fixture {
    _root: tempfile::TempDir,
    context: ToolContext,
    settings: Arc<RwLock<kcoder_config::Settings>>,
    source: Arc<Source>,
    runtime: Arc<WebSearchRuntime>,
}
impl Fixture {
    fn new(block: bool) -> Self {
        Self::with_network_reader(block, None)
    }
    fn with_network_reader(block: bool, reader: Option<NetworkGenerationReader>) -> Self {
        let root = tempfile::tempdir().unwrap();
        let mut settings = kcoder_config::Settings::default();
        settings
            .web
            .search
            .providers
            .retain(|p| p.id == WebSearchProvider::Searxng);
        settings.web.fetch.proxy_mode = kcoder_config::WebProxyMode::Direct;
        let settings = Arc::new(RwLock::new(settings));
        let source = Arc::new(Source::new(block));
        let runtime = Arc::new(WebSearchRuntime {
            network_generation_reader: reader,
            ..WebSearchRuntime::new()
        });
        let context = ToolContext::new(AppState::new(root.path()))
            .with_runtime_settings(settings.clone())
            .with_bundled_search_backend(Some(source.clone()))
            .with_web_search_runtime(runtime.clone());
        Self {
            _root: root,
            context,
            settings,
            source,
            runtime,
        }
    }
    fn input(query: &str) -> WebSearchInput {
        serde_json::from_value(json!({"query":query})).unwrap()
    }
}

#[test]
fn passive_snapshot_never_creates_health_observations_or_restores_excluded_sources() {
    let fixture = Fixture::new(false);
    let snapshot = fixture
        .runtime
        .snapshot(&fixture.settings.read().unwrap().web, None)
        .unwrap();
    assert_eq!(snapshot.candidates, [WebSearchProvider::Searxng]);
    assert_eq!(snapshot.observations.len(), 1);
    assert!(snapshot.observations[0].status.is_none());
    assert_eq!(fixture.source.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn an_unreadable_bound_policy_is_a_known_not_sent_failure_and_precancel_skips_its_io() {
    let f = Fixture::new(false);
    let reads = Arc::new(AtomicUsize::new(0));
    let observed = reads.clone();
    let context = f
        .context
        .clone()
        .with_web_settings_reader(Some(Arc::new(move || {
            observed.fetch_add(1, Ordering::SeqCst);
            Err(ToolError::Execution("PRIVATE_CONFIGURATION_DETAIL".into()))
        })));
    let response = f
        .runtime
        .probe(Fixture::input("policy changed"), &context)
        .await
        .unwrap();
    assert_eq!(response.status, WebSearchStatus::Failed);
    assert_eq!(response.failure, Some(WebSearchErrorKind::PolicyDenied));
    assert!(response.attempts.is_empty());
    assert!(
        !serde_json::to_string(&response)
            .unwrap()
            .contains("PRIVATE_CONFIGURATION_DETAIL")
    );
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 0);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    let cancel = tokio_util::sync::CancellationToken::new();
    cancel.cancel();
    let response = f
        .runtime
        .probe(
            Fixture::input("cancel before policy IO"),
            &context.with_abort_token(cancel),
        )
        .await
        .unwrap();
    assert_eq!(response.status, WebSearchStatus::Cancelled);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn owner_cache_preserves_retrieval_time_and_never_reports_a_new_network_attempt() {
    let f = Fixture::new(false);
    let first = f
        .runtime
        .execute(Fixture::input("official fixture guide"), &f.context)
        .await
        .unwrap();
    let second = f
        .runtime
        .execute(Fixture::input("official fixture guide"), &f.context)
        .await
        .unwrap();
    assert!(!first.cache_hit);
    assert!(second.cache_hit);
    assert_eq!(first.retrieved_at, second.retrieved_at);
    assert_ne!(first.request_id, second.request_id);
    assert!(second.attempts.is_empty());
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 1);
    let snapshot = f
        .runtime
        .snapshot(&f.settings.read().unwrap().web, None)
        .unwrap();
    assert_eq!(
        snapshot.observations[0].status,
        Some(WebSearchStatus::Success)
    );
}

#[tokio::test]
async fn different_state_owner_cannot_read_a_peer_cache_entry() {
    let f = Fixture::new(false);
    f.runtime
        .execute(Fixture::input("owner scoped query"), &f.context)
        .await
        .unwrap();
    let peer = ToolContext::new(AppState::new(f._root.path()))
        .with_runtime_settings(f.settings.clone())
        .with_bundled_search_backend(Some(f.source.clone()))
        .with_web_search_runtime(f.runtime.clone());
    let response = f
        .runtime
        .execute(Fixture::input("owner scoped query"), &peer)
        .await
        .unwrap();
    assert!(!response.cache_hit);
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn revoked_policy_does_not_reuse_a_previously_successful_cache() {
    let f = Fixture::new(false);
    f.runtime
        .execute(Fixture::input("revocation query"), &f.context)
        .await
        .unwrap();
    f.settings.write().unwrap().web.search.providers.clear();
    let response = f
        .runtime
        .execute(Fixture::input("revocation query"), &f.context)
        .await
        .unwrap();
    assert_eq!(response.failure, Some(WebSearchErrorKind::PolicyDenied));
    assert!(!response.cache_hit);
    assert!(response.attempts.is_empty());
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn explicit_probe_and_live_requests_bypass_content_cache() {
    let f = Fixture::new(false);
    f.runtime
        .execute(Fixture::input("fresh query"), &f.context)
        .await
        .unwrap();
    let probe = f
        .runtime
        .probe(Fixture::input("fresh query"), &f.context)
        .await
        .unwrap();
    assert!(!probe.cache_hit);
    let live = serde_json::from_value(json!({"query":"fresh query","freshness":"live"})).unwrap();
    let response = f.runtime.execute(live, &f.context).await.unwrap();
    assert!(!response.cache_hit);
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn revoked_host_policy_rejects_cached_results_and_late_inflight_pages() {
    let f = Fixture::new(false);
    f.runtime
        .execute(Fixture::input("cached guide"), &f.context)
        .await
        .unwrap();
    let denied = f.context.clone().with_web_dispatch_check(Arc::new(|| {
        Err(ToolError::Execution("host revoked".into()))
    }));
    let response = f
        .runtime
        .execute(Fixture::input("cached guide"), &denied)
        .await
        .unwrap();
    assert_eq!(response.failure, Some(WebSearchErrorKind::PolicyDenied));
    assert!(response.attempts.is_empty());
    assert!(!response.cache_hit);
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 1);
    let f = Fixture::new(true);
    let allowed = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let active = allowed.clone();
    let context = f.context.clone().with_web_dispatch_check(Arc::new(move || {
        if active.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(ToolError::Execution("host revoked".into()))
        }
    }));
    let runtime = f.runtime.clone();
    let request =
        tokio::spawn(async move { runtime.probe(Fixture::input("late guide"), &context).await });
    f.source.entered.notified().await;
    allowed.store(false, Ordering::Release);
    f.source.release.add_permits(1);
    let response = request.await.unwrap().unwrap();
    assert_eq!(response.failure, Some(WebSearchErrorKind::PolicyDenied));
    assert!(response.page.results.is_empty());
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn queued_cancellation_leaves_four_active_peers_untouched() {
    let f = Fixture::new(true);
    let mut tasks = Vec::new();
    for i in 0..4 {
        let runtime = f.runtime.clone();
        let context = f.context.clone();
        tasks.push(tokio::spawn(async move {
            runtime
                .execute(Fixture::input(&format!("active query {i}")), &context)
                .await
        }));
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        while f.source.calls.load(Ordering::SeqCst) < 4 {
            f.source.entered.notified().await;
        }
    })
    .await
    .unwrap();
    let cancel = tokio_util::sync::CancellationToken::new();
    let runtime = f.runtime.clone();
    let context = f.context.clone().with_abort_token(cancel.clone());
    let queued = tokio::spawn(async move {
        runtime
            .execute(Fixture::input("queued request"), &context)
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        while f.runtime.queued.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    cancel.cancel();
    let response = queued.await.unwrap().unwrap();
    assert_eq!(response.status, WebSearchStatus::Cancelled);
    assert!(response.attempts.is_empty());
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 4);
    f.source.release.add_permits(4);
    for task in tasks {
        assert_eq!(
            task.await.unwrap().unwrap().status,
            WebSearchStatus::Success
        );
    }
    assert_eq!(f.runtime.queued.load(Ordering::SeqCst), 0);
}

fn owned_ca_generation(path: std::path::PathBuf) -> NetworkGenerationReader {
    use std::hash::{Hash, Hasher};
    Arc::new(move |_| {
        let metadata = std::fs::metadata(&path)
            .map_err(|_| ToolError::Execution("Owned CA metadata unavailable".into()))?;
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        metadata.len().hash(&mut hash);
        metadata.modified().ok().hash(&mut hash);
        Ok(hash.finish())
    })
}

#[tokio::test]
async fn network_generation_isolates_passive_health_and_cooldown_without_relaxing_policy() {
    let root = tempfile::tempdir().unwrap();
    let ca = root.path().join("owned-ca.pem");
    std::fs::write(&ca, b"original owned CA bytes").unwrap();
    let f = Fixture::with_network_reader(false, Some(owned_ca_generation(ca.clone())));
    f.source.fail_next_network.store(true, Ordering::Release);
    let failed = f
        .runtime
        .execute(Fixture::input("network repair"), &f.context)
        .await
        .unwrap();
    assert_eq!(failed.failure, Some(WebSearchErrorKind::Network));
    assert_eq!(failed.attempts.len(), 1);
    assert!(failed.attempts[0].request_sent);
    let initial = f
        .runtime
        .snapshot(&f.settings.read().unwrap().web, None)
        .unwrap();
    assert_eq!(
        initial.observations[0].error,
        Some(WebSearchErrorKind::Network)
    );
    let cooling = f
        .runtime
        .execute(Fixture::input("network repair"), &f.context)
        .await
        .unwrap();
    assert_eq!(cooling.failure, Some(WebSearchErrorKind::RateLimited));
    assert!(cooling.attempts.is_empty());
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 1);

    // A distinct byte length makes this deterministic even on coarse-mtime filesystems.
    std::fs::write(&ca, b"repaired owned CA generation with new metadata").unwrap();
    let fresh = f
        .runtime
        .snapshot(&f.settings.read().unwrap().web, None)
        .unwrap();
    assert_eq!(
        fresh.revision, initial.revision,
        "private network identity is not exposed as public configuration"
    );
    assert_eq!(fresh.candidates, initial.candidates);
    assert!(fresh.observations[0].status.is_none());
    let recovered = f
        .runtime
        .execute(Fixture::input("network repair"), &f.context)
        .await
        .unwrap();
    assert_eq!(recovered.status, WebSearchStatus::Success);
    assert!(!recovered.cache_hit);
    assert_eq!(recovered.attempts.len(), 1);
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        f.runtime
            .snapshot(&f.settings.read().unwrap().web, None)
            .unwrap()
            .observations[0]
            .status,
        Some(WebSearchStatus::Success)
    );

    let denied = f.context.clone().with_web_dispatch_check(Arc::new(|| {
        Err(ToolError::Execution("host revoked".into()))
    }));
    std::fs::write(&ca, b"another private CA generation").unwrap();
    let blocked = f
        .runtime
        .execute(Fixture::input("host denied after repair"), &denied)
        .await
        .unwrap();
    assert_eq!(blocked.failure, Some(WebSearchErrorKind::PolicyDenied));
    assert!(blocked.attempts.is_empty());
    std::fs::remove_file(&ca).unwrap();
    assert!(
        f.runtime
            .snapshot(&f.settings.read().unwrap().web, None)
            .is_err()
    );
    let unavailable = f
        .runtime
        .execute(Fixture::input("unavailable network identity"), &f.context)
        .await
        .unwrap();
    assert_eq!(unavailable.failure, Some(WebSearchErrorKind::PolicyDenied));
    assert!(unavailable.attempts.is_empty());
    f.settings.write().unwrap().web.search.providers.clear();
    let blocked = f
        .runtime
        .execute(Fixture::input("excluded sources after repair"), &f.context)
        .await
        .unwrap();
    assert_eq!(blocked.failure, Some(WebSearchErrorKind::PolicyDenied));
    assert!(blocked.attempts.is_empty());
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 2);
    let excluded = f
        .runtime
        .snapshot(&f.settings.read().unwrap().web, None)
        .unwrap();
    assert!(excluded.candidates.is_empty() && excluded.observations.is_empty());
}

#[tokio::test]
async fn late_old_network_failure_cannot_cool_a_repaired_generation() {
    let root = tempfile::tempdir().unwrap();
    let ca = root.path().join("owned-ca.pem");
    std::fs::write(&ca, b"old CA").unwrap();
    let f = Fixture::with_network_reader(true, Some(owned_ca_generation(ca.clone())));
    f.source.fail_next_network.store(true, Ordering::Release);
    let runtime = f.runtime.clone();
    let context = f.context.clone();
    let request = tokio::spawn(async move {
        runtime
            .execute(Fixture::input("inflight old network"), &context)
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), f.source.entered.notified())
        .await
        .unwrap();
    std::fs::write(&ca, b"new repaired CA metadata").unwrap();
    f.source.release.add_permits(1);
    assert_eq!(
        request.await.unwrap().unwrap().failure,
        Some(WebSearchErrorKind::Network)
    );
    assert!(
        f.runtime
            .snapshot(&f.settings.read().unwrap().web, None)
            .unwrap()
            .observations[0]
            .status
            .is_none()
    );
    f.source.release.add_permits(1);
    let repaired = f
        .runtime
        .execute(Fixture::input("inflight old network"), &f.context)
        .await
        .unwrap();
    assert_eq!(repaired.status, WebSearchStatus::Success);
    assert_eq!(f.source.calls.load(Ordering::SeqCst), 2);
}

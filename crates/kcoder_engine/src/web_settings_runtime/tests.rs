use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use kcoder_config::{SettingsLoader, WebProxyMode, WebSettings};
use kcoder_tools::web_search::{
    BundledSearchBackend, SearchDispatchGuard, SearchFailure, WebSearchInput,
};
use kcoder_types::web_search::{
    WebSearchErrorKind, WebSearchHitV1, WebSearchPageV1, WebSearchProvider, WebSearchStatus,
};
use std::sync::atomic::{AtomicUsize, Ordering};

struct BoundSource(SettingsLoader);
impl ClientModelConfiguration for BoundSource {
    fn web_settings(&self) -> Result<Option<WebSettings>> {
        Ok(Some(self.0.load_read_only_configuration()?.settings.web))
    }
    fn settings(&self, _: &str) -> Result<Settings> {
        panic!("Web reads must not refresh the model snapshot")
    }
    fn provider(&self, _: &Settings) -> Result<Arc<dyn Provider>> {
        panic!("Web reads must not resolve provider credentials")
    }
}
struct Backend {
    dispatches: AtomicUsize,
    blocked: bool,
    entered: tokio::sync::Notify,
    release: tokio::sync::Semaphore,
}
impl Backend {
    fn new(blocked: bool) -> Self {
        Self {
            dispatches: AtomicUsize::new(0),
            blocked,
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Semaphore::new(0),
        }
    }
}
#[async_trait::async_trait]
impl BundledSearchBackend for Backend {
    async fn search(
        &self,
        _: &WebSearchInput,
        guard: &SearchDispatchGuard,
    ) -> std::result::Result<WebSearchPageV1, SearchFailure> {
        self.entered.notify_one();
        if self.blocked {
            self.release.acquire().await.unwrap().forget();
        }
        guard.check(WebSearchProvider::Searxng)?;
        self.dispatches.fetch_add(1, Ordering::SeqCst);
        Ok(WebSearchPageV1 {
            results: vec![WebSearchHitV1 {
                title: "Owned policy fixture".into(),
                url: "https://example.com/policy".into(),
                snippet: "Deterministic host adapter output".into(),
                ..Default::default()
            }],
            ..Default::default()
        })
    }
}
fn web() -> WebSettings {
    let mut web = WebSettings::default();
    web.search
        .providers
        .retain(|p| p.id == WebSearchProvider::Searxng);
    web.fetch.proxy_mode = WebProxyMode::Direct;
    web
}
fn write(path: &std::path::Path, web: &WebSettings) {
    std::fs::write(path, serde_json::json!({"web":web}).to_string()).unwrap();
}
fn input(query: &str) -> WebSearchInput {
    serde_json::from_value(serde_json::json!({"query":query})).unwrap()
}
fn engine(
    root: &std::path::Path,
    blocked: bool,
) -> (QueryEngine, Arc<Backend>, std::path::PathBuf) {
    let config = root.join("profile");
    std::fs::create_dir(&config).unwrap();
    let path = config.join("settings.json");
    write(&path, &web());
    let loader = SettingsLoader::new(root)
        .with_config_dir(&config)
        .with_executable_dir(root);
    let mut snapshot = loader.load_read_only_configuration().unwrap().settings;
    snapshot.model = "frozen-model-fixture".into();
    let backend = Arc::new(Backend::new(blocked));
    let engine = TestEngineBuilder::new(root)
        .settings(snapshot)
        .build()
        .with_client_model_configuration(Arc::new(BoundSource(loader)))
        .with_bundled_search_backend(backend.clone());
    (engine, backend, path)
}

#[tokio::test]
async fn bound_source_changes_reach_the_next_call_and_cannot_reuse_a_revoked_cache() {
    let root = tempfile::tempdir().unwrap();
    let (engine, backend, path) = engine(root.path(), false);
    let context = engine.web_search_context(CancellationToken::new());
    let runtime = engine.web_search_runtime();
    let original = runtime
        .execute(input("policy source change"), &context)
        .await
        .unwrap();
    assert_eq!(original.status, WebSearchStatus::Success);
    let mut changed = web();
    changed.search.providers.clear();
    write(&path, &changed);
    let revoked = runtime
        .execute(input("policy source change"), &context)
        .await
        .unwrap();
    assert_eq!(revoked.failure, Some(WebSearchErrorKind::PolicyDenied));
    assert!(!revoked.cache_hit);
    assert!(revoked.attempts.is_empty());
    assert_eq!(backend.dispatches.load(Ordering::SeqCst), 1);
    assert_eq!(engine.settings.read().unwrap().web, web());
    assert_eq!(engine.model_name(), "frozen-model-fixture");
    changed = web();
    changed.search.preferred_provider = Some(WebSearchProvider::Searxng);
    write(&path, &changed);
    let next = engine.web_search_context(CancellationToken::new());
    assert_eq!(next.effective_web_settings().unwrap(), changed);
    assert_eq!(
        runtime
            .execute(input("updated preference"), &next)
            .await
            .unwrap()
            .status,
        WebSearchStatus::Success
    );
    std::fs::write(path, "{invalid document").unwrap();
    assert!(next.effective_web_settings().is_err());
}

#[tokio::test]
async fn bound_source_revocation_stops_an_inflight_request_before_adapter_dispatch() {
    let root = tempfile::tempdir().unwrap();
    let (engine, backend, path) = engine(root.path(), true);
    let context = engine.web_search_context(CancellationToken::new());
    let runtime = engine.web_search_runtime();
    let task =
        tokio::spawn(async move { runtime.execute(input("inflight revoke"), &context).await });
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        backend.entered.notified(),
    )
    .await
    .unwrap();
    let mut changed = web();
    changed.search.providers.clear();
    write(&path, &changed);
    backend.release.add_permits(1);
    let response = task.await.unwrap().unwrap();
    assert_eq!(response.failure, Some(WebSearchErrorKind::PolicyDenied));
    assert_eq!(backend.dispatches.load(Ordering::SeqCst), 0);
    assert!(
        response
            .attempts
            .iter()
            .all(|attempt| !attempt.request_sent)
    );
}

#[test]
fn older_host_default_keeps_the_existing_engine_arc_as_the_web_source() {
    struct OlderHost;
    impl ClientModelConfiguration for OlderHost {
        fn settings(&self, _: &str) -> Result<Settings> {
            panic!("unused")
        }
        fn provider(&self, _: &Settings) -> Result<Arc<dyn Provider>> {
            panic!("unused")
        }
    }
    let root = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(root.path())
        .build()
        .with_client_model_configuration(Arc::new(OlderHost));
    let context = engine.web_search_context(CancellationToken::new());
    engine.settings.write().unwrap().web = web();
    assert_eq!(context.effective_web_settings().unwrap(), web());
}

#[test]
fn engine_contexts_keep_separate_project_and_frozen_template_web_scopes() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("shared-profile");
    std::fs::create_dir(&config).unwrap();
    let path = config.join("settings.json");
    let mut current = WebSettings::default();
    write(&path, &current);
    let build = |name: &str, provider: WebSearchProvider| {
        let workspace = root.path().join(name);
        std::fs::create_dir(&workspace).unwrap();
        let project = workspace.join(".kcoder");
        std::fs::create_dir(&project).unwrap();
        let providers: Vec<_> = current
            .search
            .providers
            .iter()
            .filter(|p| p.id == provider)
            .collect();
        std::fs::write(
            project.join("settings.json"),
            serde_json::json!({"web":{"search":{"providers":providers}}}).to_string(),
        )
        .unwrap();
        let template = root.path().join(format!("{name}.json"));
        std::fs::write(
            &template,
            serde_json::json!({"web":{"search":{"preferredProvider":provider}}}).to_string(),
        )
        .unwrap();
        let loader = SettingsLoader::new(&workspace)
            .with_config_dir(&config)
            .with_executable_dir(root.path().join("no-executable-settings"))
            .with_overlay_files([template.clone()])
            .freeze_overlays()
            .unwrap();
        let snapshot = loader.load_read_only_configuration().unwrap().settings;
        let engine = TestEngineBuilder::new(&workspace)
            .settings(snapshot)
            .build()
            .with_client_model_configuration(Arc::new(BoundSource(loader)));
        (engine, template)
    };
    let (first, first_template) = build("first", WebSearchProvider::Searxng);
    let (second, _) = build("second", WebSearchProvider::Bing);
    let first_context = first.web_search_context(CancellationToken::new());
    let second_context = second.web_search_context(CancellationToken::new());
    current.fetch.proxy_mode = WebProxyMode::Direct;
    write(&path, &current);
    std::fs::write(
        first_template,
        serde_json::json!({"web":{"search":{"preferredProvider":WebSearchProvider::Bing}}})
            .to_string(),
    )
    .unwrap();
    for (context, expected) in [
        (&first_context, WebSearchProvider::Searxng),
        (&second_context, WebSearchProvider::Bing),
    ] {
        let resolved = context.effective_web_settings().unwrap();
        assert_eq!(resolved.fetch.proxy_mode, WebProxyMode::Direct);
        assert_eq!(resolved.search.candidates(None).unwrap(), [expected]);
        assert_eq!(resolved.search.preferred_provider, Some(expected));
    }
    assert_eq!(
        first.settings.read().unwrap().web.fetch.proxy_mode,
        WebProxyMode::Inherit
    );
    assert_eq!(
        second.settings.read().unwrap().web.fetch.proxy_mode,
        WebProxyMode::Inherit
    );
}

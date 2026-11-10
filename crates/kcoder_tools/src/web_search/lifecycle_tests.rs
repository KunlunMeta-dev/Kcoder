//! Owned loopback responses exercise session rotation, restore, cache and native receipts.
use super::*;
use crate::web_search::{BundledSearchBackend, SearchDispatchGuard, SearchFailure};
use kcoder_state::AppState;
use kcoder_types::{
    Message, TurnAttemptIdentity,
    web_search::{WebSearchErrorKind, WebSearchPageV1, WebSearchProvider, WebSearchStatus},
};
use serde_json::json;
use std::sync::{
    Arc, RwLock,
    atomic::{AtomicUsize, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct HttpSource {
    url: String,
}
#[async_trait::async_trait]
impl BundledSearchBackend for HttpSource {
    async fn search(
        &self,
        _: &WebSearchInput,
        guard: &SearchDispatchGuard,
    ) -> Result<WebSearchPageV1, SearchFailure> {
        guard.check(WebSearchProvider::Searxng)?;
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(&self.url)
            .send()
            .await
            .unwrap();
        Ok(serde_json::from_slice(&response.bytes().await.unwrap()).unwrap())
    }
}
struct Fixture {
    _root: tempfile::TempDir,
    state: AppState,
    history: std::path::PathBuf,
    settings: Arc<RwLock<kcoder_config::Settings>>,
    source: Arc<HttpSource>,
    requests: Arc<AtomicUsize>,
    runtime: Arc<WebSearchRuntime>,
    server: Option<tokio::task::JoinHandle<()>>,
}
impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        let history = root.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&history);
        state.add_message(Message::user_text("Owned public lifecycle fixture"));
        state.save_history().unwrap();
        let mut settings = kcoder_config::Settings::default();
        settings
            .web
            .search
            .providers
            .retain(|p| p.id == WebSearchProvider::Searxng);
        settings.web.fetch.proxy_mode = kcoder_config::WebProxyMode::Direct;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/owned", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buffer = [0; 1024];
                    let n = stream.read(&mut buffer).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..n]);
                    if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                        break;
                    }
                }
                let number = count.fetch_add(1, Ordering::SeqCst) + 1;
                let body = json!({"results":[{"title":format!("Actual response {number}"),"url":"https://example.com/owned","snippet":format!("Owned body {number}")}]}).to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        Self {
            _root: root,
            state,
            history,
            settings: Arc::new(RwLock::new(settings)),
            source: Arc::new(HttpSource { url }),
            requests,
            runtime: Arc::new(WebSearchRuntime::new()),
            server: Some(server),
        }
    }
    fn context(&self) -> ToolContext {
        ToolContext::new(self.state.clone())
            .with_runtime_settings(self.settings.clone())
            .with_bundled_search_backend(Some(self.source.clone()))
            .with_web_search_runtime(self.runtime.clone())
    }
    fn identity(&self) -> TurnAttemptIdentity {
        TurnAttemptIdentity {
            thread_id: self.state.session_id(),
            turn_id: "owned-turn".into(),
            attempt_id: "owned-attempt".into(),
        }
    }
    fn tracked(&self, identity: &TurnAttemptIdentity, call: &str) -> ToolContext {
        self.context()
            .with_native_web_source_identity(Some(identity.clone()))
            .with_tool_call_id(call)
    }
    fn input() -> WebSearchInput {
        serde_json::from_value(json!({"query":"owned public lifecycle query"})).unwrap()
    }
    async fn close(&mut self) {
        if let Some(server) = self.server.take() {
            server.abort();
            let _ = server.await;
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(server) = &self.server {
            server.abort();
        }
    }
}

#[tokio::test]
async fn fresh_context_after_new_session_never_reads_previous_lifecycle_cache() {
    let mut f = Fixture::new().await;
    let previous = f.context();
    let first = f
        .runtime
        .execute(Fixture::input(), &previous)
        .await
        .unwrap();
    assert_eq!(first.page.results[0].title, "Actual response 1");
    assert!(
        f.runtime
            .execute(Fixture::input(), &previous)
            .await
            .unwrap()
            .cache_hit
    );
    f.state.start_new_session().unwrap();
    let fresh = f.context();
    let result = f.runtime.execute(Fixture::input(), &fresh).await.unwrap();
    assert!(!result.cache_hit);
    assert_eq!(result.page.results[0].title, "Actual response 2");
    assert!(
        f.runtime
            .execute(Fixture::input(), &previous)
            .await
            .is_err()
    );
    let rejected = f.runtime.probe(Fixture::input(), &previous).await.unwrap();
    assert_eq!(rejected.status, WebSearchStatus::Failed);
    assert_eq!(rejected.failure, Some(WebSearchErrorKind::PolicyDenied));
    assert!(rejected.attempts.is_empty());
    assert_eq!(f.requests.load(Ordering::SeqCst), 2);
    f.close().await;
}
#[tokio::test]
async fn restoring_same_thread_id_rotates_cache_and_receipt_authority() {
    let mut f = Fixture::new().await;
    let id = f.identity();
    let previous = f.tracked(&id, "original-call");
    let first = f
        .runtime
        .execute(Fixture::input(), &previous)
        .await
        .unwrap();
    let duplicate = f
        .runtime
        .execute(Fixture::input(), &previous)
        .await
        .unwrap();
    assert_eq!(first.request_id, duplicate.request_id);
    assert_eq!(f.requests.load(Ordering::SeqCst), 1);
    f.state.resume_from_history(&f.history).unwrap();
    assert_eq!(f.state.session_id(), id.thread_id);
    let repeated = f.tracked(&id, "original-call");
    let error = f
        .runtime
        .execute(Fixture::input(), &repeated)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("earlier session lifecycle"));
    assert_eq!(
        f.requests.load(Ordering::SeqCst),
        1,
        "old receipt must neither leak nor redispatch"
    );
    let peer_state = AppState::new(f._root.path());
    peer_state.resume_from_history(&f.history).unwrap();
    assert_eq!(peer_state.session_id(), id.thread_id);
    let restored_peer = ToolContext::new(peer_state)
        .with_runtime_settings(f.settings.clone())
        .with_bundled_search_backend(Some(f.source.clone()))
        .with_web_search_runtime(f.runtime.clone())
        .with_native_web_source_identity(Some(id.clone()))
        .with_tool_call_id("original-call");
    assert!(
        f.runtime
            .execute(Fixture::input(), &restored_peer)
            .await
            .unwrap_err()
            .to_string()
            .contains("earlier session lifecycle")
    );
    assert_eq!(f.requests.load(Ordering::SeqCst), 1);
    let new_call = f.tracked(&id, "new-call");
    let fresh = f
        .runtime
        .execute(Fixture::input(), &new_call)
        .await
        .unwrap();
    assert!(!fresh.cache_hit);
    assert_eq!(fresh.page.results[0].title, "Actual response 2");
    assert!(
        f.runtime
            .execute(Fixture::input(), &previous)
            .await
            .is_err()
    );
    assert_eq!(f.requests.load(Ordering::SeqCst), 2);
    f.close().await;
}
#[tokio::test]
async fn old_unknown_receipt_cannot_be_reclassified_as_a_new_request_after_restore() {
    let mut f = Fixture::new().await;
    let id = f.identity();
    let previous = f.tracked(&id, "unknown-call");
    let crate::web_search::receipts::Claim::Owner(owner) =
        f.runtime.receipts.claim(&previous, "shape".into()).unwrap()
    else {
        panic!("native receipt owner required")
    };
    drop(owner);
    f.state.resume_from_history(&f.history).unwrap();
    let repeated = f.tracked(&id, "unknown-call");
    assert!(
        f.runtime
            .execute(Fixture::input(), &repeated)
            .await
            .unwrap_err()
            .to_string()
            .contains("earlier session lifecycle")
    );
    assert_eq!(f.requests.load(Ordering::SeqCst), 0);
    let fresh = f
        .runtime
        .execute(Fixture::input(), &f.tracked(&id, "independent-call"))
        .await
        .unwrap();
    assert_eq!(fresh.status, WebSearchStatus::Success);
    assert_eq!(f.requests.load(Ordering::SeqCst), 1);
    f.close().await;
}
#[tokio::test]
async fn native_identity_must_match_actual_thread_and_precancel_remains_distinct() {
    let mut f = Fixture::new().await;
    let mut wrong = f.identity();
    wrong.thread_id = "model-like-wrong-thread".into();
    // The native setter already filters an invalid declaration. Exercise the
    // service boundary too, against an internally stale/corrupted binding.
    assert!(
        f.tracked(&wrong, "filtered")
            .native_web_source_identity
            .is_none()
    );
    let mut context = f.context().with_tool_call_id("not-authorized");
    context.native_web_source_identity = Some(wrong);
    assert!(f.runtime.execute(Fixture::input(), &context).await.is_err());
    let rejected = f.runtime.probe(Fixture::input(), &context).await.unwrap();
    assert_eq!(rejected.failure, Some(WebSearchErrorKind::PolicyDenied));
    assert!(rejected.attempts.is_empty());
    let cancel = tokio_util::sync::CancellationToken::new();
    cancel.cancel();
    let cancelled = context.with_abort_token(cancel);
    assert_eq!(
        f.runtime
            .probe(Fixture::input(), &cancelled)
            .await
            .unwrap()
            .status,
        WebSearchStatus::Cancelled
    );
    assert_eq!(f.requests.load(Ordering::SeqCst), 0);
    f.close().await;
}

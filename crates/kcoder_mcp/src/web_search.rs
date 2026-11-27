//! Native search bridge to the existing verified SearXNG runtime.

use crate::searxng::SearxngTransport;
use async_trait::async_trait;
use kcoder_tools::web_search::{
    BundledSearchBackend, SearchDispatchGuard, SearchFailure, WebSearchInput,
};
use kcoder_types::web_search::{
    WebSearchEngineFailureV1, WebSearchErrorKind, WebSearchHitV1, WebSearchPageV1,
};
use serde_json::{Value, json};
use tokio::sync::Mutex;

/// Fast metadata discovery only; this does not start or verify a running service.
pub fn bundled_search_component_available() -> bool {
    crate::searxng_runtime::locate().is_ok()
}

/// Owned by one native engine. Construction performs no I/O and starts no worker.
#[derive(Default)]
pub struct BundledWebSearch {
    transport: Mutex<Option<SearxngTransport>>,
    network_generation: std::sync::Mutex<Option<u64>>,
}

impl BundledWebSearch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Release only this engine's managed service; another engine keeps its own owner.
    pub async fn close(&self) {
        self.transport.lock().await.take();
    }
}

struct RequestTransport<'a> {
    transport: &'a mut Option<SearxngTransport>,
    complete: bool,
}
impl Drop for RequestTransport<'_> {
    fn drop(&mut self) {
        if !self.complete {
            self.transport.take();
        }
    }
}

fn network_generation(network: &kcoder_config::WebFetchSettings) -> Result<u64, SearchFailure> {
    kcoder_tools::web_network::environment_fingerprint(network).map_err(|_| {
        SearchFailure::new(
            WebSearchErrorKind::PolicyDenied,
            "The target web proxy or CA policy is unavailable or unsupported",
            false,
        )
    })
}

fn invalid() -> SearchFailure {
    SearchFailure::new(
        WebSearchErrorKind::ContractInvalid,
        "Bundled search returned an invalid result document",
        true,
    )
}

fn parse_page(value: Value) -> Result<WebSearchPageV1, SearchFailure> {
    let rows = value["results"].as_array().ok_or_else(invalid)?;
    let mut results = Vec::new();
    for row in rows.iter().take(20) {
        let (Some(url), Some(title)) = (row["url"].as_str(), row["title"].as_str()) else {
            return Err(invalid());
        };
        results.push(WebSearchHitV1 {
            url: url.to_owned(),
            title: title.to_owned(),
            snippet: row["content"].as_str().unwrap_or("").to_owned(),
            published_at: row["publishedAt"].as_str().map(str::to_owned),
            author: row["author"].as_str().map(str::to_owned),
            ..Default::default()
        });
    }
    let engine_failures = value["unresponsive_engines"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .take(20)
                .filter_map(|row| {
                    Some(WebSearchEngineFailureV1 {
                        engine: row["engine"].as_str()?.chars().take(80).collect(),
                        reason: row["reason"].as_str()?.chars().take(160).collect(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(WebSearchPageV1 {
        results,
        incomplete: value["incomplete"].as_bool().unwrap_or(false),
        truncated: value["truncated"].as_bool().unwrap_or(false),
        engine_failures,
        ..Default::default()
    })
}

#[async_trait]
impl BundledSearchBackend for BundledWebSearch {
    fn startup_pending(&self) -> bool {
        self.transport
            .try_lock()
            .map(|slot| slot.as_ref().is_none_or(SearxngTransport::startup_pending))
            .unwrap_or(true)
    }
    async fn search(
        &self,
        input: &WebSearchInput,
        guard: &SearchDispatchGuard,
    ) -> Result<WebSearchPageV1, SearchFailure> {
        let plan = input.constraints.plan(
            kcoder_types::web_search::WebSearchProvider::Searxng,
            kcoder_tools::web_search::constraints::ProviderConstraintCapabilities {
                native_time_range: true,
                language: true,
                region: false,
            },
        )?;
        let mut arguments = json!({"query":input.query,"limit":input.num_results.unwrap_or(8)});
        if let Some(range) = plan.native_time_range {
            arguments["time_range"] = range.as_str().into();
        }
        if let Some(language) = plan.language {
            arguments["language"] = language.into();
        }
        guard.check(kcoder_types::web_search::WebSearchProvider::Searxng)?;
        let mut transport = self.transport.lock().await;
        guard.check(kcoder_types::web_search::WebSearchProvider::Searxng)?;
        // Effective proxy/CA environment belongs to the same owner generation.
        // A changed environment cannot reuse a running worker with old egress.
        let generation = network_generation(guard.network_settings())?;
        {
            let mut previous = self.network_generation.lock().map_err(|_| {
                SearchFailure::new(
                    WebSearchErrorKind::PolicyDenied,
                    "Bundled search network policy is unavailable",
                    false,
                )
            })?;
            if previous.is_some_and(|old| old != generation) {
                transport.take();
            }
            *previous = Some(generation);
        }
        if transport.is_none() {
            // This happens on an actual search, never during startup or tool discovery.
            let root = crate::searxng_runtime::locate().map_err(|_| {
                SearchFailure::new(
                    WebSearchErrorKind::ComponentUnavailable,
                    "Bundled search component is unavailable in this target",
                    false,
                )
            })?;
            *transport = Some(SearxngTransport::bundled(root));
        }
        // Canceling a queued waiter owns no lease. Once dispatch owns the
        // service, dropping its future revokes only this backend's worker.
        let mut lease = RequestTransport {
            transport: &mut transport,
            complete: false,
        };
        let current = lease
            .transport
            .as_mut()
            .expect("search transport initialized");
        current.set_network(guard.network_settings().clone(), generation);
        let value = current
            .search_guarded(arguments, Some(guard))
            .await
            .map_err(|error| {
                error.downcast::<SearchFailure>().unwrap_or_else(|_|SearchFailure::new(
                    WebSearchErrorKind::Network,
                    "Bundled search could not complete; its service or upstream may be unavailable",
                    true,
                ))
            })?;
        let page = parse_page(value)?;
        lease.complete = true;
        Ok(page)
    }
}

#[cfg(test)]
fn direct_guard(
    check: impl Fn(kcoder_types::web_search::WebSearchProvider) -> Result<(), SearchFailure>
    + Send
    + Sync
    + 'static,
) -> SearchDispatchGuard {
    SearchDispatchGuard::new(check).with_network_settings(kcoder_config::WebFetchSettings {
        proxy_mode: kcoder_config::WebProxyMode::Direct,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn search_owned_response(body: Value) -> Result<WebSearchPageV1, SearchFailure> {
        search_owned_http_response(body.to_string().into_bytes(), true).await
    }

    async fn search_owned_http_response(
        body: Vec<u8>,
        declared_length: bool,
    ) -> Result<WebSearchPageV1, SearchFailure> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let backend = BundledWebSearch {
            network_generation: std::sync::Mutex::new(None),
            transport: Mutex::new(Some(
                SearxngTransport::new(&endpoint, &HashMap::new()).unwrap(),
            )),
        };
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut chunk = [0; 1024];
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0 && request.len() + count <= 8192);
                request.extend_from_slice(&chunk[..count]);
            }
            assert!(request.starts_with(b"GET /search?"));
            let length = if declared_length {
                format!("Content-Length: {}\r\n", body.len())
            } else {
                String::new()
            };
            let oversized = body.len() > 2 * 1024 * 1024;
            let mut response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{length}Connection: close\r\n\r\n").into_bytes();
            response.extend_from_slice(&body);
            if let Err(error) = socket.write_all(&response).await {
                assert!(
                    oversized
                        && matches!(
                            error.kind(),
                            std::io::ErrorKind::BrokenPipe
                                | std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::ConnectionAborted
                        ),
                    "Only a rejected oversized response may disconnect early"
                );
            }
        });
        let input =
            serde_json::from_value(json!({"query":"owned source contract", "num_results":1}))
                .unwrap();
        let result = backend.search(&input, &direct_guard(|_| Ok(()))).await;
        peer.await.unwrap();
        backend.close().await;
        result
    }

    #[tokio::test]
    async fn native_bridge_rejects_all_invalid_upstream_urls_instead_of_empty_success() {
        for rows in [
            json!([{"title":"missing URL"}]),
            json!([{"title":"malformed URL", "url":"not a URL"}]),
            json!([{"title":"unsafe scheme", "url":"javascript:alert(1)"}]),
            json!([{"title":"embedded credentials", "url":"https://user:secret@example.test/"}]),
            json!([{"title":"oversize URL", "url":format!("https://example.test/{}", "x".repeat(4097))}]),
        ] {
            let error = search_owned_response(json!({"results":rows}))
                .await
                .expect_err("Invalid upstream rows must survive transport filtering as a failure");
            assert_eq!(error.kind, WebSearchErrorKind::ContractInvalid);
            assert!(error.request_sent);
        }
    }

    #[tokio::test]
    async fn native_bridge_keeps_safe_mixed_rows_and_genuine_empty_results() {
        let mixed = search_owned_response(json!({"results":[
            {"title":"unsafe", "url":"javascript:alert(1)"},
            {"title":"valid source", "url":"https://example.test/source", "content":"owned source"},
            {"title":"missing URL"}
        ]}))
        .await
        .unwrap();
        assert_eq!(mixed.results.len(), 1);
        assert_eq!(mixed.results[0].url, "https://example.test/source");
        assert!(!mixed.incomplete);
        let empty = search_owned_response(json!({"results":[]})).await.unwrap();
        assert!(empty.results.is_empty());
        assert!(!empty.incomplete && empty.engine_failures.is_empty());
    }

    #[tokio::test]
    async fn native_bridge_classifies_malformed_and_oversized_http_results_as_contract_invalid() {
        let oversized = json!({"results":[],"padding":"x".repeat(2 * 1024 * 1024)})
            .to_string()
            .into_bytes();
        for (body, declared_length) in [
            (b"UNTRUSTED_SOURCE_JSON".to_vec(), true),
            (br#"{"error":"UNTRUSTED_SOURCE_SHAPE"}"#.to_vec(), true),
            (br#"{"results":null}"#.to_vec(), true),
            (oversized.clone(), true),
            (oversized, false),
        ] {
            let error = search_owned_http_response(body, declared_length)
                .await
                .expect_err("Malformed source responses are not network failures or empty results");
            assert_eq!(error.kind, WebSearchErrorKind::ContractInvalid);
            assert!(error.request_sent);
            assert!(!error.message.contains("UNTRUSTED_SOURCE"));
        }
    }

    #[tokio::test]
    async fn native_bridge_queries_the_existing_json_api_without_mcp_configuration() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let backend = BundledWebSearch {
            network_generation: std::sync::Mutex::new(None),
            transport: Mutex::new(Some(
                SearxngTransport::new(&endpoint, &HashMap::new()).unwrap(),
            )),
        };
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                let mut chunk = [0; 1024];
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0 && bytes.len() + n <= 8192);
                bytes.extend_from_slice(&chunk[..n]);
            }
            let request = String::from_utf8(bytes).unwrap();
            assert!(request.starts_with("GET /search?"));
            assert!(request.contains("format=json"));
            assert!(!request.contains("limit"));
            let body = json!({"results":[{"title":"官方资料","url":"https://example.com/source","content":"原文摘要"}],"unresponsive_engines":[["test-engine","timeout"]]}).to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        });
        let input =
            serde_json::from_value(json!({"query":"中文官方资料", "num_results":3})).unwrap();
        let page = backend
            .search(&input, &direct_guard(|_| Ok(())))
            .await
            .unwrap();
        assert_eq!(page.results[0].url, "https://example.com/source");
        assert_eq!(page.results[0].snippet, "原文摘要");
        assert!(page.results[0].source_id.is_empty());
        assert!(page.incomplete);
        assert_eq!(page.engine_failures.len(), 1);
        peer.await.unwrap();
        backend.close().await;
        assert!(backend.transport.lock().await.is_none());
    }

    #[tokio::test]
    async fn construction_does_not_discover_components_or_start_a_service() {
        let backend = BundledWebSearch::new();
        assert!(backend.transport.lock().await.is_none());
        backend.close().await;
    }

    #[tokio::test]
    async fn policy_revoked_while_waiting_for_transport_never_reaches_the_json_api() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let backend = Arc::new(BundledWebSearch {
            network_generation: std::sync::Mutex::new(None),
            transport: Mutex::new(Some(
                SearxngTransport::new(&endpoint, &HashMap::new()).unwrap(),
            )),
        });
        let held = backend.transport.lock().await;
        let allowed = Arc::new(AtomicBool::new(true));
        let entered = Arc::new(tokio::sync::Notify::new());
        let state = allowed.clone();
        let notice = entered.clone();
        let guard = direct_guard(move |_| {
            notice.notify_one();
            if state.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(SearchFailure::new(
                    WebSearchErrorKind::PolicyDenied,
                    "fixture revocation",
                    false,
                ))
            }
        });
        let worker = backend.clone();
        let task = tokio::spawn(async move {
            let request = serde_json::from_value(json!({"query":"queued policy fixture"})).unwrap();
            worker.search(&request, &guard).await
        });
        entered.notified().await;
        allowed.store(false, Ordering::SeqCst);
        drop(held);
        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.kind, WebSearchErrorKind::PolicyDenied);
        assert!(!error.request_sent);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
        backend.close().await;
    }

    #[test]
    fn error_documents_do_not_become_empty_successes() {
        assert!(parse_page(json!({"error":"not a result"})).is_err());
        assert!(parse_page(json!({"results":[{"title":"missing link"}]})).is_err());
        assert!(
            parse_page(json!({"results":[]}))
                .unwrap()
                .results
                .is_empty()
        );
    }
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn backend() -> (Arc<BundledWebSearch>, tokio::net::TcpListener) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let transport = SearxngTransport::new(
            &format!("http://{}/", listener.local_addr().unwrap()),
            &HashMap::new(),
        )
        .unwrap();
        (
            Arc::new(BundledWebSearch {
                transport: Mutex::new(Some(transport)),
                network_generation: std::sync::Mutex::new(None),
            }),
            listener,
        )
    }
    fn input() -> WebSearchInput {
        serde_json::from_value(json!({"query":"owned cancellation fixture"})).unwrap()
    }
    #[tokio::test]
    async fn cancelling_the_active_request_releases_only_its_backend_service() {
        let (backend, listener) = backend().await;
        let (peer, peer_listener) = self::backend().await;
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            assert!(socket.read(&mut bytes).await.unwrap() > 0);
            seen_tx.send(()).unwrap();
            assert_eq!(
                tokio::time::timeout(std::time::Duration::from_secs(2), socket.read(&mut bytes))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        });
        let owned = backend.clone();
        let request =
            tokio::spawn(async move { owned.search(&input(), &direct_guard(|_| Ok(()))).await });
        seen_rx.await.unwrap();
        request.abort();
        let _ = request.await;
        assert!(backend.transport.lock().await.is_none());
        assert!(peer.transport.lock().await.is_some());
        server.await.unwrap();
        drop(peer_listener);
    }
    #[tokio::test]
    async fn cancelling_a_queued_waiter_does_not_stop_the_active_peer() {
        let (backend, listener) = backend().await;
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            assert!(socket.read(&mut bytes).await.unwrap() > 0);
            seen_tx.send(()).unwrap();
            finish_rx.await.unwrap();
            let body = json!({"results":[{"title":"Owned result","url":"https://example.com/source","content":"owned source"}]}).to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        });
        let active = backend.clone();
        let active =
            tokio::spawn(async move { active.search(&input(), &direct_guard(|_| Ok(()))).await });
        seen_rx.await.unwrap();
        let queued = backend.clone();
        let entered = Arc::new(tokio::sync::Notify::new());
        let notice = entered.clone();
        let queued = tokio::spawn(async move {
            queued
                .search(
                    &input(),
                    &direct_guard(move |_| {
                        notice.notify_one();
                        Ok(())
                    }),
                )
                .await
        });
        entered.notified().await;
        queued.abort();
        let _ = queued.await;
        finish_tx.send(()).unwrap();
        assert_eq!(active.await.unwrap().unwrap().results.len(), 1);
        assert!(backend.transport.lock().await.is_some());
        server.await.unwrap();
    }
}

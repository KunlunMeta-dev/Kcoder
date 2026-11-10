//! Search HTTP requests use the same pinned network transport as page readers.
use super::{SearchDispatchGuard, SearchFailure};
use crate::{ToolContext, ToolError};
use kcoder_types::web_search::{WebSearchErrorKind, WebSearchProvider};
use kcoder_web::providers::{Request, Response, Transport};
use reqwest::{Method, Url, header::HeaderMap};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::{future::Future, pin::Pin};

pub(super) enum SearchHttpResponse {
    Native(crate::web_network::WebResponse),
    Fixture(reqwest::Response),
}

impl Response for SearchHttpResponse {
    fn response(&mut self) -> &mut reqwest::Response {
        match self {
            Self::Native(owner) => &mut owner.response,
            Self::Fixture(response) => response,
        }
    }
}

pub(super) struct SearchHttp<'a> {
    pub client: &'a reqwest::Client,
    pub ctx: Option<&'a ToolContext>,
    pub guard: Option<&'a SearchDispatchGuard>,
}

#[async_trait::async_trait]
impl Transport for SearchHttp<'_> {
    fn check(&self, provider: WebSearchProvider) -> Result<(), SearchFailure> {
        self.guard.map_or(Ok(()), |guard| guard.check(provider))
    }

    async fn send(
        &self,
        provider: WebSearchProvider,
        request: Request,
    ) -> Result<Box<dyn Response>, SearchFailure> {
        let Request {
            method,
            url,
            headers,
            body,
        } = request;
        Ok(Box::new(
            send(
                self.ctx,
                self.client,
                method,
                url,
                headers,
                body,
                self.guard,
                provider,
            )
            .await?,
        ))
    }

    fn close_exa_session(&self, request: Request) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let client = self.client.clone();
        let context = self.ctx.map(|ctx| {
            let mut ctx = ctx
                .clone()
                .with_abort_token(tokio_util::sync::CancellationToken::new());
            ctx.web_dispatch_check = None;
            ctx
        });
        Box::pin(async move {
            let Request {
                method,
                url,
                headers,
                body,
            } = request;
            let _ = send(
                context.as_ref(),
                &client,
                method,
                url,
                headers,
                body,
                None,
                WebSearchProvider::Exa,
            )
            .await;
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn send(
    ctx: Option<&ToolContext>,
    client: &reqwest::Client,
    method: Method,
    url: Url,
    headers: HeaderMap,
    body: Option<Vec<u8>>,
    guard: Option<&SearchDispatchGuard>,
    provider: WebSearchProvider,
) -> Result<SearchHttpResponse, SearchFailure> {
    if let Some(ctx) = ctx {
        let rejected = Arc::new(Mutex::new(None));
        let dispatched = Arc::new(AtomicBool::new(false));
        let mut context = ctx.clone();
        // Public source requests cannot consume a separate page-reader origin grant.
        // The original context and its peers retain their own authority.
        context.web_network_authority = None;
        let guard = guard.cloned();
        let original = context.web_dispatch_check.clone();
        let slot = rejected.clone();
        let sent = dispatched.clone();
        context = context.with_web_dispatch_check(Arc::new(move || {
            if let Some(original) = &original
                && let Err(error) = original()
            {
                let kind = if matches!(error, ToolError::Aborted) {
                    WebSearchErrorKind::Cancelled
                } else {
                    WebSearchErrorKind::PolicyDenied
                };
                *slot
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(SearchFailure::new(
                    kind,
                    "Search dispatch is restricted by the current host policy",
                    false,
                ));
                return Err(error);
            }
            if let Some(guard) = &guard
                && let Err(error) = guard.check(provider)
            {
                *slot
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error);
                return Err(ToolError::Execution("Search dispatch was denied".into()));
            }
            sent.store(true, Ordering::Release);
            Ok(())
        }));
        let response = crate::web_network::send(&context, method, url, headers, body)
            .await
            .map_err(|error| {
                rejected
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take()
                    .unwrap_or_else(|| {
                        let kind = if matches!(error, ToolError::Aborted) {
                            WebSearchErrorKind::Cancelled
                        } else {
                            WebSearchErrorKind::Network
                        };
                        SearchFailure::new(
                            kind,
                            "Search network request did not complete",
                            dispatched.load(Ordering::Acquire),
                        )
                    })
            })?;
        Ok(SearchHttpResponse::Native(response))
    } else {
        // Only internal protocol fixtures use an explicitly supplied transport without a context.
        let mut request = client.request(method, url).headers(headers);
        if let Some(body) = body {
            request = request.body(body);
        }
        Ok(SearchHttpResponse::Fixture(
            request
                .send()
                .await
                .map_err(super::routing::network_failure)?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn public_sources_reject_page_grants_without_revoking_the_original_reader() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for provider in [WebSearchProvider::Exa, WebSearchProvider::Bing] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let state = kcoder_state::AppState::new(".");
            let authority = crate::web_network::WebNetworkAuthority::new(&state);
            authority
                .grant_origin(&origin, std::time::Duration::from_secs(5))
                .unwrap();
            let mut settings = kcoder_config::Settings::default();
            settings.web.fetch.proxy_mode = kcoder_config::WebProxyMode::Direct;
            let ctx = ToolContext::new(state)
                .with_web_network_authority(authority)
                .with_runtime_settings(Arc::new(std::sync::RwLock::new(settings)));
            let response = send(
                Some(&ctx),
                &reqwest::Client::new(),
                Method::GET,
                Url::parse(&origin).unwrap(),
                HeaderMap::new(),
                None,
                None,
                provider,
            )
            .await;
            let error = match response {
                Err(error) => error,
                Ok(_) => panic!("Public source used a page-reader grant"),
            };
            assert!(!error.request_sent);
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(30), listener.accept())
                    .await
                    .is_err()
            );
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut input = [0; 2048];
                assert!(socket.read(&mut input).await.unwrap() > 0);
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
            });
            // The actual generic page transport still receives its original
            // exact-origin authority. The source clone never revokes a peer.
            let response = crate::web_network::send(
                &ctx,
                Method::GET,
                Url::parse(&origin).unwrap(),
                HeaderMap::new(),
                None,
            )
            .await
            .unwrap();
            assert_eq!(response.response.status(), reqwest::StatusCode::OK);
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn source_guard_preserves_host_dispatch_check_and_records_no_query() {
        // A public literal needs no external DNS. The actual final Native
        // dispatch fence denies before request.send opens an HTTP connection.
        let origin = "http://1.1.1.1/";
        let state = kcoder_state::AppState::new(".");
        let mut settings = kcoder_config::Settings::default();
        settings.web.fetch.proxy_mode = kcoder_config::WebProxyMode::Direct;
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let called = calls.clone();
        let ctx = ToolContext::new(state)
            .with_runtime_settings(Arc::new(std::sync::RwLock::new(settings)))
            .with_web_dispatch_check(Arc::new(move || {
                called.fetch_add(1, Ordering::SeqCst);
                Err(ToolError::Execution("host dispatch revoked".into()))
            }));
        let guard = SearchDispatchGuard::new(|_| Ok(()));
        let outcome = send(
            Some(&ctx),
            &reqwest::Client::new(),
            Method::POST,
            Url::parse(origin).unwrap(),
            HeaderMap::new(),
            None,
            Some(&guard),
            WebSearchProvider::Exa,
        )
        .await;
        let error = match outcome {
            Err(error) => error,
            Ok(_) => panic!("revoked host dispatch sent a request"),
        };
        assert!(!error.request_sent);
        assert_eq!(error.kind, WebSearchErrorKind::PolicyDenied);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(ctx.web_dispatch_check.is_some());
    }
}

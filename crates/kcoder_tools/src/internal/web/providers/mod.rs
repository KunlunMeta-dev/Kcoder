//! Public search provider protocols over transport supplied by the owning host.
use std::{future::Future, pin::Pin};

use crate::search::SearchFailure;
use kcoder_types::web_search::{WebSearchErrorKind, WebSearchProvider};
use reqwest::{Method, Url, header::HeaderMap};

#[path = "bing.rs"]
pub mod bing;
#[path = "bing_redirect.rs"]
mod bing_redirect;
#[path = "exa.rs"]
pub mod exa;

pub struct Request {
    pub method: Method,
    pub url: Url,
    pub headers: HeaderMap,
    pub body: Option<Vec<u8>>,
}

/// The response keeps its transport resources alive through body consumption.
pub trait Response: Send {
    fn response(&mut self) -> &mut reqwest::Response;
}

#[async_trait::async_trait]
pub trait Transport: Sync {
    fn check(&self, provider: WebSearchProvider) -> Result<(), SearchFailure>;

    async fn send(
        &self,
        provider: WebSearchProvider,
        request: Request,
    ) -> Result<Box<dyn Response>, SearchFailure>;

    /// Acquire the host's cleanup operation so it can outlive the search future.
    fn close_exa_session(&self, request: Request) -> Pin<Box<dyn Future<Output = ()> + Send>>;
}

fn http_failure(status: reqwest::StatusCode) -> SearchFailure {
    let kind = match status.as_u16() {
        401 | 403 => WebSearchErrorKind::Authentication,
        402 => WebSearchErrorKind::QuotaExhausted,
        429 => WebSearchErrorKind::RateLimited,
        500..=599 => WebSearchErrorKind::Network,
        _ => WebSearchErrorKind::ContractInvalid,
    };
    SearchFailure::new(
        kind,
        format!("Search service returned HTTP {}", status.as_u16()),
        true,
    )
}

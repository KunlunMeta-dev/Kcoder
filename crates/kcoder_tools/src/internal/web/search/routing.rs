//! Result bounds and fallback timing across already selected search sources.
use crate::search::{
    SearchFailure,
    request::{WebSearchInput, filter_results},
};
use async_trait::async_trait;
use kcoder_tool_error::ToolError;
use kcoder_types::web_search::{
    WEB_SEARCH_ATTEMPT_LIMIT, WEB_SEARCH_RESPONSE_VERSION, WebSearchAttemptV1, WebSearchErrorKind,
    WebSearchPageV1, WebSearchProvider, WebSearchResponseV1, WebSearchStatus,
};
use std::{collections::HashSet, time::Duration};
use tokio::time::{Instant, timeout_at};
use tokio_util::sync::CancellationToken;

pub const SEARCH_DEADLINE: Duration = Duration::from_secs(45);
pub const ATTEMPT_DEADLINE: Duration = Duration::from_secs(15);

#[async_trait]
pub trait SearchBackend: Send + Sync {
    fn startup_timeout(&self, _provider: WebSearchProvider) -> Option<Duration> {
        None
    }
    async fn search(
        &self,
        provider: WebSearchProvider,
        input: &WebSearchInput,
    ) -> Result<WebSearchPageV1, SearchFailure>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchPolicy {
    Auto,
    Pinned(WebSearchProvider),
    Configured(Vec<WebSearchProvider>),
}

impl SearchPolicy {
    pub fn from_override(value: Option<&str>) -> Result<Self, ToolError> {
        match value {
            None | Some("auto") => Ok(Self::Auto),
            Some("exa") => Ok(Self::Pinned(WebSearchProvider::Exa)),
            Some("bing") => Ok(Self::Pinned(WebSearchProvider::Bing)),
            _ => Err(ToolError::InvalidInput(
                "KCODER_WEB_SEARCH_PROVIDER must be exa, bing or auto".into(),
            )),
        }
    }

    pub fn candidates(self) -> Vec<WebSearchProvider> {
        match self {
            Self::Auto => vec![
                WebSearchProvider::Exa,
                WebSearchProvider::Searxng,
                WebSearchProvider::Bing,
            ],
            Self::Pinned(provider) => vec![provider],
            Self::Configured(providers) => providers,
        }
    }
}

pub fn bounded_page(
    mut page: WebSearchPageV1,
    input: &WebSearchInput,
    request_id: &str,
) -> Result<WebSearchPageV1, SearchFailure> {
    let raw_count = page.results.len();
    // Incomplete upstream work cannot establish an empty result. Check before
    // filtering so user restrictions never cause an additional source query.
    if raw_count == 0 && (page.incomplete || !page.engine_failures.is_empty()) {
        return Err(SearchFailure::new(
            WebSearchErrorKind::Network,
            "Search source returned no results and reported incomplete upstream processing",
            true,
        ));
    }
    let mut seen = HashSet::new();
    page.results.retain_mut(|hit| {
        let Ok(mut url) = url::Url::parse(&hit.url) else {
            return false;
        };
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || hit.url.len() > 4096
            || hit.title.trim().is_empty()
        {
            return false;
        }
        hit.url = url.to_string();
        url.set_fragment(None);
        if !seen.insert(url.to_string()) {
            return false;
        }
        hit.title = hit.title.chars().take(300).collect();
        hit.snippet = hit.snippet.chars().take(4000).collect();
        hit.published_at = hit
            .published_at
            .take()
            .map(|v| v.chars().take(64).collect());
        hit.author = hit.author.take().map(|v| v.chars().take(200).collect());
        true
    });
    if raw_count > 0 && page.results.is_empty() {
        return Err(SearchFailure::new(
            WebSearchErrorKind::ContractInvalid,
            "Search response contained no valid source links",
            true,
        ));
    }
    page.results = filter_results(page.results, input);
    let limit = input.num_results.unwrap_or(8).min(20);
    page.truncated |= page.results.len() > limit;
    page.results.truncate(limit);
    for (index, result) in page.results.iter_mut().enumerate() {
        result.source_id = format!("{request_id}:{}", index + 1);
    }
    page.engine_failures.truncate(20);
    for failure in &mut page.engine_failures {
        failure.engine = failure.engine.chars().take(80).collect();
        failure.reason = failure.reason.chars().take(160).collect();
    }
    page.incomplete |= !page.engine_failures.is_empty();
    let report = input
        .constraints
        .filter_page(&mut page, chrono::Utc::now())
        .map_err(SearchFailure::contract)?;
    if report.applied {
        if report.retained == 0 && report.limited_by_date_evidence() {
            return Err(SearchFailure::new(
                WebSearchErrorKind::Unsupported,
                "This source did not provide sufficient publication evidence for the requested window",
                true,
            ));
        }
        page.constraint_notes.push(format!("Publication window applied: {} retained; {} unknown dates, {} ambiguous dates, {} outside-window dates, {} future dates omitted.",
            report.retained,report.dropped_unknown_date,report.dropped_ambiguous_date,report.dropped_outside_window,report.dropped_future_date));
        page.incomplete |= report.limited_by_date_evidence();
    }
    page.constraint_notes.truncate(8);
    for note in &mut page.constraint_notes {
        *note = note.chars().take(512).collect();
    }
    Ok(page)
}

pub async fn run_search_with_limits(
    backend: &dyn SearchBackend,
    input: &WebSearchInput,
    policy: SearchPolicy,
    cancel: &CancellationToken,
    total: Duration,
    per_attempt: Duration,
) -> WebSearchResponseV1 {
    let started = Instant::now();
    let deadline = started + total;
    let mut response = WebSearchResponseV1 {
        schema_version: WEB_SEARCH_RESPONSE_VERSION,
        request_id: uuid::Uuid::new_v4().to_string(),
        status: WebSearchStatus::Failed,
        failure: None,
        provider: None,
        retrieved_at: chrono::Utc::now().to_rfc3339(),
        elapsed_ms: 0,
        page: WebSearchPageV1::default(),
        attempts: Vec::new(),
        cache_hit: false,
        cache_age_ms: 0,
    };
    let candidates = policy.candidates();
    if candidates.is_empty() {
        response.failure = Some(WebSearchErrorKind::PolicyDenied);
    }
    if cancel.is_cancelled() {
        response.status = WebSearchStatus::Cancelled;
        response.failure = Some(WebSearchErrorKind::Cancelled);
        return response;
    }
    for provider in candidates.into_iter().take(WEB_SEARCH_ATTEMPT_LIMIT) {
        if cancel.is_cancelled() {
            response.status = WebSearchStatus::Cancelled;
            response.failure = Some(WebSearchErrorKind::Cancelled);
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        let attempt_started = Instant::now();
        let outcome = tokio::select! {
            biased;
            () = cancel.cancelled() => Err(SearchFailure::new(WebSearchErrorKind::Cancelled, "Search cancelled", true)),
            result = timeout_at(deadline.min(attempt_started + backend.startup_timeout(provider).unwrap_or(per_attempt)), backend.search(provider, input)) => {
                result.unwrap_or_else(|_| Err(SearchFailure::new(WebSearchErrorKind::Timeout, "Search attempt timed out", true)))
                    .and_then(|page| bounded_page(page, input, &response.request_id))
            }
        };
        let elapsed_ms = attempt_started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        match outcome {
            Ok(page) => {
                response.failure = None;
                response.status = if page.incomplete {
                    WebSearchStatus::Partial
                } else if page.results.is_empty() {
                    WebSearchStatus::Empty
                } else {
                    WebSearchStatus::Success
                };
                response.attempts.push(WebSearchAttemptV1 {
                    provider,
                    elapsed_ms,
                    status: response.status,
                    error: None,
                    request_sent: true,
                });
                response.provider = Some(provider);
                response.page = page;
                break;
            }
            Err(error) => {
                response.failure = Some(error.kind);
                let cancelled = error.kind == WebSearchErrorKind::Cancelled;
                response.attempts.push(WebSearchAttemptV1 {
                    provider,
                    elapsed_ms,
                    status: if cancelled {
                        WebSearchStatus::Cancelled
                    } else {
                        WebSearchStatus::Failed
                    },
                    error: Some(error.kind),
                    request_sent: error.request_sent,
                });
                if cancelled {
                    response.status = WebSearchStatus::Cancelled;
                }
                if !error.kind.allows_fallback() {
                    break;
                }
            }
        }
    }
    response.elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    response.retrieved_at = chrono::Utc::now().to_rfc3339();
    response
}

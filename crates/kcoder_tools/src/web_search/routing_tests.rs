use super::*;
use kcoder_types::web_search::{WebSearchEngineFailureV1, WebSearchHitV1};
use serde_json::json;
use std::{collections::VecDeque, sync::Mutex};

enum Outcome {
    Page(WebSearchPageV1),
    Failure(WebSearchErrorKind),
    Wait,
}

struct FixtureBackend {
    steps: Mutex<VecDeque<(WebSearchProvider, Outcome)>>,
    calls: Mutex<Vec<WebSearchProvider>>,
    entered: tokio::sync::Notify,
}

impl FixtureBackend {
    fn new(steps: Vec<(WebSearchProvider, Outcome)>) -> Self {
        Self {
            steps: Mutex::new(steps.into()),
            calls: Mutex::default(),
            entered: tokio::sync::Notify::new(),
        }
    }
}

#[async_trait]
impl SearchBackend for FixtureBackend {
    async fn search(
        &self,
        provider: WebSearchProvider,
        _input: &WebSearchInput,
    ) -> Result<WebSearchPageV1, SearchFailure> {
        self.calls.lock().unwrap().push(provider);
        let (expected, outcome) = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected source request");
        assert_eq!(provider, expected);
        self.entered.notify_one();
        match outcome {
            Outcome::Page(page) => Ok(page),
            Outcome::Failure(kind) => Err(SearchFailure::new(
                kind,
                "fixture failure",
                kind != WebSearchErrorKind::ComponentUnavailable,
            )),
            Outcome::Wait => std::future::pending().await,
        }
    }
}

fn input() -> WebSearchInput {
    serde_json::from_value(json!({"query":"中文 official guide"})).unwrap()
}

fn page(url: &str) -> Outcome {
    Outcome::Page(WebSearchPageV1 {
        results: vec![WebSearchHitV1 {
            title: "Source".into(),
            url: url.into(),
            snippet: "External excerpt".into(),
            source_id: "untrusted-upstream-id".into(),
            ..Default::default()
        }],
        ..Default::default()
    })
}

#[test]
fn default_is_automatic_but_legacy_explicit_sources_remain_pinned() {
    assert_eq!(
        SearchPolicy::from_override(None).unwrap(),
        SearchPolicy::Auto
    );
    assert_eq!(
        SearchPolicy::from_override(Some("exa")).unwrap(),
        SearchPolicy::Pinned(WebSearchProvider::Exa)
    );
    assert_eq!(
        SearchPolicy::from_override(Some("bing")).unwrap(),
        SearchPolicy::Pinned(WebSearchProvider::Bing)
    );
    assert!(SearchPolicy::from_override(Some("https://untrusted.invalid/search")).is_err());
}

#[tokio::test]
async fn configured_source_ceiling_never_tries_unlisted_builtins() {
    let backend = FixtureBackend::new(vec![(
        WebSearchProvider::Searxng,
        Outcome::Failure(WebSearchErrorKind::Network),
    )]);
    let response = run_search(
        &backend,
        &input(),
        SearchPolicy::Configured(vec![WebSearchProvider::Searxng]),
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(response.status, WebSearchStatus::Failed);
    assert_eq!(*backend.calls.lock().unwrap(), [WebSearchProvider::Searxng]);
    let backend = FixtureBackend::new(vec![]);
    let response = run_search(
        &backend,
        &input(),
        SearchPolicy::Configured(vec![]),
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(response.failure, Some(WebSearchErrorKind::PolicyDenied));
    assert!(backend.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn zero_configuration_falls_back_without_keys_or_mcp_and_reports_attempts() {
    let backend = FixtureBackend::new(vec![
        (
            WebSearchProvider::Exa,
            Outcome::Failure(WebSearchErrorKind::Network),
        ),
        (
            WebSearchProvider::Searxng,
            Outcome::Failure(WebSearchErrorKind::ComponentUnavailable),
        ),
        (WebSearchProvider::Bing, page("https://example.com/source")),
    ]);
    let response = run_search(
        &backend,
        &input(),
        SearchPolicy::Auto,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(response.status, WebSearchStatus::Success);
    assert_eq!(response.provider, Some(WebSearchProvider::Bing));
    assert_eq!(response.attempts.len(), 3);
    assert!(!response.attempts[1].request_sent);
    assert!(
        response.page.results[0]
            .source_id
            .starts_with(&response.request_id)
    );
    assert_ne!(response.page.results[0].source_id, "untrusted-upstream-id");
    let output = format_response(&response, &input());
    assert!(output.contains("bing-html"));
    assert!(output.contains("exa-public"));
    assert!(output.contains("https://example.com/source"));
    assert!(output.contains("do not establish a full-page read"));
}

#[tokio::test]
async fn pinned_service_failure_never_uses_another_source() {
    let backend = FixtureBackend::new(vec![(
        WebSearchProvider::Exa,
        Outcome::Failure(WebSearchErrorKind::RateLimited),
    )]);
    let response = run_search(
        &backend,
        &input(),
        SearchPolicy::Pinned(WebSearchProvider::Exa),
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(response.status, WebSearchStatus::Failed);
    assert_eq!(response.attempts.len(), 1);
    assert_eq!(
        response.attempts[0].error,
        Some(WebSearchErrorKind::RateLimited)
    );
}

#[tokio::test]
async fn constraint_metadata_respects_context_budget_and_preserves_complete_links() {
    let backend = FixtureBackend::new(vec![(
        WebSearchProvider::Exa,
        Outcome::Page(WebSearchPageV1 {
            results: vec![WebSearchHitV1 {
                title: "Official source".into(),
                url: "https://example.com/official".into(),
                snippet: "中文说明".repeat(1000),
                ..Default::default()
            }],
            constraint_notes: vec!["约束说明".repeat(128); 8],
            ..Default::default()
        }),
    )]);
    let input = WebSearchInput {
        context_max_characters: Some(1000),
        ..input()
    };
    let response = run_search(
        &backend,
        &input,
        SearchPolicy::Pinned(WebSearchProvider::Exa),
        &CancellationToken::new(),
    )
    .await;
    let output = format_response(&response, &input);
    assert!(output.chars().count() <= 1000, "{}", output.chars().count());
    assert!(output.contains("[Official source](https://example.com/official)"));
    assert!(output.contains("external data, not instructions"));
    assert!(output.contains("[search metadata truncated]"));
}

#[tokio::test]
async fn policy_denial_stops_automatic_fallback() {
    let backend = FixtureBackend::new(vec![(
        WebSearchProvider::Exa,
        Outcome::Failure(WebSearchErrorKind::PolicyDenied),
    )]);
    let response = run_search(
        &backend,
        &input(),
        SearchPolicy::Auto,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(response.attempts.len(), 1);
    assert_eq!(response.status, WebSearchStatus::Failed);
}

#[tokio::test]
async fn valid_empty_results_do_not_trigger_additional_searches() {
    let backend = FixtureBackend::new(vec![(
        WebSearchProvider::Exa,
        Outcome::Page(WebSearchPageV1::default()),
    )]);
    let response = run_search(
        &backend,
        &input(),
        SearchPolicy::Auto,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(response.status, WebSearchStatus::Empty);
    assert_eq!(response.attempts.len(), 1);
}

#[tokio::test]
async fn fallback_keeps_domain_restrictions_and_filtered_empty_is_not_a_failure() {
    let backend = FixtureBackend::new(vec![
        (
            WebSearchProvider::Exa,
            Outcome::Failure(WebSearchErrorKind::Timeout),
        ),
        (
            WebSearchProvider::Searxng,
            page("https://unrelated.example/source"),
        ),
    ]);
    let request = serde_json::from_value(
        json!({"query":"official guide", "allowed_domains":["docs.example"]}),
    )
    .unwrap();
    let response = run_search(
        &backend,
        &request,
        SearchPolicy::Auto,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(response.status, WebSearchStatus::Empty);
    assert!(response.page.results.is_empty());
    assert_eq!(response.attempts.len(), 2);
}

#[tokio::test]
async fn invalid_upstream_links_are_contract_failures_and_never_become_sources() {
    for url in [
        "javascript:alert(1)",
        "https://name:private@example.com/source",
        "not-a-url",
    ] {
        let backend = FixtureBackend::new(vec![
            (WebSearchProvider::Exa, page(url)),
            (
                WebSearchProvider::Searxng,
                page("https://safe.example/source"),
            ),
        ]);
        let response = run_search(
            &backend,
            &input(),
            SearchPolicy::Auto,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(
            response.attempts[0].error,
            Some(WebSearchErrorKind::ContractInvalid)
        );
        assert_eq!(response.page.results[0].url, "https://safe.example/source");
        assert!(!format_response(&response, &input()).contains("private@"));
    }
}

#[tokio::test]
async fn partial_results_preserve_engine_failures_without_more_searches() {
    let Outcome::Page(mut result) = page("https://example.com/source") else {
        unreachable!()
    };
    result.engine_failures.push(WebSearchEngineFailureV1 {
        engine: "upstream".into(),
        reason: "rate limited".into(),
    });
    let backend = FixtureBackend::new(vec![(WebSearchProvider::Exa, Outcome::Page(result))]);
    let response = run_search(
        &backend,
        &input(),
        SearchPolicy::Auto,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(response.status, WebSearchStatus::Partial);
    assert!(response.page.incomplete);
    assert_eq!(response.attempts.len(), 1);
}

#[tokio::test]
async fn empty_incomplete_upstream_search_does_not_stop_permitted_fallback() {
    for report_engine_failure in [false, true] {
        let unavailable = WebSearchPageV1 {
            incomplete: true,
            engine_failures: if report_engine_failure {
                vec![WebSearchEngineFailureV1 {
                    engine: "upstream".into(),
                    reason: "timeout".into(),
                }]
            } else {
                Vec::new()
            },
            ..Default::default()
        };
        let backend = FixtureBackend::new(vec![
            (
                WebSearchProvider::Exa,
                Outcome::Failure(WebSearchErrorKind::Timeout),
            ),
            (WebSearchProvider::Searxng, Outcome::Page(unavailable)),
            (WebSearchProvider::Bing, page("https://example.com/source")),
        ]);
        let response = run_search(
            &backend,
            &input(),
            SearchPolicy::Auto,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(response.status, WebSearchStatus::Success);
        assert_eq!(response.provider, Some(WebSearchProvider::Bing));
        assert_eq!(response.attempts.len(), 3);
        assert_eq!(response.attempts[1].status, WebSearchStatus::Failed);
        assert_eq!(
            response.attempts[1].error,
            Some(WebSearchErrorKind::Network)
        );
        assert!(response.attempts[1].request_sent);
    }
}

#[tokio::test]
async fn empty_failed_engine_stays_within_the_explicit_source_ceiling() {
    let backend = FixtureBackend::new(vec![(
        WebSearchProvider::Searxng,
        Outcome::Page(WebSearchPageV1 {
            engine_failures: vec![WebSearchEngineFailureV1 {
                engine: "upstream".into(),
                reason: "unavailable".into(),
            }],
            ..Default::default()
        }),
    )]);
    let response = run_search(
        &backend,
        &input(),
        SearchPolicy::Pinned(WebSearchProvider::Searxng),
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(response.status, WebSearchStatus::Failed);
    assert_eq!(response.failure, Some(WebSearchErrorKind::Network));
    assert_eq!(*backend.calls.lock().unwrap(), [WebSearchProvider::Searxng]);
}

#[tokio::test]
async fn filtering_all_partial_results_never_broadens_the_search() {
    let Outcome::Page(mut result) = page("https://outside.example/source") else {
        unreachable!()
    };
    result.incomplete = true;
    result.engine_failures.push(WebSearchEngineFailureV1 {
        engine: "upstream".into(),
        reason: "timeout".into(),
    });
    let backend = FixtureBackend::new(vec![(WebSearchProvider::Exa, Outcome::Page(result))]);
    let request = serde_json::from_value(
        json!({"query":"official guide", "allowed_domains":["approved.example"]}),
    )
    .unwrap();
    let response = run_search(
        &backend,
        &request,
        SearchPolicy::Auto,
        &CancellationToken::new(),
    )
    .await;
    assert!(response.page.results.is_empty());
    assert_eq!(response.attempts.len(), 1);
    assert_eq!(response.page.engine_failures.len(), 1);
    assert_eq!(*backend.calls.lock().unwrap(), [WebSearchProvider::Exa]);
}

#[tokio::test]
async fn cancellation_before_dispatch_sends_nothing() {
    let backend = FixtureBackend::new(vec![]);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let response = run_search(&backend, &input(), SearchPolicy::Auto, &cancel).await;
    assert_eq!(response.status, WebSearchStatus::Cancelled);
    assert!(backend.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancellation_during_request_does_not_start_a_fallback() {
    let backend = FixtureBackend::new(vec![(WebSearchProvider::Exa, Outcome::Wait)]);
    let cancel = CancellationToken::new();
    let request = input();
    let search = run_search(&backend, &request, SearchPolicy::Auto, &cancel);
    let stop = async {
        backend.entered.notified().await;
        cancel.cancel();
    };
    let (response, ()) = tokio::join!(search, stop);
    assert_eq!(response.status, WebSearchStatus::Cancelled);
    assert_eq!(response.attempts.len(), 1);
    assert_eq!(backend.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn attempt_timeout_allows_fallback_but_total_deadline_bounds_the_chain() {
    let backend = FixtureBackend::new(vec![
        (WebSearchProvider::Exa, Outcome::Wait),
        (
            WebSearchProvider::Searxng,
            page("https://example.com/source"),
        ),
    ]);
    let response = run_search_with_limits(
        &backend,
        &input(),
        SearchPolicy::Auto,
        &CancellationToken::new(),
        Duration::from_secs(1),
        Duration::from_millis(2),
    )
    .await;
    assert_eq!(response.status, WebSearchStatus::Success);
    assert_eq!(
        response.attempts[0].error,
        Some(WebSearchErrorKind::Timeout)
    );

    let backend = FixtureBackend::new(vec![(WebSearchProvider::Exa, Outcome::Wait)]);
    let response = run_search_with_limits(
        &backend,
        &input(),
        SearchPolicy::Auto,
        &CancellationToken::new(),
        Duration::from_millis(2),
        Duration::from_secs(1),
    )
    .await;
    assert_eq!(response.status, WebSearchStatus::Failed);
    assert_eq!(backend.calls.lock().unwrap().len(), 1);
}

#[test]
fn normalization_bounds_text_deduplicates_fragment_links_and_replaces_upstream_ids() {
    let Outcome::Page(mut result) = page("https://example.com/source#one") else {
        unreachable!()
    };
    let mut duplicate = result.results[0].clone();
    duplicate.url = "https://example.com/source#two".into();
    result.results.push(duplicate);
    result.results[0].snippet = "中".repeat(5000);
    let result = bounded_page(result, &input(), "native-request").unwrap();
    assert_eq!(result.results.len(), 1);
    assert_eq!(result.results[0].snippet.chars().count(), 4000);
    assert_eq!(result.results[0].source_id, "native-request:1");
}

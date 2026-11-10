pub mod account_admission;
#[cfg(test)]
mod exa;
mod http;
mod lifecycle;
mod policy;
mod receipts;
mod routing;
mod runtime;
pub use kcoder_web::search::request::{LivecrawlMode, SearchType, WebSearchInput};
pub use kcoder_web::search::{SearchFailure, constraints, provider_results};
#[cfg(test)]
use kcoder_web::search::{bing::validate_bing_page, request::filter_results};
pub use policy::SearchDispatchGuard;
pub use routing::BundledSearchBackend;
pub use runtime::{WebSearchRuntime, WebSearchRuntimeSnapshot};

use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use serde_json::Value;
#[cfg(test)]
use std::time::Duration;

#[cfg(test)]
use kcoder_web::providers::bing::ENDPOINT as BING_SEARCH_URL;

#[cfg(test)]
async fn search_bing_page(
    client: &reqwest::Client,
    input: &WebSearchInput,
    search_url: &str,
    max_retries: u32,
    guard: Option<&SearchDispatchGuard>,
    ctx: Option<&ToolContext>,
) -> Result<kcoder_types::web_search::WebSearchPageV1, SearchFailure> {
    kcoder_web::providers::bing::search_page(
        &http::SearchHttp { client, guard, ctx },
        input,
        search_url,
        max_retries,
        ctx.is_none(),
    )
    .await
}

/// Legacy direct-mode override for the compatibility client. Native requests
/// use the shared target policy and capture its effective environment per call.
pub(crate) fn web_no_proxy_enabled() -> bool {
    std::env::var("KCODER_WEB_NO_PROXY")
        .ok()
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
}

/// Search the web for current information.
#[derive(Debug, Default)]
pub struct WebSearchTool {
    runtime: std::sync::Arc<WebSearchRuntime>,
}

type SearchResult = kcoder_types::web_search::WebSearchHitV1;

fn format_results(
    results: &[SearchResult],
    query: &str,
    duration_ms: u64,
    context_max: usize,
) -> String {
    let reminder = "\n\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.";
    let footer = format!("\nSearch completed in {duration_ms}ms.");
    let marker = "\n[search results truncated]";
    let budget = context_max
        .saturating_sub(reminder.chars().count() + footer.chars().count() + marker.chars().count());
    if budget < 100 {
        return format!("[search results truncated]{reminder}");
    }
    let query = crate::truncate::truncate_chars_with_marker(query, 199, "…");
    let mut body = format!("Web search results for query: \"{query}\"\n\n");
    let mut truncated = false;
    if results.is_empty() {
        body.push_str("No search results found. This does not establish that a page or repository is absent; verify its exact URL and access permissions.\n");
    } else {
        body.push_str("Links:\n");
        for (index, result) in results.iter().enumerate() {
            let title = result
                .title
                .replace('\\', "\\\\")
                .replace('[', "\\[")
                .replace(']', "\\]")
                .replace(['\r', '\n'], " ");
            let url = result.url.replace('(', "%28").replace(')', "%29");
            let mut entry = format!("  - [{title}]({url})");
            let mut metadata = String::new();
            if !result.source_id.is_empty() {
                metadata.push_str(&format!(
                    "\n    Source ID: {} (search snippet)",
                    result.source_id
                ));
            }
            if let Some(published) = &result.published_at {
                metadata.push_str(&format!("\n    Published: {published}"));
            }
            if let Some(author) = &result.author {
                metadata.push_str(&format!("\n    Author: {author}"));
            }
            let remaining = budget.saturating_sub(body.chars().count());
            let required = entry.chars().count() + metadata.chars().count() + 1;
            if required > remaining {
                truncated = true;
                continue;
            }
            let share = remaining / (results.len() - index).max(1);
            let snippet_budget = share.saturating_sub(required + 2).min(remaining - required);
            if !result.snippet.trim().is_empty() && snippet_budget > 8 {
                let snippet = crate::truncate::truncate_chars_with_marker(
                    &result.snippet,
                    snippet_budget.saturating_sub(1),
                    "…",
                );
                truncated |= snippet.chars().count() < result.snippet.chars().count();
                entry.push_str(": ");
                entry.push_str(&snippet);
            } else if !result.snippet.trim().is_empty() {
                truncated = true;
            }
            entry.push_str(&metadata);
            entry.push('\n');
            body.push_str(&entry);
        }
    }
    if body.chars().count() > budget {
        body = crate::truncate::truncate_chars_with_marker(&body, budget.saturating_sub(1), "…");
        truncated = true;
    }
    if truncated {
        body.push_str(marker);
    }
    body.push_str(&footer);
    body.push_str(reminder);
    body
}

fn normalize_input(input: Value) -> Result<WebSearchInput, ToolError> {
    kcoder_web::search::request::normalize_input(parse_input(&input)?)
}

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> String {
        "WebSearch".to_string()
    }

    fn description(&self) -> String {
        "Search the public web for relevant source pages. \
         Helps find current source material for recent events and data. \
         Returns search result information formatted as search result blocks, \
         including links as markdown hyperlinks. Use this tool for accessing \
         information beyond the model's knowledge cutoff. The search service returns \
         ranked source pages; inspect sources before relying on their claims. \
         A failed or empty search is not evidence that a URL or repository does not exist."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(WebSearchInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let request = normalize_input(input.clone())?;
        let runtime = ctx
            .web_search_runtime
            .clone()
            .unwrap_or_else(|| self.runtime.clone());
        let response = runtime.execute(request, ctx).await?;
        let normalized = normalize_input(input.clone())?;
        let text = routing::format_response(&response, &normalized);
        let output = if matches!(
            response.status,
            kcoder_types::web_search::WebSearchStatus::Failed
                | kcoder_types::web_search::WebSearchStatus::Cancelled
        ) {
            ToolOutput::error(text)
        } else {
            ToolOutput::text(text)
        };
        Ok(output.with_web_search_sources(self, &input, ctx, &response))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_web::search::{
        bing::{extract_bing_results, resolve_bing_url},
        request::domains_conflict,
    };
    use std::time::Instant;
    const MAX_RETRIES: u32 = 3;

    async fn search_bing(
        client: &reqwest::Client,
        input: &WebSearchInput,
        search_url: &str,
    ) -> Result<String, ToolError> {
        let started = Instant::now();
        let page = search_bing_page(client, input, search_url, MAX_RETRIES, None, None)
            .await
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        Ok(format_results(
            &page.results,
            &input.query,
            started.elapsed().as_millis() as u64,
            input.context_max_characters.unwrap_or(10_000),
        ))
    }

    use crate::{Tool, ToolContext};
    use kcoder_state::AppState;
    use serde_json::json;

    #[tokio::test]
    async fn bing_query_encoding_and_result_links_belong_to_the_same_response() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for query in [
            "Python async guide",
            "量子计算 入门",
            "https://example.com/a?term=a+b&name=中文#section",
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let expected = query.to_owned();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buffer = [0; 4096];
                    let count = stream.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    if bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8(bytes).unwrap();
                let uri = request
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap();
                let url = reqwest::Url::parse(&format!("http://fixture{uri}")).unwrap();
                assert_eq!(
                    url.query_pairs().find(|(key, _)| key == "q").unwrap().1,
                    expected
                );
                let html = r#"<li class="b_algo"><h2><a href="https://example.com/%E4%B8%AD?q=a%2Bb&amp;lang=zh">Correct fixture</a></h2><p class="b_lineclamp">Matching response</p></li>"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
                    html.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            let input = serde_json::from_value(json!({"query":query})).unwrap();
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let output = search_bing(&client, &input, &format!("http://{address}/search"))
                .await
                .unwrap();
            assert!(output.contains("https://example.com/%E4%B8%AD?q=a%2Bb&lang=zh"));
            server.await.unwrap();
        }
    }

    #[test]
    fn bing_response_diagnostics_distinguish_empty_blocked_and_unknown_pages() {
        assert!(
            validate_bing_page("<html>Sign in to continue</html>")
                .unwrap_err()
                .to_string()
                .contains("unrecognized")
        );
        assert!(validate_bing_page(r#"<div id="b_captcha">Verify you are human</div>"#).is_err());
        assert!(
            validate_bing_page(r#"<ol id="b_results"><li class="b_no">No results found</li></ol>"#)
                .unwrap()
                .is_empty()
        );
        assert_eq!(validate_bing_page(&sample_bing_html()).unwrap().len(), 1);
        assert!(validate_bing_page(r#"<li class="b_algo"><h2>Changed markup</h2></li>"#).is_err());
    }

    #[test]
    fn bing_results_reject_unsafe_urls_and_deduplicate() {
        assert!(resolve_bing_url("javascript:alert(1)").is_none());
        assert!(resolve_bing_url("ftp://example.com/file").is_none());
        assert_eq!(
            resolve_bing_url("https://example.com/?u=a1invalid"),
            Some("https://example.com/?u=a1invalid".into())
        );
        assert_eq!(extract_bing_results(&sample_bing_html().repeat(2)).len(), 1);
    }

    #[test]
    fn resolves_bing_redirect() {
        // Base64url encoded https://example.com (prefix a1 = https)
        let encoded = "a1aHR0cHM6Ly9leGFtcGxlLmNvbQ";
        let raw = format!("https://www.bing.com/ck/a?u={encoded}");
        assert_eq!(
            resolve_bing_url(&raw),
            Some("https://example.com".to_string())
        );
    }

    #[test]
    fn passes_through_direct_external_url() {
        assert_eq!(
            resolve_bing_url("https://example.com/page"),
            Some("https://example.com/page".to_string())
        );
    }

    #[test]
    fn skips_internal_bing_links() {
        assert_eq!(resolve_bing_url("https://www.bing.com/images"), None);
        assert_eq!(resolve_bing_url("/relative"), None);
    }

    #[test]
    fn extracts_results_from_sample_html() {
        let html = r#"
            <ol id="b_results">
                <li class="b_algo">
                    <h2><a href="https://example.com/one">First &amp; Title</a></h2>
                    <p class="b_lineclamp">First snippet with &lt;tags&gt;.</p>
                </li>
                <li class="b_algo">
                    <h2><a href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS90d28">Second Title</a></h2>
                    <div class="b_caption"><p>Second snippet.</p></div>
                </li>
            </ol>
        "#;
        let results = extract_bing_results(html);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "First & Title");
        assert_eq!(results[0].url, "https://example.com/one");
        assert_eq!(results[0].snippet, "First snippet with <tags>.");
        assert_eq!(results[1].url, "https://example.com/two");
    }

    #[test]
    fn extracts_html_encoded_bing_redirect_from_real_page_shape() {
        let html = r#"
            <ol id="b_results">
                <li class="b_algo">
                    <h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=token&amp;u=a1aHR0cHM6Ly93d3cucnVzdC1sYW5nLm9yZy8&amp;ntb=1">Rust Programming Language</a></h2>
                    <p class="b_lineclamp">A language empowering everyone.</p>
                </li>
            </ol>
        "#;

        let results = extract_bing_results(html);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://www.rust-lang.org/");
    }

    #[test]
    fn filters_blocked_domains() {
        let results = vec![
            SearchResult {
                title: "A".to_string(),
                url: "https://example.com/page".to_string(),
                snippet: "...".to_string(),
                ..Default::default()
            },
            SearchResult {
                title: "B".to_string(),
                url: "https://bad.example/page".to_string(),
                snippet: "...".to_string(),
                ..Default::default()
            },
        ];
        let input = WebSearchInput {
            query: "q".to_string(),
            allowed_domains: None,
            blocked_domains: Some(vec!["bad.example".to_string()]),
            num_results: None,
            livecrawl: None,
            search_type: None,
            context_max_characters: None,
            constraints: Default::default(),
        };
        let filtered = filter_results(results, &input);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].url, "https://example.com/page");
    }

    #[test]
    fn filters_allowed_domains() {
        let results = vec![
            SearchResult {
                title: "A".to_string(),
                url: "https://example.com/page".to_string(),
                snippet: "...".to_string(),
                ..Default::default()
            },
            SearchResult {
                title: "B".to_string(),
                url: "https://other.com/page".to_string(),
                snippet: "...".to_string(),
                ..Default::default()
            },
        ];
        let input = WebSearchInput {
            query: "q".to_string(),
            allowed_domains: Some(vec!["example.com".to_string()]),
            blocked_domains: None,
            num_results: None,
            livecrawl: None,
            search_type: None,
            context_max_characters: None,
            constraints: Default::default(),
        };
        let filtered = filter_results(results, &input);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].url, "https://example.com/page");
    }

    #[test]
    fn empty_domain_lists_do_not_filter_or_conflict() {
        let results = vec![SearchResult {
            title: "A".to_string(),
            url: "https://example.com/page".to_string(),
            snippet: "...".to_string(),
            ..Default::default()
        }];
        let input = WebSearchInput {
            query: "q".to_string(),
            allowed_domains: Some(vec![]),
            blocked_domains: Some(vec!["  ".to_string()]),
            num_results: None,
            livecrawl: None,
            search_type: None,
            context_max_characters: None,
            constraints: Default::default(),
        };

        assert!(!domains_conflict(&input));
        assert_eq!(filter_results(results, &input).len(), 1);
    }

    #[test]
    fn non_empty_allowed_and_blocked_domains_conflict() {
        let input = WebSearchInput {
            query: "q".to_string(),
            allowed_domains: Some(vec!["example.com".to_string()]),
            blocked_domains: Some(vec!["other.com".to_string()]),
            num_results: None,
            livecrawl: None,
            search_type: None,
            context_max_characters: None,
            constraints: Default::default(),
        };

        assert!(domains_conflict(&input));
    }

    #[test]
    fn format_results_includes_markdown_links_and_source_reminder() {
        let results = vec![SearchResult {
            title: "Result Title".to_string(),
            url: "https://example.com/page".to_string(),
            snippet: "Useful snippet.".to_string(),
            ..Default::default()
        }];

        let text = format_results(&results, "rust news", 12, 10_000);

        assert!(text.starts_with("Web search results for query: \"rust news\""));
        assert!(text.contains("Links:"));
        assert!(text.contains("  - [Result Title](https://example.com/page): Useful snippet."));
        assert!(text.contains("Search completed in 12ms."));
        assert!(text.contains("REMINDER: You MUST include the sources above"));
    }

    #[test]
    fn format_results_truncates_without_splitting_utf8() {
        let results = vec![SearchResult {
            title: "标题".to_string(),
            url: "https://example.com/page".to_string(),
            snippet: "你好世界".repeat(100),
            ..Default::default()
        }];

        let text = format_results(&results, "查询", 12, 5);

        assert!(text.contains("truncated"));
        assert!(text.contains("REMINDER: You MUST include the sources above"));
        assert!(std::str::from_utf8(text.as_bytes()).is_ok());
    }

    #[test]
    fn bounded_search_context_keeps_complete_links_and_escapes_link_titles() {
        let results = vec![SearchResult {
            title: "Title ] with [ brackets".into(),
            url: "https://example.com/path(with-parentheses)".into(),
            snippet: "中文摘要".repeat(2000),
            ..Default::default()
        }];
        let text = format_results(&results, &"long query ".repeat(400), 12, 1000);
        assert!(text.chars().count() <= 1000, "{}", text.chars().count());
        assert!(text.contains(
            "[Title \\] with \\[ brackets](https://example.com/path%28with-parentheses%29)"
        ));
        assert!(text.contains("truncated"));
    }

    #[test]
    fn over_budget_url_is_omitted_instead_of_returning_a_broken_link() {
        let results = vec![SearchResult {
            title: "Long URL".into(),
            url: format!("https://example.com/{}", "x".repeat(3000)),
            ..Default::default()
        }];
        let text = format_results(&results, "source query", 12, 1000);
        assert!(text.contains("truncated"));
        assert!(!text.contains("https://example.com/"));
        assert!(text.chars().count() <= 1000);
    }

    #[tokio::test]
    async fn rejects_out_of_range_result_count_before_network_call() {
        let tool = WebSearchTool::default();
        let context = ToolContext::new(AppState::new("."));
        for count in [0, 21] {
            let result = tool
                .call(json!({"query":"asyncio", "num_results":count}), &context)
                .await;
            assert!(matches!(result, Err(ToolError::InvalidInput(_))));
        }
    }

    #[tokio::test]
    async fn rejects_malformed_filters_and_unbounded_inputs_before_network_call() {
        let tool = WebSearchTool::default();
        let context = ToolContext::new(AppState::new("."));
        for invalid in [
            json!({"query":"guide", "allowed_domains":["https://example.com"]}),
            json!({"query":"guide", "allowed_domains":["*.example.com"]}),
            json!({"query":"guide", "allowed_domains":["example.com:443"]}),
            json!({"query":"guide", "allowed_domains":[".."]}),
            json!({"query":"guide", "blocked_domains":vec!["example.com";129]}),
            json!({"query":"guide\ninternal instruction"}),
            json!({"query":"中".repeat(1400)}),
            json!({"query":"guide", "context_max_characters":999}),
            json!({"query":"guide", "context_max_characters":40001}),
        ] {
            assert!(matches!(
                tool.call(invalid, &context).await,
                Err(ToolError::InvalidInput(_))
            ));
        }
    }

    #[test]
    fn domain_matching_normalizes_case_and_preserves_label_boundaries() {
        let input = serde_json::from_value(
            json!({"query":"official guide", "allowed_domains":[" EXAMPLE.COM. "]}),
        )
        .unwrap();
        let results = [
            "https://example.com/a",
            "https://docs.example.com/a",
            "https://notexample.com/a",
            "https://example.com.attacker.invalid/a",
        ]
        .into_iter()
        .map(|url| SearchResult {
            title: "Source".into(),
            url: url.into(),
            ..Default::default()
        })
        .collect();
        let filtered = filter_results(results, &input);
        assert_eq!(filtered.len(), 2);
        assert_eq!(filtered[1].url, "https://docs.example.com/a");
    }

    #[tokio::test]
    async fn rejects_blank_query_before_network_call() {
        let tool = WebSearchTool::default();
        let err = tool
            .call(
                json!({ "query": " \n\t " }),
                &ToolContext::new(AppState::new(".")),
            )
            .await
            .unwrap_err();

        assert!(err.to_string().contains("Missing query"));
        assert!(err.to_string().contains("2 non-whitespace"));
    }

    #[tokio::test]
    #[ignore = "requires live access to bing.com"]
    async fn live_bing_search_returns_results() {
        let tool = WebSearchTool::default();
        let input = WebSearchInput {
            query: "Rust programming language official website".to_string(),
            allowed_domains: None,
            blocked_domains: None,
            num_results: Some(3),
            livecrawl: None,
            search_type: Some(SearchType::Fast),
            context_max_characters: Some(10_000),
            constraints: Default::default(),
        };

        let result = search_bing(&tool.runtime.client, &input, BING_SEARCH_URL)
            .await
            .expect("live Bing request should succeed");

        assert!(result.contains("Links:\n"), "{result}");
        assert!(!result.contains("No search results found"), "{result}");
        assert!(
            result.contains("rust-lang.org") || result.contains("rustup.rs"),
            "official Rust search returned unrelated results: {result}"
        );
    }

    fn sample_bing_html() -> String {
        r#"
        <ol id="b_results">
            <li class="b_algo">
                <h2><a href="https://example.com/result">Result Title</a></h2>
                <p class="b_lineclamp">A useful snippet.</p>
            </li>
        </ol>
        "#
        .to_string()
    }

    #[tokio::test]
    async fn retries_on_server_error() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let count_clone = Arc::clone(&count);

        tokio::spawn(async move {
            loop {
                let (mut socket, _) = match listener.accept().await {
                    Ok(conn) => conn,
                    Err(_) => break,
                };
                let mut buf = [0u8; 2048];
                let n = match socket.read(&mut buf).await {
                    Ok(n) => n,
                    Err(_) => continue,
                };
                let _req = String::from_utf8_lossy(&buf[..n]);
                let c = count_clone.fetch_add(1, Ordering::SeqCst);
                let response = if c == 0 {
                    "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_string()
                } else {
                    let body = sample_bing_html();
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                };
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });

        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let input = WebSearchInput {
            query: "test".to_string(),
            allowed_domains: None,
            blocked_domains: None,
            num_results: None,
            livecrawl: None,
            search_type: None,
            context_max_characters: None,
            constraints: Default::default(),
        };
        let search_url = format!("http://{}/search", addr);
        let result = search_bing(&client, &input, &search_url).await;
        assert!(
            result.is_ok(),
            "expected success after retry, got {:?}",
            result
        );
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }
}

#[cfg(test)]
mod bing_redirect_tests;

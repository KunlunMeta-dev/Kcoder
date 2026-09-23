mod exa;

use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use base64::Engine as _;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const MAX_RETRIES: u32 = 3;
const MAX_BING_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const BING_SEARCH_URL: &str = "https://www.bing.com/search";

/// Whether web tools should bypass `http_proxy`/`https_proxy` env vars, like
/// `WebFetch` does. A local development proxy is often only
/// reachable for the model host and cannot reach bing.com / general sites;
/// setting `KCODER_WEB_NO_PROXY=1` lets WebSearch/WebBrowser connect directly.
pub(crate) fn web_no_proxy_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        match std::env::var("KCODER_WEB_NO_PROXY")
            .ok()
            .map(|v| v.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("1" | "true" | "yes" | "on") => true,
            Some("0" | "false" | "no" | "off") => false,
            _ => false,
        }
    })
}

/// Hint appended to connect/timeout errors so users can diagnose proxy issues.
pub(crate) fn proxy_diagnostic_hint(err: &reqwest::Error) -> String {
    if err.is_connect() || err.is_timeout() {
        let proxy_set = std::env::var("http_proxy").is_ok() || std::env::var("https_proxy").is_ok();
        if proxy_set {
            return " (if `http_proxy`/`https_proxy` is set, the proxy may be \
                    unreachable; set `KCODER_WEB_NO_PROXY=1` to bypass)"
                .to_string();
        }
    }
    String::new()
}

/// Search the web for current information.
#[derive(Debug)]
pub struct WebSearchTool {
    client: reqwest::Client,
}

impl Default for WebSearchTool {
    fn default() -> Self {
        let mut builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10));
        if web_no_proxy_enabled() {
            builder = builder.no_proxy();
        }
        Self {
            client: builder
                .build()
                .expect("failed to build WebSearch HTTP client"),
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub struct WebSearchInput {
    /// Search query text. Be specific enough to retrieve relevant current
    /// results.
    pub query: String,
    /// Optional allowlist of domains such as `["example.com"]`. Must be a JSON
    /// array of strings. Use only when results must come from specific sites.
    pub allowed_domains: Option<Vec<String>>,
    /// Optional denylist of domains such as `["example.com"]`. Must be a JSON
    /// array of strings.
    pub blocked_domains: Option<Vec<String>>,
    /// Number of search results to return. Use a JSON integer. Accepts 1 through 20; defaults to 8.
    pub num_results: Option<usize>,
    /// Live crawl mode. Use `fallback` for cached-first behavior or
    /// `preferred` to prioritize live crawling. Defaults to `fallback`.
    pub livecrawl: Option<LivecrawlMode>,
    /// Search depth. Use `auto` by default, `fast` for quick lookups, or
    /// `deep` for comprehensive research.
    pub search_type: Option<SearchType>,
    /// Maximum characters of returned search context. Use a JSON integer.
    /// Defaults to 10000.
    pub context_max_characters: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LivecrawlMode {
    #[serde(alias = "Fallback")]
    Fallback,
    #[serde(alias = "Preferred")]
    Preferred,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SearchType {
    #[serde(alias = "Auto")]
    Auto,
    #[serde(alias = "Fast")]
    Fast,
    #[serde(alias = "Deep")]
    Deep,
}

#[derive(Debug, Clone)]
struct SearchResult {
    title: String,
    url: String,
    snippet: String,
}

static ALGO_BLOCK_RE: OnceLock<regex::Regex> = OnceLock::new();
static H2_LINK_RE: OnceLock<regex::Regex> = OnceLock::new();
static SNIPPET_LINECLAMP_RE: OnceLock<regex::Regex> = OnceLock::new();
static SNIPPET_CAPTION_P_RE: OnceLock<regex::Regex> = OnceLock::new();
static SNIPPET_CAPTION_FALLBACK_RE: OnceLock<regex::Regex> = OnceLock::new();
static TAG_RE: OnceLock<regex::Regex> = OnceLock::new();
static BING_U_RE: OnceLock<regex::Regex> = OnceLock::new();

fn algo_block_re() -> &'static regex::Regex {
    ALGO_BLOCK_RE.get_or_init(|| {
        regex::Regex::new(r#"(?is)<li\s+class="b_algo"[^>]*>([\s\S]*?)</li>"#).unwrap()
    })
}

fn h2_link_re() -> &'static regex::Regex {
    H2_LINK_RE.get_or_init(|| {
        regex::Regex::new(r#"(?is)<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)</a>"#).unwrap()
    })
}

fn snippet_lineclamp_re() -> &'static regex::Regex {
    SNIPPET_LINECLAMP_RE.get_or_init(|| {
        regex::Regex::new(r#"(?is)<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)</p>"#).unwrap()
    })
}

fn snippet_caption_p_re() -> &'static regex::Regex {
    SNIPPET_CAPTION_P_RE.get_or_init(|| {
        regex::Regex::new(
            r#"(?is)<div[^>]*class="b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)</p>"#,
        )
        .unwrap()
    })
}

fn snippet_caption_fallback_re() -> &'static regex::Regex {
    SNIPPET_CAPTION_FALLBACK_RE.get_or_init(|| {
        regex::Regex::new(r#"(?is)<div[^>]*class="b_caption[^"]*"[^>]*>([\s\S]*?)</div>"#).unwrap()
    })
}

fn tag_re() -> &'static regex::Regex {
    TAG_RE.get_or_init(|| regex::Regex::new(r"<[^>]+>").unwrap())
}

fn bing_u_re() -> &'static regex::Regex {
    BING_U_RE.get_or_init(|| regex::Regex::new(r"[?&]u=([a-zA-Z0-9+/_=-]+)").unwrap())
}

fn strip_tags(html: &str) -> String {
    tag_re().replace_all(html, " ").trim().to_string()
}

fn decode_html(text: &str) -> String {
    html_escape::decode_html_entities(text).to_string()
}

/// Resolve a Bing redirect URL to the actual target URL.
///
/// Bing uses URLs like `https://www.bing.com/ck/a?...&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbQ...`.
/// The `u` parameter is a base64-encoded URL prefixed with `a1` (https) or `a0` (http).
fn resolve_bing_url(raw: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(raw).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return None;
    }
    let is_bing = parsed
        .host_str()
        .is_some_and(|host| host_matches(host, "bing.com"));
    if is_bing && let Some(caps) = bing_u_re().captures(raw) {
        let encoded = caps.get(1)?.as_str();
        if encoded.len() >= 3 {
            let b64 = encoded[2..].replace('-', "+").replace('_', "/");
            // Bing sometimes omits base64 padding; use an engine that tolerates
            // missing padding, mirroring browser Buffer behaviour.
            let engine = base64::engine::GeneralPurpose::new(
                &base64::alphabet::STANDARD,
                base64::engine::GeneralPurposeConfig::new()
                    .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
            );
            let decoded = engine
                .decode(b64)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())?;
            let target = reqwest::Url::parse(&decoded).ok()?;
            if matches!(target.scheme(), "http" | "https") && target.host_str().is_some() {
                return Some(decoded);
            }
        }
    }

    if !is_bing {
        return Some(raw.to_string());
    }

    None
}

fn extract_snippet(block: &str) -> String {
    let raw = if let Some(caps) = snippet_lineclamp_re().captures(block) {
        caps.get(1).map(|m| m.as_str())
    } else if let Some(caps) = snippet_caption_p_re().captures(block) {
        caps.get(1).map(|m| m.as_str())
    } else if let Some(caps) = snippet_caption_fallback_re().captures(block) {
        caps.get(1).map(|m| m.as_str())
    } else {
        None
    };
    raw.map(|s| decode_html(&strip_tags(s))).unwrap_or_default()
}

fn extract_bing_results(html: &str) -> Vec<SearchResult> {
    let mut results = Vec::new();
    for block_caps in algo_block_re().captures_iter(html) {
        let block = block_caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let Some(link_caps) = h2_link_re().captures(block) else {
            continue;
        };
        let raw_url = decode_html(link_caps.get(1).map(|m| m.as_str()).unwrap_or(""));
        let title_html = link_caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let Some(url) = resolve_bing_url(&raw_url) else {
            continue;
        };
        let title = decode_html(&strip_tags(title_html));
        if title.trim().is_empty()
            || results
                .iter()
                .any(|result: &SearchResult| result.url == url)
        {
            continue;
        }
        let snippet = extract_snippet(block);
        results.push(SearchResult {
            title,
            url,
            snippet,
        });
    }
    results
}

/// Reject challenge pages and parser drift instead of reporting a successful empty search.
fn validate_bing_page(html: &str) -> Result<Vec<SearchResult>, ToolError> {
    let lower = html.to_ascii_lowercase();
    let results = extract_bing_results(html);
    let challenge_element = lower.contains("id=\"b_captcha")
        || lower.contains("id='b_captcha")
        || lower.contains("id=\"bnp_captcha");
    let challenge_text = [
        "verify you are human",
        "unusual traffic",
        "challenge-platform",
    ]
    .iter()
    .any(|marker| lower.contains(marker));
    if challenge_element || (results.is_empty() && challenge_text) {
        return Err(ToolError::Execution(
            "Bing returned an anti-bot challenge; no search results were accepted".into(),
        ));
    }
    if !results.is_empty() {
        return Ok(results);
    }
    let empty_marker =
        regex::Regex::new(r#"(?is)<li\b[^>]*class=["'][^"']*\bb_no\b[^"']*["']"#).unwrap();
    if lower.contains("b_results") && empty_marker.is_match(html) && !algo_block_re().is_match(html)
    {
        return Ok(results);
    }
    Err(ToolError::Execution("Bing returned an unrecognized search page or changed result markup; this is not a confirmed empty search".into()))
}

async fn read_bounded_bing_response(mut response: reqwest::Response) -> Result<String, ToolError> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BING_RESPONSE_BYTES as u64)
    {
        return Err(ToolError::Execution(
            "Bing response exceeds the 4 MiB limit".into(),
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| ToolError::Execution(format!("failed to read search response: {e}")))?
    {
        if chunk.len() > MAX_BING_RESPONSE_BYTES.saturating_sub(bytes.len()) {
            return Err(ToolError::Execution(
                "Bing response exceeds the 4 MiB limit".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes)
        .map_err(|_| ToolError::Execution("Bing returned invalid UTF-8 HTML".into()))
}

fn host_matches(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

fn normalized_domains(domains: &Option<Vec<String>>) -> Vec<&str> {
    domains
        .as_ref()
        .map(|domains| {
            domains
                .iter()
                .map(|domain| domain.trim())
                .filter(|domain| !domain.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn domains_conflict(input: &WebSearchInput) -> bool {
    !normalized_domains(&input.allowed_domains).is_empty()
        && !normalized_domains(&input.blocked_domains).is_empty()
}

fn filter_results(results: Vec<SearchResult>, input: &WebSearchInput) -> Vec<SearchResult> {
    let allowed = normalized_domains(&input.allowed_domains);
    let blocked = normalized_domains(&input.blocked_domains);
    results
        .into_iter()
        .filter(|r| {
            let Ok(url) = reqwest::Url::parse(&r.url) else {
                return false;
            };
            let Some(host) = url.host_str() else {
                return false;
            };
            if !allowed.is_empty() && !allowed.iter().any(|domain| host_matches(host, domain)) {
                return false;
            }
            if blocked.iter().any(|domain| host_matches(host, domain)) {
                return false;
            }
            true
        })
        .collect()
}

fn format_results(
    results: &[SearchResult],
    query: &str,
    duration_ms: u64,
    context_max: usize,
) -> String {
    let reminder = "\n\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.";
    let mut body = format!("Web search results for query: \"{}\"\n\n", query);

    if results.is_empty() {
        body.push_str("No search results found. This does not establish that a page or repository is absent; verify its exact URL and access permissions.\n\n");
    } else {
        body.push_str("Links:\n");
        for result in results {
            body.push_str(&format!("  - [{}]({})", result.title, result.url));
            if !result.snippet.trim().is_empty() {
                body.push_str(&format!(": {}", result.snippet));
            }
            body.push('\n');
        }
        body.push('\n');
    }
    body.push_str(&format!("Search completed in {}ms.", duration_ms));

    let body = if body.chars().count() + reminder.chars().count() > context_max {
        let body_budget = context_max.saturating_sub(reminder.chars().count());
        if body_budget == 0 {
            "[search results truncated]".to_string()
        } else {
            crate::truncate::truncate_chars_with_marker(&body, body_budget, "\n[truncated]")
        }
    } else {
        body
    };

    format!("{body}{reminder}")
}

fn retry_delay(attempt: u32) -> Duration {
    Duration::from_millis(500 * 2_u64.pow(attempt.min(4)))
}

fn is_retryable(status: reqwest::StatusCode, err: Option<&reqwest::Error>) -> bool {
    if let Some(e) = err {
        return e.is_timeout() || e.is_connect();
    }
    status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS
}

async fn search_bing(
    client: &reqwest::Client,
    input: &WebSearchInput,
    search_url: &str,
) -> Result<String, ToolError> {
    let language = if input
        .query
        .chars()
        .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
    {
        "zh-CN"
    } else {
        "en-US"
    };
    let url = reqwest::Url::parse_with_params(
        search_url,
        &[("q", input.query.as_str()), ("setmkt", language)],
    )
    .map_err(|e| ToolError::Execution(format!("invalid search URL: {e}")))?;

    let started = Instant::now();
    let mut attempts = 0;
    let mut last_error = String::new();
    for attempt in 0..=MAX_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(retry_delay(attempt - 1)).await;
        }

        attempts += 1;
        let request_result = client
            .get(url.clone())
            .header(
                reqwest::header::USER_AGENT,
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
            )
            .header(
                reqwest::header::ACCEPT,
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .header(reqwest::header::ACCEPT_LANGUAGE, language)
            .send()
            .await;

        let response = match request_result {
            Ok(resp) => resp,
            Err(e) => {
                last_error = format!(
                    "failed to fetch search results: {e}{}",
                    proxy_diagnostic_hint(&e)
                );
                if !is_retryable(reqwest::StatusCode::OK, Some(&e)) {
                    break;
                }
                continue;
            }
        };

        let status = response.status();
        if status.is_success() {
            let html = read_bounded_bing_response(response).await?;
            let raw_results = validate_bing_page(&html)?;
            let filtered = filter_results(raw_results, input);
            let num = input.num_results.unwrap_or(8).min(filtered.len());
            let selected: Vec<_> = filtered.into_iter().take(num).collect();
            let duration_ms = started.elapsed().as_millis() as u64;

            let context_max = input.context_max_characters.unwrap_or(10_000);
            return Ok(format_results(
                &selected,
                &input.query,
                duration_ms,
                context_max,
            ));
        }

        last_error = format!("Bing returned HTTP {status} for {url}");
        if !is_retryable(status, None) {
            break;
        }
    }

    Err(ToolError::Execution(format!(
        "search failed after {} attempts: {}",
        attempts, last_error
    )))
}

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> String {
        "WebSearch".to_string()
    }

    fn description(&self) -> String {
        "Allows KCoder to search the web and use the results to inform responses. \
         Provides up-to-date information for current events and recent data. \
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

    async fn call(&self, input: Value, _ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let mut input: WebSearchInput = parse_input(&input)?;
        input.query = input.query.trim().to_string();

        if input.query.chars().count() < 2 {
            return Err(ToolError::InvalidInput(
                "Error: Missing query. query must contain at least 2 non-whitespace characters."
                    .to_string(),
            ));
        }

        if input
            .num_results
            .is_some_and(|count| !(1..=20).contains(&count))
        {
            return Err(ToolError::InvalidInput(
                "num_results must be between 1 and 20".into(),
            ));
        }

        if domains_conflict(&input) {
            return Err(ToolError::InvalidInput(
                "Cannot specify both allowed_domains and blocked_domains in the same request"
                    .to_string(),
            ));
        }

        let text = match std::env::var("KCODER_WEB_SEARCH_PROVIDER")
            .as_deref()
            .unwrap_or("exa")
        {
            "exa" => tokio::time::timeout(
                Duration::from_secs(45),
                exa::search(&self.client, &input, exa::ENDPOINT),
            )
            .await
            .map_err(|_| ToolError::Execution("Web search timed out after 45 seconds".into()))??,
            "bing" => tokio::time::timeout(
                Duration::from_secs(45),
                search_bing(&self.client, &input, BING_SEARCH_URL),
            )
            .await
            .map_err(|_| ToolError::Execution("Bing search timed out after 45 seconds".into()))??,
            _ => {
                return Err(ToolError::InvalidInput(
                    "KCODER_WEB_SEARCH_PROVIDER must be exa or bing".into(),
                ));
            }
        };
        Ok(ToolOutput::text(text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[tokio::test]
    async fn bing_bounded_reader_rejects_declared_and_streamed_oversize() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for declared in [true, false] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 2048];
                socket.read(&mut request).await.unwrap();
                let header = if declared {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        MAX_BING_RESPONSE_BYTES + 1
                    )
                } else {
                    "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_string()
                };
                socket.write_all(header.as_bytes()).await.unwrap();
                if !declared {
                    let _ = socket
                        .write_all(&vec![b'x'; MAX_BING_RESPONSE_BYTES + 1])
                        .await;
                }
            });
            let response = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap()
                .get(format!("http://{address}"))
                .send()
                .await
                .unwrap();
            assert!(
                read_bounded_bing_response(response)
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("4 MiB")
            );
            server.await.unwrap();
        }
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
            },
            SearchResult {
                title: "B".to_string(),
                url: "https://bad.example/page".to_string(),
                snippet: "...".to_string(),
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
            },
            SearchResult {
                title: "B".to_string(),
                url: "https://other.com/page".to_string(),
                snippet: "...".to_string(),
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
        }];
        let input = WebSearchInput {
            query: "q".to_string(),
            allowed_domains: Some(vec![]),
            blocked_domains: Some(vec!["  ".to_string()]),
            num_results: None,
            livecrawl: None,
            search_type: None,
            context_max_characters: None,
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
        };

        assert!(domains_conflict(&input));
    }

    #[test]
    fn format_results_includes_markdown_links_and_source_reminder() {
        let results = vec![SearchResult {
            title: "Result Title".to_string(),
            url: "https://example.com/page".to_string(),
            snippet: "Useful snippet.".to_string(),
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
        }];

        let text = format_results(&results, "查询", 12, 5);

        assert!(text.contains("truncated"));
        assert!(text.contains("REMINDER: You MUST include the sources above"));
        assert!(std::str::from_utf8(text.as_bytes()).is_ok());
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
        };

        let result = search_bing(&tool.client, &input, BING_SEARCH_URL)
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

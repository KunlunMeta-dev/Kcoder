use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Fetch and extract content from a URL.
#[derive(Debug, Default)]
pub struct WebFetchTool;

const MAX_URL_LENGTH: usize = 2_000;
const MAX_HTTP_CONTENT_BYTES: u64 = 10 * 1024 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_CACHE_ENTRIES: usize = 128;
const MAX_REDIRECTS: usize = 10;

#[derive(Debug, Clone)]
struct CacheEntry {
    bytes: usize,
    status: reqwest::StatusCode,
    content_type: String,
    final_url: String,
    content: String,
    inserted: Instant,
}

static URL_CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WebFetchInput {
    /// The URL to fetch content from.
    pub url: String,
    /// The prompt to run on the fetched content.
    pub prompt: String,
}

#[async_trait]
impl Tool for WebFetchTool {
    fn name(&self) -> String {
        "WebFetch".to_string()
    }

    fn description(&self) -> String {
        "Fetches content from a specified URL and processes it using the prompt as extraction guidance. \
         Fetches URL content, converts HTML to readable text, and returns the relevant fetched content. \
         The URL must be fully formed. HTTP URLs for public hosts are automatically upgraded to HTTPS; \
         localhost HTTP is preserved for local dev servers. Includes a self-cleaning 15-minute cache. \
         Same-host redirects are followed, while redirects to a different host are reported with the redirect URL. \
         For GitHub URLs, prefer the `gh` CLI via the shell tool when available."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(WebFetchInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: WebFetchInput = parse_input(&input)?;
        let requested_url = validate_url(&input.url)?;

        if let Some(entry) = cached_entry(requested_url.as_str()) {
            let text = format_web_fetch_output(WebFetchOutput {
                input: &input,
                final_url: &entry.final_url,
                status: entry.status,
                bytes: entry.bytes,
                duration_ms: 0,
                content_type: &entry.content_type,
                result: &entry.content,
                cached: true,
            });
            return Ok(ToolOutput::text(ctx.truncate(&text)));
        }

        let url = normalized_fetch_url(requested_url.clone());
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| ToolError::Execution(format!("failed to build HTTP client: {e}")))?;

        let start = Instant::now();
        let response = get_with_permitted_redirects(&client, url, 0).await?;
        let response = match response {
            FetchResponse::Response(response) => response,
            FetchResponse::Redirect(info) => {
                let text = format!(
                    "REDIRECT DETECTED: The URL redirects to a different host.\n\n\
                     Original URL: {}\nRedirect URL: {}\nStatus: {} {}\n\n\
                     To complete your request, use WebFetch again with:\n\
                     - url: \"{}\"\n- prompt: \"{}\"",
                    info.original_url,
                    info.redirect_url,
                    info.status.as_u16(),
                    status_text(info.status),
                    info.redirect_url,
                    input.prompt
                );
                return Ok(ToolOutput::text(text));
            }
        };

        let status = response.status();
        let final_url = response.url().to_string();
        if let Some(length) = response.content_length()
            && length > MAX_HTTP_CONTENT_BYTES
        {
            return Ok(ToolOutput::error(format!(
                "Response from {} is too large ({} bytes; max {} bytes).",
                final_url, length, MAX_HTTP_CONTENT_BYTES
            )));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        // Stream the body with a hard cap instead of buffering it whole:
        // chunked responses without Content-Length must not grow memory
        // without bound before the size check.
        let mut response = response;
        let mut bytes = Vec::new();
        let mut too_large = false;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| ToolError::Execution(format!("failed to read response body: {e}")))?
        {
            if bytes.len() as u64 + chunk.len() as u64 > MAX_HTTP_CONTENT_BYTES {
                too_large = true;
                break;
            }
            bytes.extend_from_slice(&chunk);
        }
        if too_large {
            return Ok(ToolOutput::error(format!(
                "Response from {} is too large (exceeds {} bytes; download aborted).",
                final_url, MAX_HTTP_CONTENT_BYTES
            )));
        }

        let duration_ms = start.elapsed().as_millis() as u64;
        let result = if is_binary_content_type(&content_type) {
            persist_binary_content(&bytes, &content_type)
                .await
                .map(|path| {
                    format!(
                        "Binary content ({}, {} bytes) saved to {} for inspection.",
                        content_type,
                        bytes.len(),
                        path.display()
                    )
                })?
        } else {
            let body = String::from_utf8_lossy(&bytes);
            if is_html_response(&content_type, &body) {
                crate::web_browser::extract_text(&body)
            } else {
                body.to_string()
            }
        };
        let result = if result.len() > 100_000 {
            crate::truncate::truncate_chars_with_marker(&result, 100_000, "\n[truncated]")
        } else {
            result
        };

        store_cache(
            requested_url.as_str().to_string(),
            CacheEntry {
                bytes: bytes.len(),
                status,
                content_type: content_type.clone(),
                final_url: final_url.clone(),
                content: result.clone(),
                inserted: Instant::now(),
            },
        );

        let text = format_web_fetch_output(WebFetchOutput {
            input: &input,
            final_url: &final_url,
            status,
            bytes: bytes.len(),
            duration_ms,
            content_type: &content_type,
            result: &result,
            cached: false,
        });

        Ok(ToolOutput::text(ctx.truncate(&text)))
    }
}

enum FetchResponse {
    Response(reqwest::Response),
    Redirect(RedirectInfo),
}

struct RedirectInfo {
    original_url: String,
    redirect_url: String,
    status: reqwest::StatusCode,
}

async fn get_with_permitted_redirects(
    client: &reqwest::Client,
    url: reqwest::Url,
    depth: usize,
) -> Result<FetchResponse, ToolError> {
    if depth > MAX_REDIRECTS {
        return Err(ToolError::Execution(format!(
            "Too many redirects (exceeded {MAX_REDIRECTS})"
        )));
    }

    let response = client
        .get(url.clone())
        .header(
            reqwest::header::ACCEPT,
            "text/markdown, text/html, text/plain, */*",
        )
        .header(reqwest::header::USER_AGENT, "kcoder-rust/0.1.0")
        .send()
        .await
        .map_err(|e| ToolError::Execution(format!("failed to fetch {}: {}", url, e)))?;

    if is_redirect_status(response.status()) {
        let Some(location) = response.headers().get(reqwest::header::LOCATION) else {
            return Err(ToolError::Execution(
                "redirect missing Location header".to_string(),
            ));
        };
        let location = location.to_str().map_err(|_| {
            ToolError::Execution("redirect Location header is not UTF-8".to_string())
        })?;
        let redirect_url = url
            .join(location)
            .map_err(|e| ToolError::Execution(format!("invalid redirect URL: {e}")))?;
        let status = response.status();
        if is_permitted_redirect(&url, &redirect_url) {
            return Box::pin(get_with_permitted_redirects(
                client,
                redirect_url,
                depth + 1,
            ))
            .await;
        }
        return Ok(FetchResponse::Redirect(RedirectInfo {
            original_url: url.to_string(),
            redirect_url: redirect_url.to_string(),
            status,
        }));
    }

    Ok(FetchResponse::Response(response))
}

pub(crate) fn validate_url(raw: &str) -> Result<reqwest::Url, ToolError> {
    if raw.len() > MAX_URL_LENGTH {
        return Err(ToolError::InvalidInput(format!(
            "Invalid URL: URL length exceeds {MAX_URL_LENGTH} characters"
        )));
    }
    let parsed = reqwest::Url::parse(raw)
        .map_err(|e| ToolError::InvalidInput(format!("invalid URL: {e}")))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(ToolError::InvalidInput(
            "Invalid URL: only http and https URLs are supported".to_string(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ToolError::InvalidInput(
            "Invalid URL: embedded usernames/passwords are not supported".to_string(),
        ));
    }
    if parsed.host_str().is_none() {
        return Err(ToolError::InvalidInput(
            "Invalid URL: URL must include a host".to_string(),
        ));
    }
    Ok(parsed)
}

fn normalized_fetch_url(mut url: reqwest::Url) -> reqwest::Url {
    if url.scheme() == "http" && !is_loopback_host(url.host_str().unwrap_or_default()) {
        let _ = url.set_scheme("https");
    }
    url
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost" || host == "127.0.0.1" || host == "::1" || host.ends_with(".localhost")
}

fn is_redirect_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

pub(crate) fn is_permitted_redirect(original: &reqwest::Url, redirect: &reqwest::Url) -> bool {
    if redirect.scheme() != original.scheme()
        || redirect.port_or_known_default() != original.port_or_known_default()
    {
        return false;
    }
    if !redirect.username().is_empty() || redirect.password().is_some() {
        return false;
    }
    strip_www(original.host_str().unwrap_or_default())
        == strip_www(redirect.host_str().unwrap_or_default())
}

fn strip_www(host: &str) -> &str {
    host.strip_prefix("www.").unwrap_or(host)
}

fn status_text(status: reqwest::StatusCode) -> &'static str {
    match status.as_u16() {
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        _ => "",
    }
}

fn is_html_response(content_type: &str, body: &str) -> bool {
    content_type.to_ascii_lowercase().contains("text/html")
        || body
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("<!doctype")
        || body.to_ascii_lowercase().contains("<html")
}

fn is_binary_content_type(content_type: &str) -> bool {
    let content_type = content_type.to_ascii_lowercase();
    !content_type.is_empty()
        && !content_type.starts_with("text/")
        && !content_type.contains("json")
        && !content_type.contains("xml")
        && !content_type.contains("javascript")
}

async fn persist_binary_content(
    bytes: &[u8],
    content_type: &str,
) -> Result<std::path::PathBuf, ToolError> {
    let extension = extension_for_content_type(content_type);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("kcoder-webfetch-{nanos}.{extension}"));
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| ToolError::Execution(format!("failed to persist binary response: {e}")))?;
    Ok(path)
}

fn extension_for_content_type(content_type: &str) -> &'static str {
    let content_type = content_type.to_ascii_lowercase();
    if content_type.contains("pdf") {
        "pdf"
    } else if content_type.contains("png") {
        "png"
    } else if content_type.contains("jpeg") || content_type.contains("jpg") {
        "jpg"
    } else if content_type.contains("gif") {
        "gif"
    } else if content_type.contains("webp") {
        "webp"
    } else {
        "bin"
    }
}

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    URL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_entry(url: &str) -> Option<CacheEntry> {
    let mut cache = cache().lock().unwrap();
    prune_expired_entries(&mut cache, Instant::now());
    cache.get(url).cloned()
}

fn store_cache(url: String, entry: CacheEntry) {
    insert_cache_entry(&mut cache().lock().unwrap(), url, entry, Instant::now());
}

fn prune_expired_entries(cache: &mut HashMap<String, CacheEntry>, now: Instant) {
    cache.retain(|_, entry| now.saturating_duration_since(entry.inserted) <= CACHE_TTL);
}

fn insert_cache_entry(
    cache: &mut HashMap<String, CacheEntry>,
    url: String,
    entry: CacheEntry,
    now: Instant,
) {
    prune_expired_entries(cache, now);
    // Replacing the same URL consumes no new slot; evict the earliest inserted entry when a new entry reaches capacity.
    if !cache.contains_key(&url) && cache.len() >= MAX_CACHE_ENTRIES {
        let oldest = cache
            .iter()
            .min_by_key(|(_, entry)| entry.inserted)
            .map(|(url, _)| url.clone());
        if let Some(oldest) = oldest {
            cache.remove(&oldest);
        }
    }
    cache.insert(url, entry);
}

struct WebFetchOutput<'a> {
    input: &'a WebFetchInput,
    final_url: &'a str,
    status: reqwest::StatusCode,
    bytes: usize,
    duration_ms: u64,
    content_type: &'a str,
    result: &'a str,
    cached: bool,
}

fn format_web_fetch_output(output: WebFetchOutput<'_>) -> String {
    format!(
        "Fetched: {}\nStatus: {}\nBytes: {}\nDuration: {}ms\nContent-Type: {}\nCached: {}\nPrompt: {}\n\n{}",
        output.final_url,
        output.status,
        output.bytes,
        output.duration_ms,
        if output.content_type.is_empty() {
            "unknown"
        } else {
            output.content_type
        },
        output.cached,
        output.input.prompt,
        output.result
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Tool;
    use kcoder_state::AppState;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn validates_url_shape_and_credentials() {
        assert!(validate_url("https://example.com/path").is_ok());
        assert!(validate_url("ftp://example.com/path").is_err());
        assert!(validate_url("https://user:pass@example.com/path").is_err());
    }

    #[test]
    fn upgrades_public_http_but_preserves_loopback_http() {
        let public = reqwest::Url::parse("http://example.com/path").unwrap();
        assert_eq!(normalized_fetch_url(public).scheme(), "https");
        let local = reqwest::Url::parse("http://127.0.0.1:8080/path").unwrap();
        assert_eq!(normalized_fetch_url(local).scheme(), "http");
    }

    #[test]
    fn permits_same_host_redirects_only() {
        let original = reqwest::Url::parse("https://example.com/a").unwrap();
        let same = reqwest::Url::parse("https://www.example.com/b").unwrap();
        let other = reqwest::Url::parse("https://evil.example.net/b").unwrap();
        assert!(is_permitted_redirect(&original, &same));
        assert!(!is_permitted_redirect(&original, &other));
    }

    #[test]
    fn cache_bounds_capacity_and_removes_unvisited_expired_entries() {
        let now = Instant::now();
        let entry = CacheEntry {
            bytes: 1,
            status: reqwest::StatusCode::OK,
            content_type: "text/plain".into(),
            final_url: "https://example.com".into(),
            content: "x".into(),
            inserted: now,
        };
        let mut cache = HashMap::new();
        for index in 0..=MAX_CACHE_ENTRIES {
            let inserted = now + Duration::from_millis(index as u64);
            insert_cache_entry(
                &mut cache,
                index.to_string(),
                CacheEntry {
                    inserted,
                    ..entry.clone()
                },
                inserted,
            );
            assert!(cache.len() <= MAX_CACHE_ENTRIES);
        }
        assert!(!cache.contains_key("0"));
        assert!(cache.contains_key("1"));
        insert_cache_entry(&mut cache, "1".into(), entry.clone(), now);
        assert_eq!(cache.len(), MAX_CACHE_ENTRIES);
        let expired_at = now + CACHE_TTL + Duration::from_secs(1);
        insert_cache_entry(
            &mut cache,
            "fresh".into(),
            CacheEntry {
                inserted: expired_at,
                ..entry
            },
            expired_at,
        );
        assert_eq!(cache.len(), 1);
        assert!(cache.contains_key("fresh"));
    }

    #[tokio::test]
    async fn web_fetch_reports_cross_host_redirect() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            let response = "HTTP/1.1 302 Found\r\nLocation: https://example.com/new\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = socket.write_all(response.as_bytes()).await;
        });

        let tool = WebFetchTool;
        let ctx = ToolContext::new(AppState::new("."));
        let output = tool
            .call(
                serde_json::json!({
                    "url": format!("http://{addr}/old"),
                    "prompt": "summarize"
                }),
                &ctx,
            )
            .await
            .unwrap();
        let text = text_output(&output);
        assert!(text.contains("REDIRECT DETECTED"));
        assert!(text.contains("https://example.com/new"));
    }

    #[tokio::test]
    async fn web_fetch_uses_cache_for_repeated_url() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let count_clone = Arc::clone(&count);
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = match listener.accept().await {
                    Ok(conn) => conn,
                    Err(_) => break,
                };
                count_clone.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let body = "cached content ".repeat(1000);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });

        let tool = WebFetchTool;
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(temp.path())).with_output_limits(512, 192, 192);
        let url = format!("http://{addr}/cache-test");
        for _ in 0..2 {
            let output = tool
                .call(
                    serde_json::json!({
                        "url": url,
                        "prompt": "extract title"
                    }),
                    &ctx,
                )
                .await
                .unwrap();
            assert!(!output.is_error);
            let text = text_output(&output);
            assert!(text.len() < 2000, "cached output must honor context limits");
            assert!(text.contains("Full output at:"));
        }
        assert_eq!(count.load(Ordering::SeqCst), 1);
        server.abort();
        let _ = server.await;
    }

    fn text_output(output: &ToolOutput) -> String {
        output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>()
    }
}

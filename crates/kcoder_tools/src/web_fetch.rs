use crate::web_content::{self, PageContent};
use crate::web_network::{self, PolicySnapshot};
use crate::web_resources::CachedPage;
use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use kcoder_types::web_sources::{WebSourcePageV1, WebSourceReadStatus};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::io::Read;
use std::time::Instant;

/// Fetch source documents without running a summarization model.
#[derive(Debug, Default)]
pub struct WebFetchTool;
pub(crate) const MAX_HTTP_CONTENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_REDIRECTS: usize = 10;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WebFetchInput {
    /// Fully formed HTTP(S) URL to read.
    pub url: String,
    /// Optional note for your own reading, returned unchanged. It does not filter or summarize the page.
    #[serde(default)]
    pub prompt: Option<String>,
    /// Bypass earlier source content when checking current information again.
    #[serde(default)]
    pub fresh: bool,
}

#[async_trait]
impl Tool for WebFetchTool {
    fn name(&self) -> String {
        "WebFetch".into()
    }
    fn description(&self) -> String {
        "Fetch a source document and HTTP metadata from a fully formed HTTP(S) URL. Converts server-rendered HTML to bounded Markdown, preserving headings, links, tables and code. Include an HTML anchor in the URL to read that section. The optional prompt is a note for your own reading, returned unchanged; it does not filter or summarize the page, and no other model is called. Uses a session-scoped 15-minute cache; set fresh=true when rechecking current information. Same-origin redirects are followed; other redirects are reported for a separate request. Private origins require a current host-issued grant. Binary responses are saved as private, session-owned temporary files; scripts, logins and OCR are not executed.".into()
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
    fn is_concurrency_safe(&self, _: &Value) -> bool {
        true
    }
    async fn call(
        &self,
        effective_input: Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let input: WebFetchInput = parse_input(&effective_input)?;
        let start = Instant::now();
        let result = read_page(&input.url, input.fresh, ctx).await?;
        let page = &result.page;
        let render = |truncated| {
            format!(
                "Requested: {}\nFetched: {}\nStatus: {}\nBytes: {}\nDuration: {}ms\nContent-Type: {}\nEncoding: {}\nRetrieved: {}\nExtraction: {}\nTruncated: {:<5}\nCached: {}\nCache-Age: {}ms\nPrompt: {}\n\n{}",
                input.url,
                page.final_url,
                page.status,
                page.bytes,
                start.elapsed().as_millis(),
                page.content_type,
                page.content.encoding,
                page.retrieved_at,
                page.content.state,
                truncated,
                result.cached,
                result.age_ms,
                input.prompt.as_deref().unwrap_or(""),
                page.content.markdown
            )
        };
        let mut text = render(page.content.truncated);
        let output_truncated = ctx.max_output_bytes != 0 && text.len() > ctx.max_output_bytes;
        if output_truncated && !page.content.truncated {
            text = render(true);
        }
        let mut observation = source_observation(&result);
        if output_truncated && observation.read_status == WebSourceReadStatus::Read {
            observation.read_status = WebSourceReadStatus::Partial;
        }
        let output = if matches!(page.content.state, "read" | "partial" | "binary") {
            ToolOutput::text(ctx.truncate(&text))
        } else {
            ToolOutput::error(ctx.truncate(&text))
        };
        Ok(output.with_web_fetch_source(self, &effective_input, ctx, observation))
    }
}

pub(crate) struct PageRead {
    pub page: CachedPage,
    pub cached: bool,
    pub age_ms: u64,
}

pub(crate) async fn read_page(
    raw: &str,
    fresh: bool,
    ctx: &ToolContext,
) -> Result<PageRead, ToolError> {
    ctx.web_resources.check_owner(&ctx.state)?;
    let requested = validate_url(raw)?;
    let policy = PolicySnapshot::capture(ctx)?;
    policy.check(ctx, &requested)?;
    let key = format!(
        "{}:{}:{}",
        policy.fingerprint,
        web_content::PARSER_VERSION,
        requested
    );
    if !fresh && let Some(page) = ctx.web_resources.cached(&key) {
        // Re-resolve the destination before returning cached content. A domain
        // that now maps into a forbidden network cannot bypass current policy.
        web_network::validate_destination(ctx, &policy, &validate_url(&page.final_url)?).await?;
        policy.check(ctx, &requested)?;
        let age_ms = page.inserted.elapsed().as_millis().min(u64::MAX as u128) as u64;
        return Ok(PageRead {
            page,
            cached: true,
            age_ms,
        });
    }
    let cancel = ctx.abort_token.clone().unwrap_or_default();
    let _permit = crate::web_search::account_admission::acquire_page(
        ctx,
        &cancel,
        tokio::time::Instant::now() + std::time::Duration::from_secs(60),
    )
    .await?;
    ctx.web_resources.check_owner(&ctx.state)?;
    policy.check(ctx, &requested)?;
    let mut current = requested.clone();
    for hop in 0..=MAX_REDIRECTS {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::ACCEPT,
            reqwest::header::HeaderValue::from_static(
                "text/markdown, text/html, text/plain, application/json, */*;q=0.5",
            ),
        );
        headers.insert(
            reqwest::header::ACCEPT_ENCODING,
            reqwest::header::HeaderValue::from_static("gzip"),
        );
        headers.insert(
            reqwest::header::USER_AGENT,
            reqwest::header::HeaderValue::from_static("KCoder/0.1 (source reader)"),
        );
        let mut owned = web_network::send_with_policy(
            ctx,
            &policy,
            reqwest::Method::GET,
            current.clone(),
            headers,
            None,
        )
        .await?;
        let response = &mut owned.response;
        let status = response.status();
        if matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| {
                    ToolError::Execution(
                        "The redirect did not include a valid Location header".into(),
                    )
                })?;
            let next = current
                .join(location)
                .map_err(|_| ToolError::Execution("The redirect URL is invalid".into()))?;
            validate_url(next.as_str())?;
            if !is_permitted_redirect(&current, &next) {
                let page = CachedPage::new(
                    current.to_string(),
                    status,
                    String::new(),
                    0,
                    chrono::Utc::now().to_rfc3339(),
                    PageContent {
                        title: String::new(),
                        markdown: format!(
                            "REDIRECT DETECTED: A separate origin requires a separate permitted request.\nOriginal URL: {current}\nRedirect URL: {next}"
                        ),
                        state: "redirect_requires_request",
                        truncated: false,
                        encoding: String::new(),
                    },
                );
                return Ok(PageRead {
                    page,
                    cached: false,
                    age_ms: 0,
                });
            }
            if hop == MAX_REDIRECTS {
                return Err(ToolError::Execution("Too many web redirects".into()));
            }
            current = next;
            continue;
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let content_encoding = response
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        if response
            .content_length()
            .is_some_and(|n| n > MAX_HTTP_CONTENT_BYTES as u64)
        {
            return Err(size_error());
        }
        let mut bytes = Vec::new();
        loop {
            let chunk = tokio::select! {biased;_=ctx.cancelled()=>return Err(web_network::cancelled()),result=response.chunk()=>result.map_err(|_|ToolError::Execution("The source response body could not be read".into()))?};
            let Some(chunk) = chunk else { break };
            if bytes.len() + chunk.len() > MAX_HTTP_CONTENT_BYTES {
                return Err(size_error());
            }
            bytes.extend_from_slice(&chunk);
        }
        let bytes = decode_compression(bytes, &content_encoding)?;
        policy.check(ctx, &current)?;
        let mut content = if is_binary_content_type(&content_type) {
            if !status.is_success() {
                PageContent {
                    title: String::new(),
                    markdown: "The HTTP error response did not contain readable source text."
                        .into(),
                    state: "http_error",
                    truncated: false,
                    encoding: String::new(),
                }
            } else {
                let path = ctx
                    .web_resources
                    .persist(&bytes, extension_for_content_type(&content_type))?;
                PageContent {
                    title: String::new(),
                    markdown: format!(
                        "Binary content ({}, {} bytes) saved to {} for inspection. The file is temporary and owned by this session.",
                        content_type,
                        bytes.len(),
                        path.display()
                    ),
                    state: "binary",
                    truncated: false,
                    encoding: String::new(),
                }
            }
        } else {
            web_content::extract(&bytes, &content_type, &current)?
        };
        if !status.is_success() {
            content.state = "http_error";
        }
        let page = CachedPage::new(
            current.to_string(),
            status,
            content_type,
            bytes.len(),
            chrono::Utc::now().to_rfc3339(),
            content,
        );
        policy.check(ctx, &current)?;
        ctx.web_resources.store(key, page.clone());
        return Ok(PageRead {
            page,
            cached: false,
            age_ms: 0,
        });
    }
    Err(ToolError::Execution("Too many web redirects".into()))
}

fn decode_compression(bytes: Vec<u8>, encoding: &str) -> Result<Vec<u8>, ToolError> {
    if encoding.is_empty() || encoding.eq_ignore_ascii_case("identity") {
        return Ok(bytes);
    }
    let mut decoder: Box<dyn Read> = match encoding.trim().to_ascii_lowercase().as_str() {
        "gzip" | "x-gzip" => Box::new(flate2::read::MultiGzDecoder::new(std::io::Cursor::new(
            bytes,
        ))),
        "deflate" => Box::new(flate2::read::ZlibDecoder::new(std::io::Cursor::new(bytes))),
        _ => {
            return Err(ToolError::Execution(
                "The source uses an unsupported content compression format".into(),
            ));
        }
    };
    let mut decoded = Vec::new();
    decoder
        .by_ref()
        .take((MAX_HTTP_CONTENT_BYTES + 1) as u64)
        .read_to_end(&mut decoded)
        .map_err(|_| ToolError::Execution("The source compressed response is invalid".into()))?;
    if decoded.len() > MAX_HTTP_CONTENT_BYTES {
        return Err(size_error());
    }
    Ok(decoded)
}
fn size_error() -> ToolError {
    ToolError::Execution(format!(
        "The source response exceeds the {}-byte download or decompressed limit",
        MAX_HTTP_CONTENT_BYTES
    ))
}

pub(crate) fn source_observation(result: &PageRead) -> WebSourcePageV1 {
    let page = &result.page;
    WebSourcePageV1 {
        source_id: String::new(),
        title: page.content.title.clone(),
        url: page.final_url.clone(),
        published_at: None,
        author: None,
        retrieved_at: page.retrieved_at.clone(),
        read_status: match page.content.state {
            "read" => WebSourceReadStatus::Read,
            "partial" => WebSourceReadStatus::Partial,
            _ => WebSourceReadStatus::Unreadable,
        },
        cache_hit: result.cached,
        cache_age_ms: result.age_ms,
    }
}
pub(crate) fn validate_url(raw: &str) -> Result<reqwest::Url, ToolError> {
    web_network::validate_url(raw)
}
pub(crate) fn is_permitted_redirect(original: &reqwest::Url, redirect: &reqwest::Url) -> bool {
    redirect.origin() == original.origin()
        && redirect.username().is_empty()
        && redirect.password().is_none()
}
fn is_binary_content_type(content_type: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    !ct.is_empty()
        && !ct.starts_with("text/")
        && !ct.contains("json")
        && !ct.contains("xml")
        && !ct.contains("javascript")
}
fn extension_for_content_type(content_type: &str) -> &'static str {
    let ct = content_type.to_ascii_lowercase();
    if ct.contains("pdf") {
        "pdf"
    } else if ct.contains("png") {
        "png"
    } else if ct.contains("jpeg") {
        "jpg"
    } else if ct.contains("gif") {
        "gif"
    } else if ct.contains("webp") {
        "webp"
    } else {
        "bin"
    }
}

#[cfg(test)]
mod tests;

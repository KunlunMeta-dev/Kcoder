use crate::web_search::{proxy_diagnostic_hint, web_no_proxy_enabled};
use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use regex::Regex;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::sync::OnceLock;

/// Lightweight web browser tool: fetches a URL and extracts text content.
#[derive(Debug, Default)]
pub struct WebBrowserTool;

/// Shared HTTP client built once (honors `KCODER_WEB_NO_PROXY`).
static SHARED_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn shared_client() -> reqwest::Client {
    SHARED_CLIENT
        .get_or_init(|| {
            let mut builder = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                // Follow redirects only within the same host (the same rule
                // WebFetch enforces), so a remote server cannot redirect the
                // agent into the internal network.
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    let previous = attempt.previous();
                    if previous.len() >= 5 {
                        return attempt.stop();
                    }
                    let mut chain: Vec<&reqwest::Url> = previous.iter().collect();
                    chain.push(attempt.url());
                    let permitted = chain
                        .windows(2)
                        .all(|pair| crate::web_fetch::is_permitted_redirect(pair[0], pair[1]));
                    if permitted {
                        attempt.follow()
                    } else {
                        attempt.stop()
                    }
                }));
            if web_no_proxy_enabled() {
                builder = builder.no_proxy();
            }
            builder
                .build()
                .expect("failed to build WebBrowser HTTP client")
        })
        .clone()
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BrowserAction {
    #[default]
    Navigate,
    #[serde(alias = "screenshot")]
    Snapshot,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WebBrowserInput {
    /// URL to fetch and extract content from.
    pub url: String,
    /// Action to perform. "navigate" fetches page content (default).
    /// "snapshot" returns a text-only snapshot, never an image.
    #[serde(default)]
    pub action: BrowserAction,
}

static SCRIPT_STYLE_RE: OnceLock<Regex> = OnceLock::new();
static TAG_RE: OnceLock<Regex> = OnceLock::new();
static WHITESPACE_RE: OnceLock<Regex> = OnceLock::new();

pub(crate) fn extract_text(html: &str) -> String {
    let script_style = SCRIPT_STYLE_RE.get_or_init(|| {
        Regex::new(r"(?is)<script[\s\S]*?</script>|<style[\s\S]*?</style>").unwrap()
    });
    let tags = TAG_RE.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let whitespace = WHITESPACE_RE.get_or_init(|| Regex::new(r"\s+").unwrap());

    let no_scripts = script_style.replace_all(html, " ");
    let no_tags = tags.replace_all(&no_scripts, " ");
    let text = whitespace.replace_all(&no_tags, " ").trim().to_string();

    if text.len() > 50_000 {
        crate::truncate::truncate_chars_with_marker(&text, 50_000, "\n[truncated]")
    } else {
        text
    }
}

fn extract_title(html: &str) -> String {
    Regex::new(r"(?is)<title[^>]*>([^<]*)</title>")
        .ok()
        .and_then(|re| re.captures(html))
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().trim().to_string())
        .unwrap_or_default()
}

#[async_trait]
impl Tool for WebBrowserTool {
    fn name(&self) -> String {
        "WebBrowser".to_string()
    }

    fn description(&self) -> String {
        "Inspect the title and server-rendered HTML text of one page with navigate or snapshot. Document retrieval with HTTP metadata and caching is a separate capability. Returns text only, never a screenshot or visual evidence. No JavaScript execution or interactive browser controls."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(WebBrowserInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, _ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: WebBrowserInput = parse_input(&input)?;

        // Same URL hygiene as WebFetch: http/https only, no embedded
        // credentials, host required.
        let url = match crate::web_fetch::validate_url(&input.url) {
            Ok(url) => url,
            Err(error) => {
                return Ok(ToolOutput::text(format!(
                    "Error ({})\n\nInvalid URL: {}",
                    input.url, error
                )));
            }
        };

        let client = shared_client();

        let response = match client
            .get(url)
            .header(
                reqwest::header::USER_AGENT,
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            )
            .header(
                reqwest::header::ACCEPT,
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .send()
            .await
        {
            Ok(response) => response,
            Err(e) => {
                return Ok(ToolOutput::text(format!(
                    "Error ({})\n\nFailed to fetch: {}{}",
                    input.url, e, proxy_diagnostic_hint(&e)
                )));
            }
        };

        let status = response.status();
        let final_url = response.url().to_string();
        // Stream the body with a hard cap instead of reading it unbounded.
        const MAX_BROWSER_CONTENT_BYTES: u64 = 10 * 1024 * 1024;
        let mut response = response;
        let mut bytes = Vec::new();
        let mut body_truncated = false;
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if bytes.len() as u64 + chunk.len() as u64 > MAX_BROWSER_CONTENT_BYTES {
                        body_truncated = true;
                        break;
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(e) => {
                    return Ok(ToolOutput::text(format!(
                        "Error ({})\n\nFailed to read response body: {}",
                        final_url, e
                    )));
                }
            }
        }
        let html = String::from_utf8_lossy(&bytes).into_owned();

        if !status.is_success() {
            return Ok(ToolOutput::text(format!(
                "HTTP {} ({})\n\nError: {} {}",
                status.as_u16(),
                final_url,
                status.as_u16(),
                status.canonical_reason().unwrap_or("Unknown")
            )));
        }

        let title = extract_title(&html);
        let mut text = extract_text(&html);

        if body_truncated {
            text = format!("[page body truncated at 10 MB download cap]\n\n{}", text);
        }

        if matches!(input.action, BrowserAction::Snapshot) {
            text = format!(
                "[Text snapshot — no image was captured or visually inspected]\n\n{}",
                text
            );
        }

        Ok(ToolOutput::text(format!(
            "{} ({})\n\n{}",
            if title.is_empty() {
                "(no title)"
            } else {
                &title
            },
            final_url,
            text
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ToolContext;
    use kcoder_state::AppState;

    fn text_from_output(output: ToolOutput) -> String {
        output
            .content
            .into_iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn extract_text_truncates_without_splitting_utf8() {
        let html = format!("<html><body>{}</body></html>", "你好".repeat(30_000));

        let text = extract_text(&html);

        assert!(text.ends_with("[truncated]"));
        assert!(std::str::from_utf8(text.as_bytes()).is_ok());
    }

    #[tokio::test]
    async fn fetch_failure_is_model_visible_output() {
        let ctx = ToolContext::new(AppState::new("/tmp"));

        let output = WebBrowserTool
            .call(serde_json::json!({ "url": "not a url" }), &ctx)
            .await
            .expect("fetch failures should be returned as tool output");

        assert!(!output.is_error);
        let text = text_from_output(output);
        assert!(text.contains("Error (not a url)"));
        assert!(text.contains("Invalid URL"));
    }
}

#[cfg(test)]
mod snapshot_contract_tests {
    use super::*;
    #[test]
    fn advertises_text_snapshot_and_accepts_legacy_spelling() {
        for action in ["snapshot", "screenshot"] {
            let input: WebBrowserInput = serde_json::from_value(
                serde_json::json!({"url":"https://example.test", "action": action}),
            )
            .unwrap();
            assert!(matches!(input.action, BrowserAction::Snapshot));
        }
        let schema = WebBrowserTool.input_schema().to_string();
        assert!(schema.contains("snapshot"));
        assert!(!schema.contains("\"screenshot\""));
        assert!(WebBrowserTool.description().contains("text only"));
    }
}

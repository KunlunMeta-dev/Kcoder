//! Parse supported Bing result pages without transport or session state.
use crate::search::request::host_matches;
use base64::Engine as _;
use kcoder_tool_error::ToolError;
use kcoder_types::web_search::WebSearchHitV1 as SearchResult;
use std::sync::OnceLock;

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
pub fn resolve_bing_url(raw: &str) -> Option<String> {
    let parsed = url::Url::parse(raw).ok()?;
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
            let target = url::Url::parse(&decoded).ok()?;
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

pub fn extract_bing_results(html: &str) -> Vec<SearchResult> {
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
            ..Default::default()
        });
    }
    results
}

/// Reject challenge pages and parser drift instead of reporting a successful empty search.
pub fn validate_bing_page(html: &str) -> Result<Vec<SearchResult>, ToolError> {
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

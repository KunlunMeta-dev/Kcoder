//! Reviewed Exa MCP result formats. Transport JSON/SSE decoding remains outside this module.
//!
//! Exa's webSearch.ts emits Title/URL/Published/Author blocks and conditionally
//! structuredContent.results through searchNotes.ts. Only those known forms are accepted.

use crate::search::SearchFailure;
use kcoder_types::web_search::{
    WEB_SEARCH_RESULT_LIMIT, WebSearchEngineFailureV1, WebSearchErrorKind, WebSearchHitV1,
    WebSearchPageV1,
};
use serde_json::Value;
use std::collections::HashSet;

pub const MAX_EXA_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_EXA_RECORDS: usize = WEB_SEARCH_RESULT_LIMIT * 16;
const MAX_TITLE_BYTES: usize = 1024;
const MAX_URL_BYTES: usize = 8192;
const MAX_SNIPPET_BYTES: usize = 16 * 1024;
const EXPLICIT_EMPTY_TEXT: &str = "No search results found. Please try a different query.";

/// Decode one complete MCP CallToolResult, never arbitrary JSON embedded in its text.
pub fn parse_exa_output(output: &Value) -> Result<WebSearchPageV1, SearchFailure> {
    validate_tool_result(output)?;
    let mut parsed = Parsed::default();
    if let Some(structured) = output
        .get("structuredContent")
        .filter(|value| !value.is_null())
    {
        return parse_structured_results(structured, false);
    } else {
        let blocks = output
            .get("content")
            .and_then(Value::as_array)
            .ok_or_else(|| contract("Search source returned no result content"))?;
        if blocks.len() > MAX_EXA_RECORDS {
            return Err(contract("Search source returned too many content blocks"));
        }
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("text") {
                parsed.invalid += 1;
                continue;
            }
            let text = block
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| contract("Search text content is malformed"))?;
            parse_legacy_text(text, &mut parsed);
        }
    }
    parsed.page()
}

/// Advanced Exa alone emits one whole JSON document in a text block. The caller
/// must select this entry only for the fixed, discovered advanced tool identity.
pub fn parse_exa_advanced_output(output: &Value) -> Result<WebSearchPageV1, SearchFailure> {
    validate_tool_result(output)?;
    if let Some(structured) = output
        .get("structuredContent")
        .filter(|value| !value.is_null())
    {
        return parse_structured_results(structured, true);
    }
    let blocks = output
        .get("content")
        .and_then(Value::as_array)
        .filter(|blocks| blocks.len() == 1)
        .ok_or_else(|| contract("Advanced search requires one complete result document"))?;
    let block = &blocks[0];
    if block.get("type").and_then(Value::as_str) != Some("text") {
        return Err(contract("Advanced search returned no JSON text document"));
    }
    let text = block
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| contract("Advanced search JSON text is malformed"))?;
    if text.trim()
        == "No search results found. Please try a different query or adjust your filters."
    {
        return Ok(WebSearchPageV1::default());
    }
    let document: Value = serde_json::from_str(text)
        .map_err(|_| contract("Advanced search returned an invalid complete JSON document"))?;
    parse_structured_results(&document, true)
}

fn validate_tool_result(output: &Value) -> Result<(), SearchFailure> {
    let mut budget = MAX_EXA_OUTPUT_BYTES;
    if !bounded_value(output, &mut budget, 0) || !output.is_object() {
        return Err(contract(
            "Search result payload is invalid or exceeds its size limit",
        ));
    }
    // This exact vendor boolean is transport metadata, not prose or a quota estimate.
    if output
        .get("_meta")
        .and_then(|meta| meta.get("ai.exa/rateLimited"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Err(SearchFailure::new(
            WebSearchErrorKind::RateLimited,
            "Search source limited this request; retry later",
            true,
        ));
    }
    match output.get("isError") {
        Some(Value::Bool(true)) => {
            return Err(contract("Search source did not complete the query"));
        }
        Some(Value::Bool(false)) | None => {}
        _ => return Err(contract("Search source returned an invalid error flag")),
    }
    Ok(())
}

fn parse_structured_results(
    structured: &Value,
    preserve_all_content: bool,
) -> Result<WebSearchPageV1, SearchFailure> {
    let mut budget = MAX_EXA_OUTPUT_BYTES;
    if !bounded_value(structured, &mut budget, 0)
        || !structured.is_object()
        || structured
            .get("error")
            .is_some_and(|value| !value.is_null())
        || structured.get("isError").is_some()
    {
        return Err(contract("Search result document has an unsupported shape"));
    }
    let rows = structured
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| contract("Search structured content has no results array"))?;
    if rows.len() > MAX_EXA_RECORDS {
        return Err(contract("Search source returned too many result records"));
    }
    let mut parsed = Parsed {
        explicit_empty: rows.is_empty(),
        notices: has_notices(structured)?,
        ..Default::default()
    };
    for row in rows {
        match structured_hit(row, preserve_all_content) {
            Ok((hit, truncated)) => {
                parsed.hits.push(hit);
                parsed.truncated |= truncated;
            }
            Err(()) => parsed.invalid += 1,
        }
    }
    parsed.page()
}

#[derive(Default)]
struct Parsed {
    hits: Vec<WebSearchHitV1>,
    invalid: usize,
    notices: bool,
    explicit_empty: bool,
    truncated: bool,
}
impl Parsed {
    fn page(mut self) -> Result<WebSearchPageV1, SearchFailure> {
        if self.hits.is_empty() && (!self.explicit_empty || self.invalid > 0) {
            return Err(contract("Search source returned no usable result links"));
        }
        if self.explicit_empty && !self.hits.is_empty() {
            return Err(contract(
                "Search source returned contradictory empty and nonempty results",
            ));
        }
        let mut seen = HashSet::new();
        self.hits.retain(|hit| {
            // Canonical identity only removes fragments. The first original URL is retained verbatim.
            let mut key = url::Url::parse(&hit.url).expect("validated URL");
            key.set_fragment(None);
            seen.insert(key.to_string())
        });
        if self.hits.len() > WEB_SEARCH_RESULT_LIMIT {
            self.hits.truncate(WEB_SEARCH_RESULT_LIMIT);
            self.truncated = true;
        }
        let mut engine_failures = Vec::new();
        if self.invalid > 0 {
            engine_failures.push(WebSearchEngineFailureV1 {
                engine: "exa-public".into(),
                reason: "Some search result records were invalid and were omitted".into(),
            });
        }
        if self.notices {
            engine_failures.push(WebSearchEngineFailureV1 {
                engine: "exa-public".into(),
                reason: "The search source reported result limitations".into(),
            });
        }
        Ok(WebSearchPageV1 {
            results: self.hits,
            incomplete: self.invalid > 0 || self.notices || self.truncated,
            truncated: self.truncated,
            engine_failures,
            ..Default::default()
        })
    }
}

fn structured_hit(row: &Value, preserve_all_content: bool) -> Result<(WebSearchHitV1, bool), ()> {
    if !row.is_object() {
        return Err(());
    }
    let url = row.get("url").and_then(Value::as_str).ok_or(())?;
    if !safe_result_url(url) {
        return Err(());
    }
    let title = structured_title(row)?;
    let published_at = optional_field(row, "publishedDate", 128, true)?;
    let author = optional_field(row, "author", 512, true)?;
    let mut text = String::new();
    if let Some(highlights) = row.get("highlights") {
        let highlights = highlights.as_array().ok_or(())?;
        if highlights.len() > MAX_EXA_RECORDS {
            return Err(());
        }
        for (index, highlight) in highlights.iter().enumerate() {
            let highlight = highlight.as_str().ok_or(())?;
            if index > 0 {
                text.push('\n');
            }
            text.push_str(highlight);
        }
    }
    if preserve_all_content {
        let mut sections = Vec::new();
        if !text.is_empty() {
            sections.push(format!("Highlights:\n{text}"));
        }
        for (key, label) in [("text", "Text"), ("summary", "Source-generated summary")] {
            if let Some(value) = row.get(key).filter(|value| !value.is_null()) {
                let value = value.as_str().ok_or(())?;
                if !value.is_empty() {
                    sections.push(format!("{label}:\n{value}"));
                }
            }
        }
        text = sections.join("\n\n");
    } else if text.is_empty() {
        for key in ["text", "summary"] {
            if let Some(value) = row.get(key).filter(|value| !value.is_null()) {
                text = value.as_str().ok_or(())?.to_owned();
                if !text.is_empty() {
                    break;
                }
            }
        }
    }
    let (snippet, truncated) = bounded_snippet(&text)?;
    Ok((
        WebSearchHitV1 {
            source_id: String::new(),
            title,
            url: url.into(),
            snippet,
            published_at,
            author,
        },
        truncated,
    ))
}

fn structured_title(row: &Value) -> Result<String, ()> {
    let Some(value) = row.get("title").filter(|value| !value.is_null()) else {
        return Ok(String::new());
    };
    let title = value.as_str().ok_or(())?;
    if title.len() > MAX_TITLE_BYTES
        || title
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\r' | '\n' | '\t'))
    {
        return Err(());
    }
    // Exa can preserve HTML title layout whitespace. Keep it a single data line;
    // publication/author fields retain their existing stricter validation.
    Ok(title
        .split([' ', '\r', '\n', '\t'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" "))
}

fn optional_field(
    row: &Value,
    key: &str,
    limit: usize,
    placeholder: bool,
) -> Result<Option<String>, ()> {
    let Some(value) = row.get(key).filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let value = value.as_str().ok_or(())?;
    if value.len() > limit || value.chars().any(char::is_control) {
        return Err(());
    }
    if value.trim().is_empty() || (placeholder && value.eq_ignore_ascii_case("N/A")) {
        return Ok(None);
    }
    Ok(Some(value.to_owned()))
}

fn parse_legacy_text(text: &str, parsed: &mut Parsed) {
    let text = text.replace("\r\n", "\n");
    let mut rest = text.trim();
    // The upstream wrapper prefixes known Note: lines. Their contents never become instructions or error codes.
    while let Some(note) = rest.strip_prefix("Note: ") {
        parsed.notices = true;
        rest = note
            .split_once('\n')
            .map_or("", |(_, rest)| rest.trim_start());
    }
    if rest.is_empty() {
        return;
    }
    if rest == EXPLICIT_EMPTY_TEXT {
        parsed.explicit_empty = true;
        return;
    }
    for block in rest
        .split("\n\n---\n\n")
        .filter(|block| !block.trim().is_empty())
    {
        match legacy_hit(block.trim()) {
            Ok((hit, truncated)) => {
                parsed.hits.push(hit);
                parsed.truncated |= truncated;
            }
            Err(()) => parsed.invalid += 1,
        }
        if parsed.hits.len().saturating_add(parsed.invalid) > MAX_EXA_RECORDS {
            parsed.invalid += 1;
            break;
        }
    }
}

fn legacy_hit(block: &str) -> Result<(WebSearchHitV1, bool), ()> {
    let mut lines = block.lines();
    let title = lines
        .next()
        .and_then(|line| line.strip_prefix("Title: "))
        .ok_or(())?;
    let url = lines
        .next()
        .and_then(|line| line.strip_prefix("URL: "))
        .ok_or(())?;
    if title.len() > MAX_TITLE_BYTES || title.chars().any(char::is_control) || !safe_result_url(url)
    {
        return Err(());
    }
    let mut published_at = None;
    let mut author = None;
    let mut seen_date = false;
    let mut seen_author = false;
    let mut text = String::new();
    let mut body = false;
    for line in lines {
        if !body {
            if let Some(value) = line.strip_prefix("Published: ") {
                if seen_date {
                    return Err(());
                }
                seen_date = true;
                published_at = legacy_optional(value, 128)?;
                continue;
            }
            if let Some(value) = line.strip_prefix("Author: ") {
                if seen_author {
                    return Err(());
                }
                seen_author = true;
                author = legacy_optional(value, 512)?;
                continue;
            }
            if line.starts_with("URL:") || line.starts_with("Title:") {
                return Err(());
            }
            body = true;
            if line == "Highlights:" {
                continue;
            }
            if let Some(value) = line.strip_prefix("Text: ") {
                text.push_str(value);
                continue;
            }
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(line);
    }
    let (snippet, truncated) = bounded_snippet(&text)?;
    Ok((
        WebSearchHitV1 {
            source_id: String::new(),
            title: if title == "N/A" {
                String::new()
            } else {
                title.into()
            },
            url: url.into(),
            snippet,
            published_at,
            author,
        },
        truncated,
    ))
}
fn legacy_optional(value: &str, limit: usize) -> Result<Option<String>, ()> {
    if value.len() > limit || value.chars().any(char::is_control) {
        return Err(());
    }
    Ok((!value.is_empty() && value != "N/A").then(|| value.to_owned()))
}
fn bounded_snippet(text: &str) -> Result<(String, bool), ()> {
    if text
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return Err(());
    }
    let mut end = text.len().min(MAX_SNIPPET_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok((text[..end].to_owned(), end < text.len()))
}
fn safe_result_url(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_URL_BYTES
        || value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace() || ch == '\\')
    {
        return false;
    }
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    let userinfo = value
        .split_once("://")
        .and_then(|(_, rest)| rest.split(['/', '?', '#']).next())
        .is_some_and(|authority| authority.contains('@'));
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && !userinfo
}
fn has_notices(value: &Value) -> Result<bool, SearchFailure> {
    match value.get("notices") {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Array(items)) => Ok(!items.is_empty()),
        _ => Err(contract("Search source returned malformed result notices")),
    }
}
fn bounded_value(value: &Value, remaining: &mut usize, depth: usize) -> bool {
    if depth > 32 {
        return false;
    }
    let bytes = match value {
        Value::String(value) => value.len(),
        Value::Array(items) => items.len(),
        Value::Object(items) => items.keys().map(|key| key.len()).sum(),
        _ => 1,
    };
    let Some(next) = remaining.checked_sub(bytes) else {
        return false;
    };
    *remaining = next;
    match value {
        Value::Array(items) => items
            .iter()
            .all(|value| bounded_value(value, remaining, depth + 1)),
        Value::Object(items) => items
            .values()
            .all(|value| bounded_value(value, remaining, depth + 1)),
        _ => true,
    }
}
fn contract(message: &str) -> SearchFailure {
    SearchFailure::new(WebSearchErrorKind::ContractInvalid, message, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn text(value: &str) -> Value {
        json!({"content":[{"type":"text","text":value}]})
    }
    fn structured(rows: Value) -> Value {
        json!({"structuredContent":{"results":rows}})
    }
    fn row(url: &str) -> Value {
        json!({"title":"Official page","url":url,"publishedDate":"2026-10-30","author":"Publisher","highlights":["A factual excerpt."]})
    }
    #[test]
    fn structured_results_preserve_native_source_fields_without_accepting_upstream_identity() {
        let mut record = row("https://example.com/page?q=a%2Bb#section");
        record["sourceId"] = json!("forged-native-source");
        record["retrievedAt"] = json!("2026-10-31");
        let page = parse_exa_output(&structured(json!([record]))).unwrap();
        let hit = &page.results[0];
        assert!(hit.source_id.is_empty());
        assert_eq!(hit.url, "https://example.com/page?q=a%2Bb#section");
        assert_eq!(hit.title, "Official page");
        assert_eq!(hit.published_at.as_deref(), Some("2026-10-30"));
        assert_eq!(hit.author.as_deref(), Some("Publisher"));
        assert!(hit.snippet.contains("factual excerpt"));
        assert!(!page.incomplete);
    }
    #[test]
    fn legacy_text_preserves_dates_and_does_not_treat_body_metadata_as_source_headers() {
        let page = parse_exa_output(&text("Title: Official page\nURL: https://example.com/page\nPublished: 2026-10-30\nAuthor: Publisher\nHighlights:\nSummary\nTitle: body text\nURL: javascript:body\nPublished: 2099-01-01")).unwrap();
        assert_eq!(page.results.len(), 1);
        assert_eq!(page.results[0].published_at.as_deref(), Some("2026-10-30"));
        assert!(page.results[0].snippet.contains("Title: body text"));
        let unknown = parse_exa_output(&text(
            "Title: N/A\nURL: https://example.com\nPublished: N/A\nAuthor: N/A\nText: Body",
        ))
        .unwrap();
        assert!(unknown.results[0].published_at.is_none());
        assert!(unknown.results[0].author.is_none());
        assert_eq!(unknown.results[0].snippet, "Body");
    }
    #[test]
    fn only_explicit_empty_results_are_empty_not_transport_errors_or_contract_drift() {
        assert!(
            parse_exa_output(&structured(json!([])))
                .unwrap()
                .results
                .is_empty()
        );
        assert!(
            parse_exa_output(&text(EXPLICIT_EMPTY_TEXT))
                .unwrap()
                .results
                .is_empty()
        );
        for output in [
            json!({}),
            text(""),
            text("No results"),
            text("Search quota exhausted"),
            text("<html>https://example.com</html>"),
            text("<soap:Envelope>failure</soap:Envelope>"),
            text("[Official](https://example.com)"),
            text("{\"results\":[]}"),
            json!({"structuredContent":{}}),
            structured(json!({})),
            json!({"isError":true,"structuredContent":{"results":[]}}),
            json!({"isError":"false","structuredContent":{"results":[]}}),
        ] {
            let failure = parse_exa_output(&output).unwrap_err();
            assert_eq!(
                failure.kind,
                WebSearchErrorKind::ContractInvalid,
                "{output}"
            );
            assert!(failure.request_sent);
        }
    }
    #[test]
    fn unsafe_or_missing_links_never_become_empty_or_trusted_records() {
        for url in [
            "javascript:alert(1)",
            "file:///tmp/source",
            "data:text/plain,source",
            "ftp://example.com",
            "https://user:password@example.com/",
            "https://@example.com",
            "https://example.com/\nspoof",
            "https://example.com\\@evil.example/",
        ] {
            assert!(
                parse_exa_output(&structured(json!([row(url)]))).is_err(),
                "{url}"
            );
        }
        assert!(parse_exa_output(&structured(json!([{"title":"No link"}]))).is_err());
        let page = parse_exa_output(&structured(json!([
            row("https://example.com"),
            row("javascript:bad")
        ])))
        .unwrap();
        assert_eq!(page.results.len(), 1);
        assert!(page.incomplete);
        assert_eq!(page.engine_failures.len(), 1);
    }
    #[test]
    fn duplicate_keys_do_not_merge_query_parameters_protocols_or_distinct_hosts() {
        let first = "HTTPS://EXAMPLE.com:443/page?signature=a%2Bb#first";
        let page = parse_exa_output(&structured(json!([
            row(first),
            row("https://example.com/page?signature=a%2Bb#second"),
            row("http://example.com/page?signature=a%2Bb"),
            row("https://example.com/page?signature=a+b"),
            row("https://www.example.com/page?signature=a%2Bb")
        ])))
        .unwrap();
        assert_eq!(page.results.len(), 4);
        assert_eq!(page.results[0].url, first);
    }
    #[test]
    fn utf8_limits_are_bytes_and_snippet_truncation_is_explicit() {
        let mut record = row("https://example.com");
        record["text"] = json!("中".repeat(MAX_SNIPPET_BYTES));
        record.as_object_mut().unwrap().remove("highlights");
        let page = parse_exa_output(&structured(json!([record]))).unwrap();
        assert!(page.truncated && page.incomplete);
        assert!(page.results[0].snippet.len() <= MAX_SNIPPET_BYTES);
        assert!(page.results[0].snippet.ends_with('中'));
        let mut too_long = row("https://example.com");
        too_long["title"] = json!("中".repeat(MAX_TITLE_BYTES / 3 + 1));
        assert!(parse_exa_output(&structured(json!([too_long]))).is_err());
        assert!(parse_exa_output(&text(&"x".repeat(MAX_EXA_OUTPUT_BYTES + 1))).is_err());
    }
    #[test]
    fn record_caps_and_source_notices_remain_visible_as_partial() {
        let page = parse_exa_output(&structured(json!(
            (0..21)
                .map(|index| row(&format!("https://example.com/{index}")))
                .collect::<Vec<_>>()
        )))
        .unwrap();
        assert_eq!(page.results.len(), 20);
        assert!(page.incomplete && page.truncated);
        let mut output = structured(json!([row("https://example.com")]));
        output["structuredContent"]["notices"] =
            json!([{"code":"source_notice","message":"Restriction relaxed"}]);
        assert!(parse_exa_output(&output).unwrap().incomplete);
        assert!(parse_exa_output(&text("Note: Source limitation\n\nTitle: Page\nURL: https://example.com\nHighlights:\nBody")).unwrap().incomplete);
    }
    #[test]
    fn advanced_accepts_only_complete_json_or_structured_records_and_retains_content_kinds() {
        let mut record = row("https://example.com/advanced?signature=a%2Bb#section");
        record["text"] = json!("Original page extract");
        record["summary"] = json!("Generated source summary");
        let document = json!({"results":[record],"notices":[]});
        let output = text(&serde_json::to_string(&document).unwrap());
        let page = parse_exa_advanced_output(&output).unwrap();
        let hit = &page.results[0];
        assert_eq!(
            hit.url,
            "https://example.com/advanced?signature=a%2Bb#section"
        );
        assert_eq!(hit.published_at.as_deref(), Some("2026-10-30"));
        assert_eq!(hit.author.as_deref(), Some("Publisher"));
        assert!(hit.snippet.contains("Highlights:"));
        assert!(hit.snippet.contains("A factual excerpt."));
        assert!(hit.snippet.contains("Text:\nOriginal page extract"));
        assert!(
            hit.snippet
                .contains("Source-generated summary:\nGenerated source summary")
        );
        assert_eq!(
            parse_exa_advanced_output(&json!({"structuredContent":document})).unwrap(),
            page
        );
        assert!(parse_exa_output(&output).is_err());
    }
    #[test]
    fn advanced_empty_results_are_explicit_and_schema_drift_or_error_cannot_be_empty() {
        assert!(
            parse_exa_advanced_output(&text(r#"{"results":[]}"#))
                .unwrap()
                .results
                .is_empty()
        );
        assert!(
            parse_exa_advanced_output(&text(
                "No search results found. Please try a different query or adjust your filters."
            ))
            .unwrap()
            .results
            .is_empty()
        );
        for value in [
            text("```json\n{}\n```"),
            text("Intro {}"),
            text(r#"{"results":[]} trailing"#),
            text("[]"),
            text("null"),
            text(r#"{"requestId":"unknown-empty-or-drift","searchTime":1}"#),
            text(r#"{"results":{},"error":"quota"}"#),
            text("<soap:Envelope/>"),
            json!({"isError":true,"content":[{"type":"text","text":"ignored error data"}]}),
        ] {
            assert_eq!(
                parse_exa_advanced_output(&value).unwrap_err().kind,
                WebSearchErrorKind::ContractInvalid,
                "{value}"
            );
        }
        let repeated = json!({"content":[{"type":"text","text":"{}"},{"type":"text","text":"{}"}]});
        assert!(parse_exa_advanced_output(&repeated).is_err());
        assert!(
            parse_exa_advanced_output(&text(
                r#"{"results":[{"url":"https://example.com","title":"\ud800"}]}"#
            ))
            .is_err()
        );
    }
    #[test]
    fn structured_titles_normalize_layout_whitespace_without_accepting_other_controls() {
        let url = "https://mail.example.org/archives/list/announce@example.org/2026/10/";
        let mut record = row(url);
        record["title"] = json!("Mailman 3 \r\n\t [Announcement] Release – 测试");
        record["publishedDate"] = json!("2026-10-30T00:00:00.000Z");
        let output = text(&json!({"results":[record.clone()]}).to_string());
        let page = parse_exa_advanced_output(&output).unwrap();
        assert_eq!(
            page.results[0].title,
            "Mailman 3 [Announcement] Release – 测试"
        );
        assert_eq!(page.results[0].url, url);
        assert_eq!(
            page.results[0].published_at.as_deref(),
            Some("2026-10-30T00:00:00.000Z")
        );
        assert_eq!(page.results[0].author.as_deref(), Some("Publisher"));
        assert!(!page.incomplete);
        assert_eq!(
            parse_exa_output(&structured(json!([record.clone()])))
                .unwrap()
                .results[0]
                .title,
            page.results[0].title
        );
        for control in ['\0', '\u{1b}', '\u{7f}', '\u{85}', '\u{b}', '\u{c}'] {
            record["title"] = json!(format!("Title{control}data"));
            assert_eq!(
                parse_exa_advanced_output(&structured(json!([record.clone()])))
                    .unwrap_err()
                    .kind,
                WebSearchErrorKind::ContractInvalid
            );
        }
        for invalid in [
            json!(" \n".repeat(600)),
            json!("中".repeat(342)),
            json!(123),
        ] {
            record["title"] = invalid;
            assert!(parse_exa_advanced_output(&structured(json!([record.clone()]))).is_err());
        }
        record["title"] = json!("Safe\nTitle");
        for field in ["publishedDate", "author"] {
            let mut invalid = record.clone();
            invalid[field] = json!("Still\nInvalid");
            assert!(parse_exa_advanced_output(&structured(json!([invalid]))).is_err());
        }
    }

    #[test]
    fn only_exact_exa_rate_limit_metadata_is_a_rate_limit_not_prose_or_empty() {
        let mut output = text("Upstream rate-limit prose; no complete result document");
        output["_meta"] = json!({"ai.exa/rateLimited":true});
        for parse in [parse_exa_output, parse_exa_advanced_output] {
            let failure = parse(&output).unwrap_err();
            assert_eq!(failure.kind, WebSearchErrorKind::RateLimited);
            assert!(failure.request_sent);
            assert!(!failure.message.contains("API"));
            for marker in [Value::Null, json!(false), json!("true"), json!(1)] {
                let mut unknown = output.clone();
                unknown["_meta"]["ai.exa/rateLimited"] = marker;
                assert_eq!(
                    parse(&unknown).unwrap_err().kind,
                    WebSearchErrorKind::ContractInvalid
                );
            }
        }
        assert_eq!(
            parse_exa_advanced_output(&text("Rate limit / quota exceeded"))
                .unwrap_err()
                .kind,
            WebSearchErrorKind::ContractInvalid
        );
        let unknown_vendor = json!({"_meta":{"another.vendor/rateLimited":true},"content":[{"type":"text","text":"Rate limit"}]});
        assert_eq!(
            parse_exa_advanced_output(&unknown_vendor).unwrap_err().kind,
            WebSearchErrorKind::ContractInvalid
        );
        let embedded = text(r#"{"_meta":{"ai.exa/rateLimited":true},"results":[]}"#);
        assert!(
            parse_exa_advanced_output(&embedded)
                .unwrap()
                .results
                .is_empty()
        );
        let false_marker =
            json!({"_meta":{"ai.exa/rateLimited":false},"structuredContent":{"results":[]}});
        assert!(
            parse_exa_advanced_output(&false_marker)
                .unwrap()
                .results
                .is_empty()
        );
        let missing =
            json!({"content":[{"type":"text","text":"{\"requestId\":\"not-proof-of-empty\"}"}]});
        assert_eq!(
            parse_exa_advanced_output(&missing).unwrap_err().kind,
            WebSearchErrorKind::ContractInvalid
        );
    }
}

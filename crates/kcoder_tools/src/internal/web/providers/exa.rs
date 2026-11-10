//! Bounded Exa JSON-RPC and SSE protocol over the owner's search transport.
use super::{Request, SearchFailure, Transport};
use crate::search::{
    constraints, provider_results,
    request::{LivecrawlMode, SearchType, WebSearchInput, filter_results},
};
#[cfg(test)]
use kcoder_types::web_search::WebSearchHitV1 as SearchResult;
use kcoder_types::web_search::{WebSearchErrorKind, WebSearchPageV1, WebSearchProvider};
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderValue, USER_AGENT};
use serde_json::{Value, json};
use std::time::Instant;

pub const ENDPOINT: &str = "https://mcp.exa.ai/mcp";
const ADVANCED_ENDPOINT: &str = "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

struct SearchSession<'a> {
    transport: &'a dyn Transport,
    endpoint: &'a str,
    id: Option<HeaderValue>,
}

impl SearchSession<'_> {
    fn close_request(&self, id: HeaderValue) -> Option<Request> {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("Mcp-Session-Id", id);
        headers.insert(
            "MCP-Protocol-Version",
            HeaderValue::from_static("2025-03-26"),
        );
        headers.insert(USER_AGENT, HeaderValue::from_static("KCoder/0.1"));
        Some(Request {
            method: reqwest::Method::DELETE,
            url: reqwest::Url::parse(self.endpoint).ok()?,
            headers,
            body: None,
        })
    }

    async fn close(&mut self) {
        if let Some(request) = self.id.clone().and_then(|id| self.close_request(id)) {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                self.transport.close_exa_session(request),
            )
            .await;
        }
        self.id = None;
    }
}

impl Drop for SearchSession<'_> {
    fn drop(&mut self) {
        // A dropped search still owns an idempotent, bounded session cleanup.
        let Some(request) = self.id.take().and_then(|id| self.close_request(id)) else {
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let cleanup = self.transport.close_exa_session(request);
        runtime.spawn(async move {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), cleanup).await;
        });
    }
}

fn failure(message: impl Into<String>) -> SearchFailure {
    SearchFailure::new(WebSearchErrorKind::ContractInvalid, message, true)
}

fn result(message: Value, id: u64) -> Result<Option<Value>, SearchFailure> {
    if message.get("id").and_then(Value::as_u64) != Some(id) {
        return Ok(None);
    }
    if let Some(error) = message.get("error") {
        let diagnostic = match error.get("code").and_then(Value::as_i64) {
            Some(code) => format!("Search service RPC failed (code {code})"),
            None => "Search service returned an invalid RPC error".into(),
        };
        return Err(failure(diagnostic));
    }
    message
        .get("result")
        .cloned()
        .map(Some)
        .ok_or_else(|| failure("Search service returned an invalid RPC response"))
}

async fn rpc(
    session: &mut SearchSession<'_>,
    method: &str,
    params: Value,
    id: Option<u64>,
) -> Result<Value, SearchFailure> {
    let started = Instant::now();
    let result = rpc_response(session, method, params, id).await;
    tracing::debug!(
        stage = method,
        elapsed_ms = started.elapsed().as_millis() as u64,
        completed = result.is_ok(),
        "Search protocol stage completed"
    );
    result.map_err(|mut error| {
        if method != "tools/call" {
            error.request_sent = false;
        }
        error
    })
}

async fn rpc_response(
    session: &mut SearchSession<'_>,
    method: &str,
    params: Value,
    id: Option<u64>,
) -> Result<Value, SearchFailure> {
    let endpoint = session.endpoint;
    let mut body = json!({"jsonrpc":"2.0","method":method,"params":params});
    if let Some(id) = id {
        body["id"] = json!(id);
    }
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("KCoder/0.1"));
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/event-stream"),
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        "MCP-Protocol-Version",
        HeaderValue::from_static("2025-03-26"),
    );
    if let Some(id) = session.id.as_ref() {
        headers.insert("Mcp-Session-Id", id.clone());
    }
    let url =
        reqwest::Url::parse(endpoint).map_err(|_| failure("Invalid search service endpoint"))?;
    let mut owner = session
        .transport
        .send(
            WebSearchProvider::Exa,
            Request {
                method: reqwest::Method::POST,
                url,
                headers,
                body: Some(
                    serde_json::to_vec(&body)
                        .map_err(|_| failure("Invalid search RPC document"))?,
                ),
            },
        )
        .await?;
    let response = owner.response();
    if !response.status().is_success() {
        return Err(crate::providers::http_failure(response.status()));
    }
    if let Some(value) = response.headers().get("Mcp-Session-Id") {
        session.id = Some(value.clone());
    }
    let Some(id) = id else {
        return Ok(Value::Null);
    };
    let sse = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"));
    let mut bytes = Vec::new();
    let mut received = 0usize;
    let mut event_data = String::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        failure(format!(
            "Search response interrupted: {}",
            error.without_url()
        ))
    })? {
        received = received.saturating_add(chunk.len());
        if received > MAX_RESPONSE_BYTES {
            return Err(failure("Search response exceeds the 2 MiB limit"));
        }
        bytes.extend_from_slice(&chunk);
        if sse {
            while let Some(end) = bytes.iter().position(|byte| *byte == b'\n') {
                let line = String::from_utf8(bytes.drain(..=end).collect())
                    .map_err(|_| failure("Search service returned invalid UTF-8"))?;
                let line = line.trim_end_matches(['\r', '\n']);
                if line.is_empty() {
                    if !event_data.is_empty() {
                        let message: Value = serde_json::from_str(&event_data)
                            .map_err(|_| failure("Search service returned invalid SSE JSON"))?;
                        event_data.clear();
                        if let Some(value) = result(message, id)? {
                            return Ok(value);
                        }
                    }
                } else if let Some(data) = line.strip_prefix("data:") {
                    if !event_data.is_empty() {
                        event_data.push('\n');
                    }
                    event_data.push_str(data.strip_prefix(' ').unwrap_or(data));
                }
            }
        }
    }
    if sse {
        if !event_data.is_empty() {
            let message = serde_json::from_str(&event_data)
                .map_err(|_| failure("Search service returned invalid SSE JSON"))?;
            if let Some(value) = result(message, id)? {
                return Ok(value);
            }
        }
    } else {
        let message = serde_json::from_slice(&bytes)
            .map_err(|_| failure("Search service returned invalid JSON"))?;
        if let Some(value) = result(message, id)? {
            return Ok(value);
        }
    }
    Err(failure("Search service closed without a matching response"))
}

fn search_mode(
    properties: &Value,
    input: &WebSearchInput,
    advanced: bool,
) -> Result<(Option<&'static str>, Vec<String>), SearchFailure> {
    let desired = match input.search_type {
        Some(SearchType::Fast) => "fast",
        Some(SearchType::Deep) => "deep",
        _ => "auto",
    };
    let accepts = |value: &str| {
        properties["type"]["enum"].as_array().is_none_or(|values| {
            values
                .iter()
                .any(|candidate| candidate.as_str() == Some(value))
        })
    };
    let selected = if properties.get("type").is_none() {
        None
    } else if !advanced && accepts(desired) {
        Some(desired)
    } else if accepts("auto") {
        Some("auto")
    } else {
        return Err(failure(
            "Search service does not expose a compatible search mode",
        ));
    };
    let notes = if desired != "auto" && selected != Some(desired) {
        vec![format!(
            "The source does not expose the requested {desired} depth in this toolset; automatic retrieval is used with the requested result limit."
        )]
    } else {
        Vec::new()
    };
    Ok((selected, notes))
}

#[cfg(test)]
fn parse_results(text: &str) -> Vec<SearchResult> {
    let mut results = Vec::new();
    let mut current: Option<SearchResult> = None;
    for line in text.lines() {
        if let Some(title) = line.strip_prefix("Title: ") {
            if let Some(value) = current.take() {
                results.push(value);
            }
            current = Some(SearchResult {
                title: title.to_owned(),
                url: String::new(),
                snippet: String::new(),
                ..Default::default()
            });
        } else if let Some(value) = current.as_mut() {
            if let Some(url) = line.strip_prefix("URL: ") {
                value.url = url.trim().to_owned();
            } else if let Some(date) = line.strip_prefix("Published: ") {
                value.published_at = Some(date.chars().take(64).collect());
            } else if let Some(author) = line.strip_prefix("Author: ") {
                value.author = Some(author.chars().take(200).collect());
            } else if !line.starts_with("Published:")
                && !line.starts_with("Author:")
                && line != "---"
                && line != "Highlights:"
                && value.snippet.chars().count() < 4000
            {
                value.snippet.push_str(line);
                value.snippet.push('\n');
            }
        }
    }
    if let Some(value) = current {
        results.push(value);
    }
    results.retain(|value| {
        reqwest::Url::parse(&value.url)
            .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
    });
    results
}

pub async fn search_page(
    transport: &dyn Transport,
    input: &WebSearchInput,
    endpoint: &str,
) -> Result<WebSearchPageV1, SearchFailure> {
    let advanced = input.constraints.region.is_some() || input.constraints.time_range.is_some();
    let plan = input.constraints.plan(
        kcoder_types::web_search::WebSearchProvider::Exa,
        constraints::ProviderConstraintCapabilities {
            native_time_range: advanced,
            region: advanced,
            language: false,
        },
    )?;
    let endpoint = if advanced && endpoint == ENDPOINT {
        ADVANCED_ENDPOINT
    } else {
        endpoint
    };
    let tool_name = if advanced {
        "web_search_advanced_exa"
    } else {
        "web_search_exa"
    };
    transport.check(WebSearchProvider::Exa)?;
    let mut session = SearchSession {
        transport,
        endpoint,
        id: None,
    };
    let mut query_started = false;
    let outcome = async {
    rpc(&mut session, "initialize", json!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"kcoder","version":env!("CARGO_PKG_VERSION")}}), Some(1)).await?;
    rpc(&mut session, "notifications/initialized", json!({}), None).await?;
    let tools = rpc(&mut session, "tools/list", json!({}), Some(2)).await?;
    let tool = tools.get("tools").and_then(Value::as_array).and_then(|tools| tools.iter().find(|tool| tool["name"] == tool_name))
        .ok_or_else(|| failure("Search service does not expose the requested search capability"))?;
    let properties = &tool["inputSchema"]["properties"];
    let (search_mode, notes) = search_mode(properties, input, advanced)?;
    let limit = input.num_results.unwrap_or(match input.search_type { Some(SearchType::Fast) => 5, Some(SearchType::Deep) => 16, _ => 8 }).min(20);
    let mut arguments = json!({"query":input.query,"numResults":limit});
    let mut objective = format!("Find documents directly answering this query: {}. Prefer original sources and specific relevant pages over generic homepages.", input.query);
    if let Some(domains) = &input.allowed_domains { objective.push_str(&format!(" Only include domains: {}.", domains.join(", "))); }
    if let Some(domains) = &input.blocked_domains { objective.push_str(&format!(" Exclude domains: {}.", domains.join(", "))); }
    if matches!(input.livecrawl, Some(LivecrawlMode::Preferred)) { objective.push_str(" Prefer freshly retrieved content where available."); }
    if properties.get("objective").is_some() { arguments["objective"] = json!(objective.chars().take(4096).collect::<String>()); }
    if let Some(mode)=search_mode { arguments["type"] = json!(mode); }
    if properties.get("livecrawl").is_some() { arguments["livecrawl"] = json!(if matches!(input.livecrawl, Some(LivecrawlMode::Preferred)) { "preferred" } else { "fallback" }); }
    if properties.get("contextMaxCharacters").is_some() { arguments["contextMaxCharacters"] = json!(input.context_max_characters.unwrap_or(10_000)); }
    if advanced {
        if let Some(region)=&plan.region {arguments["userLocation"]=json!(region);}
        if let Some(window)=input.constraints.publication_window(chrono::Utc::now()).map_err(SearchFailure::contract)? {
            arguments["startPublishedDate"]=json!(window.since.format("%Y-%m-%d").to_string());
            let until=window.until.date_naive().succ_opt().ok_or_else(||failure("Publication window cannot be represented"))?;
            arguments["endPublishedDate"]=json!(until.format("%Y-%m-%d").to_string());
        }
        if let Some(domains)=&input.allowed_domains {arguments["includeDomains"]=json!(domains);}
        if let Some(domains)=&input.blocked_domains {arguments["excludeDomains"]=json!(domains);}
        if properties.get("enableSummary").is_some(){arguments["enableSummary"]=json!(false);}
        if properties.get("enableHighlights").is_some(){arguments["enableHighlights"]=json!(true);}
        if properties.get("highlightsMaxCharacters").is_some(){arguments["highlightsMaxCharacters"]=json!(2000);}
    }
    transport.check(WebSearchProvider::Exa)?;
    query_started=true;
    let output = rpc(&mut session, "tools/call", json!({"name":tool_name,"arguments":arguments}), Some(3)).await?;
    let mut page=if advanced {provider_results::parse_exa_advanced_output(&output)?}else{provider_results::parse_exa_output(&output)?};
    page.constraint_notes.extend(notes);
    page.results=filter_results(page.results,input).into_iter().take(limit).collect();
    Ok(page)
    }.await;
    session.close().await;
    outcome.map_err(|mut error: SearchFailure| {
        error.request_sent &= query_started;
        error
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertised_modes_are_respected_and_unavailable_depth_is_disclosed() {
        let input: WebSearchInput =
            serde_json::from_value(json!({"query":"official source","search_type":"deep"}))
                .unwrap();
        let schema = json!({"type":{"enum":["auto","fast","lite","instant"]}});
        let (mode, notes) = search_mode(&schema, &input, false).unwrap();
        assert_eq!(mode, Some("auto"));
        assert!(notes[0].contains("deep"));
        let schema = json!({"type":{"enum":["auto","fast","deep"]}});
        assert_eq!(search_mode(&schema, &input, false).unwrap().0, Some("deep"));
        assert_eq!(search_mode(&schema, &input, true).unwrap().0, Some("auto"));
        assert!(search_mode(&json!({"type":{"enum":["unsupported"]}}), &input, false).is_err());
    }

    #[test]
    fn parses_structured_search_text_without_accepting_script_links() {
        let results = parse_results(
            "Title: Async IO\nURL: https://docs.python.org/3/library/asyncio.html\nHighlights:\nasyncio documentation\n\n---\n\nTitle: unsafe\nURL: javascript:alert(1)\n",
        );
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Async IO");
        assert!(results[0].snippet.contains("asyncio documentation"));
    }

    #[test]
    fn rpc_envelopes_require_the_matching_id_and_surface_failures() {
        assert!(result(json!({"id":2,"result":{}}), 1).unwrap().is_none());
        assert!(result(json!({"id":1,"error":{"code":-32600}}), 1).is_err());
        assert!(result(json!({"id":1}), 1).is_err());
        let error = result(json!({"id":1,"error":{"code":{"reflected_query":"PRIVATE_QUERY_MARKER"},"message":"PRIVATE_QUERY_MARKER"}}),1).unwrap_err();
        assert!(!error.message.contains("PRIVATE_QUERY_MARKER"));
        assert!(error.message.contains("invalid RPC error"));
    }
}

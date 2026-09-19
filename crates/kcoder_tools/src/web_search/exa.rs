use super::{
    LivecrawlMode, SearchResult, SearchType, WebSearchInput, filter_results, format_results,
};
use crate::ToolError;
use futures::StreamExt;
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderValue, USER_AGENT};
use serde_json::{Value, json};
use std::time::Instant;

pub(super) const ENDPOINT: &str = "https://mcp.exa.ai/mcp";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

fn failure(message: impl Into<String>) -> ToolError {
    ToolError::Execution(message.into())
}

fn result(message: Value, id: u64) -> Result<Option<Value>, ToolError> {
    if message.get("id").and_then(Value::as_u64) != Some(id) {
        return Ok(None);
    }
    if let Some(error) = message.get("error") {
        return Err(failure(format!(
            "Search service RPC failed (code {})",
            error.get("code").unwrap_or(&Value::Null)
        )));
    }
    message
        .get("result")
        .cloned()
        .map(Some)
        .ok_or_else(|| failure("Search service returned an invalid RPC response"))
}

async fn rpc(
    client: &reqwest::Client,
    endpoint: &str,
    session: &mut Option<HeaderValue>,
    method: &str,
    params: Value,
    id: Option<u64>,
) -> Result<Value, ToolError> {
    let mut body = json!({"jsonrpc":"2.0","method":method,"params":params});
    if let Some(id) = id {
        body["id"] = json!(id);
    }
    let mut request = client
        .post(endpoint)
        .header(USER_AGENT, "KCoder/0.1")
        .header(ACCEPT, "application/json, text/event-stream")
        .header(CONTENT_TYPE, "application/json")
        .header("MCP-Protocol-Version", "2025-03-26")
        .json(&body);
    if let Some(session) = session.as_ref() {
        request = request.header("Mcp-Session-Id", session);
    }
    let response = request.send().await.map_err(|error| {
        failure(format!(
            "Cannot reach search service: {}",
            error.without_url()
        ))
    })?;
    if !response.status().is_success() {
        return Err(failure(format!(
            "Search service returned HTTP {}; search was not completed",
            response.status().as_u16()
        )));
    }
    if let Some(value) = response.headers().get("Mcp-Session-Id") {
        *session = Some(value.clone());
    }
    let Some(id) = id else {
        return Ok(Value::Null);
    };
    let sse = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"));
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    let mut received = 0usize;
    let mut event_data = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            failure(format!(
                "Search response interrupted: {}",
                error.without_url()
            ))
        })?;
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
            });
        } else if let Some(value) = current.as_mut() {
            if let Some(url) = line.strip_prefix("URL: ") {
                value.url = url.trim().to_owned();
            } else if !line.starts_with("Published:")
                && !line.starts_with("Author:")
                && line != "---"
                && line != "Highlights:"
            {
                if value.snippet.chars().count() < 4000 {
                    value.snippet.push_str(line);
                    value.snippet.push('\n');
                }
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

pub(super) async fn search(
    client: &reqwest::Client,
    input: &WebSearchInput,
    endpoint: &str,
) -> Result<String, ToolError> {
    let started = Instant::now();
    let mut session = None;
    let outcome = async {
    rpc(client, endpoint, &mut session, "initialize", json!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"kcoder","version":env!("CARGO_PKG_VERSION")}}), Some(1)).await?;
    rpc(client, endpoint, &mut session, "notifications/initialized", json!({}), None).await?;
    let tools = rpc(client, endpoint, &mut session, "tools/list", json!({}), Some(2)).await?;
    let tool = tools.get("tools").and_then(Value::as_array).and_then(|tools| tools.iter().find(|tool| tool["name"] == "web_search_exa"))
        .ok_or_else(|| failure("Search service does not expose web_search_exa"))?;
    let properties = &tool["inputSchema"]["properties"];
    let limit = input.num_results.unwrap_or(match input.search_type { Some(SearchType::Fast) => 5, Some(SearchType::Deep) => 16, _ => 8 }).min(20);
    let mut arguments = json!({"query":input.query,"numResults":limit});
    let mut objective = format!("Find documents directly answering this query: {}. Prefer original sources and specific relevant pages over generic homepages.", input.query);
    if let Some(domains) = &input.allowed_domains { objective.push_str(&format!(" Only include domains: {}.", domains.join(", "))); }
    if let Some(domains) = &input.blocked_domains { objective.push_str(&format!(" Exclude domains: {}.", domains.join(", "))); }
    if matches!(input.livecrawl, Some(LivecrawlMode::Preferred)) { objective.push_str(" Prefer freshly retrieved content where available."); }
    if properties.get("objective").is_some() { arguments["objective"] = json!(objective.chars().take(4096).collect::<String>()); }
    if properties.get("type").is_some() { arguments["type"] = json!(match input.search_type { Some(SearchType::Fast) => "fast", Some(SearchType::Deep) => "deep", _ => "auto" }); }
    if properties.get("livecrawl").is_some() { arguments["livecrawl"] = json!(if matches!(input.livecrawl, Some(LivecrawlMode::Preferred)) { "preferred" } else { "fallback" }); }
    if properties.get("contextMaxCharacters").is_some() { arguments["contextMaxCharacters"] = json!(input.context_max_characters.unwrap_or(10_000)); }
    let output = rpc(client, endpoint, &mut session, "tools/call", json!({"name":"web_search_exa","arguments":arguments}), Some(3)).await?;
    if output.get("isError").and_then(Value::as_bool) == Some(true) { return Err(failure("Search service rejected the query or reached its usage limit")); }
    let text = output.get("content").and_then(Value::as_array).map(|items| items.iter().filter(|item| item["type"] == "text").filter_map(|item| item["text"].as_str()).collect::<Vec<_>>().join("\n\n")).unwrap_or_default();
    let results = parse_results(&text);
    if results.is_empty() { return Err(failure("Search service returned no usable result links")); }
    let selected = filter_results(results, input).into_iter().take(limit).collect::<Vec<_>>();
    Ok(format_results(&selected, &input.query, started.elapsed().as_millis() as u64, input.context_max_characters.unwrap_or(10_000)))
    }.await;
    if let Some(session) = session {
        let _ = client
            .delete(endpoint)
            .header("Mcp-Session-Id", session)
            .header("MCP-Protocol-Version", "2025-03-26")
            .header(USER_AGENT, "KCoder/0.1")
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await;
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mcp_search_negotiates_schema_filters_domains_and_closes_owned_session() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for index in 0..5 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let (header, body_start, length) = loop {
                    let mut chunk = [0u8; 4096];
                    let count = stream.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&chunk[..count]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let header = String::from_utf8(bytes[..end].to_vec())
                            .unwrap()
                            .to_ascii_lowercase();
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("content-length:")
                                    .map(|value| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        break (header, end + 4, length);
                    }
                };
                while bytes.len() < body_start + length {
                    let mut chunk = [0u8; 4096];
                    let count = stream.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&chunk[..count]);
                }
                if index > 0 {
                    assert!(header.contains("mcp-session-id: owned-test-session"));
                }
                let request: Value = if length == 0 {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes[body_start..body_start + length]).unwrap()
                };
                let (status, content_type, body) = match index {
                    0 => {
                        assert_eq!(request["method"], "initialize");
                        (200, "application/json", json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26"}}).to_string())
                    }
                    1 => {
                        assert_eq!(request["method"], "notifications/initialized");
                        assert!(request.get("id").is_none());
                        (202, "application/json", String::new())
                    }
                    2 => {
                        let reply = json!({"id":2,"result":{"tools":[{"name":"web_search_exa","inputSchema":{"properties":{"query":{},"objective":{},"numResults":{}}}}]}});
                        (
                            200,
                            "text/event-stream",
                            format!(
                                "data: {{\"method\":\"notification\"}}\n\nevent: message\ndata: {reply}\n\n"
                            ),
                        )
                    }
                    3 => {
                        let args = &request["params"]["arguments"];
                        assert_eq!(args["query"], "asyncio docs");
                        assert!(
                            args["objective"]
                                .as_str()
                                .unwrap()
                                .contains("docs.python.org")
                        );
                        assert!(args.get("type").is_none());
                        assert!(args.get("livecrawl").is_none());
                        (200, "application/json", json!({"id":3,"result":{"content":[{"type":"text","text":"Title: Async IO\nURL: https://docs.python.org/3/library/asyncio.html\nHighlights:\nPython asyncio docs\n\nTitle: unrelated\nURL: https://example.org/\nHighlights:\nother"}]}}).to_string())
                    }
                    _ => {
                        assert!(header.starts_with("delete "));
                        (204, "application/json", String::new())
                    }
                };
                let response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\nMcp-Session-Id: owned-test-session\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let input: WebSearchInput = serde_json::from_value(json!({"query":"asyncio docs","allowed_domains":["docs.python.org"],"search_type":"deep","livecrawl":"preferred","num_results":3})).unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let output = search(&client, &input, &format!("http://{address}/mcp"))
            .await
            .unwrap();
        assert!(output.contains("https://docs.python.org/3/library/asyncio.html"));
        assert!(!output.contains("example.org"));
        server.await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires live access to the public Exa MCP search service"]
    async fn live_search_returns_relevant_primary_documentation() {
        let tool = super::super::WebSearchTool::default();
        let input: WebSearchInput =
            serde_json::from_value(json!({"query":"Python asyncio documentation","num_results":3}))
                .unwrap();
        let output = search(&tool.client, &input, ENDPOINT).await.unwrap();
        assert!(
            output.contains("docs.python.org/3/library/asyncio"),
            "{output}"
        );
    }

    #[tokio::test]
    #[ignore = "requires four live queries to the public Exa MCP search service"]
    async fn live_search_user_reported_topics_have_relevant_results() {
        let tool = super::super::WebSearchTool::default();
        for (query, expected) in [
            (
                "Python asyncio tutorial",
                vec!["asyncio", "async io", "async/await"],
            ),
            (
                "Rust latest version release notes",
                vec!["rust-lang.org", "github.com/rust-lang"],
            ),
            ("Tesla stock price TSLA", vec!["stock", "tsla"]),
            (
                "quantum computing explained",
                vec!["quantum computing", "quantum computer"],
            ),
        ] {
            let input: WebSearchInput =
                serde_json::from_value(json!({"query":query,"num_results":5})).unwrap();
            let output = search(&tool.client, &input, ENDPOINT).await.unwrap();
            println!("{output}");
            // Check returned result content, excluding the query heading.
            let content = output
                .lines()
                .skip(2)
                .collect::<Vec<_>>()
                .join("\n")
                .to_lowercase();
            assert!(
                expected.iter().any(|term| content.contains(term)),
                "No relevant result for {query}: {output}"
            );
        }
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
    }
}

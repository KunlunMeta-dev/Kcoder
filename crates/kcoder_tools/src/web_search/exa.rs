use super::{SearchFailure, WebSearchInput, format_results, http::SearchHttp};
use crate::ToolError;
use kcoder_types::web_search::{WebSearchErrorKind, WebSearchPageV1};
use kcoder_web::providers::exa::ENDPOINT;
use serde_json::{Value, json};
use std::time::Instant;

async fn search_page(
    client: &reqwest::Client,
    input: &WebSearchInput,
    endpoint: &str,
) -> Result<WebSearchPageV1, SearchFailure> {
    kcoder_web::providers::exa::search_page(
        &SearchHttp {
            client,
            ctx: None,
            guard: None,
        },
        input,
        endpoint,
    )
    .await
}

#[cfg(test)]
pub(super) async fn search(
    client: &reqwest::Client,
    input: &WebSearchInput,
    endpoint: &str,
) -> Result<String, ToolError> {
    let started = Instant::now();
    let page = search_page(client, input, endpoint)
        .await
        .map_err(|error| ToolError::Execution(error.to_string()))?;
    Ok(format_results(
        &page.results,
        &input.query,
        started.elapsed().as_millis() as u64,
        input.context_max_characters.unwrap_or(10_000),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn accept_fixture_request(
        listener: &tokio::net::TcpListener,
    ) -> (tokio::net::TcpStream, String, Value) {
        use tokio::io::AsyncReadExt;
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let (header, start, length) = loop {
            let mut chunk = [0u8; 4096];
            let count = stream.read(&mut chunk).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&chunk[..count]);
            assert!(bytes.len() < 64 * 1024);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let header = String::from_utf8(bytes[..end].to_vec())
                    .unwrap()
                    .to_ascii_lowercase();
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                break (header, end + 4, length);
            }
        };
        while bytes.len() < start + length {
            let mut chunk = [0u8; 4096];
            let count = stream.read(&mut chunk).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&chunk[..count]);
        }
        let body = if length == 0 {
            Value::Null
        } else {
            serde_json::from_slice(&bytes[start..start + length]).unwrap()
        };
        (stream, header, body)
    }

    async fn fixture_reply(stream: &mut tokio::net::TcpStream, status: u16, body: &str) {
        use tokio::io::AsyncWriteExt;
        let response = format!(
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nMcp-Session-Id: owned-fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
    }

    #[tokio::test]
    async fn transport_preserves_explicit_rate_limit_metadata_on_tool_errors() {
        for advanced in [false, true] {
            for (marker, expected) in [
                (json!(true), WebSearchErrorKind::RateLimited),
                (json!("true"), WebSearchErrorKind::ContractInvalid),
            ] {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
                let name = if advanced {
                    "web_search_advanced_exa"
                } else {
                    "web_search_exa"
                };
                let server = tokio::spawn(async move {
                    for step in 0..5 {
                        let (mut socket, header, body) = accept_fixture_request(&listener).await;
                        let response = match step {
                            0 => json!({"id":1,"result":{"protocolVersion":"2025-03-26"}}),
                            1 => {
                                assert_eq!(body["method"], "notifications/initialized");
                                fixture_reply(&mut socket, 202, "").await;
                                continue;
                            }
                            2 => {
                                json!({"id":2,"result":{"tools":[{"name":name,"inputSchema":{"properties":{"query":{},"numResults":{},"userLocation":{}}}}]}})
                            }
                            3 => {
                                assert_eq!(body["method"], "tools/call");
                                assert_eq!(body["params"]["name"], name);
                                json!({"id":3,"result":{"isError":true,"_meta":{"ai.exa/rateLimited":marker},"content":[{"type":"text","text":"Service limit"}]}})
                            }
                            _ => {
                                assert!(header.starts_with("delete "));
                                fixture_reply(&mut socket, 204, "").await;
                                break;
                            }
                        };
                        fixture_reply(&mut socket, 200, &response.to_string()).await;
                    }
                });
                let client = reqwest::Client::builder().no_proxy().build().unwrap();
                let mut request = json!({"query":"owned error metadata fixture"});
                if advanced {
                    request["region"] = json!("US");
                }
                let input = serde_json::from_value(request).unwrap();
                let error = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    search_page(&client, &input, &endpoint),
                )
                .await
                .unwrap()
                .unwrap_err();
                assert_eq!(error.kind, expected);
                assert!(error.request_sent);
                tokio::time::timeout(std::time::Duration::from_secs(3), server)
                    .await
                    .unwrap()
                    .unwrap();
            }
        }
    }

    #[tokio::test]
    async fn failed_initialization_is_not_recorded_as_a_search_query() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _, body) = accept_fixture_request(&listener).await;
            assert_eq!(body["method"], "initialize");
            // No session was established, so the endpoint has no cleanup lease.
            use tokio::io::AsyncWriteExt;
            socket.write_all(b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let input = serde_json::from_value(json!({"query":"fixture query"})).unwrap();
        let error = search_page(&client, &input, &endpoint).await.unwrap_err();
        assert_eq!(error.kind, WebSearchErrorKind::RateLimited);
        assert!(!error.request_sent);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_closes_the_acquired_search_session() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (ready, waiting) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut first, _, _) = accept_fixture_request(&listener).await;
            fixture_reply(
                &mut first,
                200,
                &json!({"id":1,"result":{"protocolVersion":"2025-03-26"}}).to_string(),
            )
            .await;
            let (mut initialized, header, body) = accept_fixture_request(&listener).await;
            assert!(header.contains("mcp-session-id: owned-fixture"));
            assert_eq!(body["method"], "notifications/initialized");
            fixture_reply(&mut initialized, 202, "").await;
            let (_held, _, body) = accept_fixture_request(&listener).await;
            assert_eq!(body["method"], "tools/list");
            ready.send(()).unwrap();
            let (mut deleted, header, _) = accept_fixture_request(&listener).await;
            assert!(header.starts_with("delete "));
            assert!(header.contains("mcp-session-id: owned-fixture"));
            fixture_reply(&mut deleted, 204, "").await;
        });
        let request = tokio::spawn(async move {
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let input = serde_json::from_value(json!({"query":"中文 asynchronous guide"})).unwrap();
            search(&client, &input, &format!("http://{address}/mcp")).await
        });
        waiting.await.unwrap();
        request.abort();
        let _ = request.await;
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), server).await;
        assert!(
            result.is_ok(),
            "cancelling search leaked its acquired remote session"
        );
        result.unwrap().unwrap();
    }

    #[tokio::test]
    async fn policy_revoked_during_handshake_never_sends_the_search_query() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
        let allowed = Arc::new(AtomicBool::new(true));
        let state = allowed.clone();
        let server = tokio::spawn(async move {
            for step in 0..4 {
                let (mut socket, header, body) = accept_fixture_request(&listener).await;
                assert!(!body.to_string().contains("query-not-for-dispatch"));
                match step {
                    0 => {
                        fixture_reply(
                            &mut socket,
                            200,
                            &json!({"id":1,"result":{"protocolVersion":"2025-03-26"}}).to_string(),
                        )
                        .await
                    }
                    1 => fixture_reply(&mut socket, 202, "").await,
                    2 => {
                        assert_eq!(body["method"], "tools/list");
                        state.store(false, Ordering::SeqCst);
                        fixture_reply(&mut socket,200,&json!({"id":2,"result":{"tools":[{"name":"web_search_exa","inputSchema":{"properties":{"query":{},"numResults":{}}}}]}}).to_string()).await;
                    }
                    _ => {
                        assert!(header.starts_with("delete "));
                        fixture_reply(&mut socket, 204, "").await;
                    }
                }
            }
        });
        let guard = super::super::SearchDispatchGuard::new(move |_| {
            if allowed.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(SearchFailure::new(
                    WebSearchErrorKind::PolicyDenied,
                    "fixture revocation",
                    false,
                ))
            }
        });
        let request = serde_json::from_value(json!({"query":"query-not-for-dispatch"})).unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let error = kcoder_web::providers::exa::search_page(
            &SearchHttp {
                client: &client,
                ctx: None,
                guard: Some(&guard),
            },
            &request,
            &endpoint,
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, WebSearchErrorKind::PolicyDenied);
        assert!(!error.request_sent);
        tokio::time::timeout(std::time::Duration::from_secs(3), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn advanced_region_and_dates_use_one_toolset_and_do_not_enable_extra_synthesis() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "http://{}/mcp?tools=web_search_advanced_exa",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, header, body) = accept_fixture_request(&listener).await;
                assert!(
                    header
                        .lines()
                        .next()
                        .unwrap()
                        .contains("/mcp?tools=web_search_advanced_exa")
                );
                if header.starts_with("delete ") {
                    fixture_reply(&mut socket, 204, "").await;
                    break;
                }
                let result = match body["method"].as_str().unwrap() {
                    "initialize" => json!({"id":1,"result":{"protocolVersion":"2025-03-26"}}),
                    "notifications/initialized" => {
                        fixture_reply(&mut socket, 202, "").await;
                        continue;
                    }
                    "tools/list" => {
                        json!({"id":2,"result":{"tools":[{"name":"web_search_advanced_exa","inputSchema":{"properties":{"query":{},"numResults":{},"type":{},"userLocation":{},"startPublishedDate":{},"endPublishedDate":{},"enableSummary":{},"enableHighlights":{}}}}]}})
                    }
                    "tools/call" => {
                        assert_eq!(body["params"]["name"], "web_search_advanced_exa");
                        let args = &body["params"]["arguments"];
                        assert_eq!(args["type"], "auto");
                        assert_eq!(args["userLocation"], "CN");
                        assert_eq!(args["enableSummary"], false);
                        assert!(args["startPublishedDate"].as_str().unwrap().len() == 10);
                        assert!(args["endPublishedDate"].as_str().unwrap().len() == 10);
                        assert!(args.get("additionalQueries").is_none());
                        let text=json!({"results":[{"title":"Fixture","url":"https://example.com/current","publishedDate":"2026-10-30T12:00:00Z","highlights":["Observed excerpt"]}]}).to_string();
                        json!({"id":3,"result":{"content":[{"type":"text","text":text}]}})
                    }
                    _ => panic!("unexpected RPC"),
                };
                fixture_reply(&mut socket, 200, &result.to_string()).await;
            }
        });
        let input=serde_json::from_value(json!({"query":"fixture public query","region":"CN","time_range":"week","search_type":"deep"})).unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let page = search_page(&client, &input, &endpoint).await.unwrap();
        assert_eq!(page.results[0].url, "https://example.com/current");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn query_round_trips_unicode_spaces_and_urls_and_oversize_is_an_error() {
        for (query, oversized) in [
            ("Python asyncio guide", false),
            ("量子计算 入门", false),
            ("https://example.com/a?term=a+b&name=中文#section", false),
            ("response limit", true),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let expected = query.to_owned();
            let server = tokio::spawn(async move {
                loop {
                    let (mut socket, header, body) = accept_fixture_request(&listener).await;
                    if header.starts_with("delete ") {
                        fixture_reply(&mut socket, 204, "").await;
                        break;
                    }
                    let value = match body["method"].as_str().unwrap() {
                        "initialize" => json!({"id":1,"result":{"protocolVersion":"2025-03-26"}}),
                        "notifications/initialized" => {
                            fixture_reply(&mut socket, 202, "").await;
                            continue;
                        }
                        "tools/list" => {
                            json!({"id":2,"result":{"tools":[{"name":"web_search_exa","inputSchema":{"properties":{"query":{},"numResults":{}}}}]}})
                        }
                        "tools/call" => {
                            assert_eq!(body["params"]["arguments"]["query"], expected);
                            if oversized {
                                json!({"id":3,"result":{"padding":"x".repeat(2 * 1024 * 1024)}})
                            } else {
                                json!({"id":3,"result":{"content":[{"type":"text","text":"Title: Fixture matching request\nURL: https://example.com/%E4%B8%AD?q=a%2Bb&lang=zh\nHighlights:\nSource fixture"}]}})
                            }
                        }
                        _ => panic!("unexpected search RPC"),
                    };
                    fixture_reply(&mut socket, 200, &value.to_string()).await;
                }
            });
            let input = serde_json::from_value(json!({"query":query})).unwrap();
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let output = search(&client, &input, &format!("http://{address}/mcp")).await;
            if oversized {
                assert!(output.unwrap_err().to_string().contains("2 MiB"));
            } else {
                assert!(
                    output
                        .unwrap()
                        .contains("https://example.com/%E4%B8%AD?q=a%2Bb&lang=zh")
                );
            }
            tokio::time::timeout(std::time::Duration::from_secs(5), server)
                .await
                .unwrap()
                .unwrap();
        }
    }

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
                        (200, "application/json", json!({"id":3,"result":{"content":[{"type":"text","text":"Title: Async IO\nURL: https://docs.python.org/3/library/asyncio.html\nHighlights:\nPython asyncio docs\n\n---\n\nTitle: unrelated\nURL: https://example.org/\nHighlights:\nother"}]}}).to_string())
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
        let output = search(&tool.runtime.client, &input, ENDPOINT)
            .await
            .unwrap();
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
            let output = search(&tool.runtime.client, &input, ENDPOINT)
                .await
                .unwrap();
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
}

//! Bing query construction, bounded response reads, and canonical redirects.
use super::{Request, SearchFailure, Transport, bing_redirect};
use crate::search::{
    bing::validate_bing_page,
    constraints,
    request::{WebSearchInput, filter_results},
};
use kcoder_tool_error::ToolError;
use std::time::Duration;

const MAX_BING_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
pub const ENDPOINT: &str = "https://www.bing.com/search";

async fn read_bounded_bing_response_ref(
    response: &mut reqwest::Response,
) -> Result<String, ToolError> {
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

fn retry_delay(attempt: u32) -> Duration {
    Duration::from_millis(500 * 2_u64.pow(attempt.min(4)))
}

fn is_retryable(status: reqwest::StatusCode) -> bool {
    status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS
}

pub async fn search_page(
    transport: &dyn Transport,
    input: &WebSearchInput,
    search_url: &str,
    max_retries: u32,
    allow_fixture_redirects: bool,
) -> Result<kcoder_types::web_search::WebSearchPageV1, SearchFailure> {
    use kcoder_types::web_search::{WebSearchErrorKind, WebSearchPageV1, WebSearchProvider};
    input.constraints.plan(
        WebSearchProvider::Bing,
        constraints::ProviderConstraintCapabilities::default(),
    )?;
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
    .map_err(|_| {
        SearchFailure::new(
            WebSearchErrorKind::InvalidInput,
            "Invalid search URL",
            false,
        )
    })?;

    let mut last_error = SearchFailure::new(
        WebSearchErrorKind::Network,
        "Search service unavailable",
        false,
    );
    let mut request_sent = false;
    for attempt in 0..=max_retries {
        if attempt > 0 {
            tokio::time::sleep(retry_delay(attempt - 1)).await;
        }
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::USER_AGENT,reqwest::header::HeaderValue::from_static("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"));
        headers.insert(
            reqwest::header::ACCEPT,
            reqwest::header::HeaderValue::from_static(
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            ),
        );
        headers.insert(
            reqwest::header::ACCEPT_LANGUAGE,
            reqwest::header::HeaderValue::from_static(language),
        );
        let mut redirects = bing_redirect::Chain::new(url.clone(), allow_fixture_redirects);
        let (failure, retryable) = loop {
            transport
                .check(WebSearchProvider::Bing)
                .map_err(|mut error| {
                    error.request_sent |= request_sent;
                    error
                })?;
            let request_result = transport
                .send(
                    WebSearchProvider::Bing,
                    Request {
                        method: reqwest::Method::GET,
                        url: redirects.current().clone(),
                        headers: headers.clone(),
                        body: None,
                    },
                )
                .await;

            let response = match request_result {
                Ok(resp) => resp,
                Err(mut error) => {
                    request_sent |= error.request_sent;
                    error.request_sent = request_sent;
                    let retryable = matches!(
                        error.kind,
                        WebSearchErrorKind::Network | WebSearchErrorKind::Timeout
                    );
                    break (error, retryable);
                }
            };

            request_sent = true;
            let mut response = response;
            let response = response.response();
            let status = response.status();
            if status.is_success() {
                let html = read_bounded_bing_response_ref(response)
                    .await
                    .map_err(SearchFailure::contract)?;
                let raw_results = validate_bing_page(&html).map_err(SearchFailure::contract)?;
                let filtered = filter_results(raw_results, input);
                let num = input.num_results.unwrap_or(8).min(filtered.len());
                let selected: Vec<_> = filtered.into_iter().take(num).collect();
                return Ok(WebSearchPageV1 {
                    results: selected,
                    ..Default::default()
                });
            }

            if status.is_redirection() && matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
                redirects.follow(response.headers().get(reqwest::header::LOCATION))?;
                continue;
            }
            break (crate::providers::http_failure(status), is_retryable(status));
        };
        last_error = failure;
        if !retryable {
            break;
        }
    }

    Err(last_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bing_bounded_reader_rejects_declared_and_streamed_oversize() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for declared in [true, false] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 2048];
                assert!(socket.read(&mut request).await.unwrap() > 0);
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
            let mut response = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap()
                .get(format!("http://{address}"))
                .send()
                .await
                .unwrap();
            assert!(
                read_bounded_bing_response_ref(&mut response)
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("4 MiB")
            );
            server.await.unwrap();
        }
    }
}

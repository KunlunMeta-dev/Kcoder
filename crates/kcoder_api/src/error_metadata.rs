use std::time::Duration;

/// Non-HTTP recovery facts derived from typed transport errors and protocol types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NonHttpErrorClass {
    Transient,
    RateLimited,
    StreamIdleTimeout,
    TransportTimeout,
    Permanent,
}

/// SSE failure category without retaining potentially sensitive source diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SseErrorKind {
    Transport(NonHttpErrorClass),
    Parser,
    Utf8,
}

impl From<eventsource_stream::EventStreamError<reqwest::Error>> for SseErrorKind {
    fn from(error: eventsource_stream::EventStreamError<reqwest::Error>) -> Self {
        match error {
            eventsource_stream::EventStreamError::Transport(error) => {
                Self::Transport(network_error_class(&error))
            }
            eventsource_stream::EventStreamError::Parser(_) => Self::Parser,
            eventsource_stream::EventStreamError::Utf8(_) => Self::Utf8,
        }
    }
}

impl crate::ApiErrorKind {
    /// HTTP recovery is classified separately using response metadata.
    pub fn non_http_error_class(&self) -> Option<NonHttpErrorClass> {
        use NonHttpErrorClass::*;
        Some(match self {
            Self::Http { .. } => return None,
            Self::Api { error_type, .. } => match error_type.as_str() {
                "overloaded_error" | "stream_incomplete" => Transient,
                "rate_limit_error" => RateLimited,
                "stream_idle_timeout" => StreamIdleTimeout,
                _ => Permanent,
            },
            Self::Network(error) => network_error_class(error),
            Self::SseStream { kind, .. } => match kind {
                SseErrorKind::Transport(class) => *class,
                SseErrorKind::Parser | SseErrorKind::Utf8 => Permanent,
            },
            Self::EventSource(error) => match error.as_ref() {
                reqwest_eventsource::Error::Transport(error) => network_error_class(error),
                reqwest_eventsource::Error::StreamEnded => Transient,
                _ => Permanent,
            },
            Self::CannotCloneRequest(_) | Self::JsonParse(_, _) | Self::InvalidHeader(_) => {
                Permanent
            }
        })
    }
}

fn network_error_class(error: &reqwest::Error) -> NonHttpErrorClass {
    use NonHttpErrorClass::*;
    if error.is_builder() || error.is_decode() {
        Permanent
    } else if error.is_timeout() {
        TransportTimeout
    } else if error.is_connect() || error.is_body() {
        Transient
    } else {
        Permanent
    }
}

/// Allowlisted machine parameter names; never retain arbitrary provider input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectedReasoningParameter {
    Thinking,
    ReasoningEffort,
    Reasoning,
    ReasoningDotEffort,
}

/// Structured HTTP response facts, independent of diagnostic message text.
#[derive(Clone, PartialEq, Eq)]
pub struct HttpErrorMetadata {
    pub status: u16,
    pub provider_code: Option<String>,
    pub provider_type: Option<String>,
    pub rejected_reasoning_parameter: Option<RejectedReasoningParameter>,
    pub retry_after: Option<Duration>,
}

impl std::fmt::Debug for HttpErrorMetadata {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpErrorMetadata")
            .field("status", &self.status)
            .field(
                "provider_code",
                &self
                    .provider_code
                    .as_deref()
                    .map(kcoder_types::safe_provider_error_type),
            )
            .field(
                "provider_type",
                &self
                    .provider_type
                    .as_deref()
                    .map(kcoder_types::safe_provider_error_type),
            )
            .field(
                "rejected_reasoning_parameter",
                &self.rejected_reasoning_parameter,
            )
            .field("retry_after", &self.retry_after)
            .finish()
    }
}

impl HttpErrorMetadata {
    pub(crate) fn from_response(status: u16, body: &str, retry_after: Option<&str>) -> Self {
        // SDK-owned errors can arrive already buffered. Do not parse or clone
        // oversized diagnostic payloads into KCoder metadata.
        let json = (body.len() <= 64 * 1024).then(|| serde_json::from_str::<serde_json::Value>(body).ok()).flatten();
        let error = json
            .as_ref()
            .map(|value| value.get("error").unwrap_or(value));
        let scalar = |value: &serde_json::Value| match value {
            serde_json::Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
            serde_json::Value::Number(number) => Some(number.to_string()),
            serde_json::Value::Bool(boolean) => Some(boolean.to_string()),
            _ => None,
        };
        let field = |name| {
            error
                .and_then(|value| value.get(name))
                .and_then(scalar)
                .or_else(|| {
                    json.as_ref()
                        .and_then(|value| value.get(name))
                        .and_then(scalar)
                })
        };
        Self {
            status,
            provider_code: field("code"),
            provider_type: field("type"),
            rejected_reasoning_parameter: match error
                .and_then(|value| value.get("param"))
                .or_else(|| json.as_ref().and_then(|value| value.get("param")))
                .and_then(serde_json::Value::as_str)
            {
                Some("thinking") => Some(RejectedReasoningParameter::Thinking),
                Some("reasoning_effort") => Some(RejectedReasoningParameter::ReasoningEffort),
                Some("reasoning") => Some(RejectedReasoningParameter::Reasoning),
                Some("reasoning.effort") => Some(RejectedReasoningParameter::ReasoningDotEffort),
                _ => None,
            },
            retry_after: retry_after.and_then(parse_retry_after),
        }
    }
}

fn parse_retry_after(value: &str) -> Option<Duration> {
    let value = value.trim();
    let seconds = value.parse::<f64>().ok().or_else(|| {
        chrono::DateTime::parse_from_rfc2822(value)
            .ok()
            .map(|date| {
                (date.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_milliseconds() as f64
                    / 1000.0
            })
    })?;
    let duration = Duration::try_from_secs_f64(seconds).ok()?;
    (!duration.is_zero() && duration < Duration::from_secs(3600)).then_some(duration)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AnthropicProvider, GeminiProvider, OpenAiProvider, Provider};
    use futures::StreamExt;

    async fn serve_response(response: Vec<u8>) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(3), async {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut chunk = [0; 4096];
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&chunk[..count]);
                    assert!(request.len() <= 64 * 1024);
                    if let Some(index) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        let headers = std::str::from_utf8(&request[..index]).unwrap();
                        let length = headers
                            .lines()
                            .filter_map(|line| line.split_once(':'))
                            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                            .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                            .unwrap_or(0);
                        assert!(length <= 64 * 1024);
                        if request.len() >= index + 4 + length {
                            break;
                        }
                    }
                }
                socket.write_all(&response).await.unwrap();
            })
            .await
            .expect("bounded local HTTP fixture");
        });
        (url, task)
    }

    #[tokio::test]
    async fn provider_error_precision_distinguishes_builder_and_decode_summary() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let builder = client
            .get("not a URL SENTINEL_PRIVATE")
            .build()
            .unwrap_err();
        let builder = crate::ApiErrorKind::Network(builder);
        assert!(
            builder
                .safe_summary()
                .as_str()
                .contains("request_build_error")
        );
        assert!(!builder.to_string().contains("network_error"));
        assert!(!builder.to_string().contains("SENTINEL_PRIVATE"));
        let body = "SENTINEL_PRIVATE";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let (url, server) = serve_response(response.into_bytes()).await;
        let decode = client
            .get(url)
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap_err();
        server.await.unwrap();
        assert!(decode.is_decode());
        let decode = crate::ApiErrorKind::Network(decode);
        assert!(
            decode
                .safe_summary()
                .as_str()
                .contains("response_parse_error")
        );
        assert!(!decode.to_string().contains("network_error"));
        assert!(!decode.to_string().contains("SENTINEL_PRIVATE"));
    }

    #[tokio::test]
    async fn typed_network_errors_distinguish_transport_from_builder_and_decode() {
        use crate::ApiErrorKind;
        use NonHttpErrorClass::*;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let builder = client.get("not a URL network 429").build().unwrap_err();
        assert!(builder.is_builder());
        assert_eq!(
            ApiErrorKind::Network(builder).non_http_error_class(),
            Some(Permanent)
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let connect = client
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap_err();
        assert!(connect.is_connect());
        assert_eq!(
            ApiErrorKind::Network(connect).non_http_error_class(),
            Some(Transient)
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let timeout = client
            .get(format!("http://{}", listener.local_addr().unwrap()))
            .timeout(Duration::from_millis(20))
            .send()
            .await
            .unwrap_err();
        assert!(timeout.is_timeout());
        assert_eq!(
            ApiErrorKind::Network(timeout).non_http_error_class(),
            Some(TransportTimeout)
        );

        let (url, server) = serve_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\ninvalid".to_vec(),
        )
        .await;
        let decode = client
            .get(url)
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap_err();
        server.await.unwrap();
        assert!(decode.is_decode());
        assert_eq!(
            ApiErrorKind::Network(decode).non_http_error_class(),
            Some(Permanent)
        );

        let (url, server) = serve_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nshort".to_vec(),
        )
        .await;
        let body = client
            .get(url)
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap_err();
        server.await.unwrap();
        // Reqwest classifies a truncated response body as Decode, not Body.
        assert!(body.is_decode());
        assert_eq!(
            ApiErrorKind::Network(body).non_http_error_class(),
            Some(Permanent)
        );
    }

    #[tokio::test]
    async fn eventsource_variants_do_not_classify_diagnostic_text() {
        use crate::ApiErrorKind;
        use NonHttpErrorClass::*;
        let invalid_utf8 = String::from_utf8(vec![0xff]).unwrap_err();
        for error in [
            reqwest_eventsource::Error::Utf8(invalid_utf8),
            reqwest_eventsource::Error::InvalidLastEventId("network 429 timeout".into()),
        ] {
            assert_eq!(
                ApiErrorKind::from(error).non_http_error_class(),
                Some(Permanent)
            );
        }
        assert_eq!(
            ApiErrorKind::from(reqwest_eventsource::Error::StreamEnded).non_http_error_class(),
            Some(Transient)
        );
        let (url, server) = serve_response(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n".to_vec()).await;
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(url)
            .send()
            .await
            .unwrap();
        server.await.unwrap();
        let error = reqwest_eventsource::Error::InvalidContentType(
            response.headers()["content-type"].clone(),
            response,
        );
        assert_eq!(
            ApiErrorKind::from(error).non_http_error_class(),
            Some(Permanent)
        );
        for kind in [SseErrorKind::Parser, SseErrorKind::Utf8] {
            let error = ApiErrorKind::SseStream {
                error_type: "sse_stream".into(),
                message: "network 429 timeout".into(),
                kind,
            };
            assert_eq!(error.non_http_error_class(), Some(Permanent));
        }
    }

    #[tokio::test]
    async fn provider_sse_paths_preserve_utf8_and_transport_facts() {
        use crate::ApiErrorKind;
        for path in ["anthropic", "chat", "responses", "gemini"] {
            for (body, declared_length, expected) in [
                (vec![0xff], 1, SseErrorKind::Utf8),
                (
                    b"data: ".to_vec(),
                    100,
                    SseErrorKind::Transport(NonHttpErrorClass::Permanent),
                ),
            ] {
                let mut response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {declared_length}\r\nConnection: close\r\n\r\n").into_bytes();
                response.extend(body);
                let (base, server) = serve_response(response).await;
                let provider: Box<dyn Provider> = match path {
                    "anthropic" => Box::new(
                        AnthropicProvider::new("test")
                            .unwrap()
                            .with_base_url(base)
                            .with_no_proxy(true)
                            .unwrap(),
                    ),
                    "gemini" => Box::new(
                        GeminiProvider::new("test", "test")
                            .unwrap()
                            .with_base_url(base)
                            .with_no_proxy(true)
                            .unwrap(),
                    ),
                    _ => {
                        let provider = OpenAiProvider::new("test", "test")
                            .unwrap()
                            .with_base_url(base)
                            .with_no_proxy(true)
                            .unwrap();
                        Box::new(if path == "responses" {
                            provider.with_api_format(kcoder_config::ApiFormat::OpenaiResponses)
                        } else {
                            provider
                        })
                    }
                };
                let error = tokio::time::timeout(Duration::from_secs(5), async {
                    provider
                        .stream_messages(kcoder_types::MessagesRequest::new(
                            "test",
                            vec![kcoder_types::Message::user_text("hi")],
                        ))
                        .unwrap()
                        .next()
                        .await
                        .unwrap()
                        .unwrap_err()
                })
                .await
                .unwrap();
                server.await.unwrap();
                let ApiErrorKind::SseStream { kind, .. } = error else {
                    panic!("{path}: lost SSE facts: {error:?}");
                };
                assert_eq!(kind, expected, "{path}");
            }
        }
    }

    #[test]
    fn rejected_reasoning_parameter_is_exact_and_never_retains_unknown_input() {
        for (param, expected) in [
            ("thinking", Some(RejectedReasoningParameter::Thinking)),
            (
                "reasoning_effort",
                Some(RejectedReasoningParameter::ReasoningEffort),
            ),
            ("reasoning", Some(RejectedReasoningParameter::Reasoning)),
            (
                "reasoning.effort",
                Some(RejectedReasoningParameter::ReasoningDotEffort),
            ),
            (" thinking", None),
            ("Thinking", None),
            ("private-secret-param", None),
        ] {
            let body = serde_json::json!({"error": {"param": param}}).to_string();
            let metadata = HttpErrorMetadata::from_response(400, &body, None);
            assert_eq!(metadata.rejected_reasoning_parameter, expected);
            assert!(!format!("{metadata:?}").contains("private-secret-param"));
        }
    }

    #[test]
    fn http_retry_after_is_bounded() {
        for value in ["0", "-1", "3600", "NaN", "inf", "junk", "1e-99", "1e99"] {
            assert_eq!(parse_retry_after(value), None, "{value}");
        }
        assert_eq!(parse_retry_after("2.5"), Some(Duration::from_millis(2500)));
        let future = (chrono::Utc::now() + chrono::Duration::seconds(30)).to_rfc2822();
        assert!(parse_retry_after(&future).is_some_and(|duration| duration.as_secs() <= 30));
    }

    #[test]
    fn http_metadata_display_is_safe_and_includes_status() {
        let fallback = HttpErrorMetadata::from_response(
            401,
            r#"{"code":42,"type":"auth","error":{"message":"denied"}}"#,
            None,
        );
        assert_eq!(fallback.provider_code.as_deref(), Some("42"));
        assert_eq!(fallback.provider_type.as_deref(), Some("auth"));
        let metadata = HttpErrorMetadata::from_response(503, "non-JSON response", Some("invalid"));
        assert_eq!(metadata.provider_type, None);
        assert_eq!(metadata.provider_code, None);
        assert_eq!(metadata.retry_after, None);
        let typed = crate::ApiErrorKind::Http {
            error_type: "503 Service Unavailable".into(),
            message: "existing diagnostic".into(),
            metadata,
        };
        let legacy = crate::ApiErrorKind::Api {
            error_type: "503 Service Unavailable".into(),
            message: "existing diagnostic".into(),
        };
        assert!(typed.to_string().contains("503"));
        assert!(!typed.to_string().contains("existing diagnostic"));
        assert!(!legacy.to_string().contains("existing diagnostic"));
    }

    #[tokio::test]
    async fn http_provider_paths_preserve_status_headers_and_codes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for path in ["anthropic", "chat", "responses", "gemini"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                tokio::time::timeout(Duration::from_secs(3), async {
                    const MAX_REQUEST_BYTES: usize = 64 * 1024;
                    let mut request = Vec::new();
                    let mut expected_len = None;
                    loop {
                        if expected_len.is_some_and(|length| request.len() >= length) {
                            break;
                        }
                        assert!(
                            request.len() < MAX_REQUEST_BYTES,
                            "fixture request too large"
                        );
                        let mut chunk = [0; 4096];
                        let capacity = chunk.len().min(MAX_REQUEST_BYTES - request.len());
                        let read = socket.read(&mut chunk[..capacity]).await.unwrap();
                        assert!(read > 0, "fixture request ended before its declared body");
                        request.extend_from_slice(&chunk[..read]);
                        if expected_len.is_none()
                            && let Some(index) =
                                request.windows(4).position(|bytes| bytes == b"\r\n\r\n")
                        {
                            let header_end = index + 4;
                            let headers = std::str::from_utf8(&request[..index]).unwrap();
                            let body_len = headers
                                .lines()
                                .filter_map(|line| line.split_once(':'))
                                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                                .expect("fixture expects a Content-Length request")
                                .1
                                .trim()
                                .parse::<usize>()
                                .unwrap();
                            let total = header_end
                                .checked_add(body_len)
                                .expect("request length overflow");
                            assert!(total <= MAX_REQUEST_BYTES, "fixture request too large");
                            expected_len = Some(total);
                        }
                    }
                })
                .await
                .expect("fixture timed out reading the complete request");
                let body = r#"{"error":{"type":"authentication_error","code":"bad_key","message":"SENTINEL_PRIVATE Bearer multiple words https://host/?token=secret network 429 retry_after=99","param":"SENTINEL_PRIVATE"}}"#;
                let response = format!(
                    "HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\nRetry-After: 2\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            });
            let base = format!("http://{address}");
            let provider: Box<dyn Provider> = if path == "anthropic" {
                Box::new(
                    AnthropicProvider::new("test")
                        .unwrap()
                        .with_base_url(base)
                        .with_no_proxy(true)
                        .unwrap(),
                )
            } else if path == "gemini" {
                Box::new(
                    GeminiProvider::new("test", "test")
                        .unwrap()
                        .with_base_url(base)
                        .with_no_proxy(true)
                        .unwrap(),
                )
            } else {
                let provider = OpenAiProvider::new("test", "test")
                    .unwrap()
                    .with_base_url(base)
                    .with_no_proxy(true)
                    .unwrap();
                Box::new(if path == "responses" {
                    provider.with_api_format(kcoder_config::ApiFormat::OpenaiResponses)
                } else {
                    provider
                })
            };
            let request = kcoder_types::MessagesRequest::new(
                "test",
                vec![kcoder_types::Message::user_text("hi")],
            );
            let result = tokio::time::timeout(Duration::from_secs(5), async {
                provider
                    .stream_messages(request)
                    .unwrap()
                    .next()
                    .await
                    .unwrap()
                    .unwrap_err()
            })
            .await
            .unwrap();
            server.await.unwrap();
            assert!(!format!("{result} {result:?}").contains("SENTINEL_PRIVATE"));
            assert!(result.to_string().len() <= 512);
            let crate::ApiErrorKind::Http { metadata, .. } = result else {
                panic!("{path}: lost HTTP metadata: {result:?}");
            };
            assert_eq!(metadata.status, 401, "{path}");
            assert_eq!(metadata.provider_code.as_deref(), Some("bad_key"));
            assert_eq!(
                metadata.provider_type.as_deref(),
                Some("authentication_error")
            );
            assert_eq!(metadata.retry_after, Some(Duration::from_secs(2)));
        }
    }
}

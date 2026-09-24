use crate::ApiErrorKind;
use crate::providers::debug_log::LlmDebugRecorder;
use crate::providers::{
    ModelDiscoveryOptions, Provider, ProviderModelDiscovery, ProviderStream,
    SLIME_AGENT_DEPTH_HEADER, model_list_url, parse_anthropic_event_observed,
    parse_model_list_response,
};
use eventsource_stream::Eventsource as _;
use futures::StreamExt;
use kcoder_config::{DEFAULT_ANTHROPIC_ENDPOINT, DEFAULT_REQUEST_TIMEOUT_SECS};
use kcoder_types::{ContentBlock, Message, MessagesRequest, ReasoningEffort};
use reqwest::header::{self, HeaderMap, HeaderValue};
use serde::Deserialize;
use serde_json::{Map, Value};
use tracing::{debug, error, trace, warn};

const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Clone)]
pub struct AnthropicProvider {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
    provider_name: &'static str,
    extra_body: Map<String, Value>,
    timeout_secs: u64,
    no_proxy: bool,
    proxy_url: Option<String>,
}

impl AnthropicProvider {
    pub fn new(api_key: impl Into<String>) -> Result<Self, ApiErrorKind> {
        Ok(Self {
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(DEFAULT_REQUEST_TIMEOUT_SECS))
                .http1_only()
                .no_gzip()
                .build()?,
            api_key: api_key.into(),
            base_url: DEFAULT_ANTHROPIC_ENDPOINT.to_string(),
            provider_name: "anthropic",
            extra_body: Map::new(),
            timeout_secs: 300,
            no_proxy: false,
            proxy_url: None,
        })
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub fn with_provider_name(mut self, provider_name: &'static str) -> Self {
        self.provider_name = provider_name;
        self
    }

    pub fn with_timeout_secs(mut self, timeout_secs: u64) -> Result<Self, ApiErrorKind> {
        self.timeout_secs = timeout_secs.max(1);
        self.rebuild_client()?;
        Ok(self)
    }

    pub fn with_no_proxy(mut self, no_proxy: bool) -> Result<Self, ApiErrorKind> {
        self.no_proxy = no_proxy;
        self.rebuild_client()?;
        Ok(self)
    }

    pub fn with_proxy_url(mut self, proxy_url: Option<String>) -> Result<Self, ApiErrorKind> {
        self.proxy_url = proxy_url.filter(|value| !value.trim().is_empty());
        self.rebuild_client()?;
        Ok(self)
    }

    fn rebuild_client(&mut self) -> Result<(), ApiErrorKind> {
        let mut builder = reqwest::Client::builder()
            // A reqwest request timeout covers the complete streaming body and
            // can truncate an otherwise healthy long-running model response.
            // Limit connection establishment only; the engine owns the
            // per-event stream idle watchdog.
            .connect_timeout(std::time::Duration::from_secs(self.timeout_secs))
            .http1_only()
            .no_gzip();
        if let Some(proxy_url) = self.proxy_url.as_deref() {
            builder = builder.proxy(reqwest::Proxy::all(proxy_url)?);
        } else if self.no_proxy {
            builder = builder.no_proxy();
        }
        self.client = builder.build()?;
        Ok(())
    }

    pub fn with_extra_body(mut self, extra_body: Map<String, Value>) -> Self {
        self.extra_body = extra_body;
        self
    }

    fn messages_url(&self) -> String {
        format!("{}/v1/messages", self.base_url.trim_end_matches('/'))
    }

    fn headers(&self) -> Result<HeaderMap, ApiErrorKind> {
        let mut headers = HeaderMap::new();
        headers.insert("x-api-key", HeaderValue::from_str(&self.api_key)?);
        headers.insert(
            "anthropic-version",
            HeaderValue::from_static(ANTHROPIC_VERSION),
        );
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        headers.insert(
            header::USER_AGENT,
            HeaderValue::from_static("kcoder-rust/0.1.0"),
        );
        Ok(headers)
    }

    /// Put training provenance in a transport header so it cannot contaminate model context or request bodies.
    fn headers_for_request(&self, request: &MessagesRequest) -> Result<HeaderMap, ApiErrorKind> {
        let mut headers = self.headers()?;
        if let Some(depth) = request.trajectory_agent_depth {
            headers.insert(
                SLIME_AGENT_DEPTH_HEADER,
                HeaderValue::from_str(&depth.to_string())?,
            );
        }
        Ok(headers)
    }
}

impl Provider for AnthropicProvider {
    fn supports_reasoning_suppression(&self, parameter: crate::RejectedReasoningParameter) -> bool {
        parameter == crate::RejectedReasoningParameter::Thinking
    }

    fn name(&self) -> &'static str {
        self.provider_name
    }

    fn endpoint(&self) -> Option<&str> {
        Some(&self.base_url)
    }

    fn api_key_configured(&self) -> Option<bool> {
        Some(!self.api_key.trim().is_empty())
    }

    fn request_timeout_secs(&self) -> Option<u64> {
        Some(self.timeout_secs)
    }

    fn prewarm(&self) -> crate::providers::ProviderPrewarm {
        let client = self.client.clone();
        let url = self.messages_url();
        let headers = self.headers().ok();
        Box::pin(async move {
            let Some(headers) = headers else { return };
            let _ = client.head(url).headers(headers).send().await;
        })
    }

    fn discover_models(&self, options: ModelDiscoveryOptions) -> ProviderModelDiscovery {
        let client = self.client.clone();
        let url = model_list_url(&self.base_url);
        let headers = self.headers();
        Box::pin(async move {
            let headers = headers?;
            let response = client
                .get(url)
                .headers(headers)
                .timeout(options.timeout)
                .send()
                .await?;
            parse_model_list_response(response, options.max_models).await
        })
    }

    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        let prepared_at = std::time::Instant::now();
        let url = self.messages_url();
        let debug_session_id = request.debug_session_id.clone();
        let headers = self.headers_for_request(&request)?;
        let body = anthropic_request_body_with_options(
            &request,
            self.extra_body.clone(),
            self.provider_name == "kunlunmeta",
        )?;
        let prepared = prepared_at.elapsed();
        let request_body_bytes = body.len();
        let request_summary = anthropic_request_summary(&request, body.len());
        debug!("POST {} with {}", url, request_summary);

        let client = self.client.clone();
        let mut debug_recorder =
            LlmDebugRecorder::new("anthropic", debug_session_id.as_deref(), &url, &body);
        let stream = async_stream::stream! {
            use super::transport_metrics::{Outcome, Protocol, TransportMetrics};
            let mut metrics = TransportMetrics::new(Protocol::Anthropic, prepared, request_body_bytes);
            let mut saw_error = false;
            let response = match client.post(&url).headers(headers).body(body).send().await {
                Ok(r) => r,
                Err(e) => {
                    metrics.outcome(Outcome::NetworkError);
                    debug_recorder.record_error(e.to_string());
                    debug_recorder.finish();
                    yield Err(ApiErrorKind::Network(e));
                    return;
                }
            };

            let status = response.status();
            metrics.status(status.as_u16());
            debug_recorder.record_status(status.as_u16());
            debug_recorder.record_headers(response.headers());
            debug!("Anthropic response status: {}", status);
            if !status.is_success() {
                metrics.outcome(Outcome::HttpError);
                let header_request_id = anthropic_header_request_id(response.headers());
                let retry_after = super::retry_after_hint(response.headers());
                let text = super::bounded_body::read(response, super::bounded_body::ERROR_BODY_LIMIT).await.unwrap_or_default();
                debug_recorder.record_body(&text);
                let error_details = parse_anthropic_error_details(&text);
                let request_id = header_request_id
                    .or_else(|| error_details.request_id.clone())
                    .unwrap_or_else(|| "unknown".to_string());
                let response_preview = kcoder_types::provider_error_summary("unknown_error", Some(status.as_u16()));
                if status.is_server_error() || status.as_u16() == 429 {
                    warn!(
                        "Anthropic API transient error: {}", response_preview
                    );
                } else {
                    error!(
                        "Anthropic API error: {}", response_preview
                    );
                }
                debug_recorder.record_error(format!("http status {}", status.as_u16()));
                debug_recorder.finish();
                yield Err(ApiErrorKind::Http {
                    metadata: crate::HttpErrorMetadata::from_response(status.as_u16(), &text, retry_after.as_deref()),
                    error_type: status.to_string(),
                    message: {
                        let mut message =
                            format_anthropic_api_error_message(&request_id, &error_details, &text);
                        if let Some(after) = retry_after {
                            message.push_str(&format!("; retry_after={after}"));
                        }
                        message
                    },
                });
                return;
            }

            let mut es = response.bytes_stream().eventsource();
            while let Some(event) = es.next().await {
                match event {
                    Ok(msg) => {
                        metrics.sse();
                        let event = parse_anthropic_event_observed(&msg.event, &msg.data, |payload| metrics.anthropic_usage(payload));
                        if matches!(&event, Err(_) | Ok(kcoder_types::StreamEvent::Error { .. })) {
                            saw_error = true;
                            metrics.outcome(Outcome::ResponseError);
                            debug_recorder.record_failed_sse_event();
                            debug!("Anthropic SSE error; response details withheld");
                        } else {
                            debug_recorder.record_sse_event(&msg.event, &msg.data);
                        }
                        let terminal = matches!(
                            &event,
                            Ok(kcoder_types::StreamEvent::MessageStop)
                        );
                        if let Ok(event) = &event { metrics.event(event); }
                        if terminal && !saw_error { metrics.outcome(Outcome::UpstreamCompleted); }
                        yield event;
                        if terminal {
                            debug_recorder.finish();
                            return;
                        }
                    }
                    Err(e) => {
                        metrics.outcome(Outcome::StreamError);
                        debug_recorder.record_error(e.to_string());
                        debug_recorder.finish();
                        trace!("Anthropic SSE stream error; response details withheld");
                        yield Err(ApiErrorKind::SseStream {
                            error_type: "sse_stream_error".to_string(),
                            message: e.to_string(),
                            kind: e.into(),
                        });
                        return;
                    }
                }
            }
            if !saw_error {
                metrics.outcome(Outcome::Incomplete);
                debug_recorder.record_error("stream closed before message_stop".to_string());
                yield Err(ApiErrorKind::Api {
                    error_type: "stream_incomplete".to_string(),
                    message: "Anthropic SSE stream closed before message_stop".to_string(),
                });
            }
            debug_recorder.finish();
        };

        Ok(Box::pin(stream))
    }
}

#[cfg(test)]
fn anthropic_request_body(request: &MessagesRequest) -> Result<String, ApiErrorKind> {
    anthropic_request_body_with_options(request, Map::new(), false)
}

fn anthropic_request_body_with_options(
    request: &MessagesRequest,
    extra_body: Map<String, Value>,
    minimax_streaming_tool_choice: bool,
) -> Result<String, ApiErrorKind> {
    let path_first_tools = request.path_first_tools;
    let mut payload = serde_json::to_value(request)
        .map_err(|e| ApiErrorKind::JsonParse(e, "<request serialization>".to_string()))?;

    // Provenance belongs to persisted KCoder history, not the vendor wire format.
    if let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            if let Some(object) = message.as_object_mut() {
                object.remove("origin");
            }
        }
    }

    add_anthropic_prompt_cache_breakpoints(&mut payload);

    if let Some(budget_tokens) =
        anthropic_thinking_budget(request.reasoning_effort.as_ref(), request.max_tokens)
    {
        payload["thinking"] = serde_json::json!({
            "type": "enabled",
            "budget_tokens": budget_tokens,
        });
    }

    if let Value::Object(payload) = &mut payload {
        payload.extend(extra_body);
        if request.recovery_disable_reasoning {
            payload.remove("thinking");
        }
        if minimax_streaming_tool_choice
            && !request.tools.is_empty()
            && !payload.contains_key("tool_choice")
        {
            // MiniMax-M3's Anthropic endpoint buffers autonomous tool input
            // into one or two large deltas when tool_choice is omitted. An
            // explicit auto choice preserves model autonomy while enabling
            // fine-grained input_json_delta streaming.
            payload.insert(
                "tool_choice".to_string(),
                serde_json::json!({ "type": "auto" }),
            );
        }
    }

    super::path_first::serialize(
        &payload,
        path_first_tools,
        super::path_first::Format::Anthropic,
    )
    .map_err(|e| ApiErrorKind::JsonParse(e, "<request serialization>".to_string()))
}

fn add_anthropic_prompt_cache_breakpoints(payload: &mut serde_json::Value) {
    if let Some(system) = payload
        .get("system")
        .and_then(serde_json::Value::as_str)
        .filter(|system| !system.is_empty())
        .map(str::to_string)
    {
        payload["system"] = serde_json::json!([{
            "type": "text",
            "text": system,
            "cache_control": { "type": "ephemeral" }
        }]);
    }

    let Some(last_content_block) = payload
        .get_mut("messages")
        .and_then(serde_json::Value::as_array_mut)
        .and_then(|messages| messages.last_mut())
        .and_then(|message| message.get_mut("content"))
        .and_then(serde_json::Value::as_array_mut)
        .and_then(|content| content.last_mut())
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    if matches!(
        last_content_block
            .get("type")
            .and_then(serde_json::Value::as_str),
        Some("thinking" | "redacted_thinking")
    ) {
        return;
    }
    last_content_block.insert(
        "cache_control".to_string(),
        serde_json::json!({ "type": "ephemeral" }),
    );
}

fn anthropic_thinking_budget(effort: Option<&ReasoningEffort>, max_tokens: u32) -> Option<u32> {
    let effort = effort?;
    if matches!(effort, ReasoningEffort::None) {
        return None;
    }

    // Anthropic-style extended thinking uses a numeric token budget that counts
    // against max_tokens and must leave room for the final answer.
    const MIN_BUDGET: u32 = 1024;
    let max_budget = max_tokens.saturating_sub(1);
    if max_budget < MIN_BUDGET {
        warn!(
            max_tokens,
            "skipping Anthropic thinking because max_tokens is too small"
        );
        return None;
    }

    let desired = match effort {
        ReasoningEffort::None => return None,
        ReasoningEffort::Minimal | ReasoningEffort::Low => 1024,
        ReasoningEffort::Medium => 2048,
        ReasoningEffort::High => 3072,
        ReasoningEffort::XHigh => 4096,
        ReasoningEffort::Custom(value) => value.trim().parse::<u32>().unwrap_or(3072),
    };
    Some(desired.clamp(MIN_BUDGET, max_budget))
}

#[derive(Debug, Default, PartialEq, Eq)]
struct AnthropicErrorDetails {
    request_id: Option<String>,
    error_type: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnthropicErrorResponse {
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    error: Option<AnthropicErrorPayload>,
}

#[derive(Debug, Deserialize)]
struct AnthropicErrorPayload {
    #[serde(default, rename = "type")]
    error_type: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

fn anthropic_header_request_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get("request-id")
        .or_else(|| headers.get("x-request-id"))
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

fn parse_anthropic_error_details(text: &str) -> AnthropicErrorDetails {
    let Ok(response) = serde_json::from_str::<AnthropicErrorResponse>(text) else {
        return AnthropicErrorDetails::default();
    };
    let Some(error) = response.error else {
        return AnthropicErrorDetails {
            request_id: response.request_id,
            ..AnthropicErrorDetails::default()
        };
    };
    AnthropicErrorDetails {
        request_id: response.request_id,
        error_type: error.error_type,
        message: error.message,
    }
}

fn format_anthropic_api_error_message(
    request_id: &str,
    details: &AnthropicErrorDetails,
    text: &str,
) -> String {
    let mut parts = vec![format!("request_id={request_id}")];
    if let Some(error_type) = details.error_type.as_deref() {
        parts.push(format!("anthropic_error_type={error_type}"));
    }
    if let Some(message) = details.message.as_deref() {
        parts.push(format!("anthropic_message={message}"));
    }
    parts.push(format!("response={}", truncate_for_log(text, 8192)));
    parts.join("; ")
}

fn anthropic_request_summary(request: &MessagesRequest, body_bytes: usize) -> String {
    let system_chars = request
        .system
        .as_ref()
        .map(|system| system.chars().count())
        .unwrap_or(0);
    let message_shapes = summarize_message_shapes(&request.messages);
    format!(
        "model={}, max_tokens={}, messages={}, tools={}, system_chars={}, body_bytes={}, message_shapes=[{}]",
        request.model,
        request.max_tokens,
        request.messages.len(),
        request.tools.len(),
        system_chars,
        body_bytes,
        message_shapes
    )
}

fn summarize_message_shapes<'a>(
    messages: impl IntoIterator<
        Item = &'a Message,
        IntoIter: ExactSizeIterator + DoubleEndedIterator + Clone,
    >,
) -> String {
    let messages = messages.into_iter();
    const EDGE_MESSAGES: usize = 4;
    if messages.len() <= EDGE_MESSAGES * 2 {
        return messages
            .clone()
            .enumerate()
            .map(|(index, message)| message_shape(index, message))
            .collect::<Vec<_>>()
            .join(", ");
    }

    let head = messages
        .clone()
        .take(EDGE_MESSAGES)
        .enumerate()
        .map(|(index, message)| message_shape(index, message));
    let omitted = std::iter::once(format!(
        "...{} omitted...",
        messages.len() - EDGE_MESSAGES * 2
    ));
    let tail = messages
        .clone()
        .enumerate()
        .skip(messages.len() - EDGE_MESSAGES)
        .map(|(index, message)| message_shape(index, message));

    head.chain(omitted)
        .chain(tail)
        .collect::<Vec<_>>()
        .join(", ")
}

fn message_shape(index: usize, message: &Message) -> String {
    match message {
        Message::User { content, .. } => format!("{index}:user({})", block_shapes(content)),
        Message::Assistant { content, .. } => {
            format!("{index}:assistant({})", block_shapes(content))
        }
    }
}

fn block_shapes(content: &[ContentBlock]) -> String {
    content
        .iter()
        .map(|block| match block {
            ContentBlock::Text { text } => format!("text:{}c", text.chars().count()),
            ContentBlock::Thinking { thinking, .. } => {
                format!("thinking:{}c", thinking.chars().count())
            }
            ContentBlock::RedactedThinking { data } => {
                format!("redacted:{}c", data.chars().count())
            }
            ContentBlock::ToolUse { id, name, input } => {
                let input_keys = input.as_object().map(|map| map.len()).unwrap_or(0);
                format!("tool_use:{name}/{id}/keys:{input_keys}")
            }
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                let chars = content_blocks_chars(content);
                format!(
                    "tool_result:{tool_use_id}/blocks:{}/chars:{chars}/error:{}",
                    content.len(),
                    is_error.unwrap_or(false)
                )
            }
            ContentBlock::Image { source } => format!("image:{}", source.media_type),
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn content_blocks_chars(content: &[ContentBlock]) -> usize {
    content
        .iter()
        .map(|block| match block {
            ContentBlock::Text { text } => text.chars().count(),
            ContentBlock::Thinking { thinking, .. } => thinking.chars().count(),
            ContentBlock::RedactedThinking { data } => data.chars().count(),
            ContentBlock::ToolUse { input, .. } => input.to_string().chars().count(),
            ContentBlock::ToolResult { content, .. } => content_blocks_chars(content),
            ContentBlock::Image { .. } => 0,
        })
        .sum()
}

fn truncate_for_log(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut truncated = text.chars().take(max_chars).collect::<String>();
    truncated.push_str("...[truncated]");
    truncated
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn sequential_completed_streams_reuse_one_tcp_connection() {
        use crate::Provider;
        use futures::StreamExt;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // This local fixture measures transport reuse, not real model behavior or latency.
        async fn read_request(socket: &mut tokio::net::TcpStream) {
            let mut bytes = Vec::new();
            loop {
                assert!(bytes.len() < 65_536, "bounded fixture request");
                let mut chunk = [0; 4096];
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0, "connection closed before the next request");
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = std::str::from_utf8(&bytes[..end]).unwrap();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().unwrap())
                        })
                        .expect("request must declare its length");
                    assert!(end + 4 + length < 65_536);
                    if bytes.len() == end + 4 + length {
                        return;
                    }
                    assert!(bytes.len() < end + 4 + length);
                }
            }
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let provider = super::AnthropicProvider::new("fixture-only")
            .unwrap()
            .with_base_url(format!("http://{address}"))
            .with_no_proxy(true)
            .unwrap();
        let body = "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{body}",
            body.len()
        );
        let server = async {
            let (mut socket, _) = listener.accept().await.unwrap();
            for _ in 0..3 {
                tokio::select! {
                    _ = read_request(&mut socket) => {},
                    _ = listener.accept() => panic!("provider opened another TCP connection"),
                }
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        };
        let client = async {
            for _ in 0..3 {
                let mut stream = provider
                    .stream_messages(kcoder_types::MessagesRequest::new(
                        "fixture-model",
                        vec![kcoder_types::Message::user_text("hello")],
                    ))
                    .unwrap();
                let mut terminal = false;
                while let Some(event) = stream.next().await {
                    terminal |= matches!(event.unwrap(), kcoder_types::StreamEvent::MessageStop);
                }
                assert!(terminal);
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(server, client);
        })
        .await
        .expect("connection reuse probe exceeded its deadline");
    }

    #[test]
    fn request_wire_omits_local_message_origin() {
        let messages = vec![
            Message::user_text("literal"),
            Message::runtime_text("runtime"),
            Message::compaction_text("summary"),
        ];
        assert!(
            serde_json::to_value(&messages).unwrap()[0]
                .get("origin")
                .is_some()
        );
        let request = MessagesRequest::new("model", messages);
        let value: Value =
            serde_json::from_str(&anthropic_request_body(&request).unwrap()).unwrap();
        for message in value["messages"].as_array().unwrap() {
            assert!(message.get("origin").is_none());
        }
    }

    #[test]
    fn reasoning_recovery_removes_extra_body_thinking_only() {
        let mut request = kcoder_types::MessagesRequest::new(
            "model",
            vec![kcoder_types::Message::user_text("hello")],
        )
        .with_reasoning_effort(Some(kcoder_types::ReasoningEffort::High));
        let extra = serde_json::json!({"thinking": {"type":"enabled", "budget_tokens":1024}, "temperature":0.7});
        let original: serde_json::Value = serde_json::from_str(
            &super::anthropic_request_body_with_options(
                &request,
                extra.as_object().unwrap().clone(),
                false,
            )
            .unwrap(),
        )
        .unwrap();
        request.recovery_disable_reasoning = true;
        let actual: serde_json::Value = serde_json::from_str(
            &super::anthropic_request_body_with_options(
                &request,
                extra.as_object().unwrap().clone(),
                false,
            )
            .unwrap(),
        )
        .unwrap();
        let mut expected = original;
        expected.as_object_mut().unwrap().remove("thinking");
        assert_eq!(actual, expected);
        assert!(actual.get("recovery_disable_reasoning").is_none());
    }

    #[test]
    fn path_first_wire_final_body() {
        super::super::path_first::tests::assert_final_body(|request| {
            super::anthropic_request_body(&request).unwrap()
        });
    }
    use super::*;

    #[test]
    fn messages_url_avoids_double_slash_for_trailing_base_url() {
        let provider = AnthropicProvider::new("test-key")
            .unwrap()
            .with_base_url("http://127.0.0.1:8000/");

        assert_eq!(provider.messages_url(), "http://127.0.0.1:8000/v1/messages");
    }

    #[test]
    fn anthropic_request_headers_include_training_agent_depth() {
        let provider = AnthropicProvider::new("test-key").unwrap();
        let request = MessagesRequest::new("test-model", vec![Message::user_text("work")])
            .with_trajectory_agent_depth(3);

        let headers = provider.headers_for_request(&request).unwrap();

        assert_eq!(
            headers
                .get("x-slime-agent-depth")
                .and_then(|value| value.to_str().ok()),
            Some("3")
        );
    }

    #[test]
    fn anthropic_request_summary_uses_shapes_not_raw_text() {
        let request = MessagesRequest::new(
            "test-model",
            vec![
                Message::user_text("secret user text"),
                Message::Assistant {
                    content: vec![ContentBlock::ToolUse {
                        id: "tool-1".to_string(),
                        name: "read".to_string(),
                        input: serde_json::json!({"file_path": "secret.rs"}),
                    }],
                    usage: None,
                },
            ],
        )
        .with_system("secret system prompt")
        .with_max_tokens(123);

        let summary = anthropic_request_summary(&request, 456);

        assert!(summary.contains("model=test-model"));
        assert!(summary.contains("max_tokens=123"));
        assert!(summary.contains("messages=2"));
        assert!(summary.contains("body_bytes=456"));
        assert!(summary.contains("0:user(text:16c)"));
        assert!(summary.contains("1:assistant(tool_use:read/tool-1/keys:1)"));
        assert!(!summary.contains("secret user text"));
        assert!(!summary.contains("secret system prompt"));
        assert!(!summary.contains("secret.rs"));
    }

    #[test]
    fn anthropic_request_body_includes_thinking_when_reasoning_effort_set() {
        let request = MessagesRequest::new("test-model", vec![Message::user_text("hello")])
            .with_max_tokens(4096)
            .with_reasoning_effort(Some(ReasoningEffort::High));

        let body = anthropic_request_body(&request).unwrap();
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();

        assert!(value.get("reasoning_effort").is_none());
        assert_eq!(value["thinking"]["type"], "enabled");
        assert_eq!(value["thinking"]["budget_tokens"], 3072);
    }

    #[test]
    fn minimax_request_body_explicitly_selects_streaming_auto_tool_choice() {
        let request = MessagesRequest::new("MiniMax-M3", vec![Message::user_text("write it")])
            .with_tools(vec![kcoder_types::ToolDefinition {
                name: "write".to_string(),
                description: "Write a file".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {"content": {"type": "string"}},
                    "required": ["content"]
                }),
            }]);

        let body = anthropic_request_body_with_options(&request, Map::new(), true).unwrap();
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();

        assert_eq!(value["tool_choice"]["type"], "auto");
    }

    #[test]
    fn anthropic_request_body_does_not_add_minimax_tool_choice() {
        let request =
            MessagesRequest::new("claude", vec![Message::user_text("hello")]).with_tools(vec![
                kcoder_types::ToolDefinition {
                    name: "read".to_string(),
                    description: "Read a file".to_string(),
                    input_schema: serde_json::json!({"type": "object"}),
                },
            ]);

        let body = anthropic_request_body_with_options(&request, Map::new(), false).unwrap();
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();

        assert!(value.get("tool_choice").is_none());
    }

    #[test]
    fn anthropic_request_body_marks_stable_system_and_latest_message_for_cache() {
        let request = MessagesRequest::new(
            "test-model",
            vec![
                Message::user_text("first"),
                Message::assistant_text("latest"),
            ],
        )
        .with_system("stable system");

        let body = anthropic_request_body(&request).unwrap();
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();

        assert_eq!(value["system"][0]["type"], "text");
        assert_eq!(value["system"][0]["text"], "stable system");
        assert_eq!(value["system"][0]["cache_control"]["type"], "ephemeral");
        assert!(
            value["messages"][0]["content"][0]
                .get("cache_control")
                .is_none()
        );
        assert_eq!(
            value["messages"][1]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
    }

    #[test]
    fn anthropic_request_body_does_not_mark_thinking_tail_for_cache() {
        for tail in [
            ContentBlock::Thinking {
                thinking: "private reasoning".to_string(),
                signature: "sig".to_string(),
            },
            ContentBlock::RedactedThinking {
                data: "redacted".to_string(),
            },
        ] {
            let request = MessagesRequest::new(
                "test-model",
                vec![Message::Assistant {
                    content: vec![tail],
                    usage: None,
                }],
            )
            .with_system("stable system");

            let body = anthropic_request_body(&request).unwrap();
            let value: serde_json::Value = serde_json::from_str(&body).unwrap();

            assert!(
                value["messages"][0]["content"][0]
                    .get("cache_control")
                    .is_none()
            );
        }
    }

    #[test]
    fn anthropic_request_body_clamps_thinking_budget_below_max_tokens() {
        let request = MessagesRequest::new("test-model", vec![Message::user_text("hello")])
            .with_max_tokens(2048)
            .with_reasoning_effort(Some(ReasoningEffort::XHigh));

        let body = anthropic_request_body(&request).unwrap();
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();

        assert_eq!(value["thinking"]["budget_tokens"], 2047);
    }

    #[test]
    fn anthropic_request_body_skips_thinking_when_disabled_or_too_small() {
        let disabled = MessagesRequest::new("test-model", vec![Message::user_text("hello")])
            .with_reasoning_effort(Some(ReasoningEffort::None));
        let body = anthropic_request_body(&disabled).unwrap();
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(value.get("thinking").is_none());

        let too_small = MessagesRequest::new("test-model", vec![Message::user_text("hello")])
            .with_max_tokens(512)
            .with_reasoning_effort(Some(ReasoningEffort::High));
        let body = anthropic_request_body(&too_small).unwrap();
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(value.get("thinking").is_none());
    }

    #[test]
    fn anthropic_error_details_extract_body_request_id() {
        let details = parse_anthropic_error_details(
            r#"{"type":"error","error":{"type":"api_error","message":"unknown error, 999 (1000)"},"request_id":"0682981b03c2829bec558fdf18928abf"}"#,
        );

        assert_eq!(
            details.request_id.as_deref(),
            Some("0682981b03c2829bec558fdf18928abf")
        );
        assert_eq!(details.error_type.as_deref(), Some("api_error"));
        assert_eq!(
            details.message.as_deref(),
            Some("unknown error, 999 (1000)")
        );
    }

    #[test]
    fn anthropic_error_message_includes_structured_fields() {
        let body = r#"{"type":"error","error":{"type":"api_error","message":"unknown error, 999 (1000)"},"request_id":"body-request"}"#;
        let details = parse_anthropic_error_details(body);
        let message = format_anthropic_api_error_message("body-request", &details, body);

        assert!(message.contains("request_id=body-request"));
        assert!(message.contains("anthropic_error_type=api_error"));
        assert!(message.contains("anthropic_message=unknown error, 999 (1000)"));
        assert!(message.contains("response="));
    }
}

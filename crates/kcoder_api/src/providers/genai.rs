use crate::ApiErrorKind;
use crate::providers::{
    ModelDiscoveryOptions, Provider, ProviderModelDiscovery, ProviderStream, model_list_url,
    parse_model_list_json,
};
use futures::StreamExt;
use genai::adapter::AdapterKind;
use genai::chat::{
    ChatMessage, ChatOptions, ChatRequest, ChatStreamEvent, ContentPart, MessageContent,
    ReasoningEffort as GenAiReasoningEffort, Tool, ToolCall, ToolChoice, ToolResponse,
};
use genai::resolver::{AuthData, Endpoint};
use genai::{Client, ModelIden, ServiceTarget};
use kcoder_config::{DEFAULT_OPENAI_ENDPOINT, DEFAULT_REQUEST_TIMEOUT_SECS};
use kcoder_types::{
    ContentBlock, ContentDelta, Message, MessageDeltaFields, MessagesRequest, ReasoningEffort,
    StreamEvent, StreamingMessage, Usage,
};
use reqwest_genai::header::{AUTHORIZATION, HeaderMap, HeaderValue, USER_AGENT};
use serde_json::{Map, Value, json};
use std::time::Duration;

const DEFAULT_USER_AGENT: &str = "kcoder-rust/0.1.0";

/// A provider implementation backed by the provider-normalizing `genai` crate.
///
/// It currently targets OpenAI Chat Completions compatible endpoints. Kimi is
/// routed through this provider so reasoning, tool calls, usage and finish
/// reasons all share one normalized response path.
#[derive(Clone)]
pub struct GenAiProvider {
    client: Client,
    api_key: String,
    base_url: String,
    user_agent: String,
    extra_body: Map<String, Value>,
    timeout_secs: u64,
    no_proxy: bool,
    proxy_url: Option<String>,
}

impl std::fmt::Debug for GenAiProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GenAiProvider")
            .field("base_url", &self.base_url)
            .field("user_agent", &self.user_agent)
            .field("extra_body", &self.extra_body)
            .field("timeout_secs", &self.timeout_secs)
            .field("no_proxy", &self.no_proxy)
            .finish_non_exhaustive()
    }
}

impl GenAiProvider {
    pub fn new(api_key: impl Into<String>) -> Result<Self, ApiErrorKind> {
        let timeout_secs = DEFAULT_REQUEST_TIMEOUT_SECS;
        let user_agent = DEFAULT_USER_AGENT.to_string();
        let client = build_client(timeout_secs, false, None, &user_agent)?;
        Ok(Self {
            client,
            api_key: api_key.into(),
            base_url: DEFAULT_OPENAI_ENDPOINT.to_string(),
            user_agent,
            extra_body: Map::new(),
            timeout_secs,
            no_proxy: false,
            proxy_url: None,
        })
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub fn with_user_agent(mut self, user_agent: impl Into<String>) -> Result<Self, ApiErrorKind> {
        self.user_agent = user_agent.into();
        self.rebuild_client()?;
        Ok(self)
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

    pub fn with_extra_body_field(mut self, key: impl Into<String>, value: Value) -> Self {
        self.extra_body.insert(key.into(), value);
        self
    }

    fn rebuild_client(&mut self) -> Result<(), ApiErrorKind> {
        self.client = build_client(
            self.timeout_secs,
            self.no_proxy,
            self.proxy_url.as_deref(),
            &self.user_agent,
        )?;
        Ok(())
    }

    fn target(&self, model: &str) -> ServiceTarget {
        ServiceTarget {
            model: ModelIden::new(AdapterKind::OpenAI, model),
            endpoint: Endpoint::from_owned(normalize_base_url(&self.base_url)),
            auth: AuthData::Key(self.api_key.clone()),
        }
    }
}

fn build_client(
    timeout_secs: u64,
    no_proxy: bool,
    proxy_url: Option<&str>,
    user_agent: &str,
) -> Result<Client, ApiErrorKind> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_str(user_agent)?);
    let mut builder = reqwest_genai::Client::builder()
        .connect_timeout(Duration::from_secs(timeout_secs.max(1)))
        // Kimi's coding SSE is occasionally truncated by intermediaries when
        // content encoding is negotiated, which reqwest reports as a body
        // decode failure. SSE is already incremental, so compression has
        // negligible value here and disabling it makes the stream robust.
        .gzip(false)
        .default_headers(headers);
    if let Some(proxy_url) = proxy_url {
        builder = builder.proxy(reqwest_genai::Proxy::all(proxy_url).map_err(|error| {
            ApiErrorKind::Api {
                error_type: "genai_proxy".to_string(),
                message: format!("failed to configure genai proxy: {error}"),
            }
        })?);
    } else if no_proxy {
        builder = builder.no_proxy();
    }
    let reqwest_client = builder.build().map_err(|error| ApiErrorKind::Api {
        error_type: "genai_client".to_string(),
        message: format!("failed to build genai HTTP client: {error}"),
    })?;
    Ok(Client::builder().with_reqwest(reqwest_client).build())
}

fn normalize_base_url(base_url: &str) -> String {
    format!("{}/", base_url.trim_end_matches('/'))
}

impl Provider for GenAiProvider {
    fn name(&self) -> &'static str {
        "openai"
    }

    fn supports_response_json_schema(&self) -> bool {
        true
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

    fn discover_models(&self, options: ModelDiscoveryOptions) -> ProviderModelDiscovery {
        let api_key = self.api_key.clone();
        let base_url = self.base_url.clone();
        let user_agent = self.user_agent.clone();
        let no_proxy = self.no_proxy;
        Box::pin(async move {
            let mut builder = reqwest_genai::Client::builder();
            if no_proxy {
                builder = builder.no_proxy();
            }
            let client = builder.build().map_err(|error| ApiErrorKind::Api {
                error_type: "model_discovery_client".to_string(),
                message: error.to_string(),
            })?;
            let response = client
                .get(model_list_url(&base_url))
                .header(AUTHORIZATION, format!("Bearer {api_key}"))
                .header(USER_AGENT, user_agent)
                .timeout(options.timeout)
                .send()
                .await
                .map_err(|error| ApiErrorKind::Api {
                    error_type: "model_discovery_network".to_string(),
                    message: error.to_string(),
                })?;
            let status = response.status();
            let body = response.text().await.map_err(|error| ApiErrorKind::Api {
                error_type: "model_discovery_network".to_string(),
                message: error.to_string(),
            })?;
            if !status.is_success() {
                return Err(ApiErrorKind::Api {
                    error_type: format!("model_discovery_http_{}", status.as_u16()),
                    message: format!("model list request failed with {status}"),
                });
            }
            parse_model_list_json(&body, options.max_models)
        })
    }

    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        let target = self.target(&request.model);
        let (chat_request, options) = into_genai_request(request, &self.extra_body);
        let client = self.client.clone();

        Ok(Box::pin(async_stream::stream! {
            let response = match client.exec_chat_stream(target, chat_request, Some(&options)).await {
                Ok(response) => response,
                Err(error) => {
                    yield Err(map_genai_error(error));
                    return;
                }
            };

            let model = response.model_iden.model_name.to_string();
            let mut stream = response.stream;
            let mut state = OutputState::new(model);
            while let Some(event) = stream.next().await {
                match event {
                    Ok(event) => {
                        for mapped in state.handle(event) {
                            yield Ok(mapped);
                        }
                    }
                    Err(error) => {
                        yield Err(map_genai_error(error));
                        return;
                    }
                }
            }
        }))
    }
}

fn map_genai_error(error: genai::Error) -> ApiErrorKind {
    let message = error.to_string();
    let metadata = direct_genai_http_metadata(&error).or_else(|| match &error {
        genai::Error::WebStream { error, .. } => error
            .downcast_ref::<genai::Error>()
            .and_then(direct_genai_http_metadata),
        _ => None,
    });
    if let Some(metadata) = metadata {
        return ApiErrorKind::Http {
            error_type: "genai".into(),
            message,
            metadata,
        };
    }
    let transport = match &error {
        genai::Error::WebModelCall {
            webc_error: genai::webc::Error::Reqwest(error),
            ..
        }
        | genai::Error::WebAdapterCall {
            webc_error: genai::webc::Error::Reqwest(error),
            ..
        } => Some(error),
        genai::Error::WebStream { error, .. } => error.downcast_ref::<reqwest_genai::Error>(),
        _ => None,
    };
    if let Some(transport) = transport {
        use crate::NonHttpErrorClass::*;
        let class = if transport.is_builder() || transport.is_decode() {
            Permanent
        } else if transport.is_timeout() {
            TransportTimeout
        } else if transport.is_connect() || transport.is_body() {
            Transient
        } else {
            Permanent
        };
        return ApiErrorKind::SseStream {
            error_type: "genai".into(),
            message,
            kind: crate::SseErrorKind::Transport(class),
        };
    }
    if let genai::Error::ChatResponse { body, .. } = &error {
        let detail = body.get("error").unwrap_or(body);
        let kind = detail
            .get("type")
            .and_then(Value::as_str)
            .or_else(|| detail.get("code").and_then(Value::as_str))
            .unwrap_or("genai");
        return ApiErrorKind::Api {
            error_type: super::openai::redact_sensitive_token(kind),
            message: super::openai::redact_sensitive_text(&message),
        };
    }
    ApiErrorKind::Api {
        error_type: "genai".to_string(),
        message,
    }
}

fn direct_genai_http_metadata(error: &genai::Error) -> Option<crate::HttpErrorMetadata> {
    match error {
        genai::Error::HttpError { status, body, .. } => Some(
            crate::HttpErrorMetadata::from_response(status.as_u16(), body, None),
        ),
        genai::Error::WebModelCall {
            webc_error:
                genai::webc::Error::ResponseFailedStatus {
                    status,
                    body,
                    headers,
                },
            ..
        }
        | genai::Error::WebAdapterCall {
            webc_error:
                genai::webc::Error::ResponseFailedStatus {
                    status,
                    body,
                    headers,
                },
            ..
        } => Some(crate::HttpErrorMetadata::from_response(
            status.as_u16(),
            body,
            headers
                .get("retry-after")
                .and_then(|value| value.to_str().ok()),
        )),
        _ => None,
    }
}

fn into_genai_request(
    request: MessagesRequest,
    provider_extra_body: &Map<String, Value>,
) -> (ChatRequest, ChatOptions) {
    let mut messages = Vec::new();
    for message in request.messages {
        messages.extend(into_genai_messages(message));
    }

    let tools = request
        .tools
        .into_iter()
        .map(|tool| {
            Tool::new(tool.name)
                .with_description(tool.description)
                .with_schema(tool.input_schema)
        })
        .collect::<Vec<_>>();
    let mut chat_request = ChatRequest::new(messages);
    chat_request.system = request.system;
    if !tools.is_empty() {
        chat_request = chat_request.with_tools(tools);
    }

    let reasoning_effort = request.reasoning_effort;
    let response_json_schema = request.response_json_schema;
    let mut extra_body = Value::Object(provider_extra_body.clone());
    if let Value::Object(body) = &mut extra_body {
        // Kimi's current OpenAI-compatible contract deprecates max_tokens.
        // Setting only this field also avoids genai adding max_tokens based on
        // its OpenAI-model-name heuristic.
        body.insert(
            "max_completion_tokens".to_string(),
            Value::Number(request.max_tokens.into()),
        );
        if let Some(ReasoningEffort::Custom(value)) = &reasoning_effort {
            body.insert("reasoning_effort".to_string(), Value::String(value.clone()));
        }
        if let Some(schema) = &response_json_schema {
            let mut json_schema = json!({
                "name": schema.name,
                "strict": schema.strict,
                "schema": schema.schema,
            });
            if let Some(description) = &schema.description {
                json_schema["description"] = Value::String(description.clone());
            }
            body.insert(
                "response_format".to_string(),
                json!({"type": "json_schema", "json_schema": json_schema}),
            );
        }
    }

    let mut options = ChatOptions::default()
        .with_capture_usage(true)
        .with_capture_content(true)
        .with_capture_reasoning_content(true)
        .with_capture_tool_calls(true)
        .with_tool_choice(ToolChoice::Auto)
        .with_extra_body(extra_body);
    if let Some(session_id) = request.debug_session_id {
        options = options.with_prompt_cache_key(session_id);
    }
    if let Some(effort) = reasoning_effort.and_then(map_reasoning_effort) {
        options = options.with_reasoning_effort(effort);
    }
    (chat_request, options)
}

fn map_reasoning_effort(effort: ReasoningEffort) -> Option<GenAiReasoningEffort> {
    Some(match effort {
        ReasoningEffort::None => GenAiReasoningEffort::None,
        ReasoningEffort::Minimal => GenAiReasoningEffort::Minimal,
        ReasoningEffort::Low => GenAiReasoningEffort::Low,
        ReasoningEffort::Medium => GenAiReasoningEffort::Medium,
        ReasoningEffort::High => GenAiReasoningEffort::High,
        ReasoningEffort::XHigh => GenAiReasoningEffort::XHigh,
        ReasoningEffort::Custom(_) => return None,
    })
}

fn into_genai_messages(message: Message) -> Vec<ChatMessage> {
    match message {
        Message::Assistant { content, .. } => {
            let parts = content
                .into_iter()
                .filter_map(assistant_part)
                .collect::<Vec<_>>();
            vec![ChatMessage::assistant(MessageContent::from_parts(parts))]
        }
        Message::User { content } => {
            let mut result = Vec::new();
            let mut user_parts = Vec::new();
            for block in content {
                match block {
                    ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        ..
                    } => {
                        if !user_parts.is_empty() {
                            result.push(ChatMessage::user(MessageContent::from_parts(
                                std::mem::take(&mut user_parts),
                            )));
                        }
                        result.push(ChatMessage::tool(ToolResponse::new(
                            tool_use_id,
                            tool_result_text(content),
                        )));
                    }
                    other => {
                        if let Some(part) = user_part(other) {
                            user_parts.push(part);
                        }
                    }
                }
            }
            if !user_parts.is_empty() {
                result.push(ChatMessage::user(MessageContent::from_parts(user_parts)));
            }
            result
        }
    }
}

fn assistant_part(block: ContentBlock) -> Option<ContentPart> {
    match block {
        ContentBlock::Text { text } => Some(ContentPart::Text(text)),
        ContentBlock::Thinking { thinking, .. } => Some(ContentPart::ReasoningContent(thinking)),
        ContentBlock::ToolUse { id, name, input } => Some(ContentPart::ToolCall(ToolCall {
            call_id: id,
            fn_name: name,
            fn_arguments: input,
            thought_signatures: None,
        })),
        ContentBlock::Image { source } => Some(ContentPart::from_binary_base64(
            source.media_type,
            source.data,
            None,
        )),
        ContentBlock::ToolResult { .. } | ContentBlock::RedactedThinking { .. } => None,
    }
}

fn user_part(block: ContentBlock) -> Option<ContentPart> {
    match block {
        ContentBlock::Text { text } => Some(ContentPart::Text(text)),
        ContentBlock::Image { source } => Some(ContentPart::from_binary_base64(
            source.media_type,
            source.data,
            None,
        )),
        ContentBlock::Thinking { thinking, .. } => Some(ContentPart::Text(thinking)),
        ContentBlock::RedactedThinking { data } => Some(ContentPart::Text(data)),
        ContentBlock::ToolUse { .. } | ContentBlock::ToolResult { .. } => None,
    }
}

fn tool_result_text(content: Vec<ContentBlock>) -> String {
    content
        .into_iter()
        .map(|block| match block {
            ContentBlock::Text { text } => text,
            other => serde_json::to_string(&other).unwrap_or_default(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenBlock {
    Thinking,
    Text,
}

struct OutputState {
    model: String,
    started: bool,
    next_index: usize,
    open: Option<(usize, OpenBlock)>,
}

impl OutputState {
    fn new(model: String) -> Self {
        Self {
            model,
            started: false,
            next_index: 0,
            open: None,
        }
    }

    fn handle(&mut self, event: ChatStreamEvent) -> Vec<StreamEvent> {
        // The SDK emits Start before the HTTP response is accepted. Publishing it
        // would incorrectly disable pre-response retries for an HTTP failure.
        if matches!(event, ChatStreamEvent::Start) {
            return Vec::new();
        }
        let mut out = Vec::new();
        if !self.started {
            self.started = true;
            out.push(StreamEvent::MessageStart {
                message: StreamingMessage {
                    id: String::new(),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: self.model.clone(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            });
        }
        match event {
            ChatStreamEvent::Start => {}
            ChatStreamEvent::ReasoningChunk(chunk) => {
                let index = self.ensure_block(OpenBlock::Thinking, &mut out);
                out.push(StreamEvent::ContentBlockDelta {
                    index,
                    delta: ContentDelta::ThinkingDelta {
                        thinking: chunk.content,
                    },
                });
            }
            ChatStreamEvent::Chunk(chunk) => {
                let index = self.ensure_block(OpenBlock::Text, &mut out);
                out.push(StreamEvent::ContentBlockDelta {
                    index,
                    delta: ContentDelta::TextDelta {
                        text: chunk.content,
                    },
                });
            }
            ChatStreamEvent::ThoughtSignatureChunk(_) => {}
            // genai emits accumulated argument snapshots. We emit the final,
            // parsed calls from StreamEnd to avoid duplicated partial JSON.
            ChatStreamEvent::ToolCallChunk(_) => {}
            ChatStreamEvent::End(end) => {
                self.close_block(&mut out);
                if let Some(tool_calls) = end.captured_tool_calls() {
                    for call in tool_calls {
                        let index = self.next_index;
                        self.next_index += 1;
                        out.push(StreamEvent::ContentBlockStart {
                            index,
                            content_block: ContentBlock::ToolUse {
                                id: call.call_id.clone(),
                                name: call.fn_name.clone(),
                                input: json!({}),
                            },
                        });
                        out.push(StreamEvent::ContentBlockDelta {
                            index,
                            delta: ContentDelta::InputJsonDelta {
                                partial_json: match &call.fn_arguments {
                                    Value::String(value) => value.clone(),
                                    value => value.to_string(),
                                },
                            },
                        });
                        out.push(StreamEvent::ContentBlockStop { index });
                    }
                }
                out.push(StreamEvent::MessageDelta {
                    delta: MessageDeltaFields {
                        stop_reason: end
                            .captured_stop_reason
                            .as_ref()
                            .map(|reason| reason.raw().to_string()),
                        stop_sequence: None,
                        usage: end.captured_usage.as_ref().map(map_usage),
                    },
                });
                out.push(StreamEvent::MessageStop);
            }
        }
        out
    }

    fn ensure_block(&mut self, kind: OpenBlock, out: &mut Vec<StreamEvent>) -> usize {
        if let Some((index, current)) = self.open {
            if current == kind {
                return index;
            }
            out.push(StreamEvent::ContentBlockStop { index });
        }
        let index = self.next_index;
        self.next_index += 1;
        let content_block = match kind {
            OpenBlock::Thinking => ContentBlock::Thinking {
                thinking: String::new(),
                signature: String::new(),
            },
            OpenBlock::Text => ContentBlock::Text {
                text: String::new(),
            },
        };
        out.push(StreamEvent::ContentBlockStart {
            index,
            content_block,
        });
        self.open = Some((index, kind));
        index
    }

    fn close_block(&mut self, out: &mut Vec<StreamEvent>) {
        if let Some((index, _)) = self.open.take() {
            out.push(StreamEvent::ContentBlockStop { index });
        }
    }
}

fn map_usage(usage: &genai::chat::Usage) -> Usage {
    Usage {
        input_tokens: non_negative_u32(usage.prompt_tokens),
        output_tokens: non_negative_u32(usage.completion_tokens),
        total_tokens: usage
            .total_tokens
            .map(|tokens| tokens.max(0) as u32)
            .or_else(|| {
                Some(
                    non_negative_u32(usage.prompt_tokens)
                        .saturating_add(non_negative_u32(usage.completion_tokens)),
                )
            }),
        cache_creation_input_tokens: None,
        cache_read_input_tokens: usage
            .prompt_tokens_details
            .as_ref()
            .and_then(|details| details.cached_tokens)
            .map(|tokens| tokens.max(0) as u32),
        iterations: None,
    }
}

fn non_negative_u32(value: Option<i32>) -> u32 {
    value.unwrap_or_default().max(0) as u32
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn real_http_failure_preserves_status_before_any_model_output() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 16384];
            let read = stream.read(&mut request).await.unwrap();
            assert!(read > 0, "fixture must receive the request head");
            let body = r#"{"error":{"message":"fixture failure","code":"overloaded_error"}}"#;
            let response = format!(
                "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.shutdown().await.unwrap();
        });
        let provider = super::GenAiProvider::new("local-fixture")
            .unwrap()
            .with_base_url(format!("http://{address}/v1"))
            .with_no_proxy(true)
            .unwrap();
        let events = provider
            .stream_messages(kcoder_types::MessagesRequest::new(
                "gpt-4o",
                vec![kcoder_types::Message::user_text("hello")],
            ))
            .unwrap()
            .collect::<Vec<_>>()
            .await;
        server.await.unwrap();
        assert_eq!(
            events.len(),
            1,
            "unexpected synthetic response before HTTP failure: {events:?}"
        );
        assert!(
            matches!(&events[0], Err(crate::ApiErrorKind::Http { metadata, .. }) if metadata.status == 503),
            "{events:?}"
        );
    }

    #[test]
    fn reviewed_genai_business_type_precedence_and_redaction() {
        for detail in [
            serde_json::json!({"type":"error", "code":"rate_limit_error"}),
            serde_json::json!({"type":"sk-secret", "code":"rate_limit_error"}),
            serde_json::json!({"code":"sk-secret"}),
            serde_json::json!({"type":" overloaded_error "}),
        ] {
            let error = super::map_genai_error(genai::Error::ChatResponse {
                model_iden: genai::ModelIden::new(genai::adapter::AdapterKind::OpenAI, "test"),
                body: serde_json::json!({"error":detail}),
            });
            assert_eq!(
                error.non_http_error_class(),
                Some(crate::NonHttpErrorClass::Permanent),
                "{detail}"
            );
            assert!(!error.to_string().contains("sk-secret"));
            assert!(!format!("{error:?}").contains("sk-secret"));
        }
    }

    #[tokio::test]
    async fn genai_wrapped_errors_keep_http_transport_and_parse_boundaries() {
        use crate::NonHttpErrorClass;
        let model = || genai::ModelIden::new(genai::adapter::AdapterKind::OpenAI, "test");
        let client = reqwest_genai::Client::builder().no_proxy().build().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let error = client
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap_err();
        assert!(error.is_connect());
        let mapped = super::map_genai_error(genai::Error::WebStream {
            model_iden: model(),
            cause: "authentication 429".into(),
            error: Box::new(error),
        });
        assert_eq!(
            mapped.non_http_error_class(),
            Some(NonHttpErrorClass::Transient)
        );

        let error = client.get("not a URL").build().unwrap_err();
        let mapped = super::map_genai_error(genai::Error::WebModelCall {
            model_iden: model(),
            webc_error: genai::webc::Error::Reqwest(error),
        });
        assert_eq!(
            mapped.non_http_error_class(),
            Some(NonHttpErrorClass::Permanent)
        );

        for error in [
            genai::Error::WebStream {
                model_iden: model(),
                cause: "network 429 stream idle".into(),
                error: Box::new(String::from_utf8(vec![0xff]).unwrap_err()),
            },
            genai::Error::StreamParse {
                model_iden: model(),
                serde_error: serde_json::from_str::<serde_json::Value>("invalid").unwrap_err(),
            },
            genai::Error::Internal("network 429 stream idle".into()),
        ] {
            assert_eq!(
                super::map_genai_error(error).non_http_error_class(),
                Some(NonHttpErrorClass::Permanent)
            );
        }
        let wrapped = genai::Error::WebStream {
            model_iden: model(),
            cause: "network 429".into(),
            error: Box::new(genai::Error::HttpError {
                status: reqwest_genai::StatusCode::UNAUTHORIZED,
                canonical_reason: "fixture".into(),
                body: "network 429".into(),
            }),
        };
        assert!(matches!(
            super::map_genai_error(wrapped),
            crate::ApiErrorKind::Http {
                metadata: crate::HttpErrorMetadata { status: 401, .. },
                ..
            }
        ));
        let mut headers = reqwest_genai::header::HeaderMap::new();
        headers.insert("retry-after", "2".parse().unwrap());
        let error = genai::Error::WebModelCall {
            model_iden: model(),
            webc_error: genai::webc::Error::ResponseFailedStatus {
                status: reqwest_genai::StatusCode::SERVICE_UNAVAILABLE,
                body: "retry_after=99".into(),
                headers: Box::new(headers),
            },
        };
        let crate::ApiErrorKind::Http { metadata, .. } = super::map_genai_error(error) else {
            panic!("lost wrapped HTTP facts")
        };
        assert_eq!(metadata.status, 503);
        assert_eq!(
            metadata.retry_after,
            Some(std::time::Duration::from_secs(2))
        );
    }

    #[test]
    fn genai_mapping_preserves_typed_http_and_business_errors() {
        for status in [401, 429, 503] {
            let mapped = super::map_genai_error(genai::Error::HttpError {
                status: reqwest_genai::StatusCode::from_u16(status).unwrap(),
                canonical_reason: "fixture".into(),
                body: r#"{"error":{"type":"authentication_error","message":"network 429 retry_after=99"}}"#.into(),
            });
            let crate::ApiErrorKind::Http { metadata, .. } = mapped else {
                panic!("lost HTTP metadata: {mapped:?}")
            };
            assert_eq!(metadata.status, status);
            assert_eq!(metadata.retry_after, None);
        }
        for (kind, class) in [
            ("overloaded_error", crate::NonHttpErrorClass::Transient),
            ("authentication_error", crate::NonHttpErrorClass::Permanent),
            ("unknown", crate::NonHttpErrorClass::Permanent),
        ] {
            let mapped = super::map_genai_error(genai::Error::ChatResponse {
                model_iden: genai::ModelIden::new(genai::adapter::AdapterKind::OpenAI, "test"),
                body: serde_json::json!({"error": {"type":kind, "message":"network 429"}}),
            });
            assert_eq!(mapped.non_http_error_class(), Some(class), "{kind}");
        }
    }

    #[test]
    fn provider_error_summary_genai_retains_metadata_without_rendering_body() {
        let mapped = super::map_genai_error(genai::Error::HttpError {
            status: reqwest_genai::StatusCode::BAD_REQUEST,
            canonical_reason: "SENTINEL_PRIVATE".into(),
            body: serde_json::json!({"error":{"type":"invalid_request_error","code":"unsupported_parameter","param":"thinking","message":"SENTINEL_PRIVATE Bearer multiple words".repeat(1000)}}).to_string(),
        });
        assert!(!format!("{mapped} {mapped:?}").contains("SENTINEL_PRIVATE"));
        assert!(mapped.to_string().len() <= 512);
        let crate::ApiErrorKind::Http { metadata, .. } = mapped else {
            panic!("lost metadata")
        };
        assert_eq!(
            metadata.provider_code.as_deref(),
            Some("unsupported_parameter")
        );
        assert_eq!(
            metadata.rejected_reasoning_parameter,
            Some(crate::RejectedReasoningParameter::Thinking)
        );
    }

    use super::*;
    use kcoder_types::{ResponseJsonSchema, ToolDefinition};

    #[test]
    fn kimi_options_use_max_completion_tokens_and_preserve_parameter_extensions() {
        let request = MessagesRequest::new("kimi-for-coding", vec![Message::user_text("hi")])
            .with_max_tokens(123)
            .with_reasoning_effort(Some(ReasoningEffort::High))
            .with_response_json_schema(
                ResponseJsonSchema::new(
                    "answer",
                    json!({"type":"object","properties":{"ok":{"type":"boolean"}}}),
                )
                .with_description("answer shape")
                .with_strict(false),
            )
            .with_debug_session_id("session-1");
        let extra = Map::from_iter([("temperature".to_string(), json!(0.2))]);

        let (_, options) = into_genai_request(request, &extra);

        assert_eq!(options.max_tokens, None);
        assert_eq!(options.prompt_cache_key.as_deref(), Some("session-1"));
        assert!(matches!(
            options.reasoning_effort,
            Some(GenAiReasoningEffort::High)
        ));
        assert_eq!(
            options.extra_body.as_ref().unwrap()["max_completion_tokens"],
            json!(123)
        );
        assert_eq!(
            options.extra_body.as_ref().unwrap()["temperature"],
            json!(0.2)
        );
        assert_eq!(
            options.extra_body.as_ref().unwrap()["response_format"]["json_schema"]["strict"],
            json!(false)
        );
        assert_eq!(
            options.extra_body.as_ref().unwrap()["response_format"]["json_schema"]["description"],
            json!("answer shape")
        );
    }

    #[test]
    fn custom_reasoning_effort_is_not_dropped() {
        let request = MessagesRequest::new("kimi-for-coding", vec![Message::user_text("hi")])
            .with_reasoning_effort(Some(ReasoningEffort::Custom("max".to_string())));

        let (_, options) = into_genai_request(request, &Map::new());

        assert!(options.reasoning_effort.is_none());
        assert_eq!(
            options.extra_body.as_ref().unwrap()["reasoning_effort"],
            json!("max")
        );
    }

    #[test]
    fn assistant_roundtrip_preserves_reasoning_and_tool_call() {
        let request = MessagesRequest::new(
            "kimi-for-coding",
            vec![Message::Assistant {
                content: vec![
                    ContentBlock::Thinking {
                        thinking: "reason".to_string(),
                        signature: String::new(),
                    },
                    ContentBlock::ToolUse {
                        id: "call_1".to_string(),
                        name: "read_file".to_string(),
                        input: json!({"path":"a.rs"}),
                    },
                ],
                usage: None,
            }],
        );

        let (chat, _) = into_genai_request(request, &Map::new());
        let parts = chat.messages[0]
            .content
            .clone()
            .into_iter()
            .collect::<Vec<_>>();
        assert!(matches!(&parts[0], ContentPart::ReasoningContent(value) if value == "reason"));
        assert!(
            matches!(&parts[1], ContentPart::ToolCall(call) if call.call_id == "call_1" && call.fn_name == "read_file")
        );
    }

    #[test]
    fn tools_and_tool_results_are_mapped() {
        let request = MessagesRequest::new(
            "kimi-for-coding",
            vec![Message::user_content(vec![ContentBlock::ToolResult {
                tool_use_id: "call_1".to_string(),
                content: vec![ContentBlock::Text {
                    text: "ok".to_string(),
                }],
                is_error: Some(false),
            }])],
        )
        .with_tools(vec![ToolDefinition {
            name: "read_file".to_string(),
            description: "read".to_string(),
            input_schema: json!({"type":"object"}),
        }]);

        let (chat, _) = into_genai_request(request, &Map::new());
        assert_eq!(chat.tools.as_ref().unwrap().len(), 1);
        assert_eq!(chat.messages.len(), 1);
        assert!(chat.messages[0].content.clone().into_iter().any(|part| {
            matches!(part, ContentPart::ToolResponse(response) if response.call_id == "call_1" && response.content == "ok")
        }));
    }

    #[test]
    fn stream_state_maps_reasoning_text_usage_and_finish_reason() {
        let mut state = OutputState::new("kimi-for-coding".to_string());
        let reasoning = state.handle(ChatStreamEvent::ReasoningChunk(genai::chat::StreamChunk {
            content: "think".to_string(),
        }));
        assert!(reasoning.iter().any(|event| matches!(event, StreamEvent::ContentBlockDelta { delta: ContentDelta::ThinkingDelta { thinking }, .. } if thinking == "think")));

        let text_events = state.handle(ChatStreamEvent::Chunk(genai::chat::StreamChunk {
            content: "answer".to_string(),
        }));
        assert!(text_events.iter().any(|event| matches!(event, StreamEvent::ContentBlockDelta { delta: ContentDelta::TextDelta { text }, .. } if text == "answer")));

        let end = state.handle(ChatStreamEvent::End(genai::chat::StreamEnd {
            captured_usage: Some(genai::chat::Usage {
                prompt_tokens: Some(10),
                completion_tokens: Some(5),
                total_tokens: Some(15),
                ..Default::default()
            }),
            captured_stop_reason: Some(genai::chat::StopReason::Completed("stop".to_string())),
            ..Default::default()
        }));
        assert!(end.iter().any(|event| matches!(event, StreamEvent::MessageDelta { delta } if delta.stop_reason.as_deref() == Some("stop") && delta.usage.as_ref().is_some_and(|usage| usage.input_tokens == 10 && usage.output_tokens == 5 && usage.total_tokens == Some(15)))));
        assert!(matches!(end.last(), Some(StreamEvent::MessageStop)));
    }
}

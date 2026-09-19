use crate::ApiErrorKind;
use crate::providers::debug_log::LlmDebugRecorder;
use crate::providers::{
    ModelDiscoveryOptions, Provider, ProviderModelDiscovery, ProviderStream,
    parse_model_list_response,
};
use eventsource_stream::Eventsource;
use futures::StreamExt;
use kcoder_config::{DEFAULT_GEMINI_ENDPOINT, DEFAULT_REQUEST_TIMEOUT_SECS};
use kcoder_types::{
    ContentBlock, ContentDelta, Message, MessagesRequest, StreamEvent, ToolDefinition, Usage,
};
use serde::Deserialize;
use serde_json::{Map, Value};
use tracing::debug;

const DEFAULT_USER_AGENT: &str = "kcoder-rust/0.1.0";

/// Gemini-compatible provider using the native `streamGenerateContent` endpoint.
#[derive(Debug, Clone)]
pub struct GeminiProvider {
    client: reqwest::Client,
    api_key: String,
    model: String,
    base_url: String,
    user_agent: String,
    extra_body: Map<String, Value>,
    timeout_secs: u64,
    no_proxy: bool,
    proxy_url: Option<String>,
}

impl GeminiProvider {
    pub fn new(api_key: impl Into<String>, model: &str) -> Result<Self, ApiErrorKind> {
        Ok(Self {
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(DEFAULT_REQUEST_TIMEOUT_SECS))
                .build()?,
            api_key: api_key.into(),
            model: model.to_string(),
            base_url: DEFAULT_GEMINI_ENDPOINT.to_string(),
            user_agent: DEFAULT_USER_AGENT.to_string(),
            extra_body: Map::new(),
            timeout_secs: 300,
            no_proxy: false,
            proxy_url: None,
        })
    }

    #[allow(dead_code)]
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    #[allow(dead_code)]
    pub fn with_user_agent(mut self, user_agent: impl Into<String>) -> Self {
        self.user_agent = user_agent.into();
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
        // Do not apply a total timeout to a streaming response. Long-running
        // thinking and final text remain bounded by the engine's idle watchdog.
        let mut builder = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(self.timeout_secs));
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
}

impl Provider for GeminiProvider {
    fn name(&self) -> &'static str {
        "gemini"
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

    fn prewarm(&self) -> crate::providers::ProviderPrewarm {
        let client = self.client.clone();
        let url = format!("{}/v1beta/models/{}", self.base_url, self.model);
        let api_key = self.api_key.clone();
        let user_agent = self.user_agent.clone();
        Box::pin(async move {
            let _ = client
                .head(url)
                .query(&[("key", api_key)])
                .header(reqwest::header::USER_AGENT, user_agent)
                .send()
                .await;
        })
    }

    fn discover_models(&self, options: ModelDiscoveryOptions) -> ProviderModelDiscovery {
        let client = self.client.clone();
        let url = format!("{}/v1beta/models", self.base_url.trim_end_matches('/'));
        let api_key = self.api_key.clone();
        let user_agent = self.user_agent.clone();
        Box::pin(async move {
            let response = client
                .get(url)
                .header("x-goog-api-key", api_key)
                .header(reqwest::header::USER_AGENT, user_agent)
                .timeout(options.timeout)
                .send()
                .await?;
            parse_model_list_response(response, options.max_models).await
        })
    }

    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        let model = if request.model.trim().is_empty() {
            self.model.clone()
        } else {
            request.model.clone()
        };
        let url = format!(
            "{}/v1beta/models/{}:streamGenerateContent",
            self.base_url, model
        );
        let request_summary = gemini_request_summary(&request, &model);
        let debug_session_id = request.debug_session_id.clone();
        let body = build_gemini_request_with_extra(request, self.extra_body.clone())?;
        debug!(
            "POST {} ({}, body_bytes={})",
            url,
            request_summary,
            body.len()
        );

        let client = self.client.clone();
        let api_key = self.api_key.clone();
        let user_agent = self.user_agent.clone();
        let debug_url = format!("{url}?alt=sse");
        let mut debug_recorder =
            LlmDebugRecorder::new("gemini", debug_session_id.as_deref(), &debug_url, &body);
        let stream = async_stream::stream! {
            let response = match client
                .post(&url)
                .query(&[("alt", &"sse".to_string())])
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .header(reqwest::header::USER_AGENT, user_agent)
                .header("x-goog-api-key", api_key)
                .body(body)
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    debug_recorder.record_error(e.to_string());
                    debug_recorder.finish();
                    yield Err(ApiErrorKind::Network(e));
                    return;
                }
            };

            let status = response.status();
            debug_recorder.record_status(status.as_u16());
            debug_recorder.record_headers(response.headers());
            debug!("Gemini response status: {}", status);
            if !status.is_success() {
                let retry_after = super::retry_after_hint(response.headers());
                let text = response.text().await.unwrap_or_default();
                debug_recorder.record_body(&text);
                debug_recorder.record_error(format!("http status {}", status.as_u16()));
                debug_recorder.finish();
                debug!(
                    "Gemini error response: {}",
                    kcoder_types::provider_error_summary("unknown_error", Some(status.as_u16()))
                );
                let metadata = crate::HttpErrorMetadata::from_response(status.as_u16(), &text, retry_after.as_deref());
                let (error_type, mut message) = match parse_api_error(&text) {
                    Some(ApiErrorKind::Api { error_type, message }) => (error_type, message),
                    _ => (status.to_string(), text),
                };
                if let Some(after) = retry_after {
                    message.push_str(&format!("; retry_after={after}"));
                }
                yield Err(ApiErrorKind::Http { error_type, message, metadata });
                return;
            }

            let mut es = response.bytes_stream().eventsource();
            let mut stream_state = GeminiStreamState::default();
            while let Some(event) = es.next().await {
                match event {
                    Ok(msg) => {
                        debug!(
                            "Gemini SSE event: data_bytes={}",
                            msg.data.len()
                        );
                        if let Err(e) = validate_event_data(&msg.data) {
                            debug_recorder.record_failed_sse_event();
                            debug_recorder.record_error(e.to_string());
                            debug_recorder.finish();
                            yield Err(e);
                            return;
                        }
                        let parsed = parse_gemini_chunk(&msg.data, &mut stream_state);
                        if parsed.iter().any(|event| matches!(event, StreamEvent::Error { .. })) {
                            debug_recorder.record_failed_sse_event();
                        } else {
                            debug_recorder.record_sse_event(&msg.event, &msg.data);
                        }
                        for event in parsed {
                            let terminal = matches!(&event, StreamEvent::MessageStop);
                            yield Ok(event);
                            if terminal {
                                debug_recorder.finish();
                                return;
                            }
                        }
                    }
                    Err(e) => {
                        debug_recorder.record_error(e.to_string());
                        debug_recorder.finish();
                        debug!("Gemini SSE stream error; response details withheld");
                        yield Err(ApiErrorKind::SseStream {
                            error_type: "sse_stream_error".to_string(),
                            message: e.to_string(),
                            kind: e.into(),
                        });
                        return;
                    }
                }
            }
            debug_recorder.finish();
        };

        Ok(Box::pin(stream))
    }
}

#[cfg(test)]
fn build_gemini_request(request: MessagesRequest) -> Result<String, ApiErrorKind> {
    build_gemini_request_with_extra(request, Map::new())
}

fn build_gemini_request_with_extra(
    request: MessagesRequest,
    extra_body: Map<String, Value>,
) -> Result<String, ApiErrorKind> {
    let response_json_schema = request.response_json_schema.clone();
    let path_first_tools = request.path_first_tools;
    let mut tool_id_to_name: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for msg in &request.messages {
        if let Message::Assistant { content, .. } = msg {
            for block in content {
                if let ContentBlock::ToolUse { id, name, .. } = block {
                    tool_id_to_name.insert(id.clone(), name.clone());
                }
            }
        }
    }

    let mut contents = Vec::new();
    for msg in request.messages {
        let content = match &msg {
            Message::User { content } => content,
            Message::Assistant { content, .. } => content,
        };
        let role = match msg.role() {
            kcoder_types::MessageRole::User => "user",
            _ => "model",
        };

        let mut parts = Vec::new();
        for block in content {
            match block {
                ContentBlock::Text { text } => {
                    parts.push(serde_json::json!({ "text": text }));
                }
                ContentBlock::Image { source } => {
                    parts.push(serde_json::json!({
                        "inlineData": {
                            "mimeType": source.media_type,
                            "data": source.data,
                        }
                    }));
                }
                ContentBlock::ToolUse { id, name, input } => {
                    let _ = id;
                    parts.push(serde_json::json!({
                        "functionCall": {
                            "name": name,
                            "args": input,
                        }
                    }));
                }
                ContentBlock::ToolResult {
                    tool_use_id,
                    content: inner,
                    ..
                } => {
                    let name = tool_id_to_name
                        .get(tool_use_id)
                        .cloned()
                        .unwrap_or_else(|| tool_use_id.clone());
                    let result = inner
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    parts.push(serde_json::json!({
                        "functionResponse": {
                            "name": name,
                            "response": { "result": result },
                        }
                    }));
                }
                _ => {}
            }
        }

        if !parts.is_empty() {
            contents.push(serde_json::json!({ "role": role, "parts": parts }));
        }
    }

    let mut payload = serde_json::json!({
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": request.max_tokens,
        },
    });
    if let Some(response_json_schema) = response_json_schema {
        payload["generationConfig"]["responseMimeType"] = Value::String("application/json".into());
        payload["generationConfig"]["responseSchema"] = response_json_schema.schema;
    }

    if let Some(system) = request.system {
        payload["systemInstruction"] = serde_json::json!({
            "role": "system",
            "parts": [{ "text": system }],
        });
    }

    if !request.tools.is_empty() {
        let declarations: Vec<Value> = request
            .tools
            .into_iter()
            .map(tool_definition_to_gemini)
            .collect();
        payload["tools"] = serde_json::json!([{ "functionDeclarations": declarations }]);
    }
    if let Value::Object(payload) = &mut payload {
        payload.extend(extra_body);
    }

    super::path_first::serialize(
        &payload,
        path_first_tools,
        super::path_first::Format::Gemini,
    )
    .map_err(|e| ApiErrorKind::JsonParse(e, "<gemini request serialization>".to_string()))
}

fn gemini_request_summary(request: &MessagesRequest, effective_model: &str) -> String {
    let system_chars = request
        .system
        .as_ref()
        .map(|system| system.chars().count())
        .unwrap_or(0);
    format!(
        "model={}, max_tokens={}, messages={}, tools={}, system_chars={}",
        effective_model,
        request.max_tokens,
        request.messages.len(),
        request.tools.len(),
        system_chars
    )
}

fn tool_definition_to_gemini(tool: ToolDefinition) -> Value {
    serde_json::json!({
        "name": tool.name,
        "description": tool.description,
        "parameters": tool.input_schema,
    })
}

fn parse_api_error(text: &str) -> Option<ApiErrorKind> {
    #[derive(Deserialize)]
    struct ErrorWrapper {
        error: GeminiApiError,
    }
    #[derive(Deserialize)]
    struct GeminiApiError {
        #[serde(default)]
        code: i32,
        message: String,
        #[serde(default)]
        status: String,
    }

    let wrapped: ErrorWrapper = serde_json::from_str(text).ok()?;
    let error_type = match (wrapped.error.status.as_str(), wrapped.error.code) {
        (_, 401 | 403) => "authentication_error".to_string(),
        ("RESOURCE_EXHAUSTED", 429) => "rate_limit_error".to_string(),
        ("UNAVAILABLE", 503) | ("INTERNAL", 500) => "overloaded_error".to_string(),
        _ => format!("{} {}", wrapped.error.status, wrapped.error.code),
    };
    Some(ApiErrorKind::Api {
        error_type,
        message: wrapped.error.message,
    })
}

fn validate_event_data(data: &str) -> Result<(), ApiErrorKind> {
    if data.trim().is_empty() {
        return Ok(());
    }
    if let Some(err) = parse_api_error(data) {
        return Err(err);
    }
    Ok(())
}

/// Engine-facing block index allocator shared across SSE chunks. Each chunk
/// is parsed independently; without a persistent counter every chunk would
/// restart at index 0 and the engine would overwrite blocks accumulated from
/// earlier chunks (and cross-chunk tool call ids would collide).
#[derive(Default)]
struct GeminiStreamState {
    next_block_index: usize,
}

fn parse_gemini_chunk(data: &str, state: &mut GeminiStreamState) -> Vec<StreamEvent> {
    let response: GeminiResponse = match serde_json::from_str(data) {
        Ok(r) => r,
        Err(e) => {
            return vec![StreamEvent::Error {
                error: kcoder_types::ApiError {
                    error_type: "json_parse".to_string(),
                    message: format!("{}: {}", e, data),
                },
            }];
        }
    };

    let mut events = Vec::new();

    if let Some(metadata) = response.usage_metadata {
        events.push(StreamEvent::MessageDelta {
            delta: kcoder_types::MessageDeltaFields {
                stop_reason: response
                    .candidates
                    .as_ref()
                    .and_then(|c| c.first())
                    .and_then(|c| c.finish_reason.clone()),
                stop_sequence: None,
                usage: Some(Usage {
                    input_tokens: metadata.prompt_token_count.unwrap_or(0),
                    output_tokens: metadata.candidates_token_count.unwrap_or(0),
                    total_tokens: metadata.total_token_count.or_else(|| {
                        Some(
                            metadata
                                .prompt_token_count
                                .unwrap_or(0)
                                .saturating_add(metadata.candidates_token_count.unwrap_or(0)),
                        )
                    }),
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: metadata.cached_content_token_count,
                    iterations: None,
                }),
            },
        });
    }

    let Some(candidates) = response.candidates else {
        if events.is_empty() {
            events.push(StreamEvent::Ping);
        }
        return events;
    };

    let Some(candidate) = candidates.into_iter().next() else {
        if events.is_empty() {
            events.push(StreamEvent::Ping);
        }
        return events;
    };

    for part in candidate.content.parts {
        // Allocate a fresh engine-facing block index per part across the whole
        // stream instead of re-indexing from zero per chunk.
        let idx = state.next_block_index;
        state.next_block_index += 1;
        if let Some(text) = part.text {
            if !text.is_empty() {
                events.push(StreamEvent::ContentBlockStart {
                    index: idx,
                    content_block: ContentBlock::Text {
                        text: String::new(),
                    },
                });
                events.push(StreamEvent::ContentBlockDelta {
                    index: idx,
                    delta: ContentDelta::TextDelta { text },
                });
                events.push(StreamEvent::ContentBlockStop { index: idx });
            }
        } else if let Some(call) = part.function_call {
            events.push(StreamEvent::ContentBlockStart {
                index: idx,
                content_block: ContentBlock::ToolUse {
                    id: format!("gemini_tool_{}_{}", candidate.index, idx),
                    name: call.name,
                    input: call.args,
                },
            });
            events.push(StreamEvent::ContentBlockStop { index: idx });
        }
    }

    if let Some(reason) = candidate.finish_reason {
        events.push(StreamEvent::MessageDelta {
            delta: kcoder_types::MessageDeltaFields {
                stop_reason: Some(reason),
                stop_sequence: None,
                usage: None,
            },
        });
        events.push(StreamEvent::MessageStop);
    }

    if events.is_empty() {
        events.push(StreamEvent::Ping);
    }

    events
}

#[derive(Debug, Deserialize)]
struct GeminiResponse {
    #[serde(default)]
    candidates: Option<Vec<GeminiCandidate>>,
    #[serde(default, rename = "usageMetadata")]
    usage_metadata: Option<GeminiUsageMetadata>,
}

#[derive(Debug, Deserialize)]
struct GeminiCandidate {
    // Safety blocks and usage-only chunks omit `content` entirely; without a
    // default those chunks would fail JSON parsing and kill the whole stream.
    #[serde(default)]
    content: GeminiContent,
    #[serde(default)]
    index: usize,
    #[serde(default, rename = "finishReason")]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct GeminiContent {
    #[allow(dead_code)]
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    parts: Vec<GeminiPart>,
}

#[derive(Debug, Deserialize, Default)]
struct GeminiPart {
    #[serde(default)]
    text: Option<String>,
    #[serde(default, rename = "functionCall")]
    function_call: Option<GeminiFunctionCall>,
}

#[derive(Debug, Deserialize)]
struct GeminiFunctionCall {
    name: String,
    #[serde(default)]
    args: Value,
}

#[derive(Debug, Deserialize)]
struct GeminiUsageMetadata {
    #[serde(rename = "promptTokenCount")]
    prompt_token_count: Option<u32>,
    #[serde(rename = "candidatesTokenCount")]
    candidates_token_count: Option<u32>,
    #[serde(rename = "cachedContentTokenCount")]
    cached_content_token_count: Option<u32>,
    #[serde(rename = "totalTokenCount")]
    total_token_count: Option<u32>,
}

#[cfg(test)]
mod tests {
    #[test]
    fn path_first_wire_gemini_final_body() {
        super::super::path_first::tests::assert_final_body(|request| {
            super::build_gemini_request(request).unwrap()
        });
    }
    #[test]
    fn gemini_business_error_pairs_are_explicit() {
        for (status, code, class) in [
            (
                "RESOURCE_EXHAUSTED",
                429,
                crate::NonHttpErrorClass::RateLimited,
            ),
            ("UNAVAILABLE", 503, crate::NonHttpErrorClass::Transient),
            ("INTERNAL", 500, crate::NonHttpErrorClass::Transient),
            ("UNAVAILABLE", 401, crate::NonHttpErrorClass::Permanent),
            (
                "PERMISSION_DENIED",
                403,
                crate::NonHttpErrorClass::Permanent,
            ),
            ("UNKNOWN", 429, crate::NonHttpErrorClass::Permanent),
        ] {
            let error = super::parse_api_error(&serde_json::json!({"error":{"status":status,"code":code,"message":"network 429 stream idle retry_after=99"}}).to_string()).unwrap();
            assert_eq!(error.non_http_error_class(), Some(class), "{status}/{code}");
        }
    }

    use super::*;
    use kcoder_types::{Message, MessagesRequest, ResponseJsonSchema, ToolDefinition};

    #[test]
    fn gemini_request_includes_contents_tools_and_system_instruction() {
        let request = MessagesRequest::new("gemini-1.5-pro", vec![Message::user_text("hello")])
            .with_system("You are a helpful assistant.")
            .with_tools(vec![ToolDefinition {
                name: "read".to_string(),
                description: "read a file".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "file_path": {"type": "string"}
                    },
                    "required": ["file_path"]
                }),
            }]);

        let body = build_gemini_request(request).unwrap();
        let payload: Value = serde_json::from_str(&body).unwrap();

        assert_eq!(payload["generationConfig"]["maxOutputTokens"], 4096);
        assert_eq!(
            payload["systemInstruction"]["parts"][0]["text"],
            "You are a helpful assistant."
        );

        let contents = payload["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 1);
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(contents[0]["parts"][0]["text"], "hello");

        let declarations = payload["tools"][0]["functionDeclarations"]
            .as_array()
            .unwrap();
        assert_eq!(declarations.len(), 1);
        assert_eq!(declarations[0]["name"], "read");
        assert_eq!(declarations[0]["parameters"]["type"], "object");
    }

    #[test]
    fn gemini_request_includes_response_json_schema() {
        let request = MessagesRequest::new("gemini-1.5-pro", vec![Message::user_text("hello")])
            .with_response_json_schema(ResponseJsonSchema::new(
                "observer_draft",
                serde_json::json!({
                    "type": "object",
                    "properties": {
                        "answer": {"type": "string"}
                    },
                    "required": ["answer"]
                }),
            ));

        let body = build_gemini_request(request).unwrap();
        let payload: Value = serde_json::from_str(&body).unwrap();

        assert_eq!(
            payload["generationConfig"]["responseMimeType"],
            "application/json"
        );
        assert_eq!(
            payload["generationConfig"]["responseSchema"]["properties"]["answer"]["type"],
            "string"
        );
    }

    #[test]
    fn gemini_request_maps_tool_use_to_function_call() {
        let request = MessagesRequest::new(
            "gemini-1.5-pro",
            vec![Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "call_1".to_string(),
                    name: "read".to_string(),
                    input: serde_json::json!({"file_path": "/tmp/foo.txt"}),
                }],
                usage: None,
            }],
        );

        let body = build_gemini_request(request).unwrap();
        let payload: Value = serde_json::from_str(&body).unwrap();
        let parts = payload["contents"][0]["parts"].as_array().unwrap();

        assert_eq!(parts[0]["functionCall"]["name"], "read");
        assert_eq!(
            parts[0]["functionCall"]["args"]["file_path"],
            "/tmp/foo.txt"
        );
    }

    #[test]
    fn gemini_request_maps_image_blocks_to_inline_data_parts() {
        let request = MessagesRequest::new(
            "gemini-1.5-pro",
            vec![Message::User {
                content: vec![
                    ContentBlock::Text {
                        text: "describe this".to_string(),
                    },
                    ContentBlock::Image {
                        source: kcoder_types::ImageSource::base64("image/jpeg", "abc123"),
                    },
                ],
            }],
        );

        let body = build_gemini_request(request).unwrap();
        let payload: Value = serde_json::from_str(&body).unwrap();
        let parts = payload["contents"][0]["parts"].as_array().unwrap();

        assert_eq!(parts[0]["text"], "describe this");
        assert_eq!(parts[1]["inlineData"]["mimeType"], "image/jpeg");
        assert_eq!(parts[1]["inlineData"]["data"], "abc123");
    }

    #[test]
    fn gemini_stream_preserves_cached_content_tokens() {
        let mut state = GeminiStreamState::default();
        let events = parse_gemini_chunk(
            r#"{
                "usageMetadata": {
                    "promptTokenCount": 900,
                    "candidatesTokenCount": 40,
                    "cachedContentTokenCount": 768,
                    "totalTokenCount": 940
                }
            }"#,
            &mut state,
        );

        assert!(events.iter().any(|event| matches!(
            event,
            StreamEvent::MessageDelta { delta }
                if delta.usage.as_ref().is_some_and(|usage|
                    usage.input_tokens == 900
                        && usage.output_tokens == 40
                        && usage.cache_read_input_tokens == Some(768)
                        && usage.total_tokens == Some(940)
                )
        )));
    }

    #[test]
    fn gemini_stream_allocates_fresh_block_indices_across_chunks() {
        let mut state = GeminiStreamState::default();
        let first = parse_gemini_chunk(
            r#"{"candidates":[{"content":{"parts":[{"text":"第一"}],"role":"model"}}]}"#,
            &mut state,
        );
        let second = parse_gemini_chunk(
            r#"{"candidates":[{"content":{"parts":[{"text":"第二"}],"role":"model"}}]}"#,
            &mut state,
        );

        let first_index = match first.first() {
            Some(StreamEvent::ContentBlockStart { index, .. }) => *index,
            other => panic!("expected ContentBlockStart, got {other:?}"),
        };
        let second_index = match second.first() {
            Some(StreamEvent::ContentBlockStart { index, .. }) => *index,
            other => panic!("expected ContentBlockStart, got {other:?}"),
        };
        assert_ne!(
            first_index, second_index,
            "blocks from later chunks must not overwrite earlier ones"
        );
    }

    #[test]
    fn gemini_stream_tolerates_chunks_without_content() {
        let mut state = GeminiStreamState::default();
        // Safety-blocked chunks carry finishReason but no content field.
        let events =
            parse_gemini_chunk(r#"{"candidates":[{"finishReason":"SAFETY"}]}"#, &mut state);

        assert!(
            !events
                .iter()
                .any(|event| matches!(event, StreamEvent::Error { .. })),
            "contentless chunks must not kill the stream: {events:?}"
        );
    }

    #[test]
    fn gemini_request_summary_omits_prompt_and_tool_input_content() {
        let request = MessagesRequest::new(
            "gemini-1.5-pro",
            vec![
                Message::user_text("secret user prompt"),
                Message::Assistant {
                    content: vec![ContentBlock::ToolUse {
                        id: "call_1".to_string(),
                        name: "read".to_string(),
                        input: serde_json::json!({"file_path": "/tmp/secret.rs"}),
                    }],
                    usage: None,
                },
            ],
        )
        .with_system("secret system prompt")
        .with_tools(vec![ToolDefinition {
            name: "read".to_string(),
            description: "read a file".to_string(),
            input_schema: serde_json::json!({"type": "object"}),
        }])
        .with_max_tokens(128);

        let summary = gemini_request_summary(&request, "gemini-effective");

        assert!(summary.contains("model=gemini-effective"));
        assert!(summary.contains("max_tokens=128"));
        assert!(summary.contains("messages=2"));
        assert!(summary.contains("tools=1"));
        assert!(summary.contains("system_chars=20"));
        assert!(!summary.contains("secret user prompt"));
        assert!(!summary.contains("secret system prompt"));
        assert!(!summary.contains("/tmp/secret.rs"));
    }

    #[test]
    fn provider_error_summary_gemini_hides_sensitive_tokens() {
        let error = parse_api_error(r#"{"error":{"status":"UNAUTHENTICATED","code":401,"message":"SENTINEL_PRIVATE Bearer multiple words api_key=sk-cp-secret token=abc"}}"#).unwrap();
        let summary = error.to_string();
        assert!(summary.contains("authentication_error"));
        assert!(!summary.contains("SENTINEL_PRIVATE"));
        assert!(!summary.contains("sk-cp-secret"));
        assert!(!summary.contains("token=abc"));
    }
}

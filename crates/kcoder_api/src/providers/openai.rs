mod message_lifecycle;
mod tool_result_images;

use crate::ApiErrorKind;
use crate::providers::debug_log::LlmDebugRecorder;
use crate::providers::{
    ModelDiscoveryOptions, Provider, ProviderModelDiscovery, ProviderStream,
    SLIME_AGENT_DEPTH_HEADER, SLIME_REASONING_REPLAY_HEADER, model_list_url,
    parse_model_list_response,
};
use eventsource_stream::Eventsource as _;
use futures::StreamExt;
use kcoder_config::{
    ApiFormat, DEFAULT_LOCAL_ENDPOINT, DEFAULT_OPENAI_ENDPOINT, DEFAULT_REQUEST_TIMEOUT_SECS,
};
use kcoder_types::{ContentBlock, ContentDelta, Message, MessagesRequest, StreamEvent, Usage};
use reqwest::header::{self, HeaderMap, HeaderValue};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::time::Duration;
use tracing::debug;

const DEFAULT_USER_AGENT: &str = "kcoder-rust/0.1.0";

#[derive(Debug, Clone)]
pub struct OpenAiProvider {
    client: reqwest::Client,
    api_key: Option<String>,
    base_url: String,
    user_agent: String,
    provider_name: &'static str,
    include_stream_options: bool,
    replay_reasoning_content: bool,
    finish_reason_eof: bool,
    extra_body: Map<String, Value>,
    timeout_secs: u64,
    no_proxy: bool,
    proxy_url: Option<String>,
    api_format: ApiFormat,
}

impl OpenAiProvider {
    pub fn new(
        api_key: impl Into<String>,
        _model: impl Into<String>,
    ) -> Result<Self, ApiErrorKind> {
        Ok(Self {
            client: build_client(DEFAULT_REQUEST_TIMEOUT_SECS, false, None)?,
            api_key: Some(api_key.into()),
            base_url: DEFAULT_OPENAI_ENDPOINT.to_string(),
            user_agent: DEFAULT_USER_AGENT.to_string(),
            provider_name: "openai",
            include_stream_options: true,
            replay_reasoning_content: false,
            finish_reason_eof: false,
            extra_body: Map::new(),
            timeout_secs: DEFAULT_REQUEST_TIMEOUT_SECS,
            no_proxy: false,
            proxy_url: None,
            api_format: ApiFormat::OpenaiChatCompletions,
        })
    }

    pub fn local_compatible() -> Result<Self, ApiErrorKind> {
        Ok(Self {
            client: build_client(DEFAULT_REQUEST_TIMEOUT_SECS, true, None)?,
            api_key: None,
            base_url: DEFAULT_LOCAL_ENDPOINT.to_string(),
            user_agent: DEFAULT_USER_AGENT.to_string(),
            provider_name: "local",
            include_stream_options: false,
            replay_reasoning_content: true,
            finish_reason_eof: false,
            extra_body: Map::new(),
            timeout_secs: DEFAULT_REQUEST_TIMEOUT_SECS,
            no_proxy: true,
            proxy_url: None,
            api_format: ApiFormat::OpenaiChatCompletions,
        })
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    #[cfg(test)]
    pub(crate) fn base_url_for_test(&self) -> &str {
        &self.base_url
    }

    pub fn with_optional_api_key(mut self, api_key: Option<String>) -> Self {
        self.api_key = api_key.filter(|key| !key.trim().is_empty());
        self
    }

    pub fn with_user_agent(mut self, user_agent: impl Into<String>) -> Self {
        self.user_agent = user_agent.into();
        self
    }

    pub fn with_timeout_secs(mut self, timeout_secs: u64) -> Result<Self, ApiErrorKind> {
        let timeout_secs = timeout_secs.max(1);
        self.client = build_client(timeout_secs, self.no_proxy, self.proxy_url.as_deref())?;
        self.timeout_secs = timeout_secs;
        Ok(self)
    }

    pub fn with_no_proxy(mut self, no_proxy: bool) -> Result<Self, ApiErrorKind> {
        self.client = build_client(self.timeout_secs, no_proxy, self.proxy_url.as_deref())?;
        self.no_proxy = no_proxy;
        Ok(self)
    }

    pub fn with_proxy_url(mut self, proxy_url: Option<String>) -> Result<Self, ApiErrorKind> {
        self.proxy_url = proxy_url.filter(|value| !value.trim().is_empty());
        self.client = build_client(self.timeout_secs, self.no_proxy, self.proxy_url.as_deref())?;
        Ok(self)
    }

    #[cfg(test)]
    pub(crate) fn timeout_secs_for_test(&self) -> u64 {
        self.timeout_secs
    }

    pub fn with_provider_name(mut self, provider_name: &'static str) -> Self {
        self.provider_name = provider_name;
        self
    }

    /// MiniMax declares reasoning_content and may end a completed SSE stream at EOF.
    pub(crate) fn with_minimax_protocol(mut self) -> Self {
        self.provider_name = "minimax";
        self.replay_reasoning_content = true;
        self.finish_reason_eof = true;
        self
    }

    pub fn with_stream_options(mut self, include_stream_options: bool) -> Self {
        self.include_stream_options = include_stream_options;
        self
    }

    pub fn with_api_format(mut self, api_format: ApiFormat) -> Self {
        self.api_format = api_format;
        self
    }

    pub fn with_extra_body_field(mut self, key: impl Into<String>, value: Value) -> Self {
        self.extra_body.insert(key.into(), value);
        self
    }

    fn chat_completions_url(&self) -> String {
        chat_completions_url(&self.base_url)
    }

    fn responses_url(&self) -> String {
        responses_url(&self.base_url)
    }

    fn headers(&self) -> Result<HeaderMap, ApiErrorKind> {
        let mut headers = HeaderMap::new();
        if let Some(api_key) = &self.api_key {
            headers.insert(
                header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {}", api_key))?,
            );
        }
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        headers.insert(header::USER_AGENT, HeaderValue::from_str(&self.user_agent)?);
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
        if self.replay_reasoning_content && !self.finish_reason_eof {
            headers.insert(SLIME_REASONING_REPLAY_HEADER, HeaderValue::from_static("1"));
        }
        Ok(headers)
    }
}

fn build_client(
    timeout_secs: u64,
    no_proxy: bool,
    proxy_url: Option<&str>,
) -> Result<reqwest::Client, ApiErrorKind> {
    // `ClientBuilder::timeout` is a wall-clock timeout for the whole response
    // body, including SSE. Use it only for connection establishment so active
    // reasoning/final-output streams are never cut off mid-response.
    let mut builder = reqwest::Client::builder().connect_timeout(Duration::from_secs(timeout_secs));
    if let Some(proxy_url) = proxy_url {
        builder = builder.proxy(reqwest::Proxy::all(proxy_url)?);
    } else if no_proxy {
        builder = builder.no_proxy();
    }
    Ok(builder.build()?)
}

impl Provider for OpenAiProvider {
    fn supports_reasoning_suppression(&self, parameter: crate::RejectedReasoningParameter) -> bool {
        use crate::RejectedReasoningParameter::*;
        match self.api_format {
            ApiFormat::OpenaiChatCompletions => parameter == ReasoningEffort,
            ApiFormat::OpenaiResponses => matches!(parameter, Reasoning | ReasoningDotEffort),
            _ => false,
        }
    }

    fn name(&self) -> &'static str {
        self.provider_name
    }

    fn supports_response_json_schema(&self) -> bool {
        true
    }

    fn endpoint(&self) -> Option<&str> {
        Some(&self.base_url)
    }

    fn api_key_configured(&self) -> Option<bool> {
        Some(self.api_key.is_some())
    }

    fn request_timeout_secs(&self) -> Option<u64> {
        Some(self.timeout_secs)
    }

    fn prewarm(&self) -> crate::providers::ProviderPrewarm {
        let client = self.client.clone();
        let url = self.chat_completions_url();
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
        let model = request.model.clone();
        let stream = if self.api_format == ApiFormat::OpenaiResponses {
            self.stream_responses(request)?
        } else {
            self.stream_chat_completions(request)?
        };
        Ok(message_lifecycle::with_message_lifecycle(stream, model))
    }
}

impl OpenAiProvider {
    fn stream_chat_completions(
        &self,
        request: MessagesRequest,
    ) -> Result<ProviderStream, ApiErrorKind> {
        let response_limits = request.response_limits;
        let prepared_at = std::time::Instant::now();
        let url = self.chat_completions_url();
        let request_summary = openai_request_summary(&request);
        let debug_session_id = request.debug_session_id.clone();
        let headers = self.headers_for_request(&request)?;
        let body = build_openai_request_with_options(
            request,
            OpenAiRequestOptions {
                include_stream_options: self.include_stream_options,
                replay_reasoning_content: self.replay_reasoning_content,
                extra_body: self.extra_body.clone(),
            },
        )?;
        let prepared = prepared_at.elapsed();
        let request_body_bytes = body.len();
        let request_summary = format!("{request_summary}, body_bytes={}", body.len());
        debug!("POST {} with {}", url, request_summary);

        let client = self.client.clone();
        let provider_name = self.provider_name;
        let finish_reason_eof = self.finish_reason_eof;
        let mut debug_recorder =
            LlmDebugRecorder::new(provider_name, debug_session_id.as_deref(), &url, &body);
        let stream = async_stream::stream! {
            use super::transport_metrics::{Outcome, Protocol, TransportMetrics};
            let mut metrics = TransportMetrics::new(Protocol::Chat, prepared, request_body_bytes);
            let response = match client.post(&url).headers(headers).body(body).send().await {
                Ok(response) => response,
                Err(error) => {
                    metrics.outcome(Outcome::NetworkError);
                    debug_recorder.record_error(error.to_string());
                    debug_recorder.finish();
                    yield Err(ApiErrorKind::Network(error));
                    return;
                }
            };

            let status = response.status();
            metrics.status(status.as_u16());
            debug_recorder.record_status(status.as_u16());
            debug_recorder.record_headers(response.headers());
            if !status.is_success() {
                metrics.outcome(Outcome::HttpError);
                let request_id = openai_header_request_id(response.headers())
                    .unwrap_or_else(|| "unknown".to_string());
                let retry_after = super::retry_after_hint(response.headers());
                let text = super::bounded_body::read(response, super::bounded_body::ERROR_BODY_LIMIT).await.unwrap_or_default();
                debug_recorder.record_body(&text);
                let details = parse_openai_error_details(&text);
                let request_id = details.request_id.clone().unwrap_or(request_id);
                debug_recorder.record_error(format!("http status {}", status.as_u16()));
                debug_recorder.finish();
                yield Err(ApiErrorKind::Http {
                    metadata: crate::HttpErrorMetadata::from_response(status.as_u16(), &text, retry_after.as_deref()),
                    error_type: details
                        .error_type
                        .clone()
                        .unwrap_or_else(|| status.to_string()),
                    message: {
                        let mut message = format_openai_api_error_message(
                            provider_name,
                            status.as_u16(),
                            &request_id,
                            &details,
                            &text,
                            &request_summary,
                        );
                        if let Some(after) = retry_after {
                            message.push_str(&format!("; retry_after={after}"));
                        }
                        message
                    },
                });
                return;
            }

            let mut events = super::bounded_sse::chunks(response.bytes_stream()).eventsource();
            let mut state = OpenAiStreamState {
                budget: crate::response_budget::ResponseBudget::new(response_limits),
                ..Default::default()
            };
            while let Some(event) = events.next().await {
                match event {
                    Ok(msg) => {
                        metrics.sse();
                        if msg.data.trim() == "[DONE]" {
                            debug_recorder.record_sse_event(&msg.event, &msg.data);
                            if let Err(error) = state.finalize_tool_calls() {
                                metrics.outcome(Outcome::ResponseError);
                                debug_recorder.record_error(error.to_string());
                                debug_recorder.finish();
                                yield Err(error);
                                return;
                            }
                            state.pending.push(StreamEvent::MessageStop);
                            state.done = true;
                            metrics.outcome(Outcome::UpstreamCompleted);
                            while let Some(event) = state.flush_pending() {
                                metrics.event(&event);
                                yield Ok(event);
                            }
                            debug_recorder.finish();
                            return;
                        }

                        let chunk = match parse_openai_stream_chunk(&msg.data) {
                            Ok(chunk) => chunk,
                            Err(error) => {
                                metrics.outcome(Outcome::ResponseError);
                                debug_recorder.record_failed_sse_event();
                                debug_recorder.record_error(error.to_string());
                                debug_recorder.finish();
                                yield Err(error);
                                return;
                            }
                        };
                        debug_recorder.record_sse_event(&msg.event, &msg.data);
                        if let Err(error) = state.process_chunk(chunk) {
                            metrics.outcome(Outcome::ResponseError);
                            debug_recorder.record_error(error.to_string());
                            debug_recorder.finish();
                            yield Err(error);
                            return;
                        }
                        while let Some(event) = state.flush_pending() {
                            metrics.event(&event);
                            yield Ok(event);
                        }
                    }
                    Err(error) => {
                        metrics.outcome(Outcome::StreamError);
                        debug_recorder.record_error(error.to_string());
                        debug_recorder.finish();
                        yield Err(ApiErrorKind::SseStream {
                            error_type: "sse_stream".to_string(),
                            message: redact_sensitive_text(&error.to_string()),
                            kind: error.into(),
                        });
                        return;
                    }
                }
            }

            if finish_reason_eof && state.finish_reason.is_some() {
                if let Err(error) = state.finalize_tool_calls() {
                    metrics.outcome(Outcome::ResponseError);
                    debug_recorder.record_error(error.to_string());
                    debug_recorder.finish();
                    yield Err(error);
                    return;
                }
                metrics.outcome(Outcome::UpstreamCompleted);
                while let Some(event) = state.flush_pending() {
                    metrics.event(&event);
                    yield Ok(event);
                }
                yield Ok(StreamEvent::MessageStop);
                debug_recorder.finish();
                return;
            }

            if !state.done {
                metrics.outcome(Outcome::Incomplete);
                debug_recorder.record_error("stream closed before [DONE]".to_string());
                debug_recorder.finish();
                yield Err(ApiErrorKind::Api {
                    error_type: "stream_incomplete".to_string(),
                    message: "OpenAI SSE stream closed before [DONE]".to_string(),
                });
            }
        };

        Ok(Box::pin(stream))
    }
}

impl OpenAiProvider {
    fn stream_responses(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        let response_limits = request.response_limits;
        let prepared_at = std::time::Instant::now();
        let url = self.responses_url();
        let request_summary = openai_request_summary(&request);
        let debug_session_id = request.debug_session_id.clone();
        let headers = self.headers_for_request(&request)?;
        let body = build_openai_responses_request(request, self.extra_body.clone())?;
        let prepared = prepared_at.elapsed();
        let request_body_bytes = body.len();
        let client = self.client.clone();
        let provider_name = self.provider_name;
        let mut debug_recorder =
            LlmDebugRecorder::new(provider_name, debug_session_id.as_deref(), &url, &body);
        let stream = async_stream::stream! {
            use super::transport_metrics::{Outcome, Protocol, TransportMetrics};
            let mut metrics = TransportMetrics::new(Protocol::Responses, prepared, request_body_bytes);
            let response = match client.post(&url).headers(headers).body(body).send().await {
                Ok(response) => response,
                Err(error) => {
                    metrics.outcome(Outcome::NetworkError);
                    debug_recorder.record_error(error.to_string());
                    debug_recorder.finish();
                    yield Err(ApiErrorKind::Network(error));
                    return;
                }
            };
            let status = response.status();
            metrics.status(status.as_u16());
            debug_recorder.record_status(status.as_u16());
            debug_recorder.record_headers(response.headers());
            if !status.is_success() {
                metrics.outcome(Outcome::HttpError);
                let request_id = openai_header_request_id(response.headers())
                    .unwrap_or_else(|| "unknown".to_string());
                let retry_after = super::retry_after_hint(response.headers());
                let text = super::bounded_body::read(response, super::bounded_body::ERROR_BODY_LIMIT).await.unwrap_or_default();
                debug_recorder.record_body(&text);
                let details = parse_openai_error_details(&text);
                debug_recorder.finish();
                yield Err(ApiErrorKind::Http {
                    metadata: crate::HttpErrorMetadata::from_response(status.as_u16(), &text, retry_after.as_deref()),
                    error_type: details
                        .error_type
                        .clone()
                        .unwrap_or_else(|| status.to_string()),
                    message: {
                        let mut message = format_openai_api_error_message(
                            provider_name,
                            status.as_u16(),
                            &request_id,
                            &details,
                            &text,
                            &request_summary,
                        );
                        if let Some(after) = retry_after {
                            message.push_str(&format!("; retry_after={after}"));
                        }
                        message
                    },
                });
                return;
            }

            let mut events = super::bounded_sse::chunks(response.bytes_stream()).eventsource();
            let mut state = ResponsesStreamState {
                budget: crate::response_budget::ResponseBudget::new(response_limits),
                ..Default::default()
            };
            while let Some(event) = events.next().await {
                match event {
                    Ok(message) => {
                        metrics.sse();
                        if let Err(error) = state.process(&message.event, &message.data) {
                            metrics.outcome(Outcome::ResponseError);
                            debug_recorder.record_failed_sse_event();
                            debug_recorder.finish();
                            yield Err(error);
                            return;
                        }
                        debug_recorder.record_sse_event(&message.event, &message.data);
                        if state.done { metrics.outcome(Outcome::UpstreamCompleted); }
                        while let Some(event) = state.flush_pending() {
                            metrics.event(&event);
                            yield Ok(event);
                        }
                        if state.done {
                            debug_recorder.finish();
                            return;
                        }
                    }
                    Err(error) => {
                        metrics.outcome(Outcome::StreamError);
                        debug_recorder.finish();
                        yield Err(ApiErrorKind::SseStream {
                            error_type: "sse_stream".to_string(),
                            message: redact_sensitive_text(&error.to_string()),
                            kind: error.into(),
                        });
                        return;
                    }
                }
            }
            if !state.done {
                metrics.outcome(Outcome::Incomplete);
                yield Err(ApiErrorKind::Api {
                    error_type: "stream_incomplete".to_string(),
                    message: "OpenAI Responses stream closed before response.completed"
                        .to_string(),
                });
            }
            debug_recorder.finish();
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug, Clone)]
struct OpenAiRequestOptions {
    include_stream_options: bool,
    replay_reasoning_content: bool,
    extra_body: Map<String, Value>,
}

impl Default for OpenAiRequestOptions {
    fn default() -> Self {
        Self {
            include_stream_options: true,
            replay_reasoning_content: false,
            extra_body: Map::new(),
        }
    }
}

fn chat_completions_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{}/chat/completions", trimmed)
    }
}

fn responses_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/responses") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/responses")
    }
}

fn openai_request_summary(request: &MessagesRequest) -> String {
    format!(
        "model={}, max_tokens={}, messages={}, tools={}",
        request.model,
        request.max_tokens,
        request.messages.len(),
        request.tools.len()
    )
}

fn openai_header_request_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-request-id")
        .or_else(|| headers.get("request-id"))
        .or_else(|| headers.get("x-correlation-id"))
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
}

#[derive(Debug, Default, PartialEq, Eq)]
struct OpenAiErrorDetails {
    error_type: Option<String>,
    message: Option<String>,
    code: Option<String>,
    param: Option<String>,
    request_id: Option<String>,
}

fn parse_openai_error_details(body: &str) -> OpenAiErrorDetails {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return OpenAiErrorDetails::default();
    };
    let error = value.get("error").unwrap_or(&value);
    OpenAiErrorDetails {
        error_type: json_string(error.get("type")).or_else(|| json_string(value.get("type"))),
        message: json_string(error.get("message")).or_else(|| json_string(value.get("message"))),
        code: json_string(error.get("code")).or_else(|| json_string(value.get("code"))),
        param: json_string(error.get("param")),
        request_id: json_string(value.get("request_id"))
            .or_else(|| json_string(error.get("request_id")))
            .or_else(|| json_string(value.get("id"))),
    }
}

fn json_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(boolean) => Some(boolean.to_string()),
        _ => None,
    }
}

fn format_openai_api_error_message(
    provider_name: &str,
    status: u16,
    request_id: &str,
    details: &OpenAiErrorDetails,
    body: &str,
    request_summary: &str,
) -> String {
    let mut parts = vec![
        format!("provider={provider_name}"),
        format!("status={status}"),
        format!("request_id={request_id}"),
    ];
    if let Some(error_type) = &details.error_type {
        parts.push(format!("type={}", redact_sensitive_text(error_type)));
    }
    if let Some(code) = &details.code {
        parts.push(format!("code={}", redact_sensitive_text(code)));
    }
    if let Some(param) = &details.param {
        parts.push(format!("param={}", redact_sensitive_text(param)));
    }
    if let Some(message) = &details.message {
        parts.push(format!("message={}", redact_sensitive_text(message)));
    }
    parts.push(format!("request={request_summary}"));
    if !body.trim().is_empty() {
        parts.push(format!(
            "response={}",
            truncate_for_log(&redact_sensitive_text(body), 4096)
        ));
    }
    parts.join(", ")
}

pub(super) fn redact_sensitive_text(input: &str) -> String {
    input
        .split_whitespace()
        .map(redact_sensitive_token)
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn redact_sensitive_token(token: &str) -> String {
    let lower = token.to_ascii_lowercase();
    let sensitive_assignment = ["api_key", "apikey", "password", "token", "authorization"]
        .iter()
        .any(|needle| lower.contains(needle));
    if sensitive_assignment || lower.contains("sk-") || lower.contains("sk_") {
        return "[redacted]".to_string();
    }
    token.to_string()
}

fn truncate_for_log(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

#[cfg(test)]
fn build_openai_request(request: MessagesRequest) -> Result<String, ApiErrorKind> {
    build_openai_request_with_options(request, OpenAiRequestOptions::default())
}

fn build_openai_request_with_options(
    request: MessagesRequest,
    options: OpenAiRequestOptions,
) -> Result<String, ApiErrorKind> {
    let reasoning_effort = request.reasoning_effort.clone();
    let path_first_tools = request.path_first_tools;
    let response_json_schema = request.response_json_schema.clone();
    let mut messages = Vec::new();

    if let Some(system) = request.system {
        messages.push(json_message("system", system));
    }

    let mut tool_images = Vec::new();
    for msg in request.messages {
        if !tool_result_images::has_tool_results(&msg) {
            messages.append(&mut tool_images);
        }
        tool_images.extend(tool_result_images::followups(&msg, false));
        match msg {
            Message::User { content, .. } => {
                // OpenAI represents each tool result as a separate "tool" role
                // message, so split text and tool results into distinct messages.
                let mut user_message = OpenAiUserMessageBuilder::default();
                for block in &content {
                    match block {
                        ContentBlock::Text { text } => user_message.push_text(text),
                        ContentBlock::Image { source } => user_message.push_image(source),
                        ContentBlock::ToolResult {
                            tool_use_id,
                            content: inner,
                            ..
                        } => {
                            if let Some(message) = user_message.take_message() {
                                messages.push(message);
                            }
                            messages.push(serde_json::json!({
                                "role": "tool",
                                "tool_call_id": tool_use_id,
                                "content": text_blocks_to_string(inner),
                            }));
                        }
                        _ => {}
                    }
                }
                if let Some(message) = user_message.take_message() {
                    messages.push(message);
                }
            }
            Message::Assistant { content, .. } => {
                // Assistant messages may contain both text and tool_use blocks.
                // Preserve reasoning_content and tool_calls so compatible chat templates can
                // replay the previous prefix token by token and keep tool results associated with their original calls.
                let mut reasoning_parts = Vec::new();
                let mut text_parts = Vec::new();
                let mut tool_calls = Vec::new();
                for block in &content {
                    match block {
                        ContentBlock::Thinking { thinking, .. }
                            if options.replay_reasoning_content && !thinking.is_empty() =>
                        {
                            reasoning_parts.push(thinking.clone());
                        }
                        ContentBlock::Text { text } => text_parts.push(text.clone()),
                        ContentBlock::ToolUse { id, name, input } => {
                            tool_calls.push(serde_json::json!({
                                "id": id,
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": input.to_string(),
                                }
                            }))
                        }
                        _ => {}
                    }
                }
                if !reasoning_parts.is_empty() || !text_parts.is_empty() || !tool_calls.is_empty() {
                    let mut msg = serde_json::json!({"role": "assistant", "content": null});
                    if !reasoning_parts.is_empty() {
                        // Thinking deltas already accumulate in stream order within one ContentBlock.
                        // Even with multiple historical blocks, do not insert synthetic newlines or split the training prefix again.
                        msg["reasoning_content"] = Value::String(reasoning_parts.concat());
                    }
                    if !text_parts.is_empty() {
                        msg["content"] = Value::String(text_parts.join("\n"));
                    }
                    if !tool_calls.is_empty() {
                        msg["tool_calls"] = Value::Array(tool_calls);
                    }
                    messages.push(msg);
                }
            }
        }
    }

    messages.append(&mut tool_images);
    let mut payload = serde_json::json!({
        "model": request.model,
        "messages": messages,
        "stream": true,
        "max_tokens": request.max_tokens,
    });
    if options.include_stream_options {
        payload["stream_options"] = serde_json::json!({ "include_usage": true });
    }
    if let Some(reasoning_effort) = reasoning_effort {
        payload["reasoning_effort"] = Value::String(reasoning_effort.to_string());
    }
    if let Some(response_json_schema) = response_json_schema {
        let mut json_schema = serde_json::json!({
            "name": response_json_schema.name,
            "strict": response_json_schema.strict,
            "schema": normalize_schema_for_openai(response_json_schema.schema),
        });
        if let Some(description) = response_json_schema.description {
            json_schema["description"] = Value::String(description);
        }
        payload["response_format"] = serde_json::json!({
            "type": "json_schema",
            "json_schema": json_schema,
        });
    }
    if let Value::Object(payload_object) = &mut payload {
        for (key, value) in options.extra_body {
            payload_object.insert(key, value);
        }
        if request.recovery_disable_reasoning {
            payload_object.remove("reasoning_effort");
        }
    }

    if !request.tools.is_empty() {
        let tools: Vec<Value> = request
            .tools
            .into_iter()
            .map(|tool| {
                let parameters = normalize_schema_for_openai(tool.input_schema);
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": parameters,
                    }
                })
            })
            .collect();
        payload["tools"] = Value::Array(tools);
        payload["tool_choice"] = Value::String("auto".to_string());
    }

    super::path_first::serialize(&payload, path_first_tools, super::path_first::Format::Chat)
        .map_err(|e| ApiErrorKind::JsonParse(e, "<openai request serialization>".to_string()))
}

fn build_openai_responses_request(
    request: MessagesRequest,
    extra_body: Map<String, Value>,
) -> Result<String, ApiErrorKind> {
    let path_first_tools = request.path_first_tools;
    let mut input = Vec::new();
    let mut tool_images = Vec::new();
    for message in request.messages {
        if !tool_result_images::has_tool_results(&message) {
            input.append(&mut tool_images);
        }
        tool_images.extend(tool_result_images::followups(&message, true));
        match message {
            Message::User { content, .. } => {
                let mut parts = Vec::new();
                for block in content {
                    match block {
                        ContentBlock::Text { text } => parts.push(serde_json::json!({
                            "type": "input_text", "text": text
                        })),
                        ContentBlock::Image { source } => {
                            if let Some(url) = image_source_url(&source) {
                                parts.push(serde_json::json!({
                                    "type": "input_image", "image_url": url
                                }));
                            }
                        }
                        ContentBlock::ToolResult {
                            tool_use_id,
                            content,
                            ..
                        } => input.push(serde_json::json!({
                            "type": "function_call_output",
                            "call_id": tool_use_id,
                            "output": text_blocks_to_string(&content),
                        })),
                        _ => {}
                    }
                }
                if !parts.is_empty() {
                    input.push(serde_json::json!({"role": "user", "content": parts}));
                }
            }
            Message::Assistant { content, .. } => {
                let mut parts = Vec::new();
                for block in content {
                    match block {
                        ContentBlock::Text { text } => parts.push(serde_json::json!({
                            "type": "output_text", "text": text
                        })),
                        ContentBlock::ToolUse {
                            id,
                            name,
                            input: arguments,
                        } => {
                            input.push(serde_json::json!({
                                "type": "function_call",
                                "call_id": id,
                                "name": name,
                                "arguments": arguments.to_string(),
                            }));
                        }
                        _ => {}
                    }
                }
                if !parts.is_empty() {
                    input.push(serde_json::json!({"role": "assistant", "content": parts}));
                }
            }
        }
    }

    input.append(&mut tool_images);
    let mut payload = serde_json::json!({
        "model": request.model,
        "input": input,
        "stream": true,
        "max_output_tokens": request.max_tokens,
    });
    if let Some(system) = request.system {
        payload["instructions"] = Value::String(system);
    }
    if let Some(effort) = request.reasoning_effort {
        payload["reasoning"] = serde_json::json!({"effort": effort.to_string()});
    }
    if let Some(schema) = request.response_json_schema {
        payload["text"] = serde_json::json!({
            "format": {
                "type": "json_schema",
                "name": schema.name,
                "description": schema.description,
                "strict": schema.strict,
                "schema": normalize_schema_for_openai(schema.schema),
            }
        });
    }
    if !request.tools.is_empty() {
        payload["tools"] = Value::Array(
            request
                .tools
                .into_iter()
                .map(|tool| {
                    serde_json::json!({
                        "type": "function",
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": normalize_schema_for_openai(tool.input_schema),
                        "strict": false,
                    })
                })
                .collect(),
        );
        payload["tool_choice"] = Value::String("auto".to_string());
    }
    if let Value::Object(payload) = &mut payload {
        payload.extend(extra_body);
        if request.recovery_disable_reasoning {
            payload.remove("reasoning");
        }
    }
    super::path_first::serialize(
        &payload,
        path_first_tools,
        super::path_first::Format::Responses,
    )
    .map_err(|error| ApiErrorKind::JsonParse(error, "<responses request>".to_string()))
}

fn image_source_url(source: &kcoder_types::ImageSource) -> Option<String> {
    if source.source_type == "base64" {
        Some(format!("data:{};base64,{}", source.media_type, source.data))
    } else {
        None
    }
}

#[derive(Default)]
struct ResponsesStreamState {
    budget: crate::response_budget::ResponseBudget,
    pending: Vec<StreamEvent>,
    text_index: Option<usize>,
    thinking_index: Option<usize>,
    next_index: usize,
    tool_indices: HashMap<String, usize>,
    done: bool,
}

impl ResponsesStreamState {
    fn flush_pending(&mut self) -> Option<StreamEvent> {
        if self.pending.is_empty() {
            None
        } else {
            Some(self.pending.remove(0))
        }
    }

    fn process(&mut self, event: &str, data: &str) -> Result<(), ApiErrorKind> {
        let value: Value = serde_json::from_str(data)
            .map_err(|error| ApiErrorKind::JsonParse(error, data.to_string()))?;
        match event {
            "response.output_text.delta" => {
                let delta = value
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if self.text_index.is_none() {
                    self.budget.start(self.next_index, false, 0)?;
                    self.text_index = Some(self.next_index);
                    self.next_index += 1;
                    self.pending.push(StreamEvent::ContentBlockStart {
                        index: self.text_index.expect("text index allocated"),
                        content_block: ContentBlock::Text {
                            text: String::new(),
                        },
                    });
                }
                if !delta.is_empty() {
                    self.budget.charge(delta.len())?;
                    self.pending.push(StreamEvent::ContentBlockDelta {
                        index: self.text_index.expect("text index allocated"),
                        delta: ContentDelta::TextDelta {
                            text: delta.to_string(),
                        },
                    });
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                let delta = value
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if self.thinking_index.is_none() {
                    self.budget.start(self.next_index, false, 0)?;
                    self.thinking_index = Some(self.next_index);
                    self.next_index += 1;
                    self.pending.push(StreamEvent::ContentBlockStart {
                        index: self.thinking_index.expect("thinking index allocated"),
                        content_block: ContentBlock::Thinking {
                            thinking: String::new(),
                            signature: String::new(),
                        },
                    });
                }
                if !delta.is_empty() {
                    self.budget.charge(delta.len())?;
                    self.pending.push(StreamEvent::ContentBlockDelta {
                        index: self.thinking_index.expect("thinking index allocated"),
                        delta: ContentDelta::ThinkingDelta {
                            thinking: delta.to_string(),
                        },
                    });
                }
            }
            "response.output_item.added" => {
                let item = value.get("item").unwrap_or(&value);
                if item.get("type").and_then(Value::as_str) == Some("function_call") {
                    let call_id = item
                        .get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or("tool-call");
                    let item_id = item.get("id").and_then(Value::as_str).unwrap_or(call_id);
                    let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
                    self.budget.start(
                        self.next_index,
                        true,
                        call_id.len()
                            + name.len()
                            + if item_id == call_id { 0 } else { item_id.len() },
                    )?;
                    let call_id = call_id.to_string();
                    let item_id = item_id.to_string();
                    let index = self.next_index;
                    self.next_index += 1;
                    self.tool_indices.insert(call_id.clone(), index);
                    self.tool_indices.insert(item_id, index);
                    self.pending.push(StreamEvent::ContentBlockStart {
                        index,
                        content_block: ContentBlock::ToolUse {
                            id: call_id,
                            name: name.to_string(),
                            input: Value::Object(Map::new()),
                        },
                    });
                }
            }
            "response.function_call_arguments.delta" => {
                let id = value
                    .get("call_id")
                    .or_else(|| value.get("item_id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some(index) = self.tool_indices.get(id).copied() {
                    let delta = value
                        .get("delta")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    self.budget.tool_arguments(index, delta.len())?;
                    self.pending.push(StreamEvent::ContentBlockDelta {
                        index,
                        delta: ContentDelta::InputJsonDelta {
                            partial_json: delta.to_string(),
                        },
                    });
                }
            }
            "response.output_item.done" => {
                let item = value.get("item").unwrap_or(&value);
                let id = item
                    .get("call_id")
                    .or_else(|| item.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some(index) = self.tool_indices.remove(id) {
                    self.budget.finish(index);
                    self.tool_indices.retain(|_, mapped| *mapped != index);
                    self.pending.push(StreamEvent::ContentBlockStop { index });
                }
            }
            "response.completed" => {
                let usage = value
                    .pointer("/response/usage")
                    .or_else(|| value.get("usage"))
                    .map(|usage| {
                        let input_tokens = usage
                            .get("input_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0) as u32;
                        let output_tokens = usage
                            .get("output_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0) as u32;
                        Usage {
                            input_tokens,
                            output_tokens,
                            total_tokens: Some(
                                usage
                                    .get("total_tokens")
                                    .and_then(Value::as_u64)
                                    .map(|value| value as u32)
                                    .unwrap_or_else(|| input_tokens.saturating_add(output_tokens)),
                            ),
                            cache_creation_input_tokens: None,
                            cache_read_input_tokens: usage
                                .pointer("/input_tokens_details/cached_tokens")
                                .and_then(Value::as_u64)
                                .map(|value| value as u32),
                            iterations: None,
                        }
                    });
                self.pending.push(StreamEvent::MessageDelta {
                    delta: kcoder_types::MessageDeltaFields {
                        stop_reason: Some("end_turn".into()),
                        stop_sequence: None,
                        usage,
                    },
                });
                self.pending.push(StreamEvent::MessageStop);
                self.done = true;
            }
            "response.failed" | "error" => {
                let nested_detail = value
                    .pointer("/response/error")
                    .or_else(|| value.get("error"));
                let detail = nested_detail.unwrap_or(&value);
                let error_type = detail
                    .get("type")
                    .and_then(Value::as_str)
                    .filter(|kind| nested_detail.is_some() || event != "error" || *kind != "error")
                    .or_else(|| detail.get("code").and_then(Value::as_str))
                    .unwrap_or(event);
                return Err(ApiErrorKind::Api {
                    error_type: redact_sensitive_token(error_type),
                    message: redact_sensitive_text(data),
                });
            }
            _ => {}
        }
        Ok(())
    }
}

fn json_message(role: &str, content: String) -> Value {
    serde_json::json!({ "role": role, "content": content })
}

fn normalize_schema_for_openai(mut schema: Value) -> Value {
    rewrite_schema_refs_for_openai(&mut schema);
    declare_object_collections_for_local_templates(&mut schema);
    schema
}

/// Ollama and llama.cpp-backed servers render tool definitions through Go chat
/// templates that iterate `.function.parameters.properties` and, for some
/// models, `.required` without nil guards; omitting the empty collections
/// aborts the whole request. Declaring them keeps the schema semantically
/// identical while staying template-safe.
fn declare_object_collections_for_local_templates(schema: &mut Value) {
    let Some(map) = schema.as_object_mut() else {
        return;
    };
    let is_object_root = match map.get("type") {
        Some(Value::String(kind)) => kind == "object",
        Some(Value::Array(types)) => types.iter().any(|kind| kind.as_str() == Some("object")),
        _ => false,
    };
    if !is_object_root {
        return;
    }
    map.entry("properties")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    map.entry("required")
        .or_insert_with(|| Value::Array(Vec::new()));
}

fn rewrite_schema_refs_for_openai(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if let Some(definitions) = map.remove("definitions") {
                map.entry("$defs".to_string()).or_insert(definitions);
            }
            if let Some(reference) = map
                .get("$ref")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                && let Some(name) = reference.strip_prefix("#/definitions/")
            {
                map.insert("$ref".to_string(), Value::String(format!("#/$defs/{name}")));
            }
            for child in map.values_mut() {
                rewrite_schema_refs_for_openai(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                rewrite_schema_refs_for_openai(item);
            }
        }
        _ => {}
    }
}

#[derive(Default)]
struct OpenAiUserMessageBuilder {
    text_parts: Vec<String>,
    parts: Vec<Value>,
    has_image: bool,
}

impl OpenAiUserMessageBuilder {
    fn push_text(&mut self, text: &str) {
        if self.has_image {
            self.parts
                .push(serde_json::json!({ "type": "text", "text": text }));
        } else {
            self.text_parts.push(text.to_string());
        }
    }

    fn push_image(&mut self, source: &kcoder_types::ImageSource) {
        if !self.has_image {
            for text in self.text_parts.drain(..) {
                self.parts
                    .push(serde_json::json!({ "type": "text", "text": text }));
            }
            self.has_image = true;
        }
        self.parts.push(serde_json::json!({
            "type": "image_url",
            "image_url": {
                "url": format!("data:{};base64,{}", source.media_type, source.data),
            }
        }));
    }

    fn take_message(&mut self) -> Option<Value> {
        if self.has_image {
            if self.parts.is_empty() {
                return None;
            }
            return Some(serde_json::json!({
                "role": "user",
                "content": std::mem::take(&mut self.parts),
            }));
        }
        if self.text_parts.is_empty() {
            return None;
        }
        Some(json_message(
            "user",
            std::mem::take(&mut self.text_parts).join("\n"),
        ))
    }
}

fn text_blocks_to_string(content: &[ContentBlock]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug, Default)]
struct PartialToolCall {
    id: Option<String>,
    name: Option<String>,
    /// Retain only fragments received before the tool identity is available.
    pending_arguments: String,
    emitted_start: bool,
}

#[derive(Default)]
struct OpenAiStreamState {
    budget: crate::response_budget::ResponseBudget,
    finish_reason: Option<String>,
    tool_calls: HashMap<usize, PartialToolCall>,
    saw_content: bool,
    saw_thinking: bool,
    pending: Vec<StreamEvent>,
    done: bool,
    /// Next engine-facing content block index. Text, thinking and tool calls
    /// all start at zero on the provider side and would collide in the
    /// engine, which keys streamed blocks by index and overwrites existing
    /// slots; allocate fresh, never-colliding indices here instead.
    next_block_index: usize,
    text_block_index: Option<usize>,
    thinking_block_index: Option<usize>,
    /// Maps the provider's `tool_calls[].index` to the allocated block index.
    tool_block_indices: HashMap<usize, usize>,
}

impl OpenAiStreamState {
    fn alloc_block_index(&mut self) -> usize {
        let index = self.next_block_index;
        self.next_block_index += 1;
        index
    }

    fn ensure_text_block_index(&mut self) -> usize {
        if let Some(index) = self.text_block_index {
            return index;
        }
        let index = self.alloc_block_index();
        self.text_block_index = Some(index);
        index
    }

    fn ensure_thinking_block_index(&mut self) -> usize {
        if let Some(index) = self.thinking_block_index {
            return index;
        }
        let index = self.alloc_block_index();
        self.thinking_block_index = Some(index);
        index
    }

    fn tool_block_index(&mut self, tool_index: usize) -> usize {
        if let Some(index) = self.tool_block_indices.get(&tool_index) {
            return *index;
        }
        let index = self.alloc_block_index();
        self.tool_block_indices.insert(tool_index, index);
        index
    }

    fn flush_pending(&mut self) -> Option<StreamEvent> {
        if !self.pending.is_empty() {
            Some(self.pending.remove(0))
        } else {
            None
        }
    }

    fn finalize_tool_calls(&mut self) -> Result<(), ApiErrorKind> {
        if self.tool_calls.values().any(|partial| {
            !partial.emitted_start
                || partial.id.as_deref().is_none_or(|id| id.trim().is_empty())
                || partial
                    .name
                    .as_deref()
                    .is_none_or(|name| name.trim().is_empty())
        }) {
            return Err(ApiErrorKind::Api {
                error_type: "provider_protocol_error".into(),
                message: "OpenAI tool call terminated without a nonempty id and function.name"
                    .into(),
            });
        }
        let mut indices: Vec<usize> = self.tool_calls.keys().copied().collect();
        indices.sort_unstable();
        for idx in indices {
            if let Some(partial) = self.tool_calls.remove(&idx) {
                self.budget.finish(idx);
                debug!(
                    "finalizing tool call {}: id={:?}, name={:?}",
                    idx, partial.id, partial.name
                );
                if partial.emitted_start {
                    let block_index = self.tool_block_indices.get(&idx).copied().unwrap_or(idx);
                    self.pending
                        .push(StreamEvent::ContentBlockStop { index: block_index });
                }
            }
        }
        Ok(())
    }
}

fn parse_openai_stream_chunk(data: &str) -> Result<OpenAiChunk, ApiErrorKind> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Payload {
        Error { error: Map<String, Value> },
        Chunk(OpenAiChunk),
    }
    match serde_json::from_str::<Payload>(data)
        .map_err(|error| ApiErrorKind::JsonParse(error, data.to_string()))?
    {
        Payload::Chunk(chunk) => Ok(chunk),
        Payload::Error { error } => Err(ApiErrorKind::Api {
            error_type: redact_sensitive_token(
                error
                    .get("type")
                    .and_then(Value::as_str)
                    .or_else(|| error.get("code").and_then(Value::as_str))
                    .unwrap_or("error"),
            ),
            message: redact_sensitive_text(data),
        }),
    }
}

#[derive(Debug, Deserialize)]
struct OpenAiChunk {
    #[allow(dead_code)]
    id: Option<String>,
    choices: Vec<OpenAiChoice>,
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Deserialize)]
struct OpenAiUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
    #[serde(default)]
    total_tokens: Option<u32>,
    #[serde(default)]
    prompt_tokens_details: Option<OpenAiPromptTokensDetails>,
    #[serde(default)]
    prompt_cache_hit_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct OpenAiPromptTokensDetails {
    #[serde(default)]
    cached_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    #[allow(dead_code)]
    index: usize,
    delta: OpenAiDelta,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct OpenAiDelta {
    #[allow(dead_code)]
    role: Option<String>,
    content: Option<String>,
    reasoning_content: Option<String>,
    /// Ollama (and some llama.cpp builds) stream thinking under `reasoning`
    /// instead of the DeepSeek-style `reasoning_content`.
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default, deserialize_with = "null_as_empty_vec")]
    tool_calls: Vec<OpenAiToolCallDelta>,
}

#[derive(Debug, Deserialize)]
struct OpenAiToolCallDelta {
    index: usize,
    id: Option<String>,
    #[serde(rename = "type")]
    #[allow(dead_code)]
    tool_type: Option<String>,
    function: Option<OpenAiFunctionDelta>,
}

#[derive(Debug, Deserialize)]
struct OpenAiFunctionDelta {
    name: Option<String>,
    arguments: Option<String>,
}

fn null_as_empty_vec<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}

impl OpenAiStreamState {
    fn process_chunk(&mut self, chunk: OpenAiChunk) -> Result<(), ApiErrorKind> {
        // MiniMax may attach usage to the terminal choice instead of a separate tail.
        {
            if let Some(usage) = chunk.usage {
                let cache_read_input_tokens = usage
                    .prompt_tokens_details
                    .and_then(|details| details.cached_tokens)
                    .or(usage.prompt_cache_hit_tokens);
                self.pending.push(StreamEvent::MessageDelta {
                    delta: kcoder_types::MessageDeltaFields {
                        stop_reason: None,
                        stop_sequence: None,
                        usage: Some(Usage {
                            input_tokens: usage.prompt_tokens,
                            output_tokens: usage.completion_tokens,
                            total_tokens: Some(usage.total_tokens.unwrap_or_else(|| {
                                usage.prompt_tokens.saturating_add(usage.completion_tokens)
                            })),
                            cache_creation_input_tokens: None,
                            cache_read_input_tokens,
                            iterations: None,
                        }),
                    },
                });
            }
        }

        let Some(choice) = chunk.choices.first() else {
            return Ok(());
        };

        debug!(
            "OpenAI chunk: content={:?}, tool_calls={:?}, finish_reason={:?}",
            choice.delta.content, choice.delta.tool_calls, choice.finish_reason
        );

        if let Some(content) = &choice.delta.content
            && !content.is_empty()
        {
            if !self.saw_content {
                self.budget.start(self.next_block_index, false, 0)?;
            }
            self.budget.charge(content.len())?;
            let block_index = self.ensure_text_block_index();
            if !self.saw_content {
                self.saw_content = true;
                self.pending.push(StreamEvent::ContentBlockStart {
                    index: block_index,
                    content_block: ContentBlock::Text {
                        text: String::new(),
                    },
                });
            }
            self.pending.push(StreamEvent::ContentBlockDelta {
                index: block_index,
                delta: ContentDelta::TextDelta {
                    text: content.clone(),
                },
            });
        }

        // Ollama streams thinking as `delta.reasoning`; DeepSeek-compatible
        // servers use `delta.reasoning_content`. Accept both, preferring the
        // canonical field when a chunk carries both.
        let reasoning_delta = choice
            .delta
            .reasoning_content
            .as_deref()
            .filter(|value| !value.is_empty())
            .or_else(|| {
                choice
                    .delta
                    .reasoning
                    .as_deref()
                    .filter(|value| !value.is_empty())
            });
        if let Some(reasoning_delta) = reasoning_delta {
            if !self.saw_thinking {
                self.budget.start(self.next_block_index, false, 0)?;
            }
            self.budget.charge(reasoning_delta.len())?;
            let block_index = self.ensure_thinking_block_index();
            if !self.saw_thinking {
                self.saw_thinking = true;
                self.pending.push(StreamEvent::ContentBlockStart {
                    index: block_index,
                    content_block: ContentBlock::Thinking {
                        thinking: String::new(),
                        signature: String::new(),
                    },
                });
            }
            self.pending.push(StreamEvent::ContentBlockDelta {
                index: block_index,
                delta: ContentDelta::ThinkingDelta {
                    thinking: reasoning_delta.to_string(),
                },
            });
        }

        for tc in &choice.delta.tool_calls {
            if !self.tool_calls.contains_key(&tc.index) {
                self.budget.start(tc.index, true, 0)?;
            }
            let previous = self.tool_calls.get(&tc.index);
            let id_bytes = tc
                .id
                .as_ref()
                .filter(|id| previous.and_then(|p| p.id.as_ref()) != Some(*id))
                .map_or(0, String::len);
            let name = tc
                .function
                .as_ref()
                .and_then(|function| function.name.as_ref());
            let name_bytes = name
                .filter(|name| previous.and_then(|p| p.name.as_ref()) != Some(*name))
                .map_or(0, String::len);
            self.budget.charge(id_bytes + name_bytes)?;
            if let Some(arguments) = tc
                .function
                .as_ref()
                .and_then(|function| function.arguments.as_ref())
            {
                self.budget.tool_arguments(tc.index, arguments.len())?;
            }
            let block_index = self.tool_block_index(tc.index);
            let partial = self.tool_calls.entry(tc.index).or_default();

            if let Some(id) = &tc.id {
                partial.id = Some(id.clone());
            }
            if let Some(func) = &tc.function
                && let Some(name) = &func.name
            {
                partial.name = Some(name.clone());
            }

            // Emit ContentBlockStart as soon as we know both id and name so the
            // downstream engine can accumulate argument deltas in the right order.
            if !partial.emitted_start
                && let (Some(id), Some(name)) = (&partial.id, &partial.name)
                && !id.trim().is_empty()
                && !name.trim().is_empty()
            {
                partial.emitted_start = true;
                self.pending.push(StreamEvent::ContentBlockStart {
                    index: block_index,
                    content_block: ContentBlock::ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: Value::Object(serde_json::Map::new()),
                    },
                });
                let prefix = std::mem::take(&mut partial.pending_arguments);
                if !prefix.is_empty() {
                    self.pending.push(StreamEvent::ContentBlockDelta {
                        index: block_index,
                        delta: ContentDelta::InputJsonDelta {
                            partial_json: prefix,
                        },
                    });
                }
            }

            if let Some(func) = &tc.function
                && let Some(args) = &func.arguments
                && !args.is_empty()
            {
                if partial.emitted_start {
                    self.pending.push(StreamEvent::ContentBlockDelta {
                        index: block_index,
                        delta: ContentDelta::InputJsonDelta {
                            partial_json: args.clone(),
                        },
                    });
                } else {
                    partial.pending_arguments.push_str(args);
                }
            }
        }

        if let Some(reason) = choice.finish_reason.as_deref()
            && matches!(
                reason,
                "stop" | "tool_calls" | "length" | "content_filter" | "function_call"
            )
        {
            self.finish_reason = Some(reason.to_owned());
            self.pending.push(StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: Some(
                        match reason {
                            "stop" => "end_turn",
                            "tool_calls" | "function_call" => "tool_use",
                            "length" => "max_tokens",
                            other => other,
                        }
                        .to_owned(),
                    ),
                    stop_sequence: None,
                    usage: None,
                },
            });
        }

        // Handle the finish reason only after any trailing delta carried by
        // the same chunk has been processed: some providers send the final
        // text or the tail of tool-call arguments in the same chunk as
        // finish_reason, and returning early here would silently drop them.
        if let Some(reason) = &choice.finish_reason
            && (reason == "stop" || reason == "tool_calls")
        {
            self.finalize_tool_calls()?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "openai/tests.rs"]
mod tests;

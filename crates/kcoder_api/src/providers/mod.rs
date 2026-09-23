use crate::ApiErrorKind;
use futures::Stream;
use kcoder_types::{MessagesRequest, StreamEvent};
use serde_json::Value;
use std::pin::Pin;
use std::time::Duration;

pub mod anthropic;
pub mod debug_log;
pub mod gemini;
pub mod genai;
pub mod grok;
pub mod openai;
mod path_first;
mod bounded_body;
mod transport_metrics;

pub use anthropic::AnthropicProvider;
pub use gemini::GeminiProvider;
pub use genai::GenAiProvider;
pub use grok::GrokProvider;
pub use openai::OpenAiProvider;

/// A stream of provider events boxed for dynamic dispatch.
pub type ProviderStream = Pin<Box<dyn Stream<Item = Result<StreamEvent, ApiErrorKind>> + Send>>;
pub type ProviderPrewarm = Pin<Box<dyn std::future::Future<Output = ()> + Send>>;
pub type ProviderModelDiscovery =
    Pin<Box<dyn std::future::Future<Output = Result<Vec<String>, ApiErrorKind>> + Send>>;
pub type ProviderTokenCount =
    Pin<Box<dyn std::future::Future<Output = Result<Option<usize>, ApiErrorKind>> + Send>>;

/// Slime training-provenance marker sent only by provider transport and excluded from the model request body.
pub(crate) const SLIME_AGENT_DEPTH_HEADER: &str = "x-slime-agent-depth";
/// Tell Slime that this provider will replay `reasoning_content` in full on the next turn.
pub(crate) const SLIME_REASONING_REPLAY_HEADER: &str = "x-slime-replay-reasoning-content";

#[derive(Debug, Clone, Copy)]
pub struct ModelDiscoveryOptions {
    pub timeout: Duration,
    pub max_models: usize,
}

/// A language-model provider that can stream messages in Anthropic-compatible
/// event format.
pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;

    /// Whether this adapter can remove the rejected native parameter after all overrides.
    fn supports_reasoning_suppression(
        &self,
        _parameter: crate::RejectedReasoningParameter,
    ) -> bool {
        false
    }

    /// Whether client options may trigger factory reconstruction for this provider.
    /// Fixed providers such as deterministic scenarios return false to avoid replacement by a live network adapter.
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        true
    }

    /// Whether this adapter converts `response_json_schema` into a provider-native
    /// structured-output constraint. Disabled by default so a provider that merely
    /// carries the field without sending it is not misclassified as supporting structured output.
    fn supports_response_json_schema(&self) -> bool {
        false
    }

    /// Effective request endpoint after all configuration overrides are applied.
    fn endpoint(&self) -> Option<&str> {
        None
    }

    /// Whether this provider instance was built with an API key, without
    /// exposing the key itself. `None` means the provider cannot report it.
    fn api_key_configured(&self) -> Option<bool> {
        None
    }

    /// Effective connection timeout after provider-specific environment and
    /// configuration fallbacks are applied.
    fn request_timeout_secs(&self) -> Option<u64> {
        None
    }

    /// Best-effort connection warmup. Implementations should use the same HTTP
    /// client as real requests so DNS, TLS and the connection pool are primed,
    /// and must not generate model output or surface failures to the user.
    fn prewarm(&self) -> ProviderPrewarm {
        Box::pin(async {})
    }

    /// List model identifiers advertised by this exact deployment. Discovery
    /// is deliberately best-effort and must reuse the provider's credentials,
    /// endpoint and proxy policy.
    fn discover_models(&self, _options: ModelDiscoveryOptions) -> ProviderModelDiscovery {
        Box::pin(async { Ok(Vec::new()) })
    }

    /// Optional exact provider token counting. The default adds no network request
    /// and lets the engine estimate the complete request locally; implementations
    /// with a count-tokens API may override it.
    fn count_tokens(&self, _request: MessagesRequest) -> ProviderTokenCount {
        Box::pin(async { Ok(None) })
    }

    /// Stream message events for the given request.
    ///
    /// The request is expressed in Anthropic-style; the provider internally
    /// converts it and adapts the response stream back to `StreamEvent`s.
    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind>;
}

pub(crate) fn model_list_url(base_url: &str) -> String {
    let mut base = base_url.trim().trim_end_matches('/').to_string();
    for suffix in ["/v1/messages", "/chat/completions", "/responses", "/models"] {
        if base.to_ascii_lowercase().ends_with(suffix) {
            base.truncate(base.len() - suffix.len());
            if suffix == "/models" {
                return format!("{base}/models");
            }
            break;
        }
    }
    if base.to_ascii_lowercase().ends_with("/v1") {
        format!("{base}/models")
    } else {
        format!("{base}/v1/models")
    }
}

pub(crate) async fn parse_model_list_response(
    response: reqwest::Response,
    max_models: usize,
) -> Result<Vec<String>, ApiErrorKind> {
    let status = response.status();
    let body = bounded_body::read(response, bounded_body::MODEL_LIST_LIMIT).await?;
    if !status.is_success() {
        return Err(ApiErrorKind::Api {
            error_type: format!("model_discovery_http_{}", status.as_u16()),
            message: format!("model list request failed with {status}"),
        });
    }
    parse_model_list_json(&body, max_models)
}

pub(crate) fn parse_model_list_json(
    body: &str,
    max_models: usize,
) -> Result<Vec<String>, ApiErrorKind> {
    let value: Value = serde_json::from_str(body)
        .map_err(|error| ApiErrorKind::JsonParse(error, "<model-list response>".to_string()))?;
    let entries = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(Value::as_array)
        .ok_or_else(|| ApiErrorKind::Api {
            error_type: "model_discovery_invalid_response".to_string(),
            message: "model list response has no data/models array".to_string(),
        })?;

    let mut models = entries
        .iter()
        .filter_map(|entry| {
            entry
                .get("id")
                .or_else(|| entry.get("name"))
                .and_then(Value::as_str)
        })
        .map(|id| id.strip_prefix("models/").unwrap_or(id).trim())
        .filter(|id| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    models.sort_by_key(|model| model.to_ascii_lowercase());
    models.dedup();
    models.truncate(max_models.max(1));
    Ok(models)
}

#[cfg(test)]
mod model_discovery_tests {
    use super::*;

    #[test]
    fn normalizes_common_model_list_urls() {
        assert_eq!(model_list_url("http://host"), "http://host/v1/models");
        assert_eq!(model_list_url("http://host/v1"), "http://host/v1/models");
        assert_eq!(
            model_list_url("https://host/coding/v1"),
            "https://host/coding/v1/models"
        );
        assert_eq!(
            model_list_url("http://host/v1/messages"),
            "http://host/v1/models"
        );
    }

    #[test]
    fn parses_openai_and_gemini_model_lists_conservatively() {
        assert_eq!(
            parse_model_list_json(r#"{"data":[{"id":"B"},{"id":"a"}]}"#, 10).unwrap(),
            vec!["a", "B"]
        );
        assert_eq!(
            parse_model_list_json(
                r#"{"models":[{"name":"models/gemini-pro"},{"name":"bad\nname"}]}"#,
                10
            )
            .unwrap(),
            vec!["gemini-pro"]
        );
    }
}

/// Shared helper: extract the server-provided `Retry-After` hint (seconds or an
/// HTTP date) from response headers so it can be embedded into error messages.
pub(crate) fn retry_after_hint(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?;
    let text = value.to_str().ok()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.to_string())
}

/// Shared helper: parse one declared Anthropic Messages SSE event.
///
/// The payload is intentionally strict: provider-specific aliases are not
/// rewritten into Anthropic content blocks.
#[cfg(test)]
pub(crate) fn parse_anthropic_event(
    event_type: &str,
    data: &str,
) -> Result<StreamEvent, ApiErrorKind> {
    parse_anthropic_event_observed(event_type, data, |_| {})
}

pub(crate) fn parse_anthropic_event_observed(
    event_type: &str,
    data: &str,
    observe: impl FnOnce(&serde_json::Map<String, Value>),
) -> Result<StreamEvent, ApiErrorKind> {
    use serde_json::Value;

    let mut payload: Value =
        serde_json::from_str(data).map_err(|e| ApiErrorKind::JsonParse(e, data.to_string()))?;

    let Value::Object(ref mut map) = payload else {
        return Err(ApiErrorKind::Api {
            error_type: "invalid_anthropic_event".to_string(),
            message: format!("{event_type} event data must be a JSON object"),
        });
    };
    let payload_type =
        map.get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiErrorKind::Api {
                error_type: "invalid_anthropic_event".to_string(),
                message: format!("{event_type} event data has no type"),
            })?;
    if payload_type != event_type {
        return Err(ApiErrorKind::Api {
            error_type: "invalid_anthropic_event".to_string(),
            message: format!("SSE event {event_type} disagrees with payload type {payload_type}"),
        });
    }
    observe(map);
    if event_type == "message_delta"
        && let Some(usage) = map.remove("usage")
        && let Some(delta) = map.get_mut("delta").and_then(Value::as_object_mut)
    {
        delta.insert("usage".to_string(), normalize_anthropic_usage(usage));
    }

    let json = serde_json::to_string(&payload)
        .map_err(|e| ApiErrorKind::JsonParse(e, data.to_string()))?;

    serde_json::from_str(&json).map_err(|e| ApiErrorKind::JsonParse(e, data.to_string()))
}

fn normalize_anthropic_usage(mut usage: Value) -> Value {
    // Anthropic sends input usage in message_start and output usage in
    // message_delta. Fill the internal aggregate shape without changing any
    // provider field names or content-block semantics.
    if let Some(map) = usage.as_object_mut() {
        map.entry("input_tokens".to_string())
            .or_insert_with(|| Value::Number(0.into()));
        map.entry("output_tokens".to_string())
            .or_insert_with(|| Value::Number(0.into()));
    }
    usage
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::{ContentBlock, ContentDelta};

    #[test]
    fn parse_anthropic_event_accepts_standard_thinking_start_without_signature() {
        let event = parse_anthropic_event(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
        )
        .unwrap();

        let StreamEvent::ContentBlockStart {
            index,
            content_block:
                ContentBlock::Thinking {
                    thinking,
                    signature,
                },
        } = event
        else {
            panic!("expected thinking content block start");
        };

        assert_eq!(index, 0);
        assert_eq!(thinking, "");
        assert_eq!(signature, "");
    }

    #[test]
    fn parse_anthropic_event_accepts_signature_delta() {
        let event = parse_anthropic_event(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed"}}"#,
        )
        .unwrap();

        let StreamEvent::ContentBlockDelta {
            index,
            delta: ContentDelta::SignatureDelta { signature },
        } = event
        else {
            panic!("expected signature delta");
        };

        assert_eq!(index, 0);
        assert_eq!(signature, "signed");
    }

    #[test]
    fn parse_anthropic_event_rejects_event_name_mismatch() {
        let event = parse_anthropic_event(
            "content_block_delta",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        );
        assert!(event.is_err());
    }

    #[test]
    fn parse_anthropic_event_moves_message_delta_usage_into_delta() {
        let event = parse_anthropic_event(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":30971,"output_tokens":140,"cache_creation_input_tokens":0,"cache_read_input_tokens":128,"service_tier":"standard"}}"#,
        )
        .unwrap();

        let StreamEvent::MessageDelta { delta } = event else {
            panic!("expected message delta");
        };
        let usage = delta.usage.expect("expected usage");

        assert_eq!(usage.input_tokens, 30_971);
        assert_eq!(usage.output_tokens, 140);
        assert_eq!(usage.cache_creation_input_tokens, Some(0));
        assert_eq!(usage.cache_read_input_tokens, Some(128));
    }

    #[test]
    fn parse_anthropic_event_accepts_message_delta_usage_without_input_tokens() {
        let event = parse_anthropic_event(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}"#,
        )
        .unwrap();

        let StreamEvent::MessageDelta { delta } = event else {
            panic!("expected message delta");
        };
        let usage = delta.usage.expect("expected usage");

        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 0);
    }

    #[test]
    fn parse_anthropic_event_rejects_nonstandard_reasoning_content_block() {
        let event = parse_anthropic_event(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"reasoning_content","reasoning_content":""}}"#,
        );
        assert!(event.is_err());
    }

    #[test]
    fn parse_anthropic_event_rejects_reasoning_block_with_content_field() {
        let event = parse_anthropic_event(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"reasoning","content":"先分析一下"}}"#,
        );
        assert!(event.is_err());
    }

    #[test]
    fn parse_anthropic_event_rejects_nonstandard_reasoning_content_delta() {
        let event = parse_anthropic_event(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"reasoning_content_delta","reasoning_content":"先想一下"}}"#,
        );
        assert!(event.is_err());
    }

    #[test]
    fn parse_anthropic_event_rejects_thinking_delta_with_content_field() {
        let event = parse_anthropic_event(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","content":"继续推理"}}"#,
        );
        assert!(event.is_err());
    }

    #[test]
    fn parse_anthropic_event_rejects_reasoning_delta_with_text_field() {
        let event = parse_anthropic_event(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"reasoning_delta","text":"换一种角度"}}"#,
        );
        assert!(event.is_err());
    }
}

use anyhow::{Result, bail};
use futures::StreamExt;
use kcoder_api::{ApiErrorKind, ProviderBuildOverrides, ProviderFactory, ProviderKind};
use kcoder_config::{ProviderConfig, Settings};
use kcoder_types::{ContentBlock, ContentDelta, Message, MessagesRequest, StreamEvent};
use std::{collections::BTreeMap, time::Duration};

pub(super) async fn verify(
    baseline: &Settings,
    id: &str,
    mut profile: ProviderConfig,
    key: Option<String>,
) -> Result<()> {
    let key = key.filter(|key| !key.trim().is_empty());
    let authenticated = profile.authentication.is_api_key();
    if authenticated && key.is_none() {
        bail!("[provider_probe_configuration] Configure an API key before saving");
    }
    let model = profile.default_model.clone();
    let endpoint = profile.endpoint.clone();
    let (reasoning_effort, max_tokens) = prepare_probe_profile(&mut profile)?;
    profile.max_retries = Some(0);
    profile.request_timeout_secs = Some(15);
    let mut settings = baseline.clone();
    settings.providers = BTreeMap::from([(id.to_owned(), profile)]);
    settings.credential_overrides.clear();
    settings.stored_provider_credentials.clear();
    if authenticated && let Some(key) = key {
        settings
            .stored_provider_credentials
            .insert(id.into(), key.trim().into());
    }
    settings.apply_provider(Some(id))?;
    // Preserve the real provider transport, but test the explicitly submitted
    // endpoint/model rather than ambient built-in-provider overrides.
    settings.model = model.clone();
    settings.base_url = Some(endpoint.clone());
    let kind = ProviderKind::from_settings(&settings)?.ok_or_else(|| {
        anyhow::anyhow!("[provider_probe_configuration] Provider transport is unavailable")
    })?;
    let overrides = ProviderBuildOverrides {
        base_url: Some(endpoint.clone()),
        openai_base_url: Some(endpoint.clone()),
        local_base_url: Some(endpoint),
        ..Default::default()
    };
    let provider = ProviderFactory::new(&settings).with_overrides(overrides).build(kind, &model)
        .map_err(|_| anyhow::anyhow!("[provider_probe_configuration] Cannot build this API; check credentials and transport settings"))?;
    let request = MessagesRequest::new(model, vec![Message::user_text("Reply only OK.")])
        .with_max_tokens(max_tokens)
        .with_reasoning_effort(reasoning_effort);
    let operation = async {
        let mut stream = provider.stream_messages(request).map_err(safe_error)?;
        let mut content_seen = false;
        let mut events = 0usize;
        while let Some(event) = stream.next().await {
            events += 1;
            if events > 8192 {
                bail!("[provider_probe_response] API validation response exceeded the event limit");
            }
            match event.map_err(safe_error)? {
                StreamEvent::Error { error } => {
                    return Err(safe_error(ApiErrorKind::Api {
                        error_type: error.error_type,
                        message: error.message,
                    }));
                }
                StreamEvent::ContentBlockStart {
                    content_block: ContentBlock::Text { text },
                    ..
                }
                | StreamEvent::ContentBlockDelta {
                    delta: ContentDelta::TextDelta { text },
                    ..
                } => content_seen |= !text.trim().is_empty(),
                StreamEvent::ContentBlockStart {
                    content_block: ContentBlock::Thinking { thinking, .. },
                    ..
                }
                | StreamEvent::ContentBlockDelta {
                    delta: ContentDelta::ThinkingDelta { thinking },
                    ..
                } => content_seen |= !thinking.trim().is_empty(),
                StreamEvent::MessageStop if content_seen => return Ok(()),
                _ => {}
            }
        }
        bail!("[provider_probe_response] API returned no complete model response")
    };
    tokio::time::timeout(Duration::from_secs(30), operation)
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "[provider_probe_timeout] API validation timed out; configuration was not saved"
            )
        })?
}

/// The probe uses a bounded copy of the selected model. Never mutate the saved input.
fn prepare_probe_profile(
    profile: &mut ProviderConfig,
) -> Result<(Option<kcoder_types::ReasoningEffort>, u32)> {
    kcoder_config::validate_extra_body(&profile.extra_body)
        .map_err(|error| anyhow::anyhow!("[provider_probe_configuration] {error}"))?;
    let reasoning_effort = profile
        .capabilities
        .reasoning
        .then(|| profile.reasoning_effort.clone())
        .flatten();
    let extended = reasoning_effort
        .as_ref()
        .is_some_and(|effort| !matches!(effort, kcoder_types::ReasoningEffort::None));
    let anthropic = profile.api_format == kcoder_config::ApiFormat::AnthropicMessages;
    let explicit_budget = if anthropic
        && profile
            .extra_body
            .get("thinking")
            .and_then(|v| v.get("type"))
            .and_then(|v| v.as_str())
            == Some("enabled")
    {
        let budget = profile.extra_body["thinking"].get("budget_tokens")
            .and_then(|v| v.as_u64()).and_then(|v| u32::try_from(v).ok())
            .filter(|v| *v >= 1024)
            .ok_or_else(|| anyhow::anyhow!("[provider_probe_configuration] thinking.budget_tokens must be an integer of at least 1024"))?;
        Some(budget)
    } else {
        None
    };
    let production_limit = if anthropic {
        match profile.extra_body.get("max_tokens") {
            Some(value) => value
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .filter(|v| *v > 0)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "[provider_probe_configuration] max_tokens must be a positive integer"
                    )
                })?,
            None => profile.max_output_tokens,
        }
    } else {
        profile.max_output_tokens
    };
    if explicit_budget.is_some_and(|budget| budget >= production_limit) {
        bail!(
            "[provider_probe_configuration] thinking.budget_tokens must be below the configured max_tokens"
        );
    }
    let max_tokens = production_limit.min(if extended || explicit_budget.is_some() {
        8192
    } else {
        256
    });
    if let Some(budget) = explicit_budget {
        profile.extra_body.get_mut("thinking").unwrap()["budget_tokens"] =
            serde_json::json!(budget.min(max_tokens - 1));
    }
    for field in ["max_tokens", "max_completion_tokens", "max_output_tokens"] {
        if profile.extra_body.contains_key(field) {
            profile
                .extra_body
                .insert(field.into(), serde_json::json!(max_tokens));
        }
    }
    // This is already an effective_for_model snapshot. Keeping its catalog would
    // reapply the original per-model body in apply_provider, undoing probe limits.
    profile.models.clear();
    Ok((reasoning_effort, max_tokens))
}

fn safe_error(error: ApiErrorKind) -> anyhow::Error {
    // Provider errors can echo headers/body/credentials. Only return fixed categories.
    let raw = error.to_string().to_ascii_lowercase();
    let category = if raw.contains("http 401")
        || raw.contains("401 unauthorized")
        || raw.contains("invalid_api_key")
        || raw.contains("authentication_error")
    {
        "authentication"
    } else if raw.contains("http 403")
        || raw.contains("403 forbidden")
        || raw.contains("permission_denied")
    {
        "permission"
    } else if raw.contains("insufficient_quota") || raw.contains("quota_exceeded") {
        "quota"
    } else if raw.contains("http 429") || raw.contains("429 too many") || raw.contains("rate_limit")
    {
        "rate_limit"
    } else if raw.contains("http 404")
        || raw.contains("404 not found")
        || raw.contains("model_not_found")
    {
        "model"
    } else if matches!(&error, ApiErrorKind::Network(error) if error.is_timeout())
        || raw.contains("timed out")
        || raw.contains("timeout")
    {
        "timeout"
    } else if matches!(error, ApiErrorKind::Network(_))
        || [
            "connection refused",
            "error sending request",
            "dns error",
            "connection reset",
        ]
        .iter()
        .any(|message| raw.contains(message))
    {
        "network"
    } else {
        "response"
    };
    anyhow::anyhow!(
        "[provider_probe_{category}] API validation failed; configuration was not saved"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn thinking_profile() -> ProviderConfig {
        serde_json::from_value(json!({
            "api_format":"anthropic_messages", "endpoint":"http://127.0.0.1:1",
            "default_model":"fixture", "context_window_tokens":100000,
            "output_headroom_tokens":32768,"max_output_tokens":32768,"no_proxy":true,
            "extra_body":{"thinking":{"type":"enabled","budget_tokens":16000},"max_tokens":32768}
        }))
        .unwrap()
    }

    #[test]
    fn explicit_thinking_budget_is_bounded_without_requiring_effort() {
        let original = thinking_profile();
        let mut probe = original.clone();
        let (effort, limit) = prepare_probe_profile(&mut probe).unwrap();
        assert!(effort.is_none());
        assert_eq!(limit, 8192);
        assert_eq!(probe.extra_body["thinking"]["budget_tokens"], 8191);
        assert_eq!(probe.extra_body["max_tokens"], 8192);
        assert_eq!(original.extra_body["thinking"]["budget_tokens"], 16000);
        assert_eq!(original.extra_body["max_tokens"], 32768);
    }

    #[test]
    fn invalid_production_budget_is_not_hidden_by_probe_policy() {
        for budget in [json!(32768), json!(100), json!("PRIVATE_SENTINEL")] {
            let mut profile = thinking_profile();
            profile.extra_body["thinking"]["budget_tokens"] = budget;
            let message = prepare_probe_profile(&mut profile).unwrap_err().to_string();
            assert!(message.contains("thinking.budget_tokens"));
            assert!(!message.contains("PRIVATE_SENTINEL"));
        }
    }

    #[tokio::test]
    async fn selected_model_probe_sends_compatible_budget_and_keeps_saved_parameters() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let (header_end, content_length) = loop {
                let mut chunk = [0; 4096];
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                assert!(bytes.len() < 131072);
                if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..index]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().unwrap())
                        })
                        .unwrap();
                    break (index + 4, length);
                }
            };
            while bytes.len() < header_end + content_length {
                let mut chunk = [0; 4096];
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
            }
            let body: serde_json::Value =
                serde_json::from_slice(&bytes[header_end..header_end + content_length]).unwrap();
            let events = [
                json!({"type":"message_start","message":{"id":"probe","type":"message","role":"assistant","model":"fixture","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}),
                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"OK"}}),
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}),
                json!({"type":"message_stop"}),
            ];
            let content = events
                .iter()
                .map(|event| {
                    format!(
                        "event: {}\ndata: {event}\n\n",
                        event["type"].as_str().unwrap()
                    )
                })
                .collect::<String>();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{content}",
                content.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            body
        });
        let mut profile = thinking_profile();
        profile.endpoint = format!("http://{address}");
        profile.models = profile.model_profiles();
        let saved = serde_json::to_value(&profile).unwrap();
        let effective = profile.effective_for_model("fixture").unwrap();
        let result = verify(
            &Settings::default(),
            "probe-fixture",
            effective,
            Some("fixture-only-key".into()),
        )
        .await;
        let body = tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
        result.unwrap();
        assert_eq!(body["max_tokens"], 8192);
        assert_eq!(body["thinking"]["budget_tokens"], 8191);
        assert_eq!(body["model"], "fixture");
        assert_eq!(serde_json::to_value(profile).unwrap(), saved);
    }
}

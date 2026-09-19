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
    let max_tokens = profile.max_output_tokens.min(256);
    for field in [
        "model",
        "messages",
        "input",
        "system",
        "instructions",
        "tools",
        "stream",
    ] {
        if profile.extra_body.contains_key(field) {
            bail!(
                "[provider_probe_configuration] Remove reserved request fields from extra_body before validation"
            );
        }
    }
    for field in ["max_tokens", "max_completion_tokens", "max_output_tokens"] {
        if profile.extra_body.contains_key(field) {
            profile
                .extra_body
                .insert(field.into(), serde_json::json!(max_tokens));
        }
    }
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
        .with_max_tokens(max_tokens);
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

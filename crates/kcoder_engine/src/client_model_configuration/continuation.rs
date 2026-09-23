//! A continuation resolves a candidate before changing the failed runtime.
use super::*;
use kcoder_types::{ContentBlock, Message, RetryModelConfiguration};

#[derive(Default)]
pub struct ClientModelContinuationOptions<'a> {
    pub model: Option<&'a str>,
    pub configuration: RetryModelConfiguration,
    pub reasoning_effort: Option<&'a str>,
    pub proxy_url: Option<&'a str>,
    pub service_tier: Option<&'a str>,
}

impl QueryEngine {
    pub fn prepare_client_model_continuation(
        &self,
        bytes: &[u8],
        requested: ClientModelContinuationOptions<'_>,
    ) -> Result<()> {
        let snapshot = decode_client_model(bytes)?;
        let source = self
            .client_model_configuration
            .as_ref()
            .context("Model snapshot restoration is unsupported")?;
        let previous = recover_read_lock(&self.settings, "settings").clone();
        let mut context = previous.clone();
        if let Some((profile, model)) = snapshot.selection.split_once("::") {
            context.active_provider = Some(profile.into());
            context.model = model.into();
        } else {
            context.active_provider = None;
            context.model = snapshot.selection.clone();
        }
        let selection = canonical_selection(&context, requested.model)?;
        let use_current = requested.configuration == RetryModelConfiguration::Current
            || selection != snapshot.selection;
        if requested.configuration == RetryModelConfiguration::Current {
            anyhow::ensure!(
                requested
                    .model
                    .is_some_and(|value| !value.trim().is_empty()),
                "Current continuation requires an explicit model"
            );
        }
        let host = serde_json::to_vec(&snapshot.host)?;
        let mut options = ClientModelOptions {
            model_selection_mode: if requested.model.is_some() {
                ModelSelectionMode::Explicit
            } else {
                snapshot.mode
            },
            reasoning: snapshot.reasoning,
            default_reasoning: snapshot.default_reasoning,
            selection: Some((context.active_provider.clone(), context.model.clone())),
            proxy: snapshot
                .proxy_override
                .then(|| previous.provider_proxy_url.clone()),
            service_tier: snapshot.service_tier,
            frozen_host: None,
        };
        let (mut next, original_provider) = if use_current {
            let next = source.settings(&selection)?;
            validate_client_selection(&previous, &next)?;
            ensure_context_compatible(
                &self.state.messages(),
                &next,
                source.snapshot_api_format(&host)?,
                selection == snapshot.selection,
            )?;
            options.bind_model(&next);
            options.default_reasoning = next.model_reasoning_effort.clone();
            (next, None)
        } else {
            let (next, provider) = if let Some(proxy) = requested.proxy_url {
                source.thaw_model_with_proxy_override(&host, proxy)?
            } else {
                source.thaw_model(&host, previous.provider_proxy_url.clone())?
            };
            anyhow::ensure!(
                canonical_selection(&next, None)? == snapshot.selection,
                "Restored model selection does not match the snapshot"
            );
            options.frozen_host = Some(host.clone());
            options.proxy = (snapshot.proxy_override || requested.proxy_url.is_some())
                .then(|| next.provider_proxy_url.clone());
            (next, Some(provider))
        };
        if let Some(reasoning) = &options.reasoning {
            next.model_reasoning_effort = Some(reasoning.clone());
        }
        if use_current {
            if let Some(proxy) = &options.proxy {
                next.provider_proxy_url = proxy.clone();
            }
            if let Some(tier) = &options.service_tier {
                next.provider_extra_body
                    .insert("service_tier".into(), serde_json::json!(tier));
            }
        }
        if let Some(effort) = requested.reasoning_effort {
            if effort.trim() == "default" {
                options.reasoning = None;
                next.model_reasoning_effort = options.default_reasoning.clone();
            } else {
                let value = effort
                    .parse::<ReasoningEffort>()
                    .context("invalid client reasoning effort")?;
                next.model_reasoning_effort = Some(value.clone());
                options.reasoning = Some(value);
            }
        }
        crate::provider_runtime::apply_client_runtime_options(
            &mut next,
            requested.proxy_url,
            requested.service_tier,
        )?;
        if requested.proxy_url.is_some() {
            options.proxy = Some(next.provider_proxy_url.clone());
        }
        if requested.service_tier.is_some() {
            options.service_tier = next
                .provider_extra_body
                .get("service_tier")
                .and_then(|value| value.as_str())
                .map(str::to_owned);
        }
        let provider = if use_current {
            let provider = source.provider(&next)?;
            let requires_key = next
                .active_provider
                .as_deref()
                .and_then(|id| next.providers.get(id))
                .is_none_or(|profile| profile.authentication.is_api_key());
            anyhow::ensure!(
                !requires_key || provider.api_key_configured() != Some(false),
                "Selected model credential is unavailable"
            );
            provider
        } else if requested.reasoning_effort.is_some()
            || requested.proxy_url.is_some()
            || requested.service_tier.is_some()
        {
            let updated = source.refreeze_model(&host, &next)?;
            let (_, provider) = source.thaw_model(&updated, next.provider_proxy_url.clone())?;
            options.frozen_host = Some(updated);
            provider
        } else {
            original_provider.context("Missing snapshot provider")?
        };
        // All decoding, capability checks, option validation and construction above
        // are read-only. Only now publish the replacement and its selection.
        self.state.set_model_selection(
            options.model_selection_mode,
            Some(canonical_selection(&next, None)?),
        )?;
        *recover_write_lock(&self.provider, "provider") = provider;
        *recover_write_lock(&self.settings, "settings") = retained_model_fields(previous, &next);
        *recover_write_lock(&self.client_model_options, "client model options") = options;
        Ok(())
    }
}

fn ensure_context_compatible(
    messages: &[Message],
    candidate: &Settings,
    previous_format: Option<kcoder_config::ApiFormat>,
    same_identity: bool,
) -> Result<()> {
    #[derive(Default)]
    struct Requirements {
        tools: bool,
        images: bool,
        reasoning: bool,
        opaque_reasoning: bool,
    }
    fn scan(blocks: &[ContentBlock], needs: &mut Requirements) {
        for block in blocks {
            match block {
                ContentBlock::ToolUse { .. } => needs.tools = true,
                ContentBlock::ToolResult { content, .. } => {
                    needs.tools = true;
                    scan(content, needs);
                }
                ContentBlock::Image { .. } => needs.images = true,
                ContentBlock::Thinking { signature, .. } => {
                    needs.reasoning = true;
                    needs.opaque_reasoning |= !signature.is_empty();
                }
                ContentBlock::RedactedThinking { .. } => {
                    needs.reasoning = true;
                    needs.opaque_reasoning = true;
                }
                ContentBlock::Text { .. } => {}
            }
        }
    }
    let mut needs = Requirements::default();
    for message in messages {
        match message {
            Message::User { content } | Message::Assistant { content, .. } => {
                scan(content, &mut needs)
            }
        }
    }
    let capabilities = &candidate.model_capabilities;
    anyhow::ensure!(capabilities.text, "retry_model_incompatible: text");
    anyhow::ensure!(
        !needs.tools || capabilities.tools,
        "retry_model_incompatible: tools"
    );
    anyhow::ensure!(
        !needs.images || capabilities.vision,
        "retry_model_incompatible: images"
    );
    anyhow::ensure!(
        !needs.reasoning || capabilities.reasoning,
        "retry_model_incompatible: reasoning"
    );
    anyhow::ensure!(
        !needs.reasoning || (previous_format.is_some() && previous_format == candidate.api_format),
        "retry_model_incompatible: reasoning_protocol"
    );
    anyhow::ensure!(
        !needs.opaque_reasoning || same_identity,
        "retry_model_incompatible: reasoning_signature"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_config::ApiFormat;
    fn candidate() -> Settings {
        let mut value = Settings::default();
        value.api_format = Some(ApiFormat::OpenaiChatCompletions);
        value.model_capabilities.text = true;
        value.model_capabilities.tools = true;
        value.model_capabilities.vision = true;
        value.model_capabilities.reasoning = true;
        value
    }
    fn check(block: ContentBlock, settings: &Settings, same: bool) -> Result<()> {
        ensure_context_compatible(
            &[Message::user_content(vec![block])],
            settings,
            Some(ApiFormat::OpenaiChatCompletions),
            same,
        )
    }
    #[test]
    fn continuation_rejects_unsupported_committed_context() {
        let mut next = candidate();
        let tool = ContentBlock::ToolResult {
            tool_use_id: "call".into(),
            content: vec![ContentBlock::Image {
                source: kcoder_types::ImageSource::base64("image/png", "AA=="),
            }],
            is_error: None,
        };
        assert!(check(tool.clone(), &next, false).is_ok());
        next.model_capabilities.vision = false;
        assert_eq!(
            check(tool.clone(), &next, false).unwrap_err().to_string(),
            "retry_model_incompatible: images"
        );
        next.model_capabilities.tools = false;
        assert_eq!(
            check(tool, &next, false).unwrap_err().to_string(),
            "retry_model_incompatible: tools"
        );
        next = candidate();
        let thinking = ContentBlock::Thinking {
            thinking: "summary".into(),
            signature: String::new(),
        };
        assert!(check(thinking.clone(), &next, false).is_ok());
        next.api_format = Some(ApiFormat::AnthropicMessages);
        assert_eq!(
            check(thinking.clone(), &next, false)
                .unwrap_err()
                .to_string(),
            "retry_model_incompatible: reasoning_protocol"
        );
        next.model_capabilities.reasoning = false;
        assert_eq!(
            check(thinking, &next, false).unwrap_err().to_string(),
            "retry_model_incompatible: reasoning"
        );
        next = candidate();
        let opaque = ContentBlock::RedactedThinking {
            data: "opaque".into(),
        };
        assert!(check(opaque.clone(), &next, true).is_ok());
        assert_eq!(
            check(opaque, &next, false).unwrap_err().to_string(),
            "retry_model_incompatible: reasoning_signature"
        );
    }
}

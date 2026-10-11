//! Opt-in, single-request tool streaming diagnostic. Never executes a tool.
use futures::StreamExt;
use kcoder_api::{AnthropicProvider, Provider, ProviderFactory, ProviderKind};
use kcoder_config::SettingsLoader;
use kcoder_types::{
    ContentBlock, ContentDelta, Message, MessagesRequest, StreamEvent, ToolDefinition,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

const MAX_TOKENS: u32 = 1024;
const LONG_MAX_TOKENS: u32 = 8192;
const MAX_EVENTS: usize = 4096;
const MAX_ARGUMENT_BYTES: usize = 128 * 1024;

#[tokio::main]
async fn main() {
    match run().await {
        Ok(receipt) => {
            let completed = receipt["status"] == "completed";
            println!("{receipt}");
            if !completed {
                std::process::exit(1);
            }
        }
        // Loader/transport errors can contain private values. Only fixed categories escape.
        Err(category) => {
            println!("{}", json!({"status": "unavailable", "category": category}));
            std::process::exit(1);
        }
    }
}

async fn run() -> Result<Value, &'static str> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let eager_probe = args.len() == 5 && (args[4] == "--eager-input" || args[4] == "--long-eager");
    let minimax_chat_probe = args.len() == 5 && args[4] == "--minimax-chat";
    let long_probe = args.len() == 5 && (args[4] == "--long" || args[4] == "--long-eager");
    if !(args.len() == 4 || eager_probe || minimax_chat_probe || long_probe)
        || args[0] != "--consent-real-model"
        || std::env::var("KCODER_E2E_REAL_MODEL").as_deref() != Ok("1")
    {
        return Err(
            "explicit_consent_required: --consent-real-model CONFIG_DIR EMPTY_WORKSPACE PROVIDER [--eager-input|--minimax-chat|--long|--long-eager]",
        );
    }
    if std::env::var("DEV_DEBUG").as_deref() != Ok("0") {
        return Err("set_DEV_DEBUG_0_to_disable_payload_recording");
    }
    let config_dir = PathBuf::from(&args[1]);
    let workspace = PathBuf::from(&args[2]);
    let profile = args[3].to_str().ok_or("invalid_provider")?;
    kcoder_config::validate_provider_id(profile).map_err(|_| "invalid_provider")?;
    if !config_dir.is_dir()
        || config_dir
            .join(".provider-transaction.json")
            .try_exists()
            .map_err(|_| "configuration_unavailable")?
    {
        return Err("configuration_unavailable_or_pending_transaction");
    }
    if std::fs::read_dir(&workspace)
        .map_err(|_| "empty_workspace_required")?
        .next()
        .is_some()
    {
        return Err("empty_workspace_required");
    }
    let mut settings = SettingsLoader::new(&workspace)
        .with_config_dir(config_dir)
        .with_executable_dir(&workspace)
        .load()
        .map_err(|_| "configuration_unavailable")?
        .settings;
    if !settings.providers.contains_key(profile) {
        return Err("provider_not_declared");
    }
    settings
        .apply_provider(Some(profile))
        .map_err(|_| "provider_unavailable")?;
    settings.max_retries = 0;
    settings.request_timeout_secs = Some(60);
    let max_tokens = if long_probe {
        LONG_MAX_TOKENS
    } else {
        MAX_TOKENS
    };
    settings.max_tokens = Some(max_tokens);
    for key in ["max_tokens", "max_completion_tokens", "max_output_tokens"] {
        if settings.provider_extra_body.contains_key(key) {
            settings
                .provider_extra_body
                .insert(key.into(), json!(max_tokens));
        }
    }
    let kind = ProviderKind::from_settings(&settings)
        .map_err(|_| "provider_unavailable")?
        .ok_or("provider_unavailable")?;
    let mut provider = ProviderFactory::new(&settings)
        .build(kind, &settings.model)
        .map_err(|_| "provider_or_credential_unavailable")?;
    if minimax_chat_probe {
        // Compare only the same official MiniMax origin and credential. Never
        // infer an alternate protocol on an arbitrary configured gateway.
        let endpoint = minimax_chat_endpoint(provider.endpoint().ok_or("endpoint_unavailable")?)?;
        let mut chat = settings.clone();
        chat.provider = Some("openai".into());
        chat.api_format = Some(kcoder_config::ApiFormat::OpenaiChatCompletions);
        chat.providers
            .get_mut(profile)
            .ok_or("provider_not_declared")?
            .api_format = kcoder_config::ApiFormat::OpenaiChatCompletions;
        chat.base_url = Some(endpoint);
        chat.provider_chat_protocol = kcoder_types::ChatProtocol::Minimax;
        chat.provider_extra_body.clear();
        provider = ProviderFactory::new(&chat)
            .build(ProviderKind::Openai, &settings.model)
            .map_err(|_| "chat_probe_unavailable")?;
    }
    let prompt = if long_probe {
        "Call write exactly once with file_path 'synthetic-probe.txt'. Set content to 200 separate lines. Each line must start with Line N: (N from 1 to 200), followed by the sentence The quick brown fox jumps over the lazy dog. repeated exactly three times. Do not abbreviate or use ellipses. Return only the tool call. This synthetic streaming diagnostic never executes the tool."
    } else {
        "Call write exactly once with file_path 'synthetic-probe.txt'. Set content to 80 lines: Line 1 through Line 80, each on its own line. Return only the tool call. This is a synthetic streaming diagnostic; no tool will actually execute."
    };
    let mut request = MessagesRequest::new(&settings.model, vec![Message::user_text(prompt)])
        .with_max_tokens(max_tokens)
        .with_path_first_tools(true)
        .with_tools(vec![ToolDefinition {
            name: "write".into(),
            description: "Supply synthetic text to a diagnostic collector; no file is written."
                .into(),
            input_schema: json!({"type":"object","properties":{
            "file_path":{"type":"string"},"content":{"type":"string"}
        },"required":["file_path","content"]}),
        }]);
    // Bound optional reasoning as well as the completion; disclose this probe-only override.
    request.recovery_disable_reasoning = true;
    if eager_probe {
        if !matches!(kind, ProviderKind::Anthropic | ProviderKind::Kunlunmeta) {
            return Err("eager_probe_requires_anthropic_transport");
        }
        // This explicit diagnostic variation owns its synthetic tools. It does
        // not weaken Factory validation or save runtime-owned configuration.
        let mut tools = serde_json::to_value(&request.tools).map_err(|_| "probe_schema_invalid")?;
        for tool in tools.as_array_mut().ok_or("probe_schema_invalid")? {
            tool["eager_input_streaming"] = json!(true);
        }
        let mut extra = settings.provider_extra_body.clone();
        extra.insert("tools".into(), tools);
        let key = settings
            .resolve_provider_api_key(Some(profile), None)
            .ok_or("credential_unavailable")?;
        let native = AnthropicProvider::new(key)
            .map_err(|_| "provider_unavailable")?
            .with_base_url(provider.endpoint().ok_or("endpoint_unavailable")?)
            .with_provider_name(provider.name())
            .with_extra_body(extra)
            .with_no_proxy(settings.provider_no_proxy)
            .map_err(|_| "provider_unavailable")?
            .with_proxy_url(settings.provider_proxy_url.clone())
            .map_err(|_| "provider_unavailable")?
            .with_timeout_secs(60)
            .map_err(|_| "provider_unavailable")?;
        provider = Arc::new(native) as Arc<dyn Provider>;
    }
    let started = Instant::now();
    let operation = async {
        let mut stream = provider
            .stream_messages(request)
            .map_err(|_| "request_failed")?;
        let mut observations = Vec::new();
        let mut total_events = 0;
        let mut arguments = ArgumentMetrics::default();
        let mut stop_reason = None;
        let mut usage = None;
        let mut completed = false;
        let mut failure = None;
        while let Some(event) = stream.next().await {
            total_events += 1;
            if total_events > MAX_EVENTS {
                return Err("event_limit");
            }
            let event = match event {
                Ok(event) => event,
                Err(error) => {
                    failure = Some(error.safe_summary().to_string());
                    break;
                }
            };
            let elapsed_ms = started.elapsed().as_millis();
            let observation = match event {
                StreamEvent::ContentBlockStart {
                    index,
                    content_block: ContentBlock::ToolUse { input, .. },
                } => {
                    let bytes = if input.as_object().is_some_and(|v| v.is_empty()) {
                        0
                    } else {
                        serde_json::to_vec(&input)
                            .map_err(|_| "input_unavailable")?
                            .len()
                    };
                    json!({"kind":"tool_start","index":index,"initialArgumentBytes":bytes})
                }
                StreamEvent::ContentBlockDelta {
                    index,
                    delta: ContentDelta::InputJsonDelta { partial_json },
                } => {
                    arguments.observe(&partial_json)?;
                    json!({"kind":"argument_delta","index":index,"bytes":partial_json.len(),
                        "totalBytes":arguments.bytes,"newlineEscapes":arguments.newlines})
                }
                StreamEvent::ContentBlockStop { index } => {
                    json!({"kind":"block_stop","index":index})
                }
                StreamEvent::MessageDelta { delta } => {
                    // Only defined stop reasons enter diagnostics, never arbitrary server text.
                    stop_reason = delta.stop_reason.filter(|s| {
                        matches!(
                            s.as_str(),
                            "end_turn" | "tool_use" | "max_tokens" | "stop_sequence"
                        )
                    });
                    if let Some(value) = delta.usage {
                        usage = Some(
                            json!({"inputTokens":value.input_tokens,"outputTokens":value.output_tokens}),
                        );
                    }
                    continue;
                }
                StreamEvent::MessageStop => {
                    completed = true;
                    json!({"kind":"message_stop"})
                }
                StreamEvent::Error { error } => {
                    failure = Some(
                        kcoder_types::ProviderErrorSummary::new(&error.error_type, None)
                            .to_string(),
                    );
                    break;
                }
                _ => continue,
            };
            let mut observation = observation;
            observation["elapsedMs"] = json!(elapsed_ms);
            observations.push(observation);
            if completed {
                break;
            }
        }
        Ok(
            json!({"status":if failure.is_some() {"failed"} else if completed {"completed"} else {"incomplete"},
            "provider":profile,"model":settings.model,"configuredProviderKind":kind.as_str(),"providerAdapter":provider.name(),
            "requestCount":1,"executedTools":0,"maxTokens":max_tokens,"reasoningSuppressionRequested":true,"explicitEagerProbe":eager_probe,"longProbe":long_probe,
            "explicitMiniMaxChatProbe":minimax_chat_probe,
            "elapsedMs":started.elapsed().as_millis(),"totalEvents":total_events,
            "argumentBytes":arguments.bytes,"newlineEscapes":arguments.newlines,
            "stopReason":stop_reason,"usage":usage,"error":failure,"observations":observations}),
        )
    };
    tokio::time::timeout(Duration::from_secs(60), operation)
        .await
        .map_err(|_| "deadline_exceeded")?
}

fn minimax_chat_endpoint(endpoint: &str) -> Result<String, &'static str> {
    let mut url = reqwest::Url::parse(endpoint).map_err(|_| "official_minimax_origin_required")?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("api.minimax.cn" | "api.minimax.io"))
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("official_minimax_origin_required");
    }
    url.set_path("/v1");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.into())
}

#[derive(Default)]
struct ArgumentMetrics {
    bytes: usize,
    newlines: usize,
    escaped: bool,
}
impl ArgumentMetrics {
    fn observe(&mut self, fragment: &str) -> Result<(), &'static str> {
        self.bytes = self
            .bytes
            .checked_add(fragment.len())
            .ok_or("argument_limit")?;
        if self.bytes > MAX_ARGUMENT_BYTES {
            return Err("argument_limit");
        }
        for byte in fragment.bytes() {
            if self.escaped {
                if byte == b'n' {
                    self.newlines += 1;
                }
                self.escaped = false;
            } else {
                self.escaped = byte == b'\\';
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metrics_handle_escape_boundaries_without_retaining_contents() {
        let mut metrics = ArgumentMetrics::default();
        for fragment in ["one\\", "ntwo\\\\", "nthree\\n"] {
            metrics.observe(fragment).unwrap();
        }
        assert_eq!(metrics.newlines, 2);
        assert_eq!(metrics.bytes, 18);
        assert!(metrics.observe(&"x".repeat(MAX_ARGUMENT_BYTES)).is_err());
    }

    #[test]
    fn chat_comparison_keeps_the_official_credential_origin() {
        assert_eq!(
            minimax_chat_endpoint("https://api.minimax.cn/anthropic").unwrap(),
            "https://api.minimax.cn/v1"
        );
        for input in [
            "http://api.minimax.cn/anthropic",
            "https://api.minimax.cn:8443",
            "https://api.minimax.cn.example/",
            "https://gateway.example/anthropic",
            "https://user@api.minimax.cn/",
        ] {
            assert!(minimax_chat_endpoint(input).is_err());
        }
    }
}

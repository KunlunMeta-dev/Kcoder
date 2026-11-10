use anyhow::{Result, bail};
use kcoder_config::Settings;
use kcoder_provider_transactions::probe::{prepare_probe_profile, run};
use kcoder_types::{Message, MessagesRequest};

pub(super) async fn verify_settings(
    engine: &kcoder_engine::QueryEngine,
    mut settings: Settings,
) -> Result<()> {
    let id = settings
        .active_provider
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("[provider_probe_configuration] Provider unavailable"))?;
    let mut profile = settings
        .providers
        .get(id)
        .ok_or_else(|| anyhow::anyhow!("[provider_probe_configuration] Provider unavailable"))?
        .effective_for_model(&settings.model)?;
    // Preserve actual root/project/CLI request overrides, then bound only the
    // private probe copy before the host constructs its transport.
    profile.extra_body = settings.provider_extra_body.clone();
    profile.max_output_tokens = settings.max_tokens.unwrap_or(profile.max_output_tokens);
    profile.reasoning_effort = settings.model_reasoning_effort.clone();
    profile.capabilities = settings.model_capabilities.clone();
    profile.api_format = settings.api_format.unwrap_or(profile.api_format);
    let authenticated = profile.authentication.is_api_key();
    let (reasoning, max_tokens) = prepare_probe_profile(&mut profile)?;
    settings.provider_extra_body = profile.extra_body;
    settings.max_tokens = Some(max_tokens);
    settings.max_retries = 0;
    settings.request_timeout_secs = Some(15);
    let provider = engine.build_client_model_configuration(&settings)
        .map_err(|_| anyhow::anyhow!("[provider_probe_configuration] Cannot build this API; check credentials and transport settings"))?;
    if authenticated && provider.api_key_configured() == Some(false) {
        bail!("[provider_probe_authentication] Configure an API key before testing");
    }
    let request = MessagesRequest::new(&settings.model, vec![Message::user_text("Reply only OK.")])
        .with_max_tokens(max_tokens)
        .with_reasoning_effort(reasoning);
    run(provider, request).await
}

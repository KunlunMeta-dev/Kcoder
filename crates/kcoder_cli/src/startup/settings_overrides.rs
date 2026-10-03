//! Settings overrides for the shared CLI composition root.

use super::*;

pub(crate) fn resolve_provider_kind(
    cli_provider: Option<&str>,
    env_provider: Option<ApiProviderKind>,
    settings: &Settings,
) -> Result<ApiProviderKind> {
    if let Some(provider) = cli_provider {
        if let Some(provider) = ApiProviderKind::parse(provider) {
            return Ok(provider);
        }
        return ProviderKind::from_settings(settings)?.ok_or_else(|| {
            anyhow::anyhow!("custom provider '{provider}' must declare an api_format")
        });
    }
    if let Some(provider) = env_provider {
        return Ok(provider);
    }
    Ok(ProviderKind::from_settings(settings)?.unwrap_or(ApiProviderKind::Kunlunmeta))
}

/// Model API kind for the session commands.
///
/// `auth` carries its own `--provider`, which names a credential (and may be an id that is not a
/// transport at all). The global flag is marked `global = true`, so Clap also fills the global
/// one for `auth` invocations; resolving it as a transport would reject every such id.
pub(crate) fn cli_provider_kind(
    cli: &Cli,
    env_provider: Option<ApiProviderKind>,
    settings: &Settings,
) -> Result<ApiProviderKind> {
    if matches!(cli.command, Some(Commands::Auth { .. })) {
        return Ok(env_provider.unwrap_or(ApiProviderKind::Kunlunmeta));
    }
    resolve_cli_provider_kind(cli, env_provider, settings)
}

pub(crate) fn resolve_cli_provider_kind(
    cli: &Cli,
    env_provider: Option<ApiProviderKind>,
    settings: &Settings,
) -> Result<ApiProviderKind> {
    if cli
        .model
        .as_deref()
        .is_some_and(|model| model.contains("::"))
    {
        // A qualified model selector explicitly owns its transport identity.
        resolve_provider_kind(None, None, settings)
    } else {
        resolve_provider_kind(cli.provider.as_deref(), env_provider, settings)
    }
}

pub(crate) fn apply_cli_settings_overrides(settings: &mut Settings, cli: &Cli) -> Result<()> {
    if cli.profile.is_some() {
        settings.apply_provider(cli.profile.as_deref())?;
    }
    if let Some(provider) = non_empty(cli.provider.clone()) {
        if cli.profile.is_none() && settings.providers.contains_key(&provider) {
            settings.apply_provider(Some(&provider))?;
        } else {
            // Direct selection of a built-in transport must not inherit protocol or endpoint from the previously active provider.
            settings.active_provider = None;
            settings.active_model_selection = None;
            settings.api_format = None;
            settings.base_url = None;
            settings.request_timeout_secs = None;
            settings.provider_no_proxy = false;
            settings.provider_extra_body.clear();
            settings.provider_chat_protocol = kcoder_types::ChatProtocol::Auto;
            settings.provider = Some(provider);
        }
    }
    if let Some(model) = non_empty(cli.model.clone()) {
        if let Some((provider, model)) = model.split_once("::") {
            settings.apply_discovered_model(provider, model)?;
        } else if let Some(provider) = settings.active_provider.clone() {
            settings.apply_discovered_model(&provider, &model)?;
        } else {
            settings.model = model;
        }
    }
    if settings.model.trim().is_empty() {
        settings.model = default_model_name();
    }
    if let Some(max_tokens) = cli.max_tokens {
        settings.max_tokens = Some(max_tokens);
    }
    if let Some(max_retries) = cli.max_retries {
        settings.max_retries = max_retries;
    }
    if let Some(max_duration_secs) = cli.max_duration_secs {
        settings.max_duration_secs = Some(max_duration_secs);
    }
    if let Some(retry_base_delay_ms) = cli.retry_base_delay_ms {
        settings.retry_base_delay_ms = retry_base_delay_ms;
    }
    let summary_profile_was_explicit = cli.summary_profile.is_some();
    if summary_profile_was_explicit {
        settings.summary_profile = optional_runtime_name(cli.summary_profile.as_deref());
    } else if cli.summary_provider.is_some() || cli.summary_model.is_some() {
        settings.summary_profile = None;
    }
    if cli.summary_provider.is_some() {
        settings.summary_provider = optional_runtime_name(cli.summary_provider.as_deref());
    }
    if cli.summary_model.is_some() {
        settings.summary_model = optional_runtime_name(cli.summary_model.as_deref());
    }
    if let Some(summary_max_tokens) = cli.summary_max_tokens {
        settings.summary_max_tokens = summary_max_tokens.max(1);
    }
    if let Some(permission_mode) = cli.permission_mode {
        settings.permission_mode = permission_mode.into();
    }
    if let Some(api_key) = non_empty(cli.api_key.clone()) {
        settings.api_key = Some(api_key);
    }
    if let Some(api_key) = non_empty(cli.openai_api_key.clone()) {
        settings.openai_api_key = Some(api_key);
    }
    if let Some(api_key) = non_empty(cli.local_api_key.clone()) {
        settings.local_api_key = Some(api_key);
    }
    if let Some(api_key) = non_empty(cli.gemini_api_key.clone()) {
        settings.gemini_api_key = Some(api_key);
    }
    if let Some(api_key) = non_empty(cli.grok_api_key.clone()) {
        settings.grok_api_key = Some(api_key);
    }
    if let Some(base_url) = non_empty(cli.base_url.clone()) {
        settings.base_url = Some(base_url);
    }
    if let Some(value) = non_empty(cli.openai_base_url.clone()) {
        settings.openai_base_url = Some(value);
    }
    if let Some(value) = non_empty(cli.openai_user_agent.clone()) {
        settings.openai_user_agent = Some(value);
    }
    if let Some(value) = non_empty(cli.local_base_url.clone()) {
        settings.local_base_url = Some(value);
    }
    settings.tui.no_alt_screen = cli.no_alt_screen;
    settings.auto_skill_review_enabled = cli.skill_review;
    if cli.training_mode {
        settings.enable_training_mode();
    }
    Ok(())
}

pub(crate) fn runtime_override_source(cli: &Cli, key: &str) -> Option<&'static str> {
    if cli.profile.is_some()
        && matches!(
            key,
            "model"
                | "provider"
                | "api_format"
                | "base_url"
                | "context_window_tokens"
                | "context_output_headroom"
                | "max_tokens"
                | "model_reasoning_effort"
        )
    {
        return Some("CLI profile");
    }
    let overridden = match key {
        "model" => cli.model.is_some(),
        "provider" => cli.provider.is_some(),
        "max_tokens" => cli.max_tokens.is_some(),
        "max_retries" => cli.max_retries.is_some(),
        "max_duration_secs" => cli.max_duration_secs.is_some(),
        "retry_base_delay_ms" => cli.retry_base_delay_ms.is_some(),
        "summary_provider" => cli.summary_provider.is_some(),
        "summary_profile" => cli.summary_profile.is_some(),
        "summary_model" => cli.summary_model.is_some(),
        "summary_max_tokens" => cli.summary_max_tokens.is_some(),
        "permission_mode" => cli.permission_mode.is_some(),
        "base_url" => cli.base_url.is_some(),
        "openai_base_url" => cli.openai_base_url.is_some(),
        "local_base_url" => cli.local_base_url.is_some(),
        _ => false,
    };
    overridden.then_some("CLI/environment")
}

pub(crate) fn provider_overrides_from_cli(cli: &Cli) -> ProviderBuildOverrides {
    ProviderBuildOverrides {
        api_key: cli.api_key.clone(),
        base_url: cli.base_url.clone(),
        openai_api_key: cli.openai_api_key.clone(),
        openai_base_url: cli.openai_base_url.clone(),
        openai_user_agent: cli.openai_user_agent.clone(),
        local_base_url: cli.local_base_url.clone(),
        local_api_key: cli.local_api_key.clone(),
        gemini_api_key: cli.gemini_api_key.clone(),
        grok_api_key: cli.grok_api_key.clone(),
    }
}

pub(crate) fn local_base_url(cli: &Cli, settings: &Settings) -> String {
    ProviderFactory::new(settings)
        .with_overrides(provider_overrides_from_cli(cli))
        .local_base_url()
}

pub(crate) fn effective_setting_source<'a>(
    cli: &Cli,
    loaded: &'a LoadedSettings,
    key: &str,
) -> &'a str {
    if let Some(source) = runtime_override_source(cli, key) {
        return source;
    }
    loaded
        .field_sources
        .get(key)
        .map(|scope| scope.as_str())
        .unwrap_or("default")
}

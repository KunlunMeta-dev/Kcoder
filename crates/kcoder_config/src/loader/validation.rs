//! Validation stage of configuration loading.

use super::*;

pub(super) fn normalize_config_version(document: &mut Value) -> Result<()> {
    let Some(root) = document.as_object_mut() else {
        return Ok(());
    };
    let meta = root
        .entry("meta")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(meta) = meta.as_object_mut() else {
        bail!("settings meta must be an object");
    };
    let Some(version_value) = meta.get("config_version") else {
        meta.insert(
            "config_version".to_string(),
            Value::from(CURRENT_CONFIG_VERSION),
        );
        return Ok(());
    };
    let Some(version) = version_value.as_u64() else {
        bail!("settings meta.config_version must be integer v1");
    };
    if version > CURRENT_CONFIG_VERSION {
        bail!(
            "unsupported future settings meta.config_version={version}; current supported version is v{}",
            CURRENT_CONFIG_VERSION
        );
    }
    if version < CURRENT_CONFIG_VERSION {
        bail!(
            "unsupported settings meta.config_version={version}; current supported version is v{}",
            CURRENT_CONFIG_VERSION
        );
    }
    Ok(())
}

pub(super) fn validate_settings_document(value: &Value) -> Result<()> {
    let mut normalized_value = value.clone();
    normalize_config_version(&mut normalized_value)?;
    normalize_legacy_settings_document(&mut normalized_value);
    crate::schema::validate_settings_schema(&normalized_value)
        .map_err(|error| anyhow::anyhow!("settings failed embedded schema validation: {error}"))?;
    let complete_providers = normalized_value
        .get("providers")
        .and_then(Value::as_object)
        .map(|profiles| {
            profiles
                .iter()
                .filter(|(_, profile)| {
                    let transport_complete = ["api_format", "endpoint", "default_model"]
                        .iter()
                        .all(|field| profile.get(field).is_some());
                    transport_complete
                        && (profile
                            .get("models")
                            .and_then(Value::as_object)
                            .is_some_and(|models| !models.is_empty())
                            || [
                                "api_format",
                                "endpoint",
                                "default_model",
                                "context_window_tokens",
                                "output_headroom_tokens",
                                "max_output_tokens",
                            ]
                            .iter()
                            .all(|field| profile.get(field).is_some()))
                })
                .map(|(name, _)| name.clone())
                .collect::<std::collections::BTreeSet<_>>()
        })
        .unwrap_or_default();
    let mut validation_value = normalized_value;
    if let Some(profiles) = validation_value
        .get_mut("providers")
        .and_then(Value::as_object_mut)
    {
        for profile in profiles.values_mut() {
            let mut complete = serde_json::json!({
                "api_format": "anthropic_messages",
                "endpoint": "https://placeholder.invalid",
                "default_model": "placeholder",
                "context_window_tokens": 1,
                "output_headroom_tokens": 1,
                "max_output_tokens": 1
            });
            merge_settings_value(&mut complete, std::mem::replace(profile, Value::Null));
            *profile = complete;
        }
    }
    let content = serde_json::to_string(&validation_value)
        .context("failed to serialize settings for validation")?;
    let mut deserializer = serde_json::Deserializer::from_str(&content);
    let mut unknown = Vec::new();
    let settings: Settings = serde_ignored::deserialize(&mut deserializer, |path| {
        let path = path.to_string();
        // The `hooks` top-level field is owned by the hooks subsystem
        // (kcoder_hooks reads the same settings files); it is not part of the
        // main settings schema but must not fail startup.
        if path != "hooks" && path != "$schema" {
            unknown.push(path);
        }
    })
    .context("settings contain an invalid value")?;
    if !unknown.is_empty() {
        unknown.sort();
        unknown.dedup();
        bail!("unknown setting field(s): {}", unknown.join(", "));
    }
    if let (Some(total), Some(output)) = (
        settings.context_window_tokens,
        settings.context_output_headroom,
    ) {
        let hard = settings
            .context_hard_input_tokens
            .unwrap_or_else(|| total.saturating_sub(output));
        if hard == 0 || hard >= total {
            bail!(
                "context_hard_input_tokens must be greater than zero and below context_window_tokens"
            );
        }
        if settings
            .auto_compact_threshold_tokens
            .is_some_and(|soft| soft == 0 || soft >= hard)
        {
            bail!(
                "auto_compact_threshold_tokens must be greater than zero and below the hard input limit"
            );
        }
        let soft = settings.auto_compact_threshold_tokens.unwrap_or_else(|| {
            let percentage = settings
                .context_compaction
                .auto_threshold
                .percentage_for(total);
            hard.saturating_mul(percentage) / 100
        });
        if settings
            .prefire_threshold_tokens
            .is_some_and(|prefire| prefire == 0 || prefire >= soft)
        {
            bail!(
                "prefire_threshold_tokens must be greater than zero and below auto_compact_threshold_tokens"
            );
        }
    }
    if settings.estimated_tool_growth_tokens == Some(0) {
        bail!("estimated_tool_growth_tokens must be greater than zero");
    }
    for (name, profile) in &settings.providers {
        if !complete_providers.contains(name) {
            continue;
        }
        if profile.endpoint.trim().is_empty()
            || !(profile.endpoint.starts_with("http://")
                || profile.endpoint.starts_with("https://"))
        {
            bail!("Provider '{name}' has an invalid HTTP(S) endpoint");
        }
        if profile.default_model.trim().is_empty() {
            bail!("provider '{name}' has an empty default_model");
        }
        let credential = profile.credential(name);
        crate::validate_provider_id(&credential.id)
            .with_context(|| format!("Provider '{name}' has an invalid provider id"))?;
        for env_name in &credential.env {
            let mut chars = env_name.chars();
            let valid = chars
                .next()
                .is_some_and(|ch| ch == '_' || ch.is_ascii_alphabetic())
                && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric());
            if !valid {
                bail!("Provider '{name}' has invalid credential_env name '{env_name}'");
            }
        }
        profile
            .validate_models()
            .with_context(|| format!("Provider '{name}' has invalid model configuration"))?;
        if profile.request_timeout_secs == Some(0) {
            bail!("Provider '{name}' request_timeout_secs must be greater than zero");
        }
        if profile.retry_base_delay_ms == Some(0) {
            bail!("Provider '{name}' retry_base_delay_ms must be greater than zero");
        }
        let provider = crate::validate_provider_id(name)?;
        let compatible = match provider.as_str() {
            "anthropic" | "kunlunmeta" => profile.api_format == crate::ApiFormat::AnthropicMessages,
            "openai" | "local" | "grok" => matches!(
                profile.api_format,
                crate::ApiFormat::OpenaiChatCompletions | crate::ApiFormat::OpenaiResponses
            ),
            "gemini" => profile.api_format == crate::ApiFormat::GeminiGenerateContent,
            // Custom providers select their transport explicitly with api_format.
            _ => true,
        };
        if !compatible {
            bail!(
                "provider '{name}' uses incompatible api_format '{}'",
                profile.api_format.as_str()
            );
        }
    }
    Ok(())
}

pub(super) fn validate_profile_references(value: &Value) -> Result<()> {
    let settings: Settings =
        serde_json::from_value(value.clone()).context("failed to validate Provider references")?;
    if let Some(profile) = settings.summary_profile.as_deref()
        && !settings.providers.contains_key(profile)
    {
        bail!("summary_profile references unknown Provider '{profile}'");
    }
    if let Some(profile) = settings.goal_pro.verifier_profile.as_deref()
        && !settings.providers.contains_key(profile)
    {
        bail!("goal_pro.verifier_profile references unknown Provider '{profile}'");
    }
    for slot in &settings.goal_pro.verifier_models {
        if let Some(profile) = slot.profile.as_deref()
            && !settings.providers.contains_key(profile)
        {
            bail!("goal_pro.verifier_models references unknown Provider '{profile}'");
        }
    }
    validate_orchestrate_settings(&settings)?;
    for (id, profile) in &settings.providers {
        if !profile.authentication.is_api_key()
            && profile.api_format != crate::ApiFormat::OpenaiChatCompletions
        {
            bail!(
                "Provider '{id}' supports authentication.mode=none only with openai_chat_completions"
            );
        }
    }
    validate_goal_pro_model_escalation(&settings)?;
    for (preset_name, preset) in &settings.moa.presets {
        for slot in preset
            .reference_models
            .iter()
            .chain(std::iter::once(&preset.aggregator))
        {
            if let Some(profile) = slot.profile.as_deref()
                && !settings.providers.contains_key(profile)
            {
                bail!("MoA preset '{preset_name}' references unknown Provider '{profile}'");
            }
        }
    }
    Ok(())
}

pub(super) fn validate_orchestrate_settings(settings: &Settings) -> Result<()> {
    let orchestrate = &settings.orchestrate;
    if let Some(allowlist) = orchestrate.main.optional_tool_allowlist.as_ref() {
        if allowlist.iter().any(|tool| tool.trim().is_empty()) {
            bail!("orchestrate.main.optional_tool_allowlist contains an empty tool name");
        }
        let core = crate::orchestrate_main_core_tools();
        let protected = allowlist
            .iter()
            .filter(|tool| core.contains(&tool.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if !protected.is_empty() {
            bail!(
                "orchestrate.main.optional_tool_allowlist must not list protected core capabilities because they are always enabled: {}",
                protected.join(", ")
            );
        }
        let optional = crate::orchestrate_main_optional_tools();
        let unknown = allowlist
            .iter()
            .filter(|tool| !optional.contains(&tool.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if !unknown.is_empty() {
            bail!(
                "orchestrate.main.optional_tool_allowlist contains unknown optional tools: {}",
                unknown.join(", ")
            );
        }
    }
    if !(30..=3_600).contains(&orchestrate.delivery.lease_timeout_seconds) {
        bail!("orchestrate.delivery.lease_timeout_seconds must be between 30 and 3600");
    }
    if !(1..=64).contains(&orchestrate.delivery.max_attempts) {
        bail!("orchestrate.delivery.max_attempts must be between 1 and 64");
    }
    if !(1..=100).contains(&orchestrate.fleet.max_members) {
        bail!("orchestrate.fleet.max_members must be between 1 and 100");
    }
    if !(1_024..=32_768).contains(&orchestrate.fleet.max_inject_bytes) {
        bail!("orchestrate.fleet.max_inject_bytes must be between 1024 and 32768");
    }
    for (name, value) in [
        (
            "repeated_action_threshold",
            orchestrate.breaker.repeated_action_threshold,
        ),
        (
            "consecutive_error_threshold",
            orchestrate.breaker.consecutive_error_threshold,
        ),
        ("no_progress_rounds", orchestrate.breaker.no_progress_rounds),
    ] {
        if !(1..=64).contains(&value) {
            bail!("orchestrate.breaker.{name} must be between 1 and 64");
        }
    }
    if !(128..=65_536).contains(&orchestrate.audit.max_events) {
        bail!("orchestrate.audit.max_events must be between 128 and 65536");
    }
    if !(512..=65_536).contains(&orchestrate.audit.max_event_bytes) {
        bail!("orchestrate.audit.max_event_bytes must be between 512 and 65536");
    }
    for (tier_name, slot) in &settings.orchestrate.tiers {
        if tier_name.trim().is_empty() {
            bail!("orchestrate.tiers names must not be empty");
        }
        if slot.profile.is_some() && (slot.provider.is_some() || slot.model.is_some()) {
            bail!("orchestrate.tiers.{tier_name} cannot combine profile with provider/model");
        }
        if let Some(referenced) = slot.profile.as_deref().or(slot.provider.as_deref())
            && !settings.providers.contains_key(referenced)
        {
            bail!("orchestrate.tiers.{tier_name} references unknown Provider '{referenced}'");
        }
    }
    for (name, entry) in &settings.orchestrate.roster {
        if !matches!(name.as_str(), "junior" | "oracle" | "librarian" | "critic") {
            bail!("orchestrate.roster contains unknown persona '{name}'");
        }
        if !settings.orchestrate.tiers.contains_key(&entry.tier) {
            bail!(
                "orchestrate.roster.{name}.tier references unknown tier '{}'",
                entry.tier
            );
        }
        if let Some(allowlist) = entry.tool_allowlist.as_ref()
            && allowlist.iter().any(|tool| tool.trim().is_empty())
        {
            bail!("orchestrate.roster.{name}.tool_allowlist contains an empty tool name");
        }
        if let Some(allowlist) = entry.tool_allowlist.as_ref() {
            let maximum = crate::orchestrate_persona_max_tools(name)
                .expect("known persona must have a compiled capability profile");
            let expanded = allowlist
                .iter()
                .filter(|tool| !maximum.contains(&tool.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            if !expanded.is_empty() {
                bail!(
                    "orchestrate.roster.{name}.tool_allowlist would expand the compiled base-role capability with: {}",
                    expanded.join(", ")
                );
            }
        }
        if entry.context_mode == crate::OrchestrateContextMode::Full {
            let tier = settings
                .orchestrate
                .tiers
                .get(&entry.tier)
                .expect("tier existence checked above");
            if let Some(target_name) = tier.profile.as_deref().or(tier.provider.as_deref()) {
                let main_name = settings
                    .active_provider
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("kunlunmeta");
                let main = settings.providers.get(main_name).ok_or_else(|| {
                    anyhow::anyhow!(
                        "orchestrate.roster.{name}.context_mode=full requires active Provider '{main_name}'"
                    )
                })?;
                let target = settings.providers.get(target_name).ok_or_else(|| {
                    anyhow::anyhow!(
                        "orchestrate.roster.{name} references unknown Provider '{target_name}'"
                    )
                })?;
                let main = main.effective_for_model(if main.has_model(&settings.model) {
                    &settings.model
                } else {
                    &main.default_model
                })?;
                let target_model = tier.model.as_deref().unwrap_or(&target.default_model);
                let target = if target.has_model(target_model) {
                    target.effective_for_model(target_model)?
                } else if target.models.is_empty() {
                    target.effective_for_model(&target.default_model)?
                } else {
                    bail!(
                        "orchestrate full-context tier references unconfigured model '{target_model}'"
                    );
                };
                if target.api_format != main.api_format
                    || target.context_window_tokens != main.context_window_tokens
                {
                    bail!(
                        "orchestrate.roster.{name}.context_mode=full is incompatible: tier Provider '{target_name}' must share api_format and context_window_tokens with active Provider '{main_name}'"
                    );
                }
            }
        }
    }
    Ok(())
}

/// Load-time consistency validation for Goal Pro model-escalation rungs. Full
/// primary-agent context inheritance requires every rung to share the primary
/// provider's api_format and context window; fail fast otherwise.
pub(super) fn validate_goal_pro_model_escalation(settings: &Settings) -> Result<()> {
    let escalation = &settings.goal_pro.model_escalation;
    if !escalation.enabled {
        return Ok(());
    }
    if escalation.models.is_empty() {
        bail!("goal_pro.model_escalation is enabled but models is empty");
    }
    if escalation.threshold == 0 {
        bail!("goal_pro.model_escalation.threshold must be at least 1");
    }
    let main_name = settings
        .active_provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("kunlunmeta");
    let main = settings.providers.get(main_name).ok_or_else(|| {
        anyhow::anyhow!(
            "goal_pro.model_escalation requires the active Provider '{main_name}' to be declared in providers"
        )
    })?;
    let main = main.effective_for_model(if main.has_model(&settings.model) {
        &settings.model
    } else {
        &main.default_model
    })?;
    for slot in &escalation.models {
        let referenced = slot.profile.as_deref().or(slot.provider.as_deref());
        let Some(referenced) = referenced else {
            // Three empty slots inherit the primary runtime and therefore always match the primary provider.
            continue;
        };
        let config = settings.providers.get(referenced).ok_or_else(|| {
            anyhow::anyhow!(
                "goal_pro.model_escalation.models references unknown Provider '{referenced}'"
            )
        })?;
        let selected_model = slot.model.as_deref().unwrap_or(&config.default_model);
        let config = if config.has_model(selected_model) {
            config.effective_for_model(selected_model)?
        } else if config.models.is_empty() {
            config.effective_for_model(&config.default_model)?
        } else {
            bail!("goal_pro.model_escalation references unconfigured model '{selected_model}'");
        };
        if config.api_format != main.api_format {
            bail!(
                "goal_pro.model_escalation entry '{referenced}' uses api_format '{}' but the main Provider '{main_name}' uses '{}'; escalation models must share the main Provider's api_format and context window",
                config.api_format.as_str(),
                main.api_format.as_str(),
            );
        }
        if config.context_window_tokens != main.context_window_tokens {
            bail!(
                "goal_pro.model_escalation entry '{referenced}' has context_window_tokens={} but the main Provider '{main_name}' has {}; escalation models must share the main Provider's api_format and context window",
                config.context_window_tokens,
                main.context_window_tokens,
            );
        }
    }
    Ok(())
}

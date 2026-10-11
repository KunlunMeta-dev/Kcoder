//! Provider resolution stage of configuration loading.

use super::*;

/// Provider names explicitly declared by a settings document; empty when it has no providers object.
pub(super) fn provider_names_of(value: &Value) -> impl Iterator<Item = String> + '_ {
    value
        .get("providers")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|profiles| profiles.keys().cloned())
}

/// Bound inherited output defaults by the configured context window without
/// changing limits explicitly declared in any settings layer.
pub(super) fn normalize_default_provider_output_tokens(
    merged: &mut Value,
    field_sources: &BTreeMap<String, ConfigScope>,
    overlay_fields: &BTreeSet<String>,
) {
    let Some(profiles) = merged.get_mut("providers").and_then(Value::as_object_mut) else {
        return;
    };
    for (name, profile) in profiles {
        let path = format!("providers.{name}.max_output_tokens");
        if field_sources.contains_key(&path) || overlay_fields.contains(&path) {
            continue;
        }
        let Some(profile) = profile.as_object_mut() else {
            continue;
        };
        if profile
            .get("models")
            .and_then(Value::as_object)
            .is_some_and(|models| !models.is_empty())
        {
            continue;
        }
        let Some(context_window_tokens) = profile
            .get("context_window_tokens")
            .and_then(Value::as_u64)
            .filter(|tokens| *tokens > 0)
        else {
            continue;
        };
        let default_tokens = u64::from(kcoder_types::DEFAULT_MODEL_OUTPUT_TOKENS);
        let inherited_tokens = profile
            .get("max_output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(default_tokens);
        profile.insert(
            "max_output_tokens".to_string(),
            Value::from(
                inherited_tokens
                    .min(default_tokens)
                    .min(context_window_tokens),
            ),
        );
    }
}

pub(super) fn record_expanded_profile_sources(
    merged: &Value,
    field_sources: &mut BTreeMap<String, ConfigScope>,
    overlay_fields: &mut BTreeSet<String>,
) {
    let Some(profile) = merged.get("active_provider").and_then(Value::as_str) else {
        return;
    };
    for (profile_field, runtime_field) in [
        ("api_format", "api_format"),
        ("endpoint", "base_url"),
        ("default_model", "model"),
        ("reasoning_effort", "model_reasoning_effort"),
        ("reasoning_policy", "model_reasoning_policy"),
        ("context_window_tokens", "context_window_tokens"),
        (
            "auto_compact_threshold_tokens",
            "auto_compact_threshold_tokens",
        ),
        ("output_headroom_tokens", "context_output_headroom"),
        ("max_output_tokens", "max_tokens"),
        ("request_timeout_secs", "request_timeout_secs"),
        ("user_agent", "openai_user_agent"),
        ("max_retries", "max_retries"),
        ("retry_base_delay_ms", "retry_base_delay_ms"),
        ("no_proxy", "provider_no_proxy"),
    ] {
        if field_sources.contains_key(runtime_field) || overlay_fields.contains(runtime_field) {
            continue;
        }
        let definition = &merged["providers"][profile];
        let selected_model = merged
            .get("active_model_selection")
            .filter(|selection| selection["source_profile"].as_str() == Some(profile))
            .and_then(|selection| selection["model"].as_str())
            .or_else(|| merged.get("model").and_then(Value::as_str))
            .filter(|model| definition["models"].get(*model).is_some())
            .or_else(|| definition["default_model"].as_str());
        let profile_path = if let Some(model) = selected_model
            && definition["models"][model].get(profile_field).is_some()
        {
            format!("providers.{profile}.models.{model}.{profile_field}")
        } else {
            format!("providers.{profile}.{profile_field}")
        };
        if overlay_fields.contains(&profile_path) {
            overlay_fields.insert(runtime_field.to_string());
        } else if let Some(scope) = field_sources.get(&profile_path).copied() {
            field_sources.insert(runtime_field.to_string(), scope);
        }
    }
}

pub(super) fn expand_active_provider_below_explicit_settings(merged: &mut Value) -> Result<()> {
    let configured: Settings =
        serde_json::from_value(merged.clone()).context("failed to inspect configured Provider")?;
    let Some(name) = configured.active_provider.as_deref() else {
        return Ok(());
    };
    let profile = configured
        .providers
        .get(name)
        .ok_or_else(|| anyhow::anyhow!("active_provider '{name}' is not present in providers"))?;
    let selected_model = configured
        .active_model_selection
        .as_ref()
        .filter(|selection| selection.source_profile == name)
        .map(|selection| selection.model.as_str())
        .or_else(|| merged.get("model").and_then(Value::as_str))
        .filter(|model| profile.has_model(model))
        .unwrap_or(&profile.default_model);
    let profile = profile.effective_for_model(selected_model)?;
    let mut profile_values = serde_json::json!({
        "active_provider": name,
        "provider": name,
        "api_format": profile.api_format,
        "base_url": profile.endpoint,
        "model": profile.default_model,
        "model_reasoning_effort": profile.reasoning_effort,
        "model_reasoning_policy": profile.reasoning_policy,
        "context_window_tokens": profile.context_window_tokens,
        "auto_compact_threshold_tokens": profile.auto_compact_threshold_tokens,
        "context_output_headroom": profile.output_headroom_tokens,
        "max_tokens": profile.max_output_tokens,
        "request_timeout_secs": profile.request_timeout_secs,
        "openai_user_agent": profile.user_agent,
        "provider_no_proxy": profile.no_proxy,
        "provider_extra_body": profile.extra_body,
        "provider_chat_protocol": profile.chat_protocol,
        "model_capabilities": profile.capabilities,
    });
    if let Some(max_retries) = profile.max_retries {
        profile_values["max_retries"] = serde_json::json!(max_retries);
    }
    if let Some(retry_base_delay_ms) = profile.retry_base_delay_ms {
        profile_values["retry_base_delay_ms"] = serde_json::json!(retry_base_delay_ms);
    }
    merge_settings_value(&mut profile_values, std::mem::take(merged));
    *merged = profile_values;
    Ok(())
}

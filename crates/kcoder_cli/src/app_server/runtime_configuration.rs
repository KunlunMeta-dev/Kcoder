//! Runtime configuration: extracted from the app-server connection boundary.

use super::*;

pub(super) fn configured_model_catalog_response(
    profiles: Vec<kcoder_engine::ConfiguredModelProfile>,
) -> Value {
    let mut groups =
        std::collections::BTreeMap::<String, Vec<kcoder_engine::ConfiguredModelProfile>>::new();
    for profile in profiles {
        groups
            .entry(profile.profile_name.clone())
            .or_default()
            .push(profile);
    }
    let mut models = Vec::new();
    let providers = groups
        .into_iter()
        .map(|(provider_id, profiles)| {
            let current = profiles.iter().any(|profile| profile.current);
            let available = profiles.iter().any(|profile| profile.available);
            let provider_name = profiles[0].provider.clone();
            let error = if available {
                None
            } else {
                profiles.iter().find_map(|profile| profile.error.clone())
            };
            let data = profiles
                .into_iter()
                .map(|profile| {
                    let reasoning_efforts = if profile.reasoning {
                        profile.reasoning_effort.iter().cloned().collect()
                    } else {
                        Vec::new()
                    };
                    let entry = kcoder_app_protocol::RuntimeModelCatalogEntry {
                        id: format!("{}::{}", profile.profile_name, profile.model),
                        model: profile.model.clone(),
                        display_name: profile.model,
                        provider_id: profile.profile_name,
                        provider_name: profile.provider,
                        provider_type: "provider".into(),
                        provider_current: current,
                        description: None,
                        hidden: false,
                        is_default: profile.current,
                        default_reasoning_effort: if profile.reasoning {
                            profile.reasoning_effort
                        } else {
                            None
                        },
                        supported_reasoning_efforts: reasoning_efforts,
                        supports_fast_mode: false,
                        supports_vision: profile.vision,
                        configuration: profile.configuration,
                        available: profile.available,
                        error: profile.error,
                    };
                    // All fields are finite scalar values and containers; this serialization
                    // cannot contain credentials or arbitrary vendor request objects.
                    let model = json!(entry);
                    models.push(model.clone());
                    model
                })
                .collect::<Vec<_>>();
            json!({
                "id": provider_id,
                "displayName": provider_name,
                "type": "provider",
                "current": current,
                "available": available,
                "error": error,
                "data": data,
            })
        })
        .collect::<Vec<_>>();
    json!({"data": models, "providers": providers})
}

/// Scenario runtimes have a real injected provider but intentionally no saved
/// credentials/profile. Publish the same qualified IDs as configured profiles.
pub(super) fn scenario_model_catalog_response(model: &str) -> Value {
    configured_model_catalog_response(vec![kcoder_engine::ConfiguredModelProfile {
        profile_name: "tui-dev-mock".into(),
        provider: "tui-dev-mock".into(),
        model: model.into(),
        current: true,
        vision: true,
        reasoning: false,
        reasoning_effort: None,
        configuration: None,
        available: true,
        error: None,
    }])
}

pub(super) fn runtime_context_request(
    engine: &QueryEngine,
    method: &str,
    params: &Value,
) -> Result<Value> {
    const MAX_INSTRUCTIONS_BYTES: usize = 64 * 1024;
    let settings_path = engine.settings_persistence_path().context(
        "runtime context persistence is disabled because this engine has no explicit user settings path",
    )?;
    let user = if method == "runtime.context.update" {
        let object = params
            .as_object()
            .context("runtime.context.update params must be an object")?;
        let only_if_unconfigured = object
            .get("onlyIfUnconfigured")
            .map(|value| {
                value
                    .as_bool()
                    .context("onlyIfUnconfigured must be a boolean")
            })
            .transpose()?
            .unwrap_or(false);
        if !object.contains_key("instructions") && !object.contains_key("personality") {
            anyhow::bail!("runtime.context.update requires instructions or personality");
        }
        kcoder_config::update_settings_file(&settings_path, |user| {
            let instructions_configured = context_field_configured(user, "instructions")?;
            if let Some(value) = object.get("instructions") {
                let instructions = value.as_str().context("instructions must be a string")?;
                if instructions.len() > MAX_INSTRUCTIONS_BYTES {
                    anyhow::bail!("instructions exceed the 64 KiB limit");
                }
                if !only_if_unconfigured || !instructions_configured {
                    kcoder_config::set_dotted_value(
                        user,
                        "studio_context.instructions",
                        Value::String(instructions.to_string()),
                    )?;
                    kcoder_config::set_dotted_value(
                        user,
                        "studio_context.instructions_configured",
                        Value::Bool(true),
                    )?;
                }
            }
            let personality_configured = context_field_configured(user, "personality")?;
            if let Some(value) = object.get("personality") {
                let personality = value.as_str().context("personality must be a string")?;
                if !matches!(personality, "friendly" | "pragmatic") {
                    anyhow::bail!("personality must be friendly or pragmatic");
                }
                if !only_if_unconfigured || !personality_configured {
                    kcoder_config::set_dotted_value(
                        user,
                        "studio_context.personality",
                        Value::String(personality.to_string()),
                    )?;
                    kcoder_config::set_dotted_value(
                        user,
                        "studio_context.personality_configured",
                        Value::Bool(true),
                    )?;
                }
            }
            Ok(())
        })?
    } else {
        kcoder_config::read_settings_file(&settings_path)?
    };
    let instructions_configured = context_field_configured(&user, "instructions")?;
    let personality_configured = context_field_configured(&user, "personality")?;
    let instructions = kcoder_config::dotted_value(&user, "studio_context.instructions")?
        .and_then(Value::as_str)
        .unwrap_or_default();
    let personality = kcoder_config::dotted_value(&user, "studio_context.personality")?
        .and_then(Value::as_str)
        .unwrap_or("pragmatic");
    Ok(json!({
        "instructions": instructions,
        "personality": personality,
        "instructionsConfigured": instructions_configured,
        "personalityConfigured": personality_configured,
        "configPath": settings_path,
    }))
}

pub(super) fn context_field_configured(user: &Value, field: &str) -> Result<bool> {
    let marker = format!("studio_context.{field}_configured");
    if let Some(value) = kcoder_config::dotted_value(user, &marker)? {
        return value
            .as_bool()
            .with_context(|| format!("{marker} must be a boolean"));
    }
    Ok(kcoder_config::dotted_value(user, &format!("studio_context.{field}"))?.is_some())
}

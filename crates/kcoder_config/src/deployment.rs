use super::{
    GoalProTestScope, GoalProVerificationSettings, ProviderConfig,
    normalize_legacy_settings_document,
};
use serde_json::Value;
use std::collections::BTreeMap;

pub const DEFAULT_ACTIVE_PROVIDER: &str = "kunlunmeta";
pub const DEFAULT_MODEL: &str = "MiniMax-M3";
pub const DEFAULT_KUNLUNMETA_ENDPOINT: &str = "http://127.0.0.1:8000";
pub const DEFAULT_ANTHROPIC_ENDPOINT: &str = "https://api.anthropic.com";
pub const DEFAULT_OPENAI_ENDPOINT: &str = "https://api.openai.com/v1";
pub const DEFAULT_LOCAL_ENDPOINT: &str = "http://127.0.0.1:8000/v1";
pub const DEFAULT_GEMINI_ENDPOINT: &str = "https://generativelanguage.googleapis.com";
pub const DEFAULT_GROK_ENDPOINT: &str = "https://api.x.ai/v1";
pub const DEFAULT_REQUEST_TIMEOUT_SECS: u64 = 300;

pub fn default_providers() -> BTreeMap<String, ProviderConfig> {
    serde_json::from_value(
        default_behavior_settings_document()
            .get("providers")
            .cloned()
            .expect("embedded settings must contain providers"),
    )
    .expect("embedded providers must be valid")
}

pub fn default_deployment_settings() -> Value {
    serde_json::json!({
        "providers": default_providers(),
    })
}

fn default_behavior_settings_document() -> Value {
    let document = jsonc_parser::parse_to_serde_value(
        include_str!("../settting_inline.jsonc"),
        &Default::default(),
    )
    .expect("embedded inline settings must be valid JSONC");
    crate::schema::validate_settings_schema(&document)
        .expect("embedded inline settings must match the embedded settings schema");
    document
}

pub fn default_active_provider_name() -> String {
    default_behavior_settings_document()["active_provider"]
        .as_str()
        .expect("embedded settings must name an active Provider")
        .to_string()
}

pub fn default_active_provider_config() -> ProviderConfig {
    let name = default_active_provider_name();
    default_providers()
        .remove(&name)
        .expect("embedded active Provider must exist")
}

pub fn default_model_name() -> String {
    default_active_provider_config().default_model
}

pub fn default_goal_pro_verifier_max_turns() -> usize {
    default_behavior_settings_document()["goal_pro"]["verifier_max_turns"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .expect("embedded settings must define a valid Goal Pro verifier turn limit")
}

pub fn default_goal_pro_completion_rejection_limit() -> usize {
    default_behavior_settings_document()["goal_pro"]["completion_rejection_limit"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .expect("embedded settings must define a valid Goal Pro completion rejection limit")
}

pub fn default_goal_pro_model_escalation_threshold() -> usize {
    default_behavior_settings_document()["goal_pro"]["model_escalation"]["threshold"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .expect("embedded settings must define a valid Goal Pro model escalation threshold")
}

pub fn default_goal_pro_verification_settings() -> GoalProVerificationSettings {
    let value = &default_behavior_settings_document()["goal_pro"]["verification"];
    let boolean = |name: &str| {
        value[name]
            .as_bool()
            .unwrap_or_else(|| panic!("embedded settings must define goal_pro.verification.{name}"))
    };
    let minimum_test_scope = match value["minimum_test_scope"].as_str() {
        Some("focused") => GoalProTestScope::Focused,
        Some("target_suite") => GoalProTestScope::TargetSuite,
        _ => {
            panic!("embedded settings must define a valid goal_pro.verification.minimum_test_scope")
        }
    };
    GoalProVerificationSettings {
        require_tests: boolean("require_tests"),
        require_behavior_delta: boolean("require_behavior_delta"),
        minimum_test_scope,
        require_raw_exit_code: boolean("require_raw_exit_code"),
        allow_workspace_changes: boolean("allow_workspace_changes"),
        isolate_environment: boolean("isolate_environment"),
        allow_dependency_changes: boolean("allow_dependency_changes"),
        allow_network_only_failures: boolean("allow_network_only_failures"),
    }
}

pub fn default_provider_endpoint(provider: &str) -> Option<String> {
    default_providers()
        .remove(provider.trim())
        .map(|provider| provider.endpoint)
}

pub fn default_settings_document() -> Value {
    default_behavior_settings_document()
}

pub fn default_endpoint_for_provider(provider: &str) -> Option<&'static str> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "kunlunmeta" => Some(DEFAULT_KUNLUNMETA_ENDPOINT),
        "anthropic" => Some(DEFAULT_ANTHROPIC_ENDPOINT),
        "openai" => Some(DEFAULT_OPENAI_ENDPOINT),
        "local" | "vllm" | "sglang" => Some(DEFAULT_LOCAL_ENDPOINT),
        "gemini" => Some(DEFAULT_GEMINI_ENDPOINT),
        "grok" => Some(DEFAULT_GROK_ENDPOINT),
        _ => None,
    }
}

pub fn merge_default_deployment_settings(target: &mut Value) {
    merge_missing_json(target, default_deployment_settings());
}

/// Compatibility alias retained for downstream crates while managed deployment fields migrate to provider entries.
#[deprecated(note = "use merge_default_deployment_settings")]
pub fn apply_managed_deployment_settings(target: &mut Value) {
    merge_default_deployment_settings(target);
}

pub fn migrate_deployment_settings(target: &mut Value) {
    if let Some(root) = target.as_object_mut() {
        root.entry("$schema".to_string())
            .or_insert_with(|| Value::String(crate::schema::SETTINGS_SCHEMA_REFERENCE.to_string()));
    }
    normalize_legacy_settings_document(target);
    prepare_legacy_provider_profile(target);
    migrate_legacy_deployment_fields(target);
    merge_default_deployment_settings(target);
}

fn merge_missing_json(target: &mut Value, defaults: Value) {
    if let (Value::Object(target), Value::Object(defaults)) = (target, defaults) {
        for (key, value) in defaults {
            match target.get_mut(&key) {
                Some(existing) => merge_missing_json(existing, value),
                None => {
                    target.insert(key, value);
                }
            }
        }
    }
}

fn prepare_legacy_provider_profile(value: &mut Value) {
    let Some(root) = value.as_object_mut() else {
        return;
    };
    let active_provider = root
        .get("active_provider")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|provider| !provider.is_empty())
        .map(str::to_string);
    if active_provider.as_ref().is_some_and(|provider| {
        root.get("providers")
            .and_then(Value::as_object)
            .is_some_and(|providers| providers.contains_key(provider))
    }) {
        return;
    }
    let Some(provider) = root
        .get("provider")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|provider| !provider.is_empty() && *provider != "kunlunmeta")
        .map(str::to_string)
        .or(active_provider)
        .filter(|provider| provider != "kunlunmeta")
    else {
        return;
    };
    let normalized_provider = match provider.as_str() {
        "vllm" | "sglang" => "local",
        other => other,
    };
    let api_format = match normalized_provider {
        "anthropic" | "kunlunmeta" => "anthropic_messages",
        "gemini" => "gemini_generate_content",
        "openai" | "local" | "grok" => "openai_chat_completions",
        _ => return,
    };
    let endpoint_key = format!("{normalized_provider}_base_url");
    let endpoint = root
        .get(&endpoint_key)
        .or_else(|| root.get("base_url"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| default_provider_endpoint(normalized_provider))
        .or_else(|| default_endpoint_for_provider(normalized_provider).map(str::to_string))
        .expect("supported legacy provider must have a fallback endpoint");
    let model = root
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            default_providers()
                .remove(normalized_provider)
                .map(|provider| provider.default_model)
        })
        .unwrap_or_else(default_model_name);
    let profile = serde_json::json!({
        "api_format": api_format,
        "endpoint": endpoint,
        "default_model": model,
        "context_window_tokens": root.get("context_window_tokens").and_then(Value::as_u64).unwrap_or(128000),
        "output_headroom_tokens": root.get("context_output_headroom").and_then(Value::as_u64).unwrap_or(16384),
        "max_output_tokens": root.get("max_tokens").and_then(Value::as_u64).unwrap_or(16384)
    });
    root.insert(
        "provider".to_string(),
        Value::String(normalized_provider.to_string()),
    );
    root.entry("providers".to_string())
        .or_insert_with(|| serde_json::json!({}))[normalized_provider] = profile;
    root.insert(
        "active_provider".to_string(),
        Value::String(normalized_provider.to_string()),
    );
}

fn migrate_legacy_deployment_fields(value: &mut Value) {
    let Some(root) = value.as_object_mut() else {
        return;
    };
    let selected = root
        .get("active_provider")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(default_active_provider_name);
    let legacy_provider = root
        .remove("provider")
        .and_then(|value| value.as_str().map(str::to_string));
    let mappings = [
        ("api_format", "api_format"),
        ("base_url", "endpoint"),
        ("model", "default_model"),
        ("model_reasoning_effort", "reasoning_effort"),
        ("model_reasoning_policy", "reasoning_policy"),
        ("context_window_tokens", "context_window_tokens"),
        (
            "auto_compact_threshold_tokens",
            "auto_compact_threshold_tokens",
        ),
        ("context_output_headroom", "output_headroom_tokens"),
        ("max_tokens", "max_output_tokens"),
        ("request_timeout_secs", "request_timeout_secs"),
        ("openai_user_agent", "user_agent"),
        ("max_retries", "max_retries"),
        ("retry_base_delay_ms", "retry_base_delay_ms"),
        ("provider_no_proxy", "no_proxy"),
        ("provider_extra_body", "extra_body"),
    ];
    let mut migrated = Vec::new();
    for (old_key, profile_key) in mappings {
        if let Some(field) = root.remove(old_key).filter(|field| !field.is_null()) {
            migrated.push((profile_key.to_string(), field));
        }
    }
    let provider = legacy_provider
        .or_else(|| {
            root.get("providers")?
                .get(&selected)
                .map(|_| selected.clone())
        })
        .or_else(|| default_providers().get(&selected).map(|_| selected.clone()));
    let endpoint_key = provider.as_deref().map(|provider| match provider {
        "kunlunmeta" => "kunlunmeta_base_url",
        "anthropic" => "anthropic_base_url",
        "openai" => "openai_base_url",
        "local" => "local_base_url",
        "gemini" => "gemini_base_url",
        "grok" => "grok_base_url",
        _ => "",
    });
    if let Some(endpoint_key) = endpoint_key.filter(|key| !key.is_empty())
        && let Some(endpoint) = root.remove(endpoint_key).filter(|field| !field.is_null())
    {
        migrated.push(("endpoint".to_string(), endpoint));
    }
    let bundled_profiles = default_providers();
    let profiles = root
        .entry("providers".to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    if profiles.get(&selected).is_none()
        && let Some(default_profile) = bundled_profiles.get(&selected)
    {
        profiles[&selected] =
            serde_json::to_value(default_profile).expect("bundled Provider must serialize");
    }
    if let Some(profile) = root
        .get_mut("providers")
        .and_then(Value::as_object_mut)
        .and_then(|profiles| profiles.get_mut(&selected))
        .and_then(Value::as_object_mut)
    {
        for (key, field) in migrated {
            profile.insert(key, field);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ApiFormat;

    #[test]
    fn embedded_settings_accept_jsonc_comments_and_trailing_commas() {
        let value: Value = jsonc_parser::parse_to_serde_value(
            "{ // line comment\n \"value\": 1, /* block comment */ }",
            &Default::default(),
        )
        .unwrap();

        assert_eq!(value["value"], 1);
        assert!(default_settings_document().is_object());
    }

    #[test]
    fn deployment_value_is_derived_from_typed_profiles() {
        let value = default_deployment_settings();
        let profiles = default_providers();

        assert_eq!(
            profiles.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["kunlunmeta"]
        );
        assert!(value.get("active_provider").is_none());
        assert_eq!(default_active_provider_name(), DEFAULT_ACTIVE_PROVIDER);
        assert_eq!(default_model_name(), DEFAULT_MODEL);
        let settings = default_settings_document();
        let settings_providers: BTreeMap<String, ProviderConfig> =
            serde_json::from_value(settings["providers"].clone()).unwrap();
        assert_eq!(settings_providers, profiles);
        assert!(settings.get("model_contexts").is_none());
        assert_eq!(
            value["providers"][default_active_provider_name()],
            serde_json::to_value(&profiles[DEFAULT_ACTIVE_PROVIDER]).unwrap()
        );
        assert_eq!(profiles[DEFAULT_ACTIVE_PROVIDER].max_output_tokens, 100_000);
    }

    #[test]
    fn defaults_include_kunlunmeta_profile() {
        let profiles = default_providers();
        let kunlunmeta = &profiles["kunlunmeta"];
        assert_eq!(kunlunmeta.api_format, ApiFormat::AnthropicMessages);
        assert_eq!(kunlunmeta.endpoint, DEFAULT_KUNLUNMETA_ENDPOINT);
        assert_eq!(kunlunmeta.default_model, "MiniMax-M3");
        assert_eq!(
            kunlunmeta.reasoning_effort,
            Some(crate::ReasoningEffort::High)
        );
        assert_eq!(kunlunmeta.context_window_tokens, 1_048_576);
        assert_eq!(kunlunmeta.output_headroom_tokens, 100_000);
        assert_eq!(kunlunmeta.max_output_tokens, 100_000);
        assert_eq!(kunlunmeta.request_timeout_secs, Some(300));
        assert!(kunlunmeta.no_proxy);
    }

    #[test]
    fn migration_moves_retired_minimax_overrides_to_kunlunmeta() {
        let mut value = serde_json::json!({
            "active_provider": "minimax",
            "model": "legacy-model",
            "minimax_base_url": "https://legacy.example/anthropic",
            "max_tokens": 1234,
            "max_tool_timeout_ms": 600000
        });
        migrate_deployment_settings(&mut value);

        assert!(value.get("model").is_none());
        assert!(value.get("max_tool_timeout_ms").is_none());
        assert_eq!(
            value["providers"]["kunlunmeta"]["default_model"],
            "legacy-model"
        );
        assert_eq!(
            value["providers"]["kunlunmeta"]["endpoint"],
            "https://legacy.example/anthropic"
        );
        assert_eq!(value["providers"]["kunlunmeta"]["max_output_tokens"], 1234);
        assert_eq!(value["active_provider"], "kunlunmeta");
        assert!(value["providers"].get("minimax").is_none());
    }

    #[test]
    fn compatibility_merge_preserves_user_and_custom_profiles() {
        let mut value = serde_json::json!({
            "active_provider": "private",
            "providers": {
                "kunlunmeta": {"default_model": "stale"},
                "private": {
                    "api_format": "openai_chat_completions",
                    "endpoint": "https://private.example/v1",
                    "default_model": "private-model",
                    "context_window_tokens": 1000,
                    "output_headroom_tokens": 100,
                    "max_output_tokens": 100
                }
            }
        });

        merge_default_deployment_settings(&mut value);

        assert_eq!(value["active_provider"], "private");
        assert_eq!(value["providers"]["kunlunmeta"]["default_model"], "stale");
        assert_eq!(
            value["providers"]["kunlunmeta"]["endpoint"],
            DEFAULT_KUNLUNMETA_ENDPOINT
        );
        assert_eq!(
            value["providers"]["private"]["default_model"],
            "private-model"
        );
    }

    #[test]
    fn migration_preserves_non_minimax_legacy_provider() {
        let mut value = serde_json::json!({
            "provider": "openai",
            "model": "legacy-openai-model",
            "openai_base_url": "https://gateway.example/v1"
        });
        migrate_deployment_settings(&mut value);

        assert_eq!(value["active_provider"], "openai");
        assert!(value["providers"]["openai"].get("provider").is_none());
        assert_eq!(
            value["providers"]["openai"]["endpoint"],
            "https://gateway.example/v1"
        );
        let settings: crate::Settings = serde_json::from_value(value).unwrap();
        assert_eq!(settings.active_provider.as_deref(), Some("openai"));
    }
}

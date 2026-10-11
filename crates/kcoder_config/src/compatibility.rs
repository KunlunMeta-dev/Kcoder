use serde_json::Value;

/// Top-level settings accepted only so older files keep loading.
///
/// These keys are removed before validation and are never exposed through the
/// typed settings API or written back to disk.
const IGNORED_LEGACY_FIELDS: &[&str] = &["max_tool_timeout_ms"];

pub fn normalize_legacy_settings_document(document: &mut Value) {
    let Some(root) = document.as_object_mut() else {
        return;
    };
    migrate_retired_minimax_settings(root);
    for field in IGNORED_LEGACY_FIELDS {
        root.remove(*field);
    }
    migrate_legacy_foreground_budget(root);
    if !root.contains_key("active_provider")
        && let Some(value) = root.remove("active_profile")
    {
        root.insert("active_provider".to_string(), value);
    }
    if !root.contains_key("providers")
        && let Some(value) = root.remove("provider_profiles")
    {
        root.insert("providers".to_string(), value);
    }
    if let Some(providers) = root.get_mut("providers").and_then(Value::as_object_mut) {
        for provider in providers.values_mut().filter_map(Value::as_object_mut) {
            provider.remove("provider");
            let legacy_model = provider.remove("model");
            if !provider.contains_key("default_model")
                && let Some(model) = legacy_model
            {
                provider.insert("default_model".to_string(), model);
            }
        }
    }
}

fn migrate_retired_minimax_settings(root: &mut serde_json::Map<String, Value>) {
    move_legacy_field(root, "minimax_base_url", "kunlunmeta_base_url");
    move_legacy_field(root, "minimax_api_key", "kunlunmeta_api_key");

    if let Some(providers) = root.get_mut("providers").and_then(Value::as_object_mut)
        && let Some(retired) = providers.remove("minimax")
    {
        providers.entry("kunlunmeta".to_string()).or_insert(retired);
    }

    let mut rewritten = Value::Object(std::mem::take(root));
    rewrite_retired_minimax_references(&mut rewritten);
    *root = rewritten
        .as_object_mut()
        .map(std::mem::take)
        .expect("rewritten settings root remains an object");
}

fn move_legacy_field(root: &mut serde_json::Map<String, Value>, legacy: &str, current: &str) {
    if let Some(value) = root.remove(legacy) {
        root.entry(current.to_string()).or_insert(value);
    }
}

fn rewrite_retired_minimax_references(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, nested) in object {
                let is_provider_reference = key == "provider"
                    || key == "profile"
                    || key == "active_provider"
                    || key.ends_with("_provider")
                    || key.ends_with("_profile");
                if is_provider_reference && nested.as_str() == Some("minimax") {
                    *nested = Value::String("kunlunmeta".to_string());
                } else {
                    rewrite_retired_minimax_references(nested);
                }
            }
        }
        Value::Array(values) => {
            for nested in values {
                rewrite_retired_minimax_references(nested);
            }
        }
        _ => {}
    }
}

fn migrate_legacy_foreground_budget(root: &mut serde_json::Map<String, Value>) {
    let Some(legacy_budget) = root.remove("bash_foreground_budget_ms") else {
        return;
    };

    // The old scalar applied to both shell tools. Keep that behavior when an
    // older settings file is loaded, but materialize it into the extensible
    // per-tool map instead of exposing the legacy top-level field again.
    let tool_limits = root
        .entry("tool_limits")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Some(tool_limits) = tool_limits.as_object_mut() else {
        return;
    };
    if tool_limits.contains_key("foreground_budget_ms") {
        return;
    }

    let tools = serde_json::json!({
        "bash": legacy_budget,
        "PowerShell": legacy_budget,
    });
    tool_limits.insert(
        "foreground_budget_ms".to_string(),
        serde_json::json!({
            "default_ms": 300_000,
            "tools": tools,
        }),
    );
}

pub(crate) fn normalize_legacy_profile_references(document: &mut Value) {
    let Some(root) = document.as_object_mut() else {
        return;
    };
    if root
        .get("providers")
        .and_then(Value::as_object)
        .is_some_and(|profiles| profiles.contains_key("minimax-summary"))
    {
        return;
    }
    replace_retired_minimax_summary_profile(root.get_mut("summary_profile"));
    if let Some(presets) = root
        .get_mut("moa")
        .and_then(|moa| moa.get_mut("presets"))
        .and_then(Value::as_object_mut)
    {
        for preset in presets.values_mut() {
            if let Some(reference_models) = preset
                .get_mut("reference_models")
                .and_then(Value::as_array_mut)
            {
                for model in reference_models {
                    replace_retired_minimax_summary_profile(model.get_mut("profile"));
                }
            }
            replace_retired_minimax_summary_profile(
                preset
                    .get_mut("aggregator")
                    .and_then(|aggregator| aggregator.get_mut("profile")),
            );
        }
    }
}

fn replace_retired_minimax_summary_profile(profile: Option<&mut Value>) {
    if let Some(profile) = profile
        && profile.as_str() == Some("minimax-summary")
    {
        *profile = Value::String("kunlunmeta".to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn obsolete_tool_timeout_cap_is_ignored() {
        let mut document = serde_json::json!({
            "model": "kept",
            "max_tool_timeout_ms": 600_000
        });

        normalize_legacy_settings_document(&mut document);

        assert_eq!(document["model"], "kept");
        assert!(document.get("max_tool_timeout_ms").is_none());
    }

    #[test]
    fn legacy_bash_foreground_budget_moves_to_per_tool_limits() {
        let mut document = serde_json::json!({
            "bash_foreground_budget_ms": 2500
        });

        normalize_legacy_settings_document(&mut document);

        assert!(document.get("bash_foreground_budget_ms").is_none());
        assert_eq!(
            document["tool_limits"]["foreground_budget_ms"]["tools"]["bash"],
            2500
        );
        assert_eq!(
            document["tool_limits"]["foreground_budget_ms"]["tools"]["PowerShell"],
            2500
        );
    }

    #[test]
    fn new_foreground_budget_configuration_wins_over_legacy_alias() {
        let mut document = serde_json::json!({
            "bash_foreground_budget_ms": 2500,
            "tool_limits": {
                "foreground_budget_ms": {
                    "default_ms": 7000,
                    "tools": {"bash": 8000}
                }
            }
        });

        normalize_legacy_settings_document(&mut document);

        assert_eq!(
            document["tool_limits"]["foreground_budget_ms"]["default_ms"],
            7000
        );
        assert_eq!(
            document["tool_limits"]["foreground_budget_ms"]["tools"]["bash"],
            8000
        );
        assert!(
            document["tool_limits"]["foreground_budget_ms"]["tools"]
                .get("PowerShell")
                .is_none()
        );
    }

    #[test]
    fn legacy_provider_entries_normalize_to_provider_id_keys() {
        let mut document = serde_json::json!({
            "active_profile": "deepseek",
            "provider_profiles": {
                "deepseek": {
                    "provider": "openai",
                    "model": "legacy-model",
                    "default_model": "current-model"
                }
            }
        });

        normalize_legacy_settings_document(&mut document);

        assert_eq!(document["active_provider"], "deepseek");
        assert!(document.get("active_profile").is_none());
        assert!(document.get("provider_profiles").is_none());
        assert!(document["providers"]["deepseek"].get("provider").is_none());
        assert!(document["providers"]["deepseek"].get("model").is_none());
        assert_eq!(
            document["providers"]["deepseek"]["default_model"],
            "current-model"
        );
    }

    #[test]
    fn retired_minimax_summary_profile_falls_back_to_kunlunmeta() {
        let mut document = serde_json::json!({
            "summary_profile": "minimax-summary",
            "moa": {
                "presets": {
                    "default": {
                        "reference_models": [
                            {"profile": "minimax-summary"},
                            {"profile": "custom"}
                        ],
                        "aggregator": {"profile": "minimax-summary"}
                    }
                }
            }
        });

        normalize_legacy_profile_references(&mut document);

        assert_eq!(document["summary_profile"], "kunlunmeta");
        assert_eq!(
            document["moa"]["presets"]["default"]["reference_models"][0]["profile"],
            "kunlunmeta"
        );
        assert_eq!(
            document["moa"]["presets"]["default"]["reference_models"][1]["profile"],
            "custom"
        );
        assert_eq!(
            document["moa"]["presets"]["default"]["aggregator"]["profile"],
            "kunlunmeta"
        );
    }

    #[test]
    fn explicit_minimax_summary_profile_is_preserved() {
        let mut document = serde_json::json!({
            "summary_profile": "minimax-summary",
            "providers": {
                "minimax-summary": {
                    "provider": "minimax",
                    "model": "custom-fast-summary"
                }
            }
        });

        normalize_legacy_profile_references(&mut document);

        assert_eq!(document["summary_profile"], "minimax-summary");
    }

    #[test]
    fn retired_minimax_provider_is_migrated_to_kunlunmeta() {
        let mut document = serde_json::json!({
            "active_provider": "minimax",
            "minimax_api_key": "legacy-key",
            "minimax_base_url": "https://legacy.example/anthropic",
            "providers": {
                "minimax": {
                    "provider": "minimax",
                    "api_format": "anthropic_messages"
                }
            },
            "goal_pro": {
                "verifier_provider": "minimax",
                "verifier_models": [{"profile": "minimax"}]
            }
        });

        normalize_legacy_settings_document(&mut document);

        assert_eq!(document["active_provider"], "kunlunmeta");
        assert_eq!(document["kunlunmeta_api_key"], "legacy-key");
        assert_eq!(
            document["kunlunmeta_base_url"],
            "https://legacy.example/anthropic"
        );
        assert!(document["providers"].get("minimax").is_none());
        assert!(
            document["providers"]["kunlunmeta"]
                .get("provider")
                .is_none()
        );
        assert_eq!(
            document["providers"]["kunlunmeta"]["api_format"],
            "anthropic_messages"
        );
        assert_eq!(document["goal_pro"]["verifier_provider"], "kunlunmeta");
        assert_eq!(
            document["goal_pro"]["verifier_models"][0]["profile"],
            "kunlunmeta"
        );
    }
}

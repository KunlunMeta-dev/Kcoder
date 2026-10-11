use super::*;

#[test]
fn training_mode_is_runtime_only_and_cannot_be_loaded_from_settings_json() {
    let mut settings = Settings::default();
    settings.enable_training_mode();

    let serialized = serde_json::to_value(&settings).unwrap();
    assert!(serialized.get("training_mode").is_none());

    let loaded: Settings = serde_json::from_str(r#"{"training_mode":true}"#).unwrap();
    assert!(!loaded.training_mode);
}

#[test]
fn plugin_settings_additive_defaults_match_installation_contract() {
    let settings: Settings = serde_json::from_str("{}").unwrap();

    assert!(settings.plugins.runtime.enabled);
    assert_eq!(
        settings.plugins.runtime.project_policy,
        PluginProjectPolicy::TrustedOnly
    );
    assert!(settings.plugins.compatibility.agent_plugins_v1);
    assert!(settings.plugins.compatibility.codex);
    assert_eq!(settings.plugins.installation.max_files, 10_000);
    assert_eq!(
        settings.plugins.installation.max_total_bytes,
        256 * 1024 * 1024
    );
    assert_eq!(
        settings.plugins.installation.max_file_bytes,
        32 * 1024 * 1024
    );
    assert_eq!(settings.plugins.installation.timeout_ms, 120_000);
    assert!(settings.plugins.installed.is_empty());
}

#[test]
fn plugin_user_policy_preserves_explicit_disable() {
    let settings: Settings = serde_json::from_str(
        r#"{
                "plugins": {
                    "installed": {
                        "demo@local": {
                            "enabled": false,
                            "skills": { "enabled": true },
                            "hooks": { "enabled": false }
                        }
                    }
                }
            }"#,
    )
    .unwrap();
    let policy = settings.plugins.installed.get("demo@local").unwrap();

    assert_eq!(policy.enabled, Some(false));
    assert_eq!(policy.skills.enabled, Some(true));
    assert_eq!(policy.hooks.enabled, Some(false));
}

#[test]
fn skill_review_mode_is_not_persisted() {
    let settings = Settings {
        auto_skill_review_enabled: true,
        ..Settings::default()
    };
    let serialized = serde_json::to_value(&settings).unwrap();
    assert!(serialized.get("auto_skill_review_enabled").is_none());
    assert_eq!(
        serialized["skills"]["auto_skill_review_enabled"],
        serde_json::Value::Bool(false)
    );

    let loaded: Settings = serde_json::from_str(r#"{"auto_skill_review_enabled":true}"#).unwrap();
    assert!(!loaded.auto_skill_review_enabled);
}

#[test]
fn skills_settings_default_to_governance_plan_values() {
    let loaded: Settings = serde_json::from_str("{}").unwrap();

    assert!(loaded.skills.auto_curator_enabled);
    assert_eq!(loaded.skills.auto_curator_interval_hours, 168);
    assert_eq!(loaded.skills.auto_curator_min_idle_hours, 2);
    assert_eq!(loaded.skills.stale_after_days, 30);
    assert_eq!(loaded.skills.archive_after_days, 90);
    assert!(!loaded.skills.prune_builtins);
    assert!(!loaded.skills.trust_external);
    assert!(!loaded.skills.auto_lessons_learned);
    assert!(loaded.skills.external_dirs.is_empty());
    assert!(loaded.skills.guard.enabled);
    assert!(loaded.skills.guard.block_high_risk);
    assert!(loaded.skills.guard.block_medium_risk_for_community);
}

#[test]
fn skills_settings_accept_persistent_skill_review_config() {
    let loaded: Settings = serde_json::from_str(
        r#"{
                "skills": {
                    "auto_skill_review_enabled": true,
                    "auto_skill_review_interval": 7
                }
            }"#,
    )
    .unwrap();

    assert!(loaded.skills.auto_skill_review_enabled);
    assert_eq!(loaded.skills.auto_skill_review_interval, 7);
}

use super::*;

#[test]
fn goal_pro_verifier_models_reject_unknown_profile_reference() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    let config = temp.path().join("config");
    fs::create_dir_all(&project).unwrap();
    fs::create_dir_all(&config).unwrap();
    write(
        &config.join("settings.json"),
        r#"{
                "providers": {
                    "minimax": {
                        "provider": "minimax",
                        "api_format": "anthropic_messages",
                        "endpoint": "https://api.minimaxi.com/anthropic",
                        "model": "MiniMax-M3",
                        "context_window_tokens": 500000,
                        "output_headroom_tokens": 40960,
                        "max_output_tokens": 40960
                    }
                },
                "goal_pro": {
                    "verifier_models": [
                        { "profile": "minimax" },
                        { "profile": "ghost-profile" }
                    ]
                }
            }"#,
    );

    let error = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .load()
        .expect_err("unknown verifier panel profile must fail the load");
    assert!(
        format!("{error:#}")
            .contains("goal_pro.verifier_models references unknown Provider 'ghost-profile'"),
        "{error:#}"
    );
}

#[test]
fn goal_pro_model_escalation_accepts_a_consistent_ladder() {
    assert!(
        load_escalation_error(
            r#""goal_pro": {
                "model_escalation": {
                    "enabled": true,
                    "threshold": 2,
                    "models": [
                        { "profile": "ladder-same" },
                        { "provider": "ladder-same", "model": "ladder-model" },
                        {}
                    ]
                }
            }"#
        )
        .is_none()
    );
}

#[test]
fn goal_pro_model_escalation_rejects_an_empty_ladder_when_enabled() {
    let error = load_escalation_error(
        r#""goal_pro": { "model_escalation": { "enabled": true, "models": [] } }"#,
    )
    .expect("empty ladder must fail");
    assert!(error.contains("models is empty"), "{error}");
}

#[test]
fn goal_pro_model_escalation_rejects_unknown_provider_reference() {
    let error = load_escalation_error(
        r#""goal_pro": {
                "model_escalation": {
                    "enabled": true,
                    "models": [{ "profile": "ghost" }]
                }
            }"#,
    )
    .expect("unknown reference must fail");
    assert!(error.contains("unknown Provider 'ghost'"), "{error}");
}

#[test]
fn goal_pro_model_escalation_rejects_api_format_mismatch() {
    let error = load_escalation_error(
        r#""goal_pro": {
                "model_escalation": {
                    "enabled": true,
                    "models": [{ "profile": "ladder-other-format" }]
                }
            }"#,
    )
    .expect("api_format mismatch must fail");
    assert!(error.contains("api_format"), "{error}");
    assert!(error.contains("ladder-other-format"), "{error}");
}

#[test]
fn goal_pro_model_escalation_rejects_context_window_mismatch() {
    let error = load_escalation_error(
        r#""goal_pro": {
                "model_escalation": {
                    "enabled": true,
                    "models": [{ "profile": "ladder-other-window" }]
                }
            }"#,
    )
    .expect("context window mismatch must fail");
    assert!(error.contains("context_window_tokens"), "{error}");
    assert!(error.contains("ladder-other-window"), "{error}");
}

#[test]
fn rejects_unknown_setting_fields_instead_of_silently_ignoring_them() {
    let value = serde_json::json!({ "modle": "typo" });
    let error = validate_settings_document(&value).unwrap_err().to_string();
    assert!(error.contains("modle"), "{error}");
    assert!(error.contains("schema"), "{error}");
    assert!(error.contains("spelling"), "{error}");
}

#[test]
fn rejects_invalid_complete_context_boundaries() {
    let value = serde_json::json!({
        "context_window_tokens": 100000,
        "context_output_headroom": 12000,
        "context_hard_input_tokens": 88000,
        "auto_compact_threshold_tokens": 90000
    });
    let error = validate_settings_document(&value).unwrap_err().to_string();
    assert!(error.contains("below the hard input limit"), "{error}");

    let value = serde_json::json!({
        "context_window_tokens": 100000,
        "context_output_headroom": 12000,
        "auto_compact_threshold_tokens": 76000,
        "prefire_threshold_tokens": 76000
    });
    let error = validate_settings_document(&value).unwrap_err().to_string();
    assert!(
        error.contains("below auto_compact_threshold_tokens"),
        "{error}"
    );

    let value = serde_json::json!({
        "context_window_tokens": 1000000,
        "context_output_headroom": 100000,
        "prefire_threshold_tokens": 700000
    });
    let error = validate_settings_document(&value).unwrap_err().to_string();
    assert!(
        error.contains("below auto_compact_threshold_tokens"),
        "{error}"
    );
}

#[test]
fn rejects_auto_compact_percentages_outside_one_to_ninety_nine() {
    for percent in [0, 100] {
        let value = serde_json::json!({
            "context_compaction": {
                "auto_threshold": {
                    "large_window_percent": percent
                }
            }
        });
        let error = validate_settings_document(&value).unwrap_err().to_string();
        assert!(error.contains("large_window_percent"), "{error}");
    }
}

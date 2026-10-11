use super::*;

#[test]
fn moa_defaults_reuse_the_active_runtime() {
    let settings: Settings = serde_json::from_str("{}").unwrap();
    let preset = settings
        .moa
        .presets
        .get(settings.moa.default_preset.as_str())
        .unwrap();

    assert!(settings.moa.enabled);
    assert_eq!(settings.moa.default_preset, "default");
    assert_eq!(
        preset.reference_models,
        vec![MoaModelConfig::new("current", "current")]
    );
    assert_eq!(preset.aggregator, MoaModelConfig::new("current", "current"));
}

#[test]
fn moa_token_limits_accept_null_for_defaulting_at_runtime() {
    let settings: Settings = serde_json::from_str(
        r#"{
                "moa": {
                    "presets": {
                        "default": {
                            "reference_max_tokens": null,
                            "aggregator_max_tokens": null
                        }
                    }
                }
            }"#,
    )
    .unwrap();
    let preset = settings.moa.presets.get("default").unwrap();

    assert_eq!(preset.reference_max_tokens, None);
    assert_eq!(preset.aggregator_max_tokens, None);
}

#[test]
fn default_subagent_concurrency_cap_is_four() {
    assert_eq!(
        Settings::default().max_concurrent_subagents,
        MAX_CONCURRENT_SUBAGENTS
    );
    assert_eq!(MAX_CONCURRENT_SUBAGENTS, 4);
}

#[test]
fn default_subagent_max_turns_is_configurable_and_clamped() {
    assert_eq!(
        Settings::default().default_subagent_max_turns,
        DEFAULT_SUBAGENT_MAX_TURNS
    );

    let loaded: Settings = serde_json::from_str(r#"{"default_subagent_max_turns":120}"#).unwrap();
    assert_eq!(loaded.default_subagent_max_turns, 120);

    let legacy: Settings = serde_json::from_str(r#"{"subagent_max_turns":90}"#).unwrap();
    assert_eq!(legacy.default_subagent_max_turns, 90);

    let mut settings = Settings {
        default_subagent_max_turns: 0,
        ..Settings::default()
    };
    settings.normalize_runtime_limits();
    assert_eq!(settings.default_subagent_max_turns, MIN_SUBAGENT_MAX_TURNS);

    settings.default_subagent_max_turns = MAX_SUBAGENT_MAX_TURNS + 1;
    settings.normalize_runtime_limits();
    assert_eq!(settings.default_subagent_max_turns, MAX_SUBAGENT_MAX_TURNS);
}

#[test]
fn goal_pro_verifier_settings_default_and_override() {
    let defaults = Settings::default();
    assert!(defaults.goal_pro.is_default());
    assert_eq!(defaults.goal_pro.verifier_max_turns, 64);
    assert_eq!(defaults.goal_pro.completion_rejection_limit, 8);
    assert!(defaults.goal_pro.verification.require_tests);
    assert!(!defaults.goal_pro.verification.require_behavior_delta);
    assert_eq!(
        defaults.goal_pro.verification.minimum_test_scope,
        GoalProTestScope::TargetSuite
    );
    assert!(defaults.goal_pro.verification.require_raw_exit_code);
    assert!(!defaults.goal_pro.verification.allow_workspace_changes);
    assert!(defaults.goal_pro.verification.isolate_environment);
    assert!(!defaults.goal_pro.verification.allow_dependency_changes);
    assert!(defaults.goal_pro.verification.allow_network_only_failures);

    let missing_goal_pro: Settings = serde_json::from_str("{}").unwrap();
    assert_eq!(missing_goal_pro.goal_pro.verifier_max_turns, 64);
    assert_eq!(missing_goal_pro.goal_pro.completion_rejection_limit, 8);
    let missing_limit: Settings = serde_json::from_str(r#"{"goal_pro":{}}"#).unwrap();
    assert_eq!(missing_limit.goal_pro.verifier_max_turns, 64);
    assert_eq!(missing_limit.goal_pro.completion_rejection_limit, 8);

    let loaded: Settings = serde_json::from_str(
        r#"{
                "goal_pro": {
                    "verifier_profile": "mimo-review",
                    "verifier_provider": "kunlunmeta",
                    "verifier_model": "mimo-v2.5",
                    "verifier_max_turns": 9,
                    "completion_rejection_limit": 5,
                    "verification": {
                        "require_behavior_delta": true,
                        "minimum_test_scope": "focused",
                        "allow_network_only_failures": false
                    }
                }
            }"#,
    )
    .unwrap();
    assert_eq!(
        loaded.goal_pro.verifier_profile.as_deref(),
        Some("mimo-review")
    );
    assert_eq!(
        loaded.goal_pro.verifier_provider.as_deref(),
        Some("kunlunmeta")
    );
    assert_eq!(loaded.goal_pro.verifier_model.as_deref(), Some("mimo-v2.5"));
    assert_eq!(loaded.goal_pro.verifier_max_turns, 9);
    assert_eq!(loaded.goal_pro.completion_rejection_limit, 5);
    assert_eq!(
        loaded.goal_pro.verification.minimum_test_scope,
        GoalProTestScope::Focused
    );
    assert!(loaded.goal_pro.verification.require_tests);
    assert!(loaded.goal_pro.verification.require_behavior_delta);
    assert!(!loaded.goal_pro.verification.allow_network_only_failures);
    assert_eq!(
        default_settings_document()["goal_pro"]["verifier_max_turns"],
        serde_json::json!(64)
    );
    assert_eq!(
        default_settings_document()["goal_pro"]["completion_rejection_limit"],
        serde_json::json!(8)
    );
}

#[test]
fn orchestrate_defaults_are_materialized_and_safe() {
    let settings = Settings::default();
    assert!(settings.orchestrate.main.optional_tool_allowlist.is_none());
    assert_eq!(settings.orchestrate.continuation.max_auto_turns, 8);
    assert_eq!(settings.orchestrate.notepad.max_inject_bytes, 8192);
    assert_eq!(settings.orchestrate.delivery.lease_timeout_seconds, 120);
    assert_eq!(settings.orchestrate.delivery.max_attempts, 8);
    assert_eq!(settings.orchestrate.fleet.max_members, 24);
    assert_eq!(settings.orchestrate.fleet.max_inject_bytes, 8192);
    assert!(settings.orchestrate.control.enabled);
    assert!(settings.orchestrate.breaker.enabled);
    assert!(!settings.orchestrate.breaker.hard_stop);
    assert_eq!(settings.orchestrate.audit.max_events, 4096);
    assert_eq!(settings.orchestrate.critic_max_cycles, 3);
    assert_eq!(settings.orchestrate.roster["junior"].tier, "standard");
    assert_eq!(settings.orchestrate.roster["critic"].tier, "max");
    assert!(settings.orchestrate.tiers.contains_key("fast"));
}

#[test]
fn orchestrate_roster_layers_merge_by_name_and_fields() {
    let mut document = default_settings_document();
    merge_settings_documents(
        &mut document,
        serde_json::json!({
            "orchestrate": {
                "roster": {
                    "junior": {"tool_allowlist": ["read", "edit"]}
                }
            }
        }),
    );
    merge_settings_documents(
        &mut document,
        serde_json::json!({
            "orchestrate": {
                "roster": {
                    "junior": {"context_mode": "fork"}
                }
            }
        }),
    );
    let settings = validate_and_resolve_settings_document(&document).unwrap();
    let junior = &settings.orchestrate.roster["junior"];
    assert_eq!(junior.tier, "standard");
    assert_eq!(
        junior.tool_allowlist.as_deref(),
        Some(&["read".to_string(), "edit".to_string()][..])
    );
    assert_eq!(junior.context_mode, OrchestrateContextMode::Fork);
}

#[test]
fn orchestrate_reliability_settings_reject_values_outside_schema_bounds() {
    for value in [
        serde_json::json!({"orchestrate": {"delivery": {"lease_timeout_seconds": 29}}}),
        serde_json::json!({"orchestrate": {"delivery": {"max_attempts": 0}}}),
        serde_json::json!({"orchestrate": {"fleet": {"max_members": 101}}}),
        serde_json::json!({"orchestrate": {"fleet": {"max_inject_bytes": 1023}}}),
        serde_json::json!({"orchestrate": {"breaker": {"repeated_action_threshold": 0}}}),
        serde_json::json!({"orchestrate": {"breaker": {"consecutive_error_threshold": 65}}}),
        serde_json::json!({"orchestrate": {"breaker": {"no_progress_rounds": 0}}}),
        serde_json::json!({"orchestrate": {"audit": {"max_events": 127}}}),
        serde_json::json!({"orchestrate": {"audit": {"max_event_bytes": 65_537}}}),
    ] {
        assert!(
            validate_and_resolve_settings_document(&value).is_err(),
            "accepted {value}"
        );
    }
}

#[test]
fn orchestrate_full_context_rejects_an_incompatible_runtime() {
    let mut document = default_settings_document();
    document["providers"]["small"] = serde_json::json!({
        "credential_env": ["SMALL_KEY"],
        "api_format": "anthropic_messages",
        "endpoint": "https://example.test",
        "default_model": "small",
        "context_window_tokens": 4096,
        "output_headroom_tokens": 1024,
        "max_output_tokens": 1024
    });
    document["orchestrate"]["tiers"]["small"] = serde_json::json!({"profile": "small"});
    document["orchestrate"]["roster"]["junior"] =
        serde_json::json!({"tier": "small", "context_mode": "full"});

    let error = validate_and_resolve_settings_document(&document).unwrap_err();

    assert!(
        error
            .to_string()
            .contains("context_mode=full is incompatible")
    );
}

#[test]
fn goal_pro_verifier_models_default_empty_and_parse() {
    let defaults = Settings::default();
    assert!(defaults.goal_pro.verifier_models.is_empty());
    let missing: Settings = serde_json::from_str(r#"{"goal_pro":{}}"#).unwrap();
    assert!(missing.goal_pro.verifier_models.is_empty());
    assert_eq!(
        default_settings_document()["goal_pro"]["verifier_models"],
        serde_json::json!([])
    );

    let loaded: Settings = serde_json::from_str(
        r#"{
                "goal_pro": {
                    "verifier_models": [
                        { "profile": "mimo-review" },
                        { "provider": "kunlunmeta", "model": "mimo-v2.5" },
                        {}
                    ]
                }
            }"#,
    )
    .unwrap();
    assert_eq!(loaded.goal_pro.verifier_models.len(), 3);
    assert_eq!(
        loaded.goal_pro.verifier_models[0].profile.as_deref(),
        Some("mimo-review")
    );
    assert_eq!(
        loaded.goal_pro.verifier_models[1].provider.as_deref(),
        Some("kunlunmeta")
    );
    assert_eq!(
        loaded.goal_pro.verifier_models[1].model.as_deref(),
        Some("mimo-v2.5")
    );
    assert_eq!(loaded.goal_pro.verifier_models[2].profile, None);
    assert_eq!(loaded.goal_pro.verifier_models[2].provider, None);
    assert_eq!(loaded.goal_pro.verifier_models[2].model, None);
}

#[test]
fn goal_pro_model_escalation_defaults_to_disabled_and_parses() {
    let defaults = Settings::default();
    assert!(!defaults.goal_pro.model_escalation.enabled);
    assert_eq!(defaults.goal_pro.model_escalation.threshold, 3);
    assert!(defaults.goal_pro.model_escalation.models.is_empty());
    assert!(defaults.goal_pro.is_default());
    assert_eq!(
        default_settings_document()["goal_pro"]["model_escalation"]["threshold"],
        serde_json::json!(3)
    );

    let loaded: Settings = serde_json::from_str(
        r#"{
                "goal_pro": {
                    "model_escalation": {
                        "enabled": true,
                        "threshold": 2,
                        "models": [{ "provider": "kunlunmeta", "model": "mimo-v2.5" }]
                    }
                }
            }"#,
    )
    .unwrap();
    assert!(loaded.goal_pro.model_escalation.enabled);
    assert_eq!(loaded.goal_pro.model_escalation.threshold, 2);
    assert_eq!(loaded.goal_pro.model_escalation.models.len(), 1);
    assert_eq!(
        loaded.goal_pro.model_escalation.models[0].model.as_deref(),
        Some("mimo-v2.5")
    );
    assert!(!loaded.goal_pro.is_default());
}

#[test]
fn goal_auto_continuation_limit_defaults_to_eight_and_allows_override() {
    assert_eq!(Settings::default().goal_max_auto_continuations, 8);

    let missing: Settings = serde_json::from_str("{}").unwrap();
    assert_eq!(missing.goal_max_auto_continuations, 8);

    let explicit: Settings = serde_json::from_str(r#"{"goal_max_auto_continuations":7}"#).unwrap();
    assert_eq!(explicit.goal_max_auto_continuations, 7);
    assert_eq!(
        default_settings_document()["goal_max_auto_continuations"],
        serde_json::json!(8)
    );
}

#[test]
fn default_goal_pro_is_visible_to_dotted_config_queries() {
    let serialized = serde_json::to_value(Settings::default()).unwrap();

    assert_eq!(
        dotted_value(&serialized, "goal_pro.verifier_max_turns").unwrap(),
        Some(&serde_json::json!(64))
    );
    assert_eq!(
        dotted_value(&serialized, "goal_pro.completion_rejection_limit").unwrap(),
        Some(&serde_json::json!(8))
    );
    assert_eq!(
        dotted_value(&serialized, "goal_pro.verification.minimum_test_scope").unwrap(),
        Some(&serde_json::json!("target_suite"))
    );
    assert_eq!(
        dotted_value(&serialized, "goal_pro.verification.require_behavior_delta").unwrap(),
        Some(&serde_json::json!(false))
    );
}

#[test]
fn settings_normalize_clamps_subagent_concurrency_cap() {
    let mut settings = Settings {
        max_concurrent_subagents: 0,
        ..Settings::default()
    };
    settings.normalize_runtime_limits();
    assert_eq!(settings.max_concurrent_subagents, MAX_CONCURRENT_SUBAGENTS);

    settings.max_concurrent_subagents = MAX_CONCURRENT_SUBAGENTS + 10;
    settings.normalize_runtime_limits();
    assert_eq!(settings.max_concurrent_subagents, MAX_CONCURRENT_SUBAGENTS);

    settings.max_concurrent_subagents = 2;
    settings.normalize_runtime_limits();
    assert_eq!(settings.max_concurrent_subagents, 2);
}

#[test]
fn moa_plan_settings_have_safe_defaults_and_accept_overrides() {
    let defaults = Settings::default();
    assert!(defaults.moa_plan.enabled);
    assert_eq!(defaults.moa_plan.preset, "default");
    assert_eq!(
        defaults.moa_plan.draft_max_turns,
        DEFAULT_SUBAGENT_MAX_TURNS
    );
    assert_eq!(
        defaults.moa_plan.draft_max_tokens,
        kcoder_types::DEFAULT_MODEL_OUTPUT_TOKENS
    );
    assert_eq!(
        defaults.moa_plan.synthesis_max_tokens,
        kcoder_types::DEFAULT_MODEL_OUTPUT_TOKENS
    );
    assert_eq!(defaults.moa_plan.draft_timeout_secs, 300);
    assert_eq!(defaults.moa_plan.max_planner_workers, 4);

    let loaded: Settings = serde_json::from_str(
        r#"{
                "moa_plan": {
                    "enabled": false,
                    "preset": "careful",
                    "draft_max_turns": 6,
                    "draft_max_tokens": 8192,
                    "synthesis_max_tokens": 16384,
                    "draft_timeout_secs": 90,
                    "max_planner_workers": 2
                }
            }"#,
    )
    .unwrap();

    assert!(!loaded.moa_plan.enabled);
    assert_eq!(loaded.moa_plan.preset, "careful");
    assert_eq!(loaded.moa_plan.draft_max_turns, 6);
    assert_eq!(loaded.moa_plan.draft_max_tokens, 8192);
    assert_eq!(loaded.moa_plan.synthesis_max_tokens, 16384);
    assert_eq!(loaded.moa_plan.draft_timeout_secs, 90);
    assert_eq!(loaded.moa_plan.max_planner_workers, 2);
}

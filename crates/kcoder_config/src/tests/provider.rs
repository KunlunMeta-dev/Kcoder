use super::*;

fn provider_environment_child(test: &str, marker: &str, endpoint: Option<&str>) -> bool {
    if std::env::var_os(marker).is_some() {
        return false;
    }
    // Environment overrides belong to this child, not parallel test threads.
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", test, "--test-threads=1"])
        .env(marker, "1")
        .env_remove("KUNLUNMETA_BASE_URL")
        .env_remove("KUNLUNMETA_BASE_API_KEY");
    if let Some(endpoint) = endpoint {
        command.env("KUNLUNMETA_BASE_URL", endpoint);
    }
    let output = command.output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed;"),
        "{stdout}{}",
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

#[test]
fn settings_default_is_derived_from_the_default_provider_profile() {
    if provider_environment_child(
        "tests::provider::settings_default_is_derived_from_the_default_provider_profile",
        "KCODER_CONFIG_DEFAULT_PROVIDER_CHILD",
        None,
    ) {
        return;
    }
    let settings = Settings::default();
    let profile = &settings.providers[DEFAULT_ACTIVE_PROVIDER];

    assert_eq!(
        settings.active_provider.as_deref(),
        Some(DEFAULT_ACTIVE_PROVIDER)
    );
    assert_eq!(settings.provider.as_deref(), Some(DEFAULT_ACTIVE_PROVIDER));
    assert_eq!(settings.api_format, Some(profile.api_format));
    assert_eq!(
        settings.base_url.as_deref(),
        Some(profile.endpoint.as_str())
    );
    assert_eq!(settings.model, profile.default_model);
    assert_eq!(settings.model_reasoning_effort, profile.reasoning_effort);
    assert_eq!(
        settings.context_window_tokens,
        Some(profile.context_window_tokens)
    );
    assert_eq!(
        settings.context_output_headroom,
        Some(profile.output_headroom_tokens)
    );
    assert_eq!(settings.max_tokens, Some(profile.max_output_tokens));
    assert!(settings.time_based_micro_compact.enabled);
    assert_eq!(settings.time_based_micro_compact.gap_threshold_minutes, 60);
    assert_eq!(settings.time_based_micro_compact.keep_recent, 5);
    assert_eq!(
        settings
            .context_compaction
            .auto_threshold
            .small_window_percent,
        95
    );
    assert_eq!(
        settings
            .context_compaction
            .auto_threshold
            .medium_window_percent,
        85
    );
    assert_eq!(
        settings
            .context_compaction
            .auto_threshold
            .large_window_percent,
        75
    );
}

#[test]
fn default_provider_environment_override_is_isolated_and_preserved() {
    const ENDPOINT: &str = "https://provider-fixture.invalid/v1";
    if provider_environment_child(
        "tests::provider::default_provider_environment_override_is_isolated_and_preserved",
        "KCODER_CONFIG_PROVIDER_OVERRIDE_CHILD",
        Some(ENDPOINT),
    ) {
        return;
    }
    assert_eq!(Settings::default().base_url.as_deref(), Some(ENDPOINT));
}

#[test]
fn model_discovery_defaults_control_only_provider_catalog_queries() {
    let settings = Settings::default();
    let discovery = settings.model_discovery;

    assert!(discovery.enabled);
    assert_eq!(discovery.request_timeout_secs, 8);
    assert_eq!(discovery.cache_ttl_secs, 300);
    assert_eq!(discovery.max_models_per_provider, 200);
}

#[test]
fn discovered_model_inherits_complete_provider_configuration() {
    let mut settings = Settings::default();
    settings
        .apply_discovered_model("kunlunmeta", "Kimi-2.7")
        .unwrap();

    assert_eq!(settings.provider.as_deref(), Some("kunlunmeta"));
    assert_eq!(settings.model, "Kimi-2.7");
    assert_eq!(settings.api_format, Some(ApiFormat::AnthropicMessages));
    assert_eq!(settings.context_window_tokens, Some(1_048_576));
    assert_eq!(settings.auto_compact_threshold_tokens, None);
    assert_eq!(settings.context_output_headroom, Some(100_000));
    assert_eq!(
        settings.max_tokens,
        Some(kcoder_types::DEFAULT_MODEL_OUTPUT_TOKENS)
    );
    assert_eq!(settings.model_reasoning_effort, Some(ReasoningEffort::High));
    assert_eq!(settings.model_capabilities, ModelCapabilities::default());
    assert_eq!(
        settings.active_model_selection,
        Some(ActiveModelSelection {
            source_profile: "kunlunmeta".to_string(),
            model: "Kimi-2.7".to_string(),
        })
    );
}

#[test]
fn provider_profile_applies_complete_runtime_configuration() {
    let mut settings = Settings::default();
    settings.providers.insert(
        "custom".to_string(),
        ProviderConfig {
            response_limits: Default::default(),
            reasoning_policy: None,
            chat_protocol: Default::default(),
            authentication: Default::default(),
            credential_env: Vec::new(),
            api_format: ApiFormat::OpenaiResponses,
            endpoint: "https://example.test/v1".to_string(),
            default_model: "example-model".to_string(),
            models: Default::default(),
            discover_models: None,
            capabilities: ModelCapabilities::default(),
            reasoning_effort: Some(ReasoningEffort::High),
            context_window_tokens: 200_000,
            auto_compact_threshold_tokens: Some(100_000),
            output_headroom_tokens: 20_000,
            max_output_tokens: 12_000,
            request_timeout_secs: Some(45),
            user_agent: Some("example-client/1.0".to_string()),
            max_retries: Some(2),
            retry_base_delay_ms: Some(250),
            no_proxy: true,
            extra_body: serde_json::Map::from_iter([(
                "temperature".to_string(),
                serde_json::json!(0.2),
            )]),
        },
    );

    settings.apply_provider(Some("custom")).unwrap();

    assert_eq!(settings.provider.as_deref(), Some("custom"));
    assert_eq!(settings.api_format, Some(ApiFormat::OpenaiResponses));
    assert_eq!(
        settings.base_url.as_deref(),
        Some("https://example.test/v1")
    );
    assert_eq!(settings.model, "example-model");
    assert_eq!(settings.context_window_tokens, Some(200_000));
    assert_eq!(settings.context_output_headroom, Some(20_000));
    assert_eq!(settings.auto_compact_threshold_tokens, Some(100_000));
    assert_eq!(settings.request_timeout_secs, Some(45));
    assert!(settings.provider_no_proxy);
    assert_eq!(settings.provider_extra_body["temperature"], 0.2);
    assert_eq!(settings.max_tokens, Some(12_000));
    assert_eq!(
        settings.openai_user_agent.as_deref(),
        Some("example-client/1.0")
    );
    assert_eq!(settings.max_retries, 2);
    assert_eq!(settings.retry_base_delay_ms, 250);
}

#[test]
fn save_drops_default_identical_profiles_but_keeps_custom_ones() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("settings.json");
    let mut settings = Settings::default();
    // A profile that differs from every embedded default must survive.
    let mut custom = crate::deployment::default_providers()["kunlunmeta"].clone();
    custom.default_model = "custom-x-model".to_string();
    custom.endpoint = "https://example.invalid".to_string();
    settings.providers.insert("custom-x".to_string(), custom);

    settings.save_to(&path).unwrap();

    let persisted: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let profiles = persisted["providers"].as_object().unwrap();
    assert!(profiles.contains_key("custom-x"));
    for name in crate::deployment::default_providers().keys() {
        assert!(
            !profiles.contains_key(name),
            "default-identical profile {name} must not be persisted back"
        );
    }
}

#[test]
fn save_keeps_embedded_profiles_that_are_declared_in_the_current_file() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("settings.json");
    // The user explicitly declared kunlunmeta with the same value as the embedded default; saving must retain it.
    let declared = serde_json::json!({
        "active_provider": "kunlunmeta",
        "providers": {
            "kunlunmeta": crate::deployment::default_providers()["kunlunmeta"]
        }
    });
    std::fs::write(&path, serde_json::to_string_pretty(&declared).unwrap()).unwrap();

    let settings = Settings::default();
    settings.save_to(&path).unwrap();

    let persisted: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let profiles = persisted["providers"].as_object().unwrap();
    assert_eq!(profiles.len(), 1);
    assert!(profiles.contains_key("kunlunmeta"));
}

#[test]
fn summary_provider_and_model_null_fall_back_to_main_runtime() {
    let loaded: Settings =
        serde_json::from_str(r#"{"summary_provider":null,"summary_model":null}"#).unwrap();
    assert_eq!(loaded.summary_provider, None);
    assert_eq!(loaded.summary_model, None);
}

#[test]
fn orchestrate_rejects_unknown_persona_tier_provider_and_security_fields() {
    for value in [
        serde_json::json!({"orchestrate": {"roster": {"unknown": {"tier": "fast"}}}}),
        serde_json::json!({"orchestrate": {"roster": {"junior": {"tier": "missing"}}}}),
        serde_json::json!({"orchestrate": {"tiers": {"fast": {"provider": "missing"}}}}),
        serde_json::json!({"orchestrate": {"roster": {"junior": {"base_role": "general"}}}}),
        serde_json::json!({"orchestrate": {"roster": {"junior": {"prompt": "expand"}}}}),
        serde_json::json!({"orchestrate": {"roster": {"junior": {"profile": "other"}}}}),
        serde_json::json!({"orchestrate": {"roster": {"critic": {"verdict": "text"}}}}),
        serde_json::json!({"orchestrate": {"roster": {"oracle": {"tool_allowlist": ["read", "bash"]}}}}),
    ] {
        assert!(
            validate_and_resolve_settings_document(&value).is_err(),
            "accepted {value}"
        );
    }
}

#[test]
fn settings_accept_provider_endpoint_and_key_fields() {
    let loaded: Settings = serde_json::from_str(
        r#"{
                "provider": "openai",
                "model": "kimi-for-coding/k2p6",
                "base_url": "https://models.example/v1",
                "api_key": "generic-key",
                "openai_base_url": "https://openai.example/v1",
                "openai_api_key": "openai-key",
                "kunlunmeta_base_url": "https://kunlunmeta.example",
                "kunlunmeta_api_key": "kunlunmeta-key",
                "gemini_base_url": "https://gemini.example"
            }"#,
    )
    .unwrap();

    assert_eq!(loaded.provider.as_deref(), Some("openai"));
    assert_eq!(loaded.model, "kimi-for-coding/k2p6");
    assert_eq!(
        loaded.base_url.as_deref(),
        Some("https://models.example/v1")
    );
    assert_eq!(loaded.api_key.as_deref(), Some("generic-key"));
    assert_eq!(
        loaded.openai_base_url.as_deref(),
        Some("https://openai.example/v1")
    );
    assert_eq!(loaded.openai_api_key.as_deref(), Some("openai-key"));
    assert_eq!(
        loaded.kunlunmeta_base_url.as_deref(),
        Some("https://kunlunmeta.example")
    );
    assert_eq!(loaded.kunlunmeta_api_key.as_deref(), Some("kunlunmeta-key"));
    assert_eq!(
        loaded.gemini_base_url.as_deref(),
        Some("https://gemini.example")
    );
}

#[test]
fn plaintext_secret_setting_names_returns_only_populated_field_names() {
    let settings = Settings {
        api_key: Some("generic-secret".to_string()),
        kunlunmeta_api_key: Some("kunlunmeta-secret".to_string()),
        openai_api_key: Some("openai-secret".to_string()),
        ..Settings::default()
    };

    assert_eq!(
        settings.plaintext_secret_setting_names(),
        vec!["api_key", "kunlunmeta_api_key", "openai_api_key"]
    );
}

#[test]
fn persisted_settings_omit_plaintext_secret_fields() {
    let settings = Settings {
        api_key: Some("generic-secret".to_string()),
        anthropic_api_key: Some("anthropic-secret".to_string()),
        kunlunmeta_api_key: Some("kunlunmeta-secret".to_string()),
        openai_api_key: Some("openai-secret".to_string()),
        local_api_key: Some("local-secret".to_string()),
        gemini_api_key: Some("gemini-secret".to_string()),
        grok_api_key: Some("grok-secret".to_string()),
        model: "kept-model".to_string(),
        base_url: Some("https://models.example/v1".to_string()),
        ..Settings::default()
    };

    let persisted = settings.without_plaintext_secrets();
    let serialized = serde_json::to_string_pretty(&persisted).unwrap();
    let direct_serialized = serde_json::to_string_pretty(&settings).unwrap();

    assert_eq!(persisted.model, "kept-model");
    assert_eq!(
        persisted.base_url.as_deref(),
        Some("https://models.example/v1")
    );
    for forbidden in [
        "api_key",
        "anthropic_api_key",
        "kunlunmeta_api_key",
        "openai_api_key",
        "local_api_key",
        "gemini_api_key",
        "grok_api_key",
        "generic-secret",
        "openai-secret",
        "kunlunmeta-secret",
    ] {
        assert!(!serialized.contains(forbidden), "{forbidden}");
        assert!(!direct_serialized.contains(forbidden), "{forbidden}");
    }
}

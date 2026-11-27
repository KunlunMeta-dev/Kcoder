use super::*;

fn owned_loader(root: &crate::PrivateTempDir, value: Value) -> SettingsLoader {
    let profile = root.path().join("profile");
    fs::create_dir(&profile).unwrap();
    fs::write(
        profile.join("settings.json"),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    SettingsLoader::new(root.path())
        .with_config_dir(profile)
        .with_executable_dir(root.path().join("absent-executable"))
}

#[test]
fn management_preserves_partial_model_and_policy_without_enabling_execution_or_strict_load() {
    let root = crate::create_private_temp_dir("settings-management-partial").unwrap();
    let value = serde_json::json!({"active_provider":"CaseSensitive","tools":{"disabled":["Bash"]},
        "providers":{"CaseSensitive":{"api_format":"openai_chat_completions","endpoint":"http://127.0.0.1:1/v1","default_model":"explicit"}}});
    let loader = owned_loader(&root, value);
    let source = fs::read(loader.paths().unwrap().user_settings).unwrap();
    assert!(loader.load().is_err());
    let loaded = loader.load_for_management().unwrap();
    assert_eq!(
        loaded.settings.active_provider.as_deref(),
        Some("CaseSensitive")
    );
    assert_eq!(loaded.settings.model, "explicit");
    assert_eq!(loaded.settings.context_window_tokens, None);
    assert_eq!(loaded.settings.context_output_headroom, None);
    assert_eq!(loaded.settings.max_tokens, None);
    assert!(loaded.settings.tools.disabled.contains(&"Bash".into()));
    assert_eq!(
        loaded
            .settings
            .model_execution_readiness()
            .unwrap_err()
            .code(),
        "model_limits_missing"
    );
    assert!(loader.load().is_err());
    assert_eq!(
        fs::read(loader.paths().unwrap().user_settings).unwrap(),
        source
    );
}

#[test]
fn known_toml_overlay_is_read_only_and_explicit_provider_ownership_remains_authoritative() {
    let root = crate::create_private_temp_dir("settings-management-toml").unwrap();
    let loader = owned_loader(&root, serde_json::json!({"providers":{}}));
    let path = root.path().join("explicit-settings.toml");
    let source = b"provider = \"CaseSensitive\"\nmodel = \"\"\napi_format = \"openai\"\n[model_providers.CaseSensitive]\nbase_url = \"http://127.0.0.1:1/v1\"\n";
    fs::write(&path, source).unwrap();
    let loader = loader
        .with_overlay_files([path.clone()])
        .freeze_overlays_for_management()
        .unwrap();
    let mut settings = loader.load_for_management().unwrap().settings;
    settings
        .apply_provider_for_management(Some("CaseSensitive"))
        .unwrap();
    assert_eq!(settings.model, "");
    assert!(settings.model_execution_readiness().is_err());
    assert_eq!(settings.providers.len(), 1);
    assert!(settings.providers.contains_key("CaseSensitive"));
    assert!(settings.apply_provider(Some("CaseSensitive")).is_err());
    assert_eq!(fs::read(path).unwrap(), source);
}

#[test]
fn management_does_not_swallow_non_model_schema_parse_or_missing_overlay_failures() {
    let root = crate::create_private_temp_dir("settings-management-boundaries").unwrap();
    let loader = owned_loader(&root, serde_json::json!({"permission_mode":false}));
    let error = loader.load_for_management().unwrap_err();
    assert_eq!(
        error.downcast_ref::<SettingsLoadFailure>().unwrap().kind,
        SettingsLoadFailureKind::Schema
    );
    fs::write(loader.paths().unwrap().user_settings, "{ broken = true").unwrap();
    let error = loader.load_for_management().unwrap_err();
    assert_eq!(
        error.downcast_ref::<SettingsLoadFailure>().unwrap().kind,
        SettingsLoadFailureKind::Parse
    );
    fs::write(loader.paths().unwrap().user_settings, "{}").unwrap();
    let error = loader
        .with_overlay_files([root.path().join("absent.json")])
        .load_for_management()
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<SettingsLoadFailure>().unwrap().kind,
        SettingsLoadFailureKind::OverlayUnavailable
    );
}

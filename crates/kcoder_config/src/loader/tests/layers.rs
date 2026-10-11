use super::*;

#[test]
fn inherited_output_defaults_fit_smaller_windows_without_changing_explicit_layer_limits() {
    for explicit_layer in 0..=5 {
        let limits = if explicit_layer == 0 {
            vec![None]
        } else {
            vec![Some(8192), Some(kcoder_types::DEFAULT_MODEL_OUTPUT_TOKENS)]
        };
        for explicit_limit in limits {
            let temp = TempDir::new().unwrap();
            let config = temp.path().join("config");
            let project = temp.path().join("project");
            let executable = temp.path().join("executable");
            fs::create_dir_all(&project).unwrap();
            let layer_paths = [
                config.join("settings.json"),
                executable.join("settings.json"),
                project.join(".kcoder/settings.json"),
                project.join(".kcoder/settings.local.json"),
                temp.path().join("overlay.jsonc"),
            ];
            let mut documents = vec![serde_json::json!({}); layer_paths.len()];
            documents[0] = serde_json::json!({"providers": {"kunlunmeta": {
                "extra_body": {"private_future_field": {"value": "UNTOUCHED"}}
            }}});
            documents[4] = serde_json::json!({"providers": {"kunlunmeta": {
                "context_window_tokens": 128000
            }}});
            if let Some(limit) = explicit_limit {
                documents[explicit_layer - 1]["providers"]["kunlunmeta"]["max_output_tokens"] =
                    Value::from(limit);
            }
            let originals: Vec<_> = documents
                .iter()
                .map(|document| serde_json::to_string(document).unwrap())
                .collect();
            for (path, original) in layer_paths.iter().zip(&originals) {
                write(path, original);
            }
            let result = SettingsLoader::new(&project)
                .with_config_dir(&config)
                .with_executable_dir(&executable)
                .with_overlay_files([layer_paths[4].clone()])
                .load();
            for (path, original) in layer_paths.iter().zip(&originals) {
                assert_eq!(fs::read_to_string(path).unwrap(), *original);
            }
            if explicit_limit == Some(kcoder_types::DEFAULT_MODEL_OUTPUT_TOKENS) {
                let error = result.err().unwrap();
                assert!(format!("{error:#}").contains("output limits exceed its context window"));
                continue;
            }
            let loaded = result.unwrap();
            let provider = &loaded.settings.providers["kunlunmeta"];
            assert_eq!(provider.max_output_tokens, explicit_limit.unwrap_or(128000));
            assert_eq!(loaded.settings.max_tokens, Some(provider.max_output_tokens));
            assert_eq!(provider.context_window_tokens, 128000);
            assert_eq!(
                serde_json::to_value(&provider.extra_body).unwrap(),
                documents[0]["providers"]["kunlunmeta"]["extra_body"]
            );
            if explicit_limit.is_none() {
                assert!(
                    !loaded
                        .field_sources
                        .contains_key("providers.kunlunmeta.max_output_tokens")
                );
                assert!(!loaded.field_sources.contains_key("max_tokens"));
                assert!(!loaded.overlay_fields.contains("max_tokens"));
                let sources = loaded
                    .model_configuration_sources
                    .model_fields("kunlunmeta", provider, &provider.default_model)
                    .unwrap();
                assert_eq!(
                    sources["max_output_tokens"],
                    BTreeSet::from(["default".to_string()])
                );
            }
        }
    }
}

#[test]
fn omitted_custom_provider_output_budget_is_bounded_by_its_context_window() {
    let document = serde_json::json!({"providers": {"private": {
        "api_format": "openai_chat_completions",
        "endpoint": "https://private.invalid/v1",
        "default_model": "private-model",
        "context_window_tokens": 128000,
        "output_headroom_tokens": 8192
    }}});
    let original = document.clone();
    let settings = validate_and_resolve_settings_document(&document).unwrap();
    assert_eq!(settings.providers["private"].max_output_tokens, 128000);
    assert_eq!(settings.max_tokens, Some(128000));
    assert_eq!(document, original);
}

#[test]
fn resolved_document_preserves_an_explicit_empty_provider_catalog() {
    for document in [
        serde_json::json!({"providers": {}}),
        serde_json::json!({"providers": {}, "active_provider": null}),
    ] {
        let settings = super::validate_and_resolve_settings_document(&document).unwrap();
        assert!(settings.providers.is_empty());
        assert!(settings.active_provider.is_none());
    }
}

#[test]
fn resolved_document_selects_only_declared_providers() {
    let profile = serde_json::to_value(crate::default_active_provider_config()).unwrap();
    let settings = super::validate_and_resolve_settings_document(&serde_json::json!({
        "providers": {"remote-only": profile}
    }))
    .unwrap();
    assert_eq!(
        settings
            .providers
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["remote-only"]
    );
    assert_eq!(settings.active_provider.as_deref(), Some("remote-only"));
    assert!(
        super::validate_and_resolve_settings_document(&serde_json::json!({}))
            .unwrap()
            .providers
            .contains_key("kunlunmeta")
    );
    assert!(
        super::validate_and_resolve_settings_document(&serde_json::json!({
            "providers": {}, "active_provider": "kunlunmeta"
        }))
        .is_err()
    );
}

#[test]
fn recovery_total_timeout_settings_boundaries_and_layers() {
    let mut document = serde_json::json!({});
    let defaults = validate_and_resolve_settings_document(&document).unwrap();
    assert!(
        serde_json::to_value(defaults).unwrap()["recovery"]["provider"]["total_timeout_ms"]
            .is_null()
    );
    for timeout in [1, 86_400_000] {
        merge_settings_documents(
            &mut document,
            serde_json::json!({"recovery":{"provider":{"total_timeout_ms":timeout}}}),
        );
        let settings = validate_and_resolve_settings_document(&document).unwrap();
        assert_eq!(
            serde_json::to_value(settings).unwrap()["recovery"]["provider"]["total_timeout_ms"],
            timeout
        );
    }
    merge_settings_documents(
        &mut document,
        serde_json::json!({"recovery":{"provider":{"total_timeout_ms":null}}}),
    );
    assert!(
            serde_json::to_value(validate_and_resolve_settings_document(&document).unwrap())
                .unwrap()["recovery"]["provider"]["total_timeout_ms"]
                .is_null()
        );
    for timeout in [
        serde_json::json!(0),
        serde_json::json!(86_400_001),
        serde_json::json!(-1),
        serde_json::json!(1.5),
        serde_json::json!("10"),
    ] {
        assert!(
            serde_json::from_value::<Settings>(
                serde_json::json!({"recovery":{"provider":{"total_timeout_ms":timeout}}})
            )
            .is_err()
        );
        let error = validate_and_resolve_settings_document(
            &serde_json::json!({"recovery":{"provider":{"total_timeout_ms":timeout}}}),
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("schema"), "{error:#}");
    }
}

#[test]
fn recovery_total_timeout_file_layers_and_startup_rejection() {
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    write(
        &config.join("settings.json"),
        r#"{"recovery":{"provider":{"total_timeout_ms":1000}}}"#,
    );
    write(
        &project.join(".kcoder/settings.json"),
        r#"{"recovery":{"provider":{"total_timeout_ms":2000}}}"#,
    );
    write(
        &project.join(".kcoder/settings.local.json"),
        r#"{"recovery":{"provider":{"total_timeout_ms":3000}}}"#,
    );
    let overlay = temp.path().join("overlay.jsonc");
    write(
        &overlay,
        r#"{"recovery":{"provider":{"total_timeout_ms":null}}}"#,
    );
    let loader = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .with_executable_dir(temp.path().join("exe"));
    let loaded = loader.load().unwrap();
    assert_eq!(
        loaded.settings.recovery.provider.total_timeout_ms,
        Some(3000)
    );
    assert_eq!(
        loaded.field_sources["recovery.provider.total_timeout_ms"],
        ConfigScope::Local
    );
    let loader = loader.with_overlay_files([overlay.clone()]);
    assert_eq!(
        loader
            .load()
            .unwrap()
            .settings
            .recovery
            .provider
            .total_timeout_ms,
        None
    );
    write(
        &overlay,
        r#"{"recovery":{"provider":{"total_timeout_ms":0}}}"#,
    );
    assert!(format!("{:#}", loader.load().unwrap_err()).contains("total_timeout_ms"));
}

#[test]
fn prepended_overlay_files_stay_below_explicit_overlays() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    fs::create_dir_all(&config).unwrap();
    write(
        &config.join("settings.json"),
        r#"{"permission_mode":"auto","model":"profile-model"}"#,
    );
    let explicit = temp.path().join("explicit.jsonc");
    write(&explicit, r#"{"model":"explicit-model"}"#);
    let template = temp.path().join("template.jsonc");
    write(
        &template,
        r#"{"model":"template-model","permission_mode":"ask"}"#,
    );

    let loader = SettingsLoader::new(temp.path())
        .with_config_dir(&config)
        .with_executable_dir(temp.path().join("exe"))
        .with_overlay_files([explicit.clone()]);
    assert_eq!(loader.load().unwrap().settings.model, "explicit-model");

    let loader = loader.with_prepended_overlay_files([template.clone()]);
    let loaded = loader.load().unwrap();
    // The explicit overlay keeps the higher precedence...
    assert_eq!(loaded.settings.model, "explicit-model");
    // ...while fields it does not set still come from the template.
    assert_eq!(loaded.settings.permission_mode, crate::PermissionMode::Ask);
    assert_eq!(loaded.overlay_sources, vec![template, explicit]);
    assert!(loaded.overlay_fields.contains("permission_mode"));
    assert!(loaded.overlay_fields.contains("model"));
}

#[test]
fn tool_profile_obeys_user_project_local_and_explicit_layer_order() {
    use crate::ToolProfile;
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    let overlay = temp.path().join("explicit.json");
    fs::create_dir_all(&project).unwrap();
    let load = || {
        SettingsLoader::new(&project)
            .with_config_dir(&config)
            .load()
            .unwrap()
            .settings
    };
    assert_eq!(load().tools.profile, ToolProfile::Full);
    write(
        &config.join("settings.json"),
        r#"{"tools":{"profile":"core"}}"#,
    );
    assert_eq!(load().tools.profile, ToolProfile::Core);
    write(
        &project.join(".kcoder/settings.json"),
        r#"{"tools":{"profile":"nano"}}"#,
    );
    assert_eq!(load().tools.profile, ToolProfile::Nano);
    write(
        &project.join(".kcoder/settings.local.json"),
        r#"{"tools":{"profile":"none"}}"#,
    );
    assert_eq!(load().tools.profile, ToolProfile::None);
    write(&overlay, r#"{"tools":{"profile":"full"}}"#);
    let explicit = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .with_overlay_files([overlay])
        .load()
        .unwrap();
    assert_eq!(explicit.settings.tools.profile, ToolProfile::Full);
    assert!(explicit.overlay_fields.contains("tools.profile"));
}

#[test]
fn loads_user_workspace_and_local_settings_in_precedence_order() {
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    write(
        &config.join("settings.json"),
        r#"{"model":"user","allowed_tools":["read"]}"#,
    );
    write(
        &project.join(".kcoder/settings.json"),
        r#"{"model":"project","allowed_tools":["write"]}"#,
    );
    write(
        &project.join(".kcoder/settings.local.json"),
        r#"{"model":"local","permission_mode":"auto"}"#,
    );

    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .load()
        .unwrap();

    assert_eq!(loaded.settings.model, "local");
    assert_eq!(loaded.settings.permission_mode, crate::PermissionMode::Auto);
    assert_eq!(loaded.settings.allowed_tools, vec!["write"]);
    assert_eq!(loaded.paths.project_root, project);
    assert_eq!(loaded.loaded_sources.len(), 3);
    assert_eq!(loaded.field_sources["model"], ConfigScope::Local);
}

#[test]
fn explicit_goal_limits_override_embedded_defaults() {
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    write(
        &config.join("settings.json"),
        r#"{
                "goal_max_auto_continuations": 3,
                "goal_pro": {
                    "verifier_max_turns": 11,
                    "completion_rejection_limit": 5
                }
            }"#,
    );

    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .load()
        .unwrap();

    assert_eq!(loaded.settings.goal_max_auto_continuations, 3);
    assert_eq!(loaded.settings.goal_pro.verifier_max_turns, 11);
    assert_eq!(loaded.settings.goal_pro.completion_rejection_limit, 5);
    assert_eq!(
        loaded.field_sources["goal_max_auto_continuations"],
        ConfigScope::User
    );
    assert_eq!(
        loaded.field_sources["goal_pro.verifier_max_turns"],
        ConfigScope::User
    );
    assert_eq!(
        loaded.field_sources["goal_pro.completion_rejection_limit"],
        ConfigScope::User
    );
}

#[test]
fn explicitly_empty_provider_catalog_is_authoritative_in_every_file_scope() {
    for scope in ["user", "executable", "project", "local", "overlay"] {
        for bundled in [false, true] {
            let temp = TempDir::new().unwrap();
            let project = temp.path().join("project");
            fs::create_dir_all(&project).unwrap();
            let mut loader = SettingsLoader::new(&project)
                .with_config_dir(temp.path().join("config"))
                .with_executable_dir(temp.path().join("executable"))
                .with_bundled_providers(bundled);
            let paths = loader.paths().unwrap();
            let path = match scope {
                "user" => paths.user_settings,
                "executable" => paths.executable_settings,
                "project" => paths.project_settings,
                "local" => paths.local_settings,
                _ => {
                    let path = temp.path().join("overlay.json");
                    loader = loader.with_overlay_files([path.clone()]);
                    path
                }
            };
            let source = r#"{"providers":{}}"#;
            write(&path, source);
            let loaded = loader.load().unwrap();
            assert!(
                loaded.settings.providers.is_empty(),
                "scope={scope}, bundled={bundled}"
            );
            assert_eq!(loaded.settings.active_provider, None);
            assert_eq!(fs::read_to_string(path).unwrap(), source);
        }
    }
}

#[test]
fn empty_provider_layers_preserve_other_explicit_names_without_restoring_defaults() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let loader = SettingsLoader::new(&project)
        .with_config_dir(temp.path().join("config"))
        .with_executable_dir(temp.path().join("executable"))
        .with_bundled_providers(true);
    let paths = loader.paths().unwrap();
    write(&paths.user_settings, r#"{"providers":{}}"#);
    write(&paths.local_settings, r#"{"providers":{}}"#);
    write(
        &paths.project_settings,
        r#"{"providers":{"fixture":{
            "api_format":"openai_chat_completions","endpoint":"https://example.test/v1",
            "default_model":"fixture-model","context_window_tokens":32000,
            "max_output_tokens":4096,"output_headroom_tokens":4096
        }}}"#,
    );
    let loaded = loader.load().unwrap();
    assert_eq!(
        loaded
            .settings
            .providers
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["fixture"]
    );
    assert_eq!(loaded.settings.active_provider.as_deref(), Some("fixture"));
    write(
        &paths.project_settings,
        r#"{"providers":{},"active_provider":"removed"}"#,
    );
    assert!(
        loader.load().is_err(),
        "an explicit invalid selection must not be silently cleared"
    );
}

#[test]
fn user_providers_are_authoritative_over_embedded_defaults() {
    // A settings file declaring providers owns the complete model list; a
    // built-in default must not restore an entry removed by the user.
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    write(
        &config.join("settings.json"),
        r#"{
                "active_provider": "minimax",
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
                }
            }"#,
    );
    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .load()
        .unwrap();
    assert_eq!(loaded.settings.providers.len(), 1);
    assert!(loaded.settings.providers.contains_key("kunlunmeta"));
    assert!(!loaded.settings.providers.contains_key("minimax"));
    assert!(!loaded.settings.providers.contains_key("kimi"));
    assert!(!loaded.settings.providers.contains_key("openai-chat"));

    // Files without provider declarations continue to use the single embedded kunlunmeta provider.
    let config2 = temp.path().join("config2");
    fs::create_dir_all(&config2).unwrap();
    write(&config2.join("settings.json"), r#"{"model":"anything"}"#);
    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config2)
        .load()
        .unwrap();
    assert_eq!(loaded.settings.providers.len(), 1);
    assert!(loaded.settings.providers.contains_key("kunlunmeta"));
}

#[test]
fn bundled_kunlunmeta_can_be_merged_with_user_providers_for_source_launches() {
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    write(
        &config.join("settings.json"),
        r#"{
                "providers": {
                    "kunlunmeta": {
                        "model": "user-selected-model"
                    },
                    "kunlunmeta-deepseek-v4-flash": {
                        "provider": "kunlunmeta",
                        "api_format": "anthropic_messages",
                        "endpoint": "https://example.test/v1",
                        "model": "DeepSeek-V4-Flash",
                        "context_window_tokens": 200000,
                        "output_headroom_tokens": 20000,
                        "max_output_tokens": 12000
                    }
                }
            }"#,
    );

    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .with_bundled_providers(true)
        .load()
        .unwrap();

    assert!(loaded.settings.providers.contains_key("kunlunmeta"));
    assert!(!loaded.settings.providers.contains_key("minimax"));
    assert!(!loaded.settings.providers.contains_key("kimi"));
    assert!(
        loaded
            .settings
            .providers
            .contains_key("kunlunmeta-deepseek-v4-flash")
    );
    assert_eq!(
        loaded.settings.providers["kunlunmeta"].default_model,
        "user-selected-model"
    );
    assert_eq!(
        loaded.settings.providers.len(),
        crate::default_providers().len() + 1
    );
}

#[test]
fn obsolete_settings_are_ignored_in_every_file_scope() {
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    let overlay = temp.path().join("overlay.json");
    fs::create_dir_all(project.join(".kcoder")).unwrap();
    write(
        &config.join("settings.json"),
        r#"{"model":"user","max_tool_timeout_ms":600000}"#,
    );
    write(
        &project.join(".kcoder/settings.json"),
        r#"{"model":"project","max_tool_timeout_ms":600000}"#,
    );
    write(
        &project.join(".kcoder/settings.local.json"),
        r#"{"model":"local","max_tool_timeout_ms":600000}"#,
    );
    write(
        &overlay,
        r#"{"model":"overlay","max_tool_timeout_ms":600000}"#,
    );

    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .with_overlay_files([overlay])
        .load()
        .unwrap();

    assert_eq!(loaded.settings.model, "overlay");
    assert_eq!(loaded.loaded_sources.len(), 3);
    assert_eq!(loaded.overlay_sources.len(), 1);
    assert!(!loaded.field_sources.contains_key("max_tool_timeout_ms"));
    assert!(!loaded.overlay_fields.contains("max_tool_timeout_ms"));
}

#[test]
fn nested_objects_merge_without_erasing_sibling_values() {
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    write(
        &config.join("settings.json"),
        r#"{"tui":{"alternate_screen":"never"},"tools":{"luna":{"allowed":["read"]}}}"#,
    );
    write(
        &project.join(".kcoder/settings.json"),
        r#"{"tools":{"luna":{"allowed":["grep"]}}}"#,
    );

    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .load()
        .unwrap();
    assert_eq!(
        loaded.settings.tui.alternate_screen,
        crate::TuiAltScreenMode::Never
    );
    assert_eq!(loaded.settings.tools.luna.allowed, vec!["grep"]);
}

#[test]
fn no_settings_files_load_the_builtin_deployment_profile() {
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();

    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .load()
        .unwrap();

    assert!(loaded.loaded_sources.is_empty());
    assert_eq!(
        loaded.settings.active_provider.as_deref(),
        Some(crate::DEFAULT_ACTIVE_PROVIDER)
    );
    assert_eq!(loaded.settings.provider.as_deref(), Some("kunlunmeta"));
    assert_eq!(loaded.settings.model, crate::DEFAULT_MODEL);
    assert_eq!(
        loaded.settings.max_tokens,
        Some(kcoder_types::DEFAULT_MODEL_OUTPUT_TOKENS)
    );
    assert_eq!(loaded.settings.context_output_headroom, Some(100_000));
    assert_eq!(
        loaded.settings.base_url.as_deref(),
        Some(crate::DEFAULT_KUNLUNMETA_ENDPOINT)
    );
}

#[test]
fn user_and_project_settings_override_builtin_provider() {
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    fs::create_dir_all(project.join(".kcoder")).unwrap();
    write(
        &config.join("settings.json"),
        r#"{"providers":{"kunlunmeta":{"default_model":"stale-user-model","max_output_tokens":1}}}"#,
    );

    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .load()
        .unwrap();
    assert_eq!(loaded.settings.model, "stale-user-model");
    assert_eq!(loaded.settings.max_tokens, Some(1));
    assert_eq!(loaded.field_sources["model"], ConfigScope::User);
    assert_eq!(
        loaded.field_sources["providers.kunlunmeta.default_model"],
        ConfigScope::User
    );

    write(
        &project.join(".kcoder/settings.json"),
        r#"{"providers":{"kunlunmeta":{"default_model":"project-model","max_output_tokens":222}}}"#,
    );
    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .load()
        .unwrap();
    assert_eq!(loaded.settings.model, "project-model");
    assert_eq!(loaded.settings.max_tokens, Some(222));
    assert_eq!(loaded.field_sources["model"], ConfigScope::Project);
}

#[test]
fn explicit_overlays_have_highest_file_precedence() {
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    let overlay = temp.path().join("development.json");
    fs::create_dir_all(&project).unwrap();
    write(&config.join("settings.json"), r#"{"model":"user"}"#);
    write(&overlay, r#"{"model":"development"}"#);

    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .with_overlay_files([overlay.clone()])
        .load()
        .unwrap();

    assert_eq!(loaded.settings.model, "development");
    assert_eq!(loaded.overlay_sources, vec![overlay]);
    assert!(loaded.overlay_fields.contains("model"));
}

#[test]
fn development_overlay_configures_dedicated_summary_and_moa_profiles() {
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    // The development overlay reuses the active runtime for summary/MoA,
    // so a user-owned profile catalog remains authoritative.
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
                    },
                    "minimax-summary": {
                        "provider": "minimax",
                        "api_format": "anthropic_messages",
                        "endpoint": "https://api.minimaxi.com/anthropic",
                        "model": "MiniMax-M2.7-highspeed",
                        "context_window_tokens": 1048576,
                        "output_headroom_tokens": 20000,
                        "max_output_tokens": 20000
                    }
                }
            }"#,
    );
    let overlay = PathBuf::from(
        std::env::var_os("KCODER_WORKSPACE_ROOT").expect("Cargo 应提供当前 KCoder 工作区根目录"),
    )
    .join("crates/kcoder_config/setting_dev_user.jsonc");

    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .with_overlay_files([overlay])
        .load()
        .unwrap();

    assert_eq!(loaded.settings.summary_profile, None);
    assert_eq!(
        loaded.settings.providers["kunlunmeta"].default_model,
        "MiniMax-M3"
    );
    let preset = &loaded.settings.moa.presets["default"];
    assert_eq!(preset.reference_models[0].profile, None);
    assert_eq!(preset.reference_models[0].provider, "current");
    assert_eq!(preset.reference_models[0].model, "current");
    assert_eq!(preset.reference_models.len(), 1);
    assert_eq!(preset.aggregator.profile, None);
    assert_eq!(preset.aggregator.provider, "current");
    assert_eq!(preset.aggregator.model, "current");
}

#[test]
fn object_runtime_overrides_survive_model_reselection_with_layered_semantics() {
    for overlay in [false, true] {
        for clear in [false, true] {
            let temp = TempDir::new().unwrap();
            let config = temp.path().join("config");
            let project = temp.path().join("project");
            fs::create_dir_all(&project).unwrap();
            write(
                &config.join("settings.json"),
                &serde_json::json!({
                    "active_provider": "fixture",
                    "providers": {"fixture": {
                        "api_format": "openai_chat_completions",
                        "endpoint": "http://127.0.0.1:1/v1",
                        "default_model": "fixture-model",
                        "context_window_tokens": 32000, "output_headroom_tokens": 1024,
                        "max_output_tokens": 1024,
                        "capabilities": {"tools": true},
                        "extra_body": {"temperature": 0.1}
                    }}
                })
                .to_string(),
            );
            let body = if clear {
                serde_json::json!({})
            } else {
                serde_json::json!({"temperature": 0.7})
            };
            let overrides = serde_json::json!({"provider_extra_body": body, "model_capabilities": {"tools": false}});
            let override_path = if overlay {
                temp.path().join("overlay.json")
            } else {
                project.join(".kcoder/settings.json")
            };
            write(&override_path, &overrides.to_string());
            let mut loader = SettingsLoader::new(&project)
                .with_config_dir(&config)
                .with_executable_dir(temp.path());
            if overlay {
                loader = loader.with_overlay_files([override_path]);
            }
            let loaded = loader.load().unwrap();
            // Empty legacy root patches are no-ops, unlike explicit per-model bodies.
            let expected = if clear {
                serde_json::json!({"temperature": 0.1})
            } else {
                body.clone()
            };
            assert_eq!(
                serde_json::to_value(&loaded.settings.provider_extra_body).unwrap(),
                expected
            );
            let mut selected = loaded.settings.clone();
            selected
                .apply_discovered_model("fixture", "fixture-model")
                .unwrap();
            assert_eq!(selected.provider_extra_body["temperature"], 0.1);
            loaded.model_runtime_overrides.apply(&mut selected).unwrap();
            assert_eq!(
                serde_json::to_value(&selected.provider_extra_body).unwrap(),
                expected,
                "explicit object override must survive selection (overlay={overlay}, clear={clear})"
            );
            assert!(!selected.model_capabilities.tools);
            if clear {
                if overlay {
                    assert!(loaded.overlay_fields.contains("provider_extra_body"));
                } else {
                    assert_eq!(
                        loaded.field_sources["provider_extra_body"],
                        ConfigScope::Project
                    );
                }
            }
        }
    }
}

#[test]
fn active_provider_is_a_baseline_below_project_overrides() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    let config = temp.path().join("config");
    fs::create_dir_all(project.join(".kcoder")).unwrap();
    write(
        &config.join("settings.json"),
        &serde_json::json!({
            "active_provider": "remote",
            "providers": {
                "remote": {
                    "provider": "openai",
                    "api_format": "openai_responses",
                    "endpoint": "https://example.test/v1",
                    "model": "profile-model",
                    "context_window_tokens": 200000,
                    "output_headroom_tokens": 20000,
                    "max_output_tokens": 12000,
                    "request_timeout_secs": 45,
                    "no_proxy": true,
                    "extra_body": {"temperature": 0.1}
                }
            }
        })
        .to_string(),
    );
    write(
        &project.join(".kcoder/settings.json"),
        &serde_json::json!({
            "providers": {"remote": {"model": "project-profile-model"}},
            "model": "project-model",
            "max_tokens": 4000
        })
        .to_string(),
    );

    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .load()
        .unwrap();

    assert_eq!(loaded.settings.model, "project-model");
    assert_eq!(loaded.settings.max_tokens, Some(4000));
    assert_eq!(
        loaded.settings.base_url.as_deref(),
        Some("https://example.test/v1")
    );
    assert_eq!(
        loaded.settings.api_format,
        Some(crate::ApiFormat::OpenaiResponses)
    );
    assert_eq!(loaded.settings.request_timeout_secs, Some(45));
    assert!(loaded.settings.provider_no_proxy);
    assert_eq!(loaded.settings.provider_extra_body["temperature"], 0.1);
    assert_eq!(
        loaded.settings.providers["remote"].default_model,
        "project-profile-model"
    );
}

#[test]
fn missing_config_version_defaults_to_v1_and_future_version_is_rejected() {
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    write(
        &config.join("settings.json"),
        r#"{"tui":{"alternate_screen":"never"}}"#,
    );

    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .load()
        .unwrap();
    assert_eq!(loaded.settings.meta.config_version, CURRENT_CONFIG_VERSION);
    assert_eq!(
        loaded.settings.tui.alternate_screen,
        crate::TuiAltScreenMode::Never
    );

    write(
        &config.join("settings.json"),
        r#"{"meta":{"config_version":2}}"#,
    );
    let error = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .load()
        .unwrap_err()
        .to_string();
    assert!(error.contains("future"), "{error}");
    assert!(error.contains("config_version=2"), "{error}");
}

use super::*;

#[test]
fn optional_tool_default_disables_agree_across_typed_embedded_and_schema() {
    let expected = default_disabled_builtin_tools();
    assert_eq!(expected.len(), 28);
    assert_eq!(
        expected
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        28
    );
    assert_eq!(ToolsSettings::default().disabled, expected);
    assert_eq!(
        serde_json::from_str::<ToolsSettings>("{}")
            .unwrap()
            .disabled,
        expected
    );
    assert_eq!(Settings::default().tools.disabled, expected);
    assert_eq!(
        crate::default_settings_document()["tools"]["disabled"],
        serde_json::json!(expected)
    );
    assert_eq!(
        crate::settings_schema_for_path("tools.disabled").unwrap()["default"],
        serde_json::json!(expected)
    );
    for disabled in [
        "review",
        "skill_manage",
        "skill_curator",
        "skill_hub",
        "CtxInspect",
        "LocalMemoryRecall",
    ] {
        assert!(expected.iter().any(|name| name == disabled));
    }
    for kept in [
        "AskUserQuestion",
        "TodoWrite",
        "PlanAgent",
        "edit_plan",
        "skill",
        "DiscoverSkills",
        "skill_guard",
        "remember",
        "memory_search",
        "memory_get",
        "ListSessions",
        "ReadSession",
        "SendSessionMessage",
        "GetSessionMessageReceipt",
        "ListSessionMessageReceipts",
    ] {
        assert!(!expected.iter().any(|name| name == kept));
    }
    assert!(expected.iter().all(|name| !name.contains('*')));
}

#[test]
fn explicit_empty_and_single_tool_opt_in_replace_the_default_disable_list() {
    let empty: Settings =
        serde_json::from_value(serde_json::json!({"tools":{"disabled":[]}})).unwrap();
    assert!(empty.tools.disabled.is_empty());
    let selected = default_disabled_builtin_tools()
        .into_iter()
        .filter(|name| name != "SpecStatus")
        .collect::<Vec<_>>();
    let settings: Settings =
        serde_json::from_value(serde_json::json!({"tools":{"disabled":selected}})).unwrap();
    assert!(
        !settings
            .tools
            .disabled
            .iter()
            .any(|name| name == "SpecStatus")
    );
    assert!(
        settings
            .tools
            .disabled
            .iter()
            .any(|name| name == "SpecInit")
    );
}

#[test]
fn known_legacy_overlay_preserves_an_explicit_empty_disabled_list() {
    let root = crate::create_private_temp_dir("optional-tool-legacy-overlay").unwrap();
    let path = root.path().join("settings.toml");
    let bytes = b"provider = \"Owned\"\nmodel = \"\"\napi_format = \"openai\"\n[model_providers.Owned]\nbase_url = \"http://127.0.0.1:1/v1\"\n[tools]\ndisabled = []\n";
    std::fs::write(&path, bytes).unwrap();
    let loader = crate::SettingsLoader::new(root.path())
        .with_config_dir(root.path().join("profile"))
        .with_executable_dir(root.path().join("absent-executable"))
        .with_overlay_files([path.clone()]);
    assert!(
        loader
            .load_for_management()
            .unwrap()
            .settings
            .tools
            .disabled
            .is_empty()
    );
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn initialized_minimal_profile_inherits_defaults_but_existing_explicit_empty_is_preserved() {
    let root = crate::create_private_temp_dir("optional-tool-default-profile").unwrap();
    let loader = crate::SettingsLoader::new(root.path())
        .with_config_dir(root.path().join("profile"))
        .with_executable_dir(root.path().join("no-executable"));
    let paths = loader.paths().unwrap();
    assert!(
        crate::write_scope_if_missing(&paths, crate::ConfigScope::User, &serde_json::json!({}))
            .unwrap()
    );
    assert_eq!(
        loader
            .load_for_management()
            .unwrap()
            .settings
            .tools
            .disabled,
        default_disabled_builtin_tools()
    );
    crate::update_settings_file(&paths.user_settings, |value| {
        value["tools"] = serde_json::json!({"disabled":[]});
        Ok(())
    })
    .unwrap();
    let before = std::fs::read(&paths.user_settings).unwrap();
    assert!(
        !crate::write_scope_if_missing(&paths, crate::ConfigScope::User, &serde_json::json!({}))
            .unwrap()
    );
    assert!(
        loader
            .load_for_management()
            .unwrap()
            .settings
            .tools
            .disabled
            .is_empty()
    );
    assert_eq!(std::fs::read(&paths.user_settings).unwrap(), before);
}

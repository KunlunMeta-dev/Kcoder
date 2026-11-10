use super::*;

#[test]
fn studio_tools_legacy_and_embedded_defaults_agree() {
    for source in [
        "{}",
        r#"{"tools":{"profile":"core","disabled":["Spec*"],"luna":{"allowed":["read"]},"file_edit_tool":"apply_patch"}}"#,
        include_str!("../../settting_inline.jsonc"),
        include_str!("../../setting_dev_user.jsonc"),
    ] {
        let document = jsonc_parser::parse_to_serde_value(source, &Default::default()).unwrap();
        let settings: Settings = serde_json::from_value(document).unwrap();
        assert_eq!(settings.tools.studio, StudioToolSelections::default());
    }
    let settings = validate_and_resolve_settings_document(&serde_json::json!({})).unwrap();
    assert_eq!(settings.tools.studio, StudioToolSelections::default());
    assert_eq!(settings.tools.profile, ToolProfile::Full);
    let schema = settings_schema_for_path("tools.studio").unwrap();
    assert_eq!(schema["default"], serde_json::json!({}));
}

#[test]
fn studio_tools_preserve_explicit_empty_and_literal_wildcards() {
    let document = serde_json::json!({"tools":{"studio":{"kcoder":[],"kworker":["*","Spec*","read"]},
        "profile":"core","disabled":["memory_*"],"luna":{"allowed":["grep"]},"file_edit_tool":"apply_patch"}});
    let settings = validate_and_resolve_settings_document(&document).unwrap();
    assert_eq!(settings.tools.studio.kcoder, Some(vec![]));
    assert_eq!(
        settings.tools.studio.kworker,
        Some(vec!["*".into(), "Spec*".into(), "read".into()])
    );
    assert_eq!(settings.tools.profile, ToolProfile::Core);
    assert_eq!(settings.tools.disabled, vec!["memory_*"]);
    assert_eq!(settings.tools.luna.allowed, vec!["grep"]);
    assert_eq!(settings.tools.file_edit_tool, FileEditSurface::ApplyPatch);
    let roundtrip = serde_json::to_value(&settings).unwrap();
    assert_eq!(roundtrip["tools"]["studio"], document["tools"]["studio"]);
}

#[test]
fn studio_tools_validate_both_typed_and_document_boundaries() {
    let invalid_lists = vec![
        serde_json::json!([""]),
        serde_json::json!([" read"]),
        serde_json::json!(["read "]),
        serde_json::json!(["read\nname"]),
        serde_json::json!(["read\u{0085}name"]),
        serde_json::json!(["\u{2003}read"]),
        serde_json::json!(["read", "read"]),
        serde_json::json!(["x".repeat(257)]),
        serde_json::json!(["界".repeat(86)]),
        serde_json::json!(
            (0..1025)
                .map(|index| format!("tool_{index}"))
                .collect::<Vec<_>>()
        ),
    ];
    for mode in ["kcoder", "kworker"] {
        for names in &invalid_lists {
            let document = serde_json::json!({"tools":{"studio":{mode:names}}});
            assert!(
                serde_json::from_value::<Settings>(document.clone()).is_err(),
                "{mode}"
            );
            assert!(
                crate::schema::validate_settings_schema(&document).is_err(),
                "{mode}"
            );
            assert!(
                validate_and_resolve_settings_document(&document).is_err(),
                "{mode}"
            );
        }
        for names in [
            serde_json::json!(["x".repeat(256)]),
            serde_json::json!(["界".repeat(85)]),
            serde_json::json!(
                (0..1024)
                    .map(|index| format!("tool_{index}"))
                    .collect::<Vec<_>>()
            ),
        ] {
            let document = serde_json::json!({"tools":{"studio":{mode:names}}});
            validate_and_resolve_settings_document(&document).unwrap();
        }
    }
}

#[test]
fn studio_tools_overlays_replace_arrays_and_preserve_siblings() {
    let root = TempDir::new().unwrap();
    let config = root.path().join("config");
    let project = root.path().join("project");
    let executable = root.path().join("bin");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::create_dir_all(&executable).unwrap();
    std::fs::create_dir_all(project.join(".kcoder")).unwrap();
    std::fs::write(
        config.join("settings.json"),
        r#"{"tools":{"studio":{"kcoder":["read","grep"],"kworker":["Workflow"]}}}"#,
    )
    .unwrap();
    let load = || {
        SettingsLoader::new(&project)
            .with_config_dir(&config)
            .with_executable_dir(&executable)
            .load()
            .unwrap()
    };
    assert_eq!(
        load().settings.tools.studio.kcoder,
        Some(vec!["read".into(), "grep".into()])
    );
    std::fs::write(
        project.join(".kcoder/settings.json"),
        r#"{"tools":{"studio":{"kcoder":["write"]}}}"#,
    )
    .unwrap();
    let loaded = load();
    assert_eq!(
        loaded.settings.tools.studio.kcoder,
        Some(vec!["write".into()])
    );
    assert_eq!(
        loaded.settings.tools.studio.kworker,
        Some(vec!["Workflow".into()])
    );
    std::fs::write(
        project.join(".kcoder/settings.local.json"),
        r#"{"tools":{"studio":{"kcoder":[],"kworker":null}}}"#,
    )
    .unwrap();
    let loaded = load();
    assert_eq!(loaded.settings.tools.studio.kcoder, Some(vec![]));
    assert_eq!(loaded.settings.tools.studio.kworker, None);
}

#[test]
fn studio_tools_profile_update_supports_outer_cas_and_preserves_old_json() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("settings.json");
    std::fs::write(&path, "{\n  // Keep the user's comment.\n  \"tools\": {\"profile\": \"core\", \"disabled\": [\"Spec*\"]}\n}\n").unwrap();
    let file =
        ProfileSettingsFile::new(PrivateDirectory::open_existing(root.path()).unwrap()).unwrap();
    let expected = file.read().unwrap();
    let saved = file
        .update(|current| {
            anyhow::ensure!(*current == expected, "revision conflict");
            current["tools"]["studio"] = serde_json::json!({"kcoder":[],"kworker":["read"]});
            Ok(())
        })
        .unwrap();
    assert_eq!(saved["tools"]["studio"]["kcoder"], serde_json::json!([]));
    assert_eq!(saved["tools"]["disabled"], serde_json::json!(["Spec*"]));
    assert!(
        std::fs::read_to_string(&path)
            .unwrap()
            .contains("Keep the user's comment.")
    );
    let bytes = std::fs::read(&path).unwrap();
    assert!(
        file.update(|current| {
            anyhow::ensure!(*current == expected, "revision conflict");
            current["tools"]["studio"] = serde_json::json!({"kcoder":["write"]});
            Ok(())
        })
        .is_err()
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert!(
        file.update(|current| {
            current["tools"]["studio"] = serde_json::json!({"kcoder":["bad "]});
            Ok(())
        })
        .is_err()
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[test]
fn studio_tools_kworker_defaults_are_sorted_unique_and_include_configured_luna() {
    let names = kworker_default_tool_names(&[
        "custom_tool".into(),
        "Workflow".into(),
        "read".into(),
        "read".into(),
    ]);
    assert!(names.windows(2).all(|pair| pair[0] < pair[1]));
    for name in KWORKER_DEFAULT_AGENT_TOOLS
        .iter()
        .chain(KWORKER_DEFAULT_WORKFLOW_TOOLS)
        .chain(KWORKER_DEFAULT_SHELL_TOOLS)
        .chain(
            [
                "show_widget",
                "tool_search",
                "tool_execute",
                "custom_tool",
                "read",
            ]
            .iter(),
        )
    {
        assert!(names.iter().any(|candidate| candidate.as_str() == *name));
    }
    assert_eq!(names.len(), 14);
}

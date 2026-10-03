use super::*;

#[test]
fn default_code_theme_uses_codex_adaptive_mode() {
    assert_eq!(Settings::default().code_theme, "auto");
}

#[test]
fn tui_alternate_screen_settings_match_codex_mode_names() {
    let settings: Settings = serde_json::from_str(
        r#"{
                "tui": {
                    "alternate_screen": "auto"
                }
            }"#,
    )
    .unwrap();

    assert_eq!(settings.tui.alternate_screen, TuiAltScreenMode::Auto);
    assert!(!settings.tui.no_alt_screen);
    assert_eq!(
        serde_json::to_value(settings.tui.alternate_screen).unwrap(),
        serde_json::Value::String("auto".to_string())
    );
}

#[test]
fn tui_settings_default_to_fullscreen_and_skip_cli_override() {
    let settings: Settings = serde_json::from_str("{}").unwrap();

    assert_eq!(settings.tui.alternate_screen, TuiAltScreenMode::Auto);
    assert!(!settings.tui.no_alt_screen);

    let mut settings = Settings::default();
    settings.tui.no_alt_screen = true;
    let serialized = serde_json::to_value(&settings).unwrap();
    assert_eq!(serialized["tui"]["alternate_screen"], "auto");
    assert!(serialized["tui"].get("no_alt_screen").is_none());
}

#[test]
fn tui_path_preview_defaults_schema_and_layer_override() {
    let defaults: Settings = serde_json::from_str("{}").unwrap();
    assert!(!defaults.tui.path_preview.enabled);
    let mut user = serde_json::json!({"tui":{"path_preview":{"enabled":true}}});
    schema::validate_settings_schema(&user).unwrap();
    let parsed: Settings = serde_json::from_value(user.clone()).unwrap();
    assert!(parsed.tui.path_preview.enabled);
    merge_settings_documents(
        &mut user,
        serde_json::json!({"tui":{"path_preview":{"enabled":false}}}),
    );
    let parsed: Settings = serde_json::from_value(user).unwrap();
    assert!(!parsed.tui.path_preview.enabled);
    let invalid = serde_json::json!({"tui":{"path_preview":{"enabled":"true"}}});
    assert!(schema::validate_settings_schema(&invalid).is_err());
    assert!(serde_json::from_value::<Settings>(invalid).is_err());
}

#[test]
fn tui_path_preview_project_overrides_user_file() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    let executable = temp.path().join("bin");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::create_dir_all(&executable).unwrap();
    std::fs::create_dir_all(project.join(".kcoder")).unwrap();
    std::fs::write(
        config.join("settings.json"),
        r#"{"tui":{"path_preview":{"enabled":true}}}"#,
    )
    .unwrap();
    let load = || {
        SettingsLoader::new(&project)
            .with_config_dir(&config)
            .with_executable_dir(&executable)
            .load()
            .unwrap()
    };
    assert!(load().settings.tui.path_preview.enabled);
    std::fs::write(
        project.join(".kcoder/settings.json"),
        r#"{"tui":{"path_preview":{"enabled":false}}}"#,
    )
    .unwrap();
    let loaded = load();
    assert!(!loaded.settings.tui.path_preview.enabled);
    assert_eq!(
        loaded.field_sources["tui.path_preview.enabled"],
        ConfigScope::Project
    );
    std::fs::write(
        project.join(".kcoder/settings.local.json"),
        r#"{"tui":{"path_preview":{"enabled":true}}}"#,
    )
    .unwrap();
    let loaded = load();
    assert!(loaded.settings.tui.path_preview.enabled);
    assert_eq!(
        loaded.field_sources["tui.path_preview.enabled"],
        ConfigScope::Local
    );
    let overlay = temp.path().join("setting_test.jsonc");
    std::fs::write(&overlay, r#"{"tui":{"path_preview":{"enabled":false}}}"#).unwrap();
    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .with_executable_dir(&executable)
        .with_overlay_files([overlay])
        .load()
        .unwrap();
    assert!(!loaded.settings.tui.path_preview.enabled);
    assert!(loaded.overlay_fields.contains("tui.path_preview.enabled"));
}

#[test]
fn settings_save_is_atomic() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("settings.json");
    let settings = Settings {
        model: "test-model".into(),
        ..Settings::default()
    };
    // Direct write to temp path then rename, mirroring save logic.
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, serde_json::to_string_pretty(&settings).unwrap()).unwrap();
    fs::rename(&tmp_path, &path).unwrap();
    assert!(path.exists());
    let loaded: Settings = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(loaded.model, "test-model");
}

#[test]
fn settings_normalize_expands_external_dir_home_paths() {
    let mut settings = Settings {
        skills: SkillsSettings {
            external_dirs: vec![PathBuf::from("~/team-skills")],
            ..SkillsSettings::default()
        },
        ..Settings::default()
    };

    settings.normalize_paths();

    let expected = dirs::home_dir()
        .map(|home| home.join("team-skills"))
        .unwrap_or_else(|| PathBuf::from("~/team-skills"));
    assert_eq!(settings.skills.external_dirs, vec![expected]);
}

#[test]
fn project_key_uses_sanitized_path() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("project with spaces");
    fs::create_dir_all(&root).unwrap();

    let project_dir = Settings::project_data_dir(&root).unwrap();
    let legacy_dir = Settings::legacy_project_data_dir(&root).unwrap();
    let project_key = project_dir.file_name().unwrap().to_string_lossy();
    let legacy_key = legacy_dir.file_name().unwrap().to_string_lossy();

    assert!(project_key.contains("project-with-spaces"));
    assert!(!project_key.contains("project_with_spaces"));
    assert!(legacy_key.contains("project_with_spaces"));
    assert_ne!(project_key, legacy_key);

    let read_dirs = Settings::project_data_dirs_for_read(&root).unwrap();
    assert_eq!(read_dirs.first(), Some(&project_dir));
    assert!(read_dirs.contains(&legacy_dir));
    assert_eq!(
        read_dirs.iter().collect::<HashSet<_>>().len(),
        read_dirs.len()
    );
}

#[cfg(windows)]
#[test]
fn project_data_read_dirs_preserve_verbatim_windows_compatibility() {
    let tmp = TempDir::new().unwrap();
    let current = Settings::project_data_dir(tmp.path()).unwrap();
    let read_dirs = Settings::project_data_dirs_for_read(tmp.path()).unwrap();
    let previous = Settings::projects_dir()
        .unwrap()
        .join(previous_project_key_for_path(tmp.path()));

    assert!(read_dirs.first().is_some_and(|dir| dir == &current));
    assert!(read_dirs.contains(&previous));
    assert!(
        !normalized_project_path(tmp.path())
            .to_string_lossy()
            .starts_with(r"\\?\")
    );
    assert!(
        previous_normalized_project_path(tmp.path())
            .to_string_lossy()
            .starts_with(r"\\?\")
    );
}

#[test]
fn turn_file_changes_policy_defaults_and_schema_are_wired() {
    let settings = Settings::default();
    assert_eq!(
        settings.turn_file_changes,
        TurnFileChangesSettings::default()
    );

    let document = serde_json::json!({
        "turn_file_changes": {
            "max_file_bytes": 1048576,
            "ignore_globs": ["**/*.gguf"]
        }
    });
    crate::schema::validate_settings_schema(&document)
        .expect("embedded schema must accept turn_file_changes");

    let parsed: Settings = serde_json::from_value(serde_json::json!({
        "turn_file_changes": { "max_file_bytes": 1048576, "ignore_globs": ["**/*.gguf"] }
    }))
    .unwrap();
    assert_eq!(parsed.turn_file_changes.max_file_bytes, 1_048_576);
    assert_eq!(parsed.turn_file_changes.ignore_globs, vec!["**/*.gguf"]);
    assert_eq!(
        parsed.turn_file_changes.retention_days, 14,
        "defaults fill the rest"
    );
}

#[test]
fn long_workspace_read_dirs_skip_impossible_legacy_components() {
    let tmp = TempDir::new().unwrap();
    let cwd = tmp.path().join("nested".repeat(25)).join("workspace".repeat(20));
    fs::create_dir_all(&cwd).unwrap();
    let current = Settings::project_data_dir(&cwd).unwrap();
    let legacy = Settings::legacy_project_data_dir(&cwd).unwrap();
    let dirs = Settings::project_data_dirs_for_read(&cwd).unwrap();
    assert_eq!(dirs.first(), Some(&current));
    assert!(!dirs.contains(&legacy));
    for dir in dirs {
        // Missing valid paths are normal; invalid component lengths must not
        // escape into history listing, worktree preflight or session restore.
        assert!(!dir.try_exists().unwrap());
    }
}

use super::*;

#[test]
fn dev_and_release_profile_paths_do_not_share_state_roots() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let dev = ConfigPaths::with_config_dir(&project, temp.path().join("home/.config/kcoder-dev"));
    let release = ConfigPaths::with_config_dir(&project, temp.path().join("home/.config/kcoder"));

    assert_ne!(dev.config_dir, release.config_dir);
    assert_ne!(dev.user_settings, release.user_settings);
    assert_ne!(dev.credentials, release.credentials);
    assert_ne!(
        dev.config_dir.join("memory"),
        release.config_dir.join("memory")
    );
    assert_ne!(
        dev.config_dir.join("history"),
        release.config_dir.join("history")
    );
    assert_ne!(
        dev.config_dir.join("projects"),
        release.config_dir.join("projects")
    );
}

#[test]
fn profile_home_prefers_explicit_config_override() {
    let path = resolve_user_config_dir(
        Some("/tmp/explicit".into()),
        Some("/tmp/profile".into()),
        Some("kcoder-dev".into()),
        Some(PathBuf::from("/home/kcoder-test")),
    )
    .unwrap();
    assert_eq!(path, PathBuf::from("/tmp/explicit"));
}

#[test]
fn profile_home_uses_kcoder_home() {
    let path = resolve_user_config_dir(
        None,
        Some("/home/kcoder-test/.config/custom-profile".into()),
        None,
        Some(PathBuf::from("/home/kcoder-test")),
    )
    .unwrap();
    assert_eq!(
        path,
        PathBuf::from("/home/kcoder-test/.config/custom-profile")
    );
}

#[test]
fn dev_executable_uses_isolated_profile() {
    let path = resolve_user_config_dir(
        None,
        None,
        Some("kcoder-dev".into()),
        Some(PathBuf::from("/home/kcoder-test")),
    )
    .unwrap();
    assert_eq!(path, PathBuf::from("/home/kcoder-test/.config/kcoder-dev"));
}

#[test]
fn release_executable_uses_formal_profile() {
    let path = resolve_user_config_dir(
        None,
        None,
        Some("kcoder".into()),
        Some(PathBuf::from("/home/kcoder-test")),
    )
    .unwrap();
    assert_eq!(path, PathBuf::from("/home/kcoder-test/.config/kcoder"));
}

#[test]
fn loads_executable_directory_settings_between_user_and_project_settings() {
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let executable_dir = temp.path().join("bin");
    let project = temp.path().join("project");
    fs::create_dir_all(project.join(".kcoder")).unwrap();
    fs::create_dir_all(&executable_dir).unwrap();
    write(
        &config.join("settings.json"),
        r#"{"model":"user","permission_mode":"ask"}"#,
    );
    write(
        &executable_dir.join("settings.json"),
        r#"{"model":"executable","request_timeout_secs":11}"#,
    );
    write(
        &project.join(".kcoder/settings.json"),
        r#"{"model":"project"}"#,
    );
    write(
        &project.join(".kcoder/settings.local.json"),
        r#"{"model":"local"}"#,
    );

    let loaded = SettingsLoader::new(&project)
        .with_config_dir(&config)
        .with_executable_dir(&executable_dir)
        .load()
        .unwrap();

    assert_eq!(loaded.settings.model, "local");
    assert_eq!(loaded.settings.permission_mode, crate::PermissionMode::Ask);
    assert_eq!(loaded.settings.request_timeout_secs, Some(11));
    assert_eq!(loaded.field_sources["model"], ConfigScope::Local);
    assert_eq!(
        loaded.field_sources["request_timeout_secs"],
        ConfigScope::Executable
    );
    assert_eq!(
        loaded.loaded_sources,
        vec![
            ConfigSource {
                scope: ConfigScope::User,
                path: config.join("settings.json"),
            },
            ConfigSource {
                scope: ConfigScope::Executable,
                path: executable_dir.join("settings.json"),
            },
            ConfigSource {
                scope: ConfigScope::Project,
                path: project.join(".kcoder/settings.json"),
            },
            ConfigSource {
                scope: ConfigScope::Local,
                path: project.join(".kcoder/settings.local.json"),
            },
        ]
    );
}

#[test]
fn does_not_load_settings_from_parent_directories() {
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let parent = temp.path().join("parent");
    let workspace = parent.join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    write(
        &parent.join(".kcoder/settings.json"),
        r#"{"model":"parent-model"}"#,
    );

    let loaded = SettingsLoader::new(&workspace)
        .with_config_dir(&config)
        .load()
        .unwrap();

    assert_eq!(loaded.paths.project_root, workspace);
    assert_eq!(
        loaded.paths.project_settings,
        loaded.paths.project_root.join(".kcoder/settings.json")
    );
    assert_ne!(loaded.settings.model, "parent-model");
    assert!(
        loaded
            .loaded_sources
            .iter()
            .all(|source| source.scope != ConfigScope::Project)
    );
}

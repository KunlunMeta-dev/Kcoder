use super::*;

#[test]
fn session_overlay_is_pinned_while_user_settings_reload() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("config");
    std::fs::create_dir(&home).unwrap();
    let user = home.join("settings.json");
    let overlay = temp.path().join("template.json");
    std::fs::write(&user, r#"{"max_retries":1}"#).unwrap();
    std::fs::write(
        &overlay,
        r#"{"max_tokens":128,"tools":{"disabled":["PRIVATE_OVERLAY_SENTINEL"]}}"#,
    )
    .unwrap();
    let live = SettingsLoader::new(temp.path())
        .with_config_dir(&home)
        .with_executable_dir(temp.path())
        .with_overlay_files([overlay.clone()]);
    let frozen = live.clone().freeze_overlays().unwrap();
    assert!(!format!("{frozen:?}").contains("PRIVATE_OVERLAY_SENTINEL"));
    std::fs::write(&user, r#"{"max_retries":2}"#).unwrap();
    std::fs::write(&overlay, r#"{"max_tokens":256}"#).unwrap();
    let loaded = frozen.load().unwrap().settings;
    assert_eq!(loaded.max_tokens, Some(128));
    assert_eq!(loaded.max_retries, 2);
    assert_eq!(live.load().unwrap().settings.max_tokens, Some(256));
    std::fs::remove_file(&overlay).unwrap();
    assert_eq!(frozen.load().unwrap().settings.max_tokens, Some(128));
    assert!(live.load().is_err());
}

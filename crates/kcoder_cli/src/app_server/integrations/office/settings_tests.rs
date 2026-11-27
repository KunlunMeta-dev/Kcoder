use super::*;
use clap::Parser;
use kcoder_config::SettingsLoader;
use std::{ffi::OsStr, sync::Arc};

struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    engine: QueryEngine,
    factory: AppServerEngineFactory,
}
fn fixture(overlay: Option<bool>) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_existing(root.path()).unwrap();
    parent.create_private_child(OsStr::new("profile")).unwrap();
    parent
        .create_private_child(OsStr::new("workspace"))
        .unwrap();
    let profile = root.path().join("profile");
    let cwd = root.path().join("workspace");
    let path = profile.join("settings.json");
    std::fs::write(&path, "{\n// retained user comment\n\"providers\":{},\"history_enabled\":false,\"studio_context\":{\"instructions\":\"preserve\"},\"integrations\":{\"office\":{\"enabled\":false,\"allowExternalDelivery\":false}}\n}\n").unwrap();
    let mut cli = crate::Cli::parse_from(["kcoder"]);
    if let Some(value) = overlay {
        let path = root.path().join("overlay.json");
        std::fs::write(
            &path,
            json!({"integrations":{"office":{"enabled":value}}}).to_string(),
        )
        .unwrap();
        cli.settings_files.push(path);
    }
    let loader = SettingsLoader::new(&cwd)
        .with_config_dir(&profile)
        .with_executable_dir(&cwd)
        .with_overlay_files(cli.settings_files.clone());
    let settings = loader.load().unwrap().settings;
    let provider = Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
        crate::tui_dev_mock::TuiDevScenario::FullTurn,
    ));
    let owner = Arc::new(kcoder_config::create_private_temp_dir("office-settings-tests").unwrap());
    let services = kcoder_engine::WorkspaceRuntimeServices::new(&cwd, "office-settings-tests")
        .with_private_client_storage(owner);
    let engine = QueryEngine::try_new_for_client_with_services(
        provider.clone(),
        kcoder_state::AppState::new(&cwd),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings.clone(),
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        cwd.clone(),
        Some(true),
        services.clone(),
    )
    .unwrap()
    .with_settings_persistence_path(path.clone());
    let factory = AppServerEngineFactory::new(
        provider,
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        cwd.clone(),
        None,
        true,
        services,
        Some(path),
        cwd.join("test-ids"),
    )
    .with_session_configuration(loader, cli, false)
    .unwrap();
    Fixture {
        _root: root,
        profile,
        engine,
        factory,
    }
}
fn entries(path: &std::path::Path) -> Vec<OsString> {
    let mut value = std::fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    value.sort();
    value
}
fn input(value: bool, revision: String) -> OfficeSettingsSaveParams {
    OfficeSettingsSaveParams {
        enabled: value,
        expected_revision: revision,
    }
}

#[test]
fn observes_disabled_target_without_creating_config_or_feature_storage() {
    let f = fixture(None);
    let path = f.profile.join("settings.json");
    let before = std::fs::read(&path).unwrap();
    let names = entries(&f.profile);
    let actual = read(&f.engine, &f.factory, &CancellationToken::new()).unwrap();
    assert_eq!(actual.persisted_enabled, Some(false));
    assert!(!actual.effective_enabled);
    assert!(!actual.connection_enabled);
    assert!(!actual.restart_required);
    assert_eq!(std::fs::read(path).unwrap(), before);
    assert_eq!(entries(&f.profile), names);
    let public = serde_json::to_string(&actual).unwrap();
    assert!(!public.contains("settings.json"));
    assert!(!public.contains("preserve"));
}

#[test]
fn changes_only_office_enabled_and_keeps_jsonc_other_values_and_old_connection_explicit() {
    let f = fixture(None);
    let token = CancellationToken::new();
    let initial = read(&f.engine, &f.factory, &token).unwrap();
    let saved = save(&f.engine, &f.factory, input(true, initial.revision), &token).unwrap();
    assert_eq!(saved.persisted_enabled, Some(true));
    assert!(saved.effective_enabled);
    assert!(!saved.connection_enabled);
    assert!(saved.restart_required);
    let raw = std::fs::read_to_string(f.profile.join("settings.json")).unwrap();
    assert!(raw.contains("// retained user comment"));
    let doc = kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap();
    assert_eq!(doc["providers"], json!({}));
    assert_eq!(doc["studio_context"]["instructions"], "preserve");
    assert_eq!(
        doc["integrations"]["office"]["allowExternalDelivery"],
        false
    );
    assert!(doc.get("model").is_none());
    assert!(!f.profile.join("integrations").exists());
    *f.engine.settings.write().unwrap() = f.factory.current_settings().unwrap();
    let refreshed = read(&f.engine, &f.factory, &token).unwrap();
    assert!(refreshed.connection_enabled);
    assert!(!refreshed.restart_required);
}

#[test]
fn old_revision_conflicts_while_unrelated_edits_are_preserved() {
    let f = fixture(None);
    let token = CancellationToken::new();
    let initial = read(&f.engine, &f.factory, &token).unwrap();
    kcoder_config::update_settings_file(&f.profile.join("settings.json"), |doc| {
        kcoder_config::set_dotted_value(
            doc,
            "studio_context.instructions",
            json!("new unrelated text"),
        )
    })
    .unwrap();
    let saved = save(
        &f.engine,
        &f.factory,
        input(true, initial.revision.clone()),
        &token,
    )
    .unwrap();
    let before = std::fs::read(f.profile.join("settings.json")).unwrap();
    assert_eq!(
        save(
            &f.engine,
            &f.factory,
            input(false, initial.revision),
            &token
        )
        .unwrap_err()
        .to_string(),
        "OFFICE_SETTINGS_REVISION_CONFLICT"
    );
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        before
    );
    assert_eq!(saved.persisted_enabled, Some(true));
    assert_eq!(
        kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap()["studio_context"]
            ["instructions"],
        "new unrelated text"
    );
}

#[test]
fn two_actual_writers_use_the_same_config_lock_and_only_one_original_revision_commits() {
    let f = fixture(None);
    let initial = read(&f.engine, &f.factory, &CancellationToken::new()).unwrap();
    let gate = Arc::new(std::sync::Barrier::new(2));
    let threads = (0..2)
        .map(|_| {
            let engine = f.engine.clone();
            let factory = f.factory.clone();
            let expected = initial.revision.clone();
            let gate = gate.clone();
            std::thread::spawn(move || {
                gate.wait();
                save(
                    &engine,
                    &factory,
                    input(true, expected),
                    &CancellationToken::new(),
                )
            })
        })
        .collect::<Vec<_>>();
    let results = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .find_map(|value| value.as_ref().err())
            .unwrap()
            .to_string(),
        "OFFICE_SETTINGS_REVISION_CONFLICT"
    );
}

#[test]
fn overlay_remains_authoritative_and_is_never_written_back_to_user_settings() {
    let f = fixture(Some(false));
    let token = CancellationToken::new();
    let overlay = f._root.path().join("overlay.json");
    let before = std::fs::read(&overlay).unwrap();
    let initial = read(&f.engine, &f.factory, &token).unwrap();
    let saved = save(&f.engine, &f.factory, input(true, initial.revision), &token).unwrap();
    assert_eq!(saved.persisted_enabled, Some(true));
    assert!(!saved.effective_enabled);
    assert!(!saved.restart_required);
    assert_eq!(std::fs::read(overlay).unwrap(), before);
}

#[test]
fn cancellation_missing_empty_bad_or_foreign_targets_never_become_a_valid_empty_config() {
    let f = fixture(None);
    let token = CancellationToken::new();
    let initial = read(&f.engine, &f.factory, &token).unwrap();
    let path = f.profile.join("settings.json");
    let before = std::fs::read(&path).unwrap();
    token.cancel();
    assert_eq!(
        save(&f.engine, &f.factory, input(true, initial.revision), &token)
            .unwrap_err()
            .to_string(),
        "OFFICE_SETTINGS_CANCELLED"
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    for invalid in [
        b" ".as_slice(),
        b"{".as_slice(),
        b"{\"integrations\":{\"office\":{\"enabled\":\"true\"}}}".as_slice(),
    ] {
        std::fs::write(&path, invalid).unwrap();
        assert!(read(&f.engine, &f.factory, &CancellationToken::new()).is_err());
    }
    std::fs::remove_file(&path).unwrap();
    assert!(read(&f.engine, &f.factory, &CancellationToken::new()).is_err());
    assert!(!path.exists());
    std::fs::write(f._root.path().join("not-user.json"), b"{}").unwrap();
    std::fs::write(&path, before).unwrap();
    let other = f
        .engine
        .clone()
        .with_settings_persistence_path(f._root.path().join("not-user.json"));
    assert_eq!(
        read(&other, &f.factory, &CancellationToken::new())
            .unwrap_err()
            .to_string(),
        "OFFICE_SETTINGS_TARGET_CHANGED"
    );
}

#[cfg(unix)]
#[test]
fn refuses_linked_configuration_sources() {
    let f = fixture(None);
    let path = f.profile.join("settings.json");
    let original = f.profile.join("original.json");
    std::fs::rename(&path, &original).unwrap();
    std::os::unix::fs::symlink(&original, &path).unwrap();
    assert!(read(&f.engine, &f.factory, &CancellationToken::new()).is_err());
    std::fs::remove_file(&path).unwrap();
    std::fs::hard_link(&original, &path).unwrap();
    assert!(read(&f.engine, &f.factory, &CancellationToken::new()).is_err());
}

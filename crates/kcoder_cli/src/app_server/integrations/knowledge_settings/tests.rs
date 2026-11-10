use super::*;
use clap::Parser;
use kcoder_config::SettingsLoader;
use std::{ffi::OsStr, sync::Arc};

struct Fixture {
    root: tempfile::TempDir,
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
    std::fs::write(&path,"{\n// user comment retained\n\"providers\":{},\"history_enabled\":false,\"studio_context\":{\"instructions\":\"preserve\"},\"integrations\":{\"knowledge\":{\"observer_candidates_enabled\":false,\"auxiliary_extraction_enabled\":false}}\n}").unwrap();
    let mut cli = crate::Cli::parse_from(["kcoder"]);
    if let Some(value) = overlay {
        let path = root.path().join("overlay.json");
        std::fs::write(
            &path,
            json!({"integrations":{"knowledge":{"business_automation_enabled":value}}}).to_string(),
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
    let owner =
        Arc::new(kcoder_config::create_private_temp_dir("knowledge-settings-tests").unwrap());
    let services = kcoder_engine::WorkspaceRuntimeServices::new(&cwd, "knowledge-settings-tests")
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
        root,
        profile,
        engine,
        factory,
    }
}
fn params(feature: KnowledgeSettingsFeature, revision: String) -> KnowledgeSettingsSaveParams {
    KnowledgeSettingsSaveParams {
        feature,
        enabled: true,
        expected_revision: revision,
    }
}

#[test]
fn disabled_features_are_readable_without_enabling_them_or_initializing_domain_storage() {
    let f = fixture(None);
    let before = std::fs::read(f.profile.join("settings.json")).unwrap();
    let actual = read(&f.engine, &f.factory, &CancellationToken::new()).unwrap();
    assert_eq!(actual.persisted.business_automation_enabled, None);
    assert!(
        !actual.effective.memory_center_enabled
            && !actual.effective.publications_enabled
            && !actual.effective.business_automation_enabled
    );
    assert!(!actual.restart_required);
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        before
    );
    let public = serde_json::to_string(&actual).unwrap();
    assert!(!public.contains("settings.json") && !public.contains("preserve"));
    assert!(!f.profile.join("integrations").exists());
}

#[test]
fn explicit_setup_changes_one_switch_and_keeps_old_connection_other_features_and_comments() {
    for feature in [
        KnowledgeSettingsFeature::MemoryCenter,
        KnowledgeSettingsFeature::SharedKnowledge,
        KnowledgeSettingsFeature::Subscriptions,
    ] {
        let f = fixture(None);
        let token = CancellationToken::new();
        let initial = read(&f.engine, &f.factory, &token).unwrap();
        let saved = save(
            &f.engine,
            &f.factory,
            params(feature, initial.revision.clone()),
            &token,
        )
        .unwrap();
        assert!(saved.restart_required);
        assert!(
            !saved.connection.memory_center_enabled
                && !saved.connection.publications_enabled
                && !saved.connection.business_automation_enabled
        );
        assert_eq!(
            saved.effective.memory_center_enabled,
            feature == KnowledgeSettingsFeature::MemoryCenter
        );
        assert_eq!(
            saved.effective.publications_enabled,
            feature == KnowledgeSettingsFeature::SharedKnowledge
        );
        assert_eq!(
            saved.effective.business_automation_enabled,
            feature == KnowledgeSettingsFeature::Subscriptions
        );
        let path = f.profile.join("settings.json");
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("// user comment retained")
        );
        let document = kcoder_config::read_settings_file(&path).unwrap();
        assert_eq!(document["providers"], json!({}));
        assert_eq!(document["studio_context"]["instructions"], "preserve");
        assert_eq!(
            document["integrations"]["knowledge"]["observer_candidates_enabled"],
            false
        );
        assert_eq!(
            document["integrations"]["knowledge"]["auxiliary_extraction_enabled"],
            false
        );
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(
            save(
                &f.engine,
                &f.factory,
                params(feature, initial.revision),
                &token
            )
            .unwrap_err()
            .to_string(),
            "KNOWLEDGE_SETTINGS_REVISION_CONFLICT"
        );
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn an_overlay_remains_authoritative_and_setup_does_not_overwrite_it() {
    let f = fixture(Some(false));
    let path = f.root.path().join("overlay.json");
    let before = std::fs::read(&path).unwrap();
    let token = CancellationToken::new();
    let initial = read(&f.engine, &f.factory, &token).unwrap();
    let saved = save(
        &f.engine,
        &f.factory,
        params(KnowledgeSettingsFeature::Subscriptions, initial.revision),
        &token,
    )
    .unwrap();
    assert_eq!(saved.persisted.business_automation_enabled, Some(true));
    assert!(!saved.effective.business_automation_enabled && !saved.restart_required);
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn cancelled_foreign_missing_and_empty_targets_are_not_repaired_or_overwritten() {
    let f = fixture(None);
    let token = CancellationToken::new();
    let initial = read(&f.engine, &f.factory, &token).unwrap();
    let path = f.profile.join("settings.json");
    let before = std::fs::read(&path).unwrap();
    token.cancel();
    assert_eq!(
        save(
            &f.engine,
            &f.factory,
            params(KnowledgeSettingsFeature::Subscriptions, initial.revision),
            &token
        )
        .unwrap_err()
        .to_string(),
        "KNOWLEDGE_SETTINGS_CANCELLED"
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let token = CancellationToken::new();
    let foreign = f
        .engine
        .clone()
        .with_settings_persistence_path(f.root.path().join("foreign.json"));
    assert_eq!(
        read(&foreign, &f.factory, &token).unwrap_err().to_string(),
        "KNOWLEDGE_SETTINGS_TARGET_CHANGED"
    );
    std::fs::remove_file(&path).unwrap();
    assert!(read(&f.engine, &f.factory, &token).is_err());
    assert!(!path.exists());
    std::fs::write(&path, "").unwrap();
    assert!(read(&f.engine, &f.factory, &token).is_err());
    assert!(std::fs::read(path).unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn linked_or_whitespace_configuration_cannot_be_adopted_as_feature_setup() {
    let f = fixture(None);
    let path = f.profile.join("settings.json");
    let original = f.profile.join("original.json");
    std::fs::rename(&path, &original).unwrap();
    std::os::unix::fs::symlink(&original, &path).unwrap();
    assert!(read(&f.engine, &f.factory, &CancellationToken::new()).is_err());
    std::fs::remove_file(&path).unwrap();
    std::fs::hard_link(&original, &path).unwrap();
    assert!(read(&f.engine, &f.factory, &CancellationToken::new()).is_err());
    std::fs::remove_file(&path).unwrap();
    std::fs::write(&path, " \n\t ").unwrap();
    assert!(read(&f.engine, &f.factory, &CancellationToken::new()).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), " \n\t ");
}

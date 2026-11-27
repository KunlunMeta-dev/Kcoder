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
fn fixture(overlay: Option<Value>) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_existing(root.path()).unwrap();
    parent.create_private_child(OsStr::new("profile")).unwrap();
    parent
        .create_private_child(OsStr::new("workspace"))
        .unwrap();
    let profile = root.path().join("profile");
    let cwd = root.path().join("workspace");
    let path = profile.join("settings.json");
    std::fs::write(&path,"{\n// user comment retained\n\"providers\":{},\"history_enabled\":false,\"studio_context\":{\"instructions\":\"preserve\"},\"integrations\":{\"connectivity\":{\"enabled\":false},\"services\":{\"enabled\":false},\"knowledge\":{\"observer_candidates_enabled\":false,\"auxiliary_extraction_enabled\":false}}\n}").unwrap();
    let mut cli = crate::Cli::parse_from(["kcoder"]);
    if let Some(value) = overlay {
        let path = root.path().join("overlay.json");
        std::fs::write(&path, value.to_string()).unwrap();
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
        Arc::new(kcoder_config::create_private_temp_dir("connectivity-settings-tests").unwrap());
    let services =
        kcoder_engine::WorkspaceRuntimeServices::new(&cwd, "connectivity-settings-tests")
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
fn params(enabled: bool, revision: String) -> ConnectivitySettingsSaveParams {
    ConnectivitySettingsSaveParams {
        enabled,
        expected_revision: revision,
    }
}
fn read_fixture(f: &Fixture) -> ConnectivitySettingsReadResult {
    read(&f.engine, &f.factory, &CancellationToken::new()).unwrap()
}
#[test]
fn connectivity_settings_disabled_read_creates_no_store_identity_or_configuration() {
    let f = fixture(None);
    let before = std::fs::read(f.profile.join("settings.json")).unwrap();
    let result = read_fixture(&f);
    assert_eq!(result.persisted.enabled, Some(false));
    assert_eq!(result.persisted.services_enabled, Some(false));
    assert!(!result.effective.enabled && !result.effective.services_enabled);
    assert_eq!(result.effective, result.connection);
    assert!(!result.restart_required && result.editable && !result.controlled_by_overlay);
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        before
    );
    assert!(!f.profile.join("integrations").exists());
    let public = serde_json::to_string(&result).unwrap();
    assert!(!public.contains("settings.json") && !public.contains("preserve"));
}
#[test]
fn connectivity_settings_enable_changes_only_selected_fields_and_new_connection_applies_them() {
    let f = fixture(None);
    let before = read_fixture(&f);
    let result = save(
        &f.engine,
        &f.factory,
        params(true, before.revision),
        &CancellationToken::new(),
    )
    .unwrap();
    assert!(result.effective.enabled && result.effective.services_enabled);
    assert!(!result.connection.enabled && !result.connection.services_enabled);
    assert!(result.restart_required);
    let source = std::fs::read_to_string(f.profile.join("settings.json")).unwrap();
    assert!(source.contains("user comment retained"));
    let document = kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap();
    assert_eq!(
        document["integrations"]["connectivity"],
        json!({"enabled":true})
    );
    assert_eq!(
        document["integrations"]["services"],
        json!({"enabled":true})
    );
    assert_eq!(
        document["integrations"]["knowledge"],
        json!({"observer_candidates_enabled":false,"auxiliary_extraction_enabled":false})
    );
    assert_eq!(document["studio_context"]["instructions"], "preserve");
    assert!(document["integrations"].get("core").is_none());
    assert!(!f.profile.join("integrations").exists());
    let current = f.factory.current_settings().unwrap();
    let cwd = f.root.path().join("workspace");
    let provider = Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
        crate::tui_dev_mock::TuiDevScenario::FullTurn,
    ));
    let new_connection = QueryEngine::try_new_for_client_with_services(
        provider,
        kcoder_state::AppState::new(&cwd),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&current),
        current,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        cwd.clone(),
        Some(true),
        kcoder_engine::WorkspaceRuntimeServices::new(&cwd, "connectivity-new-connection")
            .with_private_client_storage(Arc::new(
                kcoder_config::create_private_temp_dir("connectivity-new-connection").unwrap(),
            )),
    )
    .unwrap()
    .with_settings_persistence_path(f.profile.join("settings.json"));
    let observed = read(&new_connection, &f.factory, &CancellationToken::new()).unwrap();
    assert_eq!(observed.connection, observed.effective);
    assert!(!observed.restart_required);
    assert!(!f.profile.join("integrations").exists());
    let disabled = save(
        &f.engine,
        &f.factory,
        params(false, result.revision),
        &CancellationToken::new(),
    )
    .unwrap();
    assert!(!disabled.effective.enabled && disabled.effective.services_enabled);
    assert_eq!(disabled.persisted.services_enabled, Some(true));
}
#[test]
fn connectivity_settings_stale_revision_never_replays_or_clobbers_a_competing_change() {
    let f = fixture(None);
    let original = read_fixture(&f);
    let saved = save(
        &f.engine,
        &f.factory,
        params(true, original.revision.clone()),
        &CancellationToken::new(),
    )
    .unwrap();
    let before = std::fs::read(f.profile.join("settings.json")).unwrap();
    assert!(
        save(
            &f.engine,
            &f.factory,
            params(false, original.revision),
            &CancellationToken::new()
        )
        .unwrap_err()
        .to_string()
        .contains("REVISION_CONFLICT")
    );
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        before
    );
    assert_eq!(read_fixture(&f).revision, saved.revision);
}
#[test]
fn connectivity_settings_authoritative_overlays_are_read_only_without_materializing_them() {
    for overlay in [
        json!({"integrations":{"connectivity":{"enabled":true}}}),
        json!({"integrations":{"services":{"enabled":false}}}),
    ] {
        let f = fixture(Some(overlay));
        let result = read_fixture(&f);
        assert!(!result.editable && result.controlled_by_overlay);
        let before = std::fs::read(f.profile.join("settings.json")).unwrap();
        assert!(
            save(
                &f.engine,
                &f.factory,
                params(true, result.revision),
                &CancellationToken::new()
            )
            .unwrap_err()
            .to_string()
            .contains("CONTROLLED_BY_OVERLAY")
        );
        assert_eq!(
            std::fs::read(f.profile.join("settings.json")).unwrap(),
            before
        );
    }
    let f = fixture(Some(json!({"integrations":{"services":{"enabled":true}}})));
    let initial = read_fixture(&f);
    assert!(initial.editable && !initial.controlled_by_overlay);
    let saved = save(
        &f.engine,
        &f.factory,
        params(true, initial.revision),
        &CancellationToken::new(),
    )
    .unwrap();
    assert!(saved.effective.enabled && saved.effective.services_enabled);
    assert_eq!(saved.persisted.services_enabled, Some(false));
}
#[test]
fn connectivity_settings_source_fence_detects_a_new_or_changed_overlay_before_commit() {
    let f = fixture(None);
    let loaded = f.factory.connectivity_settings_sources().unwrap();
    let fence = SourceFence::capture(&loaded).unwrap();
    std::fs::create_dir_all(loaded.paths.project_settings.parent().unwrap()).unwrap();
    std::fs::write(
        &loaded.paths.project_settings,
        json!({"integrations":{"services":{"enabled":false}}}).to_string(),
    )
    .unwrap();
    assert!(
        fence
            .verify()
            .unwrap_err()
            .to_string()
            .contains("REVISION_CONFLICT")
    );
}
#[test]
fn connectivity_settings_cancelled_foreign_missing_and_linked_targets_fail_without_repair() {
    let f = fixture(None);
    let before = read_fixture(&f);
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(
        save(
            &f.engine,
            &f.factory,
            params(true, before.revision),
            &cancelled
        )
        .is_err()
    );
    let foreign = f.root.path().join("foreign.json");
    std::fs::write(&foreign, "{}").unwrap();
    let foreign_engine = f.engine.clone().with_settings_persistence_path(foreign);
    assert!(read(&foreign_engine, &f.factory, &CancellationToken::new()).is_err());
    std::fs::remove_file(f.profile.join("settings.json")).unwrap();
    assert!(read(&f.engine, &f.factory, &CancellationToken::new()).is_err());
    assert!(!f.profile.join("settings.json").exists());
}
#[tokio::test]
async fn connectivity_settings_rpc_requires_its_own_opt_in_but_no_enabled_domain_or_native_identity()
 {
    use crate::app_server::ConnectionState;
    let f = fixture(None);
    let mut state = ConnectionState::default();
    let response = state.initialize(json!(1), &json!({"protocolVersion":kcoder_app_protocol::PROTOCOL_VERSION,"clientInfo":{"name":"connectivity-settings-test","version":"1"},"capabilities":{"experimental":{"connectivitySettingsV1":true}}}), &f.engine);
    assert!(response.get("error").is_none(), "{response}");
    assert_eq!(
        response["result"]["capabilities"]["experimental"]["connectivitySettingsV1"],
        true
    );
    assert!(state.integration_context.is_none());
    assert!(!f.profile.join("integrations").exists());
    let (out, mut received) = tokio::sync::mpsc::channel(8);
    assert!(
        dispatch(
            CONNECTIVITY_SETTINGS_READ,
            &json!(2),
            &json!({}),
            &f.engine,
            &f.factory,
            &out,
            &mut state
        )
        .await
        .unwrap()
    );
    let result = received.recv().await.unwrap();
    assert_eq!(result["result"]["effective"]["enabled"], false);
    dispatch(
        CONNECTIVITY_SETTINGS_SAVE,
        &json!(4),
        &json!({"enabled":true,"expectedRevision":result["result"]["revision"]}),
        &f.engine,
        &f.factory,
        &out,
        &mut state,
    )
    .await
    .unwrap();
    let saved = received.recv().await.unwrap();
    assert_eq!(saved["result"]["effective"]["enabled"], true);
    assert_eq!(saved["result"]["effective"]["servicesEnabled"], true);
    assert_eq!(saved["result"]["connection"]["enabled"], false);
    assert!(state.integration_context.is_none());
    assert!(!f.profile.join("integrations").exists());
    let mut legacy = ConnectionState::default();
    dispatch(
        CONNECTIVITY_SETTINGS_READ,
        &json!(3),
        &json!({}),
        &f.engine,
        &f.factory,
        &out,
        &mut legacy,
    )
    .await
    .unwrap();
    assert!(received.recv().await.unwrap().get("error").is_some());
}

#[cfg(unix)]
#[test]
fn connectivity_settings_linked_and_blank_files_are_not_adopted() {
    use std::os::unix::fs::symlink;
    for hard in [true, false] {
        let f = fixture(None);
        let target = f.profile.join("settings.json");
        let foreign = f.root.path().join("foreign.json");
        std::fs::write(&foreign, "{}").unwrap();
        std::fs::remove_file(&target).unwrap();
        if hard {
            std::fs::hard_link(&foreign, &target).unwrap();
        } else {
            symlink(&foreign, &target).unwrap();
        }
        assert!(read(&f.engine, &f.factory, &CancellationToken::new()).is_err());
        assert_eq!(std::fs::read_to_string(&foreign).unwrap(), "{}");
    }
    let f = fixture(None);
    std::fs::write(f.profile.join("settings.json"), "   \n").unwrap();
    assert!(read(&f.engine, &f.factory, &CancellationToken::new()).is_err());
}

#[cfg(unix)]
#[test]
fn connectivity_settings_source_fence_rejects_fifo_without_waiting_for_a_writer() {
    use std::os::unix::ffi::OsStrExt;
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("overlay.json");
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    // SAFETY: the test owns the temporary path and the CString is NUL terminated.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(SourceFence::digest(&path).is_err());
}

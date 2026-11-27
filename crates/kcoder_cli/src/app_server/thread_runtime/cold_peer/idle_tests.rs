use super::*;

#[tokio::test]
async fn actual_cold_restore_reservation_blocks_idle_before_a_runtime_exists() {
    let workspace = tempfile::tempdir().unwrap();
    let settings = crate::test_fixtures::settings_with_default_provider();
    let engine = QueryEngine::try_new_for_client_with_services(
        Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
            crate::tui_dev_mock::TuiDevScenario::FullTurn,
        )),
        kcoder_state::AppState::new(workspace.path()),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        workspace.path().to_owned(),
        Some(true),
        kcoder_engine::WorkspaceRuntimeServices::new(workspace.path(), "cold-idle-handoff"),
    )
    .unwrap();
    let mut manager = ThreadManager::with_resident_limit(2);
    assert!(
        manager
            .reserve_cold_peer("original-cold-target")
            .unwrap()
            .is_none()
    );
    assert!(manager.runtimes.is_empty());
    assert!(
        matches!(
            manager.try_reserve_workspace_idle_with_reason(&engine),
            Err("peer_cold_restore")
        ),
        "the actual reserved restore must keep its host alive before runtime insertion"
    );
    manager.release_cold_peer("original-cold-target");
    assert!(
        manager
            .try_reserve_workspace_idle_with_reason(&engine)
            .is_ok()
    );
}

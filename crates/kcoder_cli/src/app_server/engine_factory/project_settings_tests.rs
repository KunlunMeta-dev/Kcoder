use super::tests::configured_factory;
use kcoder_migration::{
    batch::{BatchResolution, settings::SettingsGroupPlan},
    mcp::{McpResolution, McpTarget},
    providers::{ModelLimits, ProviderResolution, ProviderTarget},
    source_transfer::ReceivedProjectTarget,
};
use serde_json::{Value, json};

#[tokio::test]
async fn project_import_is_consumed_by_real_session_configuration_and_preserves_user_defaults_and_catalog()
 {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let cwd = root.path().join("workspace");
    kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
    std::fs::create_dir(&cwd).unwrap();
    let original=json!({"active_provider":"User","providers":{"User":{"api_format":"openai_chat_completions","endpoint":"https://user.invalid/v1","authentication":{"mode":"none"},"default_model":"user-model","context_window_tokens":128000,"output_headroom_tokens":8192,"max_output_tokens":8192}},"mcp_servers":[]}).to_string();
    let path = profile.join("settings.json");
    std::fs::write(&path, &original).unwrap();
    std::fs::write(
        profile.join("trusted-folders.json"),
        json!({"trusted":[cwd],"never":[]}).to_string(),
    )
    .unwrap();
    let factory = configured_factory(&cwd, &profile, &path, None);
    let mapping = ReceivedProjectTarget::capture(&profile, &cwd).unwrap();
    let provider = ProviderTarget::open_project(&profile, &mapping, true).unwrap();
    let mcp = McpTarget::open_project(&profile, &mapping, true).unwrap();
    let inventory=kcoder_migration::parse_claude_settings(r#"{"model":"source-model","env":{"ANTHROPIC_BASE_URL":"https://source.invalid"},"mcpServers":{"docs":{"command":"NEVER_EXECUTE_PROJECT_SOURCE","args":[]}}}"#).unwrap();
    let items = inventory
        .items
        .iter()
        .filter_map(|item| {
            if item.provider.is_some() {
                Some((
                    item.clone(),
                    BatchResolution::Provider(ProviderResolution {
                        item_id: item.preview.id.clone(),
                        target_name: "ProjectImported".into(),
                        endpoint: None,
                        model: None,
                        limits: Some(ModelLimits {
                            context_window_tokens: 128000,
                            output_headroom_tokens: 8192,
                            max_output_tokens: 8192,
                        }),
                    }),
                ))
            } else if item.mcp.is_some() {
                Some((
                    item.clone(),
                    BatchResolution::Mcp(McpResolution {
                        item_id: item.preview.id.clone(),
                        target_name: "project-docs".into(),
                        cwd: None,
                        enable_after_import: false,
                    }),
                ))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    let plan = SettingsGroupPlan::prepare(&provider, &mcp, &items).unwrap();
    plan.publish(&provider, &mcp, false, false, false).unwrap();
    let effective = factory.current_settings().unwrap();
    assert_eq!(effective.active_provider.as_deref(), Some("User"));
    assert_eq!(effective.model, "user-model");
    assert_eq!(effective.providers.len(), 2);
    assert!(effective.providers.contains_key("User"));
    assert!(effective.providers.contains_key("ProjectImported"));
    assert!(!effective.providers.contains_key("kunlunmeta"));
    assert_eq!(effective.mcp_servers.len(), 1);
    assert_eq!(effective.mcp_servers[0].name, "project-docs");
    assert!(!effective.mcp_server_enabled("project-docs"));
    assert_eq!(
        factory
            .migration_project_settings_path(&["providers", "mcp_servers", "mcp_disabled_servers"])
            .unwrap(),
        cwd.join(".kcoder/settings.json")
    );
    assert!(factory.migration_user_settings_path().is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    let raw: Value =
        serde_json::from_slice(&std::fs::read(cwd.join(".kcoder/settings.json")).unwrap()).unwrap();
    assert!(raw["providers"].get("User").is_none());
    assert!(raw.get("active_provider").is_none());
    let local = cwd.join(".kcoder/settings.local.json");
    std::fs::write(
        &local,
        json!({"providers":{"ProjectImported":{"max_output_tokens":4096}}}).to_string(),
    )
    .unwrap();
    assert!(
        factory
            .migration_project_settings_path(&["providers"])
            .is_err()
    );
    std::fs::remove_file(local).unwrap();
    plan.rollback(&provider, &mcp).unwrap();
    let restored = factory.current_settings().unwrap();
    assert_eq!(restored.providers.len(), 1);
    assert_eq!(restored.active_provider.as_deref(), Some("User"));
    assert!(restored.mcp_servers.is_empty());
    assert_eq!(std::fs::read_to_string(path).unwrap(), original);
}

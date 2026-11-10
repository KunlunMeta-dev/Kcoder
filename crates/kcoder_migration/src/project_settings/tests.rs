use super::*;
use crate::{
    mcp::{McpResolution, McpTarget},
    providers::{ModelLimits, ProviderResolution, ProviderTarget},
};
use serde_json::json;
struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    project: PathBuf,
    binding: ReceivedProjectTarget,
    original: String,
}
fn fixture(settings: Value) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let project = root.path().join("workspace");
    kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
    std::fs::create_dir(&project).unwrap();
    let original = serde_json::to_string(&settings).unwrap();
    std::fs::write(profile.join("settings.json"), &original).unwrap();
    std::fs::write(
        profile.join("trusted-folders.json"),
        serde_json::to_vec(&json!({"trusted":[project],"never":[]})).unwrap(),
    )
    .unwrap();
    let binding = ReceivedProjectTarget::capture(&profile, &project).unwrap();
    Fixture {
        _root: root,
        profile,
        project,
        binding,
        original,
    }
}
fn user() -> Value {
    json!({"active_provider":"User","providers":{"User":{"api_format":"openai_chat_completions","endpoint":"https://user.invalid/v1","authentication":{"mode":"none"},"default_model":"user-model","context_window_tokens":128000,"output_headroom_tokens":8192,"max_output_tokens":8192}},"mcp_servers":[]})
}
fn inventory() -> crate::MigrationInventory {
    crate::parse_claude_settings(r#"{"model":"source-model","env":{"ANTHROPIC_BASE_URL":"https://source.invalid"},"mcpServers":{"docs":{"command":"NEVER_EXECUTE_PROJECT_SOURCE","args":[]}}}"#).unwrap()
}
fn provider_plan(target: &ProviderTarget) -> crate::providers::ProviderPlan {
    let inventory = inventory();
    let item = inventory
        .items
        .iter()
        .find(|item| item.provider.is_some())
        .unwrap();
    target
        .prepare(
            item,
            &ProviderResolution {
                item_id: item.preview.id.clone(),
                target_name: "ImportedProject".into(),
                endpoint: None,
                model: None,
                limits: Some(ModelLimits {
                    context_window_tokens: 128000,
                    output_headroom_tokens: 8192,
                    max_output_tokens: 8192,
                }),
            },
        )
        .unwrap()
}
#[test]
fn project_targets_preserve_user_catalog_defaults_and_undo_only_the_actual_workspace_settings() {
    let f = fixture(user());
    let provider = ProviderTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let mcp = McpTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let plan = provider_plan(&provider);
    assert!(plan.project);
    assert!(
        ProviderTarget::open(&f.profile)
            .unwrap()
            .check_binding(&plan)
            .is_err()
    );
    provider.publish(&plan, false, false).unwrap();
    let raw: Value =
        serde_json::from_slice(&std::fs::read(f.project.join(".kcoder/settings.json")).unwrap())
            .unwrap();
    assert_eq!(
        raw["providers"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        vec!["ImportedProject"]
    );
    assert!(raw.get("active_provider").is_none());
    let loaded = kcoder_config::SettingsLoader::new(&f.project)
        .with_config_dir(&f.profile)
        .load()
        .unwrap()
        .settings;
    assert_eq!(loaded.active_provider.as_deref(), Some("User"));
    assert_eq!(loaded.model, "user-model");
    assert_eq!(loaded.providers.len(), 2);
    assert!(loaded.providers.contains_key("User"));
    assert!(!loaded.providers.contains_key("kunlunmeta"));
    let inventory = inventory();
    let item = inventory
        .items
        .iter()
        .find(|item| item.mcp.is_some())
        .unwrap();
    let mp = mcp
        .prepare(
            item,
            &McpResolution {
                item_id: item.preview.id.clone(),
                target_name: "project-docs".into(),
                cwd: None,
                enable_after_import: false,
            },
        )
        .unwrap();
    let wrong_provider = ProviderTarget::open(&f.profile).unwrap();
    let mixed = crate::batch::settings::SettingsGroupPlan::prepare(
        &wrong_provider,
        &mcp,
        &[(
            item.clone(),
            crate::batch::BatchResolution::Mcp(McpResolution {
                item_id: item.preview.id.clone(),
                target_name: "wrong-target".into(),
                cwd: None,
                enable_after_import: false,
            }),
        )],
    );
    assert!(
        mixed.is_err(),
        "MCP-only groups cannot select a user writer with a project MCP target"
    );
    mcp.publish(&mp, false, false).unwrap();
    let loaded = kcoder_config::SettingsLoader::new(&f.project)
        .with_config_dir(&f.profile)
        .load()
        .unwrap()
        .settings;
    assert_eq!(loaded.mcp_servers.len(), 1);
    assert_eq!(loaded.mcp_servers[0].name, "project-docs");
    assert!(!loaded.mcp_server_enabled("project-docs"));
    assert!(provider.templates().is_err());
    drop(provider);
    drop(mcp);
    let provider = ProviderTarget::open_project(&f.profile, &f.binding, false).unwrap();
    let mcp = McpTarget::open_project(&f.profile, &f.binding, false).unwrap();
    mcp.rollback(&mp).unwrap();
    provider.rollback(&plan).unwrap();
    let loaded = kcoder_config::SettingsLoader::new(&f.project)
        .with_config_dir(&f.profile)
        .load()
        .unwrap()
        .settings;
    assert_eq!(loaded.providers.len(), 1);
    assert!(loaded.mcp_servers.is_empty());
    assert_eq!(
        std::fs::read_to_string(f.profile.join("settings.json")).unwrap(),
        f.original
    );
}
#[test]
fn first_project_provider_preserves_public_defaults_and_undo_restores_implicit_catalog() {
    let f = fixture(json!({"mcp_servers":[]}));
    let target = ProviderTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let original = kcoder_config::SettingsLoader::new(&f.project)
        .with_config_dir(&f.profile)
        .load()
        .unwrap()
        .settings;
    let plan = provider_plan(&target);
    assert!(plan.project_catalog.is_some());
    assert!(!f.project.join(".kcoder/settings.json").exists());
    target.publish(&plan, false, false).unwrap();
    let loaded = kcoder_config::SettingsLoader::new(&f.project)
        .with_config_dir(&f.profile)
        .load()
        .unwrap()
        .settings;
    for (name, provider) in &original.providers {
        assert_eq!(loaded.providers.get(name), Some(provider));
    }
    assert!(loaded.providers.contains_key("ImportedProject"));
    // A fresh profile ships no Provider and selects none, so the first
    // imported Provider may become the selection; nothing existing is replaced.
    assert_eq!(original.active_provider, None);
    assert_eq!(loaded.active_provider.as_deref(), Some("ImportedProject"));
    assert_eq!(loaded.model, "source-model");
    drop(target);
    let target = ProviderTarget::open_project(&f.profile, &f.binding, false).unwrap();
    target.publish(&plan, false, false).unwrap();
    target.rollback(&plan).unwrap();
    let settings: Value =
        serde_json::from_slice(&std::fs::read(f.project.join(".kcoder/settings.json")).unwrap())
            .unwrap();
    assert!(settings.get("providers").is_none());
    assert_eq!(
        kcoder_config::SettingsLoader::new(&f.project)
            .with_config_dir(&f.profile)
            .load()
            .unwrap()
            .settings
            .providers,
        original.providers
    );
    assert_eq!(
        std::fs::read_to_string(f.profile.join("settings.json")).unwrap(),
        f.original
    );
}

#[test]
fn project_mcp_cannot_hide_existing_user_mcp_definitions() {
    let inventory = inventory();
    let mut settings = user();
    settings["mcp_servers"] =
        json!([{"name":"user-docs","transport":"stdio","command":"NEVER_EXECUTE_USER_SOURCE"}]);
    let f = fixture(settings);
    let target = McpTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let item = inventory
        .items
        .iter()
        .find(|item| item.mcp.is_some())
        .unwrap();
    assert_eq!(
        target
            .prepare(
                item,
                &McpResolution {
                    item_id: item.preview.id.clone(),
                    target_name: "project-docs".into(),
                    cwd: None,
                    enable_after_import: false
                }
            )
            .err()
            .unwrap()
            .to_string(),
        "migration_project_mcp_catalog_preservation_required"
    );
    assert_eq!(
        std::fs::read_to_string(f.profile.join("settings.json")).unwrap(),
        f.original
    );
    assert!(!f.project.join(".kcoder/settings.json").exists());
}
#[test]
fn project_import_cannot_report_enabled_when_the_user_layer_keeps_the_server_denied() {
    let mut settings = user();
    settings["mcp_disabled_servers"] = json!(["project-docs"]);
    let f = fixture(settings);
    let mcp = McpTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let inventory = inventory();
    let item = inventory
        .items
        .iter()
        .find(|item| item.mcp.is_some())
        .unwrap();
    let error = mcp
        .prepare(
            item,
            &McpResolution {
                item_id: item.preview.id.clone(),
                target_name: "project-docs".into(),
                cwd: None,
                enable_after_import: true,
            },
        )
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "migration_project_mcp_activation_denied");
    assert_eq!(
        std::fs::read_to_string(f.profile.join("settings.json")).unwrap(),
        f.original
    );
    assert!(!f.project.join(".kcoder/settings.json").exists());
}

#[test]
fn revoked_trust_or_missing_born_settings_directory_never_repairs_or_redirects_to_user() {
    let f = fixture(user());
    let target = ProviderTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let plan = provider_plan(&target);
    std::fs::write(
        f.profile.join("trusted-folders.json"),
        serde_json::to_vec(&json!({"trusted":[],"never":[f.project]})).unwrap(),
    )
    .unwrap();
    assert!(target.publish(&plan, false, false).is_err());
    assert!(!f.project.join(".kcoder/settings.json").exists());
    let f = fixture(user());
    let target = ProviderTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let plan = provider_plan(&target);
    drop(target);
    std::fs::rename(
        f.project.join(".kcoder"),
        f.project.join("withheld-project-metadata"),
    )
    .unwrap();
    assert!(ProviderTarget::open_project(&f.profile, &f.binding, false).is_err());
    assert!(!f.project.join(".kcoder").exists());
    assert!(
        ProviderTarget::open(&f.profile)
            .unwrap()
            .check_binding(&plan)
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(f.profile.join("settings.json")).unwrap(),
        f.original
    );
}

#[test]
fn changed_user_catalog_cannot_be_replaced_by_a_stale_implicit_preservation_plan() {
    let f = fixture(json!({"mcp_servers":[]}));
    let target = ProviderTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let plan = provider_plan(&target);
    let changed = serde_json::to_string(&user()).unwrap();
    std::fs::write(f.profile.join("settings.json"), &changed).unwrap();
    assert!(target.publish(&plan, false, false).is_err());
    assert!(!f.project.join(".kcoder/settings.json").exists());
    assert_eq!(
        std::fs::read_to_string(f.profile.join("settings.json")).unwrap(),
        changed
    );
}

#[test]
fn raw_project_delta_cannot_move_an_explicit_selection() {
    // Fresh installations ship no implicit Provider to preserve.
    assert!(
        kcoder_config::validate_and_resolve_settings_document(
            &kcoder_config::default_settings_document(),
        )
        .unwrap()
        .providers
        .is_empty()
    );
    let f = fixture(user());
    let _target = ProviderTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let directory = PrivateDirectory::open_existing(&f.project.join(".kcoder")).unwrap();
    let settings = kcoder_config::ProfileSettingsFile::new(directory).unwrap();
    let other = json!({"api_format":"openai_chat_completions","endpoint":"https://other.invalid/v1","authentication":{"mode":"none"},"default_model":"other-model","context_window_tokens":128000,"output_headroom_tokens":8192,"max_output_tokens":8192});
    // Adding a Provider next to an explicit selection keeps that selection.
    settings
        .validate_project_change(
            &f.profile,
            &f.project,
            &json!({}),
            &json!({"providers":{"Other":other}}),
        )
        .unwrap();
    // A project document cannot select a Provider itself.
    assert!(
        settings
            .validate_project_change(
                &f.profile,
                &f.project,
                &json!({}),
                &json!({"providers":{"Other":other},"active_provider":"Other"}),
            )
            .is_err()
    );
    assert!(!f.project.join(".kcoder/settings.json").exists());
}

#[test]
fn grouped_provider_catalog_plan_round_trips_and_removes_only_its_explicit_materialization() {
    use crate::batch::{BatchResolution, settings::SettingsGroupPlan};
    let f = fixture(json!({"mcp_servers":[]}));
    let provider = ProviderTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let mcp = McpTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let inventory = inventory();
    let item = inventory
        .items
        .iter()
        .find(|item| item.provider.is_some())
        .unwrap();
    let mut second = item.clone();
    second.preview.id = "second-provider".into();
    let rows = [(item.clone(), "ProjectOne"), (second, "ProjectTwo")]
        .into_iter()
        .map(|(item, name)| {
            let resolution = BatchResolution::Provider(ProviderResolution {
                item_id: item.preview.id.clone(),
                target_name: name.into(),
                endpoint: None,
                model: None,
                limits: Some(ModelLimits {
                    context_window_tokens: 128000,
                    output_headroom_tokens: 8192,
                    max_output_tokens: 8192,
                }),
            });
            (item, resolution)
        })
        .collect::<Vec<_>>();
    let plan = SettingsGroupPlan::prepare(&provider, &mcp, &rows).unwrap();
    let serialized = serde_json::to_vec(&plan).unwrap();
    drop(provider);
    drop(mcp);
    let restored: SettingsGroupPlan = serde_json::from_slice(&serialized).unwrap();
    let provider = ProviderTarget::open_project(&f.profile, &f.binding, false).unwrap();
    let mcp = McpTarget::open_project(&f.profile, &f.binding, false).unwrap();
    restored
        .publish(&provider, &mcp, false, false, false)
        .unwrap();
    let loaded = kcoder_config::SettingsLoader::new(&f.project)
        .with_config_dir(&f.profile)
        .load()
        .unwrap()
        .settings;
    assert!(loaded.providers.contains_key("ProjectOne"));
    assert!(loaded.providers.contains_key("ProjectTwo"));
    let defaults = kcoder_config::validate_and_resolve_settings_document(
        &kcoder_config::default_settings_document(),
    )
    .unwrap();
    for (name, value) in defaults.providers {
        assert_eq!(loaded.providers.get(&name), Some(&value));
    }
    restored.rollback(&provider, &mcp).unwrap();
    assert!(provider.read_settings().unwrap().get("providers").is_none());
    assert_eq!(
        std::fs::read_to_string(f.profile.join("settings.json")).unwrap(),
        f.original
    );
}

use super::*;
use crate::providers::ProviderTarget;
use crate::source_transfer::ReceivedProjectTarget;
use serde_json::json;
use std::path::PathBuf;
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

const INHERITED_SECRET: &str = "SYNTHETIC_PROJECT_MCP_INHERITED_PRIVATE_VALUE";
fn inherited_user() -> Value {
    let mut value = user();
    value["mcp_servers"] = json!([
        {"name":"user-docs","command":"NEVER_RUN_INHERITED_USER","env":{"TOKEN":INHERITED_SECRET}},
        {"name":"user-omitted","command":"NEVER_RUN_OMITTED_USER"}
    ]);
    value
}
#[test]
fn project_catalog_preview_does_not_create_project_configuration_or_copy_private_values() {
    let f = fixture(inherited_user());
    let preview = McpTarget::preview_project_mcp_catalog(&f.profile, &f.binding).unwrap();
    assert_eq!(preview.names, ["user-docs", "user-omitted"]);
    assert!(
        !serde_json::to_string(&preview)
            .unwrap()
            .contains(INHERITED_SECRET)
    );
    assert!(!f.project.join(".kcoder").exists());
    assert_eq!(
        std::fs::read_to_string(f.profile.join("settings.json")).unwrap(),
        f.original
    );
    let target = McpTarget::open_project(&f.profile, &f.binding, true).unwrap();
    target
        .with_project_mcp_catalog(preview.select(vec!["user-docs".into()]).unwrap())
        .unwrap();
}

#[test]
fn project_catalog_preview_rejects_existing_project_and_local_declarations() {
    for name in ["settings.json", "settings.local.json"] {
        let f = fixture(inherited_user());
        McpTarget::open_project(&f.profile, &f.binding, true).unwrap();
        std::fs::write(
            f.project.join(".kcoder").join(name),
            r#"{"mcp_servers":[]}"#,
        )
        .unwrap();
        let error = McpTarget::preview_project_mcp_catalog(&f.profile, &f.binding).unwrap_err();
        assert_eq!(
            error.to_string(),
            "migration_project_mcp_catalog_already_declared"
        );
    }
}

#[test]
fn project_catalog_preview_rechecks_current_trust() {
    let f = fixture(inherited_user());
    std::fs::write(
        f.profile.join("trusted-folders.json"),
        r#"{"trusted":[],"never":[]}"#,
    )
    .unwrap();
    assert_eq!(
        McpTarget::preview_project_mcp_catalog(&f.profile, &f.binding)
            .unwrap_err()
            .to_string(),
        "migration_project_target_untrusted"
    );
    assert!(!f.project.join(".kcoder").exists());
}
fn mcp_item() -> crate::NormalizedItem {
    inventory()
        .items
        .into_iter()
        .find(|item| item.mcp.is_some())
        .unwrap()
}
fn mcp_choice(item: &crate::NormalizedItem, name: &str) -> McpResolution {
    McpResolution {
        item_id: item.preview.id.clone(),
        target_name: name.into(),
        cwd: None,
        enable_after_import: false,
    }
}
fn project_document(f: &Fixture) -> Value {
    serde_json::from_slice(&std::fs::read(f.project.join(".kcoder/settings.json")).unwrap())
        .unwrap()
}
fn runtime_mcp(f: &Fixture) -> Vec<kcoder_types::McpServerConfig> {
    kcoder_config::SettingsLoader::new(&f.project)
        .with_config_dir(&f.profile)
        .load()
        .unwrap()
        .settings
        .mcp_servers
}
#[test]
fn project_mcp_explicit_name_selection_reopens_and_undo_restores_live_inheritance_without_copying_values()
 {
    let f = fixture(inherited_user());
    let item = mcp_item();
    let target = McpTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let preview = target.project_mcp_catalog().unwrap();
    assert_eq!(preview.names, ["user-docs", "user-omitted"]);
    assert!(
        !serde_json::to_string(&preview)
            .unwrap()
            .contains(INHERITED_SECRET)
    );
    let target = target
        .with_project_mcp_catalog(preview.select(vec!["user-docs".into()]).unwrap())
        .unwrap();
    let plan = target
        .prepare(&item, &mcp_choice(&item, "project-docs"))
        .unwrap();
    let saved = serde_json::to_vec(&plan).unwrap();
    assert!(!String::from_utf8_lossy(&saved).contains(INHERITED_SECRET));
    target.publish(&plan, false, false).unwrap();
    let raw = project_document(&f);
    assert_eq!(raw["mcp_inherited_servers"], json!(["user-docs"]));
    assert_eq!(raw["mcp_servers"].as_array().unwrap().len(), 1);
    assert!(!raw.to_string().contains(INHERITED_SECRET));
    let runtime = runtime_mcp(&f);
    assert_eq!(
        runtime.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        ["user-docs", "project-docs"]
    );
    assert_eq!(
        runtime[0].env.get("TOKEN").map(String::as_str),
        Some(INHERITED_SECRET)
    );
    assert_eq!(
        std::fs::read_to_string(f.profile.join("settings.json")).unwrap(),
        f.original
    );
    drop(target);
    let mut changed = inherited_user();
    changed["mcp_servers"][0]["env"]["TOKEN"] = "SYNTHETIC_USER_CHANGED_AFTER_PUBLICATION".into();
    changed["mcp_servers"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":"later-user","command":"NEVER_RUN_LATER_USER"}));
    let changed = serde_json::to_vec(&changed).unwrap();
    std::fs::write(f.profile.join("settings.json"), &changed).unwrap();
    let reopened = McpTarget::open_project(&f.profile, &f.binding, false).unwrap();
    let plan: crate::mcp::McpPlan = serde_json::from_slice(&saved).unwrap();
    assert!(
        !reopened
            .publish(&plan, false, false)
            .unwrap()
            .ownership_confirmed
    );
    reopened.rollback(&plan).unwrap();
    assert!(project_document(&f).get("mcp_inherited_servers").is_none());
    assert!(project_document(&f).get("mcp_servers").is_none());
    assert_eq!(
        runtime_mcp(&f)
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>(),
        ["user-docs", "user-omitted", "later-user"]
    );
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        changed
    );
}
#[test]
fn project_mcp_catalog_edits_before_publication_do_not_refresh_the_selected_snapshot() {
    let f = fixture(inherited_user());
    let item = mcp_item();
    let target = McpTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let preview = target.project_mcp_catalog().unwrap();
    let target = target
        .with_project_mcp_catalog(preview.select(preview.names.clone()).unwrap())
        .unwrap();
    let plan = target
        .prepare(&item, &mcp_choice(&item, "project-docs"))
        .unwrap();
    let mut changed = inherited_user();
    changed["mcp_servers"] = json!([]);
    let changed = serde_json::to_vec(&changed).unwrap();
    std::fs::write(f.profile.join("settings.json"), &changed).unwrap();
    assert_eq!(
        target
            .publish(&plan, false, false)
            .err()
            .unwrap()
            .to_string(),
        "migration_target_changed"
    );
    assert!(!f.project.join(".kcoder/settings.json").exists());
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        changed
    );
}
#[test]
fn project_mcp_user_removal_and_project_edits_are_not_replaced_by_an_old_catalog() {
    let f = fixture(inherited_user());
    let item = mcp_item();
    let target = McpTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let preview = target.project_mcp_catalog().unwrap();
    let target = target
        .with_project_mcp_catalog(preview.select(vec!["user-docs".into()]).unwrap())
        .unwrap();
    let plan = target
        .prepare(&item, &mcp_choice(&item, "project-docs"))
        .unwrap();
    target.publish(&plan, false, false).unwrap();
    let mut removed = inherited_user();
    removed["mcp_servers"] = json!([]);
    std::fs::write(
        f.profile.join("settings.json"),
        serde_json::to_vec(&removed).unwrap(),
    )
    .unwrap();
    assert_eq!(
        runtime_mcp(&f)
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>(),
        ["project-docs"]
    );
    let raw = project_document(&f);
    let mut changed = raw.clone();
    changed["mcp_servers"][0]["args"] = json!(["user-after-import"]);
    std::fs::write(
        f.project.join(".kcoder/settings.json"),
        serde_json::to_vec(&changed).unwrap(),
    )
    .unwrap();
    assert_eq!(
        target.rollback(&plan).unwrap_err().to_string(),
        "migration_target_changed"
    );
    assert_eq!(project_document(&f), changed);
    std::fs::write(
        f.project.join(".kcoder/settings.json"),
        serde_json::to_vec(&raw).unwrap(),
    )
    .unwrap();
    target.rollback(&plan).unwrap();
    assert!(runtime_mcp(&f).is_empty());
}
#[test]
fn project_mcp_empty_selection_is_explicit_and_name_collisions_require_a_new_choice() {
    let f = fixture(inherited_user());
    let item = mcp_item();
    let target = McpTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let preview = target.project_mcp_catalog().unwrap();
    let target = target
        .with_project_mcp_catalog(preview.select(vec!["user-docs".into()]).unwrap())
        .unwrap();
    assert_eq!(
        target
            .prepare(&item, &mcp_choice(&item, "user-docs"))
            .err()
            .unwrap()
            .to_string(),
        "migration_target_conflict"
    );
    let target = McpTarget::open_project(&f.profile, &f.binding, false).unwrap();
    let preview = target.project_mcp_catalog().unwrap();
    let target = target
        .with_project_mcp_catalog(preview.select(vec![]).unwrap())
        .unwrap();
    let plan = target
        .prepare(&item, &mcp_choice(&item, "project-docs"))
        .unwrap();
    target.publish(&plan, false, false).unwrap();
    assert_eq!(project_document(&f)["mcp_inherited_servers"], json!([]));
    assert_eq!(runtime_mcp(&f).len(), 1);
    target.rollback(&plan).unwrap();
    assert_eq!(runtime_mcp(&f).len(), 2);
}
#[test]
fn project_mcp_grouped_first_declaration_serializes_reopens_and_restores_the_original_null_directive()
 {
    use crate::batch::{BatchResolution, settings::SettingsGroupPlan};
    let f = fixture(inherited_user());
    let provider = ProviderTarget::open_project(&f.profile, &f.binding, true).unwrap();
    std::fs::write(
        f.project.join(".kcoder/settings.json"),
        r#"{"mcp_inherited_servers":null,"max_retries":7}"#,
    )
    .unwrap();
    let target = McpTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let preview = target.project_mcp_catalog().unwrap();
    let target = target
        .with_project_mcp_catalog(preview.select(vec!["user-docs".into()]).unwrap())
        .unwrap();
    let inventory = crate::parse_claude_settings(
        r#"{"mcpServers":{"docs":{"command":"NEVER_RUN_A"},"calc":{"command":"NEVER_RUN_B"}}}"#,
    )
    .unwrap();
    let items = inventory
        .items
        .into_iter()
        .filter(|item| item.mcp.is_some())
        .enumerate()
        .map(|(i, item)| {
            let resolution = BatchResolution::Mcp(mcp_choice(&item, &format!("project-{i}")));
            (item, resolution)
        })
        .collect::<Vec<_>>();
    let group = SettingsGroupPlan::prepare(&provider, &target, &items).unwrap();
    let saved = serde_json::to_vec(&group).unwrap();
    assert!(!String::from_utf8_lossy(&saved).contains(INHERITED_SECRET));
    assert!(
        group
            .publish(&provider, &target, false, false, false)
            .unwrap()
            .ownership_confirmed
    );
    assert_eq!(runtime_mcp(&f).len(), 3);
    drop(target);
    drop(provider);
    let provider = ProviderTarget::open_project(&f.profile, &f.binding, false).unwrap();
    let target = McpTarget::open_project(&f.profile, &f.binding, false).unwrap();
    let group: SettingsGroupPlan = serde_json::from_slice(&saved).unwrap();
    group.rollback(&provider, &target).unwrap();
    assert_eq!(
        project_document(&f),
        json!({"mcp_inherited_servers":null,"max_retries":7})
    );
    assert_eq!(runtime_mcp(&f).len(), 2);
}

#[test]
fn project_mcp_observation_keeps_a_later_user_denial_authoritative() {
    let f = fixture(inherited_user());
    let item = mcp_item();
    let target = McpTarget::open_project(&f.profile, &f.binding, true).unwrap();
    let preview = target.project_mcp_catalog().unwrap();
    let target = target
        .with_project_mcp_catalog(preview.select(vec!["user-docs".into()]).unwrap())
        .unwrap();
    let mut choice = mcp_choice(&item, "project-docs");
    choice.enable_after_import = true;
    let plan = target.prepare(&item, &choice).unwrap();
    target.publish(&plan, false, false).unwrap();
    assert_eq!(target.observe(&plan).unwrap(), Some(true));
    let mut updated = inherited_user();
    updated["mcp_disabled_servers"] = json!(["project-docs"]);
    std::fs::write(
        f.profile.join("settings.json"),
        serde_json::to_vec(&updated).unwrap(),
    )
    .unwrap();
    assert_eq!(target.observe(&plan).unwrap(), Some(false));
    target.rollback(&plan).unwrap();
    assert!(
        !kcoder_config::SettingsLoader::new(&f.project)
            .with_config_dir(&f.profile)
            .load()
            .unwrap()
            .settings
            .mcp_server_enabled("project-docs")
    );
}

#[test]
fn project_mcp_null_local_directive_is_not_a_runtime_override_but_a_local_catalog_still_is() {
    let f = fixture(inherited_user());
    let item = mcp_item();
    std::fs::create_dir(f.project.join(".kcoder")).unwrap();
    let local = f.project.join(".kcoder/settings.local.json");
    std::fs::write(&local, r#"{"mcp_inherited_servers":null}"#).unwrap();
    let target = McpTarget::open_project(&f.profile, &f.binding, false).unwrap();
    let preview = target.project_mcp_catalog().unwrap();
    let target = target
        .with_project_mcp_catalog(preview.select(vec!["user-docs".into()]).unwrap())
        .unwrap();
    let plan = target
        .prepare(&item, &mcp_choice(&item, "project-docs"))
        .unwrap();
    target.publish(&plan, false, false).unwrap();
    target.rollback(&plan).unwrap();
    std::fs::write(&local, r#"{"mcp_inherited_servers":null,"mcp_servers":[]}"#).unwrap();
    let target = McpTarget::open_project(&f.profile, &f.binding, false).unwrap();
    let preview = target.project_mcp_catalog().unwrap();
    let target = target
        .with_project_mcp_catalog(preview.select(vec![]).unwrap())
        .unwrap();
    assert_eq!(
        target
            .prepare(&item, &mcp_choice(&item, "project-docs"))
            .err()
            .unwrap()
            .to_string(),
        "migration_target_controlled_by_overlay"
    );
    assert!(project_document(&f).get("mcp_servers").is_none());
}

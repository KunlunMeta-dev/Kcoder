use kcoder_migration::{
    mcp::{McpResolution, McpTarget},
    parse_claude_settings, parse_codex_config,
    store::MigrationStore,
};
use kcoder_types::migration::{MigrationCategory, MigrationJobStatus};

#[test]
fn mcp_only_files_do_not_invent_provider_entries_and_private_literals_never_enter_the_inventory() {
    let source = r#"{"mcpServers":{"documents":{"command":"fixture-program","args":["--mode","read"],"env":{"ACCESS_TOKEN":"SYNTHETIC_PRIVATE_TOKEN"},"enabled_tools":["read"],"disabled_tools":["write"]}}}"#;
    let inventory = parse_claude_settings(source).unwrap();
    assert_eq!(inventory.items.len(), 1);
    assert_eq!(inventory.items[0].preview.category, MigrationCategory::Mcp);
    assert!(
        !serde_json::to_string(&inventory)
            .unwrap()
            .contains("SYNTHETIC_PRIVATE_TOKEN")
    );
    let root = tempfile::tempdir().unwrap();
    let store = MigrationStore::open_or_create(root.path()).unwrap();
    let target = McpTarget::open(root.path()).unwrap();
    let id = inventory.items[0].preview.id.clone();
    let job = store.create_scan("fixture", inventory).unwrap();
    let job = store
        .select(&job.job_id, job.sequence, std::slice::from_ref(&id))
        .unwrap();
    let resolution = McpResolution {
        item_id: id,
        target_name: "documents".into(),
        cwd: None,
        enable_after_import: false,
    };
    let staged = store
        .prepare_mcp(&job.job_id, job.sequence, &target, &resolution)
        .unwrap();
    let plan_id = staged.mcp_plans[0].id().to_owned();
    let completed = store
        .apply_mcp(&job.job_id, staged.sequence, &plan_id, &target)
        .unwrap();
    assert_eq!(completed.status, MigrationJobStatus::CompletedWithIssues);
    let settings = kcoder_config::read_settings_file(&root.path().join("settings.json")).unwrap();
    let config: kcoder_types::McpServerConfig =
        serde_json::from_value(settings["mcp_servers"][0].clone()).unwrap();
    assert_eq!(config.policy.required_env, vec!["ACCESS_TOKEN"]);
    assert!(!config.policy.allows("write"));
    assert!(config.policy.allows("read"));
    assert!(kcoder_mcp_policy::validate_references(&config).is_err());
    assert!(!settings.to_string().contains("SYNTHETIC_PRIVATE_TOKEN"));
    assert_eq!(
        settings["mcp_disabled_servers"],
        serde_json::json!(["documents"])
    );
}

#[test]
fn relative_working_directories_require_explicit_target_mapping_and_constraints_remain_intact() {
    let inventory=parse_codex_config("[mcp_servers.documents]\ncommand='fixture-program'\ncwd='relative-source-folder'\nargs=['--mode','read']\nenabled=false\nenabled_tools=[]\ndisabled_tools=['write']\nstartup_timeout_sec=20\ntool_timeout_sec=30\n").unwrap();
    let item = inventory
        .items
        .iter()
        .find(|item| item.mcp.is_some())
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let target = McpTarget::open(root.path()).unwrap();
    let mut resolution = McpResolution {
        item_id: item.preview.id.clone(),
        target_name: "documents".into(),
        cwd: None,
        enable_after_import: false,
    };
    assert!(target.prepare(item, &resolution).is_err());
    resolution.cwd = Some(root.path().to_str().unwrap().into());
    let plan = target.prepare(item, &resolution).unwrap();
    assert_eq!(plan.config().policy.enabled_tools, Some(vec![]));
    assert!(!plan.config().policy.allows("anything"));
    assert_eq!(plan.config().args, vec!["--mode", "read"]);
    assert_eq!(plan.config().policy.tool_timeout_secs, Some(30));
    assert!(!plan.item().mcp.as_ref().unwrap().enabled_in_source);
}

#[test]
fn permissions_and_authentication_helpers_cannot_be_silently_dropped() {
    let inventory=parse_claude_settings(r#"{"permissions":{"deny":["mcp__documents__write"]},"mcpServers":{"documents":{"command":"fixture-program"}}}"#).unwrap();
    let item = inventory
        .items
        .iter()
        .find(|item| item.mcp.is_some())
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let target = McpTarget::open(root.path()).unwrap();
    let resolution = McpResolution {
        item_id: item.preview.id.clone(),
        target_name: "documents".into(),
        cwd: None,
        enable_after_import: false,
    };
    assert!(target.prepare(item, &resolution).is_err());
    let inventory=parse_codex_config("[mcp_servers.documents]\nurl='https://example.invalid/mcp'\nhttp_headers_helper='never-run-helper'\n").unwrap();
    let item = inventory
        .items
        .iter()
        .find(|item| item.mcp.is_some())
        .unwrap();
    assert!(
        item.preview
            .issues
            .iter()
            .any(|issue| issue.blocks_import())
    );
    assert!(
        !serde_json::to_string(&inventory)
            .unwrap()
            .contains("never-run-helper")
    );
}

#[test]
fn project_mcp_definitions_retain_a_workspace_boundary_when_saved_in_the_target_profile() {
    use kcoder_migration::discovery::{DiscoveryRoots, SourceRegistry};
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let home = root.path().join("home");
    let profile = root.path().join("profile");
    for path in [&project, &home, &profile] {
        std::fs::create_dir(path).unwrap();
    }
    std::fs::write(
        project.join(".mcp.json"),
        r#"{"mcpServers":{"documents":{"command":"fixture-program"}}}"#,
    )
    .unwrap();
    let mut registry = SourceRegistry::new(DiscoveryRoots {
        home,
        project: Some(project.clone()),
        claude_config_dir: None,
        codex_home: None,
    });
    let sources = registry.discover(&[], true).0;
    let source = sources
        .iter()
        .find(|source| source.scope == "project-mcp")
        .unwrap();
    let binding = registry.selected(&source.source_id).unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let job = store.create_bound_scan(binding).unwrap();
    let id = job.inventory.items[0].preview.id.clone();
    let job = store
        .select(&job.job_id, job.sequence, std::slice::from_ref(&id))
        .unwrap();
    let target = McpTarget::open(&profile).unwrap();
    let staged = store
        .prepare_mcp(
            &job.job_id,
            job.sequence,
            &target,
            &McpResolution {
                item_id: id,
                target_name: "documents".into(),
                cwd: None,
                enable_after_import: false,
            },
        )
        .unwrap();
    assert_eq!(
        staged.mcp_plans[0].config().policy.workspace.as_deref(),
        Some(project.canonicalize().unwrap().to_str().unwrap())
    );
    assert!(kcoder_mcp_policy::validate_references(staged.mcp_plans[0].config()).is_err());
    store
        .apply_mcp(
            &job.job_id,
            staged.sequence,
            staged.mcp_plans[0].id(),
            &target,
        )
        .unwrap();
    let settings = kcoder_config::read_settings_file(&profile.join("settings.json")).unwrap();
    assert_eq!(
        settings["mcp_servers"][0]["policy"]["workspace"],
        project.to_str().unwrap()
    );
}

#[test]
fn names_that_collide_in_the_native_tool_namespace_are_rejected_before_publication() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("settings.json"),
        r#"{"mcp_servers":[{"name":"docs_server","command":"existing-fixture"}]}"#,
    )
    .unwrap();
    let inventory =
        parse_claude_settings(r#"{"mcpServers":{"documents":{"command":"new-fixture"}}}"#).unwrap();
    let target = McpTarget::open(root.path()).unwrap();
    let result = target.prepare(
        &inventory.items[0],
        &McpResolution {
            item_id: inventory.items[0].preview.id.clone(),
            target_name: "docs.server".into(),
            cwd: None,
            enable_after_import: false,
        },
    );
    assert_eq!(result.unwrap_err().to_string(), "migration_target_conflict");
    let current = kcoder_config::read_settings_file(&root.path().join("settings.json")).unwrap();
    assert_eq!(current["mcp_servers"].as_array().unwrap().len(), 1);
}

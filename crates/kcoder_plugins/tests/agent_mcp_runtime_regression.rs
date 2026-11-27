use kcoder_plugins::{PluginRegistry, PluginStore};
use serde_json::{Value, json};
use std::path::Path;

fn write_plugin(root: &Path, version: &str, mcp: Value) {
    std::fs::create_dir_all(root).unwrap();
    std::fs::write(
        root.join("plugin.json"),
        json!({
            "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            "name": "portable-runtime", "version": version,
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(root.join("mcp.json"), mcp.to_string()).unwrap();
}

fn mcp(servers: Value) -> Value {
    json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", "mcpServers":servers})
}

#[test]
fn portable_mcp_retains_valid_servers_and_reports_each_invalid_entry() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".kcoder/plugins/portable");
    write_plugin(
        &root,
        "1",
        mcp(json!({
            "valid": {"type":"stdio", "command":"fixture-never-executed", "args":["${PATH}","${PLUGIN_DATA}"], "env":{"LITERAL":"${HOME}"}},
            "missing-type": {"command":"fixture-never-executed"},
            "wrong-field": {"type":"stdio", "command":"fixture-never-executed", "url":"https://example.invalid/mcp"},
            "remote": {"type":"streamable-http", "url":"https://example.invalid/mcp", "headers":{"X-Literal":"${HOME}"}},
        })),
    );
    let store = PluginStore::open(&temp.path().join("store")).unwrap();
    let registry = PluginRegistry::discover_with_store(temp.path(), true, &store).unwrap();
    let plugin = registry
        .plugins()
        .iter()
        .find(|p| p.name == "portable-runtime")
        .unwrap();
    assert_eq!(plugin.mcp_configs.len(), 2);
    assert_eq!(
        plugin
            .diagnostics
            .iter()
            .filter(|d| d.code == "invalid_mcp_server")
            .count(),
        2
    );
    let local = plugin
        .mcp_configs
        .iter()
        .find(|p| p.transport == "stdio")
        .unwrap();
    assert_eq!(
        local.policy.cwd.as_deref(),
        dunce::canonicalize(&root).unwrap().to_str()
    );
    assert_eq!(local.args[0], "${PATH}");
    assert_eq!(local.env["LITERAL"], "${HOME}");
    assert_eq!(local.args[1], local.env["PLUGIN_DATA"]);
    assert!(Path::new(&local.env["PLUGIN_DATA"]).is_dir());
    let remote = plugin
        .mcp_configs
        .iter()
        .find(|p| p.transport == "http")
        .unwrap();
    assert_eq!(remote.headers["X-Literal"], "${HOME}");
    assert!(remote.env.is_empty());
}

#[test]
fn portable_mcp_requires_schema_without_disabling_skills() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".kcoder/plugins/portable");
    write_plugin(
        &root,
        "1",
        json!({"mcpServers":{"invalid":{"type":"stdio","command":"fixture-never-executed"}}}),
    );
    std::fs::create_dir_all(root.join("skills/demo")).unwrap();
    std::fs::write(
        root.join("skills/demo/SKILL.md"),
        "---\nname: demo\ndescription: fixture\n---\nFixture",
    )
    .unwrap();
    let store = PluginStore::open(&temp.path().join("store")).unwrap();
    let registry = PluginRegistry::discover_with_store(temp.path(), true, &store).unwrap();
    let snapshot = registry.effective_snapshot();
    assert!(snapshot.mcp_configs.is_empty());
    assert!(
        snapshot
            .skill_roots
            .iter()
            .any(|path| path.starts_with(&root))
    );
    assert!(
        snapshot
            .diagnostics
            .iter()
            .any(|d| d.code == "invalid_mcp_config")
    );
}

#[test]
fn managed_portable_plugin_data_survives_version_updates_and_is_bound_to_lease() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    let config = mcp(
        json!({"server":{"type":"stdio", "command":"fixture-never-executed", "env":{"CUSTOM_ROOT":"${PLUGIN_ROOT}/config"}}}),
    );
    write_plugin(&root, "1", config.clone());
    let store = PluginStore::open(&temp.path().join("store")).unwrap();
    let first = store.install_local(&root, "test").unwrap();
    let registry = PluginRegistry::discover_with_store(temp.path(), true, &store).unwrap();
    let snapshot = registry.effective_snapshot();
    let server = snapshot
        .mcp_configs
        .iter()
        .map(|server| &server.config)
        .find(|p| p.name == "plugin.portable-runtime@test.server")
        .unwrap();
    let data = Path::new(&server.env["PLUGIN_DATA"]);
    assert_eq!(data, store.data_root(&first.plugin_id).unwrap());
    std::fs::write(data.join("saved.txt"), "preserved").unwrap();
    assert!(!snapshot.version_leases[0].matches_root_environment(&server.env));
    let roots_only = server
        .env
        .iter()
        .filter(|(key, _)| matches!(key.as_str(), "PLUGIN_ROOT" | "PLUGIN_DATA"))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    assert!(snapshot.version_leases[0].matches_root_environment(&roots_only));
    let mut forged = roots_only;
    forged.insert("PLUGIN_DATA".into(), root.to_str().unwrap().into());
    assert!(!snapshot.version_leases[0].matches_root_environment(&forged));
    write_plugin(&root, "2", config);
    let second = store.install_local(&root, "test").unwrap();
    assert_ne!(first.root(store.root()), second.root(store.root()));
    let updated = PluginRegistry::discover_with_store(temp.path(), true, &store)
        .unwrap()
        .effective_snapshot();
    let next = updated
        .mcp_configs
        .iter()
        .map(|server| &server.config)
        .find(|p| p.name == server.name)
        .unwrap();
    assert_eq!(next.env["PLUGIN_DATA"], server.env["PLUGIN_DATA"]);
    assert_eq!(
        std::fs::read_to_string(data.join("saved.txt")).unwrap(),
        "preserved"
    );
    assert!(
        snapshot.version_leases[0].same_configuration_except_version_paths(
            server,
            &updated.version_leases[0],
            next
        )
    );
}

#[test]
fn disabled_portable_plugin_does_not_create_its_data_directory() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    write_plugin(
        &root,
        "1",
        mcp(json!({"server":{"type":"stdio", "command":"fixture-never-executed"}})),
    );
    let store = PluginStore::open(&temp.path().join("store")).unwrap();
    let installed = store.install_local(&root, "test").unwrap();
    let mut settings = kcoder_config::PluginsSettings::default();
    settings
        .installed
        .entry(installed.plugin_id.to_string())
        .or_default()
        .enabled = Some(false);
    let registry =
        PluginRegistry::discover_with_store_and_settings(temp.path(), true, &store, &settings)
            .unwrap();
    assert!(registry.effective_snapshot().mcp_configs.is_empty());
    assert!(!store.data_root(&installed.plugin_id).unwrap().exists());
}

#[cfg(unix)]
#[test]
fn unsafe_plugin_data_disables_local_processes_without_disabling_remote_servers() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    write_plugin(
        &root,
        "1",
        mcp(json!({
            "local":{"type":"stdio", "command":"fixture-never-executed"},
            "remote":{"type":"streamable-http", "url":"https://example.invalid/mcp"}
        })),
    );
    let store = PluginStore::open(&temp.path().join("store")).unwrap();
    let installed = store.install_local(&root, "test").unwrap();
    let data = store.data_root(&installed.plugin_id).unwrap();
    std::fs::create_dir_all(data.parent().unwrap()).unwrap();
    let outside = temp.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, &data).unwrap();
    let registry = PluginRegistry::discover_with_store(temp.path(), true, &store).unwrap();
    let snapshot = registry.effective_snapshot();
    assert_eq!(snapshot.mcp_configs.len(), 1);
    assert_eq!(snapshot.mcp_configs[0].config.transport, "http");
    assert!(snapshot.diagnostics.iter().any(|d| matches!(
        d.code.as_str(),
        "invalid_plugin_data" | "invalid_mcp_server"
    ) && d.message.contains("data")));
    assert_eq!(std::fs::read_dir(outside).unwrap().count(), 0);
}

#[test]
fn nonexistent_working_directory_is_diagnosed_without_publishing_a_broken_server() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".kcoder/plugins/portable");
    write_plugin(
        &root,
        "1",
        mcp(json!({
            "local":{"type":"stdio", "command":"fixture-never-executed", "cwd":"${PLUGIN_DATA}/state"},
            "remote":{"type":"streamable-http", "url":"https://example.invalid/mcp"}
        })),
    );
    let store = PluginStore::open(&temp.path().join("store")).unwrap();
    let snapshot = PluginRegistry::discover_with_store(temp.path(), true, &store)
        .unwrap()
        .effective_snapshot();
    assert_eq!(snapshot.mcp_configs.len(), 1);
    assert_eq!(snapshot.mcp_configs[0].config.transport, "http");
    assert!(
        snapshot
            .diagnostics
            .iter()
            .any(|d| d.code == "invalid_mcp_server" && d.message.contains("working directory"))
    );
}

#[test]
fn package_commands_must_name_real_regular_files() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".kcoder/plugins/portable");
    write_plugin(
        &root,
        "1",
        mcp(json!({
            "missing":{"type":"stdio", "command":"./missing"},
            "directory":{"type":"stdio", "command":"./directory"},
            "remote":{"type":"streamable-http", "url":"https://example.invalid/mcp"}
        })),
    );
    std::fs::create_dir(root.join("directory")).unwrap();
    let store = PluginStore::open(&temp.path().join("store")).unwrap();
    let snapshot = PluginRegistry::discover_with_store(temp.path(), true, &store)
        .unwrap()
        .effective_snapshot();
    assert_eq!(snapshot.mcp_configs.len(), 1);
    assert_eq!(snapshot.mcp_configs[0].config.transport, "http");
    assert_eq!(
        snapshot
            .diagnostics
            .iter()
            .filter(|d| d.code == "invalid_mcp_server")
            .count(),
        2
    );
}

#[test]
fn direct_hook_consumers_respect_installed_component_policy() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
    std::fs::write(root.join(".claude-plugin/plugin.json"), json!({
        "name":"hook-policy", "hooks":{"ConfigChange":[{"hooks":[{"type":"command", "command":"fixture-never-executed"}]}]}
    }).to_string()).unwrap();
    let store = PluginStore::open(&temp.path().join("store")).unwrap();
    let installed = store.install_local(&root, "test").unwrap();
    let enabled = PluginRegistry::discover_with_store(temp.path(), true, &store).unwrap();
    assert!(!enabled.hook_matchers().is_empty());
    let mut settings = kcoder_config::PluginsSettings::default();
    settings
        .installed
        .entry(installed.plugin_id.to_string())
        .or_default()
        .hooks
        .enabled = Some(false);
    let disabled =
        PluginRegistry::discover_with_store_and_settings(temp.path(), true, &store, &settings)
            .unwrap();
    assert!(!disabled.plugins()[0].hooks.is_empty());
    assert!(disabled.hook_matchers().is_empty());
    assert!(disabled.effective_snapshot().hook_matchers.is_empty());
}

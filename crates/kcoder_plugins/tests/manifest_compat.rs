use kcoder_plugins::{
    CompatibilityLevel, PluginAsset, PluginManifestFormat, PluginRegistry, PluginStore,
    load_plugin_manifest,
};
use std::path::{Path, PathBuf};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(
        std::env::var_os("KCODER_WORKSPACE_ROOT").expect("Cargo 应提供当前 KCoder 工作区根目录"),
    )
    .join("crates/kcoder_plugins/tests/fixtures/plugins")
    .join(name)
}

#[test]
fn claude_manifest_discovers_conventional_skills_and_preserves_https_logo() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("claude-plugin");
    std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
    std::fs::create_dir_all(root.join("skills/demo")).unwrap();
    std::fs::write(
        root.join(".claude-plugin/plugin.json"),
        r#"{
          "name": "conventional-demo",
          "interface": {
            "logo": "https://raw.githubusercontent.com/example/plugin/main/logo.svg"
          }
        }"#,
    )
    .unwrap();
    std::fs::write(
        root.join("skills/demo/SKILL.md"),
        "---\nname: demo\ndescription: demo\n---\n",
    )
    .unwrap();

    let loaded = load_plugin_manifest(&root).unwrap().unwrap();

    assert_eq!(loaded.manifest.contributions.skills.len(), 1);
    assert!(matches!(
        loaded
            .manifest
            .interface
            .as_ref()
            .and_then(|interface| interface.logo.as_ref()),
        Some(PluginAsset::RemoteUrl(url)) if url.starts_with("https://raw.githubusercontent.com/")
    ));
}

#[test]
fn loads_every_planned_manifest_format_through_one_public_boundary() {
    let cases = [
        ("kcoder-legacy", PluginManifestFormat::KcoderLegacy),
        ("agent-v1", PluginManifestFormat::AgentPluginsV1),
        ("codex", PluginManifestFormat::Codex),
        ("claude", PluginManifestFormat::Claude),
        ("cursor", PluginManifestFormat::Cursor),
    ];

    for (name, expected_format) in cases {
        let loaded = load_plugin_manifest(&fixture(name))
            .unwrap_or_else(|error| panic!("{name} fixture should load: {error:#}"))
            .unwrap_or_else(|| panic!("{name} fixture should contain a manifest"));
        assert_eq!(loaded.manifest.format, expected_format, "fixture {name}");
        assert!(!loaded.manifest.name.trim().is_empty(), "fixture {name}");
    }
}

#[test]
fn agent_plugin_reports_activated_and_deferred_contributions() {
    let loaded = load_plugin_manifest(&fixture("agent-v1"))
        .unwrap()
        .expect("agent fixture should load");

    assert_eq!(loaded.manifest.name, "agent-demo");
    assert_eq!(loaded.manifest.contributions.skills.len(), 1);
    assert!(loaded.manifest.contributions.mcp_servers.is_some());
    assert_eq!(loaded.manifest.contributions.hooks.len(), 1);
    assert!(loaded.manifest.contributions.apps.is_some());
    assert_eq!(
        loaded.compatibility.level,
        CompatibilityLevel::PartiallySupported
    );
    assert_eq!(
        loaded.compatibility.supported_capabilities,
        vec![
            "hooks".to_string(),
            "mcp_servers".to_string(),
            "skills".to_string()
        ]
    );
    assert_eq!(
        loaded.compatibility.deferred_capabilities,
        ["apps"].into_iter().map(str::to_string).collect::<Vec<_>>()
    );
}

#[test]
fn external_manifest_precedes_root_kcoder_legacy_manifest_and_reports_shadowing() {
    let loaded = load_plugin_manifest(&fixture("priority"))
        .unwrap()
        .expect("priority fixture should load");

    assert_eq!(loaded.manifest.format, PluginManifestFormat::Codex);
    assert_eq!(loaded.manifest.name, "codex-wins");
    assert_eq!(
        loaded
            .shadowed_manifest_paths
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        vec!["plugin.json"]
    );
}

#[test]
fn unsupported_agent_schema_fails_closed_and_surfaces_a_registry_diagnostic() {
    let root = fixture("unsupported-agent");
    let error = load_plugin_manifest(&root).unwrap_err();
    assert!(
        error.to_string().contains("unsupported plugin schema"),
        "unexpected error: {error:#}"
    );

    let temp = tempfile::tempdir().unwrap();
    let plugin_root = temp.path().join(".kcoder/plugins/unsupported-agent");
    copy_tree(&root, &plugin_root);
    let registry = discover_isolated(temp.path(), true);

    assert!(registry.plugins().is_empty());
    assert_eq!(registry.diagnostics().len(), 1);
    assert_eq!(registry.diagnostics()[0].code, "unsupported_schema");
}

#[test]
fn existing_kcoder_hook_plugin_still_exports_hooks_and_obeys_project_trust() {
    let temp = tempfile::tempdir().unwrap();
    let plugin_root = temp.path().join(".kcoder/plugins/kcoder-legacy");
    copy_tree(&fixture("kcoder-legacy"), &plugin_root);

    let trusted = discover_isolated(temp.path(), true);
    assert_eq!(trusted.plugins().len(), 1);
    assert_eq!(trusted.hook_matchers().len(), 1);
    assert_eq!(
        trusted.plugins()[0].compatibility.level,
        CompatibilityLevel::FullySupported
    );

    let untrusted = discover_isolated(temp.path(), false);
    assert!(untrusted.plugins().is_empty());
    assert!(untrusted.hook_matchers().is_empty());
}

#[test]
fn external_resource_paths_cannot_escape_the_plugin_root() {
    let temp = tempfile::tempdir().unwrap();
    let plugin_root = temp.path().join("escape");
    std::fs::create_dir_all(plugin_root.join(".codex-plugin")).unwrap();
    std::fs::write(
        plugin_root.join(".codex-plugin/plugin.json"),
        r#"{"name":"escape","skills":"./../outside"}"#,
    )
    .unwrap();

    let error = load_plugin_manifest(&plugin_root).unwrap_err();
    assert_eq!(error.diagnostic_code(), "unsafe_resource_path");
}

#[cfg(unix)]
#[test]
fn external_resource_paths_cannot_traverse_symlinks() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let outside = temp.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let plugin_root = temp.path().join("symlinked");
    std::fs::create_dir_all(plugin_root.join(".codex-plugin")).unwrap();
    symlink(&outside, plugin_root.join("skills")).unwrap();
    std::fs::write(
        plugin_root.join(".codex-plugin/plugin.json"),
        r#"{"name":"symlinked","skills":"./skills"}"#,
    )
    .unwrap();

    let error = load_plugin_manifest(&plugin_root).unwrap_err();
    assert_eq!(error.diagnostic_code(), "unsafe_resource_path");
}

#[test]
fn plugin_skill_roots_load_through_the_existing_skill_registry_boundary() {
    let temp = tempfile::tempdir().unwrap();
    let plugin_root = temp.path().join(".kcoder/plugins/agent-v1");
    copy_tree(&fixture("agent-v1"), &plugin_root);
    let plugins = discover_isolated(temp.path(), true);
    let snapshot = plugins.effective_snapshot();

    assert_eq!(snapshot.skill_roots.len(), 1);
    let skills = kcoder_skills::SkillRegistry::load_with_external_dirs_and_trust(
        temp.path(),
        snapshot.skill_roots.iter(),
        true,
    )
    .unwrap();
    assert!(skills.get("agent-demo-skill").is_some());
}

#[test]
fn plugin_mcp_declarations_convert_to_namespaced_kcoder_server_configs() {
    let temp = tempfile::tempdir().unwrap();
    let plugin_root = temp.path().join(".kcoder/plugins/agent-v1");
    copy_tree(&fixture("agent-v1"), &plugin_root);
    let plugins = discover_isolated(temp.path(), true);
    let snapshot = plugins.effective_snapshot();

    assert_eq!(snapshot.mcp_configs.len(), 1);
    let server = &snapshot.mcp_configs[0];
    assert_eq!(server.name, "plugin.agent-demo.fixture");
    assert_eq!(server.transport, "stdio");
    assert_eq!(server.command, "fixture-mcp");
    assert!(
        snapshot
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code != "invalid_mcp_config")
    );
}

#[test]
fn codex_command_hooks_convert_to_kcoder_runtime_matchers() {
    let temp = tempfile::tempdir().unwrap();
    let plugin_root = temp.path().join(".kcoder/plugins/agent-v1");
    copy_tree(&fixture("agent-v1"), &plugin_root);
    let plugins = discover_isolated(temp.path(), true);
    let snapshot = plugins.effective_snapshot();

    assert_eq!(snapshot.hook_matchers.len(), 1);
    assert_eq!(
        snapshot.hook_matchers[0].0,
        kcoder_hooks::HookEvent::SessionStart
    );
    assert_eq!(
        snapshot.hook_matchers[0].1.source.as_ref().unwrap().id,
        "agent-demo"
    );
    assert!(
        snapshot
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code != "unsupported_hook_action")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn external_plugin_root_variables_work_for_hooks_and_mcp() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let plugin_root = temp.path().join(".kcoder/plugins/root variables");
    std::fs::create_dir_all(plugin_root.join(".claude-plugin")).unwrap();
    std::fs::create_dir_all(plugin_root.join("hooks")).unwrap();
    std::fs::write(
        plugin_root.join(".claude-plugin/plugin.json"),
        r#"{"name":"root-variables"}"#,
    )
    .unwrap();
    std::fs::write(
        plugin_root.join("hooks/hooks.json"),
        r#"{
          "hooks": {
            "SessionStart": [{
              "hooks": [{
                "type": "command",
                "command": "test -f \"$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json\" && test \"$CLAUDE_PLUGIN_ROOT\" = \"$PLUGIN_ROOT\" && test \"$PLUGIN_ROOT\" = \"$CODEX_PLUGIN_ROOT\" && printf '%s' '{\"hookSpecificOutput\":{\"additionalContext\":\"root-ok\"}}'"
              }]
            }]
          }
        }"#,
    )
    .unwrap();
    std::fs::write(
        plugin_root.join(".mcp.json"),
        r#"{
          "mcpServers": {
            "fixture": {
              "command": "${CLAUDE_PLUGIN_ROOT}/mcp-server.sh",
              "args": ["${PLUGIN_ROOT}", "${CODEX_PLUGIN_ROOT}"]
            }
          }
        }"#,
    )
    .unwrap();
    let server = plugin_root.join("mcp-server.sh");
    std::fs::write(
        &server,
        r#"#!/bin/sh
test "$1" = "$2" || exit 9
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"root-fixture","version":"1"}}}'
      ;;
    *'"method":"tools/list"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"root_ok","description":"fixture","inputSchema":{"type":"object"}}]}}'
      ;;
  esac
done
"#,
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&server).unwrap().permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&server, permissions).unwrap();

    let plugins = discover_isolated(temp.path(), true);
    let snapshot = plugins.effective_snapshot();

    let hook_registry = kcoder_hooks::HookRegistry::from_matchers(snapshot.hook_matchers);
    let results = kcoder_hooks::execute_hooks(
        &hook_registry,
        kcoder_hooks::HookInput::new(
            kcoder_hooks::HookEvent::SessionStart,
            "startup",
            serde_json::json!({}),
        ),
    )
    .await;
    assert!(matches!(
        &results[0].outcome,
        kcoder_hooks::HookOutcome::Effects(effects)
            if effects.iter().any(|effect| matches!(
                effect,
                kcoder_hooks::HookEffect::AdditionalContext(value) if value == "root-ok"
            ))
    ));

    assert_eq!(snapshot.mcp_configs.len(), 1);
    let (handle, tools) = kcoder_mcp::connect_server(&snapshot.mcp_configs[0])
        .await
        .unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "root_ok");
    drop(handle);
}

#[test]
fn unsupported_external_hook_actions_are_reported_without_fake_activation() {
    let temp = tempfile::tempdir().unwrap();
    let plugin_root = temp.path().join(".kcoder/plugins/unsupported-hook");
    std::fs::create_dir_all(plugin_root.join(".codex-plugin")).unwrap();
    std::fs::write(
        plugin_root.join(".codex-plugin/plugin.json"),
        r#"{
          "name": "unsupported-hook",
          "hooks": {
            "PreToolUse": [
              {"hooks": [{"type": "mcp_tool", "server": "demo", "tool": "read"}]}
            ]
          }
        }"#,
    )
    .unwrap();

    let registry = discover_isolated(temp.path(), true);
    assert_eq!(registry.plugins().len(), 1);
    assert!(registry.hook_matchers().is_empty());
    assert_eq!(
        registry.plugins()[0].compatibility.level,
        CompatibilityLevel::MetadataOnly
    );
    assert!(
        registry
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.code == "unsupported_hook_action")
    );
}

#[test]
fn invalid_external_mcp_config_is_diagnostic_not_an_enabled_capability() {
    let temp = tempfile::tempdir().unwrap();
    let plugin_root = temp.path().join(".kcoder/plugins/invalid-mcp");
    std::fs::create_dir_all(plugin_root.join(".cursor-plugin")).unwrap();
    std::fs::write(
        plugin_root.join(".cursor-plugin/plugin.json"),
        r#"{
          "name": "invalid-mcp",
          "mcpServers": {"broken": {"type": "stdio"}}
        }"#,
    )
    .unwrap();

    let registry = discover_isolated(temp.path(), true);
    let snapshot = registry.effective_snapshot();
    assert_eq!(registry.plugins().len(), 1);
    assert!(snapshot.mcp_configs.is_empty());
    assert_eq!(
        registry.plugins()[0].compatibility.level,
        CompatibilityLevel::MetadataOnly
    );
    assert!(
        snapshot
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "invalid_mcp_config")
    );
}

#[tokio::test]
async fn adapted_command_hook_executes_through_the_public_hook_registry() {
    let temp = tempfile::tempdir().unwrap();
    let plugin_root = temp.path().join(".kcoder/plugins/agent-v1");
    copy_tree(&fixture("agent-v1"), &plugin_root);
    let plugins = discover_isolated(temp.path(), true);
    let snapshot = plugins.effective_snapshot();
    let registry = kcoder_hooks::HookRegistry::from_matchers(snapshot.hook_matchers);

    let results = kcoder_hooks::execute_hooks(
        &registry,
        kcoder_hooks::HookInput::new(
            kcoder_hooks::HookEvent::SessionStart,
            "startup",
            serde_json::json!({}),
        ),
    )
    .await;

    assert_eq!(results.len(), 1);
    assert!(matches!(
        &results[0].outcome,
        kcoder_hooks::HookOutcome::InvalidOutput(output) if output.contains("agent")
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn plugin_mcp_config_completes_real_initialize_and_tools_list_lifecycle() {
    let temp = tempfile::tempdir().unwrap();
    let plugin_root = temp.path().join(".kcoder/plugins/live-mcp");
    std::fs::create_dir_all(plugin_root.join(".cursor-plugin")).unwrap();
    let script = r#"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"fixture","version":"1"}}}'
      ;;
    *'"method":"tools/list"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"fixture_read","description":"fixture","inputSchema":{"type":"object"}}]}}'
      ;;
  esac
done
"#;
    std::fs::write(
        plugin_root.join(".cursor-plugin/plugin.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "name": "live-mcp",
            "mcpServers": {
                "fixture": {
                    "type": "stdio",
                    "command": "/bin/sh",
                    "args": ["-c", script]
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let plugins = discover_isolated(temp.path(), true);
    let snapshot = plugins.effective_snapshot();
    assert_eq!(snapshot.mcp_configs.len(), 1);
    let (handle, tools) = kcoder_mcp::connect_server(&snapshot.mcp_configs[0])
        .await
        .unwrap();

    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "fixture_read");
    drop(handle);
}

fn copy_tree(source: &Path, target: &Path) {
    std::fs::create_dir_all(target).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&source_path, &target_path);
        } else {
            std::fs::copy(source_path, target_path).unwrap();
        }
    }
}

fn discover_isolated(cwd: &Path, project_trusted: bool) -> PluginRegistry {
    let store = PluginStore::open(&cwd.join("test-plugin-store")).unwrap();
    PluginRegistry::discover_with_store(cwd, project_trusted, &store).unwrap()
}

#[tokio::test]
async fn external_bash_script_hook_keeps_plugin_root_expansion_and_quoted_paths() {
    // Requires Bash (Git Bash on Windows); no model or network calls are involved.
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".kcoder/plugins/ai plugins $literal");
    std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
    std::fs::create_dir_all(root.join("hooks")).unwrap();
    std::fs::write(
        root.join(".claude-plugin/plugin.json"),
        r#"{"name":"ai-plugins"}"#,
    )
    .unwrap();
    std::fs::write(
        root.join("hooks/hooks.json"),
        r#"{
      "hooks":{"UserPromptSubmit":[{"matcher":"","hooks":[{
        "type":"command","command":"bash \"${CLAUDE_PLUGIN_ROOT}/hooks/suggest-endor-tools.sh\""
      }]}]}
    }"#,
    )
    .unwrap();
    std::fs::write(
        root.join("hooks/suggest-endor-tools.sh"),
        r#"
test "$CLAUDE_PLUGIN_ROOT" = "$CODEX_PLUGIN_ROOT" || exit 9
test "$CLAUDE_PLUGIN_ROOT" = "$PLUGIN_ROOT" || exit 10
printf '%s' '{"hookSpecificOutput":{"additionalContext":"endor-hook-found"}}'
"#,
    )
    .unwrap();
    let snapshot = discover_isolated(temp.path(), true).effective_snapshot();
    assert_eq!(snapshot.hook_matchers.len(), 1);
    let registry = kcoder_hooks::HookRegistry::from_matchers(snapshot.hook_matchers);
    let results = kcoder_hooks::execute_hooks(
        &registry,
        kcoder_hooks::HookInput::new(
            kcoder_hooks::HookEvent::UserPromptSubmit,
            "hello",
            serde_json::json!({}),
        ),
    )
    .await;
    assert_eq!(results.len(), 1);
    assert!(
        matches!(&results[0].outcome, kcoder_hooks::HookOutcome::Effects(effects)
        if effects.iter().any(|effect| matches!(effect, kcoder_hooks::HookEffect::AdditionalContext(value) if value == "endor-hook-found"))),
        "{:?}",
        results[0].outcome
    );
    // Advisory hooks may successfully return no context for an unrelated prompt.
    std::fs::write(root.join("hooks/suggest-endor-tools.sh"), "exit 0\n").unwrap();
    let silent = kcoder_hooks::execute_hooks(
        &registry,
        kcoder_hooks::HookInput::new(
            kcoder_hooks::HookEvent::UserPromptSubmit,
            "",
            serde_json::json!("hello"),
        ),
    )
    .await;
    assert!(
        matches!(&silent[0].outcome, kcoder_hooks::HookOutcome::Effects(effects) if effects.is_empty()),
        "{:?}",
        silent[0].outcome
    );
    assert!(kcoder_hooks::first_blocking_error(&silent).is_none());
}

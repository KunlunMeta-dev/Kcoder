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

    let hook_registry = trusted_hook_registry(temp.path(), snapshot.hook_matchers);
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
    let registry = trusted_hook_registry(temp.path(), snapshot.hook_matchers);

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
    let registry = trusted_hook_registry(temp.path(), snapshot.hook_matchers);
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

#[test]
fn unsupported_external_agents_are_reported_instead_of_silently_ignored() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join(".claude-plugin")).unwrap();
    std::fs::write(
        root.path().join(".claude-plugin/plugin.json"),
        r#"{"name":"agent-only","agents":["./agents/reviewer.md"]}"#,
    )
    .unwrap();
    let loaded = kcoder_plugins::load_plugin_manifest(root.path())
        .unwrap()
        .unwrap();
    assert!(
        loaded
            .compatibility
            .deferred_capabilities
            .contains(&"agents".to_string())
    );
    assert!(loaded.compatibility.supported_capabilities.is_empty());
}

fn trusted_hook_registry(
    cwd: &Path,
    mut matchers: Vec<(kcoder_hooks::HookEvent, kcoder_hooks::HookMatcher)>,
) -> kcoder_hooks::HookRegistry {
    // Execution now rechecks consent instead of trusting the discovery boolean.
    // Keep that boundary active and grant consent only in this fixture's profile.
    let config = cwd.join("test-trust-profile");
    kcoder_config::FolderTrustStore::load(&config)
        .trust(cwd)
        .unwrap();
    for (_, matcher) in &mut matchers {
        if let Some(required) = matcher
            .source
            .as_mut()
            .and_then(|source| source.required_trust.as_mut())
        {
            required.config_dir = Some(config.clone());
        }
    }
    kcoder_hooks::HookRegistry::from_matchers(matchers)
}

#[test]
fn grok_manifest_loads_skills_and_can_be_disabled_independently() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join(".grok-plugin")).unwrap();
    std::fs::create_dir_all(temp.path().join("skills/demo")).unwrap();
    std::fs::write(
        temp.path().join(".grok-plugin/plugin.json"),
        r#"{"name":"grok-demo"}"#,
    )
    .unwrap();
    std::fs::write(
        temp.path().join("skills/demo/SKILL.md"),
        "---\nname: demo\ndescription: demo\n---\n",
    )
    .unwrap();
    let loaded = load_plugin_manifest(temp.path()).unwrap().unwrap();
    assert_eq!(loaded.manifest.format, PluginManifestFormat::Grok);
    assert_eq!(loaded.manifest.contributions.skills.len(), 1);
    let defaults: kcoder_config::PluginsSettings = serde_json::from_str("{}").unwrap();
    assert!(defaults.compatibility.grok);
    let disabled: kcoder_config::PluginsSettings =
        serde_json::from_str(r#"{"compatibility":{"grok":false}}"#).unwrap();
    assert!(!disabled.compatibility.grok);
    assert!(disabled.compatibility.claude);
}

#[test]
fn codebuddy_manifest_discovers_conventional_skills() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join(".codebuddy-plugin")).unwrap();
    std::fs::create_dir_all(temp.path().join("skills/demo")).unwrap();
    std::fs::write(
        temp.path().join(".codebuddy-plugin/plugin.json"),
        r#"{"name":"codebuddy-demo"}"#,
    )
    .unwrap();
    std::fs::write(
        temp.path().join("skills/demo/SKILL.md"),
        "---\nname: demo\ndescription: demo\n---\n",
    )
    .unwrap();
    let loaded = load_plugin_manifest(temp.path()).unwrap().unwrap();
    assert_eq!(loaded.manifest.format, PluginManifestFormat::Codebuddy);
    assert_eq!(loaded.manifest.contributions.skills.len(), 1);
}

#[test]
fn anchored_resource_paths_remain_inside_plugin_root() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join(".codebuddy-plugin")).unwrap();
    std::fs::create_dir_all(temp.path().join("hooks")).unwrap();
    std::fs::write(temp.path().join("hooks/hooks.json"), "{}").unwrap();
    let manifest = temp.path().join(".codebuddy-plugin/plugin.json");
    for value in [
        "hooks/hooks.json",
        "${CODEBUDDY_PLUGIN_ROOT}/hooks/hooks.json",
    ] {
        std::fs::write(
            &manifest,
            serde_json::json!({"name":"demo","hooks":value}).to_string(),
        )
        .unwrap();
        assert!(load_plugin_manifest(temp.path()).unwrap().is_some());
    }
    for value in ["${CODEBUDDY_PLUGIN_ROOT}/../outside", "${HOME}/hooks.json"] {
        std::fs::write(
            &manifest,
            serde_json::json!({"name":"demo","hooks":value}).to_string(),
        )
        .unwrap();
        assert!(load_plugin_manifest(temp.path()).is_err());
    }
}

#[test]
fn trae_manifest_loads_skills_and_mcp_without_claiming_host_connectors_or_binaries() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(temp.path().join(".trae-plugin")).unwrap();
    std::fs::create_dir_all(temp.path().join("skills/demo")).unwrap();
    std::fs::write(
        temp.path().join("skills/demo/SKILL.md"),
        "---\nname: demo\ndescription: Demo\n---\n",
    )
    .unwrap();
    std::fs::write(temp.path().join("service.json"), r#"{"mcpServers":{}}"#).unwrap();
    std::fs::write(temp.path().join("connector.json"), "{}").unwrap();
    std::fs::write(
        temp.path().join(".trae-plugin/plugin.json"),
        r#"{"name":"demo","mcp":"service.json","binaries":[{"name":"vendor-cli"}]}"#,
    )
    .unwrap();
    let loaded = load_plugin_manifest(temp.path()).unwrap().unwrap();
    assert_eq!(loaded.manifest.format, PluginManifestFormat::Trae);
    assert_eq!(loaded.manifest.contributions.skills.len(), 1);
    assert!(loaded.manifest.contributions.mcp_servers.is_some());
    assert!(
        loaded
            .compatibility
            .deferred_capabilities
            .iter()
            .any(|c| c == "connectors")
    );
    assert!(
        loaded
            .compatibility
            .deferred_capabilities
            .iter()
            .any(|c| c == "binaries")
    );
    assert_eq!(
        loaded.compatibility.level,
        CompatibilityLevel::PartiallySupported
    );
}

#[test]
fn hosted_manifest_selection_preserves_vendor_adapters_and_identity() {
    let temp = tempfile::TempDir::new().unwrap();
    for directory in [".claude-plugin", ".qoder-plugin"] {
        std::fs::create_dir(temp.path().join(directory)).unwrap();
    }
    std::fs::write(
        temp.path().join(".claude-plugin/plugin.json"),
        r#"{"name":"context7-plugin"}"#,
    )
    .unwrap();
    std::fs::write(temp.path().join(".qoder-plugin/plugin.json"), r#"{"name":"context7","version":"1.0.0","mcpServers":{"context7":{"command":"node","args":["server.js"]}}}"#).unwrap();
    assert_eq!(
        kcoder_plugins::load_plugin_manifest(temp.path())
            .unwrap()
            .unwrap()
            .manifest
            .name,
        "context7-plugin"
    );
    let selection = temp.path().join(".kcoder-marketplace-manifest");
    std::fs::write(&selection, ".qoder-plugin/plugin.json").unwrap();
    let loaded = kcoder_plugins::load_plugin_manifest(temp.path())
        .unwrap()
        .unwrap();
    assert_eq!(loaded.manifest.name, "context7");
    assert_eq!(
        loaded.manifest.format,
        kcoder_plugins::PluginManifestFormat::Qoder
    );
    assert!(
        loaded
            .compatibility
            .supported_capabilities
            .iter()
            .any(|c| c == "mcp_servers")
    );
    assert!(temp.path().join(".claude-plugin/plugin.json").is_file());
    for invalid in [
        "../plugin.json",
        "C:/plugin.json",
        ".trae-plugin/plugin.json",
    ] {
        std::fs::write(&selection, invalid).unwrap();
        assert!(kcoder_plugins::load_plugin_manifest(temp.path()).is_err());
    }
}

#[test]
fn bare_dotfile_and_relative_resources_load_across_external_formats() {
    for vendor in ["claude", "codex", "qoder", "trae", "codebuddy", "grok"] {
        for prefix in ["", "./"] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path();
            let manifest_dir = root.join(format!(".{vendor}-plugin"));
            std::fs::create_dir(&manifest_dir).unwrap();
            std::fs::create_dir_all(root.join("skills/demo")).unwrap();
            std::fs::write(
                root.join("skills/demo/SKILL.md"),
                "---\nname: demo\ndescription: Example\n---\nInstructions",
            )
            .unwrap();
            std::fs::write(root.join(".mcp.json"), r#"{"mcpServers":{}}"#).unwrap();
            std::fs::write(manifest_dir.join("plugin.json"), serde_json::json!({
                "name":"bare-paths", "skills":format!("{prefix}skills"), "mcpServers":format!("{prefix}.mcp.json")
            }).to_string()).unwrap();
            let loaded = load_plugin_manifest(root).unwrap().unwrap();
            let kcoder_plugins::PluginMcpDeclaration::Path(resource) =
                loaded.manifest.contributions.mcp_servers.unwrap()
            else {
                panic!("expected file MCP declaration")
            };
            assert_eq!(resource.relative_path, PathBuf::from(".mcp.json"));
            assert_eq!(resource.absolute_path, root.join(".mcp.json"));
            assert_eq!(
                loaded.manifest.contributions.skills[0].relative_path,
                PathBuf::from("skills")
            );
        }
    }
}

#[test]
fn accepting_bare_paths_does_not_allow_escape_urls_or_windows_streams() {
    for path in [
        "../.mcp.json",
        "./../.mcp.json",
        "/etc/file",
        "C:/file",
        "C:\\file",
        "\\\\host\\share",
        "file:stream",
        "https://example.com/file",
        "./hooks/../../file",
    ] {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join(".claude-plugin")).unwrap();
        std::fs::write(
            temp.path().join(".claude-plugin/plugin.json"),
            serde_json::json!({"name":"escape","mcpServers":path}).to_string(),
        )
        .unwrap();
        assert!(load_plugin_manifest(temp.path()).is_err(), "{path}");
    }
}

#[test]
fn named_command_maps_resolve_sources_without_losing_containment() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir(temp.path().join(".qoder-plugin")).unwrap();
    std::fs::create_dir(temp.path().join("commands")).unwrap();
    std::fs::write(
        temp.path().join("commands/deploy.md"),
        "---\ndescription: Deploy\n---\nDeploy using explicit tools.",
    )
    .unwrap();
    let path = temp.path().join(".qoder-plugin/plugin.json");
    std::fs::write(&path, serde_json::json!({"name":"mapped", "commands":{"deploy":{"source":"./commands/deploy.md","description":"Deploy"}}}).to_string()).unwrap();
    let loaded = load_plugin_manifest(temp.path()).unwrap().unwrap();
    assert_eq!(
        loaded.manifest.contributions.commands[0].relative_path,
        PathBuf::from("commands/deploy.md")
    );
    for source in ["../escape", "C:/escape"] {
        std::fs::write(
            &path,
            serde_json::json!({"name":"mapped", "commands":{"deploy":{"source":source}}})
                .to_string(),
        )
        .unwrap();
        assert!(load_plugin_manifest(temp.path()).is_err());
    }
}

#[test]
fn claude_marketplace_alias_keeps_source_manifest_and_managed_identity_separate() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("market");
    std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
    std::fs::create_dir_all(root.join("plugin/.claude-plugin")).unwrap();
    std::fs::write(
        root.join("plugin/.claude-plugin/plugin.json"),
        r#"{"name":"original","mcpServers":{"test":{"command":"node","args":["server.js"]}}}"#,
    )
    .unwrap();
    std::fs::write(
        root.join(".claude-plugin/marketplace.json"),
        r#"{"name":"aliases","plugins":[{"name":"publisher-original","source":"./plugin"}]}"#,
    )
    .unwrap();
    let manager =
        kcoder_plugins::PluginManager::open(&temp.path().join("profile/plugin_store")).unwrap();
    manager.marketplace_add("aliases", &root).unwrap();
    let record = manager
        .install_from_marketplace(temp.path(), true, "aliases", "publisher-original")
        .unwrap();
    assert_eq!(record.plugin_id.to_string(), "publisher-original@aliases");
    let loaded = load_plugin_manifest(&record.root(manager.store().root()))
        .unwrap()
        .unwrap();
    assert_eq!(loaded.manifest.name, "original");
    let plugin = manager
        .read(temp.path(), true, &record.plugin_id)
        .unwrap()
        .unwrap()
        .plugin;
    assert_eq!(plugin.id, "publisher-original@aliases");
    assert!(
        plugin
            .mcp_server_names
            .iter()
            .any(|name| name.starts_with("plugin.publisher-original@aliases."))
    );
    manager.uninstall(&record.plugin_id, true).unwrap();
}

#[test]
fn individually_declared_skill_directories_are_loaded_by_the_runtime() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".kcoder/plugins/design");
    std::fs::create_dir_all(root.join(".qoder-plugin")).unwrap();
    std::fs::create_dir_all(root.join("skills/frame")).unwrap();
    std::fs::write(
        root.join(".qoder-plugin/plugin.json"),
        r#"{"name":"design","skills":["./skills/frame"]}"#,
    )
    .unwrap();
    std::fs::write(
        root.join("skills/frame/SKILL.md"),
        "---\nname: 问题定义\ndescription: Define a design problem\n---\nInstructions",
    )
    .unwrap();
    let registry = discover_isolated(temp.path(), true);
    let snapshot = registry.effective_snapshot();
    let skills = kcoder_skills::SkillRegistry::load_with_external_dirs_and_trust(
        temp.path(),
        snapshot.skill_roots.iter(),
        true,
    )
    .unwrap();
    assert!(skills.get("问题定义").is_some());
}

#[test]
fn flat_skill_plugins_do_not_silently_install_as_metadata_only() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".kcoder/plugins/flat");
    std::fs::create_dir_all(root.join(".codebuddy-plugin")).unwrap();
    std::fs::write(
        root.join(".codebuddy-plugin/plugin.json"),
        r#"{"name":"flat","description":"One skill"}"#,
    )
    .unwrap();
    std::fs::write(
        root.join("SKILL.md"),
        "---\nname: flat-skill\ndescription: Flat root fixture\n---\nInstructions",
    )
    .unwrap();
    let loaded = load_plugin_manifest(&root).unwrap().unwrap();
    assert_eq!(
        loaded.manifest.contributions.skills[0].relative_path,
        PathBuf::from("SKILL.md")
    );
    let registry = discover_isolated(temp.path(), true);
    let snapshot = registry.effective_snapshot();
    let skills = kcoder_skills::SkillRegistry::load_with_external_dirs_and_trust(
        temp.path(),
        snapshot.skill_roots.iter(),
        true,
    )
    .unwrap();
    assert!(skills.get("flat-skill").is_some());
}

#[test]
fn marketplace_aliases_preserve_capitalized_manifest_names() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("market");
    std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
    std::fs::create_dir_all(root.join("plugin/.codex-plugin")).unwrap();
    std::fs::write(root.join("plugin/.codex-plugin/plugin.json"), r#"{"name":"Notion","mcpServers":{"notion":{"type":"http","url":"https://example.invalid/mcp"}}}"#).unwrap();
    std::fs::write(
        root.join(".claude-plugin/marketplace.json"),
        r#"{"name":"aliases","plugins":[{"name":"notion-dev","source":"./plugin"}]}"#,
    )
    .unwrap();
    let manager =
        kcoder_plugins::PluginManager::open(&temp.path().join("profile/plugin_store")).unwrap();
    manager.marketplace_add("aliases", &root).unwrap();
    let record = manager
        .install_from_marketplace(temp.path(), true, "aliases", "notion-dev")
        .unwrap();
    assert_eq!(record.plugin_id.to_string(), "notion-dev@aliases");
    assert_eq!(
        load_plugin_manifest(&record.root(manager.store().root()))
            .unwrap()
            .unwrap()
            .manifest
            .name,
        "Notion"
    );
    manager.uninstall(&record.plugin_id, true).unwrap();
}

#[test]
fn flat_skill_collections_are_discovered_but_explicit_empty_is_authoritative() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::fs::create_dir_all(root.join(".codebuddy-plugin")).unwrap();
    std::fs::create_dir_all(root.join("science")).unwrap();
    std::fs::write(
        root.join("science/SKILL.md"),
        "---\nname: science\ndescription: Test\n---\nTest",
    )
    .unwrap();
    let manifest = root.join(".codebuddy-plugin/plugin.json");
    std::fs::write(&manifest, r#"{"name":"bundle"}"#).unwrap();
    let loaded = load_plugin_manifest(root).unwrap().unwrap();
    assert_eq!(
        loaded.manifest.contributions.skills[0].relative_path,
        PathBuf::from("science/SKILL.md")
    );
    std::fs::write(&manifest, r#"{"name":"bundle","skills":[]}"#).unwrap();
    assert!(
        load_plugin_manifest(root)
            .unwrap()
            .unwrap()
            .manifest
            .contributions
            .skills
            .is_empty()
    );
}

#[test]
fn root_plugin_manifest_keeps_legacy_identity_and_loads_skills_and_mcp() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::fs::create_dir_all(root.join("skills/help")).unwrap();
    std::fs::write(
        root.join("skills/help/SKILL.md"),
        "---\nname: help\ndescription: Help\n---\nHelp",
    )
    .unwrap();
    std::fs::write(
        root.join("plugin.json"),
        r#"{"id":"root-id","name":"root","enabled":false,"skills":["./skills/"]}"#,
    )
    .unwrap();
    std::fs::write(
        root.join(".mcp.json"),
        r#"{"mcpServers":{"docs":{"command":"node","args":["server.js"]}}}"#,
    )
    .unwrap();
    let loaded = load_plugin_manifest(root).unwrap().unwrap();
    assert_eq!(loaded.manifest.id.as_deref(), Some("root-id"));
    assert!(!loaded.manifest.enabled_by_default);
    assert_eq!(loaded.manifest.contributions.skills.len(), 1);
    assert!(loaded.manifest.contributions.mcp_servers.is_some());
}

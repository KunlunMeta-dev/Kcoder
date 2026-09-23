use crate::manifest::{PluginManifestError, load_plugin_manifest};
use crate::model::{
    CompatibilityReport, PluginHookDeclaration, PluginManifest, PluginManifestFormat,
    PluginMcpDeclaration,
};
use crate::store::{InstalledPluginRecord, PluginStore, PluginVersionLease};
use anyhow::{Context, Result, bail};
use kcoder_config::{PluginPolicySettings, PluginProjectPolicy, PluginsSettings};
use kcoder_hooks::{HookEvent, HookMatcher, HookSource, HooksSettings};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::{debug, warn};

#[derive(Debug, Clone)]
pub struct LoadedPlugin {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub root: PathBuf,
    pub managed: bool,
    pub version_lease: Option<Arc<PluginVersionLease>>,
    pub required_trust_directory: Option<PathBuf>,
    pub enabled: bool,
    pub skills_enabled: bool,
    pub hooks_enabled: bool,
    pub mcp_enabled: bool,
    pub hooks: Vec<(HookEvent, HookMatcher)>,
    pub mcp_configs: Vec<kcoder_config::McpServerConfig>,
    pub mcp_tool_policies: BTreeMap<String, EffectiveMcpToolPolicy>,
    pub manifest: PluginManifest,
    pub compatibility: CompatibilityReport,
    pub selected_manifest_path: PathBuf,
    pub shadowed_manifest_paths: Vec<PathBuf>,
    pub diagnostics: Vec<PluginLoadDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PluginLoadDiagnostic {
    pub root: PathBuf,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct PluginMcpContribution {
    pub plugin_id: String,
    pub declaration: PluginMcpDeclaration,
}

#[derive(Debug, Clone, Default)]
pub struct EffectivePluginSnapshot {
    pub generation: u64,
    pub version_leases: Vec<Arc<PluginVersionLease>>,
    pub plugin_ids: Vec<String>,
    pub skill_roots: Vec<PathBuf>,
    pub skill_trust_roots: Vec<(PathBuf, PathBuf)>,
    pub mcp_servers: Vec<PluginMcpContribution>,
    pub mcp_configs: Vec<kcoder_config::McpServerConfig>,
    /// Provenance and policy in exactly the same order as `mcp_configs`.
    pub mcp_config_sources: Vec<EffectiveMcpContribution>,
    pub mcp_tool_policies: BTreeMap<String, EffectiveMcpToolPolicy>,
    pub hook_matchers: Vec<(HookEvent, HookMatcher)>,
    pub diagnostics: Vec<PluginLoadDiagnostic>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EffectiveMcpContribution {
    pub plugin_id: String,
    pub required_trust_directory: Option<PathBuf>,
    pub tool_policy: EffectiveMcpToolPolicy,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EffectiveMcpToolPolicy {
    pub enabled_tools: Vec<String>,
    pub disabled_tools: Vec<String>,
}

impl EffectiveMcpToolPolicy {
    pub fn allows(&self, tool_name: &str) -> bool {
        (self.enabled_tools.is_empty()
            || self
                .enabled_tools
                .iter()
                .any(|enabled| enabled == tool_name))
            && !self
                .disabled_tools
                .iter()
                .any(|disabled| disabled == tool_name)
    }
}

#[derive(Debug, Clone, Default)]
pub struct PluginRegistry {
    plugins: Vec<LoadedPlugin>,
    diagnostics: Vec<PluginLoadDiagnostic>,
    generation: u64,
}

impl PluginRegistry {
    pub fn discover(cwd: &Path) -> Result<Self> {
        Self::discover_with_trust(cwd, true)
    }

    /// Skip project plugins when the project directory is untrusted; always discover user-level plugins.
    pub fn discover_with_trust(cwd: &Path, project_trusted: bool) -> Result<Self> {
        let loaded = kcoder_config::Settings::load_for_cwd(cwd)?;
        Self::discover_with_trust_and_settings(cwd, project_trusted, &loaded.settings.plugins)
    }

    pub fn discover_with_trust_and_settings(
        cwd: &Path,
        project_trusted: bool,
        settings: &PluginsSettings,
    ) -> Result<Self> {
        let store = PluginStore::open_default()?;
        Self::discover_with_store_and_settings(cwd, project_trusted, &store, settings)
    }

    pub fn discover_with_store(
        cwd: &Path,
        project_trusted: bool,
        store: &PluginStore,
    ) -> Result<Self> {
        Self::discover_with_store_and_settings(
            cwd,
            project_trusted,
            store,
            &PluginsSettings::default(),
        )
    }

    pub fn discover_with_store_and_settings(
        cwd: &Path,
        project_trusted: bool,
        store: &PluginStore,
        settings: &PluginsSettings,
    ) -> Result<Self> {
        let mut plugins = Vec::new();
        let mut diagnostics = Vec::new();
        for (root, is_project_root) in plugin_search_roots(cwd) {
            if is_project_root
                && (!project_trusted
                    || settings.runtime.project_policy == PluginProjectPolicy::Disabled)
            {
                debug!(
                    "project plugin root skipped (folder not trusted): {}",
                    root.display()
                );
                continue;
            }
            if !root.is_dir() {
                continue;
            }
            for path in plugin_directories(&root)? {
                load_discovered_plugin(
                    &path,
                    None,
                    None,
                    is_project_root.then_some(cwd),
                    settings,
                    &mut plugins,
                    &mut diagnostics,
                );
            }
        }
        let (store_snapshot, version_leases) = store.snapshot_with_leases()?;
        let generation = store_snapshot.generation;
        let managed_records = if settings.runtime.enabled {
            store_snapshot.installed
        } else {
            Vec::new()
        };
        for (record, lease) in managed_records.into_iter().zip(version_leases) {
            let root = record.root(store.root());
            if !root.is_dir() {
                diagnostics.push(PluginLoadDiagnostic {
                    root,
                    code: "managed_plugin_missing".to_string(),
                    message: format!(
                        "managed plugin {} is missing from its active cache path",
                        record.plugin_id
                    ),
                });
                continue;
            }
            load_discovered_plugin(
                &root,
                Some(&record),
                Some(lease),
                None,
                settings,
                &mut plugins,
                &mut diagnostics,
            );
        }
        Ok(Self {
            plugins,
            diagnostics,
            generation,
        })
    }

    pub fn empty() -> Self {
        Self::default()
    }

    pub fn plugins(&self) -> &[LoadedPlugin] {
        &self.plugins
    }

    pub fn diagnostics(&self) -> &[PluginLoadDiagnostic] {
        &self.diagnostics
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn enabled_plugins(&self) -> impl Iterator<Item = &LoadedPlugin> {
        self.plugins.iter().filter(|plugin| plugin.enabled)
    }

    pub fn hook_matchers(&self) -> Vec<(HookEvent, HookMatcher)> {
        self.enabled_plugins()
            .flat_map(|plugin| plugin.hooks.clone())
            .collect()
    }

    pub fn effective_snapshot(&self) -> EffectivePluginSnapshot {
        let mut snapshot = EffectivePluginSnapshot {
            generation: self.generation,
            diagnostics: self.diagnostics.clone(),
            ..EffectivePluginSnapshot::default()
        };
        for plugin in self.enabled_plugins() {
            snapshot.plugin_ids.push(plugin.id.clone());
            snapshot
                .version_leases
                .extend(plugin.version_lease.iter().cloned());
            if plugin.skills_enabled {
                if let Some(directory) = &plugin.required_trust_directory {
                    snapshot.skill_trust_roots.extend(
                        plugin
                            .manifest
                            .contributions
                            .skills
                            .iter()
                            .map(|resource| (resource.absolute_path.clone(), directory.clone())),
                    );
                }
                snapshot.skill_roots.extend(
                    plugin
                        .manifest
                        .contributions
                        .skills
                        .iter()
                        .map(|resource| resource.absolute_path.clone()),
                );
            }
            if plugin.mcp_enabled
                && let Some(declaration) = &plugin.manifest.contributions.mcp_servers
            {
                snapshot.mcp_servers.push(PluginMcpContribution {
                    plugin_id: plugin.id.clone(),
                    declaration: declaration.clone(),
                });
            }
            if plugin.mcp_enabled {
                snapshot.mcp_configs.extend(plugin.mcp_configs.clone());
                snapshot
                    .mcp_config_sources
                    .extend(plugin.mcp_configs.iter().map(|config| {
                        EffectiveMcpContribution {
                            plugin_id: plugin.id.clone(),
                            required_trust_directory: plugin.required_trust_directory.clone(),
                            tool_policy: plugin
                                .mcp_tool_policies
                                .get(&config.name)
                                .cloned()
                                .unwrap_or_default(),
                        }
                    }));
                snapshot
                    .mcp_tool_policies
                    .extend(plugin.mcp_tool_policies.clone());
            }
            if plugin.hooks_enabled {
                snapshot.hook_matchers.extend(plugin.hooks.clone());
            }
        }
        snapshot
    }
}

fn plugin_directories(root: &Path) -> Result<Vec<PathBuf>> {
    let mut entries = std::fs::read_dir(root)
        .with_context(|| format!("failed to read plugin root {}", root.display()))?
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    Ok(entries
        .into_iter()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect())
}

fn load_discovered_plugin(
    path: &Path,
    managed: Option<&InstalledPluginRecord>,
    version_lease: Option<Arc<PluginVersionLease>>,
    required_trust: Option<&Path>,
    settings: &PluginsSettings,
    plugins: &mut Vec<LoadedPlugin>,
    diagnostics: &mut Vec<PluginLoadDiagnostic>,
) {
    match load_plugin(path) {
        Ok(Some(mut plugin)) => {
            plugin.version_lease = version_lease;
            if !manifest_format_enabled(plugin.manifest.format, settings) {
                plugin.enabled = false;
                diagnostics.push(PluginLoadDiagnostic {
                    root: path.to_path_buf(),
                    code: "plugin_format_disabled".to_string(),
                    message: format!(
                        "plugin format {:?} is disabled by compatibility policy",
                        plugin.manifest.format
                    ),
                });
            }
            if let Some(record) = managed {
                plugin.managed = true;
                plugin.id = record.plugin_id.to_string();
                let policy = settings.installed.get(&plugin.id);
                plugin.enabled = policy
                    .and_then(|policy| policy.enabled)
                    .unwrap_or(record.enabled_by_default)
                    && manifest_format_enabled(plugin.manifest.format, settings);
                for config in &mut plugin.mcp_configs {
                    let manifest_id = manifest_runtime_id(&plugin.manifest);
                    let managed_prefix = format!("plugin.{}.", record.plugin_id);
                    let manifest_prefix = format!("plugin.{manifest_id}.");
                    if let Some(server_name) = config.name.strip_prefix(&manifest_prefix) {
                        config.name = format!("{managed_prefix}{server_name}");
                    }
                }
                apply_contribution_policy(&mut plugin, policy);
                let mut source = HookSource::plugin(
                    record.plugin_id.to_string(),
                    plugin.manifest.name.clone(),
                    path,
                );
                source.runtime_guard = plugin
                    .version_lease
                    .as_ref()
                    .map(|lease| Arc::clone(lease) as Arc<dyn std::fmt::Debug + Send + Sync>);
                for (_, matcher) in &mut plugin.hooks {
                    matcher.source = Some(source.clone());
                }
            }
            plugin.required_trust_directory = required_trust.map(Path::to_path_buf);
            if let Some(directory) = required_trust {
                for (_, matcher) in &mut plugin.hooks {
                    if let Some(source) = matcher.source.take() {
                        matcher.source = Some(source.requiring_folder_trust(directory));
                    }
                }
            }
            diagnostics.extend(plugin.diagnostics.iter().cloned());
            plugins.push(plugin);
        }
        Ok(None) => {}
        Err(error) => {
            let code = error
                .downcast_ref::<PluginManifestError>()
                .map(PluginManifestError::diagnostic_code)
                .unwrap_or("plugin_load_failed");
            warn!("failed to load plugin {}: {error:#}", path.display());
            diagnostics.push(PluginLoadDiagnostic {
                root: path.to_path_buf(),
                code: code.to_string(),
                message: format!("{error:#}"),
            });
        }
    }
}

fn apply_contribution_policy(plugin: &mut LoadedPlugin, policy: Option<&PluginPolicySettings>) {
    let Some(policy) = policy else {
        return;
    };
    plugin.skills_enabled = policy.skills.enabled.unwrap_or(true);
    plugin.hooks_enabled = policy.hooks.enabled.unwrap_or(true);
    let prefix = format!("plugin.{}.", plugin.id);
    plugin.mcp_configs.retain(|config| {
        let Some(server_name) = config.name.strip_prefix(&prefix) else {
            return true;
        };
        let Some(server_policy) = policy.mcp_servers.get(server_name) else {
            return true;
        };
        if server_policy.enabled == Some(false) {
            return false;
        }
        if !server_policy.enabled_tools.is_empty() || !server_policy.disabled_tools.is_empty() {
            plugin.mcp_tool_policies.insert(
                config.name.clone(),
                EffectiveMcpToolPolicy {
                    enabled_tools: server_policy.enabled_tools.clone(),
                    disabled_tools: server_policy.disabled_tools.clone(),
                },
            );
        }
        true
    });
}

fn manifest_format_enabled(format: PluginManifestFormat, settings: &PluginsSettings) -> bool {
    match format {
        PluginManifestFormat::AgentPluginsV1 => settings.compatibility.agent_plugins_v1,
        PluginManifestFormat::Codex => settings.compatibility.codex,
        PluginManifestFormat::Claude => settings.compatibility.claude,
        PluginManifestFormat::Cursor => settings.compatibility.cursor,
        PluginManifestFormat::Kcoder | PluginManifestFormat::KcoderLegacy => true,
    }
}

fn manifest_runtime_id(manifest: &PluginManifest) -> String {
    manifest
        .id
        .clone()
        .unwrap_or_else(|| manifest.name.to_ascii_lowercase().replace(' ', "-"))
}

#[cfg(test)]
mod policy_tests {
    use super::*;

    fn agent_fixture() -> PathBuf {
        PathBuf::from(
            std::env::var_os("KCODER_WORKSPACE_ROOT")
                .expect("Cargo must provide the runtime workspace root"),
        )
        .join("crates")
        .join("kcoder_plugins")
        .join("tests")
        .join("fixtures")
        .join("plugins")
        .join("agent-v1")
    }

    #[test]
    fn snapshot_keeps_exact_mcp_plugin_ownership_and_respects_disabled_contributions() {
        let root = agent_fixture();
        let plugin = load_plugin(&root).unwrap().unwrap();
        let mut registry = PluginRegistry {
            plugins: vec![plugin],
            ..Default::default()
        };
        let snapshot = registry.effective_snapshot();
        assert_eq!(snapshot.mcp_config_sources[0].plugin_id, "agent-demo");
        registry.plugins[0].mcp_enabled = false;
        let disabled = registry.effective_snapshot();
        assert!(disabled.mcp_configs.is_empty());
        assert!(disabled.mcp_config_sources.is_empty());
    }

    #[test]
    fn same_server_name_keeps_each_plugin_contribution_identity() {
        let root = agent_fixture();
        let mut first = load_plugin(&root).unwrap().unwrap();
        first.mcp_configs[0].name = "plugin.agent-demo.fixture.more".into();
        let mut second = first.clone();
        second.id = "agent-demo.fixture".into();
        second.mcp_tool_policies.insert(
            second.mcp_configs[0].name.clone(),
            EffectiveMcpToolPolicy {
                disabled_tools: vec!["read".into()],
                ..Default::default()
            },
        );
        let registry = PluginRegistry {
            plugins: vec![first, second],
            ..Default::default()
        };
        let snapshot = registry.effective_snapshot();
        assert_eq!(snapshot.mcp_configs.len(), 2);
        assert_eq!(snapshot.mcp_config_sources.len(), 2);
        assert_eq!(snapshot.mcp_config_sources[0].plugin_id, "agent-demo");
        assert_eq!(
            snapshot.mcp_config_sources[1].plugin_id,
            "agent-demo.fixture"
        );
        assert!(snapshot.mcp_config_sources[0].tool_policy.allows("read"));
        assert!(!snapshot.mcp_config_sources[1].tool_policy.allows("read"));
    }

    #[test]
    fn mcp_tool_policy_applies_allowlist_before_denylist() {
        let policy = EffectiveMcpToolPolicy {
            enabled_tools: vec!["issues.read".to_string(), "issues.write".to_string()],
            disabled_tools: vec!["issues.write".to_string()],
        };

        assert!(policy.allows("issues.read"));
        assert!(!policy.allows("issues.write"));
        assert!(!policy.allows("issues.delete"));
    }
}

fn plugin_search_roots(cwd: &Path) -> Vec<(PathBuf, bool)> {
    let mut levels = Vec::new();
    let mut current = Some(cwd);
    while let Some(dir) = current {
        levels.push(dir.join(".kcoder").join("plugins"));
        current = dir.parent();
    }
    levels.reverse();
    let mut roots = Vec::new();
    for directory in levels {
        if directory.is_dir() {
            roots.push((directory, true));
        }
    }

    if let Ok(config_dir) = user_plugins_dir() {
        roots.push((config_dir, false));
    }
    roots
}

fn user_plugins_dir() -> Result<PathBuf> {
    Ok(kcoder_config::user_config_dir()?.join("plugins"))
}

#[cfg(test)]
fn user_plugins_dir_with_override(override_dir: Option<std::ffi::OsString>) -> Result<PathBuf> {
    let dir = override_dir
        .filter(|dir| !dir.is_empty())
        .context("config directory override was empty")?;
    Ok(PathBuf::from(dir).join("plugins"))
}

fn load_plugin(root: &Path) -> Result<Option<LoadedPlugin>> {
    let Some(loaded) = load_plugin_manifest(root)? else {
        return Ok(None);
    };
    validate_plugin_name(&loaded.manifest.name)?;
    let id = loaded
        .manifest
        .id
        .clone()
        .unwrap_or_else(|| loaded.manifest.name.to_ascii_lowercase().replace(' ', "-"));
    validate_plugin_id(&id)?;

    let mut compatibility = loaded.compatibility;
    let mut plugin_diagnostics = Vec::new();
    let mut hooks = if matches!(
        loaded.manifest.format,
        PluginManifestFormat::Kcoder | PluginManifestFormat::KcoderLegacy
    ) {
        load_kcoder_hooks(&loaded.manifest, &loaded.manifest.name)?
    } else {
        let outcome = crate::contributions::hooks::resolve(&loaded.manifest.contributions.hooks)
            .map_err(|message| anyhow::anyhow!(message))?;
        if !loaded.manifest.contributions.hooks.is_empty()
            && outcome.matchers.is_empty()
            && !outcome.warnings.is_empty()
        {
            compatibility.defer_capability(
                "hooks",
                "unsupported_hook_action",
                "plugin declares Hooks but none can be activated by this runtime",
            );
        }
        for warning in outcome.warnings {
            compatibility.add_issue(warning.code, Some("hooks"), warning.message.clone());
            plugin_diagnostics.push(PluginLoadDiagnostic {
                root: root.to_path_buf(),
                code: warning.code.to_string(),
                message: warning.message,
            });
        }
        outcome.matchers
    };
    let mcp_configs = match &loaded.manifest.contributions.mcp_servers {
        Some(declaration) => match crate::contributions::mcp::resolve(&id, root, declaration) {
            Ok(configs) => configs,
            Err(message) => {
                compatibility.defer_capability(
                    "mcp_servers",
                    "invalid_mcp_config",
                    message.clone(),
                );
                plugin_diagnostics.push(PluginLoadDiagnostic {
                    root: root.to_path_buf(),
                    code: "invalid_mcp_config".to_string(),
                    message,
                });
                Vec::new()
            }
        },
        None => Vec::new(),
    };
    let source = HookSource::plugin(id.clone(), loaded.manifest.name.clone(), root);
    for (_, matcher) in &mut hooks {
        matcher.source = Some(source.clone());
    }

    debug!(
        "loaded plugin {} from {} with {} hook matcher(s)",
        loaded.manifest.name,
        root.display(),
        hooks.len()
    );
    Ok(Some(LoadedPlugin {
        id,
        name: loaded.manifest.name.clone(),
        version: loaded.manifest.version.clone(),
        description: loaded.manifest.description.clone(),
        root: root.to_path_buf(),
        managed: false,
        version_lease: None,
        required_trust_directory: None,
        enabled: loaded.manifest.enabled_by_default,
        skills_enabled: true,
        hooks_enabled: true,
        mcp_enabled: true,
        hooks,
        mcp_configs,
        mcp_tool_policies: BTreeMap::new(),
        manifest: loaded.manifest,
        compatibility,
        selected_manifest_path: loaded.selected_manifest_path,
        shadowed_manifest_paths: loaded.shadowed_manifest_paths,
        diagnostics: plugin_diagnostics,
    }))
}

fn load_kcoder_hooks(
    manifest: &PluginManifest,
    plugin_name: &str,
) -> Result<Vec<(HookEvent, HookMatcher)>> {
    let mut hooks = Vec::new();
    for declaration in &manifest.contributions.hooks {
        match declaration {
            PluginHookDeclaration::Path(resource) => {
                let content =
                    std::fs::read_to_string(&resource.absolute_path).with_context(|| {
                        format!(
                            "failed to read hooks file {}",
                            resource.absolute_path.display()
                        )
                    })?;
                let value: Value = serde_json::from_str(&content).with_context(|| {
                    format!(
                        "failed to parse hooks file {}",
                        resource.absolute_path.display()
                    )
                })?;
                hooks.extend(parse_hooks_value(value, plugin_name)?);
            }
            PluginHookDeclaration::Inline(value) => {
                hooks.extend(parse_hooks_value(value.clone(), plugin_name)?);
            }
        }
    }
    Ok(hooks)
}

fn parse_hooks_value(value: Value, plugin_name: &str) -> Result<Vec<(HookEvent, HookMatcher)>> {
    let settings_value = value.get("hooks").cloned().unwrap_or(value);
    let settings: HooksSettings = serde_json::from_value(settings_value)
        .with_context(|| format!("failed to parse hooks for plugin {plugin_name}"))?;
    Ok(settings.into_matchers())
}

fn validate_plugin_name(name: &str) -> Result<()> {
    if name.trim().is_empty() {
        bail!("plugin name cannot be empty");
    }
    Ok(())
}

fn validate_plugin_id(id: &str) -> Result<()> {
    let valid = !id.is_empty()
        && id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        });
    if !valid {
        bail!("plugin id may contain only ASCII letters, digits, '-', '_' and '.'");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn discovers_project_plugin_with_inline_hooks() {
        let temp = TempDir::new().unwrap();
        let plugin_dir = temp.path().join(".kcoder/plugins/demo");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
              "id": "demo",
              "name": "Demo",
              "version": "0.1.0",
              "hooks": {
                "PreToolUse": [
                  {"matcher": "read", "hooks": [{"type": "command", "command": "echo hi"}]}
                ]
              }
            }"#,
        )
        .unwrap();

        let store = PluginStore::open(&temp.path().join("plugin-store")).unwrap();
        let registry = PluginRegistry::discover_with_store(temp.path(), true, &store).unwrap();
        let plugins = registry.plugins();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, "demo");
        assert_eq!(plugins[0].hooks.len(), 1);
        let (event, matcher) = &plugins[0].hooks[0];
        assert_eq!(*event, HookEvent::PreToolUse);
        assert_eq!(matcher.matcher.as_deref(), Some("read"));
        assert_eq!(matcher.source.as_ref().unwrap().name, "Demo");
        assert_eq!(
            matcher
                .source
                .as_ref()
                .unwrap()
                .required_trust
                .as_ref()
                .unwrap()
                .directory,
            temp.path()
        );
    }

    #[test]
    fn supports_wrapped_hooks_file_from_manifest() {
        let temp = TempDir::new().unwrap();
        let plugin_dir = temp.path().join(".kcoder/plugins/demo");
        std::fs::create_dir_all(plugin_dir.join("hooks")).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
              "id": "demo",
              "name": "Demo",
              "hooks": "./hooks/extra-hooks.json"
            }"#,
        )
        .unwrap();
        std::fs::write(
            plugin_dir.join("hooks/extra-hooks.json"),
            r#"{
              "description": "Demo hooks",
              "hooks": {
                "SessionStart": [
                  {"hooks": [{"type": "command", "command": "echo start"}]}
                ]
              }
            }"#,
        )
        .unwrap();

        let store = PluginStore::open(&temp.path().join("plugin-store")).unwrap();
        let registry = PluginRegistry::discover_with_store(temp.path(), true, &store).unwrap();
        let hooks = registry.hook_matchers();
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].0, HookEvent::SessionStart);
        assert_eq!(
            hooks[0].1.source.as_ref().unwrap().root,
            plugin_dir.to_path_buf()
        );
    }

    #[test]
    fn disabled_plugins_do_not_export_hooks() {
        let temp = TempDir::new().unwrap();
        let plugin_dir = temp.path().join(".kcoder/plugins/demo");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
              "id": "demo",
              "name": "Demo",
              "enabled": false,
              "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo stop"}]}]}
            }"#,
        )
        .unwrap();

        let store = PluginStore::open(&temp.path().join("plugin-store")).unwrap();
        let registry = PluginRegistry::discover_with_store(temp.path(), true, &store).unwrap();
        assert_eq!(registry.plugins().len(), 1);
        assert!(registry.hook_matchers().is_empty());
    }

    #[test]
    fn user_plugins_dir_honours_config_dir_env() {
        let temp = TempDir::new().unwrap();
        let resolved =
            user_plugins_dir_with_override(Some(temp.path().as_os_str().to_owned())).unwrap();
        assert_eq!(resolved, temp.path().join("plugins"));
    }
}

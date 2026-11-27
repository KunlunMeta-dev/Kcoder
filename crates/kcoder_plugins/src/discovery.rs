use crate::manifest::{PluginManifestError, load_plugin_manifest};
use crate::model::{
    CompatibilityReport, PluginHookDeclaration, PluginManifest, PluginManifestFormat,
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
    pub managed_operation_id: Option<String>,
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
    pub(crate) prompt_entries: Vec<crate::prompts::PromptEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PluginLoadDiagnostic {
    pub root: PathBuf,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Default)]
pub struct EffectivePluginSnapshot {
    pub generation: u64,
    pub version_leases: Vec<Arc<PluginVersionLease>>,
    pub managed_operations: BTreeMap<String, String>,
    pub plugin_ids: Vec<String>,
    pub skill_roots: Vec<PathBuf>,
    /// Owning plugin of each skill root (and materialized prompt root), so the
    /// skill registry can attribute and rank plugin copies.
    pub skill_root_owners: Vec<PluginSkillRootOwner>,
    pub prompt_leases: Vec<Arc<kcoder_config::PrivateTempDir>>,
    pub skill_trust_roots: Vec<(PathBuf, PathBuf)>,
    pub mcp_configs: Vec<EffectiveMcpServer>,
    pub hook_matchers: Vec<(HookEvent, HookMatcher)>,
    pub diagnostics: Vec<PluginLoadDiagnostic>,
}

/// Plugin owning one contributed skill root. The host converts this to the
/// skill registry's ownership type; plugins do not depend on skills.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginSkillRootOwner {
    pub root: PathBuf,
    pub plugin_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EffectiveMcpContribution {
    pub plugin_id: String,
    pub required_trust_directory: Option<PathBuf>,
    pub tool_policy: EffectiveMcpToolPolicy,
}

/// An effective MCP configuration and its inseparable plugin origin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveMcpServer {
    pub config: kcoder_config::McpServerConfig,
    pub source: EffectiveMcpContribution,
}

impl EffectivePluginSnapshot {
    /// Replace the host-marked private suffix with this snapshot's contributions.
    /// The original suffix length belongs to Settings, not to a newly observed snapshot.
    pub fn configured_mcp_servers<'a>(
        &'a self,
        settings: &'a kcoder_config::Settings,
    ) -> Result<
        impl Iterator<
            Item = (
                &'a kcoder_config::McpServerConfig,
                Option<&'a EffectiveMcpContribution>,
            ),
        >,
    > {
        let public_len = settings
            .mcp_servers
            .len()
            .checked_sub(settings.runtime_plugin_mcp_count)
            .context("Invalid host plugin MCP suffix length")?;
        Ok(settings.mcp_servers[..public_len]
            .iter()
            .map(|config| (config, None))
            .chain(
                self.mcp_configs
                    .iter()
                    .map(|server| (&server.config, Some(&server.source))),
            ))
    }
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
    managed_records: BTreeMap<String, InstalledPluginRecord>,
}

impl PluginRegistry {
    pub fn discover(cwd: &Path) -> Result<Self> {
        let project_trusted = kcoder_config::FolderTrustStore::trust_all_from_environment()
            || kcoder_config::user_config_dir().is_ok_and(|config_dir| {
                kcoder_config::FolderTrustStore::load(&config_dir).check(cwd)
                    == kcoder_config::FolderTrust::Trusted
            });
        Self::discover_with_trust(cwd, project_trusted)
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
        Self::discover_with_store_settings_and_credentials(
            cwd,
            project_trusted,
            store,
            settings,
            &BTreeMap::new(),
        )
    }

    /// Host-resolved private values are keyed by the immutable installation
    /// operation ID, never a display name. Project/user unmanaged plugins and
    /// Hooks do not receive these values. The host owns credential persistence.
    pub fn discover_with_store_settings_and_credentials(
        cwd: &Path,
        project_trusted: bool,
        store: &PluginStore,
        settings: &PluginsSettings,
        credentials_by_operation: &BTreeMap<String, BTreeMap<String, String>>,
    ) -> Result<Self> {
        let mut plugins = Vec::new();
        let mut diagnostics = Vec::new();
        let trust_all = kcoder_config::FolderTrustStore::trust_all_from_environment();
        let cwd_identity = dunce::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
        let profile = store
            .root()
            .parent()
            .context("plugin store has no profile directory")?;
        let folder_trust = kcoder_config::FolderTrustStore::load(profile);
        let trust_requirement = |directory: &Path| kcoder_hooks::types::HookTrustRequirement {
            directory: directory.to_path_buf(),
            config_dir: Some(profile.to_path_buf()),
        };
        for (root, project_owner) in plugin_search_roots(cwd, profile) {
            let is_project_root = project_owner.is_some();
            let owner_trusted = project_owner.as_ref().is_none_or(|owner| {
                let owner_identity = dunce::canonicalize(owner).unwrap_or_else(|_| owner.clone());
                trust_all
                    || if owner_identity == cwd_identity {
                        project_trusted
                    } else {
                        folder_trust.check(owner) == kcoder_config::FolderTrust::Trusted
                    }
            });
            if is_project_root
                && (!project_trusted
                    || !owner_trusted
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
                    &unmanaged_data_root(store, &path)?,
                    None,
                    None,
                    project_owner.as_deref().map(trust_requirement),
                    settings,
                    None,
                    &mut plugins,
                    &mut diagnostics,
                );
            }
        }
        let (generation, managed_records, version_leases) = if settings.runtime.enabled {
            let (store_snapshot, version_leases) = store.snapshot_with_leases()?;
            (
                store_snapshot.generation,
                store_snapshot.installed,
                version_leases,
            )
        } else {
            let snapshot = store.snapshot()?;
            (snapshot.generation, snapshot.installed, Vec::new())
        };
        for (index, record) in managed_records.iter().enumerate() {
            let lease = version_leases.get(index).cloned();
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
            let project_root = if let Some(identity) = &record.project_identity {
                if !project_trusted
                    || settings.runtime.project_policy == PluginProjectPolicy::Disabled
                {
                    continue;
                }
                match crate::project::runtime_root(cwd, identity) {
                    Ok(Some(root)) => {
                        let trusted =
                            folder_trust.check(&root) == kcoder_config::FolderTrust::Trusted;
                        if !trusted {
                            continue;
                        }
                        Some(root)
                    }
                    Ok(None) => continue,
                    Err(_) => {
                        diagnostics.push(PluginLoadDiagnostic {
                            root: root.clone(),
                            code: "managed_plugin_project_changed".into(),
                            message: "Project installation identity cannot be verified".into(),
                        });
                        continue;
                    }
                }
            } else {
                None
            };
            load_discovered_plugin(
                &root,
                &store.data_root(&record.plugin_id)?,
                Some(record),
                lease,
                project_root.as_deref().map(trust_requirement),
                settings,
                credentials_by_operation.get(&record.operation_id),
                &mut plugins,
                &mut diagnostics,
            );
        }
        let mut id_counts = BTreeMap::<String, usize>::new();
        for plugin in &plugins {
            *id_counts.entry(plugin.id.clone()).or_default() += 1;
        }
        let mut unique_plugins = Vec::with_capacity(plugins.len());
        for plugin in plugins {
            if id_counts.get(&plugin.id).is_some_and(|count| *count > 1) {
                diagnostics.push(PluginLoadDiagnostic {
                    root: plugin.root.clone(),
                    code: "duplicate_plugin_id".into(),
                    message: format!(
                        "plugin ID {} appears in multiple roots; all conflicting plugins are disabled",
                        plugin.id
                    ),
                });
            } else {
                unique_plugins.push(plugin);
            }
        }
        Ok(Self {
            plugins: unique_plugins,
            diagnostics,
            generation,
            managed_records: managed_records
                .into_iter()
                .map(|record| (record.plugin_id.to_string(), record))
                .collect(),
        })
    }

    pub fn empty() -> Self {
        Self::default()
    }

    pub fn plugins(&self) -> &[LoadedPlugin] {
        &self.plugins
    }

    pub(crate) fn installed_record(&self, id: &str) -> Option<&InstalledPluginRecord> {
        self.managed_records.get(id)
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
            .filter(|plugin| plugin.hooks_enabled)
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
            if let Some(operation) = &plugin.managed_operation_id {
                snapshot
                    .managed_operations
                    .insert(plugin.id.clone(), operation.clone());
            }
            snapshot
                .version_leases
                .extend(plugin.version_lease.iter().cloned());
            if plugin.skills_enabled {
                if !plugin.prompt_entries.is_empty() {
                    match crate::prompts::materialize(&plugin.id, &plugin.prompt_entries) {
                        Ok(lease) => {
                            if let Some(directory) = &plugin.required_trust_directory {
                                snapshot
                                    .skill_trust_roots
                                    .push((lease.path().to_path_buf(), directory.clone()));
                            }
                            snapshot.skill_roots.push(lease.path().to_path_buf());
                            snapshot.skill_root_owners.push(PluginSkillRootOwner {
                                root: lease.path().to_path_buf(),
                                plugin_id: plugin.id.clone(),
                            });
                            snapshot.prompt_leases.push(lease);
                        }
                        Err(error) => snapshot.diagnostics.push(PluginLoadDiagnostic {
                            root: plugin.root.clone(),
                            code: "prompt_adapter_failed".into(),
                            message: error.to_string(),
                        }),
                    }
                }
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
                for resource in &plugin.manifest.contributions.skills {
                    snapshot.skill_roots.push(resource.absolute_path.clone());
                    snapshot.skill_root_owners.push(PluginSkillRootOwner {
                        root: resource.absolute_path.clone(),
                        plugin_id: plugin.id.clone(),
                    });
                }
            }
            if plugin.mcp_enabled {
                snapshot
                    .mcp_configs
                    .extend(plugin.mcp_configs.iter().map(|config| {
                        EffectiveMcpServer {
                            config: config.clone(),
                            source: EffectiveMcpContribution {
                                plugin_id: plugin.id.clone(),
                                required_trust_directory: plugin.required_trust_directory.clone(),
                                tool_policy: plugin
                                    .mcp_tool_policies
                                    .get(&config.name)
                                    .cloned()
                                    .unwrap_or_default(),
                            },
                        }
                    }));
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

#[expect(
    clippy::too_many_arguments,
    reason = "Keep plugin origin, lease, trust and credential policy explicit at discovery"
)]
fn load_discovered_plugin(
    path: &Path,
    data_root: &Path,
    managed: Option<&InstalledPluginRecord>,
    version_lease: Option<Arc<PluginVersionLease>>,
    required_trust: Option<kcoder_hooks::types::HookTrustRequirement>,
    settings: &PluginsSettings,
    credentials: Option<&BTreeMap<String, String>>,
    plugins: &mut Vec<LoadedPlugin>,
    diagnostics: &mut Vec<PluginLoadDiagnostic>,
) {
    match load_plugin_with_credentials(path, data_root, credentials) {
        Ok(Some(mut plugin)) => {
            plugin.managed_operation_id = managed
                .filter(|_| version_lease.is_some())
                .map(|record| record.operation_id.clone());
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
            plugin.enabled &= settings.runtime.enabled;
            plugin.required_trust_directory =
                required_trust.as_ref().map(|trust| trust.directory.clone());
            if plugin.enabled
                && plugin.mcp_enabled
                && plugin.manifest.format == PluginManifestFormat::AgentPluginsV1
                && plugin
                    .mcp_configs
                    .iter()
                    .any(|config| config.transport == "stdio")
            {
                let data_directory = match kcoder_config::PrivateDirectory::open_existing(data_root)
                {
                    Ok(directory) => Ok(directory),
                    Err(error)
                        if error.chain().any(|cause| {
                            cause
                                .downcast_ref::<std::io::Error>()
                                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                        }) =>
                    {
                        kcoder_config::PrivateDirectory::open_or_create(data_root)
                    }
                    Err(error) => Err(error),
                };
                match data_directory.and_then(|directory| directory.verify_private_directory()) {
                    Err(error) => {
                        // A bad data directory must not disable independent remote servers or skills.
                        plugin
                            .mcp_configs
                            .retain(|config| config.transport != "stdio");
                        let message = format!("plugin data directory is unavailable: {error}");
                        plugin.compatibility.add_issue(
                            "invalid_plugin_data",
                            Some("mcp_servers"),
                            &message,
                        );
                        plugin.diagnostics.push(PluginLoadDiagnostic {
                            root: path.to_path_buf(),
                            code: "invalid_plugin_data".into(),
                            message,
                        });
                    }
                    Ok(()) => {
                        plugin.mcp_configs.retain(|config| {
                            if config.transport != "stdio" {
                                return true;
                            }
                            let valid = config.policy.cwd.as_deref().is_some_and(|cwd| {
                                kcoder_config::PrivateDirectory::open_existing(Path::new(cwd))
                                    .is_ok()
                            });
                            if !valid {
                                let message = format!(
                                    "MCP server `{}` working directory is missing or unsafe",
                                    config.name
                                );
                                plugin.compatibility.add_issue(
                                    "invalid_mcp_server",
                                    Some("mcp_servers"),
                                    &message,
                                );
                                plugin.diagnostics.push(PluginLoadDiagnostic {
                                    root: path.to_path_buf(),
                                    code: "invalid_mcp_server".into(),
                                    message,
                                });
                            }
                            valid
                        });
                    }
                }
            }
            if let Some(required) = required_trust {
                for (_, matcher) in &mut plugin.hooks {
                    if let Some(source) = &mut matcher.source {
                        source.required_trust = Some(required.clone());
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

fn unmanaged_data_root(store: &PluginStore, path: &Path) -> Result<PathBuf> {
    use sha2::{Digest, Sha256};
    let root = std::fs::canonicalize(path)?;
    let key = format!("{:x}", Sha256::digest(root.as_os_str().as_encoded_bytes()));
    // The leading dot is outside the managed marketplace identity grammar.
    Ok(store.root().join("data/.unmanaged").join(key))
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
        PluginManifestFormat::Grok => settings.compatibility.grok,
        PluginManifestFormat::Codebuddy => settings.compatibility.codebuddy,
        PluginManifestFormat::Qoder => settings.compatibility.qoder,
        PluginManifestFormat::Trae => settings.compatibility.trae,
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
    fn configured_sources_preserve_public_prefix_when_plugin_count_changes() {
        let server = |name: &str| {
            serde_json::from_value::<kcoder_config::McpServerConfig>(
                serde_json::json!({"name": name, "command": "not-executed"}),
            )
            .unwrap()
        };
        let settings = kcoder_config::Settings {
            // Matching names must not cause the user's entry to become a plugin contribution.
            mcp_servers: vec![server("same"), server("other"), server("same")],
            runtime_plugin_mcp_count: 1,
            ..Default::default()
        };
        let snapshot = EffectivePluginSnapshot {
            mcp_configs: vec![
                EffectiveMcpServer {
                    config: server("same"),
                    source: EffectiveMcpContribution {
                        plugin_id: "first".into(),
                        ..Default::default()
                    },
                },
                EffectiveMcpServer {
                    config: server("same"),
                    source: EffectiveMcpContribution {
                        plugin_id: "second".into(),
                        ..Default::default()
                    },
                },
            ],
            ..Default::default()
        };
        let projected = snapshot
            .configured_mcp_servers(&settings)
            .unwrap()
            .map(|(config, source)| {
                (
                    config.name.as_str(),
                    source.map(|source| source.plugin_id.as_str()),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            projected,
            vec![
                ("same", None),
                ("other", None),
                ("same", Some("first")),
                ("same", Some("second"))
            ]
        );
        let empty = EffectivePluginSnapshot::default();
        assert_eq!(empty.configured_mcp_servers(&settings).unwrap().count(), 2);
        let invalid = kcoder_config::Settings {
            runtime_plugin_mcp_count: 1,
            ..Default::default()
        };
        assert!(empty.configured_mcp_servers(&invalid).is_err());
    }

    #[test]
    fn registry_keeps_installation_metadata_from_its_observed_generation() {
        let temp = tempfile::tempdir().unwrap();
        let store = PluginStore::open(&temp.path().join("plugin_store")).unwrap();
        let installed = store.install_local(&agent_fixture(), "snapshot").unwrap();
        let registry = PluginRegistry::discover_with_store(temp.path(), false, &store).unwrap();
        let id = installed.plugin_id.to_string();
        let captured_generation = registry.generation();
        let replacement = store.install_local(&agent_fixture(), "snapshot").unwrap();
        assert_ne!(installed.operation_id, replacement.operation_id);
        assert_eq!(
            registry.installed_record(&id).unwrap().operation_id,
            installed.operation_id
        );
        assert_eq!(registry.generation(), captured_generation);
        let latest = PluginRegistry::discover_with_store(temp.path(), false, &store).unwrap();
        assert!(latest.generation() > captured_generation);
        assert_eq!(
            latest.installed_record(&id).unwrap().operation_id,
            replacement.operation_id
        );
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
        assert_eq!(snapshot.mcp_configs[0].source.plugin_id, "agent-demo");
        registry.plugins[0].mcp_enabled = false;
        let disabled = registry.effective_snapshot();
        assert!(disabled.mcp_configs.is_empty());
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
        assert_eq!(snapshot.mcp_configs[0].source.plugin_id, "agent-demo");
        assert_eq!(
            snapshot.mcp_configs[1].source.plugin_id,
            "agent-demo.fixture"
        );
        assert!(snapshot.mcp_configs[0].source.tool_policy.allows("read"));
        assert!(!snapshot.mcp_configs[1].source.tool_policy.allows("read"));
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

fn plugin_search_roots(cwd: &Path, profile: &Path) -> Vec<(PathBuf, Option<PathBuf>)> {
    let mut levels = Vec::new();
    let mut current = Some(cwd);
    while let Some(dir) = current {
        levels.push((dir.join(".kcoder").join("plugins"), dir.to_path_buf()));
        current = dir.parent();
    }
    levels.reverse();
    let mut roots = Vec::new();
    for (directory, owner) in levels {
        if directory.is_dir() {
            roots.push((directory, Some(owner)));
        }
    }

    roots.push((profile.join("plugins"), None));

    let mut unique: Vec<(PathBuf, Option<PathBuf>)> = Vec::with_capacity(roots.len());
    let mut indices = BTreeMap::<PathBuf, usize>::new();
    for (root, owner) in roots {
        let identity = dunce::canonicalize(&root).unwrap_or_else(|_| root.clone());
        let project_owner = owner.map(|owner| {
            identity
                .parent()
                .and_then(Path::parent)
                .map(Path::to_path_buf)
                .unwrap_or(owner)
        });
        if let Some(index) = indices.get(&identity).copied() {
            if unique[index].1.is_none() {
                unique[index].1 = project_owner;
            }
        } else {
            indices.insert(identity.clone(), unique.len());
            unique.push((identity, project_owner));
        }
    }
    unique
}

#[cfg(test)]
fn load_plugin(root: &Path) -> Result<Option<LoadedPlugin>> {
    load_plugin_with_credentials(root, root, None)
}

fn load_plugin_with_credentials(
    root: &Path,
    data_root: &Path,
    credentials: Option<&BTreeMap<String, String>>,
) -> Result<Option<LoadedPlugin>> {
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
    match crate::materialize::submodules::skipped_note(root) {
        Ok(Some(message)) => {
            compatibility.issues.push(crate::CompatibilityIssue {
                code: "unfetched_development_submodules".into(),
                capability: None,
                message,
            });
            if !compatibility.supported_capabilities.is_empty() {
                compatibility.level = crate::CompatibilityLevel::PartiallySupported;
            }
        }
        Ok(None) => {}
        Err(error) => plugin_diagnostics.push(PluginLoadDiagnostic {
            root: root.into(),
            code: "invalid_git_dependency_provenance".into(),
            message: error.to_string(),
        }),
    }

    let mut hooks = if matches!(
        loaded.manifest.format,
        PluginManifestFormat::Kcoder | PluginManifestFormat::KcoderLegacy
    ) {
        load_kcoder_hooks(root, &loaded.manifest, &loaded.manifest.name)?
    } else {
        let outcome =
            crate::contributions::hooks::resolve(root, &loaded.manifest.contributions.hooks)
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
        Some(_) => {
            match crate::contributions::mcp::resolve_manifest_with_env(
                &id,
                root,
                data_root,
                &loaded.manifest,
                |name| {
                    credentials
                        .and_then(|values| values.get(name).cloned())
                        .or_else(|| std::env::var(name).ok())
                },
            ) {
                Ok(outcome) => {
                    for message in outcome.warnings {
                        if outcome.configs.is_empty() {
                            compatibility.defer_capability(
                                "mcp_servers",
                                "invalid_mcp_server",
                                &message,
                            );
                        } else {
                            compatibility.add_issue(
                                "invalid_mcp_server",
                                Some("mcp_servers"),
                                &message,
                            );
                        }
                        plugin_diagnostics.push(PluginLoadDiagnostic {
                            root: root.to_path_buf(),
                            code: "invalid_mcp_server".into(),
                            message,
                        });
                    }
                    outcome.configs
                }
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
            }
        }
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
        managed_operation_id: None,
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
        prompt_entries: loaded.prompt_entries,
    }))
}

fn load_kcoder_hooks(
    root: &Path,
    manifest: &PluginManifest,
    plugin_name: &str,
) -> Result<Vec<(HookEvent, HookMatcher)>> {
    let mut hooks = Vec::new();
    for declaration in &manifest.contributions.hooks {
        match declaration {
            PluginHookDeclaration::Path(resource) => {
                let content =
                    crate::manifest::resources::read_resource(root, resource, 1024 * 1024)?;
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
}

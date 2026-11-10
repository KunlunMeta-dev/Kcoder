#[path = "../internal/session_configuration/temporary_mcp/mod.rs"]
pub mod temporary_mcp;

#[path = "../internal/session_configuration/registry.rs"]
mod registry;
pub use registry::{builtin_tools_for_profile, builtin_tools_for_settings};
#[path = "../internal/session_configuration/startup.rs"]
mod startup;
pub use startup::configure_startup_tools;
#[cfg(test)]
#[path = "session_configuration/credential_http_tests.rs"]
mod credential_http_tests;
#[path = "session_configuration/tool_profiles.rs"]
mod tool_profiles;
#[path = "session_configuration/tool_selections.rs"]
mod tool_selections;
pub use tool_selections::editable as tool_selection_editable;

use anyhow::{Context, Result};
use kcoder_api::{Provider, ProviderKind};
use kcoder_cli_commands::{
    cli_args::{self, Cli},
    credentials::apply_credential_env_file,
    entry_modes::project_mcp_server_names,
    mcp_connection, model_configuration,
    settings_overrides::{apply_cli_settings_overrides, resolve_cli_provider_kind},
};
use kcoder_config::{Settings, SettingsLoader};
use kcoder_plugins::{EffectiveMcpContribution, EffectivePluginSnapshot};
use kcoder_tools::{Tool, ToolRegistry};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct SessionConfiguration {
    loader: SettingsLoader,
    cli: Cli,
    mcp_cache: Arc<Mutex<Option<CachedMcpSnapshot>>>,
    server_cache: Arc<Mutex<Vec<CachedMcpServer>>>,
    mcp_health: Arc<std::sync::Mutex<Vec<TrackedMcpConnection>>>,
    mcp_attempts: Arc<
        std::sync::Mutex<
            std::collections::BTreeMap<String, (Value, kcoder_app_protocol::McpConnectionAttempt)>,
        >,
    >,
}

pub struct PluginCredentialRefresh {
    pub settings: Settings,
    pub tools: ToolRegistry,
    pub snapshot: EffectivePluginSnapshot,
}

struct CachedMcpSnapshot {
    key: McpSnapshotKey,
    tools: ToolRegistry,
    handles: Vec<kcoder_mcp::McpServerHandle>,
    _plugin_leases: Vec<Arc<kcoder_plugins::PluginVersionLease>>,
}

struct CachedMcpServer {
    key: McpServerKey,
    tools: ToolRegistry,
    handle: kcoder_mcp::McpServerHandle,
    _plugin_leases: Vec<Arc<kcoder_plugins::PluginVersionLease>>,
}

struct TrackedMcpConnection {
    config: Value,
    handle: std::sync::Weak<Mutex<kcoder_mcp::McpClient>>,
    tools: Vec<std::sync::Weak<dyn Tool>>,
}

fn connection_failure(
    handle: &kcoder_mcp::McpServerHandle,
) -> Option<kcoder_types::mcp_failure::McpFailureReason> {
    // An in-flight call owns the lock; its terminal transport failure is observed
    // once it releases the connection. Observation must never cancel that call.
    handle
        .try_lock()
        .ok()
        .and_then(|mut client| client.connection_failure_reason())
}

fn failed_attempt(
    reason: kcoder_types::mcp_failure::McpFailureReason,
) -> kcoder_app_protocol::McpConnectionAttempt {
    kcoder_app_protocol::McpConnectionAttempt {
        status: kcoder_app_protocol::McpConnectionAttemptStatus::Unavailable,
        failure_reason: Some(reason),
    }
}
#[derive(PartialEq)]
struct McpServerKey {
    config: Value,
    source: Option<EffectiveMcpContribution>,
    operation_id: Option<String>,
    trust_profile: std::path::PathBuf,
    project_root: std::path::PathBuf,
    project_server: bool,
    authorization: Vec<String>,
    credential_store: kcoder_config::CredentialStoreMode,
}

#[derive(PartialEq)]
struct McpSnapshotKey {
    builtin_names: Vec<String>,
    configs: Value,
    project_servers: std::collections::BTreeSet<String>,
    trust_profile: std::path::PathBuf,
    project_root: std::path::PathBuf,
    sources: Vec<EffectiveMcpContribution>,
    generation: u64,
    disabled: Vec<String>,
    disabled_servers: Vec<String>,
    authorization_revisions: Vec<String>,
    credential_store: kcoder_config::CredentialStoreMode,
}

impl McpSnapshotKey {
    fn new(
        settings: &Settings,
        plugins: &EffectivePluginSnapshot,
        paths: &kcoder_config::ConfigPaths,
    ) -> Result<Self> {
        Ok(Self {
            builtin_names: Vec::new(),
            configs: serde_json::to_value(&settings.mcp_servers)?,
            project_servers: project_mcp_server_names(&paths.project_root),
            trust_profile: paths.config_dir.clone(),
            project_root: paths.project_root.clone(),
            sources: plugins.mcp_config_sources.clone(),
            generation: plugins.generation,
            disabled: settings.tools.disabled.clone(),
            disabled_servers: settings.mcp_disabled_servers.clone(),
            authorization_revisions: Vec::new(),
            credential_store: settings.credential_store,
        })
    }
}

impl SessionConfiguration {
    /// Reconnect only the credential bindings for an unchanged frozen plugin set.
    pub async fn refresh_plugin_credentials(
        &self,
        cwd: &std::path::Path,
        folder_trusted: bool,
        settings: Settings,
        settings_path: &std::path::Path,
        frozen: &EffectivePluginSnapshot,
    ) -> Result<Option<PluginCredentialRefresh>> {
        let manager = kcoder_plugins::PluginManager::open_default_for_cwd_with_effective_settings(
            cwd,
            settings.plugins.clone(),
        )?;
        if manager.store().generation()? != frozen.generation {
            return Ok(None);
        }
        let fresh = kcoder_plugin_rpc::runtime_snapshot::runtime_plugin_snapshot_with_profile(
            cwd,
            folder_trusted,
            &settings,
            &settings_path.with_file_name("credentials.json"),
        )?;
        if fresh.generation != frozen.generation
            || fresh.plugin_ids != frozen.plugin_ids
            || fresh.managed_operations != frozen.managed_operations
        {
            return Ok(None);
        }
        if serde_json::to_value(&fresh.mcp_configs)? == serde_json::to_value(&frozen.mcp_configs)? {
            return Ok(None);
        }
        let mut next = frozen.clone();
        // Unmanaged project/user extensions are not rediscovered or granted private values.
        let frozen_unmanaged = frozen
            .mcp_configs
            .iter()
            .cloned()
            .zip(frozen.mcp_config_sources.iter().cloned())
            .filter(|(_, source)| !frozen.managed_operations.contains_key(&source.plugin_id));
        let refreshed_managed = fresh
            .mcp_configs
            .into_iter()
            .zip(fresh.mcp_config_sources)
            .filter(|(_, source)| frozen.managed_operations.contains_key(&source.plugin_id));
        let pairs = frozen_unmanaged
            .chain(refreshed_managed)
            .collect::<Vec<_>>();
        next.mcp_configs = pairs.iter().map(|(config, _)| config.clone()).collect();
        next.mcp_config_sources = pairs.into_iter().map(|(_, source)| source).collect();
        next.mcp_tool_policies = frozen.mcp_tool_policies.clone();
        for source in &next.mcp_config_sources {
            if frozen.managed_operations.contains_key(&source.plugin_id) {
                for config in &next.mcp_configs {
                    if let Some(policy) = fresh.mcp_tool_policies.get(&config.name) {
                        next.mcp_tool_policies
                            .insert(config.name.clone(), policy.clone());
                    }
                }
            }
        }
        let mut next_settings = settings;
        next_settings
            .mcp_servers
            .extend(next.mcp_configs.iter().cloned());
        next_settings.runtime_plugin_mcp_count = next.mcp_configs.len();
        let tools = self.tools(&next_settings, &next).await?;
        // Installation changes while connecting never update this resident's frozen version set.
        if manager.store().generation()? != frozen.generation {
            anyhow::bail!("plugin_scope_changed: retry this turn");
        }
        Ok(Some(PluginCredentialRefresh {
            settings: next_settings,
            tools,
            snapshot: next,
        }))
    }

    pub fn new(loader: SettingsLoader, cli: Cli) -> Self {
        Self {
            loader,
            cli,
            mcp_cache: Arc::new(Mutex::new(None)),
            server_cache: Default::default(),
            mcp_health: Default::default(),
            mcp_attempts: Arc::new(std::sync::Mutex::new(std::collections::BTreeMap::new())),
        }
    }

    pub fn freeze_model_overlays(mut self) -> Result<Self> {
        self.loader = self.loader.freeze_overlays()?;
        Ok(self)
    }

    pub fn model_source(&self) -> Arc<dyn kcoder_api::ClientModelConfiguration> {
        Arc::new(model_configuration::ModelConfiguration::new(
            self.loader.clone(),
            self.cli.clone(),
        ))
    }

    pub fn cli_permission_mode_override(&self) -> Result<Option<kcoder_config::PermissionMode>> {
        if let Some(mode) = self.cli.permission_mode {
            return Ok(Some(mode.into()));
        }
        for path in &self.cli.settings_files {
            let value = kcoder_config::read_settings_file(path)?;
            if value.get("permission_mode").is_some() {
                return Ok(Some(self.loader.load()?.settings.permission_mode));
            }
        }
        Ok(None)
    }

    /// Returns this configuration with a session settings template layered in.
    ///
    /// The template sits *below* explicit CLI overlays, so `--settings-file`
    /// keeps the final word. The host supplies the frozen native version, so
    /// editing the management template cannot alter a recorded session overlay.
    pub fn with_template(&self, path: std::path::PathBuf) -> Self {
        Self {
            loader: self.loader.clone().with_prepended_overlay_files([path]),
            cli: self.cli.clone(),
            mcp_cache: Arc::new(Mutex::new(None)),
            server_cache: Default::default(),
            mcp_health: Default::default(),
            mcp_attempts: Arc::new(std::sync::Mutex::new(std::collections::BTreeMap::new())),
        }
    }

    pub fn template_sets_permission_mode(&self, path: std::path::PathBuf) -> Result<bool> {
        let template = kcoder_config::read_settings_file(&path).with_context(|| {
            format!(
                "failed to read session settings template {}",
                path.display()
            )
        })?;
        Ok(template.get("permission_mode").is_some())
    }

    pub fn mcp_connection_attempt(
        &self,
        config: &kcoder_mcp::McpServerConfig,
    ) -> Option<kcoder_app_protocol::McpConnectionAttempt> {
        let value = serde_json::to_value(config).ok()?;
        let attempts = self.mcp_attempts.lock().ok()?;
        let (recorded, status) = attempts.get(&config.name)?;
        if recorded != &value {
            return None;
        }
        let mut status = status.clone();
        drop(attempts);
        if status.status == kcoder_app_protocol::McpConnectionAttemptStatus::Ready
            && let Ok(connections) = self.mcp_health.lock()
            && let Some(connection) = connections
                .iter()
                .rev()
                .find(|connection| connection.config == value)
        {
            let reason = connection.handle.upgrade().map_or(
                Some(kcoder_types::mcp_failure::McpFailureReason::ConnectionFailed),
                |handle| connection_failure(&handle),
            );
            if let Some(reason) = reason {
                status = failed_attempt(reason);
            }
        }
        Some(status)
    }

    pub fn mcp_connection_attempt_for_registry(
        &self,
        config: &kcoder_mcp::McpServerConfig,
        registry: &ToolRegistry,
    ) -> Option<kcoder_app_protocol::McpConnectionAttempt> {
        let value = serde_json::to_value(config).ok()?;
        let active = registry.all();
        let connections = self.mcp_health.lock().ok()?;
        if let Some(connection) = connections.iter().rev().find(|connection| {
            connection.config == value
                && connection.tools.iter().any(|tool| {
                    tool.upgrade()
                        .is_some_and(|tool| active.iter().any(|active| Arc::ptr_eq(&tool, active)))
                })
        }) {
            return Some(match connection.handle.upgrade() {
                Some(handle) => connection_failure(&handle).map_or_else(
                    || kcoder_app_protocol::McpConnectionAttemptStatus::Ready.into(),
                    failed_attempt,
                ),
                None => {
                    failed_attempt(kcoder_types::mcp_failure::McpFailureReason::ConnectionFailed)
                }
            });
        }
        drop(connections);
        self.mcp_connection_attempt(config)
    }

    fn track_mcp_connection(
        &self,
        config: &kcoder_mcp::McpServerConfig,
        handle: &kcoder_mcp::McpServerHandle,
        tools: &ToolRegistry,
    ) -> Result<()> {
        let mut connections = self
            .mcp_health
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP health registry is unavailable"))?;
        connections.retain(|connection| connection.handle.strong_count() > 0);
        connections.push(TrackedMcpConnection {
            config: serde_json::to_value(config)?,
            handle: Arc::downgrade(handle),
            tools: tools.all().iter().map(Arc::downgrade).collect(),
        });
        Ok(())
    }

    fn record_mcp_attempt(
        &self,
        config: &kcoder_mcp::McpServerConfig,
        status: impl Into<kcoder_app_protocol::McpConnectionAttempt>,
    ) {
        if let (Ok(value), Ok(mut attempts)) =
            (serde_json::to_value(config), self.mcp_attempts.lock())
        {
            attempts.insert(config.name.clone(), (value, status.into()));
        }
    }

    pub fn seed_mcp(
        &mut self,
        settings: &Settings,
        plugins: &EffectivePluginSnapshot,
        tools: &ToolRegistry,
    ) -> Result<()> {
        let builtins = builtin_tools_for_settings(&self.cli, settings);
        if builtins.names().is_empty() {
            return Ok(());
        }
        // The bootstrap registry does not expose transport handles. Rebuild an
        // observable MCP connection at the first explicit conversation activation.
        if !settings.mcp_servers.is_empty() {
            return Ok(());
        }
        for config in &settings.mcp_servers {
            self.record_mcp_attempt(
                config,
                kcoder_app_protocol::McpConnectionAttemptStatus::Ready,
            );
        }
        let mut key = McpSnapshotKey::new(settings, plugins, &self.loader.paths()?)?;
        key.builtin_names = builtins.names();
        key.builtin_names.sort();
        *self
            .mcp_cache
            .try_lock()
            .context("session configuration cache is busy")? = Some(CachedMcpSnapshot {
            key,
            tools: tools.clone(),
            handles: Vec::new(),
            _plugin_leases: plugins.version_leases.clone(),
        });
        Ok(())
    }

    pub fn settings(&self, cwd: &std::path::Path, trusted: bool) -> Result<Settings> {
        let mut settings = self
            .loader
            .load()
            .context("Cannot reload configuration for a new conversation")?
            .settings;
        apply_cli_settings_overrides(&mut settings, &self.cli)?;
        if let Some(path) = self.cli.credential_env_file.as_deref() {
            apply_credential_env_file(&mut settings, path)?;
        }
        if !trusted {
            let project_names = project_mcp_server_names(cwd);
            settings
                .mcp_servers
                .retain(|server| !project_names.contains(&server.name));
        }
        Ok(settings)
    }

    pub fn connectivity_settings_sources(&self) -> Result<kcoder_config::LoadedSettings> {
        let mut loaded = self.loader.load()?;
        apply_cli_settings_overrides(&mut loaded.settings, &self.cli)?;
        Ok(loaded)
    }

    pub fn connectivity_policy_settings(&self) -> Result<Settings> {
        self.loader.load_policy_configuration()
    }

    /// Public policy observation must not hydrate credentials or initialize a profile.
    pub fn public_runtime_settings(&self) -> Result<Settings> {
        let mut loaded = self.loader.load_read_only_configuration()?;
        apply_cli_settings_overrides(&mut loaded.settings, &self.cli)?;
        Ok(loaded.settings)
    }

    pub fn hook_user_settings_path(&self) -> Result<std::path::PathBuf> {
        Ok(self.loader.load()?.paths.user_settings)
    }

    pub fn mcp_user_settings_path(&self) -> Result<std::path::PathBuf> {
        self.mcp_editable_field_path("mcp_servers")
    }

    pub fn migration_project_settings_path(&self, names: &[&str]) -> Result<std::path::PathBuf> {
        let loaded = self.loader.load()?;
        let covered = |field: &str| {
            names
                .iter()
                .any(|name| field == *name || field.starts_with(&format!("{name}.")))
        };
        anyhow::ensure!(
            !loaded.overlay_fields.iter().any(|field| covered(field))
                && !loaded
                    .field_sources
                    .iter()
                    .any(|(field, scope)| covered(field)
                        && *scope == kcoder_config::ConfigScope::Local),
            "migration_target_controlled_by_overlay"
        );
        Ok(loaded.paths.project_settings)
    }

    pub fn migration_user_settings_path(&self) -> Result<std::path::PathBuf> {
        self.mcp_editable_field_path("providers")
    }

    pub fn mcp_activation_user_settings_path(&self) -> Result<std::path::PathBuf> {
        self.mcp_editable_field_path("mcp_disabled_servers")
    }

    fn mcp_editable_field_path(&self, name: &str) -> Result<std::path::PathBuf> {
        let loaded = self.loader.load()?;
        let prefix = format!("{name}.");
        let covered = |field: &str| field == name || field.starts_with(&prefix);
        if loaded.overlay_fields.iter().any(|field| covered(field))
            || loaded.field_sources.iter().any(|(field, scope)| {
                covered(field)
                    && matches!(
                        scope,
                        kcoder_config::ConfigScope::Executable
                            | kcoder_config::ConfigScope::Project
                            | kcoder_config::ConfigScope::Local
                    )
            })
        {
            anyhow::bail!(
                "MCP settings are controlled by higher-priority configuration or a read-only overlay; edit that source instead"
            );
        }
        Ok(loaded.paths.user_settings)
    }

    pub fn provider(&self, settings: &Settings) -> Result<Arc<dyn Provider>> {
        let kind = resolve_cli_provider_kind(&self.cli, ProviderKind::from_env(), settings)?
            .context("No model Provider is configured")?;
        self.provider_for_kind(settings, kind)
    }

    fn provider_for_kind(
        &self,
        settings: &Settings,
        kind: ProviderKind,
    ) -> Result<Arc<dyn Provider>> {
        model_configuration::ModelConfiguration::new(self.loader.clone(), self.cli.clone())
            .provider_for_kind(settings, kind)
    }

    pub async fn tools(
        &self,
        settings: &Settings,
        plugins: &EffectivePluginSnapshot,
    ) -> Result<ToolRegistry> {
        // Rebuild per newly activated conversation; resident engines keep their own registry.
        let builtin_tools = builtin_tools_for_settings(&self.cli, settings);
        if builtin_tools.names().is_empty() {
            return Ok(builtin_tools);
        }
        let paths = self.loader.paths()?;
        let manager = kcoder_plugins::PluginManager::open_default_for_cwd_with_effective_settings(
            &paths.project_root,
            settings.plugins.clone(),
        )?;
        let private_values = kcoder_plugin_rpc::credentials::by_operation(
            &paths.credentials,
            settings.credential_store,
            &manager,
        )?;
        let project_mcp_names = project_mcp_server_names(&paths.project_root);
        let mut key = McpSnapshotKey::new(settings, plugins, &paths)?;
        key.builtin_names = builtin_tools.names();
        key.builtin_names.sort();
        let enabled_configs = settings
            .mcp_servers
            .iter()
            .filter(|config| settings.mcp_server_enabled(&config.name))
            .cloned()
            .collect::<Vec<_>>();
        let revision_valid = match mcp_connection::authorization_revisions(
            &enabled_configs,
            &paths.config_dir,
            settings.credential_store,
        )
        .await
        {
            Ok(revisions) => {
                key.authorization_revisions = revisions;
                true
            }
            Err(error) => {
                tracing::warn!("Cannot inspect optional MCP authorization cache: {error}");
                false
            }
        };
        let mut cache = self.mcp_cache.lock().await;
        if revision_valid
            && let Some(cached) = cache.as_ref()
            && cached.key == key
            && cached
                .handles
                .iter()
                .all(|handle| connection_failure(handle).is_none())
        {
            return Ok(cached.tools.clone());
        }
        *cache = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        // Lock order: full snapshot cache, then bounded per-server cache. Existing
        // turn registries retain their Arc handles when a host entry is evicted.
        let mut servers = self.server_cache.lock().await;
        servers.retain(|cached| {
            cached.key.config["name"]
                .as_str()
                .is_some_and(|name| settings.mcp_server_enabled(name))
                && connection_failure(&cached.handle).is_none()
        });
        let mut current_keys = Vec::new();
        let mut current_handles = Vec::new();
        let mut complete = revision_valid;
        let tools = {
            let mut tools = builtin_tools;
            let configured_count = settings
                .mcp_servers
                .len()
                .saturating_sub(plugins.mcp_configs.len());
            for (index, server) in settings.mcp_servers.iter().enumerate() {
                if !settings.mcp_server_enabled(&server.name) {
                    continue;
                }
                let source = if index < configured_count {
                    None
                } else {
                    Some(
                        plugins
                            .mcp_config_sources
                            .get(index - configured_count)
                            .context("Plugin MCP source identity is missing")?,
                    )
                };
                let server_key = McpServerKey {
                    config: serde_json::to_value(server)?,
                    source: source.cloned(),
                    operation_id: source
                        .and_then(|source| plugins.managed_operations.get(&source.plugin_id))
                        .cloned(),
                    trust_profile: paths.config_dir.clone(),
                    project_root: paths.project_root.clone(),
                    project_server: project_mcp_names.contains(&server.name),
                    credential_store: settings.credential_store,
                    authorization: mcp_connection::authorization_revisions(
                        std::slice::from_ref(server),
                        &paths.config_dir,
                        settings.credential_store,
                    )
                    .await
                    .unwrap_or_default(),
                };
                if revision_valid
                    && let Some(cached) = servers.iter().find(|cached| cached.key == server_key)
                {
                    for tool in cached.tools.all() {
                        tools.try_register(tool)?;
                    }
                    self.record_mcp_attempt(
                        server,
                        kcoder_app_protocol::McpConnectionAttemptStatus::Ready,
                    );
                    current_keys.push(server_key);
                    current_handles.push(Arc::clone(&cached.handle));
                    continue;
                }
                let private = kcoder_mcp::tool::PrivateValues::new(
                    source
                        .and_then(|source| plugins.managed_operations.get(&source.plugin_id))
                        .and_then(|operation| private_values.get(operation))
                        .into_iter()
                        .flat_map(|values| values.values().cloned()),
                )?;
                let (handle, mut definitions) = match tokio::time::timeout_at(
                    deadline,
                    mcp_connection::connect_private(
                        server,
                        Arc::clone(&private),
                        &paths.config_dir,
                        settings.credential_store,
                    ),
                )
                .await
                {
                    Ok(Ok(connected)) => connected,
                    failure => {
                        complete = false;
                        let reason = match failure {
                            Ok(Err(error)) => kcoder_mcp::failure::failure_reason(&error),
                            Err(_) => kcoder_types::mcp_failure::McpFailureReason::TimedOut,
                            Ok(Ok(_)) => unreachable!(),
                        };
                        self.record_mcp_attempt(
                            server,
                            kcoder_app_protocol::McpConnectionAttempt {
                                status: if reason
                                    == kcoder_types::mcp_failure::McpFailureReason::TimedOut
                                {
                                    kcoder_app_protocol::McpConnectionAttemptStatus::TimedOut
                                } else {
                                    kcoder_app_protocol::McpConnectionAttemptStatus::Unavailable
                                },
                                failure_reason: Some(reason),
                            },
                        );
                        tracing::warn!(server = %server.name, ?reason, "MCP connection failed for new conversation");
                        continue;
                    }
                };
                self.record_mcp_attempt(
                    server,
                    kcoder_app_protocol::McpConnectionAttemptStatus::Ready,
                );
                if let Some(source) = source {
                    definitions.retain(|definition| source.tool_policy.allows(&definition.name));
                }
                let mut server_tools = ToolRegistry::new();
                for definition in definitions {
                    let tool =
                        kcoder_mcp::McpTool::new(&server.name, Arc::clone(&handle), definition)
                            .with_credential_context(
                                kcoder_mcp::server_policy::CredentialContext {
                                    config_dir: paths.config_dir.clone(),
                                    mode: settings.credential_store,
                                },
                            );
                    let tool = match source {
                        Some(source) => tool
                            .with_plugin_source(&source.plugin_id)
                            .with_private_values(Arc::clone(&private))?,
                        None => tool,
                    };
                    let required_trust = source
                        .and_then(|source| source.required_trust_directory.as_deref())
                        .or_else(|| {
                            project_mcp_names
                                .contains(&server.name)
                                .then_some(paths.project_root.as_path())
                        });
                    let tool = match required_trust {
                        Some(directory) => tool.with_folder_trust(directory, &paths.config_dir),
                        None => tool,
                    };
                    let tool = Arc::new(tool) as Arc<dyn Tool>;
                    server_tools.try_register(Arc::clone(&tool))?;
                    tools.try_register(tool)?;
                }
                self.track_mcp_connection(server, &handle, &server_tools)?;
                current_handles.push(Arc::clone(&handle));
                if revision_valid {
                    if servers.len() >= 64 {
                        servers.remove(0);
                    }
                    current_keys.push(McpServerKey {
                        credential_store: server_key.credential_store,
                        config: serde_json::to_value(server)?,
                        source: source.cloned(),
                        operation_id: source
                            .and_then(|source| plugins.managed_operations.get(&source.plugin_id))
                            .cloned(),
                        trust_profile: paths.config_dir.clone(),
                        project_root: paths.project_root.clone(),
                        project_server: project_mcp_names.contains(&server.name),
                        authorization: server_key.authorization.clone(),
                    });
                    servers.push(CachedMcpServer {
                        key: server_key,
                        tools: server_tools,
                        handle,
                        _plugin_leases: plugins.version_leases.clone(),
                    });
                }
            }
            tools.filtered_out_by_patterns(&settings.tools.disabled)
        };
        servers.retain(|cached| current_keys.iter().any(|key| key == &cached.key));
        // Retry unavailable servers on the next session instead of caching a partial snapshot.
        if complete {
            *cache = Some(CachedMcpSnapshot {
                key,
                tools: tools.clone(),
                handles: current_handles,
                _plugin_leases: plugins.version_leases.clone(),
            });
        }
        Ok(tools)
    }
}

#[cfg(test)]
mod permission_override_tests {
    use super::*;
    use clap::Parser;
    use std::fs;

    fn configuration(cwd: &std::path::Path, args: &[&str]) -> SessionConfiguration {
        let cli = Cli::try_parse_from(args).expect("valid test CLI arguments");
        let loader = SettingsLoader::new(cwd)
            .with_config_dir(cwd.join("user-config"))
            .with_executable_dir(cwd.join("executable"))
            .with_overlay_files(cli.settings_files.clone());
        SessionConfiguration::new(loader, cli)
    }

    #[test]
    fn user_settings_default_is_not_reported_as_a_cli_permission_override() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("user-config")).unwrap();
        fs::write(
            temp.path().join("user-config/settings.json"),
            r#"{"permission_mode":"auto"}"#,
        )
        .unwrap();

        let configuration = configuration(temp.path(), &["kcoder"]);

        assert_eq!(configuration.cli_permission_mode_override().unwrap(), None);
        assert_eq!(
            configuration
                .loader
                .load()
                .unwrap()
                .settings
                .permission_mode,
            kcoder_config::PermissionMode::Auto
        );
    }

    #[test]
    fn template_permission_detection_reads_the_template_file_not_merged_overlays() {
        let temp = tempfile::tempdir().unwrap();
        let overlay = temp.path().join("cli-settings.json");
        let template = temp.path().join("template.json");
        fs::write(&overlay, r#"{"permission_mode":"bypass"}"#).unwrap();
        fs::write(&template, r#"{"model":"template-model"}"#).unwrap();
        let configuration = configuration(
            temp.path(),
            &["kcoder", "--settings-file", overlay.to_str().unwrap()],
        );

        assert_eq!(
            configuration.cli_permission_mode_override().unwrap(),
            Some(kcoder_config::PermissionMode::Bypass)
        );
        assert!(
            !configuration
                .template_sets_permission_mode(template.clone())
                .unwrap()
        );

        fs::write(&template, r#"{"permission_mode":"ask"}"#).unwrap();
        assert!(
            configuration
                .template_sets_permission_mode(template)
                .unwrap()
        );
    }
}

#[cfg(test)]
mod model_refresh_source_tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn mcp_activation_participates_in_snapshot_identity() {
        let root = tempfile::tempdir().unwrap();
        let paths = SettingsLoader::new(root.path())
            .with_config_dir(root.path())
            .paths()
            .unwrap();
        let plugins = EffectivePluginSnapshot::default();
        let mut settings = Settings::default();
        settings.mcp_servers.push(
            serde_json::from_value(serde_json::json!({
                "name":"disabled-service", "command":"must-not-start-nonexistent-mcp"
            }))
            .unwrap(),
        );
        settings
            .mcp_disabled_servers
            .push("disabled-service".into());
        let disabled = McpSnapshotKey::new(&settings, &plugins, &paths).unwrap();
        settings.mcp_disabled_servers.clear();
        let enabled = McpSnapshotKey::new(&settings, &plugins, &paths).unwrap();
        assert!(disabled != enabled);
        settings.credential_store = kcoder_config::CredentialStoreMode::File;
        let file = McpSnapshotKey::new(&settings, &plugins, &paths).unwrap();
        settings.credential_store = kcoder_config::CredentialStoreMode::Keyring;
        assert!(file != McpSnapshotKey::new(&settings, &plugins, &paths).unwrap());
    }

    #[test]
    fn model_refresh_preserves_root_overlay_and_cli_priority() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("config");
        std::fs::create_dir(&home).unwrap();
        std::fs::write(
            home.join("settings.json"),
            serde_json::json!({
                "active_provider":"fixture", "providers":{"fixture":{
                    "api_format":"openai_chat_completions", "endpoint":"http://127.0.0.1:1/v1",
                    "default_model":"test", "context_window_tokens":32000,
                    "max_output_tokens":2048, "output_headroom_tokens":1024
                }}
            })
            .to_string(),
        )
        .unwrap();
        let overlay = temp.path().join("template.json");
        std::fs::write(&overlay, r#"{"max_tokens":128}"#).unwrap();
        let loader = SettingsLoader::new(temp.path())
            .with_config_dir(&home)
            .with_executable_dir(temp.path())
            .with_overlay_files([overlay.clone()]);
        let mut cli = Cli::parse_from(["kcoder"]);
        cli.max_tokens = None;
        let config = SessionConfiguration::new(loader, cli)
            .freeze_model_overlays()
            .unwrap();
        let source = config.model_source();
        assert_eq!(
            source.settings("fixture::test").unwrap().max_tokens,
            Some(128)
        );
        std::fs::write(&overlay, r#"{"max_tokens":256}"#).unwrap();
        assert_eq!(
            source.settings("fixture::test").unwrap().max_tokens,
            Some(128)
        );
        let mut explicit_cli = config;
        explicit_cli.cli.max_tokens = Some(512);
        assert_eq!(
            explicit_cli
                .model_source()
                .settings("fixture::test")
                .unwrap()
                .max_tokens,
            Some(512)
        );
    }
    #[tokio::test]
    async fn new_session_registry_reloads_profile_and_preserves_existing_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let config = SessionConfiguration::new(
            SettingsLoader::new(temp.path()).with_config_dir(temp.path()),
            Cli::parse_from(["kcoder"]),
        );
        let plugins = EffectivePluginSnapshot::default();
        let mut settings = Settings::default();
        let full = config.tools(&settings, &plugins).await.unwrap();
        std::fs::write(
            temp.path().join("settings.json"),
            r#"{"tools":{"profile":"nano"}}"#,
        )
        .unwrap();
        settings = config.settings(temp.path(), true).unwrap();
        assert_eq!(settings.tools.profile, kcoder_config::ToolProfile::Nano);
        let nano = config.tools(&settings, &plugins).await.unwrap();
        assert!(full.names().len() > nano.names().len());
        assert!(nano.names().contains(&"CtxInspect".to_owned()));
        let full_names = full.names();
        settings.tools.profile = kcoder_config::ToolProfile::None;
        // None must not even attempt to connect a configured MCP endpoint.
        settings.mcp_servers.push(
            serde_json::from_value(serde_json::json!({
                "name":"unreachable", "transport":"stdio", "command":"does-not-exist"
            }))
            .unwrap(),
        );
        assert!(
            config
                .tools(&settings, &plugins)
                .await
                .unwrap()
                .names()
                .is_empty()
        );
        assert!(
            config
                .mcp_connection_attempt(&settings.mcp_servers[0])
                .is_none()
        );
        assert_eq!(full.names(), full_names);
        settings.mcp_servers.clear();
        settings.tools.profile = kcoder_config::ToolProfile::Full;
        assert_eq!(
            config.tools(&settings, &plugins).await.unwrap().names(),
            full_names
        );
    }

    #[tokio::test]
    async fn explicit_profile_survives_settings_reload_and_disabled_filter() {
        let temp = tempfile::tempdir().unwrap();
        let config = SessionConfiguration::new(
            SettingsLoader::new(temp.path()).with_config_dir(temp.path()),
            Cli::parse_from(["kcoder", "--tool-profile", "nano"]),
        );
        let mut settings = Settings::default();
        settings.tools.profile = kcoder_config::ToolProfile::None;
        let plugins = EffectivePluginSnapshot::default();
        let tools = config.tools(&settings, &plugins).await.unwrap();
        assert!(tools.names().contains(&"CtxInspect".to_owned()));
        settings.tools.disabled.push("CtxInspect".into());
        assert!(
            !config
                .tools(&settings, &plugins)
                .await
                .unwrap()
                .names()
                .contains(&"CtxInspect".to_owned())
        );
    }

    #[tokio::test]
    async fn resident_provider_rejects_removed_stored_credentials_without_legacy_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let loader = SettingsLoader::new(temp.path()).with_config_dir(temp.path());
        let path = loader.paths().unwrap().credentials;
        std::fs::write(&path, r#"{"openai":{"type":"api","key":"fixture-old"}}"#).unwrap();
        let mut settings = Settings::default();
        settings.providers.clear();
        settings.active_provider = None;
        settings.provider = Some("openai".into());
        settings.api_format = Some(kcoder_config::ApiFormat::OpenaiChatCompletions);
        settings.model = "fixture-model".into();
        settings.openai_base_url = Some("http://127.0.0.1:9/v1".into());
        settings.openai_api_key = Some("fixture-old".into());
        settings.openai_base_url = Some("http://127.0.0.1:1/v1".into());
        settings.credential_store = kcoder_config::CredentialStoreMode::File;
        loader
            .refresh_stored_provider_credentials(&mut settings)
            .unwrap();
        let config = SessionConfiguration::new(loader, Cli::parse_from(["kcoder"]));
        let provider = config
            .provider_for_kind(&settings, ProviderKind::Openai)
            .unwrap();
        let request = kcoder_types::MessagesRequest::new("fixture-model", vec![]);
        assert!(provider.count_tokens(request.clone()).await.is_ok());
        std::fs::write(&path, r#"{"openai":{"type":"api","key":"fixture-new"}}"#).unwrap();
        assert!(provider.count_tokens(request.clone()).await.is_ok());
        std::fs::write(&path, "{}").unwrap();
        let error = provider.count_tokens(request).await.unwrap_err();
        assert!(
            matches!(&error, kcoder_api::ApiErrorKind::Api { error_type, .. } if error_type == "authentication_error")
        );
        assert!(!error.to_string().contains("fixture-old"));
    }
}

#[cfg(test)]
mod mcp_trust_cache_tests {
    use super::*;

    #[test]
    fn identical_transport_from_project_configuration_has_a_distinct_trust_cache_key() {
        let temp = tempfile::tempdir().unwrap();
        let paths =
            kcoder_config::ConfigPaths::with_config_dir(temp.path(), temp.path().join("profile"));
        let settings = Settings::default();
        let plugins = EffectivePluginSnapshot::default();
        let user = McpSnapshotKey::new(&settings, &plugins, &paths).unwrap();
        std::fs::create_dir_all(temp.path().join(".kcoder")).unwrap();
        std::fs::write(
            &paths.project_settings,
            r#"{"mcp_servers":[{"name":"probe"}]}"#,
        )
        .unwrap();
        let project = McpSnapshotKey::new(&settings, &plugins, &paths).unwrap();
        assert!(user != project);
        assert_eq!(
            project.project_servers.into_iter().collect::<Vec<_>>(),
            vec!["probe"]
        );
    }
}

#[cfg(test)]
mod mcp_connection_attempt_tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn connection_result_does_not_follow_changed_config_or_another_profile() {
        let temp = tempfile::tempdir().unwrap();
        let make = || {
            SessionConfiguration::new(
                SettingsLoader::new(temp.path()).with_config_dir(temp.path()),
                Cli::parse_from(["kcoder"]),
            )
        };
        let configuration = make();
        let mut server: kcoder_mcp::McpServerConfig = serde_json::from_value(
            serde_json::json!({"name":"fixture","transport":"stdio","command":"old"}),
        )
        .unwrap();
        configuration.record_mcp_attempt(
            &server,
            kcoder_app_protocol::McpConnectionAttemptStatus::Unavailable,
        );
        assert_eq!(
            configuration.mcp_connection_attempt(&server),
            Some(kcoder_app_protocol::McpConnectionAttemptStatus::Unavailable.into())
        );
        assert_eq!(make().mcp_connection_attempt(&server), None);
        server.command = "new".into();
        assert_eq!(configuration.mcp_connection_attempt(&server), None);
    }
}

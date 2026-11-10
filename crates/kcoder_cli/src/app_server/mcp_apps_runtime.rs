//! Dedicated MCP Apps connections bound to a resident conversation and its policy.
use anyhow::{Context, Result, ensure};
use kcoder_engine::QueryEngine;
use kcoder_tools::{Tool, ToolRegistry, ToolSource};
use kcoder_types::widgets::WidgetTurnBinding;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub struct ConfiguredAppSource {
    pub config: kcoder_mcp::McpServerConfig,
    pub plugin_id: Option<String>,
    pub policy: Option<kcoder_plugins::EffectiveMcpToolPolicy>,
    pub required_trust: Option<PathBuf>,
}

/// Project the explicitly configured and plugin-provided app sources.
pub fn configured_app_sources(
    settings: &kcoder_config::Settings,
    plugins: kcoder_plugins::EffectivePluginSnapshot,
    settings_contain_plugin_mcp: bool,
) -> Vec<ConfiguredAppSource> {
    let count = if !settings_contain_plugin_mcp {
        settings.mcp_servers.len()
    } else {
        settings
            .mcp_servers
            .len()
            .saturating_sub(plugins.mcp_configs.len())
    };
    let mut result = settings
        .mcp_servers
        .iter()
        .take(count)
        .cloned()
        .map(|config| ConfiguredAppSource {
            config,
            plugin_id: None,
            policy: None,
            required_trust: None,
        })
        .collect::<Vec<_>>();
    for (config, source) in plugins
        .mcp_configs
        .into_iter()
        .zip(plugins.mcp_config_sources)
    {
        result.push(ConfiguredAppSource {
            config,
            plugin_id: Some(source.plugin_id),
            policy: Some(source.tool_policy),
            required_trust: source.required_trust_directory,
        });
    }
    result.retain(|source| settings.mcp_server_enabled(&source.config.name));
    result
}
pub type LoadAppSources =
    Arc<dyn Fn() -> Result<(kcoder_config::Settings, Vec<ConfiguredAppSource>)> + Send + Sync>;

fn source_proof(source: &ConfiguredAppSource, settings: &kcoder_config::Settings) -> Result<Value> {
    Ok(
        json!({"config":serde_json::to_value(&source.config)?,"tools":serde_json::to_value(&settings.tools)?,"modelTools":settings.model_capabilities.tools,"plugin":source.plugin_id,"trust":source.required_trust,"enabledTools":source.policy.as_ref().map(|policy|&policy.enabled_tools),"disabledTools":source.policy.as_ref().map(|policy|&policy.disabled_tools)}),
    )
}

pub struct AppConnection {
    pub thread_id: String,
    pub connection_id: String,
    pub handle: kcoder_mcp::McpServerHandle,
    pub tools: HashMap<String, Arc<kcoder_mcp::McpTool>>,
    pub revoked: Arc<AtomicBool>,
    pub cancel: CancellationToken,
    pub lease: Arc<tokio::sync::RwLock<()>>,
    pub action_gate: Arc<Mutex<()>>,
    pub resources_enabled: bool,
    pub session_directory: PathBuf,
    resource_readers: std::sync::Mutex<
        HashMap<
            (String, String, String),
            Arc<kcoder_engine::integrations::core::NativeResourceReadAuthority>,
        >,
    >,
    config: Value,
    _plugin_leases: Arc<kcoder_plugins::EffectivePluginSnapshot>,
    server_name: String,
    plugin_id: Option<String>,
}
impl AppConnection {
    pub fn resource_reader(
        &self,
        widget: &kcoder_types::widgets::WidgetRef,
        raw_tool: &str,
    ) -> Result<Arc<kcoder_engine::integrations::core::NativeResourceReadAuthority>> {
        ensure!(
            self.live() && widget.identity.thread_id == self.thread_id,
            "TASK_RESOURCE_APP_OWNER_CHANGED"
        );
        self.resource_reader_for(
            &widget.identity.turn_id,
            &widget.identity.attempt_id,
            raw_tool,
        )
    }
    pub(super) fn resource_reader_for(
        &self,
        turn: &str,
        attempt: &str,
        raw_tool: &str,
    ) -> Result<Arc<kcoder_engine::integrations::core::NativeResourceReadAuthority>> {
        self.resource_readers
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_RESOURCE_APP_OWNER_UNAVAILABLE"))?
            .get(&(turn.into(), attempt.into(), raw_tool.into()))
            .cloned()
            .context("TASK_RESOURCE_ORIGINAL_APP_EMITTER_REQUIRED")
    }
    pub fn live(&self) -> bool {
        !self.revoked.load(Ordering::SeqCst)
            && self
                .tools
                .values()
                .next()
                .is_some_and(|tool| tool.app_authority_current())
            && self
                .handle
                .try_lock()
                .ok()
                .is_none_or(|mut client| client.connection_failure_reason().is_none())
    }
    pub fn revoke(&self) {
        self.revoked.store(true, Ordering::SeqCst);
        self.cancel.cancel();
        if let Ok(mut readers) = self.resource_readers.lock() {
            readers.clear();
        }
    }
}
#[derive(Debug, Default)]
pub struct McpAppsRuntime;
impl McpAppsRuntime {
    pub async fn prepare_turn(
        &mut self,
        load_sources: LoadAppSources,
        engine: QueryEngine,
        binding: WidgetTurnBinding,
        cancel: &CancellationToken,
        scope: super::mcp_apps_registry::Preparation,
    ) -> QueryEngine {
        if !engine.isolated_widgets_enabled()
            || binding.thread_id != scope.thread
            || !scope.current()
        {
            return engine;
        }
        let names: HashSet<_> = engine
            .effective_tool_catalog()
            .await
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        let templates = engine
            .active_tool_registry()
            .all()
            .into_iter()
            .filter(|tool| names.contains(&tool.name()))
            .filter(|tool| {
                matches!(
                    tool.source(),
                    ToolSource::Mcp { .. } | ToolSource::Plugin { .. }
                )
            })
            .collect::<Vec<_>>();
        if templates.is_empty() {
            return engine;
        }
        let (fresh_settings, current) = match load_sources() {
            Ok(current) => current,
            Err(_) => return engine,
        };
        let settings = engine
            .settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if matches!(
            settings.tools.profile,
            kcoder_config::ToolProfile::Nano | kcoder_config::ToolProfile::None
        ) {
            return engine;
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        let mut replacements: HashMap<String, Arc<dyn Tool>> = HashMap::new();
        let mut sources = HashSet::new();
        for entry in scope.registry.snapshot() {
            if !entry.live() {
                scope.registry.remove(&entry.connection_id);
            }
        }
        for template in &templates {
            if tokio::time::Instant::now() >= deadline || !scope.current() {
                break;
            }
            let (server_name, plugin_id) = match template.source() {
                ToolSource::Mcp { server, .. } => (server, None),
                ToolSource::Plugin { server, plugin, .. } => (server, Some(plugin)),
                _ => continue,
            };
            if !sources.insert((server_name.clone(), plugin_id.clone())) {
                continue;
            }
            let selected = current
                .iter()
                .filter(|source| source.config.name == server_name && source.plugin_id == plugin_id)
                .collect::<Vec<_>>();
            if selected.len() != 1 {
                continue;
            }
            let selected = selected[0];
            let config = match source_proof(selected, &fresh_settings) {
                Ok(config) => config,
                Err(_) => continue,
            };
            if !settings.mcp_servers.iter().any(|source| {
                source.name == server_name
                    && serde_json::to_value(source).is_ok_and(|source| source == config["config"])
            }) {
                continue;
            }
            let existing = scope.registry.snapshot().into_iter().find(|entry| {
                entry.thread_id == binding.thread_id
                    && entry.server_name == server_name
                    && entry.plugin_id == plugin_id
                    && entry.config == config
                    && entry.live()
            });
            let entry = if let Some(existing) = existing {
                existing
            } else {
                if !scope.registry.has_capacity() || !scope.current() {
                    continue;
                }
                let any: &dyn std::any::Any = template.as_ref();
                let Some(original) = any.downcast_ref::<kcoder_mcp::McpTool>() else {
                    continue;
                };
                let proof_config = config.clone();
                let proof_server = server_name.clone();
                let proof_plugin = plugin_id.clone();
                let load_current_sources = Arc::clone(&load_sources);
                let revoked = Arc::new(AtomicBool::new(false));
                let proof_revoked = Arc::clone(&revoked);
                let authorized: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
                    !proof_revoked.load(Ordering::SeqCst)
                        && load_current_sources().is_ok_and(|(settings, sources)| {
                            let matching = sources
                                .into_iter()
                                .filter(|source| {
                                    source.config.name == proof_server
                                        && source.plugin_id == proof_plugin
                                })
                                .collect::<Vec<_>>();
                            matching.len() == 1
                                && source_proof(&matching[0], &settings)
                                    .is_ok_and(|current| current == proof_config)
                        })
                });
                let store = if selected.config.transport == "http"
                    && selected.config.policy.credential_ref.is_none()
                {
                    match kcoder_plugin_rpc::mcp_authorization::token_store_for(&selected.config) {
                        Ok(store) => Some(store),
                        Err(_) => continue,
                    }
                } else {
                    None
                };
                let connected = tokio::select! {biased;_ = cancel.cancelled()=>return engine,_=scope.revoked()=>{cancel.cancel();return engine}, result=tokio::time::timeout_at(deadline,original.connect_for_app(&selected.config,store,Arc::clone(&authorized)))=>result};
                let Ok(Ok((handle, tools))) = connected else {
                    continue;
                };
                let connection_id = match handle.lock().await.app_connection_id() {
                    Some(id) => id.to_owned(),
                    None => continue,
                };
                let resources_enabled = handle.lock().await.resources_supported();
                let mut allowed = HashMap::new();
                let mut exposed = HashSet::new();
                let mut ambiguous = false;
                for tool in tools {
                    let name = tool.name();
                    if tool.is_model_visible() && !names.contains(&name) {
                        continue;
                    }
                    if engine
                        .tools
                        .source(&name)
                        .is_some_and(|source| source != &tool.source())
                    {
                        continue;
                    }
                    if !exposed.insert(name.clone()) {
                        ambiguous = true;
                        break;
                    }
                    if !settings.tools.luna.allowed.contains(&name) {
                        continue;
                    }
                    if let Some(policy) =
                        engine.plugin_snapshot().mcp_tool_policies.get(&server_name)
                        && !policy.allows(
                            match tool.source() {
                                ToolSource::Mcp { tool, .. } | ToolSource::Plugin { tool, .. } => {
                                    tool
                                }
                                _ => String::new(),
                            }
                            .as_str(),
                        )
                    {
                        continue;
                    }
                    let raw = match tool.source() {
                        ToolSource::Mcp { tool, .. } | ToolSource::Plugin { tool, .. } => tool,
                        _ => continue,
                    };
                    if selected
                        .policy
                        .as_ref()
                        .is_some_and(|policy| !policy.allows(&raw))
                    {
                        continue;
                    }
                    let tool = Arc::new(tool);
                    let mut candidate = ToolRegistry::new();
                    if candidate.try_register(tool.clone()).is_err()
                        || candidate
                            .filtered_out_by_patterns(&settings.tools.disabled)
                            .get(&name)
                            .is_none()
                    {
                        continue;
                    }
                    if allowed.insert(raw, tool).is_some() {
                        continue;
                    }
                }
                if ambiguous {
                    continue;
                }
                let entry = Arc::new(AppConnection {
                    thread_id: binding.thread_id.clone(),
                    connection_id: connection_id.clone(),
                    handle,
                    tools: allowed,
                    revoked,
                    cancel: CancellationToken::new(),
                    lease: Arc::new(tokio::sync::RwLock::new(())),
                    action_gate: Arc::new(Mutex::new(())),
                    resources_enabled,
                    session_directory: match store_directory(&engine, &binding.thread_id) {
                        Ok(path) => path,
                        Err(_) => continue,
                    },
                    resource_readers: std::sync::Mutex::new(HashMap::new()),
                    config: config.clone(),
                    _plugin_leases: engine.plugin_snapshot(),
                    server_name: server_name.clone(),
                    plugin_id: plugin_id.clone(),
                });
                if !scope.registry.insert(&scope, Arc::clone(&entry)) {
                    continue;
                }
                entry
            };
            // Each retained widget uses its actual original turn/emitter, including
            // when this same dedicated App connection is reused by another turn.
            let mut readers = match entry.resource_readers.lock() {
                Ok(readers) => readers,
                Err(_) => continue,
            };
            let additions = templates
                .iter()
                .filter(|tool| match tool.source() {
                    ToolSource::Mcp { server, .. } => server == server_name && plugin_id.is_none(),
                    ToolSource::Plugin { server, plugin, .. } => {
                        server == server_name && plugin_id.as_ref() == Some(&plugin)
                    }
                    _ => false,
                })
                .filter_map(|tool| {
                    let raw = match tool.source() {
                        ToolSource::Mcp { tool, .. } | ToolSource::Plugin { tool, .. } => tool,
                        _ => return None,
                    };
                    let reader = engine.native_resource_read_authority(&tool.name())?;
                    Some((
                        (binding.turn_id.clone(), binding.attempt_id.clone(), raw),
                        reader,
                    ))
                })
                .collect::<Vec<_>>();
            if readers.len()
                + additions
                    .iter()
                    .filter(|(key, _)| !readers.contains_key(key))
                    .count()
                > 128
            {
                continue;
            }
            readers.extend(additions);
            drop(readers);
            for inner in entry.tools.values() {
                let wrapped = super::mcp_apps_tool::McpPresentationTool {
                    inner: Arc::clone(inner),
                    binding: binding.clone(),
                    owner: Arc::clone(&entry),
                    session_directory: match store_directory(&engine, &binding.thread_id) {
                        Ok(path) => path,
                        Err(_) => return engine,
                    },
                };
                replacements.insert(wrapped.name(), Arc::new(wrapped));
            }
        }
        if replacements.is_empty() {
            return engine;
        }
        let mut registry = ToolRegistry::new();
        for tool in engine.tools.all() {
            if !replacements.contains_key(&tool.name()) && registry.try_register(tool).is_err() {
                return engine;
            }
        }
        for (_, tool) in replacements {
            if registry.try_register(tool).is_err() {
                return engine;
            }
        }
        registry = registry.filtered_out_by_patterns(&settings.tools.disabled);
        engine.with_turn_tools(registry)
    }
}

/// Tools use the authoritative artifact location, which may follow a restored history file.
pub fn store_directory(engine: &QueryEngine, thread_id: &str) -> Result<std::path::PathBuf> {
    let session = &engine.state;
    ensure!(
        session.session_id() == thread_id && session.artifact_session_id() == thread_id,
        "invalid_widget: current session artifact owner does not match the requested thread"
    );
    let root = session
        .session_artifact_project_dir()
        .context("artifact_unavailable: this session has no durable artifact directory")?;
    Ok(kcoder_state::session_dir_path(&root, thread_id))
}

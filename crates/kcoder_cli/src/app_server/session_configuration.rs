use anyhow::{Context, Result};
use kcoder_api::{MissingApiKeyError, Provider, ProviderFactory, ProviderKind};
use kcoder_config::{Settings, SettingsLoader};
use kcoder_plugins::{EffectiveMcpContribution, EffectivePluginSnapshot};
use kcoder_tools::{Tool, ToolRegistry};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

#[derive(Clone)]
pub(super) struct SessionConfiguration {
    loader: SettingsLoader,
    cli: crate::Cli,
    builtin_tools: ToolRegistry,
    mcp_cache: Arc<Mutex<Option<(McpSnapshotKey, ToolRegistry)>>>,
}

#[derive(PartialEq)]
struct McpSnapshotKey {
    configs: Value,
    sources: Vec<EffectiveMcpContribution>,
    generation: u64,
    disabled: Vec<String>,
    authorization_revisions: Vec<String>,
}

impl McpSnapshotKey {
    fn new(settings: &Settings, plugins: &EffectivePluginSnapshot) -> Result<Self> {
        Ok(Self {
            configs: serde_json::to_value(&settings.mcp_servers)?,
            sources: plugins.mcp_config_sources.clone(),
            generation: plugins.generation,
            disabled: settings.tools.disabled.clone(),
            authorization_revisions: Vec::new(),
        })
    }
}

impl SessionConfiguration {
    pub(super) fn new(
        loader: SettingsLoader,
        cli: crate::Cli,
        builtin_tools: ToolRegistry,
    ) -> Self {
        Self {
            loader,
            cli,
            builtin_tools,
            mcp_cache: Arc::new(Mutex::new(None)),
        }
    }

    /// Returns this configuration with a session settings template layered in.
    ///
    /// The template sits *below* explicit CLI overlays, so `--settings-file`
    /// keeps the final word. Content is read live; the recorded binding
    /// revision is what lets callers detect drift after the fact.
    pub(super) fn with_template(&self, path: std::path::PathBuf) -> Self {
        Self {
            loader: self.loader.clone().with_prepended_overlay_files([path]),
            cli: self.cli.clone(),
            builtin_tools: self.builtin_tools.clone(),
            mcp_cache: Arc::new(Mutex::new(None)),
        }
    }

    pub(super) fn seed_mcp(
        &mut self,
        settings: &Settings,
        plugins: &EffectivePluginSnapshot,
        tools: &ToolRegistry,
    ) -> Result<()> {
        if settings
            .mcp_servers
            .iter()
            .any(|server| server.transport == "http")
        {
            return Ok(());
        }
        *self
            .mcp_cache
            .try_lock()
            .context("session configuration cache is busy")? =
            Some((McpSnapshotKey::new(settings, plugins)?, tools.clone()));
        Ok(())
    }

    pub(super) fn settings(&self, cwd: &std::path::Path, trusted: bool) -> Result<Settings> {
        let mut settings = self
            .loader
            .load()
            .context("Cannot reload configuration for a new conversation")?
            .settings;
        crate::apply_cli_settings_overrides(&mut settings, &self.cli)?;
        if let Some(path) = self.cli.credential_env_file.as_deref() {
            crate::apply_credential_env_file(&mut settings, path)?;
        }
        if !trusted {
            let project_names = crate::project_mcp_server_names(cwd);
            settings
                .mcp_servers
                .retain(|server| !project_names.contains(&server.name));
        }
        Ok(settings)
    }

    pub(super) fn mcp_user_settings_path(&self) -> Result<std::path::PathBuf> {
        let loaded = self.loader.load()?;
        let covered = |field: &str| field == "mcp_servers" || field.starts_with("mcp_servers.");
        if loaded.overlay_fields.iter().any(|field| covered(field))
            || loaded.field_sources.iter().any(|(field, scope)| {
                covered(field)
                    && matches!(
                        scope,
                        kcoder_config::ConfigScope::Project | kcoder_config::ConfigScope::Local
                    )
            })
        {
            anyhow::bail!(
                "MCP settings are controlled by a project or read-only overlay; edit that source instead"
            );
        }
        Ok(loaded.paths.user_settings)
    }

    pub(super) fn provider(&self, settings: &Settings) -> Result<Arc<dyn Provider>> {
        let kind = crate::resolve_cli_provider_kind(&self.cli, ProviderKind::from_env(), settings)?;
        match ProviderFactory::new(settings)
            .with_overrides(crate::provider_overrides_from_cli(&self.cli))
            .build(kind, &settings.model)
        {
            Ok(provider) => Ok(provider),
            Err(error) if error.downcast_ref::<MissingApiKeyError>().is_some() => {
                Ok(Arc::new(crate::SignedOutProvider {
                    name: kind.as_str(),
                    error_message: error.to_string(),
                }))
            }
            Err(error) => Err(error).context("Cannot initialize the new conversation provider"),
        }
    }

    pub(super) async fn tools(
        &self,
        settings: &Settings,
        plugins: &EffectivePluginSnapshot,
    ) -> Result<ToolRegistry> {
        if self.builtin_tools.names().is_empty() {
            return Ok(self.builtin_tools.clone());
        }
        let mut key = McpSnapshotKey::new(settings, plugins)?;
        let revision_valid =
            match crate::mcp_connection::authorization_revisions(&settings.mcp_servers).await {
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
        if revision_valid {
            if let Some((cached_key, tools)) = cache.as_ref() {
                if cached_key == &key {
                    return Ok(tools.clone());
                }
            }
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let mut complete = revision_valid;
        let tools = {
            let mut tools = self.builtin_tools.clone();
            let configured_count = settings
                .mcp_servers
                .len()
                .saturating_sub(plugins.mcp_configs.len());
            for (index, server) in settings.mcp_servers.iter().enumerate() {
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
                let (handle, mut definitions) = match tokio::time::timeout_at(
                    deadline,
                    crate::mcp_connection::connect(server),
                )
                .await
                {
                    Ok(Ok(connected)) => connected,
                    failure => {
                        complete = false;
                        let detail = match failure {
                            Ok(Err(error)) => format!("{error:#}"),
                            Err(_) => "MCP connection timed out".to_owned(),
                            Ok(Ok(_)) => unreachable!(),
                        };
                        tracing::warn!(server = %server.name, "MCP unavailable for new conversation: {detail}");
                        continue;
                    }
                };
                if let Some(source) = source {
                    definitions.retain(|definition| source.tool_policy.allows(&definition.name));
                }
                for definition in definitions {
                    let tool =
                        kcoder_mcp::McpTool::new(&server.name, Arc::clone(&handle), definition);
                    let tool = match source {
                        Some(source) => tool.with_plugin_source(&source.plugin_id),
                        None => tool,
                    };
                    tools.try_register(Arc::new(tool) as Arc<dyn Tool>)?;
                }
            }
            tools.filtered_out_by_patterns(&settings.tools.disabled)
        };
        // Retry unavailable servers on the next session instead of caching a partial snapshot.
        if complete {
            *cache = Some((key, tools.clone()));
        }
        Ok(tools)
    }
}

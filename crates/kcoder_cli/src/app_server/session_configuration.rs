mod tool_profiles;
#[cfg(test)]
mod credential_http_tests;

use anyhow::{Context, Result};
use kcoder_api::{Provider, ProviderKind};
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
    mcp_cache: Arc<Mutex<Option<CachedMcpSnapshot>>>,
    mcp_attempts: Arc<
        std::sync::Mutex<
            std::collections::BTreeMap<
                String,
                (Value, kcoder_app_protocol::McpConnectionAttemptStatus),
            >,
        >,
    >,
}

struct CachedMcpSnapshot {
    key: McpSnapshotKey,
    tools: ToolRegistry,
    _plugin_leases: Vec<Arc<kcoder_plugins::PluginVersionLease>>,
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
    authorization_revisions: Vec<String>,
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
            project_servers: crate::project_mcp_server_names(&paths.project_root),
            trust_profile: paths.config_dir.clone(),
            project_root: paths.project_root.clone(),
            sources: plugins.mcp_config_sources.clone(),
            generation: plugins.generation,
            disabled: settings.tools.disabled.clone(),
            authorization_revisions: Vec::new(),
        })
    }
}

impl SessionConfiguration {
    pub(super) fn new(loader: SettingsLoader, cli: crate::Cli) -> Self {
        Self {
            loader,
            cli,
            mcp_cache: Arc::new(Mutex::new(None)),
            mcp_attempts: Arc::new(std::sync::Mutex::new(std::collections::BTreeMap::new())),
        }
    }

    pub(super) fn freeze_model_overlays(mut self) -> Result<Self> {
        self.loader = self.loader.freeze_overlays()?;
        Ok(self)
    }

    pub(super) fn model_source(&self) -> Arc<dyn kcoder_engine::ClientModelConfiguration> {
        Arc::new(crate::model_configuration::ModelConfiguration::new(
            self.loader.clone(),
            self.cli.clone(),
        ))
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
            mcp_cache: Arc::new(Mutex::new(None)),
            mcp_attempts: Arc::new(std::sync::Mutex::new(std::collections::BTreeMap::new())),
        }
    }

    pub(super) fn mcp_connection_attempt(
        &self,
        config: &kcoder_mcp::McpServerConfig,
    ) -> Option<kcoder_app_protocol::McpConnectionAttemptStatus> {
        let value = serde_json::to_value(config).ok()?;
        let attempts = self.mcp_attempts.lock().ok()?;
        let (recorded, status) = attempts.get(&config.name)?;
        (recorded == &value).then(|| status.clone())
    }

    fn record_mcp_attempt(
        &self,
        config: &kcoder_mcp::McpServerConfig,
        status: kcoder_app_protocol::McpConnectionAttemptStatus,
    ) {
        if let (Ok(value), Ok(mut attempts)) =
            (serde_json::to_value(config), self.mcp_attempts.lock())
        {
            attempts.insert(config.name.clone(), (value, status));
        }
    }

    pub(super) fn seed_mcp(
        &mut self,
        settings: &Settings,
        plugins: &EffectivePluginSnapshot,
        tools: &ToolRegistry,
    ) -> Result<()> {
        let builtins = crate::builtin_tools_for_settings(&self.cli, settings);
        if builtins.names().is_empty() {
            return Ok(());
        }
        if settings
            .mcp_servers
            .iter()
            .any(|server| server.transport == "http")
        {
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
            _plugin_leases: plugins.version_leases.clone(),
        });
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

    pub(super) fn hook_user_settings_path(&self) -> Result<std::path::PathBuf> {
        Ok(self.loader.load()?.paths.user_settings)
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
        self.provider_for_kind(settings, kind)
    }

    fn provider_for_kind(
        &self,
        settings: &Settings,
        kind: ProviderKind,
    ) -> Result<Arc<dyn Provider>> {
        crate::model_configuration::ModelConfiguration::new(self.loader.clone(), self.cli.clone())
            .provider_for_kind(settings, kind)
    }

    pub(super) async fn tools(
        &self,
        settings: &Settings,
        plugins: &EffectivePluginSnapshot,
    ) -> Result<ToolRegistry> {
        // Rebuild per newly activated conversation; resident engines keep their own registry.
        let builtin_tools = crate::builtin_tools_for_settings(&self.cli, settings);
        if builtin_tools.names().is_empty() {
            return Ok(builtin_tools);
        }
        let paths = self.loader.paths()?;
        let project_mcp_names = crate::project_mcp_server_names(&paths.project_root);
        let mut key = McpSnapshotKey::new(settings, plugins, &paths)?;
        key.builtin_names = builtin_tools.names();
        key.builtin_names.sort();
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
            if let Some(cached) = cache.as_ref() {
                if cached.key == key {
                    return Ok(cached.tools.clone());
                }
            }
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let mut complete = revision_valid;
        let tools = {
            let mut tools = builtin_tools;
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
                        self.record_mcp_attempt(
                            server,
                            if failure.is_err() {
                                kcoder_app_protocol::McpConnectionAttemptStatus::TimedOut
                            } else {
                                kcoder_app_protocol::McpConnectionAttemptStatus::Unavailable
                            },
                        );
                        let detail = match failure {
                            Ok(Err(error)) => format!("{error:#}"),
                            Err(_) => "MCP connection timed out".to_owned(),
                            Ok(Ok(_)) => unreachable!(),
                        };
                        tracing::warn!(server = %server.name, "MCP unavailable for new conversation: {detail}");
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
                for definition in definitions {
                    let tool =
                        kcoder_mcp::McpTool::new(&server.name, Arc::clone(&handle), definition);
                    let tool = match source {
                        Some(source) => tool.with_plugin_source(&source.plugin_id),
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
                    tools.try_register(Arc::new(tool) as Arc<dyn Tool>)?;
                }
            }
            tools.filtered_out_by_patterns(&settings.tools.disabled)
        };
        // Retry unavailable servers on the next session instead of caching a partial snapshot.
        if complete {
            *cache = Some(CachedMcpSnapshot {
                key,
                tools: tools.clone(),
                _plugin_leases: plugins.version_leases.clone(),
            });
        }
        Ok(tools)
    }
}

#[cfg(test)]
mod model_refresh_source_tests {
    use super::*;
    use clap::Parser;

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
        let mut cli = crate::Cli::parse_from(["kcoder"]);
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
            crate::Cli::parse_from(["kcoder"]),
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
        assert!(config
            .tools(&settings, &plugins)
            .await
            .unwrap()
            .names()
            .is_empty());
        assert!(config
            .mcp_connection_attempt(&settings.mcp_servers[0])
            .is_none());
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
            crate::Cli::parse_from(["kcoder", "--tool-profile", "nano"]),
        );
        let mut settings = Settings::default();
        settings.tools.profile = kcoder_config::ToolProfile::None;
        let plugins = EffectivePluginSnapshot::default();
        let tools = config.tools(&settings, &plugins).await.unwrap();
        assert!(tools.names().contains(&"CtxInspect".to_owned()));
        settings.tools.disabled.push("CtxInspect".into());
        assert!(!config
            .tools(&settings, &plugins)
            .await
            .unwrap()
            .names()
            .contains(&"CtxInspect".to_owned()));
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
        settings.openai_api_key = Some("fixture-old".into());
        settings.credential_store = kcoder_config::CredentialStoreMode::File;
        loader
            .refresh_stored_provider_credentials(&mut settings)
            .unwrap();
        let config = SessionConfiguration::new(loader, crate::Cli::parse_from(["kcoder"]));
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
                crate::Cli::parse_from(["kcoder"]),
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
            Some(kcoder_app_protocol::McpConnectionAttemptStatus::Unavailable)
        );
        assert_eq!(make().mcp_connection_attempt(&server), None);
        server.command = "new".into();
        assert_eq!(configuration.mcp_connection_attempt(&server), None);
    }
}

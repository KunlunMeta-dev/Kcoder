use anyhow::{Context, Result};
use kcoder_app_protocol::{
    JSONRPC_VERSION, MarketplaceAddParams, MarketplaceDiagnostic as ProtocolMarketplaceDiagnostic,
    MarketplaceListParams, MarketplaceListResult as ProtocolMarketplaceListResult,
    MarketplaceMutationResult, MarketplacePluginSource as ProtocolMarketplacePluginSource,
    MarketplacePluginSummary, MarketplaceRefreshParams, MarketplaceRemoveParams,
    MarketplaceSummary, PluginCompatibility as ProtocolPluginCompatibility,
    PluginCompatibilityIssue as ProtocolPluginCompatibilityIssue, PluginComponentSummary,
    PluginDiagnostic as ProtocolPluginDiagnostic, PluginEnableParams, PluginInstallParams,
    PluginListParams, PluginListResult as ProtocolPluginListResult, PluginMutationResult,
    PluginReadParams, PluginReadResult as ProtocolPluginReadResult,
    PluginSource as ProtocolPluginSource, PluginSummary, PluginUninstallParams, method,
};
use kcoder_plugins::{
    MarketplaceListResult, PluginId, PluginListItem, PluginManager, PluginSource,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub(super) struct PluginProcessor {
    manager: Arc<PluginManager>,
    cwd: PathBuf,
    project_trusted: bool,
    write_gate: Arc<Mutex<()>>,
    cancellation: kcoder_plugins::PluginCancellationToken,
}

impl PluginProcessor {
    pub(super) fn open(cwd: &Path, settings: kcoder_config::PluginsSettings) -> Result<Self> {
        let manager = PluginManager::open_default_for_cwd_with_effective_settings(cwd, settings)?;
        let project_trusted = folder_trusted(cwd);
        Ok(Self {
            manager: Arc::new(manager),
            cwd: cwd.to_path_buf(),
            project_trusted,
            write_gate: Arc::new(Mutex::new(())),
            cancellation: kcoder_plugins::PluginCancellationToken::default(),
        })
    }

    pub(super) fn cancel(&self) {
        self.cancellation.cancel();
    }

    pub(super) fn handles(method_name: &str) -> bool {
        matches!(
            method_name,
            method::PLUGIN_LIST
                | method::PLUGIN_READ
                | method::PLUGIN_INSTALL
                | method::PLUGIN_UNINSTALL
                | method::PLUGIN_ENABLE
                | method::PLUGIN_DISABLE
                | method::MARKETPLACE_LIST
                | method::MARKETPLACE_ADD
                | method::MARKETPLACE_REMOVE
                | method::MARKETPLACE_REFRESH
        )
    }

    pub(super) async fn process(&self, id: Value, method_name: &str, params: Value) -> Value {
        let result = self.process_result(method_name, params).await;
        match result {
            Ok(result) => json!({
                "jsonrpc": JSONRPC_VERSION,
                "id": id,
                "result": result,
            }),
            Err(error) => error.response(id),
        }
    }

    async fn process_result(
        &self,
        method_name: &str,
        params: Value,
    ) -> Result<Value, ProcessorError> {
        match method_name {
            method::PLUGIN_LIST => {
                let params: PluginListParams = parse_params(params)?;
                let result = self.plugin_list(params.all).await?;
                serialize_result(result)
            }
            method::PLUGIN_READ => {
                let params: PluginReadParams = parse_params(params)?;
                let plugin_id: PluginId = params
                    .plugin_id
                    .parse::<PluginId>()
                    .map_err(|error| ProcessorError::invalid_params(error.to_string()))?;
                let manager = Arc::clone(&self.manager);
                let cwd = self.cwd.clone();
                let project_trusted = self.project_trusted;
                let result = tokio::task::spawn_blocking(move || {
                    manager
                        .read(&cwd, project_trusted, &plugin_id)?
                        .with_context(|| format!("plugin {plugin_id} was not found"))
                })
                .await
                .map_err(ProcessorError::join)?
                .map_err(ProcessorError::operation)?;
                serialize_result(ProtocolPluginReadResult {
                    generation: result.generation,
                    plugin: plugin_summary(result.plugin),
                    diagnostics: result
                        .diagnostics
                        .into_iter()
                        .map(plugin_diagnostic)
                        .collect(),
                })
            }
            method::PLUGIN_INSTALL => {
                let params: PluginInstallParams = parse_params(params)?;
                validate_attempt_id(params.install_attempt_id.as_deref())?;
                let _write = self.write_gate.lock().await;
                let manager = Arc::clone(&self.manager);
                let cwd = self.cwd.clone();
                let project_trusted = self.project_trusted;
                let cancellation = self.cancellation.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let record = match (params.path, params.marketplace_name, params.plugin_name) {
                        (Some(path), None, None) => {
                            manager.install_local_with_cancellation(&path, &cancellation)?
                        }
                        (None, Some(marketplace), Some(plugin)) => manager
                            .install_from_marketplace_with_cancellation(
                                &cwd,
                                project_trusted,
                                &marketplace,
                                &plugin,
                                &cancellation,
                            )?,
                        _ => anyhow::bail!(
                            "plugin/install requires either path or marketplaceName plus pluginName"
                        ),
                    };
                    let plugin = manager
                        .read(&cwd, project_trusted, &record.plugin_id)?
                        .context("installed plugin was not visible in the published generation")?;
                    Ok::<_, anyhow::Error>(plugin)
                })
                .await
                .map_err(ProcessorError::join)?
                .map_err(ProcessorError::operation)?;
                serialize_result(PluginMutationResult {
                    generation: result.generation,
                    plugin: Some(plugin_summary(result.plugin)),
                    changed: true,
                })
            }
            method::PLUGIN_UNINSTALL => {
                let params: PluginUninstallParams = parse_params(params)?;
                let plugin_id: PluginId = params
                    .plugin_id
                    .parse::<PluginId>()
                    .map_err(|error| ProcessorError::invalid_params(error.to_string()))?;
                let _write = self.write_gate.lock().await;
                let manager = Arc::clone(&self.manager);
                let cancellation = self.cancellation.clone();
                let removed = tokio::task::spawn_blocking(move || {
                    manager.uninstall_with_cancellation(
                        &plugin_id,
                        params.purge_data,
                        &cancellation,
                    )
                })
                .await
                .map_err(ProcessorError::join)?
                .map_err(ProcessorError::operation)?;
                if !removed {
                    return Err(ProcessorError::not_found("plugin is not installed"));
                }
                serialize_result(PluginMutationResult {
                    generation: self
                        .manager
                        .store()
                        .generation()
                        .map_err(ProcessorError::operation)?,
                    plugin: None,
                    changed: true,
                })
            }
            method::PLUGIN_ENABLE | method::PLUGIN_DISABLE => {
                let params: PluginEnableParams = parse_params(params)?;
                let plugin_id: PluginId = params
                    .plugin_id
                    .parse::<PluginId>()
                    .map_err(|error| ProcessorError::invalid_params(error.to_string()))?;
                let enabled = method_name == method::PLUGIN_ENABLE;
                let _write = self.write_gate.lock().await;
                let manager = Arc::clone(&self.manager);
                let cwd = self.cwd.clone();
                let project_trusted = self.project_trusted;
                let result = tokio::task::spawn_blocking(move || {
                    let changed = manager.set_enabled(&plugin_id, enabled)?;
                    let plugin = manager
                        .read(&cwd, project_trusted, &plugin_id)?
                        .context("updated plugin was not visible")?;
                    Ok::<_, anyhow::Error>((changed, plugin))
                })
                .await
                .map_err(ProcessorError::join)?
                .map_err(ProcessorError::operation)?;
                serialize_result(PluginMutationResult {
                    generation: result.1.generation,
                    plugin: Some(plugin_summary(result.1.plugin)),
                    changed: result.0,
                })
            }
            method::MARKETPLACE_LIST => {
                let _: MarketplaceListParams = parse_params(params)?;
                let result = self.marketplace_list().await?;
                serialize_result(result)
            }
            method::MARKETPLACE_ADD => {
                let params: MarketplaceAddParams = parse_params(params)?;
                if params.source.starts_with("http://") {
                    return Err(ProcessorError::internal(
                        "unsupported_remote_marketplace",
                        "remote hosted marketplace APIs are not supported",
                    ));
                }
                let _write = self.write_gate.lock().await;
                let manager = Arc::clone(&self.manager);
                let source = params.source;
                let cwd = self.cwd.clone();
                let project_trusted = self.project_trusted;
                let cancellation = self.cancellation.clone();
                let result = tokio::task::spawn_blocking(move || {
                    if source.starts_with("https://") || source.starts_with("file://") {
                        return manager.marketplace_add_git_with_cancellation(
                            &source,
                            params.marketplace_name.as_deref(),
                            &cwd,
                            project_trusted,
                            &cancellation,
                        );
                    }
                    let source = PathBuf::from(source);
                    let marketplace = kcoder_plugins::load_marketplace_manifest(&source)?;
                    let marketplace_name = params
                        .marketplace_name
                        .unwrap_or_else(|| marketplace.name.clone());
                    manager.marketplace_add_with_trust(
                        &marketplace_name,
                        &marketplace.path,
                        &cwd,
                        project_trusted,
                    )?;
                    Ok::<_, anyhow::Error>(marketplace_name)
                })
                .await
                .map_err(ProcessorError::join)?
                .map_err(ProcessorError::operation)?;
                serialize_result(MarketplaceMutationResult {
                    generation: self
                        .manager
                        .store()
                        .generation()
                        .map_err(ProcessorError::operation)?,
                    marketplace_name: result,
                    changed: true,
                })
            }
            method::MARKETPLACE_REMOVE => {
                let params: MarketplaceRemoveParams = parse_params(params)?;
                let _write = self.write_gate.lock().await;
                let manager = Arc::clone(&self.manager);
                let marketplace_name = params.marketplace_name;
                let name_for_operation = marketplace_name.clone();
                let removed = tokio::task::spawn_blocking(move || {
                    manager.marketplace_remove(&name_for_operation)
                })
                .await
                .map_err(ProcessorError::join)?
                .map_err(ProcessorError::operation)?;
                if !removed {
                    return Err(ProcessorError::not_found("marketplace is not configured"));
                }
                serialize_result(MarketplaceMutationResult {
                    generation: self
                        .manager
                        .store()
                        .generation()
                        .map_err(ProcessorError::operation)?,
                    marketplace_name,
                    changed: true,
                })
            }
            method::MARKETPLACE_REFRESH => {
                let params: MarketplaceRefreshParams = parse_params(params)?;
                let _write = self.write_gate.lock().await;
                let manager = Arc::clone(&self.manager);
                let cwd = self.cwd.clone();
                let project_trusted = self.project_trusted;
                let result = tokio::task::spawn_blocking(move || {
                    manager.marketplace_refresh(
                        &cwd,
                        project_trusted,
                        params.marketplace_name.as_deref(),
                    )
                })
                .await
                .map_err(ProcessorError::join)?
                .map_err(ProcessorError::operation)?;
                serialize_result(marketplace_list_result(result))
            }
            _ => Err(ProcessorError::invalid_params("unsupported plugin method")),
        }
    }

    async fn plugin_list(
        &self,
        include_disabled: bool,
    ) -> Result<ProtocolPluginListResult, ProcessorError> {
        let manager = Arc::clone(&self.manager);
        let cwd = self.cwd.clone();
        let project_trusted = self.project_trusted;
        let mut result = tokio::task::spawn_blocking(move || manager.list(&cwd, project_trusted))
            .await
            .map_err(ProcessorError::join)?
            .map_err(ProcessorError::operation)?;
        if !include_disabled {
            result.plugins.retain(|plugin| plugin.enabled);
        }
        Ok(ProtocolPluginListResult {
            generation: result.generation,
            plugins: result.plugins.into_iter().map(plugin_summary).collect(),
            diagnostics: result
                .diagnostics
                .into_iter()
                .map(plugin_diagnostic)
                .collect(),
        })
    }

    async fn marketplace_list(&self) -> Result<ProtocolMarketplaceListResult, ProcessorError> {
        let manager = Arc::clone(&self.manager);
        let cwd = self.cwd.clone();
        let project_trusted = self.project_trusted;
        let result =
            tokio::task::spawn_blocking(move || manager.marketplace_list(&cwd, project_trusted))
                .await
                .map_err(ProcessorError::join)?
                .map_err(ProcessorError::operation)?;
        Ok(marketplace_list_result(result))
    }
}

fn parse_params<T: DeserializeOwned>(params: Value) -> Result<T, ProcessorError> {
    serde_json::from_value(params)
        .map_err(|error| ProcessorError::invalid_params(error.to_string()))
}

fn serialize_result(value: impl serde::Serialize) -> Result<Value, ProcessorError> {
    serde_json::to_value(value)
        .map_err(|error| ProcessorError::internal("serialization_failed", error.to_string()))
}

fn validate_attempt_id(value: Option<&str>) -> Result<(), ProcessorError> {
    if value.is_some_and(|value| {
        value.is_empty()
            || value.len() > 128
            || value.chars().any(|character| character.is_control())
    }) {
        return Err(ProcessorError::invalid_params(
            "installAttemptId must be 1..=128 printable characters",
        ));
    }
    Ok(())
}

fn plugin_components(plugin: &PluginListItem) -> Vec<PluginComponentSummary> {
    let mut components = Vec::new();
    for root in &plugin.skill_roots {
        let entries = match std::fs::read_dir(root) {
            Ok(entries) => entries,
            Err(error) => {
                tracing::warn!(path = %root.display(), %error, "Cannot inspect plugin skills");
                continue;
            }
        };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let path = entry.path().join("SKILL.md");
            if !std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file()) {
                continue;
            }
            match kcoder_skills::parse_skill_file(&path) {
                Ok(skill) => components.push(PluginComponentSummary {
                    kind: "skill".into(),
                    name: skill.name,
                    path: Some(path),
                    description: Some(skill.description),
                }),
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "Cannot inspect plugin skill")
                }
            }
        }
    }
    for path in &plugin.command_paths {
        components.push(PluginComponentSummary {
            kind: "command".into(),
            name: path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            path: Some(path.clone()),
            description: None,
        });
    }
    // Inventory never returns MCP credentials, environment values, or hook commands.
    for (kind, names) in [
        ("mcp", &plugin.mcp_server_names),
        ("hook", &plugin.hook_event_names),
    ] {
        for name in names {
            components.push(PluginComponentSummary {
                kind: kind.into(),
                name: name.clone(),
                path: None,
                description: None,
            });
        }
    }
    components.sort_by(|left, right| {
        (&left.kind, &left.name, &left.path).cmp(&(&right.kind, &right.name, &right.path))
    });
    components.dedup();
    components
}

fn plugin_summary(plugin: PluginListItem) -> PluginSummary {
    let components = plugin_components(&plugin);
    PluginSummary {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        root: plugin.root,
        enabled: plugin.enabled,
        managed: plugin.managed,
        source: plugin.source.map(|source| match source {
            kcoder_plugins::InstalledPluginSource::Local { canonical_path } => {
                ProtocolPluginSource::Local { canonical_path }
            }
            kcoder_plugins::InstalledPluginSource::Marketplace { marketplace, entry } => {
                ProtocolPluginSource::Marketplace { marketplace, entry }
            }
            kcoder_plugins::InstalledPluginSource::Git {
                redacted_url,
                resolved_sha,
            } => ProtocolPluginSource::Git {
                redacted_url,
                resolved_sha,
            },
            kcoder_plugins::InstalledPluginSource::Npm { package, integrity } => {
                ProtocolPluginSource::Npm { package, integrity }
            }
            kcoder_plugins::InstalledPluginSource::Bundled { bundle, digest } => {
                ProtocolPluginSource::Bundled { bundle, digest }
            }
        }),
        operation_id: plugin.operation_id,
        file_count: plugin.file_count,
        total_bytes: plugin.total_bytes,
        compatibility: ProtocolPluginCompatibility {
            level: plugin.compatibility.level.as_str().to_string(),
            supported_capabilities: plugin.compatibility.supported_capabilities,
            deferred_capabilities: plugin.compatibility.deferred_capabilities,
            issues: plugin
                .compatibility
                .issues
                .into_iter()
                .map(|issue| ProtocolPluginCompatibilityIssue {
                    code: issue.code,
                    capability: issue.capability,
                    message: issue.message,
                })
                .collect(),
        },
        components,
        hook_matcher_count: plugin.hook_matcher_count,
        diagnostic_count: plugin.diagnostic_count,
    }
}

fn plugin_diagnostic(diagnostic: kcoder_plugins::PluginLoadDiagnostic) -> ProtocolPluginDiagnostic {
    ProtocolPluginDiagnostic {
        root: diagnostic.root,
        code: diagnostic.code,
        message: diagnostic.message,
    }
}

fn marketplace_list_result(result: MarketplaceListResult) -> ProtocolMarketplaceListResult {
    ProtocolMarketplaceListResult {
        generation: result.generation,
        marketplaces: result
            .marketplaces
            .into_iter()
            .map(|marketplace| MarketplaceSummary {
                id: marketplace.id,
                path: marketplace.path,
                display_name: marketplace.display_name,
                configured: marketplace.configured,
                plugins: marketplace
                    .plugins
                    .into_iter()
                    .map(|plugin| MarketplacePluginSummary {
                        plugin_id: plugin.plugin_id.to_string(),
                        source: match plugin.source {
                            PluginSource::Local { path } => {
                                ProtocolMarketplacePluginSource::Local { path }
                            }
                            PluginSource::Git {
                                url,
                                path,
                                ref_name,
                                sha,
                            } => ProtocolMarketplacePluginSource::Git {
                                url,
                                path,
                                ref_name,
                                sha,
                            },
                            PluginSource::Npm {
                                package,
                                version,
                                registry,
                                integrity,
                            } => ProtocolMarketplacePluginSource::Npm {
                                package,
                                version,
                                registry,
                                integrity,
                            },
                            PluginSource::Bundled { bundle, digest } => {
                                ProtocolMarketplacePluginSource::Bundled { bundle, digest }
                            }
                        },
                        version: plugin.version,
                        install_policy: plugin.install_policy.as_str().to_string(),
                        auth_policy: plugin.auth_policy.as_str().to_string(),
                        manifest_fallback: plugin.manifest_fallback,
                    })
                    .collect(),
            })
            .collect(),
        diagnostics: result
            .diagnostics
            .into_iter()
            .map(|diagnostic| ProtocolMarketplaceDiagnostic {
                marketplace_id: diagnostic.marketplace_id,
                path: diagnostic.path,
                code: diagnostic.code,
                message: diagnostic.message,
            })
            .collect(),
    }
}

fn folder_trusted(cwd: &Path) -> bool {
    if kcoder_config::FolderTrustStore::trust_all_from_environment() {
        return true;
    }
    kcoder_config::user_config_dir()
        .map(|config_dir| kcoder_config::FolderTrustStore::load(&config_dir))
        .is_ok_and(|store| store.check(cwd) == kcoder_config::FolderTrust::Trusted)
}

struct ProcessorError {
    rpc_code: i64,
    kind: &'static str,
    message: String,
}

impl ProcessorError {
    fn invalid_params(message: impl Into<String>) -> Self {
        Self {
            rpc_code: -32602,
            kind: "invalid_params",
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            rpc_code: -32054,
            kind: "not_found",
            message: message.into(),
        }
    }

    fn internal(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            rpc_code: -32050,
            kind,
            message: message.into(),
        }
    }

    fn join(error: tokio::task::JoinError) -> Self {
        Self::internal("infrastructure_error", error.to_string())
    }

    fn operation(error: anyhow::Error) -> Self {
        let message = format!("{error:#}");
        let lowercase = message.to_ascii_lowercase();
        let kind = if lowercase.contains("unsupported plugin schema") {
            "unsupported_schema"
        } else if lowercase.contains("manifest") {
            "invalid_manifest"
        } else if lowercase.contains("disabled by settings")
            || lowercase.contains("not available for installation")
        {
            "policy_denied"
        } else if lowercase.contains("timed out") {
            "timeout"
        } else if lowercase.contains("cancelled") {
            "cancelled"
        } else if lowercase.contains("rollback also failed") {
            "rollback_failed"
        } else if lowercase.contains("not found") || lowercase.contains("not installed") {
            "not_found"
        } else if lowercase.contains("lock") {
            "busy"
        } else {
            "plugin_operation_failed"
        };
        Self::internal(kind, message)
    }

    fn response(self, id: Value) -> Value {
        json!({
            "jsonrpc": JSONRPC_VERSION,
            "id": id,
            "error": {
                "code": self.rpc_code,
                "message": self.message,
                "data": {
                    "kind": self.kind,
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn processor_installs_lists_disables_and_uninstalls_local_plugin() {
        let temp = TempDir::new().unwrap();
        let config_dir = temp.path().join("config");
        let source = temp.path().join("source");
        std::fs::create_dir_all(source.join(".codex-plugin")).unwrap();
        std::fs::write(
            source.join(".codex-plugin/plugin.json"),
            r#"{"name":"app-demo","version":"1.0.0"}"#,
        )
        .unwrap();
        let manager = PluginManager::open(&config_dir.join("plugin_store")).unwrap();
        let processor = PluginProcessor {
            manager: Arc::new(manager),
            cwd: temp.path().to_path_buf(),
            project_trusted: true,
            write_gate: Arc::new(Mutex::new(())),
            cancellation: kcoder_plugins::PluginCancellationToken::default(),
        };

        let installed = processor
            .process(json!(1), method::PLUGIN_INSTALL, json!({"path": source}))
            .await;
        assert_eq!(installed["result"]["generation"], 1);
        assert_eq!(installed["result"]["plugin"]["id"], "app-demo@local");

        let disabled = processor
            .process(
                json!(2),
                method::PLUGIN_DISABLE,
                json!({"pluginId": "app-demo@local"}),
            )
            .await;
        assert_eq!(disabled["result"]["generation"], 2);
        assert_eq!(disabled["result"]["plugin"]["enabled"], false);

        let removed = processor
            .process(
                json!(3),
                method::PLUGIN_UNINSTALL,
                json!({"pluginId": "app-demo@local", "purgeData": true}),
            )
            .await;
        assert_eq!(removed["result"]["generation"], 3);
        assert_eq!(removed["result"]["changed"], true);
    }

    #[tokio::test]
    async fn processor_returns_stable_error_kind_for_invalid_id() {
        let temp = TempDir::new().unwrap();
        let processor = PluginProcessor {
            manager: Arc::new(PluginManager::open(&temp.path().join("plugin_store")).unwrap()),
            cwd: temp.path().to_path_buf(),
            project_trusted: true,
            write_gate: Arc::new(Mutex::new(())),
            cancellation: kcoder_plugins::PluginCancellationToken::default(),
        };

        let response = processor
            .process(
                json!("bad"),
                method::PLUGIN_READ,
                json!({"pluginId": "../escape"}),
            )
            .await;

        assert_eq!(response["error"]["code"], -32602);
        assert_eq!(response["error"]["data"]["kind"], "invalid_params");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn processor_cancellation_stops_install_without_publishing_state() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir_all(source.join(".codex-plugin")).unwrap();
        std::fs::write(
            source.join(".codex-plugin/plugin.json"),
            r#"{"name":"cancel-demo","version":"1.0.0"}"#,
        )
        .unwrap();
        for index in 0..32 {
            let file = std::fs::File::create(source.join(format!("payload-{index}"))).unwrap();
            file.set_len(1024 * 1024).unwrap();
        }
        let processor = PluginProcessor {
            manager: Arc::new(PluginManager::open(&temp.path().join("plugin_store")).unwrap()),
            cwd: temp.path().to_path_buf(),
            project_trusted: true,
            write_gate: Arc::new(Mutex::new(())),
            cancellation: kcoder_plugins::PluginCancellationToken::default(),
        };
        let task_processor = processor.clone();
        let task = tokio::spawn(async move {
            task_processor
                .process(json!(1), method::PLUGIN_INSTALL, json!({"path": source}))
                .await
        });
        tokio::task::yield_now().await;
        processor.cancel();

        let response = task.await.unwrap();

        assert_eq!(response["error"]["data"]["kind"], "cancelled");
        assert!(
            processor
                .manager
                .store()
                .installed_plugins()
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn processor_rejects_remote_hosted_marketplace_explicitly() {
        let temp = TempDir::new().unwrap();
        let processor = PluginProcessor {
            manager: Arc::new(PluginManager::open(&temp.path().join("plugin_store")).unwrap()),
            cwd: temp.path().to_path_buf(),
            project_trusted: true,
            write_gate: Arc::new(Mutex::new(())),
            cancellation: kcoder_plugins::PluginCancellationToken::default(),
        };

        let response = processor
            .process(
                json!(1),
                method::MARKETPLACE_ADD,
                json!({"source": "http://example.invalid/hosted"}),
            )
            .await;

        assert_eq!(
            response["error"]["data"]["kind"],
            "unsupported_remote_marketplace"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn processor_serializes_concurrent_plugin_store_writes() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir_all(source.join(".codex-plugin")).unwrap();
        std::fs::write(
            source.join(".codex-plugin/plugin.json"),
            r#"{"name":"serialized-demo","version":"1.0.0"}"#,
        )
        .unwrap();
        let processor = PluginProcessor {
            manager: Arc::new(PluginManager::open(&temp.path().join("plugin_store")).unwrap()),
            cwd: temp.path().to_path_buf(),
            project_trusted: true,
            write_gate: Arc::new(Mutex::new(())),
            cancellation: kcoder_plugins::PluginCancellationToken::default(),
        };

        let first = processor.process(json!(1), method::PLUGIN_INSTALL, json!({"path": source}));
        let second = processor.process(json!(2), method::PLUGIN_INSTALL, json!({"path": source}));
        let (first, second) = tokio::join!(first, second);
        let mut generations = [
            first["result"]["generation"].as_u64().unwrap(),
            second["result"]["generation"].as_u64().unwrap(),
        ];
        generations.sort_unstable();

        assert_eq!(generations, [1, 2]);
        assert_eq!(processor.manager.store().generation().unwrap(), 2);
        assert_eq!(
            processor.manager.store().installed_plugins().unwrap().len(),
            1
        );
    }
}

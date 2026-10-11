//! Private plugin setup and non-activating availability requests.
use super::*;
use kcoder_app_protocol::{
    PluginActivationComponent, PluginActivationPhase as Phase, PluginActivationSnapshot,
};
use std::collections::BTreeMap;

pub(super) fn supports(method_name: &str) -> bool {
    matches!(
        method_name,
        method::PLUGIN_REVALIDATE
            | method::PLUGIN_ACTIVATION_READ
            | method::PLUGIN_CREDENTIALS_CONFIGURE
    )
}

#[derive(Clone, Default)]
pub(in crate::app_server) struct RuntimeObservation {
    thread_id: String,
    generation: u64,
    tools: BTreeMap<String, usize>,
    attempts: BTreeMap<String, kcoder_app_protocol::McpConnectionAttempt>,
    mcp_configs: Vec<kcoder_mcp::McpServerConfig>,
    authorizations: BTreeMap<String, kcoder_app_protocol::McpAuthorizationStatus>,
    skill_paths: Vec<PathBuf>,
    hooks: Vec<String>,
    hook_observations: BTreeMap<String, kcoder_hooks::PluginHookObservation>,
    hooks_disabled: bool,
}
impl RuntimeObservation {
    pub(in crate::app_server) fn capture(
        engine: &kcoder_engine::QueryEngine,
        plugin: &str,
        factory: &super::super::engine_factory::AppServerEngineFactory,
    ) -> Self {
        let registry = engine.active_tool_registry();
        let mut tools = BTreeMap::new();
        for name in registry.names() {
            if let Some(kcoder_tools::ToolSource::Plugin {
                plugin: owner,
                server,
                ..
            }) = registry.source(&name)
                && owner == plugin
            {
                *tools.entry(server.clone()).or_insert(0) += 1;
            }
        }
        let hooks = engine
            .hook_registry()
            .settings_hooks
            .iter()
            .filter_map(|(event, matcher)| {
                matcher
                    .source
                    .as_ref()
                    .filter(|source| source.id == plugin)
                    .map(|_| event.as_str().to_owned())
            })
            .collect();
        let snapshot = engine.plugin_snapshot();
        let attempts = snapshot
            .mcp_configs
            .iter()
            .zip(&snapshot.mcp_config_sources)
            .filter(|(_, source)| source.plugin_id == plugin)
            .filter_map(|(config, _)| {
                factory
                    .mcp_connection_attempt_for_registry(config, &registry)
                    .map(|status| (config.name.clone(), status))
            })
            .collect();
        Self {
            thread_id: engine.session_id(),
            generation: engine.plugin_snapshot().generation,
            tools,
            attempts,
            mcp_configs: snapshot
                .mcp_configs
                .iter()
                .zip(&snapshot.mcp_config_sources)
                .filter(|(_, source)| source.plugin_id == plugin)
                .map(|(config, _)| config.clone())
                .collect(),
            authorizations: BTreeMap::new(),
            skill_paths: engine
                .client_skill_catalog()
                .into_iter()
                .map(|skill| skill.path)
                .collect(),
            hooks,
            hook_observations: engine
                .hook_registry()
                .plugin_observations(plugin)
                .into_iter()
                .map(|observation| (observation.event.as_str().into(), observation))
                .collect(),
            hooks_disabled: engine.hook_registry().disabled,
        }
    }
}

fn mcp_activation_outcome(
    count: Option<usize>,
    attempt: Option<&kcoder_app_protocol::McpConnectionAttempt>,
) -> (Phase, Option<String>) {
    use kcoder_app_protocol::McpConnectionAttemptStatus as Status;
    use kcoder_types::mcp_failure::McpFailureReason as Reason;
    // Failed attempts cannot be promoted by stale registered tools.
    match attempt {
        Some(attempt) if attempt.status != Status::Ready => {
            let (phase, code) = match attempt.failure_reason {
                Some(Reason::AuthorizationRequired) => (
                    Phase::AuthorizationRequired,
                    Reason::AuthorizationRequired.error_code(),
                ),
                Some(Reason::ProtocolFailed) => {
                    (Phase::Failed, Reason::ProtocolFailed.error_code())
                }
                Some(Reason::ConnectionFailed) => {
                    (Phase::Failed, Reason::ConnectionFailed.error_code())
                }
                Some(Reason::TimedOut) => (Phase::Failed, Reason::TimedOut.error_code()),
                _ if attempt.status == Status::TimedOut => {
                    (Phase::Failed, Reason::TimedOut.error_code())
                }
                _ => (Phase::Failed, Reason::Unavailable.error_code()),
            };
            (phase, Some(code.into()))
        }
        _ if count.is_some_and(|n| n > 0) => (Phase::Usable, None),
        Some(_) => (Phase::Mounted, Some("mcp_no_tools".into())),
        None => (Phase::Unknown, None),
    }
}

impl PluginProcessor {
    pub(in crate::app_server) async fn process_observed(
        &self,
        id: Value,
        method_name: &str,
        params: Value,
        observation: Option<RuntimeObservation>,
    ) -> Value {
        if method_name != method::PLUGIN_ACTIVATION_READ {
            return self.process(id, method_name, params).await;
        }
        let result = self.activation(params, observation).await;
        match result {
            Ok(value) => json!({"jsonrpc":JSONRPC_VERSION,"id":id,"result":value}),
            Err(error) => error.response(id),
        }
    }
    pub(super) async fn private_request(
        &self,
        method_name: &str,
        params: Value,
    ) -> Result<Value, ProcessorError> {
        match method_name {
            method::PLUGIN_REVALIDATE => {
                let input: kcoder_app_protocol::PluginRevalidateParams = parse_params(params)?;
                validate_attempt_id(Some(&input.revalidation_attempt_id))?;
                let operation = self
                    .install_operations
                    .start(Some(&input.revalidation_attempt_id), &self.cancellation)
                    .map_err(ProcessorError::operation)?;
                let manager = self.manager.clone();
                let cwd = self.cwd.clone();
                let trusted = self.project_trusted();
                let cancellation = operation.token.clone();
                tokio::task::spawn_blocking(move || {
                    manager.revalidate_from_marketplace(
                        &cwd,
                        trusted,
                        &input.marketplace_name,
                        &input.plugin_name,
                        &cancellation,
                    )
                })
                .await
                .map_err(ProcessorError::join)?
                .map_err(ProcessorError::operation)?;
                serialize_result(self.marketplace_list().await?)
            }
            method::PLUGIN_CREDENTIALS_CONFIGURE => {
                // Invalid secret-bearing input must never be copied into an error/debug result.
                let input: kcoder_app_protocol::PluginCredentialsParams =
                    serde_json::from_value(params).map_err(|_| {
                        ProcessorError::invalid_params("Invalid private credential request")
                    })?;
                let _write = self.write_gate.lock().await;
                let this = self.clone();
                let result = tokio::task::spawn_blocking(move || this.configure(input))
                    .await
                    .map_err(ProcessorError::join)?
                    .map_err(ProcessorError::operation)?;
                serialize_result(result)
            }
            method::PLUGIN_ACTIVATION_READ => self.activation(params, None).await,
            _ => Err(ProcessorError::invalid_params(
                "Unsupported plugin lifecycle action",
            )),
        }
    }
    fn catalog_entry(
        &self,
        plugin_id: &PluginId,
    ) -> Result<Option<kcoder_plugins::MarketplaceEntry>> {
        Ok(self
            .manager
            .marketplace_list(&self.cwd, self.project_trusted())?
            .marketplaces
            .into_iter()
            .flat_map(|market| market.plugins)
            .find(|entry| &entry.plugin_id == plugin_id))
    }
    fn installed_scope(&self, record: &kcoder_plugins::InstalledPluginRecord) -> Result<String> {
        let store = kcoder_config::CredentialStore::load_from(&self.credentials_path)?;
        if let Some((scope, _)) = store
            .plugin_credentials
            .scopes
            .iter()
            .find(|(_, entry)| entry.operation_id.as_deref() == Some(&record.operation_id))
        {
            return Ok(scope.clone());
        }
        use sha2::{Digest, Sha256};
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &record.plugin_id,
                &record.source,
                &record.version,
                std::env::consts::OS,
                std::env::consts::ARCH
            ))?)
        ))
    }
    fn configure(
        &self,
        input: kcoder_app_protocol::PluginCredentialsParams,
    ) -> Result<kcoder_app_protocol::PluginCredentialsResult> {
        let plugin_id = input.plugin_id.parse::<PluginId>()?;
        let backend = kcoder_config::OsCredentialBackend::new();
        let write = |scope: &str, operation: Option<&str>, allowed: &[String]| {
            kcoder_config::CredentialStore::update_missing_plugin_credentials(
                &self.credentials_path,
                scope,
                operation,
                &input.values,
                allowed,
                self.credential_mode,
                &backend,
            )
        };
        let (scope, allowed, generation) =
            if let Some(operation) = input.expected_operation_id.as_deref() {
                let generation = input
                    .expected_generation
                    .context("plugin_scope_changed: generation required")?;
                let record = self
                    .manager
                    .store()
                    .read(&plugin_id)?
                    .context("plugin_scope_changed")?;
                anyhow::ensure!(record.operation_id == operation, "plugin_scope_changed");
                let scope = self.installed_scope(&record)?;
                let allowed = self.manager.required_mcp_environment_names(&plugin_id)?;
                self.manager.store().with_installed_identity(
                    &plugin_id,
                    generation,
                    operation,
                    |_| write(&scope, Some(operation), &allowed),
                )?;
                (scope, allowed, generation)
            } else {
                anyhow::ensure!(
                    input.expected_generation.is_none(),
                    "plugin_scope_changed: catalog setup requires source scope"
                );
                let expected = input
                    .expected_credential_scope
                    .as_deref()
                    .context("plugin_scope_changed: source scope required")?;
                let entry = self
                    .catalog_entry(&plugin_id)?
                    .context("plugin_scope_changed")?;
                let scope = PluginManager::marketplace_credential_scope(&entry)?;
                anyhow::ensure!(scope == expected, "plugin_scope_changed");
                let allowed = PluginManager::required_catalog_mcp_environment_names(&entry)?;
                // Re-read immediately before the private transaction. Values remain confined to
                // this source hash even if a catalog publisher replaces it afterward.
                let current = self
                    .catalog_entry(&plugin_id)?
                    .context("plugin_scope_changed")?;
                anyhow::ensure!(
                    PluginManager::marketplace_credential_scope(&current)? == scope,
                    "plugin_scope_changed"
                );
                write(&scope, None, &allowed)?;
                (scope, allowed, self.manager.store().generation()?)
            };
        let values = kcoder_config::CredentialStore::load_from(&self.credentials_path)?
            .plugin_credentials
            .resolve_strict(&scope, &backend, self.credential_mode)?;
        let missing_names = allowed
            .into_iter()
            .filter(|name| {
                !values.contains_key(name)
                    && !kcoder_config::plugin_credentials::environment_is_configured(name)
            })
            .collect();
        Ok(kcoder_app_protocol::PluginCredentialsResult {
            missing_names,
            effective_from: "next_turn".into(),
            generation,
        })
    }
    async fn activation(
        &self,
        params: Value,
        mut observation: Option<RuntimeObservation>,
    ) -> Result<Value, ProcessorError> {
        if let Some(fact) = observation.as_mut() {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
            for config in &fact.mcp_configs {
                let status = match tokio::time::timeout_at(
                    deadline,
                    super::super::mcp_processor::status(config),
                )
                .await
                {
                    Ok(Ok(status)) => status,
                    _ => kcoder_app_protocol::McpAuthorizationStatus::Unavailable,
                };
                fact.authorizations.insert(config.name.clone(), status);
            }
        }
        let input: kcoder_app_protocol::PluginActivationParams = parse_params(params)?;
        let this = self.clone();
        let snapshot = tokio::task::spawn_blocking(move || {
            this.activation_snapshot(&input.plugin_id, observation)
        })
        .await
        .map_err(ProcessorError::join)?
        .map_err(ProcessorError::operation)?;
        serialize_result(snapshot)
    }
    fn activation_snapshot(
        &self,
        id: &str,
        observation: Option<RuntimeObservation>,
    ) -> Result<PluginActivationSnapshot> {
        let id = id.parse::<PluginId>()?;
        let generation = self.manager.store().generation()?;
        let record = self.manager.store().read(&id)?;
        let (scope, names) = if let Some(record) = &record {
            (
                self.installed_scope(record)?,
                self.manager.required_mcp_environment_names(&id)?,
            )
        } else {
            let entry = self.catalog_entry(&id)?.context("plugin was not found")?;
            (
                PluginManager::marketplace_credential_scope(&entry)?,
                PluginManager::required_catalog_mcp_environment_names(&entry)?,
            )
        };
        let values = kcoder_config::CredentialStore::load_from(&self.credentials_path)?
            .plugin_credentials
            .resolve_strict(
                &scope,
                &kcoder_config::OsCredentialBackend::new(),
                self.credential_mode,
            )?;
        let missing = names
            .into_iter()
            .filter(|name| {
                !values.contains_key(name)
                    && !kcoder_config::plugin_credentials::environment_is_configured(name)
            })
            .collect::<Vec<_>>();
        let mut result = PluginActivationSnapshot {
            thread_id: None,
            generation,
            operation_id: record.as_ref().map(|r| r.operation_id.clone()),
            credential_scope: Some(scope),
            phase: if missing.is_empty() {
                Phase::Installed
            } else {
                Phase::CredentialsRequired
            },
            components: Vec::new(),
            effective_from: None,
        };
        if !missing.is_empty() {
            result.components.push(PluginActivationComponent {
                kind: "mcp".into(),
                name: id.to_string(),
                phase: Phase::CredentialsRequired,
                tool_count: None,
                error_code: None,
                authorization: None,
                missing_names: missing,
            });
        }
        let Some(record) = record else {
            return Ok(result);
        };
        let loaded = self
            .manager
            .read(&self.cwd, self.project_trusted(), &id)?
            .context("plugin was not found")?;
        if !loaded.plugin.enabled {
            result.phase = Phase::Disabled;
            return Ok(result);
        }
        let observation = observation.filter(|fact| fact.generation == generation);
        result.thread_id = observation.as_ref().map(|fact| fact.thread_id.clone());
        if observation.is_none() {
            result.effective_from = Some("next_turn".into());
        }
        let private_values = crate::plugin_credentials::by_operation(
            &self.credentials_path,
            self.credential_mode,
            &self.manager,
        )?;
        let resolved_snapshot = self.manager.effective_snapshot_with_credentials(
            &self.cwd,
            self.project_trusted(),
            &private_values,
        )?;
        anyhow::ensure!(
            resolved_snapshot.generation == generation,
            "plugin_scope_changed"
        );
        let mcp_names = resolved_snapshot
            .mcp_configs
            .iter()
            .zip(&resolved_snapshot.mcp_config_sources)
            .filter(|(_, source)| source.plugin_id == id.to_string())
            .map(|(config, _)| config.name.clone())
            .collect::<Vec<_>>();
        for name in &mcp_names {
            let count = observation
                .as_ref()
                .and_then(|fact| fact.tools.get(name))
                .copied();
            let attempt = observation
                .as_ref()
                .and_then(|fact| fact.attempts.get(name));
            let (phase, error_code) = mcp_activation_outcome(count, attempt);
            let authorization = observation
                .as_ref()
                .and_then(|fact| fact.authorizations.get(name))
                .cloned();
            result.components.push(PluginActivationComponent {
                kind: "mcp".into(),
                name: name.clone(),
                phase,
                tool_count: count.or_else(|| {
                    attempt
                        .filter(|attempt| {
                            attempt.status == kcoder_app_protocol::McpConnectionAttemptStatus::Ready
                        })
                        .map(|_| 0)
                }),
                error_code,
                authorization,
                missing_names: Vec::new(),
            });
        }
        for path in &loaded.plugin.skill_roots {
            let found = observation.as_ref().is_some_and(|fact| {
                fact.skill_paths
                    .iter()
                    .any(|source| source.starts_with(path))
            });
            result.components.push(PluginActivationComponent {
                kind: "skill".into(),
                name: path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                phase: if found { Phase::Usable } else { Phase::Unknown },
                tool_count: None,
                error_code: None,
                authorization: None,
                missing_names: Vec::new(),
            });
        }
        for name in &loaded.plugin.hook_event_names {
            let mounted = observation
                .as_ref()
                .is_some_and(|fact| fact.hooks.contains(name));
            let observed = observation
                .as_ref()
                .and_then(|fact| fact.hook_observations.get(name));
            let (phase, error_code) = if observation
                .as_ref()
                .is_some_and(|fact| fact.hooks_disabled)
            {
                (Phase::Disabled, None)
            } else if let Some(observed) = observed {
                use kcoder_hooks::HookRuntimeStatus as Status;
                match observed.status {
                    Status::TimedOut => (Phase::Failed, Some("hook_timeout".into())),
                    Status::Failed => (Phase::Failed, Some("hook_failed".into())),
                    Status::InvalidOutput => (Phase::Failed, Some("hook_invalid_output".into())),
                    Status::Passed
                        if observed.configured_count > 0
                            && observed.observed_count == observed.configured_count =>
                    {
                        (Phase::Usable, None)
                    }
                    _ if mounted => (Phase::Mounted, None),
                    _ => (Phase::Unknown, None),
                }
            } else if mounted {
                (Phase::Mounted, None)
            } else {
                (Phase::Unknown, None)
            };
            result.components.push(PluginActivationComponent {
                kind: "hook".into(),
                name: name.clone(),
                phase,
                tool_count: None,
                error_code,
                authorization: None,
                missing_names: Vec::new(),
            });
        }
        if result.phase != Phase::CredentialsRequired {
            result.phase = if result.components.is_empty() {
                Phase::Unknown
            } else if result.components.iter().all(|c| c.phase == Phase::Usable) {
                Phase::Usable
            } else {
                result
                    .components
                    .iter()
                    .find(|c| c.phase != Phase::Usable)
                    .unwrap()
                    .phase
                    .clone()
            };
        }
        let _ = record;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, PluginProcessor, String) {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir_all(source.join(".claude-plugin")).unwrap();
        std::fs::write(
            source.join(".claude-plugin/plugin.json"),
            json!({
                "name":"private-demo", "version":"1.0.0", "mcpServers": {"private": {
                    "type":"http", "url":"https://example.invalid/mcp",
                    "headers":{"Authorization":"Bearer ${P09_SYNTHETIC_TOKEN}"}
                }}
            })
            .to_string(),
        )
        .unwrap();
        let manager = PluginManager::open(&temp.path().join("plugin_store")).unwrap();
        let record = manager.install_local(&source).unwrap();
        let processor = PluginProcessor {
            manager: Arc::new(manager),
            cwd: temp.path().to_path_buf(),
            credentials_path: temp.path().join("credentials.json"),
            credential_mode: kcoder_config::CredentialStoreMode::File,
            write_gate: Arc::new(Mutex::new(())),
            cancellation: Default::default(),
            install_operations: Default::default(),
        };
        (temp, processor, record.operation_id)
    }
    #[tokio::test]
    async fn private_rpc_rejects_stale_identity_and_only_injects_next_snapshot() {
        let (temp, processor, operation) = fixture();
        let values = json!({"P09_SYNTHETIC_TOKEN":"p09-synthetic-value"});
        let stale = processor
            .process(
                json!(1),
                method::PLUGIN_CREDENTIALS_CONFIGURE,
                json!({
                    "pluginId":"private-demo@local", "values":values,
                    "expectedOperationId":operation, "expectedGeneration":0
                }),
            )
            .await;
        assert_eq!(stale["error"]["data"]["kind"], "plugin_scope_changed");
        assert!(!processor.credentials_path.exists());
        let configured = processor
            .process(
                json!(2),
                method::PLUGIN_CREDENTIALS_CONFIGURE,
                json!({
                    "pluginId":"private-demo@local", "values":values,
                    "expectedOperationId":operation, "expectedGeneration":1
                }),
            )
            .await;
        assert!(configured.get("error").is_none(), "{configured}");
        assert_eq!(configured["result"]["effectiveFrom"], "next_turn");
        assert!(!configured.to_string().contains("p09-synthetic-value"));
        let resolved = crate::plugin_credentials::by_operation(
            &processor.credentials_path,
            processor.credential_mode,
            &processor.manager,
        )
        .unwrap();
        assert_eq!(
            resolved[&operation]["P09_SYNTHETIC_TOKEN"],
            "p09-synthetic-value"
        );
        let snapshot = processor
            .manager
            .effective_snapshot_with_credentials(temp.path(), true, &resolved)
            .unwrap();
        assert_eq!(
            snapshot.mcp_configs[0].headers["Authorization"],
            "Bearer p09-synthetic-value"
        );
        assert_ne!(
            std::env::var("P09_SYNTHETIC_TOKEN").ok().as_deref(),
            Some("p09-synthetic-value")
        );
        let unknown = processor
            .process(
                json!(3),
                method::PLUGIN_ACTIVATION_READ,
                json!({"pluginId":"private-demo@local"}),
            )
            .await;
        assert_eq!(unknown["result"]["phase"], "unknown");
        assert!(unknown["result"].get("threadId").is_none());
        let malformed = processor
            .process(
                json!(4),
                method::PLUGIN_CREDENTIALS_CONFIGURE,
                json!({
            "pluginId":"private-demo@local", "values":"p09-synthetic-value"}),
            )
            .await;
        assert!(!malformed.to_string().contains("p09-synthetic-value"));
    }
    #[test]
    fn only_observed_owned_tools_establish_usability() {
        let (_temp, processor, _) = fixture();
        let missing = processor
            .activation_snapshot("private-demo@local", None)
            .unwrap();
        assert_eq!(missing.phase, Phase::CredentialsRequired);
        let observation = RuntimeObservation {
            thread_id: "owned".into(),
            generation: 1,
            ..Default::default()
        };
        let result = processor
            .activation_snapshot("private-demo@local", Some(observation))
            .unwrap();
        assert_ne!(result.phase, Phase::Usable);
    }
}

#[cfg(test)]
mod mcp_failure_projection_tests {
    use super::*;
    use kcoder_app_protocol::{McpConnectionAttempt, McpConnectionAttemptStatus as Status};
    use kcoder_types::mcp_failure::McpFailureReason as Reason;
    #[test]
    fn typed_failures_override_stale_tools_and_legacy_attempts_stay_conservative() {
        for (reason, phase, code) in [
            (
                Reason::ConnectionFailed,
                Phase::Failed,
                "mcp_connection_failed",
            ),
            (Reason::ProtocolFailed, Phase::Failed, "mcp_protocol_failed"),
            (
                Reason::AuthorizationRequired,
                Phase::AuthorizationRequired,
                "mcp_authorization_required",
            ),
            (Reason::TimedOut, Phase::Failed, "mcp_timeout"),
        ] {
            let attempt = McpConnectionAttempt {
                status: Status::Unavailable,
                failure_reason: Some(reason),
            };
            assert_eq!(
                mcp_activation_outcome(Some(3), Some(&attempt)),
                (phase, Some(code.into()))
            );
        }
        assert_eq!(
            mcp_activation_outcome(None, Some(&Status::Unavailable.into())),
            (Phase::Failed, Some("mcp_unavailable".into()))
        );
        assert_eq!(
            mcp_activation_outcome(Some(0), Some(&Status::Ready.into())),
            (Phase::Mounted, Some("mcp_no_tools".into()))
        );
        assert_eq!(mcp_activation_outcome(None, None), (Phase::Unknown, None));
    }
}

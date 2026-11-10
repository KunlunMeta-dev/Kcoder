use super::*;
use crate::app_server::AppServerEngineFactory;
use kcoder_engine::QueryEngine;
use std::sync::Weak;

/// Only actual native registration, original Engine snapshot and store lease can create this.
pub(super) struct NativePluginSourceLease {
    tool: Weak<dyn kcoder_tools::Tool>,
    original: Weak<dyn kcoder_tools::Tool>,
    origin: Weak<kcoder_mcp::native_origin::NativeMcpConnectionOrigin>,
    lease: Weak<kcoder_plugins::PluginVersionLease>,
    selector: NativeMcpSourceSelector,
    operation: String,
}
impl NativePluginSourceLease {
    fn capture(
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        tool: &Arc<dyn kcoder_tools::Tool>,
        original: &Arc<dyn kcoder_tools::Tool>,
        selector: &NativeMcpSourceSelector,
    ) -> Result<Option<Arc<Self>>> {
        let Some(plugin) = selector.plugin.as_deref() else {
            return Ok(None);
        };
        let object: &dyn std::any::Any = original.as_ref();
        let actual = object
            .downcast_ref::<kcoder_mcp::McpTool>()
            .context("NATIVE_PLUGIN_ACTUAL_TOOL_REQUIRED")?;
        let origin = actual
            .native_origin()
            .context("NATIVE_PLUGIN_ORIGIN_REQUIRED")?;
        let snapshot = engine.plugin_snapshot();
        let Some(operation) = snapshot.managed_operations.get(plugin) else {
            return Ok(None);
        };
        let configurations = snapshot
            .mcp_configs
            .iter()
            .zip(&snapshot.mcp_config_sources)
            .filter(|(config, source)| source.plugin_id == plugin && config.name == selector.server)
            .collect::<Vec<_>>();
        ensure!(
            configurations.len() == 1
                && serde_json::to_value(configurations[0].0)?
                    == serde_json::to_value(origin.private_config())?
                && engine
                    .tools
                    .all()
                    .iter()
                    .any(|registered| Arc::ptr_eq(registered, tool)),
            "NATIVE_PLUGIN_FROZEN_CONFIGURATION_CHANGED"
        );
        let leases = snapshot
            .version_leases
            .iter()
            .filter(|lease| lease.identifies(plugin, operation))
            .collect::<Vec<_>>();
        ensure!(leases.len() == 1, "NATIVE_PLUGIN_VERSION_LEASE_REQUIRED");
        leases[0].verify_runtime_binding(context.profile()?, plugin, operation)?;
        let result = Arc::new(Self {
            tool: Arc::downgrade(tool),
            original: Arc::downgrade(original),
            origin: Arc::downgrade(origin),
            lease: Arc::downgrade(leases[0]),
            selector: selector.clone(),
            operation: operation.clone(),
        });
        result.verify(context)?;
        Ok(Some(result))
    }
    /// True is the current installed version; false is an actually retained older version.
    pub(super) fn verify(&self, context: &NativeIntegrationContext) -> Result<bool> {
        context.verify()?;
        let tool = self.tool.upgrade().context("NATIVE_PLUGIN_TOOL_ENDED")?;
        let original = self
            .original
            .upgrade()
            .context("NATIVE_PLUGIN_TOOL_ENDED")?;
        let current = super::super::application_inputs::business_source_tool(context, &tool)?
            .unwrap_or_else(|| tool.clone());
        ensure!(
            Arc::ptr_eq(&original, &current)
                && self.selector.matches_tool_source(&original.source())
                && original.is_model_visible()
                && tool.is_model_visible(),
            "NATIVE_PLUGIN_ORIGINAL_TOOL_CHANGED"
        );
        let object: &dyn std::any::Any = original.as_ref();
        let actual = object
            .downcast_ref::<kcoder_mcp::McpTool>()
            .context("NATIVE_PLUGIN_ACTUAL_TOOL_REQUIRED")?;
        let origin = self
            .origin
            .upgrade()
            .context("NATIVE_PLUGIN_ORIGIN_ENDED")?;
        ensure!(
            actual
                .native_origin()
                .is_some_and(|current| Arc::ptr_eq(current, &origin))
                && origin.matches_profile(context.profile()?)?,
            "NATIVE_PLUGIN_ORIGINAL_CONNECTION_CHANGED"
        );
        self.lease
            .upgrade()
            .context("NATIVE_PLUGIN_VERSION_LEASE_ENDED")?
            .verify_runtime_binding(
                context.profile()?,
                self.selector.plugin.as_deref().unwrap(),
                &self.operation,
            )
    }
    fn policy(&self, settings: &Settings) -> Result<()> {
        let plugin = self.selector.plugin.as_deref().unwrap();
        ensure!(
            settings.plugins.runtime.enabled && settings.mcp_server_enabled(&self.selector.server),
            "NATIVE_PLUGIN_GLOBALLY_DISABLED"
        );
        if let Some(policy) = settings.plugins.installed.get(plugin) {
            ensure!(
                policy.enabled != Some(false),
                "NATIVE_PLUGIN_GLOBALLY_DISABLED"
            );
            if let Some(name) = self
                .selector
                .server
                .strip_prefix(&format!("plugin.{plugin}."))
                && let Some(server) = policy.mcp_servers.get(name)
            {
                ensure!(
                    server.enabled != Some(false),
                    "NATIVE_PLUGIN_GLOBALLY_DISABLED"
                );
                let original = self
                    .original
                    .upgrade()
                    .context("NATIVE_PLUGIN_TOOL_ENDED")?;
                let ToolSource::Plugin { tool, .. } = original.source() else {
                    anyhow::bail!("NATIVE_PLUGIN_ACTUAL_TOOL_REQUIRED")
                };
                ensure!(
                    (server.enabled_tools.is_empty() || server.enabled_tools.contains(&tool))
                        && !server.disabled_tools.contains(&tool),
                    "NATIVE_PLUGIN_TOOL_POLICY_DENIED"
                );
            }
        }
        Ok(())
    }
    fn compatible_current_configuration(
        &self,
        context: &NativeIntegrationContext,
        snapshot: &kcoder_plugins::EffectivePluginSnapshot,
    ) -> Result<bool> {
        let plugin = self.selector.plugin.as_deref().unwrap();
        let Some(operation) = snapshot.managed_operations.get(plugin) else {
            return Ok(false);
        };
        let configurations = snapshot
            .mcp_configs
            .iter()
            .zip(&snapshot.mcp_config_sources)
            .filter(|(config, source)| {
                source.plugin_id == plugin && config.name == self.selector.server
            })
            .collect::<Vec<_>>();
        if configurations.len() != 1 {
            return Ok(false);
        }
        let leases = snapshot
            .version_leases
            .iter()
            .filter(|lease| lease.identifies(plugin, operation))
            .collect::<Vec<_>>();
        if leases.len() != 1 {
            return Ok(false);
        }
        ensure!(
            leases[0].verify_runtime_binding(context.profile()?, plugin, operation)?,
            "NATIVE_PLUGIN_CURRENT_INSTALLATION_CHANGED"
        );
        let old = self
            .lease
            .upgrade()
            .context("NATIVE_PLUGIN_VERSION_LEASE_ENDED")?;
        old.verify_runtime_binding(context.profile()?, plugin, &self.operation)?;
        let origin = self
            .origin
            .upgrade()
            .context("NATIVE_PLUGIN_ORIGIN_ENDED")?;
        Ok(old.same_configuration_except_version_paths(
            origin.private_config(),
            leases[0],
            configurations[0].0,
        ))
    }
}
impl NativeMcpSourceFact {
    fn has_certified_root_environment(
        &self,
        context: &NativeIntegrationContext,
        config: &McpServerConfig,
        snapshot: &kcoder_plugins::EffectivePluginSnapshot,
    ) -> Result<bool> {
        if !matches!(config.transport.as_str(), "stdio" | "http")
            || !config.headers.is_empty()
            || config.policy.credential_ref.is_some()
            || (config.transport == "stdio" && config.policy.oauth_account.is_some())
            || !config.policy.required_env.is_empty()
            || !config.policy.env_vars.is_empty()
            || !config.policy.env_aliases.is_empty()
            || !config.policy.required_headers.is_empty()
            || !config.policy.env_http_headers.is_empty()
            || config.policy.bearer_token_env_var.is_some()
        {
            return Ok(false);
        }
        let Some(plugin) = self.selector.plugin.as_deref() else {
            return Ok(false);
        };
        let Some(operation) = snapshot.managed_operations.get(plugin) else {
            return Ok(false);
        };
        let configurations = snapshot
            .mcp_configs
            .iter()
            .zip(&snapshot.mcp_config_sources)
            .filter(|(actual, source)| source.plugin_id == plugin && actual.name == config.name)
            .collect::<Vec<_>>();
        ensure!(
            configurations.len() == 1
                && serde_json::to_value(configurations[0].0)? == serde_json::to_value(config)?,
            "NATIVE_PLUGIN_ROOT_CONFIGURATION_CHANGED"
        );
        let leases = snapshot
            .version_leases
            .iter()
            .filter(|lease| lease.identifies(plugin, operation))
            .collect::<Vec<_>>();
        ensure!(leases.len() == 1, "NATIVE_PLUGIN_VERSION_LEASE_REQUIRED");
        leases[0].verify_runtime_binding(context.profile()?, plugin, operation)?;
        Ok(leases[0].matches_root_environment(&config.env))
    }

    pub(crate) fn certify_plugin_root_environment(
        &mut self,
        context: &NativeIntegrationContext,
        config: &McpServerConfig,
        snapshot: &kcoder_plugins::EffectivePluginSnapshot,
    ) -> Result<()> {
        if matches!(
            self.account,
            NativeMcpAccountFact::Unknown("NATIVE_ACCOUNT_REFERENCE_UNAVAILABLE")
        ) && self.has_certified_root_environment(context, config, snapshot)?
        {
            self.account = if config.transport == "http" {
                observe_existing_oauth(context, config)?
            } else {
                NativeMcpAccountFact::NoSeparateAccount
            };
        }
        Ok(())
    }

    pub(crate) fn from_registered_engine_tool(
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        tool: &Arc<dyn kcoder_tools::Tool>,
    ) -> Result<Self> {
        let original = super::super::application_inputs::business_source_tool(context, tool)?
            .unwrap_or_else(|| tool.clone());
        let mut fact = Self::from_registered_tool(context, &original)?;
        let object: &dyn std::any::Any = original.as_ref();
        let actual = object
            .downcast_ref::<kcoder_mcp::McpTool>()
            .context("NATIVE_PLUGIN_ACTUAL_TOOL_REQUIRED")?;
        let origin = actual
            .native_origin()
            .context("NATIVE_PLUGIN_ORIGIN_REQUIRED")?;
        let config = origin.private_config();
        // A current account must never be relabeled as an old registered connection's birth.
        if matches!(
            fact.account,
            NativeMcpAccountFact::Unknown("NATIVE_ACCOUNT_REFERENCE_UNAVAILABLE")
        ) && fact.has_certified_root_environment(context, config, &engine.plugin_snapshot())?
        {
            fact.account = if config.transport == "http" {
                match origin.oauth_metadata().cloned() {
                    Some(metadata) => account_from_oauth_metadata(metadata)?,
                    None => NativeMcpAccountFact::Unknown("NATIVE_OAUTH_ORIGINAL_BINDING_REQUIRED"),
                }
            } else {
                NativeMcpAccountFact::NoSeparateAccount
            };
        }
        fact.leased_plugin =
            NativePluginSourceLease::capture(context, engine, tool, &original, &fact.selector)?;
        Ok(fact)
    }
    pub(crate) fn verify_lease_policy(
        &self,
        context: &NativeIntegrationContext,
        settings: &Settings,
    ) -> Result<()> {
        if let Some(proof) = &self.leased_plugin {
            proof.verify(context)?;
            proof.policy(settings)?;
        }
        Ok(())
    }
}

/// A current native task may retain its actual old managed version, never a same-name replacement.
pub(crate) fn for_engine(
    context: &NativeIntegrationContext,
    factory: &AppServerEngineFactory,
    backend: &dyn CredentialBackend,
    engine: &QueryEngine,
) -> Result<Vec<NativeMcpSourceFact>> {
    let mut facts = native_mcp_source_facts(context, factory, backend)?;
    if engine.plugin_snapshot().managed_operations.is_empty() {
        return Ok(facts);
    }
    let (settings, current) = factory.current_plugins_with_settings()?;
    let mut replacements = BTreeMap::new();
    for tool in engine.tools.all() {
        if !matches!(tool.source(), ToolSource::Plugin { .. }) {
            continue;
        }
        let Ok(birth) = NativeMcpSourceFact::from_registered_engine_tool(context, engine, &tool)
        else {
            continue;
        };
        let Some(proof) = birth.leased_plugin else {
            continue;
        };
        let plugin = proof.selector.plugin.as_deref().unwrap();
        if proof.verify(context).is_err()
            || !current.managed_operations.contains_key(plugin)
            || proof.policy(&settings).is_err()
        {
            continue;
        }
        if current.managed_operations.get(plugin) == Some(&proof.operation) {
            continue;
        }
        if !proof.compatible_current_configuration(context, &current)? {
            continue;
        }
        let origin = proof
            .origin
            .upgrade()
            .context("NATIVE_PLUGIN_ORIGIN_ENDED")?;
        let mut fact = NativeMcpSourceFact::from_resolved(
            context,
            &settings,
            origin.private_config(),
            Some(plugin),
            backend,
        )?;
        fact.certify_plugin_root_environment(
            context,
            origin.private_config(),
            &engine.plugin_snapshot(),
        )?;
        fact.leased_plugin = Some(proof);
        replacements.entry(fact.selector.key()?).or_insert(fact);
    }
    for (key, fact) in replacements {
        facts.retain(|current| current.selector.key().is_ok_and(|value| value != key));
        facts.push(fact);
    }
    let (after_settings, after) = factory.current_plugins_with_settings()?;
    ensure!(
        current.managed_operations == after.managed_operations
            && current.mcp_configs == after.mcp_configs
            && current.mcp_config_sources == after.mcp_config_sources
            && after_settings.plugins == settings.plugins
            && after_settings.credential_store == settings.credential_store
            && after_settings.mcp_disabled_servers == settings.mcp_disabled_servers,
        "NATIVE_PLUGIN_CONFIGURATION_CHANGED"
    );
    context.verify()?;
    Ok(facts)
}

//! Runtime plugin observations and MCP source projection.

use anyhow::Result;
use kcoder_config::Settings;
use kcoder_mcp::McpServerConfig;
use kcoder_plugins::EffectivePluginSnapshot;

pub fn runtime_plugin_snapshot(
    cwd: &std::path::Path,
    folder_trusted: bool,
    settings: &Settings,
) -> Result<kcoder_plugins::EffectivePluginSnapshot> {
    if settings.training_mode {
        return Ok(kcoder_plugins::EffectivePluginSnapshot::default());
    }
    #[cfg(windows)]
    if kcoder_plugins::computer_use_policy_allows(&settings.plugins)
        && !kcoder_plugins::computer_use_requires_explicit_enable(
            &settings.plugins,
            &settings.mcp_servers,
        )
        && std::env::current_exe()
            .ok()
            .and_then(|exe| {
                exe.parent()?
                    .parent()
                    .map(|root| root.join("computer-use/runtime-manifest.json"))
            })
            .is_some_and(|path| path.is_file())
    {
        let id = kcoder_plugins::PluginId::new("kcoder-windows-computer-use", "kcoder-bundled")?;
        if kcoder_plugins::PluginStore::open_default()?
            .read(&id)?
            .is_none_or(|record| kcoder_plugins::computer_use_guidance_needs_update(&record.source))
        {
            let manager =
                kcoder_plugins::PluginManager::open_default_for_cwd_with_effective_settings(
                    cwd,
                    settings.plugins.clone(),
                )?;
            manager.install_from_marketplace(
                cwd,
                false,
                "kcoder-bundled",
                "kcoder-windows-computer-use",
            )?;
        }
    }
    let credentials_path = kcoder_config::ConfigPaths::discover(cwd)?.credentials;
    runtime_plugin_snapshot_with_profile(cwd, folder_trusted, settings, &credentials_path)
}

pub fn runtime_plugin_snapshot_with_profile(
    cwd: &std::path::Path,
    folder_trusted: bool,
    settings: &Settings,
    credentials_path: &std::path::Path,
) -> Result<kcoder_plugins::EffectivePluginSnapshot> {
    if settings.training_mode {
        return Ok(kcoder_plugins::EffectivePluginSnapshot::default());
    }
    let manager = kcoder_plugins::PluginManager::open_default_for_cwd_with_effective_settings(
        cwd,
        settings.plugins.clone(),
    )?;
    let values =
        crate::credentials::by_operation(credentials_path, settings.credential_store, &manager)?;
    manager.effective_snapshot_with_credentials(cwd, folder_trusted, &values)
}

pub struct ConfiguredMcp {
    pub config: McpServerConfig,
    pub plugin_id: Option<String>,
}

/// Project the MCP sources from one observed settings and plugin snapshot.
pub fn configured_mcp_servers(
    settings: &Settings,
    plugins: &EffectivePluginSnapshot,
    settings_contain_plugin_mcp: bool,
) -> Vec<ConfiguredMcp> {
    let configured_count = if !settings_contain_plugin_mcp {
        settings.mcp_servers.len()
    } else {
        settings
            .mcp_servers
            .len()
            .saturating_sub(plugins.mcp_configs.len())
    };
    let mut result: Vec<_> = settings
        .mcp_servers
        .iter()
        .take(configured_count)
        .cloned()
        .map(|config| ConfiguredMcp {
            config,
            plugin_id: None,
        })
        .collect();
    for (config, source) in plugins
        .mcp_configs
        .iter()
        .cloned()
        .zip(&plugins.mcp_config_sources)
    {
        result.push(ConfiguredMcp {
            config,
            plugin_id: Some(source.plugin_id.clone()),
        });
    }
    result
}

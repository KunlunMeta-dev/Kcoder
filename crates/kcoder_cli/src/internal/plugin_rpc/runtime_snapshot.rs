//! Runtime plugin observations and MCP source projection.

use anyhow::{Context, Result};
use kcoder_config::Settings;
use kcoder_mcp::McpServerConfig;
use kcoder_plugins::EffectivePluginSnapshot;

pub fn runtime_plugin_snapshot(
    cwd: &std::path::Path,
    folder_trusted: bool,
    settings: &Settings,
    credentials_path: &std::path::Path,
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
        let manager = kcoder_plugins::PluginManager::open_for_profile(
            cwd,
            credentials_path
                .parent()
                .context("Plugin credential profile directory unavailable")?,
            settings.plugins.clone(),
        )?;
        if manager
            .store()
            .read(&id)?
            .is_none_or(|record| kcoder_plugins::computer_use_guidance_needs_update(&record.source))
        {
            manager.install_from_marketplace(
                cwd,
                false,
                "kcoder-bundled",
                "kcoder-windows-computer-use",
            )?;
        }
    }
    runtime_plugin_snapshot_with_profile(cwd, folder_trusted, settings, credentials_path)
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
    let manager = kcoder_plugins::PluginManager::open_for_profile(
        cwd,
        credentials_path
            .parent()
            .context("Plugin credential profile directory unavailable")?,
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
) -> Result<Vec<ConfiguredMcp>> {
    Ok(plugins
        .configured_mcp_servers(settings)?
        .map(|(config, source)| ConfiguredMcp {
            config: config.clone(),
            plugin_id: source.map(|source| source.plugin_id.clone()),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn selected_profile_owns_management_startup_and_runtime_snapshots() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("workspace");
        let profile = temp.path().join("selected-profile");
        let plugin = profile.join("plugins/direct");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(
            plugin.join("plugin.json"),
            json!({
                "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
                "name": "profile-owned",
                "version": "1.0.0"
            })
            .to_string(),
        )
        .unwrap();
        let settings = Settings::default();
        let credentials = profile.join("credentials.json");
        let processor = crate::PluginProcessor::open_with_profile(
            &cwd,
            settings.plugins.clone(),
            credentials.clone(),
            settings.credential_store,
        )
        .unwrap();
        assert_eq!(
            std::fs::canonicalize(processor.manager.store().root()).unwrap(),
            std::fs::canonicalize(profile.join("plugin_store")).unwrap()
        );
        let listed = processor.manager.list(&cwd, false).unwrap();
        assert_eq!(listed.plugins.len(), 1);
        assert_eq!(listed.plugins[0].id, "profile-owned");
        for snapshot in [
            runtime_plugin_snapshot(&cwd, false, &settings, &credentials).unwrap(),
            runtime_plugin_snapshot_with_profile(&cwd, false, &settings, &credentials).unwrap(),
        ] {
            assert_eq!(snapshot.plugin_ids, vec!["profile-owned"]);
        }
        assert!(!credentials.exists());
    }
}

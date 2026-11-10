//! Initial MCP tool registration for CLI and App Server startup.

use std::{collections::BTreeSet, path::Path, sync::Arc};

use anyhow::{Context, Result};
use kcoder_cli_commands::{
    cli_args::{Cli, Commands},
    mcp_connection,
};
use kcoder_config::{ConfigPaths, Settings};
use kcoder_mcp::McpTool;
use kcoder_plugins::EffectivePluginSnapshot;
use kcoder_tools::ToolRegistry;
use tracing::{info, warn};

use crate::builtin_tools_for_settings;

pub async fn configure_startup_tools(
    cli: &Cli,
    settings: &mut Settings,
    paths: &ConfigPaths,
    cwd: &Path,
    trust_store_config_dir: &Path,
    project_mcp_names: &BTreeSet<String>,
    plugin_snapshot: &EffectivePluginSnapshot,
) -> Result<(ToolRegistry, bool)> {
    let configured_mcp_server_count = settings.mcp_servers.len();
    settings
        .mcp_servers
        .extend(plugin_snapshot.mcp_configs.iter().cloned());
    settings.runtime_plugin_mcp_count = plugin_snapshot.mcp_configs.len();

    let plugin_manager =
        kcoder_plugins::PluginManager::open_default_for_cwd_with_effective_settings(
            cwd,
            settings.plugins.clone(),
        )?;
    let private_plugin_values = kcoder_plugin_rpc::credentials::by_operation(
        &paths.credentials,
        settings.credential_store,
        &plugin_manager,
    )?;
    let effective_tool_profile = cli.tool_profile.effective(settings.tools.profile);
    let mut tools = builtin_tools_for_settings(cli, settings);
    let is_app_server = matches!(cli.command, Some(Commands::AppServer { .. }));
    // Optional services must leave room for the Gateway's 12-second initialize handshake.
    let mcp_startup_deadline =
        is_app_server.then(|| tokio::time::Instant::now() + std::time::Duration::from_secs(8));
    let mut mcp_snapshot_complete = true;
    if !matches!(effective_tool_profile, kcoder_config::ToolProfile::None) {
        for (server_index, server) in settings.mcp_servers.iter().enumerate() {
            if !settings.mcp_server_enabled(&server.name) {
                continue;
            }
            let plugin_source = if server_index < configured_mcp_server_count {
                None
            } else if let Some(source) = plugin_snapshot
                .mcp_config_sources
                .get(server_index - configured_mcp_server_count)
            {
                Some(source)
            } else {
                let diagnostic = format!(
                    "MCP server {:?} rejected: plugin contribution has no source identity",
                    server.name
                );
                warn!("{diagnostic}");
                eprintln!("[kcoder] {diagnostic}");
                continue;
            };
            let private = kcoder_mcp::tool::PrivateValues::new(
                plugin_source
                    .and_then(|source| plugin_snapshot.managed_operations.get(&source.plugin_id))
                    .and_then(|operation| private_plugin_values.get(operation))
                    .into_iter()
                    .flat_map(|values| values.values().cloned()),
            )?;
            let connected = if let Some(deadline) = mcp_startup_deadline {
                tokio::time::timeout_at(
                    deadline,
                    mcp_connection::connect_private(
                        server,
                        Arc::clone(&private),
                        &paths.config_dir,
                        settings.credential_store,
                    ),
                )
                .await
                .context("optional MCP startup deadline exceeded")
                .and_then(std::convert::identity)
            } else {
                mcp_connection::connect_private(
                    server,
                    Arc::clone(&private),
                    &paths.config_dir,
                    settings.credential_store,
                )
                .await
            };
            match connected {
                Ok((handle, mut defs)) => {
                    if let Some(source) = plugin_source {
                        defs.retain(|definition| source.tool_policy.allows(&definition.name));
                    }
                    info!(
                        "MCP server '{}' connected with {} tools",
                        server.name,
                        defs.len()
                    );
                    let conflicts = tools.extend(defs.into_iter().filter_map(|definition| {
                        let tool = McpTool::new(&server.name, Arc::clone(&handle), definition)
                            .with_credential_context(
                                kcoder_mcp::server_policy::CredentialContext {
                                    config_dir: paths.config_dir.clone(),
                                    mode: settings.credential_store,
                                },
                            );
                        let tool = match plugin_source {
                            Some(source) => {
                                let tool = tool.with_plugin_source(&source.plugin_id);
                                match tool.with_private_values(Arc::clone(&private)) {
                                    Ok(tool) => tool,
                                    Err(_) => return None,
                                }
                            }
                            None => tool,
                        };
                        let required_trust = plugin_source
                            .and_then(|source| source.required_trust_directory.as_deref())
                            .or_else(|| project_mcp_names.contains(&server.name).then_some(cwd));
                        let tool = match required_trust {
                            Some(directory) => {
                                tool.with_folder_trust(directory, trust_store_config_dir)
                            }
                            None => tool,
                        };
                        Some(Arc::new(tool) as Arc<dyn kcoder_tools::Tool>)
                    }));
                    for conflict in conflicts {
                        warn!("{conflict}");
                        eprintln!("[kcoder] {conflict}");
                    }
                }
                Err(e) => {
                    mcp_snapshot_complete = false;
                    if plugin_source
                        .and_then(|source| {
                            plugin_snapshot.managed_operations.get(&source.plugin_id)
                        })
                        .and_then(|operation| private_plugin_values.get(operation))
                        .is_some_and(|values| !values.is_empty())
                    {
                        warn!(server = %server.name, code = "mcp_unavailable", "Private plugin MCP connection failed");
                    } else {
                        warn!("failed to connect MCP server '{}': {e:#}", server.name);
                    }
                }
            }
        }
    }
    if !settings.tools.disabled.is_empty() {
        tools = tools.filtered_out_by_patterns(&settings.tools.disabled);
    }
    Ok((tools, mcp_snapshot_complete))
}

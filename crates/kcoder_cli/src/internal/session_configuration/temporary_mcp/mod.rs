//! Owned launch and cleanup for client-supplied temporary MCP servers.

use anyhow::{Result, ensure};
#[cfg(any(target_os = "linux", windows))]
use futures::FutureExt;
use kcoder_app_protocol::ThreadMcpServerV1;
use kcoder_config::Settings;
use kcoder_mcp::{McpServerConfig, McpTool};
use kcoder_tools::ToolRegistry;
use std::{
    collections::{BTreeSet, HashMap},
    path::Path,
    sync::Arc,
    time::Duration,
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

/// Register tools against the connection owner's lease. The owner revokes it
/// when setup fails or the session stops accepting input.
pub async fn connect_tools(
    workspace: &Path,
    servers: &[ThreadMcpServerV1],
    disconnected: &CancellationToken,
    revoked: &CancellationToken,
    #[cfg_attr(not(any(target_os = "linux", windows)), allow(unused_variables))]
    cleanup: &mut JoinSet<Result<()>>,
) -> Result<ToolRegistry> {
    let mut tools = ToolRegistry::new();
    for (index, server) in servers.iter().enumerate() {
        let private = kcoder_mcp::tool::PrivateValues::new(server.env.values().cloned())?;
        ensure!(
            !private.contains(&server.name),
            "Temporary MCP /name contains private environment data"
        );
        let config = McpServerConfig {
            name: server.name.clone(),
            transport: "stdio".into(),
            command: server.command.clone(),
            args: server.args.clone(),
            env: server.env.clone().into_iter().collect::<HashMap<_, _>>(),
            url: String::new(),
            headers: HashMap::new(),
            policy: Default::default(),
        };
        #[cfg(any(target_os = "linux", windows))]
        let supervisor = std::env::current_exe()
            .map_err(|_| anyhow::anyhow!("Temporary MCP owner executable unavailable"))?;
        #[cfg(any(target_os = "linux", windows))]
        let connect = kcoder_mcp::connect_owned_session_server(&config, &supervisor, |monitor| {
            cleanup.spawn(monitor.wait().boxed());
        });
        #[cfg(not(any(target_os = "linux", windows)))]
        let connect = kcoder_mcp::connect_session_server(&config);
        let connected = tokio::select! {
            biased;
            _ = disconnected.cancelled() => anyhow::bail!("Temporary MCP setup cancelled because its client disconnected"),
            connected = tokio::time::timeout(Duration::from_secs(20), connect) => connected,
        };
        let (handle, definitions) = connected
            .map_err(|_| {
                anyhow::anyhow!(
                    "Temporary MCP server {} initialization timed out after 20s",
                    index + 1
                )
            })?
            .map_err(|error| {
                anyhow::anyhow!(
                    "Temporary MCP server {} initialization failed ({:?})",
                    index + 1,
                    kcoder_mcp::failure::failure_reason(&error)
                )
            })?;
        // The worker owns closure even while Engine/tool clones retain Arc handles.
        let owned = handle.clone();
        let closed = revoked.clone();
        tokio::spawn(async move {
            closed.cancelled().await;
            owned.lock().await.close();
        });
        for definition in definitions {
            let tool = McpTool::new(&server.name, handle.clone(), definition)
                .with_private_values(private.clone())
                .map_err(|_| {
                    anyhow::anyhow!(
                        "Temporary MCP server {} tool identity contains private data",
                        index + 1
                    )
                })?
                .with_folder_trust(workspace, kcoder_config::Settings::config_dir()?)
                .with_session_lease(revoked.clone());
            tools.try_register(Arc::new(tool)).map_err(|_| {
                anyhow::anyhow!(
                    "Temporary MCP server {} exposes duplicate tool identities",
                    index + 1
                )
            })?;
        }
    }
    Ok(tools)
}

pub async fn await_cleanup(tasks: &mut JoinSet<Result<()>>) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(4), async {
        while let Some(result) = tasks.join_next().await {
            result.map_err(|_| anyhow::anyhow!("Temporary MCP cleanup task failed"))??;
        }
        Ok(())
    })
    .await
    .map_err(|_| anyhow::anyhow!("Temporary MCP cleanup is unconfirmed after 4s"))?
}

pub fn validate_servers(
    servers: &[ThreadMcpServerV1],
    settings: &Settings,
    plugin_configs: &[McpServerConfig],
) -> Result<()> {
    let mut names = settings
        .mcp_servers
        .iter()
        .map(|server| server.name.clone())
        .collect::<BTreeSet<_>>();
    names.extend(plugin_configs.iter().map(|server| server.name.clone()));
    for server in servers {
        ensure!(
            settings.mcp_server_enabled(&server.name),
            "Temporary MCP server is disabled on this target"
        );
        server.validate().map_err(anyhow::Error::msg)?;
        if cfg!(windows) {
            let names = server
                .env
                .keys()
                .map(|name| name.to_ascii_lowercase())
                .collect::<BTreeSet<_>>();
            ensure!(
                names.len() == server.env.len(),
                "Temporary MCP /env contains case-insensitive duplicate names"
            );
        }
        ensure!(
            Path::new(&server.command).is_absolute(),
            "Temporary MCP /command must be an absolute executable path"
        );
        ensure!(
            names.insert(server.name.clone()),
            "Temporary MCP /name conflicts with an existing server"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cleanup_preserves_worker_failure() {
        let mut workers = JoinSet::new();
        workers.spawn(async { anyhow::bail!("owner did not confirm cleanup") });

        let error = await_cleanup(&mut workers).await.unwrap_err();
        assert_eq!(error.to_string(), "owner did not confirm cleanup");
        assert!(workers.is_empty());
    }
}

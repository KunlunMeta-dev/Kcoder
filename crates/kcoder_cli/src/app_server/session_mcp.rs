//! Temporary client MCP services never enter Settings, snapshots or connection caches.
use anyhow::{Result, ensure};
use kcoder_app_protocol::{THREAD_MCP_SERVER_LIMIT, ThreadMcpServerV1};
use kcoder_engine::QueryEngine;
use tokio_util::sync::CancellationToken;

pub use kcoder_session_configuration::temporary_mcp::await_cleanup;

#[derive(Debug)]
pub struct SetupError(String);
impl std::fmt::Display for SetupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}
impl std::error::Error for SetupError {}

pub fn attach<'a>(
    engine: QueryEngine,
    servers: &'a [ThreadMcpServerV1],
    trusted: bool,
    disconnected: &'a CancellationToken,
    cleanup: &'a mut tokio::task::JoinSet<Result<()>>,
) -> futures::future::BoxFuture<'a, Result<QueryEngine>> {
    Box::pin(attach_producer(
        engine,
        servers,
        trusted,
        disconnected,
        cleanup,
    ))
}

async fn attach_producer(
    engine: QueryEngine,
    servers: &[ThreadMcpServerV1],
    trusted: bool,
    disconnected: &CancellationToken,
    cleanup: &mut tokio::task::JoinSet<Result<()>>,
) -> Result<QueryEngine> {
    attach_private(engine, servers, trusted, disconnected, cleanup)
        .await
        .map_err(|error| {
            // All inner launch/registration failures are replaced with fixed diagnostics.
            anyhow::Error::new(SetupError(error.to_string()))
        })
}

async fn attach_private(
    engine: QueryEngine,
    servers: &[ThreadMcpServerV1],
    trusted: bool,
    disconnected: &CancellationToken,
    cleanup: &mut tokio::task::JoinSet<Result<()>>,
) -> Result<QueryEngine> {
    if servers.is_empty() {
        return Ok(engine);
    }
    while let Some(result) = cleanup.try_join_next() {
        result.map_err(|_| anyhow::anyhow!("Temporary MCP cleanup task failed"))??;
    }
    validate(&engine, servers, trusted)?;
    let disabled = engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("Session settings unavailable"))?
        .tools
        .disabled
        .clone();
    let revoked = CancellationToken::new();
    let rollback = revoked.clone().drop_guard();
    let tools = kcoder_session_configuration::temporary_mcp::connect_tools(
        &engine.state.cwd(),
        servers,
        disconnected,
        &revoked,
        cleanup,
    )
    .await?;
    let engine = engine
        .with_session_tools(tools.filtered_out_by_patterns(&disabled), revoked)
        .map_err(|_| {
            anyhow::anyhow!("Temporary MCP tool registration conflicts with the session registry")
        })?;
    rollback.disarm();
    Ok(engine)
}

fn validate(engine: &QueryEngine, servers: &[ThreadMcpServerV1], trusted: bool) -> Result<()> {
    ensure!(
        trusted,
        "Temporary MCP requires a trusted session directory"
    );
    ensure!(
        servers.len() <= THREAD_MCP_SERVER_LIMIT,
        "Temporary MCP server limit is 16"
    );
    ensure!(
        !engine.tools.names().is_empty(),
        "Temporary MCP is disabled by the active tool profile"
    );
    let settings = engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("Session settings unavailable"))?;
    kcoder_session_configuration::temporary_mcp::validate_servers(
        servers,
        &settings,
        &engine.plugin_snapshot().mcp_configs,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_mcp::McpServerConfig;
    use kcoder_tools::{FileReadTool, ToolRegistry};

    #[tokio::test]
    async fn preflight_rejects_untrusted_empty_profile_duplicate_and_configured_names() {
        let root = tempfile::tempdir().unwrap();
        let runtime = super::super::thread_runtime::test_support::test_runtime(
            "fixture",
            &root.path().join("history"),
        );
        let mut engine = runtime.engine();
        let server = ThreadMcpServerV1 {
            name: "host".into(),
            command: std::env::current_exe().unwrap().to_string_lossy().into(),
            args: vec![],
            env: Default::default(),
        };
        assert!(validate(&engine, std::slice::from_ref(&server), true).is_err());
        engine = engine.with_turn_tools(ToolRegistry::new().register(FileReadTool));
        assert!(validate(&engine, std::slice::from_ref(&server), false).is_err());
        assert!(validate(&engine, &[server.clone(), server.clone()], true).is_err());
        assert!(validate(&engine, std::slice::from_ref(&server), true).is_ok());
        engine
            .settings
            .write()
            .unwrap()
            .mcp_servers
            .push(McpServerConfig {
                name: "host".into(),
                transport: "stdio".into(),
                command: "existing".into(),
                args: vec![],
                env: Default::default(),
                url: String::new(),
                headers: Default::default(),
                policy: Default::default(),
            });
        assert!(validate(&engine, std::slice::from_ref(&server), true).is_err());
        runtime.shutdown().await;
    }
}

use super::engine_factory::AppServerEngineFactory;
use anyhow::Result;
use kcoder_app_protocol::{McpAuthorizationStatus as Status, McpListResult, McpServerSummary};
use kcoder_mcp::McpServerConfig;
use kcoder_plugin_rpc::mcp_authorization::{status, token_store_for};

pub(super) use kcoder_plugin_rpc::runtime_snapshot::ConfiguredMcp;

pub(super) async fn list(factory: AppServerEngineFactory) -> Result<McpListResult> {
    let source = factory.clone();
    let (settings, configured) = tokio::task::spawn_blocking(move || {
        Ok::<_, anyhow::Error>((source.current_settings()?, source.current_mcp_servers()?))
    })
    .await??;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    let mut servers = Vec::with_capacity(configured.len());
    for server in configured {
        let authorization = match tokio::time::timeout_at(deadline, status(&server.config)).await {
            Ok(Ok(status)) => status,
            _ => Status::Unavailable,
        };
        let attempt = factory.mcp_connection_attempt(&server.config);
        let last_connection_attempt = attempt.as_ref().map(|attempt| attempt.status.clone());
        let last_connection_failure = attempt.and_then(|attempt| attempt.failure_reason);
        servers.push(McpServerSummary {
            enabled: settings.mcp_server_enabled(&server.config.name),
            name: server.config.name,
            transport: server.config.transport,
            plugin_id: server.plugin_id,
            authorization,
            last_connection_attempt,
            last_connection_failure,
        });
    }
    Ok(McpListResult { servers })
}

pub(super) async fn set_enabled(
    factory: AppServerEngineFactory,
    params: kcoder_app_protocol::McpSetEnabledParams,
) -> Result<kcoder_app_protocol::McpSetEnabledResult> {
    let name = params.name.clone();
    tokio::task::spawn_blocking(move || {
        let servers = factory.current_mcp_servers()?;
        let matches = servers
            .iter()
            .filter(|server| server.config.name == params.name)
            .collect::<Vec<_>>();
        anyhow::ensure!(
            matches.len() == 1 && matches[0].plugin_id == params.plugin_id,
            "MCP server identity is unavailable or ambiguous on this target"
        );
        super::mcp_configuration::set_enabled(
            &factory.mcp_activation_user_settings_path()?,
            &params.name,
            params.enabled,
        )
    })
    .await??;
    Ok(kcoder_app_protocol::McpSetEnabledResult {
        name,
        enabled: params.enabled,
        applies_to_new_conversations: true,
    })
}

pub(super) async fn resolve(
    factory: AppServerEngineFactory,
    selector: kcoder_app_protocol::McpServerParams,
) -> Result<McpServerConfig> {
    let configured = tokio::task::spawn_blocking(move || factory.current_mcp_servers()).await??;
    let mut matches = configured.into_iter().filter(|server| {
        server.config.name == selector.name && server.plugin_id == selector.plugin_id
    });
    let selected = matches
        .next()
        .ok_or_else(|| anyhow::anyhow!("MCP server is not configured on this target"))?;
    if matches.next().is_some() {
        anyhow::bail!("MCP server identity is ambiguous; remove duplicate configuration");
    }
    Ok(selected.config)
}

pub(super) async fn logout(
    factory: AppServerEngineFactory,
    params: kcoder_app_protocol::McpServerParams,
) -> Result<kcoder_app_protocol::McpLogoutResult> {
    let config = resolve(factory, params).await?;
    if config.transport != "http" {
        anyhow::bail!("This MCP server does not use HTTP OAuth");
    }
    if config
        .headers
        .keys()
        .any(|name| name.eq_ignore_ascii_case("authorization"))
    {
        anyhow::bail!(
            "This MCP server uses a configured Authorization header; edit its configuration to remove it"
        );
    }
    let endpoint =
        reqwest::Url::parse(&config.url).map_err(|_| anyhow::anyhow!("Invalid MCP endpoint"))?;
    token_store_for(&config)?.logout_endpoint(&endpoint).await?;
    Ok(kcoder_app_protocol::McpLogoutResult { logged_out: true })
}

pub(super) async fn install(
    factory: AppServerEngineFactory,
    params: kcoder_app_protocol::McpInstallParams,
) -> Result<kcoder_app_protocol::McpConfigurationResult> {
    let fields = params
        .config
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("MCP configuration must be an object"))?;
    if fields.keys().any(|key| {
        ![
            "name",
            "transport",
            "command",
            "args",
            "url",
            "env",
            "headers",
            "policy",
        ]
        .contains(&key.as_str())
    }) {
        anyhow::bail!("Unsupported MCP configuration field");
    }
    let config: McpServerConfig = serde_json::from_value(params.config)
        .map_err(|_| anyhow::anyhow!("Invalid MCP configuration"))?;
    let name = config.name.clone();
    tokio::task::spawn_blocking(move || {
        let path = factory.mcp_user_settings_path()?;
        if factory
            .current_mcp_servers()?
            .iter()
            .any(|server| server.config.name == config.name)
        {
            anyhow::bail!("An MCP server with this name already exists on this target");
        }
        super::mcp_configuration::install(&path, config)
    })
    .await??;
    Ok(kcoder_app_protocol::McpConfigurationResult {
        name,
        applies_to_new_conversations: true,
    })
}

pub(super) async fn remove(
    factory: AppServerEngineFactory,
    params: kcoder_app_protocol::McpServerParams,
) -> Result<kcoder_app_protocol::McpConfigurationResult> {
    if params.plugin_id.is_some() {
        anyhow::bail!("Manage plugin MCP servers through their plugin");
    }
    let name = params.name;
    let removed = name.clone();
    tokio::task::spawn_blocking(move || {
        super::mcp_configuration::remove(&factory.mcp_user_settings_path()?, &removed)
    })
    .await??;
    Ok(kcoder_app_protocol::McpConfigurationResult {
        name,
        applies_to_new_conversations: true,
    })
}

mod provider_revocation;
pub(super) use provider_revocation::process as provider_revocation;

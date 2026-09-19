use super::engine_factory::AppServerEngineFactory;
use anyhow::Result;
use kcoder_app_protocol::{McpAuthorizationStatus as Status, McpListResult, McpServerSummary};
use kcoder_mcp::McpServerConfig;

pub(super) struct ConfiguredMcp {
    pub config: McpServerConfig,
    pub plugin_id: Option<String>,
}

pub(super) async fn list(factory: AppServerEngineFactory) -> Result<McpListResult> {
    let configured = tokio::task::spawn_blocking(move || factory.current_mcp_servers()).await??;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    let mut servers = Vec::with_capacity(configured.len());
    for server in configured {
        let authorization = match tokio::time::timeout_at(deadline, status(&server.config)).await {
            Ok(Ok(status)) => status,
            _ => Status::Unavailable,
        };
        servers.push(McpServerSummary {
            name: server.config.name,
            transport: server.config.transport,
            plugin_id: server.plugin_id,
            authorization,
        });
    }
    Ok(McpListResult { servers })
}

async fn status(config: &McpServerConfig) -> Result<Status> {
    if config.transport != "http" {
        return Ok(Status::NotApplicable);
    }
    if config
        .headers
        .keys()
        .any(|name| name.eq_ignore_ascii_case("authorization"))
    {
        return Ok(Status::ConfiguredHeader);
    }
    let endpoint = reqwest::Url::parse(&config.url)?;
    if kcoder_mcp::authorization::validate_endpoint(&endpoint).is_err() {
        return Ok(Status::NotApplicable);
    }
    let store = crate::mcp_connection::token_store()?;
    let association = store.acquire_connection(&endpoint).await?;
    let Some(saved) = association.load()? else {
        return Ok(Status::NotAuthorized);
    };
    let registration = store
        .acquire_registration(&saved.metadata, &saved.redirect_uri)
        .await?;
    let Some(client) = registration.load()? else {
        return Ok(Status::ReauthorizationRequired);
    };
    if client.client_id() != saved.binding.client_id {
        return Ok(Status::ReauthorizationRequired);
    }
    drop(registration);
    let lease = store.acquire(saved.binding).await?;
    let tokens = match lease.load() {
        Ok(Some(tokens)) => tokens,
        Ok(None) => return Ok(Status::NotAuthorized),
        Err(error)
            if error
                .downcast_ref::<kcoder_mcp::authorization_tokens::RefreshRecoveryRequired>()
                .is_some() =>
        {
            return Ok(Status::ReauthorizationRequired);
        }
        Err(error) => return Err(error),
    };
    if tokens
        .expires_at()
        .is_some_and(|expiry| expiry <= std::time::Instant::now())
    {
        return Ok(Status::Expired);
    }
    Ok(Status::Authorized)
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
    crate::mcp_connection::token_store()?
        .logout_endpoint(&endpoint)
        .await?;
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

pub mod authorization;
pub mod authorization_flow;
pub mod authorization_index;
pub mod authorization_registration;
pub mod authorization_session;
pub mod authorization_store;
mod authorization_token_shape;
pub mod authorization_tokens;
pub mod authorized_transport;
pub mod client;
pub mod model;
mod sse;
mod streamable_http;
pub mod tool;
pub mod transport;

pub use client::McpClient;
pub use kcoder_types::McpServerConfig;
pub use model::{CallToolResult, InitializeResult, ListToolsResult, McpToolDefinition};
pub use streamable_http::{AuthenticationRequired, StreamableHttpTransport};
pub use tool::{McpServerHandle, McpTool, mcp_tool_name};
pub use transport::{McpTransport, SseTransport, StdioTransport};

/// Start an MCP server from config and return the client plus all tool
/// definitions exposed by the server.
pub async fn connect_server(
    config: &McpServerConfig,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    let client = match config.transport.as_str() {
        "sse" => {
            if config.url.is_empty() {
                anyhow::bail!("MCP SSE transport requires a 'url' field");
            }
            let transport = SseTransport::new(&config.url).await?;
            McpClient::with_transport(Box::new(transport))
        }
        "http" => {
            if config.url.is_empty() {
                anyhow::bail!("MCP Streamable HTTP transport requires a 'url' field");
            }
            let transport = StreamableHttpTransport::new(&config.url, &config.headers).await?;
            McpClient::with_transport(Box::new(transport))
        }
        _ => McpClient::new(&config.command, &config.args, &config.env).await?,
    };
    initialize_client(client).await
}

/// Restore an endpoint's saved authorization, or use its ordinary configured transport.
pub async fn connect_server_with_store(
    config: &McpServerConfig,
    store: Arc<authorization_store::OAuthTokenStore>,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    if config.transport != "http"
        || config
            .headers
            .keys()
            .any(|name| name.eq_ignore_ascii_case("authorization"))
    {
        return connect_server(config).await;
    }
    let endpoint =
        reqwest::Url::parse(&config.url).map_err(|_| anyhow::anyhow!("Invalid MCP endpoint"))?;
    if authorization::validate_endpoint(&endpoint).is_err() {
        return connect_server(config).await;
    }
    let association = store.acquire_connection(&endpoint).await?;
    let Some(saved) = association.load()? else {
        drop(association);
        return connect_server(config).await;
    };
    let registration = store
        .acquire_registration(&saved.metadata, &saved.redirect_uri)
        .await?;
    let client = registration
        .load()?
        .ok_or_else(|| anyhow::anyhow!("Saved MCP OAuth client registration is unavailable"))?;
    drop(registration);
    connect_authorized_server(config, store, saved.binding, client).await
}

/// Connect using target-owned OAuth credentials; explicit configuration headers remain authoritative.
pub async fn connect_authorized_server(
    config: &McpServerConfig,
    store: Arc<authorization_store::OAuthTokenStore>,
    binding: authorization_store::CredentialBinding,
    client: authorization_registration::RegisteredClient,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    if config.transport != "http" {
        anyhow::bail!("MCP OAuth requires Streamable HTTP transport");
    }
    let transport = authorized_transport::AuthorizedHttpTransport::new(
        &config.url,
        &config.headers,
        store,
        binding,
        client,
    )
    .await?;
    initialize_client(McpClient::with_transport(Box::new(transport))).await
}

async fn initialize_client(
    mut client: McpClient,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    let _info = client.initialize().await?;
    let tools = client.list_tools().await?;
    let handle: McpServerHandle = Arc::new(Mutex::new(client));
    Ok((handle, tools))
}

use std::sync::Arc;
use tokio::sync::Mutex;

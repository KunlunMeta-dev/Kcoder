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
#[cfg(windows)]
pub mod desktop_host;
#[cfg(windows)]
pub mod desktop_recovery;
#[cfg(windows)]
mod desktop_recovery_launch;
#[cfg(any(windows, test))]
mod desktop_stdio_codec;
#[cfg(windows)]
pub mod desktop_tool;
#[cfg(windows)]
pub mod desktop_worker;
pub mod failure;
pub mod model;
mod result_content;
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
    connect_server_private_impl(config, false).await
}

async fn connect_server_private_impl(
    config: &McpServerConfig,
    private: bool,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    let client = match config.transport.as_str() {
        "sse" => {
            if config.url.is_empty() {
                anyhow::bail!("MCP SSE transport requires a 'url' field");
            }
            let transport = SseTransport::with_headers(&config.url, &config.headers).await?;
            McpClient::with_transport(Box::new(transport))
        }
        "http" => {
            if config.url.is_empty() {
                anyhow::bail!("MCP Streamable HTTP transport requires a 'url' field");
            }
            let transport = StreamableHttpTransport::new(&config.url, &config.headers).await?;
            McpClient::with_transport(Box::new(transport))
        }
        _ => McpClient::with_transport(Box::new(
            StdioTransport::new_private(&config.command, &config.args, &config.env, private)
                .await?,
        )),
    };
    initialize_client(client.with_private_context(private)).await
}

/// Restore an endpoint's saved authorization, or use its ordinary configured transport.
pub async fn connect_server_with_store(
    config: &McpServerConfig,
    store: Arc<authorization_store::OAuthTokenStore>,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    connect_store_private_impl(config, store, false).await
}

/// Host-only context binds redaction to this server, not a process-wide setting.
pub async fn connect_server_with_private_values(
    config: &McpServerConfig,
    store: Option<Arc<authorization_store::OAuthTokenStore>>,
    values: Arc<tool::PrivateValues>,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    let private = !values.is_empty();
    let result = match store {
        Some(store) => connect_store_private_impl(config, store, private).await,
        None => connect_server_private_impl(config, private).await,
    };
    result.map_err(|error| {
        if private {
            failure::McpFailure {
                reason: failure::failure_reason(&error),
                message: "mcp_private_connection_failed",
            }
            .into()
        } else {
            error
        }
    })
}

async fn connect_store_private_impl(
    config: &McpServerConfig,
    store: Arc<authorization_store::OAuthTokenStore>,
    private: bool,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    if config.transport != "http"
        || config
            .headers
            .keys()
            .any(|name| name.eq_ignore_ascii_case("authorization"))
    {
        return connect_server_private_impl(config, private).await;
    }
    let endpoint =
        reqwest::Url::parse(&config.url).map_err(|_| anyhow::anyhow!("Invalid MCP endpoint"))?;
    if authorization::validate_endpoint(&endpoint).is_err() {
        return connect_server_private_impl(config, private).await;
    }
    let association = store.acquire_connection(&endpoint).await?;
    let Some(saved) = association.load()? else {
        drop(association);
        return connect_server_private_impl(config, private).await;
    };
    let registration = store
        .acquire_registration(&saved.metadata, &saved.redirect_uri)
        .await?;
    let client = registration.load()?.ok_or_else(|| {
        failure::authorization("Saved MCP OAuth client registration is unavailable")
    })?;
    drop(registration);
    connect_authorized_private_impl(config, store, saved.binding, client, private).await
}

/// Connect using target-owned OAuth credentials; explicit configuration headers remain authoritative.
pub async fn connect_authorized_server(
    config: &McpServerConfig,
    store: Arc<authorization_store::OAuthTokenStore>,
    binding: authorization_store::CredentialBinding,
    client: authorization_registration::RegisteredClient,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    connect_authorized_private_impl(config, store, binding, client, false).await
}
async fn connect_authorized_private_impl(
    config: &McpServerConfig,
    store: Arc<authorization_store::OAuthTokenStore>,
    binding: authorization_store::CredentialBinding,
    client: authorization_registration::RegisteredClient,
    private: bool,
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
    initialize_client(McpClient::with_transport(Box::new(transport)).with_private_context(private))
        .await
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

#[cfg(test)]
mod private_connection_tests {
    use super::*;
    #[tokio::test]
    async fn private_command_failure_has_no_secret_display_or_debug_cause() {
        let secret = "p09-missing-command-Synthetic/Value+%";
        let config: McpServerConfig = serde_json::from_value(serde_json::json!({
            "name":"owned", "transport":"stdio", "command":secret,
            "env":{"FOO":secret}, "headers":{"X-Custom":secret}
        }))
        .unwrap();
        let values = tool::PrivateValues::new([secret.into()]).unwrap();
        let error = connect_server_with_private_values(&config, None, values)
            .await
            .err()
            .unwrap();
        assert!(!format!("{error:?} {error:#}").contains(secret));
        assert!(error.to_string().contains("mcp_private_connection_failed"));
        let ordinary = connect_server(&config).await.err().unwrap();
        assert!(ordinary.to_string().contains(secret));
    }
}

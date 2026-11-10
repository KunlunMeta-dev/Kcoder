pub mod apps;
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
pub mod desktop_tool;
#[cfg(windows)]
pub mod desktop_worker;
pub mod failure;
pub mod model;
pub mod native_origin;
mod result_content;
pub mod searxng;
mod searxng_proxy_routes;
pub mod searxng_runtime;
pub mod server_policy;
mod sse;
mod streamable_http;
pub mod tool;
pub mod transport;
pub mod web_search;

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
    connect_server_private_impl(config, false, false, None).await
}

async fn connect_server_private_impl(
    config: &McpServerConfig,
    private: bool,
    apps: bool,
    context: Option<&server_policy::CredentialContext>,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    server_policy::validate(config)?;
    let result = server_policy::startup(
        config.policy.startup_timeout_secs,
        connect_server_private_inner(config, private, apps, context),
    )
    .await;
    private_policy_result(config, result)
}

fn private_policy_result<T>(
    config: &McpServerConfig,
    result: anyhow::Result<T>,
) -> anyhow::Result<T> {
    result.map_err(|error| {
        if !config.policy.env_vars.is_empty()
            || config.policy.credential_ref.is_some()
            || !config.policy.env_aliases.is_empty()
            || !config.policy.env_http_headers.is_empty()
            || config.policy.bearer_token_env_var.is_some()
        {
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

async fn connect_server_private_inner(
    config: &McpServerConfig,
    private: bool,
    apps: bool,
    context: Option<&server_policy::CredentialContext>,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    let (config, values) = server_policy::prepare_in(config, context)?;
    let private = private || !values.is_empty();
    let config = &config;
    let client = match config.transport.as_str() {
        "searxng" => {
            McpClient::with_transport(Box::new(searxng::SearxngTransport::connect(config).await?))
        }
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
        "stdio" => McpClient::with_transport(Box::new(
            StdioTransport::new_private_in(
                &config.command,
                &config.args,
                &config.env,
                private,
                config.policy.cwd.as_deref().map(std::path::Path::new),
            )
            .await?,
        )),
        _ => anyhow::bail!("Unsupported MCP transport"),
    };
    initialize_client(
        client
            .with_private_context(private)
            .with_server_policy(config.policy.clone(), values)
            .with_apps_support(apps)?,
    )
    .await
}

/// Restore an endpoint's saved authorization, or use its ordinary configured transport.
pub async fn connect_server_with_store(
    config: &McpServerConfig,
    store: Arc<authorization_store::OAuthTokenStore>,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    connect_store_private_impl(config, store, false, false, None).await
}

/// Session launch data is always private, including servers with an empty environment.
pub async fn connect_session_server(
    config: &McpServerConfig,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    anyhow::ensure!(
        config.transport == "stdio",
        "Session MCP supports stdio only"
    );
    connect_server_private_impl(config, true, false, None)
        .await
        .map_err(|error| {
            failure::McpFailure {
                reason: failure::failure_reason(&error),
                message: "session_mcp_connection_failed",
            }
            .into()
        })
}

/// A host provides its private helper and registers exit observation before handshake.
#[cfg(any(target_os = "linux", windows))]
pub async fn connect_owned_session_server(
    config: &McpServerConfig,
    supervisor: &std::path::Path,
    observe: impl FnOnce(transport::OwnedStdioExit),
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    anyhow::ensure!(
        config.policy.is_empty(),
        "Temporary MCP does not accept persistent server policy"
    );
    anyhow::ensure!(
        config.transport == "stdio",
        "Session MCP supports stdio only"
    );
    let setup = async {
        let (transport, monitor) = StdioTransport::new_owned_private(
            &config.command,
            &config.args,
            &config.env,
            supervisor,
        )
        .await?;
        observe(monitor);
        initialize_client(McpClient::with_transport(Box::new(transport)).with_private_context(true))
            .await
    };
    setup.await.map_err(|error| {
        failure::McpFailure {
            reason: failure::failure_reason(&error),
            message: "session_mcp_connection_failed",
        }
        .into()
    })
}

/// Host-only context binds redaction to this server, not a process-wide setting.
pub async fn connect_server_with_private_values(
    config: &McpServerConfig,
    store: Option<Arc<authorization_store::OAuthTokenStore>>,
    values: Arc<tool::PrivateValues>,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    connect_server_with_private_values_in(config, store, values, None).await
}

/// Use the host's resolved target profile and credential policy without reloading overlays.
pub async fn connect_server_with_private_values_in(
    config: &McpServerConfig,
    store: Option<Arc<authorization_store::OAuthTokenStore>>,
    values: Arc<tool::PrivateValues>,
    context: Option<&server_policy::CredentialContext>,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    let origin = native_origin::NativeMcpConnectionOrigin::capture(config, context)
        .ok()
        .flatten();
    let private = !values.is_empty();
    let result = match store {
        Some(store) => connect_store_private_impl(config, store, private, false, context).await,
        None => connect_server_private_impl(config, private, false, context).await,
    };
    if let Ok((handle, _)) = &result {
        native_origin::attach_after_connect(handle, origin).await;
    }
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

/// Open a dedicated presentation connection after host isolation and user authority
/// have been established. Existing CLI/shared connection entrypoints never advertise Apps.
pub async fn connect_server_for_apps(
    config: &McpServerConfig,
    store: Option<Arc<authorization_store::OAuthTokenStore>>,
    values: Arc<tool::PrivateValues>,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    connect_server_for_apps_in(config, store, values, None).await
}

/// Dedicated Apps connections retain the same target credential authority as their source.
pub async fn connect_server_for_apps_in(
    config: &McpServerConfig,
    store: Option<Arc<authorization_store::OAuthTokenStore>>,
    values: Arc<tool::PrivateValues>,
    context: Option<&server_policy::CredentialContext>,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    let origin = native_origin::NativeMcpConnectionOrigin::capture(config, context)
        .ok()
        .flatten();
    let private = !values.is_empty();
    let result = match store {
        Some(store) => connect_store_private_impl(config, store, private, true, context).await,
        None => connect_server_private_impl(config, private, true, context).await,
    };
    if let Ok((handle, _)) = &result {
        native_origin::attach_after_connect(handle, origin).await;
    }
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
    apps: bool,
    context: Option<&server_policy::CredentialContext>,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    anyhow::ensure!(
        store.account.as_deref() == config.policy.oauth_account.as_deref(),
        "MCP OAuth account slot does not match the configured connection"
    );
    if config.transport != "http"
        || config.policy.credential_ref.is_some()
        || config.policy.bearer_token_env_var.is_some()
        || config
            .policy
            .env_http_headers
            .keys()
            .any(|name| name.eq_ignore_ascii_case("authorization"))
        || config
            .headers
            .keys()
            .any(|name| name.eq_ignore_ascii_case("authorization"))
    {
        return connect_server_private_impl(config, private, apps, context).await;
    }
    let endpoint =
        reqwest::Url::parse(&config.url).map_err(|_| anyhow::anyhow!("Invalid MCP endpoint"))?;
    if authorization::validate_endpoint(&endpoint).is_err() {
        return connect_server_private_impl(config, private, apps, context).await;
    }
    let association = store.acquire_connection(&endpoint).await?;
    let Some(saved) = association.load()? else {
        drop(association);
        return connect_server_private_impl(config, private, apps, context).await;
    };
    let registration = store
        .acquire_registration(&saved.metadata, &saved.redirect_uri)
        .await?;
    let client = registration.load()?.ok_or_else(|| {
        failure::authorization("Saved MCP OAuth client registration is unavailable")
    })?;
    drop(registration);
    connect_authorized_private_impl(config, store, saved.binding, client, private, apps).await
}

/// Connect using target-owned OAuth credentials; explicit configuration headers remain authoritative.
pub async fn connect_authorized_server(
    config: &McpServerConfig,
    store: Arc<authorization_store::OAuthTokenStore>,
    binding: authorization_store::CredentialBinding,
    client: authorization_registration::RegisteredClient,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    connect_authorized_private_impl(config, store, binding, client, false, false).await
}
async fn connect_authorized_private_impl(
    config: &McpServerConfig,
    store: Arc<authorization_store::OAuthTokenStore>,
    binding: authorization_store::CredentialBinding,
    client: authorization_registration::RegisteredClient,
    private: bool,
    apps: bool,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    anyhow::ensure!(
        store.account.as_deref() == config.policy.oauth_account.as_deref(),
        "MCP OAuth account slot does not match the configured connection"
    );
    server_policy::validate(config)?;
    anyhow::ensure!(
        config.policy.credential_ref.is_none(),
        "Explicit MCP credential references cannot be combined with OAuth"
    );
    private_policy_result(
        config,
        server_policy::startup(
            config.policy.startup_timeout_secs,
            connect_authorized_private_inner(config, store, binding, client, private, apps),
        )
        .await,
    )
}

async fn connect_authorized_private_inner(
    config: &McpServerConfig,
    store: Arc<authorization_store::OAuthTokenStore>,
    binding: authorization_store::CredentialBinding,
    client: authorization_registration::RegisteredClient,
    private: bool,
    apps: bool,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    let (config, values) = server_policy::prepare(config)?;
    let private = private || !values.is_empty();
    let config = &config;
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
    initialize_client(
        McpClient::with_transport(Box::new(transport))
            .with_private_context(private)
            .with_server_policy(config.policy.clone(), values)
            .with_apps_support(apps)?,
    )
    .await
}

async fn initialize_client(
    mut client: McpClient,
) -> anyhow::Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    let _info = client.initialize().await?;
    let tools = client
        .list_tools()
        .await?
        .into_iter()
        .filter(McpToolDefinition::visible_to_model)
        .collect();
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

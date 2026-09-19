//! Shared target-local OAuth integration for CLI and Studio MCP connections.

use anyhow::Result;
use kcoder_mcp::{McpServerConfig, McpServerHandle, McpToolDefinition};
use std::sync::Arc;

pub(crate) fn token_store() -> Result<Arc<kcoder_mcp::authorization_store::OAuthTokenStore>> {
    Ok(Arc::new(
        kcoder_mcp::authorization_store::OAuthTokenStore::open(
            &kcoder_config::user_config_dir()?.join("mcp-oauth"),
        )?,
    ))
}

pub(crate) async fn connect(
    config: &McpServerConfig,
) -> Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    if config.transport != "http" {
        return kcoder_mcp::connect_server(config).await;
    }
    kcoder_mcp::connect_server_with_store(config, token_store()?).await
}

pub(crate) async fn authorization_revisions(configs: &[McpServerConfig]) -> Result<Vec<String>> {
    let mut revisions = Vec::new();
    for config in configs.iter().filter(|config| config.transport == "http") {
        let endpoint = reqwest::Url::parse(&config.url)
            .map_err(|_| anyhow::anyhow!("Invalid MCP endpoint"))?;
        // Ordinary HTTP configurations may not be eligible for OAuth.
        if kcoder_mcp::authorization::validate_endpoint(&endpoint).is_err() {
            continue;
        }
        revisions.push(token_store()?.connection_cache_revision(&endpoint).await?);
    }
    Ok(revisions)
}

//! Target-local OAuth store and authorization observations for MCP RPC.

use anyhow::Result;
use kcoder_app_protocol::McpAuthorizationStatus as Status;
use kcoder_mcp::McpServerConfig;
use std::{path::Path, sync::Arc};

pub fn token_store_for(
    config: &McpServerConfig,
) -> Result<Arc<kcoder_mcp::authorization_store::OAuthTokenStore>> {
    token_store_for_in(
        &kcoder_config::user_config_dir()?,
        config.policy.oauth_account.as_deref(),
    )
}
pub fn token_store_for_in(
    profile: &Path,
    account: Option<&str>,
) -> Result<Arc<kcoder_mcp::authorization_store::OAuthTokenStore>> {
    Ok(Arc::new(
        kcoder_mcp::authorization_store::OAuthTokenStore::open_for_account(
            &profile.join("mcp-oauth"),
            account,
        )?,
    ))
}

pub async fn status(config: &McpServerConfig) -> Result<Status> {
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
    let store = token_store_for(config)?;
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
                .is_some()
                || error
                    .downcast_ref::<kcoder_mcp::authorization_tokens::ProviderRevocationBlocked>()
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

//! Target-local OAuth store and authorization observations for MCP RPC.

use anyhow::Result;
use kcoder_app_protocol::McpAuthorizationStatus as Status;
use kcoder_mcp::McpServerConfig;
use std::{path::Path, sync::Arc};

pub fn token_store_for(
    config: &McpServerConfig,
    profile: &Path,
) -> Result<Arc<kcoder_mcp::authorization_store::OAuthTokenStore>> {
    Ok(Arc::new(
        kcoder_mcp::authorization_store::OAuthTokenStore::open_for_account(
            &profile.join("mcp-oauth"),
            config.policy.oauth_account.as_deref(),
        )?,
    ))
}

pub use kcoder_mcp::server_policy::uses_oauth;

pub async fn status(config: &McpServerConfig, profile: &Path) -> Result<Status> {
    if config.transport != "http" || config.policy.credential_ref.is_some() {
        return Ok(Status::NotApplicable);
    }
    if !uses_oauth(config) {
        return Ok(Status::ConfiguredHeader);
    }
    let endpoint = reqwest::Url::parse(&config.url)?;
    if kcoder_mcp::authorization::validate_endpoint(&endpoint).is_err() {
        return Ok(Status::NotApplicable);
    }
    let store = token_store_for(config, profile)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_mcp::{
        authorization::AuthorizationServerMetadata,
        authorization_flow::PendingAuthorization,
        authorization_registration::{RegisteredClient, RegistrationMethod},
    };
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn config() -> McpServerConfig {
        serde_json::from_value(json!({
            "name":"fixture", "transport":"http", "url":"https://mcp.example.test/mcp",
            "policy":{"oauth_account":"work"}
        }))
        .unwrap()
    }

    async fn grant(config: &McpServerConfig, profile: &Path) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut bytes = [0u8; 1024];
                    let read = socket.read(&mut bytes).await.unwrap();
                    assert!(read > 0 && request.len() + read <= 16 * 1024);
                    request.extend_from_slice(&bytes[..read]);
                    if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let length = headers.lines().filter_map(|line| line.split_once(':'))
                            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                            .map(|(_, value)| value.trim().parse::<usize>().unwrap()).unwrap();
                        if request.len() >= end + 4 + length { break; }
                    }
                }
                let body = r#"{"access_token":"synthetic-fixture-token","token_type":"Bearer","scope":"read"}"#;
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                socket.write_all(response.as_bytes()).await.unwrap();
            }).await.unwrap();
        });
        let metadata: AuthorizationServerMetadata = serde_json::from_value(json!({
            "issuer":issuer, "authorization_endpoint":format!("{issuer}/authorize"),
            "token_endpoint":format!("{issuer}/token"), "response_types_supported":["code"],
            "code_challenge_methods_supported":["S256"], "token_endpoint_auth_methods_supported":["none"]
        })).unwrap();
        let resource = reqwest::Url::parse(&config.url).unwrap();
        let redirect = reqwest::Url::parse("http://127.0.0.1:34567/callback").unwrap();
        let client = RegisteredClient::manual(
            &metadata,
            "fixture-client".into(),
            None,
            RegistrationMethod::Public,
            &redirect,
        )
        .unwrap();
        let store = token_store_for(config, profile).unwrap();
        let mut flow = PendingAuthorization::begin_for_endpoint(
            &store,
            &resource,
            &metadata,
            &resource,
            &redirect,
            &["read".into()],
            Some(client),
        )
        .await
        .unwrap();
        let state = flow
            .authorization_url()
            .query_pairs()
            .find(|(name, _)| name == "state")
            .unwrap()
            .1
            .into_owned();
        let mut callback = redirect;
        callback
            .query_pairs_mut()
            .append_pair("state", &state)
            .append_pair("code", "fixture-code");
        flow.complete(&store, &callback).await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn oauth_status_and_logout_are_isolated_by_profile_and_account() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        let work = config();
        let mut personal = work.clone();
        personal.policy.oauth_account = Some("personal".into());
        grant(&work, &first).await;
        assert_eq!(status(&work, &first).await.unwrap(), Status::Authorized);
        assert_eq!(status(&work, &second).await.unwrap(), Status::NotAuthorized);
        assert_eq!(
            status(&personal, &first).await.unwrap(),
            Status::NotAuthorized
        );
        grant(&work, &second).await;
        grant(&personal, &first).await;
        token_store_for(&work, &first)
            .unwrap()
            .logout_endpoint(&reqwest::Url::parse(&work.url).unwrap())
            .await
            .unwrap();
        assert_eq!(status(&work, &first).await.unwrap(), Status::NotAuthorized);
        assert_eq!(status(&work, &second).await.unwrap(), Status::Authorized);
        assert_eq!(status(&personal, &first).await.unwrap(), Status::Authorized);
    }

    #[tokio::test]
    async fn configured_credentials_never_open_an_oauth_store() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("must-remain-absent");
        let mut base = config();
        base.policy.oauth_account = None;
        let mut literal = base.clone();
        literal
            .headers
            .insert("Authorization".into(), "fixture".into());
        let mut bearer = base.clone();
        bearer.policy.bearer_token_env_var = Some("FIXTURE_NOT_SET".into());
        let mut header = base.clone();
        header
            .policy
            .env_http_headers
            .insert("AUTHORIZATION".into(), "FIXTURE_NOT_SET".into());
        for config in [literal, bearer, header] {
            assert!(!uses_oauth(&config));
            assert_eq!(
                status(&config, &profile).await.unwrap(),
                Status::ConfiguredHeader
            );
        }
        let mut private = base;
        private.policy.credential_ref =
            Some(serde_json::from_value(json!({"id":format!("cred-{}", "1".repeat(32))})).unwrap());
        assert!(!uses_oauth(&private));
        assert_eq!(
            status(&private, &profile).await.unwrap(),
            Status::NotApplicable
        );
        assert!(!profile.exists());
    }

    #[tokio::test]
    async fn unreadable_selected_oauth_store_does_not_fall_back() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("mcp-oauth"), "blocked").unwrap();
        assert!(status(&config(), temp.path()).await.is_err());
    }
}

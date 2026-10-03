//! HTTP requests reload target-owned credentials so logout and token rotation take effect.

use crate::authorization::{resource_covers_endpoint, validate_endpoint};
use crate::authorization_registration::RegisteredClient;
use crate::authorization_store::{CredentialBinding, OAuthTokenStore};
use crate::{McpTransport, StreamableHttpTransport};
use anyhow::{Result, bail};
use async_trait::async_trait;
use reqwest::Url;
use std::{collections::HashMap, sync::Arc, time::Instant};

pub struct AuthorizedHttpTransport {
    inner: StreamableHttpTransport,
    store: Arc<OAuthTokenStore>,
    binding: CredentialBinding,
    client: RegisteredClient,
}

impl AuthorizedHttpTransport {
    pub async fn new(
        url: &str,
        headers: &HashMap<String, String>,
        store: Arc<OAuthTokenStore>,
        binding: CredentialBinding,
        client: RegisteredClient,
    ) -> Result<Self> {
        let endpoint = Url::parse(url).map_err(|_| anyhow::anyhow!("Invalid MCP endpoint"))?;
        validate_endpoint(&endpoint)?;
        validate_endpoint(&binding.resource)?;
        if !resource_covers_endpoint(&binding.resource, &endpoint)
            || client.issuer() != &binding.issuer
            || client.client_id() != binding.client_id
        {
            bail!("MCP OAuth credentials do not match the configured resource and client");
        }
        if headers
            .keys()
            .any(|name| name.eq_ignore_ascii_case("authorization"))
        {
            bail!("MCP OAuth cannot override an explicitly configured Authorization header");
        }
        Ok(Self {
            inner: StreamableHttpTransport::new(url, headers).await?,
            store,
            binding,
            client,
        })
    }
}

#[async_trait]
impl McpTransport for AuthorizedHttpTransport {
    async fn send(&mut self, line: &str) -> Result<()> {
        let mut lease = self.store.acquire(self.binding.clone()).await?;
        let mut tokens = lease
            .load()?
            .ok_or_else(|| anyhow::anyhow!("MCP authorization is required"))?;
        if tokens
            .expires_at()
            .is_some_and(|expiry| expiry <= Instant::now())
        {
            lease.refresh(self.client.authentication()?).await?;
            tokens = lease
                .load()?
                .ok_or_else(|| anyhow::anyhow!("MCP refreshed credentials are unavailable"))?;
            if tokens
                .expires_at()
                .is_some_and(|expiry| expiry <= Instant::now())
            {
                bail!("MCP refreshed access token has already expired");
            }
        }
        // Keep the lease through the request: logout waits for this request and blocks subsequent ones.
        self.inner
            .send_with_bearer(line, tokens.access_token())
            .await
    }

    async fn recv(&mut self) -> Result<Option<String>> {
        self.inner.recv().await
    }

    fn supported_protocol_versions(&self) -> &'static [&'static str] {
        self.inner.supported_protocol_versions()
    }

    fn set_negotiated_protocol_version(&mut self, version: String) {
        self.inner.set_negotiated_protocol_version(version);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authorization::AuthorizationServerMetadata;
    use crate::authorization_registration::RegistrationMethod;
    use crate::authorization_tokens::OAuthTokens;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn concurrent_connections_refresh_expired_credentials_only_once() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let metadata: AuthorizationServerMetadata = serde_json::from_value(serde_json::json!({
            "issuer": root, "authorization_endpoint": format!("{root}/authorize"),
            "token_endpoint": format!("{root}/token"), "response_types_supported": ["code"],
            "code_challenge_methods_supported": ["S256"], "token_endpoint_auth_methods_supported": ["none"]
        })).unwrap();
        let make_client = || {
            RegisteredClient::manual(
                &metadata,
                "client".into(),
                None,
                RegistrationMethod::Public,
                &Url::parse("http://127.0.0.1:34567/callback").unwrap(),
            )
            .unwrap()
        };
        let binding = CredentialBinding {
            resource: Url::parse(&root).unwrap(),
            issuer: Url::parse(&root).unwrap(),
            client_id: "client".into(),
            token_endpoint: Url::parse(&metadata.token_endpoint).unwrap(),
        };
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(OAuthTokenStore::open(directory.path()).unwrap());
        let tokens = OAuthTokens::from_store_bytes(
            &serde_json::to_vec(&serde_json::json!({
                "version": 2, "refresh_pending": false, "resource": binding.resource.as_str(),
                "issuer": binding.issuer.as_str(), "client_id": "client",
                "token_endpoint": binding.token_endpoint.as_str(),
                "access_token": "expired-token", "refresh_token": "old-refresh",
                "expires_at_ms": 1, "scope": "read"
            }))
            .unwrap(),
            &binding.resource,
            &binding.issuer,
            &binding.client_id,
            &binding.token_endpoint,
        )
        .unwrap();
        store
            .acquire(binding.clone())
            .await
            .unwrap()
            .save(&tokens)
            .unwrap();
        let mut first = AuthorizedHttpTransport::new(
            &format!("{root}/mcp"),
            &HashMap::new(),
            Arc::clone(&store),
            binding.clone(),
            make_client(),
        )
        .await
        .unwrap();
        let mut second = AuthorizedHttpTransport::new(
            &format!("{root}/mcp"),
            &HashMap::new(),
            Arc::clone(&store),
            binding.clone(),
            make_client(),
        )
        .await
        .unwrap();
        let server = tokio::spawn(async move {
            for index in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let (head, body) = loop {
                    let mut chunk = [0; 4096];
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&chunk[..count]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&bytes[..end]).into_owned();
                        let length: usize = head
                            .lines()
                            .find_map(|line| {
                                let (key, value) = line.split_once(':')?;
                                key.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse().unwrap())
                            })
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            break (head, bytes[end + 4..end + 4 + length].to_vec());
                        }
                    }
                };
                let (status, response) = if index == 0 {
                    assert!(head.starts_with("POST /token "));
                    let form: HashMap<String, String> =
                        serde_urlencoded::from_bytes(&body).unwrap();
                    assert_eq!(form["grant_type"], "refresh_token");
                    assert_eq!(form["refresh_token"], "old-refresh");
                    assert_eq!(form["client_id"], "client");
                    assert_eq!(form["resource"], format!("{root}/"));
                    (
                        "200 OK",
                        r#"{"access_token":"fresh-token","refresh_token":"rotated-refresh","token_type":"Bearer","expires_in":3600}"#,
                    )
                } else {
                    assert!(head.starts_with("POST /mcp "));
                    assert!(
                        head.to_lowercase()
                            .contains("authorization: bearer fresh-token")
                    );
                    ("202 Accepted", "")
                };
                socket.write_all(format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                    response.len(),
                ).as_bytes()).await.unwrap();
            }
        });
        let (a, b) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(first.send("{}"), second.send("{}"))
        })
        .await
        .unwrap();
        a.unwrap();
        b.unwrap();
        server.await.unwrap();
        let reopened = OAuthTokenStore::open(directory.path()).unwrap();
        let saved = reopened
            .acquire(binding)
            .await
            .unwrap()
            .load()
            .unwrap()
            .unwrap();
        assert_eq!(saved.access_token(), "fresh-token");
        assert_eq!(saved.refresh_token(), Some("rotated-refresh"));
        assert_eq!(saved.scope(), Some("read"));
    }

    #[tokio::test]
    async fn requests_reload_tokens_and_stop_after_logout() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let metadata: AuthorizationServerMetadata = serde_json::from_value(serde_json::json!({
            "issuer": "https://auth.example.test", "authorization_endpoint": "https://auth.example.test/authorize",
            "token_endpoint": "https://auth.example.test/token", "response_types_supported": ["code"],
            "code_challenge_methods_supported": ["S256"], "token_endpoint_auth_methods_supported": ["none"]
        })).unwrap();
        let client = RegisteredClient::manual(
            &metadata,
            "client".into(),
            None,
            RegistrationMethod::Public,
            &Url::parse("http://127.0.0.1:34567/callback").unwrap(),
        )
        .unwrap();
        let binding = CredentialBinding {
            resource: Url::parse(&root).unwrap(),
            issuer: client.issuer().clone(),
            client_id: "client".into(),
            token_endpoint: Url::parse(&metadata.token_endpoint).unwrap(),
        };
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(OAuthTokenStore::open(directory.path()).unwrap());
        let save = |value: &str| {
            OAuthTokens::from_store_bytes(
                &serde_json::to_vec(&serde_json::json!({
                    "version": 2, "refresh_pending": false,
                    "resource": binding.resource.as_str(), "issuer": binding.issuer.as_str(),
                    "client_id": "client", "token_endpoint": binding.token_endpoint.as_str(),
                    "access_token": value, "refresh_token": null, "expires_at_ms": null, "scope": null
                })).unwrap(),
                &binding.resource, &binding.issuer, &binding.client_id, &binding.token_endpoint,
            ).unwrap()
        };
        store
            .acquire(binding.clone())
            .await
            .unwrap()
            .save(&save("first-token"))
            .unwrap();
        let mut transport = AuthorizedHttpTransport::new(
            &format!("{root}/mcp"),
            &HashMap::new(),
            Arc::clone(&store),
            binding.clone(),
            client,
        )
        .await
        .unwrap();
        let server = tokio::spawn(async move {
            for expected in ["first-token", "second-token"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut chunk = [0; 4096];
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&chunk[..count]);
                    if bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8_lossy(&bytes);
                assert!(
                    request
                        .to_lowercase()
                        .contains(&format!("authorization: bearer {expected}"))
                );
                socket
                    .write_all(
                        b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await
                    .unwrap();
            }
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(150), listener.accept())
                    .await
                    .is_err()
            );
        });
        transport.send("{}").await.unwrap();
        store
            .acquire(binding.clone())
            .await
            .unwrap()
            .save(&save("second-token"))
            .unwrap();
        transport.send("{}").await.unwrap();
        store.acquire(binding).await.unwrap().remove().unwrap();
        assert!(
            transport
                .send("{}")
                .await
                .unwrap_err()
                .to_string()
                .contains("authorization is required")
        );
        server.await.unwrap();
    }
}

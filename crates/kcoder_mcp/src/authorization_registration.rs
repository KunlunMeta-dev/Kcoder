//! Dynamic and explicitly configured OAuth clients.

use crate::authorization::{AuthorizationServerMetadata, validate_endpoint};
use crate::authorization_tokens::ClientAuthentication;
use anyhow::{Context, Result, bail};
use futures::StreamExt;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RegistrationMethod {
    #[serde(rename = "none")]
    Public,
    #[serde(rename = "client_secret_basic")]
    Basic,
    #[serde(rename = "client_secret_post")]
    Post,
}
impl RegistrationMethod {
    fn name(self) -> &'static str {
        match self {
            Self::Public => "none",
            Self::Basic => "client_secret_basic",
            Self::Post => "client_secret_post",
        }
    }
    fn allowed(self, metadata: &AuthorizationServerMetadata) -> bool {
        metadata
            .token_endpoint_auth_methods_supported
            .as_ref()
            .map_or(self == Self::Basic, |methods| {
                methods.iter().any(|method| method == self.name())
            })
    }
}
fn default_method() -> RegistrationMethod {
    RegistrationMethod::Basic
}

pub struct RegisteredClient {
    client_id: String,
    issuer: Url,
    redirect_uri: Url,
    authentication: ClientAuthentication,
    secret_expires_at: Option<SystemTime>,
}
impl std::fmt::Debug for RegisteredClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RegisteredClient")
            .finish_non_exhaustive()
    }
}
impl RegisteredClient {
    pub(crate) fn store_bytes(&self) -> Result<Zeroizing<Vec<u8>>> {
        let (method, secret) = match &self.authentication {
            ClientAuthentication::Public => (RegistrationMethod::Public, None),
            ClientAuthentication::Basic(secret) => (
                RegistrationMethod::Basic,
                Some(Zeroizing::new(secret.to_string())),
            ),
            ClientAuthentication::Post(secret) => (
                RegistrationMethod::Post,
                Some(Zeroizing::new(secret.to_string())),
            ),
        };
        let expires = self
            .secret_expires_at
            .map(|expiry| {
                expiry
                    .duration_since(UNIX_EPOCH)
                    .map(|duration| duration.as_secs())
                    .map_err(|_| anyhow::anyhow!("Invalid OAuth client expiry"))
            })
            .transpose()?;
        let record = StoredClient {
            version: 1,
            client_id: self.client_id.clone(),
            issuer: self.issuer.as_str().into(),
            redirect_uri: self.redirect_uri.as_str().into(),
            method,
            secret,
            expires,
        };
        serde_json::to_vec(&record)
            .map(Zeroizing::new)
            .map_err(|_| anyhow::anyhow!("Cannot serialize OAuth client credentials"))
    }

    pub(crate) fn from_store_bytes(
        bytes: &[u8],
        metadata: &AuthorizationServerMetadata,
        redirect: &Url,
    ) -> Result<Self> {
        let record: StoredClient = serde_json::from_slice(bytes)
            .map_err(|_| anyhow::anyhow!("Invalid OAuth client credential record"))?;
        if record.version != 1 {
            bail!("Unsupported OAuth client credential version");
        }
        let issuer =
            Url::parse(&metadata.issuer).map_err(|_| anyhow::anyhow!("Invalid OAuth issuer"))?;
        if record.issuer != issuer.as_str() || record.redirect_uri != redirect.as_str() {
            bail!("OAuth client credential binding does not match");
        }
        let mut client = Self::manual(
            metadata,
            record.client_id,
            record.secret,
            record.method,
            redirect,
        )?;
        client.secret_expires_at = record
            .expires
            .map(|seconds| {
                UNIX_EPOCH
                    .checked_add(Duration::from_secs(seconds))
                    .ok_or_else(|| anyhow::anyhow!("Invalid OAuth client expiry"))
            })
            .transpose()?;
        Ok(client)
    }

    pub fn client_id(&self) -> &str {
        &self.client_id
    }
    pub fn issuer(&self) -> &Url {
        &self.issuer
    }
    pub fn redirect_uri(&self) -> &Url {
        &self.redirect_uri
    }
    pub fn authentication(&self) -> Result<&ClientAuthentication> {
        if self
            .secret_expires_at
            .is_some_and(|expiry| SystemTime::now() >= expiry)
        {
            bail!("OAuth client secret expired");
        }
        Ok(&self.authentication)
    }
    pub fn manual(
        metadata: &AuthorizationServerMetadata,
        client_id: String,
        secret: Option<Zeroizing<String>>,
        method: RegistrationMethod,
        redirect_uri: &Url,
    ) -> Result<Self> {
        validate_endpoint(redirect_uri)?;
        if redirect_uri.query().is_some() || client_id.is_empty() {
            bail!("Invalid OAuth client identifier or callback");
        }
        let issuer =
            Url::parse(&metadata.issuer).map_err(|_| anyhow::anyhow!("Invalid OAuth issuer"))?;
        validate_endpoint(&issuer)?;
        if issuer.query().is_some() || !method.allowed(metadata) {
            bail!("OAuth client authentication method is not supported by this issuer");
        }
        let authentication = match (method, secret) {
            (RegistrationMethod::Public, _) => ClientAuthentication::Public,
            (RegistrationMethod::Basic, Some(secret)) if !secret.is_empty() => {
                ClientAuthentication::Basic(secret)
            }
            (RegistrationMethod::Post, Some(secret)) if !secret.is_empty() => {
                ClientAuthentication::Post(secret)
            }
            _ => bail!("OAuth client secret does not match the selected authentication method"),
        };
        Ok(Self {
            client_id,
            issuer,
            redirect_uri: redirect_uri.clone(),
            authentication,
            secret_expires_at: None,
        })
    }
}

#[derive(Serialize, Deserialize)]
struct StoredClient {
    version: u32,
    client_id: String,
    issuer: String,
    redirect_uri: String,
    method: RegistrationMethod,
    secret: Option<Zeroizing<String>>,
    expires: Option<u64>,
}

#[derive(Deserialize)]
struct RegistrationResponse {
    client_id: String,
    #[serde(default)]
    client_secret: Option<Zeroizing<String>>,
    #[serde(default = "default_method")]
    token_endpoint_auth_method: RegistrationMethod,
    #[serde(default)]
    redirect_uris: Option<Vec<String>>,
    #[serde(default)]
    client_secret_expires_at: Option<u64>,
    #[serde(default)]
    grant_types: Option<Vec<String>>,
    #[serde(default)]
    response_types: Option<Vec<String>>,
}

/// Call only after the user starts a connection; discovery alone must not register clients.
pub async fn register_client(
    metadata: &AuthorizationServerMetadata,
    redirect_uri: &Url,
) -> Result<RegisteredClient> {
    validate_endpoint(redirect_uri)?;
    if redirect_uri.query().is_some() {
        bail!("OAuth callback must not contain query parameters");
    }
    let endpoint = metadata.registration_endpoint.as_ref().ok_or_else(|| {
        anyhow::anyhow!("OAuth server requires an explicitly configured client identifier")
    })?;
    let endpoint =
        Url::parse(endpoint).map_err(|_| anyhow::anyhow!("Invalid OAuth registration endpoint"))?;
    validate_endpoint(&endpoint)?;
    let issuer =
        Url::parse(&metadata.issuer).map_err(|_| anyhow::anyhow!("Invalid OAuth issuer"))?;
    validate_endpoint(&issuer)?;
    if issuer.query().is_some() || (issuer.scheme() == "https" && endpoint.scheme() != "https") {
        bail!("Invalid OAuth registration issuer or transport");
    }
    let method = [
        RegistrationMethod::Public,
        RegistrationMethod::Basic,
        RegistrationMethod::Post,
    ]
    .into_iter()
    .find(|method| method.allowed(metadata))
    .ok_or_else(|| anyhow::anyhow!("OAuth server has no supported client authentication method"))?;
    let mut grants = vec!["authorization_code"];
    if let Some(supported) = &metadata.grant_types_supported {
        if !supported.iter().any(|grant| grant == "authorization_code") {
            bail!("OAuth server does not support authorization code grants");
        }
        if supported.iter().any(|grant| grant == "refresh_token") {
            grants.push("refresh_token");
        }
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .context("Cannot build OAuth registration client")?;
    let response = client.post(endpoint).json(&serde_json::json!({
        "client_name":"KCoder Studio", "application_type":"native", "redirect_uris":[redirect_uri.as_str()],
        "grant_types":grants, "response_types":["code"], "token_endpoint_auth_method":method,
    })).send().await.map_err(|error| anyhow::anyhow!("OAuth registration failed: {}", error.without_url()))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        if status == 401 || status == 403 {
            bail!(
                "OAuth registration was rejected (HTTP {status}); this authorization server does not allow dynamic client registration, provide a pre-registered client ID (and secret) for this MCP server instead"
            );
        }
        bail!("OAuth registration returned HTTP {}", status);
    }
    const LIMIT: usize = 65536;
    if response
        .content_length()
        .is_some_and(|length| length > LIMIT as u64)
    {
        bail!("OAuth registration response exceeds the size limit");
    }
    let mut bytes = Zeroizing::new(Vec::new());
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|_| anyhow::anyhow!("OAuth registration response was interrupted"))?;
        if bytes.len().saturating_add(chunk.len()) > LIMIT {
            bail!("OAuth registration response exceeds the size limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    let response: RegistrationResponse = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("Invalid OAuth client registration response"))?;
    if let Some(redirects) = &response.redirect_uris {
        if !redirects.iter().any(|uri| uri == redirect_uri.as_str()) {
            bail!("OAuth server did not register the requested callback");
        }
    }
    if response
        .grant_types
        .as_ref()
        .is_some_and(|values| !values.iter().any(|value| value == "authorization_code"))
        || response
            .response_types
            .as_ref()
            .is_some_and(|values| !values.iter().any(|value| value == "code"))
    {
        bail!("OAuth registration does not allow the requested code flow");
    }
    let mut registered = RegisteredClient::manual(
        metadata,
        response.client_id,
        response.client_secret,
        response.token_endpoint_auth_method,
        redirect_uri,
    )?;
    registered.secret_expires_at =
        if response.token_endpoint_auth_method == RegistrationMethod::Public {
            None
        } else {
            response
                .client_secret_expires_at
                .filter(|seconds| *seconds != 0)
                .map(|seconds| {
                    UNIX_EPOCH
                        .checked_add(Duration::from_secs(seconds))
                        .ok_or_else(|| anyhow::anyhow!("Invalid OAuth client secret expiry"))
                })
                .transpose()?
        };
    registered.authentication()?;
    Ok(registered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn metadata(origin: &str, methods: &[&str]) -> AuthorizationServerMetadata {
        serde_json::from_value(serde_json::json!({
            "issuer":origin, "authorization_endpoint":format!("{origin}/authorize"), "token_endpoint":format!("{origin}/token"),
            "registration_endpoint":format!("{origin}/register"), "response_types_supported":["code"], "code_challenge_methods_supported":["S256"],
            "grant_types_supported":["authorization_code","refresh_token"], "token_endpoint_auth_methods_supported":methods
        })).unwrap()
    }

    #[tokio::test]
    async fn registration_requests_native_code_clients_and_validates_the_response() {
        for case in [
            "public",
            "basic",
            "wrong-callback",
            "wrong-grant",
            "server-error",
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let method = if case == "basic" {
                "client_secret_basic"
            } else {
                "none"
            };
            let server_metadata = metadata(&origin, &[method]);
            let callback = Url::parse("http://127.0.0.1/callback").unwrap();
            let body = serde_json::json!({
                "client_id":"registered-client", "client_secret":"synthetic-secret", "token_endpoint_auth_method":method,
                "redirect_uris":[if case == "wrong-callback" { "https://other.example.test/callback" } else { callback.as_str() }], "client_secret_expires_at":0, "grant_types": if case == "wrong-grant" { vec!["client_credentials"] } else { vec!["authorization_code", "refresh_token"] }
            }).to_string();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let (end, length) = loop {
                    let mut buffer = [0; 4096];
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        assert!(headers.starts_with("post /register http/1.1"));
                        assert!(!headers.contains("authorization:"));
                        assert!(!headers.contains("cookie:"));
                        let length: usize = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .unwrap()
                            .trim()
                            .parse()
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            break (end, length);
                        }
                    }
                };
                let input: serde_json::Value =
                    serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
                assert_eq!(input["client_name"], "KCoder Studio");
                assert_eq!(input["redirect_uris"][0], "http://127.0.0.1/callback");
                assert_eq!(
                    input["grant_types"],
                    serde_json::json!(["authorization_code", "refresh_token"])
                );
                assert_eq!(input["token_endpoint_auth_method"], method);
                let status = if case == "server-error" { 400 } else { 201 };
                let response = format!(
                    "HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            });
            let result = register_client(&server_metadata, &callback).await;
            if case == "public" || case == "basic" {
                let client = result.unwrap();
                assert_eq!(client.client_id(), "registered-client");
                assert_eq!(client.redirect_uri(), &callback);
                assert_eq!(client.issuer().as_str(), format!("{origin}/"));
                assert_eq!(
                    matches!(
                        client.authentication().unwrap(),
                        ClientAuthentication::Basic(_)
                    ),
                    case == "basic"
                );
                assert!(!format!("{client:?}").contains("synthetic-secret"));
            } else {
                assert!(!format!("{:?}", result.unwrap_err()).contains("synthetic-secret"));
            }
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn registration_rejection_names_the_preregistered_client_fallback() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server_metadata = metadata(&origin, &["none"]);
        let callback = Url::parse("http://127.0.0.1/callback").unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            let read = socket.read(&mut bytes).await.unwrap();
            assert!(read > 0, "fixture must receive the request before replying");
            socket
                .write_all(
                    b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 9\r\nConnection: close\r\n\r\nForbidden",
                )
                .await
                .unwrap();
        });
        let error = register_client(&server_metadata, &callback)
            .await
            .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("HTTP 403"), "{message}");
        assert!(
            message.contains("pre-registered client"),
            "error should point at the manual client fallback: {message}"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn manual_clients_work_without_a_registration_endpoint() {
        let mut metadata = metadata("https://auth.example.test", &["client_secret_post"]);
        metadata.registration_endpoint = None;
        let callback = Url::parse("http://127.0.0.1/callback").unwrap();
        assert!(register_client(&metadata, &callback).await.is_err());
        let client = RegisteredClient::manual(
            &metadata,
            "manual-client".into(),
            Some(Zeroizing::new("manual-secret".into())),
            RegistrationMethod::Post,
            &callback,
        )
        .unwrap();
        assert!(matches!(
            client.authentication().unwrap(),
            ClientAuthentication::Post(_)
        ));
        assert!(
            RegisteredClient::manual(
                &metadata,
                "manual-client".into(),
                None,
                RegistrationMethod::Post,
                &callback
            )
            .is_err()
        );
    }
}

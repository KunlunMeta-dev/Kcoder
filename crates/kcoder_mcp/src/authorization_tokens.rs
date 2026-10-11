//! Resource-bound OAuth token exchange. No response bodies or credentials enter errors.

use crate::authorization_session::AuthorizationCodeGrant;
use anyhow::{Context, Result, bail};
use futures::StreamExt;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

pub enum ClientAuthentication {
    Public,
    Basic(Zeroizing<String>),
    Post(Zeroizing<String>),
}

impl std::fmt::Debug for ClientAuthentication {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Public => "Public",
            Self::Basic(_) => "Basic([redacted])",
            Self::Post(_) => "Post([redacted])",
        })
    }
}

#[derive(Debug)]
pub struct TokenEndpointError {
    status: u16,
    code: Option<&'static str>,
}
impl TokenEndpointError {
    pub fn status(&self) -> u16 {
        self.status
    }
    pub fn code(&self) -> Option<&'static str> {
        self.code
    }
}
impl std::fmt::Display for TokenEndpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "OAuth token endpoint rejected the request (HTTP {}; {})",
            self.status,
            self.code.unwrap_or("unspecified")
        )
    }
}
impl std::error::Error for TokenEndpointError {}

#[derive(Debug)]
pub struct RefreshRecoveryRequired;
impl std::fmt::Display for RefreshRecoveryRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OAuth refresh outcome is uncertain; new authorization is required")
    }
}
impl std::error::Error for RefreshRecoveryRequired {}

pub struct OAuthTokens {
    access_token: Zeroizing<String>,
    refresh_token: Option<Zeroizing<String>>,
    expires_at: Option<Instant>,
    scope: Option<String>,
    resource: Url,
    issuer: Url,
    client_id: String,
    token_endpoint: Url,
}

impl std::fmt::Debug for OAuthTokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OAuthTokens").finish_non_exhaustive()
    }
}

impl OAuthTokens {
    #[cfg(test)]
    pub(crate) fn store_bytes(&self) -> Result<Zeroizing<Vec<u8>>> {
        self.store_bytes_with_refresh_pending(false)
    }

    pub(crate) fn store_bytes_with_refresh_pending(
        &self,
        pending: bool,
    ) -> Result<Zeroizing<Vec<u8>>> {
        let wall = std::time::SystemTime::now();
        let monotonic = Instant::now();
        let expires_at_ms = self
            .expires_at
            .map(|expiry| {
                let absolute = wall
                    .checked_add(expiry.saturating_duration_since(monotonic))
                    .ok_or_else(|| anyhow::anyhow!("Invalid OAuth credential expiry"))?;
                let millis = absolute
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| anyhow::anyhow!("Invalid system clock"))?
                    .as_millis();
                u64::try_from(millis)
                    .map_err(|_| anyhow::anyhow!("Invalid OAuth credential expiry"))
            })
            .transpose()?;
        let record = StoredTokens {
            version: 2,
            refresh_pending: Some(pending),
            resource: self.resource.as_str().into(),
            issuer: self.issuer.as_str().into(),
            client_id: self.client_id.clone(),
            token_endpoint: self.token_endpoint.as_str().into(),
            access_token: Zeroizing::new(self.access_token.to_string()),
            refresh_token: self
                .refresh_token
                .as_ref()
                .map(|value| Zeroizing::new(value.to_string())),
            expires_at_ms,
            scope: self.scope.clone(),
        };
        serde_json::to_vec(&record)
            .map(Zeroizing::new)
            .map_err(|_| anyhow::anyhow!("Cannot serialize OAuth credentials"))
    }

    pub(crate) fn from_store_bytes(
        bytes: &[u8],
        resource: &Url,
        issuer: &Url,
        client_id: &str,
        endpoint: &Url,
    ) -> Result<Self> {
        let record: StoredTokens = serde_json::from_slice(bytes)
            .map_err(|_| anyhow::anyhow!("Invalid OAuth credential record"))?;
        let pending = match record.version {
            1 => record.refresh_pending.unwrap_or(false),
            2 => record
                .refresh_pending
                .ok_or_else(|| anyhow::anyhow!("OAuth credential refresh state is missing"))?,
            _ => bail!("Unsupported OAuth credential version"),
        };
        if pending {
            return Err(RefreshRecoveryRequired.into());
        }
        if record.resource != resource.as_str()
            || record.issuer != issuer.as_str()
            || record.client_id != client_id
            || record.token_endpoint != endpoint.as_str()
        {
            bail!("OAuth credential binding does not match");
        }
        validate_bearer(&record.access_token)?;
        let expires_at = record
            .expires_at_ms
            .map(|millis| {
                let absolute = std::time::UNIX_EPOCH
                    .checked_add(Duration::from_millis(millis))
                    .ok_or_else(|| anyhow::anyhow!("Invalid OAuth credential expiry"))?;
                Instant::now()
                    .checked_add(
                        absolute
                            .duration_since(std::time::SystemTime::now())
                            .unwrap_or_default(),
                    )
                    .ok_or_else(|| anyhow::anyhow!("Invalid OAuth credential expiry"))
            })
            .transpose()?;
        Ok(Self {
            access_token: record.access_token,
            refresh_token: record.refresh_token,
            expires_at,
            scope: record.scope,
            resource: resource.clone(),
            issuer: issuer.clone(),
            client_id: client_id.into(),
            token_endpoint: endpoint.clone(),
        })
    }

    /// Refresh under the caller's credential-store lease. Failed responses leave this value intact.
    pub async fn refresh(&mut self, authentication: &ClientAuthentication) -> Result<()> {
        let refresh = self.refresh_token.as_ref().ok_or_else(|| {
            anyhow::anyhow!("OAuth refresh token is unavailable; authorization is required")
        })?;
        let form = vec![
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.as_str()),
            ("resource", self.resource.as_str()),
        ];
        let (response, expires_at) =
            request_token(&self.token_endpoint, &self.client_id, authentication, form).await?;
        self.access_token = response.access_token;
        if let Some(refresh) = response.refresh_token {
            self.refresh_token = Some(refresh);
        }
        self.expires_at = expires_at;
        if let Some(scope) = response.scope {
            self.scope = Some(scope);
        }
        Ok(())
    }

    pub fn access_token(&self) -> &str {
        &self.access_token
    }
    pub fn refresh_token(&self) -> Option<&str> {
        self.refresh_token.as_ref().map(|value| value.as_str())
    }
    pub fn expires_at(&self) -> Option<Instant> {
        self.expires_at
    }
    pub fn scope(&self) -> Option<&str> {
        self.scope.as_deref()
    }
    pub fn resource(&self) -> &Url {
        &self.resource
    }
    pub fn issuer(&self) -> &Url {
        &self.issuer
    }
    pub fn client_id(&self) -> &str {
        &self.client_id
    }
    pub fn token_endpoint(&self) -> &Url {
        &self.token_endpoint
    }
}

#[derive(Serialize, Deserialize)]
struct StoredTokens {
    version: u32,
    #[serde(default)]
    refresh_pending: Option<bool>,
    resource: String,
    issuer: String,
    client_id: String,
    token_endpoint: String,
    access_token: Zeroizing<String>,
    refresh_token: Option<Zeroizing<String>>,
    expires_at_ms: Option<u64>,
    scope: Option<String>,
}

fn validate_bearer(token: &str) -> Result<()> {
    // Tokens are opaque; validate visible header bytes without assuming a base64 encoding.
    if token.is_empty() || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
        bail!("Invalid OAuth bearer token syntax");
    }
    Ok(())
}

#[derive(Deserialize)]
struct ErrorResponse {
    error: Zeroizing<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Zeroizing<String>,
    token_type: String,
    #[serde(default)]
    refresh_token: Option<Zeroizing<String>>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    scope: Option<String>,
}

fn basic_component(value: &str) -> Result<Zeroizing<String>> {
    let encoded = serde_urlencoded::to_string([("x", value)])
        .map_err(|_| anyhow::anyhow!("Cannot encode OAuth client authentication"))?;
    Ok(Zeroizing::new(encoded[2..].to_string()))
}

pub async fn exchange_authorization_code(
    grant: AuthorizationCodeGrant,
    authentication: &ClientAuthentication,
) -> Result<OAuthTokens> {
    let form = vec![
        ("grant_type", "authorization_code"),
        ("code", grant.code()),
        ("code_verifier", grant.code_verifier()),
        ("redirect_uri", grant.redirect_uri().as_str()),
        ("resource", grant.resource().as_str()),
    ];
    let (response, expires_at) = request_token(
        grant.token_endpoint(),
        grant.client_id(),
        authentication,
        form,
    )
    .await?;
    Ok(OAuthTokens {
        access_token: response.access_token,
        refresh_token: response.refresh_token,
        expires_at,
        scope: response
            .scope
            .or_else(|| grant.requested_scope().map(str::to_owned)),
        resource: grant.resource().clone(),
        issuer: grant.issuer().clone(),
        client_id: grant.client_id().into(),
        token_endpoint: grant.token_endpoint().clone(),
    })
}

async fn request_token<'a>(
    endpoint: &Url,
    client_id: &'a str,
    authentication: &'a ClientAuthentication,
    mut form: Vec<(&'a str, &'a str)>,
) -> Result<(TokenResponse, Option<Instant>)> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .context("Cannot build OAuth token client")?;
    let mut request = client
        .post(endpoint.clone())
        .header(reqwest::header::ACCEPT, "application/json");
    match authentication {
        ClientAuthentication::Public => form.push(("client_id", client_id)),
        ClientAuthentication::Post(secret) => {
            form.push(("client_id", client_id));
            form.push(("client_secret", secret.as_str()));
        }
        ClientAuthentication::Basic(secret) => {
            let id = basic_component(client_id)?;
            let secret = basic_component(secret)?;
            request = request.basic_auth(id.as_str(), Some(secret.as_str()));
        }
    }
    if matches!(authentication, ClientAuthentication::Basic(secret) | ClientAuthentication::Post(secret) if secret.is_empty())
    {
        bail!("OAuth client secret is required for this authentication method");
    }
    let response =
        request.form(&form).send().await.map_err(|error| {
            anyhow::anyhow!("OAuth token exchange failed: {}", error.without_url())
        })?;
    let status = response.status();
    const MAX_TOKEN_RESPONSE: usize = 65536;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_TOKEN_RESPONSE as u64)
    {
        bail!("OAuth token response exceeds the size limit");
    }
    let mut bytes = Zeroizing::new(Vec::new());
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| anyhow::anyhow!("OAuth token response was interrupted"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_TOKEN_RESPONSE {
            bail!("OAuth token response exceeds the size limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let parsed: Option<ErrorResponse> = serde_json::from_slice(&bytes).ok();
        let code = match parsed.as_ref().map(|value| value.error.as_str()) {
            Some("invalid_grant") => Some("invalid_grant"),
            Some("invalid_client") => Some("invalid_client"),
            Some("invalid_request") => Some("invalid_request"),
            Some("invalid_scope") => Some("invalid_scope"),
            Some("unauthorized_client") => Some("unauthorized_client"),
            Some("unsupported_grant_type") => Some("unsupported_grant_type"),
            _ => None,
        };
        return Err(TokenEndpointError {
            status: status.as_u16(),
            code,
        }
        .into());
    }
    let response: TokenResponse = serde_json::from_slice(&bytes).map_err(|_| {
        anyhow::anyhow!(
            "Invalid OAuth token response ({})",
            crate::authorization_token_shape::describe(&bytes)
        )
    })?;
    if !response.token_type.eq_ignore_ascii_case("Bearer") {
        bail!("OAuth token type is not Bearer");
    }
    validate_bearer(&response.access_token)?;
    let expires_at = response
        .expires_in
        .map(|seconds| {
            Instant::now()
                .checked_add(Duration::from_secs(seconds))
                .ok_or_else(|| anyhow::anyhow!("Invalid OAuth token lifetime"))
        })
        .transpose()?;
    if response
        .refresh_token
        .as_ref()
        .is_some_and(|value| value.is_empty())
    {
        bail!("OAuth server returned an empty refresh token");
    }
    Ok((response, expires_at))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opaque_tokens_preserve_header_safe_punctuation_and_reject_injection() {
        for token in [
            "opaque:token",
            "opaque|token",
            "opaque=part.token",
            "opaque%token",
            "opaque;token",
        ] {
            assert!(validate_bearer(token).is_ok());
        }
        for token in [
            "",
            "bad token",
            "bad\ttoken",
            "bad\r\nInjected: value",
            "bad\0token",
            "bad\u{7f}token",
        ] {
            assert!(validate_bearer(token).is_err());
        }
    }
    use crate::authorization::AuthorizationServerMetadata;
    use crate::authorization_session::AuthorizationSession;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn exchange_fixture(
        status: u16,
        body: &str,
        authentication: ClientAuthentication,
    ) -> (Result<OAuthTokens>, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let metadata: AuthorizationServerMetadata = serde_json::from_value(serde_json::json!({
            "issuer": origin, "authorization_endpoint":format!("{origin}/authorize"), "token_endpoint":format!("{origin}/token"),
            "response_types_supported":["code"], "code_challenge_methods_supported":["S256"]
        })).unwrap();
        let mut session = AuthorizationSession::new(
            &metadata,
            "client: id",
            &Url::parse("https://resource.example.test/mcp").unwrap(),
            &Url::parse("http://127.0.0.1/callback").unwrap(),
            &["read".into()],
        )
        .unwrap();
        let state = session
            .authorization_url()
            .query_pairs()
            .find(|(name, _)| name == "state")
            .unwrap()
            .1
            .into_owned();
        let grant = session
            .complete_callback(&state, "secret-code&resource=wrong", None)
            .unwrap();
        let verifier = grant.code_verifier().to_owned();
        let body = body.to_string();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            let (header_end, length) = loop {
                let mut buffer = [0u8; 4096];
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                received.extend_from_slice(&buffer[..count]);
                if let Some(end) = received.windows(4).position(|value| value == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&received[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                                .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    if received.len() >= end + 4 + length {
                        break (end, length);
                    }
                }
            };
            let fields: std::collections::HashMap<String, String> =
                serde_urlencoded::from_bytes(&received[header_end + 4..header_end + 4 + length])
                    .unwrap();
            assert!(String::from_utf8_lossy(&received).starts_with("POST /token HTTP/1.1\r\n"));
            assert_eq!(fields["grant_type"], "authorization_code");
            assert_eq!(fields["code_verifier"], verifier);
            assert_eq!(fields["code"], "secret-code&resource=wrong");
            assert_eq!(fields["resource"], "https://resource.example.test/mcp");
            assert_eq!(fields["redirect_uri"], "http://127.0.0.1/callback");
            let location = if status == 302 {
                format!("Location: {origin}/must-not-follow\r\n")
            } else {
                String::new()
            };
            let response = format!(
                "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{location}Connection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8(received).unwrap()
        });
        let result = exchange_authorization_code(grant, &authentication).await;
        (result, server.await.unwrap())
    }

    #[tokio::test]
    async fn authorization_code_exchange_uses_bound_values_and_selected_client_authentication() {
        for authentication in [
            ClientAuthentication::Public,
            ClientAuthentication::Basic(Zeroizing::new("secret: +/".into())),
            ClientAuthentication::Post(Zeroizing::new("secret: +/".into())),
        ] {
            let basic = matches!(&authentication, ClientAuthentication::Basic(_));
            let post = matches!(&authentication, ClientAuthentication::Post(_));
            let (result, request) = exchange_fixture(200, r#"{"access_token":"access-secret","token_type":"bearer","refresh_token":"refresh-secret","expires_in":3600}"#, authentication).await;
            let tokens = result.unwrap();
            assert_eq!(tokens.access_token(), "access-secret");
            assert_eq!(tokens.scope(), Some("read"));
            assert_eq!(tokens.refresh_token(), Some("refresh-secret"));
            assert_eq!(
                tokens.resource().as_str(),
                "https://resource.example.test/mcp"
            );
            assert!(tokens.expires_at().unwrap() > Instant::now());
            assert!(!format!("{tokens:?}").contains("secret"));
            let (headers, body) = request.split_once("\r\n\r\n").unwrap();
            let fields: std::collections::HashMap<String, String> =
                serde_urlencoded::from_str(body).unwrap();
            if basic {
                let value = headers
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                            .map(|(_, value)| value.trim())
                    })
                    .unwrap();
                assert_eq!(
                    value,
                    format!("Basic {}", STANDARD.encode("client%3A+id:secret%3A+%2B%2F"))
                );
                assert!(!fields.contains_key("client_secret"));
            } else {
                assert!(!headers.to_lowercase().contains("authorization:"));
                assert_eq!(fields["client_id"], "client: id");
                assert_eq!(
                    fields.get("client_secret").map(String::as_str),
                    post.then_some("secret: +/")
                );
            }
        }
    }

    #[tokio::test]
    async fn refresh_rotates_credentials_and_preserves_state_on_failure() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let mut tokens = OAuthTokens {
            access_token: Zeroizing::new("original-access".into()),
            refresh_token: Some(Zeroizing::new("original-refresh".into())),
            expires_at: None,
            scope: Some("read".into()),
            resource: Url::parse("https://resource.example.test/mcp").unwrap(),
            issuer: Url::parse(&origin).unwrap(),
            client_id: "client".into(),
            token_endpoint: Url::parse(&format!("{origin}/token")).unwrap(),
        };
        let server = tokio::spawn(async move {
            for (expected, status, body) in [
                (
                    "original-refresh",
                    200,
                    r#"{"access_token":"first-access","token_type":"Bearer","refresh_token":"rotated-refresh","expires_in":60}"#,
                ),
                (
                    "rotated-refresh",
                    200,
                    r#"{"access_token":"second-access","token_type":"Bearer","expires_in":120}"#,
                ),
                (
                    "rotated-refresh",
                    503,
                    r#"{"error":"temporarily_unavailable","error_description":"original-refresh"}"#,
                ),
                (
                    "rotated-refresh",
                    200,
                    r#"{"access_token":"invalid-update","token_type":"Bearer","refresh_token":""}"#,
                ),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let form = loop {
                    let mut buffer = [0; 4096];
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                    if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                        assert!(headers.starts_with("post /token http/1.1"));
                        assert!(!headers.contains("authorization:"));
                        let length: usize = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .unwrap()
                            .trim()
                            .parse()
                            .unwrap();
                        if request.len() >= end + 4 + length {
                            break request[end + 4..end + 4 + length].to_vec();
                        }
                    }
                };
                let fields: std::collections::HashMap<String, String> =
                    serde_urlencoded::from_bytes(&form).unwrap();
                assert_eq!(fields["grant_type"], "refresh_token");
                assert_eq!(fields["refresh_token"], expected);
                assert_eq!(fields["client_id"], "client");
                assert_eq!(fields["resource"], "https://resource.example.test/mcp");
                assert!(!fields.contains_key("code_verifier"));
                let response = format!(
                    "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        tokens.refresh(&ClientAuthentication::Public).await.unwrap();
        assert_eq!(tokens.access_token(), "first-access");
        assert_eq!(tokens.refresh_token(), Some("rotated-refresh"));
        tokens.refresh(&ClientAuthentication::Public).await.unwrap();
        assert_eq!(tokens.access_token(), "second-access");
        assert_eq!(tokens.refresh_token(), Some("rotated-refresh"));
        let expiry = tokens.expires_at();
        for _ in 0..2 {
            let error = tokens
                .refresh(&ClientAuthentication::Public)
                .await
                .unwrap_err();
            assert!(!format!("{error:?}").contains("original-refresh"));
            assert_eq!(tokens.access_token(), "second-access");
            assert_eq!(tokens.refresh_token(), Some("rotated-refresh"));
            assert_eq!(tokens.expires_at(), expiry);
            assert_eq!(tokens.scope(), Some("read"));
        }
        server.await.unwrap();
    }

    #[tokio::test]
    async fn token_errors_do_not_echo_response_credentials() {
        for (status, body) in [
            (302, r#"{}"#),
            (
                400,
                r#"{"error":"invalid_grant","error_description":"secret-code"}"#,
            ),
            (
                200,
                r#"{"access_token":"access-secret","token_type":"MAC"}"#,
            ),
            (
                200,
                r#"{"access_token":"bad secret","token_type":"Bearer"}"#,
            ),
        ] {
            let (result, _) = exchange_fixture(status, body, ClientAuthentication::Public).await;
            let error = result.unwrap_err();
            assert!(!format!("{error:?}").contains("secret"));
            if status == 302 {
                assert_eq!(
                    error.downcast_ref::<TokenEndpointError>().unwrap().status(),
                    302
                );
            }
            if status == 400 {
                let endpoint = error.downcast_ref::<TokenEndpointError>().unwrap();
                assert_eq!(endpoint.status(), 400);
                assert_eq!(endpoint.code(), Some("invalid_grant"));
            }
        }
    }
}

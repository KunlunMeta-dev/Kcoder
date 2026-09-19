//! HTTP authorization discovery. This client never carries MCP credentials.

use anyhow::{Context, Result, bail};
use futures::StreamExt;
use reqwest::Url;
use serde::Deserialize;
use std::time::Duration;

const MAX_METADATA_BYTES: usize = 1024 * 1024;

#[derive(Clone, Deserialize)]
pub struct ProtectedResourceMetadata {
    pub resource: String,
    pub authorization_servers: Vec<String>,
    #[serde(default)]
    pub scopes_supported: Vec<String>,
}

impl std::fmt::Debug for ProtectedResourceMetadata {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProtectedResourceMetadata")
            .field(
                "authorization_server_count",
                &self.authorization_servers.len(),
            )
            .finish_non_exhaustive()
    }
}

/// Extract Bearer resource metadata without interpreting parameters from other schemes.
pub fn metadata_url_from_challenges(headers: &[String]) -> Result<Option<Url>> {
    let mut selected = None;
    for value in bearer_parameter_values(headers, "resource_metadata")? {
        let url =
            Url::parse(&value).map_err(|_| anyhow::anyhow!("Invalid MCP resource metadata URL"))?;
        validate_endpoint(&url)?;
        if selected.as_ref().is_some_and(|previous| previous != &url) {
            bail!("MCP server advertised conflicting resource metadata URLs");
        }
        selected = Some(url);
    }
    Ok(selected)
}

/// Use explicit scopes, otherwise the current Bearer challenge, then resource metadata.
pub fn select_authorization_scopes(
    requested: &[String],
    headers: &[String],
    supported: &[String],
) -> Result<Vec<String>> {
    if !requested.is_empty() {
        return Ok(requested.to_vec());
    }
    let mut selected = None;
    for value in bearer_parameter_values(headers, "scope")? {
        let scopes: Vec<String> = value
            .split(' ')
            .filter(|scope| !scope.is_empty())
            .map(str::to_owned)
            .collect();
        if selected
            .as_ref()
            .is_some_and(|previous| previous != &scopes)
        {
            bail!("MCP server advertised conflicting authorization scopes");
        }
        selected = Some(scopes);
    }
    Ok(selected.unwrap_or_else(|| supported.to_vec()))
}

fn bearer_parameter_values(headers: &[String], parameter_name: &str) -> Result<Vec<String>> {
    let mut selected = Vec::new();
    for header in headers {
        if header.len() > 65536
            || header
                .bytes()
                .any(|byte| (byte < 32 && byte != b'\t') || byte == 127)
        {
            bail!("Invalid MCP authentication challenge size or control characters");
        }
        let mut segments = Vec::new();
        let mut start = 0;
        let mut quoted = false;
        let mut escaped = false;
        for (index, character) in header.char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            match character {
                '\\' if quoted => escaped = true,
                '"' => quoted = !quoted,
                ',' if !quoted => {
                    segments.push(&header[start..index]);
                    start = index + 1;
                }
                _ => {}
            }
        }
        if quoted || escaped {
            bail!("Malformed MCP authentication challenge");
        }
        segments.push(&header[start..]);
        let mut bearer = false;
        for segment in segments {
            let segment = segment.trim();
            let first = segment.split_whitespace().next().unwrap_or_default();
            let parameter = if !first.contains('=') && !segment.starts_with('=') {
                // Spaces around '=' are valid auth-param syntax, not a new scheme.
                let tail = segment[first.len()..].trim_start();
                if tail.starts_with('=') {
                    segment
                } else {
                    bearer = first.eq_ignore_ascii_case("Bearer");
                    tail
                }
            } else {
                segment
            };
            if !bearer {
                continue;
            }
            let Some((name, raw)) = parameter.split_once('=') else {
                continue;
            };
            if !name.trim().eq_ignore_ascii_case(parameter_name) {
                continue;
            }
            let raw = raw.trim();
            let inner = raw
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
                .ok_or_else(|| anyhow::anyhow!("MCP resource metadata URL must be quoted"))?;
            let mut value = String::new();
            let mut characters = inner.chars();
            while let Some(character) = characters.next() {
                if character == '\\' {
                    value.push(characters.next().ok_or_else(|| {
                        anyhow::anyhow!("Malformed MCP authentication challenge")
                    })?);
                } else if character == '"' {
                    bail!("Malformed MCP authentication challenge");
                } else {
                    value.push(character);
                }
            }
            selected.push(value);
        }
    }
    Ok(selected)
}

/// Fetch and bind protected-resource metadata before considering an authorization server.
/// The expected resource is the canonical resource identifier selected by the caller.
pub async fn discover_protected_resource(
    expected_resource: &Url,
    metadata_url: &Url,
) -> Result<ProtectedResourceMetadata> {
    validate_endpoint(expected_resource)?;
    validate_endpoint(metadata_url)?;
    let metadata: ProtectedResourceMetadata = fetch_metadata(metadata_url).await?;
    let resource = Url::parse(&metadata.resource)
        .map_err(|_| anyhow::anyhow!("Invalid MCP resource identifier"))?;
    validate_endpoint(&resource)?;
    if &resource != expected_resource {
        bail!("MCP authorization metadata identifies a different resource");
    }
    validate_resource_metadata(&metadata)?;
    Ok(metadata)
}

/// RFC 9728 §3.1 well-known candidates for a protected resource: the
/// path-inserted form first, then the origin root form as a fallback.
fn well_known_resource_metadata_urls(endpoint: &Url) -> Vec<Url> {
    let origin = endpoint.origin().ascii_serialization();
    let path = endpoint.path().trim_end_matches('/');
    let mut candidates = Vec::new();
    if let Ok(url) = Url::parse(&format!(
        "{origin}/.well-known/oauth-protected-resource{path}"
    )) {
        candidates.push(url);
    }
    if !path.is_empty() {
        if let Ok(url) = Url::parse(&format!("{origin}/.well-known/oauth-protected-resource")) {
            candidates.push(url);
        }
    }
    candidates
}

/// Discover the canonical resource from a challenge received at the configured endpoint.
/// A canonical parent path is accepted only on the exact same origin and path boundary.
/// When the challenge omits `resource_metadata` (RFC 9728 §5 permits this), the
/// well-known locations derived from the endpoint are probed before failing.
pub async fn discover_challenged_resource(
    challenge: &crate::AuthenticationRequired,
) -> Result<ProtectedResourceMetadata> {
    let endpoint = challenge.resource_url();
    validate_endpoint(endpoint)?;
    if let Some(location) = challenge.metadata_url()? {
        let metadata: ProtectedResourceMetadata = fetch_metadata(&location).await?;
        let resource = Url::parse(&metadata.resource)
            .map_err(|_| anyhow::anyhow!("Invalid MCP resource identifier"))?;
        validate_endpoint(&resource)?;
        if !resource_covers_endpoint(&resource, endpoint) {
            bail!("MCP authorization metadata identifies a different resource");
        }
        validate_resource_metadata(&metadata)?;
        return Ok(metadata);
    }
    let mut last: Option<anyhow::Error> = None;
    for location in well_known_resource_metadata_urls(endpoint) {
        match fetch_metadata::<ProtectedResourceMetadata>(&location).await {
            Ok(metadata) => {
                let resource = match Url::parse(&metadata.resource) {
                    Ok(resource) => resource,
                    Err(_) => {
                        last = Some(anyhow::anyhow!("Invalid MCP resource identifier"));
                        continue;
                    }
                };
                if validate_endpoint(&resource).is_err()
                    || !resource_covers_endpoint(&resource, endpoint)
                {
                    last = Some(anyhow::anyhow!(
                        "MCP authorization metadata identifies a different resource"
                    ));
                    continue;
                }
                if let Err(error) = validate_resource_metadata(&metadata) {
                    last = Some(error);
                    continue;
                }
                return Ok(metadata);
            }
            Err(error) => last = Some(error),
        }
    }
    Err(last.unwrap_or_else(|| {
        anyhow::anyhow!("MCP authentication challenge omitted resource metadata")
    }))
}

pub(crate) fn resource_covers_endpoint(resource: &Url, endpoint: &Url) -> bool {
    if resource.origin() != endpoint.origin() {
        return false;
    }
    if resource.query().is_some() {
        return resource == endpoint;
    }
    let prefix = resource.path().trim_end_matches('/');
    endpoint.path() == resource.path()
        || endpoint.path() == prefix
        || endpoint
            .path()
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn validate_resource_metadata(metadata: &ProtectedResourceMetadata) -> Result<()> {
    if metadata.authorization_servers.is_empty() {
        bail!("MCP resource did not advertise an authorization server");
    }
    for issuer in &metadata.authorization_servers {
        let issuer = Url::parse(issuer)
            .map_err(|_| anyhow::anyhow!("Invalid MCP authorization server identifier"))?;
        validate_endpoint(&issuer)?;
        if issuer.query().is_some() {
            bail!("MCP authorization server identifier must not contain a query");
        }
    }
    Ok(())
}

async fn fetch_metadata<T: serde::de::DeserializeOwned>(metadata_url: &Url) -> Result<T> {
    validate_endpoint(metadata_url)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .context("Cannot build MCP authorization discovery client")?;
    let response = client
        .get(metadata_url.clone())
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| {
            anyhow::anyhow!(
                "MCP authorization discovery failed: {}",
                error.without_url()
            )
        })?;
    if !response.status().is_success() {
        bail!(
            "MCP authorization metadata returned HTTP {}",
            response.status().as_u16()
        );
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_METADATA_BYTES as u64)
    {
        bail!("MCP authorization metadata exceeds the size limit");
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            anyhow::anyhow!(
                "MCP authorization metadata was interrupted: {}",
                error.without_url()
            )
        })?;
        if bytes.len().saturating_add(chunk.len()) > MAX_METADATA_BYTES {
            bail!("MCP authorization metadata exceeds the size limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("Invalid MCP authorization metadata"))
}

#[derive(Clone, Deserialize, serde::Serialize)]
pub struct AuthorizationServerMetadata {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub registration_endpoint: Option<String>,
    pub response_types_supported: Vec<String>,
    #[serde(default)]
    pub grant_types_supported: Option<Vec<String>>,
    #[serde(default)]
    pub code_challenge_methods_supported: Vec<String>,
    #[serde(default)]
    pub token_endpoint_auth_methods_supported: Option<Vec<String>>,
    #[serde(default)]
    pub authorization_response_iss_parameter_supported: bool,
}

impl std::fmt::Debug for AuthorizationServerMetadata {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthorizationServerMetadata")
            .finish_non_exhaustive()
    }
}

/// RFC 8414 places the well-known component before an issuer's path.
pub fn authorization_server_metadata_url(issuer: &Url) -> Result<Url> {
    validate_endpoint(issuer)?;
    if issuer.query().is_some() {
        bail!("OAuth issuer must not contain a query");
    }
    let mut url = issuer.clone();
    let suffix = issuer.path().trim_end_matches('/');
    url.set_path(&format!("/.well-known/oauth-authorization-server{suffix}"));
    Ok(url)
}

pub async fn discover_authorization_server(issuer: &Url) -> Result<AuthorizationServerMetadata> {
    let location = authorization_server_metadata_url(issuer)?;
    let metadata: AuthorizationServerMetadata = fetch_metadata(&location).await?;
    let advertised =
        Url::parse(&metadata.issuer).map_err(|_| anyhow::anyhow!("Invalid OAuth issuer"))?;
    if &advertised != issuer {
        bail!("OAuth metadata issuer does not match the selected authorization server");
    }
    for endpoint in [&metadata.authorization_endpoint, &metadata.token_endpoint]
        .into_iter()
        .chain(metadata.registration_endpoint.as_ref())
    {
        let endpoint =
            Url::parse(endpoint).map_err(|_| anyhow::anyhow!("Invalid OAuth endpoint"))?;
        validate_endpoint(&endpoint)?;
        if endpoint.scheme() == "http" && issuer.scheme() != "http" {
            bail!("OAuth endpoints must not downgrade an HTTPS issuer to HTTP");
        }
    }
    if !metadata
        .response_types_supported
        .iter()
        .any(|value| value == "code")
    {
        bail!("OAuth server does not support authorization code responses");
    }
    if !metadata
        .code_challenge_methods_supported
        .iter()
        .any(|value| value == "S256")
    {
        bail!("OAuth server does not advertise S256 PKCE support");
    }
    Ok(metadata)
}

pub fn validate_endpoint(url: &Url) -> Result<()> {
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        bail!(
            "MCP authorization requires HTTPS or a loopback development URL without credentials or fragments"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn scope_selection_uses_challenge_then_resource_metadata() {
        let supported = vec!["design:read".into(), "design:write".into()];
        assert_eq!(
            super::select_authorization_scopes(&[], &[], &supported).unwrap(),
            supported
        );
        let challenge = vec![
            r#"Basic realm="other", scope="ignore", Bearer scope="profile:read design:read""#
                .into(),
        ];
        assert_eq!(
            super::select_authorization_scopes(&[], &challenge, &supported).unwrap(),
            ["profile:read", "design:read"]
        );
        assert_eq!(
            super::select_authorization_scopes(&["manual".into()], &challenge, &supported).unwrap(),
            ["manual"]
        );
        assert!(
            super::select_authorization_scopes(
                &[],
                &[r#"Bearer scope="read", scope="write""#.into()],
                &supported
            )
            .is_err()
        );
        assert!(
            super::select_authorization_scopes(&[], &[], &[])
                .unwrap()
                .is_empty()
        );
    }
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn metadata_server(
        status: &str,
        headers: &str,
        body: String,
    ) -> (Url, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "http://{}/metadata",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let body = body.replace(
            "{{SERVER}}",
            &format!("http://{}", listener.local_addr().unwrap()),
        );
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n{body}",
            body.len()
        );
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let count = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..count]).to_lowercase();
            assert!(!request.contains("authorization:"));
            assert!(!request.contains("cookie:"));
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        (url, task)
    }

    fn prm_body(resource: &str) -> String {
        serde_json::json!({
            "resource": resource, "authorization_servers": ["https://auth.example.test"],
        })
        .to_string()
    }

    fn http_reply(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[tokio::test]
    async fn challenge_without_resource_metadata_probes_the_rfc9728_well_known_path() {
        use crate::transport::McpTransport;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let well_known = prm_body(&root);
        let replies = vec![
            "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer scope=\"mcp:connect\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
            http_reply("200 OK", &well_known),
        ];
        let task = tokio::spawn(async move {
            let mut seen = Vec::new();
            for reply in replies {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 8192];
                let count = socket.read(&mut bytes).await.unwrap();
                let request = String::from_utf8_lossy(&bytes[..count]).to_lowercase();
                seen.push(request.lines().next().unwrap_or_default().to_string());
                socket.write_all(reply.as_bytes()).await.unwrap();
            }
            seen
        });
        let mut transport = crate::StreamableHttpTransport::new(
            &format!("{root}/mcp?client=studio"),
            &std::collections::HashMap::new(),
        )
        .await
        .unwrap();
        let error = transport.send("{}").await.unwrap_err();
        let challenge = error
            .downcast_ref::<crate::AuthenticationRequired>()
            .unwrap();
        let discovered = discover_challenged_resource(challenge).await.unwrap();
        assert_eq!(discovered.resource, root);
        let seen = task.await.unwrap();
        assert!(seen[1].starts_with("get /.well-known/oauth-protected-resource/mcp"));
    }

    #[tokio::test]
    async fn challenge_well_known_probing_falls_back_to_the_origin_root() {
        use crate::transport::McpTransport;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let well_known = prm_body(&root);
        let replies = vec![
            "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer scope=\"mcp:connect\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
            http_reply("200 OK", &well_known),
        ];
        let task = tokio::spawn(async move {
            let mut seen = Vec::new();
            for reply in replies {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 8192];
                let count = socket.read(&mut bytes).await.unwrap();
                let request = String::from_utf8_lossy(&bytes[..count]).to_lowercase();
                seen.push(request.lines().next().unwrap_or_default().to_string());
                socket.write_all(reply.as_bytes()).await.unwrap();
            }
            seen
        });
        let mut transport = crate::StreamableHttpTransport::new(
            &format!("{root}/mcp"),
            &std::collections::HashMap::new(),
        )
        .await
        .unwrap();
        let error = transport.send("{}").await.unwrap_err();
        let challenge = error
            .downcast_ref::<crate::AuthenticationRequired>()
            .unwrap();
        let discovered = discover_challenged_resource(challenge).await.unwrap();
        assert_eq!(discovered.resource, root);
        let seen = task.await.unwrap();
        assert!(seen[1].starts_with("get /.well-known/oauth-protected-resource/mcp"));
        assert!(seen[2].starts_with("get /.well-known/oauth-protected-resource http"));
    }

    #[tokio::test]
    async fn challenge_discovery_binds_metadata_to_the_responding_endpoint() {
        use crate::transport::McpTransport;
        for same_origin in [true, false] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let root = format!("http://{}", listener.local_addr().unwrap());
            let resource = if same_origin {
                root.clone()
            } else {
                "https://other.example.test".into()
            };
            let (location, metadata_task) = metadata_server(
                "200 OK",
                "",
                serde_json::json!({
                    "resource": resource, "authorization_servers": ["https://auth.example.test"],
                })
                .to_string(),
            )
            .await;
            let reply = format!(
                "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer resource_metadata=\"{location}\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let challenge_task = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 8192];
                let read = socket.read(&mut bytes).await.unwrap();
                assert!(read > 0, "fixture must receive the request before replying");
                socket.write_all(reply.as_bytes()).await.unwrap();
            });
            let mut transport = crate::StreamableHttpTransport::new(
                &format!("{root}/mcp?client=studio"),
                &std::collections::HashMap::new(),
            )
            .await
            .unwrap();
            let error = transport.send("{}").await.unwrap_err();
            let challenge = error
                .downcast_ref::<crate::AuthenticationRequired>()
                .unwrap();
            let discovered = discover_challenged_resource(challenge).await;
            assert_eq!(discovered.is_ok(), same_origin);
            challenge_task.await.unwrap();
            metadata_task.await.unwrap();
        }
    }

    #[test]
    fn canonical_resource_binding_accepts_parent_paths_without_crossing_boundaries() {
        let covers = |resource: &str, endpoint: &str| {
            resource_covers_endpoint(
                &Url::parse(resource).unwrap(),
                &Url::parse(endpoint).unwrap(),
            )
        };
        assert!(covers(
            "https://mcp.context7.com",
            "https://mcp.context7.com/mcp"
        ));
        assert!(covers(
            "https://example.test/mcp",
            "https://example.test/mcp?client=studio"
        ));
        assert!(covers(
            "https://example.test/team",
            "https://example.test/team/mcp"
        ));
        for endpoint in [
            "https://other.test/team/mcp",
            "https://example.test:444/team/mcp",
            "http://example.test/team/mcp",
            "https://example.test/teammate/mcp",
            "https://example.test/other",
        ] {
            assert!(!covers("https://example.test/team", endpoint));
        }
        assert!(!covers(
            "https://example.test/mcp?tenant=a",
            "https://example.test/mcp?tenant=b"
        ));
        assert!(!covers(
            "https://example.test/team",
            "https://example.test/team%2Fother"
        ));
    }

    #[test]
    fn issuer_metadata_location_preserves_tenant_paths() {
        assert_eq!(
            authorization_server_metadata_url(
                &Url::parse("https://auth.example.test/tenant%20one").unwrap()
            )
            .unwrap()
            .as_str(),
            "https://auth.example.test/.well-known/oauth-authorization-server/tenant%20one"
        );
        assert_eq!(
            authorization_server_metadata_url(&Url::parse("https://auth.example.test/").unwrap())
                .unwrap()
                .path(),
            "/.well-known/oauth-authorization-server"
        );
        assert!(
            authorization_server_metadata_url(
                &Url::parse("https://auth.example.test/?secret=value").unwrap()
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn authorization_discovery_validates_issuer_and_pkce_support() {
        for case in [
            "valid",
            "wrong-issuer",
            "no-pkce",
            "no-code",
            "unsafe-endpoint",
        ] {
            let mut document = serde_json::json!({
                "issuer":"{{SERVER}}/tenant", "authorization_endpoint":"{{SERVER}}/authorize",
                "token_endpoint":"{{SERVER}}/token", "registration_endpoint":"{{SERVER}}/register",
                "response_types_supported":["code"], "code_challenge_methods_supported":["S256"],
                "token_endpoint_auth_methods_supported":["none"]
            });
            match case {
                "wrong-issuer" => {
                    document["issuer"] = serde_json::json!("https://other.example.test")
                }
                "no-pkce" => {
                    document["code_challenge_methods_supported"] = serde_json::json!(["plain"])
                }
                "no-code" => document["response_types_supported"] = serde_json::json!(["token"]),
                "unsafe-endpoint" => {
                    document["token_endpoint"] =
                        serde_json::json!("http://remote.example.test/private-secret")
                }
                _ => {}
            }
            let (mut issuer, server) = metadata_server("200 OK", "", document.to_string()).await;
            issuer.set_path("/tenant");
            let result = discover_authorization_server(&issuer).await;
            if case == "valid" {
                let metadata = result.unwrap();
                assert_eq!(metadata.issuer, issuer.as_str());
                assert!(metadata.registration_endpoint.is_some());
                assert_eq!(
                    metadata.token_endpoint_auth_methods_supported.unwrap(),
                    ["none"]
                );
            } else {
                let error = result.unwrap_err();
                assert!(!format!("{error:?}").contains("private-secret"));
            }
            server.await.unwrap();
        }
    }

    #[test]
    fn bearer_challenges_handle_multiple_schemes_and_quoted_commas() {
        let value = metadata_url_from_challenges(&[r#"Basic realm="ignored,realm", resource_metadata="https://wrong.test/", Bearer realm="mcp", resource_metadata = "https://auth.example.test/meta,a""#.into()]).unwrap().unwrap();
        assert_eq!(value.as_str(), "https://auth.example.test/meta,a");
        assert!(
            metadata_url_from_challenges(&[
                r#"Basic resource_metadata="https://wrong.test/""#.into()
            ])
            .unwrap()
            .is_none()
        );
        assert_eq!(
            metadata_url_from_challenges(&[
                r#"bEaReR resource_metadata="https://auth.example.test/meta""#.into()
            ])
            .unwrap()
            .unwrap()
            .path(),
            "/meta"
        );
    }

    #[test]
    fn malformed_or_conflicting_challenges_fail_without_echoing_values() {
        for headers in [
            vec![r#"Bearer resource_metadata="https://one.test/", resource_metadata="https://two.test/""#.into()],
            vec![r#"Bearer resource_metadata="private-secret"#.into()],
            vec![r#"Bearer resource_metadata="http://remote.test/private-secret""#.into()],
        ] {
            let error = metadata_url_from_challenges(&headers).unwrap_err();
            assert!(!format!("{error:?}").contains("private-secret"));
        }
    }

    #[tokio::test]
    async fn discovery_binds_the_resource_and_preserves_authorization_server_choices() {
        let resource = Url::parse("https://mcp.example.test/mcp").unwrap();
        let (url, task) = metadata_server("200 OK", "", serde_json::json!({
            "resource":resource.as_str(), "authorization_servers":["https://auth.example.test/tenant"], "scopes_supported":["read"]
        }).to_string()).await;
        let metadata = discover_protected_resource(&resource, &url).await.unwrap();
        assert_eq!(
            metadata.authorization_servers,
            ["https://auth.example.test/tenant"]
        );
        assert_eq!(metadata.scopes_supported, ["read"]);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn discovery_rejects_resource_substitution_and_redirects() {
        let resource = Url::parse("https://mcp.example.test/mcp").unwrap();
        for (status, headers, body, expected) in [
            (
                "200 OK",
                "",
                r#"{"resource":"https://other.example.test/mcp","authorization_servers":["https://auth.example.test"]}"#,
                "different resource",
            ),
            (
                "302 Found",
                "Location: https://other.example.test/metadata\r\n",
                "",
                "HTTP 302",
            ),
            (
                "200 OK",
                "",
                r#"{"resource":"private-response-value"}"#,
                "Invalid MCP authorization metadata",
            ),
        ] {
            let (url, task) = metadata_server(status, headers, body.into()).await;
            let error = discover_protected_resource(&resource, &url)
                .await
                .unwrap_err();
            assert!(error.to_string().contains(expected));
            assert!(!format!("{error:?}").contains("private-response-value"));
            task.await.unwrap();
        }
    }

    #[test]
    fn authorization_urls_reject_plaintext_remote_targets_and_embedded_credentials() {
        for value in [
            "http://remote.example.test/mcp",
            "https://user:secret@example.test/mcp",
            "https://example.test/mcp#fragment",
        ] {
            assert!(validate_endpoint(&Url::parse(value).unwrap()).is_err());
        }
        assert!(validate_endpoint(&Url::parse("http://127.0.0.1:8080/mcp").unwrap()).is_ok());
        assert!(validate_endpoint(&Url::parse("https://example.test/mcp").unwrap()).is_ok());
    }
}

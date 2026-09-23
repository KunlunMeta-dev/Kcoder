//! Pending authorization-code flows; secrets are not serializable or printable.

use crate::authorization::{AuthorizationServerMetadata, validate_endpoint};
use anyhow::{Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::Url;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

const FLOW_LIFETIME: Duration = Duration::from_secs(600);
const RESERVED_PARAMETERS: &[&str] = &[
    "response_type",
    "client_id",
    "redirect_uri",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
    "resource",
];

pub struct AuthorizationSession {
    authorization_url: Url,
    state: Zeroizing<String>,
    verifier: Option<Zeroizing<String>>,
    expires_at: Instant,
    require_response_issuer: bool,
    client_id: String,
    resource: Url,
    redirect_uri: Url,
    token_endpoint: Url,
    issuer: Url,
    requested_scope: Option<String>,
}

pub struct AuthorizationCodeGrant {
    code: Zeroizing<String>,
    verifier: Zeroizing<String>,
    client_id: String,
    resource: Url,
    redirect_uri: Url,
    token_endpoint: Url,
    issuer: Url,
    requested_scope: Option<String>,
}

impl std::fmt::Debug for AuthorizationSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthorizationSession")
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for AuthorizationCodeGrant {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthorizationCodeGrant")
            .finish_non_exhaustive()
    }
}

fn random_secret() -> Result<Zeroizing<String>> {
    let mut bytes = Zeroizing::new([0u8; 32]);
    getrandom::fill(bytes.as_mut())
        .map_err(|_| anyhow::anyhow!("OAuth random source is unavailable"))?;
    Ok(Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes.as_slice())))
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

impl AuthorizationSession {
    pub fn new(
        metadata: &AuthorizationServerMetadata,
        client_id: &str,
        resource: &Url,
        redirect_uri: &Url,
        scopes: &[String],
    ) -> Result<Self> {
        validate_endpoint(resource)?;
        validate_endpoint(redirect_uri)?;
        let issuer =
            Url::parse(&metadata.issuer).map_err(|_| anyhow::anyhow!("Invalid OAuth issuer"))?;
        validate_endpoint(&issuer)?;
        if issuer.query().is_some() {
            bail!("OAuth issuer must not contain a query");
        }
        let mut authorization_url = Url::parse(&metadata.authorization_endpoint)
            .map_err(|_| anyhow::anyhow!("Invalid OAuth authorization endpoint"))?;
        let token_endpoint = Url::parse(&metadata.token_endpoint)
            .map_err(|_| anyhow::anyhow!("Invalid OAuth token endpoint"))?;
        for endpoint in [&authorization_url, &token_endpoint] {
            validate_endpoint(endpoint)?;
            if issuer.scheme() == "https" && endpoint.scheme() == "http" {
                bail!("OAuth endpoints must not downgrade HTTPS");
            }
        }
        if client_id.is_empty() || redirect_uri.query().is_some() {
            bail!("OAuth requires a client identifier and a callback without query parameters");
        }
        if !metadata
            .code_challenge_methods_supported
            .iter()
            .any(|value| value == "S256")
            || !metadata
                .response_types_supported
                .iter()
                .any(|value| value == "code")
        {
            bail!("OAuth server must support authorization code with S256 PKCE");
        }
        if scopes.iter().any(|scope| {
            scope.is_empty()
                || !scope.bytes().all(|byte| {
                    byte == 0x21 || (0x23..=0x5b).contains(&byte) || (0x5d..=0x7e).contains(&byte)
                })
        }) {
            bail!("Invalid OAuth scope token");
        }
        if authorization_url
            .query_pairs()
            .any(|(name, _)| RESERVED_PARAMETERS.contains(&name.as_ref()))
        {
            bail!("OAuth authorization endpoint contains conflicting flow parameters");
        }
        let state = random_secret()?;
        let verifier = random_secret()?;
        {
            let mut query = authorization_url.query_pairs_mut();
            query
                .append_pair("response_type", "code")
                .append_pair("client_id", client_id)
                .append_pair("redirect_uri", redirect_uri.as_str())
                .append_pair("resource", resource.as_str())
                .append_pair("state", &state)
                .append_pair("code_challenge", &challenge(&verifier))
                .append_pair("code_challenge_method", "S256");
            if !scopes.is_empty() {
                query.append_pair("scope", &scopes.join(" "));
            }
        }
        Ok(Self {
            authorization_url,
            state,
            verifier: Some(verifier),
            expires_at: Instant::now() + FLOW_LIFETIME,
            client_id: client_id.into(),
            resource: resource.clone(),
            redirect_uri: redirect_uri.clone(),
            token_endpoint,
            issuer,
            require_response_issuer: metadata.authorization_response_iss_parameter_supported,
            requested_scope: (!scopes.is_empty()).then(|| scopes.join(" ")),
        })
    }

    /// This URL contains the public challenge and CSRF state, never the verifier.
    pub fn authorization_url(&self) -> &Url {
        &self.authorization_url
    }

    pub fn cancel(&mut self) {
        self.verifier.take();
    }

    fn validate_callback(&mut self, state: &str, response_issuer: Option<&str>) -> Result<()> {
        if !bool::from(self.state.as_bytes().ct_eq(state.as_bytes())) {
            bail!("OAuth callback state does not match");
        }
        if Instant::now() >= self.expires_at {
            self.cancel();
            bail!("OAuth authorization session expired");
        }
        if self.require_response_issuer && response_issuer.is_none() {
            bail!("OAuth callback omitted the required issuer");
        }
        if let Some(issuer) = response_issuer {
            let issuer =
                Url::parse(issuer).map_err(|_| anyhow::anyhow!("Invalid OAuth callback issuer"))?;
            if issuer != self.issuer {
                bail!("OAuth callback issuer does not match");
            }
        }
        if self.verifier.is_none() {
            bail!("OAuth authorization session was already consumed or cancelled");
        }
        Ok(())
    }

    pub fn reject_callback(&mut self, state: &str, response_issuer: Option<&str>) -> Result<()> {
        self.validate_callback(state, response_issuer)?;
        self.cancel();
        Ok(())
    }

    pub fn complete_callback(
        &mut self,
        state: &str,
        code: &str,
        response_issuer: Option<&str>,
    ) -> Result<AuthorizationCodeGrant> {
        self.validate_callback(state, response_issuer)?;
        if code.is_empty() || code.len() > 16384 {
            bail!("Invalid OAuth authorization code");
        }
        let verifier = self.verifier.take().ok_or_else(|| {
            anyhow::anyhow!("OAuth authorization session was already consumed or cancelled")
        })?;
        Ok(AuthorizationCodeGrant {
            code: Zeroizing::new(code.into()),
            verifier,
            client_id: self.client_id.clone(),
            resource: self.resource.clone(),
            redirect_uri: self.redirect_uri.clone(),
            token_endpoint: self.token_endpoint.clone(),
            issuer: self.issuer.clone(),
            requested_scope: self.requested_scope.clone(),
        })
    }
}

impl AuthorizationCodeGrant {
    pub fn requested_scope(&self) -> Option<&str> {
        self.requested_scope.as_deref()
    }
    pub fn issuer(&self) -> &Url {
        &self.issuer
    }
    pub fn client_id(&self) -> &str {
        &self.client_id
    }
    pub fn resource(&self) -> &Url {
        &self.resource
    }
    pub fn redirect_uri(&self) -> &Url {
        &self.redirect_uri
    }
    pub fn token_endpoint(&self) -> &Url {
        &self.token_endpoint
    }
    /// Sensitive value for the token exchange body only.
    pub fn code(&self) -> &str {
        &self.code
    }
    /// Sensitive value for the token exchange body only.
    pub fn code_verifier(&self) -> &str {
        &self.verifier
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> AuthorizationServerMetadata {
        serde_json::from_value(serde_json::json!({
            "issuer":"https://auth.example.test", "authorization_endpoint":"https://auth.example.test/authorize?tenant=one",
            "token_endpoint":"https://auth.example.test/token", "response_types_supported":["code"], "code_challenge_methods_supported":["S256"]
        })).unwrap()
    }
    fn session() -> AuthorizationSession {
        AuthorizationSession::new(
            &metadata(),
            "client",
            &Url::parse("https://mcp.example.test/mcp").unwrap(),
            &Url::parse("http://127.0.0.1:32145/callback").unwrap(),
            &["read".into()],
        )
        .unwrap()
    }
    fn state(session: &AuthorizationSession) -> String {
        session
            .authorization_url()
            .query_pairs()
            .find(|(name, _)| name == "state")
            .unwrap()
            .1
            .into_owned()
    }

    #[test]
    fn pkce_matches_rfc_7636_vector() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn callback_is_bound_single_use_and_secrets_are_not_printed() {
        let mut pending = session();
        let callback_state = state(&pending);
        assert_ne!(callback_state, state(&session()));
        assert!(
            pending
                .complete_callback("wrong-state", "secret-code", None)
                .is_err()
        );
        let grant = pending
            .complete_callback(&callback_state, "secret-code", None)
            .unwrap();
        let query: std::collections::HashMap<_, _> = pending
            .authorization_url()
            .query_pairs()
            .into_owned()
            .collect();
        assert_eq!(query["resource"], grant.resource().as_str());
        assert_eq!(query["code_challenge"], challenge(grant.code_verifier()));
        assert!(!query.contains_key("code_verifier"));
        assert_eq!(grant.code_verifier().len(), 43);
        assert_eq!(grant.code(), "secret-code");
        assert_eq!(grant.client_id(), "client");
        assert!(
            pending
                .complete_callback(&callback_state, "secret-code", None)
                .is_err()
        );
        for output in [format!("{pending:?}"), format!("{grant:?}")] {
            assert!(!output.contains(&callback_state));
            assert!(!output.contains("secret-code"));
            assert!(!output.contains(grant.code_verifier()));
        }
    }

    #[test]
    fn advertised_callback_issuer_is_required_and_must_match() {
        let mut server = metadata();
        server.authorization_response_iss_parameter_supported = true;
        let mut flow = AuthorizationSession::new(
            &server,
            "client",
            &Url::parse("https://mcp.example.test/mcp").unwrap(),
            &Url::parse("http://127.0.0.1/callback").unwrap(),
            &[],
        )
        .unwrap();
        let state = state(&flow);
        assert!(flow.complete_callback(&state, "code", None).is_err());
        assert!(
            flow.complete_callback(&state, "code", Some("https://other.example.test"))
                .is_err()
        );
        let grant = flow
            .complete_callback(&state, "code", Some("https://auth.example.test"))
            .unwrap();
        assert_eq!(grant.issuer().as_str(), "https://auth.example.test/");
        assert_eq!(
            grant.token_endpoint().as_str(),
            "https://auth.example.test/token"
        );
        assert_eq!(grant.redirect_uri().as_str(), "http://127.0.0.1/callback");
    }

    #[test]
    fn flow_rejects_parameter_injection_unsafe_callbacks_and_invalid_scopes() {
        let resource = Url::parse("https://mcp.example.test/mcp").unwrap();
        let callback = Url::parse("http://127.0.0.1/callback").unwrap();
        let mut server = metadata();
        server.authorization_endpoint.push_str("&state=attacker");
        assert!(AuthorizationSession::new(&server, "client", &resource, &callback, &[]).is_err());
        for callback in [
            "http://remote.example.test/callback",
            "https://example.test/callback?code=old",
            "https://user:secret@example.test/callback",
        ] {
            assert!(
                AuthorizationSession::new(
                    &metadata(),
                    "client",
                    &resource,
                    &Url::parse(callback).unwrap(),
                    &[]
                )
                .is_err()
            );
        }
        assert!(
            AuthorizationSession::new(
                &metadata(),
                "client",
                &resource,
                &callback,
                &["read write".into()]
            )
            .is_err()
        );
        let mut server = metadata();
        server.code_challenge_methods_supported = vec!["plain".into()];
        assert!(AuthorizationSession::new(&server, "client", &resource, &callback, &[]).is_err());
    }

    #[test]
    fn expired_and_cancelled_flows_cannot_be_redeemed() {
        let mut expired = session();
        expired.expires_at = Instant::now() - Duration::from_secs(1);
        assert!(
            expired
                .complete_callback(&state(&expired), "code", None)
                .is_err()
        );
        let mut cancelled = session();
        cancelled.cancel();
        assert!(
            cancelled
                .complete_callback(&state(&cancelled), "code", None)
                .is_err()
        );
    }
}
